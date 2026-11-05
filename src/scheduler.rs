//! # 调度器：采样、熔断、定时开关机、抢占式保活、日报
//!
//! 每次 Cron（`*/5 * * * *`）走一遍 [`Scheduler::run_account_cron`]：
//!
//! ```text
//! 1. 清理过期锁 / 旧任务 / 旧日志（每天一次）
//! 2. 逐个启用账号：CDT 流量 + 余额 + 该账号的 ECS 实例 → 写快照 → 采样历史
//! 3. 阈值判定：合计流量 ≥ traffic_limit_gb
//!      └─ 首次超限 → 标记账期 + 通知 [+ 停机（stop_and_notify）]
//! 4. 定时关机（含 10 分钟短窗口补偿）
//! 5. 定时开机（同上，**受熔断闸门约束**）
//! 6. 抢占式保活（受熔断闸门与「夜间停机窗口」约束）
//! 7. 每日日报（命中 HH:MM 窗口且当天未推送）
//! ```
//!
//! ## 优先级规则（硬性）
//!
//! ```text
//! 流量熔断停机  >  抢占式保活  >  定时开机
//! ```
//!
//! 当月已被熔断（`account_snapshots.threshold_triggered_month == 当前账期`）
//! 且账号策略为 `stop_and_notify` 时，保活与定时开机**一律不拉起实例**；
//! 手动开机接口也会返回 409。`notify_only` 从不实际停机，因此不加闸门。
//!
//! ## 与「夜间停机窗口」的关系
//!
//! 如果账号同时配置了定时开关机与抢占式保活，保活会在 `[停止时间, 开始时间)`
//! 这段本地时间窗口内让路——否则保活会把刚被计划停机的实例重新拉起，
//! 使定时策略失效。

use std::collections::HashMap;

use crate::aliyun::AliyunClient;
use crate::crypto::{Crypto, random_hex};
mod schedule;
mod threshold;
use crate::db::Db;
use crate::models::{
    AccountOverview, AccountRow, BarkConfig, DailyReportConfig, HistoryBucket, InstanceInfo,
    NotifyChannel, OverLimitAction, QuotaPool, SnapshotRow, SnapshotUpdate, TelegramConfig,
    build_overview, bytes_to_gb, human_amount, local_date, local_day_start_ms,
    local_minutes_of_day, now_ms, parse_hhmm, setting_key, threshold_reached, within_window,
};
use crate::notify::{
    BarkChannel, Channels, Message, NotifyLevel, NotifyOutcome, TelegramChannel, dispatch,
};

/// 定时开关机的补偿窗口（分钟）。与上游一致：10 分钟。
///
/// Cron 每 5 分钟一次，所以每个触发点有 2 次尝试机会（准点与 +5 分钟）。
pub const SCHEDULE_WINDOW_MINUTES: u32 = 10;
/// 日报的补偿窗口（分钟）。与开关机窗口同宽，与上游一致。
pub const REPORT_WINDOW_MINUTES: u32 = 10;
/// 历史数据保留天数。
///
/// 图表日视图最多 31 个点，更早的采样写了也读不到。
/// 留 32 天而非 31 天，是为了让边界那天的采样在被裁掉前完整保留一个整天。
pub const HISTORY_RETENTION_DAYS: i64 = 32;
/// 操作日志保留天数。
///
/// 与流量历史保持一致：一个自然月的图表窗口 + 1 天边界。
/// 真实排障走数据库直查，界面抽屉只作最近状态参考。
pub const LOG_RETENTION_DAYS: i64 = 32;
/// 任务记录保留天数。
pub const JOB_RETENTION_DAYS: i64 = 7;
/// 单实例动作锁 TTL（分钟）。
pub const INSTANCE_LOCK_TTL_MINUTES: i64 = 30;
/// 过渡态按需采集的防抖窗口（毫秒）。
///
/// 前端过渡态每 1 分钟轮询一次（对齐上游），锁留 45 秒让同一次轮询里的
/// 多个请求（多标签页）只触发一次采集，下一分钟又能正常采。
pub const TRANSITION_REFRESH_TTL_MS: i64 = 45_000;
/// 定时关机后保活的避让期（分钟）。
///
/// 只需覆盖「刚关机的那一轮 Cron」：Cron 5 分钟一次，留 10 分钟让快照
/// 追上最新状态即可。不能用「当天已关机」判断——那样当天之后实例若被
/// 抢占回收，保活会一直不再拉起，与「自动开关机 + 保活并存」的预期冲突。
pub const KEEP_ALIVE_STOP_GRACE_MINUTES: i64 = 10;

// ===========================================================================
// 辅助函数
// ===========================================================================

// ===========================================================================
// 结果结构
// ===========================================================================

/// 单账号一次刷新的结果。
#[derive(Debug, Clone)]
pub struct RefreshOutcome {
    pub account_id: i64,
    pub account_name: String,
    /// 流量和实例均查询成功；余额失败作为警告返回。
    pub success: bool,
    /// 本轮成功读取实例状态；失败时旧快照仅供展示，不能确认定时动作完成。
    pub instances_fresh: bool,
    pub total_bytes: i64,
    pub domestic_bytes: i64,
    pub overseas_bytes: i64,
    /// 本次刷新是否**新触发**了熔断。
    pub threshold_fired: bool,
    /// 局部失败 / 提示信息。
    pub warnings: Vec<String>,
}

impl RefreshOutcome {
    fn failed(account: &AccountRow, error: String) -> Self {
        Self {
            account_id: account.id,
            account_name: account.name.clone(),
            success: false,
            instances_fresh: false,
            total_bytes: 0,
            domestic_bytes: 0,
            overseas_bytes: 0,
            threshold_fired: false,
            warnings: vec![error],
        }
    }
}

/// 一次 Cron 的汇总（写进 Worker 日志）。
#[derive(Debug, Clone, Default)]
pub struct CronReport {
    pub accounts_total: usize,
    pub accounts_refreshed: usize,
    pub accounts_failed: usize,
    pub thresholds_fired: usize,
    pub instances_started: usize,
    pub instances_stopped: usize,
    pub keep_alive_started: usize,
    pub report_sent: bool,
    /// 采集、状态过渡或自动化动作尚未完成，允许队列重新核实。
    pub retry_needed: bool,
    /// 逐条明细（日志用）。
    pub notes: Vec<String>,
}

impl CronReport {
    /// 单行摘要。
    pub fn summary(&self) -> String {
        format!(
            "账号 {}/{} 刷新成功，失败 {}，熔断 {}，停机 {}，开机 {}，保活 {}，日报 {}",
            self.accounts_refreshed,
            self.accounts_total,
            self.accounts_failed,
            self.thresholds_fired,
            self.instances_stopped,
            self.instances_started,
            self.keep_alive_started,
            if self.report_sent {
                "已推送"
            } else {
                "未触发"
            }
        )
    }
}

