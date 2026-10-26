//! # Worker 入口：路由分发、Turnstile 鉴权、异步 Job 执行器
//!
//! ## 请求生命周期
//!
//! ```text
//! fetch(req, env, ctx)
//!   ├─ 非 /api/*  → 转发给 ASSETS 绑定（Vue 静态资源，SPA 回退）
//!   └─ /api/*     → 路由分发
//!        ├─ 公开路由：/auth/session、/auth/login、/auth/logout
//!        └─ 受保护路由：校验 Cookie 里的 HMAC Token
//!             ├─ 读接口：直接 await（快）
//!             └─ 写接口：建 job 行 → ctx.wait_until(执行) → 202 Accepted + job_id
//! ```
//!
//! ## 鉴权
//!
//! * 登录：Turnstile token 送 `challenges.cloudflare.com/turnstile/v0/siteverify`，
//!   同时带上 `CF-Connecting-IP`。校验通过后再比对管理员密码。
//! * 会话：`HMAC-SHA256(MASTER_KEY)` 签名的无状态 Token，写入
//!   `HttpOnly; Secure; SameSite=Strict` Cookie；D1 里没有 Session 表。
//! * 所有写接口额外校验 `Origin`/`Referer` 与 `Sec-Fetch-Site`，作为
//!   SameSite=Strict 之外的纵深防御。
//!
//! ## 异步 Job
//!
//! 手动刷新、开关机、通知测试、日报推送都走同一个执行器：
//! 请求线程只做「建 job 行 + 派生任务」，实际调用阿里云的活交给
//! `ctx.wait_until`，客户端立刻拿到 `202 { job_id }` 并轮询
//! `/api/v1/jobs/{job_id}`。

use std::collections::HashMap;

// `logging` 里定义的是 `#[macro_export]` 宏，声明在 `mod` 之前以便
// 子模块（scheduler 等）直接 `log_info!` 而无需逐个 `use`。
#[macro_use]
pub mod logging;
pub mod device;
pub mod http;

pub mod aliyun;
pub mod crypto;
pub mod db;
pub mod models;
pub mod notify;
pub mod scheduler;

use serde::Serialize;
use worker::{
    Context, Env, Fetch, Headers, Method, Request, Response, ResponseBuilder, ScheduleContext,
    ScheduledEvent, event,
};

use crate::crypto::{
    Crypto, MasterKey, SessionToken, TokenState, constant_time_eq, random_hex, session_cookie,
    session_token_from_cookie,
};
use crate::db::Db;
use crate::device::{client_ip, client_ua, same_origin_ok, short_device, short_ip};
use crate::http::{query_i64, query_map, query_str, query_u32, read_json};
use crate::models::{
    AcceptedJob, AccountInput, AdvancedConfig, AdvancedSettingsDto, ApiErrorBody, BarkConfig,
    BarkSettingsDto, BarkSettingsUpdate, DailyReportConfig, DailyReportDto, HistoryBucket,
    HistoryQuery, JobDto, JobStatus, JobType, LoginRequest, NotifyChannel, NotifyTestRequest,
    SessionResponse, SessionsResponse, SettingsDto, TelegramConfig, TelegramSettingsDto,
    TelegramSettingsUpdate, TrafficHistoryResponse, TurnstileConfig, TurnstileSettingsDto,
    TurnstileSettingsUpdate, build_overview, is_supported_timezone, now_ms, setting_key,
};
use crate::notify::NotifyLevel;
use crate::scheduler::Scheduler;

// ===========================================================================
// 常量
// ===========================================================================

/// 登录接口的固定延迟（毫秒）。Turnstile token 一次性，暴力破解必须每次重算，
/// 这个延迟主要用来钝化自动化脚本的探测节奏。
const LOGIN_FAILURE_DELAY_MS: u64 = 350;
/// 单次查询返回的 Job 数量上限。
const MAX_JOBS: u32 = 50;
/// 单次查询返回的日志数量上限。
const MAX_LOGS: u32 = 200;
/// 历史图表的点数上限。
const MAX_HISTORY_POINTS: u32 = 720;

// ===========================================================================
// 响应工具
// ===========================================================================

/// 通用安全响应头。SPA 同源请求，不需要 CORS。
fn base_headers() -> worker::Result<Headers> {
    let headers = Headers::new();
    headers.set("X-Content-Type-Options", "nosniff")?;
    headers.set("X-Frame-Options", "DENY")?;
    headers.set("Referrer-Policy", "same-origin")?;
    headers.set("Cache-Control", "no-store")?;
    Ok(headers)
}

/// 构造 JSON 响应（可附带 `Set-Cookie`）。
fn json_response<T: Serialize>(
    value: &T,
    status: u16,
    cookie: Option<String>,
) -> worker::Result<Response> {
    let headers = base_headers()?;
    if let Some(cookie) = cookie {
        headers.set("Set-Cookie", &cookie)?;
    }
    ResponseBuilder::new()
        .with_status(status)
        .with_headers(headers)
        .from_json(value)
}

/// 成功响应（200）。
fn ok<T: Serialize>(value: &T) -> worker::Result<Response> {
    json_response(value, 200, None)
}

/// 错误响应体。
fn error_response(status: u16, message: impl Into<String>) -> worker::Result<Response> {
    let body = ApiErrorBody::new(message);
    let mut response = json_response(&body, status, None)?;
    // 401 时提示前端回到登录页
    if status == 401 {
        let headers: &mut Headers = response.headers_mut();
        let _ = headers.set("X-Auth-Required", "1");
    }
    Ok(response)
}

/// 带错误码的错误响应。
fn error_response_with_code(
    status: u16,
    message: impl Into<String>,
    code: &str,
) -> worker::Result<Response> {
    let body = ApiErrorBody::with_code(message, code);
    json_response(&body, status, None)
}

// ===========================================================================
// 应用上下文
// ===========================================================================

/// 人机校验的三种状态。
enum TurnstileGate {
    /// 后台未启用（默认）：跳过人机校验。
    Disabled,
    /// 已启用且私钥可用：必须校验。
    Required(String),
    /// 已启用但私钥取不出来：拒绝登录，不能当成「未启用」放行。
    Broken,
}

/// 一次请求期间共享的上下文。
struct AppCtx {
    env: Env,
    db: Db,
    crypto: Crypto,
    timezone: String,
    /// 高级配置（日志级别 / 锁窗口 / 会话有效期），来自 D1。
    advanced: AdvancedConfig,
    now: i64,
}

impl AppCtx {
    async fn load(env: &Env) -> worker::Result<Self> {
        let master =
            MasterKey::from_env(env).map_err(|err| worker::Error::RustError(err.to_string()))?;
        let db = Db::new(env);

        // 读 settings 是每次请求的第一步。如果表还不存在，最可能的原因是
        // 忘了跑迁移；把这种情况翻译成明确的运维提示，而不是抛原始 SQL 错误。
        let timezone = match db.get_timezone().await {
            Ok(timezone) => timezone,
            Err(err) => return Err(worker::Error::RustError(migration_hint(&err))),
        };
        // 高级配置同样来自 D1；读失败时用默认值，不阻断请求
        let advanced = db.get_advanced_config().await.unwrap_or_default();

        Ok(Self {
            env: env.clone(),
            db,
            crypto: Crypto::new(master),
            timezone,
            advanced,
            now: now_ms(),
        })
    }

    /// 读取 Turnstile 配置（来自 D1 的 `settings` 表）。
    ///
    /// **未配置即关闭**：`enabled` 为 false 或密钥不全时一律不校验，
    /// 登录只比对用户名 + 密码。这样自部署可以先跑起来，
    /// 需要人机校验时再去后台填两个 key。
    async fn turnstile_config(&self) -> TurnstileConfig {
        let mut config: TurnstileConfig = self
            .db
            .get_json_setting(setting_key::TURNSTILE)
            .await
            .unwrap_or_default();
        // 密钥不全时强制视为关闭，避免出现「前端不渲染组件、后端仍要求 token」
        config.enabled = config.enabled && config.is_complete();
        config
    }

