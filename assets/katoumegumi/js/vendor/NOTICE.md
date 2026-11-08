# vendor/ 第三方运行库说明

本目录内的文件由 AnimePet 按需加载，用于渲染 Cubism 3/4（`.moc3`）格式的 Live2D 模型。
旧版 Live2D 2 模型（加藤惠、蕾姆）不依赖这些文件。

| 文件 | 来源 | 许可证 |
|------|------|--------|
| `pixi.min.js` | [pixi.js v6.5.10](https://github.com/pixijs/pixijs)（jsDelivr 官方构建） | MIT |
| `live2dcubismcore.min.js` | [Live2D 官方 Cubism Core for Web](https://www.live2d.com/sdk/download/web/) | Live2D Proprietary Software License（属许可协议中的 "Redistributable Code"，文件头部附有协议链接） |
| `cubism4.min.js` | [pixi-live2d-display v0.4.0](https://github.com/guansss/pixi-live2d-display)（cubism4 构建） | MIT |

模型资源（`assets/megumin`、`assets/darkness`、`assets/aqua`）来自游戏
《为美好的世界献上祝福！Fantastic Days》，版权归原发行方所有，
仅供学习交流，禁止商用。
