//! # 调度器：采样、熔断、定时开关机、抢占式保活、日报
//!
//! 每次 Cron（`*/5 * * * *`）走一遍 [`Scheduler::run_cron`]：
//!
//! ```text
//! 1. 清理过期锁 / 旧任务 / 旧日志（每天一次）
//! 2. 逐个启用账号：CDT 流量 + 余额 + 各地域 ECS 实例 → 写快照 → 采样历史
//! 3. 阈值判定：合计流量 ≥ traffic_limit_gb
//!      └─ 首次超限 → 标记账期 + 通知 [+ 停机（stop_and_notify）]
//! 4. 定时关机（含 20 分钟短窗口补偿）
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

use std::collections::{BTreeSet, HashMap};

use crate::aliyun::AliyunClient;
use crate::crypto::{Crypto, random_hex};
use crate::db::Db;
use crate::models::{
    AccountOverview, AccountRow, BarkConfig, DailyReportConfig, HistoryBucket, InstanceInfo,
    NotifyChannel, OverLimitAction, SnapshotRow, SnapshotUpdate, TelegramConfig, TrafficPoint,
    build_overview, gb_to_bytes, human_amount, human_bytes, local_date, local_minutes_of_day,
    month_bounds_ms, now_ms, parse_hhmm, percent_of_limit, setting_key, utc_offset_minutes,
    within_window,
};
use crate::notify::{
    BarkChannel, Channels, Message, NotifyLevel, NotifyOutcome, TelegramChannel, dispatch,
};

/// 定时开关机的补偿窗口（分钟）。Cron 每 5 分钟一次，20 分钟窗口意味着
/// 最多 4 次重试机会，足以吞掉一次网络抖动。
pub const SCHEDULE_WINDOW_MINUTES: u32 = 20;
/// 日报的补偿窗口（分钟）。
pub const REPORT_WINDOW_MINUTES: u32 = 40;
/// 流量采样去重心跳：数值连续不变时，至少每 30 分钟落一个点，
/// 保证小时粒度图表不断线。
pub const HISTORY_HEARTBEAT_MS: i64 = 30 * 60 * 1000;
/// 历史数据保留天数。
pub const HISTORY_RETENTION_DAYS: i64 = 90;
/// 操作日志保留天数。
pub const LOG_RETENTION_DAYS: i64 = 30;
/// 任务记录保留天数。
pub const JOB_RETENTION_DAYS: i64 = 7;
/// 单实例动作锁 TTL（分钟）。
pub const INSTANCE_LOCK_TTL_MINUTES: i64 = 30;
/// 突变告警的默认阈值（GiB）：单次采样间隔内增长超过此值即告警。
pub const DEFAULT_SPIKE_THRESHOLD_GB: f64 = 5.0;
/// 突变判定允许的最大采样间隔：超过则视为正常增长（例如 Cron 停跑一整天）。
pub const SPIKE_MAX_GAP_MS: i64 = 2 * 60 * 60 * 1000;

// ===========================================================================
// 辅助函数
// ===========================================================================

/// 突变阈值（GB）。账号可覆盖，`None` 用默认值。
fn spike_threshold_gb(account: &AccountRow) -> f64 {
    account
        .spike_threshold_gb
        .unwrap_or(DEFAULT_SPIKE_THRESHOLD_GB)
        .max(0.0)
}

/// 把毫秒间隔转成便于阅读的时长。
fn human_duration(ms: i64) -> String {
    let minutes = (ms.max(0) / 60_000).max(1);
    if minutes < 60 {
        return format!("{minutes} 分钟");
    }
    let hours = minutes / 60;
    let rest = minutes % 60;
    if hours < 24 {
        if rest == 0 {
            format!("{hours} 小时")
        } else {
            format!("{hours} 小时 {rest} 分钟")
        }
    } else {
        format!("{} 天", hours / 24)
    }
}

// ===========================================================================
// 结果结构
// ===========================================================================

/// 单账号一次刷新的结果。
#[derive(Debug, Clone)]
pub struct RefreshOutcome {
    pub account_id: i64,
    pub account_name: String,
    /// 本次刷新是否成功取到至少一项数据。
    pub success: bool,
    pub total_bytes: i64,
    pub domestic_bytes: i64,
    pub overseas_bytes: i64,
    /// 本次刷新是否**新触发**了熔断。
    pub threshold_fired: bool,
    /// 本次采样是否检测到异常增长（已发出告警）。
    pub spike_detected: bool,
    /// 局部失败 / 提示信息。
    pub warnings: Vec<String>,
}

