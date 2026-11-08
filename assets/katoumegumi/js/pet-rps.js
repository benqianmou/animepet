/*
 * AnimePet · 猜拳小游戏
 * 依赖 window.AnimePetUI / window.AnimePetState；由 pet-ui.js 之后加载。
 */
(function () {
    'use strict';

    var rps = document.getElementById('pet-rps');
    var HANDS = {
        rock: { emoji: '✊', label: '石头' },
        scissors: { emoji: '✌️', label: '剪刀' },
        paper: { emoji: '🖐', label: '布' }
    };
    var RPS_BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
    var busy = false;
    var returnFocus = null;

    function ui() { return window.AnimePetUI; }
    function state() { return window.AnimePetState; }

    function setDisabled(disabled) {
        Array.prototype.forEach.call(rps.querySelectorAll('.rps-choice'), function (button) {
            button.disabled = disabled;
        });
    }

    function open() {
        var U = ui();
        returnFocus = document.activeElement;
        U.enter('rps');
        rps.classList.add('is-open');
        U.closeMenu();
        document.getElementById('rps-you').textContent = '❔';
        document.getElementById('rps-pet').textContent = '❔';
        document.getElementById('rps-result').textContent = '出什么？赢了我会有奖励哦。';
        setDisabled(false);
        busy = false;
        U.syncRegion();
        window.setTimeout(U.syncRegion, 240);
        var first = rps.querySelector('.rps-choice');
        if (first) first.focus();
    }

    function close() {
        var U = ui();
        rps.classList.remove('is-open');
        U.leave('rps');
        if (returnFocus && typeof returnFocus.focus === 'function') {
            returnFocus.focus();
            returnFocus = null;
        }
    }

    function play(playerHand) {
        if (busy) return;
        busy = true;
        setDisabled(true);
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
            var S = state();
            var U = ui();
            var outcome;
            if (playerHand === petHand) outcome = 'draw';
            else if (RPS_BEATS[playerHand] === petHand) outcome = 'win';
            else outcome = 'lose';
            if (outcome === 'win') {
                youEl.classList.add('is-win');
                resultEl.textContent = '你赢了！好感 +2，经验 +6';
                S.add({ exp: 6, affection: 2, mood: 4, stat: 'plays' }, 'rps-win');
                U.bubble('唔…这局算你厉害。');
            } else if (outcome === 'draw') {
                resultEl.textContent = '平局，再来一局？经验 +2';
                S.add({ exp: 2, mood: 1, stat: 'plays' }, 'rps-draw');
            } else {
                youEl.classList.add('is-lose');
                resultEl.textContent = '我赢了～不过陪你玩很开心，心情 +2';
                S.add({ mood: 2, exp: 1, stat: 'plays' }, 'rps-lose');
            }
            U.refresh();
            busy = false;
            setDisabled(false);
        }, 520);
    }

    Array.prototype.forEach.call(rps.querySelectorAll('.rps-choice'), function (button) {
        button.addEventListener('click', function () { play(button.dataset.hand); });
    });
    document.getElementById('rps-close').addEventListener('click', close);
    rps.addEventListener('pointerdown', function (event) {
        if (event.target === rps) close();
    });
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

    window.AnimePetRps = { open: open, close: close };
})();
