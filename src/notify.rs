//! # 通知渠道：Telegram + Bark
//!
//! 只保留这两条通道（原项目的 SMTP / 通用 Webhook / SOCKS5 代理均已移除）。
//!
//! * **Telegram**：直连 `https://api.telegram.org`，请求发往
//!   `/bot{token}/sendMessage`。消息用 HTML 解析模式，正文做转义。
//! * **Bark**：`POST {server_url}/push`，JSON 载荷。按消息级别在
//!   `active` / `timeSensitive` / `critical` 之间切换——普通通知用
//!   `normal_level`，熔断告警用 `alert_level`，`critical` 可穿透静音。
//!
//! 设计约束：
//! 1. **通知失败不影响主流程**。调度器把通知当作尽力而为的副作用，
//!    返回值只用于写日志与「测试发送」的界面反馈。
//! 2. **并发发送**：两个渠道并行，总耗时取最大值而不是相加。
//! 3. **超时**：Worker 单次 fetch 没有默认超时，这里用 `Delay` 与 fetch
//!    竞速做 8 秒上限，避免 Cron 被慢接口拖死。

use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use worker::{Delay, Fetch, Headers, Method, Request, RequestInit};

use crate::models::PushLevel;

/// 单次 fetch 超时（毫秒）。
pub const REQUEST_TIMEOUT_MS: u32 = 8_000;

// ===========================================================================
// 消息
// ===========================================================================

/// 通知级别：决定 Bark 使用哪一档推送强度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyLevel {
    /// 普通通知（日报、刷新结果、手动操作回执）。
    Normal,
    /// 熔断 / 异常告警（流量超限、停机失败、连续采集失败）。
    Alert,
}

impl NotifyLevel {
    pub fn is_alert(self) -> bool {
        matches!(self, NotifyLevel::Alert)
    }

    /// 根据级别选 Bark 推送档位。
    pub fn bark_level(self, normal: PushLevel, alert: PushLevel) -> PushLevel {
        match self {
            NotifyLevel::Normal => normal,
            NotifyLevel::Alert => alert,
        }
    }
}

/// 一条待发送的通知。
#[derive(Debug, Clone)]
pub struct Message {
    /// 标题（Bark 的 title / Telegram 的首行）。
    pub title: String,
    /// 正文主体。
    pub body: String,
    /// 附加明细行（每条渲染成一行 bullet）。
    pub details: Vec<String>,
    pub level: NotifyLevel,
    /// Bark 分组（同一分组会折叠）。
    pub group: String,
}

impl Message {
    pub fn new(title: impl Into<String>, body: impl Into<String>, level: NotifyLevel) -> Self {
        Self {
            title: title.into(),
            body: body.into(),
            details: Vec::new(),
            level,
            group: "CDT-Monitor".to_string(),
        }
    }

    pub fn alert(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(title, body, NotifyLevel::Alert)
    }

    pub fn info(title: impl Into<String>, body: impl Into<String>) -> Self {
        Self::new(title, body, NotifyLevel::Normal)
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.details.push(detail.into());
        self
    }

    pub fn with_details<I, S>(mut self, details: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.details.extend(details.into_iter().map(Into::into));
        self
    }

    pub fn with_group(mut self, group: impl Into<String>) -> Self {
        self.group = group.into();
        self
    }

    /// 纯文本渲染（Telegram 用）。
    pub fn plain_text(&self) -> String {
        let mut out = format!("【{}】\n{}", self.title, self.body);
        for detail in &self.details {
            out.push_str("\n• ");
            out.push_str(detail);
        }
        out
    }

    /// Bark 的 body（标题已单独传，避免重复）。
    pub fn bark_body(&self) -> String {
        let mut out = self.body.clone();
        for detail in &self.details {
            out.push('\n');
            out.push_str(detail);
        }
        out
    }

    /// HTML 转义（Telegram `parse_mode=HTML`）。
    fn html_text(&self) -> String {
        let mut out = format!(
            "<b>{}</b>\n{}",
            escape_html(&self.title),
            escape_html(&self.body)
        );
        for detail in &self.details {
            out.push_str("\n• ");
            out.push_str(&escape_html(detail));
        }
        out
    }
}

/// Telegram HTML 模式只需要转义这三个字符。
pub fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

// ===========================================================================
// 通道配置
// ===========================================================================

/// Telegram 通道（Token 已解密）。
#[derive(Debug, Clone)]
pub struct TelegramChannel {
    pub token: String,
    pub chat_id: String,
}

impl TelegramChannel {
    /// 官方 API 基址。
    pub const API_BASE: &'static str = "https://api.telegram.org";

