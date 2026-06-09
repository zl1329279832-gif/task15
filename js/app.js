/**
 * App - 智慧泵站控制器
 *
 * 职责:
 * 1. 模式状态机 (Auto/Manual/Pause/Resume/Reset)
 * 2. 定时器生命周期管理 (所有 setInterval ID 必须存储和清除)
 * 3. 从 Engine 快照统一更新 Renderer + DOM + Trend
 * 4. 用户输入路由
 */
var App = (function () {
  'use strict';

  /* ========== 定时器 ID (全部存储，修复泄漏) ========== */
  var _clockTimer = null;
  var _fpsTimer = null;
  var _resizeTimer = null;
  var _trendDrawTimer = null;
  var _predictUpdateTimer = null;
  var _strategySwitchTimer = null;  // 策略切换防抖定时器

  /* ========== 状态 ========== */
  var _latestSnap = null;
  var _selectedEqId = null;
  var _lastStrategyVersion = -1;    // 上一次已知的策略版本号

  var STATE_BG = {
    running: 'rgba(0,255,136,0.12)', stopped: 'rgba(102,119,136,0.10)',
    fault: 'rgba(255,68,85,0.12)', maintenance: 'rgba(255,170,0,0.12)',
    offline: 'rgba(85,102,119,0.10)'
  };

  /* ========== DOM 缓存 ========== */
  var dom = {};

  function _cacheDom() {
    dom.canvas = document.getElementById('scene');
    dom.panelContent = document.getElementById('panelContent');
    dom.alarmList = document.getElementById('alarmList');
    dom.headerTime = document.getElementById('headerTime');
    dom.statTotal = document.getElementById('statTotal');
    dom.statRunning = document.getElementById('statRunning');
    dom.statAlarm = document.getElementById('statAlarm');
    dom.statFPS = document.getElementById('statFPS');
    dom.modeLabel = document.getElementById('modeLabel');
    dom.modeBar = document.getElementById('modeBar');
    dom.faultBar = document.getElementById('faultBar');
    dom.manualPanel = document.getElementById('manualPanel');
    dom.trendCanvas = document.getElementById('trendCanvas');
    dom.sceneLabel = document.getElementById('sceneLabel');
    dom.strategyBar = document.getElementById('strategyBar');
    dom.predictContent = document.getElementById('predictContent');
    dom.dispatchContent = document.getElementById('dispatchContent');
    dom.compareContent = document.getElementById('compareContent');
    dom.riskOverlayToggle = document.getElementById('riskOverlayToggle');
  }

  /* ========== 初始化 ========== */
  function _init() {
    _cacheDom();

    // 初始化渲染器
    Renderer.init(dom.canvas);
    Renderer.start();

    // 初始化趋势图
    Trend.init(dom.trendCanvas);

    // 注册引擎回调
    Engine.onTick(_onEngineTick);

    // 绑定事件
    _bindEvents();

    // 启动时钟 (存储 ID)
    _startClock();

    // 启动 FPS 显示 (存储 ID)
    _startFpsDisplay();

    // 启动趋势绘制
    _startTrendDraw();

    // 启动预测面板定期更新
    _startPredictUpdate();

    // 产生初始快照
    _latestSnap = Engine.getSnapshot();
    _updateAll(_latestSnap);

    // 更新手动控制面板
    _updateManualPanel();
  }

  /* ========== 定时器生命周期 (全部守卫) ========== */
  function _startClock() {
    if (_clockTimer) clearInterval(_clockTimer);
    _updateClock();
    _clockTimer = setInterval(_updateClock, 1000);
  }
  function _stopClock() {
    if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
  }

  function _startFpsDisplay() {
    if (_fpsTimer) clearInterval(_fpsTimer);
    _fpsTimer = setInterval(function () {
      dom.statFPS.textContent = Renderer.getFPS();
    }, 1000);
  }
  function _stopFpsDisplay() {
    if (_fpsTimer) { clearInterval(_fpsTimer); _fpsTimer = null; }
  }

  function _startTrendDraw() {
    if (_trendDrawTimer) clearInterval(_trendDrawTimer);
    _trendDrawTimer = setInterval(function () {
      Trend.draw();
    }, 200); // 5 FPS for trend chart
  }
  function _stopTrendDraw() {
    if (_trendDrawTimer) { clearInterval(_trendDrawTimer); _trendDrawTimer = null; }
  }

  function _startPredictUpdate() {
    if (_predictUpdateTimer) clearInterval(_predictUpdateTimer);
    _predictUpdateTimer = setInterval(function () {
      _updatePredictPanel();
      _updateDispatchPanel();
      _updateComparePanel();
    }, 500); // 2 FPS for prediction panels
  }
  function _stopPredictUpdate() {
    if (_predictUpdateTimer) { clearInterval(_predictUpdateTimer); _predictUpdateTimer = null; }
  }

  function _updateClock() {
    var n = new Date(), p = function (v) { return v < 10 ? '0' + v : '' + v; };
    dom.headerTime.textContent = n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate())
      + ' ' + p(n.getHours()) + ':' + p(n.getMinutes()) + ':' + p(n.getSeconds());
  }

  /* ========== 事件绑定 ========== */
  function _bindEvents() {
    // Canvas 点击
    dom.canvas.addEventListener('click', _onCanvasClick, false);
    dom.canvas.addEventListener('mousemove', _onCanvasMove, false);

    // 模式按钮
    var modeBtns = dom.modeBar.querySelectorAll('.mode-btn');
    for (var i = 0; i < modeBtns.length; i++) {
      modeBtns[i].addEventListener('click', _onModeBtnClick, false);
    }

    // 故障注入按钮
    var faultBtns = dom.faultBar.querySelectorAll('.fault-btn');
    for (var f = 0; f < faultBtns.length; f++) {
      faultBtns[f].addEventListener('click', _onFaultBtnClick, false);
    }

    // 报警确认 (事件委托)
    dom.alarmList.addEventListener('click', _onAlarmClick, false);

    // 手动控制 (事件委托)
    dom.manualPanel.addEventListener('click', _onManualClick, false);

    // 策略选择 (事件委托)
    dom.strategyBar.addEventListener('click', _onStrategyClick, false);

    // 风险热区开关
    dom.riskOverlayToggle.addEventListener('change', function () {
      Renderer.setShowRiskOverlay(dom.riskOverlayToggle.checked);
    }, false);

    // 窗口 resize
    window.addEventListener('resize', function () {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function () {
        Renderer.resize();
        Trend.resize();
      }, 200);
    }, false);
  }

  /* ========== 模式按钮处理 ========== */
  function _onModeBtnClick(e) {
    var btn = e.currentTarget;
    var action = btn.getAttribute('data-action');
    if (!action) return;

    var result = false;
    switch (action) {
      case 'auto':   result = Engine.setMode('auto'); break;
      case 'manual': result = Engine.setMode('manual'); break;
      case 'pause':  result = Engine.setMode('pause'); break;
      case 'resume': result = Engine.setMode('resume'); break;
      case 'reset':  result = _doReset(); break;
    }
    if (result) {
      _updateModeUI();
      _updateManualPanel();
    }
  }

  function _doReset() {
    // 清除策略切换防抖定时器 — 避免重置后仍然执行延迟的失效操作
    if (_strategySwitchTimer) {
      clearTimeout(_strategySwitchTimer);
      _strategySwitchTimer = null;
    }
    _lastStrategyVersion = -1;

    Engine.reset();
    Trend.reset();
    Predictor.reset();
    Strategy.reset();
    _selectedEqId = null;
    Renderer.setSelected(null);
    Renderer.clearRiskData();
    dom.panelContent.innerHTML = '<div class="panel-placeholder">\u70b9\u51fb\u753b\u5e03\u4e2d\u7684\u8bbe\u5907\u67e5\u770b\u8be6\u60c5</div>';
    dom.predictContent.innerHTML = '<div class="panel-placeholder">\u542f\u52a8\u4eff\u771f\u540e\u663e\u793a\u5206\u6790\u6570\u636e</div>';
    dom.dispatchContent.innerHTML = '<div class="panel-placeholder">\u9009\u62e9\u7b56\u7565\u540e\u663e\u793a\u5efa\u8bae</div>';
    dom.compareContent.innerHTML = '<div class="panel-placeholder">\u5207\u6362\u7b56\u7565\u540e\u663e\u793a\u5bf9\u6bd4\u6570\u636e</div>';
    // 重置策略按钮
    var stratBtns = dom.strategyBar.querySelectorAll('.strategy-btn');
    for (var i = 0; i < stratBtns.length; i++) {
      stratBtns[i].classList.remove('active');
      if (stratBtns[i].getAttribute('data-strategy') === 'safety') {
        stratBtns[i].classList.add('active');
      }
    }
    _updateModeUI();
    _updateManualPanel();
    return true;
  }

  function _updateModeUI() {
    var mode = Engine.getMode();
    var labelMap = {
      idle: '\u5f85\u673a', auto: '\u81ea\u52a8\u8fd0\u884c',
      manual: '\u624b\u52a8\u63a7\u5236', paused: '\u5df2\u6682\u505c'
    };
    dom.modeLabel.textContent = labelMap[mode] || mode;

    // 更新按钮高亮
    var btns = dom.modeBar.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.remove('active');
      var act = btns[i].getAttribute('data-action');
      if (act === mode || (mode === 'paused' && act === 'pause')) {
        btns[i].classList.add('active');
      }
    }

    // 暂停时冻结渲染器动画
    Renderer.setPaused(mode === 'paused');

    // 场景标签
    dom.sceneLabel.textContent = '\u5f53\u524d\u6a21\u5f0f\uff1a' + (labelMap[mode] || mode);
  }

  /* ========== 故障注入 ========== */
  function _onFaultBtnClick(e) {
    var btn = e.currentTarget;
    var type = btn.getAttribute('data-fault');
    if (!type) return;
    Engine.injectFault(type);
    btn.disabled = true;
    btn.classList.add('injected');
  }

  /* ========== 报警点击 ========== */
  function _onAlarmClick(e) {
    var target = e.target;
    if (target.classList.contains('alarm-ack-btn')) {
      var key = target.getAttribute('data-key');
      if (key) Engine.acknowledgeAlarm(key);
    }
  }

  /* ========== 手动控制点击 ========== */
  function _onManualClick(e) {
    var target = e.target;
    if (target.classList.contains('manual-toggle-btn')) {
      var eqId = target.getAttribute('data-eq');
      var newState = target.getAttribute('data-state');
      if (eqId && newState) {
        Engine.manualOverride(eqId, newState);
      }
    }
  }

  function _updateManualPanel() {
    var mode = Engine.getMode();
    if (mode !== 'manual') {
      dom.manualPanel.style.display = 'none';
      return;
    }
    dom.manualPanel.style.display = 'block';

    var html = '<div class="manual-title">\u624b\u52a8\u63a7\u5236\u9762\u677f</div>';
    var controllable = [
      {id: 'pump1', name: '1#\u6c34\u6cf5'},
      {id: 'pump2', name: '2#\u6c34\u6cf5'},
      {id: 'pump3', name: '3#\u6c34\u6cf5'},
      {id: 'v_inlet', name: '\u8fdb\u6c34\u9600'},
      {id: 'v_outlet', name: '\u51fa\u6c34\u9600'},
      {id: 'v1', name: '1#\u6cf5\u524d\u9600'},
      {id: 'v2', name: '2#\u6cf5\u524d\u9600'},
      {id: 'v3', name: '3#\u6cf5\u524d\u9600'}
    ];

    for (var i = 0; i < controllable.length; i++) {
      var c = controllable[i];
      var snap = _latestSnap;
      var st = 'stopped';
      if (snap) {
        for (var j = 0; j < snap.equipment.length; j++) {
          if (snap.equipment[j].id === c.id) { st = snap.equipment[j].state; break; }
        }
      }
      var isRunning = st === 'running';
      var toggleState = isRunning ? 'stopped' : 'running';
      var toggleLabel = isRunning ? '\u505c\u6b62' : '\u542f\u52a8';
      var toggleClass = isRunning ? 'btn-stop' : 'btn-start';
      html += '<div class="manual-row">';
      html += '<span class="manual-name">' + c.name + '</span>';
      html += '<span class="manual-state ' + st + '">' + (DataModule.STATE_LABELS[st] || st) + '</span>';
      html += '<button class="manual-toggle-btn ' + toggleClass + '" data-eq="' + c.id + '" data-state="' + toggleState + '">' + toggleLabel + '</button>';
      html += '</div>';
    }
    dom.manualPanel.innerHTML = html;
  }

  /* ========== Canvas 交互 ========== */
  function _onCanvasClick(e) {
    var rect = dom.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    var hitId = Renderer.hitTest(x, y);
    if (hitId) _selectEquipment(hitId);
    else _deselectEquipment();
  }

  function _onCanvasMove(e) {
    var rect = dom.canvas.getBoundingClientRect();
    var x = e.clientX - rect.left, y = e.clientY - rect.top;
    var hitId = Renderer.hitTest(x, y);
    dom.canvas.style.cursor = hitId ? 'pointer' : 'default';
  }

  function _selectEquipment(id) {
    _selectedEqId = id;
    Renderer.setSelected(id);
    _showEquipmentPanel(id);
  }

  function _deselectEquipment() {
    _selectedEqId = null;
    Renderer.setSelected(null);
    dom.panelContent.innerHTML = '<div class="panel-placeholder">\u70b9\u51fb\u753b\u5e03\u4e2d\u7684\u8bbe\u5907\u67e5\u770b\u8be6\u60c5</div>';
  }

  /* ========== 设备面板 ========== */
  function _showEquipmentPanel(id) {
    if (!_latestSnap) return;
    var eq = null;
    for (var i = 0; i < _latestSnap.equipment.length; i++) {
      if (_latestSnap.equipment[i].id === id) { eq = _latestSnap.equipment[i]; break; }
    }
    if (!eq) return;

    var stateLabel = DataModule.STATE_LABELS[eq.state] || eq.state;
    var icons = {
      pump: '\u2699', valve: '\u2638', sensor: '\u26a1',
      tank: '\u26c6', cabinet: '\u26a0', alarm_light: '\u26a0'
    };

    var html = '<div class="eq-header"><div class="eq-icon" style="background:'
      + (STATE_BG[eq.state] || '#111') + '">' + (icons[eq.type] || '\u2699')
      + '</div><div><div class="eq-name">' + eq.name + '</div><span class="eq-state '
      + eq.state + '">' + stateLabel + '</span></div></div>';

    var fields = [
      {key: 'flow', label: '\u6d41\u91cf', icon: '\u2248', color: '#00d4ff', max: 320, unit: 'm\u00b3/h', dec: 0},
      {key: 'pressure', label: '\u538b\u529b', icon: '\u25ce', color: '#00ff88', max: 0.65, unit: 'MPa', dec: 2},
      {key: 'temp', label: '\u6e29\u5ea6', icon: '\u2600', color: '#ffaa00', max: 95, unit: '\u00b0C', dec: 1},
      {key: 'power', label: '\u80fd\u8017', icon: '\u26a1', color: '#aa66ff', max: 120, unit: 'kW', dec: 1},
      {key: 'runtime', label: '\u8fd0\u884c\u65f6\u957f', icon: '\u23f1', color: '#88aacc', max: 9999, unit: 'h', dec: 0}
    ];

    // 特殊处理水池
    if (eq.type === 'tank') {
      fields = [{
        key: 'level', label: '\u6db2\u4f4d', icon: '\u25a6', color: '#4488ff',
        max: 100, unit: '%', dec: 1
      }];
      eq.level = _latestSnap.tankLevel * 100;
    }

    html += '<div class="data-grid">';
    for (var f = 0; f < fields.length; f++) {
      var field = fields[f];
      var val = eq[field.key];
      if (val === undefined || val === null) continue;
      var valStr = field.dec > 0 ? val.toFixed(field.dec) : Math.round(val);
      var barPct = Math.min(100, Math.round(val / (field.max * 1.2) * 100));
      html += '<div class="data-item"><div class="data-label">' + field.icon + ' ' + field.label + '</div>';
      html += '<div class="data-value" style="color:' + field.color + '">' + valStr + '<span class="data-unit">' + field.unit + '</span></div>';
      html += '<div class="data-bar"><div class="data-bar-fill" style="width:' + barPct + '%;background:' + field.color + '"></div></div></div>';
    }

    // 能耗总览
    if (eq.type === 'cabinet') {
      html += '<div class="data-item"><div class="data-label">\u26a1 \u7d2f\u8ba1\u80fd\u8017</div>';
      html += '<div class="data-value" style="color:#aa66ff">' + _latestSnap.energyKWh.toFixed(2) + '<span class="data-unit">kWh</span></div></div>';
      html += '<div class="data-item"><div class="data-label">\u2211 \u603b\u529f\u7387</div>';
      html += '<div class="data-value" style="color:#aa66ff">' + _latestSnap.totalPower.toFixed(1) + '<span class="data-unit">kW</span></div></div>';
    }

    html += '</div>';
    dom.panelContent.innerHTML = html;
  }

  /* ========== 策略切换 ========== */
  function _onStrategyClick(e) {
    var btn = e.target;
    if (!btn.classList.contains('strategy-btn')) return;
    var stratId = btn.getAttribute('data-strategy');
    if (!stratId) return;

    var result = Strategy.switchStrategy(stratId, _latestSnap);
    if (result) {
      // 更新按钮高亮
      var btns = dom.strategyBar.querySelectorAll('.strategy-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.remove('active');
        if (btns[i].getAttribute('data-strategy') === stratId) {
          btns[i].classList.add('active');
        }
      }

      // ===== 数据版本与缓存失效管线 =====
      // 策略切换必须使下游模块的缓存全部失效，防止热区、趋势、建议互相矛盾
      _invalidateOnStrategySwitch();
    }
  }

  /**
   * 策略切换后的缓存失效管线。
   * 清除 Predictor 的旧风险评分/预测/建议，
   * 清除 Trend 的旧预测曲线，
   * 清除 Renderer 的旧风险热区，
   * 然后立即触发一轮重算（不等待下一个 tick）。
   *
   * 快速切换时使用防抖：如果在上一次切换的失效操作尚未完成时又发生切换，
   * 只保留最新一次切换的失效操作，避免重复计算。
   */
  function _invalidateOnStrategySwitch() {
    // 防抖：清除上一次尚未执行的失效操作
    if (_strategySwitchTimer) {
      clearTimeout(_strategySwitchTimer);
      _strategySwitchTimer = null;
    }

    var newVersion = Strategy.getVersion();
    _lastStrategyVersion = newVersion;

    // 1. Predictor: 清除旧策略下的风险评分、预测曲线、调度建议、压力历史
    Predictor.invalidateCache(newVersion);

    // 2. Trend: 清除旧策略下的预测曲线 (保留历史缓冲区)
    Trend.clearPredictions();
    Trend.setStrategyVersion(newVersion);

    // 3. Renderer: 清除旧策略下的风险热区覆盖
    Renderer.clearRiskData();

    // 4. 防抖后强制立即重算 — 等 50ms 让 Engine 至少产生一个新快照
    _strategySwitchTimer = setTimeout(function () {
      _strategySwitchTimer = null;
      _forceRecalculate();
    }, 50);
  }

  /**
   * 强制立即执行一轮完整的重算和 UI 更新。
   * 不依赖 Engine tick 定时器，直接从最新快照驱动所有下游模块。
   */
  function _forceRecalculate() {
    var snap = Engine.getSnapshot();
    if (!snap) return;
    _latestSnap = snap;

    var version = Strategy.getVersion();

    // Predictor 重算 — 传入策略版本号
    Predictor.pushSnapshot(snap, version);

    // Strategy 指标更新
    Strategy.updateMetrics(snap);

    // Renderer 风险热区更新 — 传入版本号
    Renderer.setRiskData(Predictor.getRiskScores(), version);

    // Trend 预测曲线更新
    var preds = Predictor.getPredictions();
    Trend.setPredictions(preds);

    // 立即刷新预测/调度/对比面板
    _updatePredictPanel();
    _updateDispatchPanel();
    _updateComparePanel();
  }

  /* ========== 预测面板更新 ========== */
  function _updatePredictPanel() {
    var risks = Predictor.getRiskScores();
    var keys = Object.keys(risks);
    var stats = Predictor.getStats();
    var energyTrend = Predictor.getEnergyTrend();

    if (keys.length === 0 && stats.historyLength < 10) {
      dom.predictContent.innerHTML = '<div class="panel-placeholder">\u7b49\u5f85\u5206\u6790\u6570\u636e\u79ef\u7d2f...</div>';
      return;
    }

    var html = '';

    // 能耗趋势条
    html += '<div class="energy-trend-bar">';
    html += '<div class="energy-trend-icon">\u26a1</div>';
    html += '<div class="energy-trend-info">';
    html += '<div class="energy-trend-label">\u5b9e\u65f6\u529f\u7387 / \u80fd\u8017\u8d8b\u52bf</div>';
    html += '<div class="energy-trend-value">' + energyTrend.last.toFixed(1) + '<span class="data-unit">kW</span>';
    if (Math.abs(energyTrend.trend) > 0.1) {
      var trendClass = energyTrend.trend > 0 ? 'up' : 'down';
      var trendIcon = energyTrend.trend > 0 ? '\u2191' : '\u2193';
      html += '<span class="energy-trend-trend ' + trendClass + '">' + trendIcon + Math.abs(energyTrend.trend).toFixed(2) + '</span>';
    }
    html += '</div></div></div>';

    // 启停统计
    var sc = stats.startStopCount;
    html += '<div class="energy-trend-bar" style="margin-bottom:4px">';
    html += '<div class="energy-trend-icon">\u21bb</div>';
    html += '<div class="energy-trend-info">';
    html += '<div class="energy-trend-label">\u542f\u505c\u6b21\u6570 (2min)</div>';
    html += '<div style="font-size:12px;font-family:var(--mono);color:var(--text)">';
    html += '1#: ' + sc.pump1 + '  2#: ' + sc.pump2 + '  3#: ' + sc.pump3;
    html += '</div></div></div>';

    // 风险列表
    if (keys.length > 0) {
      // 按风险分排序
      var sorted = [];
      for (var i = 0; i < keys.length; i++) {
        sorted.push({id: keys[i], data: risks[keys[i]]});
      }
      sorted.sort(function (a, b) { return b.data.score - a.data.score; });

      for (var s = 0; s < sorted.length; s++) {
        var item = sorted[s];
        var score = item.data.score;
        var level = score >= 70 ? 'high' : (score >= 45 ? 'medium' : 'low');
        var typeName = {
          freq: '\u542f\u505c', blockage: '\u5835\u585e', idle: '\u7a7a\u8f6c',
          efficiency: '\u6548\u7387', valve: '\u9600\u95e8', overflow: '\u6ee1\u6ea2',
          dry: '\u5e72\u6d9d', overheat: '\u8fc7\u70ed', energy: '\u80fd\u8017'
        }[item.data.type] || item.data.type;

        html += '<div class="risk-item ' + level + '">';
        html += '<span class="risk-score">' + score.toFixed(0) + '%</span>';
        html += '<span class="risk-label">' + item.data.label + '</span>';
        html += '<span class="risk-type-badge">' + typeName + '</span>';
        html += '</div>';
      }
    } else {
      html += '<div style="text-align:center;color:var(--green);font-size:12px;padding:10px">\u2713 \u65e0\u660e\u663e\u98ce\u9669</div>';
    }

    dom.predictContent.innerHTML = html;
  }

  /* ========== 调度建议面板 ========== */
  function _updateDispatchPanel() {
    if (!_latestSnap) return;
    var advice = Strategy.getDispatchAdvice(_latestSnap);
    if (!advice || advice.length === 0) {
      dom.dispatchContent.innerHTML = '<div class="panel-placeholder">\u6682\u65e0\u8c03\u5ea6\u5efa\u8bae</div>';
      return;
    }

    var html = '';
    var iconMap = {start: '\u25b6', stop: '\u25a0', info: '\u2139', warning: '\u26a0'};
    for (var i = 0; i < advice.length; i++) {
      var a = advice[i];
      html += '<div class="dispatch-item type-' + a.type + '">';
      html += '<span class="dispatch-icon">' + (iconMap[a.type] || '\u2139') + '</span>';
      html += '<span class="dispatch-text">' + a.reason + '</span>';
      html += '</div>';
    }

    // 当前策略信息
    var strat = Strategy.getStrategyConfig();
    html += '<div style="margin-top:8px;padding:6px;background:rgba(255,255,255,.03);border-radius:4px;font-size:10px;color:var(--text2)">';
    html += '\u5f53\u524d\u7b56\u7565: <span style="color:' + strat.color + ';font-weight:600">' + strat.name + '</span>';
    html += ' | \u76ee\u6807\u6db2\u4f4d: ' + (strat.targetLevelLow * 100).toFixed(0) + '%-' + (strat.targetLevelHigh * 100).toFixed(0) + '%';
    html += '</div>';

    dom.dispatchContent.innerHTML = html;
  }

  /* ========== 策略对比面板 ========== */
  function _updateComparePanel() {
    var comp = Strategy.getComparison();
    if (!comp) {
      dom.compareContent.innerHTML = '<div class="panel-placeholder">\u5207\u6362\u7b56\u7565\u540e\u663e\u793a\u5bf9\u6bd4\u6570\u636e</div>';
      return;
    }

    var html = '';
    html += '<div class="compare-header">';
    html += '<span class="compare-from" style="background:' + comp.fromColor + '22;color:' + comp.fromColor + '">' + comp.fromStrategy + '</span>';
    html += '<span class="compare-arrow">\u2192</span>';
    html += '<span class="compare-to" style="background:' + comp.toColor + '22;color:' + comp.toColor + '">' + comp.toStrategy + '</span>';
    html += '</div>';

    html += '<table class="compare-table">';
    html += '<tr><td>\u529f\u7387</td><td>' + comp.energy.powerBefore.toFixed(1) + ' kW</td><td>\u2192</td><td>' + comp.energy.powerAfter.toFixed(1) + ' kW</td></tr>';
    html += '<tr><td>\u7d2f\u8ba1\u80fd\u8017</td><td>' + comp.energy.before.toFixed(2) + '</td><td>\u2192</td><td>' + comp.energy.after.toFixed(2) + '</td></tr>';
    html += '<tr><td>\u544a\u8b66\u6570</td><td>' + comp.alarms.before + '</td><td>\u2192</td><td>' + comp.alarms.after + _deltaStr(comp.alarms.delta, true) + '</td></tr>';
    html += '<tr><td>\u5b89\u5168\u4f59\u91cf</td><td>' + comp.safetyMargin.before.toFixed(1) + '%</td><td>\u2192</td><td>' + comp.safetyMargin.after.toFixed(1) + '%' + _deltaStr(comp.safetyMargin.delta, false) + '</td></tr>';
    html += '<tr><td>\u6db2\u4f4d</td><td>' + comp.tankLevel.before.toFixed(0) + '%</td><td>\u2192</td><td>' + comp.tankLevel.after.toFixed(0) + '%</td></tr>';
    html += '</table>';

    dom.compareContent.innerHTML = html;
  }

  function _deltaStr(delta, invertColor) {
    if (Math.abs(delta) < 0.01) return '';
    var isPositive = delta > 0;
    var cls = invertColor ? (isPositive ? 'negative' : 'positive') : (isPositive ? 'positive' : 'negative');
    return ' <span class="compare-delta ' + cls + '">(' + (delta > 0 ? '+' : '') + delta.toFixed(1) + ')</span>';
  }

  /* ========== 统一更新函数 (从同一帧快照) ========== */
  function _onEngineTick(snap) {
    _latestSnap = snap;
    _updateAll(snap);
  }

  function _updateAll(snap) {
    var stratVersion = Strategy.getVersion();

    // 1. Canvas 渲染器 — 从快照
    Renderer.updateFromSnapshot(snap);

    // 2. 趋势图 — 从快照
    Trend.pushFromSnapshot(snap);

    // 3. 预测分析 — 从快照 (传入策略版本号)
    Predictor.pushSnapshot(snap, stratVersion);

    // 4. 策略指标更新 — 从快照
    Strategy.updateMetrics(snap);

    // 5. 更新 Canvas 风险热区
    // invalidateCache 已在策略切换时清空旧数据；_analyze 重算后此处自动更新
    Renderer.setRiskData(Predictor.getRiskScores(), stratVersion);

    // 6. 更新趋势预测曲线
    // getPredictions 在策略版本变化且未重新分析前返回 null，安全地跳过
    var preds = Predictor.getPredictions();
    if (preds) Trend.setPredictions(preds);

    // 7. DOM 统计 — 从快照
    dom.statTotal.textContent = snap.totalEqCount;
    dom.statRunning.textContent = snap.runningCount;
    dom.statAlarm.textContent = snap.faultCount;

    // 8. 报警列表 — 从快照
    _updateAlarmList(snap);

    // 9. 设备面板 (如果选中了设备) — 从快照
    if (_selectedEqId) _showEquipmentPanel(_selectedEqId);

    // 10. 手动控制面板 (如果在手动模式) — 从快照
    if (snap.modeId === Engine.MODE.MANUAL) _updateManualPanel();
  }

  /* ========== 报警列表渲染 ========== */
  function _updateAlarmList(snap) {
    var alarms = snap.alarms;
    if (!alarms || alarms.length === 0) {
      dom.alarmList.innerHTML = '<li class="alarm-empty">\u6682\u65e0\u62a5\u8b66</li>';
      return;
    }
    var html = '';
    for (var i = 0; i < alarms.length; i++) {
      var a = alarms[i];
      html += '<li class="' + a.severity + (a.acked ? ' acked' : '') + '">';
      html += '<span class="alarm-time">' + a.time + '</span>';
      html += '<span class="alarm-text">' + a.text + '</span>';
      if (!a.acked) {
        html += '<button class="alarm-ack-btn" data-key="' + a.key + '" title="\u786e\u8ba4">\u2713</button>';
      }
      html += '</li>';
    }
    dom.alarmList.innerHTML = html;
  }

  /* ========== 初始化入口 ========== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  return {
    // 供 Verify 使用
    getLatestSnapshot: function () { return _latestSnap; },
    getLastStrategyVersion: function () { return _lastStrategyVersion; },
    doReset: _doReset
  };
})();