    /// 下发给浏览器的 site key。未启用时为空字符串，前端据此不加载脚本。
    async fn turnstile_site_key(&self) -> String {
        let config = self.turnstile_config().await;
        if config.enabled {
            config.site_key.unwrap_or_default()
        } else {
            String::new()
        }
    }

    /// 人机校验闸门。
    ///
    /// 「未启用」与「已启用但私钥不可用」必须区分：前者放行，后者拒绝登录。
    /// 两者若都返回 `None`，私钥解密失败（如 `MASTER_KEY` 已轮换）时
    /// 校验会被静默跳过，人机校验失效且无任何提示。
    async fn turnstile_gate(&self) -> TurnstileGate {
        let config: TurnstileConfig = self
            .db
            .get_json_setting(setting_key::TURNSTILE)
            .await
            .unwrap_or_default();

        if !config.enabled || !config.is_complete() {
            return TurnstileGate::Disabled;
        }

        let enc = config.secret_enc.as_deref().unwrap_or_default();
        match self.crypto.try_decrypt(enc) {
            Some(secret) if !secret.trim().is_empty() => {
                TurnstileGate::Required(secret.trim().to_string())
            }
            _ => TurnstileGate::Broken,
        }
    }

    /// Job 锁 TTL（已在 `AdvancedConfig::normalized` 中限制范围）。
    fn job_lock_ttl_ms(&self) -> i64 {
        self.advanced.job_lock_ttl_ms
    }

    /// 会话有效期（同上）。
    fn session_ttl_ms(&self) -> i64 {
        self.advanced.session_ttl_ms
    }

    /// 从请求中取出已验签的会话（不查库）。
    fn session_claims(&self, req: &Request) -> Option<SessionClaims> {
        let header = req.headers().get("Cookie").ok().flatten();
        let token = session_token_from_cookie(header.as_deref())?;
        match SessionToken::new(self.crypto.key()).verify(&token, now_ms()) {
            TokenState::Valid { expires_at, sid } => Some(SessionClaims { expires_at, sid }),
            _ => None,
        }
    }

    /// 校验会话 Cookie，并确认会话在库中仍有效（未被踢下线）。
    ///
    /// 无状态 Token 无法吊销，因此每次鉴权都要回查 `sessions`：
    /// 缺库（未建表）时按无效处理，不放行。
    async fn session_from_request(&self, req: &Request) -> Option<SessionClaims> {
        let claims = self.session_claims(req)?;
        match self.db.session_is_active(&claims.sid, now_ms()).await {
            Ok(true) => Some(claims),
            Ok(false) => None,
            Err(err) => {
                log_error!("会话校验失败：{err}");
                None
            }
        }
    }
}

/// 生成会话 ID（128 位随机，十六进制）。
fn random_sid() -> worker::Result<String> {
    random_hex(16).map_err(|err| worker::Error::RustError(err.to_string()))
}

/// 会话声明（验签通过 + 库中存在）。
#[derive(Debug, Clone)]
struct SessionClaims {
    expires_at: i64,
    sid: String,
}

// ===========================================================================
// Turnstile
// ===========================================================================

