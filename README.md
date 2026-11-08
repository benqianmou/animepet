# AnimePet 🐾

在 Wayland 桌面（niri）上运行的二次元桌宠，基于 Rust + GTK3 + WebKitGTK + Live2D。

一只会眨眼、会说话的二次元桌宠，悬浮在桌面最上层，跨所有工作区显示，可拖拽到任意位置。内置 5 个 Live2D 模型（加藤惠 / 蕾姆 / 惠惠 / 达克妮丝 / 阿克娅），可在聊天窗口中随时切换。

## ✨ 功能特性

### 桌面与形象
- **透明背景** — 只显示角色模型，无窗口边框和背景
- **始终置顶** — 基于 layer-shell Overlay 层，永远浮在所有应用上方
- **跨工作区显示** — layer-shell 原生支持，所有工作区都能看到
- **自由拖拽 + 抛掷** — 拖拽到任意位置；快速甩出会按重力落地、回弹，再保存位置
- **输入穿透** — 点击模型以外的区域穿透到下层应用；聊天/陪伴面板打开时热区是「模型 + 面板」的并集，面板之外仍可正常操作其他窗口
- **5 模型切换** — 加藤惠、蕾姆（SDK2）、惠惠、达克妮丝、阿克娅（Cubism 3/4），选择保存到本地
- **Live2D 动画** — 完整保留表情、眨眼、物理摆动等动画；画布 280×300，五个模型头部与身体均完整显示

### 陪伴互动（v2 新增）
- **四维数值** — 饱食 / 心情 / 精力 / 亲密度，随时间衰减，离线最多结算 24 小时
- **等级与称号** — 经验累积升级，从「初见」到「命运同行」共 8 档称号
- **桌面手势** — 单击打开聊天；双击摸头 / 逗弄，带气泡台词与数值奖励；右键打开陪伴菜单
- **投喂** — 饱食与心情提升，附带动画与台词
- **猜拳小游戏** — 石头剪刀布，胜 / 平 / 负分别结算经验、亲密度与心情
- **专注番茄钟** — 25 分钟倒计时，完成时气泡 + 语音 + 桌面通知 + 奖励，可随时结束
- **喝水提醒 / 整点报时** — 可开关；提醒同时走气泡、toast、TTS 与 `notify-send`
- **陪伴中心（v3）** — 状态 / 互动 / 回忆三页 Tab，Telegram 风格滑动指示器、方向性入场、键盘左右切换
- **礼物与偏好** — 甜点 / 热茶 / 花 / 书，每个模型有偏好礼物；20 秒冷却
- **每日签到** — 连续陪伴天数，跨天首次互动结算
- **亲密度阶段与里程碑** — 初见 → 熟悉 → 亲近 → 喜欢 → 依恋 → 心意相通，20/40/60/80/100 里程碑
- **回忆日记** — 礼物、签到、升级、里程碑、专注完成自动记录（最近 40 条）
- **心情状态机** — 心动 / 开心 / 平静 / 低落 / 饥饿 / 困倦，影响 HUD 配色与待机台词
- **爱心粒子** — 摸头、投喂、礼物、里程碑触发，尊重 reduced-motion
- **iOS 液态玻璃（v4）** — 面板/菜单/弹窗统一玻璃材质：分层半透明 + 镜面高光描边 + 弹簧入场与按钮回弹（WebKitGTK 下不使用 backdrop-filter，见下）
- **本地待机台词** — 45–90 秒随机小动作与问候，不再依赖 hitokoto 网络接口

### 对话
- **DeepSeek AI 对话** — 点击桌宠打开聊天窗口，支持流式回复、多轮上下文和本地人格/身份/记忆文件
- **陪伴式聊天界面** — 深色柔光玻璃面板、矢量图标按钮、消息入场动画、窄屏适配
- **语音输入（STT）** — 浏览器录音后交给本地 Whisper 识别，结果自动回填输入框
- **语音输出（TTS）** — GPT-SoVITS 合成，口型与 Live2D 同步

## 🧸 陪伴系统说明

> v2 设计见 [`docs/FEATURE-V2.md`](docs/FEATURE-V2.md)，v3 陪伴中心与 Tab 动效见 [`docs/COMPANION-CENTER-V3.md`](docs/COMPANION-CENTER-V3.md)，v4 液态玻璃见 [`docs/LIQUID-GLASS.md`](docs/LIQUID-GLASS.md)。

- 数值保存在两处：浏览器 `localStorage`（v3，自动迁移 v2 档）与 `~/.local/share/animepet/state.json`；启动时以 `lastSeen` 较新的一方为准，清理浏览器数据也不会丢档。
- 衰减规则：饱食 −4/小时、精力 −2.5/小时，心情向两者均值回归；离线结算上限 24 小时。
- 交互奖励：摸头 +1 exp、投喂 +4 exp、猜拳胜 +6 exp、专注完成 +12 exp、每次对话 +1 exp；礼物偏好 +8 亲密/+8 exp、普通 +3/+4；每日签到 +2 亲密/+5 exp。
- 桌面通知依赖系统的 `notify-send`（libnotify）；缺失时静默跳过，不影响其他提醒通道。
- 右键菜单里的「退出 AnimePet」会通过本地 `/app/quit` 让 GTK 主循环安全退出。

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

