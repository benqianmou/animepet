use gtk::prelude::*;
use gtk::{Application, ApplicationWindow};
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{
    Arc, Mutex,
    mpsc::{self, Receiver, Sender},
};
use std::time::{Duration, SystemTime};
use webkit2gtk::{SettingsExt, WebView, WebViewExt};

// 资源路径：编译时嵌入项目根目录，资源自包含在 assets/katoumegumi 下
const LIVE2D_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/katoumegumi");

// 模型尺寸与初始位置（需与 assets/katoumegumi/index.html 中 #landlord 的 CSS 保持一致）
const MODEL_WIDTH: i32 = 280;
const MODEL_HEIGHT: i32 = 250;
const MODEL_HIT_PADDING: i32 = 14;
const INIT_LEFT: i32 = 5; // message.js 无历史位置时默认 left:5px
const INIT_BOTTOM: i32 = 0;
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CHAT_SERVER_PORT: u16 = 17_364;
const MAX_HISTORY_MESSAGES: usize = 40;
const MAX_MEMORY_BYTES: usize = 1024 * 1024;
const MAX_IDENTITY_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
struct AppConfig {
    api_key: String,
    #[serde(default = "default_base_url")]
    base_url: String,
    #[serde(default = "default_model")]
    model: String,
    #[serde(default)]
    tts_enabled: bool,
    #[serde(default = "default_tts_base_url")]
    tts_base_url: String,
    #[serde(default)]
    tts_ref_audio: String,
    #[serde(default)]
    tts_prompt_text: String,
    #[serde(default = "default_tts_prompt_lang")]
    tts_prompt_lang: String,
}
fn default_base_url() -> String {
    "https://api.deepseek.com".into()
}
fn default_model() -> String {
    "deepseek-chat".into()
}
fn default_tts_base_url() -> String {
    "http://127.0.0.1:9880".into()
}
fn default_tts_prompt_lang() -> String {
    "ja".into()
}

#[derive(Clone, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}
#[derive(Deserialize)]
struct ChatRequest {
    message: String,
    #[serde(default = "default_soul_model")]
    model: String,
}

fn default_soul_model() -> String {
    "katoumegumi".into()
}

#[derive(Deserialize)]
struct TtsRequest {
    text: String,
}

fn http_agent() -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .timeout_connect(Some(HTTP_CONNECT_TIMEOUT))
        .timeout_resolve(Some(HTTP_CONNECT_TIMEOUT))
        .build();
    config.into()
}

struct StreamReader {
    rx: Receiver<Vec<u8>>,
    pending: Vec<u8>,
}
impl Read for StreamReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pending.is_empty() {
            self.pending = self.rx.recv().unwrap_or_default();
        }
        if self.pending.is_empty() {
            return Ok(0);
        }
        let n = out.len().min(self.pending.len());
        out[..n].copy_from_slice(&self.pending[..n]);
        self.pending.drain(..n);
        Ok(n)
    }
}

fn load_config() -> Result<AppConfig, String> {
    let text = std::fs::read_to_string(format!("{}/config.toml", env!("CARGO_MANIFEST_DIR")))
        .map_err(|_| {
            "缺少 config.toml。请复制 config.toml.example 并填写 DeepSeek API Key。".to_string()
        })?;
    toml::from_str(&text).map_err(|e| format!("config.toml 格式错误: {e}"))
}

fn load_prompt_file(name: &str) -> String {
    std::fs::read_to_string(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), name)).unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
struct SoulDocument {
    frontmatter: String,
    body: String,
}

/// Split a skill-style document into its lightweight index and body.
fn split_soul_document(source: &str) -> SoulDocument {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let Some(after_open) = source
        .strip_prefix("---\n")
        .or_else(|| source.strip_prefix("---\r\n"))
    else {
        return SoulDocument {
            frontmatter: String::new(),
            body: source.trim().to_string(),
        };
    };
    let Some(close_start) = after_open.find("\n---") else {
        return SoulDocument {
            frontmatter: String::new(),
            body: source.trim().to_string(),
        };
    };
    let frontmatter = after_open[..close_start].trim().to_string();
    let mut body = &after_open[close_start + "\n---".len()..];
    body = body
        .strip_prefix("\r\n")
        .or_else(|| body.strip_prefix('\n'))
        .unwrap_or(body);
    SoulDocument {
        frontmatter,
        body: body.trim().to_string(),
    }
}