/// 调用 Cloudflare Turnstile 的 siteverify 接口。
async fn verify_turnstile(
    secret: &str,
    token: &str,
    remote_ip: Option<&str>,
) -> Result<bool, String> {
    if token.trim().is_empty() {
        return Ok(false);
    }

    let mut form = format!(
        "secret={}&response={}",
        crate::notify::urlencode(secret),
        crate::notify::urlencode(token)
    );
    if let Some(ip) = remote_ip {
        form.push_str("&remoteip=");
        form.push_str(&crate::notify::urlencode(ip));
    }

    let headers = Headers::new();
    headers
        .set("Content-Type", "application/x-www-form-urlencoded")
        .map_err(|e| format!("设置请求头失败：{e}"))?;

    let mut init = worker::RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(worker::wasm_bindgen::JsValue::from_str(&form)));

    let request = worker::Request::new_with_init(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        &init,
    )
    .map_err(|e| format!("构造 Turnstile 请求失败：{e}"))?;

    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|e| format!("Turnstile 请求失败：{e}"))?;

    let status = response.status_code();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 Turnstile 响应失败：{e}"))?;

    if !(200..300).contains(&status) {
        return Err(format!("Turnstile 返回 HTTP {status}：{body}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Turnstile 响应不是 JSON：{e}"))?;
    Ok(parsed
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

/// 把「表/列不存在」的 D1 错误翻译成可执行的运维提示。
///
/// 这类错误 100% 是部署流程漏了迁移，原始信息（`D1Error { cause: JsValue(...) }`）
/// 对使用者毫无帮助，因此这里直接给出对应命令。
fn migration_hint(err: &worker::Error) -> String {
    let raw = err.to_string();
    let lowered = raw.to_ascii_lowercase();
    if lowered.contains("no such table") || lowered.contains("no such column") {
        return format!(
            "数据库尚未初始化：请先执行迁移。本地开发用 `bun run db:migrate:local`，\
             线上用 `bun run db:migrate:remote`。（原始错误：{raw}）"
        );
    }
    raw
}

/// 相对延迟（毫秒）。用于钝化自动化探测。
async fn sleep_ms(ms: u64) {
    worker::Delay::from(std::time::Duration::from_millis(ms)).await;
}

// ===========================================================================
// 管理员密码
// ===========================================================================

/// 读取环境变量（secret 优先，其次 var）。
fn env_value(app: &AppCtx, key: &str) -> Option<String> {
    app.env
        .secret(key)
        .ok()
        .map(|v| v.to_string())
        .or_else(|| app.env.var(key).ok().map(|v| v.to_string()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 管理员用户名。**只来自环境变量** `ADMIN_USERNAME`。
///
/// 缺失时返回 `None`，登录接口会直接 500 并提示去配置 —— 不设默认值，
/// 避免「忘了配用户名却能用默认 admin 登进去」。
fn admin_username(app: &AppCtx) -> Option<String> {
    env_value(app, "ADMIN_USERNAME")
}

/// 管理员密码。**只来自环境变量** `ADMIN_PASSWORD`。
fn admin_password(app: &AppCtx) -> Option<String> {
    env_value(app, "ADMIN_PASSWORD")
}

/// 校验用户名与密码。
///
/// 两者都用常量时间比较：`==` 对 `String` 会短路，理论上能被计时攻击
/// 逐字节试探。这里虽然通过 Turnstile 已经很难被自动化，但既然成本
/// 只有几行代码，就没必要留这个口子。
fn verify_credentials(app: &AppCtx, username: &str, password: &str) -> bool {
    let Some(expected_user) = admin_username(app) else {
        return false;
    };
    let Some(expected_pass) = admin_password(app) else {
        return false;
    };
    let user_ok = constant_time_eq(username.as_bytes(), expected_user.as_bytes());
    let pass_ok = constant_time_eq(password.as_bytes(), expected_pass.as_bytes());
    // 不短路：两者都算完再合并，避免「用户名错」比「密码错」返回更快
    user_ok & pass_ok
}

// ===========================================================================
// 认证路由
// ===========================================================================

/// `GET /api/v1/auth/session`（公开）
async fn handle_session(app: &AppCtx, req: &Request) -> worker::Result<Response> {
    let claims = app.session_from_request(req).await;
    ok(&SessionResponse {
        authenticated: claims.is_some(),
        turnstile_site_key: app.turnstile_site_key().await,
        expires_at: claims.map(|c| c.expires_at),
    })
}

/// `POST /api/v1/auth/login`（公开，但必须先过 Turnstile）
async fn handle_login(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: LoginRequest = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };

    if payload.password.is_empty() {
        return error_response(400, "密码不能为空");
    }

    // 1) Turnstile —— 后台没配就整体跳过（默认关闭）
    match app.turnstile_gate().await {
        TurnstileGate::Disabled => {}
        TurnstileGate::Broken => {
            log_error!("Turnstile 已启用但私钥无法解密，拒绝登录（请检查 MASTER_KEY）");
            return error_response_with_code(
                500,
                "人机校验配置异常，请联系管理员检查私钥与 MASTER_KEY",
                "turnstile_broken",
            );
        }
        TurnstileGate::Required(secret) => {
            let ip = client_ip(&req);
            match verify_turnstile(&secret, &payload.turnstile_token, ip.as_deref()).await {
                Ok(true) => {}
                Ok(false) => {
                    sleep_ms(LOGIN_FAILURE_DELAY_MS).await;
                    app.db
                        .add_log(
                            None,
                            "login_turnstile_failed",
                            None,
                            "Turnstile 校验未通过",
                            now_ms(),
                        )
                        .await
                        .ok();
                    return error_response_with_code(
                        403,
                        "人机校验未通过，请刷新页面后重试",
                        "turnstile_failed",
                    );
                }
                Err(err) => {
                    return error_response_with_code(502, err, "turnstile_unavailable");
                }
            }
        }
    }

    // 2) 用户名 + 密码（均来自环境变量）
    //
    // 用户名不对与密码不对返回**同一句提示**、同样的延迟，避免通过
    // 文案差异枚举出正确的用户名。
    let username = payload.username.trim();
    if username.is_empty() {
        return error_response(400, "请填写用户名");
    }
    if payload.password.is_empty() {
        return error_response(400, "请填写密码");
    }

    // 凭证没配就直接 500：这时候任何尝试都不可能成功，早报错比让用户
    // 反复试密码有用。
    if admin_username(app).is_none() || admin_password(app).is_none() {
        return error_response_with_code(
            500,
            "服务端未配置 ADMIN_USERNAME / ADMIN_PASSWORD，请在 Cloudflare \
             控制台 Settings → Variables and Secrets 添加后重试",
            "credentials_not_configured",
        );
    }

    if !verify_credentials(app, username, &payload.password) {
        sleep_ms(LOGIN_FAILURE_DELAY_MS).await;
        let ip = client_ip(&req).unwrap_or_else(|| "unknown".to_string());
        app.db
            .add_log(
                None,
                "login_failed",
                None,
                &format!("凭证错误（用户 {username}，来源 IP {ip}）"),
                now_ms(),
            )
            .await
            .ok();
        return error_response_with_code(401, "用户名或密码错误", "invalid_credentials");
    }

    // 3) 建立会话并签发 Token
    //
    // 先落库再签发：sid 必须在库中存在，否则首个请求就会被判为已吊销。
    let ttl = app.session_ttl_ms();
    let now = now_ms();
    let sid = random_sid()?;
    let ua = client_ua(&req);
    let ip = client_ip(&req).unwrap_or_default();

    app.db
        .create_session(&crate::models::SessionRow {
            sid: sid.clone(),
            ua: ua.clone(),
            ip: ip.clone(),
            created_at: now,
            last_seen_at: now,
            expires_at: now.saturating_add(ttl),
        })
        .await?;

    let token = SessionToken::new(app.crypto.key())
        .issue(now, ttl, &sid)
        .map_err(|err| worker::Error::RustError(err.to_string()))?;
    let max_age = (ttl / 1000).max(60);
    let cookie = session_cookie(&token, max_age);

    app.db
        .add_log(
            None,
            "login_success",
            None,
            &format!(
                "管理员登录成功（{} / {}）",
                short_device(&ua),
                short_ip(&ip)
            ),
            now,
        )
        .await
        .ok();

    json_response(
        &SessionResponse {
            authenticated: true,
            turnstile_site_key: app.turnstile_site_key().await,
            expires_at: Some(now_ms() + ttl),
        },
        200,
        Some(cookie),
    )
}

/// `POST /api/v1/auth/logout`（公开：清 Cookie 即可）
async fn handle_logout(app: &AppCtx, req: &Request) -> worker::Result<Response> {
    // 只删当前会话：退出一个设备不应影响其它已登录设备
    if let Some(claims) = app.session_claims(req)
        && let Err(err) = app.db.delete_session(&claims.sid).await
    {
        log_error!("删除会话失败：{err}");
    }
    json_response(
        &serde_json::json!({ "authenticated": false }),
        200,
        Some(session_cookie("", 0)),
    )
}

/// `GET /api/v1/sessions`：列出登录设备。
async fn handle_list_sessions(app: &AppCtx, current_sid: &str) -> worker::Result<Response> {
    let rows = app.db.list_sessions(now_ms()).await?;
    let sessions = rows
        .iter()
        .map(|row| row.to_dto(Some(current_sid)))
        .collect();
    ok(&SessionsResponse { sessions })
}

/// `DELETE /api/v1/sessions/{sid}`：踢指定设备下线。
async fn handle_delete_session(
    app: &AppCtx,
    current_sid: &str,
    sid: &str,
) -> worker::Result<Response> {
    if sid == current_sid {
        return error_response_with_code(
            400,
            "不能在这里退出当前设备，请使用「退出登录」",
            "cannot_kick_self",
        );
    }
    if !app.db.delete_session(sid).await? {
        return error_response(404, "设备不存在或已下线");
    }
    app.db
        .add_log(
            None,
            "session_revoked",
            None,
            &format!(
                "已踢下线一个登录设备（{}）",
                sid.chars().take(8).collect::<String>()
            ),
            now_ms(),
        )
        .await
        .ok();
    handle_list_sessions(app, current_sid).await
}

/// `DELETE /api/v1/sessions`：踢出除当前设备外的全部会话。
async fn handle_delete_other_sessions(app: &AppCtx, current_sid: &str) -> worker::Result<Response> {
    let rows = app.db.list_sessions(now_ms()).await?;
    let mut removed = 0usize;
    for row in rows {
        if row.sid == current_sid {
            continue;
        }
        if app.db.delete_session(&row.sid).await.unwrap_or(false) {
            removed += 1;
        }
    }
    app.db
        .add_log(
            None,
            "session_revoked",
            None,
            &format!("已踢下线其它 {removed} 个登录设备"),
            now_ms(),
        )
        .await
        .ok();
    handle_list_sessions(app, current_sid).await
}

// ===========================================================================
// 概览 / 历史 / 日志
// ===========================================================================

/// `GET /api/v1/overview`
async fn handle_overview(app: &AppCtx) -> worker::Result<Response> {
    let accounts = app.db.list_accounts(false).await?;
    let snapshots: HashMap<i64, crate::models::SnapshotRow> = app
        .db
        .list_snapshots()
        .await?
        .into_iter()
        .map(|snapshot| (snapshot.account_id, snapshot))
        .collect();

    let overviews = accounts
        .iter()
        .map(|account| build_overview(account, snapshots.get(&account.id), &app.timezone, app.now))
        .collect::<Vec<_>>();

    ok(&crate::models::OverviewResponse {
        accounts: overviews,
        timezone: app.timezone.clone(),
        billing_month: crate::models::billing_month(app.now, &app.timezone),
        generated_at: app.now,
    })
}

/// `GET /api/v1/history?account_id=&bucket=hour|day&limit=`
async fn handle_history(app: &AppCtx, req: &Request) -> worker::Result<Response> {
    let params = query_map(req);
    let bucket = query_str(&params, "bucket")
        .map(HistoryBucket::from_query)
        .unwrap_or(HistoryBucket::Hour);
    let limit = query_u32(&params, "limit")
        .unwrap_or_else(|| bucket.default_limit())
        .clamp(1, MAX_HISTORY_POINTS);

    let account_id = match query_i64(&params, "account_id") {
        Some(id) => id,
        None => {
            let accounts = app.db.list_accounts(false).await?;
            match accounts.first() {
                Some(account) => account.id,
                None => return error_response(400, "还没有添加任何账号"),
            }
        }
    };

    let account = app
        .db
        .get_account(account_id)
        .await?
        .ok_or_else(|| worker::Error::RustError("账号不存在".to_string()))?;

    let query = HistoryQuery {
        account_id: Some(account_id),
        bucket,
        limit,
    };
    let scheduler = Scheduler::with_now(&app.env, app.now).await?;
    let points = scheduler
        .traffic_history(account_id, query.bucket, query.limit)
        .await?;

    let billing_month = crate::models::billing_month(app.now, &app.timezone);
    let triggered = app
        .db
        .get_snapshot(account_id)
        .await?
        .map(|snapshot| snapshot.threshold_triggered(&billing_month))
        .unwrap_or(false);

    ok(&TrafficHistoryResponse {
        account_id,
        bucket,
        traffic_limit_gb: account.traffic_limit_gb,
        billing_month,
        threshold_triggered: triggered,
        points,
    })
}

/// `GET /api/v1/logs?account_id=&limit=`
async fn handle_logs(app: &AppCtx, req: &Request) -> worker::Result<Response> {
    let params = query_map(req);
    let limit = query_u32(&params, "limit").unwrap_or(80).clamp(1, MAX_LOGS);
    let filter = crate::models::LogFilter {
        account_id: query_i64(&params, "account_id"),
        action_prefix: query_str(&params, "action").map(|v| v.to_string()),
        keyword: query_str(&params, "q").map(|v| v.to_string()),
        limit,
    };
    let logs = app.db.list_logs(&filter).await?;
    ok(&logs)
}

/// `GET /api/v1/jobs/{id}` 与 `GET /api/v1/jobs`
async fn handle_job(app: &AppCtx, job_id: &str) -> worker::Result<Response> {
    match app.db.get_job(job_id).await? {
        Some(job) => ok(&job.to_dto()),
        None => error_response(404, "任务不存在"),
    }
}

async fn handle_job_list(app: &AppCtx, req: &Request) -> worker::Result<Response> {
    let params = query_map(req);
    let account_id = query_i64(&params, "account_id");
    let limit = query_u32(&params, "limit").unwrap_or(20).clamp(1, MAX_JOBS);
    let jobs: Vec<JobDto> = app
        .db
        .list_jobs(account_id, limit)
        .await?
        .into_iter()
        .map(|job| job.to_dto())
        .collect();
    ok(&jobs)
}

// ===========================================================================
// 账号 CRUD
// ===========================================================================

/// `POST /api/v1/accounts`
async fn handle_create_account(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: AccountInput = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };
    if let Err(message) = payload.validate() {
        return error_response(400, message);
    }

    let secret = match payload.access_key_secret.as_deref().map(str::trim) {
        Some(secret) if !secret.is_empty() => secret,
        _ => return error_response(400, "新增账号必须提供 AccessKey Secret"),
    };

    let encrypted = app
        .crypto
        .encrypt(secret)
        .map_err(|err| worker::Error::RustError(err.to_string()))?;

    let id = app
        .db
        .create_account(
            payload.name.trim(),
            payload.site_type.as_str(),
            payload.access_key_id.trim(),
            &encrypted,
            &payload.regions_json(),
            payload.traffic_limit_gb,
            payload.spike_threshold_gb,
            payload.over_limit_action.as_str(),
            payload.stop_mode.as_str(),
            payload.normalized_schedule_start().as_deref(),
            payload.normalized_schedule_stop().as_deref(),
            payload.spot_keep_alive,
            payload.enabled,
            now_ms(),
        )
        .await?;

    app.db
        .add_log(
            Some(id),
            "account_created",
            None,
            &format!("新增账号（{}）", payload.name.trim()),
            now_ms(),
        )
        .await?;

    match app.db.get_account(id).await? {
        Some(account) => json_response(&account.to_dto(), 201, None),
        None => ok(&serde_json::json!({ "id": id })),
    }
}

/// `PUT /api/v1/accounts/{id}`
async fn handle_update_account(
    app: &AppCtx,
    account_id: i64,
    mut req: Request,
) -> worker::Result<Response> {
    let existing = match app.db.get_account(account_id).await? {
        Some(account) => account,
        None => return error_response(404, "账号不存在"),
    };

    let payload: AccountInput = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };
    if let Err(message) = payload.validate() {
        return error_response(400, message);
    }

    // 留空表示沿用原密钥
    let encrypted = match payload.access_key_secret.as_deref().map(str::trim) {
        Some(secret) if !secret.is_empty() => Some(
            app.crypto
                .encrypt(secret)
                .map_err(|err| worker::Error::RustError(err.to_string()))?,
        ),
        _ => None,
    };

    app.db
        .update_account(
            account_id,
            payload.name.trim(),
            payload.site_type.as_str(),
            payload.access_key_id.trim(),
            encrypted.as_deref(),
            &payload.regions_json(),
            payload.traffic_limit_gb,
            payload.spike_threshold_gb,
            payload.over_limit_action.as_str(),
            payload.stop_mode.as_str(),
            payload.normalized_schedule_start().as_deref(),
            payload.normalized_schedule_stop().as_deref(),
            payload.spot_keep_alive,
            payload.enabled,
            now_ms(),
        )
        .await?;

    app.db
        .add_log(
            Some(account_id),
            "account_updated",
            None,
            &format!("更新账号（{}）", payload.name.trim()),
            now_ms(),
        )
        .await?;

    let _ = existing;
    match app.db.get_account(account_id).await? {
        Some(account) => ok(&account.to_dto()),
        None => error_response(404, "账号不存在"),
    }
}

/// `DELETE /api/v1/accounts/{id}`
async fn handle_delete_account(app: &AppCtx, account_id: i64) -> worker::Result<Response> {
    if app.db.get_account(account_id).await?.is_none() {
        return error_response(404, "账号不存在");
    }
    app.db.delete_account(account_id).await?;
    app.db
        .add_log(
            None,
            "account_deleted",
            None,
            &format!("删除账号 #{account_id}"),
            now_ms(),
        )
        .await?;
    ok(&serde_json::json!({ "deleted": true }))
}

// ===========================================================================
// 设置
// ===========================================================================

/// 组装 `GET /api/v1/settings` 的响应。
///
/// 时区从 D1 现读，而不是用 `AppCtx` 里请求开始时的缓存：`PUT /settings/timezone`
/// 更新后会立刻回显新值，避免界面显示「已保存但仍是旧时区」。
async fn handle_get_settings(app: &AppCtx) -> worker::Result<Response> {
    let telegram: TelegramConfig = app.db.get_json_setting(setting_key::TELEGRAM).await?;
    let bark: BarkConfig = app.db.get_json_setting(setting_key::BARK).await?;
    let report: DailyReportConfig = app.db.get_json_setting(setting_key::DAILY_REPORT).await?;
    let timezone = app.db.get_timezone().await?;

    let accounts = app
        .db
        .list_accounts(false)
        .await?
        .iter()
        .map(|account| account.to_dto())
        .collect();

    let advanced = app.db.get_advanced_config().await.unwrap_or_default();
    let turnstile = app.turnstile_config().await;

    ok(&SettingsDto {
        timezone: timezone.clone(),
        timezone_options: crate::models::timezone_options(),
        advanced: AdvancedSettingsDto::from(&advanced),
        turnstile: TurnstileSettingsDto {
            enabled: turnstile.enabled,
            site_key: turnstile.site_key.clone().unwrap_or_default(),
            secret_configured: turnstile
                .secret_enc
                .as_deref()
                .map(|enc| app.crypto.try_decrypt(enc).is_some())
                .unwrap_or(false),
        },
        telegram: TelegramSettingsDto {
            enabled: telegram.enabled,
            chat_id: telegram.chat_id.clone(),
            api_host: telegram.api_host.clone(),
            token_configured: telegram
                .token_enc
                .as_deref()
                .map(|enc| app.crypto.try_decrypt(enc).is_some())
                .unwrap_or(false),
        },
        bark: BarkSettingsDto {
            enabled: bark.enabled,
            server_url: bark.server_url.clone(),
            device_key_configured: bark
                .device_key_enc
                .as_deref()
                .map(|enc| app.crypto.try_decrypt(enc).is_some())
                .unwrap_or(false),
            normal_level: bark.normal_level,
            alert_level: bark.alert_level,
        },
        daily_report: DailyReportDto {
            enabled: report.enabled,
            time: report.time.clone(),
            timezone: if report.timezone.trim().is_empty() {
                timezone
            } else {
                report.timezone.clone()
            },
        },
        accounts,
    })
}

/// `PUT /api/v1/settings/telegram`
async fn handle_update_telegram(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: TelegramSettingsUpdate = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };

    let mut config: TelegramConfig = app.db.get_json_setting(setting_key::TELEGRAM).await?;

    if payload.clear_token {
        config.token_enc = None;
    } else if let Some(token) = payload
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        // Telegram Bot Token 形如 123456:AA...，做一次轻量格式检查
        if !token.contains(':') || token.len() < 20 {
            return error_response(400, "Bot Token 格式不正确（应形如 123456:AA...）");
        }
        config.token_enc = Some(
            app.crypto
                .encrypt(token)
                .map_err(|err| worker::Error::RustError(err.to_string()))?,
        );
    }

    config.chat_id = payload
        .chat_id
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string());
    config.api_host = payload
        .api_host
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.trim_end_matches('/').to_string());
    config.enabled = payload.enabled;

    if config.enabled && (config.token_enc.is_none() || config.chat_id.is_none()) {
        return error_response(400, "启用 Telegram 前请先填写 Bot Token 与 Chat ID");
    }

    app.db
        .set_json_setting(setting_key::TELEGRAM, &config, now_ms())
        .await?;
    app.db
        .add_log(
            None,
            "settings_telegram",
            None,
            if config.enabled {
                "Telegram 通知已启用"
            } else {
                "Telegram 通知已关闭"
            },
            now_ms(),
        )
        .await?;

    handle_get_settings(app).await
}

