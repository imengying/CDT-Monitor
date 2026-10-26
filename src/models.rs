//! # 数据模型层
//!
//! * D1 实体行（`*Row`）：字段类型与 SQLite 列一一对应。所有布尔列都以
//!   `INTEGER(0/1)` 存储，读取时统一用 `i64` 承载再转换——因为
//!   `serde-wasm-bindgen` 反序列化 `bool` 时只接受 JS `true/false`，
//!   直接写 `bool` 字段会得到 "invalid type" 错误。
//! * 前后端 DTO：直接序列化成 JSON 交给浏览器，字段名统一 `snake_case`。
//! * 时间与单位换算工具：全局时区、账期、百分比、字节格式化。
//!
//! 时区约定：`settings.timezone` 以 `UTC+8` 这类固定偏移形式保存，
//! 本模块把它解析成分钟偏移，供账期计算、定时开关机与图表分桶使用。

use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use serde::{Deserialize, Serialize};

// ===========================================================================
// 常量
// ===========================================================================

/// 1 GiB 的字节数。阿里云 CDT 流量配额按 1 GB = 1024³ 字节计。
pub const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// 未在账号里配置地域时使用的默认地域列表。
pub const DEFAULT_REGIONS: &[&str] = &["cn-hangzhou", "cn-shanghai", "cn-beijing", "cn-shenzhen"];

/// 系统设置表的固定 key。
pub mod setting_key {
    pub const SCHEMA_VERSION: &str = "schema_version";
    pub const TIMEZONE: &str = "timezone";
    pub const DAILY_REPORT: &str = "daily_report";
    pub const TELEGRAM: &str = "telegram";
    pub const BARK: &str = "bark";
    /// Turnstile 配置 JSON（site_key + 加密的 secret_key + 开关）。
    pub const TURNSTILE: &str = "turnstile";
    /// 高级配置 JSON（日志级别、任务锁 TTL、会话有效期）。
    pub const ADVANCED: &str = "advanced";
}

// ===========================================================================
// 时间工具
// ===========================================================================

/// 当前 Unix 毫秒时间戳（Workers 运行时提供 `Date.now()`）。
pub fn now_ms() -> i64 {
    worker::Date::now().as_millis() as i64
}

/// 把 `UTC+8` / `GMT-05:00` / `+8` / `8` 解析为分钟偏移；无法识别时按 UTC 处理。
pub fn utc_offset_minutes(tz: &str) -> i32 {
    let upper = tz.trim().to_ascii_uppercase();
    let body = upper
        .trim_start_matches("UTC")
        .trim_start_matches("GMT")
        .trim();
    if body.is_empty() {
        return 0;
    }
    let (sign, rest) = match body.chars().next() {
        Some('+') => (1, &body[1..]),
        Some('-') => (-1, &body[1..]),
        _ => (1, body),
    };
    let mut parts = rest.split(':');
    let hours: i32 = parts
        .next()
        .map(|h| h.trim())
        .and_then(|h| h.parse().ok())
        .unwrap_or(0);
    let minutes: i32 = parts
        .next()
        .map(|m| m.trim())
        .and_then(|m| m.parse().ok())
        .unwrap_or(0);
    let total = hours.clamp(0, 14) * 60 + minutes.clamp(0, 59);
    (sign * total).clamp(-12 * 60, 14 * 60)
}

/// 可选时区（固定偏移）。
///
/// 界面用下拉选择而非自由输入：手填 `UTC+8` 这类字符串格式错了不会报错，
/// 会被静默按 UTC 处理，导致定时开关机与日报时刻整体偏移。
pub const TIMEZONE_OPTIONS: &[(&str, &str)] = &[
    ("UTC-8", "UTC-8 · 美西"),
    ("UTC-7", "UTC-7 · 美西夏令时"),
    ("UTC-5", "UTC-5 · 美东"),
    ("UTC-3", "UTC-3 · 巴西"),
    ("UTC+0", "UTC+0 · 伦敦"),
    ("UTC+1", "UTC+1 · 中欧"),
    ("UTC+3", "UTC+3 · 莫斯科"),
    ("UTC+4", "UTC+4 · 迪拜"),
    ("UTC+5:30", "UTC+5:30 · 印度"),
    ("UTC+6:30", "UTC+6:30 · 缅甸"),
    ("UTC+7", "UTC+7 · 曼谷 / 雅加达"),
    ("UTC+8", "UTC+8 · 北京 / 新加坡"),
    ("UTC+9", "UTC+9 · 东京 / 首尔"),
    ("UTC+10", "UTC+10 · 悉尼"),
    ("UTC+12", "UTC+12 · 奥克兰"),
];

/// 默认时区。
pub const DEFAULT_TIMEZONE: &str = "UTC+8";

/// 校验是否为受支持的时区取值。
pub fn is_supported_timezone(tz: &str) -> bool {
    let tz = tz.trim();
    TIMEZONE_OPTIONS.iter().any(|(value, _)| *value == tz)
}

/// 把固定偏移时区转成 `FixedOffset`。
pub fn fixed_offset(tz: &str) -> FixedOffset {
    let minutes = utc_offset_minutes(tz);
    FixedOffset::east_opt(minutes * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("UTC 偏移合法"))
}

/// 毫秒时间戳 -> 指定时区的本地时间。
pub fn local_datetime(ms: i64, tz: &str) -> DateTime<FixedOffset> {
    let utc = DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(|| DateTime::<Utc>::from_timestamp_millis(0).expect("epoch 合法"));
    utc.with_timezone(&fixed_offset(tz))
}

/// 账期标识 `YYYY-MM`（按本地时区）。
pub fn billing_month(ms: i64, tz: &str) -> String {
    let dt = local_datetime(ms, tz);
    format!("{:04}-{:02}", dt.year(), dt.month())
}

/// 本地日期 `YYYY-MM-DD`，用于「每日任务只执行一次」的去重标记。
pub fn local_date(ms: i64, tz: &str) -> String {
    let dt = local_datetime(ms, tz);
    format!("{:04}-{:02}-{:02}", dt.year(), dt.month(), dt.day())
}

/// 本地时间距当日 00:00 的分钟数（0..1440）。
pub fn local_minutes_of_day(ms: i64, tz: &str) -> u32 {
    let dt = local_datetime(ms, tz);
    dt.hour() * 60 + dt.minute()
}