/// 一个实例的动作结果。
#[derive(Debug, Clone)]
pub struct InstanceActionResult {
    pub instance_id: String,
    pub ok: bool,
    pub detail: String,
}

// ===========================================================================
// Scheduler
// ===========================================================================

/// 调度器。持有一次执行期间需要的全部上下文。
pub struct Scheduler {
    env: worker::Env,
    db: Db,
    crypto: Crypto,
    now: i64,
    timezone: String,
}

impl Scheduler {
    /// 从 Worker 环境构造（会读取 `MASTER_KEY` 与时区）。
    pub async fn new(env: &worker::Env) -> worker::Result<Self> {
        let crypto = Crypto::new(
            crate::crypto::MasterKey::from_env(env)
                .map_err(|err| worker::Error::RustError(err.to_string()))?,
        );
        let db = Db::new(env);
        let timezone = db.get_timezone().await?;
        Ok(Self {
            env: env.clone(),
            db,
            crypto,
            now: now_ms(),
            timezone,
        })
    }

    /// 指定「当前时间」构造（测试与补偿逻辑使用）。
    pub async fn with_now(env: &worker::Env, now: i64) -> worker::Result<Self> {
        let mut scheduler = Self::new(env).await?;
        scheduler.now = now;
        Ok(scheduler)
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn crypto(&self) -> &Crypto {
        &self.crypto
    }

    pub fn now(&self) -> i64 {
        self.now
    }

    pub fn timezone(&self) -> &str {
        &self.timezone
    }

    pub fn env(&self) -> &worker::Env {
        &self.env
    }

    // -----------------------------------------------------------------------
    // 通知渠道
    // -----------------------------------------------------------------------

    /// 读取并解密通知渠道配置。任一渠道解密失败只跳过该渠道。
    pub async fn channels(&self) -> Channels {
        let mut channels = Channels::default();

        let telegram: TelegramConfig = self
            .db
            .get_json_setting(setting_key::TELEGRAM)
            .await
            .unwrap_or_default();
        if telegram.enabled {
            let token = telegram
                .token_enc
                .as_deref()
                .and_then(|enc| self.crypto.try_decrypt(enc));
            if let (Some(token), Some(chat_id)) = (
                token,
                telegram
                    .chat_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
            ) {
                channels.telegram = Some(TelegramChannel {
                    token,
                    chat_id: chat_id.to_string(),
                });
            }
        }

        let bark: BarkConfig = self
            .db
            .get_json_setting(setting_key::BARK)
            .await
            .unwrap_or_default();
        if bark.enabled {
            let device_key = bark
                .device_key_enc
                .as_deref()
                .and_then(|enc| self.crypto.try_decrypt(enc));
            if let Some(device_key) = device_key {
                channels.bark = Some(BarkChannel {
                    server_url: bark.server_url.clone(),
                    device_key,
                    normal_level: bark.normal_level,
                    alert_level: bark.alert_level,
                });
            }
        }

        channels
    }

    /// 发送通知并记录失败（尽力而为，永不返回错误）。
    pub async fn notify(&self, message: Message) -> NotifyOutcome {
        let channels = self.channels().await;
        if channels.is_empty() {
            return NotifyOutcome {
                results: Vec::new(),
            };
        }
        let outcome = dispatch(&channels, &message).await;
        for failure in outcome.failures() {
            let _ = self
                .db
                .add_log(None, "notify_failed", None, &failure, now_ms())
                .await;
            log_warn!("通知发送失败：{failure}");
        }
        outcome
    }

    /// 同一「去重键」在窗口内只发送一次的通知。
    ///
    /// 用于周期性巡检产生的告警：Cron 每 5 分钟一轮，若不加抑制，
    /// 一次持续异常会连续轰炸。去重键应包含「异常主体 + 时间片」，
    /// 例如 `threshold:3:2026-10`。
    pub async fn notify_once(
        &self,
        dedup_key: &str,
        window_ms: i64,
        message: Message,
    ) -> Option<NotifyOutcome> {
        let owner = random_hex(8).ok()?;
        let acquired = self
            .db
            .acquire_lock(dedup_key, &owner, now_ms(), window_ms)
            .await
            .ok()?;
        if !acquired {
            return None;
        }
        let outcome = self.notify(message).await;
        if !outcome.any_success() {
            let _ = self.db.release_lock(dedup_key, &owner).await;
        }
        Some(outcome)
    }

    /// 通知渠道测试。
    pub async fn test_notification(&self, channel: Option<NotifyChannel>) -> NotifyOutcome {
        let channels = self.channels().await;
        if channels.is_empty() {
            return NotifyOutcome {
                results: Vec::new(),
            };
        }
        let requested = channel.map(|c| match c {
            NotifyChannel::Telegram => "telegram",
            NotifyChannel::Bark => "bark",
        });
        let outcome = crate::notify::send_test(&channels, requested).await;
        let detail = outcome.summary();
        let action = match channel {
            Some(NotifyChannel::Telegram) => "notify_test_telegram",
            Some(NotifyChannel::Bark) => "notify_test_bark",
            None => "notify_test_all",
        };
        let _ = self.db.add_log(None, action, None, &detail, now_ms()).await;
        outcome
    }

    // -----------------------------------------------------------------------
    // 账号刷新
    // -----------------------------------------------------------------------

    /// 解密账号 AccessKey Secret。
    fn account_secret(&self, account: &AccountRow) -> worker::Result<String> {
        self.crypto
            .decrypt(&account.encrypted_access_key_secret)
            .map_err(|_| {
                worker::Error::RustError(
                    "AccessKey Secret 解密失败（MASTER_KEY 可能已更换），请在设置里重新保存该账号密钥"
                        .to_string(),
                )
            })
    }

    /// 刷新单个账号：采集 → 合并保活标记 → 写快照 → 采样 → 阈值判定。
    pub async fn refresh_account(&self, account: &AccountRow) -> RefreshOutcome {
        let result = self
            .db
            .with_account_lock(account.id, 20_000, async {
                self.db
                    .account_at_version(account.id, account.config_version)
                    .await?;
                self.refresh_account_inner(account).await
            })
            .await;
        self.refresh_outcome(account, result).await
    }

    async fn refresh_locked(&self, account: &AccountRow) -> RefreshOutcome {
        let result = crate::runtime::timeout(20_000, Box::pin(self.refresh_account_inner(account)))
            .await
            .unwrap_or_else(|e| Err(worker::Error::RustError(e.into())));
        self.refresh_outcome(account, result).await
    }

    async fn refresh_outcome(
        &self,
        account: &AccountRow,
        result: worker::Result<RefreshOutcome>,
    ) -> RefreshOutcome {
        match result {
            Ok(outcome) => outcome,
            Err(err) => {
                let text = err.to_string();
                let _ = self
                    .db
                    .add_log(Some(account.id), "refresh_failed", None, &text, now_ms())
                    .await;
                RefreshOutcome::failed(account, text)
            }
        }
    }

    async fn refresh_account_inner(&self, account: &AccountRow) -> worker::Result<RefreshOutcome> {
        let secret = self.account_secret(account)?;
        let client = AliyunClient::from_account(account, secret);
        if account.cloud_account_id.is_none() {
            match client.caller_account_id().await {
                Ok(id) => self.db.set_cloud_account_id(account.id, &id).await?,
                Err(err) => log_error!("账号 {} 身份核实失败：{}", account.id, err.short()),
            }
        }
        let sync =
            crate::aliyun::sync_account(&client, &account.region_id, account.instance_id_opt())
                .await;

        let previous = self.db.get_snapshot(account.id).await?;
        let billing_month = crate::models::billing_month(self.now, &self.timezone);

        // 逐实例保活开关由用户在界面设置，采集结果里没有这项信息，
        // 因此按 instance_id 从旧快照继承。
        let previous_keep_alive: HashMap<String, bool> = previous
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .instances()
                    .into_iter()
                    .map(|instance| (instance.instance_id, instance.keep_alive))
                    .collect()
            })
            .unwrap_or_default();

