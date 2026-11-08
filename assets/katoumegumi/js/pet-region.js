/*
 * AnimePet · 浮层与输入热区
 * ---------------------------------------------------------------------------
 * 与 Rust 的 document.title 协议：
 *   chat_open / overlay_open / modal_open / chat_close:left,bottom / region:x,y,w,h;...
 * 浮层用 id 集合登记；聊天优先键盘焦点，猜拳是整屏模态。
 */
(function () {
    'use strict';

    var pet = document.getElementById('landlord');
    var hud = document.getElementById('pet-hud');
    var menu = document.getElementById('pet-menu');
    var overlays = {};
    var regionTimer = null;
    var regionPaused = false;

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
        syncRegion();
    }


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


    function syncRegion() {
        if (regionPaused || regionTimer) return;
        regionTimer = window.setTimeout(function () {
            regionTimer = null;
            pushInputRegion();
        }, 0);
    }

    window.AnimePetOverlay = {
        enter: function (id) {
            overlays[id] = true;
            syncOverlayTitle();
        },
        leave: function (id) {
            delete overlays[id];
            syncOverlayTitle();
        },
        hasOverlay: function () {
            return Object.keys(overlays).length > 0;
        },
        pauseRegion: function (paused) {
            regionPaused = !!paused;
            if (!regionPaused) window.AnimePetOverlay.syncRegion();
        },
        syncRegion: syncRegion,
        placeNear: placeNear
    };
})();