/// 账期起止时间（毫秒，左闭右开），按本地时区对齐到 1 号 00:00。
///
/// 用于 CDT 查询的 `StartTime` / `EndTime` 兜底参数：某些接口要求
/// ISO8601 区间而不是账期字符串。
pub fn month_bounds_ms(ms: i64, tz: &str) -> (i64, i64) {
    let dt = local_datetime(ms, tz);
    let offset_ms = utc_offset_minutes(tz) as i64 * 60_000;
    let (year, month) = (dt.year(), dt.month());
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let start_local = chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|naive| naive.and_utc().timestamp_millis())
        .unwrap_or(0);
    let end_local = chrono::NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|naive| naive.and_utc().timestamp_millis())
        .unwrap_or(start_local);
    (start_local - offset_ms, end_local - offset_ms)
}

/// 本地时间的 `HH:MM` 文本。
pub fn local_hhmm(ms: i64, tz: &str) -> String {
    let dt = local_datetime(ms, tz);
    format!("{:02}:{:02}", dt.hour(), dt.minute())
}

/// 便于日志阅读的本地时间字符串。
pub fn format_local_timestamp(ms: i64, tz: &str) -> String {
    local_datetime(ms, tz)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// 解析 `HH:MM` 为当日分钟数；非法输入返回 `None`。
pub fn parse_hhmm(value: &str) -> Option<u32> {
    let trimmed = value.trim();
    let mut parts = trimmed.split(':');
    let hour: u32 = parts.next()?.trim().parse().ok()?;
    let minute: u32 = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() || hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

/// 分钟数 -> `HH:MM`。
pub fn minutes_to_hhmm(minutes: u32) -> String {
    format!("{:02}:{:02}", (minutes / 60) % 24, minutes % 60)
}

/// 判断当前本地时间是否落在 `target` 分钟之后 `window` 分钟的短窗口内。
/// Cron 每 5 分钟触发一次，窗口用于兜住边缘抖动（不至于整天错过）。
pub fn within_window(now_minutes: u32, target_minutes: u32, window: u32) -> bool {
    now_minutes >= target_minutes && now_minutes < target_minutes.saturating_add(window)
}

// ===========================================================================
// 单位换算
// ===========================================================================

/// GB -> 字节。
pub fn gb_to_bytes(gb: f64) -> i64 {
    if gb <= 0.0 {
        return 0;
    }
    (gb * GIB).round() as i64
}

/// 字节 -> GB。
pub fn bytes_to_gb(bytes: i64) -> f64 {
    bytes.max(0) as f64 / GIB
}

/// 相对配额的百分比（保留两位小数，上限 9999.99）。
pub fn percent_of_limit(bytes: i64, limit_gb: f64) -> f64 {
    let limit_bytes = gb_to_bytes(limit_gb);
    if limit_bytes <= 0 {
        return 0.0;
    }
    let pct = (bytes.max(0) as f64 / limit_bytes as f64) * 100.0;
    ((pct * 100.0).round() / 100.0).clamp(0.0, 9999.99)
}

/// 人类可读的流量文案，例如 `3.42 GiB`。
pub fn human_bytes(bytes: i64) -> String {
    let value = bytes.max(0) as f64;
    if value < 1024.0 {
        return format!("{value:.0} B");
    }
    let units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut scaled = value / 1024.0;
    let mut idx = 0usize;
    while scaled >= 1024.0 && idx + 1 < units.len() {
        scaled /= 1024.0;
        idx += 1;
    }
    format!("{:.2} {}", scaled, units[idx])
}

// ===========================================================================
// 突变检测
// ===========================================================================

/// 判断单次采样是否为异常突变。
///
/// 只对「本次比上次增长超过 `threshold_bytes`」告警，且要求距上次采样足够近：
/// 若上次采样是三天前，增长很大是正常的，不是突变。
pub fn is_traffic_spike(
    previous_bytes: i64,
    current_bytes: i64,
    since_last_ms: i64,
    threshold_bytes: i64,
    max_gap_ms: i64,
) -> bool {
    if previous_bytes < 0 || current_bytes <= previous_bytes {
        return false;
    }
    if since_last_ms <= 0 || since_last_ms > max_gap_ms {
        return false;
    }
    if threshold_bytes <= 0 {
        return false;
    }
    current_bytes - previous_bytes >= threshold_bytes
}

/// 金额文案，例如 `¥ 12.30`。
pub fn human_amount(amount: f64, currency: Option<&str>) -> String {
    let symbol = match currency.unwrap_or("CNY") {
        "USD" => "$",
        "CNY" => "¥",
        other => other,
    };
    format!("{symbol} {amount:.2}")
}

/// 脱敏 AccessKey ID：`LTAI5t****abcd`。
pub fn mask_secret(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "****".to_string();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}****{tail}")
}

// ===========================================================================
// 枚举
// ===========================================================================

/// 账号站点：中国站 / 国际站。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SiteType {
    China,
    Intl,
}

impl SiteType {
    pub fn as_str(self) -> &'static str {
        match self {
            SiteType::China => "china",
            SiteType::Intl => "intl",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SiteType::China => "中国站",
            SiteType::Intl => "国际站",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "intl" => SiteType::Intl,
            _ => SiteType::China,
        }
    }
}

/// 触发阈值后的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverLimitAction {
    /// 停机 + 通知
    StopAndNotify,
    /// 仅通知
    NotifyOnly,
}

impl OverLimitAction {
    pub fn as_str(self) -> &'static str {
        match self {
            OverLimitAction::StopAndNotify => "stop_and_notify",
            OverLimitAction::NotifyOnly => "notify_only",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OverLimitAction::StopAndNotify => "停机并通知",
            OverLimitAction::NotifyOnly => "仅通知",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "notify_only" => OverLimitAction::NotifyOnly,
            _ => OverLimitAction::StopAndNotify,
        }
    }
}

/// 停机模式：节省停机（不收计算资源费）/ 普通停机（保留资源继续计费）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopMode {
    StopCharging,
    KeepCharging,
}

