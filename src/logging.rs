//! # 日志
//!
//! **默认关闭**。Worker 的 `console.log` 在 Cloudflare 上会写入 Workers Logs
//! （按写入量计费，且会把业务细节暴露在控制台），对正常运行的巡检来说
//! 属于纯噪音 —— 每 15 分钟一次的 Cron 不该产生几十行日志。
//!
//! 因此这里分三级，默认只有 `error` 会输出：
//!
//! | 级别 | 默认 | 内容 |
//! |---|---|---|
//! | error | ✅ 开 | 真正需要人介入的失败（解密失败、D1 不可用、任务失败） |
//! | warn  | ❌ 关 | 可自愈的异常（单地域查询失败、通知发送失败） |
//! | info  | ❌ 关 | 正常流程轨迹（任务完成、Cron 汇总、保活拉起实例） |
//!
//! 排障时把 Worker 变量 `LOG_LEVEL` 设为 `debug` / `info` / `warn` 即可
//! 打开对应级别（`wrangler.toml` 的 `[vars]` 里默认写的是 `error`）。
//!
//! 注意：这里的 `error` 级别**刻意保留**。把错误也一起关掉会让线上故障
//! 完全不可见，那不是「安静」而是「失明」。

use std::cell::Cell;

/// 日志级别，数值越大越啰嗦。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// 只输出错误。
    Error = 0,
    /// 额外输出可自愈的警告。
    Warn = 1,
    /// 额外输出正常流程。
    Info = 2,
    /// 保留给最细粒度追踪（目前与 Info 同级）。
    Debug = 3,
}

impl Level {
    /// 从 `LOG_LEVEL` 文本解析；无法识别时回落到 `Error`。
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => Level::Debug,
            "info" => Level::Info,
            "warn" | "warning" => Level::Warn,
            // "error" / "off" / 空 / 其它一律只留错误
            _ => Level::Error,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
        }
    }
}

thread_local! {
    /// 当前生效的级别。
    ///
    /// 用 `thread_local` 而不是全局 `AtomicU8`：Wasm 单线程执行，
    /// 但每个请求可能配置不同（本地开发时 `wrangler dev` 会热重载），
    /// thread-local 让「每个 isolate 初始化一次」的语义最直观。
    static CURRENT: Cell<Level> = const { Cell::new(Level::Error) };
}

/// 设置全局级别（Worker 启动时读 `LOG_LEVEL` 调用一次）。
pub fn set_level(level: Level) {
    CURRENT.with(|cell| cell.set(level));
}

/// 读取当前级别。
pub fn level() -> Level {
    CURRENT.with(|cell| cell.get())
}

/// 是否输出指定级别。
pub fn enabled(level: Level) -> bool {
    self::level() >= level
}

/// 按配置值初始化级别。非法值退回 `Error`（默认安静）。
pub fn init_from_config(raw: Option<&str>) {
    set_level(raw.map(Level::parse).unwrap_or(Level::Error));
}

// ===========================================================================
// 宏
// ===========================================================================

/// 错误日志。**始终输出**（受 `error` 级别保护，而 `error` 是默认级别）。
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {{
        if $crate::logging::enabled($crate::logging::Level::Error) {
            ::worker::console_error!($($arg)*);
        }
    }};
}

/// 警告日志。默认关闭。
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {{
        if $crate::logging::enabled($crate::logging::Level::Warn) {
            ::worker::console_warn!($($arg)*);
        }
    }};
}

/// 流程日志。默认关闭。
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {{
        if $crate::logging::enabled($crate::logging::Level::Info) {
            ::worker::console_log!($($arg)*);
        }
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_falls_back_to_error() {
        assert_eq!(Level::parse("debug"), Level::Debug);
        assert_eq!(Level::parse("INFO"), Level::Info);
        assert_eq!(Level::parse(" warn "), Level::Warn);
        assert_eq!(Level::parse("error"), Level::Error);
        // 拼错 / 空值 / 关闭 都回落到 error（不是 info）
        assert_eq!(Level::parse("inf"), Level::Error);
        assert_eq!(Level::parse(""), Level::Error);
        assert_eq!(Level::parse("off"), Level::Error);
    }

    #[test]
    fn ordering_is_cumulative() {
        // info 级别应同时打开 error 与 warn
        assert!(Level::Info >= Level::Error);
        assert!(Level::Info >= Level::Warn);
        // error 级别不应打开 warn
        assert!(Level::Error < Level::Warn);
        assert!(Level::Warn < Level::Info);
    }

    #[test]
    fn as_str_roundtrip() {
        for level in [Level::Error, Level::Warn, Level::Info, Level::Debug] {
            assert_eq!(Level::parse(level.as_str()), level);
        }
    }
}
