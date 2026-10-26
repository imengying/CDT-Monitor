//! # 客户端识别
//!
//! 从请求头提取来源 IP、User-Agent，并转成可读的设备标签。
//! 仅用于展示与审计，不参与鉴权判断。

use worker::Request;

/// 请求的客户端 IP（Cloudflare 提供）。
pub(crate) fn client_ip(req: &Request) -> Option<String> {
    for header in ["CF-Connecting-IP", "X-Forwarded-For"] {
        if let Ok(Some(value)) = req.headers().get(header) {
            let first = value.split(',').next().unwrap_or("").trim();
            if !first.is_empty() {
                return Some(first.to_string());
            }
        }
    }
    None
}

/// 取 `User-Agent`，截断到 512 字节避免超长入库。
pub(crate) fn client_ua(req: &Request) -> String {
    req.headers()
        .get("User-Agent")
        .ok()
        .flatten()
        .map(|v| v.chars().take(512).collect::<String>())
        .unwrap_or_default()
}

/// 从 UA 里提炼可读的设备名，用于列表展示。
///
/// 只做粗粒度识别：浏览器 + 平台足够区分多台设备，不必引入 UA 解析库。
pub(crate) fn short_device(ua: &str) -> String {
    let lower = ua.to_ascii_lowercase();

    let browser = if lower.contains("edg/") {
        "Edge"
    } else if lower.contains("chrome/") && !lower.contains("chromium") {
        "Chrome"
    } else if lower.contains("firefox/") {
        "Firefox"
    } else if lower.contains("safari/") {
        "Safari"
    } else if lower.contains("curl/") {
        "curl"
    } else if lower.contains("python") {
        "Python"
    } else if lower.is_empty() {
        "未知客户端"
    } else {
        "其他"
    };

    let platform = if lower.contains("iphone") {
        "iPhone"
    } else if lower.contains("ipad") {
        "iPad"
    } else if lower.contains("android") {
        "Android"
    } else if lower.contains("mac os x") || lower.contains("macintosh") {
        "macOS"
    } else if lower.contains("windows") {
        "Windows"
    } else if lower.contains("linux") {
        "Linux"
    } else {
        ""
    };

    if platform.is_empty() {
        browser.to_string()
    } else {
        format!("{browser} · {platform}")
    }
}

/// 掩码 IP：保留前两段，其余用 `*`，避免在界面上完整暴露来源地址。
pub(crate) fn short_ip(ip: &str) -> String {
    if ip.is_empty() {
        return "未知来源".to_string();
    }
    if ip.contains(':') {
        // IPv6 只留前 4 组
        let head: Vec<&str> = ip.split(':').filter(|s| !s.is_empty()).take(2).collect();
        return format!("{}::*", head.join(":"));
    }
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() == 4 {
        format!("{}.{}.*.*", parts[0], parts[1])
    } else {
        ip.to_string()
    }
}

/// 取 `Origin` 的 host 部分。
pub(crate) fn origin_host(req: &Request) -> Option<String> {
    let origin = req.headers().get("Origin").ok().flatten()?;
    url::Url::parse(origin.trim())
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_ascii_lowercase()))
}

/// 取 `Referer` 的 host 部分。
pub(crate) fn referer_host(req: &Request) -> Option<String> {
    let referer = req.headers().get("Referer").ok().flatten()?;
    url::Url::parse(referer.trim())
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_ascii_lowercase()))
}

/// 请求自身的 host。
pub(crate) fn request_host(req: &Request) -> Option<String> {
    req.url()
        .ok()
        .and_then(|parsed| parsed.host_str().map(|h| h.to_ascii_lowercase()))
}

/// 写接口的纵深防御：拒绝跨站来源。
///
/// `SameSite=Strict` 已经挡住浏览器发起的跨站 Cookie，这里再挡一层，
/// 覆盖老浏览器与 `SameSite` 被忽略的场景。
pub(crate) fn same_origin_ok(req: &Request) -> bool {
    if let Ok(Some(site)) = req.headers().get("Sec-Fetch-Site") {
        let site = site.trim().to_ascii_lowercase();
        if site == "cross-site" {
            return false;
        }
    }

    let Some(host) = request_host(req) else {
        return true;
    };
    if let Some(origin) = origin_host(req)
        && origin != host
    {
        return false;
    }
    if origin_host(req).is_none()
        && let Some(referer) = referer_host(req)
        && referer != host
    {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_name_from_user_agent() {
        let chrome_mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        assert_eq!(short_device(chrome_mac), "Chrome · macOS");

        let safari_iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) \
                             AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        assert_eq!(short_device(safari_iphone), "Safari · iPhone");

        let edge_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                        (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
        assert_eq!(short_device(edge_win), "Edge · Windows");

        assert_eq!(short_device("curl/8.4.0"), "curl");
        assert_eq!(short_device(""), "未知客户端");
    }

    #[test]
    fn ip_is_masked() {
        assert_eq!(short_ip("203.0.113.42"), "203.0.*.*");
        assert_eq!(short_ip("2001:db8:85a3::8a2e:370:7334"), "2001:db8::*");
        assert_eq!(short_ip(""), "未知来源");
    }
}