impl StopMode {
    pub fn as_str(self) -> &'static str {
        match self {
            StopMode::StopCharging => "StopCharging",
            StopMode::KeepCharging => "KeepCharging",
        }
    }

    /// 面向界面的中文说明。
    pub fn label(self) -> &'static str {
        match self {
            StopMode::StopCharging => "节省停机",
            StopMode::KeepCharging => "普通停机",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "KeepCharging" => StopMode::KeepCharging,
            _ => StopMode::StopCharging,
        }
    }
}

/// 异步任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running,
    Success,
    Failed,
    /// 前向兼容：数据库里出现了当前代码不认识的状态。
    Unknown,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Pending => "pending",
            JobStatus::Running => "running",
            JobStatus::Success => "success",
            JobStatus::Failed => "failed",
            JobStatus::Unknown => "unknown",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, JobStatus::Success | JobStatus::Failed)
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "pending" => JobStatus::Pending,
            "running" => JobStatus::Running,
            "success" => JobStatus::Success,
            "failed" => JobStatus::Failed,
            _ => JobStatus::Unknown,
        }
    }
}

/// 任务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobType {
    /// 刷新全部账号
    RefreshAll,
    /// 刷新单个账号
    RefreshAccount,
    /// 开机
    StartInstance,
    /// 关机
    StopInstance,
    /// 通知渠道测试
    NotifyTest,
    /// 手动推送日报
    DailyReport,
    /// 未知类型（前向兼容）
    Unknown,
}

impl JobType {
    pub fn as_str(self) -> &'static str {
        match self {
            JobType::RefreshAll => "refresh_all",
            JobType::RefreshAccount => "refresh_account",
            JobType::StartInstance => "start_instance",
            JobType::StopInstance => "stop_instance",
            JobType::NotifyTest => "notify_test",
            JobType::DailyReport => "daily_report",
            JobType::Unknown => "unknown",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "refresh_all" => JobType::RefreshAll,
            "refresh_account" => JobType::RefreshAccount,
            "start_instance" => JobType::StartInstance,
            "stop_instance" => JobType::StopInstance,
            "notify_test" => JobType::NotifyTest,
            "daily_report" => JobType::DailyReport,
            _ => JobType::Unknown,
        }
    }
}

/// Bark 推送级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PushLevel {
    Active,
    TimeSensitive,
    Critical,
}

impl PushLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            PushLevel::Active => "active",
            PushLevel::TimeSensitive => "timeSensitive",
            PushLevel::Critical => "critical",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "timeSensitive" => PushLevel::TimeSensitive,
            "critical" => PushLevel::Critical,
            _ => PushLevel::Active,
        }
    }
}

/// 通知渠道。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyChannel {
    Telegram,
    Bark,
}

/// 流量历史图表的时间粒度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryBucket {
    Hour,
    Day,
}

impl HistoryBucket {
    /// 桶宽度（毫秒）。
    pub fn width_ms(self) -> i64 {
        match self {
            HistoryBucket::Hour => 3_600_000,
            HistoryBucket::Day => 86_400_000,
        }
    }

    /// 默认回溯窗口（毫秒）。
    pub fn default_span_ms(self) -> i64 {
        match self {
            HistoryBucket::Hour => 48 * 3_600_000,
            HistoryBucket::Day => 30 * 86_400_000,
        }
    }

    /// 默认桶数量上限。
    pub fn default_limit(self) -> u32 {
        match self {
            HistoryBucket::Hour => 48,
            HistoryBucket::Day => 30,
        }
    }

    pub fn from_query(value: &str) -> Self {
        match value {
            "day" | "daily" => HistoryBucket::Day,
            _ => HistoryBucket::Hour,
        }
    }
}

// ===========================================================================
// D1 实体行
// ===========================================================================

