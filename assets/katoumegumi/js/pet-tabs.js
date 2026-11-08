/*
 * AnimePet · 陪伴中心 Tab（Telegram 风格滑动指示器）
 */
(function () {
    'use strict';

    var tabsBar = document.getElementById('hud-tabs');
    var buttons = tabsBar ? Array.prototype.slice.call(tabsBar.querySelectorAll('.tab-btn')) : [];
    var pages = {
        status: document.getElementById('page-status'),
        interact: document.getElementById('page-interact'),
        memory: document.getElementById('page-memory')
    };
    var activeIndex = 0;

    function ui() { return window.AnimePetUI; }

    function select(name, animate) {
        var index = -1;
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].dataset.tab === name) index = i;
        }
        var page = pages[name];
        if (index < 0 || !page) return;
        if (index === activeIndex && page.classList.contains('is-active')) return;
        var direction = index > activeIndex ? 1 : -1;
        activeIndex = index;
        tabsBar.style.setProperty('--tab-index', String(index));

        var indicator = tabsBar.querySelector('.tab-indicator');
        if (indicator && animate) {
            indicator.classList.add('is-moving');
            window.clearTimeout(indicator._moveTimer);
            indicator._moveTimer = window.setTimeout(function () {
                indicator.classList.remove('is-moving');
            }, 380);
        }

        buttons.forEach(function (button) {
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

        Object.keys(pages).forEach(function (key) {
            var target = pages[key];
            var on = key === name;
            if (on) {
                target.hidden = false;
                target.style.setProperty('--page-shift', (direction > 0 ? 18 : -18) + 'px');
                target.classList.remove('is-active');
                void target.offsetWidth;
                target.classList.add('is-active');
            } else {
                target.classList.remove('is-active');
                target.hidden = true;
            }
        });
        var U = ui();
        if (U && U.syncRegion) U.syncRegion();
    }

    buttons.forEach(function (button) {
        button.addEventListener('click', function () { select(button.dataset.tab, true); });
    });
    if (tabsBar) {
        tabsBar.addEventListener('keydown', function (event) {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
            var current = buttons.indexOf(document.activeElement);
            if (current < 0) current = activeIndex;
            var next = current;
            if (event.key === 'ArrowLeft') next = (current + buttons.length - 1) % buttons.length;
            else if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
            else if (event.key === 'Home') next = 0;
            else next = buttons.length - 1;
            event.preventDefault();
            buttons[next].focus();
            select(buttons[next].dataset.tab, true);
        });
    }

    window.AnimePetTabs = { select: select };
    var U = ui();
    if (U) U.selectTab = select;
    select('status', false);
})();