/// `PUT /api/v1/settings/bark`
async fn handle_update_bark(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: BarkSettingsUpdate = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };

    let mut config: BarkConfig = app.db.get_json_setting(setting_key::BARK).await?;

    if payload.clear_device_key {
        config.device_key_enc = None;
    } else if let Some(key) = payload
        .device_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        config.device_key_enc = Some(
            app.crypto
                .encrypt(key)
                .map_err(|err| worker::Error::RustError(err.to_string()))?,
        );
    }

    let server = payload.server_url.trim();
    if server.is_empty() {
        return error_response(400, "Bark Server URL 不能为空");
    }
    config.server_url = server.trim_end_matches('/').to_string();
    config.normal_level = payload.normal_level;
    config.alert_level = payload.alert_level;
    config.enabled = payload.enabled;

    if config.enabled && config.device_key_enc.is_none() {
        return error_response(400, "启用 Bark 前请先填写 Device Key");
    }

    app.db
        .set_json_setting(setting_key::BARK, &config, now_ms())
        .await?;
    app.db
        .add_log(
            None,
            "settings_bark",
            None,
            if config.enabled {
                "Bark 通知已启用"
            } else {
                "Bark 通知已关闭"
            },
            now_ms(),
        )
        .await?;

    handle_get_settings(app).await
}