/// `accounts` 表行。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AccountRow {
    pub id: i64,
    pub name: String,
    pub site_type: String,
    pub access_key_id: String,
    pub encrypted_access_key_secret: String,
    pub regions_json: String,
    pub traffic_limit_gb: f64,
    /// 突变告警阈值（GB）；`None` 表示使用全局默认值。
    pub spike_threshold_gb: Option<f64>,
    pub over_limit_action: String,
    pub stop_mode: String,
    pub schedule_start_time: Option<String>,
    pub schedule_stop_time: Option<String>,
    pub spot_keep_alive: i64,
    pub enabled: i64,
    pub last_schedule_start_date: Option<String>,
    pub last_schedule_stop_date: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AccountRow {
    pub fn site(&self) -> SiteType {
        SiteType::from_db(&self.site_type)
    }

    pub fn action(&self) -> OverLimitAction {
        OverLimitAction::from_db(&self.over_limit_action)
    }

    pub fn stop_mode(&self) -> StopMode {
        StopMode::from_db(&self.stop_mode)
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled != 0
    }

    pub fn is_spot_keep_alive(&self) -> bool {
        self.spot_keep_alive != 0
    }

    /// 账号配置的地域列表；为空时回退到默认地域。
    pub fn regions(&self) -> Vec<String> {
        let parsed: Vec<String> = serde_json::from_str(&self.regions_json).unwrap_or_default();
        let cleaned: Vec<String> = parsed
            .into_iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        if cleaned.is_empty() {
            DEFAULT_REGIONS.iter().map(|r| r.to_string()).collect()
        } else {
            cleaned
        }
    }

    pub fn schedule_start_minutes(&self) -> Option<u32> {
        self.schedule_start_time.as_deref().and_then(parse_hhmm)
    }

    pub fn schedule_stop_minutes(&self) -> Option<u32> {
        self.schedule_stop_time.as_deref().and_then(parse_hhmm)
    }

    /// 界面展示用的账号 DTO（不含任何密文）。
    pub fn to_dto(&self) -> AccountDto {
        AccountDto {
            id: self.id,
            name: self.name.clone(),
            site_type: self.site(),
            site_label: self.site().label().to_string(),
            access_key_id: self.access_key_id.clone(),
            access_key_id_masked: mask_secret(&self.access_key_id),
            regions: self.regions(),
            traffic_limit_gb: self.traffic_limit_gb,
            spike_threshold_gb: self.spike_threshold_gb,
            over_limit_action: self.action(),
            over_limit_action_label: self.action().label().to_string(),
            stop_mode: self.stop_mode(),
            stop_mode_label: self.stop_mode().label().to_string(),
            schedule_start_time: self.schedule_start_time.clone(),
            schedule_stop_time: self.schedule_stop_time.clone(),
            spot_keep_alive: self.is_spot_keep_alive(),
            enabled: self.is_enabled(),
            last_schedule_start_date: self.last_schedule_start_date.clone(),
            last_schedule_stop_date: self.last_schedule_stop_date.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// `account_snapshots` 表行。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SnapshotRow {
    pub account_id: i64,
    pub balance_amount: Option<f64>,
    pub balance_currency: Option<String>,
    pub cdt_domestic_bytes: i64,
    pub cdt_overseas_bytes: i64,
    pub billing_month: String,
    pub instances_json: String,
    pub threshold_triggered_month: Option<String>,
    pub updated_at: i64,
}

impl SnapshotRow {
    pub fn instances(&self) -> Vec<InstanceInfo> {
        serde_json::from_str(&self.instances_json).unwrap_or_default()
    }

    pub fn total_bytes(&self) -> i64 {
        self.cdt_domestic_bytes.max(0) + self.cdt_overseas_bytes.max(0)
    }

    /// 本月是否已经触发过流量熔断。
    pub fn threshold_triggered(&self, month: &str) -> bool {
        match self.threshold_triggered_month.as_deref() {
            Some(value) => !value.is_empty() && value == month,
            None => false,
        }
    }
}

/// ECS 实例信息（快照 `instances_json` 的元素，也是后端返回给前端的结构）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub instance_id: String,
    #[serde(default)]
    pub instance_name: String,
    #[serde(default)]
    pub instance_type: String,
    #[serde(default)]
    pub region_id: String,
    #[serde(default)]
    pub zone_id: String,
    /// `Running` / `Stopped` / `Starting` / `Stopping` 等阿里云原始状态。
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub public_ip: Option<String>,
    #[serde(default)]
    pub private_ip: Option<String>,
    /// `PrePaid` / `PostPaid`
    #[serde(default)]
    pub instance_charge_type: Option<String>,
    /// 阿里云原始 `SpotStrategy`：`NoSpot` / `SpotWithPriceLimit` / `SpotAsPriceGo`
    #[serde(default)]
    pub spot_strategy: Option<String>,
    #[serde(default)]
    pub stopped_mode: Option<String>,
    #[serde(default)]
    pub os_name: Option<String>,
    #[serde(default)]
    pub creation_time: Option<String>,
    #[serde(default)]
    pub expired_time: Option<String>,
    /// 是否为抢占式实例。
    #[serde(default)]
    pub spot: bool,
    /// 抢占式保活开关（逐实例），账号级 `spot_keep_alive` 为总闸。
    #[serde(default)]
    pub keep_alive: bool,
}

impl InstanceInfo {
    pub fn is_running(&self) -> bool {
        self.status.eq_ignore_ascii_case("Running")
    }

    pub fn is_stopped(&self) -> bool {
        self.status.eq_ignore_ascii_case("Stopped")
    }

    /// 抢占式实例的可保活判断：必须是抢占式 + 已打开逐实例开关 + 当前处于运行态。
    pub fn keep_alive_active(&self, account_master_switch: bool) -> bool {
        self.spot && self.keep_alive && account_master_switch
    }
}

/// 写快照的入参（不含 `threshold_triggered_month`：熔断账期由专门语句维护，
/// 避免普通刷新把熔断标记覆盖掉）。
#[derive(Debug, Clone)]
pub struct SnapshotUpdate {
    pub account_id: i64,
    pub balance_amount: Option<f64>,
    pub balance_currency: Option<String>,
    pub cdt_domestic_bytes: i64,
    pub cdt_overseas_bytes: i64,
    pub billing_month: String,
    pub instances: Vec<InstanceInfo>,
    pub updated_at: i64,
}

/// `traffic_history` 表里的一个采样点（图表里的一个桶）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficPoint {
    /// 桶起始时间（Unix 毫秒）。
    pub recorded_at: i64,
    pub domestic_bytes: i64,
    pub overseas_bytes: i64,
    pub total_bytes: i64,
}

/// `jobs` 表行。
#[derive(Debug, Clone, Deserialize)]
pub struct JobRow {
    pub id: String,
    pub account_id: Option<i64>,
    pub job_type: String,
    pub status: String,
    pub error_msg: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

impl JobRow {
    pub fn to_dto(&self) -> JobDto {
        JobDto {
            id: self.id.clone(),
            account_id: self.account_id,
            job_type: JobType::from_db(&self.job_type),
            status: JobStatus::from_db(&self.status),
            error_msg: self.error_msg.clone(),
            created_at: self.created_at,
            finished_at: self.finished_at,
        }
    }
}

/// `sessions` 表行（登录设备）。
#[derive(Debug, Clone, Deserialize)]
pub struct SessionRow {
    pub sid: String,
    pub ua: String,
    pub ip: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
}

impl SessionRow {
    /// 转 DTO；`current` 标记当前请求所属会话。
    pub fn to_dto(&self, current_sid: Option<&str>) -> SessionDto {
        SessionDto {
            sid: self.sid.clone(),
            ua: self.ua.clone(),
            ip: self.ip.clone(),
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            expires_at: self.expires_at,
            current: current_sid == Some(self.sid.as_str()),
        }
    }
}

/// 登录设备（脱敏：不下发 sid 之外的任何凭据材料）。
#[derive(Debug, Clone, Serialize)]
pub struct SessionDto {
    pub sid: String,
    pub ua: String,
    pub ip: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
    /// 是否为发起本次请求的设备。
    pub current: bool,
}

/// 登录设备列表响应。
#[derive(Debug, Clone, Serialize)]
pub struct SessionsResponse {
    pub sessions: Vec<SessionDto>,
}

/// 操作日志查询条件。
#[derive(Debug, Clone, Default)]
pub struct LogFilter {
    pub account_id: Option<i64>,
    /// 动作类型前缀，例如 `login` 命中 `login_success` / `login_failed`。
    pub action_prefix: Option<String>,
    /// 明细关键字（SQL LIKE，区分大小写）。
    pub keyword: Option<String>,
    pub limit: u32,
}

/// `action_logs` 表行（带账号名，便于界面直接展示）。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ActionLog {
    pub id: i64,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
    pub action_type: String,
    pub instance_id: Option<String>,
    pub detail: String,
    pub created_at: i64,
}

