/*
 * Cubism 3/4 (.moc3) 模型加载器 —— 让 AnimePet 能加载《为美好的世界献上祝福！FD》
 * 等使用 Cubism 3 格式的 Live2D 模型（项目原有的 live2d.js 是 Live2D 2 引擎，
 * 只支持 .moc，无法解析 .moc3）。
 *
 * 实现方式：
 *   - 懒加载 vendor/ 下的 PIXI 6 + Live2D Cubism Core + pixi-live2d-display(cubism4)，
 *     只有切换到 Cubism3 模型时才会真正下载执行；
 *   - 在 #landlord 内新建一块独立画布（#live2d-cubism）交给 PIXI 渲染，
 *     与旧版 SDK2 的 #live2d 画布互不干扰：进入 Cubism3 模型时停掉旧渲染循环
 *     并隐藏旧画布；切回旧版模型时由 message.js 整页重载恢复；
 *   - 模型 JSON 中约定 motion 分组：idle（待机循环）、tap_body（点击）、
 *     flick_head（轻拍），与旧版模型在 message.js 中的行为保持一致；
 *   - 桥接 lipsync.js 的 setLive2dLipSyncValue，让 TTS 说话时嘴巴同步开合。
 *
 * 暴露接口：window.AnimePetCubism3.load(modelDef, baseUrl) -> Promise<void>
 */