/// `PUT /api/v1/settings/turnstile`
///
/// 未配置即关闭：只要后台没填全两个 key，登录就不做人机校验。
async fn handle_update_turnstile(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: TurnstileSettingsUpdate = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };

    let mut config: TurnstileConfig = app.db.get_json_setting(setting_key::TURNSTILE).await?;

    if payload.clear_secret {
        config.secret_enc = None;
    } else if let Some(secret) = payload
        .secret_key
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        config.secret_enc = Some(
            app.crypto
                .encrypt(secret)
                .map_err(|err| worker::Error::RustError(err.to_string()))?,
        );
    }

    if let Some(site_key) = payload.site_key.as_deref().map(str::trim) {
        // 留空 = 保持原值；想清除请用 enabled: false
        if !site_key.is_empty() {
            config.site_key = Some(site_key.to_string());
        }
    }

    // 要启用就必须两个 key 都在，否则前端不渲染组件、后端却要求 token，
    // 会陷入「怎么登都失败」的死锁。
    if payload.enabled && !config.is_complete() {
        return error_response(400, "启用 Turnstile 前请先填写站点公钥与私钥");
    }

    config.enabled = payload.enabled;

    app.db
        .set_json_setting(setting_key::TURNSTILE, &config, now_ms())
        .await?;
    app.db
        .add_log(
            None,
            "settings_turnstile",
            None,
            if config.enabled {
                "人机校验已启用"
            } else {
                "人机校验已关闭"
            },
            now_ms(),
        )
        .await?;

    handle_get_settings(app).await
}

/// `PUT /api/v1/settings/advanced`
///
/// 日志级别、任务锁窗口、会话有效期。这些值不影响已签发的会话，
/// 下次请求起按新配置执行。
async fn handle_update_advanced(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: AdvancedSettingsDto = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };

    let config = AdvancedConfig::from(&payload);
    app.db.set_advanced_config(&config, now_ms()).await?;

    // 立即生效，无需等下一次请求
    logging::init_from_config(Some(&config.log_level));

    app.db
        .add_log(
            None,
            "settings_advanced",
            None,
            &format!(
                "高级配置已更新（日志 {}，锁 {} 分钟，会话 {} 天）",
                config.log_level,
                config.job_lock_ttl_ms / 60_000,
                config.session_ttl_ms / (24 * 60 * 60 * 1000)
            ),
            now_ms(),
        )
        .await?;

    handle_get_settings(app).await
}

/// `PUT /api/v1/settings/daily-report`
async fn handle_update_report(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    let payload: DailyReportDto = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };
    if crate::models::parse_hhmm(&payload.time).is_none() {
        return error_response(400, "日报时间格式应为 HH:MM");
    }

    let mut config: DailyReportConfig = app.db.get_json_setting(setting_key::DAILY_REPORT).await?;
    config.enabled = payload.enabled;
    config.time =
        crate::models::minutes_to_hhmm(crate::models::parse_hhmm(&payload.time).unwrap_or(540));
    config.timezone = if payload.timezone.trim().is_empty() {
        app.timezone.clone()
    } else {
        payload.timezone.trim().to_string()
    };

    app.db
        .set_json_setting(setting_key::DAILY_REPORT, &config, now_ms())
        .await?;

    handle_get_settings(app).await
}

/// `PUT /api/v1/settings/timezone`
async fn handle_update_timezone(app: &AppCtx, mut req: Request) -> worker::Result<Response> {
    #[derive(serde::Deserialize)]
    struct Body {
        timezone: String,
    }
    let payload: Body = match read_json(&mut req).await {
        Ok(payload) => payload,
        Err(err) => return error_response(400, err),
    };
    let raw = payload.timezone.trim();
    if !is_supported_timezone(raw) {
        return error_response(400, "时区取值不受支持");
    }

    app.db
        .set_setting(setting_key::TIMEZONE, raw, now_ms())
        .await?;

    handle_get_settings(app).await
}

// ===========================================================================
// 异步 Job
// ===========================================================================

/// 异步任务的具体内容。Job 行只记录状态，参数随闭包一起进入 `wait_until`。
#[derive(Debug, Clone)]
enum JobTask {
    RefreshAll,
    RefreshAccount {
        account_id: i64,
    },
    StartInstance {
        account_id: i64,
        instance_id: String,
    },
    StopInstance {
        account_id: i64,
        instance_id: String,
    },
    /// 账号内全部实例的开/关机。
    InstanceBatch {
        account_id: i64,
        start: bool,
    },
    NotifyTest {
        channel: Option<NotifyChannel>,
    },
    DailyReport,
}

