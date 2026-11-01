//! # Cron 表达式调度
//!
//! 进阶模式下的定时开关机用五字段 Cron 表达式（分 时 日 月 周）描述，
//! 比「每日 HH:MM」多出「每周一」「每月 1 号」这类能力。
//!
//! ## 为什么不用 croner 的时区功能
//!
//! 项目里的时区是固定偏移（`UTC+8`），不是 IANA 名称，而 croner 按
//! `chrono::TimeZone` 走。这里统一把「本地时间」当成一个朴素时间轴交给
//! croner：先把真实时刻加上偏移得到本地时间，匹配完再减回去。这样
//! 表达式里的 `0 0 * * *` 就是本地 00:00，与简单模式语义一致。

use chrono::{NaiveDateTime, TimeZone, Utc};
use croner::{Cron, Direction};
use std::str::FromStr;

/// 解析并校验一个五字段 Cron 表达式。
///
/// 返回 `Err` 时附带可直接展示给用户的原因。
pub fn validate(expression: &str) -> Result<(), String> {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return Err("表达式不能为空".to_string());
    }
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "需要 5 个字段（分 时 日 月 周），当前是 {} 个",
            fields.len()
        ));
    }
    Cron::from_str(trimmed).map_err(|e| format!("表达式无法解析：{e}"))?;
    Ok(())
}

/// 表达式是否合法（不产生详细原因）。
pub fn is_valid(expression: &str) -> bool {
    validate(expression).is_ok()
}

/// 计算从 `now_ms` 起的下 `count` 次触发时刻（毫秒时间戳，按 `tz` 本地解释）。
///
/// `count` 会被夹到 1..=10，与界面「未来 5 次」预览一致。
pub fn next_occurrences(expression: &str, tz: &str, now_ms: i64, count: usize) -> Vec<i64> {
    let Ok(cron) = Cron::from_str(expression.trim()) else {
        return Vec::new();
    };
    let offset_ms = crate::models::utc_offset_minutes(tz) as i64 * 60_000;
    let count = count.clamp(1, 10);
    // 本地朴素时间轴上从现在开始往后找
    let local_now = now_ms + offset_ms;
    let Some(start) = Utc.timestamp_millis_opt(local_now).single() else {
        return Vec::new();
    };
    cron.iter_from(start, Direction::Forward)
        .take(count)
        .map(|dt| dt.timestamp_millis() - offset_ms)
        .collect()
}

/// 判断「最近一次触发」是否落在 `now_ms` 往前的 `window_ms` 内。
///
/// 命中时返回那次触发的时刻（毫秒）。窗口比 Cron 间隔宽，是为了让
/// 一次失败（网络抖动、阿里云限流）能在后续几轮里补上；
/// 调用方还需结合「上次已执行时刻」做去重，避免同一触发重复执行。
pub fn last_occurrence_within(
    expression: &str,
    tz: &str,
    now_ms: i64,
    window_ms: i64,
) -> Option<i64> {
    let cron = Cron::from_str(expression.trim()).ok()?;
    let offset_ms = crate::models::utc_offset_minutes(tz) as i64 * 60_000;
    let local_now = now_ms + offset_ms;
    let now = Utc.timestamp_millis_opt(local_now).single()?;
    let previous = cron.find_previous_occurrence(&now, true).ok()?;
    let occurred_ms = previous.timestamp_millis() - offset_ms;
    let elapsed = now_ms - occurred_ms;
    if (0..=window_ms).contains(&elapsed) {
        Some(occurred_ms)
    } else {
        None
    }
}

/// 把表达式描述成人话（「每天 00:00」之类）。解析失败时回退到原串。
pub fn describe(expression: &str) -> String {
    Cron::from_str(expression.trim())
        .map(|cron| cron.describe())
        .unwrap_or_else(|_| expression.trim().to_string())
}