(function () {
    'use strict';

    var CANVAS_ID = 'live2d-cubism';
    // 注意：<script src> 相对 HTML 文档解析（同 message.js 的 'model/...' 写法），
    // 因此这里从页面根目录写起，而不是相对 js/ 目录。
    var VENDOR_SCRIPTS = [
        'js/vendor/pixi.min.js',
        'js/vendor/live2dcubismcore.min.js',
        'js/vendor/cubism4.min.js'
    ];
    // 缩放比例：1 = 角色内容恰好撑满 280x250 画布（与加藤惠/蕾姆观感一致）。
    // 注意：#landlord 已提升到 300px 高，Cubism3 画布仍是 280x250 并用 bottom:0 贴底，
    // 这样既保留原有观感，也不用重算 FILL；画布上方的 50px 是透明留白。
    var FILL = 1.0;

    var vendorPromise = null;
    var app = null;
    var currentModel = null;
    var mouthValue = 0;

    // ---- 唇形同步桥接：lipsync.js 只作用于 SDK2 模型，这里补上 Cubism3 一侧 ----
    var baseSetLipSyncValue = window.setLive2dLipSyncValue;
    window.setLive2dLipSyncValue = function (value) {
        mouthValue = Math.max(0, Math.min(1, Number(value) || 0));
        if (baseSetLipSyncValue) baseSetLipSyncValue(value);
    };

    // ---- 对外接口 ----
    window.AnimePetCubism3 = {
        /**
         * @param {object} modelDef message.js live2dModels 里的一条配置
         * @param {string} baseUrl  静态资源根目录（以 / 结尾）
         * @returns {Promise<void>}
         */
        load: function (modelDef, baseUrl) {
            return ensureVendor(baseUrl)
                .then(function () {
                    return PIXI.live2d.Live2DModel.from(baseUrl + modelDef.model, {
                        autoInteract: false,
                        motionPreload: 'IDLE'
                    });
                })
                .then(function (model) {
                    // 必须先挂载（首次挂载会创建画布）再切换画布可见性，
                    // 否则第一次进入 Cubism3 模型时画布还没存在、会一直隐藏。
                    mountModel(model);
                    swapCanvas(true);
                })
                .catch(function (error) {
                    console.error('[AnimePet] Cubism3 模型加载失败:', error);
                    swapCanvas(false);
                    throw error;
                });
        }
    };

    // ---- 内部实现 ----

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = src;
            script.onload = function () { resolve(); };
            script.onerror = function () {
                reject(new Error('无法加载 Cubism3 运行库: ' + src));
            };
            document.head.appendChild(script);
        });
    }

    function ensureVendor(baseUrl) {
        if (!vendorPromise) {
            vendorPromise = VENDOR_SCRIPTS.reduce(function (chain, name) {
                return chain.then(function () {
                    return loadScript(baseUrl + name);
                });
            }, Promise.resolve());
        }
        return vendorPromise;
    }

    // 旧版 SDK2 的渲染循环一旦启动就常驻且没有停止接口。
    // 借用 message.js 处理监听器时的同款手法：短暂接管 requestAnimationFrame，
    // 让循环下一帧不再自我续期，随后恢复全局 rAF 供 PIXI/jQuery 使用。
    // 只有旧循环确实启动过（加载过 SDK2 模型）才需要停。
    function stopLegacyLoop() {
        if (window.__animepetLegacyLoopStopped || !window.__animepetLegacyStarted) return;
        window.__animepetLegacyLoopStopped = true;
        var originalRaf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = function () { return 0; };
        setTimeout(function () {
            window.requestAnimationFrame = originalRaf;
        }, 250);
    }

    function ensureApp() {
        if (app) return app;
        var canvas = document.createElement('canvas');
        canvas.id = CANVAS_ID;
        canvas.width = 280;
        canvas.height = 250;
        canvas.style.cssText = 'position:absolute;left:0;bottom:0;z-index:1;display:none;';
        var landlord = document.getElementById('landlord') || document.body;
        landlord.appendChild(canvas);
        app = new PIXI.Application({
            view: canvas,
            width: 280,
            height: 250,
            backgroundAlpha: 0,
            antialias: true,
            autoStart: true
        });
        bindTapInteraction(landlord);
        return app;
    }

    // 显示/隐藏两块画布：cubism3 激活时显示 PIXI 画布并隐藏旧画布
    function swapCanvas(cubismActive) {
        var legacy = document.getElementById('live2d');
        var cubism = document.getElementById(CANVAS_ID);
        if (legacy) legacy.style.display = cubismActive ? 'none' : '';
        if (cubism) cubism.style.display = cubismActive ? 'block' : 'none';
    }

    function mountModel(model) {
        var a = ensureApp();
        if (currentModel) {
            a.stage.removeChild(currentModel);
            currentModel.destroy();
        }
        currentModel = model;
        a.stage.addChild(model);

        // 必须按"角色实际内容"而不是 model.width/height 来缩放：后者是 3000x4500 的
        // 画布信息，内容只占中间一块且位置有偏移，按它缩放会让角色又小又跑出画布。
        var width = a.view.width;
        var height = a.view.height;
        var bounds = contentBounds(model);
        var fit = Math.min(width / bounds.width, height / bounds.height) * FILL;
        model.scale.set(fit);
        model.anchor.set(0, 0);
        model.position.set(
            width / 2 - bounds.centerX * fit,
            height / 2 - bounds.centerY * fit
        );

        patchLipSync(model);
    }

    // 角色内容包围盒。遍历所有可绘制网格顶点，得到的是"模型空间"（y 向上、原点在
    // 画布中心）下的盒子；渲染时内容按 x => canvasW/2 + x、y => canvasH/2 - y 映射，
    // 因此中心要按这个关系换算，否则角色会整体偏到画布右上角。
    function contentBounds(model) {
        var internalModel = model.internalModel;
        var coreModel = internalModel.coreModel;
        var transform = internalModel.localTransform;
        var drawableCount = coreModel.getDrawableCount();
        var minX = Infinity;
        var minY = Infinity;
        var maxX = -Infinity;
        var maxY = -Infinity;

        for (var i = 0; i < drawableCount; i++) {
            var vertices = coreModel.getDrawableVertices(i);
            for (var j = 0; j < vertices.length; j += 2) {
                var x = transform.a * vertices[j] + transform.c * vertices[j + 1] + transform.tx;
                var y = transform.b * vertices[j] + transform.d * vertices[j + 1] + transform.ty;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (minX === Infinity) {
            return {
                width: model.width,
                height: model.height,
                centerX: model.width / 2,
                centerY: model.height / 2
            };
        }
        return {
            width: maxX - minX,
            height: maxY - minY,
            centerX: model.width / 2 + (minX + maxX) / 2,
            centerY: model.height / 2 - (minY + maxY) / 2
        };
    }

    // 在动作更新之后、绘制之前写入口型参数，避免被动作曲线覆盖。
    // 这是 pixi-live2d-display 官方推荐的口型同步改法。
    function patchLipSync(model) {
        var internalModel = model.internalModel;
        var coreModel = internalModel.coreModel;
        var motionManager = internalModel.motionManager;
        var originalUpdate = motionManager.update.bind(motionManager);
        motionManager.update = function (targetModel, now) {
            var result = originalUpdate(targetModel, now);
            try {
                coreModel.setParameterValueById('ParamMouthOpenY', mouthValue);
            } catch (error) {
                // 模型没有 ParamMouthOpenY 参数时静默跳过
            }
            return result;
        };
    }

    // 点击模型播放随机 tap_body 动作。#landlord 的拖拽逻辑在 pointerdown 时
    // 会 setPointerCapture，pointerup 不会落回画布，因此监听冒泡上来的 click。
    function bindTapInteraction(landlord) {
        landlord.addEventListener('click', function () {
            if (!currentModel) return;
            try {
                currentModel.motion('tap_body');
            } catch (error) {
                console.error('[AnimePet] 播放 tap_body 动作失败:', error);
            }
        });
    }
})();