fn soul_file_for_model(model_id: &str) -> &'static str {
    match model_id {
        "rem" => "souls/rem/SOUL.md",
        _ => "souls/katoumegumi/SOUL.md",
    }
}

fn load_soul_for_model(model_id: &str) -> String {
    let document = split_soul_document(&load_prompt_file(soul_file_for_model(model_id)));
    let frontmatter = if document.frontmatter.is_empty() {
        "id: unknown\nload: body"
    } else {
        &document.frontmatter
    };
    format!(
        "当前角色 frontmatter（身份索引）：\n{frontmatter}\n\n当前角色正文（按模型选择加载）：\n{}",
        document.body
    )
}

const IDENTITY_OPEN: &str = "<identity_update>";
const IDENTITY_CLOSE: &str = "</identity_update>";

fn extract_identity_update(response: &str) -> (String, Option<String>) {
    let Some(start) = response.find(IDENTITY_OPEN) else {
        return (response.to_string(), None);
    };
    let content_start = start + IDENTITY_OPEN.len();
    let Some(end_offset) = response[content_start..].find(IDENTITY_CLOSE) else {
        return (response.to_string(), None);
    };
    let end = content_start + end_offset;
    let update = response[content_start..end].trim();
    let mut clean = String::with_capacity(response.len());
    clean.push_str(response[..start].trim_end());
    clean.push_str(response[end + IDENTITY_CLOSE.len()..].trim_start());
    let update = (!update.is_empty()).then(|| update.to_string());
    (clean.trim().to_string(), update)
}

fn append_identity_update(update: &str) {
    let update = update.trim();
    if update.is_empty() {
        return;
    }

    // Keep accidental verbose output from growing the local profile without bound.
    let update: String = update.chars().take(2_000).collect();
    let path = format!("{}/IDENTITY.md", env!("CARGO_MANIFEST_DIR"));
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.contains(&update) {
        return;
    }

    let section = format!("\n## 对话提取 [{}]\n{}\n", chrono_like_now(), update);
    if let Err(error) = append_bounded_file(Path::new(&path), &section, MAX_IDENTITY_BYTES) {
        eprintln!("无法写入身份记录: {error}");
    }
}

fn append_bounded_file(path: &Path, entry: &str, max_bytes: usize) -> Result<(), String> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut combined = String::with_capacity(existing.len() + entry.len());
    combined.push_str(&existing);
    combined.push_str(entry);
    if combined.len() > max_bytes {
        let mut start = combined.len() - max_bytes;
        while start < combined.len() && !combined.is_char_boundary(start) {
            start += 1;
        }
        if let Some(newline) = combined[start..].find('\n') {
            start += newline + 1;
        }
        combined = combined[start..].to_string();
    }
    std::fs::write(path, combined).map_err(|error| error.to_string())
}

fn emit_stream_delta(response: &str, emitted_len: &mut usize, tx: &Sender<Vec<u8>>) {
    let safe_end = if let Some(marker_start) = response.find(IDENTITY_OPEN) {
        marker_start
    } else {
        // Hold a short suffix so a marker split across network chunks stays hidden.
        let hold = IDENTITY_OPEN.len().saturating_sub(1);
        let mut end = response.len().saturating_sub(hold);
        while end > 0 && !response.is_char_boundary(end) {
            end -= 1;
        }
        end
    };
    if safe_end > *emitted_len {
        json_event(tx, "delta", &response[*emitted_len..safe_end]);
        *emitted_len = safe_end;
    }
}