        let traffic_fresh = sync.traffic.is_some();
        let balance_fresh = sync.balance.is_some();
        let instances_fresh = !sync.instances_failed;
        let sampled_at = now_ms();
        let traffic_month = if traffic_fresh {
            billing_month.clone()
        } else {
            previous
                .as_ref()
                .map(|s| s.billing_month.clone())
                .unwrap_or_default()
        };
        let mut instances = sync.instances;
        for instance in &mut instances {
            instance.keep_alive = previous_keep_alive
                .get(&instance.instance_id)
                .copied()
                .unwrap_or(false);
        }

        // 实例查询失败（而不是「这个地域没有实例」）时沿用旧快照，
        // 避免一次网络抖动就让卡片上的实例信息消失。
        if sync.instances_failed {
            instances = previous
                .as_ref()
                .map(|snapshot| snapshot.instances())
                .unwrap_or_default();
        }

        // CDT 查询失败时沿用上次快照的流量值，绝不写成 0（否则阈值会误判为安全）。
        let (domestic_bytes, overseas_bytes) = match sync.traffic {
            Some(traffic) => (traffic.domestic_bytes.max(0), traffic.overseas_bytes.max(0)),
            None => match previous.as_ref() {
                Some(snapshot) => (
                    snapshot.cdt_domestic_bytes.max(0),
                    snapshot.cdt_overseas_bytes.max(0),
                ),
                None => (0, 0),
            },
        };

        // 余额同理：沿用旧值，避免余额接口抖动导致界面金额闪成 "-"。
        let (balance_amount, balance_currency, balance_cash, balance_credit) =
            match sync.balance.as_ref() {
                Some(balance) => (
                    Some(balance.amount),
                    balance.currency.clone(),
                    balance.cash,
                    balance.credit,
                ),
                None => match previous.as_ref() {
                    Some(snapshot) => (
                        snapshot.balance_amount,
                        snapshot.balance_currency.clone(),
                        snapshot.balance_cash,
                        snapshot.balance_credit,
                    ),
                    None => (None, None, None, None),
                },
            };

        // 账号落在哪个额度池由地域决定：中国内地 20 GB、其余（含香港）200 GB。
        // CDT 接口按地域分类汇总，这里取账号所属那一类的累计值。
        let total_bytes = domestic_bytes + overseas_bytes;
        let pool = account.quota_pool();
        let used_gb = bytes_to_gb(match pool {
            QuotaPool::Domestic => domestic_bytes,
            QuotaPool::Overseas => overseas_bytes,
        });

        self.db
            .upsert_snapshot(
                &SnapshotUpdate {
                    account_id: account.id,
                    balance_amount,
                    balance_currency,
                    balance_cash,
                    balance_credit,
                    cdt_domestic_bytes: domestic_bytes,
                    cdt_overseas_bytes: overseas_bytes,
                    billing_month: traffic_month,
                    instances: instances.clone(),
                    updated_at: if traffic_fresh || balance_fresh || instances_fresh {
                        sampled_at
                    } else {
                        previous.as_ref().map(|s| s.updated_at).unwrap_or(0)
                    },
                    traffic_updated_at: if traffic_fresh {
                        Some(sampled_at)
                    } else {
                        previous.as_ref().and_then(|s| s.traffic_updated_at)
                    },
                    balance_updated_at: if balance_fresh {
                        Some(sampled_at)
                    } else {
                        previous.as_ref().and_then(|s| s.balance_updated_at)
                    },
                    instances_updated_at: if instances_fresh {
                        Some(sampled_at)
                    } else {
                        previous.as_ref().and_then(|s| s.instances_updated_at)
                    },
                    sync_errors: sync.warnings.clone(),
                },
                traffic_fresh.then(|| {
                    (
                        used_gb,
                        self.now,
                        local_day_start_ms(self.now, &self.timezone),
                    )
                }),
            )
            .await?;

        let already_triggered = previous
            .as_ref()
            .is_some_and(|s| s.threshold_triggered(&billing_month));
        let can_release = previous.as_ref().is_some_and(|snapshot| {
            should_release_threshold(account, snapshot, &billing_month, traffic_fresh, used_gb)
        });
        if can_release {
            self.db.clear_threshold(account.id).await?;
            self.db
                .add_log(
                    Some(account.id),
                    "threshold_cleared",
                    None,
                    "阈值已调整，最新用量低于新阈值，解除熔断",
                    now_ms(),
                )
                .await?;
        }
        let mut threshold_fired = false;
        if !can_release
            && ((traffic_fresh && threshold_reached(used_gb, account.traffic_threshold_gb))
                || already_triggered)
        {
            threshold_fired = self.handle_threshold(account, used_gb, pool).await?;
        }

        for warning in &sync.warnings {
            let _ = self
                .db
                .add_log(Some(account.id), "refresh_warning", None, warning, now_ms())
                .await;
        }