// ===========================================================================
// settings 表里的 JSON 配置（密文形式，仅供后端使用）
// ===========================================================================

/// Telegram 配置。`token_enc` 为 XChaCha20Poly1305 密文。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelegramConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub token_enc: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
}

/// Bark 配置。`device_key_enc` 为 XChaCha20Poly1305 密文。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarkConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_bark_server")]
    pub server_url: String,
    #[serde(default)]
    pub device_key_enc: Option<String>,
    /// 普通通知级别。
    #[serde(default = "default_normal_level")]
    pub normal_level: PushLevel,
    /// 熔断告警级别。
    #[serde(default = "default_alert_level")]
    pub alert_level: PushLevel,
}

fn default_bark_server() -> String {
    "https://api.day.app".to_string()
}

fn default_normal_level() -> PushLevel {
    PushLevel::Active
}

fn default_alert_level() -> PushLevel {
    PushLevel::Critical
}

impl Default for BarkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server_url: default_bark_server(),
            device_key_enc: None,
            normal_level: default_normal_level(),
            alert_level: default_alert_level(),
        }
    }
}

/// Turnstile 配置。`secret_enc` 为 XChaCha20Poly1305 密文，不出库。
///
/// 未配置时不校验人机，登录仅校验用户名与密码。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TurnstileConfig {
    /// 是否启用。只有 site_key 与 secret 都填了才可能为 true。
    #[serde(default)]
    pub enabled: bool,
    /// 站点公钥，明文存储（本来就会下发到浏览器）。
    #[serde(default)]
    pub site_key: Option<String>,
    /// 私钥密文。
    #[serde(default)]
    pub secret_enc: Option<String>,
}

impl TurnstileConfig {
    /// 公钥与私钥是否都已填写（非空、去空白后）。
    pub fn is_complete(&self) -> bool {
        let has_site = self
            .site_key
            .as_deref()
            .map(str::trim)
            .is_some_and(|v| !v.is_empty());
        let has_secret = self
            .secret_enc
            .as_deref()
            .map(str::trim)
            .is_some_and(|v| !v.is_empty());
        has_site && has_secret
    }
}

/// 高级配置。存 D1，后台可改，不需要重新部署。
///
/// 这些是"调优参数"而非机密：日志级别、任务锁窗口、会话有效期。
/// 放环境变量会导致改一个数字就要重新部署，因此挪到设置表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedConfig {
    /// 日志级别：error / warn / info / debug。
    #[serde(default = "default_log_level")]
    pub log_level: String,
    /// 刷新任务互斥窗口（毫秒）。
    #[serde(default = "default_job_lock_ttl")]
    pub job_lock_ttl_ms: i64,
    /// 会话有效期（毫秒）。
    #[serde(default = "default_session_ttl")]
    pub session_ttl_ms: i64,
}

fn default_log_level() -> String {
    "error".to_string()
}

fn default_job_lock_ttl() -> i64 {
    10 * 60 * 1000
}

fn default_session_ttl() -> i64 {
    7 * 24 * 60 * 60 * 1000
}

impl Default for AdvancedConfig {
    fn default() -> Self {
        Self {
            log_level: default_log_level(),
            job_lock_ttl_ms: default_job_lock_ttl(),
            session_ttl_ms: default_session_ttl(),
        }
    }
}

impl AdvancedConfig {
    /// 归一化：限制取值范围，避免后台填出离谱的值。
    pub fn normalized(mut self) -> Self {
        self.log_level = match self.log_level.trim().to_ascii_lowercase().as_str() {
            "warn" => "warn".to_string(),
            "info" => "info".to_string(),
            "debug" => "debug".to_string(),
            _ => "error".to_string(),
        };
        self.job_lock_ttl_ms = self.job_lock_ttl_ms.clamp(30_000, 60 * 60 * 1000);
        self.session_ttl_ms = self.session_ttl_ms.clamp(60_000, 30 * 24 * 60 * 60 * 1000);
        self
    }
}

/// 日报配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyReportConfig {
    #[serde(default)]
    pub enabled: bool,
    /// `HH:MM`（本地时区），空表示不推送。
    #[serde(default = "default_report_time")]
    pub time: String,
    #[serde(default = "default_report_timezone")]
    pub timezone: String,
    /// 最近一次推送日期 `YYYY-MM-DD`，用于幂等。
    #[serde(default)]
    pub last_sent_date: Option<String>,
}

fn default_report_time() -> String {
    "09:00".to_string()
}

fn default_report_timezone() -> String {
    "UTC+8".to_string()
}

impl Default for DailyReportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            time: default_report_time(),
            timezone: default_report_timezone(),
            last_sent_date: None,
        }
    }
}

// ===========================================================================
// 前后端 DTO
// ===========================================================================

/// 统一的错误响应体。
#[derive(Debug, Clone, Serialize)]
pub struct ApiErrorBody {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl ApiErrorBody {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            code: None,
        }
    }

    pub fn with_code(error: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            code: Some(code.into()),
        }
    }
}

/// 登录请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct LoginRequest {
    /// 管理员用户名。必填 —— 缺失时 serde 直接报错，返回 400。
    pub username: String,
    pub password: String,
    /// Turnstile 前端小组件产出的 token。
    #[serde(default)]
    pub turnstile_token: String,
}

