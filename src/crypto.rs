//! # 密码学与鉴权
//!
//! 三件事，全部在 Worker 内部完成，不依赖任何原生扩展：
//!
//! 1. **凭据加密**：`XChaCha20Poly1305`（24 字节随机 Nonce，192 位）。
//!    密文格式固定为 `Base64(24 字节 Nonce ‖ 密文 ‖ 16 字节 Tag)`，
//!    直接作为 TEXT 存进 D1。算法要求 AEAD，篡改任意一个字节都会解密失败。
//! 2. **管理员凭证校验**：用户名与密码都来自 Worker 环境变量
//!    （`ADMIN_USERNAME` / `ADMIN_PASSWORD`），**不支持**在后台改，
//!    也不写进 D1。这样「谁能登录」这件事只有一个来源，轮换就是改环境变量。
//!    用常量时间比较，避免通过响应时间差推断密码。
//! 3. **无状态会话 Token**：`v1.<payload_b64url>.<sig_b64url>`，签名算法
//!    `HMAC-SHA256`，密钥直接使用 `MASTER_KEY`，payload 里带过期时间与随机 jti。
//!    服务端不落库，只验签 + 比对时间；配合 `HttpOnly; Secure; SameSite=Strict`
//!    Cookie 使用。
//!
//! `MASTER_KEY` 的解析容错：64 字符 Hex、44 字符 Base64、或恰好 32 字节的
//! 原始字符串都接受；其它形式会经 `blake3::derive_key` 拉伸成 32 字节，
//! 这样随手填一串长字符串也不会直接报错，但**强烈建议**使用 Hex/Base64。

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// 会话 Cookie 名称。
pub const SESSION_COOKIE: &str = "cdt_session";
/// 默认会话有效期：7 天。
pub const DEFAULT_SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Nonce 长度（XChaCha20 为 24 字节）。
pub const NONCE_LEN: usize = 24;
/// 认证标签长度。
pub const TAG_LEN: usize = 16;

type HmacSha256 = Hmac<Sha256>;

// ===========================================================================
// 错误
// ===========================================================================

/// 加解密 / 密码 / Token 相关的错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// `MASTER_KEY` 缺失或格式非法。
    InvalidMasterKey(String),
    /// 密文不是合法的 Base64 / 长度不足 / 认证失败。
    DecryptFailed(String),
    /// 明文无法构造密文。
    EncryptFailed(String),
    /// 随机数生成失败。
    RngFailed(String),
    /// Token 结构错误。
    MalformedToken,
    /// 签名不匹配。
    BadSignature,
    /// 已过期。
    Expired { expires_at: i64 },
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::InvalidMasterKey(msg) => write!(f, "MASTER_KEY 配置错误：{msg}"),
            CryptoError::DecryptFailed(msg) => write!(f, "解密失败：{msg}"),
            CryptoError::EncryptFailed(msg) => write!(f, "加密失败：{msg}"),
            CryptoError::RngFailed(msg) => write!(f, "随机数生成失败：{msg}"),
            CryptoError::MalformedToken => write!(f, "会话 Token 格式非法"),
            CryptoError::BadSignature => write!(f, "会话 Token 签名不匹配"),
            CryptoError::Expired { expires_at } => write!(f, "会话已过期（{expires_at}）"),
        }
    }
}

impl std::error::Error for CryptoError {}

/// 便于在路由层用 `?` 直接转成 `worker::Error`。
impl From<CryptoError> for worker::Error {
    fn from(err: CryptoError) -> Self {
        worker::Error::RustError(err.to_string())
    }
}

// ===========================================================================
// 主密钥
// ===========================================================================

/// 32 字节主密钥包装。构造即校验，之后的所有操作都不会再失败于密钥格式。
#[derive(Clone)]
pub struct MasterKey {
    bytes: [u8; 32],
}

impl std::fmt::Debug for MasterKey {
    /// 永不打印密钥内容。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

impl MasterKey {
    /// 从环境变量文本解析主密钥。
    ///
    /// 支持（按顺序尝试）：64 字符 Hex、Base64（标准/无填充/URL-safe）、
    /// 恰好 32 字节的原始文本。其它情况用 `blake3::derive_key` 拉伸。
    pub fn parse(raw: &str) -> Result<Self, CryptoError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(CryptoError::InvalidMasterKey(
                "环境变量 MASTER_KEY 为空；请用 `wrangler secret put MASTER_KEY` 配置".to_string(),
            ));
        }