fn json_event(tx: &Sender<Vec<u8>>, kind: &str, text: &str) {
    let body = serde_json::json!({"type": kind, "text": text}).to_string() + "\n";
    let _ = tx.send(body.into_bytes());
}

fn process_stream_line(
    line: &str,
    answer: &mut String,
    emitted_len: &mut usize,
    tx: &Sender<Vec<u8>>,
) {
    let data = line.trim().strip_prefix("data: ").unwrap_or("");
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data)
        && let Some(delta) = value["choices"][0]["delta"]["content"].as_str()
    {
        answer.push_str(delta);
        emit_stream_delta(answer, emitted_len, tx);
    }
}

fn stream_chat(req: ChatRequest, tx: Sender<Vec<u8>>, history: Arc<Mutex<Vec<ChatMessage>>>) {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            json_event(&tx, "error", &e);
            return;
        }
    };
    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: format!(
            "{}\n\n用户身份信息（仅记录用户明确提供的事实和偏好）：\n{}\n\n长期记忆：\n{}\n\n身份记录规则：\n- 你不能直接操作文件；如果本轮对话中用户明确提供了姓名、称呼、地区、职业、兴趣、偏好、习惯或其他个人信息，请在正常回复末尾追加一段 <identity_update>...</identity_update>。\n- 标记内部只写简洁的 Markdown 条目，不要写推测、敏感信息、密码、API 密钥或用户没有明确说过的内容。\n- 如果没有新的用户信息，不要输出该标记。标记之外只放给用户看的正常回复。",
            load_soul_for_model(&req.model),
            load_prompt_file("IDENTITY.md"),
            load_prompt_file("MEMORY.md")
        ),
    }];
    let mut guard = history.lock().unwrap();
    messages.extend(guard.clone());
    messages.push(ChatMessage {
        role: "user".into(),
        content: req.message.clone(),
    });
    drop(guard);
    let url = format!(
        "{}/v1/chat/completions",
        config.base_url.trim_end_matches('/')
    );
    let agent = http_agent();
    let response = agent
        .post(&url)
        .header("Authorization", &format!("Bearer {}", config.api_key))
        .send_json(
            serde_json::json!({"model": config.model, "messages": messages, "stream": true}),
        );
    let mut response = match response {
        Ok(r) => r,
        Err(e) => {
            json_event(&tx, "error", &format!("请求 DeepSeek 失败: {e}"));
            return;
        }
    };
    let mut response_reader = response.body_mut().as_reader();
    let mut buf = Vec::new();
    let mut answer = String::new();
    let mut emitted_len = 0;
    let mut bytes = [0u8; 4096];
    loop {
        let n = match response_reader.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                json_event(&tx, "error", &e.to_string());
                return;
            }
        };
        buf.extend_from_slice(&bytes[..n]);
        while let Some(pos) = buf.iter().position(|byte| *byte == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = match String::from_utf8(line_bytes) {
                Ok(line) => line,
                Err(error) => {
                    json_event(&tx, "error", &format!("DeepSeek 返回了无效 UTF-8: {error}"));
                    return;
                }
            };
            process_stream_line(&line, &mut answer, &mut emitted_len, &tx);
        }
    }
    if !buf.is_empty() {
        let line = match String::from_utf8(buf) {
            Ok(line) => line,
            Err(error) => {
                json_event(&tx, "error", &format!("DeepSeek 返回了无效 UTF-8: {error}"));
                return;
            }
        };
        process_stream_line(&line, &mut answer, &mut emitted_len, &tx);
    }
    if !answer.is_empty() {
        let (clean_answer, identity_update) = extract_identity_update(&answer);
        if let Some(update) = identity_update {
            append_identity_update(&update);
        }
        guard = history.lock().unwrap();
        guard.push(ChatMessage {
            role: "user".into(),
            content: req.message.clone(),
        });
        guard.push(ChatMessage {
            role: "assistant".into(),
            content: clean_answer.clone(),
        });
        if guard.len() > MAX_HISTORY_MESSAGES {
            let excess = guard.len() - MAX_HISTORY_MESSAGES;
            guard.drain(..excess);
        }
        let stamp = format!(
            "\n- [{}] 用户：{}\n  AnimePet：{}\n",
            chrono_like_now(),
            req.message,
            clean_answer
        );
        let memory_path = format!("{}/MEMORY.md", env!("CARGO_MANIFEST_DIR"));
        if let Err(error) = append_bounded_file(Path::new(&memory_path), &stamp, MAX_MEMORY_BYTES) {
            eprintln!("无法写入对话记忆: {error}");
        }
        json_event(&tx, "done", &clean_answer);
    } else {
        json_event(&tx, "done", "");
    }
}

