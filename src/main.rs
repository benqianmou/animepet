use gtk::prelude::*;
use gtk::{Application, ApplicationWindow};
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use serde::Deserialize;
use std::io::Read;
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
    mpsc::{self, Receiver, Sender},
};
use std::time::{Duration, SystemTime};
use webkit2gtk::{
    PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebView, WebViewExt,
};

mod http_util;
use http_util::{
    parse_region_spec, read_request_body, read_request_bytes, request_is_authorized, respond_json,
    respond_text, serve_file, session_token,
};

mod speech;
use speech::{synthesize_speech, transcribe_speech};

mod chat;
use chat::{ChatMessage, ChatRequest, stream_chat};

mod state;
use state::{
    read_state_json, send_desktop_notification, validate_state_payload, write_state_atomic,
};

// 静态资源根目录；katoumegumi 页面与 rem / megumin / darkness / aqua 模型目录并列。
const ASSETS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets");

// 模型尺寸与初始位置（需与 assets/katoumegumi/css/pet.css 中 #landlord 保持一致）
const MODEL_WIDTH: i32 = 280;
const MODEL_HEIGHT: i32 = 300;
const MODEL_HIT_PADDING: i32 = 14;
const INIT_LEFT: i32 = 5; // message.js 无历史位置时默认 left:5px
const INIT_BOTTOM: i32 = 0;
pub(crate) const HTTP_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CHAT_SERVER_PORT: u16 = 17_364;
pub(crate) const MAX_HISTORY_MESSAGES: usize = 40;
pub(crate) const MAX_MEMORY_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_IDENTITY_BYTES: usize = 256 * 1024;
pub(crate) const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const MAX_STATE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
pub(crate) struct AppConfig {
    pub(crate) api_key: String,
    #[serde(default = "default_base_url")]
    pub(crate) base_url: String,
    #[serde(default = "default_model")]
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) tts_enabled: bool,
    #[serde(default = "default_tts_base_url")]
    pub(crate) tts_base_url: String,
    #[serde(default)]
    pub(crate) tts_ref_audio: String,
    #[serde(default)]
    pub(crate) tts_prompt_text: String,
    #[serde(default = "default_tts_prompt_lang")]
    pub(crate) tts_prompt_lang: String,
    #[serde(default)]
    pub(crate) stt_enabled: bool,
    #[serde(default = "default_stt_base_url")]
    pub(crate) stt_base_url: String,
    #[serde(default = "default_stt_model")]
    pub(crate) stt_model: String,
    #[serde(default)]
    pub(crate) stt_language: String,
    #[serde(default)]
    pub(crate) stt_api_key: String,
    #[serde(default = "default_stt_provider")]
    pub(crate) stt_provider: String,
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
fn default_stt_base_url() -> String {
    "http://127.0.0.1:8000".into()
}
fn default_stt_model() -> String {
    "whisper-1".into()
}
fn default_stt_provider() -> String {
    "openai".into()
}

#[derive(Deserialize)]
pub(crate) struct TtsRequest {
    text: String,
}

#[derive(Deserialize)]
pub(crate) struct SttResponse {
    text: String,
}

