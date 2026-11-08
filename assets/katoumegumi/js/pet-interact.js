/*
 * AnimePet v2 · 桌面手势
 * ---------------------------------------------------------------------------
 * 单击   → 打开聊天（保留 v1 行为；延迟 280ms 以便识别双击）
 * 双击   → 摸头 / 逗弄：气泡台词 + 数值奖励 + 模型小动画
 * 拖拽   → 移动；松手按速度做重力抛掷，落地回弹后保存位置
 * 右键   → 陪伴菜单
 *
 * 位置通过 sessionStorage(historywidth/historyheight) 持久化，
 * 并与 Rust 端用 document.title 同步输入热区：
 *   drag_start / drag_end:left,bottom / restore:left,bottom
 */
(function () {
    'use strict';

    var pet = document.getElementById('landlord');
    if (!pet) return;

    var state = window.AnimePetState;
    // 尺寸以 #landlord 的实际 CSS 盒为准，避免 JS 再写死 280/300
    function modelWidth() {
        return pet.offsetWidth || 280;
    }

    function modelHeight() {
        return pet.offsetHeight || 300;
    }
    var TAP_DELAY = 280;
    var DOUBLE_TAP_GAP = 250;
    var DRAG_THRESHOLD = 7;

    var pointerId = null;
    var dragging = false;
    var moved = false;
    var startedAt = 0;
    var startX = 0;
    var startY = 0;
    var startLeft = 0;
    var startBottom = 0;
    var currentLeft = 0;
    var currentBottom = 0;
    var velocity = { x: 0, y: 0 };
    var samples = [];
    var tapTimer = null;
    var lastTapAt = 0;
    var suppressClick = false;
    var throwFrame = null;
    var nextIdleAt = Date.now() + 45000;
    var lastInteractionAt = Date.now();

    var IDLE_LINES = [
        '在忙吗？我就在这里。',
        '偶尔也起来走两步吧。',
        '今天的代码，写得还顺利吗？',
        '这个位置的光线刚刚好。',
        '要不要摸摸头？',
        '我刚刚在数你的窗口数量。',
        '累了就发会儿呆，我不打扰你。',
        '桌面有点乱哦，我帮你看着。'
    ];

    var MOOD_LINES = {
        sleepy: ['有点困…让我靠一会儿。', '眼皮好沉，你也别熬太晚。'],
        hungry: ['肚子饿了…有吃的吗？', '闻到什么香味了吗？'],
        low: ['今天有点没精神…', '能陪我说说话吗？', '不太想动，就在你旁边待着。'],
        sweet: ['看到你就很开心。', '今天也想和你待在一起。', '刚才一直在等你抬头。'],
        happy: ['今天状态很好！', '要不要一起做点什么？', '感觉今天会是不错的一天。']
    };

    function lines() {
        var moodState = window.AnimePetState ? window.AnimePetState.moodInfo() : null;
        var extra = moodState && MOOD_LINES[moodState.id];
        return extra ? extra.concat(IDLE_LINES) : IDLE_LINES;
    }

    function pick(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    function ui() {
        return window.AnimePetUI || null;
    }

    function say(text, timeout) {
        var module = ui();
        if (module) module.bubble(text, timeout);
    }

    function petRect() {
        return pet.getBoundingClientRect();
    }

    function clampLeft(value) {
        return Math.max(0, Math.min(value, Math.max(0, window.innerWidth - modelWidth())));
    }

    function clampBottom(value) {
        // 上边界同样要夹紧：否则 bottom 超过窗口高度时 GTK 输入热区会被推到屏幕外，
        // 整个窗口变成完全穿透，桌宠再也抓不回来。
        return Math.max(0, Math.min(value, Math.max(0, window.innerHeight - modelHeight())));
    }

    function readInt(value) {
        var parsed = parseInt(value, 10);
        return isNaN(parsed) ? 0 : parsed;
    }

    function applyPosition(left, bottom) {
        currentLeft = clampLeft(left);
        currentBottom = clampBottom(bottom);
        pet.style.left = Math.round(currentLeft) + 'px';
        pet.style.bottom = Math.round(currentBottom) + 'px';
        if (window.updateChatPanel) window.updateChatPanel();
        var module = ui();
        if (module && module.reposition) module.reposition();
    }

    function persistPosition() {
        try {
            sessionStorage.setItem('historywidth', String(Math.round(currentLeft)));
            sessionStorage.setItem('historyheight', String(Math.round(currentBottom)));
        } catch (error) {
            /* 忽略 */
        }
    }

    function syncInputRegion(prefix) {
        var module = ui();
        if (module && module.hasOverlay && module.hasOverlay()) {
            // 浮层打开时热区是「模型 + 面板」的并集，交给 UI 模块统一计算
            if (module.syncRegion) module.syncRegion();
            return;
        }
        document.title = prefix + ':' + Math.round(currentLeft) + ',' + Math.round(currentBottom);
    }

    // ------------------------------------------------------------ 数值互动

    function petHead() {
        var snapshot = state.get();
        state.add({ mood: 2, exp: 1, affection: 0.6, stat: 'pets' }, 'pet');
        if (snapshot.energy < 22) {
            say('唔…有点困，让我再靠一会儿…');
        } else if (snapshot.hunger < 20) {
            say('摸头也没用…肚子饿了。');
        } else {
            say(pick(['唔…被摸头了。', '今天也很乖嘛。', '舒服…再多摸一会儿。', '嗯？我头发乱了吗。']));
        }
        animate('is-poked');
        var module = ui();
        if (module && module.heartBurst) module.heartBurst(4);
    }

    function teaseBody() {
        var snapshot = state.get();
        state.add({ mood: 2.5, exp: 2, affection: 1, stat: 'pets' }, 'tease');
        if (snapshot.mood < 30) {
            say('别闹啦…今天心情有点低。');
        } else {
            say(pick(['呀，痒！', '你干嘛突然戳我。', '再戳我就要生气了哦。']));
        }
        animate('is-spin');
        var module = ui();
        if (module && module.heartBurst) module.heartBurst(3);
    }

    function animate(className) {
        pet.classList.remove(className);
        void pet.offsetWidth;
        pet.classList.add(className);
        window.setTimeout(function () {
            pet.classList.remove(className);
        }, 950);
    }

    // ------------------------------------------------------------ 点击 / 双击

    function openChat() {
        if (window.openChatPanel) window.openChatPanel();
    }

    function handleTap(event) {
        var rect = petRect();
        var ratioY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
        var now = Date.now();
        if (now - lastTapAt < DOUBLE_TAP_GAP) {
            lastTapAt = 0;
            if (tapTimer) {
                window.clearTimeout(tapTimer);
                tapTimer = null;
            }
            if (ratioY < 0.45) petHead();
            else teaseBody();
            return;
        }
        lastTapAt = now;
        if (tapTimer) window.clearTimeout(tapTimer);
        tapTimer = window.setTimeout(function () {
            tapTimer = null;
            // 双击窗口已过，视为打开聊天
            openChat();
        }, TAP_DELAY);
    }

    // ------------------------------------------------------------ 指针手势

    function pushSample(x, y) {
        samples.push({ x: x, y: y, t: performance.now() });
        if (samples.length > 6) samples.shift();
    }

    function computeVelocity() {
        if (samples.length < 2) return { x: 0, y: 0 };
        var first = samples[0];
        var last = samples[samples.length - 1];
        var dt = (last.t - first.t) / 1000;
        if (dt <= 0.008) return { x: 0, y: 0 };
        return {
            x: (last.x - first.x) / dt,
            y: (last.y - first.y) / dt
        };
    }

    function onDown(event) {
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('#pet-menu, #pet-hud, #pet-rps, #chat-panel')) return;
        // 清掉未决的单击计时，避免「点一下再拖」时在拖拽途中弹出聊天窗
        if (tapTimer) {
            window.clearTimeout(tapTimer);
            tapTimer = null;
        }
        if (throwFrame) {
            cancelAnimationFrame(throwFrame);
            throwFrame = null;
        }
        pointerId = event.pointerId;
        dragging = true;
        moved = false;
        startedAt = performance.now();
        startX = event.clientX;
        startY = event.clientY;
        startLeft = readInt(pet.style.left);
        startBottom = readInt(pet.style.bottom);
        currentLeft = startLeft;
        currentBottom = startBottom;
        samples = [];
        pushSample(event.clientX, event.clientY);
        try {
            pet.setPointerCapture(event.pointerId);
        } catch (error) {
            /* 某些合成事件没有有效 pointerId */
        }
        lastInteractionAt = Date.now();
        event.preventDefault();
    }

    function onMove(event) {
        if (!dragging || event.pointerId !== pointerId) return;
        var dx = event.clientX - startX;
        var dy = event.clientY - startY;
        pushSample(event.clientX, event.clientY);
        if (!moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            moved = true;
            document.title = 'drag_start';
            var module = ui();
            if (module && module.pauseRegion) module.pauseRegion(true);
        }
        applyPosition(startLeft + dx, startBottom - dy);
    }

    function finishThrow(velocityX, velocityY) {
        var left = currentLeft;
        var bottom = currentBottom;
        var vx = velocityX;
        var vy = velocityY;
        var last = performance.now();
        var restitution = 0.42;
        var gravity = 2400;

        function frame(now) {
            var dt = Math.min(0.045, Math.max(0.001, (now - last) / 1000));
            last = now;
            vy -= gravity * dt;
            left += vx * dt;
            bottom += vy * dt;

            if (left < 0) {
                left = 0;
                vx = Math.abs(vx) * 0.5;
            } else if (left > window.innerWidth - modelWidth()) {
                left = window.innerWidth - modelWidth();
                vx = -Math.abs(vx) * 0.5;
            }

            if (bottom <= 0) {
                bottom = 0;
                if (Math.abs(vy) > 130) {
                    vy = -vy * restitution;
                    vx *= 0.86;
                } else {
                    vy = 0;
                    vx *= 0.7;
                    if (Math.abs(vx) < 12) {
                        vx = 0;
                    }
                }
                if (vy === 0 && vx === 0) {
                    applyPosition(left, bottom);
                    persistPosition();
                    syncInputRegion('drag_end');
                    animate('is-landing');
                    throwFrame = null;
                    return;
                }
            }

            var ceiling = Math.max(0, window.innerHeight - modelHeight());
            if (bottom > ceiling) {
                bottom = ceiling;
                vy = -Math.abs(vy) * restitution;
            }

            applyPosition(left, bottom);
            throwFrame = requestAnimationFrame(frame);
        }

        throwFrame = requestAnimationFrame(frame);
    }

    /** 拖拽/抛掷结束的统一收尾：复位状态、恢复热区、保存位置 */
    function finishDragGesture() {
        dragging = false;
        pointerId = null;
        var module = ui();
        if (module && module.pauseRegion) module.pauseRegion(false);
        if (moved) {
            persistPosition();
            syncInputRegion('drag_end');
        }
    }

    function onUp(event) {
        if (!dragging) return;
        if (event.pointerId !== pointerId) {
            // pointerId 丢失时必须收尾，否则 drag_start 永远不会配对 drag_end，
            // 整个透明窗口会一直保持全屏输入。
            finishDragGesture();
            return;
        }
        var wasMoved = moved;
        try {
            pet.releasePointerCapture(event.pointerId);
        } catch (error) {
            /* 忽略 */
        }
        finishDragGesture();

        if (wasMoved) {
            suppressClick = true;
            window.setTimeout(function () {
                suppressClick = false;
            }, 320);
            var speed = computeVelocity();
            var fast = Math.abs(speed.x) > 260 || Math.abs(speed.y) > 260;
            if (fast) {
                say(pick(['哇——要被甩飞了！', '轻一点啦！', '呀！']), 1400);
                // 屏幕坐标 y 向下为正，而 bottom 向上为正，这里要翻转符号。
                finishThrow(speed.x, -speed.y);
            }
            return;
        }

        handleTap(event);
    }

    function onCancel() {
        if (!dragging) return;
        finishDragGesture();
    }

    // 拖拽后的 click 不应触发 cubism3 的 tap_body 动作
    document.addEventListener('click', function (event) {
        if (!suppressClick) return;
        if (!pet.contains(event.target)) return;
        suppressClick = false;
        event.stopPropagation();
        event.preventDefault();
    }, true);

    pet.addEventListener('pointerdown', onDown, true);
    pet.addEventListener('pointermove', onMove, true);
    pet.addEventListener('pointerup', onUp, true);
    pet.addEventListener('pointercancel', onCancel, true);

    pet.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        var module = ui();
        if (module && module.openMenu) module.openMenu(event.clientX, event.clientY);
    });

    window.addEventListener('blur', function () {
        if (!dragging) return;
        finishDragGesture();
    });

    // ------------------------------------------------------------ 待机行为

    function timeGreeting() {
        // 与 message.js 的 localGreeting 共用一份时段文案（存在则直接用）
        if (typeof window.animePetGreeting === 'function') return window.animePetGreeting();
        var hour = new Date().getHours();
        if (hour >= 5 && hour < 9) return '早上好，今天也要好好吃早饭。';
        if (hour >= 9 && hour < 12) return '上午好，记得起来活动一下。';
        if (hour >= 12 && hour < 14) return '中午啦，去吃点东西吧。';
        if (hour >= 14 && hour < 18) return '下午容易犯困，喝点水。';
        if (hour >= 18 && hour < 22) return '晚上好，今天辛苦了。';
        return '这么晚还没睡吗？我陪你一会儿。';
    }

    function idleTick() {
        if (Date.now() < nextIdleAt) return;
        nextIdleAt = Date.now() + 45000 + Math.random() * 45000;
        var module = ui();
        if (module && module.hasOverlay && module.hasOverlay()) return;
        if (dragging || document.visibilityState === 'hidden') return;
        var snapshot = state.get();
        if (snapshot.energy < 25) {
            say('有点困…先安静一会儿。');
            animate('is-happy-hop');
            return;
        }
        var roll = Math.random();
        if (roll < 0.18) {
            say(timeGreeting());
        } else if (roll < 0.62) {
            say(pick(lines()));
        } else {
            animate('is-happy-hop');
            say(pick(['嗯？', '在的。', '我一直都在这里。']));
        }
    }

    window.setInterval(idleTick, 5000);

    // ------------------------------------------------------------ 启动恢复

    function restore() {
        var left = readInt(pet.style.left);
        var bottom = readInt(pet.style.bottom);
        currentLeft = left;
        currentBottom = bottom;
        // 即使 (0,0) 也要同步：GTK 默认热区按 left=5 计算，不发送会留下 5px 偏差。
        document.title = 'restore:' + left + ',' + bottom;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            window.setTimeout(restore, 30);
        });
    } else {
        window.setTimeout(restore, 30);
    }

    window.AnimePetInteract = {
        say: say,
        animate: animate,
        restore: restore,
        idleLines: lines
    };
})();
