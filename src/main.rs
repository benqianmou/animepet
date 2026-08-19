use gtk::prelude::*;
use gtk::{Application, ApplicationWindow};
use gtk_layer_shell::{Edge, Layer, LayerShell};
use std::path::Path;
use webkit2gtk::{SettingsExt, WebView, WebViewExt};

// 资源路径：编译时嵌入项目根目录，资源自包含在 assets/live2d 下
const LIVE2D_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/live2d");

// 模型尺寸与初始位置（需与 assets/live2d/index.html 中 #landlord 的 CSS 保持一致）
const MODEL_WIDTH: i32 = 280;
const MODEL_HEIGHT: i32 = 250;
const INIT_LEFT: i32 = 5; // message.js 无历史位置时默认 left:5px
const INIT_BOTTOM: i32 = 0;

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

fn start_static_server(root: &str) -> u16 {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("failed to bind local server");
    let port = server.server_addr().to_ip().unwrap().port();
    let root = root.to_string();

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url_path = request.url().split('?').next().unwrap_or("/");
            let relative = url_path.trim_start_matches('/');
            let relative = if relative.is_empty() { "index.html" } else { relative };
            let full_path = Path::new(&root).join(relative);

            let response_result = std::fs::read(&full_path);
            match response_result {
                Ok(data) => {
                    let content_type = content_type_for(&full_path);
                    let header = tiny_http::Header::from_bytes(
                        &b"Content-Type"[..],
                        content_type.as_bytes(),
                    )
                    .unwrap();
                    let response = tiny_http::Response::from_data(data).with_header(header);
                    let _ = request.respond(response);
                }
                Err(_) => {
                    let response = tiny_http::Response::from_string("404 Not Found")
                        .with_status_code(404);
                    let _ = request.respond(response);
                }
            }
        }
    });

    println!("Local static server started on 127.0.0.1:{}", port);
    port
}

/// 将输入热区设置为以 (left, bottom) 为左下角、大小为模型尺寸的矩形。
/// left/bottom 是 JS 侧 #landlord 的 CSS 值（相对窗口左/底），需换算为窗口坐标。
fn apply_input_region(window: &ApplicationWindow, left: i32, bottom: i32) {
    let (_, win_h) = window.size();
    let y = win_h - bottom - MODEL_HEIGHT;
    let rect = cairo::RectangleInt::new(left, y, MODEL_WIDTH, MODEL_HEIGHT);
    let region = cairo::Region::create_rectangle(&rect);
    window.input_shape_combine_region(Some(&region));
    println!(
        "Input region: x={} y={} {}x{}",
        left, y, MODEL_WIDTH, MODEL_HEIGHT
    );
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

    let port = start_static_server(LIVE2D_PATH);
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
        webview.connect_title_notify(move |wv| {
            let title = wv.title().map(|t| t.as_str().to_string()).unwrap_or_default();
            if title == "drag_start" {
                // 拖拽开始：扩大输入区域到全屏，避免拖拽时鼠标移出热区导致中断
                window_ref.input_shape_combine_region(None);
                println!("Drag started: input region cleared (fullscreen input)");
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
