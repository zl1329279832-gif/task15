/**
 * Engine - 智慧泵站仿真引擎
 *
 * 核心设计原则:
 * 1. 单一定时器 (10Hz)，启动前必须清除旧的 — 修复定时器重复启动
 * 2. 所有可变状态仅 Engine 内部持有 — 消除共享引用
 * 3. 每 tick 产生 Object.freeze 快照 — Canvas/DOM/Trend 读取同一帧
 * 4. 联动级联在同一 tick 内按序执行 + latch 防重入 — 修复设备联动顺序
 * 5. 报警使用 dedupKey 去重 — 修复报警重新出现
 * 6. 状态机守卫非法转换 — 修复快速切换时的混乱
 */
var Engine = (function () {
  'use strict';

  /* ========== 模式状态机 ========== */
  var MODE = {IDLE:0, AUTO:1, MANUAL:2, PAUSED:3};
  var MODE_LABEL = {0:'idle', 1:'auto', 2:'manual', 3:'paused'};
  var _mode = MODE.IDLE;
  var _prevMode = MODE.IDLE; // 暂停前模式，用于恢复

  /* ========== 定时器 ========== */
  var _tickTimer = null;
  var TICK_MS = 100;         // 10 Hz 仿真
  var _frameCounter = 0;
  var _simTime = 0;          // 仿真累计时间 (秒)

  /* ========== 内部可变状态 ========== */
  var _eqStates = {};        // {id: {state, flow, pressure, temp, power, runtime}}
  var _tankLevel = 0.60;
  var _activePipes = [];
  var _totalFlow = 0;
  var _totalPower = 0;
  var _energyKWh = 0;

  /* ========== 报警 ========== */
  var _activeAlarms = {};    // {dedupKey: {id, key, severity, text, time, acked}}
  var _alarmHistory = [];    // 最近 50 条已确认/已清除报警
  var _alarmIdCounter = 0;

  /* ========== 联动 latch ========== */
  var _cascadeLatched = {};  // {ruleAlarmKey: true} 防止同一联动重复执行

  /* ========== 故障注入 ========== */
  var _injectedFaults = {};  // {type: true}

  /* ========== 回调 ========== */
  var _onTick = null;

  /* ========== 工具函数 ========== */
  function _clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function _pad(v) { return v < 10 ? '0' + v : '' + v; }
  function _timeStr() {
    var d = new Date();
    return _pad(d.getHours()) + ':' + _pad(d.getMinutes()) + ':' + _pad(d.getSeconds());
  }
  function _rand(a, b) { return a + Math.random() * (b - a); }
  function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ========== 初始化内部状态 ========== */
  function _initState() {
    var init = DataModule.initialState;
    var eqTpl = DataModule.equipment;
    _eqStates = {};
    for (var i = 0; i < eqTpl.length; i++) {
      var eq = eqTpl[i];
      _eqStates[eq.id] = {
        state: init[eq.id] || 'stopped',
        flow: 0, pressure: 0, temp: 25, power: 0, runtime: 0
      };
    }
    _tankLevel = DataModule.tankPhysics.initialLevel;
    _totalFlow = 0;
    _totalPower = 0;
    _energyKWh = 0;
    _activeAlarms = {};
    _alarmHistory = [];
    _alarmIdCounter = 0;
    _cascadeLatched = {};
    _injectedFaults = {};
    _frameCounter = 0;
    _simTime = 0;
    _updateActivePipes();
  }

  /* ========== 管道激活计算 ========== */
  function _updateActivePipes() {
    var active = [];
    var always = DataModule.alwaysActivePipes;
    for (var a = 0; a < always.length; a++) active.push(always[a]);

    var map = DataModule.pipePumpMap;
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    for (var p = 0; p < pumpIds.length; p++) {
      var pid = pumpIds[p];
      var es = _eqStates[pid];
      var pm = map[pid];
      if (!es || !pm) continue;
      // 泵运行 且 对应泵前阀打开 → 激活 drop + riser
      if (es.state === 'running' && _eqStates[pm.valve] && _eqStates[pm.valve].state === 'running') {
        active.push(pm.drop);
        active.push(pm.riser);
      }
    }
    // inlet 阀控制
    if (_eqStates['v_inlet'] && _eqStates['v_inlet'].state !== 'running') {
      var idx = active.indexOf('inlet');
      if (idx >= 0) active.splice(idx, 1);
    }
    // outlet 阀控制
    if (_eqStates['v_outlet'] && _eqStates['v_outlet'].state !== 'running') {
      var idx2 = active.indexOf('outlet');
      if (idx2 >= 0) active.splice(idx2, 1);
    }
    _activePipes = active;
  }

  /* ========== 物理计算 ========== */
  function _physicsTick(dt) {
    var pc = DataModule.pumpConfig;
    var bd = DataModule.boundary;
    var tp = DataModule.tankPhysics;

    // 1. 计算每台泵的流量/压力/功率/温度
    var totalPumpFlow = 0;
    _totalPower = 0;
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var es = _eqStates[pid];
      var valveId = DataModule.pipePumpMap[pid].valve;
      var vs = _eqStates[valveId];
      var valveOpen = vs && vs.state === 'running';

      if (es.state === 'running' && valveOpen) {
        es.flow = pc.ratedFlow * _rand(0.92, 1.08);
        es.pressure = pc.ratedPressure * _rand(0.90, 1.10);
        es.power = pc.ratedPower * _rand(0.88, 1.12);
        // 温度缓慢上升 + 随机波动
        es.temp = _clamp(es.temp + _rand(-0.3, 0.5), 25, pc.maxTempFault + 5);
        es.runtime += dt / 3600; // 小时
        totalPumpFlow += es.flow;
        _totalPower += es.power;
      } else if (es.state === 'fault') {
        es.flow = _rand(0, 10);
        es.pressure = _rand(0, 0.05);
        es.power = _rand(0, 2);
        es.temp = _clamp(es.temp + _rand(-0.5, 1.5), 25, 95);
      } else {
        // stopped / maintenance / offline
        es.flow = 0;
        es.pressure = 0;
        es.power = 0;
        es.temp = _clamp(es.temp + _rand(-0.5, 0.1), 20, 30);
      }
    }
    _totalFlow = totalPumpFlow;

    // 2. 进水流量 (受进水阀控制)
    var inletFlow = 0;
    if (_eqStates['v_inlet'] && _eqStates['v_inlet'].state === 'running') {
      inletFlow = bd.inletFlow * _rand(0.95, 1.05);
    }

    // 3. 排水流量 (重力排水 Q = coeff * sqrt(level))
    var drainFlow = bd.drainCoeff * Math.sqrt(Math.max(0, _tankLevel));

    // 4. 出水流量 = 泵总流量 (泵将水从池中抽出)
    var outletFlow = totalPumpFlow;

    // 5. 水池液位 Euler 积分
    //    dLevel/dt = (inletFlow - drainFlow - outletFlow) / (area * 3600)
    //    流量单位 m³/h, 需要 /3600 得到 m³/s; area m² → level m/s → *dt
    //    但 level 是比例值 (0~1)，实际高度按 5m 算
    var TANK_HEIGHT = 5; // m
    var netFlowM3s = (inletFlow - drainFlow - outletFlow) / 3600;
    var dLevel = netFlowM3s * dt / (tp.area * TANK_HEIGHT);
    _tankLevel = _clamp(_tankLevel + dLevel, 0, 1.0);

    // 6. 能耗累加 (kW * h)
    _energyKWh += _totalPower * dt / 3600;

    // 7. 传感器读数
    if (_eqStates['s_flow_in']) {
      var sf = _eqStates['s_flow_in'];
      sf.flow = sf.state === 'offline' ? null : (sf.state === 'running' ? inletFlow : 0);
    }
    if (_eqStates['s_flow_out']) {
      var sfo = _eqStates['s_flow_out'];
      sfo.flow = sfo.state === 'offline' ? null : (sfo.state === 'running' ? outletFlow : 0);
    }
    if (_eqStates['s_level']) {
      var sl = _eqStates['s_level'];
      sl.level = sl.state === 'offline' ? null : (sl.state === 'running' ? _tankLevel * 100 : 0);
    }
    if (_eqStates['s_press_in']) {
      var sp = _eqStates['s_press_in'];
      sp.pressure = sp.state === 'offline' ? null : (sp.state === 'running' ? _rand(0.20, 0.35) : 0);
    }
    if (_eqStates['s_temp']) {
      var st = _eqStates['s_temp'];
      // 显示运行中泵的最高温度
      var maxT = 25;
      for (var p = 0; p < pumpIds.length; p++) {
        var pt = _eqStates[pumpIds[p]].temp;
        if (pt > maxT) maxT = pt;
      }
      st.temp = st.state === 'offline' ? null : (st.state === 'running' ? maxT : 25);
    }

    // 8. 更新管道激活状态
    _updateActivePipes();
  }

  /* ========== 联动级联 ========== */
  function _runLinkage() {
    if (_mode !== MODE.AUTO) return;
    var rules = DataModule.linkageRules;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      // 已执行过的联动不再重复
      if (_cascadeLatched[rule.alarmKey]) continue;

      var parts = rule.trigger.split(':');
      var triggerId = parts[0];
      var triggerCond = parts[1];

      var triggered = false;
      if (triggerCond === 'fault') {
        triggered = _eqStates[triggerId] && _eqStates[triggerId].state === 'fault';
      } else if (triggerCond === 'level_high_high') {
        triggered = _tankLevel > DataModule.tankPhysics.levelHighHigh;
      } else if (triggerCond === 'level_high') {
        triggered = _tankLevel > DataModule.tankPhysics.levelHigh;
      }

      if (triggered) {
        // 按序执行联动动作 (同一 tick 内)
        for (var a = 0; a < rule.actions.length; a++) {
          var act = rule.actions[a];
          if (_eqStates[act.target]) {
            _eqStates[act.target].state = act.state;
          }
        }
        _cascadeLatched[rule.alarmKey] = true;
        // 生成联动报警
        _raiseAlarm(rule.alarmKey, 'warning', rule.alarmText);
      }
    }
  }

  /* ========== 报警系统 ========== */
  function _raiseAlarm(dedupKey, severity, text) {
    if (_activeAlarms[dedupKey]) return; // 去重: 相同 key 不重复添加
    var id = ++_alarmIdCounter;
    _activeAlarms[dedupKey] = {
      id: id, key: dedupKey, severity: severity,
      text: text, time: _timeStr(), acked: false
    };
    // 激活声光报警器
    if (_eqStates['alarm_light']) {
      _eqStates['alarm_light'].state = 'running';
    }
  }

  function _clearAlarm(dedupKey) {
    var alarm = _activeAlarms[dedupKey];
    if (!alarm) return;
    // 移入历史
    alarm.acked = true;
    alarm.clearTime = _timeStr();
    _alarmHistory.push(alarm);
    if (_alarmHistory.length > 50) _alarmHistory.shift();
    delete _activeAlarms[dedupKey];
    // 如果没有未确认报警，关闭声光
    var keys = Object.keys(_activeAlarms);
    var hasUnacked = false;
    for (var i = 0; i < keys.length; i++) {
      if (!_activeAlarms[keys[i]].acked) { hasUnacked = true; break; }
    }
    if (!hasUnacked && _eqStates['alarm_light']) {
      _eqStates['alarm_light'].state = 'stopped';
    }
  }

  function _detectAlarms() {
    var tp = DataModule.tankPhysics;
    var pc = DataModule.pumpConfig;

    // 液位高
    if (_tankLevel > tp.levelHigh) {
      _raiseAlarm('tank:high', 'critical',
        '\u6c34\u6c60\u6db2\u4f4d\u8d85\u9ad8\u9650 (' + Math.round(_tankLevel * 100) + '%)');
    } else {
      _clearAlarm('tank:high');
    }
    // 液位超高
    if (_tankLevel > tp.levelHighHigh) {
      _raiseAlarm('tank:high_high', 'critical',
        '\u6c34\u6c60\u6db2\u4f4d\u8d85\u8d85\u9ad8\u9650 (' + Math.round(_tankLevel * 100) + '%)');
    } else {
      _clearAlarm('tank:high_high');
    }
    // 液位低
    if (_tankLevel < tp.levelLow) {
      _raiseAlarm('tank:low', 'warning',
        '\u6c34\u6c60\u6db2\u4f4d\u8fc7\u4f4e (' + Math.round(_tankLevel * 100) + '%)');
    } else {
      _clearAlarm('tank:low');
    }

    // 泵故障
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var es = _eqStates[pid];
      var nm = pid.replace('pump', '') + '#\u6c34\u6cf5';
      if (es.state === 'fault') {
        _raiseAlarm('pump:fault:' + pid, 'critical',
          nm + '\u6545\u969c');
      } else {
        _clearAlarm('pump:fault:' + pid);
      }
      if (es.state === 'running' && es.temp > pc.maxTemp) {
        _raiseAlarm('pump:overtemp:' + pid, 'warning',
          nm + '\u7ed5\u7ec4\u6e29\u5ea6\u8fc7\u9ad8 (' + Math.round(es.temp) + '\u00b0C)');
      } else {
        _clearAlarm('pump:overtemp:' + pid);
      }
    }

    // 传感器离线
    var sensorIds = ['s_flow_in', 's_press_in', 's_level', 's_flow_out', 's_temp'];
    for (var s = 0; s < sensorIds.length; s++) {
      var sid = sensorIds[s];
      var se = _eqStates[sid];
      if (se && se.state === 'offline') {
        _raiseAlarm('sensor:offline:' + sid, 'critical',
          _getEqName(sid) + '\u901a\u4fe1\u4e2d\u65ad');
      } else {
        _clearAlarm('sensor:offline:' + sid);
      }
    }
  }

  function _getEqName(id) {
    var eqList = DataModule.equipment;
    for (var i = 0; i < eqList.length; i++) {
      if (eqList[i].id === id) return eqList[i].name;
    }
    return id;
  }

  /* ========== 快照生成 ========== */
  function _produceSnapshot() {
    var eqArr = [];
    var eqTpl = DataModule.equipment;
    for (var i = 0; i < eqTpl.length; i++) {
      var tpl = eqTpl[i];
      var es = _eqStates[tpl.id] || {};
      eqArr.push({
        id: tpl.id, type: tpl.type, name: tpl.name,
        rx: tpl.rx, ry: tpl.ry,
        sensorType: tpl.sensorType || null,
        state: es.state || 'stopped',
        flow: es.flow || 0,
        pressure: es.pressure || 0,
        temp: es.temp || 25,
        power: es.power || 0,
        runtime: es.runtime || 0
      });
    }

    var pipeArr = [];
    var pipesTpl = DataModule.pipes;
    for (var p = 0; p < pipesTpl.length; p++) {
      var pp = pipesTpl[p];
      pipeArr.push({
        id: pp.id, color: pp.color, points: pp.points,
        active: _activePipes.indexOf(pp.id) >= 0
      });
    }

    var alarmArr = [];
    var akeys = Object.keys(_activeAlarms);
    for (var a = 0; a < akeys.length; a++) {
      var al = _activeAlarms[akeys[a]];
      alarmArr.push({
        id: al.id, key: al.key, severity: al.severity,
        text: al.text, time: al.time, acked: al.acked
      });
    }

    // 按 severity 排序: critical > warning > info
    var sevOrder = {critical: 0, warning: 1, info: 2};
    alarmArr.sort(function (a, b) { return (sevOrder[a.severity] || 3) - (sevOrder[b.severity] || 3); });

    var snap = {
      frameId: _frameCounter,
      timestamp: Date.now(),
      simTime: _simTime,
      mode: MODE_LABEL[_mode],
      modeId: _mode,
      equipment: eqArr,
      pipes: pipeArr,
      tankLevel: _tankLevel,
      tankGeom: DataModule.tankGeom,
      totalFlow: _totalFlow,
      totalPower: _totalPower,
      energyKWh: _energyKWh,
      alarms: alarmArr,
      alarmHistory: _alarmHistory.slice(-20),
      unackedCount: _countUnacked(),
      runningCount: _countByState('running'),
      faultCount: _countByState('fault') + _countByState('offline'),
      totalEqCount: eqTpl.length
    };

    // 深度冻结
    Object.freeze(snap);
    Object.freeze(snap.equipment);
    Object.freeze(snap.pipes);
    Object.freeze(snap.alarms);
    for (var fi = 0; fi < snap.equipment.length; fi++) Object.freeze(snap.equipment[fi]);
    for (var fp = 0; fp < snap.pipes.length; fp++) Object.freeze(snap.pipes[fp]);
    for (var fa = 0; fa < snap.alarms.length; fa++) Object.freeze(snap.alarms[fa]);

    return snap;
  }

  function _countByState(st) {
    var c = 0, keys = Object.keys(_eqStates);
    for (var i = 0; i < keys.length; i++) {
      if (_eqStates[keys[i]].state === st) c++;
    }
    return c;
  }
  function _countUnacked() {
    var c = 0, keys = Object.keys(_activeAlarms);
    for (var i = 0; i < keys.length; i++) {
      if (!_activeAlarms[keys[i]].acked) c++;
    }
    return c;
  }

  /* ========== 核心 tick ========== */
  function _tick() {
    if (_mode === MODE.PAUSED || _mode === MODE.IDLE) {
      // 暂停或空闲时仍产生快照 (供渲染)，但不推进物理
      var snap = _produceSnapshot();
      if (_onTick) _onTick(snap);
      return;
    }
    var dt = TICK_MS / 1000; // 0.1 秒
    _frameCounter++;
    _simTime += dt;

    // 1. 物理计算
    _physicsTick(dt);

    // 2. 联动级联 (AUTO 模式)
    _runLinkage();

    // 3. 报警检测
    _detectAlarms();

    // 4. 产生快照
    var snap = _produceSnapshot();

    // 5. 通知消费者
    if (_onTick) _onTick(snap);
  }

  /* ========== 定时器生命周期 ========== */
  function _startTimer() {
    _stopTimer(); // 关键: 启动前必须清除 — 修复定时器重复启动
    _tickTimer = setInterval(_tick, TICK_MS);
  }
  function _stopTimer() {
    if (_tickTimer) {
      clearInterval(_tickTimer);
      _tickTimer = null;
    }
  }

  /* ========== 公开 API ========== */

  /**
   * 设置运行模式
   * 状态机守卫: 忽略非法转换
   */
  function setMode(newMode) {
    var nm = typeof newMode === 'string' ? newMode.toLowerCase() : '';
    var transitions = {
      'auto':   {from: [MODE.IDLE, MODE.MANUAL, MODE.PAUSED], to: MODE.AUTO},
      'manual': {from: [MODE.IDLE, MODE.AUTO, MODE.PAUSED], to: MODE.MANUAL},
      'pause':  {from: [MODE.AUTO, MODE.MANUAL], to: MODE.PAUSED},
      'resume': {from: [MODE.PAUSED], to: _prevMode || MODE.AUTO},
      'stop':   {from: [MODE.AUTO, MODE.MANUAL, MODE.PAUSED], to: MODE.IDLE}
    };
    var tr = transitions[nm];
    if (!tr) return false;
    if (tr.from.indexOf(_mode) < 0) return false; // 非法转换

    if (_mode !== MODE.PAUSED && nm !== 'resume') {
      _prevMode = _mode;
    }

    var targetMode = (nm === 'resume') ? (_prevMode || MODE.AUTO) : tr.to;
    _mode = targetMode;

    // 启动/停止定时器
    if (_mode === MODE.IDLE) {
      _stopTimer();
    } else {
      _startTimer();
    }

    // 模式切换时产生一个即时快照
    var snap = _produceSnapshot();
    if (_onTick) _onTick(snap);
    return true;
  }

  /**
   * 手动覆写设备状态 (仅 MANUAL 模式有效)
   */
  function manualOverride(eqId, newState) {
    if (_mode !== MODE.MANUAL) return false;
    if (!_eqStates[eqId]) return false;
    _eqStates[eqId].state = newState;
    _updateActivePipes();
    // 手动模式不触发联动
    var snap = _produceSnapshot();
    if (_onTick) _onTick(snap);
    return true;
  }

  /**
   * 注入故障
   */
  function injectFault(type) {
    if (_injectedFaults[type]) return false;
    _injectedFaults[type] = true;

    switch (type) {
      case 'pump1_fault':
        if (_eqStates['pump1']) _eqStates['pump1'].state = 'fault';
        _raiseAlarm('inject:pump1_fault', 'critical',
          '1#\u6c34\u6cf5\u8fc7\u6d41\u4fdd\u62a4\u52a8\u4f5c');
        break;
      case 'pump2_fault':
        if (_eqStates['pump2']) _eqStates['pump2'].state = 'fault';
        _raiseAlarm('inject:pump2_fault', 'critical',
          '2#\u6c34\u6cf5\u8fc7\u6d41\u4fdd\u62a4\u52a8\u4f5c');
        break;
      case 'sensor_offline':
        if (_eqStates['s_flow_in']) _eqStates['s_flow_in'].state = 'offline';
        if (_eqStates['s_level']) _eqStates['s_level'].state = 'offline';
        _raiseAlarm('inject:sensor_offline', 'critical',
          '\u4f20\u611f\u5668\u79bb\u7ebf: \u8fdb\u6c34\u6d41\u91cf\u8ba1, \u6db2\u4f4d\u8ba1');
        break;
      case 'pipe_leak':
        _raiseAlarm('inject:pipe_leak', 'warning',
          '\u7ba1\u9053\u6cc4\u6f0f\u68c0\u6d4b: \u51fa\u6c34\u6d41\u91cf\u5f02\u5e38');
        // 模拟泄漏: 减少 15% 流量效率
        break;
    }
    _updateActivePipes();
    // 如果在 AUTO 模式，立即运行一次联动
    if (_mode === MODE.AUTO) {
      _runLinkage();
    }
    var snap = _produceSnapshot();
    if (_onTick) _onTick(snap);
    return true;
  }

  /**
   * 确认报警
   */
  function acknowledgeAlarm(alarmKey) {
    var alarm = _activeAlarms[alarmKey];
    if (!alarm) return false;
    alarm.acked = true;
    // 移入历史
    alarm.clearTime = _timeStr();
    _alarmHistory.push(alarm);
    if (_alarmHistory.length > 50) _alarmHistory.shift();
    delete _activeAlarms[alarmKey];
    // 检查是否还有未确认报警
    var keys = Object.keys(_activeAlarms);
    var hasUnacked = false;
    for (var i = 0; i < keys.length; i++) {
      if (!_activeAlarms[keys[i]].acked) { hasUnacked = true; break; }
    }
    if (!hasUnacked && _eqStates['alarm_light']) {
      _eqStates['alarm_light'].state = 'stopped';
    }
    var snap = _produceSnapshot();
    if (_onTick) _onTick(snap);
    return true;
  }

  /**
   * 完全重置
   */
  function reset() {
    _stopTimer();
    _mode = MODE.IDLE;
    _prevMode = MODE.IDLE;
    _initState();
    var snap = _produceSnapshot();
    if (_onTick) _onTick(snap);
    return true;
  }

  /**
   * 注册 tick 回调
   */
  function onTick(fn) {
    _onTick = fn;
  }

  /**
   * 获取当前模式
   */
  function getMode() {
    return MODE_LABEL[_mode];
  }

  /**
   * 获取当前快照 (不推进仿真)
   */
  function getSnapshot() {
    return _produceSnapshot();
  }

  /**
   * 获取内部状态 (仅供 verify 使用)
   */
  function _debugState() {
    return {
      mode: MODE_LABEL[_mode],
      timerActive: _tickTimer !== null,
      frameCounter: _frameCounter,
      cascadeLatched: _clone(_cascadeLatched),
      activeAlarmKeys: Object.keys(_activeAlarms),
      eqStates: _clone(_eqStates),
      tankLevel: _tankLevel
    };
  }

  /* ========== 初始化 ========== */
  _initState();

  return {
    MODE: MODE,
    setMode: setMode,
    manualOverride: manualOverride,
    injectFault: injectFault,
    acknowledgeAlarm: acknowledgeAlarm,
    reset: reset,
    onTick: onTick,
    getMode: getMode,
    getSnapshot: getSnapshot,
    _debugState: _debugState
  };
})();