    /// 完整的 sendMessage 地址。
    pub fn send_message_url(&self) -> String {
        format!("{}/bot{}/sendMessage", Self::API_BASE, self.token)
    }
}

/// Bark 通道（Device Key 已解密）。
#[derive(Debug, Clone)]
pub struct BarkChannel {
    pub server_url: String,
    pub device_key: String,
    pub normal_level: PushLevel,
    pub alert_level: PushLevel,
}

impl BarkChannel {
    /// 规范化推送地址：
    /// * `https://api.day.app` → `https://api.day.app/push`
    /// * `https://bark.example.com/bark` → `https://bark.example.com/bark/push`
    /// * 已以 `/push` 结尾时原样使用。
    pub fn push_url(&self) -> String {
        let raw = self.server_url.trim();
        let with_scheme = if raw.starts_with("http://") || raw.starts_with("https://") {
            raw.to_string()
        } else {
            format!("https://{raw}")
        };
        let base = with_scheme.trim_end_matches('/');
        if base.ends_with("/push") {
            base.to_string()
        } else {
            format!("{base}/push")
        }
    }
}

/// 所有已启用的通道。
#[derive(Debug, Clone, Default)]
pub struct Channels {
    pub telegram: Option<TelegramChannel>,
    pub bark: Option<BarkChannel>,
}

impl Channels {
    pub fn is_empty(&self) -> bool {
        self.telegram.is_none() && self.bark.is_none()
    }

    /// 已启用通道名（用于日志）。
    pub fn names(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.telegram.is_some() {
            out.push("telegram");
        }
        if self.bark.is_some() {
            out.push("bark");
        }
        out
    }
}

// ===========================================================================
// 发送结果
// ===========================================================================

/// 单个通道的发送结果。
#[derive(Debug, Clone, Serialize)]
pub struct ChannelResult {
    pub channel: String,
    pub success: bool,
    pub message: String,
}

impl ChannelResult {
    fn ok(channel: &str, message: impl Into<String>) -> Self {
        Self {
            channel: channel.to_string(),
            success: true,
            message: message.into(),
        }
    }

    fn fail(channel: &str, message: impl Into<String>) -> Self {
        Self {
            channel: channel.to_string(),
            success: false,
            message: message.into(),
        }
    }
}

/// 一轮通知的整体结果。
#[derive(Debug, Clone, Serialize)]
pub struct NotifyOutcome {
    pub results: Vec<ChannelResult>,
}

impl NotifyOutcome {
    /// 是否至少有一个通道成功（没有任何通道配置时视为「无需发送」，返回 true）。
    pub fn any_success(&self) -> bool {
        self.results.is_empty() || self.results.iter().any(|r| r.success)
    }

    /// 拼接失败原因，供日志使用。
    pub fn failures(&self) -> Vec<String> {
        self.results
            .iter()
            .filter(|r| !r.success)
            .map(|r| format!("{}：{}", r.channel, r.message))
            .collect()
    }

    /// 人类可读摘要（测试发送界面直接展示）。
    pub fn summary(&self) -> String {
        if self.results.is_empty() {
            return "未配置任何通知渠道".to_string();
        }
        self.results
            .iter()
            .map(|r| {
                format!(
                    "{} {}：{}",
                    r.channel,
                    if r.success { "✅" } else { "❌" },
                    r.message
                )
            })
            .collect::<Vec<_>>()
            .join("；")
    }
}

// ===========================================================================
// HTTP 基础设施
// ===========================================================================

/// 发起带正文的 POST 请求，返回 (状态码, 响应文本)。
async fn post_with_timeout(
    url: &str,
    content_type: &str,
    body: String,
) -> Result<(u16, String), String> {
    let headers = Headers::new();
    headers
        .set("Content-Type", content_type)
        .map_err(|e| format!("设置请求头失败：{e}"))?;
    headers
        .set("Accept", "application/json")
        .map_err(|e| format!("设置请求头失败：{e}"))?;
    headers
        .set("User-Agent", "cdt-monitor/0.1")
        .map_err(|e| format!("设置请求头失败：{e}"))?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(worker::wasm_bindgen::JsValue::from_str(&body)));

    let request = Request::new_with_init(url, &init).map_err(|e| format!("构造请求失败：{e}"))?;

    // fetch 与定时器竞争：谁先完成用谁。
    // `Fetch::send(&self)` 借用了 `Fetch`，所以要先把 `Fetch` 绑定到局部变量。
    let source = Fetch::Request(request);
    let fetch = source.send();
    let timeout = Delay::from(Duration::from_millis(REQUEST_TIMEOUT_MS as u64));
    let raced = futures_race(fetch, timeout).await;

    match raced {
        RaceResult::First(result) => {
            let mut response = result.map_err(|e| format!("网络请求失败：{e}"))?;
            let status = response.status_code();
            let text = response
                .text()
                .await
                .unwrap_or_else(|e| format!("<读取响应失败：{e}>"));
            Ok((status, text))
        }
        RaceResult::Second(()) => Err(format!("请求超过 {REQUEST_TIMEOUT_MS}ms 未完成")),
    }
}

