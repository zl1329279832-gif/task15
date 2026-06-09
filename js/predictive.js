/**
 * Predictive - 预测性维护与能耗优化引擎
 *
 * 功能:
 * 1. 持续采集仿真数据，维护历史缓冲区
 * 2. 计算泵组启停频率、压力波动、水位趋势、流量异常、能耗趋势
 * 3. 识别故障模式: 空转 / 堵塞 / 阀门异常 / 泵效率下降
 * 4. 策略引擎: 节能优先 / 安全优先 / 排涝优先
 * 5. 生成调度建议，输出设备风险评分
 * 6. 策略对比: 记录并比较各策略下的能耗、告警、水位安全余量
 */
var Predictive = (function () {
  'use strict';

  /* ========== 常量 ========== */
  var SAMPLE_INTERVAL = 10;        // 每10个tick采样一次 (1Hz)
  var HISTORY_SIZE = 600;          // 10分钟历史窗口
  var PREDICT_HORIZON = 60;        // 预测未来60个采样点 (60秒)
  var FREQ_WINDOW = 60;            // 启停频率统计窗口 (60秒 = 60个采样)
  var PRESSURE_WINDOW = 30;        // 压力波动分析窗口
  var TREND_WINDOW = 60;           // 趋势回归窗口

  /* ========== 策略定义 ========== */
  var STRATEGIES = {
    energy: {
      name: '节能优先',
      desc: '最小化能耗，允许较大水位波动',
      levelTarget: 0.55,
      levelLow: 0.25,
      levelHigh: 0.80,
      maxPumps: 1,
      startThreshold: 0.70,
      stopThreshold: 0.35,
      weights: {energy: 0.6, safety: 0.2, drainage: 0.2}
    },
    safety: {
      name: '安全优先',
      desc: '保守运行，提前预警，保持冗余',
      levelTarget: 0.50,
      levelLow: 0.30,
      levelHigh: 0.70,
      maxPumps: 2,
      startThreshold: 0.55,
      stopThreshold: 0.40,
      weights: {energy: 0.15, safety: 0.65, drainage: 0.2}
    },
    drainage: {
      name: '排涝优先',
      desc: '最大排水能力，多泵并行',
      levelTarget: 0.30,
      levelLow: 0.10,
      levelHigh: 0.60,
      maxPumps: 3,
      startThreshold: 0.40,
      stopThreshold: 0.20,
      weights: {energy: 0.1, safety: 0.2, drainage: 0.7}
    }
  };

  /* ========== 状态 ========== */
  var _sampleCounter = 0;
  var _history = [];                // [{simTime, tankLevel, totalFlow, totalPower, energyKWh, pumps:[{id,state,flow,pressure,power,temp}], alarmCount}]
  var _pumpEvents = {};             // {pumpId: [{time, fromState, toState}]}
  var _prevPumpStates = {};         // {pumpId: state}
  var _currentStrategy = 'safety';  // 默认安全优先
  var _prevStrategy = null;

  /* ========== 策略对比记录 ========== */
  var _strategyStats = {
    energy:   {energyKWh: 0, alarmCount: 0, safetyMarginSum: 0, sampleCount: 0, pumpHours: 0, startEnergy: 0, startAlarms: 0},
    safety:   {energyKWh: 0, alarmCount: 0, safetyMarginSum: 0, sampleCount: 0, pumpHours: 0, startEnergy: 0, startAlarms: 0},
    drainage: {energyKWh: 0, alarmCount: 0, safetyMarginSum: 0, sampleCount: 0, pumpHours: 0, startEnergy: 0, startAlarms: 0}
  };
  var _strategyStartTime = 0;
  var _totalAlarmsSeen = 0;

  /* ========== 分析结果缓存 ========== */
  var _analysisResult = {
    risks: {},               // {equipmentId: {score, level, factors:[]}}
    predictions: {           // 预测曲线数据
      levelTrend: [],        // [{t, value}]
      energyTrend: [],
      flowTrend: []
    },
    faults: [],              // [{type, equipmentId, description, confidence}]
    suggestions: [],         // [{priority, text, type}]
    pumpMetrics: {},         // {pumpId: {startStopFreq, pressureStdDev, efficiency, flowRatio}}
    comparison: null         // 策略切换前后对比
  };

  /* ========== 工具函数 ========== */
  function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function _mean(arr) {
    if (!arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  function _stdDev(arr) {
    if (arr.length < 2) return 0;
    var m = _mean(arr);
    var sumSq = 0;
    for (var i = 0; i < arr.length; i++) {
      var d = arr[i] - m;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / arr.length);
  }

  function _linearRegress(arr) {
    var n = arr.length;
    if (n < 3) return {slope: 0, intercept: arr.length ? arr[n - 1] : 0, r2: 0};
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += i;
      sumY += arr[i];
      sumXY += i * arr[i];
      sumXX += i * i;
    }
    var denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-10) return {slope: 0, intercept: sumY / n, r2: 0};
    var slope = (n * sumXY - sumX * sumY) / denom;
    var intercept = (sumY - slope * sumX) / n;
    var yMean = sumY / n;
    var ssRes = 0, ssTot = 0;
    for (var j = 0; j < n; j++) {
      var predicted = intercept + slope * j;
      ssRes += (arr[j] - predicted) * (arr[j] - predicted);
      ssTot += (arr[j] - yMean) * (arr[j] - yMean);
    }
    var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    return {slope: slope, intercept: intercept, r2: r2};
  }

  /* ========== 数据采集 ========== */
  function pushSnapshot(snap) {
    _sampleCounter++;
    if (_sampleCounter < SAMPLE_INTERVAL) return;
    _sampleCounter = 0;

    // 采集泵状态
    var pumps = [];
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    for (var i = 0; i < snap.equipment.length; i++) {
      var eq = snap.equipment[i];
      if (eq.type === 'pump') {
        pumps.push({
          id: eq.id, state: eq.state,
          flow: eq.flow, pressure: eq.pressure,
          power: eq.power, temp: eq.temp
        });
        // 记录启停事件
        var prev = _prevPumpStates[eq.id];
        if (prev && prev !== eq.state) {
          if (!_pumpEvents[eq.id]) _pumpEvents[eq.id] = [];
          _pumpEvents[eq.id].push({
            time: snap.simTime,
            fromState: prev,
            toState: eq.state
          });
          // 限制事件历史长度
          if (_pumpEvents[eq.id].length > 200) {
            _pumpEvents[eq.id] = _pumpEvents[eq.id].slice(-100);
          }
        }
        _prevPumpStates[eq.id] = eq.state;
      }
    }

    // 计算水位安全余量 (距离最近限值的距离)
    var tp = DataModule.tankPhysics;
    var strat = STRATEGIES[_currentStrategy];
    var marginHigh = strat.levelHigh - snap.tankLevel;
    var marginLow = snap.tankLevel - strat.levelLow;
    var safetyMargin = Math.min(marginHigh, marginLow);

    _history.push({
      simTime: snap.simTime,
      tankLevel: snap.tankLevel,
      totalFlow: snap.totalFlow,
      totalPower: snap.totalPower,
      energyKWh: snap.energyKWh,
      pumps: pumps,
      alarmCount: snap.alarms.length,
      runningPumps: snap.runningCount,
      safetyMargin: safetyMargin
    });

    if (_history.length > HISTORY_SIZE) {
      _history.shift();
    }

    // 更新策略统计
    var stat = _strategyStats[_currentStrategy];
    stat.sampleCount++;
    stat.safetyMarginSum += Math.max(0, safetyMargin);
    stat.energyKWh = snap.energyKWh - stat.startEnergy;
    stat.alarmCount = _totalAlarmsSeen - stat.startAlarms;
    for (var p = 0; p < pumps.length; p++) {
      if (pumps[p].state === 'running') {
        stat.pumpHours += 1.0 / 3600; // 1秒 = 1/3600小时
      }
    }

    // 每次采样都记录告警累计
    _totalAlarmsSeen += snap.alarms.length;

    // 执行分析 (每5个采样执行一次完整分析)
    if (_history.length % 5 === 0 || _history.length < 10) {
      _runAnalysis(snap);
    }
  }

  /* ========== 核心分析 ========== */
  function _runAnalysis(snap) {
    _analyzeStartStopFrequency();
    _analyzePressureFluctuation();
    _analyzeFaultModes(snap);
    _computeRiskScores(snap);
    _computePredictions();
    _generateSuggestions(snap);
  }

  /* ---------- 启停频率分析 ---------- */
  function _analyzeStartStopFrequency() {
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    var now = _history.length > 0 ? _history[_history.length - 1].simTime : 0;
    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var events = _pumpEvents[pid] || [];
      var count = 0;
      for (var e = events.length - 1; e >= 0; e--) {
        if (now - events[e].time > FREQ_WINDOW) break;
        if (events[e].toState === 'running' || events[e].toState === 'stopped') {
          count++;
        }
      }
      if (!_analysisResult.pumpMetrics[pid]) {
        _analysisResult.pumpMetrics[pid] = {};
      }
      _analysisResult.pumpMetrics[pid].startStopFreq = count;
    }
  }

  /* ---------- 压力波动分析 ---------- */
  function _analyzePressureFluctuation() {
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    var startIdx = Math.max(0, _history.length - PRESSURE_WINDOW);
    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var pressures = [];
      for (var h = startIdx; h < _history.length; h++) {
        var sample = _history[h];
        for (var p = 0; p < sample.pumps.length; p++) {
          if (sample.pumps[p].id === pid && sample.pumps[p].state === 'running') {
            pressures.push(sample.pumps[p].pressure);
          }
        }
      }
      if (!_analysisResult.pumpMetrics[pid]) {
        _analysisResult.pumpMetrics[pid] = {};
      }
      _analysisResult.pumpMetrics[pid].pressureStdDev = _stdDev(pressures);
      _analysisResult.pumpMetrics[pid].pressureMean = _mean(pressures);
    }
  }

  /* ---------- 故障模式识别 ---------- */
  function _analyzeFaultModes(snap) {
    var faults = [];
    var pc = DataModule.pumpConfig;
    var recentCount = Math.min(10, _history.length);
    var startIdx = _history.length - recentCount;

    var pumpIds = ['pump1', 'pump2', 'pump3'];
    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var metrics = _analysisResult.pumpMetrics[pid] || {};
      var latestPump = null;
      for (var e = 0; e < snap.equipment.length; e++) {
        if (snap.equipment[e].id === pid) { latestPump = snap.equipment[e]; break; }
      }
      if (!latestPump || latestPump.state !== 'running') continue;

      // 计算近期平均值
      var avgFlow = 0, avgPower = 0, avgPressure = 0, count = 0;
      for (var h = startIdx; h < _history.length; h++) {
        for (var p = 0; p < _history[h].pumps.length; p++) {
          if (_history[h].pumps[p].id === pid && _history[h].pumps[p].state === 'running') {
            avgFlow += _history[h].pumps[p].flow;
            avgPower += _history[h].pumps[p].power;
            avgPressure += _history[h].pumps[p].pressure;
            count++;
          }
        }
      }
      if (count > 0) {
        avgFlow /= count;
        avgPower /= count;
        avgPressure /= count;
      }

      var flowRatio = avgFlow / pc.ratedFlow;
      var efficiency = avgFlow > 0 ? avgPower / avgFlow : 999;

      if (!_analysisResult.pumpMetrics[pid]) _analysisResult.pumpMetrics[pid] = {};
      _analysisResult.pumpMetrics[pid].efficiency = efficiency;
      _analysisResult.pumpMetrics[pid].flowRatio = flowRatio;

      // 1. 空转检测: 泵运行但流量极低
      if (flowRatio < 0.10 && count >= 3) {
        faults.push({
          type: 'dry_run',
          equipmentId: pid,
          description: latestPump.name + '疑似空转：流量仅为额定值' + Math.round(flowRatio * 100) + '%',
          confidence: _clamp(1 - flowRatio * 5, 0.3, 0.95)
        });
      }

      // 2. 堵塞检测: 压力高但流量低
      if (avgPressure > pc.ratedPressure * 1.15 && flowRatio < 0.50 && count >= 3) {
        faults.push({
          type: 'blockage',
          equipmentId: pid,
          description: latestPump.name + '疑似管路堵塞：压力偏高(' + avgPressure.toFixed(2) + 'MPa)但流量仅' + Math.round(flowRatio * 100) + '%',
          confidence: _clamp((avgPressure / pc.ratedPressure - 1) * 5, 0.3, 0.90)
        });
      }

      // 3. 泵效率下降: 单位流量功耗过高
      var ratedEfficiency = pc.ratedPower / pc.ratedFlow;
      if (efficiency > ratedEfficiency * 1.25 && count >= 5) {
        faults.push({
          type: 'efficiency_drop',
          equipmentId: pid,
          description: latestPump.name + '效率下降：单位流量功耗' + efficiency.toFixed(2) + ' kW/(m\u00b3/h)，超出额定' + Math.round((efficiency / ratedEfficiency - 1) * 100) + '%',
          confidence: _clamp((efficiency / ratedEfficiency - 1) * 3, 0.2, 0.85)
        });
      }

      // 4. 频繁启停
      if (metrics.startStopFreq > 4) {
        faults.push({
          type: 'frequent_start',
          equipmentId: pid,
          description: latestPump.name + '频繁启停：' + FREQ_WINDOW + '秒内启停' + metrics.startStopFreq + '次',
          confidence: _clamp(metrics.startStopFreq / 8, 0.4, 0.90)
        });
      }
    }

    // 5. 阀门异常检测
    var valveChecks = [
      {valve: 'v1', pump: 'pump1'},
      {valve: 'v2', pump: 'pump2'},
      {valve: 'v3', pump: 'pump3'}
    ];
    for (var v = 0; v < valveChecks.length; v++) {
      var vc = valveChecks[v];
      var valveEq = null, pumpEq = null;
      for (var eq = 0; eq < snap.equipment.length; eq++) {
        if (snap.equipment[eq].id === vc.valve) valveEq = snap.equipment[eq];
        if (snap.equipment[eq].id === vc.pump) pumpEq = snap.equipment[eq];
      }
      if (!valveEq || !pumpEq) continue;
      // 阀门开但泵运行无流量
      if (valveEq.state === 'running' && pumpEq.state === 'running' && pumpEq.flow < 10) {
        faults.push({
          type: 'valve_fault',
          equipmentId: vc.valve,
          description: valveEq.name + '异常：阀门已开启但' + pumpEq.name + '流量异常低',
          confidence: 0.65
        });
      }
    }

    _analysisResult.faults = faults;
  }

  /* ---------- 风险评分 ---------- */
  function _computeRiskScores(snap) {
    var risks = {};
    var pumpIds = ['pump1', 'pump2', 'pump3'];

    for (var i = 0; i < pumpIds.length; i++) {
      var pid = pumpIds[i];
      var metrics = _analysisResult.pumpMetrics[pid] || {};
      var score = 0;
      var factors = [];
      var eq = null;
      for (var e = 0; e < snap.equipment.length; e++) {
        if (snap.equipment[e].id === pid) { eq = snap.equipment[e]; break; }
      }
      if (!eq) continue;

      // 故障状态直接高危
      if (eq.state === 'fault') {
        score = 95;
        factors.push('设备故障');
      } else if (eq.state === 'maintenance') {
        score = 50;
        factors.push('设备检修中');
      } else if (eq.state === 'running') {
        // 温度因子
        var tempRatio = eq.temp / DataModule.pumpConfig.maxTemp;
        if (tempRatio > 0.90) {
          score += 30;
          factors.push('温度接近上限');
        } else if (tempRatio > 0.75) {
          score += 15;
          factors.push('温度偏高');
        }

        // 压力波动因子
        if (metrics.pressureStdDev > 0.05) {
          score += 20;
          factors.push('压力波动大');
        } else if (metrics.pressureStdDev > 0.03) {
          score += 10;
          factors.push('压力波动偏大');
        }

        // 启停频率因子
        if (metrics.startStopFreq > 6) {
          score += 25;
          factors.push('频繁启停');
        } else if (metrics.startStopFreq > 3) {
          score += 12;
          factors.push('启停频率偏高');
        }

        // 效率因子
        var ratedEff = DataModule.pumpConfig.ratedPower / DataModule.pumpConfig.ratedFlow;
        if (metrics.efficiency > ratedEff * 1.3) {
          score += 20;
          factors.push('运行效率下降');
        }

        // 运行时长因子
        if (eq.runtime > 100) {
          score += 10;
          factors.push('长时间连续运行');
        }
      }

      // 检查是否有对应故障
      for (var f = 0; f < _analysisResult.faults.length; f++) {
        if (_analysisResult.faults[f].equipmentId === pid) {
          score += Math.round(_analysisResult.faults[f].confidence * 15);
        }
      }

      score = _clamp(score, 0, 100);
      var level = score < 30 ? 'normal' : score < 55 ? 'caution' : score < 75 ? 'warning' : 'danger';
      risks[pid] = {score: score, level: level, factors: factors};
    }

    // 阀门和传感器风险
    var otherIds = ['v_inlet', 'v_outlet', 'v1', 'v2', 'v3', 's_flow_in', 's_press_in', 's_level', 's_flow_out', 's_temp'];
    for (var o = 0; o < otherIds.length; o++) {
      var oid = otherIds[o];
      var oeq = null;
      for (var oe = 0; oe < snap.equipment.length; oe++) {
        if (snap.equipment[oe].id === oid) { oeq = snap.equipment[oe]; break; }
      }
      if (!oeq) continue;
      var oscore = 0;
      var ofactors = [];
      if (oeq.state === 'fault') { oscore = 90; ofactors.push('设备故障'); }
      else if (oeq.state === 'offline') { oscore = 85; ofactors.push('通信中断'); }
      else if (oeq.state === 'maintenance') { oscore = 40; ofactors.push('设备检修'); }

      // 检查阀门故障
      for (var vf = 0; vf < _analysisResult.faults.length; vf++) {
        if (_analysisResult.faults[vf].equipmentId === oid) {
          oscore += 25;
          ofactors.push(_analysisResult.faults[vf].type === 'valve_fault' ? '阀门动作异常' : '异常');
        }
      }

      oscore = _clamp(oscore, 0, 100);
      var olevel = oscore < 30 ? 'normal' : oscore < 55 ? 'caution' : oscore < 75 ? 'warning' : 'danger';
      risks[oid] = {score: oscore, level: olevel, factors: ofactors};
    }

    _analysisResult.risks = risks;
  }

  /* ---------- 趋势预测 ---------- */
  function _computePredictions() {
    if (_history.length < 10) {
      _analysisResult.predictions = {levelTrend: [], energyTrend: [], flowTrend: []};
      return;
    }

    var startIdx = Math.max(0, _history.length - TREND_WINDOW);
    var levels = [], energies = [], flows = [];
    for (var i = startIdx; i < _history.length; i++) {
      levels.push(_history[i].tankLevel);
      energies.push(_history[i].totalPower);
      flows.push(_history[i].totalFlow);
    }

    var levelReg = _linearRegress(levels);
    var energyReg = _linearRegress(energies);
    var flowReg = _linearRegress(flows);

    var baseIdx = levels.length;
    var lastTime = _history[_history.length - 1].simTime;

    var levelTrend = [], energyTrend = [], flowTrend = [];
    for (var t = 0; t <= PREDICT_HORIZON; t++) {
      var futureTime = lastTime + t;
      var predLevel = _clamp(levelReg.intercept + levelReg.slope * (baseIdx + t), 0, 1);
      var predEnergy = Math.max(0, energyReg.intercept + energyReg.slope * (baseIdx + t));
      var predFlow = Math.max(0, flowReg.intercept + flowReg.slope * (baseIdx + t));

      levelTrend.push({t: futureTime, value: predLevel});
      energyTrend.push({t: futureTime, value: predEnergy});
      flowTrend.push({t: futureTime, value: predFlow});
    }

    _analysisResult.predictions = {
      levelTrend: levelTrend,
      energyTrend: energyTrend,
      flowTrend: flowTrend,
      levelSlope: levelReg.slope,
      levelR2: levelReg.r2,
      energySlope: energyReg.slope
    };
  }

  /* ---------- 调度建议生成 ---------- */
  function _generateSuggestions(snap) {
    var suggestions = [];
    var strat = STRATEGIES[_currentStrategy];
    var level = snap.tankLevel;
    var tp = DataModule.tankPhysics;

    // 基于策略的水位建议
    if (level > strat.levelHigh) {
      suggestions.push({
        priority: 'high',
        text: '水位(' + Math.round(level * 100) + '%)超过策略上限(' + Math.round(strat.levelHigh * 100) + '%)，建议增开水泵排水',
        type: 'level'
      });
    }
    if (level < strat.levelLow) {
      suggestions.push({
        priority: 'high',
        text: '水位(' + Math.round(level * 100) + '%)低于策略下限(' + Math.round(strat.levelLow * 100) + '%)，建议减少排水或增加进水',
        type: 'level'
      });
    }

    // 水位趋势预测预警
    var pred = _analysisResult.predictions;
    if (pred.levelTrend && pred.levelTrend.length > 0) {
      var futureLevel = pred.levelTrend[pred.levelTrend.length - 1].value;
      if (futureLevel > tp.levelHigh && level <= tp.levelHigh) {
        suggestions.push({
          priority: 'medium',
          text: '预测' + PREDICT_HORIZON + '秒后水位将达到' + Math.round(futureLevel * 100) + '%，可能超过高限，建议提前启泵',
          type: 'prediction'
        });
      }
      if (futureLevel < tp.levelLow && level >= tp.levelLow) {
        suggestions.push({
          priority: 'medium',
          text: '预测' + PREDICT_HORIZON + '秒后水位将降至' + Math.round(futureLevel * 100) + '%，可能低于下限，建议减少排水',
          type: 'prediction'
        });
      }
    }

    // 能耗优化建议
    var runningPumps = 0;
    var pumpIds = ['pump1', 'pump2', 'pump3'];
    for (var i = 0; i < snap.equipment.length; i++) {
      if (snap.equipment[i].type === 'pump' && snap.equipment[i].state === 'running') {
        runningPumps++;
      }
    }
    if (_currentStrategy === 'energy' && runningPumps > strat.maxPumps && level < strat.startThreshold) {
      suggestions.push({
        priority: 'medium',
        text: '当前运行' + runningPumps + '台泵，节能模式建议最多' + strat.maxPumps + '台，水位安全可停泵节能',
        type: 'energy'
      });
    }

    // 故障相关建议
    for (var f = 0; f < _analysisResult.faults.length; f++) {
      var fault = _analysisResult.faults[f];
      var actionMap = {
        dry_run: '建议立即检查进水管路和泵前阀门',
        blockage: '建议安排管路清洗和阀门检查',
        valve_fault: '建议检查阀门执行机构和反馈信号',
        efficiency_drop: '建议安排泵组维护保养',
        frequent_start: '建议检查控制逻辑，避免频繁启停损坏设备'
      };
      if (fault.confidence > 0.5) {
        suggestions.push({
          priority: fault.confidence > 0.7 ? 'high' : 'medium',
          text: fault.description + '。' + (actionMap[fault.type] || ''),
          type: 'maintenance'
        });
      }
    }

    // 风险设备维护建议
    var riskKeys = Object.keys(_analysisResult.risks);
    for (var r = 0; r < riskKeys.length; r++) {
      var risk = _analysisResult.risks[riskKeys[r]];
      if (risk.level === 'danger' && risk.factors.length > 0) {
        var eqName = _getEqName(riskKeys[r]);
        suggestions.push({
          priority: 'high',
          text: eqName + '风险评分' + risk.score + '分(危险)，因素：' + risk.factors.join('、') + '，建议立即排查',
          type: 'risk'
        });
      } else if (risk.level === 'warning' && risk.factors.length > 0) {
        var eqName2 = _getEqName(riskKeys[r]);
        suggestions.push({
          priority: 'medium',
          text: eqName2 + '风险评分' + risk.score + '分(预警)，建议关注：' + risk.factors.join('、'),
          type: 'risk'
        });
      }
    }

    // 按优先级排序
    var prioOrder = {high: 0, medium: 1, low: 2};
    suggestions.sort(function (a, b) {
      return (prioOrder[a.priority] || 3) - (prioOrder[b.priority] || 3);
    });

    // 限制数量
    if (suggestions.length > 8) suggestions = suggestions.slice(0, 8);
    _analysisResult.suggestions = suggestions;
  }

  function _getEqName(id) {
    var eqList = DataModule.equipment;
    for (var i = 0; i < eqList.length; i++) {
      if (eqList[i].id === id) return eqList[i].name;
    }
    return id;
  }

  /* ========== 策略管理 ========== */
  function setStrategy(strategyId) {
    if (!STRATEGIES[strategyId]) return false;
    if (strategyId === _currentStrategy) return false;

    _prevStrategy = _currentStrategy;

    // 保存切换前快照用于对比
    var prevStat = _strategyStats[_prevStrategy];
    var switchSnapshot = {
      strategy: _prevStrategy,
      name: STRATEGIES[_prevStrategy].name,
      energyKWh: prevStat.energyKWh,
      alarmCount: prevStat.alarmCount,
      avgSafetyMargin: prevStat.sampleCount > 0 ? prevStat.safetyMarginSum / prevStat.sampleCount : 0,
      pumpHours: prevStat.pumpHours,
      sampleCount: prevStat.sampleCount
    };

    // 切换策略
    _currentStrategy = strategyId;

    // 重置新策略统计 (保留旧策略数据用于对比)
    var currentStat = _strategyStats[_currentStrategy];
    var lastSample = _history.length > 0 ? _history[_history.length - 1] : null;
    currentStat.startEnergy = lastSample ? lastSample.energyKWh : 0;
    currentStat.startAlarms = _totalAlarmsSeen;
    currentStat.energyKWh = 0;
    currentStat.alarmCount = 0;
    currentStat.safetyMarginSum = 0;
    currentStat.sampleCount = 0;
    currentStat.pumpHours = 0;

    // 更新对比数据
    _analysisResult.comparison = {
      previous: switchSnapshot,
      current: {
        strategy: _currentStrategy,
        name: STRATEGIES[_currentStrategy].name,
        energyKWh: 0,
        alarmCount: 0,
        avgSafetyMargin: 0,
        pumpHours: 0,
        sampleCount: 0
      },
      switchTime: lastSample ? lastSample.simTime : 0
    };

    return true;
  }

  function getStrategy() {
    return _currentStrategy;
  }

  function getStrategyConfig() {
    return STRATEGIES[_currentStrategy];
  }

  function getStrategies() {
    return STRATEGIES;
  }

  /* ========== 获取分析结果 ========== */
  function getAnalysis() {
    // 更新对比面板中的当前策略数据
    if (_analysisResult.comparison) {
      var stat = _strategyStats[_currentStrategy];
      _analysisResult.comparison.current.energyKWh = stat.energyKWh;
      _analysisResult.comparison.current.alarmCount = stat.alarmCount;
      _analysisResult.comparison.current.avgSafetyMargin = stat.sampleCount > 0 ? stat.safetyMarginSum / stat.sampleCount : 0;
      _analysisResult.comparison.current.pumpHours = stat.pumpHours;
      _analysisResult.comparison.current.sampleCount = stat.sampleCount;
    }
    return _analysisResult;
  }

  function getHistory() {
    return _history;
  }

  /* ========== 重置 ========== */
  function reset() {
    _sampleCounter = 0;
    _history = [];
    _pumpEvents = {};
    _prevPumpStates = {};
    _currentStrategy = 'safety';
    _prevStrategy = null;
    _totalAlarmsSeen = 0;

    var keys = Object.keys(_strategyStats);
    for (var i = 0; i < keys.length; i++) {
      _strategyStats[keys[i]] = {
        energyKWh: 0, alarmCount: 0, safetyMarginSum: 0,
        sampleCount: 0, pumpHours: 0, startEnergy: 0, startAlarms: 0
      };
    }

    _analysisResult = {
      risks: {},
      predictions: {levelTrend: [], energyTrend: [], flowTrend: []},
      faults: [],
      suggestions: [],
      pumpMetrics: {},
      comparison: null
    };
  }

  return {
    pushSnapshot: pushSnapshot,
    setStrategy: setStrategy,
    getStrategy: getStrategy,
    getStrategyConfig: getStrategyConfig,
    getStrategies: getStrategies,
    getAnalysis: getAnalysis,
    getHistory: getHistory,
    reset: reset,
    STRATEGIES: STRATEGIES
  };
})();