        // 1) 64 字符 Hex
        if trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            let decoded = hex::decode(trimmed)
                .map_err(|e| CryptoError::InvalidMasterKey(format!("Hex 解码失败：{e}")))?;
            if decoded.len() == 32 {
                return Ok(Self {
                    bytes: to_array(decoded),
                });
            }
        }

        // 2) Base64（三种变体）
        for engine in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE_NO_PAD] {
            if let Ok(decoded) = engine.decode(trimmed)
                && decoded.len() == 32
            {
                return Ok(Self {
                    bytes: to_array(decoded),
                });
            }
        }

        // 3) 恰好 32 字节的原始文本
        let raw_bytes = trimmed.as_bytes();
        if raw_bytes.len() == 32 {
            return Ok(Self {
                bytes: to_array(raw_bytes.to_vec()),
            });
        }

        // 4) 其它长度：确定性拉伸（避免部署时因为长度不对直接 500）
        if raw_bytes.len() < 16 {
            return Err(CryptoError::InvalidMasterKey(
                "长度不足 16 字节；请提供 64 字符 Hex 或 32 字节 Base64".to_string(),
            ));
        }
        let derived = blake3::derive_key("cdt-monitor/master-key/v1", raw_bytes);
        Ok(Self { bytes: derived })
    }

    /// 从可选的环境变量值构造。
    pub fn from_optional(raw: Option<String>) -> Result<Self, CryptoError> {
        match raw {
            Some(value) => Self::parse(&value),
            None => Err(CryptoError::InvalidMasterKey(
                "未绑定 MASTER_KEY；请执行 `wrangler secret put MASTER_KEY`".to_string(),
            )),
        }
    }

    /// 从 Worker 绑定读取（secret 优先，其次 var）。
    pub fn from_env(env: &worker::Env) -> Result<Self, CryptoError> {
        let raw = env
            .secret("MASTER_KEY")
            .ok()
            .map(|s| s.to_string())
            .or_else(|| env.var("MASTER_KEY").ok().map(|v| v.to_string()));
        Self::from_optional(raw)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.bytes
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.bytes)
    }
}

fn to_array(bytes: Vec<u8>) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[..32]);
    out
}

// ===========================================================================
// 随机数
// ===========================================================================

/// 使用 Workers 运行时的 CSPRNG（`getrandom` 的 `js` 后端）填充缓冲区。
pub fn random_bytes(len: usize) -> Result<Vec<u8>, CryptoError> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).map_err(|e| CryptoError::RngFailed(format!("{e}")))?;
    Ok(buf)
}

/// 随机 UUIDv4 文本（用于 job_id 等非机密标识）。
pub fn random_id() -> Result<String, CryptoError> {
    let bytes = random_bytes(16)?;
    let mut b = [0u8; 16];
    b.copy_from_slice(&bytes);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    Ok(format!(
        "{}-{}-{}-{}-{}",
        hex::encode(&b[0..4]),
        hex::encode(&b[4..6]),
        hex::encode(&b[6..8]),
        hex::encode(&b[8..10]),
        hex::encode(&b[10..16])
    ))
}

/// 随机短 ID：给锁 owner、Token jti 用。
pub fn random_hex(len_bytes: usize) -> Result<String, CryptoError> {
    Ok(hex::encode(random_bytes(len_bytes)?))
}

// ===========================================================================
// 凭据加解密
// ===========================================================================

/// 凭据加解密器。内部持有一份 `XChaCha20Poly1305` 实例（构造代价极低）。
pub struct Crypto {
    key: MasterKey,
    cipher: XChaCha20Poly1305,
}

impl std::fmt::Debug for Crypto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Crypto(<redacted>)")
    }
}

impl Crypto {
    pub fn new(key: MasterKey) -> Self {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_bytes()));
        Self { key, cipher }
    }

    pub fn key(&self) -> &MasterKey {
        &self.key
    }

    /// 加密任意文本 -> `Base64(Nonce ‖ Ciphertext)`。
    pub fn encrypt(&self, plaintext: &str) -> Result<String, CryptoError> {
        let nonce_bytes = random_bytes(NONCE_LEN)?;
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| CryptoError::EncryptFailed(format!("{e}")))?;
        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        Ok(STANDARD.encode(out))
    }

    /// 解密 `Base64(Nonce ‖ Ciphertext)`。
    pub fn decrypt(&self, payload: &str) -> Result<String, CryptoError> {
        let raw = STANDARD
            .decode(payload.trim())
            .map_err(|e| CryptoError::DecryptFailed(format!("Base64 解码失败：{e}")))?;
        if raw.len() < NONCE_LEN + TAG_LEN {
            return Err(CryptoError::DecryptFailed(format!(
                "密文长度不足（{} 字节，至少 {} 字节）",
                raw.len(),
                NONCE_LEN + TAG_LEN
            )));
        }
        let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
        let nonce = XNonce::from_slice(nonce_bytes);
        let plaintext = self.cipher.decrypt(nonce, ciphertext).map_err(|_| {
            CryptoError::DecryptFailed("认证标签校验失败（MASTER_KEY 可能已更换）".to_string())
        })?;
        String::from_utf8(plaintext)
            .map_err(|e| CryptoError::DecryptFailed(format!("明文非 UTF-8：{e}")))
    }

    /// 解密失败时返回 `None`，用于「密钥轮换后旧密文」的平滑降级。
    pub fn try_decrypt(&self, payload: &str) -> Option<String> {
        self.decrypt(payload).ok()
    }

    /// 加密可选值：`None` 保持 `None`。
    pub fn encrypt_optional(&self, value: Option<&str>) -> Result<Option<String>, CryptoError> {
        match value.map(str::trim).filter(|v| !v.is_empty()) {
            Some(v) => Ok(Some(self.encrypt(v)?)),
            None => Ok(None),
        }
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ===========================================================================
// 无状态会话 Token
// ===========================================================================

/// Token 载荷（紧凑 JSON 后再 Base64URL，便于将来扩展字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenPayload {
    /// 版本号，当前固定为 1。
    v: u8,
    /// 签发时间（Unix 毫秒）。
    iat: i64,
    /// 过期时间（Unix 毫秒）。
    exp: i64,
    /// 随机 ID，避免同一秒内签发的 Token 完全相同。
    jti: String,
}