enum RaceResult<T> {
    First(T),
    Second(()),
}

/// 极简的「两个 future 竞速」实现。
///
/// 不用 `futures` crate 是为了避免额外依赖；这里只需要「A 完成或超时」，
/// 因此用 `poll_fn` 手动轮询，超时分支固定返回 `Second(())`。
async fn futures_race<F, T>(future: F, timeout: worker::Delay) -> RaceResult<T>
where
    F: std::future::Future<Output = T>,
{
    use std::future::Future;
    use std::pin::pin;
    use std::task::Poll;

    let mut future = pin!(future);
    let mut timeout = pin!(timeout);

    std::future::poll_fn(move |cx| {
        if let Poll::Ready(value) = future.as_mut().poll(cx) {
            return Poll::Ready(RaceResult::First(value));
        }
        if let Poll::Ready(()) = timeout.as_mut().poll(cx) {
            return Poll::Ready(RaceResult::Second(()));
        }
        Poll::Pending
    })
    .await
}

// ===========================================================================
// Telegram
// ===========================================================================

/// 发送 Telegram 消息。
pub async fn send_telegram(channel: &TelegramChannel, message: &Message) -> ChannelResult {
    let url = channel.send_message_url();
    let payload = format!(
        "chat_id={}&text={}&parse_mode=HTML&disable_web_page_preview=true",
        urlencode(&channel.chat_id),
        urlencode(&message.html_text()),
    );

    match post_with_timeout(&url, "application/x-www-form-urlencoded", payload).await {
        Ok((status, body)) => {
            if (200..300).contains(&status) && telegram_ok(&body) {
                ChannelResult::ok("telegram", "已送达")
            } else {
                ChannelResult::fail("telegram", telegram_error(&status, &body))
            }
        }
        Err(err) => ChannelResult::fail("telegram", err),
    }
}

/// Telegram 响应里 `"ok":true` 表示成功。
fn telegram_ok(body: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(value) => value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        Err(_) => false,
    }
}

/// 从 Telegram 错误响应里提取 `description`。
fn telegram_error(status: &u16, body: &str) -> String {
    let description = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| truncate(body, 160));
    format!("HTTP {status}：{description}")
}

// ===========================================================================
// Bark
// ===========================================================================

/// Bark `/push` 请求体。
#[derive(Debug, Serialize)]
struct BarkPayload<'a> {
    device_key: &'a str,
    title: &'a str,
    body: String,
    level: &'a str,
    group: &'a str,
    /// 告警用 `alarm` 声音，普通通知用默认。
    sound: &'a str,
    /// 服务端自动复制到剪贴板（仅告警）。
    auto_copy: bool,
    /// 通知角标（Bark 会累加）。
    badge: u32,
}

/// 发送 Bark 推送。
pub async fn send_bark(channel: &BarkChannel, message: &Message) -> ChannelResult {
    let level = message
        .level
        .bark_level(channel.normal_level, channel.alert_level);
    let payload = BarkPayload {
        device_key: &channel.device_key,
        title: &message.title,
        body: message.bark_body(),
        level: level.as_str(),
        group: &message.group,
        sound: if message.level.is_alert() {
            "alarm"
        } else {
            "minuet"
        },
        auto_copy: message.level.is_alert(),
        badge: if message.level.is_alert() { 1 } else { 0 },
    };

    let body = match serde_json::to_string(&payload) {
        Ok(body) => body,
        Err(err) => return ChannelResult::fail("bark", format!("序列化失败：{err}")),
    };

    match post_with_timeout(&channel.push_url(), "application/json", body).await {
        Ok((status, response)) => {
            if (200..300).contains(&status) && bark_ok(&response) {
                ChannelResult::ok("bark", format!("已送达（{}）", level.as_str()))
            } else {
                ChannelResult::fail("bark", bark_error(&status, &response))
            }
        }
        Err(err) => ChannelResult::fail("bark", err),
    }
}

/// Bark 成功时返回 `{"code":200,...}`；部分自建服务只回 `200` 文本。
fn bark_ok(body: &str) -> bool {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return true;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) => value
            .get("code")
            .and_then(|v| v.as_i64())
            .map(|code| code == 200)
            .unwrap_or(true),
        Err(_) => trimmed == "200",
    }
}

