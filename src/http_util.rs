//! 本地 HTTP 服务的纯工具层：令牌、路由响应、静态文件、请求体读取。
//! 不依赖 GTK 状态，便于单测与后续把 server 循环拆出 main.rs。

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use tiny_http::Request;

const MAX_REQUEST_BYTES: usize = 512 * 1024;

/// 每次启动生成的一次性令牌：只注入到同源页面，用于挡住其他网页对本地端口的 CSRF。
pub(crate) fn session_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    fn digest(seed: u128) -> u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(seed);
        hasher.write_u32(std::process::id());
        hasher.finish()
    }

    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!(
        "{:016x}{:016x}",
        digest(nanos),
        digest(nanos ^ 0x9e37_79b9_7f4a_7c15)
    )
}

fn header_value(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.to_string().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str().to_string())
}

/// 只接受来自本机回环地址的 Host，避免 DNS rebinding 把公网域名指到 127.0.0.1。
fn host_is_local(request: &Request) -> bool {
    let Some(host) = header_value(request, "Host") else {
        return false;
    };
    let host = host.trim().to_ascii_lowercase();
    let host = host.split(':').next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// 敏感写接口必须携带本次启动注入到页面里的令牌。
pub(crate) fn request_is_authorized(request: &Request, token: &str) -> bool {
    host_is_local(request)
        && header_value(request, "X-AnimePet-Token")
            .map(|value| value == token)
            .unwrap_or(false)
}

pub(crate) fn respond_text(request: Request, status: u16, body: &str) {
    let _ = request.respond(tiny_http::Response::from_string(body).with_status_code(status));
}

pub(crate) fn respond_json(request: Request, status: u16, body: &str) {
    let header = tiny_http::Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .unwrap();
    let _ = request.respond(
        tiny_http::Response::from_string(body)
            .with_status_code(status)
            .with_header(header),
    );
}

pub(crate) fn read_request_body(request: &mut Request) -> Result<String, String> {
    let bytes = read_request_bytes(request, MAX_REQUEST_BYTES)?;
    String::from_utf8(bytes).map_err(|error| format!("请求体不是有效 UTF-8: {error}"))
}

pub(crate) fn read_request_bytes(
    request: &mut Request,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() > max_bytes {
        return Err(format!("请求体过大（最多 {} 字节）", max_bytes));
    }
    Ok(body)
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

fn percent_decode_path(path: &str) -> Option<String> {
    fn hex_digit(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }

    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_digit(bytes[index + 1])?;
            let low = hex_digit(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn safe_static_path(root: &str, url: &str) -> Option<PathBuf> {
    let raw_path = url.split('?').next().unwrap_or("/");
    let decoded_path = percent_decode_path(raw_path)?;
    if decoded_path.contains('\\') {
        return None;
    }
    let relative = decoded_path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    for component in Path::new(relative).components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return None;
        }
    }
    let root = Path::new(root).canonicalize().ok()?;
    let candidate = root.join(relative).canonicalize().ok()?;
    candidate.starts_with(&root).then_some(candidate)
}

pub(crate) fn serve_file(request: Request, root: &str, token: &str) {
    if request.method() != &tiny_http::Method::Get {
        let _ = request.respond(
            tiny_http::Response::from_string("405 Method Not Allowed").with_status_code(405),
        );
        return;
    }
    let Some(full_path) = safe_static_path(root, request.url()) else {
        let _ = request
            .respond(tiny_http::Response::from_string("404 Not Found").with_status_code(404));
        return;
    };
    match std::fs::read(&full_path) {
        Ok(data) => {
            let is_html = full_path.extension().and_then(|value| value.to_str()) == Some("html");
            let data = if is_html {
                match String::from_utf8(data) {
                    Ok(text) => text.replace("__ANIMEPET_TOKEN__", token).into_bytes(),
                    Err(error) => error.into_bytes(),
                }
            } else {
                data
            };
            let header = tiny_http::Header::from_bytes(
                &b"Content-Type"[..],
                content_type_for(&full_path).as_bytes(),
            )
            .unwrap();
            let mut response = tiny_http::Response::from_data(data).with_header(header);
            if let Ok(cache) =
                tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..])
            {
                response.add_header(cache);
            }
            let _ = request.respond(response);
        }
        Err(_) => {
            let _ = request
                .respond(tiny_http::Response::from_string("404 Not Found").with_status_code(404));
        }
    }
}

/// 由前端提交的输入热区集合：各矩形以 CSS 像素给出，分号分隔。
pub(crate) fn parse_region_spec(spec: &str) -> Vec<(i32, i32, i32, i32)> {
    spec.split(';')
        .filter_map(|part| {
            let nums: Vec<i32> = part
                .split(',')
                .filter_map(|value| value.trim().parse::<i32>().ok())
                .collect();
            if nums.len() == 4 && nums[2] > 0 && nums[3] > 0 {
                Some((nums[0], nums[1], nums[2], nums[3]))
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{parse_region_spec, safe_static_path, session_token};

    #[test]
    fn parses_overlay_region_specs() {
        let rects = parse_region_spec("5,10,280,314;300,400,352,410");
        assert_eq!(rects, vec![(5, 10, 280, 314), (300, 400, 352, 410)]);
        assert!(parse_region_spec("0,0,0,0;bad;1,2,3").is_empty());
        assert_eq!(parse_region_spec("1,2,3,4;").len(), 1);
    }

    #[test]
    fn session_tokens_are_hex_and_distinct() {
        let first = session_token();
        let second = session_token();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn rejects_invalid_or_traversing_static_paths() {
        let root = env!("CARGO_MANIFEST_DIR");
        assert!(safe_static_path(root, "/../config.toml").is_none());
        assert!(safe_static_path(root, "/%2e%2e/config.toml").is_none());
        assert!(safe_static_path(root, "/katoumegumi/../config.toml").is_none());
    }
}
