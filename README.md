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
sudo pacman -S gtk3 webkit2gtk-4.1 gtk-layer-shell espeak-ng
```

其他发行版对应包名：

| 发行版 | 依赖包 |
|--------|--------|
| Arch | `gtk3 webkit2gtk-4.1 gtk-layer-shell espeak-ng` |
| Debian/Ubuntu | `libgtk-3-dev libwebkit2gtk-4.1-dev libgtk-layer-shell-dev espeak-ng` |
| Fedora | `gtk3-devel webkit2gtk4.1-devel gtk-layer-shell-devel espeak-ng` |

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

`souls/katoumegumi/SOUL.md` 和 `souls/rem/SOUL.md` 是按模型选择的人格设定；文件采用类似 Skill 的渐进式格式：`---` 包裹的 frontmatter 先作为轻量身份索引解析，只有当前选中的模型才加载对应正文。`IDENTITY.md` 是用户身份档案，`MEMORY.md` 是长期记忆；两者会随每次请求加载。成功对话会追加一条记录到 `MEMORY.md`。当用户明确提供姓名、偏好、习惯等个人信息时，AI 会通过内部标记让程序追加到 `IDENTITY.md`。根目录 `SOUL.md` 仅保留为旧版本兼容档案，不参与模型切换。config.toml 已被 .gitignore 忽略，不会被提交。

```bash
./target/release/animepet
```

或开发模式直接：

```bash
cargo run
```

### 加藤惠语音输出（GPT-SoVITS）

AnimePet 可以将每次 AI 回复自动交给本地或局域网内的 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) `api_v2.py` 服务合成，并在播放时触发 Live2D 的说话动作。聊天窗口右上角的扬声器按钮可切换静音，状态会保存在本地。

发布到 GitHub 时，仓库只包含导入流程，不包含任何未经确认可公开再分发的声源。`voice/` 内的实际音频默认被 Git 忽略，避免误提交第三方素材。

1. 准备一段你有权使用的干净参考音频，并知道它的准确台词。运行 `bash scripts/import-katovoice.sh /path/to/katou-reference.wav`，会在项目中生成 `voice/katou-reference.wav`。脚本也支持 MP3、FLAC、OGG 等 FFmpeg 可读取格式。`katovoice` 中的 FMOD `.bank` 文件需先用 vgmstream 解码为音频文件，不能直接作为 GPT-SoVITS 参考。
2. 在本机 GPU 上启动官方 GPT-SoVITS API。若 GPT-SoVITS 位于项目同级目录，可直接运行 `bash scripts/start-gpt-sovits.sh`；脚本会使用其独立 Python 环境，并检查 `torchcodec`。也可以在 GPT-SoVITS 目录运行 `python api_v2.py -a 127.0.0.1 -p 9880`。
3. 在 `config.toml` 中启用 `tts_enabled`，将 `tts_ref_audio` 设为 `voice/katou-reference.wav`，再填写该参考音频的准确 `tts_prompt_text` 和语言。若服务位于另一台机器，`tts_ref_audio` 必须改为那台机器可访问的绝对路径。参考音频是英文时使用 `tts_prompt_lang = "en"`，中文使用 `zh`，日语使用 `ja`。

需要发布可下载的语音资源时，只能将具有明确再分发授权的音频放到 GitHub Release 或其他受限下载位置；不要将来源不明的游戏 `.bank` 文件提交进源码仓库。

回复为中文时，AnimePet 请求 GPT-SoVITS 使用 `zh`；回复含日语假名时使用 `ja`。`tts_enabled = false` 时可用本机 `espeak-ng` 系统语音；一旦启用 GPT-SoVITS，服务不可用会在聊天窗明确报错，不再静默播放机器人音。若看到“加藤惠语音服务不可用”，先运行 `bash scripts/start-gpt-sovits.sh` 并保持该终端运行。

**环境要求**：需要在 Wayland 会话（推荐 niri）下运行，并确保运行机器可以访问 api.deepseek.com。程序会自动设置 WAYLAND_DISPLAY 和 GDK_BACKEND 环境变量。

停止：`pkill animepet`

## 🗂️ 项目结构

```
animepet/
├── Cargo.toml              # 项目配置 + 依赖声明
├── Cargo.lock              # 依赖版本锁定（保证可复现构建）
├── .gitignore              # 忽略 /target 构建产物
├── README.md
├── SOUL.md                  # 旧版兼容人格档案
├── souls/
│   ├── katoumegumi/
│   │   └── SOUL.md          # 加藤惠人格（frontmatter + 正文）
│   └── rem/
│       └── SOUL.md          # 蕾姆人格（frontmatter + 正文）
├── IDENTITY.md              # 用户身份和偏好档案
├── MEMORY.md                # 长期对话记忆
├── voice/
│   └── README.md             # 本地参考音频说明（实际音频默认不提交）
├── scripts/
│   ├── import-katovoice.sh   # 导入并规范化本地参考音频
│   └── start-gpt-sovits.sh   # 启动同级 GPT-SoVITS API
├── src/
│   └── main.rs             # 全部 Rust 代码（约 170 行）
└── assets/
    └── katoumegumi/        # Live2D 资源（自包含，运行时加载）
        ├── index.html      # HTML 包装层（气泡样式 + 拖拽通信）
        ├── js/
        │   ├── live2d.js   # Live2D 引擎
        │   └── message.js  # 交互逻辑
        ├── message.json    # 消息文案配置
        └── model/
            ├── katou_01/   # 加藤惠模型
            └── rem/        # 蕾姆模型（仅供学习交流，禁止商用）
```

## 🏗️ 架构说明

- **技术栈**：GTK3 + WebKitGTK + gtk-layer-shell + tiny_http
- **窗口**：全屏 layer-shell Overlay 层（透明、跨工作区、始终置顶）
- **渲染**：WebView 加载本地 HTTP 服务器（tiny_http）serving 的 index.html → Live2D 引擎渲染模型
- **拖拽**：JS 侧 `addEventListener` 实现，通过 `document.title` 与 Rust 通信
- **输入穿透**：`input_shape_combine_region` 矩形热区，拖拽时临时扩大到全屏
- **本地服务器**：绕开 `file://` 协议的 CORS 限制（Live2D 需用 XHR 加载模型 JSON）

## 🎨 自定义

- **切换模型**：打开对话框，点击标题栏的切换按钮；当前选择会保存在 `localStorage`，重启后继续使用
- **模型配置**：编辑 `assets/katoumegumi/js/message.js` 中的 `live2dModels`
- **气泡样式**：编辑 `assets/katoumegumi/index.html` 中的 `.message` CSS
- **对话文案**：编辑 `assets/katoumegumi/message.json`

## 📄 许可证

项目代码使用 MIT 许可证。蕾姆模型来自
[`eeg1412/Live2dRem`](https://github.com/eeg1412/Live2dRem)，上游项目使用 GPL v2，
且其 README 声明模型仅供学习交流、禁止商用；详见
`assets/katoumegumi/model/rem/NOTICE.md`。
