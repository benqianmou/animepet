/*
 * AnimePet · 专注番茄钟、喝水提醒与整点报时
 * 依赖 window.AnimePetUI / window.AnimePetState。
 */
(function () {
    'use strict';

    var FOCUS_KEY = 'animepet-focus-v1';
    var WATER_KEY = 'animepet-last-water';
    var WATER_INTERVAL = 45 * 60 * 1000;
    var hud = document.getElementById('pet-hud');
    var focusBox = document.getElementById('hud-focus');
    var focusTime = document.getElementById('hud-focus-time');
    var focusLabel = document.getElementById('hud-focus-label');
    var focus = loadFocus();
    var lastHour = new Date().getHours();

    function ui() { return window.AnimePetUI; }
    function state() { return window.AnimePetState; }
    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

    function loadFocus() {
        try {
            var raw = JSON.parse(localStorage.getItem(FOCUS_KEY) || 'null');
            if (raw && typeof raw === 'object') {
                return { endsAt: Number(raw.endsAt) || 0, minutes: Number(raw.minutes) || 25 };
            }
        } catch (error) { /* 忽略损坏数据 */ }
        return { endsAt: 0, minutes: 25 };
    }

    function saveFocus() {
        try { localStorage.setItem(FOCUS_KEY, JSON.stringify(focus)); } catch (error) { /* 忽略 */ }
    }

    function remaining() { return Math.max(0, focus.endsAt - Date.now()); }
    function active() { return focus.endsAt > 0; }

    function refreshUi() {
        if (!focusBox) return;
        if (!active()) { focusBox.hidden = true; return; }
        focusBox.hidden = false;
        var total = Math.ceil(remaining() / 1000);
        var minutes = Math.floor(total / 60);
        var seconds = total % 60;
        focusTime.textContent = (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
        if (focusLabel) focusLabel.textContent = '专注中';
        if (hud.classList.contains('is-open')) {
            var U = ui();
            if (U && U.syncRegion) U.syncRegion();
        }
    }

    function start(minutes) {
        minutes = minutes || 25;
        focus.endsAt = Date.now() + minutes * 60000;
        focus.minutes = minutes;
        saveFocus();
        refreshUi();
        var U = ui();
        U.bubble('好，专心' + minutes + '分钟，我陪着你。');
        U.toast('专注开始：' + minutes + ' 分钟');
        if (hud.classList.contains('is-open')) U.refresh();
    }

    function stop(silent) {
        var wasActive = active();
        focus.endsAt = 0;
        saveFocus();
        refreshUi();
        if (wasActive && !silent) ui().bubble('这次先休息一下，下次再一起加油。');
    }

    function complete() {
        var minutes = focus.minutes || 25;
        focus.endsAt = 0;
        saveFocus();
        var S = state();
        var U = ui();
        S.add({ exp: 12, affection: 2, energy: -6, mood: 4, stat: 'focus' }, 'focus-done');
        S.note('focus', '陪你完成了 ' + minutes + ' 分钟专注');
        U.remind('专注 ' + minutes + ' 分钟完成！休息一下吧。', { title: 'AnimePet · 专注完成' });
        U.animatePet('is-happy-hop');
        refreshUi();
        U.refresh();
    }

    function resetWaterTimer() {
        localStorage.setItem(WATER_KEY, String(Date.now()));
    }

    function tick() {
        var U = ui();
        var S = state();
        if (active() && remaining() <= 0) complete();
        else if (active()) refreshUi();

        var settings = S.get().settings;
        var now = Date.now();

        if (settings.water) {
            var last = Number(localStorage.getItem(WATER_KEY)) || 0;
            if (!last) localStorage.setItem(WATER_KEY, String(now));
            else if (now - last >= WATER_INTERVAL) {
                localStorage.setItem(WATER_KEY, String(now));
                U.remind(pick([
                    '该喝水啦，别只顾着敲代码。',
                    '起来活动一下，顺便喝口水吧。',
                    '眼睛也需要休息，看看远处～'
                ]), { title: 'AnimePet · 喝水提醒' });
            }
        }

        if (settings.hourly) {
            var hour = new Date().getHours();
            if (hour !== lastHour) {
                lastHour = hour;
                U.bubble((hour < 10 ? '0' : '') + hour + ':00 啦，整点报时。');
            }
        }

        if (hud.classList.contains('is-open') && U.updateGiftUi) U.updateGiftUi();
        S.tick();
    }

    window.setInterval(tick, 1000);

    var U = ui();
    if (U) {
        U.focus = { start: start, stop: stop, active: active, remaining: remaining };
        U.startFocus = start;
        U.stopFocus = stop;
        U.reminders = { tick: tick, refreshUi: refreshUi, resetWaterTimer: resetWaterTimer };
    }
    window.AnimePetReminders = {
        start: start, stop: stop, active: active, remaining: remaining,
        refreshUi: refreshUi, resetWaterTimer: resetWaterTimer, tick: tick
    };
})();