        Ok(RefreshOutcome {
            account_id: account.id,
            account_name: account.name.clone(),
            // 流量与实例是自动化决策所需数据，失败时不能用旧快照冒充刷新成功。
            success: traffic_fresh && instances_fresh,
            instances_fresh,
            total_bytes,
            domestic_bytes,
            overseas_bytes,
            threshold_fired,
            warnings: sync.warnings,
        })
    }

    /// 刷新全部启用账号。
    pub async fn refresh_all(&self) -> Vec<RefreshOutcome> {
        let accounts = match self.db.list_accounts(true).await {
            Ok(accounts) => accounts,
            Err(err) => {
                log_error!("读取账号失败：{err}");
                return Vec::new();
            }
        };

        let mut outcomes = Vec::with_capacity(accounts.len());
        for account in &accounts {
            outcomes.push(self.refresh_account(account).await);
        }
        outcomes
    }

    // -----------------------------------------------------------------------
    // 日报
    // -----------------------------------------------------------------------

    /// 命中时间窗口就推送日报；返回是否推送。
    pub async fn maybe_daily_report(&self, report: &mut CronReport) -> worker::Result<bool> {
        let mut config: DailyReportConfig =
            self.db.get_json_setting(setting_key::DAILY_REPORT).await?;
        if !config.enabled {
            return Ok(false);
        }
        let Some(target) = parse_hhmm(&config.time) else {
            return Ok(false);
        };
        let tz = if config.timezone.trim().is_empty() {
            self.timezone.clone()
        } else {
            config.timezone.clone()
        };
        let today = local_date(self.now, &tz);
        if config.last_sent_date.as_deref() == Some(today.as_str()) {
            return Ok(false);
        }
        if !within_window(
            local_minutes_of_day(self.now, &tz),
            target,
            REPORT_WINDOW_MINUTES,
        ) {
            return Ok(false);
        }

        let lock_name = format!("daily-report:{today}");
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        if !self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 30 * 60 * 1000)
            .await?
        {
            return Ok(false);
        }

        let message = self.build_daily_report(&tz).await?;
        let outcome = self.notify(message).await;

        // 只在真的送达后才标记「今天已推送」，否则下次 Cron 会重试。
        // 之前无条件标记，一次通知失败就会让当天的日报永久丢失。
        if !outcome.any_success() {
            let reason = outcome.failures().join("；");
            let _ = self.db.release_lock(&lock_name, &owner).await;
            report
                .notes
                .push(format!("日报推送失败，稍后重试：{reason}"));
            return Ok(false);
        }

        config.last_sent_date = Some(today.clone());
        self.db
            .set_json_setting(setting_key::DAILY_REPORT, &config, now_ms())
            .await?;
        self.db
            .add_log(
                None,
                "daily_report",
                None,
                &format!("日报已推送（{today}）"),
                now_ms(),
            )
            .await?;
        let _ = self.db.release_lock(&lock_name, &owner).await;

        report.report_sent = true;
        report.notes.push(format!("日报已推送（{today}）"));
        Ok(true)
    }

    /// 手工触发一次日报（`POST /api/v1/reports/daily`）。
    pub async fn push_daily_report(&self) -> worker::Result<String> {
        let message = self.build_daily_report(&self.timezone).await?;
        let preview = message.plain_text();
        let outcome = self.notify(message).await;
        let detail = if outcome.results.is_empty() {
            "未配置任何通知渠道，日报未发送".to_string()
        } else {
            outcome.summary()
        };
        self.db
            .add_log(None, "daily_report_manual", None, &detail, now_ms())
            .await?;
        Ok(format!("{detail}\n{preview}"))
    }

    /// 组装日报消息。
    async fn build_daily_report(&self, tz: &str) -> worker::Result<Message> {
        let accounts = self.db.list_accounts(true).await?;
        let snapshots: HashMap<i64, SnapshotRow> = self
            .db
            .list_snapshots()
            .await?
            .into_iter()
            .map(|snapshot| (snapshot.account_id, snapshot))
            .collect();

        let mut details = Vec::new();
        let mut used_total_gb = 0.0f64;
        let mut missing_traffic = 0usize;
        let mut collection_warnings = 0usize;
        let mut triggered = 0usize;
        let mut running = 0usize;
        let mut stopped = 0usize;

        for account in &accounts {
            let snapshot = snapshots.get(&account.id);
            let overview: AccountOverview = build_overview(account, snapshot, tz, self.now);
            if overview.traffic_current {
                used_total_gb += overview.traffic_used_gb;
            } else {
                missing_traffic += 1;
            }
            if !overview.sync_errors.is_empty() {
                collection_warnings += 1;
            }
            if overview.threshold_triggered {
                triggered += 1;
            }
            for instance in &overview.instances {
                if instance.is_running() {
                    running += 1;
                } else if instance.is_stopped() {
                    stopped += 1;
                }
            }

            let balance = match (
                overview.balance_amount,
                overview.balance_currency.as_deref(),
            ) {
                (Some(amount), currency) => human_amount(amount, currency),
                (None, _) => "未知".to_string(),
            };
            let traffic = if overview.traffic_current {
                format!(
                    "{:.2} / {} GB（{:.2}%）",
                    overview.traffic_used_gb,
                    trim_float(overview.quota_gb),
                    overview.percentage
                )
            } else {
                "本月流量待采集（未计入合计）".to_string()
            };
            details.push(format!(
                "{}（{} · {}）：{}｜余额 {}｜实例 {} 台{}{}",
                overview.name,
                overview.region_name,
                overview.quota_label,
                traffic,
                balance,
                overview.instances.len(),
                if overview.threshold_triggered {
                    "｜⚠️ 已熔断"
                } else {
                    ""
                },
                if overview.sync_errors.is_empty() {
                    String::new()
                } else {
                    format!(
                        "｜采集异常，展示最近成功数据：{}",
                        overview.sync_errors.join("；")
                    )
                }
            ));
        }

        if details.is_empty() {
            details.push("尚未添加任何阿里云账号".to_string());
        }

        let body = format!(
            "{} 概览：{} 个账号，已采集的本月合计流量 {:.2} GB，{} 个账号本月流量待采集，{} 个账号最近采集异常，实例运行 {} / 停止 {}，已熔断 {} 个。",
            local_date(self.now, tz),
            accounts.len(),
            used_total_gb,
            missing_traffic,
            collection_warnings,
            running,
            stopped,
            triggered
        );

        Ok(Message::new(
            "CDT-Monitor 每日日报",
            body,
            if triggered > 0 {
                NotifyLevel::Alert
            } else {
                NotifyLevel::Normal
            },
        )
        .with_details(details)
        .with_group("CDT-DailyReport"))
    }

    // -----------------------------------------------------------------------
    // 手动动作
    // -----------------------------------------------------------------------

    /// 手动开机 / 关机。返回可读的结果描述。
    ///
    /// 开机受熔断闸门约束；成功后立即刷新账号快照，让界面状态同步。
    pub async fn instance_action(
        &self,
        account_id: i64,
        instance_id: &str,
        start: bool,
        config_version: i64,
    ) -> worker::Result<InstanceActionResult> {
        self.db
            .with_account_lock(account_id, 20_000, async {
                let account = self
                    .db
                    .account_at_version(account_id, config_version)
                    .await?;
                self.instance_action_locked(&account, instance_id, start)
                    .await
            })
            .await
    }

    async fn instance_action_locked(
        &self,
        account: &AccountRow,
        instance_id: &str,
        start: bool,
    ) -> worker::Result<InstanceActionResult> {
        let account_id = account.id;

        if account.instance_id_opt() != Some(instance_id) {
            return Err(worker::Error::RustError("实例 ID 与账号配置不一致".into()));
        }
        if start && self.threshold_blocked(account).await? {
            return Err(worker::Error::RustError(
                "本月已触发流量熔断停机，禁止开机；请提升阈值并成功刷新，或等待下个账期".into(),
            ));
        }
        let client = AliyunClient::from_account(account, self.account_secret(account)?);
        let region_id = &account.region_id;
        let mut instance = client
            .describe_instance(region_id, instance_id)
            .await?
            .filter(|i| i.instance_id == instance_id)
            .ok_or_else(|| {
                worker::Error::RustError("云端找不到配置的实例，请核实地域和实例 ID".into())
            })?;
        instance.keep_alive = self
            .db
            .snapshot_instances(account_id)
            .await?
            .iter()
            .find(|i| i.instance_id == instance_id)
            .is_some_and(|i| i.keep_alive);
        self.db
            .save_live_instance(account_id, &instance, now_ms())
            .await?;
        if (start && instance.is_running()) || (!start && instance.is_stopped()) {
            return Ok(InstanceActionResult {
                instance_id: instance_id.into(),
                ok: true,
                detail: if start {
                    "已核实实例正在运行，无需开机"
                } else {
                    "已核实实例已停止，无需关机"
                }
                .into(),
            });
        }
        if !(instance.is_running() || instance.is_stopped()) {
            return Err(worker::Error::RustError(
                "实例正在过渡或状态未知，请稍后刷新重试".into(),
            ));
        }

        let result = if start {
            client.start_instance(instance_id, region_id).await
        } else {
            client
                .stop_instance(instance_id, region_id, account.stop_mode())
                .await
        };

        let detail = match result {
            Ok(()) => {
                let action = if start { "manual_start" } else { "manual_stop" };
                let text = if start {
                    format!("手动开机成功（{region_id}）")
                } else {
                    format!(
                        "手动关机成功（{}，{region_id}）",
                        account.stop_mode().label()
                    )
                };
                self.db
                    .add_log(Some(account_id), action, Some(instance_id), &text, now_ms())
                    .await?;
                InstanceActionResult {
                    instance_id: instance_id.to_string(),
                    ok: true,
                    detail: text,
                }
            }
            Err(err) => {
                let text = err.short();
                self.db
                    .add_log(
                        Some(account_id),
                        if start {
                            "manual_start_failed"
                        } else {
                            "manual_stop_failed"
                        },
                        Some(instance_id),
                        &text,
                        now_ms(),
                    )
                    .await?;
                return Err(worker::Error::RustError(format!(
                    "{} 失败：{text}",
                    if start { "开机" } else { "关机" }
                )));
            }
        };

        // 动作后立即刷新，保证前端轮询结束时看到的是真实状态；
        // 若阿里云尚未落到终态（刚发出指令常如此），把快照置为过渡态，
        // 让前端显示「正在启动…」并切到 1 分钟轮询。
        let refresh = self.refresh_locked(account).await;
        if !refresh.success {
            log_warn!("动作后刷新失败：{}", refresh.warnings.join("；"));
        }
        self.set_transitional_status(account_id, instance_id, start)
            .await?;

        Ok(detail)
    }

    /// 把快照里某个实例的状态置为 `Starting` / `Stopping`。
    ///
    /// 只在刷新后仍停留在「与意图相反」的旧状态时才写：若阿里云已经
    /// 报回 `Starting` / `Stopping` / 终态，就以采集结果为准，不要回退。
    async fn set_transitional_status(
        &self,
        account_id: i64,
        instance_id: &str,
        start: bool,
    ) -> worker::Result<()> {
        let mut instances = self.db.snapshot_instances(account_id).await?;
        let mut changed = false;
        for instance in instances.iter_mut() {
            if instance.instance_id != instance_id {
                continue;
            }
            let current = instance.status.to_ascii_lowercase();
            // 已经开始动了（或已是目标终态）就别再改成过渡态
            let already_moving = current == "starting"
                || current == "stopping"
                || current == "pending"
                || (start && current == "running")
                || (!start && current == "stopped");
            if already_moving {
                continue;
            }
            instance.status = if start {
                "Starting".to_string()
            } else {
                "Stopping".to_string()
            };
            changed = true;
        }
        if changed {
            self.db
                .update_snapshot_instances(account_id, &instances, now_ms())
                .await?;
        }
        Ok(())
    }

    /// 切换逐实例抢占式保活开关。
    pub async fn set_instance_keep_alive(
        &self,
        account_id: i64,
        instance_id: &str,
        enabled: bool,
    ) -> worker::Result<()> {
        self.db
            .with_account_lock(
                account_id,
                10_000,
                self.set_instance_keep_alive_locked(account_id, instance_id, enabled),
            )
            .await
    }

    async fn set_instance_keep_alive_locked(
        &self,
        account_id: i64,
        instance_id: &str,
        enabled: bool,
    ) -> worker::Result<()> {
        // 先确认账号存在，避免对已删除账号的残留快照写入配置
        if self.db.get_account(account_id).await?.is_none() {
            return Err(worker::Error::RustError(format!(
                "账号 {account_id} 不存在"
            )));
        }

        let mut instances = self.db.snapshot_instances(account_id).await?;
        let Some(target) = instances
            .iter_mut()
            .find(|instance| instance.instance_id == instance_id)
        else {
            return Err(worker::Error::RustError(
                "快照中找不到该实例，请先刷新".to_string(),
            ));
        };

        if enabled && !target.spot {
            return Err(worker::Error::RustError(
                "只有抢占式实例可以开启保活".to_string(),
            ));
        }
        target.keep_alive = enabled;

        self.db
            .update_snapshot_instances(account_id, &instances, now_ms())
            .await?;
        self.db
            .add_log(
                Some(account_id),
                if enabled {
                    "keep_alive_enabled"
                } else {
                    "keep_alive_disabled"
                },
                Some(instance_id),
                if enabled {
                    "开启抢占式保活"
                } else {
                    "关闭抢占式保活"
                },
                now_ms(),
            )
            .await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Cron 主流程
    // -----------------------------------------------------------------------

    /// 一个队列消息只巡检一个账号，独享该次 Worker 的 D1 调用额度。
    pub async fn run_account_cron(&self, account: &AccountRow) -> CronReport {
        match self
            .db
            .with_account_lock(account.id, 85_000, async {
                self.db
                    .account_at_version(account.id, account.config_version)
                    .await?;
                Ok(self.run_account_cron_locked(account).await)
            })
            .await
        {
            Ok(report) => report,
            Err(err) => CronReport {
                accounts_total: 1,
                accounts_failed: usize::from(
                    !matches!(&err, worker::Error::RustError(message) if message == crate::db::ACCOUNT_BUSY),
                ),
                retry_needed: true,
                notes: vec![err.to_string()],
                ..CronReport::default()
            },
        }
    }

    async fn run_account_cron_locked(&self, account: &AccountRow) -> CronReport {
        let mut report = CronReport {
            accounts_total: 1,
            ..CronReport::default()
        };
        let outcome = self.refresh_locked(account).await;
        if outcome.success {
            report.accounts_refreshed += 1;
        } else {
            report.accounts_failed += 1;
            report.retry_needed = true;
            report.notes.push(format!(
                "{} 刷新失败：{}",
                account.name,
                outcome.warnings.join("；")
            ));
        }
        if outcome.threshold_fired {
            report.thresholds_fired += 1;
            report.notes.push(format!("{} 触发流量熔断", account.name));
        }

        if !outcome.instances_fresh {
            report.notes.push(format!(
                "{} 实例状态未更新，保留定时任务重试机会",
                account.name
            ));
            return report;
        }

        // 快照可能已被本次刷新更新，重新读取用于后续判断
        let snapshot = match self.db.get_snapshot(account.id).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                report.retry_needed = true;
                report
                    .notes
                    .push(format!("{} 读取快照失败：{err}", account.name));
                return report;
            }
        };

        if let Err(err) = self.maybe_scheduled_stop(account, &mut report).await {
            report.retry_needed = true;
            report
                .notes
                .push(format!("{} 定时关机异常：{err}", account.name));
        }
        if let Err(err) = self.maybe_scheduled_start(account, &mut report).await {
            report.retry_needed = true;
            report
                .notes
                .push(format!("{} 定时开机异常：{err}", account.name));
        }
        if let Err(err) = self
            .maybe_keep_alive(account, snapshot.as_ref(), &mut report)
            .await
        {
            report.retry_needed = true;
            report
                .notes
                .push(format!("{} 保活异常：{err}", account.name));
        }
        report
    }

    pub async fn maintenance(&self) -> worker::Result<()> {
        let mut report = CronReport::default();
        self.housekeeping(&mut report).await;
        self.maybe_daily_report(&mut report).await?;
        Ok(())
    }

    /// 在 Cron 派发端运行，队列积压时仍可发现采集停滞。
    pub async fn check_collection_health(&self) -> worker::Result<()> {
        let accounts = self.db.list_accounts(true).await?;
        let snapshots: HashMap<_, _> = self
            .db
            .list_snapshots()
            .await?
            .into_iter()
            .map(|s| (s.account_id, s))
            .collect();
        let mut details = Vec::new();
        for account in accounts {
            let snapshot = snapshots.get(&account.id);
            // 刚更换身份导致快照清空时，从配置更新时间开始给采集留出窗口。
            let baseline = if snapshot.is_none() {
                account.updated_at
            } else {
                account.created_at
            };
            let traffic_at = snapshot
                .and_then(|s| s.traffic_updated_at)
                .unwrap_or(baseline);
            let instances_at = snapshot
                .and_then(|s| s.instances_updated_at)
                .unwrap_or(baseline);
            let age = self.now.saturating_sub(traffic_at.min(instances_at));
            if age >= 15 * 60_000 {
                details.push(format!(
                    "{}：流量或实例状态已 {} 分钟未成功采集",
                    account.name,
                    age / 60_000
                ));
            }
        }
        if details.is_empty() {
            return Ok(());
        }
        let message = Message::alert("采集停滞", "请检查云接口、队列积压及 Worker 错误日志")
            .with_details(details.clone())
            .with_group("CDT-Health");
        if self
            .notify_once("collection-health", 60 * 60_000, message)
            .await
            .is_some()
        {
            let detail = details.join("；");
            log_error!(
                "{}",
                serde_json::json!({"event": "collection_stalled", "at": self.now, "detail": detail})
            );
            self.db
                .add_log(None, "collection_stalled", None, &detail, self.now)
                .await?;
        }
        Ok(())
    }

    /// 清理过期数据：每天只跑一次（锁保证）。
    async fn housekeeping(&self, report: &mut CronReport) {
        let now = now_ms();
        let owner = match random_hex(8) {
            Ok(owner) => owner,
            Err(_) => return,
        };
        match self
            .db
            .acquire_lock("housekeeping", &owner, now, 20 * 60 * 60 * 1000)
            .await
        {
            Ok(true) => {}
            _ => return,
        }

        let _ = self.db.purge_login_attempts(now).await;
        if let Err(err) = self.db.purge_locks(now).await {
            report.notes.push(format!("清理过期锁失败：{err}"));
        }
        if let Err(err) = self.db.purge_sessions(now).await {
            report.notes.push(format!("清理过期会话失败：{err}"));
        }
        let day = 24 * 60 * 60 * 1000i64;
        if let Err(err) = self
            .db
            .purge_history(now - HISTORY_RETENTION_DAYS * day)
            .await
        {
            report.notes.push(format!("清理历史失败：{err}"));
        }
        if let Err(err) = self.db.purge_logs(now - LOG_RETENTION_DAYS * day).await {
            report.notes.push(format!("清理日志失败：{err}"));
        }
        if let Err(err) = self.db.purge_jobs(now - JOB_RETENTION_DAYS * day).await {
            report.notes.push(format!("清理任务失败：{err}"));
        }
    }

    // -----------------------------------------------------------------------
    // 供路由层复用的查询
    // -----------------------------------------------------------------------

    /// 首页数据：账号 + 快照 → 概览。
    pub async fn overview(&self) -> worker::Result<Vec<AccountOverview>> {
        let accounts = self.db.list_accounts(false).await?;
        let snapshots: HashMap<i64, SnapshotRow> = self
            .db
            .list_snapshots()
            .await?
            .into_iter()
            .map(|snapshot| (snapshot.account_id, snapshot))
            .collect();

        Ok(accounts
            .iter()
            .map(|account| {
                build_overview(
                    account,
                    snapshots.get(&account.id),
                    &self.timezone,
                    self.now,
                )
            })
            .collect())
    }

    /// 流量历史：小时点与天点各取最近一批。
    pub async fn traffic_history(
        &self,
        account_id: i64,
    ) -> worker::Result<crate::models::TrafficHistory> {
        Ok(crate::models::TrafficHistory {
            hourly: self
                .db
                .traffic_history(account_id, HistoryBucket::Hour)
                .await?,
            daily: self
                .db
                .traffic_history(account_id, HistoryBucket::Day)
                .await?,
        })
    }
}

