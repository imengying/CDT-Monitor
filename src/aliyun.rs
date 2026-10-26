//! # 阿里云 RPC 客户端（纯 Rust，无 SDK）
//!
//! Workers 里不能链接任何 C/系统调用型 SDK，因此这里直接实现阿里云
//! **RPC 风格 API 的 V1 签名**并用 `worker::Fetch` 发起 HTTPS 请求。
//!
//! ## 签名算法（RPC V1）
//!
//! ```text
//! 1. 所有参数（含公共参数、不含 Signature）按参数名做字典序排序
//! 2. 拼成 key1=value1&key2=value2 …（key / value 均做 RFC3986 百分号编码）
//! 3. StringToSign = "GET" + "&" + percentEncode("/") + "&" + percentEncode(规范化查询串)
//! 4. Signature   = Base64(HMAC-SHA1(Secret + "&", StringToSign))
//! ```
//!
//! `tests::signature_matches_official_example` 用阿里云官方文档给出的
//! `testid` / `testsecret` 样例做断言，保证编码细节（空格 %20、`*` → `%2A`、
//! `~` 不编码、十六进制大写）与官方一致。
//!
//! ## 覆盖的接口
//!
//! | 用途 | 域名 | Version | Action |
//! |---|---|---|---|
//! | CDT 流量 | `cdt.aliyuncs.com` | 2021-08-13 | `ListCdtInternetTraffic`（失败回退 `GetCdtInternetTraffic`） |
//! | ECS 查询/控制 | `ecs.aliyuncs.com` | 2014-05-26 | `DescribeInstances` / `StartInstance` / `StopInstance` |
//! | 账户余额 | `business.aliyuncs.com` | 2017-12-14 | `QueryAccountBalance` |
//!
//! 国际站把域名换成 `*.ap-southeast-1.aliyuncs.com`（BSS 为
//! `business.ap-southeast-1.aliyuncs.com`）。
//!
//! ## 重试
//!
//! 仅对**可恢复**错误重试最多 2 次（指数退避 200ms / 600ms）：
//! 网络层失败、HTTP 5xx、阿里云 `Throttling*` / `ServiceUnavailable` /
//! `InternalError` 等瞬态错误码。参数错误、鉴权失败等 4xx 直接返回，
//! 避免无意义地放大调用。

use std::collections::BTreeMap;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use worker::{Delay, Fetch, Headers, Method, Request, RequestInit};

use crate::crypto::{CryptoError, random_hex};
use crate::models::{AccountRow, InstanceInfo, SiteType, StopMode};

type HmacSha1 = Hmac<Sha1>;

// ===========================================================================
// 错误
// ===========================================================================

/// 阿里云调用错误。
#[derive(Debug, Clone)]
pub enum AliyunError {
    /// 阿里云返回了业务错误（HTTP 4xx/5xx 或响应体含 Code/Message）。
    Api {
        code: String,
        message: String,
        request_id: Option<String>,
        http_status: u16,
    },
    /// 网络层失败（DNS / TLS / 连接中断 / fetch 抛错）。
    Network(String),
    /// 响应不是预期的 JSON 结构。
    Parse(String),
    /// 本地构造请求失败（签名、编码、随机数）。
    Local(String),
}

impl std::fmt::Display for AliyunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AliyunError::Api {
                code,
                message,
                request_id,
                http_status,
            } => {
                let rid = request_id.as_deref().unwrap_or("-");
                write!(
                    f,
                    "阿里云错误 [{code}] {message}（HTTP {http_status}, RequestId {rid}）"
                )
            }
            AliyunError::Network(msg) => write!(f, "阿里云网络错误：{msg}"),
            AliyunError::Parse(msg) => write!(f, "阿里云响应解析失败：{msg}"),
            AliyunError::Local(msg) => write!(f, "阿里云请求构造失败：{msg}"),
        }
    }
}

impl std::error::Error for AliyunError {}

impl From<AliyunError> for worker::Error {
    fn from(err: AliyunError) -> Self {
        worker::Error::RustError(err.to_string())
    }
}

impl From<CryptoError> for AliyunError {
    fn from(err: CryptoError) -> Self {
        AliyunError::Local(err.to_string())
    }
}

impl AliyunError {
    /// 是否为可重试的瞬态错误。
    pub fn is_retryable(&self) -> bool {
        match self {
            AliyunError::Network(_) => true,
            AliyunError::Api {
                code, http_status, ..
            } => {
                if *http_status >= 500 {
                    return true;
                }
                let code = code.to_ascii_lowercase();
                code.starts_with("throttling")
                    || code.contains("serviceunavailable")
                    || code.contains("internalerror")
                    || code.contains("timeout")
                    || code.contains("busy")
            }
            _ => false,
        }
    }

    /// 便于日志的短描述。
    pub fn short(&self) -> String {
        match self {
            AliyunError::Api { code, message, .. } => format!("{code}: {message}"),
            other => other.to_string(),
        }
    }
}

// ===========================================================================
// 端点
// ===========================================================================

/// 三种服务端点（可被环境变量覆盖）。
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub cdt: String,
    pub ecs: String,
    pub bss: String,
}