启动后点击聊天窗口标题栏的模型切换按钮即可在加藤惠和蕾姆之间切换。切换只改变当前 Live2D 形象和对应人格文件，不会删除已有的身份档案或长期记忆；当前选择保存在浏览器 `localStorage`，重启后会恢复。

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

### 语音输入（Whisper STT）

聊天输入框左侧的麦克风按钮会调用 WebKitGTK 的浏览器录音权限。录音结束后，AnimePet 通过本地 Rust 代理将音频转发给 whisper.cpp server 的 `POST /inference` 接口，识别结果会回填到输入框，发送前仍可修改。浏览器通常产生 `webm/opus`，启动脚本使用 `--convert` 和 FFmpeg 自动转换为 Whisper 可读的 16 kHz 单声道 WAV。

1. 安装构建工具和 FFmpeg（Arch Linux）：`sudo pacman -S cmake ffmpeg`。Debian/Ubuntu 可使用 `sudo apt install cmake ffmpeg`。
2. 在 AnimePet 项目目录下载并编译 whisper.cpp：

   ```bash
   cd /home/qian/Projects/animepet
   git clone https://github.com/ggerganov/whisper.cpp.git
   cd whisper.cpp
   cmake -B build -DWHISPER_BUILD_SERVER=ON
   cmake --build build -j2
   bash models/download-ggml-model.sh base
   cd ..
   ```

3. 确认 `config.toml` 使用与服务相同的端口：

   ```toml
   stt_enabled = true
   stt_provider = "whisper-cpp"
   stt_base_url = "http://127.0.0.1:8081"
   stt_language = "auto"
   ```

4. 启动 STT 服务并保持终端运行：`bash scripts/start-whisper-cpp.sh`。脚本会加载 `ggml-base.bin`、监听 `127.0.0.1:8081`，并启用 FFmpeg 转码。若端口被占用，修改脚本中的 `--port`，同时修改 `config.toml` 的 `stt_base_url`。
5. 重新启动 AnimePet，首次点击麦克风时允许 WebKit 访问麦克风。服务不可用或未启用时，状态栏会显示具体错误，不会影响文字聊天。建议每次录音持续至少 2 秒，并在 Whisper 终端确认收到请求。

STT 服务只接收 Rust 本地代理转发的录音，浏览器页面不会接触任何服务密钥。录音请求限制为 25 MB，浏览器通常会产生 webm/opus 格式。

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
│   ├── rem/
│   │   └── SOUL.md          # 蕾姆人格（frontmatter + 正文）
│   ├── megumin/SOUL.md      # 惠惠人格
│   ├── darkness/SOUL.md     # 达克妮丝人格
│   └── aqua/SOUL.md         # 阿克娅人格
├── IDENTITY.md              # 用户身份和偏好档案
├── MEMORY.md                # 长期对话记忆
├── voice/
│   └── README.md             # 本地参考音频说明（实际音频默认不提交）
├── scripts/
│   ├── import-katovoice.sh   # 导入并规范化本地参考音频
│   ├── start-gpt-sovits.sh   # 启动同级 GPT-SoVITS API
│   └── start-whisper-cpp.sh  # 启动 Whisper STT 服务并自动转码
├── src/
│   └── main.rs             # GTK 窗口、本地服务器与对话/语音逻辑
└── assets/
    ├── katoumegumi/        # 加藤惠 Live2D 资源与桌宠页面
    │   ├── index.html      # 页面结构（气泡 / 聊天 / 陪伴面板 / 菜单 / 猜拳）
    │   ├── css/pet.css     # 设计令牌与全部组件样式
    │   ├── js/
    │   │   ├── live2d.js   # Live2D 引擎
    │   │   ├── message.js  # 模型加载与本地问候
    │   │   ├── cubism3.js  # Cubism 3/4 模型渲染
    │   │   ├── pet-state.js# 陪伴数值 / 心情 / 阶段 / 礼物 / 签到 / 回忆
    │   │   ├── pet-region.js # 浮层登记 / 输入热区并集 / 面板定位
    │   │   ├── pet-ui.js   # 陪伴中心 Tab / 菜单 / 猜拳 / 专注 / 提醒
    │   │   ├── pet-interact.js # 手势 / 抛掷物理 / 待机行为
    │   │   ├── chat.js     # 聊天、TTS 播放与 STT 录音
    │   │   └── vendor/     # jQuery / PIXI / Cubism 运行库
    │   ├── models.json     # 模型清单单一来源（id / 名称 / 路径 / 人格文件）
    │   ├── message.json    # 旧版消息文案（v2 起不再轮询）
    │   └── model/katou_01/ # 加藤惠模型
    ├── rem/                # 蕾姆完整模型（与 katoumegumi 并列）
    │   ├── rem.json
    │   ├── remu.moc
    │   ├── remu2048/
    │   └── motions/
    ├── megumin/            # 惠惠（Cubism 3 .moc3）
    ├── darkness/           # 达克妮丝（Cubism 3 .moc3）
    └── aqua/               # 阿克娅（Cubism 3 .moc3）
