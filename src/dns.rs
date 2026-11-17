//! Cloudflare DNS-only A 记录联动。稳定状态不请求 API，TTL 固定 300 秒。
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{Headers, Method, Request, RequestInit, wasm_bindgen::JsValue};

use crate::{crypto::Crypto, models::AccountRow};

pub const TTL: u32 = 300;
pub const TICK_MS: i64 = 5 * 60_000;
fn default_lead() -> u32 {
    30
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DnsState {
    pub record_id: Option<String>,
    pub published_ip: Option<String>,
    // 创建请求结果不确定时，下次按此 IP 查找，不能盲目重复 POST。
    pub pending_ip: Option<String>,
    pub drain_at: Option<i64>,
    pub schedule_key: String,
    pub paused: bool,
    pub seen_stopped: bool,
    pub once_event: Option<String>,
    pub alerted_event: Option<String>,
    pub attempt_slot: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct DnsSettings {
    pub enabled: bool,
    pub zone_id: String,
    pub name: String,
    pub token_enc: Option<String>,
    pub lead_minutes: u32,
    pub state: DnsState,
}
impl Default for DnsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            zone_id: String::new(),
            name: String::new(),
            token_enc: None,
            lead_minutes: 30,
            state: DnsState::default(),
        }
    }
}
impl DnsSettings {
    pub fn from_account(account: &AccountRow) -> Self {
        serde_json::from_str(&account.dns_json).unwrap_or_default()
    }
    pub fn dto(&self) -> DnsDto {
        DnsDto {
            enabled: self.enabled,
            zone_id: self.zone_id.clone(),
            name: self.name.clone(),
            token_configured: self.token_enc.is_some(),
            lead_minutes: self.lead_minutes,
            last_error: self.state.last_error.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct DnsDto {
    pub enabled: bool,
    pub zone_id: String,
    pub name: String,
    pub token_configured: bool,
    pub lead_minutes: u32,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct DnsInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub zone_id: String,
    #[serde(default)]
    pub name: String,
    pub api_token: Option<String>,
    #[serde(default = "default_lead")]
    pub lead_minutes: u32,
}
impl DnsInput {
    pub fn apply(
        &self,
        previous: &DnsSettings,
        crypto: &Crypto,
        resource_changed: bool,
    ) -> Result<DnsSettings, String> {
        if self.lead_minutes > 1440 || !self.lead_minutes.is_multiple_of(5) {
            return Err("DNS 提前摘除时间必须为 0～1440 分钟内的 5 分钟整数倍".into());
        }
        let zone = self.zone_id.trim().to_ascii_lowercase();
        let name = self.name.trim().trim_end_matches('.').to_ascii_lowercase();
        let supplied = self
            .api_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if self.enabled {
            if zone.len() != 32 || !zone.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Cloudflare Zone ID 应为 32 位十六进制字符".into());
            }
            if !valid_name(&name) {
                return Err("请填写完整的 DNS 域名，例如 app.example.com".into());
            }
            if supplied.is_none() && previous.token_enc.is_none() {
                return Err("启用 DNS 联动必须提供 Cloudflare API Token".into());
            }
        }
        if supplied.is_some_and(|s| s.len() > 512 || s.contains(['\r', '\n'])) {
            return Err("Cloudflare API Token 格式不合法".into());
        }
        let binding_changed = zone != previous.zone_id || name != previous.name;
        let mut state = if binding_changed {
            DnsState::default()
        } else {
            previous.state.clone()
        };
        if resource_changed
            || self.enabled != previous.enabled
            || self.lead_minutes != previous.lead_minutes
        {
            state.drain_at = None;
            state.paused = false;
            state.alerted_event = None;
            state.attempt_slot = None;
            if resource_changed {
                state.seen_stopped = false;
                state.once_event = None;
            }
            if resource_changed || (self.enabled && !previous.enabled) {
                // 保留原记录归属和旧 IP，重新启用或更换实例后强制同步。
                state.pending_ip = state.pending_ip.take().or(state.published_ip.take());
                state.last_error = None;
            }
        }
        Ok(DnsSettings {
            enabled: self.enabled,
            zone_id: zone,
            name,
            token_enc: match supplied {
                Some(token) => Some(crypto.encrypt(token).map_err(|_| "DNS 凭据加密失败")?),
                None => previous.token_enc.clone(),
            },
            lead_minutes: self.lead_minutes,
            state,
        })
    }
}
fn valid_name(name: &str) -> bool {
    name.len() <= 253
        && name.contains('.')
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// 计算下一次停机；简单模式也通过同一 Cron 计算，覆盖跨午夜。
pub fn next_stop(account: &AccountRow, timezone: &str, now: i64) -> Option<i64> {
    if account.schedule_is_advanced() {
        crate::cron::next_occurrences(account.stop_cron()?, timezone, now, 1)
            .first()
            .copied()
    } else {
        let minute = account.schedule_stop_minutes()?;
        crate::cron::next_occurrences(
            &format!("{} {} * * *", minute % 60, minute / 60),
            timezone,
            now,
            1,
        )
        .first()
        .copied()
    }
}
pub fn drain_due(stop_at: i64, lead_minutes: u32, now: i64) -> bool {
    let target = stop_at - i64::from(lead_minutes) * 60_000;
    let target = if lead_minutes == 0 {
        target
    } else {
        target.div_euclid(TICK_MS) * TICK_MS
    };
    now >= target
}
pub fn schedule_key(account: &AccountRow, timezone: &str) -> String {
    format!(
        "{}|{}|{}",
        timezone,
        account.schedule_mode.as_deref().unwrap_or("simple"),
        if account.schedule_is_advanced() {
            account.stop_cron().unwrap_or("")
        } else {
            account.schedule_stop_time.as_deref().unwrap_or("")
        }
    )
}

pub struct CloudflareDns<'a> {
    pub settings: &'a DnsSettings,
    pub token: &'a str,
}
impl CloudflareDns<'_> {
    async fn call(
        &self,
        method: Method,
        suffix: &str,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let headers = Headers::new();
        headers
            .set("Authorization", &format!("Bearer {}", self.token))
            .map_err(|_| "DNS 认证头构造失败")?;
        headers
            .set("Content-Type", "application/json")
            .map_err(|_| "DNS 请求头构造失败")?;
        let mut init = RequestInit::new();
        init.with_method(method.clone()).with_headers(headers);
        if let Some(body) = body {
            init.with_body(Some(JsValue::from_str(&body.to_string())));
        }
        let request = Request::new_with_init(
            &format!(
                "https://api.cloudflare.com/client/v4/zones/{}/dns_records{suffix}",
                self.settings.zone_id
            ),
            &init,
        )
        .map_err(|_| "DNS 请求构造失败")?;
        let (status, text) = crate::runtime::fetch_text(request, 2_000)
            .await
            .map_err(|_| "Cloudflare DNS 请求失败或超时，结果尚未确认")?;
        if status == 404 && method == Method::Delete {
            return Ok(Value::Null);
        }
        let value: Value =
            serde_json::from_str(&text).map_err(|_| "Cloudflare DNS 返回了无效响应")?;
        if value.get("success").and_then(Value::as_bool) != Some(true)
            || !(200..300).contains(&status)
        {
            // 不记录响应原文，防止代理或异常响应回显凭据。
            let code = value
                .pointer("/errors/0/code")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if method == Method::Delete && code == 81044 {
                return Ok(Value::Null);
            }
            return Err(format!(
                "Cloudflare DNS 操作失败（HTTP {status}，错误码 {code}）"
            ));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| "Cloudflare DNS 响应缺少 result".into())
    }
    pub async fn find(&self, ip: &str) -> Result<Option<String>, String> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("type", "A")
            .append_pair("name", &self.settings.name)
            .append_pair("content", ip)
            .append_pair("per_page", "100")
            .finish();
        let result = self.call(Method::Get, &format!("?{query}"), None).await?;
        let records = result.as_array().ok_or("Cloudflare DNS 记录列表格式错误")?;
        let matches: Vec<_> = records
            .iter()
            .filter(|r| {
                r["type"] == "A"
                    && r["name"].as_str().is_some_and(|name| {
                        name.trim_end_matches('.')
                            .eq_ignore_ascii_case(&self.settings.name)
                    })
                    && r["content"] == ip
            })
            .collect();
        if matches.len() > 1 {
            return Err("同一域名和 IP 存在多条 A 记录，请先在 Cloudflare 清理重复记录".into());
        }
        matches
            .first()
            .map(|record| {
                record["id"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "Cloudflare DNS 记录缺少 ID".into())
            })
            .transpose()
    }
    pub async fn delete(&self, id: &str) -> Result<(), String> {
        self.call(Method::Delete, &format!("/{id}"), None)
            .await
            .map(|_| ())
    }
    pub async fn publish(&self, id: Option<&str>, ip: &str) -> Result<String, String> {
        let body = json!({"type":"A", "name":self.settings.name, "content":ip, "ttl":TTL, "proxied":false});
        let result = self
            .call(
                if id.is_some() {
                    Method::Patch
                } else {
                    Method::Post
                },
                &id.map(|id| format!("/{id}")).unwrap_or_default(),
                Some(body),
            )
            .await?;
        result["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Cloudflare DNS 写入响应缺少记录 ID".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lead_rounds_down_without_early_zero() {
        let stop = 22 * 3600_000 + 3 * 60_000;
        assert!(!drain_due(stop, 30, 21 * 3600_000 + 29 * 60_000));
        assert!(drain_due(stop, 30, 21 * 3600_000 + 30 * 60_000));
        assert!(!drain_due(stop, 0, stop - 1));
        assert!(drain_due(stop, 0, stop));
    }
    #[test]
    fn validates_names() {
        assert!(valid_name("app.example.com"));
        for name in [
            "https://example.com",
            "example.com/path",
            "foo..com",
            "-foo.com",
            "foo",
            "*.example.com",
        ] {
            assert!(!valid_name(name), "{name}");
        }
    }
    #[test]
    fn dto_never_contains_credentials() {
        let config = DnsSettings {
            token_enc: Some("secret-ciphertext".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&config.dto()).unwrap();
        assert!(json.contains("token_configured"));
        assert!(!json.contains("secret-ciphertext"));
    }
    #[test]
    fn replacing_instance_retains_managed_record_and_blank_token() {
        let crypto = Crypto::new(crate::crypto::MasterKey::parse(&"ab".repeat(32)).unwrap());
        let previous = DnsSettings {
            enabled: true,
            zone_id: "a".repeat(32),
            name: "app.example.com".into(),
            token_enc: Some(crypto.encrypt("fixture-token").unwrap()),
            state: DnsState {
                record_id: Some("record-a".into()),
                published_ip: Some("192.0.2.1".into()),
                drain_at: Some(1000),
                paused: true,
                ..Default::default()
            },
            ..Default::default()
        };
        let input = DnsInput {
            enabled: true,
            zone_id: previous.zone_id.clone(),
            name: previous.name.clone(),
            api_token: Some(String::new()),
            lead_minutes: 30,
        };
        let next = input.apply(&previous, &crypto, true).unwrap();
        assert_eq!(next.state.record_id, previous.state.record_id);
        assert!(next.state.published_ip.is_none());
        assert_eq!(next.state.pending_ip, previous.state.published_ip);
        assert_eq!(next.token_enc, previous.token_enc);
        assert!(next.state.drain_at.is_none());
        assert!(!next.state.paused);
        assert!(next.state.last_error.is_none());
    }
}