pub(crate) fn http_agent() -> ureq::Agent {
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

pub(crate) fn load_config() -> Result<AppConfig, String> {
    let text = std::fs::read_to_string(format!("{}/config.toml", env!("CARGO_MANIFEST_DIR")))
        .map_err(|_| {
            "缺少 config.toml。请复制 config.toml.example 并填写 DeepSeek API Key。".to_string()
        })?;
    toml::from_str(&text).map_err(|e| format!("config.toml 格式错误: {e}"))
}

pub(crate) fn load_prompt_file(name: &str) -> String {
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

/// 从模型 id 推导人格文件路径；只接受安全字符，文件不存在时回退到加藤惠。
/// 模型清单本身由 `assets/models.json` 维护，Rust 侧不再逐个 match。
fn soul_file_for_model(model_id: &str) -> String {
    let safe = !model_id.is_empty()
        && model_id.len() <= 32
        && model_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    let fallback = "souls/katoumegumi/SOUL.md".to_string();
    if !safe {
        return fallback;
    }
    let candidate = format!("souls/{model_id}/SOUL.md");
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(&candidate);
    if path.exists() { candidate } else { fallback }
}

pub(crate) fn load_soul_for_model(model_id: &str) -> String {
    let document = split_soul_document(&load_prompt_file(&soul_file_for_model(model_id)));
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

pub(crate) fn chrono_like_now() -> String {
    format!("{:?}", SystemTime::now())
}

/// 陪伴状态与配置的持久化目录（XDG_DATA_HOME 优先）。
/// 启动本地 HTTP 服务：聊天 / TTS / STT / 状态 / 通知 / 退出。
fn start_chat_server(
    root: &str,
    history: Arc<Mutex<Vec<ChatMessage>>>,
    quit_tx: Sender<()>,
    token: String,
) -> u16 {
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
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
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
                            respond_text(request, 503, &error);
                        }
                    }
                });
            } else if route == "/stt" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let mime = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Content-Type"))
                    .map(|header| header.value.as_str().to_string())
                    .unwrap_or_else(|| "audio/webm".into());
                let body = match read_request_bytes(&mut request, MAX_AUDIO_BYTES) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
                        continue;
                    }
                };
                std::thread::spawn(move || match transcribe_speech(body, &mime) {
                    Ok(text) => {
                        let header = tiny_http::Header::from_bytes(
                            &b"Content-Type"[..],
                            &b"application/json; charset=utf-8"[..],
                        )
                        .unwrap();
                        let payload = serde_json::json!({"text": text}).to_string();
                        let _ = request
                            .respond(tiny_http::Response::from_string(payload).with_header(header));
                    }
                    Err(error) => {
                        respond_text(request, 503, &error);
                    }
                });
            } else if route == "/state" {
                match *request.method() {
                    tiny_http::Method::Get => {
                        respond_json(request, 200, &read_state_json());
                    }
                    tiny_http::Method::Post => {
                        if !request_is_authorized(&request, &token) {
                            respond_text(request, 403, "forbidden");
                            continue;
                        }
                        let body = match read_request_bytes(&mut request, MAX_STATE_BYTES).and_then(
                            |bytes| {
                                String::from_utf8(bytes)
                                    .map_err(|error| format!("状态不是有效 UTF-8: {error}"))
                            },
                        ) {
                            Ok(body) => body,
                            Err(error) => {
                                respond_text(request, 413, &error);
                                continue;
                            }
                        };
                        match validate_state_payload(&body)
                            .and_then(|state| write_state_atomic(&state).map(|_| state))
                        {
                            Ok(state) => respond_json(request, 200, &state),
                            Err(error) => respond_text(request, 400, &error),
                        }
                    }
                    _ => respond_text(request, 405, "405 Method Not Allowed"),
                }
            } else if route == "/notify" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
                        continue;
                    }
                };
                let payload: serde_json::Value =
                    serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                let title = payload["title"].as_str().unwrap_or("AnimePet").to_string();
                let message = payload["body"].as_str().unwrap_or("").to_string();
                std::thread::spawn(move || {
                    if let Err(error) = send_desktop_notification(&title, &message) {
                        eprintln!("desktop notification skipped: {error}");
                    }
                });
                respond_text(request, 200, "ok");
            } else if route == "/app/quit" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let _ = quit_tx.send(());
                respond_text(request, 200, "bye");
            } else if route == "/chat" && request.method() == &tiny_http::Method::Post {
                if !request_is_authorized(&request, &token) {
                    respond_text(request, 403, "forbidden");
                    continue;
                }
                let body = match read_request_body(&mut request) {
                    Ok(body) => body,
                    Err(error) => {
                        respond_text(request, 413, &error);
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
                    respond_text(request, 400, "bad request");
                }
            } else {
                serve_file(request, &root, &token);
            }
        }
    });
    port
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

