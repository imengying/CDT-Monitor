//! # HTTP 请求工具
//!
//! 请求体解析、查询参数读取、同源校验。这些函数与业务无关，
//! 单独成模块便于复用与测试。

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use worker::Request;

/// 读取并反序列化 JSON 请求体。
pub(crate) async fn read_json<T: DeserializeOwned>(req: &mut Request) -> Result<T, String> {
    req.json::<T>()
        .await
        .map_err(|err| format!("请求体不是合法 JSON：{err}"))
}

/// 解析 URL 查询参数（重复键取第一个）。
pub(crate) fn query_map(req: &Request) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Ok(url) = req.url()
        && let Some(query) = url.query()
    {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            out.entry(key.to_string()).or_insert(value.to_string());
        }
    }
    out
}

/// 取查询参数并解析成 `i64`。
pub(crate) fn query_i64(params: &HashMap<String, String>, key: &str) -> Option<i64> {
    params.get(key).and_then(|v| v.trim().parse().ok())
}

/// 取查询参数并解析成 `u32`。
pub(crate) fn query_u32(params: &HashMap<String, String>, key: &str) -> Option<u32> {
    params.get(key).and_then(|v| v.trim().parse().ok())
}

/// 取查询参数原始文本。
pub(crate) fn query_str<'a>(params: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .map(|v| v.as_str())
        .filter(|v| !v.is_empty())
}
