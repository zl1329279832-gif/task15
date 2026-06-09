/**
 * Trend - 趋势曲线模块
 *
 * 环形缓冲区存储历史数据，Canvas 绘制迷你趋势图
 * 所有数据来自 Engine 快照，不直接读取仿真状态
 */
var Trend = (function () {
  'use strict';

  var MAX_SAMPLES = 300;     // 5 分钟 @ 1 Hz
  var PUSH_INTERVAL = 10;    // 每 10 个 tick 推送一次 (1 Hz)
  var PREDICT_SAMPLES = 60;  // 预测 60 个采样点
  var _buffer = [];
  var _predictions = null;    // 预测数据
  var _pushCounter = 0;
  var _canvas = null;
  var _ctx = null;
  var _W = 0, _H = 0;
  var _strategyVersion = -1;  // 当前缓冲区对应的策略版本号

  // 三条曲线配置
  var SERIES = [
    {key: 'tankLevel',  label: '\u6db2\u4f4d%',   color: '#4488ff', min: 0, max: 100, scale: 100},
    {key: 'totalFlow',  label: '\u6d41\u91cf',     color: '#00ff88', min: 0, max: 800, scale: 1},
    {key: 'totalPower', label: '\u529f\u7387',     color: '#aa66ff', min: 0, max: 300, scale: 1}
  ];

  function init(canvasEl) {
    _canvas = canvasEl;
    if (!_canvas) return;
    _ctx = _canvas.getContext('2d', {alpha: false});
    _resize();
  }

  function _resize() {
    if (!_canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    _W = _canvas.clientWidth || 280;
    _H = _canvas.clientHeight || 120;
    _canvas.width = Math.round(_W * dpr);
    _canvas.height = Math.round(_H * dpr);
    _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 从快照推送数据 (每 tick 调用，内部节流)
   */
  function pushFromSnapshot(snap) {
    _pushCounter++;
    if (_pushCounter < PUSH_INTERVAL) return;
    _pushCounter = 0;

    _buffer.push({
      t: snap.simTime,
      tankLevel: snap.tankLevel,
      totalFlow: snap.totalFlow,
      totalPower: snap.totalPower
    });

    if (_buffer.length > MAX_SAMPLES) {
      _buffer.shift();
    }
  }

  /**
   * 设置预测数据
   */
  function setPredictions(pred) {
    _predictions = pred;
  }

  /**
   * 绘制趋势图 (含预测曲线)
   */
  function draw() {
    if (!_ctx || !_canvas) return;

    var W = _W, H = _H;
    var padL = 36, padR = 6, padT = 14, padB = 18;
    var hasPrediction = _predictions && _predictions.tankLevel && _predictions.tankLevel.length > 0;
    var predZoneW = hasPrediction ? Math.round(W * 0.22) : 0;
    var plotW = W - padL - padR - predZoneW;
    var plotH = H - padT - padB;

    // 背景
    _ctx.fillStyle = '#0a0e1a';
    _ctx.fillRect(0, 0, W, H);

    // 边框
    _ctx.strokeStyle = '#1a2456';
    _ctx.lineWidth = 1;
    _ctx.strokeRect(padL, padT, plotW, plotH);

    // 预测区域背景
    if (hasPrediction) {
      _ctx.fillStyle = 'rgba(20,30,60,0.5)';
      _ctx.fillRect(padL + plotW, padT, predZoneW, plotH);
      _ctx.strokeStyle = 'rgba(100,150,200,0.2)';
      _ctx.strokeRect(padL + plotW, padT, predZoneW, plotH);
    }

    // 网格线
    _ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    _ctx.lineWidth = 0.5;
    for (var g = 1; g < 4; g++) {
      var gy = padT + plotH * g / 4;
      _ctx.beginPath();
      _ctx.moveTo(padL, gy);
      _ctx.lineTo(padL + plotW + predZoneW, gy);
      _ctx.stroke();
    }

    // 标题
    _ctx.fillStyle = '#5a7a8a';
    _ctx.font = '10px sans-serif';
    _ctx.textAlign = 'left';
    _ctx.fillText('\u8d8b\u52bf\u66f2\u7ebf' + (hasPrediction ? ' + \u9884\u6d4b' : ''), padL, 10);

    if (_buffer.length < 2) {
      _ctx.fillStyle = '#3a4a5a';
      _ctx.font = '11px sans-serif';
      _ctx.textAlign = 'center';
      _ctx.fillText('\u7b49\u5f85\u6570\u636e...', W / 2, H / 2);
      return;
    }

    var n = _buffer.length;

    // 绘制历史曲线
    for (var s = 0; s < SERIES.length; s++) {
      var sr = SERIES[s];
      _ctx.strokeStyle = sr.color;
      _ctx.lineWidth = 1.5;
      _ctx.setLineDash([]);
      _ctx.beginPath();

      var lastX = 0, lastY = 0;
      for (var i = 0; i < n; i++) {
        var val = _buffer[i][sr.key];
        var scaled = val * sr.scale;
        var ratio = _clamp((scaled - sr.min) / (sr.max - sr.min), 0, 1);
        var x = padL + (i / (MAX_SAMPLES - 1)) * plotW;
        var y = padT + plotH * (1 - ratio);
        if (i === 0) _ctx.moveTo(x, y);
        else _ctx.lineTo(x, y);
        lastX = x; lastY = y;
      }
      _ctx.stroke();

      // 绘制预测曲线 (虚线)
      if (hasPrediction && _predictions[sr.key]) {
        var predArr = _predictions[sr.key];
        _ctx.strokeStyle = sr.color;
        _ctx.lineWidth = 1.2;
        _ctx.setLineDash([4, 3]);
        _ctx.globalAlpha = 0.7;
        _ctx.beginPath();
        _ctx.moveTo(lastX, lastY);

        for (var pi = 0; pi < predArr.length; pi++) {
          var pVal = predArr[pi].value;
          var pRatio = _clamp((pVal - sr.min) / (sr.max - sr.min), 0, 1);
          var px = padL + plotW + (pi / (PREDICT_SAMPLES - 1)) * predZoneW;
          var py = padT + plotH * (1 - pRatio);
          _ctx.lineTo(px, py);
        }
        _ctx.stroke();
        _ctx.globalAlpha = 1;
        _ctx.setLineDash([]);
      }
    }

    // "现在"分割线
    if (hasPrediction) {
      _ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      _ctx.lineWidth = 1;
      _ctx.setLineDash([3, 2]);
      _ctx.beginPath();
      _ctx.moveTo(padL + plotW, padT);
      _ctx.lineTo(padL + plotW, padT + plotH);
      _ctx.stroke();
      _ctx.setLineDash([]);
      // "now" 标签
      _ctx.fillStyle = 'rgba(255,255,255,0.4)';
      _ctx.font = '8px sans-serif';
      _ctx.textAlign = 'center';
      _ctx.fillText('now', padL + plotW, padT - 2);
    }

    // 图例
    var legX = padL + 4;
    var legY = padT + 10;
    for (var l = 0; l < SERIES.length; l++) {
      var sl = SERIES[l];
      _ctx.fillStyle = sl.color;
      _ctx.fillRect(legX, legY + l * 12, 8, 3);
      _ctx.fillStyle = '#8899aa';
      _ctx.font = '9px sans-serif';
      _ctx.textAlign = 'left';

      var lastVal = _buffer[n - 1][sl.key] * sl.scale;
      var valStr = sl.key === 'tankLevel' ? lastVal.toFixed(0) + '%' :
                   lastVal.toFixed(0);
      _ctx.fillText(sl.label + ' ' + valStr, legX + 12, legY + l * 12 + 4);
    }

    // X 轴时间标签
    _ctx.fillStyle = '#5a6a7a';
    _ctx.font = '9px monospace';
    _ctx.textAlign = 'left';
    _ctx.fillText('-5min', padL, H - 3);
    _ctx.textAlign = 'right';
    _ctx.fillText(hasPrediction ? '+1min' : 'now', padL + plotW + predZoneW, H - 3);
    if (hasPrediction) {
      _ctx.textAlign = 'center';
      _ctx.fillText('now', padL + plotW, H - 3);
    }
  }

  function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /**
   * 仅清除预测曲线数据，保留历史缓冲区。
   * 策略切换时调用 — 旧策略的预测曲线不再有效，但历史数据仍有参考价值。
   */
  function clearPredictions() {
    _predictions = null;
  }

  /**
   * 完全重置缓冲区（历史 + 预测）。
   * 用于数据版本不兼容或需要彻底清理的场景。
   * @param {number} [newVersion] - 新的策略版本号
   */
  function resetBuffer(newVersion) {
    _buffer = [];
    _predictions = null;
    _pushCounter = 0;
    if (newVersion !== undefined) _strategyVersion = newVersion;
  }

  /**
   * 更新策略版本号
   */
  function setStrategyVersion(v) {
    _strategyVersion = v;
  }

  /**
   * 获取当前缓冲区对应的策略版本号
   */
  function getStrategyVersion() {
    return _strategyVersion;
  }

  /**
   * 重置
   */
  function reset() {
    _buffer = [];
    _predictions = null;
    _pushCounter = 0;
    _strategyVersion = -1;
  }

  /**
   * 获取缓冲区长度
   */
  function getLength() {
    return _buffer.length;
  }

  return {
    init: init,
    pushFromSnapshot: pushFromSnapshot,
    setPredictions: setPredictions,
    clearPredictions: clearPredictions,
    resetBuffer: resetBuffer,
    setStrategyVersion: setStrategyVersion,
    getStrategyVersion: getStrategyVersion,
    draw: draw,
    reset: reset,
    resize: _resize,
    getLength: getLength
  };
})();