/// 由前端提交的输入热区集合：各矩形以 CSS 像素给出（WebView 铺满窗口，坐标一致），
/// 用分号分隔。这样聊天窗 / HUD / 菜单打开时，只有面板与模型区域接收鼠标，
/// 其余桌面区域仍然可以正常点击。
fn apply_region_spec(window: &ApplicationWindow, spec: &str) {
    let rects = parse_region_spec(spec);
    let region = cairo::Region::create();
    let mut added = false;
    for (x, y, width, height) in &rects {
        let rect = cairo::RectangleInt::new(*x, *y, *width, *height);
        if region.union_rectangle(&rect).is_ok() {
            added = true;
        }
    }
    if !added {
        setup_input_region(window);
        return;
    }
    window.input_shape_combine_region(Some(&region));
    println!("Input region: {} rect(s)", rects.len());
}

/// 解析 "left,bottom" 形式的标题（drag_end / restore / chat_close 共用）。
fn apply_position_title(window: &ApplicationWindow, rest: &str, keyboard: bool) {
    if keyboard {
        window.set_keyboard_mode(KeyboardMode::None);
    }
    let parts: Vec<&str> = rest.split(',').collect();
    if parts.len() == 2 {
        let left: i32 = parts[0].parse().unwrap_or(INIT_LEFT);
        let bottom: i32 = parts[1].parse().unwrap_or(INIT_BOTTOM);
        apply_input_region(window, left, bottom);
    } else {
        setup_input_region(window);
    }
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

    // WebKitGTK does not show a browser-style permission prompt by itself.
    // Without handling this signal, navigator.mediaDevices.getUserMedia()
    // is rejected even when the desktop microphone is available.
    webview.connect_permission_request(|_, request| {
        if request.is::<UserMediaPermissionRequest>() {
            request.allow();
            println!("Microphone permission granted to WebView");
            true
        } else {
            false
        }
    });

    let history: Arc<Mutex<Vec<ChatMessage>>> = Arc::new(Mutex::new(Vec::new()));
    let (quit_tx, quit_rx) = mpsc::channel::<()>();
    let token = session_token();
    let port = start_chat_server(ASSETS_PATH, history, quit_tx, token);
    // 前端菜单里的"退出"通过本地 HTTP 通知 GTK 主循环，避免跨线程操作 GObject。
    {
        let app_ref = app.clone();
        gtk::glib::timeout_add_local(Duration::from_millis(120), move || {
            if quit_rx.try_recv().is_ok() {
                println!("Quit requested from the WebView");
                app_ref.quit();
                gtk::glib::ControlFlow::Break
            } else {
                gtk::glib::ControlFlow::Continue
            }
        });
    }
    let html_path = format!("http://127.0.0.1:{}/katoumegumi/index.html", port);
    println!("Preparing HTML: {}", html_path);

    window.add(&webview);
    println!("WebView added to window");

    // JS 会在两个时间点改 title：
    //   app_ready   —— DOM 就绪（检测页面加载卡死）
    //   model_ready —— Live2D 模型真正渲染完成（检测「页面正常但模型不可见」）
    let page_ready = Arc::new(AtomicBool::new(false));
    let model_ready = Arc::new(AtomicBool::new(false));
    let reload_attempts = Arc::new(AtomicU32::new(0));
    let model_reload_attempts = Arc::new(AtomicU32::new(0));

    // 监听 title 变化（JS ↔ Rust 的轻量协议，格式见 index.html / pet-ui.js）：
    //   drag_start        — 拖拽开始：清空热区，允许指针移出模型
    //   drag_end:l,b      — 拖拽结束，模型位于 (left=l, bottom=b)
    //   restore:l,b       — 页面加载后恢复上次拖拽位置
    //   overlay_open      — 非聊天浮层打开：只清空热区，不抢键盘
    //   modal_open        — 整屏模态（猜拳）：清空热区并请求键盘焦点
    //   region:x,y,w,h;…  — 模型 + 可见浮层的并集热区（CSS 像素）
    //   chat_open         — 聊天浮层：清空热区并请求键盘焦点
    //   chat_close:l,b    — 所有浮层关闭：恢复模型矩形热区
    {
        let window_ref = window.clone();
        let webview_ref = webview.clone();
        let page_ready_title = page_ready.clone();
        let model_ready_title = model_ready.clone();
        webview.connect_title_notify(move |wv| {
            let title = wv
                .title()
                .map(|t| t.as_str().to_string())
                .unwrap_or_default();
            if title == "app_ready" {
                page_ready_title.store(true, Ordering::SeqCst);
                println!("Page signalled app_ready");
            } else if title == "model_ready" {
                model_ready_title.store(true, Ordering::SeqCst);
                println!("Model signalled ready");
            } else if title == "drag_start" {
                // 拖拽开始：扩大输入区域到全屏，避免拖拽时鼠标移出热区导致中断
                window_ref.input_shape_combine_region(None);
                println!("Drag started: input region cleared (fullscreen input)");
            } else if let Some(spec) = title.strip_prefix("region:") {
                apply_region_spec(&window_ref, spec);
            } else if title == "modal_open" {
                // 猜拳是整屏模态，需要键盘焦点支持 Tab / Enter
                window_ref.input_shape_combine_region(None);
                window_ref.set_keyboard_mode(KeyboardMode::OnDemand);
                window_ref.present();
                webview_ref.grab_focus();
                println!("Modal opened: fullscreen input + keyboard focus");
            } else if title == "overlay_open" {
                // 菜单 / 陪伴面板 / 猜拳只需要扩大输入热区，不应抢键盘焦点。
                window_ref.input_shape_combine_region(None);
                println!("Overlay opened: input region cleared");
            } else if title == "chat_open" {
                window_ref.input_shape_combine_region(None);
                window_ref.set_keyboard_mode(KeyboardMode::OnDemand);
                window_ref.present();
                webview_ref.grab_focus();
                println!("Chat opened: input region cleared (fullscreen input)");
            } else if let Some(rest) = title.strip_prefix("chat_close:") {
                apply_position_title(&window_ref, rest, true);
            } else if let Some(rest) = title
                .strip_prefix("drag_end:")
                .or_else(|| title.strip_prefix("restore:"))
            {
                apply_position_title(&window_ref, rest, false);
            }
        });
    }

    webview.connect_load_failed(|_, event, uri, error| {
        eprintln!("WebView load failed ({event:?}) {uri}: {error}");
        false
    });

    window.show_all();
    println!("Window shown");

    // 关键：等 WebView realize 之后再 load_uri。
    // 在未 realize 的 WebView 上提前 load_uri，WebKitGTK 偶尔会卡住首次加载，
    // 直到 reload 才执行页面 JS（表现就是启动后只有透明窗口、模型不出现）。
    {
        let started = Arc::new(AtomicBool::new(false));
        let start_load = {
            let started = started.clone();
            let webview_ref = webview.clone();
            let url = html_path.clone();
            move || {
                if started.swap(true, Ordering::SeqCst) {
                    return;
                }
                println!("Loading HTML from: {url}");
                webview_ref.load_uri(&url);
            }
        };
        // realize 钩子优先；某些 WebKitGTK 版本不会给 WebView 发 realize，
        // 因此再用一个 500ms 兜底，保证 load_uri 一定会执行一次。
        let realize_load = start_load.clone();
        webview.connect_realize(move |_| realize_load());
        gtk::glib::timeout_add_local_once(Duration::from_millis(500), start_load);
    }

    // 页面加载看门狗：realize 之后 1.5s 没有 app_ready 就 reload（最多 2 次）
    {
        let ready_ref = page_ready.clone();
        let webview_ref = webview.clone();
        let attempts_ref = reload_attempts.clone();
        gtk::glib::timeout_add_local(Duration::from_millis(1500), move || {
            if ready_ref.load(Ordering::SeqCst) {
                return gtk::glib::ControlFlow::Break;
            }
            let attempt = attempts_ref.fetch_add(1, Ordering::SeqCst);
            if attempt >= 2 {
                eprintln!("Page never signalled ready after reloads; leaving window as-is");
                return gtk::glib::ControlFlow::Break;
            }
            eprintln!(
                "Page not ready after 1.5s; reloading WebView (attempt {})",
                attempt + 1
            );
            webview_ref.reload();
            gtk::glib::ControlFlow::Continue
        });
    }

    // 模型看门狗：页面正常但 10s 内没有 model_ready，说明 WebGL/模型加载异常，reload 一次
    {
        let page_ref = page_ready.clone();
        let model_ref = model_ready.clone();
        let webview_ref = webview.clone();
        let attempts_ref = model_reload_attempts.clone();
        gtk::glib::timeout_add_local(Duration::from_secs(10), move || {
            if model_ref.load(Ordering::SeqCst) || !page_ref.load(Ordering::SeqCst) {
                return gtk::glib::ControlFlow::Break;
            }
            if attempts_ref.fetch_add(1, Ordering::SeqCst) >= 1 {
                eprintln!("Model still not ready after reload; leaving as-is");
                return gtk::glib::ControlFlow::Break;
            }
            eprintln!("Page ready but model not ready after 10s; reloading WebView");
            webview_ref.reload();
            gtk::glib::ControlFlow::Continue
        });
    }

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
        AppConfig, TtsRequest, load_soul_for_model, split_soul_document, validate_state_payload,
    };
    use crate::chat::{IDENTITY_CLOSE, IDENTITY_OPEN, extract_identity_update};
    use crate::speech::{
        audio_extension, contains_japanese, is_wav_audio, normalize_language,
        resolve_tts_reference_path, stt_endpoint, synthesize_speech_fallback,
        synthesize_speech_with_config,
    };
    use crate::state::truncate_chars;

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
    fn fallback_tts_generates_wav_audio() {
        let audio = synthesize_speech_fallback("你好", "zh").unwrap();
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
            stt_enabled: false,
            stt_base_url: "http://127.0.0.1:8000".into(),
            stt_model: "whisper-1".into(),
            stt_language: String::new(),
            stt_api_key: String::new(),
            stt_provider: "openai".into(),
        };
        let (audio, source) = synthesize_speech_with_config(
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
            stt_enabled: false,
            stt_base_url: "http://127.0.0.1:8000".into(),
            stt_model: "whisper-1".into(),
            stt_language: String::new(),
            stt_api_key: String::new(),
            stt_provider: "openai".into(),
        };
        let error = synthesize_speech_with_config(
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
            stt_enabled: false,
            stt_base_url: "http://127.0.0.1:8000".into(),
            stt_model: "whisper-1".into(),
            stt_language: String::new(),
            stt_api_key: String::new(),
            stt_provider: "openai".into(),
        };
        let error = synthesize_speech_with_config(
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
        assert!(is_wav_audio(b"RIFF\x00\x00\x00\x00WAVEdata"));
        assert!(!is_wav_audio(b"not wav audio"));
    }

    #[test]
    fn builds_openai_compatible_stt_endpoint() {
        assert_eq!(
            stt_endpoint("http://127.0.0.1:8000", "openai"),
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            stt_endpoint("http://127.0.0.1:8000/", "openai"),
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            stt_endpoint("http://stt.local/v1/audio/transcriptions", "openai"),
            "http://stt.local/v1/audio/transcriptions"
        );
    }

    #[test]
    fn builds_whisper_cpp_endpoint() {
        assert_eq!(
            stt_endpoint("http://127.0.0.1:8080", "whisper-cpp"),
            "http://127.0.0.1:8080/inference"
        );
    }

    #[test]
    fn maps_recording_mime_types_to_file_extensions() {
        assert_eq!(audio_extension("audio/webm;codecs=opus"), "webm");
        assert_eq!(audio_extension("audio/ogg"), "ogg");
        assert_eq!(audio_extension("audio/wav"), "wav");
        assert_eq!(audio_extension("audio/mp4"), "m4a");
    }
    #[test]
    fn accepts_only_json_objects_as_state() {
        let normalized = validate_state_payload(r#"{"hunger":72,"mood":90}"#).unwrap();
        assert!(normalized.contains("\"hunger\""));
        assert!(validate_state_payload("[1,2,3]").is_err());
        assert!(validate_state_payload("not-json").is_err());
        assert!(validate_state_payload("null").is_err());
    }

    #[test]
    fn truncates_notification_text_by_chars() {
        assert_eq!(truncate_chars("abc", 10), "abc");
        assert_eq!(truncate_chars("桌宠提醒提醒提醒", 4).chars().count(), 4);
        assert_eq!(truncate_chars("", 5), "");
    }
}
