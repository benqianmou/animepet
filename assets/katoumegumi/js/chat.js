/*
 * AnimePet v2 · 聊天面板
 * ---------------------------------------------------------------------------
 * 从 index.html 内联脚本抽出，保留原有流式对话 / TTS / STT 行为，并接入：
 *   - AnimePetUI 浮层计数（输入热区与键盘模式由 Rust 侧统一处理）
 *   - 陪伴数值（每次成功对话 +1 exp）
 *   - 语音播报桥 window.animePetSpeak，供陪伴面板的提醒复用
 */
(function () {
    'use strict';

    var ICONS = {
        volumeOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.6L13 19V5L7.6 9.5H4z"/><path d="M16.4 8.8a4.6 4.6 0 0 1 0 6.4"/><path d="M18.9 6.2a8.2 8.2 0 0 1 0 11.6"/></svg>',
        volumeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.6L13 19V5L7.6 9.5H4z"/><path d="M16.6 9.4l4.2 5.2M20.8 9.4l-4.2 5.2"/></svg>',
        mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/></svg>',
        stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7.5" y="7.5" width="9" height="9" rx="2" fill="currentColor" stroke="none"/></svg>'
    };

    var panel = document.getElementById('chat-panel');
    var close = document.getElementById('chat-close');
    var form = document.getElementById('chat-form');
    var input = document.getElementById('chat-input');
    var log = document.getElementById('chat-log');
    var recordButton = document.getElementById('chat-record');
    var voiceModeButton = document.getElementById('chat-voice-mode');
    var mute = document.getElementById('chat-mute');
    var modelSwitch = document.getElementById('chat-model');
    var characterName = document.getElementById('chat-character-name');
    var avatarText = document.getElementById('chat-avatar-text');
    var announcer = document.getElementById('chat-announcer');
    var voiceStatus = document.querySelector('.chat-name small');

    var audio = null;
    var speechRequest = null;
    var speechSequence = 0;
    var audioContext = null;
    var lipSyncFrame = null;
    var muted = localStorage.getItem('animepet-muted') === '1';
    var chatBusy = false;
    var recorder = null;
    var recordStream = null;
    var recordChunks = [];
    var voiceMode = localStorage.getItem('animepet-voice-mode') === '1';

    function animeUi() {
        return window.AnimePetUI || null;
    }

    function authHeaders(extra) {
        var headers = extra || {};
        var auth = window.AnimePetAuth;
        if (auth && auth.headers) {
            var token = auth.headers();
            Object.keys(token).forEach(function (key) {
                headers[key] = token[key];
            });
        }
        return headers;
    }

    // ------------------------------------------------------------ 浮层与定位

    function positionPanel() {
        if (!panel.classList.contains('is-open')) return;
        var module = animeUi();
        if (module && module.placeNear) {
            // 与陪伴面板共用同一套「模型旁边 + 边界回收」逻辑
            module.placeNear(panel, 12);
            if (module.syncRegion) {
                module.syncRegion();
                window.setTimeout(module.syncRegion, 240);
            }
        }
    }

    function openPanel() {
        var module = animeUi();
        if (module) module.enter('chat');
        // 聊天与陪伴面板互斥，避免两个浮层叠在同一个位置
        if (module && module.isHudOpen && module.isHudOpen()) module.closeHud();
        panel.classList.add('is-open');
        positionPanel();
        window.setTimeout(function () {
            input.focus();
        }, 50);
    }

    function closePanel() {
        panel.classList.remove('is-open');
        var module = animeUi();
        if (module) module.leave('chat');
    }

    window.openChatPanel = openPanel;
    window.closeChatPanel = closePanel;
    window.updateChatPanel = positionPanel;
    window.addEventListener('resize', positionPanel);

    // ------------------------------------------------------------ 状态提示

    function setVoiceStatus(text, actionable) {
        voiceStatus.textContent = text;
        voiceStatus.classList.toggle('is-action', !!actionable);
        window.clearTimeout(setVoiceStatus.timer);
        if (text !== '在这里陪着你' && !actionable) {
            setVoiceStatus.timer = window.setTimeout(function () {
                setVoiceStatus('在这里陪着你');
            }, 4500);
        }
    }

    function updateVoiceModeButton() {
        voiceModeButton.classList.toggle('is-active', voiceMode);
        voiceModeButton.setAttribute('aria-pressed', voiceMode ? 'true' : 'false');
        voiceModeButton.dataset.tip = voiceMode ? '关闭语音对话' : '语音对话';
    }

    updateVoiceModeButton();
    voiceModeButton.addEventListener('click', function () {
        voiceMode = !voiceMode;
        localStorage.setItem('animepet-voice-mode', voiceMode ? '1' : '0');
        updateVoiceModeButton();
        setVoiceStatus(voiceMode ? '语音对话模式已开启' : '语音对话模式已关闭');
    });

    function announce(text) {
        if (!announcer || !text) return;
        announcer.textContent = '';
        window.setTimeout(function () {
            announcer.textContent = text;
        }, 30);
    }

    function addLine(role, text) {
        var node = document.createElement('div');
        node.className = 'chat-line ' + role;
        node.textContent = text;
        log.appendChild(node);
        log.scrollTop = log.scrollHeight;
        return node;
    }

    function updateMuteButton() {
        mute.classList.toggle('is-muted', muted);
        mute.innerHTML = muted ? ICONS.volumeOff : ICONS.volumeOn;
        mute.setAttribute('aria-label', muted ? '取消静音' : '静音');
        mute.dataset.tip = muted ? '取消静音' : '静音';
        if (audio) audio.muted = muted;
    }

    // ------------------------------------------------------------ 语音播放

    function stopSpeech() {
        speechSequence++;
        if (speechRequest) {
            speechRequest.abort();
            speechRequest = null;
        }
        if (audio) {
            var oldSrc = audio.src;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            if (oldSrc) URL.revokeObjectURL(oldSrc);
            audio = null;
        }
        if (lipSyncFrame) {
            cancelAnimationFrame(lipSyncFrame);
            lipSyncFrame = null;
        }
        if (window.setLive2dLipSyncValue) window.setLive2dLipSyncValue(0);
        setVoiceStatus('在这里陪着你');
        document.getElementById('live_talk').value = '0';
    }

    window.stopAnimePetSpeech = stopSpeech;

    function primeAudio() {
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!audioContext) audioContext = new AudioContext();
        if (audioContext.state === 'suspended') audioContext.resume();
    }

    function connectLipSync(media) {
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        primeAudio();
        var source = audioContext.createMediaElementSource(media);
        var analyser = audioContext.createAnalyser();
        var samples = new Uint8Array(analyser.fftSize = 256);
        analyser.smoothingTimeConstant = 0.68;
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        function updateMouth() {
            analyser.getByteTimeDomainData(samples);
            var energy = 0;
            for (var i = 0; i < samples.length; i++) {
                var normalized = (samples[i] - 128) / 128;
                energy += normalized * normalized;
            }
            var rms = Math.sqrt(energy / samples.length);
            if (window.setLive2dLipSyncValue) {
                window.setLive2dLipSyncValue(muted ? 0 : Math.min(1, rms * 5.5));
            }
            lipSyncFrame = requestAnimationFrame(updateMouth);
        }
        updateMouth();
    }

    async function playAudio() {
        if (!audio || muted) return;
        try {
            primeAudio();
            await audio.play();
        } catch (error) {
            setVoiceStatus('点这里播放语音', true);
        }
    }

    async function speak(text) {
        if (muted) {
            setVoiceStatus('已静音');
            return;
        }
        if (!text) return;
        stopSpeech();
        var sequence = ++speechSequence;
        speechRequest = new AbortController();
        setVoiceStatus('正在合成语音...');
        try {
            var response = await fetch('/tts', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ text: text }),
                signal: speechRequest.signal
            });
            if (!response.ok) throw new Error(await response.text());
            var voiceType = response.headers.get('X-AnimePet-TTS');
            var blob = await response.blob();
            if (sequence !== speechSequence || muted) return;
            var currentAudio = new Audio(URL.createObjectURL(blob));
            audio = currentAudio;
            currentAudio.muted = muted;
            currentAudio.preload = 'auto';
            connectLipSync(currentAudio);
            currentAudio.addEventListener('play', function () {
                document.getElementById('live_talk').value = '1';
                setVoiceStatus(voiceType === 'fallback' ? '正在说话（系统语音）' : '正在说话');
            });
            currentAudio.addEventListener('ended', function () {
                URL.revokeObjectURL(currentAudio.src);
                if (audio === currentAudio) {
                    if (lipSyncFrame) {
                        cancelAnimationFrame(lipSyncFrame);
                        lipSyncFrame = null;
                    }
                    if (window.setLive2dLipSyncValue) window.setLive2dLipSyncValue(0);
                    document.getElementById('live_talk').value = '0';
                    setVoiceStatus('在这里陪着你');
                    audio = null;
                }
            });
            currentAudio.addEventListener('error', function () {
                if (currentAudio.src) URL.revokeObjectURL(currentAudio.src);
                if (audio === currentAudio) {
                    document.getElementById('live_talk').value = '0';
                    audio = null;
                    setVoiceStatus('语音播放失败');
                }
            });
            await playAudio();
        } catch (error) {
            if (error.name !== 'AbortError') setVoiceStatus('语音未播放：' + error.message);
        } finally {
            if (sequence === speechSequence) speechRequest = null;
        }
    }

    window.animePetSpeak = speak;

    voiceStatus.addEventListener('click', function () {
        if (voiceStatus.classList.contains('is-action')) playAudio();
    });

    mute.addEventListener('click', function () {
        muted = !muted;
        localStorage.setItem('animepet-muted', muted ? '1' : '0');
        if (muted) stopSpeech();
        updateMuteButton();
    });

    updateMuteButton();

    // ------------------------------------------------------------ 模型

    function updateModelUi(model) {
        if (!model) return;
        characterName.textContent = model.name;
        if (avatarText) avatarText.textContent = (model.name || 'A').charAt(0);
        modelSwitch.disabled = !!model.loading;
        var label = '切换模型（当前：' + model.name + '）';
        modelSwitch.setAttribute('aria-label', label);
        modelSwitch.dataset.tip = '切换模型';
        setVoiceStatus(model.loading ? '正在切换模型...' : '在这里陪着你');
    }

    document.addEventListener('animepet:modelchange', function (event) {
        updateModelUi(event.detail);
    });
    modelSwitch.addEventListener('click', function () {
        if (window.cycleAnimePetModel) window.cycleAnimePetModel();
    });
    if (window.getAnimePetModel) updateModelUi(window.getAnimePetModel());

    // ------------------------------------------------------------ 输入与录音

    close.addEventListener('click', closePanel);

    input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            form.requestSubmit();
        }
    });

    input.addEventListener('input', function () {
        input.style.height = '38px';
        input.style.height = Math.min(input.scrollHeight, 88) + 'px';
    });

    function setRecordingUi(recording) {
        recordButton.classList.toggle('is-recording', recording);
        recordButton.innerHTML = recording ? ICONS.stop : ICONS.mic;
        recordButton.setAttribute('aria-label', recording ? '停止录音' : '语音输入');
        recordButton.dataset.tip = recording ? '停止录音' : '语音输入';
        if (recording) setVoiceStatus('正在录音，再点一次结束');
    }

    setRecordingUi(false);

    function recordingMimeType() {
        var options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
        for (var i = 0; i < options.length; i++) {
            if (!window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(options[i])) {
                return options[i];
            }
        }
        return '';
    }

    async function transcribeRecording(blob, mime) {
        setVoiceStatus('正在识别语音...');
        try {
            var response = await fetch('/stt', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': mime || 'audio/webm' }),
                body: blob
            });
            var payload = await response.text();
            if (!response.ok) throw new Error(payload || ('HTTP ' + response.status));
            var result = JSON.parse(payload);
            var text = (result.text || '').trim();
            if (!text) throw new Error('没有识别出文字');
            input.value = input.value.trim() ? input.value.trim() + ' ' + text : text;
            input.dispatchEvent(new Event('input'));
            input.focus();
            if (voiceMode) {
                setVoiceStatus('正在发送语音内容...');
                form.requestSubmit();
            } else {
                setVoiceStatus('语音已填入输入框');
            }
        } catch (error) {
            setVoiceStatus('语音识别失败：' + error.message);
        }
    }

    function stopRecording() {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    }

    recordButton.addEventListener('click', async function () {
        if (recorder && recorder.state === 'recording') {
            stopRecording();
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
            setVoiceStatus('当前环境不支持录音');
            return;
        }
        try {
            recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            var mime = recordingMimeType();
            recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
            recordChunks = [];
            recorder.addEventListener('dataavailable', function (event) {
                if (event.data && event.data.size) recordChunks.push(event.data);
            });
            recorder.addEventListener('stop', function () {
                var actualMime = recorder.mimeType || mime || 'audio/webm';
                var blob = new Blob(recordChunks, { type: actualMime });
                if (recordStream) recordStream.getTracks().forEach(function (track) { track.stop(); });
                recordStream = null;
                recorder = null;
                setRecordingUi(false);
                if (blob.size) transcribeRecording(blob, actualMime);
            }, { once: true });
            recorder.start();
            setRecordingUi(true);
        } catch (error) {
            if (recordStream) recordStream.getTracks().forEach(function (track) { track.stop(); });
            recordStream = null;
            recorder = null;
            setVoiceStatus('无法访问麦克风：' + error.message);
        }
    });

    // ------------------------------------------------------------ 发送与流式回复

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        var text = input.value.trim();
        if (!text || chatBusy) return;
        stopRecording();
        chatBusy = true;
        document.getElementById('chat-send').disabled = true;
        primeAudio();
        stopSpeech();
        input.value = '';
        input.style.height = '38px';
        addLine('user', text);
        var reply = addLine('assistant', '思考中...');
        reply.classList.add('is-pending');
        // 流式增量不适合 live region：每帧都会重播整段内容，改为结束后统一播报。
        log.setAttribute('aria-live', 'off');
        try {
            var selectedModel = window.getAnimePetModel ? window.getAnimePetModel().id : 'katoumegumi';
            var response = await fetch('/chat', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ message: text, model: selectedModel })
            });
            if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
            reply.textContent = '';
            reply.classList.remove('is-pending');
            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var pending = '';
            while (true) {
                var part = await reader.read();
                if (part.done) break;
                pending += decoder.decode(part.value, { stream: true });
                var chunks = pending.split('\n');
                pending = chunks.pop();
                chunks.forEach(function (line) {
                    if (!line) return;
                    try {
                        var data = JSON.parse(line);
                        if (data.type === 'delta') {
                            reply.textContent += data.text;
                            log.scrollTop = log.scrollHeight;
                        } else if (data.type === 'done' && data.text) {
                            reply.textContent = data.text;
                            log.scrollTop = log.scrollHeight;
                            if (window.AnimePetState) {
                                window.AnimePetState.add({ exp: 1, affection: 0.3, stat: 'chats' }, 'chat');
                            }
                            announce(data.text);
                            speak(data.text);
                        } else if (data.type === 'error') {
                            reply.textContent = '出错了：' + data.text;
                            reply.classList.remove('is-pending');
                            announce('出错了：' + data.text);
                        }
                    } catch (error) {
                        /* 单行解析失败不影响后续流 */
                    }
                });
            }
        } catch (error) {
            reply.classList.remove('is-pending');
            reply.textContent = '连接失败：' + error.message;
            announce('连接失败：' + error.message);
        } finally {
            chatBusy = false;
            document.getElementById('chat-send').disabled = false;
            log.setAttribute('aria-live', 'polite');
        }
    });
})();