fn contains_japanese(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{3040}'..='\u{30ff}' | '\u{31f0}'..='\u{31ff}'))
}

fn normalize_language(language: &str) -> Result<&'static str, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "ja" | "jp" | "日语" | "日文" => Ok("ja"),
        "zh" | "中文" | "汉语" | "漢語" => Ok("zh"),
        "en" | "english" | "英语" | "英文" => Ok("en"),
        _ => Err(format!(
            "不支持的 TTS 参考语言: {language}（请使用 ja、zh 或 en）"
        )),
    }
}

fn resolve_tts_reference_path(reference: &str) -> String {
    let reference = Path::new(reference.trim());
    if reference.is_absolute() {
        return reference.to_string_lossy().into_owned();
    }

    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(reference)
        .to_string_lossy()
        .into_owned()
}

fn synthesize_speech(req: TtsRequest) -> Result<(Vec<u8>, &'static str), String> {
    let config = load_config()?;
    synthesize_speech_with_config(req, config)
}

fn synthesize_speech_with_config(
    req: TtsRequest,
    config: AppConfig,
) -> Result<(Vec<u8>, &'static str), String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err("TTS 文本为空".into());
    }
    if text.chars().count() > 40_000 {
        return Err("TTS 文本过长（最多 40000 个字符）".into());
    }
    let text_lang = if contains_japanese(text) { "ja" } else { "zh" };
    if !config.tts_enabled {
        return synthesize_speech_fallback(text, text_lang).map(|audio| (audio, "fallback"));
    }
    if config.tts_ref_audio.trim().is_empty() || config.tts_prompt_text.trim().is_empty() {
        return Err("已启用加藤惠语音，但缺少 tts_ref_audio 或 tts_prompt_text 配置".into());
    }
    let prompt_lang = normalize_language(&config.tts_prompt_lang)?;
    let ref_audio_path = resolve_tts_reference_path(&config.tts_ref_audio);
    let url = format!("{}/tts", config.tts_base_url.trim_end_matches('/'));
    let payload = serde_json::json!({
        "text": text,
        "text_lang": text_lang,
        "ref_audio_path": ref_audio_path,
        "prompt_text": config.tts_prompt_text,
        "prompt_lang": prompt_lang,
        "text_split_method": "cut5",
        "batch_size": 1,
        "speed_factor": 1.0,
        "media_type": "wav",
        "streaming_mode": false,
    });
    let agent = http_agent();
    let mut response = match agent
        .post(&url)
        .header("Content-Type", "application/json")
        .send_json(&payload)
    {
        Ok(response) => response,
        Err(error) => {
            return Err(format!(
                "加藤惠语音服务不可用: {error}。请先运行 bash scripts/start-gpt-sovits.sh"
            ));
        }
    };
    let audio = response
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(|error| format!("读取 GPT-SoVITS 音频失败: {error}"))?;
    if !is_wav_audio(&audio) {
        return Err("GPT-SoVITS 未返回有效 WAV 音频，请检查服务日志和参考音频配置".into());
    }
    Ok((audio, "gpt-sovits"))
}

fn is_wav_audio(audio: &[u8]) -> bool {
    audio.len() >= 12 && &audio[..4] == b"RIFF" && &audio[8..12] == b"WAVE"
}

