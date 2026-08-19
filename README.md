# AnimePet 🐾

在 Wayland 桌面（niri）上运行的二次元桌宠，基于 Rust + GTK3 + WebKitGTK + Live2D。

一只会眨眼、会说话的加藤惠，悬浮在桌面最上层，跨所有工作区显示，可拖拽到任意位置。

## ✨ 功能特性

- **透明背景** — 只显示角色模型，无窗口边框和背景
- **始终置顶** — 基于 layer-shell Overlay 层，永远浮在所有应用上方
- **跨工作区显示** — layer-shell 原生支持，所有工作区都能看到
- **自由拖拽** — 拖拽到屏幕任意位置（rough 模式热区，非像素级）
- **输入穿透** — 点击模型以外的区域穿透到下层应用
- **对话气泡** — 模型头顶显示对话文字，半透明悬浮效果
- **DeepSeek AI 对话** — 点击桌宠打开聊天窗口，支持流式回复、多轮上下文和本地人格/身份/记忆文件
- **Live2D 动画** — 完整保留表情、眨眼、物理摆动等动画

## 📦 系统依赖

本程序依赖以下系统库（Arch Linux）：

```bash
sudo pacman -S gtk3 webkit2gtk-4.1 gtk-layer-shell
```

其他发行版对应包名：

| 发行版 | 依赖包 |
|--------|--------|
| Arch | `gtk3 webkit2gtk-4.1 gtk-layer-shell` |
| Debian/Ubuntu | `libgtk-3-dev libwebkit2gtk-4.1-dev libgtk-layer-shell-dev` |
| Fedora | `gtk3-devel webkit2gtk4.1-devel gtk-layer-shell-devel` |

## 🔨 构建

```bash
git clone <repo-url>
cd animepet
cargo build --release
```

构建产物：`target/release/animepet`

> 依赖已锁定在 `Cargo.lock`，构建时只下载项目声明的最小依赖集（gtk、webkit2gtk、gtk-layer-shell、tiny_http、cairo-rs）。

## 🚀 运行

首次使用先创建配置文件：

    cp config.toml.example config.toml
    # 编辑 config.toml，填入 DeepSeek API Key

SOUL.md 是人格设定，IDENTITY.md 是用户身份档案，MEMORY.md 是长期记忆。三者会随每次请求加载；成功对话会追加一条记录到 MEMORY.md。当用户明确提供姓名、偏好、习惯等个人信息时，AI 会通过内部标记让程序追加到 IDENTITY.md。config.toml 已被 .gitignore 忽略，不会被提交。

```bash
./target/release/animepet
```

或开发模式直接：

```bash
cargo run
```

**环境要求**：需要在 Wayland 会话（推荐 niri）下运行，并确保运行机器可以访问 api.deepseek.com。程序会自动设置 WAYLAND_DISPLAY 和 GDK_BACKEND 环境变量。

停止：`pkill animepet`

## 🗂️ 项目结构

```
animepet/
├── Cargo.toml              # 项目配置 + 依赖声明
├── Cargo.lock              # 依赖版本锁定（保证可复现构建）
├── .gitignore              # 忽略 /target 构建产物
├── README.md
├── SOUL.md                  # AI 人格设定
├── IDENTITY.md              # 用户身份和偏好档案
├── MEMORY.md                # 长期对话记忆
├── src/
│   └── main.rs             # 全部 Rust 代码（约 170 行）
└── assets/
    └── live2d/             # Live2D 资源（自包含，运行时加载）
        ├── index.html      # HTML 包装层（气泡样式 + 拖拽通信）
        ├── js/
        │   ├── live2d.js   # Live2D 引擎
        │   └── message.js  # 交互逻辑
        ├── message.json    # 消息文案配置
        └── model/katou_01/ # 加藤惠模型
```

## 🏗️ 架构说明

- **技术栈**：GTK3 + WebKitGTK + gtk-layer-shell + tiny_http
- **窗口**：全屏 layer-shell Overlay 层（透明、跨工作区、始终置顶）
- **渲染**：WebView 加载本地 HTTP 服务器（tiny_http）serving 的 index.html → Live2D 引擎渲染模型
- **拖拽**：JS 侧 `addEventListener` 实现，通过 `document.title` 与 Rust 通信
- **输入穿透**：`input_shape_combine_region` 矩形热区，拖拽时临时扩大到全屏
- **本地服务器**：绕开 `file://` 协议的 CORS 限制（Live2D 需用 XHR 加载模型 JSON）

## 🎨 自定义

- **切换模型**：替换 `assets/live2d/model/` 下的模型文件，并修改 `index.html` 中的 `loadlive2d()` 调用
- **气泡样式**：编辑 `assets/live2d/index.html` 中的 `.message` CSS
- **对话文案**：编辑 `assets/live2d/message.json`

## 📄 许可证

MIT
