use gtk::prelude::*;
use gtk::{Application, ApplicationWindow};
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{
    Arc, Mutex,
    mpsc::{self, Receiver, Sender},
};
use std::time::SystemTime;
use webkit2gtk::{SettingsExt, WebView, WebViewExt};

// 资源路径：编译时嵌入项目根目录，资源自包含在 assets/live2d 下
const LIVE2D_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/live2d");

// 模型尺寸与初始位置（需与 assets/live2d/index.html 中 #landlord 的 CSS 保持一致）
const MODEL_WIDTH: i32 = 280;
const MODEL_HEIGHT: i32 = 250;
const MODEL_HIT_PADDING: i32 = 14;
const INIT_LEFT: i32 = 5; // message.js 无历史位置时默认 left:5px
const INIT_BOTTOM: i32 = 0;

#[derive(Deserialize)]
struct AppConfig {
    api_key: String,
    #[serde(default = "default_base_url")]
    base_url: String,
    #[serde(default = "default_model")]
    model: String,
}
fn default_base_url() -> String {
    "https://api.deepseek.com".into()
}
fn default_model() -> String {
    "deepseek-chat".into()
}

#[derive(Clone, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}
#[derive(Deserialize)]
struct ChatRequest {
    message: String,
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
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(section.as_bytes());
    }
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
            load_prompt_file("SOUL.md"),
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
    let response = ureq::post(&url)
        .header("Authorization", &format!("Bearer {}", config.api_key))
        .send_json(
            &serde_json::json!({"model": config.model, "messages": messages, "stream": true}),
        );
    let mut response = match response {
        Ok(r) => r,
        Err(e) => {
            json_event(&tx, "error", &format!("请求 DeepSeek 失败: {e}"));
            return;
        }
    };
    let mut response_reader = response.body_mut().as_reader();
    let mut buf = String::new();
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
        buf.push_str(&String::from_utf8_lossy(&bytes[..n]));
        while let Some(pos) = buf.find("\n") {
            let line = buf.drain(..=pos).collect::<String>();
            let data = line.trim().strip_prefix("data: ").unwrap_or("");
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = value["choices"][0]["delta"]["content"].as_str() {
                    answer.push_str(delta);
                    emit_stream_delta(&answer, &mut emitted_len, &tx);
                }
            }
        }
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
        let stamp = format!(
            "\n- [{}] 用户：{}\n  AnimePet：{}\n",
            chrono_like_now(),
            req.message,
            clean_answer
        );
        let memory_path = format!("{}/MEMORY.md", env!("CARGO_MANIFEST_DIR"));
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(memory_path) {
            let _ = file.write_all(stamp.as_bytes());
        }
        json_event(&tx, "done", &clean_answer);
    } else {
        json_event(&tx, "done", "");
    }
}

fn chrono_like_now() -> String {
    format!("{:?}", SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::{IDENTITY_CLOSE, IDENTITY_OPEN, extract_identity_update};

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
}

fn start_chat_server(root: &str, history: Arc<Mutex<Vec<ChatMessage>>>) -> u16 {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("failed to bind local server");
    let port = server.server_addr().to_ip().unwrap().port();
    let root = root.to_string();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            if request.url().split('?').next().unwrap_or("") == "/chat"
                && request.method() == &tiny_http::Method::Post
            {
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
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
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

fn serve_file(request: tiny_http::Request, root: &str) {
    let url_path = request.url().split('?').next().unwrap_or("/");
    let relative = url_path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    let full_path = Path::new(root).join(relative);
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
    if let Some(screen) = gtk::gdk::Screen::default() {
        if let Some(visual) = screen.rgba_visual() {
            window.set_visual(Some(&visual));
            println!("RGBA visual set for transparency");
        }
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
