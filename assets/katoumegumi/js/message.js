// 静态资源根目录（与 index.html 同源）。原先由 index.html 的内联脚本注入。
var message_Path = './';

var userAgent = window.navigator.userAgent.toLowerCase();
console.log(userAgent);
var norunAI = [ "android", "iphone", "ipod", "ipad", "windows phone", "mqqbrowser" ,"msie","trident/7.0"];
var norunFlag = false;


for(var i=0;i<norunAI.length;i++){
	if(userAgent.indexOf(norunAI[i]) > -1){
		norunFlag = true;
		break;
	}
}

if(!window.WebGLRenderingContext){
	norunFlag = true;
}

if(!norunFlag){
	function bootHint(text, isError) {
		var node = document.getElementById('boot-hint');
		if (!node) return;
		node.textContent = text || '';
		node.classList.toggle('is-error', !!isError);
		node.classList.remove('is-hidden');
	}

	function hideBootHint() {
		var node = document.getElementById('boot-hint');
		if (node) node.classList.add('is-hidden');
	}

	function showMessage(text){
		if(Array.isArray(text)) text = text[Math.floor(Math.random() * text.length)];
		$('.message').stop(true, true);
		$('.message').html(text);
		$('.message').fadeTo(200, 1);
	}
	function hideMessage(timeout){
		if (timeout === null) timeout = 5000;
		$('.message').delay(timeout).fadeTo(200, 0);
	}
	window.animePetShowMessage = showMessage;

	// v2：改为纯本地问候。v1 的 hitokoto 轮询离线时会每 15 秒弹一次网络错误。
	function localGreeting(){
		var now = (new Date()).getHours();
		if (now > 23 || now <= 5) return '你是夜猫子呀？这么晚还不睡，明天起得来吗。';
		if (now > 5 && now <= 7) return '早上好，一日之计在于晨。';
		if (now > 7 && now <= 11) return '上午好，工作顺利嘛？别久坐哦。';
		if (now > 11 && now <= 14) return '中午了，该去吃午饭啦。';
		if (now > 14 && now <= 17) return '午后容易犯困，起来走走。';
		if (now > 17 && now <= 19) return '傍晚了，今天过得怎么样？';
		if (now > 19 && now <= 21) return '晚上好，辛苦了。';
		return '已经这么晚了，早点休息吧。';
	}
	window.animePetGreeting = localGreeting;
	window.setTimeout(function(){
		if (!live2dModelReady) return;
		showMessage(localGreeting());
	}, 2800);

	// 模型清单的单一来源是 assets/models.json；这里只保留首模型作为加载失败兜底。
	var live2dModels = [
		{
			id: 'katoumegumi',
			name: '加藤惠',
			model: 'model/katou_01/katou_01.model.json',
			texture: 'model/katou_01/moc/katou.2048/texture_00.png'
		}
	];

	var live2dModelsLoaded = fetch(message_Path + 'models.json')
		.then(function (response) { return response.ok ? response.json() : null; })
		.then(function (data) {
			if (data && Array.isArray(data.models) && data.models.length) {
				live2dModels = data.models;
			}
		})
		.catch(function (error) {
			console.warn('[AnimePet] models.json 加载失败，使用内置兜底模型:', error);
		});
	var live2dModelStorageKey = 'animepet-model';
	var activeLive2dModel = live2dModels[0];
	var live2dModelReady = false;

	function findLive2dModel(id) {
		for (var i = 0; i < live2dModels.length; i++) {
			if (live2dModels[i].id === id) return live2dModels[i];
		}
		return live2dModels[0];
	}

	function notifyLive2dModel(loading) {
		document.dispatchEvent(new CustomEvent('animepet:modelchange', {
			detail: {
				id: activeLive2dModel.id,
				name: activeLive2dModel.name,
				loading: loading
			}
		}));
	}

	function replaceLive2dModel(model, initialLoad) {
		if (model.format === 'cubism3') {
			// Cubism3 模型走 PIXI + Cubism Core 渲染管线（js/cubism3.js）。
			// 内部会停掉旧版 SDK2 的渲染循环并隐藏旧画布。
			return window.AnimePetCubism3.load(model, message_Path);
		}
		if (initialLoad) {
			loadlive2d('live2d', message_Path + model.model);
			return;
		}

		// loadlive2d also installs input listeners. Suppress that setup when reusing
		// the existing canvas so repeated model changes do not duplicate handlers.
		var windowAddEventListener = window.addEventListener;
		var documentAddEventListener = document.addEventListener;
		try {
			window.addEventListener = function() {};
			document.addEventListener = function() {};
			loadlive2d('live2d', message_Path + model.model);
		} finally {
			window.addEventListener = windowAddEventListener;
			document.addEventListener = documentAddEventListener;
		}
	}

	function activateLive2dModel(model, initialLoad) {
		// Cubism3 模型会永久停掉旧版 SDK2 渲染循环（该循环没有恢复接口），
		// 因此从 Cubism3 切回旧版模型时整页重载，靠 localStorage 恢复选择。
		if (!initialLoad && activeLive2dModel.format === 'cubism3' && model.format !== 'cubism3') {
			localStorage.setItem(live2dModelStorageKey, model.id);
			window.location.reload();
			return;
		}
		activeLive2dModel = model;
		live2dModelReady = false;
		localStorage.setItem(live2dModelStorageKey, model.id);
		if (window.stopAnimePetSpeech) window.stopAnimePetSpeech();
		if (window.setLive2dLipSyncValue) window.setLive2dLipSyncValue(0);
		$('#live_talk').val('0');
		notifyLive2dModel(true);

		var texture = new Image();
		texture.onload = function() {
			var result = replaceLive2dModel(model, initialLoad);
			var settled = false;
			function markModelReady() {
				if (settled) return;
				settled = true;
				// 等一帧让首次绘制完成，再隐藏启动提示并上报 model_ready
				window.requestAnimationFrame(function() {
					window.setTimeout(function() {
						$('#landlord').fadeIn(200);
						live2dModelReady = true;
						notifyLive2dModel(false);
						hideBootHint();
						document.title = 'model_ready';
						if (!initialLoad) showMessage('已切换到' + model.name);
					}, 260);
				});
			}
			if (result && typeof result.then === 'function') {
				// Cubism3：必须等模型资源真正加载完，不能只等贴图 onload
				result.then(markModelReady).catch(function() {
					settled = true;
					bootHint(model.name + ' 模型加载失败', true);
					showMessage(model.name + '模型资源加载失败');
				});
			} else {
				// SDK2：loadlive2d 同步创建画布，给一帧绘制时间
				markModelReady();
			}
			// 兜底：8 秒仍未 ready 就明确提示，而不是无声空白
			window.setTimeout(function() {
				if (!live2dModelReady) bootHint(model.name + ' 模型加载超时', true);
			}, 8000);
			texture = null;
		};
		texture.onerror = function() {
			live2dModelReady = true;
			notifyLive2dModel(false);
			bootHint(model.name + ' 模型资源加载失败', true);
			showMessage(model.name + '模型资源加载失败');
		};
		texture.src = message_Path + model.texture;
	}

	activeLive2dModel = findLive2dModel(localStorage.getItem(live2dModelStorageKey));
	window.getAnimePetModel = function() {
		return {
			id: activeLive2dModel.id,
			name: activeLive2dModel.name,
			loading: !live2dModelReady
		};
	};
	window.cycleAnimePetModel = function() {
		if (!live2dModelReady) return;
		var index = live2dModels.indexOf(activeLive2dModel);
		activateLive2dModel(live2dModels[(index + 1) % live2dModels.length], false);
	};
	
	function initLive2d (){
		var landL = parseInt(sessionStorage.getItem("historywidth"));
		var landB = parseInt(sessionStorage.getItem("historyheight"));
		if(Number.isNaN(landL) || Number.isNaN(landB)){
			landL = 5;
			landB = 0;
		}
		$('#landlord').css('left', landL + 'px');
		$('#landlord').css('bottom', landB + 'px');
	}
	// 拖拽由 js/pet-interact.js 实现（并写入 historywidth/historyheight 持久化位置），
	// 原 getEvent() 实现依赖 arguments.callee.caller，在现代 WebKitGTK 下失效，故移除。
	$(document).ready(function() {
		initLive2d();
		// 通知 Rust：页面 JS 已经跑起来（用于启动看门狗，避免透明窗口卡死）
		document.title = 'app_ready';
		live2dModelsLoaded.then(function() {
			activeLive2dModel = findLive2dModel(localStorage.getItem(live2dModelStorageKey));
			activateLive2dModel(activeLive2dModel, true);
		});
	});
}