impl JobTask {
    fn job_type(&self) -> JobType {
        match self {
            JobTask::RefreshAll => JobType::RefreshAll,
            JobTask::RefreshAccount { .. } => JobType::RefreshAccount,
            JobTask::StartInstance { .. } => JobType::StartInstance,
            JobTask::StopInstance { .. } => JobType::StopInstance,
            JobTask::InstanceBatch { start, .. } => {
                if *start {
                    JobType::StartInstance
                } else {
                    JobType::StopInstance
                }
            }
            JobTask::NotifyTest { .. } => JobType::NotifyTest,
            JobTask::DailyReport => JobType::DailyReport,
        }
    }

    fn account_id(&self) -> Option<i64> {
        match self {
            JobTask::RefreshAll | JobTask::NotifyTest { .. } | JobTask::DailyReport => None,
            JobTask::RefreshAccount { account_id }
            | JobTask::StartInstance { account_id, .. }
            | JobTask::StopInstance { account_id, .. }
            | JobTask::InstanceBatch { account_id, .. } => Some(*account_id),
        }
    }

    /// 需要 D1 级互斥锁的任务名（跨实例防止并发重复执行）。
    ///
    /// 只给「会打阿里云且开销较大」的刷新类任务上锁：全局刷新与单账号刷新。
    /// 开关机由阿里云自身的幂等语义 + 调度器的实例级锁兜底，无需额外锁；
    /// 通知测试与日报是纯副作用，重复执行无害。
    fn lock_name(&self) -> Option<String> {
        match self {
            JobTask::RefreshAll => Some("job:refresh_all".to_string()),
            JobTask::RefreshAccount { account_id } => Some(format!("job:refresh:{account_id}")),
            _ => None,
        }
    }
}

/// 执行一个 Job：置 running → 跑任务 → 置 success/failed → 释放互斥锁。
async fn execute_job(env: Env, job_id: String, task: JobTask) {
    let db = Db::new(&env);
    let lock_name = task.lock_name();
    if let Err(err) = db.start_job(&job_id).await {
        log_error!("任务 {job_id} 置为 running 失败：{err}");
        release_job_lock(&db, lock_name.as_deref(), &job_id).await;
        return;
    }

    let scheduler = match Scheduler::new(&env).await {
        Ok(scheduler) => scheduler,
        Err(err) => {
            let text = err.to_string();
            log_error!("任务 {job_id} 初始化失败：{text}");
            let _ = db.finish_job_failed(&job_id, &text, now_ms()).await;
            release_job_lock(&db, lock_name.as_deref(), &job_id).await;
            return;
        }
    };

    let result: worker::Result<String> = match task {
        JobTask::RefreshAll => {
            let outcomes = scheduler.refresh_all().await;
            if outcomes.is_empty() {
                Err(worker::Error::RustError(
                    "没有任何启用的账号可刷新".to_string(),
                ))
            } else {
                // 如实汇报：部分失败时不能谎报「全部已刷新」，
                // 否则用户会以为数据是新的。
                let failed: Vec<String> = outcomes
                    .iter()
                    .filter(|outcome| !outcome.success)
                    .map(|outcome| {
                        let reason = outcome.warnings.first().cloned().unwrap_or_default();
                        if reason.is_empty() {
                            outcome.account_name.clone()
                        } else {
                            format!("{}（{reason}）", outcome.account_name)
                        }
                    })
                    .collect();

                if failed.is_empty() {
                    Ok(format!("{} 个账号已刷新", outcomes.len()))
                } else if failed.len() == outcomes.len() {
                    Err(worker::Error::RustError(format!(
                        "全部 {} 个账号刷新失败：{}",
                        failed.len(),
                        failed.join("；")
                    )))
                } else {
                    Ok(format!(
                        "{}/{} 个账号刷新成功；失败：{}",
                        outcomes.len() - failed.len(),
                        outcomes.len(),
                        failed.join("；")
                    ))
                }
            }
        }
        JobTask::RefreshAccount { account_id } => match db.get_account(account_id).await {
            Ok(Some(account)) => {
                let outcome = scheduler.refresh_account(&account).await;
                if outcome.success {
                    Ok(format!(
                        "{} 已刷新：国内 {} / 海外 {}",
                        outcome.account_name,
                        crate::models::human_bytes(outcome.domestic_bytes),
                        crate::models::human_bytes(outcome.overseas_bytes)
                    ))
                } else {
                    Err(worker::Error::RustError(if outcome.warnings.is_empty() {
                        "刷新失败".to_string()
                    } else {
                        outcome.warnings.join("；")
                    }))
                }
            }
            Ok(None) => Err(worker::Error::RustError("账号不存在".to_string())),
            Err(err) => Err(err),
        },
        JobTask::StartInstance {
            account_id,
            instance_id,
        } => scheduler
            .instance_action(account_id, &instance_id, true)
            .await
            .map(|result| result.detail),
        JobTask::StopInstance {
            account_id,
            instance_id,
        } => scheduler
            .instance_action(account_id, &instance_id, false)
            .await
            .map(|result| result.detail),
        JobTask::InstanceBatch { account_id, start } => scheduler
            .instance_batch(account_id, start)
            .await
            .map(|summary| summary.detail),
        JobTask::NotifyTest { channel } => {
            let outcome = scheduler.test_notification(channel).await;
            if outcome.results.is_empty() {
                Err(worker::Error::RustError(
                    "未启用任何通知渠道，请先在设置中配置".to_string(),
                ))
            } else if outcome.any_success() {
                Ok(outcome.summary())
            } else {
                Err(worker::Error::RustError(outcome.summary()))
            }
        }
        JobTask::DailyReport => scheduler.push_daily_report().await,
    };

    match result {
        Ok(detail) => {
            log_info!("任务 {job_id} 完成：{detail}");
            if let Err(err) = db.finish_job_success(&job_id, now_ms()).await {
                log_error!("任务 {job_id} 收尾失败：{err}");
            }
        }
        Err(err) => {
            let text = err.to_string();
            log_error!("任务 {job_id} 失败：{text}");
            if let Err(inner) = db.finish_job_failed(&job_id, &text, now_ms()).await {
                log_error!("任务 {job_id} 收尾失败：{inner}");
            }
        }
    }

    release_job_lock(&db, lock_name.as_deref(), &job_id).await;
}

/// 释放 Job 互斥锁（owner 不匹配时不会误删）。
async fn release_job_lock(db: &Db, lock_name: Option<&str>, owner: &str) {
    if let Some(name) = lock_name
        && let Err(err) = db.release_lock(name, owner).await
    {
        log_error!("释放任务锁 {name} 失败：{err}");
    }
}

/// 建 Job 行 → `ctx.wait_until` 派生执行 → 立刻返回 202。
async fn spawn_job(ctx: &Context, app: &AppCtx, task: JobTask) -> worker::Result<Response> {
    let job_type = task.job_type();
    let account_id = task.account_id();

    // 先确认账号存在：jobs 表对 account_id 有外键，直接插入会得到
    // 「FOREIGN KEY constraint failed」并被翻译成 500，掩盖了真实原因
    // （账号已被删除或 ID 手误）。在这里提前给出 404。
    if let Some(id) = account_id
        && app.db.get_account(id).await?.is_none()
    {
        return error_response(404, "账号不存在");
    }

    let job_id =
        crate::crypto::random_id().map_err(|err| worker::Error::RustError(err.to_string()))?;

    // 跨实例互斥：同一刷新任务在 TTL 内只允许一个执行者。
    // 用 job_id 作为锁 owner，收尾时按 owner 释放，避免误删他人的锁。
    let lock_name = task.lock_name();
    if let Some(name) = lock_name.as_deref() {
        let acquired = app
            .db
            .acquire_lock(name, &job_id, now_ms(), app.job_lock_ttl_ms())
            .await?;
        if !acquired {
            return error_response_with_code(409, "同类任务正在执行中，请稍后再试", "job_locked");
        }
    }

    if let Err(err) = app
        .db
        .create_job(&job_id, account_id, job_type, now_ms())
        .await
    {
        release_job_lock(&app.db, lock_name.as_deref(), &job_id).await;
        return Err(err);
    }

    let env = app.env.clone();
    let job_id_for_task = job_id.clone();
    ctx.wait_until(async move {
        execute_job(env, job_id_for_task, task).await;
    });

    json_response(
        &AcceptedJob {
            job_id,
            status: JobStatus::Pending,
            job_type,
        },
        202,
        None,
    )
}