impl Endpoints {
    /// 按站点返回端点。
    pub fn for_site(site: SiteType) -> Self {
        match site {
            SiteType::China => Self {
                cdt: "https://cdt.aliyuncs.com".to_string(),
                ecs: "https://ecs.aliyuncs.com".to_string(),
                bss: "https://business.aliyuncs.com".to_string(),
            },
            SiteType::Intl => Self {
                cdt: "https://cdt.ap-southeast-1.aliyuncs.com".to_string(),
                ecs: "https://ecs.ap-southeast-1.aliyuncs.com".to_string(),
                bss: "https://business.ap-southeast-1.aliyuncs.com".to_string(),
            },
        }
    }
}

// ===========================================================================
// 签名
// ===========================================================================

/// RFC3986 百分号编码（阿里云要求的变体）。
///
/// 保留字符集只含 `A-Z a-z 0-9 - _ . ~`；其余全部编码为大写十六进制。
/// 空格编码为 `%20`（不是 `+`），`*` 编码为 `%2A`。
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            other => {
                out.push('%');
                out.push_str(&format!("{other:02X}"));
            }
        }
    }
    out
}

/// 规范化查询串（键按字典序，键值均已编码）。
pub fn canonicalized_query(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// 待签名字符串。
pub fn string_to_sign(method: &str, canonical_query: &str) -> String {
    format!(
        "{}&{}&{}",
        method,
        percent_encode("/"),
        percent_encode(canonical_query)
    )
}

/// 用 `HMAC-SHA1(secret + "&")` 计算签名并 Base64 编码。
pub fn sign(secret: &str, string_to_sign: &str) -> String {
    let key = format!("{secret}&");
    let mut mac =
        <HmacSha1 as Mac>::new_from_slice(key.as_bytes()).expect("HMAC-SHA1 接受任意长度密钥");
    mac.update(string_to_sign.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

/// Unix 毫秒 -> 阿里云要求的 UTC ISO8601（`2025-01-01T00:00:00Z`）。
pub fn iso8601_utc(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(|| {
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(0).expect("epoch")
        })
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

// ===========================================================================
// 客户端
// ===========================================================================

/// 一个阿里云账号的调用客户端（Secret 已解密，仅存活于本次执行）。
#[derive(Clone)]
pub struct AliyunClient {
    access_key_id: String,
    access_key_secret: String,
    site: SiteType,
    endpoints: Endpoints,
}

impl std::fmt::Debug for AliyunClient {
    /// 永不输出 Secret。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AliyunClient")
            .field("access_key_id", &self.access_key_id)
            .field("site", &self.site)
            .field("endpoints", &self.endpoints)
            .finish_non_exhaustive()
    }
}

impl AliyunClient {
    pub fn new(
        access_key_id: impl Into<String>,
        access_key_secret: impl Into<String>,
        site: SiteType,
        endpoints: Endpoints,
    ) -> Self {
        Self {
            access_key_id: access_key_id.into(),
            access_key_secret: access_key_secret.into(),
            site,
            endpoints,
        }
    }

    /// 由账号行 + 解密后的 Secret 构造。
    pub fn from_account(account: &AccountRow, secret: String) -> Self {
        Self::new(
            account.access_key_id.clone(),
            secret,
            account.site(),
            Endpoints::for_site(account.site()),
        )
    }

    pub fn site(&self) -> SiteType {
        self.site
    }

    // -----------------------------------------------------------------------
    // 底层 RPC
    // -----------------------------------------------------------------------

    /// 发起一次 RPC GET 请求（含最多 2 次退避重试）。
    async fn call(
        &self,
        endpoint: &str,
        version: &str,
        action: &str,
        extra: Vec<(&str, String)>,
    ) -> Result<Value, AliyunError> {
        const MAX_ATTEMPTS: usize = 3;
        let mut last_error: Option<AliyunError> = None;

        for attempt in 0..MAX_ATTEMPTS {
            match self.call_once(endpoint, version, action, &extra).await {
                Ok(value) => return Ok(value),
                Err(err) => {
                    let retryable = err.is_retryable();
                    last_error = Some(err);
                    if !retryable || attempt + 1 >= MAX_ATTEMPTS {
                        break;
                    }
                    // 200ms -> 600ms
                    let backoff = 200u64 * 3u64.pow(attempt as u32);
                    Delay::from(Duration::from_millis(backoff)).await;
                }
            }
        }

        Err(last_error.unwrap_or_else(|| AliyunError::Local("未知调用失败".to_string())))
    }

    /// 单次 RPC 调用（签名 + fetch + 解析）。
    async fn call_once(
        &self,
        endpoint: &str,
        version: &str,
        action: &str,
        extra: &[(&str, String)],
    ) -> Result<Value, AliyunError> {
        let mut params: BTreeMap<String, String> = BTreeMap::new();
        params.insert("AccessKeyId".to_string(), self.access_key_id.clone());
        params.insert("Action".to_string(), action.to_string());
        params.insert("Format".to_string(), "JSON".to_string());
        params.insert("SignatureMethod".to_string(), "HMAC-SHA1".to_string());
        params.insert(
            "SignatureNonce".to_string(),
            random_hex(16).map_err(AliyunError::from)?,
        );
        params.insert("SignatureVersion".to_string(), "1.0".to_string());
        params.insert(
            "Timestamp".to_string(),
            iso8601_utc(crate::models::now_ms()),
        );
        params.insert("Version".to_string(), version.to_string());
        for (key, value) in extra {
            params.insert((*key).to_string(), value.clone());
        }

        let canonical = canonicalized_query(&params);
        let to_sign = string_to_sign("GET", &canonical);
        let signature = sign(&self.access_key_secret, &to_sign);

        let url = format!(
            "{endpoint}/?{canonical}&Signature={}",
            percent_encode(&signature)
        );

        let headers = Headers::new();
        headers
            .set("Accept", "application/json")
            .map_err(|e| AliyunError::Local(format!("设置请求头失败：{e}")))?;
        headers
            .set("User-Agent", "cdt-monitor/0.1 (+workers-rs)")
            .map_err(|e| AliyunError::Local(format!("设置请求头失败：{e}")))?;
        headers
            .set("x-acs-action", action)
            .map_err(|e| AliyunError::Local(format!("设置请求头失败：{e}")))?;

        let mut init = RequestInit::new();
        init.with_method(Method::Get).with_headers(headers);

        let request = Request::new_with_init(&url, &init)
            .map_err(|e| AliyunError::Local(format!("构造请求失败：{e}")))?;

        let mut response = Fetch::Request(request)
            .send()
            .await
            .map_err(|e| AliyunError::Network(format!("{e}")))?;

        let status = response.status_code();
        let body = response
            .text()
            .await
            .map_err(|e| AliyunError::Network(format!("读取响应失败：{e}")))?;

        parse_rpc_response(status, &body, action)
    }

    // -----------------------------------------------------------------------
    // CDT 流量
    // -----------------------------------------------------------------------

    /// 查询当月 CDT 公网流量（国内 / 海外分开汇总）。
    ///
    /// 先尝试 `ListCdtInternetTraffic`；若返回“不支持的 Action”等错误，
    /// 再回退到 `GetCdtInternetTraffic`。两个接口的响应结构都按
    /// [`CdtTraffic::parse`] 的宽松规则解析，尽量兼容字段差异。
    pub async fn query_cdt_traffic(&self) -> Result<CdtTraffic, AliyunError> {
        // 参数与上游一致：RegionId 固定 cn-hongkong，不传时间范围。
        // 该 Action 返回当前计费周期内的累计值。
        //
        // 空 TrafficDetails 会重试：CDT 的计量数据有分钟级延迟，
        // 首次调用可能在数据落库前返回空数组，稍后重试即可拿到。
        const MAX_ATTEMPTS: usize = 3;
        let mut last_value = Value::Null;

        for attempt in 0..MAX_ATTEMPTS {
            let value = self
                .call(
                    &self.endpoints.cdt,
                    "2021-08-13",
                    "ListCdtInternetTraffic",
                    vec![("RegionId", "cn-hongkong".to_string())],
                )
                .await?;

            if CdtTraffic::has_details(&value) {
                return Ok(CdtTraffic::parse(&value, self.site));
            }

            last_value = value;
            if attempt + 1 < MAX_ATTEMPTS {
                Delay::from(Duration::from_millis(300 * 2u64.pow(attempt as u32))).await;
            }
        }

        // 重试后仍为空：按无数据处理，由上层决定是否告警
        Ok(CdtTraffic::parse(&last_value, self.site))
    }

    // -----------------------------------------------------------------------
    // ECS
    // -----------------------------------------------------------------------

    /// 列出指定地域的全部实例（自动翻页，最多 20 页 = 2000 台）。
    pub async fn describe_instances(
        &self,
        region_id: &str,
    ) -> Result<Vec<InstanceInfo>, AliyunError> {
        const PAGE_SIZE: i64 = 100;
        const MAX_PAGES: i64 = 20;

        let mut collected: Vec<InstanceInfo> = Vec::new();
        let mut page = 1i64;

        while page <= MAX_PAGES {
            let value = self
                .call(
                    &self.endpoints.ecs,
                    "2014-05-26",
                    "DescribeInstances",
                    vec![
                        ("RegionId", region_id.to_string()),
                        ("PageNumber", page.to_string()),
                        ("PageSize", PAGE_SIZE.to_string()),
                    ],
                )
                .await?;

            let instances = extract_array(&value, &["Instances", "Instance"]);
            let count = instances.len();
            for item in instances {
                collected.push(parse_instance(&item, region_id));
            }

            let total = value
                .get("TotalCount")
                .and_then(|v| {
                    v.as_i64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(collected.len() as i64);

            if count == 0 || collected.len() as i64 >= total || count < PAGE_SIZE as usize {
                break;
            }
            page += 1;
        }

        Ok(collected)
    }

    /// 启动实例。
    pub async fn start_instance(
        &self,
        instance_id: &str,
        region_id: &str,
    ) -> Result<(), AliyunError> {
        self.call(
            &self.endpoints.ecs,
            "2014-05-26",
            "StartInstance",
            vec![
                ("InstanceId", instance_id.to_string()),
                ("RegionId", region_id.to_string()),
            ],
        )
        .await
        .map(|_| ())
    }

    /// 停止实例。
    ///
    /// * `StopCharging`（节省停机）：释放计算资源（vCPU/内存）不计费，
    ///   公网 IP / 云盘照常计费；
    /// * `KeepCharging`（普通停机）：保留计算资源，继续计费。
    ///
    /// 对**按量付费 / 抢占式**实例，阿里云要求必须传 `StoppedMode`；
    /// 对包年包月实例该参数会被忽略。
    pub async fn stop_instance(
        &self,
        instance_id: &str,
        region_id: &str,
        mode: StopMode,
    ) -> Result<(), AliyunError> {
        self.call(
            &self.endpoints.ecs,
            "2014-05-26",
            "StopInstance",
            vec![
                ("InstanceId", instance_id.to_string()),
                ("RegionId", region_id.to_string()),
                ("StoppedMode", mode.as_str().to_string()),
                ("ForceStop", "false".to_string()),
            ],
        )
        .await
        .map(|_| ())
    }

    // -----------------------------------------------------------------------
    // BSS 余额
    // -----------------------------------------------------------------------

    /// 查询账户可用余额。响应里 `Data.AvailableAmount` 是字符串金额，
    /// `Data.Currency` 是 `CNY` / `USD`。
    pub async fn query_balance(&self) -> Result<AccountBalance, AliyunError> {
        let value = self
            .call(
                &self.endpoints.bss,
                "2017-12-14",
                "QueryAccountBalance",
                vec![],
            )
            .await?;

        let data = value.get("Data").cloned().unwrap_or(Value::Null);
        let amount = data
            .get("AvailableAmount")
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.trim().to_string())
                    .or_else(|| v.as_f64().map(|f| f.to_string()))
            })
            .and_then(|s| s.parse::<f64>().ok());
        let currency = data
            .get("Currency")
            .and_then(|v| v.as_str())
            .map(|s| s.to_ascii_uppercase());

        match amount {
            Some(amount) => Ok(AccountBalance { amount, currency }),
            None => Err(AliyunError::Parse(format!(
                "QueryAccountBalance 响应缺少 Data.AvailableAmount：{}",
                truncate_json(&value, 200)
            ))),
        }
    }
}

// ===========================================================================
// 响应结构
// ===========================================================================

/// 账户余额。
#[derive(Debug, Clone, PartialEq)]
pub struct AccountBalance {
    pub amount: f64,
    pub currency: Option<String>,
}

/// CDT 流量汇总（字节）。
///
/// 字段结构依据 `ListCdtInternetTraffic` 的实际响应：
///
/// ```json
/// { "TrafficDetails": [
///     { "BusinessRegionId": "cn-hangzhou", "Traffic": 1073741824 },
///     { "BusinessRegionId": "cn-hongkong", "Traffic": 2147483648 }
/// ] }
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CdtTraffic {
    /// 中国内地地域流量。
    pub domestic_bytes: i64,
    /// 非中国内地（中国香港及海外）流量。
    pub overseas_bytes: i64,
    /// 无法归类、已按站点默认归类并入上面的字节数（仅用于日志告警）。
    pub unclassified_bytes: i64,
    /// 解析到的条目数（0 表示接口没返回数据）。
    pub items: usize,
}

impl CdtTraffic {
    pub fn total_bytes(&self) -> i64 {
        self.domestic_bytes.max(0) + self.overseas_bytes.max(0)
    }

    /// 解析 `ListCdtInternetTraffic` 的响应。
    ///
    /// `TrafficDetails` 既可能是数组，也可能是 `{"Item": [...]}` 形式；
    /// 部分响应会把数据包在 `Data` 里，两种情况都处理。
    pub fn parse(value: &Value, site: SiteType) -> Self {
        let mut out = CdtTraffic::default();

        let items = value
            .get("TrafficDetails")
            .map(traffic_items)
            .filter(|items| !items.is_empty())
            .or_else(|| {
                value
                    .get("Data")
                    .and_then(|data| data.get("TrafficDetails"))
                    .map(traffic_items)
            })
            .unwrap_or_default();

        for item in items {
            let Some(bytes) = item.get("Traffic").and_then(json_to_i64) else {
                continue;
            };
            let region = item
                .get("BusinessRegionId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty());
            out.items += 1;

            match classify_region(region, site) {
                RegionClass::Domestic => out.domestic_bytes += bytes,
                RegionClass::Overseas => out.overseas_bytes += bytes,
                RegionClass::Unknown => {
                    out.unclassified_bytes += bytes;
                    match site {
                        SiteType::China => out.domestic_bytes += bytes,
                        SiteType::Intl => out.overseas_bytes += bytes,
                    }
                }
            }
        }

        out.domestic_bytes = out.domestic_bytes.max(0);
        out.overseas_bytes = out.overseas_bytes.max(0);
        out
    }

    /// 响应里是否有 `TrafficDetails`（含非空数组）。空数组视为无数据。
    pub fn has_details(value: &Value) -> bool {
        value
            .get("TrafficDetails")
            .map(traffic_items)
            .filter(|items| !items.is_empty())
            .is_some()
            || value
                .get("Data")
                .and_then(|data| data.get("TrafficDetails"))
                .map(traffic_items)
                .is_some_and(|items| !items.is_empty())
    }
}

/// 把 `TrafficDetails` 归一化成数组：接受数组本身或 `{"Item": [...]}`。
fn traffic_items(value: &Value) -> Vec<Value> {
    if let Some(array) = value.as_array() {
        return array.clone();
    }
    if let Some(item) = value.get("Item") {
        if let Some(array) = item.as_array() {
            return array.clone();
        }
        if item.is_object() {
            return vec![item.clone()];
        }
    }
    Vec::new()
}

/// 数字或数字字符串转 `i64`。
fn json_to_i64(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    if let Some(f) = value.as_f64() {
        return Some(f.round() as i64);
    }
    value.as_str()?.trim().parse::<i64>().ok()
}

/// 地域归类结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegionClass {
    Domestic,
    Overseas,
    Unknown,
}

/// 把 `BusinessRegionId` 归到「中国内地」或「非中国内地」。
///
/// CDT 的计费口径是两者分开计费，判定规则与上游一致：
/// 以 `cn-` 开头且不是 `cn-hongkong` 的算中国内地，其余（中国香港、
/// 亚太、欧美等）一律算非中国内地。
fn classify_region(region: Option<&str>, _site: SiteType) -> RegionClass {
    let Some(region) = region else {
        return RegionClass::Unknown;
    };
    let lower = region.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return RegionClass::Unknown;
    }

    // 中国香港虽以 cn- 开头，但计费上属于非中国内地
    if lower == "cn-hongkong" {
        return RegionClass::Overseas;
    }
    if lower.starts_with("cn-") {
        return RegionClass::Domestic;
    }
    RegionClass::Overseas
}

/// 取形如 `{"Instances": {"Instance": [...]}}` 的数组。
fn extract_array(value: &Value, path: &[&str]) -> Vec<Value> {
    let mut cursor = value;
    for key in path {
        match cursor.get(*key) {
            Some(next) => cursor = next,
            None => return Vec::new(),
        }
    }
    cursor.as_array().cloned().unwrap_or_default()
}

/// 解析单个 ECS 实例对象。
fn parse_instance(item: &Value, fallback_region: &str) -> InstanceInfo {
    let string_of = |key: &str| -> Option<String> {
        item.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    let public_ip = extract_array(item, &["PublicIpAddress", "IpAddress"])
        .first()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            item.get("EipAddress")
                .and_then(|e| e.get("IpAddress"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        });

    let private_ip = extract_array(item, &["InnerIpAddress", "IpAddress"])
        .first()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            extract_array(item, &["VpcAttributes", "PrivateIpAddress", "IpAddress"])
                .first()
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    let spot_strategy = string_of("SpotStrategy");
    let spot = spot_strategy
        .as_deref()
        .map(|s| !s.eq_ignore_ascii_case("NoSpot"))
        .unwrap_or(false)
        || item.get("Spot").and_then(|v| v.as_bool()).unwrap_or(false);

    let stopped_mode = string_of("StoppedMode");

    InstanceInfo {
        instance_id: string_of("InstanceId").unwrap_or_default(),
        instance_name: string_of("InstanceName").unwrap_or_default(),
        instance_type: string_of("InstanceType").unwrap_or_default(),
        region_id: string_of("RegionId").unwrap_or_else(|| fallback_region.to_string()),
        zone_id: string_of("ZoneId").unwrap_or_default(),
        status: string_of("Status").unwrap_or_default(),
        public_ip,
        private_ip,
        instance_charge_type: string_of("InstanceChargeType"),
        spot_strategy,
        stopped_mode,
        os_name: string_of("OSName"),
        creation_time: string_of("CreationTime"),
        expired_time: string_of("ExpiredTime"),
        spot,
        // 逐实例保活开关由用户在界面设置，采集时保持默认关闭；
        // scheduler 合并旧快照里的用户选择。
        keep_alive: false,
    }
}

/// 解析 RPC 响应：非 2xx 或含 `Code` 的对象视为错误。
fn parse_rpc_response(status: u16, body: &str, action: &str) -> Result<Value, AliyunError> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return if (200..300).contains(&status) {
            Ok(Value::Object(Default::default()))
        } else {
            Err(AliyunError::Api {
                code: format!("HTTP{status}"),
                message: format!("{action} 返回空响应"),
                request_id: None,
                http_status: status,
            })
        };
    }

    let parsed: Value = serde_json::from_str(trimmed).map_err(|err| {
        if (200..300).contains(&status) {
            AliyunError::Parse(format!(
                "{action} 响应不是 JSON（{err}）：{}",
                truncate_str(trimmed, 200)
            ))
        } else {
            AliyunError::Api {
                code: format!("HTTP{status}"),
                message: truncate_str(trimmed, 200),
                request_id: None,
                http_status: status,
            }
        }
    })?;

    if !(200..300).contains(&status) || is_error_payload(&parsed) {
        let code = parsed
            .get("Code")
            .and_then(|v| v.as_str())
            .unwrap_or("UnknownError")
            .to_string();
        let message = parsed
            .get("Message")
            .or_else(|| parsed.get("ErrorMessage"))
            .and_then(|v| v.as_str())
            .unwrap_or("阿里云未返回错误描述")
            .to_string();
        let request_id = parsed
            .get("RequestId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        return Err(AliyunError::Api {
            code,
            message,
            request_id,
            http_status: status,
        });
    }

    Ok(parsed)
}