fn synthesize_speech_fallback(text: &str, text_lang: &str) -> Result<Vec<u8>, String> {
    let voice = if text_lang == "ja" { "ja" } else { "zh" };
    let limited_text: String = text.chars().take(2_000).collect();
    let output = Command::new("espeak-ng")
        .arg("--stdout")
        .arg("-v")
        .arg(voice)
        .arg("-s")
        .arg("150")
        .arg(limited_text)
        .output()
        .map_err(|e| format!("GPT-SoVITS 不可用，且无法启动 espeak-ng 兜底: {e}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("GPT-SoVITS 不可用，espeak-ng 兜底失败: {stderr}"));
    }
    Ok(output.stdout)
}

fn chrono_like_now() -> String {
    format!("{:?}", SystemTime::now())
}

fn start_chat_server(root: &str, history: Arc<Mutex<Vec<ChatMessage>>>) -> u16 {
    // A stable origin lets WebKit persist model selection in localStorage across restarts.
    // Fall back to an ephemeral port if another AnimePet instance already owns it.
    let server = tiny_http::Server::http(format!("127.0.0.1:{CHAT_SERVER_PORT}"))
        .or_else(|_| tiny_http::Server::http("127.0.0.1:0"))
        .expect("failed to bind local server");
    let port = server.server_addr().to_ip().unwrap().port();
    let root = root.to_string();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let route = request.url().split('?').next().unwrap_or("");
            if route == "/tts" && request.method() == &tiny_http::Method::Post {
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        let _ = request
                            .respond(tiny_http::Response::from_string(error).with_status_code(413));
                        continue;
                    }
                };
                std::thread::spawn(move || {
                    match serde_json::from_str::<TtsRequest>(&body)
                        .map_err(|e| e.to_string())
                        .and_then(synthesize_speech)
                    {
                        Ok((audio, lang)) => {
                            let header = tiny_http::Header::from_bytes(
                                &b"Content-Type"[..],
                                &b"audio/wav"[..],
                            )
                            .unwrap();
                            let voice_header = tiny_http::Header::from_bytes(
                                &b"X-AnimePet-TTS"[..],
                                lang.as_bytes(),
                            )
                            .unwrap();
                            let _ = request.respond(
                                tiny_http::Response::from_data(audio)
                                    .with_header(header)
                                    .with_header(voice_header),
                            );
                        }
                        Err(error) => {
                            let _ = request.respond(
                                tiny_http::Response::from_string(error).with_status_code(503),
                            );
                        }
                    }
                });
            } else if route == "/chat" && request.method() == &tiny_http::Method::Post {
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        let _ = request
                            .respond(tiny_http::Response::from_string(error).with_status_code(413));
                        continue;
                    }
                };
                let parsed = serde_json::from_str::<ChatRequest>(&body);
                if let Ok(chat) = parsed {
                    let (tx, rx) = mpsc::channel();
                    let history_ref = history.clone();
                    std::thread::spawn(move || stream_chat(chat, tx, history_ref));
                    let header = tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        &b"application/x-ndjson"[..],
                    )
                    .unwrap();
                    let response = tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        vec![header],
                        StreamReader {
                            rx,
                            pending: vec![],
                        },
                        None,
                        None,
                    );
                    let _ = request.respond(response);
                } else {
                    let _ = request.respond(
                        tiny_http::Response::from_string("bad request").with_status_code(400),
                    );
                }
            } else {
                serve_file(request, &root);
            }
        }
    });
    port
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

fn read_request_body(request: &mut tiny_http::Request) -> Result<String, String> {
    let mut body = String::new();
    request
        .as_reader()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(format!("请求体过大（最多 {} 字节）", MAX_REQUEST_BYTES));
    }
    Ok(body)
}

fn serve_file(request: tiny_http::Request, root: &str) {
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
            let header = tiny_http::Header::from_bytes(
                &b"Content-Type"[..],
                content_type_for(&full_path).as_bytes(),
            )
            .unwrap();
            let _ = request.respond(tiny_http::Response::from_data(data).with_header(header));
        }
        Err(_) => {
            let _ = request
                .respond(tiny_http::Response::from_string("404 Not Found").with_status_code(404));
        }
    }
}