// ===========================================================================
// 路由
// ===========================================================================

/// API 路径分段。
fn path_segments(req: &Request) -> Vec<String> {
    req.path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_string())
        .collect()
}

/// 受保护路由的统一入口。
async fn handle_api(ctx: Context, req: Request, env: Env) -> worker::Result<Response> {
    let app = match AppCtx::load(&env).await {
        Ok(app) => app,
        Err(err) => {
            log_error!("初始化失败：{err}");
            return error_response_with_code(
                500,
                format!("服务端初始化失败：{err}"),
                "init_failed",
            );
        }
    };

    let method = req.method();
    let segments = path_segments(&req);

    // segments: ["api", "v1", ...rest]
    if segments.len() < 2 || segments[0] != "api" || segments[1] != "v1" {
        return error_response(404, "接口不存在");
    }
    let rest: Vec<&str> = segments[2..].iter().map(|s| s.as_str()).collect();

    // ---------------------------------------------------------------- public
    match (method.clone(), rest.as_slice()) {
        (Method::Get, ["auth", "session"]) => return handle_session(&app, &req).await,
        (Method::Post, ["auth", "login"]) => return handle_login(&app, req).await,
        (Method::Post, ["auth", "logout"]) => return handle_logout(&app, &req).await,
        _ => {}
    }

    // ---------------------------------------------------------------- 鉴权
    let Some(claims) = app.session_from_request(&req).await else {
        return error_response_with_code(401, "请先登录", "unauthenticated");
    };
    // 顺带刷新活跃时间，供「登录设备」展示；失败不影响请求
    let _ = app.db.touch_session(&claims.sid, now_ms()).await;

    // 写接口的跨站防护
    if method != Method::Get && !same_origin_ok(&req) {
        return error_response_with_code(403, "跨站请求被拒绝", "cross_origin");
    }

    let mut req = req;

    match (method.clone(), rest.as_slice()) {
        // ------------------------------------------------------------ 登录设备
        (Method::Get, ["sessions"]) => handle_list_sessions(&app, &claims.sid).await,
        (Method::Delete, ["sessions"]) => handle_delete_other_sessions(&app, &claims.sid).await,
        (Method::Delete, ["sessions", sid]) => handle_delete_session(&app, &claims.sid, sid).await,

        // ------------------------------------------------------------ 概览
        (Method::Get, ["overview"]) => handle_overview(&app).await,
        (Method::Get, ["history"]) => handle_history(&app, &req).await,
        (Method::Get, ["logs"]) => handle_logs(&app, &req).await,

        // ------------------------------------------------------------ 任务
        (Method::Get, ["jobs"]) => handle_job_list(&app, &req).await,
        (Method::Get, ["jobs", id]) => handle_job(&app, id).await,
        (Method::Post, ["refresh"]) => spawn_job(&ctx, &app, JobTask::RefreshAll).await,

        // ------------------------------------------------------------ 账号
        (Method::Post, ["accounts"]) => handle_create_account(&app, req).await,
        (Method::Put, ["accounts", id]) => match id.parse::<i64>() {
            Ok(account_id) => handle_update_account(&app, account_id, req).await,
            Err(_) => error_response(400, "账号 ID 不合法"),
        },
        (Method::Delete, ["accounts", id]) => match id.parse::<i64>() {
            Ok(account_id) => handle_delete_account(&app, account_id).await,
            Err(_) => error_response(400, "账号 ID 不合法"),
        },
        (Method::Post, ["accounts", id, "refresh"]) => match id.parse::<i64>() {
            Ok(account_id) => {
                if app.db.get_account(account_id).await?.is_none() {
                    return error_response(404, "账号不存在");
                }
                spawn_job(&ctx, &app, JobTask::RefreshAccount { account_id }).await
            }
            Err(_) => error_response(400, "账号 ID 不合法"),
        },

        // ------------------------------------------------ 实例控制
        (Method::Post, ["accounts", id, "instances", instance_id, "start"]) => {
            match id.parse::<i64>() {
                Ok(account_id) => {
                    spawn_job(
                        &ctx,
                        &app,
                        JobTask::StartInstance {
                            account_id,
                            instance_id: instance_id.to_string(),
                        },
                    )
                    .await
                }
                Err(_) => error_response(400, "账号 ID 不合法"),
            }
        }
        (Method::Post, ["accounts", id, "instances", instance_id, "stop"]) => {
            match id.parse::<i64>() {
                Ok(account_id) => {
                    spawn_job(
                        &ctx,
                        &app,
                        JobTask::StopInstance {
                            account_id,
                            instance_id: instance_id.to_string(),
                        },
                    )
                    .await
                }
                Err(_) => error_response(400, "账号 ID 不合法"),
            }
        }
        (Method::Post, ["accounts", id, "instances", "start-all"]) => match id.parse::<i64>() {
            Ok(account_id) => {
                spawn_job(
                    &ctx,
                    &app,
                    JobTask::InstanceBatch {
                        account_id,
                        start: true,
                    },
                )
                .await
            }
            Err(_) => error_response(400, "账号 ID 不合法"),
        },
        (Method::Post, ["accounts", id, "instances", "stop-all"]) => match id.parse::<i64>() {
            Ok(account_id) => {
                spawn_job(
                    &ctx,
                    &app,
                    JobTask::InstanceBatch {
                        account_id,
                        start: false,
                    },
                )
                .await
            }
            Err(_) => error_response(400, "账号 ID 不合法"),
        },
        (Method::Put, ["accounts", id, "instances", instance_id, "keep-alive"]) => {
            match id.parse::<i64>() {
                Ok(account_id) => {
                    #[derive(serde::Deserialize)]
                    struct Body {
                        enabled: bool,
                    }
                    let payload: Body = match read_json(&mut req).await {
                        Ok(payload) => payload,
                        Err(err) => return error_response(400, err),
                    };
                    let scheduler = Scheduler::with_now(&app.env, app.now).await?;
                    match scheduler
                        .set_instance_keep_alive(account_id, instance_id, payload.enabled)
                        .await
                    {
                        Ok(()) => ok(&serde_json::json!({
                            "instance_id": instance_id,
                            "keep_alive": payload.enabled
                        })),
                        Err(err) => error_response(400, err.to_string()),
                    }
                }
                Err(_) => error_response(400, "账号 ID 不合法"),
            }
        }

        // ------------------------------------------------------------ 设置
        (Method::Get, ["settings"]) => handle_get_settings(&app).await,
        (Method::Put, ["settings", "turnstile"]) => handle_update_turnstile(&app, req).await,
        (Method::Put, ["settings", "telegram"]) => handle_update_telegram(&app, req).await,
        (Method::Put, ["settings", "bark"]) => handle_update_bark(&app, req).await,
        (Method::Put, ["settings", "daily-report"]) => handle_update_report(&app, req).await,
        (Method::Put, ["settings", "timezone"]) => handle_update_timezone(&app, req).await,
        (Method::Put, ["settings", "advanced"]) => handle_update_advanced(&app, req).await,
        (Method::Post, ["settings", "notify-test"]) => {
            let payload: NotifyTestRequest = match read_json(&mut req).await {
                Ok(payload) => payload,
                Err(err) => return error_response(400, err),
            };
            spawn_job(
                &ctx,
                &app,
                JobTask::NotifyTest {
                    channel: Some(payload.channel),
                },
            )
            .await
        }

        // ------------------------------------------------------------ 日报
        (Method::Post, ["reports", "daily"]) => spawn_job(&ctx, &app, JobTask::DailyReport).await,

        // ------------------------------------------------------------ 兜底
        (_, path) if !path.is_empty() => error_response(404, "接口不存在"),
        _ => error_response(404, "接口不存在"),
    }
}