impl RefreshOutcome {
    fn failed(account: &AccountRow, error: String) -> Self {
        Self {
            account_id: account.id,
            account_name: account.name.clone(),
            success: false,
            total_bytes: 0,
            domestic_bytes: 0,
            overseas_bytes: 0,
            threshold_fired: false,
            spike_detected: false,
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
    pub spikes_detected: usize,
    pub instances_started: usize,
    pub instances_stopped: usize,
    pub keep_alive_started: usize,
    pub report_sent: bool,
    /// 逐条明细（日志用）。
    pub notes: Vec<String>,
}

impl CronReport {
    /// 单行摘要。
    pub fn summary(&self) -> String {
        format!(
            "账号 {}/{} 刷新成功，失败 {}，熔断 {}，突变 {}，停机 {}，开机 {}，保活 {}，日报 {}",
            self.accounts_refreshed,
            self.accounts_total,
            self.accounts_failed,
            self.thresholds_fired,
            self.spikes_detected,
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

/// 账号内批量开关机的结果。
#[derive(Debug, Clone)]
pub struct InstanceBatchSummary {
    pub started: usize,
    pub skipped: usize,
    pub failed: usize,
    /// 人类可读的汇总文案。
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
                    api_host: telegram
                        .api_host
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string()),
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
    /// 例如 `spike:3:4850000`。
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
        Some(self.notify(message).await)
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
        match self.refresh_account_inner(account).await {
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
        let regions = account.regions();
        let (month_start, month_end) = month_bounds_ms(self.now, &self.timezone);

        let sync = crate::aliyun::sync_account(&client, &regions, month_start, month_end).await;

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

        let synced_instance_count = sync.instances.len();
        let mut instances = sync.instances;
        for instance in &mut instances {
            instance.keep_alive = previous_keep_alive
                .get(&instance.instance_id)
                .copied()
                .unwrap_or(false);
        }

        // 若某地域整体查询失败（而不是"这个地域没有实例"），沿用旧快照里该
        // 地域的实例，避免一次网络抖动就让界面上的实例整片消失。
        if !sync.failed_regions.is_empty()
            && let Some(previous_snapshot) = previous.as_ref()
        {
            let failed: BTreeSet<&str> = sync
                .failed_regions
                .iter()
                .map(|region| region.as_str())
                .collect();
            let synced_ids: BTreeSet<String> = instances
                .iter()
                .map(|instance| instance.instance_id.clone())
                .collect();
            for old in previous_snapshot.instances() {
                if failed.contains(old.region_id.as_str())
                    && !synced_ids.contains(old.instance_id.as_str())
                {
                    instances.push(old);
                }
            }
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
        let (balance_amount, balance_currency) = match sync.balance.as_ref() {
            Some(balance) => (Some(balance.amount), balance.currency.clone()),
            None => match previous.as_ref() {
                Some(snapshot) => (snapshot.balance_amount, snapshot.balance_currency.clone()),
                None => (None, None),
            },
        };

        self.db
            .upsert_snapshot(&SnapshotUpdate {
                account_id: account.id,
                balance_amount,
                balance_currency,
                cdt_domestic_bytes: domestic_bytes,
                cdt_overseas_bytes: overseas_bytes,
                billing_month: billing_month.clone(),
                instances: instances.clone(),
                updated_at: now_ms(),
            })
            .await?;

        // 采样历史（数值不变时按心跳去重）。
        //
        // 写入前先取上一次采样，用于突变检测：CDT 上报的是账期累计值，
        // 两条相邻记录的增长量即这段时间消耗的流量。
        let previous_sample = self.db.latest_history(account.id).await.ok().flatten();
        self.db
            .sample_history(
                account.id,
                self.now,
                domestic_bytes,
                overseas_bytes,
                HISTORY_HEARTBEAT_MS,
            )
            .await?;

        let total_bytes = domestic_bytes + overseas_bytes;
        let limit_bytes = gb_to_bytes(account.traffic_limit_gb);
        let already_triggered = previous
            .as_ref()
            .map(|snapshot| snapshot.threshold_triggered(&billing_month))
            .unwrap_or(false);

        let mut threshold_fired = false;
        if limit_bytes > 0 && total_bytes >= limit_bytes && !already_triggered {
            threshold_fired = self
                .handle_threshold(account, total_bytes, domestic_bytes, overseas_bytes)
                .await?;
        }

        // 突变告警：相邻两次采样之间增长过多，说明流量正在被快速消耗。
        // 与阈值熔断互补 —— 熔断是「到上限才管」，突变是「刚发生就知道」。
        let spike_detected = self
            .check_spike(account, previous_sample.as_ref(), total_bytes)
            .await;

        for warning in &sync.warnings {
            let _ = self
                .db
                .add_log(Some(account.id), "refresh_warning", None, warning, now_ms())
                .await;
        }

        Ok(RefreshOutcome {
            account_id: account.id,
            account_name: account.name.clone(),
            // 只有真正取到数据才算成功。此前把 `previous.is_some()`（存在旧快照）
            // 也算成功，导致「CDT / 余额 / 实例全部失败」时任务仍报 success，
            // 用户看到「已刷新」却看不到任何新数据，这是误导性的反馈。
            success: sync.traffic.is_some() || sync.balance.is_some() || synced_instance_count > 0,
            total_bytes,
            domestic_bytes,
            overseas_bytes,
            threshold_fired,
            spike_detected,
            warnings: sync.warnings,
        })
    }

    /// 检测单次采样是否异常增长，命中则记录日志并推送告警。
    ///
    /// 返回是否发出了告警。用幂等锁按「账号 + 小时」去重，避免同一波流量
    /// 在每次 Cron 都重复通知。
    async fn check_spike(
        &self,
        account: &AccountRow,
        previous: Option<&TrafficPoint>,
        current_total: i64,
    ) -> bool {
        let Some(prev) = previous else {
            return false;
        };

        let threshold_bytes = gb_to_bytes(spike_threshold_gb(account));
        let gap = self.now.saturating_sub(prev.recorded_at);
        if !crate::models::is_traffic_spike(
            prev.total_bytes,
            current_total,
            gap,
            threshold_bytes,
            SPIKE_MAX_GAP_MS,
        ) {
            return false;
        }

        let increase = current_total - prev.total_bytes;
        let detail = format!(
            "{} 内增长 {}（{} → {}），超过突变阈值 {}",
            human_duration(gap),
            human_bytes(increase),
            human_bytes(prev.total_bytes),
            human_bytes(current_total),
            human_bytes(threshold_bytes)
        );

        let _ = self
            .db
            .add_log(Some(account.id), "traffic_spike", None, &detail, now_ms())
            .await;

        let message = Message::new(
            format!("流量异常增长 · {}", account.name),
            format!("{detail}，请确认是否有预期外的流量消耗。"),
            NotifyLevel::Alert,
        )
        .with_details(vec![
            format!(
                "当前已用 {}（配额 {:.0} GB 的 {:.1}%）",
                human_bytes(current_total),
                account.traffic_limit_gb,
                percent_of_limit(current_total, account.traffic_limit_gb)
            ),
            format!(
                "账期 {}",
                crate::models::billing_month(self.now, &self.timezone)
            ),
        ])
        .with_group("CDT-Spike");

        // 同一账号同一小时内只告警一次：Cron 每 5 分钟一轮，
        // 一次持续的大流量会连续触发几十条通知。
        let hour_key = self.now / (60 * 60 * 1000);
        let dedup_key = format!("spike:{}:{}", account.id, hour_key);
        self.notify_once(&dedup_key, 60 * 60 * 1000, message)
            .await
            .is_some()
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
    // 阈值熔断
    // -----------------------------------------------------------------------

    /// 处理首次超限：标记账期 → 停机（按策略）→ 告警。
    ///
    /// 返回是否真的完成了标记（幂等锁保护，并发 Cron 只有一个能进来）。
    async fn handle_threshold(
        &self,
        account: &AccountRow,
        total_bytes: i64,
        domestic_bytes: i64,
        overseas_bytes: i64,
    ) -> worker::Result<bool> {
        let billing_month = crate::models::billing_month(self.now, &self.timezone);
        let lock_name = format!("threshold:{}:{}", account.id, billing_month);
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        let acquired = self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 15 * 60 * 1000)
            .await?;
        if !acquired {
            return Ok(false);
        }

        self.db
            .mark_threshold_triggered(account.id, &billing_month, now_ms())
            .await?;

        let mut details = vec![
            format!(
                "国内 {} / 海外 {} / 合计 {}",
                human_bytes(domestic_bytes),
                human_bytes(overseas_bytes),
                human_bytes(total_bytes)
            ),
            format!(
                "阈值 {} GB（{:.2}%）",
                trim_float(account.traffic_limit_gb),
                percent_of_limit(total_bytes, account.traffic_limit_gb)
            ),
            format!("账期 {}", billing_month),
        ];

        let mut stopped = Vec::new();
        let mut stop_failures = Vec::new();

        if account.action() == OverLimitAction::StopAndNotify {
            let instances = self.db.snapshot_instances(account.id).await?;
            let running: Vec<InstanceInfo> = instances
                .into_iter()
                .filter(|instance| instance.is_running())
                .collect();

            if running.is_empty() {
                details.push("没有运行中的实例需要停机".to_string());
            } else {
                let secret = self.account_secret(account)?;
                let client = AliyunClient::from_account(account, secret);
                for instance in &running {
                    match client
                        .stop_instance(
                            &instance.instance_id,
                            &instance.region_id,
                            account.stop_mode(),
                        )
                        .await
                    {
                        Ok(()) => {
                            stopped.push(instance.instance_id.clone());
                            self.db
                                .add_log(
                                    Some(account.id),
                                    "threshold_stop",
                                    Some(&instance.instance_id),
                                    &format!("流量熔断停机（{}）", account.stop_mode().label()),
                                    now_ms(),
                                )
                                .await?;
                        }
                        Err(err) => {
                            let detail =
                                format!("{} 停机失败：{}", instance.instance_id, err.short());
                            stop_failures.push(detail.clone());
                            self.db
                                .add_log(
                                    Some(account.id),
                                    "threshold_stop_failed",
                                    Some(&instance.instance_id),
                                    &detail,
                                    now_ms(),
                                )
                                .await?;
                        }
                    }
                }
            }
            if !stopped.is_empty() {
                details.push(format!("已停机：{}", stopped.join("、")));
            }
            details.extend(stop_failures.iter().cloned());
        } else {
            details.push("策略为「仅通知」，未执行停机".to_string());
        }

        self.db
            .add_log(
                Some(account.id),
                "threshold_triggered",
                None,
                &format!("流量超阈值：{}", details.join("；")),
                now_ms(),
            )
            .await?;

        let title = format!("{} 流量超阈值", account.name);
        let body = if account.action() == OverLimitAction::StopAndNotify {
            format!(
                "合计 {} 已超过阈值 {} GB，已按策略停机。",
                human_bytes(total_bytes),
                trim_float(account.traffic_limit_gb)
            )
        } else {
            format!(
                "合计 {} 已超过阈值 {} GB，当前策略为仅通知，实例仍在运行。",
                human_bytes(total_bytes),
                trim_float(account.traffic_limit_gb)
            )
        };

        self.notify(
            Message::alert(title, body)
                .with_details(details)
                .with_group(format!("CDT-{}", account.id)),
        )
        .await;

        // 释放锁：熔断标记已经落库，后续靠快照里的账期判断，不需要长锁。
        let _ = self.db.release_lock(&lock_name, &owner).await;
        Ok(true)
    }

    /// 当月是否处于「熔断闸门」关闭状态（禁止任何自动/手动开机）。
    pub async fn threshold_blocked(&self, account: &AccountRow) -> worker::Result<bool> {
        if account.action() != OverLimitAction::StopAndNotify {
            return Ok(false);
        }
        let billing_month = crate::models::billing_month(self.now, &self.timezone);
        Ok(self
            .db
            .get_snapshot(account.id)
            .await?
            .map(|snapshot| snapshot.threshold_triggered(&billing_month))
            .unwrap_or(false))
    }

    // -----------------------------------------------------------------------
    // 定时开关机
    // -----------------------------------------------------------------------

    /// 定时关机：命中窗口且当天未执行过。
    async fn maybe_scheduled_stop(
        &self,
        account: &AccountRow,
        report: &mut CronReport,
    ) -> worker::Result<()> {
        let Some(target) = account.schedule_stop_minutes() else {
            return Ok(());
        };
        let now_minutes = local_minutes_of_day(self.now, &self.timezone);
        if !within_window(now_minutes, target, SCHEDULE_WINDOW_MINUTES) {
            return Ok(());
        }
        let today = local_date(self.now, &self.timezone);
        if account.last_schedule_stop_date.as_deref() == Some(today.as_str()) {
            return Ok(());
        }

        let lock_name = format!("schedule-stop:{}:{}", account.id, today);
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        if !self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 20 * 60 * 1000)
            .await?
        {
            return Ok(());
        }

        let instances = self.db.snapshot_instances(account.id).await?;
        let running: Vec<InstanceInfo> = instances
            .into_iter()
            .filter(|instance| instance.is_running())
            .collect();

        let mut ok_count = 0usize;
        if !running.is_empty() {
            let secret = self.account_secret(account)?;
            let client = AliyunClient::from_account(account, secret);
            for instance in &running {
                match client
                    .stop_instance(
                        &instance.instance_id,
                        &instance.region_id,
                        account.stop_mode(),
                    )
                    .await
                {
                    Ok(()) => {
                        ok_count += 1;
                        report.instances_stopped += 1;
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_stop",
                                Some(&instance.instance_id),
                                &format!(
                                    "定时关机 {}",
                                    account.schedule_stop_time.as_deref().unwrap_or("-")
                                ),
                                now_ms(),
                            )
                            .await?;
                    }
                    Err(err) => {
                        report.notes.push(format!(
                            "{} 定时关机失败（{}）：{}",
                            account.name,
                            instance.instance_id,
                            err.short()
                        ));
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_stop_failed",
                                Some(&instance.instance_id),
                                &err.short(),
                                now_ms(),
                            )
                            .await?;
                    }
                }
            }
        }

        // 只在「全部成功」或「本来就没有运行中的实例」时标记当日完成。
        // 任一实例失败都不标记，让 20 分钟窗口内的下一轮 Cron 继续重试。
        if ok_count == running.len() {
            self.db
                .mark_schedule_done(account.id, false, &today, now_ms())
                .await?;
        }
        let _ = self.db.release_lock(&lock_name, &owner).await;

        report.notes.push(format!(
            "{} 定时关机：成功 {} / 待处理 {}（{}）",
            account.name,
            ok_count,
            running.len().saturating_sub(ok_count),
            today
        ));
        Ok(())
    }

    /// 定时开机：命中窗口、当天未执行过、且未被熔断闸门拦住。
    async fn maybe_scheduled_start(
        &self,
        account: &AccountRow,
        report: &mut CronReport,
    ) -> worker::Result<()> {
        let Some(target) = account.schedule_start_minutes() else {
            return Ok(());
        };
        let now_minutes = local_minutes_of_day(self.now, &self.timezone);
        if !within_window(now_minutes, target, SCHEDULE_WINDOW_MINUTES) {
            return Ok(());
        }
        let today = local_date(self.now, &self.timezone);
        if account.last_schedule_start_date.as_deref() == Some(today.as_str()) {
            return Ok(());
        }

        // 优先级：熔断闸门高于定时开机
        if self.threshold_blocked(account).await? {
            // 标记当日已完成：本月不会再尝试拉起，无需在窗口内反复判定。
            self.db
                .mark_schedule_done(account.id, true, &today, now_ms())
                .await?;
            report.notes.push(format!(
                "{} 定时开机被跳过：本月已触发流量熔断",
                account.name
            ));
            self.db
                .add_log(
                    Some(account.id),
                    "schedule_start_blocked",
                    None,
                    "本月已触发流量熔断，定时开机被禁止",
                    now_ms(),
                )
                .await?;
            return Ok(());
        }

        let lock_name = format!("schedule-start:{}:{}", account.id, today);
        let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
        if !self
            .db
            .acquire_lock(&lock_name, &owner, now_ms(), 20 * 60 * 1000)
            .await?
        {
            return Ok(());
        }

        let instances = self.db.snapshot_instances(account.id).await?;
        let stopped: Vec<InstanceInfo> = instances
            .into_iter()
            .filter(|instance| instance.is_stopped())
            .collect();

        let mut ok_count = 0usize;
        if !stopped.is_empty() {
            let secret = self.account_secret(account)?;
            let client = AliyunClient::from_account(account, secret);
            for instance in &stopped {
                match client
                    .start_instance(&instance.instance_id, &instance.region_id)
                    .await
                {
                    Ok(()) => {
                        ok_count += 1;
                        report.instances_started += 1;
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_start",
                                Some(&instance.instance_id),
                                &format!(
                                    "定时开机 {}",
                                    account.schedule_start_time.as_deref().unwrap_or("-")
                                ),
                                now_ms(),
                            )
                            .await?;
                    }
                    Err(err) => {
                        report.notes.push(format!(
                            "{} 定时开机失败（{}）：{}",
                            account.name,
                            instance.instance_id,
                            err.short()
                        ));
                        self.db
                            .add_log(
                                Some(account.id),
                                "schedule_start_failed",
                                Some(&instance.instance_id),
                                &err.short(),
                                now_ms(),
                            )
                            .await?;
                    }
                }
            }
        }

        if ok_count == stopped.len() {
            self.db
                .mark_schedule_done(account.id, true, &today, now_ms())
                .await?;
        }
        let _ = self.db.release_lock(&lock_name, &owner).await;

        report.notes.push(format!(
            "{} 定时开机：成功 {} / 待处理 {}（{}）",
            account.name,
            ok_count,
            stopped.len().saturating_sub(ok_count),
            today
        ));
        Ok(())
    }

    // -----------------------------------------------------------------------
    // 抢占式保活
    // -----------------------------------------------------------------------

    /// 抢占式实例保活：仅拉起「被系统释放后处于 Stopped」的可保活实例。
    async fn maybe_keep_alive(
        &self,
        account: &AccountRow,
        snapshot: Option<&SnapshotRow>,
        report: &mut CronReport,
    ) -> worker::Result<()> {
        if !account.is_spot_keep_alive() {
            return Ok(());
        }
        let Some(snapshot) = snapshot else {
            return Ok(());
        };

        let candidates: Vec<InstanceInfo> = snapshot
            .instances()
            .into_iter()
            .filter(|instance| instance.keep_alive_active(true) && instance.is_stopped())
            .collect();
        if candidates.is_empty() {
            return Ok(());
        }

        // 夜间停机窗口内不保活（否则会把计划停机的实例重新拉起）
        if in_sleep_window(account, local_minutes_of_day(self.now, &self.timezone)) {
            report.notes.push(format!(
                "{} 处于定时停机窗口内，跳过抢占式保活",
                account.name
            ));
            return Ok(());
        }

        // 熔断闸门
        if self.threshold_blocked(account).await? {
            report
                .notes
                .push(format!("{} 已触发流量熔断，跳过抢占式保活", account.name));
            return Ok(());
        }

        let secret = self.account_secret(account)?;
        let client = AliyunClient::from_account(account, secret);

        for instance in &candidates {
            let lock_name = format!("keepalive:{}:{}", account.id, instance.instance_id);
            let owner = random_hex(8).map_err(|e| worker::Error::RustError(e.to_string()))?;
            if !self
                .db
                .acquire_lock(
                    &lock_name,
                    &owner,
                    now_ms(),
                    INSTANCE_LOCK_TTL_MINUTES * 60 * 1000,
                )
                .await?
            {
                continue;
            }

            match client
                .start_instance(&instance.instance_id, &instance.region_id)
                .await
            {
                Ok(()) => {
                    report.keep_alive_started += 1;
                    report.notes.push(format!(
                        "{} 抢占式保活拉起 {}",
                        account.name, instance.instance_id
                    ));
                    self.db
                        .add_log(
                            Some(account.id),
                            "spot_keep_alive",
                            Some(&instance.instance_id),
                            "抢占式实例已被释放，自动重新拉起",
                            now_ms(),
                        )
                        .await?;
                }
                Err(err) => {
                    report.notes.push(format!(
                        "{} 保活失败（{}）：{}",
                        account.name,
                        instance.instance_id,
                        err.short()
                    ));
                    self.db
                        .add_log(
                            Some(account.id),
                            "spot_keep_alive_failed",
                            Some(&instance.instance_id),
                            &err.short(),
                            now_ms(),
                        )
                        .await?;
                }
            }
        }

        Ok(())
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
        self.notify(message).await;

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
        let mut total_bytes = 0i64;
        let mut triggered = 0usize;
        let mut running = 0usize;
        let mut stopped = 0usize;

        for account in &accounts {
            let snapshot = snapshots.get(&account.id);
            let overview: AccountOverview = build_overview(account, snapshot, tz, self.now);
            total_bytes += overview.cdt_total_bytes;
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
            details.push(format!(
                "{}（{}）：国内 {} · 海外 {} · 合计 {} / {} GB（{:.2}%）｜余额 {}｜实例 {} 台{}",
                overview.name,
                overview.site_label,
                human_bytes(overview.cdt_domestic_bytes),
                human_bytes(overview.cdt_overseas_bytes),
                human_bytes(overview.cdt_total_bytes),
                trim_float(overview.traffic_limit_gb),
                overview.total_percent,
                balance,
                overview.instances.len(),
                if overview.threshold_triggered {
                    "｜⚠️ 已熔断"
                } else {
                    ""
                }
            ));
        }

        if details.is_empty() {
            details.push("尚未添加任何阿里云账号".to_string());
        }

        let body = format!(
            "{} 概览：{} 个账号，合计流量 {}，实例运行 {} / 停止 {}，已熔断 {} 个。",
            local_date(self.now, tz),
            accounts.len(),
            human_bytes(total_bytes),
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
    ) -> worker::Result<InstanceActionResult> {
        let account = self
            .db
            .get_account(account_id)
            .await?
            .ok_or_else(|| worker::Error::RustError(format!("账号 {account_id} 不存在")))?;

        let instances = self.db.snapshot_instances(account_id).await?;
        let target = instances
            .into_iter()
            .find(|instance| instance.instance_id == instance_id);

        let region_id = match target.as_ref() {
            Some(instance) => instance.region_id.clone(),
            None => account
                .regions()
                .first()
                .cloned()
                .unwrap_or_else(|| "cn-hangzhou".to_string()),
        };

        if start && self.threshold_blocked(&account).await? {
            return Err(worker::Error::RustError(
                "本月已触发流量熔断停机，禁止开机；请提升阈值或等待下个账期".to_string(),
            ));
        }

        if let Some(instance) = target.as_ref() {
            if start && instance.is_running() {
                return Ok(InstanceActionResult {
                    instance_id: instance_id.to_string(),
                    ok: true,
                    detail: "实例已在运行中，无需开机".to_string(),
                });
            }
            if !start && instance.is_stopped() {
                return Ok(InstanceActionResult {
                    instance_id: instance_id.to_string(),
                    ok: true,
                    detail: "实例已处于停止状态".to_string(),
                });
            }
        }

        let secret = self.account_secret(&account)?;
        let client = AliyunClient::from_account(&account, secret);

        let result = if start {
            client.start_instance(instance_id, &region_id).await
        } else {
            client
                .stop_instance(instance_id, &region_id, account.stop_mode())
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

        // 动作后立即刷新，保证前端轮询结束时看到的是真实状态
        let refresh = self.refresh_account(&account).await;
        if !refresh.success {
            log_warn!("动作后刷新失败：{}", refresh.warnings.join("；"));
        }

        Ok(detail)
    }

    /// 对账号内全部实例执行开/关机。
    ///
    /// 逐个执行而非并发：阿里云对单账号有 QPS 限制，并发容易触发限流；
    /// 且失败需要逐个记录，串行更容易给出准确的汇总。
    pub async fn instance_batch(
        &self,
        account_id: i64,
        start: bool,
    ) -> worker::Result<InstanceBatchSummary> {
        let account = self
            .db
            .get_account(account_id)
            .await?
            .ok_or_else(|| worker::Error::RustError(format!("账号 {account_id} 不存在")))?;

        // 熔断开机闸门：批量开机同样受约束
        if start && self.threshold_blocked(&account).await? {
            return Err(worker::Error::RustError(
                "本月已触发流量熔断停机，禁止开机；请提升阈值或等待下个账期".to_string(),
            ));
        }

        let instances = self.db.snapshot_instances(account_id).await?;
        if instances.is_empty() {
            return Ok(InstanceBatchSummary {
                started: 0,
                skipped: 0,
                failed: 0,
                detail: "没有可操作的实例".to_string(),
            });
        }

        let mut ok_count = 0usize;
        let mut skipped = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for instance in &instances {
            // 先按快照状态预判，避免对已处于目标状态的实例发起请求
            if start && instance.is_running() {
                skipped += 1;
                continue;
            }
            if !start && instance.is_stopped() {
                skipped += 1;
                continue;
            }

            match self
                .instance_action(account_id, &instance.instance_id, start)
                .await
            {
                Ok(_) => ok_count += 1,
                Err(err) => failures.push(format!("{}：{err}", instance.instance_id)),
            }
        }

        let action = if start { "开机" } else { "关机" };
        let mut detail = format!("{action}完成 {ok_count} 台");
        if skipped > 0 {
            detail.push_str(&format!("，跳过 {skipped} 台（已在目标状态）"));
        }
        if !failures.is_empty() {
            detail.push_str(&format!("，失败 {} 台", failures.len()));
        }
        if !failures.is_empty() {
            detail.push_str(&format!("（{}）", failures.join("；")));
        }

        self.db
            .add_log(
                Some(account_id),
                if start { "batch_start" } else { "batch_stop" },
                None,
                &detail,
                now_ms(),
            )
            .await
            .ok();

        // 全部失败才报错，部分成功仍算完成（细节已在文案里）
        if ok_count == 0 && !failures.is_empty() {
            return Err(worker::Error::RustError(detail));
        }

        Ok(InstanceBatchSummary {
            started: ok_count,
            skipped,
            failed: failures.len(),
            detail,
        })
    }

    /// 切换逐实例抢占式保活开关。
    pub async fn set_instance_keep_alive(
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

    /// 执行一次完整巡检。
    pub async fn run_cron(&self) -> CronReport {
        let mut report = CronReport::default();

        self.housekeeping(&mut report).await;

        let accounts = match self.db.list_accounts(true).await {
            Ok(accounts) => accounts,
            Err(err) => {
                log_error!("读取账号失败：{err}");
                report.notes.push(format!("读取账号失败：{err}"));
                return report;
            }
        };
        report.accounts_total = accounts.len();

        for account in &accounts {
            let outcome = self.refresh_account(account).await;
            if outcome.success {
                report.accounts_refreshed += 1;
            } else {
                report.accounts_failed += 1;
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

            // 快照可能已被本次刷新更新，重新读取用于后续判断
            let snapshot = self.db.get_snapshot(account.id).await.ok().flatten();

            if let Err(err) = self.maybe_scheduled_stop(account, &mut report).await {
                report
                    .notes
                    .push(format!("{} 定时关机异常：{err}", account.name));
            }
            if let Err(err) = self.maybe_scheduled_start(account, &mut report).await {
                report
                    .notes
                    .push(format!("{} 定时开机异常：{err}", account.name));
            }
            if let Err(err) = self
                .maybe_keep_alive(account, snapshot.as_ref(), &mut report)
                .await
            {
                report
                    .notes
                    .push(format!("{} 保活异常：{err}", account.name));
            }
        }

        if let Err(err) = self.maybe_daily_report(&mut report).await {
            report.notes.push(format!("日报异常：{err}"));
        }

        for note in &report.notes {
            log_info!("{}", note);
        }
        log_info!("Cron 完成：{}", report.summary());
        report
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

    /// 流量历史（按小时 / 天分桶）。
    pub async fn traffic_history(
        &self,
        account_id: i64,
        bucket: HistoryBucket,
        limit: u32,
    ) -> worker::Result<Vec<crate::models::TrafficPoint>> {
        let offset_ms = utc_offset_minutes(&self.timezone) as i64 * 60_000;
        let until = self.now;
        let since = until - bucket.default_span_ms();
        self.db
            .aggregate_history(account_id, bucket, offset_ms, since, until, limit)
            .await
    }
}

// ===========================================================================
// 纯函数工具
// ===========================================================================

/// 当前是否处于「定时停机 → 定时开机」之间的睡眠窗口。
///
/// * 未配置任一时刻 → 不算睡眠窗口；
/// * `stop < start`：窗口为 `[stop, start)`；
/// * `stop > start`：窗口跨越午夜，为 `[stop, 24:00) ∪ [00:00, start)`；
/// * `stop == start`：视为未配置（无法判断），不算窗口。
pub fn in_sleep_window(account: &AccountRow, now_minutes: u32) -> bool {
    let (Some(stop), Some(start)) = (
        account.schedule_stop_minutes(),
        account.schedule_start_minutes(),
    ) else {
        return false;
    };
    if stop == start {
        return false;
    }
    if stop < start {
        now_minutes >= stop && now_minutes < start
    } else {
        now_minutes >= stop || now_minutes < start
    }
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
            id: 1,
            name: "测试账号".to_string(),
            site_type: "china".to_string(),
            access_key_id: "LTAI5tTestKey".to_string(),
            encrypted_access_key_secret: "cipher".to_string(),
            regions_json: "[]".to_string(),
            traffic_limit_gb: 20.0,
            spike_threshold_gb: None,
            over_limit_action: "stop_and_notify".to_string(),
            stop_mode: "StopCharging".to_string(),
            schedule_start_time: start.map(|s| s.to_string()),
            schedule_stop_time: stop.map(|s| s.to_string()),
            spot_keep_alive: 1,
            enabled: 1,
            last_schedule_start_date: None,
            last_schedule_stop_date: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn sleep_window_within_same_day() {
        // start=08:00 stop=22:00 → 睡眠窗口 [22:00, 24:00) ∪ [00:00, 08:00)
        let account = account_with_schedule(Some("08:00"), Some("22:00"));
        assert!(in_sleep_window(&account, 0));
        assert!(in_sleep_window(&account, 7 * 60 + 59));
        assert!(!in_sleep_window(&account, 8 * 60));
        assert!(!in_sleep_window(&account, 12 * 60));
        assert!(!in_sleep_window(&account, 21 * 60 + 59));
        assert!(in_sleep_window(&account, 22 * 60));
        assert!(in_sleep_window(&account, 23 * 60 + 59));
    }

    #[test]
    fn sleep_window_overnight_is_running_overnight() {
        // start=22:00 stop=08:00 → 睡眠窗口 [08:00, 22:00)
        let account = account_with_schedule(Some("22:00"), Some("08:00"));
        assert!(in_sleep_window(&account, 8 * 60));
        assert!(in_sleep_window(&account, 15 * 60));
        assert!(in_sleep_window(&account, 21 * 60 + 59));
        assert!(!in_sleep_window(&account, 22 * 60));
        assert!(!in_sleep_window(&account, 2 * 60));
    }

    #[test]
    fn sleep_window_undefined_cases() {
        assert!(!in_sleep_window(
            &account_with_schedule(None, Some("08:00")),
            10 * 60
        ));
        assert!(!in_sleep_window(
            &account_with_schedule(Some("08:00"), None),
            10 * 60
        ));
        // start == stop：无法推断区间，视为不睡眠
        assert!(!in_sleep_window(
            &account_with_schedule(Some("08:00"), Some("08:00")),
            8 * 60
        ));
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
            spikes_detected: 0,
            instances_started: 2,
            instances_stopped: 1,
            keep_alive_started: 1,
            report_sent: false,
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
}
