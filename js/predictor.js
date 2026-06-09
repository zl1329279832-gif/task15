/**
 * Predictor - 预测性维护与故障风险分析引擎
 *
 * 功能:
 * 1. 持续计算泵组启停频率、压力波动、水位变化、流量异常和能耗趋势
 * 2. 识别空转、堵塞、阀门异常、泵效率下降等潜在故障
 * 3. 为每台设备生成风险评分 (0-100)
 * 4. 生成未来预测曲线 (液位/能耗/流量)
 * 5. 提供调度建议
 *
 * 数据来源: Engine 快照，不直接读取仿真状态
 * 纯 ES5，IIFE 模式，零依赖
 */
var Predictor = (function () {
  'use strict';

  /* ========== 配置 ========== */
  var HISTORY_SIZE = 120;       // 保留最近 120 个采样 (~2 min @ 1Hz)
  var PREDICT_HORIZON = 60;     // 预测未来 60 个采样点 (~1 min)
  var SAMPLE_INTERVAL = 10;     // 每 10 个 tick 采样一次 (1 Hz)

  /* ========== 内部状态 ========== */
  var _sampleCounter = 0;
  var _history = [];            // 环形缓冲: {t, tankLevel, totalFlow, totalPower, energyKWh, pumpStates:{}}
  var _prevPumpStates = {};     // 上一次各泵状态 (用于启停计数)
  var _pumpStartStopCount = {pump1: 0, pump2: 0, pump3: 0};
  var _pumpRunningTicks = {pump1: 0, pump2: 0, pump3: 0};
  var _pumpEnergyAccum = {pump1: 0, pump2: 0, pump3: 0};
  var _pumpFlowAccum = {pump1: 0, pump2: 0, pump3: 0};
  var _pressureHistory = {pump1: [], pump2: [], pump3: []};
  var _riskScores = {};         // {eqId: {score:0-100, type:'', label:''}}
  var _suggestions = [];        // 调度建议列表
  var _totalSimTime = 0;
  var _epoch = 0;               // 策略数据版本号

  /* ========== 工具函数 ========== */
  function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function _avg(arr) {
    if (!arr || arr.length === 0) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function _variance(arr) {
    if (!arr || arr.length < 2) return 0;
    var m = _avg(arr), s = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      s += d * d;
    }
    return s / arr.length;
  }

  function _linearRegression(arr) {
    if (!arr || arr.length < 2) return {slope: 0, intercept: arr ? (arr[0] || 0) : 0};
    var n = arr.length;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) {
      sx += i;
      sy += arr[i];
      sxy += i * arr[i];
      sxx += i * i;
    }
    var denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 0.001) return {slope: 0, intercept: sy / n};
    var slope = (n * sxy - sx * sy) / denom;
    var intercept = (sy - slope * sx) / n;
    return {slope: slope, intercept: intercept};
  }

  /* ========== 采样 ========== */
  function pushSnapshot(snap) {
    _sampleCounter++;
    if (_sampleCounter < SAMPLE_INTERVAL) return;
    _sampleCounter = 0;

    _totalSimTime = snap.simTime;

    // 提取泵状态
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    var pumpStates = {};
    for (var i = 0; i < snap.equipment.length; i++) {
      var eq = snap.equipment[i];
      if (eq.type === 'pump') {
        pumpStates[eq.id] = {
          state: eq.state,
          flow: eq.flow,
          pressure: eq.pressure,
          power: eq.power,
          temp: eq.temp,
          runtime: eq.runtime
        };
      }
    }

    // 启停频率检测
    for (var p = 0; p < pumpIds.length; p++) {
      var pid = pumpIds[p];
      var prevSt = _prevPumpStates[pid];
      var curSt = pumpStates[pid] ? pumpStates[pid].state : 'stopped';
      if (prevSt && prevSt !== curSt) {
        if ((prevSt === 'stopped' && curSt === 'running') ||
            (prevSt === 'running' && curSt === 'stopped')) {
          _pumpStartStopCount[pid]++;
        }
      }
      _prevPumpStates[pid] = curSt;

      // 累计运行 ticks 和能耗/流量
      if (pumpStates[pid] && pumpStates[pid].state === 'running') {
        _pumpRunningTicks[pid]++;
        _pumpEnergyAccum[pid] += pumpStates[pid].power;
        _pumpFlowAccum[pid] += pumpStates[pid].flow;
      }

      // 压力历史
      if (pumpStates[pid] && pumpStates[pid].state === 'running') {
        _pressureHistory[pid].push(pumpStates[pid].pressure);
        if (_pressureHistory[pid].length > 60) _pressureHistory[pid].shift();
      }
    }

    // 存入历史缓冲
    _history.push({
      t: snap.simTime,
      tankLevel: snap.tankLevel,
      totalFlow: snap.totalFlow,
      totalPower: snap.totalPower,
      energyKWh: snap.energyKWh,
      pumpStates: pumpStates
    });

    if (_history.length > HISTORY_SIZE) {
      _history.shift();
    }

    // 运行分析
    _analyze();
  }

  /* ========== 核心分析 ========== */
  function _analyze() {
    _riskScores = {};
    _suggestions = [];

    var pumpIds = ['pump1', 'pump2', 'pump3'];

    // 1. 启停频率风险
    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var count = _pumpStartStopCount[pid];
      // 2 分钟内超过 6 次启停视为高风险
      var freqScore = _clamp(count * 12, 0, 80);
      if (freqScore > 30) {
        _addRisk(pid, freqScore, 'freq', '启停频繁 (' + count + '次/2min)');
        _suggestions.push({
          priority: freqScore > 60 ? 'high' : 'medium',
          text: pid.replace('pump', '') + '#泵启停频繁，建议检查液位控制逻辑或扩大死区'
        });
      }
    }

    // 2. 压力波动风险 (堵塞检测)
    for (var p = 0; p < pumpIds.length; p++) {
      var ppid = pumpIds[p];
      var pHist = _pressureHistory[ppid];
      if (pHist.length >= 10) {
        var pVar = _variance(pHist);
        var pMean = _avg(pHist);
        var cvRatio = pMean > 0 ? Math.sqrt(pVar) / pMean : 0;
        // 变异系数 > 0.15 表示压力异常波动
        var pressScore = _clamp(cvRatio * 400, 0, 85);
        if (pressScore > 25) {
          _addRisk(ppid, pressScore, 'blockage', '压力波动异常 (CV=' + cvRatio.toFixed(3) + ')');
          _suggestions.push({
            priority: pressScore > 50 ? 'high' : 'medium',
            text: ppid.replace('pump', '') + '#泵压力波动大，可能存在管路堵塞或叶轮磨损'
          });
        }
      }
    }

    // 3. 空转检测 (泵运行但流量极低)
    if (_history.length > 5) {
      var latest = _history[_history.length - 1];
      for (var k = 0; k < pumpIds.length; k++) {
        var pk = pumpIds[k];
        var ps = latest.pumpStates[pk];
        if (ps && ps.state === 'running' && ps.flow < 30 && ps.power > 20) {
          _addRisk(pk, 75, 'idle', '疑似空转 (流量=' + ps.flow.toFixed(0) + ' m³/h)');
          _suggestions.push({
            priority: 'high',
            text: pk.replace('pump', '') + '#泵疑似空转，建议立即检查进水阀和管路'
          });
        }
      }
    }

    // 4. 泵效率下降检测 (功率/流量比)
    for (var e = 0; e < pumpIds.length; e++) {
      var pe = pumpIds[e];
      if (_pumpRunningTicks[pe] > 30) {
        var avgPower = _pumpEnergyAccum[pe] / _pumpRunningTicks[pe];
        var avgFlow = _pumpFlowAccum[pe] / _pumpRunningTicks[pe];
        if (avgFlow > 10) {
          var efficiencyRatio = avgPower / avgFlow; // kW/(m³/h)
          // 额定: 90kW/250m³h = 0.36, 超过 0.55 表示效率下降
          var effScore = _clamp((efficiencyRatio - 0.36) * 300, 0, 80);
          if (effScore > 30) {
            _addRisk(pe, effScore, 'efficiency', '泵效率下降 (比能耗=' + efficiencyRatio.toFixed(3) + ')');
            _suggestions.push({
              priority: effScore > 55 ? 'high' : 'low',
              text: pe.replace('pump', '') + '#泵效率下降，建议安排检修或更换叶轮'
            });
          }
        }
      }
    }

    // 5. 阀门异常检测 (阀门开但无流量 / 阀门关但有流量)
    if (_history.length > 10) {
      var recent = _history[_history.length - 1];
      var valveMap = {v1: 'pump1', v2: 'pump2', v3: 'pump3'};
      var valveIds = ['v1', 'v2', 'v3'];
      // 从快照中找阀门状态 - 需从最近快照的设备列表获取
      // 简化: 通过泵状态推断
      for (var v = 0; v < valveIds.length; v++) {
        var vid = valveIds[v];
        var assocPump = valveMap[vid];
        var aps = recent.pumpStates[assocPump];
        if (aps && aps.state === 'running' && aps.flow < 5) {
          _addRisk(vid, 65, 'valve', '阀门异常: 泵运行但流量极低');
          _suggestions.push({
            priority: 'medium',
            text: vid + '阀门可能卡死或堵塞，建议现场巡检'
          });
        }
      }
    }

    // 6. 液位变化趋势风险
    if (_history.length >= 20) {
      var levels = [];
      for (var l = _history.length - 20; l < _history.length; l++) {
        levels.push(_history[l].tankLevel);
      }
      var levelReg = _linearRegression(levels);
      // 液位快速上升
      if (levelReg.slope > 0.002) {
        var overflowScore = _clamp(levelReg.slope * 15000, 0, 90);
        _addRisk('tank', overflowScore, 'overflow', '液位持续上升 (速率=' + (levelReg.slope * 100).toFixed(2) + '%/s)');
        _suggestions.push({
          priority: overflowScore > 60 ? 'high' : 'medium',
          text: '水池液位持续上升，建议增加泵运行台数或开大出水阀'
        });
      }
      // 液位快速下降
      if (levelReg.slope < -0.002) {
        var dryScore = _clamp(-levelReg.slope * 12000, 0, 85);
        _addRisk('tank', dryScore, 'dry', '液位持续下降 (速率=' + (levelReg.slope * 100).toFixed(2) + '%/s)');
        _suggestions.push({
          priority: dryScore > 50 ? 'high' : 'medium',
          text: '水池液位持续下降，建议减少泵运行台数或检查进水管路'
        });
      }
    }

    // 7. 温度异常趋势
    if (_history.length >= 15) {
      for (var tp = 0; tp < pumpIds.length; tp++) {
        var tpid = pumpIds[tp];
        var temps = [];
        for (var ti = _history.length - 15; ti < _history.length; ti++) {
          var tps = _history[ti].pumpStates[tpid];
          if (tps && tps.state === 'running') temps.push(tps.temp);
        }
        if (temps.length >= 8) {
          var tempReg = _linearRegression(temps);
          if (tempReg.slope > 0.05) {
            var overheatScore = _clamp(tempReg.slope * 400, 0, 85);
            _addRisk(tpid, overheatScore, 'overheat', '温度持续升高 (趋势=' + tempReg.slope.toFixed(3) + '°C/s)');
            _suggestions.push({
              priority: overheatScore > 50 ? 'high' : 'medium',
              text: tpid.replace('pump', '') + '#泵温度持续升高，建议检查轴承和润滑系统'
            });
          }
        }
      }
    }

    // 8. 能耗趋势异常
    if (_history.length >= 30) {
      var powers = [];
      for (var pw = _history.length - 30; pw < _history.length; pw++) {
        powers.push(_history[pw].totalPower);
      }
      var powerReg = _linearRegression(powers);
      if (Math.abs(powerReg.slope) > 0.5) {
        var energyScore = _clamp(Math.abs(powerReg.slope) * 30, 0, 70);
        _addRisk('cabinet', energyScore, 'energy', '能耗趋势异常 (斜率=' + powerReg.slope.toFixed(2) + ')');
        if (powerReg.slope > 0) {
          _suggestions.push({
            priority: 'medium',
            text: '总功率持续上升，建议优化泵组调度减少冗余运行'
          });
        }
      }
    }
  }

  function _addRisk(eqId, score, type, label) {
    if (!_riskScores[eqId] || _riskScores[eqId].score < score) {
      _riskScores[eqId] = {score: score, type: type, label: label};
    }
  }

  /* ========== 预测曲线 ========== */
  function getPredictions() {
    if (_history.length < 15) return null;

    var n = _history.length;
    // 取最近数据做线性回归
    var startIdx = Math.max(0, n - 30);
    var levels = [], flows = [], powers = [], energies = [];
    for (var i = startIdx; i < n; i++) {
      levels.push(_history[i].tankLevel * 100);
      flows.push(_history[i].totalFlow);
      powers.push(_history[i].totalPower);
      energies.push(_history[i].energyKWh);
    }

    var levelReg = _linearRegression(levels);
    var flowReg = _linearRegression(flows);
    var powerReg = _linearRegression(powers);
    var energyReg = _linearRegression(energies);

    var predictions = {
      tankLevel: [],
      totalFlow: [],
      totalPower: [],
      energyKWh: []
    };

    var lastT = _history[n - 1].t;
    var lastEnergy = _history[n - 1].energyKWh;

    for (var j = 1; j <= PREDICT_HORIZON; j++) {
      predictions.tankLevel.push({
        t: lastT + j,
        value: _clamp(levelReg.intercept + levelReg.slope * (levels.length + j), 0, 100)
      });
      predictions.totalFlow.push({
        t: lastT + j,
        value: Math.max(0, flowReg.intercept + flowReg.slope * (flows.length + j))
      });
      predictions.totalPower.push({
        t: lastT + j,
        value: Math.max(0, powerReg.intercept + powerReg.slope * (powers.length + j))
      });
      predictions.energyKWh.push({
        t: lastT + j,
        value: lastEnergy + (energyReg.slope > 0 ? energyReg.slope * j : 0.01 * j)
      });
    }

    return predictions;
  }

  /* ========== 公开 API ========== */
  function getRiskScores() {
    return _riskScores;
  }

  function getSuggestions() {
    return _suggestions;
  }

  function getHistory() {
    return _history;
  }

  function getStats() {
    return {
      startStopCount: {
        pump1: _pumpStartStopCount.pump1,
        pump2: _pumpStartStopCount.pump2,
        pump3: _pumpStartStopCount.pump3
      },
      historyLength: _history.length,
      totalSimTime: _totalSimTime
    };
  }

  /**
   * 获取能耗趋势数据 (最近 N 个采样的平均功率)
   */
  function getEnergyTrend() {
    if (_history.length < 5) return {avg: 0, trend: 0};
    var recent = [];
    var start = Math.max(0, _history.length - 30);
    for (var i = start; i < _history.length; i++) {
      recent.push(_history[i].totalPower);
    }
    var reg = _linearRegression(recent);
    return {
      avg: _avg(recent),
      trend: reg.slope,
      last: recent[recent.length - 1] || 0
    };
  }

  /**
   * 策略切换回调 — 清除基于旧策略的分析缓存，保留原始历史
   */
  function onStrategySwitch(epoch) {
    _epoch = epoch;
    // 清除分析结果（基于策略语境的产出）
    _riskScores = {};
    _suggestions = [];
    // 重置启停计数（新策略下泵组行为模式不同）
    _pumpStartStopCount = {pump1: 0, pump2: 0, pump3: 0};
    // 重置压力历史（新策略下的压力基线不同）
    _pressureHistory = {pump1: [], pump2: [], pump3: []};
    // 重置效率统计（新策略运行台数/负载不同）
    _pumpRunningTicks = {pump1: 0, pump2: 0, pump3: 0};
    _pumpEnergyAccum = {pump1: 0, pump2: 0, pump3: 0};
    _pumpFlowAccum = {pump1: 0, pump2: 0, pump3: 0};
    // 重置采样计数器，确保下次 tick 立即采样
    _sampleCounter = SAMPLE_INTERVAL - 1;
    // 保留 _history 原始缓冲区 — 时间序列数据本身是客观的
    // 如有足够历史，立即重新分析
    if (_history.length >= 5) {
      _analyze();
    }
  }

  function getEpoch() {
    return _epoch;
  }

  function reset() {
    _sampleCounter = 0;
    _history = [];
    _prevPumpStates = {};
    _pumpStartStopCount = {pump1: 0, pump2: 0, pump3: 0};
    _pumpRunningTicks = {pump1: 0, pump2: 0, pump3: 0};
    _pumpEnergyAccum = {pump1: 0, pump2: 0, pump3: 0};
    _pumpFlowAccum = {pump1: 0, pump2: 0, pump3: 0};
    _pressureHistory = {pump1: [], pump2: [], pump3: []};
    _riskScores = {};
    _suggestions = [];
    _totalSimTime = 0;
    _epoch = 0;
  }

  return {
    pushSnapshot: pushSnapshot,
    getRiskScores: getRiskScores,
    getSuggestions: getSuggestions,
    getPredictions: getPredictions,
    getHistory: getHistory,
    getStats: getStats,
    getEnergyTrend: getEnergyTrend,
    onStrategySwitch: onStrategySwitch,
    getEpoch: getEpoch,
    reset: reset
  };
})();