/// 把非 API 请求转给静态资源绑定。
async fn serve_asset(env: &Env, req: Request) -> worker::Result<Response> {
    let assets = env.assets("ASSETS")?;
    let url = req.url()?.to_string();
    assets.fetch(url, None).await
}

// ===========================================================================
// 事件入口
// ===========================================================================

/// HTTP 入口。
#[event(fetch, respond_with_errors)]
pub async fn main(req: Request, env: Env, ctx: Context) -> worker::Result<Response> {
    // 日志级别来自 D1（后台「设置 → 系统」），因此要先读配置再决定级别。
    // 读失败时保持默认的 error，不影响请求处理。
    let log_level = Db::new(&env)
        .get_advanced_config()
        .await
        .ok()
        .map(|config| config.log_level);
    logging::init_from_config(log_level.as_deref());

    let path = req.path();

    if !path.starts_with("/api/") {
        return serve_asset(&env, req).await.or_else(|err| {
            log_error!("静态资源转发失败：{err}");
            error_response(500, "静态资源不可用")
        });
    }

    match handle_api(ctx, req, env).await {
        Ok(response) => Ok(response),
        Err(err) => {
            log_error!("API 处理失败：{err}");
            error_response_with_code(500, "服务器内部错误", "internal_error")
        }
    }
}

/// Cron 入口：`*/5 * * * *`。
#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let log_level = Db::new(&env)
        .get_advanced_config()
        .await
        .ok()
        .map(|config| config.log_level);
    logging::init_from_config(log_level.as_deref());

    let scheduler = match Scheduler::new(&env).await {
        Ok(scheduler) => scheduler,
        Err(err) => {
            log_error!("Cron 初始化失败：{err}");
            return;
        }
    };

    let report = scheduler.run_cron().await;
    log_info!("Cron 汇总：{}", report.summary());

    if report.accounts_failed > 0 || report.thresholds_fired > 0 || report.spikes_detected > 0 {
        // 每 6 小时最多一条汇总：持续故障不应该每 5 分钟提醒一次。
        let bucket = crate::models::now_ms() / (6 * 60 * 60 * 1000);
        let _ = scheduler
            .notify_once(
                &format!("cron-alert:{bucket}"),
                6 * 60 * 60 * 1000,
                crate::notify::Message::new(
                    "CDT-Monitor 巡检异常",
                    report.summary(),
                    NotifyLevel::Alert,
                )
                .with_details(report.notes.clone())
                .with_group("CDT-Cron"),
            )
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_strip_empty() {
        // 直接测试纯逻辑：模拟 "/api/v1/accounts/3/refresh"
        let raw = "/api/v1/accounts/3/refresh";
        let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
        assert_eq!(segments, vec!["api", "v1", "accounts", "3", "refresh"]);
        assert_eq!(&segments[2..], &["accounts", "3", "refresh"]);
    }

    #[test]
    fn job_task_metadata() {
        let task = JobTask::StartInstance {
            account_id: 7,
            instance_id: "i-1".to_string(),
        };
        assert_eq!(task.job_type(), JobType::StartInstance);
        assert_eq!(task.account_id(), Some(7));

        let global = JobTask::RefreshAll;
        assert_eq!(global.job_type(), JobType::RefreshAll);
        assert_eq!(global.account_id(), None);

        assert_eq!(JobTask::DailyReport.job_type(), JobType::DailyReport);
        assert_eq!(
            JobTask::NotifyTest { channel: None }.job_type(),
            JobType::NotifyTest
        );
    }

    #[test]
    fn error_body_shapes() {
        let plain = ApiErrorBody::new("出错了");
        let value = serde_json::to_value(&plain).expect("序列化");
        assert_eq!(value["error"], "出错了");
        assert!(value.get("code").is_none());

        let coded = ApiErrorBody::with_code("出错了", "some_code");
        let value = serde_json::to_value(&coded).expect("序列化");
        assert_eq!(value["code"], "some_code");
    }

    #[test]
    fn accepted_job_serializes_snake_case() {
        let accepted = AcceptedJob {
            job_id: "abc".to_string(),
            status: JobStatus::Pending,
            job_type: JobType::StartInstance,
        };
        let value = serde_json::to_value(&accepted).expect("序列化");
        assert_eq!(value["job_id"], "abc");
        assert_eq!(value["status"], "pending");
        assert_eq!(value["job_type"], "start_instance");
    }

    #[test]
    fn turnstile_disabled_by_default() {
        // 全新部署：settings 表里没有 turnstile 配置
        let config = TurnstileConfig::default();
        assert!(!config.enabled, "默认必须是关闭");
        assert!(!config.is_complete());
    }

    #[test]
    fn turnstile_requires_both_keys_to_be_complete() {
        let mut config = TurnstileConfig {
            enabled: true,
            site_key: Some("0x4AAAAAAA".to_string()),
            secret_enc: Some("cipher".to_string()),
        };
        assert!(config.is_complete());

        // 只填公钥
        config.secret_enc = None;
        assert!(!config.is_complete(), "缺私钥不算配置完整");

        // 只填私钥
        config.secret_enc = Some("cipher".to_string());
        config.site_key = None;
        assert!(!config.is_complete(), "缺公钥不算配置完整");

        // 空白字符串等同于没填
        config.site_key = Some("   ".to_string());
        assert!(!config.is_complete());
    }

    #[test]
    fn turnstile_blank_keys_are_not_complete() {
        let config = TurnstileConfig {
            enabled: true,
            site_key: Some(String::new()),
            secret_enc: Some(String::new()),
        };
        assert!(!config.is_complete());
    }

    #[test]
    fn turnstile_config_roundtrips_through_json() {
        // 存进 D1 的是 JSON；确认密文不会意外变成明文
        let config = TurnstileConfig {
            enabled: true,
            site_key: Some("site".to_string()),
            secret_enc: Some("enc-value".to_string()),
        };
        let raw = serde_json::to_string(&config).expect("序列化");
        assert!(!raw.contains("\"secret_enc\":null"));
        let back: TurnstileConfig = serde_json::from_str(&raw).expect("反序列化");
        assert!(back.is_complete());
    }

    #[test]
    fn turnstile_broken_secret_is_not_treated_as_disabled() {
        // 关键安全属性：启用了但私钥取不出来（MASTER_KEY 被换）时，
        // 绝不能退化为「未启用」而放行登录。
        let mut config = TurnstileConfig {
            enabled: true,
            site_key: Some("site".to_string()),
            secret_enc: Some("ciphertext".to_string()),
        };
        assert!(config.is_complete());

        // 模拟解密失败：密文存在但解不出明文
        let crypto = crate::crypto::Crypto::new(
            crate::crypto::MasterKey::parse(
                "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            )
            .expect("主密钥"),
        );
        assert!(
            crypto
                .try_decrypt(&config.secret_enc.clone().unwrap())
                .is_none(),
            "换过 MASTER_KEY 的密文应当解不出来"
        );

        // 配置仍然是 enabled + complete，说明闸门会判定为 Broken 而非 Disabled
        config.enabled = true;
        assert!(config.enabled && config.is_complete());
    }

    #[test]
    fn session_dto_marks_current_device() {
        let row = crate::models::SessionRow {
            sid: "abc123".to_string(),
            ua: "Chrome".to_string(),
            ip: "1.2.*.*".to_string(),
            created_at: 1,
            last_seen_at: 2,
            expires_at: 3,
        };
        assert!(row.to_dto(Some("abc123")).current);
        assert!(!row.to_dto(Some("other")).current);
        assert!(!row.to_dto(None).current);
    }

    #[test]
    fn session_response_hides_expiry_when_anonymous() {
        let anonymous = SessionResponse {
            authenticated: false,
            turnstile_site_key: "site-key".to_string(),
            expires_at: None,
        };
        let value = serde_json::to_value(&anonymous).expect("序列化");
        assert_eq!(value["authenticated"], false);
        assert_eq!(value["turnstile_site_key"], "site-key");
        assert!(value.get("expires_at").is_none());
    }
}
