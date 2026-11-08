# 重构执行记录与剩余计划

## 已执行（2026-11-08，v0.5.0）

| 项 | 结果 |
| --- | --- |
| `/chat`、`/tts`、`/stt` 未鉴权 | 统一要求 `X-AnimePet-Token` + 本机 Host；前端 `chat.js` 三个 fetch 已带 token |
| 拖拽收尾逻辑三处重复 | 合并为 `finishDragGesture()`（onUp / onCancel / blur 共用） |
| 时段问候两份实现 | `pet-interact.timeGreeting()` 优先复用 `message.js` 的 `animePetGreeting()` |
| CSS 颜色字面量 | 新增 `--coral-rgb` / `--mint-rgb`，替换 30 + 15 处 `rgba(...)` |
| 面板上方黑边 | 投影改为只向下（负 spread），`background-clip: padding-box` |
| 模型清单 4 处重复 | 新增 `assets/katoumegumi/models.json`；`message.js` 启动时 fetch；Rust 改为 `souls/<id>/SOUL.md` 安全推导 |
| `main.rs` HTTP 工具混杂 | 抽出 `src/http_util.rs`（令牌、响应、静态文件、请求体、region 解析 + 3 个测试） |
| JS 尺寸写死 280/300 | `pet-interact.js` 改为读取 `#landlord.offsetWidth/offsetHeight` |

回归：`cargo test` 20 passed；`node --check` 全通过；无头 QA 7/7（热区并集、tab、礼物、回忆、聊天开关、零脚本错误）；真机 `app_ready` + `model_ready` 正常。

## 剩余计划（按风险从低到高）

1. ~~模型清单单一来源~~（已完成）
2. **`pet-ui.js` 拆分**
   - `pet-region.js`（输入热区并集）、`pet-tabs.js`、`pet-games.js`、`pet-reminders.js`。
   - 收益：单文件从 800+ 行降到 200 行级；风险：中（模块加载顺序与全局 `window.AnimePetUI` 契约）。
3. **`src/main.rs` 拆分**
   - `server.rs`（tiny_http 路由/静态文件/token）、`chat.rs`（DeepSeek 流）、`tts.rs`、`stt.rs`、`state.rs`、`ui.rs`。
   - 收益：消除 1500 行单体的 Divergent Change；风险：高（大量 `pub(crate)` 与测试迁移），建议独立 PR。
4. **尺寸常量单一来源**
   - Rust `MODEL_WIDTH/HEIGHT/PADDING` 与 CSS/JS 重复。可让 JS 首次上报 `region` 后，Rust 不再自行计算模型矩形。
   - 收益：改模型尺寸只动 CSS；风险：中（启动早期仍需 bootstrap 常量）。
5. **静态资源内存缓存 / 服务器线程模型**
   - 目前 tiny_http 单线程串行，长请求会队头阻塞。本地场景影响小，可延后。
6. **Live2D 不可见时降帧**
   - 监听 `visibilitychange` 暂停/降低渲染帧率，省电；需要确认 SDK2 / PIXI 两侧的暂停接口。

原则：每次只做一个模块，保持 `cargo test` + 无头 QA 全绿，再进入下一项。