/// 将输入热区设置为以 (left, bottom) 为左下角、大小为模型尺寸的矩形。
/// left/bottom 是 JS 侧 #landlord 的 CSS 值（相对窗口左/底），需换算为窗口坐标。
fn apply_input_region(window: &ApplicationWindow, left: i32, bottom: i32) {
    let (_, win_h) = window.size();
    let x = left - MODEL_HIT_PADDING;
    let y = win_h - bottom - MODEL_HEIGHT - MODEL_HIT_PADDING;
    let width = MODEL_WIDTH + MODEL_HIT_PADDING * 2;
    let height = MODEL_HEIGHT + MODEL_HIT_PADDING * 2;
    let rect = cairo::RectangleInt::new(x, y, width, height);
    let region = cairo::Region::create_rectangle(&rect);
    window.input_shape_combine_region(Some(&region));
    println!("Input region: x={} y={} {}x{}", x, y, width, height);
}

fn setup_input_region(window: &ApplicationWindow) {
    apply_input_region(window, INIT_LEFT, INIT_BOTTOM);
}

fn main() {
    // 仅在未设置时提供默认值，避免覆盖真实会话环境（如 wayland-0 或 X11 会话）
    unsafe {
        if std::env::var("WAYLAND_DISPLAY").is_err() {
            std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        }
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "wayland");
        }
    }

    let app = Application::builder()
        .application_id("com.animepet.desktop")
        .build();

    app.connect_activate(build_ui);

    println!("Application starting...");
    app.run();
}

fn build_ui(app: &Application) {
    println!("build_ui called");

    let window = ApplicationWindow::builder()
        .application(app)
        .default_width(280)
        .default_height(250)
        .decorated(false)
        .build();

    println!("Window created");

    // 关键：让 GTK 不绘制窗口默认背景，配合 RGBA visual 实现透明
    window.set_app_paintable(true);

    // 设置 RGBA visual 以支持透明背景（只显示模型，不显示窗口背景）
    if let Some(screen) = gtk::gdk::Screen::default()
        && let Some(visual) = screen.rgba_visual()
    {
        window.set_visual(Some(&visual));
        println!("RGBA visual set for transparency");
    }

    // layer-shell：全屏 Overlay 层，跨所有工作区 + 始终置顶
    // 模型（#landlord）在全屏窗口内可自由拖拽到任意位置
    window.init_layer_shell();
    window.set_namespace("animepet");
    window.set_layer(Layer::Overlay);
    window.set_keyboard_mode(KeyboardMode::None);
    for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
        window.set_anchor(edge, true);
    }
    window.set_exclusive_zone(0);
    println!("Layer shell configured (fullscreen Overlay layer, cross-workspace)");

    let webview = WebView::new();
    println!("WebView created");

    // 设置 WebView 背景为完全透明，只渲染 HTML 内容
    webview.set_background_color(&gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
    println!("WebView background set to transparent");

    // 启用开发者工具和控制台输出
    if let Some(settings) = webkit2gtk::WebViewExt::settings(&webview) {
        settings.set_enable_developer_extras(true);
        settings.set_enable_write_console_messages_to_stdout(true);
        settings.set_allow_file_access_from_file_urls(true);
        settings.set_allow_universal_access_from_file_urls(true);
        settings.set_media_playback_requires_user_gesture(false);
        println!("WebView settings configured");
    }

    let history: Arc<Mutex<Vec<ChatMessage>>> = Arc::new(Mutex::new(Vec::new()));
    let port = start_chat_server(LIVE2D_PATH, history);
    let html_path = format!("http://127.0.0.1:{}/index.html", port);
    println!("Loading HTML from: {}", html_path);
    webview.load_uri(&html_path);

    window.add(&webview);
    println!("WebView added to window");

    // 监听 title 变化（JS 拖拽通信，格式见 index.html）：
    //   drag_start        — 拖拽开始
    //   drag_end:l,b      — 拖拽结束，模型位于 (left=l, bottom=b)
    //   restore:l,b       — 页面加载后恢复上次拖拽位置
    {
        let window_ref = window.clone();
        let webview_ref = webview.clone();
        webview.connect_title_notify(move |wv| {
            let title = wv
                .title()
                .map(|t| t.as_str().to_string())
                .unwrap_or_default();
            if title == "drag_start" {
                // 拖拽开始：扩大输入区域到全屏，避免拖拽时鼠标移出热区导致中断
                window_ref.input_shape_combine_region(None);
                println!("Drag started: input region cleared (fullscreen input)");
            } else if title == "chat_open" {
                window_ref.input_shape_combine_region(None);
                window_ref.set_keyboard_mode(KeyboardMode::OnDemand);
                window_ref.present();
                webview_ref.grab_focus();
                println!("Chat opened: input region cleared (fullscreen input)");
            } else if let Some(rest) = title.strip_prefix("chat_close:") {
                window_ref.set_keyboard_mode(KeyboardMode::None);
                let parts: Vec<&str> = rest.split(',').collect();
                if parts.len() == 2 {
                    let left: i32 = parts[0].parse().unwrap_or(INIT_LEFT);
                    let bottom: i32 = parts[1].parse().unwrap_or(INIT_BOTTOM);
                    apply_input_region(&window_ref, left, bottom);
                } else {
                    setup_input_region(&window_ref);
                }
            } else if let Some(rest) = title
                .strip_prefix("drag_end:")
                .or_else(|| title.strip_prefix("restore:"))
            {
                let parts: Vec<&str> = rest.split(',').collect();
                if parts.len() == 2 {
                    let left: i32 = parts[0].parse().unwrap_or(INIT_LEFT);
                    let bottom: i32 = parts[1].parse().unwrap_or(INIT_BOTTOM);
                    apply_input_region(&window_ref, left, bottom);
                }
            }
        });
    }

    window.show_all();
    println!("Window shown");

    // 设置输入穿透热区（rough 模式：矩形区域）
    // 延迟执行，确保窗口已完成尺寸分配
    let window_ref = window.clone();
    gtk::glib::idle_add_local_once(move || {
        setup_input_region(&window_ref);
    });
}

