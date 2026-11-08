/*
 * AnimePet v3 · 陪伴数值状态机（情感培养）
 * ---------------------------------------------------------------------------
 * 数值：hunger 饱食 / mood 心情 / energy 精力 / affection 亲密度（0-100）
 * 经验 exp 累积提升等级；亲密度分阶段（初见 → 心意相通）。
 *
 * v3 新增：
 *   - 心情状态机 moodInfo()：sweet / happy / calm / low / hungry / sleepy
 *   - 亲密度阶段 stageInfo() 与里程碑（20/40/60/80/100）
 *   - 礼物 addGift()（每个模型有偏好，20s 冷却）
 *   - 每日签到 checkDaily()（连续天数）
 *   - 回忆日记 journal[]（最近 40 条）
 *
 * 持久化双通道：
 *   1. localStorage  —— 立即、离线可用；
 *   2. POST /state   —— Rust 侧写入 ~/.local/share/animepet/state.json，
 *      清除浏览器数据后仍能恢复（启动时以 lastSeen 较新的一方为准）。
 *
 * 对外接口（window.AnimePetState）：
 *   get() / add(patch) / set(patch) / reset() / tick()
 *   levelInfo() / stageInfo() / moodInfo() / subscribe(fn) / save()
 *   setSetting(key, value) / addGift(name) / checkDaily() / note(type, text)
 *   gifts / favoriteGiftId()
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'animepet-companion-v3';
    var LEGACY_STORAGE_KEY = 'animepet-companion-v2';
    var MAX_OFFLINE_MS = 24 * 60 * 60 * 1000;
    var SAVE_DEBOUNCE_MS = 3000;
    var JOURNAL_LIMIT = 40;
    var GIFT_COOLDOWN_MS = 20 * 1000;

    var THRESHOLDS = [0, 24, 60, 110, 180, 270, 390, 540, 720, 950, 1230, 1560, 1950, 2400, 2950];
    var TITLES = ['初见', '点头之交', '熟悉的邻居', '会想念的人', '重要的朋友', '心灵伙伴', '不可替代', '命运同行'];

    var STAGES = [
        { min: 0, name: '初见', hint: '刚刚认识，还在观察你' },
        { min: 20, name: '熟悉', hint: '开始记住你的习惯' },
        { min: 40, name: '亲近', hint: '会主动凑过来' },
        { min: 60, name: '喜欢', hint: '看你的眼神变柔软了' },
        { min: 80, name: '依恋', hint: '不太想让你离开' },
        { min: 100, name: '心意相通', hint: '不用说也懂' }
    ];
    var MILESTONES = [20, 40, 60, 80, 100];

    var GIFTS = {
        sweet: { label: '甜点', emoji: '🍰' },
        tea: { label: '热茶', emoji: '🍵' },
        flower: { label: '花', emoji: '🌸' },
        book: { label: '书', emoji: '📖' }
    };
    // 每个模型的偏好礼物（模型 id 来自 message.js 的 live2dModels）
    var FAVORITES = {
        katoumegumi: 'tea',
        rem: 'sweet',
        megumin: 'book',
        darkness: 'flower',
        aqua: 'tea'
    };

    var DEFAULTS = {
        version: 3,
        lastTick: 0,
        lastSeen: 0,
        createdAt: 0,
        hunger: 76,
        mood: 84,
        energy: 88,
        affection: 12,
        exp: 0,
        stats: { pets: 0, feeds: 0, plays: 0, chats: 0, focus: 0, gifts: 0, checkins: 0 },
        settings: { water: true, hourly: false },
        streak: { days: 0, lastDay: '' },
        gifts: { lastAt: 0 },
        milestones: [],
        journal: []
    };

    var state = null;
    var listeners = [];
    var saveTimer = null;
    var lastLevel = 1;
    var tokenMeta = document.querySelector('meta[name="animepet-token"]');
    var authToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

    function authHeaders(extra) {
        var headers = extra || {};
        if (authToken && authToken !== '__ANIMEPET_TOKEN__') {
            headers['X-AnimePet-Token'] = authToken;
        }
        return headers;
    }

    window.AnimePetAuth = {
        token: authToken,
        headers: authHeaders,
        post: function (body) {
            return {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(body)
            };
        }
    };

    function clamp(value, min, max) {
        var number = Number(value);
        if (!isFinite(number)) number = min;
        return Math.min(max, Math.max(min, number));
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function dayKey(offsetDays) {
        var date = new Date(Date.now() + (offsetDays || 0) * 86400000);
        return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
    }

    function normalizeJournal(raw) {
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(function (entry) {
                return entry && typeof entry === 'object' && typeof entry.text === 'string';
            })
            .slice(0, JOURNAL_LIMIT)
            .map(function (entry) {
                return {
                    t: typeof entry.t === 'number' ? entry.t : Date.now(),
                    type: typeof entry.type === 'string' ? entry.type : 'note',
                    text: entry.text.slice(0, 120)
                };
            });
    }

    function normalize(raw) {
        var next = clone(DEFAULTS);
        if (raw && typeof raw === 'object') {
            ['hunger', 'mood', 'energy', 'affection', 'exp', 'lastTick', 'lastSeen', 'createdAt'].forEach(function (key) {
                if (typeof raw[key] === 'number' && isFinite(raw[key])) next[key] = raw[key];
            });
            if (raw.stats && typeof raw.stats === 'object') {
                Object.keys(next.stats).forEach(function (key) {
                    if (typeof raw.stats[key] === 'number' && isFinite(raw.stats[key])) next.stats[key] = raw.stats[key];
                });
            }
            if (raw.settings && typeof raw.settings === 'object') {
                Object.keys(next.settings).forEach(function (key) {
                    if (typeof raw.settings[key] === 'boolean') next.settings[key] = raw.settings[key];
                });
            }
            if (raw.streak && typeof raw.streak === 'object') {
                if (typeof raw.streak.days === 'number' && isFinite(raw.streak.days)) next.streak.days = Math.max(0, raw.streak.days);
                if (typeof raw.streak.lastDay === 'string') next.streak.lastDay = raw.streak.lastDay;
            }
            if (raw.gifts && typeof raw.gifts === 'object' && typeof raw.gifts.lastAt === 'number') {
                next.gifts.lastAt = Math.max(0, raw.gifts.lastAt);
            }
            if (Array.isArray(raw.milestones)) {
                next.milestones = raw.milestones.filter(function (value) {
                    return MILESTONES.indexOf(value) >= 0;
                });
            }
            next.journal = normalizeJournal(raw.journal);
        }
        next.version = 3;
        next.hunger = clamp(next.hunger, 0, 100);
        next.mood = clamp(next.mood, 0, 100);
        next.energy = clamp(next.energy, 0, 100);
        next.affection = clamp(next.affection, 0, 100);
        next.exp = Math.max(0, next.exp);
        var now = Date.now();
        if (!next.createdAt) next.createdAt = now;
        if (!next.lastTick) next.lastTick = now;
        if (!next.lastSeen) next.lastSeen = now;
        return next;
    }

    function readLocal() {
        try {
            var text = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
            if (!text) return null;
            return normalize(JSON.parse(text));
        } catch (error) {
            console.warn('[AnimePet] 本地陪伴状态读取失败:', error);
            return null;
        }
    }

    function levelFor(exp) {
        var level = 1;
        for (var i = 0; i < THRESHOLDS.length; i++) {
            if (exp >= THRESHOLDS[i]) level = i + 1;
        }
        return level;
    }

    function titleFor(level) {
        return TITLES[Math.min(TITLES.length - 1, Math.floor((level - 1) / 2))];
    }

    function levelInfo() {
        var level = levelFor(state.exp);
        var max = level >= THRESHOLDS.length;
        var base = THRESHOLDS[level - 1] || 0;
        var next = max ? state.exp : (THRESHOLDS[level] || (base + 400));
        return {
            level: level,
            title: titleFor(level),
            exp: state.exp,
            base: base,
            next: next,
            max: max,
            progress: max ? 1 : (next > base ? clamp((state.exp - base) / (next - base), 0, 1) : 1)
        };
    }

    function stageInfo() {
        var index = 0;
        for (var i = 0; i < STAGES.length; i++) {
            if (state.affection >= STAGES[i].min) index = i;
        }
        var current = STAGES[index];
        var next = STAGES[index + 1] || null;
        var span = next ? next.min - current.min : 1;
        return {
            index: index,
            name: current.name,
            hint: current.hint,
            min: current.min,
            next: next ? next.min : 100,
            max: !next,
            progress: next ? clamp((state.affection - current.min) / span, 0, 1) : 1
        };
    }

    function moodInfo() {
        var id = 'calm';
        var label = '平静';
        var emoji = '🌙';
        var hint = '安静地待在你旁边';
        if (state.energy < 25) {
            id = 'sleepy'; label = '困倦'; emoji = '😪'; hint = '眼皮有点沉…';
        } else if (state.hunger < 25) {
            id = 'hungry'; label = '饿了'; emoji = '🍰'; hint = '肚子在抗议了';
        } else if (state.mood < 35) {
            id = 'low'; label = '低落'; emoji = '🌧'; hint = '想被陪一会儿';
        } else if (state.affection >= 60 && state.mood >= 75) {
            id = 'sweet'; label = '心动'; emoji = '💗'; hint = '看到你就很开心';
        } else if (state.mood >= 70) {
            id = 'happy'; label = '开心'; emoji = '☀️'; hint = '今天状态不错';
        }
        return { id: id, label: label, emoji: emoji, hint: hint };
    }

    function decay(elapsedMs) {
        var hours = Math.min(Math.max(elapsedMs, 0), MAX_OFFLINE_MS) / 3600000;
        if (hours <= 0.001) return false;
        state.hunger = clamp(state.hunger - hours * 4, 0, 100);
        state.energy = clamp(state.energy - hours * 2.5, 0, 100);
        var target = (state.hunger + state.energy) / 2;
        var drift = (target - state.mood) * Math.min(1, hours * 0.5);
        state.mood = clamp(state.mood + drift - hours * 0.4, 0, 100);
        state.lastTick = Date.now();
        return true;
    }

    function note(type, text) {
        if (!text) return;
        state.journal.unshift({ t: Date.now(), type: type || 'note', text: String(text).slice(0, 120) });
        if (state.journal.length > JOURNAL_LIMIT) state.journal.length = JOURNAL_LIMIT;
        scheduleSave();
    }

    function checkMilestones() {
        var unlocked = [];
        MILESTONES.forEach(function (threshold) {
            if (state.affection >= threshold && state.milestones.indexOf(threshold) < 0) {
                state.milestones.push(threshold);
                unlocked.push(threshold);
                var stage = stageInfo();
                note('milestone', '亲密度达到 ' + threshold + ' · ' + stage.name);
            }
        });
        if (unlocked.length) {
            scheduleSave();
            unlocked.forEach(function (threshold) {
                try {
                    document.dispatchEvent(new CustomEvent('animepet:milestone', {
                        detail: { threshold: threshold, stage: stageInfo(), affection: state.affection }
                    }));
                } catch (error) {
                    /* 忽略 */
                }
            });
        }
        return unlocked;
    }

    function emit(reason) {
        var info = levelInfo();
        if (info.level > lastLevel) {
            lastLevel = info.level;
            note('level', '升到了 Lv.' + info.level + ' · ' + info.title);
            notify('levelup', info);
        }
        listeners.forEach(function (fn) {
            try {
                fn(state, reason || 'change');
            } catch (error) {
                console.error('[AnimePet] 陪伴状态监听器异常:', error);
            }
        });
    }

    function notify(type, detail) {
        try {
            document.dispatchEvent(new CustomEvent('animepet:state', {
                detail: { type: type, state: clone(state), level: detail || levelInfo() }
            }));
        } catch (error) {
            /* 老 WebKit 缺 CustomEvent 构造器时忽略 */
        }
    }

    function saveLocal() {
        state.lastSeen = Date.now();
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            console.warn('[AnimePet] 本地陪伴状态写入失败:', error);
        }
    }

    function pushRemote() {
        try {
            fetch('/state', window.AnimePetAuth.post(state)).catch(function () { /* 离线时忽略 */ });
        } catch (error) {
            /* fetch 不可用时忽略 */
        }
    }

    function scheduleSave() {
        saveLocal();
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(function () {
            saveTimer = null;
            pushRemote();
        }, SAVE_DEBOUNCE_MS);
    }

    function save() {
        if (saveTimer) {
            window.clearTimeout(saveTimer);
            saveTimer = null;
        }
        saveLocal();
        pushRemote();
    }

    var api = {
        gifts: GIFTS,
        get: function () {
            return state;
        },
        snapshot: function () {
            return clone(state);
        },
        subscribe: function (fn) {
            if (typeof fn === 'function') listeners.push(fn);
            return function () {
                var index = listeners.indexOf(fn);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
        levelInfo: levelInfo,
        stageInfo: stageInfo,
        moodInfo: moodInfo,
        favoriteGiftId: function () {
            var model = window.getAnimePetModel ? window.getAnimePetModel() : null;
            var id = model ? model.id : 'katoumegumi';
            return FAVORITES[id] || FAVORITES.katoumegumi;
        },
        daysTogether: function () {
            return Math.max(1, Math.floor((Date.now() - state.createdAt) / 86400000) + 1);
        },
        note: function (type, text) {
            note(type, text);
            emit('note');
        },
        add: function (patch, reason) {
            patch = patch || {};
            var touched = false;
            ['hunger', 'mood', 'energy', 'affection'].forEach(function (key) {
                if (typeof patch[key] === 'number') {
                    state[key] = clamp(state[key] + patch[key], 0, 100);
                    touched = true;
                }
            });
            if (typeof patch.exp === 'number') {
                state.exp = Math.max(0, state.exp + patch.exp);
                touched = true;
            }
            if (patch.stat && Object.prototype.hasOwnProperty.call(state.stats, patch.stat)) {
                state.stats[patch.stat] += 1;
                touched = true;
            }
            if (touched) {
                scheduleSave();
                checkMilestones();
                emit(reason || 'add');
            }
            return levelInfo();
        },
        set: function (patch, reason) {
            patch = patch || {};
            if (typeof patch.hunger === 'number') state.hunger = clamp(patch.hunger, 0, 100);
            if (typeof patch.mood === 'number') state.mood = clamp(patch.mood, 0, 100);
            if (typeof patch.energy === 'number') state.energy = clamp(patch.energy, 0, 100);
            if (typeof patch.affection === 'number') state.affection = clamp(patch.affection, 0, 100);
            scheduleSave();
            checkMilestones();
            emit(reason || 'set');
        },
        setSetting: function (key, value) {
            if (Object.prototype.hasOwnProperty.call(state.settings, key)) {
                state.settings[key] = !!value;
                scheduleSave();
                emit('settings');
                return true;
            }
            return false;
        },
        /** 送礼物：偏好 +8 亲密/经验，普通 +3/+4；20 秒冷却 */
        addGift: function (name) {
            var meta = GIFTS[name];
            if (!meta) return { ok: false, reason: 'unknown' };
            var now = Date.now();
            var remaining = GIFT_COOLDOWN_MS - (now - state.gifts.lastAt);
            if (remaining > 0) {
                return { ok: false, reason: 'cooldown', remaining: remaining };
            }
            var favorite = api.favoriteGiftId() === name;
            state.gifts.lastAt = now;
            state.stats.gifts += 1;
            state.affection = clamp(state.affection + (favorite ? 8 : 3), 0, 100);
            state.exp += favorite ? 8 : 4;
            state.mood = clamp(state.mood + (favorite ? 8 : 4), 0, 100);
            note('gift', (favorite ? '最喜欢' : '收到') + '的' + meta.label);
            scheduleSave();
            checkMilestones();
            emit('gift');
            return { ok: true, favorite: favorite, label: meta.label, emoji: meta.emoji };
        },
        /** 每日签到：同一天幂等；返回 {days} 或 null */
        checkDaily: function () {
            var today = dayKey(0);
            if (state.streak.lastDay === today) return null;
            var yesterday = dayKey(-1);
            state.streak.days = state.streak.lastDay === yesterday ? state.streak.days + 1 : 1;
            state.streak.lastDay = today;
            state.stats.checkins += 1;
            state.affection = clamp(state.affection + 2, 0, 100);
            state.exp += 5;
            note('daily', '连续陪伴第 ' + state.streak.days + ' 天');
            scheduleSave();
            checkMilestones();
            emit('daily');
            return { days: state.streak.days };
        },
        reset: function () {
            state = normalize(DEFAULTS);
            state.createdAt = Date.now();
            lastLevel = levelInfo().level;
            save();
            emit('reset');
        },
        tick: function () {
            if (Date.now() - state.lastTick < 60000) return state;
            var changed = decay(Date.now() - state.lastTick);
            if (changed) {
                scheduleSave();
                emit('tick');
            }
            return state;
        },
        save: save
    };

    // ---- 初始化 ----
    var stored = readLocal();
    var hadLocalState = !!stored;
    state = stored || normalize(DEFAULTS);
    lastLevel = levelInfo().level;
    if (decay(Date.now() - state.lastTick)) saveLocal();

    try {
        fetch('/state', { cache: 'no-store' })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (remote) {
                var hasRemoteState = remote && typeof remote === 'object' && Object.keys(remote).length > 0;
                var remoteIsNewer = hasRemoteState
                    && (!hadLocalState || (Number(remote.lastSeen) || 0) > state.lastSeen);
                if (remoteIsNewer) {
                    var merged = normalize(remote);
                    state = merged;
                    decay(Date.now() - state.lastTick);
                    lastLevel = levelInfo().level;
                    emit('restore');
                }
                save();
            })
            .catch(function () { /* 离线时保留本地状态 */ });
    } catch (error) {
        /* fetch 不可用时保留本地状态 */
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') save();
    });
    window.addEventListener('beforeunload', save);

    window.AnimePetState = api;
})();
