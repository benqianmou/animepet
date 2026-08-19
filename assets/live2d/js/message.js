var home_Path = document.location.protocol +'//' + window.document.location.host +'/';

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
	var hitFlag = false;
	var liveTlakTimer = null;
	var sleepTimer_ = null;
	(function (){
		$(document).on('copy', function (){
			showMessage('你都复制了些什么呀，转载要记得加上出处哦~~');
		});
		
		function initTips(){
			$.ajax({
				cache: true,
				url: message_Path+'message.json',
				dataType: "json",
				success: function (result){
					$.each(result.click, function (index, tips){
						$(tips.selector).click(function (){
							if(hitFlag){
								return false
							}
							hitFlag = true;
							setTimeout(function(){
								hitFlag = false;
							},8000);
							var text = tips.text;
							if(Array.isArray(tips.text)) text = tips.text[Math.floor(Math.random() * tips.text.length + 1)-1];
							showMessage(text);
						});
						clearInterval(liveTlakTimer);
						liveTlakTimer = null;
						if(liveTlakTimer == null){
							liveTlakTimer = window.setInterval(function(){
								showHitokoto();
							},15000);
						};
					});
				}
			});
		}
		initTips();
	
		var text;
		if(document.referrer !== ''){
			var referrer = document.createElement('a');
			referrer.href = document.referrer;
			text = '嗨！来自 <span style="color:#0099cc;">' + referrer.hostname + '</span> 的朋友！';
			var domain = referrer.hostname.split('.')[1];
			if (domain == 'baidu') {
				text = '嗨！ 来自 百度搜索 的朋友！<br>欢迎访问<span style="color:#0099cc;">「 ' + document.title.split(' - ')[0] + ' 」</span>';
			}else if (domain == 'so') {
				text = '嗨！ 来自 360搜索 的朋友！<br>欢迎访问<span style="color:#0099cc;">「 ' + document.title.split(' - ')[0] + ' 」</span>';
			}else if (domain == 'google') {
				text = '嗨！ 来自 谷歌搜索 的朋友！<br>欢迎访问<span style="color:#0099cc;">「 ' + document.title.split(' - ')[0] + ' 」</span>';
			}
		}else {
			if (window.location.href == home_Path) { //主页URL判断，需要斜杠结尾
				var now = (new Date()).getHours();
				if (now > 23 || now <= 5) {
					text = '你是夜猫子呀？这么晚还不睡觉，明天起的来嘛？';
				} else if (now > 5 && now <= 7) {
					text = '早上好！一日之计在于晨，美好的一天就要开始了！';
				} else if (now > 7 && now <= 11) {
					text = '上午好！工作顺利嘛，不要久坐，多起来走动走动哦！';
				} else if (now > 11 && now <= 14) {
					text = '中午了，工作了一个上午，现在是午餐时间！';
				} else if (now > 14 && now <= 17) {
					text = '午后很容易犯困呢，今天的运动目标完成了吗？';
				} else if (now > 17 && now <= 19) {
					text = '傍晚了！窗外夕阳的景色很美丽呢，最美不过夕阳红~~';
				} else if (now > 19 && now <= 21) {
					text = '晚上好，今天过得怎么样？';
				} else if (now > 21 && now <= 23) {
					text = '已经这么晚了呀，早点休息吧，晚安~~';
				} else {
					text = '嗨~ 快来逗我玩吧！';
				}
			}else {
				text = '欢迎阅读<span style="color:#0099cc;">「 ' + document.title.split(' - ')[0] + ' 」</span>';
			}
		}
		showMessage(text);
	})();
	
	liveTlakTimer = setInterval(function(){
		showHitokoto();
	},15000);
	
	function showHitokoto(){
		if(sessionStorage.getItem("Sleepy")!=="1"){
			$.getJSON('https://sslapi.hitokoto.cn/',function(result){
				talkValTimer();
				showMessage(result.hitokoto);
			}).fail(function(){
				showMessage('(｡•́︿•̀｡) 网络开小差了~');
			});
		}else{
			hideMessage(0);
			if(sleepTimer_==null){
				sleepTimer_ = setInterval(function(){
					checkSleep();
				},200);
			}
			console.log(sleepTimer_);
		}
	}
	
	function checkSleep(){
		var sleepStatu = sessionStorage.getItem("Sleepy");
		if(sleepStatu!=='1'){
			talkValTimer();
			showMessage('你回来啦~');
			clearInterval(sleepTimer_);
			sleepTimer_= null;
		}
	}
	
	function showMessage(text){
		if(Array.isArray(text)) text = text[Math.floor(Math.random() * text.length + 1)-1];
		$('.message').stop();
		$('.message').html(text);
		$('.message').fadeTo(200, 1);
	}
	function talkValTimer(){
		$('#live_talk').val('1');
	}
	
	function hideMessage(timeout){
		if (timeout === null) timeout = 5000;
		$('.message').delay(timeout).fadeTo(200, 0);
	}
	
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
	// 拖拽已由 index.html 独立实现（并写入 historywidth/historyheight 持久化位置），
	// 原 getEvent() 实现依赖 arguments.callee.caller，在现代 WebKitGTK 下失效，故移除。
	$(document).ready(function() {
		var AIimgSrc = [
			home_Path + message_Path + "model/katou_01/moc/katou.2048/texture_00.png"
		]
		var images = [];
		var imgLength = AIimgSrc.length;
		var loadingNum = 0;
		for(var i=0;i<imgLength;i++){
			images[i] = new Image();
			images[i].src = AIimgSrc[i];
			images[i].onload = function(){
				loadingNum++;
				if(loadingNum===imgLength){
					setTimeout(function(){
						$('#landlord').fadeIn(200);
					},1300);
					setTimeout(function(){
						loadlive2d("live2d", message_Path+"model/katou_01/katou_01.model.json");
					},1000);
					initLive2d ();
					images = null;
				}
			}
		}
	});
}