#[cfg(test)]
mod tests {
    use super::{
        AppConfig, IDENTITY_CLOSE, IDENTITY_OPEN, TtsRequest, contains_japanese,
        extract_identity_update, load_soul_for_model, normalize_language, percent_decode_path,
        resolve_tts_reference_path, safe_static_path, split_soul_document,
    };

    #[test]
    fn extracts_identity_block_and_keeps_visible_reply() {
        let response = format!("你好。\n{}\n- 喜欢咖啡\n{}", IDENTITY_OPEN, IDENTITY_CLOSE);
        let (clean, update) = extract_identity_update(&response);
        assert_eq!(clean, "你好。");
        assert_eq!(update.as_deref(), Some("- 喜欢咖啡"));
    }

    #[test]
    fn leaves_incomplete_identity_block_untouched() {
        let response = format!("你好 {}未完成", IDENTITY_OPEN);
        let (clean, update) = extract_identity_update(&response);
        assert_eq!(clean, response);
        assert!(update.is_none());
    }

    #[test]
    fn splits_skill_style_soul_frontmatter_and_body() {
        let document = split_soul_document("---\nid: rem\nload: body\n---\n# Rem\n");
        assert_eq!(document.frontmatter, "id: rem\nload: body");
        assert_eq!(document.body, "# Rem");
    }

    #[test]
    fn selects_soul_by_model_with_safe_default() {
        assert!(load_soul_for_model("rem").contains("id: rem"));
        assert!(load_soul_for_model("katoumegumi").contains("id: katoumegumi"));
        assert!(load_soul_for_model("unknown").contains("id: katoumegumi"));
    }

    #[test]
    fn detects_kana_as_japanese() {
        assert!(contains_japanese("今日はどうしたの？"));
        assert!(!contains_japanese("今天怎么了？"));
    }