/// 判断响应体是否为错误结构。
///
/// 成功的 RPC 响应通常带 `RequestId` 而不带 `Code`；错误响应一定带
/// `Code` + `Message`。个别接口成功时也会返回业务 `Code`（如 `200`），
/// 因此只把「带 Message 且 Code 非成功语义」的对象当作错误。
fn is_error_payload(value: &Value) -> bool {
    let Some(code) = value.get("Code") else {
        return false;
    };
    let Some(code_str) = code.as_str() else {
        return false;
    };
    if matches!(code_str, "200" | "OK" | "Success" | "success") {
        return false;
    }
    value.get("Message").is_some() || value.get("ErrorMessage").is_some()
}

fn truncate_str(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let head: String = value.chars().take(max_chars).collect();
    format!("{head}…")
}

fn truncate_json(value: &Value, max_chars: usize) -> String {
    truncate_str(&value.to_string(), max_chars)
}

// ===========================================================================
// 便捷封装
// ===========================================================================

/// 一轮账号同步的原始结果（尚未写入 D1）。
#[derive(Debug, Clone, Default)]
pub struct AccountSync {
    /// CDT 流量；`None` 表示查询失败（调用方应沿用上次快照，而不是写成 0）。
    pub traffic: Option<CdtTraffic>,
    pub balance: Option<AccountBalance>,
    pub instances: Vec<InstanceInfo>,
    /// 查询失败的地域列表：调用方据此决定是否沿用旧快照里的实例。
    pub failed_regions: Vec<String>,
    /// 局部失败信息：例如「cn-shanghai 地域查询失败」，不影响其它地域。
    pub warnings: Vec<String>,
}