fn bark_error(status: &u16, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| truncate(body, 160));
    format!("HTTP {status}：{detail}")
}

// ===========================================================================
// 统一入口
// ===========================================================================

/// 向所有已启用通道发送同一条消息（并行）。
///
/// 永不返回 `Err`：每个通道的失败都收进 `NotifyOutcome`，由调用方决定
/// 是写日志还是界面提示。
pub async fn dispatch(channels: &Channels, message: &Message) -> NotifyOutcome {
    if channels.is_empty() {
        return NotifyOutcome {
            results: Vec::new(),
        };
    }

    // 两个通道并行：用 join 语义手写（避免引入 futures::join）。
    let telegram_fut = async {
        match &channels.telegram {
            Some(channel) => Some(send_telegram(channel, message).await),
            None => None,
        }
    };
    let bark_fut = async {
        match &channels.bark {
            Some(channel) => Some(send_bark(channel, message).await),
            None => None,
        }
    };

    let (telegram_result, bark_result) = join2(telegram_fut, bark_fut).await;

    let mut results = Vec::new();
    if let Some(result) = telegram_result {
        results.push(result);
    }
    if let Some(result) = bark_result {
        results.push(result);
    }
    NotifyOutcome { results }
}

/// 极简 `join`：两个 future 都完成后返回各自结果。
async fn join2<A, B, FA, FB>(fa: FA, fb: FB) -> (A, B)
where
    FA: std::future::Future<Output = A>,
    FB: std::future::Future<Output = B>,
{
    use std::pin::pin;
    use std::task::Poll;

    let mut fa = pin!(fa);
    let mut fb = pin!(fb);
    let mut out_a: Option<A> = None;
    let mut out_b: Option<B> = None;

    std::future::poll_fn(move |cx| {
        if out_a.is_none()
            && let Poll::Ready(value) = fa.as_mut().poll(cx)
        {
            out_a = Some(value);
        }
        if out_b.is_none()
            && let Poll::Ready(value) = fb.as_mut().poll(cx)
        {
            out_b = Some(value);
        }
        match (out_a.is_some(), out_b.is_some()) {
            (true, true) => {
                Poll::Ready((out_a.take().expect("已就绪"), out_b.take().expect("已就绪")))
            }
            _ => Poll::Pending,
        }
    })
    .await
}

/// 通知渠道测试（设置面板的「测试发送」）。
pub async fn send_test(channels: &Channels, requested: Option<&str>) -> NotifyOutcome {
    let message = Message::info(
        "CDT-Monitor 测试通知",
        "如果你看到这条消息，说明通知渠道配置正确。",
    )
    .with_detail(format!(
        "时间：{} UTC",
        crate::models::local_datetime(crate::models::now_ms(), "UTC").format("%Y-%m-%d %H:%M:%S")
    ))
    .with_detail("来源：Cloudflare Workers");

    match requested.map(|s| s.to_ascii_lowercase()) {
        Some(name) if name == "telegram" => {
            let mut results = Vec::new();
            match &channels.telegram {
                Some(channel) => results.push(send_telegram(channel, &message).await),
                None => results.push(ChannelResult::fail("telegram", "未启用或未配置")),
            }
            NotifyOutcome { results }
        }
        Some(name) if name == "bark" => {
            let mut results = Vec::new();
            match &channels.bark {
                Some(channel) => results.push(send_bark(channel, &message).await),
                None => results.push(ChannelResult::fail("bark", "未启用或未配置")),
            }
            NotifyOutcome { results }
        }
        _ => dispatch(channels, &message).await,
    }
}

// ===========================================================================
// 工具
// ===========================================================================

/// `application/x-www-form-urlencoded` 编码。
pub fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn truncate(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let head: String = input.chars().take(max_chars).collect();
    format!("{head}…")
}