// ===========================================================================
// 纯函数工具
// ===========================================================================

/// 当前是否处于「允许运行时段」，用于保活前的闸门。
///
/// 覆盖「只配了一个时刻」的情形：
///
/// * 未配置定时 → 全天允许（`true`）；
/// * 只配了开机时刻 → 当前是否已过开机点；
/// * 只配了关机时刻 → 当前是否还没到关机点；
/// * 两个都配 → `[start, stop)`，跨午夜时取并集。
///
/// 上游用的是同一套判断（`!ScheduleEnabled || inTimeRange(...)`）。
pub fn in_allowed_window(account: &AccountRow, now_minutes: u32) -> bool {
    let start = account.schedule_start_minutes();
    let stop = account.schedule_stop_minutes();

    match (start, stop) {
        (None, None) => true,
        (Some(start), None) => now_minutes >= start,
        (None, Some(stop)) => now_minutes < stop,
        (Some(start), Some(stop)) => {
            if start == stop {
                // 区间退化，无法推断，按全天允许处理
                return true;
            }
            if start < stop {
                now_minutes >= start && now_minutes < stop
            } else {
                now_minutes >= start || now_minutes < stop
            }
        }
    }
}

/// Cron 以最近的开/关触发决定期望状态；关机同刻优先。
pub fn automation_allowed(account: &AccountRow, now: i64, tz: &str) -> bool {
    if !account.schedule_is_advanced() {
        return in_allowed_window(account, local_minutes_of_day(now, tz));
    }
    let previous = |expr: Option<&str>| {
        expr.and_then(|e| crate::cron::last_occurrence_within(e, tz, now, i64::MAX))
    };
    match (
        previous(account.start_cron()),
        previous(account.stop_cron()),
    ) {
        (Some(start), Some(stop)) => start > stop,
        (_, Some(_)) => false,
        (Some(_), None) => true,
        (None, None) => account.start_cron().is_none() && account.stop_cron().is_none(),
    }
}

