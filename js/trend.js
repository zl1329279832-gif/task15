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
  var _buffer = [];
  var _pushCounter = 0;
  var _canvas = null;
  var _ctx = null;
  var _W = 0, _H = 0;

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
   * 绘制趋势图
   */
  function draw() {
    if (!_ctx || !_canvas) return;

    var W = _W, H = _H;
    var padL = 36, padR = 6, padT = 14, padB = 18;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    // 背景
    _ctx.fillStyle = '#0a0e1a';
    _ctx.fillRect(0, 0, W, H);

    // 边框
    _ctx.strokeStyle = '#1a2456';
    _ctx.lineWidth = 1;
    _ctx.strokeRect(padL, padT, plotW, plotH);

    // 网格线
    _ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    _ctx.lineWidth = 0.5;
    for (var g = 1; g < 4; g++) {
      var gy = padT + plotH * g / 4;
      _ctx.beginPath();
      _ctx.moveTo(padL, gy);
      _ctx.lineTo(padL + plotW, gy);
      _ctx.stroke();
    }

    // 标题
    _ctx.fillStyle = '#5a7a8a';
    _ctx.font = '10px sans-serif';
    _ctx.textAlign = 'left';
    _ctx.fillText('\u8d8b\u52bf\u66f2\u7ebf', padL, 10);

    if (_buffer.length < 2) {
      _ctx.fillStyle = '#3a4a5a';
      _ctx.font = '11px sans-serif';
      _ctx.textAlign = 'center';
      _ctx.fillText('\u7b49\u5f85\u6570\u636e...', W / 2, H / 2);
      return;
    }

    var n = _buffer.length;

    // 绘制每条曲线
    for (var s = 0; s < SERIES.length; s++) {
      var sr = SERIES[s];
      _ctx.strokeStyle = sr.color;
      _ctx.lineWidth = 1.5;
      _ctx.beginPath();

      for (var i = 0; i < n; i++) {
        var val = _buffer[i][sr.key];
        var scaled = val * sr.scale;
        var ratio = _clamp((scaled - sr.min) / (sr.max - sr.min), 0, 1);
        var x = padL + (i / (MAX_SAMPLES - 1)) * plotW;
        var y = padT + plotH * (1 - ratio);
        if (i === 0) _ctx.moveTo(x, y);
        else _ctx.lineTo(x, y);
      }
      _ctx.stroke();
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
    _ctx.fillText('now', padL + plotW, H - 3);
  }

  function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /**
   * 重置
   */
  function reset() {
    _buffer = [];
    _pushCounter = 0;
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
    draw: draw,
    reset: reset,
    resize: _resize,
    getLength: getLength
  };
})();