/// 验签结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenState {
    Valid { expires_at: i64 },
    Expired { expires_at: i64 },
    Invalid,
}

/// 会话 Token 签发 / 校验器。无状态：只依赖 `MASTER_KEY`。
pub struct SessionToken<'a> {
    key: &'a MasterKey,
}

impl<'a> SessionToken<'a> {
    pub fn new(key: &'a MasterKey) -> Self {
        Self { key }
    }

    /// 计算 HMAC-SHA256 签名。
    fn sign(&self, message: &[u8]) -> [u8; 32] {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(self.key.as_bytes())
            .expect("HMAC 接受任意长度密钥");
        mac.update(message);
        mac.finalize().into_bytes().into()
    }

    /// 签发 Token，`ttl_ms` 为有效期。
    pub fn issue(&self, now_ms: i64, ttl_ms: i64) -> Result<String, CryptoError> {
        let ttl = ttl_ms.clamp(60_000, 30 * 24 * 60 * 60 * 1000);
        let payload = TokenPayload {
            v: 1,
            iat: now_ms,
            exp: now_ms.saturating_add(ttl),
            jti: random_hex(8)?,
        };
        let json = serde_json::to_vec(&payload)
            .map_err(|e| CryptoError::EncryptFailed(format!("Token 载荷序列化失败：{e}")))?;
        let body = URL_SAFE_NO_PAD.encode(json);
        let signature = URL_SAFE_NO_PAD.encode(self.sign(body.as_bytes()));
        Ok(format!("v1.{body}.{signature}"))
    }

    /// 验签 + 检查过期时间。仅当签名合法时才判断过期。
    pub fn verify(&self, token: &str, now_ms: i64) -> TokenState {
        let mut parts = token.trim().split('.');
        let (version, body, signature) = match (parts.next(), parts.next(), parts.next()) {
            (Some(v), Some(b), Some(s)) if parts.next().is_none() => (v, b, s),
            _ => return TokenState::Invalid,
        };
        if version != "v1" {
            return TokenState::Invalid;
        }
        let provided = match URL_SAFE_NO_PAD.decode(signature) {
            Ok(raw) if raw.len() == 32 => raw,
            _ => return TokenState::Invalid,
        };
        let expected = self.sign(body.as_bytes());
        if !constant_time_eq(&provided, &expected) {
            return TokenState::Invalid;
        }
        let json = match URL_SAFE_NO_PAD.decode(body) {
            Ok(raw) => raw,
            Err(_) => return TokenState::Invalid,
        };
        let payload: TokenPayload = match serde_json::from_slice(&json) {
            Ok(p) => p,
            Err(_) => return TokenState::Invalid,
        };
        if payload.v != 1 {
            return TokenState::Invalid;
        }
        if payload.exp <= now_ms {
            return TokenState::Expired {
                expires_at: payload.exp,
            };
        }
        TokenState::Valid {
            expires_at: payload.exp,
        }
    }

    /// 便捷判断：Token 是否有效。
    pub fn is_valid(&self, token: &str, now_ms: i64) -> bool {
        matches!(self.verify(token, now_ms), TokenState::Valid { .. })
    }
}

// ===========================================================================
// Cookie 工具
// ===========================================================================

/// 构造 `Set-Cookie` 值。`max_age_seconds <= 0` 表示立即删除。
pub fn session_cookie(value: &str, max_age_seconds: i64) -> String {
    if max_age_seconds <= 0 {
        format!("{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict")
    } else {
        format!(
            "{SESSION_COOKIE}={value}; Path=/; Max-Age={max_age_seconds}; HttpOnly; Secure; SameSite=Strict"
        )
    }
}

