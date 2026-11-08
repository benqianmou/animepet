/*
 * AnimePet v2 · 陪伴界面（HUD / 右键菜单 / 猜拳 / 专注计时 / 提醒）
 * ---------------------------------------------------------------------------
 * 与 Rust 的通信仍沿用 document.title 协议：
 *   chat_open            —— 有浮层打开：清空输入热区并允许键盘
 *   chat_close:left,bottom —— 所有浮层关闭：恢复模型热区
 *
 * 浮层用引用计数管理，聊天窗、HUD、菜单、猜拳弹窗互不覆盖。
 */
(function () {
    'use strict';

    var state = window.AnimePetState;
    var ui = {};
    var overlays = {};

    var pet = document.getElementById('landlord');
    var panel = document.getElementById('chat-panel');
    var hud = document.getElementById('pet-hud');
    var menu = document.getElementById('pet-menu');
    var rps = document.getElementById('pet-rps');
    var toastEl = document.getElementById('pet-toast');
    var tabsBar = document.getElementById('hud-tabs');
    var tabButtons = tabsBar ? Array.prototype.slice.call(tabsBar.querySelectorAll('.tab-btn')) : [];
    var tabPages = {
        status: document.getElementById('page-status'),
        interact: document.getElementById('page-interact'),
        memory: document.getElementById('page-memory')
    };
    var activeTab = 'status';
    var activeTabIndex = 0;
    var lastJournalSig = '';

    var focusBox = document.getElementById('hud-focus');
    var focusTime = document.getElementById('hud-focus-time');
    var focusLabel = document.getElementById('hud-focus-label');

    var FOCUS_KEY = 'animepet-focus-v1';
    var WATER_KEY = 'animepet-last-water';
    var WATER_INTERVAL = 45 * 60 * 1000;
    var focus = loadFocus();
    var toastTimer = null;
    var lastHour = new Date().getHours();
    var bound = false;

    // ------------------------------------------------------------ 浮层管理

    function petPosition() {
        var left = parseInt(pet.style.left, 10);
        var bottom = parseInt(pet.style.bottom, 10);
        return {
            left: isNaN(left) ? 5 : left,
            bottom: isNaN(bottom) ? 0 : bottom
        };
    }

    function clearInputRegion() {
        document.title = 'chat_open';
    }

    function restoreInputRegion() {
        var position = petPosition();
        document.title = 'chat_close:' + position.left + ',' + position.bottom;
    }

    var regionTimer = null;
    var regionPaused = false;

    function rectPayload(el, padding) {
        var rect = el.getBoundingClientRect();
        // offsetWidth/Height 不受入场动画的 scale 影响；用中心对齐反推出布局盒。
        var width = el.offsetWidth || Math.round(rect.width);
        var height = el.offsetHeight || Math.round(rect.height);
        if (width <= 0 || height <= 0) return '';
        var left = rect.left + (rect.width - width) / 2;
        var top = rect.top + (rect.height - height) / 2;
        var pad = padding || 0;
        return [
            Math.round(left - pad),
            Math.round(top - pad),
            Math.round(width + pad * 2),
            Math.round(height + pad * 2)
        ].join(',');
    }

    /**
     * 输入热区 = 模型 + 当前可见浮层。其余桌面区域保持穿透，
     * 这样打开聊天窗后仍然可以操作别的窗口。
     */
    function pushInputRegion() {
        if (Object.keys(overlays).length === 0) return;
        // 猜拳是整屏模态：保持 modal_open（Rust 会清空热区并给键盘焦点），
        // 不要让 region: 把它覆盖成小热区。
        if (overlays.rps) return;
        var parts = [rectPayload(pet, 14)];
        var chatPanel = document.getElementById('chat-panel');
        if (overlays.chat && chatPanel.classList.contains('is-open')) parts.push(rectPayload(chatPanel, 0));
        if (overlays.hud && hud.classList.contains('is-open')) parts.push(rectPayload(hud, 0));
        if (overlays.menu && menu.classList.contains('is-open')) parts.push(rectPayload(menu, 0));
        var spec = parts.filter(Boolean).join(';');
        if (spec) document.title = 'region:' + spec;
    }

    /**
     * 合并同一轮事件内的多次调用。用 setTimeout 而不是 rAF：
     * WebKitGTK / 无头渲染下 rAF 在窗口不可见时可能被节流，热区会卡在旧值。
     */
    ui.syncRegion = function () {
        if (regionPaused || regionTimer) return;
        regionTimer = window.setTimeout(function () {
            regionTimer = null;
            pushInputRegion();
        }, 0);
    };

    /**
     * 只有聊天浮层需要键盘输入（chat_open）；菜单 / 陪伴面板 / 猜拳只扩大输入热区
     * （overlay_open），避免右键菜单也抢焦点、把窗口抬到最前。
     */
    function syncOverlayTitle() {
        var ids = Object.keys(overlays);
        if (ids.length === 0) {
            restoreInputRegion();
            return;
        }
        if (overlays.rps) document.title = 'modal_open';
        else if (overlays.chat) clearInputRegion();
        else document.title = 'overlay_open';
        ui.syncRegion();
    }

    ui.enter = function (id) {
        overlays[id] = true;
        syncOverlayTitle();
    };

    ui.leave = function (id) {
        delete overlays[id];
        syncOverlayTitle();
    };

    ui.hasOverlay = function () {
        return Object.keys(overlays).length > 0;
    };

    /** 拖拽期间暂停热区更新，保持 drag_start 的全屏输入直到松手 */
    ui.pauseRegion = function (paused) {
        regionPaused = !!paused;
        if (!regionPaused) ui.syncRegion();
    };

    // ------------------------------------------------------------ 气泡与提示

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    ui.bubble = function (text, timeout) {
        var node = document.querySelector('.message');
        if (!node || !text) return;
        node.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
        window.clearTimeout(node._timer);
        if (window.jQuery) {
            var $node = window.jQuery(node);
            $node.stop(true, true).fadeTo(180, 1);
            $node.delay(timeout || 4200).fadeTo(260, 0);
        } else {
            node.style.opacity = '1';
            node._timer = window.setTimeout(function () {
                node.style.opacity = '0';
            }, timeout || 4200);
        }
    };

    ui.toast = function (text, timeout) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.classList.add('is-open');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toastEl.classList.remove('is-open');
        }, timeout || 4600);
    };

    function speak(text) {
        if (typeof window.animePetSpeak === 'function') {
            try {
                window.animePetSpeak(text);
            } catch (error) {
                console.warn('[AnimePet] 语音播报失败:', error);
            }
        }
    }

    function desktopNotify(title, body) {
        try {
            var auth = window.AnimePetAuth;
            var options = auth
                ? auth.post({ title: title, body: body })
                : {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title: title, body: body })
                };
            fetch('/notify', options).catch(function () { /* 忽略 */ });
        } catch (error) {
            /* 忽略 */
        }
    }

    /** 提醒统一出口：气泡 + toast + 语音 + 桌面通知 */
    ui.remind = function (text, options) {
        options = options || {};
        ui.bubble(text, options.timeout || 5200);
        ui.toast(text);
        if (options.speak !== false) speak(text);
        if (options.notify !== false) {
            desktopNotify(options.title || 'AnimePet', text);
        }
    };

    // ------------------------------------------------------------ 面板定位

    function placeNear(el, gap) {
        if (!el) return;
        gap = gap === undefined ? 12 : gap;
        var rect = pet.getBoundingClientRect();
        var width = el.offsetWidth;
        var height = el.offsetHeight;
        var left = rect.right + gap;
        if (left + width > window.innerWidth - 12) left = rect.left - width - gap;
        left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
        var top = rect.bottom - height;
        top = Math.max(12, Math.min(top, window.innerHeight - height - 12));
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
    }

    ui.placeNear = placeNear;

    ui.reposition = function () {
        if (hud.classList.contains('is-open')) placeNear(hud, 7);
        if (menu.classList.contains('is-open')) {
            // 菜单由 openMenu 记录锚点，这里只做边界回收
            clampMenu();
        }
        ui.syncRegion();
    };

    // 聊天面板定位保留在 chat.js 中（那里有更多上下文），这里只暴露给对手势模块
    ui.petPosition = petPosition;

    // ------------------------------------------------------------ HUD

    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function setBar(stat, value) {
        var row = hud.querySelector('.stat[data-stat="' + stat + '"]');
        if (!row) return;
        var fill = row.querySelector('.bar > i');
        var label = row.querySelector('b');
        if (fill) fill.style.width = Math.round(value) + '%';
        if (label) label.textContent = Math.round(value) + '%';
    }

    function formatRelative(timestamp) {
        var diff = Math.max(0, Date.now() - timestamp);
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
        var date = new Date(timestamp);
        return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
    }

    function renderJournal(snapshot) {
        var list = document.getElementById('hud-journal');
        if (!list) return;
        var journal = snapshot.journal || [];
        var signature = journal.map(function (entry) {
            return entry.t + entry.type + entry.text;
        }).join('|');
        if (signature === lastJournalSig) return;
        lastJournalSig = signature;
        list.innerHTML = '';
        if (!journal.length) {
            var empty = document.createElement('li');
            empty.className = 'journal-empty';
            empty.textContent = '还没有回忆。投喂、送礼物、完成专注，都会写进这里。';
            list.appendChild(empty);
            return;
        }
        journal.forEach(function (entry) {
            var item = document.createElement('li');
            item.className = 'journal-item';
            item.dataset.type = entry.type || 'note';

            var dot = document.createElement('span');
            dot.className = 'journal-dot';

            var body = document.createElement('div');
            body.className = 'journal-body';

            var text = document.createElement('p');
            text.className = 'journal-text';
            text.textContent = entry.text;

            var time = document.createElement('span');
            time.className = 'journal-time';
            time.textContent = formatRelative(entry.t);

            body.appendChild(text);
            body.appendChild(time);
            item.appendChild(dot);
            item.appendChild(body);
            list.appendChild(item);
        });
    }

    function updateGiftUi(snapshot) {
        var favorite = state.favoriteGiftId();
        var remaining = Math.max(0, 20000 - (Date.now() - snapshot.gifts.lastAt));
        var cooling = remaining > 0;
        Array.prototype.forEach.call(hud.querySelectorAll('.gift-btn'), function (button) {
            button.classList.toggle('is-favorite', button.dataset.gift === favorite);
            button.classList.toggle('is-cooling', cooling);
        });
        var hint = document.getElementById('hud-gift-hint');
        if (hint) {
            hint.textContent = cooling
                ? '消化中 · ' + Math.ceil(remaining / 1000) + 's'
                : '每个角色都有偏好';
        }
    }

    function refreshHud() {
        var snapshot = state.get();
        var info = state.levelInfo();
        var stage = state.stageInfo();
        var mood = state.moodInfo();
        hud.dataset.mood = mood.id;
        setBar('affection', snapshot.affection);
        setBar('mood', snapshot.mood);
        setBar('hunger', snapshot.hunger);
        setBar('energy', snapshot.energy);
        var levelEl = document.getElementById('hud-level');
        if (levelEl) levelEl.textContent = 'Lv.' + info.level + ' · ' + info.title;
        var expFill = document.getElementById('hud-exp-fill');
        var expText = document.getElementById('hud-exp-text');
        if (expFill) expFill.style.width = Math.round(info.progress * 100) + '%';
        if (expText) expText.textContent = info.max ? 'MAX' : info.exp + ' / ' + info.next;
        var nameEl = document.getElementById('hud-name');
        var model = window.getAnimePetModel ? window.getAnimePetModel() : null;
        if (nameEl && model) nameEl.textContent = model.name;

        var stageEl = document.getElementById('hud-stage');
        if (stageEl) stageEl.textContent = stage.name;
        var stageFill = document.getElementById('hud-stage-fill');
        if (stageFill) stageFill.style.width = Math.round(stage.progress * 100) + '%';
        var stageText = document.getElementById('hud-stage-text');
        if (stageText) {
            stageText.textContent = stage.max
                ? stage.name + ' · MAX'
                : stage.name + ' ' + Math.round(snapshot.affection) + ' / ' + stage.next;
        }

        var moodEmoji = document.getElementById('hud-mood-emoji');
        if (moodEmoji) moodEmoji.textContent = mood.emoji;
        var moodLabel = document.getElementById('hud-mood-label');
        if (moodLabel) moodLabel.textContent = mood.label;
        var moodHint = document.getElementById('hud-mood-hint');
        if (moodHint) moodHint.textContent = mood.hint;
        var days = document.getElementById('hud-days');
        if (days) days.textContent = '第 ' + state.daysTogether() + ' 天';

        var streakDays = document.getElementById('hud-streak-days');
        if (streakDays) streakDays.textContent = '连续 ' + snapshot.streak.days + ' 天';
        var streakHint = document.getElementById('hud-streak-hint');
        if (streakHint) {
            streakHint.textContent = snapshot.streak.lastDay === new Date().getFullYear() + '-' + (new Date().getMonth() + 1) + '-' + new Date().getDate()
                ? '今天已经签到'
                : '今天还没签到';
        }
        var checkins = document.getElementById('hud-checkins');
        if (checkins) checkins.textContent = snapshot.stats.checkins + ' 次';

        document.getElementById('hud-water').checked = !!snapshot.settings.water;
        document.getElementById('hud-hourly').checked = !!snapshot.settings.hourly;
        updateGiftUi(snapshot);
        renderJournal(snapshot);
        refreshFocusUi();
    }

    ui.refresh = refreshHud;

    // ------------------------------------------------------------ Tab 切换（Telegram 风格）

    function selectTab(name, animate) {
        var index = -1;
        for (var i = 0; i < tabButtons.length; i++) {
            if (tabButtons[i].dataset.tab === name) index = i;
        }
        if (index < 0) return;
        var page = tabPages[name];
        if (!page) return;
        if (index === activeTabIndex && page.classList.contains('is-active')) return;
        var direction = index > activeTabIndex ? 1 : -1;
        activeTabIndex = index;
        activeTab = name;
        tabsBar.style.setProperty('--tab-index', String(index));

        var indicator = tabsBar.querySelector('.tab-indicator');
        if (indicator && animate) {
            indicator.classList.add('is-moving');
            window.clearTimeout(indicator._moveTimer);
            indicator._moveTimer = window.setTimeout(function () {
                indicator.classList.remove('is-moving');
            }, 380);
        }

        tabButtons.forEach(function (button) {
            var on = button.dataset.tab === name;
            button.classList.toggle('is-active', on);
            button.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on && animate) {
                button.classList.remove('is-bouncing');
                void button.offsetWidth;
                button.classList.add('is-bouncing');
                window.setTimeout(function () { button.classList.remove('is-bouncing'); }, 460);
            }
        });

        Object.keys(tabPages).forEach(function (key) {
            var target = tabPages[key];
            var on = key === name;
            if (on) {
                target.hidden = false;
                // 内容从切换方向滑入：向右切从右侧进来，向左切从左侧进来
                target.style.setProperty('--page-shift', (direction > 0 ? 18 : -18) + 'px');
                target.classList.remove('is-active');
                void target.offsetWidth;
                target.classList.add('is-active');
            } else {
                target.classList.remove('is-active');
                target.hidden = true;
            }
        });
        ui.syncRegion();
    }

    ui.selectTab = selectTab;

    // ------------------------------------------------------------ 爱心粒子

    ui.heartBurst = function (count) {
        if (reduceMotion) return;
        var rect = pet.getBoundingClientRect();
        var total = count || 6;
        for (var i = 0; i < total; i++) {
            var heart = document.createElement('span');
            heart.className = 'heart-burst';
            heart.textContent = i % 3 === 0 ? '♡' : '♥';
            heart.style.left = Math.round(rect.left + rect.width * (0.3 + Math.random() * 0.4)) + 'px';
            heart.style.top = Math.round(rect.top + rect.height * (0.25 + Math.random() * 0.2)) + 'px';
            heart.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 56) + 'px');
            heart.style.animationDelay = (i * 45) + 'ms';
            document.body.appendChild(heart);
            window.setTimeout(function (node) {
                return function () { node.remove(); };
            }(heart), 1250 + i * 45);
        }
    };

    ui.openHud = function () {
        // 先登记浮层再关菜单：避免中间态把输入热区收回模型矩形
        ui.enter('hud');
        if (window.closeChatPanel) window.closeChatPanel();
        hud.classList.add('is-open');
        closeMenu();
        refreshHud();
        placeNear(hud, 7);
        ui.syncRegion();
        // 入场动画结束后按最终尺寸再校正一次
        window.setTimeout(ui.syncRegion, 260);
    };

    ui.closeHud = function () {
        hud.classList.remove('is-open');
        ui.leave('hud');
    };

    ui.toggleHud = function () {
        if (hud.classList.contains('is-open')) ui.closeHud();
        else ui.openHud();
    };

    // ------------------------------------------------------------ 右键菜单

    function closeMenu() {
        if (!menu.classList.contains('is-open')) return;
        menu.classList.remove('is-open');
        ui.leave('menu');
    }

    function clampMenu() {
        var rect = menu.getBoundingClientRect();
        var left = Math.min(parseInt(menu.style.left, 10) || rect.left, window.innerWidth - rect.width - 10);
        var top = Math.min(parseInt(menu.style.top, 10) || rect.top, window.innerHeight - rect.height - 10);
        menu.style.left = Math.max(10, left) + 'px';
        menu.style.top = Math.max(10, top) + 'px';
    }

    ui.openMenu = function (x, y) {
        closeMenu();
        ui.enter('menu');
        menu.classList.add('is-open');
        menu.style.left = Math.max(10, Math.min(x, window.innerWidth - 210)) + 'px';
        menu.style.top = Math.max(10, Math.min(y, window.innerHeight - menu.offsetHeight - 10)) + 'px';
        clampMenu();
        ui.syncRegion();
        window.setTimeout(ui.syncRegion, 180);
        var first = menu.querySelector('.pet-menu-item');
        if (first) first.focus();
    };

    ui.closeMenu = closeMenu;

    window.addEventListener('resize', function () {
        ui.reposition();
    });

    document.addEventListener('pointerdown', function (event) {
        if (!menu.classList.contains('is-open')) return;
        if (!menu.contains(event.target)) closeMenu();
    }, true);

    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        if (rps.classList.contains('is-open')) closeRps();
        else if (menu.classList.contains('is-open')) closeMenu();
        else if (hud.classList.contains('is-open')) ui.closeHud();
        else if (panel.classList.contains('is-open') && window.closeChatPanel) window.closeChatPanel();
    });

    // ------------------------------------------------------------ 投喂

    var lastFeedAt = 0;

    ui.feed = function () {
        var snapshot = state.get();
        var now = Date.now();
        if (snapshot.hunger >= 96) {
            ui.bubble('已经吃得饱饱的啦，再吃要胖了…');
            return false;
        }
        if (now - lastFeedAt < 1200) return false;
        lastFeedAt = now;
        state.add({ hunger: 26, mood: 5, affection: 1.5, exp: 4, stat: 'feeds' }, 'feed');
        ui.bubble(pick(['好吃！再来一份～', '唔…这个味道，我很喜欢。', '谢谢，你记得我喜欢甜的。']));
        playPetAnimation('is-happy-hop');
        refreshHud();
        return true;
    };

    function pick(lines) {
        return lines[Math.floor(Math.random() * lines.length)];
    }

    function playPetAnimation(className) {
        if (!pet) return;
        pet.classList.remove(className);
        // 强制回流以重启动画
        void pet.offsetWidth;
        pet.classList.add(className);
        window.setTimeout(function () {
            pet.classList.remove(className);
        }, 900);
    }

    // ------------------------------------------------------------ 猜拳

    var HANDS = {
        rock: { emoji: '✊', label: '石头' },
        scissors: { emoji: '✌️', label: '剪刀' },
        paper: { emoji: '🖐', label: '布' }
    };
    var RPS_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
    var rpsBusy = false;

    var rpsReturnFocus = null;

    function openRps() {
        rpsReturnFocus = document.activeElement;
        ui.enter('rps');
        rps.classList.add('is-open');
        closeMenu();
        document.getElementById('rps-you').textContent = '❔';
        document.getElementById('rps-pet').textContent = '❔';
        document.getElementById('rps-result').textContent = '出什么？赢了我会有奖励哦。';
        setRpsDisabled(false);
        rpsBusy = false;
        ui.syncRegion();
        window.setTimeout(ui.syncRegion, 240);
        var firstChoice = rps.querySelector('.rps-choice');
        if (firstChoice) firstChoice.focus();
    }

    function closeRps() {
        rps.classList.remove('is-open');
        ui.leave('rps');
        if (rpsReturnFocus && typeof rpsReturnFocus.focus === 'function') {
            rpsReturnFocus.focus();
            rpsReturnFocus = null;
        }
    }

    // 焦点陷阱：Tab 只在弹窗内的可交互元素之间循环
    rps.addEventListener('keydown', function (event) {
        if (event.key !== 'Tab' || !rps.classList.contains('is-open')) return;
        var focusable = rps.querySelectorAll('button:not([disabled])');
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    function setRpsDisabled(disabled) {
        Array.prototype.forEach.call(rps.querySelectorAll('.rps-choice'), function (button) {
            button.disabled = disabled;
        });
    }

    function playRps(playerHand) {
        if (rpsBusy) return;
        rpsBusy = true;
        setRpsDisabled(true);
        var keys = Object.keys(HANDS);
        var petHand = keys[Math.floor(Math.random() * keys.length)];
        var youEl = document.getElementById('rps-you');
        var petEl = document.getElementById('rps-pet');
        var resultEl = document.getElementById('rps-result');
        youEl.textContent = HANDS[playerHand].emoji;
        petEl.textContent = '✊';
        petEl.classList.add('is-shake');
        resultEl.textContent = '…';
        window.setTimeout(function () {
            petEl.classList.remove('is-shake');
            petEl.textContent = HANDS[petHand].emoji;
            youEl.classList.remove('is-win', 'is-lose');
            petEl.classList.remove('is-win', 'is-lose');
            var outcome;
            if (playerHand === petHand) {
                outcome = 'draw';
            } else if (RPS_BEATS[playerHand] === petHand) {
                outcome = 'win';
            } else {
                outcome = 'lose';
            }
            if (outcome === 'win') {
                youEl.classList.add('is-win');
                resultEl.textContent = '你赢了！好感 +2，经验 +6';
                state.add({ exp: 6, affection: 2, mood: 4, stat: 'plays' }, 'rps-win');
                ui.bubble('唔…这局算你厉害。');
            } else if (outcome === 'draw') {
                resultEl.textContent = '平局，再来一局？经验 +2';
                state.add({ exp: 2, mood: 1, stat: 'plays' }, 'rps-draw');
            } else {
                youEl.classList.add('is-lose');
                resultEl.textContent = '我赢了～不过陪你玩很开心，心情 +2';
                state.add({ mood: 2, exp: 1, stat: 'plays' }, 'rps-lose');
            }
            refreshHud();
            rpsBusy = false;
            setRpsDisabled(false);
        }, 520);
    }

    // ------------------------------------------------------------ 专注计时

    function loadFocus() {
        try {
            var raw = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                return {
                    endsAt: Number(raw.endsAt) || 0,
                    minutes: Number(raw.minutes) || 25
                };
            }
        } catch (error) {
            /* 忽略损坏数据 */
        }
        return { endsAt: 0, minutes: 25 };
    }

    function saveFocus() {
        try {
            localStorage.setItem(FOCUS_KEY, JSON.stringify(focus));
        } catch (error) {
            /* 忽略 */
        }
    }

    function focusRemaining() {
        return Math.max(0, focus.endsAt - Date.now());
    }

    function focusActive() {
        return focus.endsAt > 0;
    }

    function refreshFocusUi() {
        if (!focusBox) return;
        if (!focusActive()) {
            focusBox.hidden = true;
            return;
        }
        focusBox.hidden = false;
        var remaining = focusRemaining();
        var totalSeconds = Math.ceil(remaining / 1000);
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = totalSeconds % 60;
        focusTime.textContent = (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
        if (focusLabel) focusLabel.textContent = '专注中';
        // 专注条出现/消失会改变 HUD 高度，热区需要跟着更新
        if (hud.classList.contains('is-open')) ui.syncRegion();
    }

    function startFocus(minutes) {
        minutes = minutes || 25;
        focus.endsAt = Date.now() + minutes * 60000;
        focus.minutes = minutes;
        saveFocus();
        refreshFocusUi();
        ui.bubble('好，专心' + minutes + '分钟，我陪着你。');
        ui.toast('专注开始：' + minutes + ' 分钟');
        if (window.AnimePetUI.isHudOpen()) refreshHud();
        return true;
    }

    function stopFocus(silent) {
        var wasActive = focusActive();
        focus.endsAt = 0;
        saveFocus();
        refreshFocusUi();
        if (wasActive && !silent) {
            ui.bubble('这次先休息一下，下次再一起加油。');
        }
    }

    function completeFocus() {
        var minutes = focus.minutes || 25;
        focus.endsAt = 0;
        saveFocus();
        state.add({ exp: 12, affection: 2, energy: -6, mood: 4, stat: 'focus' }, 'focus-done');
        state.note('focus', '陪你完成了 ' + minutes + ' 分钟专注');
        ui.remind('专注 ' + minutes + ' 分钟完成！休息一下吧。', { title: 'AnimePet · 专注完成' });
        playPetAnimation('is-happy-hop');
        refreshFocusUi();
        refreshHud();
    }

    ui.isHudOpen = function () {
        return hud.classList.contains('is-open');
    };
    ui.startFocus = startFocus;
    ui.stopFocus = stopFocus;
    ui.focus = {
        start: startFocus,
        stop: stopFocus,
        active: focusActive,
        remaining: focusRemaining
    };

    // ------------------------------------------------------------ 提醒循环

    function reminderTick() {
        // 专注结束
        if (focusActive() && focusRemaining() <= 0) {
            completeFocus();
        } else if (focusActive()) {
            refreshFocusUi();
        }

        var settings = state.get().settings;
        var now = Date.now();

        if (settings.water) {
            var last = Number(localStorage.getItem(WATER_KEY)) || 0;
            if (!last) {
                localStorage.setItem(WATER_KEY, String(now));
            } else if (now - last >= WATER_INTERVAL) {
                localStorage.setItem(WATER_KEY, String(now));
                ui.remind(pick(['该喝水啦，别只顾着敲代码。', '起来活动一下，顺便喝口水吧。', '眼睛也需要休息，看看远处～']), {
                    title: 'AnimePet · 喝水提醒'
                });
            }
        }

        if (settings.hourly) {
            var hour = new Date().getHours();
            if (hour !== lastHour) {
                lastHour = hour;
                ui.bubble((hour < 10 ? '0' : '') + hour + ':00 啦，整点报时。');
            }
        }

        if (hud.classList.contains('is-open')) updateGiftUi(state.get());
        state.tick();
    }

    window.setInterval(reminderTick, 1000);
    // 数值面板每 15 秒同步一次衰减结果
    window.setInterval(refreshHud, 15000);

    // ------------------------------------------------------------ 菜单动作

    function handleAction(action) {
        switch (action) {
            case 'hud':
                ui.openHud();
                break;
            case 'focus':
                closeMenu();
                startFocus(25);
                ui.openHud();
                break;
            case 'chat':
                if (window.openChatPanel) window.openChatPanel();
                closeMenu();
                break;
            case 'feed':
                closeMenu();
                ui.feed();
                break;
            case 'play':
                closeMenu();
                openRps();
                break;
            case 'hide-bubble':
                closeMenu();
                ui.bubble('', 1);
                break;
            case 'quit':
                closeMenu();
                quitApp();
                break;
            default:
                break;
        }
    }

    function quitApp() {
        try {
            state.save();
            var headers = window.AnimePetAuth ? window.AnimePetAuth.headers() : {};
            fetch('/app/quit', { method: 'POST', headers: headers }).catch(function () {});
        } catch (error) {
            /* 忽略 */
        }
        ui.toast('正在退出 AnimePet…', 2000);
    }

    function bindUi() {
        if (bound) return;
        bound = true;
        document.getElementById('hud-close').addEventListener('click', ui.closeHud);
        document.getElementById('hud-chat').addEventListener('click', function () {
            if (window.openChatPanel) window.openChatPanel();
            ui.closeHud();
        });
        var statusButton = document.getElementById('chat-status');
        if (statusButton) {
            statusButton.addEventListener('click', function () {
                ui.openHud();
                if (window.closeChatPanel) window.closeChatPanel();
            });
        }
        document.getElementById('hud-water').addEventListener('change', function (event) {
            state.setSetting('water', event.target.checked);
            if (event.target.checked) localStorage.setItem(WATER_KEY, String(Date.now()));
        });
        document.getElementById('hud-hourly').addEventListener('change', function (event) {
            state.setSetting('hourly', event.target.checked);
        });
        tabButtons.forEach(function (button) {
            button.addEventListener('click', function () {
                selectTab(button.dataset.tab, true);
            });
        });
        if (tabsBar) {
            tabsBar.addEventListener('keydown', function (event) {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
                var current = tabButtons.indexOf(document.activeElement);
                if (current < 0) current = activeTabIndex;
                var next = current;
                if (event.key === 'ArrowLeft') next = (current + tabButtons.length - 1) % tabButtons.length;
                else if (event.key === 'ArrowRight') next = (current + 1) % tabButtons.length;
                else if (event.key === 'Home') next = 0;
                else next = tabButtons.length - 1;
                event.preventDefault();
                tabButtons[next].focus();
                selectTab(tabButtons[next].dataset.tab, true);
            });
        }
        selectTab('status', false);

        Array.prototype.forEach.call(hud.querySelectorAll('.gift-btn'), function (button) {
            button.addEventListener('click', function () {
                var result = state.addGift(button.dataset.gift);
                if (!result.ok) {
                    if (result.reason === 'cooldown') {
                        ui.bubble('让我先消化一下，' + Math.ceil(result.remaining / 1000) + ' 秒后再来～');
                    }
                    return;
                }
                ui.heartBurst(result.favorite ? 10 : 5);
                playPetAnimation('is-happy-hop');
                ui.bubble(result.favorite ? '这是我最喜欢的…谢谢你。' : '谢谢，我会收好的。');
                refreshHud();
            });
        });

        Array.prototype.forEach.call(hud.querySelectorAll('.action-btn'), function (button) {
            button.addEventListener('click', function () {
                var action = button.dataset.action;
                if (action === 'feed') ui.feed();
                else if (action === 'play') openRps();
                else if (action === 'focus') startFocus(25);
            });
        });
        document.getElementById('hud-focus-stop').addEventListener('click', function () {
            stopFocus(false);
            refreshHud();
        });

        Array.prototype.forEach.call(menu.querySelectorAll('.pet-menu-item'), function (item) {
            item.addEventListener('click', function () {
                handleAction(item.dataset.action);
            });
        });

        Array.prototype.forEach.call(rps.querySelectorAll('.rps-choice'), function (button) {
            button.addEventListener('click', function () {
                playRps(button.dataset.hand);
            });
        });
        document.getElementById('rps-close').addEventListener('click', closeRps);
        rps.addEventListener('pointerdown', function (event) {
            if (event.target === rps) closeRps();
        });

        state.subscribe(function () {
            refreshHud();
        });

        document.addEventListener('animepet:modelchange', function () {
            refreshHud();
        });

        document.addEventListener('animepet:milestone', function (event) {
            var detail = event.detail || {};
            var stageName = detail.stage ? detail.stage.name : '';
            ui.heartBurst(10);
            playPetAnimation('is-happy-hop');
            ui.remind('亲密度达到 ' + detail.threshold + ' · ' + stageName + '！', {
                title: 'AnimePet · 新的阶段',
                notify: false
            });
            refreshHud();
        });

        document.addEventListener('animepet:state', function (event) {
            if (event.detail && event.detail.type === 'levelup') {
                ui.remind('升级啦！现在是 Lv.' + event.detail.level.level + ' · ' + event.detail.level.title, {
                    title: 'AnimePet · 升级',
                    notify: false
                });
            }
        });
    }

    // 暴露给 chat.js / pet-interact.js
    window.AnimePetUI = ui;

    document.addEventListener('DOMContentLoaded', function () {
        bindUi();
        refreshHud();
        refreshFocusUi();
        // 每日签到：同一天只触发一次
        window.setTimeout(function () {
            var daily = state.checkDaily();
            if (!daily) return;
            ui.bubble('今天是第 ' + daily.days + ' 天，谢谢你还在。', 6000);
            ui.toast('连续陪伴 ' + daily.days + ' 天，亲密度 +2');
            ui.heartBurst(8);
            refreshHud();
        }, 1800);

        // 首次使用给出一次操作引导
        try {
            if (!localStorage.getItem('animepet-tour-v2')) {
                localStorage.setItem('animepet-tour-v2', '1');
                window.setTimeout(function () {
                    ui.bubble('双击我可以摸摸头，右键能打开菜单。', 6000);
                }, 5200);
            }
        } catch (error) {
            /* localStorage 不可用时跳过引导 */
        }

        // 首次加载时把上次离开期间的衰减结果提示出来
        var snapshot = state.get();
        if (snapshot.hunger < 25) {
            window.setTimeout(function () {
                ui.bubble('肚子有点饿了…');
            }, 2200);
        }
    });

    // DOMContentLoaded 可能已经触发（脚本置于底部），兜底再执行一次
    if (document.readyState !== 'loading') {
        bindUi();
        refreshHud();
        refreshFocusUi();
    }
})();