/// 构造 Bark 载荷的 JSON 字符串（供测试断言使用）。
#[allow(dead_code)]
fn bark_payload_json(channel: &BarkChannel, message: &Message) -> String {
    let level = message
        .level
        .bark_level(channel.normal_level, channel.alert_level);
    json!({
        "device_key": channel.device_key,
        "title": message.title,
        "body": message.bark_body(),
        "level": level.as_str(),
        "group": message.group,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn telegram() -> TelegramChannel {
        TelegramChannel {
            token: "123:ABC".to_string(),
            chat_id: "-1001234567890".to_string(),
        }
    }

    fn bark() -> BarkChannel {
        BarkChannel {
            server_url: "https://api.day.app".to_string(),
            device_key: "devicekey".to_string(),
            normal_level: PushLevel::Active,
            alert_level: PushLevel::Critical,
        }
    }

    #[test]
    fn telegram_url_is_official() {
        assert_eq!(
            telegram().send_message_url(),
            "https://api.telegram.org/bot123:ABC/sendMessage"
        );
    }

    #[test]
    fn bark_url_normalization() {
        assert_eq!(bark().push_url(), "https://api.day.app/push");

        let with_path = BarkChannel {
            server_url: "https://bark.example.com/bark/".to_string(),
            ..bark()
        };
        assert_eq!(with_path.push_url(), "https://bark.example.com/bark/push");

        let already = BarkChannel {
            server_url: "https://bark.example.com/push".to_string(),
            ..bark()
        };
        assert_eq!(already.push_url(), "https://bark.example.com/push");
    }

    #[test]
    fn bark_level_switches_by_message_level() {
        let message_alert = Message::alert("t", "b");
        assert_eq!(
            NotifyLevel::Alert.bark_level(PushLevel::Active, PushLevel::Critical),
            PushLevel::Critical
        );
        assert_eq!(
            NotifyLevel::Normal.bark_level(PushLevel::TimeSensitive, PushLevel::Critical),
            PushLevel::TimeSensitive
        );
        assert!(message_alert.level.is_alert());
    }

    #[test]
    fn bark_payload_contains_level() {
        let payload = bark_payload_json(&bark(), &Message::alert("标题", "正文"));
        let value: serde_json::Value = serde_json::from_str(&payload).expect("合法 JSON");
        assert_eq!(value["level"], "critical");
        assert_eq!(value["device_key"], "devicekey");
        assert_eq!(value["title"], "标题");
    }

    #[test]
    fn html_escaping() {
        assert_eq!(escape_html("<b>a & b</b>"), "&lt;b&gt;a &amp; b&lt;/b&gt;");
        let message = Message::info("a<b>", "c&d").with_detail("e>f");
        let html = message.html_text();
        assert!(html.contains("a&lt;b&gt;"));
        assert!(html.contains("c&amp;d"));
        assert!(html.contains("e&gt;f"));
    }

    #[test]
    fn telegram_ok_detection() {
        assert!(telegram_ok(r#"{"ok":true,"result":{}}"#));
        assert!(!telegram_ok(r#"{"ok":false,"description":"Unauthorized"}"#));
        assert!(!telegram_ok("not json"));
    }

    #[test]
    fn telegram_error_extraction() {
        let msg = telegram_error(
            &401,
            r#"{"ok":false,"error_code":401,"description":"Unauthorized"}"#,
        );
        assert!(msg.contains("401"));
        assert!(msg.contains("Unauthorized"));
    }

    #[test]
    fn bark_ok_detection() {
        assert!(bark_ok(r#"{"code":200,"message":"success"}"#));
        assert!(bark_ok("200"));
        assert!(bark_ok(""));
        assert!(!bark_ok(r#"{"code":400,"message":"bad key"}"#));
    }

    #[test]
    fn form_encoding() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencode("中文"), "%E4%B8%AD%E6%96%87");
        assert_eq!(urlencode("-_.~"), "-_.~");
    }

    #[test]
    fn outcome_summary_and_failures() {
        let outcome = NotifyOutcome {
            results: vec![
                ChannelResult::ok("telegram", "已送达"),
                ChannelResult::fail("bark", "HTTP 400：bad key"),
            ],
        };
        assert!(outcome.any_success());
        assert_eq!(outcome.failures().len(), 1);
        assert!(outcome.summary().contains("telegram"));
        assert!(outcome.summary().contains("bark"));

        let empty = NotifyOutcome {
            results: Vec::new(),
        };
        assert!(empty.any_success());
        assert_eq!(empty.summary(), "未配置任何通知渠道");
    }

    #[test]
    fn plain_text_rendering() {
        let message = Message::alert("超限", "已使用 120%")
            .with_detail("实例 i-1 已停机")
            .with_detail("实例 i-2 停机失败");
        let text = message.plain_text();
        assert!(text.contains("【超限】"));
        assert!(text.contains("• 实例 i-1 已停机"));
        assert!(text.contains("• 实例 i-2 停机失败"));
    }

    #[test]
    fn channels_names() {
        let channels = Channels {
            telegram: Some(telegram()),
            bark: None,
        };
        assert_eq!(channels.names(), vec!["telegram"]);
        assert!(!channels.is_empty());
        assert!(Channels::default().is_empty());
    }
}