/// 未认证 / 已认证探测响应。
#[derive(Debug, Clone, Serialize)]
pub struct SessionResponse {
    pub authenticated: bool,
    pub turnstile_site_key: String,
    /// Cookie 的过期时间（毫秒），未认证时为 `None`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// 202 Accepted 响应体：前端据此轮询 `/api/v1/jobs/{job_id}`。
#[derive(Debug, Clone, Serialize)]
pub struct AcceptedJob {
    pub job_id: String,
    pub status: JobStatus,
    pub job_type: JobType,
}

/// 账号 DTO（设置面板用，绝不含密文）。
#[derive(Debug, Clone, Serialize)]
pub struct AccountDto {
    pub id: i64,
    pub name: String,
    pub site_type: SiteType,
    pub site_label: String,
    pub access_key_id: String,
    pub access_key_id_masked: String,
    pub regions: Vec<String>,
    pub traffic_limit_gb: f64,
    /// 突变告警阈值（GB）；`None` 表示使用默认值。
    pub spike_threshold_gb: Option<f64>,
    pub over_limit_action: OverLimitAction,
    pub over_limit_action_label: String,
    pub stop_mode: StopMode,
    pub stop_mode_label: String,
    pub schedule_start_time: Option<String>,
    pub schedule_stop_time: Option<String>,
    pub spot_keep_alive: bool,
    pub enabled: bool,
    pub last_schedule_start_date: Option<String>,
    pub last_schedule_stop_date: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 账号新增 / 修改请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct AccountInput {
    pub name: String,
    pub site_type: SiteType,
    pub access_key_id: String,
    /// 修改时留空表示沿用原密钥。
    #[serde(default)]
    pub access_key_secret: Option<String>,
    #[serde(default)]
    pub regions: Vec<String>,
    pub traffic_limit_gb: f64,
    /// 突变告警阈值（GB）；省略或 `null` 用默认值，0 表示关闭。
    #[serde(default)]
    pub spike_threshold_gb: Option<f64>,
    pub over_limit_action: OverLimitAction,
    pub stop_mode: StopMode,
    #[serde(default)]
    pub schedule_start_time: Option<String>,
    #[serde(default)]
    pub schedule_stop_time: Option<String>,
    #[serde(default)]
    pub spot_keep_alive: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

impl AccountInput {
    /// 归一化后的地域列表（去空白、去重、保序）。
    pub fn normalized_regions(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for region in &self.regions {
            let trimmed = region.trim();
            if trimmed.is_empty() || out.iter().any(|r| r == trimmed) {
                continue;
            }
            out.push(trimmed.to_string());
        }
        out
    }

    pub fn regions_json(&self) -> String {
        serde_json::to_string(&self.normalized_regions()).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn schedule_start_minutes(&self) -> Option<u32> {
        self.schedule_start_time.as_deref().and_then(parse_hhmm)
    }

    pub fn schedule_stop_minutes(&self) -> Option<u32> {
        self.schedule_stop_time.as_deref().and_then(parse_hhmm)
    }

    pub fn normalized_schedule_start(&self) -> Option<String> {
        self.schedule_start_minutes().map(minutes_to_hhmm)
    }

    pub fn normalized_schedule_stop(&self) -> Option<String> {
        self.schedule_stop_minutes().map(minutes_to_hhmm)
    }

    /// 字段校验；返回 `Err(中文提示)` 由路由层转成 400。
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("账号名称不能为空".to_string());
        }
        if self.access_key_id.trim().len() < 8 {
            return Err("AccessKey ID 不合法".to_string());
        }
        if !self.traffic_limit_gb.is_finite() || self.traffic_limit_gb <= 0.0 {
            return Err("流量阈值必须大于 0".to_string());
        }
        if let Some(time) = self.schedule_start_time.as_deref()
            && !time.trim().is_empty()
            && parse_hhmm(time).is_none()
        {
            return Err("定时开机时间格式应为 HH:MM".to_string());
        }
        if let Some(time) = self.schedule_stop_time.as_deref()
            && !time.trim().is_empty()
            && parse_hhmm(time).is_none()
        {
            return Err("定时关机时间格式应为 HH:MM".to_string());
        }
        Ok(())
    }
}

/// 首页账号卡片 + 实例列表。
#[derive(Debug, Clone, Serialize)]
pub struct AccountOverview {
    pub id: i64,
    pub name: String,
    pub site_type: SiteType,
    pub site_label: String,
    pub access_key_id_masked: String,
    pub traffic_limit_gb: f64,
    pub over_limit_action: OverLimitAction,
    pub over_limit_action_label: String,
    pub stop_mode: StopMode,
    pub stop_mode_label: String,
    pub schedule_start_time: Option<String>,
    pub schedule_stop_time: Option<String>,
    pub spot_keep_alive: bool,
    pub enabled: bool,
    pub balance_amount: Option<f64>,
    pub balance_currency: Option<String>,
    pub cdt_domestic_bytes: i64,
    pub cdt_overseas_bytes: i64,
    pub cdt_total_bytes: i64,
    pub domestic_percent: f64,
    pub overseas_percent: f64,
    pub total_percent: f64,
    pub billing_month: String,
    /// 本月是否已触发流量熔断（熔断后禁止任何自动/手动开机）。
    pub threshold_triggered: bool,
    pub snapshot_updated_at: Option<i64>,
    pub instances: Vec<InstanceInfo>,
}

/// 首页整体响应。
#[derive(Debug, Clone, Serialize)]
pub struct OverviewResponse {
    pub accounts: Vec<AccountOverview>,
    pub timezone: String,
    pub billing_month: String,
    pub generated_at: i64,
}

/// 任务状态 DTO。
#[derive(Debug, Clone, Serialize)]
pub struct JobDto {
    pub id: String,
    pub account_id: Option<i64>,
    pub job_type: JobType,
    pub status: JobStatus,
    pub error_msg: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

/// 流量历史响应。
#[derive(Debug, Clone, Serialize)]
pub struct TrafficHistoryResponse {
    pub account_id: i64,
    pub bucket: HistoryBucket,
    pub traffic_limit_gb: f64,
    pub billing_month: String,
    /// 是否已超过阈值（前端用于图表提示线）。
    pub threshold_triggered: bool,
    pub points: Vec<TrafficPoint>,
}

/// 图表查询参数（从 URL query 解析而来）。
#[derive(Debug, Clone)]
pub struct HistoryQuery {
    pub account_id: Option<i64>,
    pub bucket: HistoryBucket,
    pub limit: u32,
}

// --------------------------- 设置相关 DTO ---------------------------------

/// Telegram 设置（脱敏）。
#[derive(Debug, Clone, Serialize)]
pub struct TelegramSettingsDto {
    pub enabled: bool,
    pub chat_id: Option<String>,
    pub token_configured: bool,
}

/// Telegram 设置更新请求；`token` 留空表示保持原值。
#[derive(Debug, Clone, Deserialize)]
pub struct TelegramSettingsUpdate {
    pub enabled: bool,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

/// Bark 设置（脱敏）。
#[derive(Debug, Clone, Serialize)]
pub struct BarkSettingsDto {
    pub enabled: bool,
    pub server_url: String,
    pub device_key_configured: bool,
    pub normal_level: PushLevel,
    pub alert_level: PushLevel,
}

/// Bark 设置更新请求；`device_key` 留空表示保持原值。
#[derive(Debug, Clone, Deserialize)]
pub struct BarkSettingsUpdate {
    pub enabled: bool,
    #[serde(default = "default_bark_server")]
    pub server_url: String,
    #[serde(default)]
    pub device_key: Option<String>,
    #[serde(default = "default_normal_level")]
    pub normal_level: PushLevel,
    #[serde(default = "default_alert_level")]
    pub alert_level: PushLevel,
}

/// 高级配置 DTO（后台可改）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedSettingsDto {
    pub log_level: String,
    pub job_lock_ttl_ms: i64,
    pub session_ttl_ms: i64,
}

impl From<&AdvancedConfig> for AdvancedSettingsDto {
    fn from(config: &AdvancedConfig) -> Self {
        Self {
            log_level: config.log_level.clone(),
            job_lock_ttl_ms: config.job_lock_ttl_ms,
            session_ttl_ms: config.session_ttl_ms,
        }
    }
}

impl From<&AdvancedSettingsDto> for AdvancedConfig {
    fn from(dto: &AdvancedSettingsDto) -> Self {
        AdvancedConfig {
            log_level: dto.log_level.clone(),
            job_lock_ttl_ms: dto.job_lock_ttl_ms,
            session_ttl_ms: dto.session_ttl_ms,
        }
        .normalized()
    }
}

/// 时区下拉项。
#[derive(Debug, Clone, Serialize)]
pub struct TimeZoneOption {
    pub value: String,
    pub label: String,
}

/// 时区下拉项全集。
pub fn timezone_options() -> Vec<TimeZoneOption> {
    TIMEZONE_OPTIONS
        .iter()
        .map(|(value, label)| TimeZoneOption {
            value: value.to_string(),
            label: label.to_string(),
        })
        .collect()
}

/// Turnstile 设置（脱敏：私钥只回 `secret_configured`）。
#[derive(Debug, Clone, Serialize)]
pub struct TurnstileSettingsDto {
    pub enabled: bool,
    pub site_key: String,
    pub secret_configured: bool,
}

/// Turnstile 设置更新请求。
///
/// `site_key` / `secret_key` 留空表示**保持原值**。
/// 想关闭人机校验，传 `enabled: false` 即可，无需清空密钥。
#[derive(Debug, Clone, Deserialize)]
pub struct TurnstileSettingsUpdate {
    pub enabled: bool,
    #[serde(default)]
    pub site_key: Option<String>,
    #[serde(default)]
    pub secret_key: Option<String>,
}

/// 日报设置 DTO / 更新请求共用（`enabled` + `HH:MM`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyReportDto {
    pub enabled: bool,
    pub time: String,
    pub timezone: String,
}

/// 全量设置响应。
#[derive(Debug, Clone, Serialize)]
pub struct SettingsDto {
    pub timezone: String,
    /// 可选时区（value, label），供界面下拉使用。
    pub timezone_options: Vec<TimeZoneOption>,
    pub advanced: AdvancedSettingsDto,
    pub turnstile: TurnstileSettingsDto,
    pub telegram: TelegramSettingsDto,
    pub bark: BarkSettingsDto,
    pub daily_report: DailyReportDto,
    pub accounts: Vec<AccountDto>,
}

/// 通知渠道测试请求。
#[derive(Debug, Clone, Deserialize)]
pub struct NotifyTestRequest {
    pub channel: NotifyChannel,
}

/// 实例动作请求（可选指定地域；缺省时从快照推断）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct InstanceActionRequest {
    #[serde(default)]
    pub region_id: Option<String>,
}

/// 逐实例抢占式保活开关。
#[derive(Debug, Clone, Deserialize)]
pub struct KeepAliveRequest {
    pub enabled: bool,
}

// ===========================================================================
// 组合工具
// ===========================================================================

/// 由账号行 + 快照行拼出首页卡片数据。
pub fn build_overview(
    account: &AccountRow,
    snapshot: Option<&SnapshotRow>,
    timezone: &str,
    now: i64,
) -> AccountOverview {
    let month = billing_month(now, timezone);
    let (
        domestic,
        overseas,
        total,
        balance_amount,
        balance_currency,
        updated_at,
        triggered,
        instances,
    ) = match snapshot {
        Some(snap) => (
            snap.cdt_domestic_bytes.max(0),
            snap.cdt_overseas_bytes.max(0),
            snap.total_bytes(),
            snap.balance_amount,
            snap.balance_currency.clone(),
            Some(snap.updated_at),
            snap.threshold_triggered(&month),
            snap.instances(),
        ),
        None => (0, 0, 0, None, None, None, false, Vec::new()),
    };

    AccountOverview {
        id: account.id,
        name: account.name.clone(),
        site_type: account.site(),
        site_label: account.site().label().to_string(),
        access_key_id_masked: mask_secret(&account.access_key_id),
        traffic_limit_gb: account.traffic_limit_gb,
        over_limit_action: account.action(),
        over_limit_action_label: account.action().label().to_string(),
        stop_mode: account.stop_mode(),
        stop_mode_label: account.stop_mode().label().to_string(),
        schedule_start_time: account.schedule_start_time.clone(),
        schedule_stop_time: account.schedule_stop_time.clone(),
        spot_keep_alive: account.is_spot_keep_alive(),
        enabled: account.is_enabled(),
        balance_amount,
        balance_currency,
        cdt_domestic_bytes: domestic,
        cdt_overseas_bytes: overseas,
        cdt_total_bytes: total,
        domestic_percent: percent_of_limit(domestic, account.traffic_limit_gb),
        overseas_percent: percent_of_limit(overseas, account.traffic_limit_gb),
        total_percent: percent_of_limit(total, account.traffic_limit_gb),
        billing_month: month,
        threshold_triggered: triggered,
        snapshot_updated_at: updated_at,
        instances,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_offset() {
        assert_eq!(utc_offset_minutes("UTC+8"), 480);
        assert_eq!(utc_offset_minutes("utc-05:30"), -330);
        assert_eq!(utc_offset_minutes("GMT+8:00"), 480);
        assert_eq!(utc_offset_minutes(""), 0);
        assert_eq!(utc_offset_minutes("+9"), 540);
    }

    #[test]
    fn timezone_options_are_parseable() {
        // 下拉里的每个取值都必须能被解析器正确理解，
        // 否则选中后行为会静默退回 UTC。
        for (value, _label) in TIMEZONE_OPTIONS {
            let minutes = utc_offset_minutes(value);
            let expected: i32 = {
                let body = value.trim_start_matches("UTC");
                let (sign, rest) = match body.chars().next() {
                    Some('-') => (-1, &body[1..]),
                    Some('+') => (1, &body[1..]),
                    _ => (1, body),
                };
                let mut parts = rest.split(':');
                let h: i32 = parts.next().unwrap().parse().unwrap();
                let m: i32 = parts.next().map(|v| v.parse().unwrap()).unwrap_or(0);
                sign * (h * 60 + m)
            };
            assert_eq!(minutes, expected, "{value} 解析不一致");
        }
    }

    #[test]
    fn default_timezone_is_supported() {
        assert!(is_supported_timezone(DEFAULT_TIMEZONE));
        assert!(is_supported_timezone("UTC+8"));
        assert!(is_supported_timezone("UTC+5:30"));
        assert!(!is_supported_timezone("UTC+8:15"), "非白名单取值应被拒绝");
        assert!(!is_supported_timezone("Asia/Shanghai"), "不支持 IANA 名称");
        assert!(!is_supported_timezone(""));
    }

    #[test]
    fn spike_detection() {
        let gb = gb_to_bytes(1.0);
        let one_hour = 60 * 60 * 1000;
        // 一小时内涨了 2 GiB，阈值 1 GiB → 是突变
        assert!(is_traffic_spike(gb, gb * 3, one_hour, gb, 2 * one_hour));
        // 涨得不够多 → 不算
        assert!(!is_traffic_spike(
            gb,
            gb + gb / 2,
            one_hour,
            gb,
            2 * one_hour
        ));
        // 时间跨度太长 → 正常增长，不算突变
        assert!(!is_traffic_spike(
            gb,
            gb * 10,
            48 * one_hour,
            gb,
            2 * one_hour
        ));
        // 流量下降（账期重置）→ 不算
        assert!(!is_traffic_spike(gb * 5, gb, one_hour, gb, 2 * one_hour));
        // 阈值 <= 0 → 关闭
        assert!(!is_traffic_spike(gb, gb * 100, one_hour, 0, 2 * one_hour));
    }

    #[test]
    fn hhmm_roundtrip() {
        assert_eq!(parse_hhmm("08:30"), Some(510));
        assert_eq!(parse_hhmm("8:3"), Some(483));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(minutes_to_hhmm(510), "08:30");
    }

    #[test]
    fn billing_month_uses_local_midnight() {
        // 2026-10-31T15:59:00Z = 2026-10-31 23:59 (UTC+8)
        assert_eq!(billing_month(1_793_462_340_000, "UTC+8"), "2026-10");
        // 2026-10-31T16:00:00Z = 2026-11-01 00:00 (UTC+8) -> 新账期
        assert_eq!(billing_month(1_793_462_400_000, "UTC+8"), "2026-11");
        // 同一时刻在 UTC 下仍是 10 月
        assert_eq!(billing_month(1_793_462_400_000, "UTC"), "2026-10");
    }

    #[test]
    fn month_bounds_align_to_local_first_day() {
        // 2026-10-26T15:46:40Z = 2026-10-26 23:46 (UTC+8)
        let now = 1_793_029_600_000;
        let (start, end) = month_bounds_ms(now, "UTC+8");
        // 本地 2026-10-01 00:00 == 2026-09-30T16:00Z
        assert_eq!(
            local_datetime(start, "UTC+8")
                .format("%Y-%m-%d %H:%M")
                .to_string(),
            "2026-10-01 00:00"
        );
        assert_eq!(
            local_datetime(end, "UTC+8")
                .format("%Y-%m-%d %H:%M")
                .to_string(),
            "2026-11-01 00:00"
        );
        assert!(start < now && now < end);
    }

    #[test]
    fn month_bounds_december_rolls_year() {
        let now = 1_798_000_000_000; // 2026-12-23 前后
        let (start, end) = month_bounds_ms(now, "UTC+8");
        assert_eq!(
            local_datetime(start, "UTC+8").format("%Y-%m").to_string(),
            "2026-12"
        );
        assert_eq!(
            local_datetime(end, "UTC+8").format("%Y-%m").to_string(),
            "2027-01"
        );
    }

    #[test]
    fn local_date_and_hhmm() {
        // 2026-10-26T15:46:40Z = 2026-10-26 23:46 (UTC+8)
        let ms = 1_793_029_600_000;
        assert_eq!(local_date(ms, "UTC+8"), "2026-10-26");
        assert_eq!(local_hhmm(ms, "UTC+8"), "23:46");
        assert_eq!(local_date(ms, "UTC"), "2026-10-26");
        assert_eq!(local_hhmm(ms, "UTC"), "15:46");
        assert_eq!(local_minutes_of_day(ms, "UTC+8"), 23 * 60 + 46);
        assert_eq!(local_minutes_of_day(ms, "UTC"), 15 * 60 + 46);
    }

    #[test]
    fn within_window_semantics() {
        // 目标 10:00，窗口 20 分钟 -> [10:00, 10:20)
        assert!(!within_window(9 * 60 + 59, 10 * 60, 20));
        assert!(within_window(10 * 60, 10 * 60, 20));
        assert!(within_window(10 * 60 + 19, 10 * 60, 20));
        assert!(!within_window(10 * 60 + 20, 10 * 60, 20));
    }

    #[test]
    fn percent_math() {
        assert_eq!(percent_of_limit(gb_to_bytes(10.0), 20.0), 50.0);
        assert_eq!(percent_of_limit(0, 20.0), 0.0);
        assert_eq!(percent_of_limit(10, 0.0), 0.0);
    }

    #[test]
    fn mask() {
        assert_eq!(mask_secret("LTAI5tAbCdEfGhIj"), "LTAI****GhIj");
        assert_eq!(mask_secret("short"), "****");
    }
}