/// 从 `Cookie` 请求头里提取会话 Token。
pub fn session_token_from_cookie(header: Option<&str>) -> Option<String> {
    let header = header?;
    for part in header.split(';') {
        let mut kv = part.splitn(2, '=');
        let name = kv.next()?.trim();
        if name != SESSION_COOKIE {
            continue;
        }
        let value = kv.next().unwrap_or("").trim();
        if value.is_empty() {
            return None;
        }
        return Some(value.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> MasterKey {
        MasterKey::parse("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
            .expect("测试密钥合法")
    }

    #[test]
    fn master_key_formats() {
        let hex_key = test_key();
        assert_eq!(hex_key.as_bytes()[0], 0x00);
        assert_eq!(hex_key.as_bytes()[31], 0xff);

        let b64 = STANDARD.encode(hex_key.as_bytes());
        let from_b64 = MasterKey::parse(&b64).expect("Base64 可用");
        assert_eq!(from_b64.as_bytes(), hex_key.as_bytes());

        let raw = "0123456789abcdef0123456789abcdef";
        let from_raw = MasterKey::parse(raw).expect("32 字节原文可用");
        assert_eq!(from_raw.as_bytes(), raw.as_bytes());

        assert!(MasterKey::parse("short").is_err());
        assert!(MasterKey::parse("").is_err());
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let crypto = Crypto::new(test_key());
        let secret = "LTAI-secret-中文-🔐";
        let ciphertext = crypto.encrypt(secret).expect("加密成功");
        assert_ne!(ciphertext, secret);
        let raw = STANDARD.decode(&ciphertext).expect("Base64");
        assert_eq!(raw.len(), NONCE_LEN + secret.len() + TAG_LEN);
        assert_eq!(crypto.decrypt(&ciphertext).expect("解密成功"), secret);
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let crypto = Crypto::new(test_key());
        let ciphertext = crypto.encrypt("token").expect("加密成功");
        let mut raw = STANDARD.decode(&ciphertext).expect("Base64");
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        let tampered = STANDARD.encode(raw);
        assert!(crypto.decrypt(&tampered).is_err());
        assert!(crypto.decrypt("not-base64!!").is_err());
    }

    #[test]
    fn token_roundtrip() {
        let key = test_key();
        let issuer = SessionToken::new(&key);
        let now = 1_700_000_000_000i64;
        let token = issuer.issue(now, 60_000).expect("签发成功");
        assert!(issuer.is_valid(&token, now + 1_000));
        assert_eq!(
            issuer.verify(&token, now + 1_000),
            TokenState::Valid {
                expires_at: now + 60_000
            }
        );
        assert_eq!(
            issuer.verify(&token, now + 120_000),
            TokenState::Expired {
                expires_at: now + 60_000
            }
        );
        assert_eq!(issuer.verify("v1.abc.def", now), TokenState::Invalid);
        assert_eq!(issuer.verify("v2.abc.def", now), TokenState::Invalid);
    }

    #[test]
    fn token_tamper_rejected() {
        let key = test_key();
        let issuer = SessionToken::new(&key);
        let now = 1_700_000_000_000i64;
        let token = issuer.issue(now, 60_000).expect("签发成功");
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged_payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&TokenPayload {
                v: 1,
                iat: now,
                exp: now + 99_999_999,
                jti: "forged".to_string(),
            })
            .expect("序列化"),
        );
        parts[1] = &forged_payload;
        let forged = parts.join(".");
        assert_eq!(issuer.verify(&forged, now), TokenState::Invalid);
    }

    #[test]
    fn different_key_cannot_verify() {
        let other =
            MasterKey::parse("ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100")
                .expect("合法");
        let token = SessionToken::new(&test_key())
            .issue(1_700_000_000_000, 60_000)
            .expect("签发");
        assert!(!SessionToken::new(&other).is_valid(&token, 1_700_000_000_001));
    }

    #[test]
    fn cookie_helpers() {
        let cookie = session_cookie("abc", 3600);
        assert!(cookie.contains("cdt_session=abc"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(session_cookie("", 0).contains("Max-Age=0"));

        assert_eq!(
            session_token_from_cookie(Some("foo=1; cdt_session=xyz; bar=2")),
            Some("xyz".to_string())
        );
        assert_eq!(session_token_from_cookie(Some("foo=1")), None);
        assert_eq!(session_token_from_cookie(None), None);
    }

    #[test]
    fn random_ids_are_unique() {
        let a = random_id().expect("随机 ID");
        let b = random_id().expect("随机 ID");
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(random_hex(4).expect("随机 Hex").len(), 8);
    }
}
