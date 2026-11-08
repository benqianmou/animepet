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
    var overlay = window.AnimePetOverlay;
    ui.enter = overlay.enter;
    ui.leave = overlay.leave;
    ui.hasOverlay = overlay.hasOverlay;
    ui.pauseRegion = overlay.pauseRegion;
    ui.syncRegion = overlay.syncRegion;
    ui.placeNear = overlay.placeNear;

    var pet = document.getElementById('landlord');
    var panel = document.getElementById('chat-panel');
    var hud = document.getElementById('pet-hud');
    var menu = document.getElementById('pet-menu');
    var rps = document.getElementById('pet-rps');
    var toastEl = document.getElementById('pet-toast');
    var lastJournalSig = '';

    var toastTimer = null;
    var bound = false;

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
    ui.isHudOpen = function () {
        return hud.classList.contains('is-open');
    };

    ui.animatePet = playPetAnimation;
    ui.updateGiftUi = function () { updateGiftUi(state.get()); };

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


    ui.reposition = function () {
        if (hud.classList.contains('is-open')) ui.placeNear(hud, 7);
        if (menu.classList.contains('is-open')) {
            // 菜单由 openMenu 记录锚点，这里只做边界回收
            clampMenu();
        }
        ui.syncRegion();
    };

    // 聊天面板定位保留在 chat.js 中（那里有更多上下文），这里只暴露给对手势模块

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
        if (window.AnimePetReminders) window.AnimePetReminders.refreshUi();
    }

    ui.refresh = refreshHud;
    window.setInterval(refreshHud, 15000);

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
        ui.placeNear(hud, 7);
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
        if (rps.classList.contains('is-open') && window.AnimePetRps) window.AnimePetRps.close();
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

    // ------------------------------------------------------------ 菜单动作

    function handleAction(action) {
        switch (action) {
            case 'hud':
                ui.openHud();
                break;
            case 'focus':
                closeMenu();
                if (window.AnimePetReminders) window.AnimePetReminders.start(25);
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
                if (window.AnimePetRps) window.AnimePetRps.open();
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
            if (event.target.checked && window.AnimePetReminders) window.AnimePetReminders.resetWaterTimer();
        });
        document.getElementById('hud-hourly').addEventListener('change', function (event) {
            state.setSetting('hourly', event.target.checked);
        });

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
                else if (action === 'play' && window.AnimePetRps) window.AnimePetRps.open();
                else if (action === 'focus' && window.AnimePetReminders) window.AnimePetReminders.start(25);
            });
        });
        document.getElementById('hud-focus-stop').addEventListener('click', function () {
            if (window.AnimePetReminders) window.AnimePetReminders.stop(false);
            refreshHud();
        });

        Array.prototype.forEach.call(menu.querySelectorAll('.pet-menu-item'), function (item) {
            item.addEventListener('click', function () {
                handleAction(item.dataset.action);
            });
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
        if (window.AnimePetReminders) window.AnimePetReminders.refreshUi();
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
        if (window.AnimePetReminders) window.AnimePetReminders.refreshUi();
    }
})();