/// 依次拉取某账号的 CDT 流量、余额与全部地域实例。
///
/// 三个来源互相独立：任一失败只记 warning，其余照常返回，避免一次
/// 网络抖动就让整张卡片变成错误状态。
pub async fn sync_account(client: &AliyunClient, regions: &[String]) -> AccountSync {
    let mut out = AccountSync::default();

    match client.query_cdt_traffic().await {
        Ok(traffic) => {
            if traffic.unclassified_bytes > 0 {
                out.warnings.push(format!(
                    "CDT 有 {} 字节无法按地域归类，已按站点默认归类",
                    traffic.unclassified_bytes
                ));
            }
            if traffic.items == 0 {
                out.warnings
                    .push("CDT 接口未返回任何流量条目（可能当月还没有产生流量）".to_string());
            }
            out.traffic = Some(traffic);
        }
        Err(err) => out
            .warnings
            .push(format!("CDT 流量查询失败：{}", err.short())),
    }

    match client.query_balance().await {
        Ok(balance) => out.balance = Some(balance),
        Err(err) => out.warnings.push(format!("余额查询失败：{}", err.short())),
    }

    for region in regions {
        match client.describe_instances(region).await {
            Ok(mut instances) => out.instances.append(&mut instances),
            Err(err) => {
                out.failed_regions.push(region.clone());
                out.warnings
                    .push(format!("{region} 实例查询失败：{}", err.short()));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 阿里云官方文档的分组签名示例（ECS DescribeRegions）。
    /// AccessKeyId=testid / AccessKeySecret=testsecret / GET / Version=2014-05-26
    #[test]
    fn signature_matches_official_example() {
        let mut params = BTreeMap::new();
        params.insert("AccessKeyId".to_string(), "testid".to_string());
        params.insert("Action".to_string(), "DescribeRegions".to_string());
        params.insert("Format".to_string(), "XML".to_string());
        params.insert("SignatureMethod".to_string(), "HMAC-SHA1".to_string());
        params.insert(
            "SignatureNonce".to_string(),
            "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf".to_string(),
        );
        params.insert("SignatureVersion".to_string(), "1.0".to_string());
        params.insert("Timestamp".to_string(), "2016-02-23T12:46:24Z".to_string());
        params.insert("Version".to_string(), "2014-05-26".to_string());

        let canonical = canonicalized_query(&params);
        assert_eq!(
            canonical,
            "AccessKeyId=testid&Action=DescribeRegions&Format=XML&SignatureMethod=HMAC-SHA1&SignatureNonce=3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf&SignatureVersion=1.0&Timestamp=2016-02-23T12%3A46%3A24Z&Version=2014-05-26"
        );

        let to_sign = string_to_sign("GET", &canonical);
        let signature = sign("testsecret", &to_sign);
        assert_eq!(signature, "OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
    }

    #[test]
    fn percent_encoding_rules() {
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a*b"), "a%2Ab");
        assert_eq!(percent_encode("a~b"), "a~b");
        assert_eq!(percent_encode("a+b"), "a%2Bb");
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("中文"), "%E4%B8%AD%E6%96%87");
        assert_eq!(percent_encode("A-Z_a.z"), "A-Z_a.z");
    }

    #[test]
    fn iso_time_format() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(1_735_689_600_000), "2025-01-01T00:00:00Z");
    }

    #[test]
    fn cdt_parse_real_response() {
        // 结构取自 ListCdtInternetTraffic 的实际响应
        let value = serde_json::json!({
            "RequestId": "x",
            "TrafficDetails": [
                { "BusinessRegionId": "cn-hangzhou", "Traffic": 1073741824i64 },
                { "BusinessRegionId": "cn-beijing", "Traffic": 2147483648i64 },
                { "BusinessRegionId": "cn-hongkong", "Traffic": 4294967296i64 },
                { "BusinessRegionId": "ap-southeast-1", "Traffic": 1073741824i64 }
            ]
        });
        let traffic = CdtTraffic::parse(&value, SiteType::China);
        assert_eq!(traffic.domestic_bytes, 3 * 1073741824, "内地合计 3 GiB");
        assert_eq!(traffic.overseas_bytes, 5 * 1073741824, "非内地合计 5 GiB");
        assert_eq!(traffic.items, 4);
        assert_eq!(traffic.unclassified_bytes, 0);
        assert_eq!(traffic.total_bytes(), 8 * 1073741824);
    }

    #[test]
    fn cdt_parse_item_wrapper() {
        // TrafficDetails 也可能包在 {"Item": [...]} 里
        let value = serde_json::json!({
            "TrafficDetails": {
                "Item": [
                    { "BusinessRegionId": "cn-shanghai", "Traffic": 1024 }
                ]
            }
        });
        let traffic = CdtTraffic::parse(&value, SiteType::China);
        assert_eq!(traffic.domestic_bytes, 1024);
        assert_eq!(traffic.items, 1);
    }

    #[test]
    fn cdt_parse_data_wrapper() {
        let value = serde_json::json!({
            "Data": {
                "TrafficDetails": [
                    { "BusinessRegionId": "cn-hongkong", "Traffic": 2048 }
                ]
            }
        });
        let traffic = CdtTraffic::parse(&value, SiteType::China);
        assert_eq!(traffic.overseas_bytes, 2048);
    }

    #[test]
    fn cdt_parse_traffic_as_string() {
        let value = serde_json::json!({
            "TrafficDetails": [
                { "BusinessRegionId": "cn-hangzhou", "Traffic": "1024" }
            ]
        });
        let traffic = CdtTraffic::parse(&value, SiteType::China);
        assert_eq!(traffic.domestic_bytes, 1024);
    }

    #[test]
    fn cdt_parse_missing_region_uses_site_default() {
        let value = serde_json::json!({
            "TrafficDetails": [ { "Traffic": 42 }, { "Traffic": 8 } ]
        });
        let cn = CdtTraffic::parse(&value, SiteType::China);
        assert_eq!(cn.unclassified_bytes, 50);
        assert_eq!(cn.domestic_bytes, 50);
        assert_eq!(cn.overseas_bytes, 0);

        let intl = CdtTraffic::parse(&value, SiteType::Intl);
        assert_eq!(intl.overseas_bytes, 50);
        assert_eq!(intl.domestic_bytes, 0);
    }

    #[test]
    fn cn_hongkong_counts_as_overseas() {
        // 中国香港以 cn- 开头，但计费上属于非中国内地
        let value = serde_json::json!({
            "TrafficDetails": [
                { "BusinessRegionId": "cn-hangzhou", "Traffic": 100 },
                { "BusinessRegionId": "cn-hongkong", "Traffic": 200 },
                { "BusinessRegionId": "cn-shanghai", "Traffic": 50 },
                { "BusinessRegionId": "ap-southeast-1", "Traffic": 30 }
            ]
        });
        let traffic = CdtTraffic::parse(&value, SiteType::China);
        assert_eq!(
            traffic.domestic_bytes, 150,
            "内地仅 cn-hangzhou + cn-shanghai"
        );
        assert_eq!(traffic.overseas_bytes, 230, "香港计入非内地");
        assert_eq!(traffic.unclassified_bytes, 0);
    }

    #[test]
    fn classify_region_boundaries() {
        let c = |r: &str| classify_region(Some(r), SiteType::China);
        assert_eq!(c("cn-hongkong"), RegionClass::Overseas);
        assert_eq!(c("CN-HongKong"), RegionClass::Overseas);
        assert_eq!(c("cn-hangzhou"), RegionClass::Domestic);
        assert_eq!(c("cn-beijing"), RegionClass::Domestic);
        assert_eq!(c("ap-southeast-1"), RegionClass::Overseas);
        assert_eq!(c("us-west-1"), RegionClass::Overseas);
        assert_eq!(c("eu-central-1"), RegionClass::Overseas);
        assert_eq!(classify_region(None, SiteType::China), RegionClass::Unknown);
        assert_eq!(
            classify_region(Some("   "), SiteType::China),
            RegionClass::Unknown
        );
    }

    #[test]
    fn cdt_parse_empty() {
        let none = CdtTraffic::parse(&serde_json::json!({ "RequestId": "x" }), SiteType::China);
        assert_eq!(none, CdtTraffic::default());

        let empty = CdtTraffic::parse(
            &serde_json::json!({ "TrafficDetails": [] }),
            SiteType::China,
        );
        assert_eq!(empty.items, 0);
        assert_eq!(empty.total_bytes(), 0);
    }

    #[test]
    fn has_details_detects_non_empty() {
        assert!(!CdtTraffic::has_details(&serde_json::json!({})));
        assert!(!CdtTraffic::has_details(
            &serde_json::json!({ "TrafficDetails": [] })
        ));
        assert!(CdtTraffic::has_details(&serde_json::json!({
            "TrafficDetails": [ { "BusinessRegionId": "cn-hangzhou", "Traffic": 1 } ]
        })));
        assert!(CdtTraffic::has_details(&serde_json::json!({
            "Data": { "TrafficDetails": [ { "BusinessRegionId": "cn-hangzhou", "Traffic": 1 } ] }
        })));
    }

    #[test]
    fn instance_parsing() {
        let value = serde_json::json!({
            "InstanceId": "i-abc123",
            "InstanceName": "web-1",
            "InstanceType": "ecs.t6-c1m1.large",
            "RegionId": "cn-hangzhou",
            "ZoneId": "cn-hangzhou-i",
            "Status": "Running",
            "PublicIpAddress": { "IpAddress": ["1.2.3.4"] },
            "InnerIpAddress": { "IpAddress": ["10.0.0.1"] },
            "InstanceChargeType": "PostPaid",
            "SpotStrategy": "SpotAsPriceGo",
            "StoppedMode": "StopCharging",
            "OSName": "Alibaba Cloud Linux 3"
        });
        let instance = parse_instance(&value, "cn-hangzhou");
        assert_eq!(instance.instance_id, "i-abc123");
        assert_eq!(instance.public_ip.as_deref(), Some("1.2.3.4"));
        assert_eq!(instance.private_ip.as_deref(), Some("10.0.0.1"));
        assert!(instance.is_running());
        assert!(instance.spot);
        assert_eq!(instance.spot_strategy.as_deref(), Some("SpotAsPriceGo"));
        assert!(!instance.keep_alive);
    }

    #[test]
    fn instance_parsing_eip_and_defaults() {
        let value = serde_json::json!({
            "InstanceId": "i-xyz",
            "Status": "Stopped",
            "EipAddress": { "IpAddress": "5.6.7.8" },
            "VpcAttributes": { "PrivateIpAddress": { "IpAddress": ["172.16.0.9"] } },
            "SpotStrategy": "NoSpot"
        });
        let instance = parse_instance(&value, "cn-beijing");
        assert_eq!(instance.region_id, "cn-beijing");
        assert_eq!(instance.public_ip.as_deref(), Some("5.6.7.8"));
        assert_eq!(instance.private_ip.as_deref(), Some("172.16.0.9"));
        assert!(instance.is_stopped());
        assert!(!instance.spot);
    }

    #[test]
    fn error_payload_detection() {
        let err = serde_json::json!({
            "Code": "Throttling.User",
            "Message": "Request was denied due to user flow control.",
            "RequestId": "rid"
        });
        assert!(is_error_payload(&err));

        let ok = serde_json::json!({ "RequestId": "rid", "TotalCount": 0 });
        assert!(!is_error_payload(&ok));

        let business_ok = serde_json::json!({ "Code": "200", "Message": "ok" });
        assert!(!is_error_payload(&business_ok));
    }

    #[test]
    fn parse_rpc_error_maps_fields() {
        let body = r#"{"Code":"InvalidAccessKeyId.NotFound","Message":"Specified access key is not found.","RequestId":"abc"}"#;
        let err = parse_rpc_response(404, body, "DescribeInstances").expect_err("应识别为错误");
        match err {
            AliyunError::Api {
                code,
                message,
                request_id,
                http_status,
            } => {
                assert_eq!(code, "InvalidAccessKeyId.NotFound");
                assert!(message.contains("not found"));
                assert_eq!(request_id.as_deref(), Some("abc"));
                assert_eq!(http_status, 404);
            }
            other => panic!("错误类型不符：{other:?}"),
        }
    }

    #[test]
    fn parse_rpc_success() {
        let body = r#"{"RequestId":"abc","TotalCount":0,"Instances":{"Instance":[]}}"#;
        let value = parse_rpc_response(200, body, "DescribeInstances").expect("应成功");
        assert_eq!(value.get("TotalCount").and_then(|v| v.as_i64()), Some(0));
    }

    #[test]
    fn retryable_classification() {
        let throttling = AliyunError::Api {
            code: "Throttling.User".to_string(),
            message: "slow down".to_string(),
            request_id: None,
            http_status: 400,
        };
        assert!(throttling.is_retryable());

        let bad_param = AliyunError::Api {
            code: "InvalidParameter".to_string(),
            message: "bad".to_string(),
            request_id: None,
            http_status: 400,
        };
        assert!(!bad_param.is_retryable());

        assert!(AliyunError::Network("tls".to_string()).is_retryable());
        assert!(!AliyunError::Parse("json".to_string()).is_retryable());

        let server_error = AliyunError::Api {
            code: "Unknown".to_string(),
            message: "boom".to_string(),
            request_id: None,
            http_status: 503,
        };
        assert!(server_error.is_retryable());
    }

    #[test]
    fn endpoints_by_site() {
        let china = Endpoints::for_site(SiteType::China);
        assert_eq!(china.cdt, "https://cdt.aliyuncs.com");
        assert_eq!(china.bss, "https://business.aliyuncs.com");

        let intl = Endpoints::for_site(SiteType::Intl);
        assert_eq!(intl.ecs, "https://ecs.ap-southeast-1.aliyuncs.com");
        assert_eq!(intl.bss, "https://business.ap-southeast-1.aliyuncs.com");
    }
}
