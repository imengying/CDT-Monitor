//! Cloudflare DDNS：共享凭据和域名，每台实例独立维护自己的 A 记录。
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{Headers, Method, Request, RequestInit, wasm_bindgen::JsValue};

use crate::{crypto::Crypto, models::AccountRow};

pub const TTL: u32 = 300;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DdnsConfig {
    pub zone_id: String,
    pub name: String,
    pub token_enc: Option<String>,
}
impl DdnsConfig {
    pub fn configured(&self) -> bool {
        self.zone_id.len() == 32
            && self.zone_id.bytes().all(|b| b.is_ascii_hexdigit())
            && valid_name(&self.name)
            && self.token_enc.is_some()
    }
    pub fn dto(&self) -> DdnsDto {
        DdnsDto {
            zone_id: self.zone_id.clone(),
            name: self.name.clone(),
            token_configured: self.token_enc.is_some(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct DdnsDto {
    pub zone_id: String,
    pub name: String,
    pub token_configured: bool,
}
#[derive(Clone, Debug, Deserialize)]
pub struct DdnsInput {
    pub zone_id: String,
    pub name: String,
    pub api_token: Option<String>,
}
impl DdnsInput {
    pub fn apply(&self, previous: &DdnsConfig, crypto: &Crypto) -> Result<DdnsConfig, String> {
        let zone_id = self.zone_id.trim().to_ascii_lowercase();
        let name = self.name.trim().trim_end_matches('.').to_ascii_lowercase();
        let supplied = self
            .api_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if zone_id.len() != 32 || !zone_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Cloudflare Zone ID 应为 32 位十六进制字符".into());
        }
        if !valid_name(&name) {
            return Err("请填写完整的 DNS 域名，例如 app.example.com".into());
        }
        if supplied.is_none() && previous.token_enc.is_none() {
            return Err("请填写 Cloudflare API Token".into());
        }
        if supplied.is_some_and(|s| s.len() > 512 || s.contains(['\r', '\n'])) {
            return Err("Cloudflare API Token 格式不合法".into());
        }
        Ok(DdnsConfig {
            zone_id,
            name,
            token_enc: match supplied {
                Some(token) => Some(crypto.encrypt(token).map_err(|_| "DDNS 凭据加密失败")?),
                None => previous.token_enc.clone(),
            },
        })
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DnsState {
    pub record_id: Option<String>,
    pub published_ip: Option<String>,
    // 创建结果未知时，下轮先按此 IP 核实，避免重复创建或遗留记录。
    pub pending_ip: Option<String>,
    pub zone_id: String,
    pub name: String,
    pub alert: Option<DnsAlert>,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DnsAlert {
    pub id: String,
    pub running: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DnsSettings {
    pub enabled: bool,
    pub state: DnsState,
}
impl DnsSettings {
    pub fn from_account(account: &AccountRow) -> Self {
        serde_json::from_str(&account.dns_json).unwrap_or_default()
    }
    pub fn dto(&self) -> DnsDto {
        DnsDto {
            enabled: self.enabled,
            last_error: self.state.last_error.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct DnsDto {
    pub enabled: bool,
    pub last_error: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct DnsInput {
    pub enabled: bool,
}
impl DnsInput {
    pub fn apply(&self, previous: &DnsSettings) -> DnsSettings {
        let mut next = previous.clone();
        next.enabled = self.enabled;
        if self.enabled != previous.enabled {
            next.state.last_error = None;
            next.state.alert = None;
        }
        next
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

pub struct DnsRecord {
    pub id: String,
    pub needs_update: bool,
}

pub struct CloudflareDns<'a> {
    pub settings: &'a DdnsConfig,
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
    pub async fn find(&self, ip: &str) -> Result<Option<DnsRecord>, String> {
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
                    .map(|id| DnsRecord {
                        id: id.to_owned(),
                        needs_update: record["ttl"].as_u64() != Some(u64::from(TTL))
                            || record["proxied"].as_bool() != Some(false),
                    })
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
    fn credentials_stay_encrypted_and_blank_token_is_preserved() {
        let crypto = Crypto::new(crate::crypto::MasterKey::parse(&"ab".repeat(32)).unwrap());
        let input = DdnsInput {
            zone_id: "A".repeat(32),
            name: " App.Example.com. ".into(),
            api_token: Some("fixture-token".into()),
        };
        let config = input.apply(&DdnsConfig::default(), &crypto).unwrap();
        assert_eq!(config.name, "app.example.com");
        assert_eq!(
            crypto.decrypt(config.token_enc.as_ref().unwrap()).unwrap(),
            "fixture-token"
        );
        let dto = serde_json::to_string(&config.dto()).unwrap();
        assert!(!dto.contains("fixture-token"));
        assert!(!dto.contains(config.token_enc.as_ref().unwrap()));
        let next = DdnsInput {
            api_token: Some(String::new()),
            ..input
        }
        .apply(&config, &crypto)
        .unwrap();
        assert_eq!(config, next);
    }
}