    #[test]
    fn normalizes_prompt_language_aliases() {
        assert_eq!(normalize_language("日语").unwrap(), "ja");
        assert_eq!(normalize_language("zh").unwrap(), "zh");
        assert_eq!(normalize_language("English").unwrap(), "en");
        assert!(normalize_language("fr").is_err());
    }

    #[test]
    fn resolves_project_relative_tts_reference_path() {
        let relative = resolve_tts_reference_path("voice/katou-reference.wav");
        assert!(relative.ends_with("/voice/katou-reference.wav"));
        assert_eq!(
            resolve_tts_reference_path("/tmp/katou-reference.wav"),
            "/tmp/katou-reference.wav"
        );
    }

    #[test]
    fn rejects_invalid_or_traversing_static_paths() {
        assert_eq!(
            percent_decode_path("/model/katou.json"),
            Some("/model/katou.json".into())
        );
        assert_eq!(
            percent_decode_path("/%2e%2e/config.toml"),
            Some("/../config.toml".into())
        );
        assert!(safe_static_path(super::LIVE2D_PATH, "/../config.toml").is_none());
        assert!(safe_static_path(super::LIVE2D_PATH, "/%2e%2e/config.toml").is_none());
        assert!(safe_static_path(super::LIVE2D_PATH, "/index.html").is_some());
    }

    #[test]
    fn fallback_tts_generates_wav_audio() {
        let audio = super::synthesize_speech_fallback("你好", "zh").unwrap();
        assert!(audio.starts_with(b"RIFF"));
        assert!(audio.len() > 1024);
    }

    #[test]
    fn disabled_tts_uses_fallback_wav_audio() {
        let config = AppConfig {
            api_key: "unused".into(),
            base_url: "https://example.invalid".into(),
            model: "unused".into(),
            tts_enabled: false,
            tts_base_url: "http://127.0.0.1:9".into(),
            tts_ref_audio: String::new(),
            tts_prompt_text: String::new(),
            tts_prompt_lang: "ja".into(),
        };
        let (audio, source) = super::synthesize_speech_with_config(
            TtsRequest {
                text: "你好".into(),
            },
            config,
        )
        .unwrap();
        assert_eq!(source, "fallback");
        assert!(audio.starts_with(b"RIFF"));
    }

    #[test]
    fn unavailable_gptsovits_returns_a_clear_error() {
        let config = AppConfig {
            api_key: "unused".into(),
            base_url: "https://example.invalid".into(),
            model: "unused".into(),
            tts_enabled: true,
            tts_base_url: "http://127.0.0.1:9".into(),
            tts_ref_audio: "/tmp/missing-reference.wav".into(),
            tts_prompt_text: "こんにちは".into(),
            tts_prompt_lang: "ja".into(),
        };
        let error = super::synthesize_speech_with_config(
            TtsRequest {
                text: "今日は".into(),
            },
            config,
        )
        .unwrap_err();
        assert!(error.contains("加藤惠语音服务不可用"));
    }

    #[test]
    fn enabled_tts_requires_a_reference_and_transcript() {
        let config = AppConfig {
            api_key: "unused".into(),
            base_url: "https://example.invalid".into(),
            model: "unused".into(),
            tts_enabled: true,
            tts_base_url: "http://127.0.0.1:9880".into(),
            tts_ref_audio: String::new(),
            tts_prompt_text: String::new(),
            tts_prompt_lang: "ja".into(),
        };
        let error = super::synthesize_speech_with_config(
            TtsRequest {
                text: "你好".into(),
            },
            config,
        )
        .unwrap_err();
        assert!(error.contains("缺少 tts_ref_audio 或 tts_prompt_text"));
    }

    #[test]
    fn validates_wav_container_header() {
        assert!(super::is_wav_audio(b"RIFF\x00\x00\x00\x00WAVEdata"));
        assert!(!super::is_wav_audio(b"not wav audio"));
    }
}