/// 校验时区字符串是否能用于偏移计算。
pub fn validate_timezone(tz: &str) -> bool {
    crate::models::is_supported_timezone(tz)
}

// 让 NaiveDateTime 参与类型推断，避免未使用告警（croner 的泛型需要具体类型）。
#[allow(dead_code)]
fn _assert_naive_is_supported(dt: NaiveDateTime) -> Option<NaiveDateTime> {
    Some(dt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, Timelike};

    /// 构造一个 UTC 毫秒时间戳。
    fn ms(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, h, mi, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn fmt(v: i64) -> String {
        let t = Utc.timestamp_millis_opt(v).unwrap();
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}",
            t.year(),
            t.month(),
            t.day(),
            t.hour(),
            t.minute()
        )
    }

    #[test]
    fn validates_field_count() {
        assert!(validate("0 0 * * *").is_ok());
        assert!(validate("0 0 * *").is_err());
        assert!(validate("0 0 * * * *").is_err());
        assert!(validate("").is_err());
    }

    #[test]
    fn rejects_bad_values() {
        assert!(validate("99 99 * * *").is_err());
        assert!(validate("not a cron").is_err());
    }

    #[test]
    fn daily_midnight_next_occurrences() {
        // UTC+0 下，从 10-25 15:46 起，下一次每天 00:00 是 10-26 00:00
        let start = ms(2026, 10, 25, 15, 46);
        let next = next_occurrences("0 0 * * *", "UTC+0", start, 3);
        assert_eq!(next.len(), 3);
        assert_eq!(fmt(next[0]), "2026-10-26 00:00");
        assert_eq!(fmt(next[1]), "2026-10-27 00:00");
    }

    #[test]
    fn timezone_offset_shifts_occurrence() {
        // 同一个每日 00:00，UTC+8 的本地 00:00 对应 UTC 前一天 16:00
        let start = ms(2026, 10, 25, 15, 46);
        let next = next_occurrences("0 0 * * *", "UTC+8", start, 2);
        assert_eq!(fmt(next[0]), "2026-10-25 16:00");
    }

    #[test]
    fn last_occurrence_hits_inside_window() {
        // 每天 00:00；UTC+0 下 00:05 距上次触发 5 分钟，落在 10 分钟窗口内
        let now = ms(2026, 10, 26, 0, 5);
        let hit = last_occurrence_within("0 0 * * *", "UTC+0", now, 10 * 60_000);
        assert_eq!(hit.map(fmt).as_deref(), Some("2026-10-26 00:00"));

        // 00:20 已经超出 10 分钟窗口
        let late = ms(2026, 10, 26, 0, 20);
        assert!(last_occurrence_within("0 0 * * *", "UTC+0", late, 10 * 60_000).is_none());
    }

    #[test]
    fn high_frequency_expression_has_many_occurrences() {
        // */5 每 5 分钟一次，连续三次应该相差 5 分钟
        let start = ms(2026, 10, 26, 0, 1);
        let next = next_occurrences("*/5 * * * *", "UTC+0", start, 3);
        assert_eq!(fmt(next[0]), "2026-10-26 00:05");
        assert_eq!(fmt(next[1]), "2026-10-26 00:10");
        assert_eq!(fmt(next[2]), "2026-10-26 00:15");
    }

    #[test]
    fn weekly_expression() {
        // 每周一 03:00；2026-10-25 是周日，下一次是 10-26（周一）
        let start = ms(2026, 10, 25, 12, 0);
        let next = next_occurrences("0 3 * * 1", "UTC+0", start, 1);
        assert_eq!(fmt(next[0]), "2026-10-26 03:00");
    }

    #[test]
    fn invalid_expression_yields_nothing() {
        assert!(next_occurrences("bad expr", "UTC+0", ms(2026, 1, 1, 0, 0), 3).is_empty());
        assert!(last_occurrence_within("bad", "UTC+0", ms(2026, 1, 1, 0, 0), 60_000).is_none());
    }
}
