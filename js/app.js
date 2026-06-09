var App=(function(){
  'use strict';

  /* ============ 定时器管理器 ============ */
  var TimerMgr = {
    _timers: {},
    setInterval: function(name, fn, ms) {
      this.clear(name);
      this._timers[name] = { id: setInterval(fn, ms), type: 'interval' };
    },
    setTimeout: function(name, fn, ms) {
      this.clear(name);
      var self = this;
      this._timers[name] = {
        id: setTimeout(function(){ delete self._timers[name]; fn(); }, ms),
        type: 'timeout'
      };
    },
    clear: function(name) {
      var t = this._timers[name];
      if (!t) return;
      if (t.type === 'interval') clearInterval(t.id);
      else clearTimeout(t.id);
      delete this._timers[name];
    },
    clearAll: function() {
      var names = Object.keys(this._timers);
      for (var i = 0; i < names.length; i++) this.clear(names[i]);
    },
    has: function(name) { return !!this._timers[name]; }
  };

  /* ============ 状态 ============ */
  var dom = {};
  var DATA_REFRESH_INTERVAL = 3000;
  var TREND_MAX_POINTS = 60;
  var currentScene = 'normal';
  var currentMode = 'auto';
  var selectedEqId = null;
  var currentSnapshot = null;
  var trendHistory = [];

  var STATE_BG = {
    running:'rgba(0,255,136,0.12)', stopped:'rgba(102,119,136,0.10)',
    fault:'rgba(255,68,85,0.12)', maintenance:'rgba(255,170,0,0.12)',
    offline:'rgba(85,102,119,0.10)'
  };
  var dataRanges_max = {flow:320, pressure:0.65, level:100, temperature:55, power:120, runtime:9999};

  /* ============ 初始化 ============ */
  function init(){
    cacheDom();
    initRenderer();
    bindEvents();
    switchScene('normal');
    startTimers();
  }

  function cacheDom(){
    dom.canvas     = document.getElementById('scene');
    dom.sceneBar   = document.getElementById('sceneBar');
    dom.modeBar    = document.getElementById('modeBar');
    dom.panelContent = document.getElementById('panelContent');
    dom.alarmList  = document.getElementById('alarmList');
    dom.sceneLabel = document.getElementById('sceneLabel');
    dom.headerTime = document.getElementById('headerTime');
    dom.statTotal  = document.getElementById('statTotal');
    dom.statRunning= document.getElementById('statRunning');
    dom.statAlarm  = document.getElementById('statAlarm');
    dom.statFPS    = document.getElementById('statFPS');
    dom.statFrame  = document.getElementById('statFrame');
    dom.perfInfo   = document.getElementById('perfInfo');
    dom.trendCanvas= document.getElementById('trendCanvas');
  }

  function initRenderer(){
    Renderer.init(dom.canvas, DataModule.equipment, DataModule.pipes, DataModule.tank, DataModule.buildings);
    Renderer.start();
  }

  /* ============ 定时器启停 ============ */
  function startTimers(){
    TimerMgr.setInterval('clock', updateClock, 1000);
    TimerMgr.setInterval('fps', function(){ if(dom.statFPS) dom.statFPS.textContent = Renderer.getFPS(); }, 1000);
    startDataRefresh();
  }

  function stopTimers(){
    TimerMgr.clearAll();
  }

  function startDataRefresh(){
    TimerMgr.setInterval('dataRefresh', function(){
      if(currentMode === 'paused') return;
      pushSnapshot();
    }, DATA_REFRESH_INTERVAL);
  }

  function stopDataRefresh(){
    TimerMgr.clear('dataRefresh');
  }

  /* ============ 事件绑定 ============ */
  function bindEvents(){
    dom.canvas.addEventListener('click', onCanvasClick, false);
    dom.canvas.addEventListener('mousemove', onCanvasMove, false);

    /* 场景按钮 */
    var sceneBtns = dom.sceneBar.querySelectorAll('.scene-btn');
    for(var i = 0; i < sceneBtns.length; i++) sceneBtns[i].addEventListener('click', onSceneBtnClick, false);

    /* 模式按钮 */
    if(dom.modeBar){
      var modeBtns = dom.modeBar.querySelectorAll('.mode-btn');
      for(var j = 0; j < modeBtns.length; j++) modeBtns[j].addEventListener('click', onModeBtnClick, false);
    }

    /* 报警确认 - 委托 */
    if(dom.alarmList) dom.alarmList.addEventListener('click', onAlarmClick, false);

    /* 窗口resize */
    window.addEventListener('resize', function(){
      TimerMgr.setTimeout('resize', function(){ Renderer.resize(); }, 200);
    }, false);
  }

  function onCanvasClick(e){
    var rect = dom.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    var hitId = Renderer.hitTest(x, y);
    if(hitId) selectEquipment(hitId); else deselectEquipment();
  }
  function onCanvasMove(e){
    var rect = dom.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    var hitId = Renderer.hitTest(x, y);
    dom.canvas.style.cursor = hitId ? 'pointer' : 'default';
    Renderer.setHover(hitId);
  }

  function onSceneBtnClick(e){
    var btn = e.currentTarget, sc = btn.getAttribute('data-scene');
    if(!sc || sc === currentScene) return;
    if(currentMode === 'paused') return;
    var all = dom.sceneBar.querySelectorAll('.scene-btn');
    for(var i = 0; i < all.length; i++) all[i].classList.remove('active');
    btn.classList.add('active');
    switchScene(sc);
  }

  function onModeBtnClick(e){
    var btn = e.currentTarget, mode = btn.getAttribute('data-mode');
    if(!mode || mode === currentMode) return;
    var all = dom.modeBar.querySelectorAll('.mode-btn');
    for(var i = 0; i < all.length; i++) all[i].classList.remove('active');
    btn.classList.add('active');
    switchMode(mode);
  }

  function onAlarmClick(e){
    var li = e.target.closest ? e.target.closest('li[data-alarm-id]') : null;
    if(!li) {
      var el = e.target;
      while(el && el !== dom.alarmList){
        if(el.tagName === 'LI' && el.getAttribute('data-alarm-id')){ li = el; break; }
        el = el.parentNode;
      }
    }
    if(!li) return;
    var alarmId = li.getAttribute('data-alarm-id');
    if(alarmId) ackAlarm(alarmId);
  }

  /* ============ 模式状态机 ============ */
  function switchMode(mode){
    var prevMode = currentMode;
    currentMode = mode;

    if(mode === 'paused'){
      /* 暂停：停数据刷新，暂停渲染动画 */
      stopDataRefresh();
      Renderer.pause();
    } else {
      if(prevMode === 'paused'){
        /* 从暂停恢复 */
        Renderer.resume();
        startDataRefresh();
      }
      if(mode === 'fault_sim'){
        switchScene('pumpFault');
        activateSceneBtn('pumpFault');
      } else if(mode === 'auto'){
        /* 自动模式：恢复到当前场景 */
        pushSnapshot();
      } else if(mode === 'manual'){
        /* 手动模式：保持当前状态 */
        pushSnapshot();
      }
    }
    updateFooter();
  }

  function activateSceneBtn(sceneName){
    var all = dom.sceneBar.querySelectorAll('.scene-btn');
    for(var i = 0; i < all.length; i++){
      if(all[i].getAttribute('data-scene') === sceneName) all[i].classList.add('active');
      else all[i].classList.remove('active');
    }
  }

  /* ============ 场景切换（联锁序列） ============ */
  function switchScene(targetScene){
    var scene = DataModule.scenes[targetScene];
    if(!scene) return;

    var prevScene = currentScene;
    currentScene = targetScene;

    /* 获取联锁执行序列 */
    var sequence = DataModule.getInterlockSequence(prevScene, targetScene);

    /* 按联锁顺序更新设备状态 */
    var eqList = DataModule.equipment;
    for(var s = 0; s < sequence.length; s++){
      var step = sequence[s];
      for(var i = 0; i < eqList.length; i++){
        if(eqList[i].id === step.id){
          eqList[i].state = step.target;
          break;
        }
      }
    }
    /* 更新未在序列中的设备（传感器、水箱等） */
    for(var j = 0; j < eqList.length; j++){
      var eq = eqList[j];
      if(scene.equipment[eq.id] !== undefined) eq.state = scene.equipment[eq.id];
    }

    /* 清除趋势历史（场景变了） */
    if(prevScene !== targetScene) trendHistory = [];

    /* 生成并推送快照 */
    pushSnapshot();
  }

  /* ============ 统一快照推送 ============ */
  function pushSnapshot(){
    var snap = DataModule.createSnapshot(currentScene, currentMode, currentSnapshot);
    if(!snap) return;

    currentSnapshot = snap;

    /* 1. 渲染器：帧边界原子化应用 */
    Renderer.applySnapshot(snap);
    Renderer.rebuildHitAreas();

    /* 2. UI面板：从同一快照读取 */
    if(selectedEqId) showEquipmentPanel(selectedEqId);

    /* 3. 报警列表：从同一快照读取 */
    updateAlarms(snap.alarms);

    /* 4. 统计：从同一快照读取 */
    updateStats(snap.stats);

    /* 5. 帧号 */
    if(dom.statFrame) dom.statFrame.textContent = snap.frameId;

    /* 6. 趋势数据 */
    recordTrend(snap);
    drawTrend();

    /* 7. 底部标签 */
    updateFooter();
  }

  /* ============ 报警确认 ============ */
  function ackAlarm(alarmId){
    if(!currentSnapshot || !currentSnapshot.alarms) return;
    for(var i = 0; i < currentSnapshot.alarms.length; i++){
      if(currentSnapshot.alarms[i].id === alarmId){
        currentSnapshot.alarms[i].acked = true;
        break;
      }
    }
    updateAlarms(currentSnapshot.alarms);
  }

  /* ============ 重置流程 ============ */
  function resetAll(){
    /* 1. 停止所有定时器 */
    stopTimers();

    /* 2. 停止渲染器 */
    Renderer.stop();

    /* 3. 重置数据层 */
    DataModule.resetFrameSeq();
    var eqList = DataModule.equipment;
    var normalScene = DataModule.scenes.normal;
    for(var i = 0; i < eqList.length; i++){
      eqList[i].state = normalScene.equipment[eqList[i].id] || 'stopped';
    }

    /* 4. 清空应用状态 */
    currentScene = 'normal';
    currentMode = 'auto';
    selectedEqId = null;
    currentSnapshot = null;
    trendHistory = [];

    /* 5. 重新初始化 */
    Renderer.start();
    activateSceneBtn('normal');
    activateModeBtn('auto');
    switchScene('normal');
    startTimers();
  }

  function activateModeBtn(mode){
    if(!dom.modeBar) return;
    var all = dom.modeBar.querySelectorAll('.mode-btn');
    for(var i = 0; i < all.length; i++){
      if(all[i].getAttribute('data-mode') === mode) all[i].classList.add('active');
      else all[i].classList.remove('active');
    }
  }

  /* ============ 设备面板 ============ */
  function selectEquipment(id){ selectedEqId = id; Renderer.setSelected(id); showEquipmentPanel(id); }
  function deselectEquipment(){ selectedEqId = null; Renderer.setSelected(null); dom.panelContent.innerHTML = '<div class="panel-placeholder">\u70B9\u51FB\u753B\u5E03\u4E2D\u7684\u8BBE\u5907\u67E5\u770B\u8BE6\u60C5</div>'; }

  function showEquipmentPanel(id){
    if(!currentSnapshot) return;

    /* 从快照中查找设备 */
    var eq = null;
    for(var i = 0; i < currentSnapshot.equipment.length; i++){
      if(currentSnapshot.equipment[i].id === id){ eq = currentSnapshot.equipment[i]; break; }
    }
    if(!eq) return;

    /* 从快照中获取数据 */
    var data = currentSnapshot.sensorData[id] || DataModule.generateData(eq.state);
    var stateLabel = DataModule.STATE_LABELS[eq.state] || eq.state;
    var icons = {pump:'\u2699', valve:'\u2638', sensor:'\u26A1', tank:'\u26C6', cabinet:'\u26A0', alarm_light:'\u26A0'};

    var html = '<div class="eq-header"><div class="eq-icon" style="background:'+(STATE_BG[eq.state]||'#111')+'">'+(icons[eq.type]||'\u2699')+'</div><div><div class="eq-name">'+eq.name+'</div><span class="eq-state '+eq.state+'">'+stateLabel+'</span></div></div>';
    html += '<div class="eq-frame-info">Frame #'+currentSnapshot.frameId+'</div>';

    var fields = [
      {key:'flow',label:'\u6D41\u91CF',icon:'\u2248',color:'#00d4ff'},
      {key:'pressure',label:'\u538B\u529B',icon:'\u25CE',color:'#00ff88'},
      {key:'level',label:'\u6DB2\u4F4D',icon:'\u25A6',color:'#4488ff'},
      {key:'temperature',label:'\u6E29\u5EA6',icon:'\u2600',color:'#ffaa00'},
      {key:'power',label:'\u80FD\u8017',icon:'\u26A1',color:'#aa66ff'},
      {key:'runtime',label:'\u8FD0\u884C\u65F6\u957F',icon:'\u23F1',color:'#88aacc'}
    ];
    html += '<div class="data-grid">';
    for(var f = 0; f < fields.length; f++){
      var field = fields[f], d = data[field.key]; if(!d) continue;
      var valStr = d.value === '--' ? '--' : d.value, barPct = 0;
      if(d.value !== '--'){
        var ref = dataRanges_max[field.key] || 1;
        barPct = Math.min(100, Math.round(d.value / (ref * 1.2) * 100));
      }
      html += '<div class="data-item"><div class="data-label">'+field.icon+' '+field.label+'</div><div class="data-value" style="color:'+field.color+'">'+valStr+'<span class="data-unit">'+d.unit+'</span></div><div class="data-bar"><div class="data-bar-fill" style="width:'+barPct+'%;background:'+field.color+'"></div></div></div>';
    }
    html += '</div>';
    dom.panelContent.innerHTML = html;
  }

  /* ============ 报警列表 ============ */
  function updateAlarms(alarms){
    if(!alarms || alarms.length === 0){
      dom.alarmList.innerHTML = '<li class="alarm-empty">\u6682\u65E0\u544A\u8B66</li>';
      return;
    }
    var unacked = [];
    for(var k = 0; k < alarms.length; k++){
      if(!alarms[k].acked) unacked.push(alarms[k]);
    }
    if(unacked.length === 0){
      dom.alarmList.innerHTML = '<li class="alarm-empty">\u6240\u6709\u544A\u8B66\u5DF2\u786E\u8BA4</li>';
      return;
    }
    var html = '';
    for(var i = 0; i < unacked.length; i++){
      var a = unacked[i];
      html += '<li class="'+a.level+'" data-alarm-id="'+a.id+'" title="\u70B9\u51FB\u786E\u8BA4">';
      html += '<span class="alarm-time">'+a.time+'</span>';
      html += '<span class="alarm-text">'+a.text+'</span>';
      html += '<span class="alarm-ack-btn">\u2713</span>';
      html += '</li>';
    }
    dom.alarmList.innerHTML = html;
  }

  /* ============ 统计 ============ */
  function updateStats(stats){
    if(!stats) return;
    dom.statTotal.textContent = stats.total;
    dom.statRunning.textContent = stats.running;
    dom.statAlarm.textContent = stats.alarm;
  }

  /* ============ 趋势数据 ============ */
  function recordTrend(snap){
    var runningPumps = 0, totalFlow = 0, totalPower = 0;
    for(var i = 0; i < snap.equipment.length; i++){
      if(snap.equipment[i].type === 'pump' && snap.equipment[i].state === 'running') runningPumps++;
    }
    var sd = snap.sensorData;
    if(sd.s_flow_in && sd.s_flow_in.flow && sd.s_flow_in.flow.value !== '--') totalFlow = sd.s_flow_in.flow.value;
    for(var j = 0; j < snap.equipment.length; j++){
      var eqId = snap.equipment[j].id;
      if(snap.equipment[j].type === 'pump' && sd[eqId] && sd[eqId].power && sd[eqId].power.value !== '--'){
        totalPower += sd[eqId].power.value;
      }
    }
    trendHistory.push({
      t: snap.timestamp,
      frame: snap.frameId,
      level: snap.tankLevel,
      flow: totalFlow,
      power: totalPower,
      pumps: runningPumps
    });
    if(trendHistory.length > TREND_MAX_POINTS) trendHistory.shift();
  }

  function drawTrend(){
    var tc = dom.trendCanvas;
    if(!tc) return;
    var tctx = tc.getContext('2d');
    var w = tc.clientWidth, h = tc.clientHeight;
    tc.width = w; tc.height = h;
    if(trendHistory.length < 2) {
      tctx.fillStyle = '#334';
      tctx.fillRect(0, 0, w, h);
      tctx.fillStyle = '#556';
      tctx.font = '11px sans-serif';
      tctx.textAlign = 'center';
      tctx.fillText('\u7B49\u5F85\u6570\u636E...', w/2, h/2);
      return;
    }

    tctx.fillStyle = 'rgba(10,14,39,0.95)';
    tctx.fillRect(0, 0, w, h);

    var n = trendHistory.length, dx = w / (n - 1);
    var series = [
      {key:'level', color:'#4488ff', label:'\u6DB2\u4F4D', max:1},
      {key:'flow',  color:'#00d4ff', label:'\u6D41\u91CF', max:350},
      {key:'power', color:'#aa66ff', label:'\u80FD\u8017', max:200}
    ];

    for(var s = 0; s < series.length; s++){
      var sr = series[s];
      tctx.strokeStyle = sr.color;
      tctx.lineWidth = 1.5;
      tctx.beginPath();
      for(var i = 0; i < n; i++){
        var val = trendHistory[i][sr.key] || 0;
        var y = h - (val / sr.max) * (h - 4) - 2;
        if(i === 0) tctx.moveTo(0, y); else tctx.lineTo(i * dx, y);
      }
      tctx.stroke();
    }

    /* 图例 */
    tctx.font = '10px sans-serif';
    tctx.textAlign = 'left';
    for(var l = 0; l < series.length; l++){
      var lx = 6 + l * 60;
      tctx.fillStyle = series[l].color;
      tctx.fillRect(lx, 4, 10, 3);
      tctx.fillText(series[l].label, lx + 14, 10);
    }
  }

  /* ============ 时钟 & 底栏 ============ */
  function updateClock(){
    var n = new Date(), p = function(v){ return v < 10 ? '0'+v : ''+v; };
    dom.headerTime.textContent = n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+' '+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds());
  }

  function updateFooter(){
    var sceneLabel = currentSnapshot ? currentSnapshot.sceneLabel : '';
    var modeLabel = DataModule.MODE_LABELS[currentMode] || currentMode;
    dom.sceneLabel.textContent = '\u573A\u666F\uFF1A' + sceneLabel + ' | \u6A21\u5F0F\uFF1A' + modeLabel;
  }

  /* ============ 验证脚本 ============ */
  function runValidation(){
    var results = [];
    var pass = 0, fail = 0;

    function assert(name, condition, detail){
      var ok = !!condition;
      results.push({name:name, pass:ok, detail:detail||''});
      if(ok) pass++; else fail++;
    }

    function getSnap(){ return currentSnapshot; }

    function delay(ms){
      return new Promise(function(resolve){ setTimeout(resolve, ms); });
    }

    async function run(){
      console.log('%c===== \u6CF5\u7AD9\u7CFB\u7EDF\u8FDE\u7EED\u64CD\u4F5C\u9A8C\u8BC1\u5F00\u59CB =====', 'color:#00d4ff;font-weight:bold');

      /* T1: \u6B63\u5E38\u573A\u666F\u521D\u59CB\u5316 */
      resetAll();
      await delay(500);
      var s1 = getSnap();
      assert('T1-\u521D\u59CB\u5316\u5FEB\u7167\u5B58\u5728', !!s1);
      assert('T1-\u573A\u666F\u4E3Anormal', s1 && s1.scene === 'normal');
      assert('T1-\u6A21\u5F0F\u4E3Aauto', s1 && s1.mode === 'auto');
      assert('T1-\u5E27\u53F7>0', s1 && s1.frameId > 0, 'frameId=' + (s1?s1.frameId:'null'));

      /* T2: \u5FEB\u901F\u573A\u666F\u5207\u6362 - \u6BCF100ms\u5207\u4E00\u6B21 */
      var sceneNames = ['highLevel','pumpFault','sensorOffline','nightLowLoad','normal'];
      for(var i = 0; i < sceneNames.length; i++){
        switchScene(sceneNames[i]);
        await delay(100);
      }
      var s2 = getSnap();
      assert('T2-\u5FEB\u901F\u5207\u6362\u540E\u573A\u666F\u6B63\u786E', s2 && s2.scene === 'normal');
      assert('T2-\u5E27\u53F7\u9012\u589E', s2 && s2.frameId > s1.frameId, 'frameId=' + (s2?s2.frameId:'null'));

      /* T3: \u72B6\u6001\u4E00\u81F4\u6027 - \u6CF5\u505C\u65F6\u6D41\u91CF\u5FC5\u987B\u4E3A0 */
      switchScene('pumpFault');
      await delay(300);
      var s3 = getSnap();
      var pump1data = s3 ? s3.sensorData.pump1 : null;
      assert('T3-\u6545\u969C\u6CF5\u6D41\u91CF\u4E3A0', pump1data && pump1data.flow && pump1data.flow.value === 0, 'flow=' + (pump1data?pump1data.flow.value:'null'));
      assert('T3-\u6545\u969C\u6CF5\u529F\u7387\u4E3A0', pump1data && pump1data.power && pump1data.power.value === 0, 'power=' + (pump1data?pump1data.power.value:'null'));

      /* T4: \u505C\u673A\u6CF5\u6D41\u91CF\u4E3A0 */
      var pump3data = s3 ? s3.sensorData.pump3 : null;
      assert('T4-\u505C\u673A\u6CF5\u6D41\u91CF\u4E3A0', pump3data && pump3data.flow && pump3data.flow.value === 0);
      assert('T4-\u505C\u673A\u6CF5\u529F\u7387\u4E3A0', pump3data && pump3data.power && pump3data.power.value === 0);

      /* T5: \u6DB2\u4F4D\u4E00\u81F4\u6027 - \u6240\u6709\u8BBE\u5907\u7684\u6DB2\u4F4D\u6765\u81EA\u540C\u4E00\u5FEB\u7167 */
      var allLevelsSame = true;
      var expectedLevel = s3 ? Math.round(s3.tankLevel * 100) : -1;
      if(s3){
        for(var eqId in s3.sensorData){
          var d = s3.sensorData[eqId];
          if(d.level && d.level.value !== '--' && d.level.value !== expectedLevel){
            allLevelsSame = false;
            break;
          }
        }
      }
      assert('T5-\u6240\u6709\u6DB2\u4F4D\u503C\u4E00\u81F4', allLevelsSame, 'expected=' + expectedLevel);

      /* T6: \u7BA1\u9053\u4E0E\u6CF5\u72B6\u6001\u540C\u6B65 */
      if(s3){
        var pump1eq = null, drop1pipe = null;
        for(var ei = 0; ei < s3.equipment.length; ei++){
          if(s3.equipment[ei].id === 'pump1') pump1eq = s3.equipment[ei];
        }
        for(var pi = 0; pi < s3.pipes.length; pi++){
          if(s3.pipes[pi].id === 'drop1') drop1pipe = s3.pipes[pi];
        }
        assert('T6-\u6545\u969C\u6CF5\u5BF9\u5E94\u7BA1\u9053\u4E0D\u6D3B\u8DC3', pump1eq && pump1eq.state === 'fault' && drop1pipe && !drop1pipe.active);
      }

      /* T7: \u62A5\u8B66\u53BB\u91CD + \u786E\u8BA4 */
      assert('T7-\u6709\u62A5\u8B66', s3 && s3.alarms.length > 0);
      if(s3 && s3.alarms.length > 0){
        var firstAlarmId = s3.alarms[0].id;
        ackAlarm(firstAlarmId);
        assert('T7-\u786E\u8BA4\u6807\u8BB0', s3.alarms[0].acked === true);

        /* \u5237\u65B0\u5FEB\u7167\uFF0C\u786E\u8BA4\u72B6\u6001\u4FDD\u6301 */
        pushSnapshot();
        await delay(100);
        var s3b = getSnap();
        var stillAcked = false;
        for(var ai = 0; ai < s3b.alarms.length; ai++){
          if(s3b.alarms[ai].id === firstAlarmId && s3b.alarms[ai].acked){ stillAcked = true; break; }
        }
        assert('T7-\u786E\u8BA4\u72B6\u6001\u4FDD\u6301', stillAcked);
      }

      /* T8: \u6682\u505C\u6062\u590D */
      var preF = getSnap().frameId;
      switchMode('paused');
      assert('T8-\u6E32\u67D3\u5668\u5DF2\u6682\u505C', Renderer.isPaused());
      await delay(500);
      assert('T8-\u6682\u505C\u65F6\u5E27\u53F7\u4E0D\u53D8', getSnap().frameId === preF, 'frameId=' + getSnap().frameId);

      switchMode('auto');
      assert('T8-\u6062\u590D\u540E\u672A\u6682\u505C', !Renderer.isPaused());
      await delay(500);
      assert('T8-\u6062\u590D\u540E\u5E27\u53F7\u589E\u52A0', getSnap().frameId > preF);

      /* T9: \u5B8C\u6574\u91CD\u7F6E */
      switchScene('highLevel');
      await delay(200);
      resetAll();
      await delay(500);
      var s9 = getSnap();
      assert('T9-\u91CD\u7F6E\u540E\u573A\u666F\u4E3Anormal', s9 && s9.scene === 'normal');
      assert('T9-\u91CD\u7F6E\u540E\u6A21\u5F0F\u4E3Aauto', s9 && s9.mode === 'auto');

      /* T10: \u8054\u9501\u5E8F\u5217\u6B63\u786E\u6027 */
      var seq = DataModule.getInterlockSequence('normal', 'highLevel');
      var stopIdx = -1, startIdx = -1;
      for(var si = 0; si < seq.length; si++){
        if(seq[si].id === 'pump3' && seq[si].action === 'start') startIdx = si;
        if(seq[si].id === 'v3' && seq[si].action === 'start'){
          if(startIdx < 0) assert('T10-\u9600\u5148\u4E8E\u6CF5\u542F\u52A8', true);
          else assert('T10-\u9600\u5148\u4E8E\u6CF5\u542F\u52A8', false, 'pump3\u5728v3\u4E4B\u524D');
        }
      }
      if(seq.length > 0) assert('T10-\u6709\u8054\u9501\u5E8F\u5217', true, 'steps=' + seq.length);

      /* T11: \u5E27\u5FEB\u7167\u4E0E\u6E32\u67D3\u5E27\u540C\u6B65 */
      pushSnapshot();
      await delay(200);
      var snapFrame = getSnap().frameId;
      var renderFrame = Renderer.getAppliedFrameId();
      assert('T11-\u5FEB\u7167\u5E27\u4E0E\u6E32\u67D3\u5E27\u4E00\u81F4', snapFrame === renderFrame,
             'snap=' + snapFrame + ' render=' + renderFrame);

      /* \u7ED3\u679C\u6C47\u603B */
      console.log('%c===== \u9A8C\u8BC1\u7ED3\u679C =====', 'color:#00d4ff;font-weight:bold');
      for(var r = 0; r < results.length; r++){
        var res = results[r];
        console.log(
          '%c' + (res.pass ? '\u2713 PASS' : '\u2717 FAIL') + '%c ' + res.name + (res.detail ? ' ('+res.detail+')' : ''),
          res.pass ? 'color:#00ff88' : 'color:#ff4455;font-weight:bold',
          'color:#c8d6e5'
        );
      }
      console.log('%c\u603B\u8BA1: '+pass+' \u901A\u8FC7, '+fail+' \u5931\u8D25, \u5171 '+results.length+' \u9879',
        fail === 0 ? 'color:#00ff88;font-weight:bold' : 'color:#ff4455;font-weight:bold');

      return { pass:pass, fail:fail, total:results.length, results:results };
    }

    return run();
  }

  /* ============ 启动 ============ */
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    switchScene:switchScene, selectEquipment:selectEquipment, deselectEquipment:deselectEquipment,
    switchMode:switchMode, ackAlarm:ackAlarm, resetAll:resetAll,
    pushSnapshot:pushSnapshot, getSnapshot:function(){ return currentSnapshot; },
    runValidation:runValidation
  };
})();