```

## 🏗️ 架构说明

- **技术栈**：GTK3 + WebKitGTK + gtk-layer-shell + tiny_http
- **窗口**：全屏 layer-shell Overlay 层（透明、跨工作区、始终置顶）
- **渲染**：WebView 加载本地 HTTP 服务器（tiny_http）serving 的 index.html → Live2D 引擎渲染模型
- **拖拽**：JS 侧 `addEventListener` 实现，通过 `document.title` 与 Rust 通信
- **输入穿透**：`input_shape_combine_region` 矩形热区，拖拽时临时扩大到全屏
- **本地服务器**：绕开 `file://` 协议的 CORS 限制（Live2D 需用 XHR 加载模型 JSON）
- **模型资源根目录**：Rust 从 `assets/` 提供静态文件，页面位于 `assets/katoumegumi/`，其他模型通过兄弟路径加载

### 本地 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/chat` | 流式对话（NDJSON） |
| POST | `/tts` | GPT-SoVITS 语音合成 |
| POST | `/stt` | Whisper 语音识别 |
| GET | `/state` | 读取陪伴状态 JSON |
| POST | `/state` | 写入陪伴状态（≤64 KB，必须是 JSON 对象，原子替换） |
| POST | `/notify` | 调 `notify-send` 发桌面通知 |
| POST | `/app/quit` | 请求 GTK 主循环退出 |

其余 GET 请求从 `assets/` 提供静态文件。

安全约束：`/state` POST、`/chat`、`/tts`、`/stt`、`/notify`、`/app/quit` 都需要页面内的一次性启动令牌（`X-AnimePet-Token`），并且只接受 `Host` 为本机回环地址的请求；所有静态资源响应带 `Cache-Control: no-store`，避免旧令牌或旧 CSS/JS 被缓存。其他网页即使知道端口也无法直接改写状态或退出程序。

## 🎨 自定义

- **切换模型**：打开对话框，点击标题栏的切换按钮；当前选择会保存在 `localStorage`，重启后继续使用
- **模型配置**：编辑 `assets/katoumegumi/models.json`；新增模型只需加一条记录 + 资源目录 + `souls/<id>/SOUL.md`
- **气泡样式**：编辑 `assets/katoumegumi/css/pet.css` 中的 `.message`
- **陪伴数值**：编辑 `assets/katoumegumi/js/pet-state.js` 顶部的 `THRESHOLDS` / `TITLES` 与衰减速率
- **界面主题**：修改 `pet.css` 顶部 `:root` 里的 coral / mint 设计令牌即可整体换色
- **对话文案**：编辑 `assets/katoumegumi/message.json`

### 界面设计与样式

桌宠的主要视觉界面由 WebKitGTK 中加载的 HTML/CSS 绘制，而不是 GTK 原生控件：

- `#landlord` 和 `#live2d` 负责角色位置、模型画布和拖拽热区
- `.message` 负责角色头顶的对话气泡
- `#chat-panel`、`.chat-line` 和 `#chat-form` 负责聊天面板、消息气泡和输入区
- `.icon-btn` 是所有界面按钮的统一基类：矢量图标 + 玻璃底 + hover 抬升 / active 压下 / 焦点环 / CSS tooltip（猜拳手型保留系统 emoji 作为游戏符号）
- `#pet-hud`、`#pet-menu`、`#pet-rps`、`#pet-toast` 分别是陪伴面板、右键菜单、猜拳弹窗和提醒 toast
- CSS 变量集中在 `pet.css` 的 `:root`，可从这里调整背景、文字、强调色和状态色
- 液态玻璃由 `.surface` 的多层渐变 + inset 高光模拟；`--spring` 控制 iOS 弹簧曲线

当前采用柔光玻璃面板 + 珊瑚/薄荷双强调色，聊天面板与陪伴面板会根据角色位置自动避让，并在窄屏下收缩到窗口边距内。所有动画都尊重 `prefers-reduced-motion`。修改样式后重新启动 AnimePet 即可看到效果。

项目目前保持 GTK3 + WebKitGTK 架构。GTK4 的 CSS 主要影响 GTK 原生控件，不会直接改变 Live2D 页面；如果只想调整桌宠外观，优先修改上述 HTML/CSS。

## 📄 许可证

项目代码使用 MIT 许可证。蕾姆模型来自
[`eeg1412/Live2dRem`](https://github.com/eeg1412/Live2dRem)，上游项目使用 GPL v2，
且其 README 声明模型仅供学习交流、禁止商用；详见
`assets/rem/NOTICE.md`。