fn should_release_threshold(
    account: &AccountRow,
    snapshot: &SnapshotRow,
    month: &str,
    fresh: bool,
    used_gb: f64,
) -> bool {
    fresh
        && snapshot.threshold_triggered(month)
        && (account.traffic_threshold_gb == 0.0
            || snapshot
                .threshold_limit_gb
                .is_some_and(|old| account.traffic_threshold_gb > old))
        && !threshold_reached(used_gb, account.traffic_threshold_gb)
}

/// 去掉浮点尾巴：`20.0 -> "20"`，`20.50 -> "20.5"`。
pub fn trim_float(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let rounded = (value * 100.0).round() / 100.0;
    if (rounded - rounded.trunc()).abs() < f64::EPSILON {
        format!("{}", rounded as i64)
    } else {
        let text = format!("{rounded:.2}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{OverLimitAction, SiteType, StopMode};

    fn account_with_schedule(start: Option<&str>, stop: Option<&str>) -> AccountRow {
        AccountRow {
            cloud_account_id: None,
            config_version: 1,
            id: 1,
            name: "测试账号".to_string(),
            site_type: "china".to_string(),
            access_key_id: "LTAI5tTestKey".to_string(),
            encrypted_access_key_secret: "cipher".to_string(),
            region_id: "cn-hongkong".to_string(),
            instance_id: None,
            traffic_threshold_gb: 0.0,
            over_limit_action: "stop_and_notify".to_string(),
            stop_mode: "StopCharging".to_string(),
            schedule_start_time: start.map(|s| s.to_string()),
            schedule_stop_time: stop.map(|s| s.to_string()),
            schedule_mode: None,
            schedule_start_cron: None,
            schedule_stop_cron: None,
            spot_keep_alive: 1,
            enabled: 1,
            last_schedule_start_date: None,
            last_schedule_stop_date: None,
            last_schedule_start_at: None,
            last_schedule_stop_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    // -----------------------------------------------------------------------
    // 允许运行时段（保活闸门）
    // -----------------------------------------------------------------------

    #[test]
    fn allowed_window_without_schedule_is_always_open() {
        let account = account_with_schedule(None, None);
        for minutes in [0, 6 * 60, 12 * 60, 23 * 60 + 59] {
            assert!(in_allowed_window(&account, minutes), "{minutes} 应允许运行");
        }
    }

    #[test]
    fn allowed_window_with_stop_only() {
        // 只配了关机时间：关机点之前允许，之后不允许。
        // 只判断「是否处于停机窗口」会漏掉这种情形：缺开机时间时
        // 那种判断返回 false，保活会在停机后立刻拉起实例。
        let account = account_with_schedule(None, Some("22:00"));
        assert!(in_allowed_window(&account, 0));
        assert!(in_allowed_window(&account, 21 * 60 + 59));
        assert!(
            !in_allowed_window(&account, 22 * 60),
            "已到关机点，不应保活"
        );
        assert!(!in_allowed_window(&account, 23 * 60 + 59));
    }

    #[test]
    fn allowed_window_with_start_only() {
        // 只配了开机时间：开机点之后允许。
        let account = account_with_schedule(Some("08:00"), None);
        assert!(!in_allowed_window(&account, 7 * 60 + 59));
        assert!(in_allowed_window(&account, 8 * 60));
        assert!(in_allowed_window(&account, 23 * 60));
    }

    #[test]
    fn allowed_window_with_both_same_day() {
        let account = account_with_schedule(Some("08:00"), Some("22:00"));
        assert!(!in_allowed_window(&account, 7 * 60));
        assert!(in_allowed_window(&account, 8 * 60));
        assert!(in_allowed_window(&account, 21 * 60 + 59));
        assert!(!in_allowed_window(&account, 22 * 60));
    }

    #[test]
    fn allowed_window_across_midnight() {
        // 22:00 关 → 次日 08:00 开：允许时段为 [08:00, 22:00)
        let account = account_with_schedule(Some("08:00"), Some("22:00"));
        assert!(!in_allowed_window(&account, 23 * 60));
        assert!(!in_allowed_window(&account, 3 * 60));

        let overnight = account_with_schedule(Some("22:00"), Some("06:00"));
        assert!(in_allowed_window(&overnight, 23 * 60));
        assert!(in_allowed_window(&overnight, 3 * 60));
        assert!(!in_allowed_window(&overnight, 12 * 60));
    }

    #[test]
    fn allowed_window_start_equals_stop_is_open() {
        // 区间退化，无法推断，按全天允许
        let account = account_with_schedule(Some("08:00"), Some("08:00"));
        assert!(in_allowed_window(&account, 3 * 60));
        assert!(in_allowed_window(&account, 8 * 60));
    }

    /// 保活避让只看「刚刚关过机」：关机后在避让期内让路，
    /// 之后必须恢复保活，否则当天被抢占回收就再也不会拉起。
    #[test]
    fn keep_alive_stop_grace_window() {
        let grace_ms = KEEP_ALIVE_STOP_GRACE_MINUTES * 60 * 1000;
        let now = 1_000_000_000_000i64;

        let elapsed = |stop_at: i64| {
            if stop_at > now {
                None
            } else {
                Some(now - stop_at)
            }
        };
        let in_grace = |stop_at: i64| matches!(elapsed(stop_at), Some(gap) if gap < grace_ms);

        // 同一轮：刚关机，必须让路
        assert!(in_grace(now));
        assert!(in_grace(now - 5 * 60 * 1000));
        assert!(in_grace(
            now - (KEEP_ALIVE_STOP_GRACE_MINUTES - 1) * 60 * 1000
        ));

        // 避让期结束后：恢复正常保活（这正是旧实现的缺陷所在）
        assert!(!in_grace(now - grace_ms));
        assert!(!in_grace(now - 6 * 60 * 60 * 1000));

        // 时钟回拨：未来时间戳不得被误判为「刚关机」
        assert!(!in_grace(now + 60 * 60 * 1000));
    }

    #[test]
    fn trim_float_formats() {
        assert_eq!(trim_float(20.0), "20");
        assert_eq!(trim_float(20.5), "20.5");
        assert_eq!(trim_float(20.55), "20.55");
        assert_eq!(trim_float(0.0), "0");
        assert_eq!(trim_float(f64::NAN), "0");
    }

    #[test]
    fn action_priority_matrix() {
        // 熔断闸门只对 stop_and_notify 生效
        let stop_and_notify = account_with_schedule(None, None);
        assert_eq!(
            OverLimitAction::from_db(&stop_and_notify.over_limit_action),
            OverLimitAction::StopAndNotify
        );

        let mut notify_only = account_with_schedule(None, None);
        notify_only.over_limit_action = "notify_only".to_string();
        assert_eq!(
            OverLimitAction::from_db(&notify_only.over_limit_action),
            OverLimitAction::NotifyOnly
        );
    }

    #[test]
    fn keep_alive_requires_spot_and_switch() {
        let mut instance = InstanceInfo {
            instance_id: "i-1".to_string(),
            spot: true,
            keep_alive: true,
            status: "Stopped".to_string(),
            instance_type: "ecs.t6".to_string(),
            ..Default::default()
        };
        assert!(instance.keep_alive_active(true));
        assert!(!instance.keep_alive_active(false));

        instance.keep_alive = false;
        assert!(!instance.keep_alive_active(true));

        instance.keep_alive = true;
        instance.spot = false;
        assert!(!instance.keep_alive_active(true));
    }

    #[test]
    fn cron_report_summary() {
        let report = CronReport {
            accounts_total: 3,
            accounts_refreshed: 2,
            accounts_failed: 1,
            thresholds_fired: 1,
            instances_started: 2,
            instances_stopped: 1,
            keep_alive_started: 1,
            report_sent: false,
            retry_needed: false,
            notes: Vec::new(),
        };
        let summary = report.summary();
        assert!(summary.contains("账号 2/3"));
        assert!(summary.contains("日报 未触发"));
    }

    #[test]
    fn site_and_mode_defaults() {
        assert_eq!(SiteType::from_db("intl").label(), "国际站");
        assert_eq!(StopMode::from_db("KeepCharging").label(), "普通停机");
        assert_eq!(StopMode::from_db("StopCharging").label(), "节省停机");
    }

    // -----------------------------------------------------------------------
    // 进阶（Cron）定时
    // -----------------------------------------------------------------------

    /// 带 cron 配置的账号。
    fn account_with_cron(
        mode: Option<&str>,
        start: Option<&str>,
        stop: Option<&str>,
    ) -> AccountRow {
        AccountRow {
            schedule_mode: mode.map(|s| s.to_string()),
            schedule_start_cron: start.map(|s| s.to_string()),
            schedule_stop_cron: stop.map(|s| s.to_string()),
            ..account_with_schedule(None, None)
        }
    }

    #[test]
    fn advanced_mode_detection() {
        // 显式 advanced
        assert!(
            account_with_cron(Some("advanced"), Some("0 8 * * *"), None).schedule_is_advanced()
        );
        // simple / 空都算简单模式
        assert!(!account_with_cron(Some("simple"), Some("0 8 * * *"), None).schedule_is_advanced());
        assert!(!account_with_cron(None, Some("0 8 * * *"), None).schedule_is_advanced());
    }

    #[test]
    fn cron_accessors_trim_and_ignore_blank() {
        let acc = account_with_cron(Some("advanced"), Some("  0 8 * * *  "), Some("   "));
        assert_eq!(acc.start_cron(), Some("0 8 * * *"));
        assert_eq!(acc.stop_cron(), None);
    }
    #[test]
    fn cron_keep_alive_obeys_latest_event_even_with_stale_simple_fields() {
        use chrono::TimeZone;
        let at = |hour| {
            chrono::Utc
                .with_ymd_and_hms(2026, 11, 4, hour, 5, 0)
                .unwrap()
                .timestamp_millis()
        };
        let mut account =
            account_with_cron(Some("advanced"), Some("0 8 * * *"), Some("0 22 * * *"));
        account.schedule_start_time = Some("00:00".into());
        account.schedule_stop_time = Some("23:59".into());
        assert!(!automation_allowed(&account, at(7), "UTC+0"));
        assert!(automation_allowed(&account, at(8), "UTC+0"));
        assert!(!automation_allowed(&account, at(22), "UTC+0"));
        account.schedule_start_cron = None;
        assert!(!automation_allowed(&account, at(8), "UTC+0"));
        account.schedule_start_cron = Some("0 22 * * *".into());
        assert!(
            !automation_allowed(&account, at(22), "UTC+0"),
            "关机同刻优先"
        );
    }

    #[test]
    fn cron_keep_alive_handles_weekly_and_overnight_schedules() {
        use chrono::TimeZone;
        let at = |day, hour| {
            chrono::Utc
                .with_ymd_and_hms(2026, 11, day, hour, 0, 0)
                .unwrap()
                .timestamp_millis()
        };
        let weekly = account_with_cron(Some("advanced"), Some("0 8 * * MON"), Some("0 22 * * FRI"));
        assert!(automation_allowed(&weekly, at(4, 12), "UTC+0"));
        assert!(!automation_allowed(&weekly, at(7, 12), "UTC+0"));
        let overnight = account_with_cron(Some("advanced"), Some("0 22 * * *"), Some("0 6 * * *"));
        assert!(automation_allowed(&overnight, at(4, 23), "UTC+0"));
        assert!(automation_allowed(&overnight, at(5, 3), "UTC+0"));
        assert!(!automation_allowed(&overnight, at(5, 12), "UTC+0"));
    }
}
