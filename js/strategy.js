/**
 * Strategy - 运行策略管理与对比分析模块
 *
 * 功能:
 * 1. 管理三种运行策略: 节能优先 / 安全优先 / 排涝优先
 * 2. 根据当前策略生成泵组调度建议
 * 3. 记录策略切换前后的能耗、告警次数、水位安全余量
 * 4. 提供策略对比面板数据
 *
 * 数据来源: Engine 快照 + Predictor 分析结果
 * 纯 ES5，IIFE 模式，零依赖
 */
var Strategy = (function () {
  'use strict';

  /* ========== 策略定义 ========== */
  var STRATEGIES = {
    energy: {
      id: 'energy',
      name: '\u8282\u80fd\u4f18\u5148',
      icon: '\u26a1',
      color: '#00ff88',
      description: '\u6700\u5c0f\u5316\u80fd\u8017\uff0c\u4ec5\u8fd0\u884c\u5fc5\u8981\u6cf5\u7ec4',
      // 液位目标区间
      targetLevelLow: 0.45,
      targetLevelHigh: 0.70,
      // 泵组运行策略: 最少泵数
      maxPumps: 1,
      preferPump: 'pump1',  // 优先使用效率最高的泵
      // 权重
      energyWeight: 1.0,
      safetyWeight: 0.3,
      drainageWeight: 0.2
    },
    safety: {
      id: 'safety',
      name: '\u5b89\u5168\u4f18\u5148',
      icon: '\u26e8',
      color: '#4488ff',
      description: '\u4fdd\u6301\u6c34\u4f4d\u5728\u5b89\u5168\u533a\u95f4\uff0c\u5747\u8861\u80fd\u8017',
      targetLevelLow: 0.35,
      targetLevelHigh: 0.65,
      maxPumps: 2,
      preferPump: null,  // 轮换
      energyWeight: 0.5,
      safetyWeight: 1.0,
      drainageWeight: 0.5
    },
    drainage: {
      id: 'drainage',
      name: '\u6392\u6d9d\u4f18\u5148',
      icon: '\u26c6',
      color: '#ff6644',
      description: '\u6700\u5927\u6392\u6c34\u80fd\u529b\uff0c\u9632\u6b62\u6ee1\u6ea2',
      targetLevelLow: 0.20,
      targetLevelHigh: 0.50,
      maxPumps: 3,
      preferPump: null,  // 全部
      energyWeight: 0.2,
      safetyWeight: 0.5,
      drainageWeight: 1.0
    }
  };

  var STRATEGY_LIST = ['energy', 'safety', 'drainage'];

  /* ========== 内部状态 ========== */
  var _currentStrategy = 'safety';   // 默认安全优先
  var _prevStrategy = null;
  var _switchTime = null;
  var _metricsBefore = null;         // 切换前指标快照
  var _metricsAfter = null;          // 切换后指标快照
  var _switchHistory = [];           // 策略切换历史
  var _lastSnapEnergy = 0;
  var _lastSnapAlarmCount = 0;
  var _lastSnapTankLevel = 0.6;
  var _strategyVersion = 0;          // 数据版本号，每次切换递增

  /* ========== 指标计算 ========== */
  function _computeMetrics(snap) {
    if (!snap) return null;
    var tp = DataModule.tankPhysics;
    var level = snap.tankLevel;
    // 安全余量: 距离高限/低限的最小距离
    var highMargin = Math.max(0, tp.levelHigh - level);
    var lowMargin = Math.max(0, level - tp.levelLow);
    var safetyMargin = Math.min(highMargin, lowMargin);

    return {
      energyKWh: snap.energyKWh,
      totalPower: snap.totalPower,
      alarmCount: snap.alarms ? snap.alarms.length : 0,
      tankLevel: level,
      highMargin: highMargin,
      lowMargin: lowMargin,
      safetyMargin: safetyMargin,
      runningPumps: snap.runningCount,
      totalFlow: snap.totalFlow,
      timestamp: Date.now()
    };
  }

  /* ========== 调度建议 ========== */
  function _generateDispatchAdvice(snap) {
    var strat = STRATEGIES[_currentStrategy];
    var advice = [];
    var level = snap ? snap.tankLevel : 0.6;
    var pumpIds = ['pump1', 'pump2', 'pump3'];

    // 获取各泵状态
    var pumpStates = {};
    if (snap) {
      for (var i = 0; i < snap.equipment.length; i++) {
        if (snap.equipment[i].type === 'pump') {
          pumpStates[snap.equipment[i].id] = snap.equipment[i].state;
        }
      }
    }

    var runningCount = 0;
    for (var r = 0; r < pumpIds.length; r++) {
      if (pumpStates[pumpIds[r]] === 'running') runningCount++;
    }

    if (_currentStrategy === 'energy') {
      // 节能模式: 尽量少开泵
      if (level < strat.targetLevelLow && runningCount === 0) {
        advice.push({type: 'start', target: 'pump1', reason: '\u6db2\u4f4d\u504f\u4f4e\uff0c\u542f\u52a81#\u6cf5\u8865\u6c34'});
      } else if (level > strat.targetLevelHigh && runningCount > 0) {
        advice.push({type: 'stop', target: 'pump1', reason: '\u6db2\u4f4d\u8fbe\u6807\uff0c\u505c\u6cf5\u8282\u80fd'});
      } else if (runningCount > strat.maxPumps) {
        advice.push({type: 'stop', target: 'pump3', reason: '\u8282\u80fd\u6a21\u5f0f\uff0c\u51cf\u5c11\u8fd0\u884c\u6cf5\u6570'});
      }
      if (runningCount === 0 && level > strat.targetLevelLow) {
        advice.push({type: 'info', reason: '\u5f53\u524d\u6db2\u4f4d\u5728\u76ee\u6807\u8303\u56f4\u5185\uff0c\u65e0\u9700\u542f\u6cf5'});
      }
    } else if (_currentStrategy === 'safety') {
      // 安全模式: 保持液位在安全区间
      if (level > strat.targetLevelHigh) {
        if (runningCount < 2) {
          advice.push({type: 'start', target: runningCount === 0 ? 'pump1' : 'pump2', reason: '\u6db2\u4f4d\u504f\u9ad8\uff0c\u589e\u52a0\u6cf5\u8fd0\u884c\u53f0\u6570'});
        }
      } else if (level < strat.targetLevelLow) {
        if (runningCount > 1) {
          advice.push({type: 'stop', target: 'pump3', reason: '\u6db2\u4f4d\u504f\u4f4e\uff0c\u51cf\u5c11\u6cf5\u8fd0\u884c\u53f0\u6570'});
        } else if (runningCount === 0) {
          advice.push({type: 'start', target: 'pump1', reason: '\u6db2\u4f4d\u8fc7\u4f4e\uff0c\u542f\u52a81#\u6cf5'});
        }
      } else {
        advice.push({type: 'info', reason: '\u6db2\u4f4d\u5728\u5b89\u5168\u533a\u95f4\u5185 (' + (level * 100).toFixed(0) + '%)'});
      }
    } else if (_currentStrategy === 'drainage') {
      // 排涝模式: 全力排水
      if (level > strat.targetLevelLow) {
        for (var d = 0; d < pumpIds.length; d++) {
          if (pumpStates[pumpIds[d]] !== 'running' && pumpStates[pumpIds[d]] !== 'fault') {
            advice.push({type: 'start', target: pumpIds[d], reason: '\u6392\u6d9d\u6a21\u5f0f\uff0c\u542f\u52a8' + pumpIds[d].replace('pump', '') + '#\u6cf5'});
          }
        }
      } else {
        advice.push({type: 'info', reason: '\u6db2\u4f4d\u5df2\u964d\u81f3\u5b89\u5168\u6c34\u4f4d\uff0c\u53ef\u51cf\u5c11\u6cf5\u6570'});
        if (runningCount > 1) {
          advice.push({type: 'stop', target: 'pump3', reason: '\u6db2\u4f4d\u5145\u5206\u964d\u4f4e\uff0c\u53ef\u505c\u6b623#\u6cf5'});
        }
      }
    }

    // 基于预测的额外建议
    var predictions = Predictor.getPredictions();
    if (predictions && predictions.tankLevel.length > 10) {
      var predLevel = predictions.tankLevel[Math.min(29, predictions.tankLevel.length - 1)].value;
      if (predLevel > 85) {
        advice.push({type: 'warning', reason: '\u26a0 \u9884\u6d4b1\u5206\u949f\u540e\u6db2\u4f4d\u5c06\u8d85\u8fc785%\uff0c\u5efa\u8bae\u63d0\u524d\u52a0\u6cf5'});
      } else if (predLevel < 20) {
        advice.push({type: 'warning', reason: '\u26a0 \u9884\u6d4b1\u5206\u949f\u540e\u6db2\u4f4d\u5c06\u4f4e\u4e8e20%\uff0c\u5efa\u8bae\u51cf\u6cf5\u6216\u8865\u6c34'});
      }
    }

    return advice;
  }

  /* ========== 公开 API ========== */

  function getCurrentStrategy() {
    return _currentStrategy;
  }

  function getStrategyConfig(id) {
    return STRATEGIES[id || _currentStrategy];
  }

  function getStrategyList() {
    return STRATEGY_LIST;
  }

  /**
   * 切换策略
   * 递增数据版本号，清除上一次切换的"切换后"指标，
   * 确保下游模块可检测到版本变化并重新计算。
   */
  function switchStrategy(newId, snap) {
    if (!STRATEGIES[newId] || newId === _currentStrategy) return false;

    // 记录切换前指标
    _metricsBefore = _computeMetrics(snap);
    _prevStrategy = _currentStrategy;

    // 清除上一次切换的"切换后"指标 — 避免快速切换时使用旧策略的缓存数据
    _metricsAfter = null;

    // 切换
    _currentStrategy = newId;
    _switchTime = Date.now();

    // 递增数据版本号 — 下游模块 (Predictor/Trend/Renderer) 据此判断缓存是否过期
    _strategyVersion++;

    // 记录切换历史
    _switchHistory.push({
      from: _prevStrategy,
      to: newId,
      time: _switchTime,
      metricsBefore: _metricsBefore,
      version: _strategyVersion
    });
    if (_switchHistory.length > 20) _switchHistory.shift();

    return true;
  }

  /**
   * 更新切换后指标 (每 tick 调用)
   */
  function updateMetrics(snap) {
    if (_switchTime && snap) {
      var elapsed = Date.now() - _switchTime;
      // 切换后 5 秒开始记录"切换后"指标
      if (elapsed > 5000) {
        _metricsAfter = _computeMetrics(snap);
      }
    }
    _lastSnapEnergy = snap ? snap.energyKWh : _lastSnapEnergy;
    _lastSnapAlarmCount = snap ? (snap.alarms ? snap.alarms.length : 0) : _lastSnapAlarmCount;
    _lastSnapTankLevel = snap ? snap.tankLevel : _lastSnapTankLevel;
  }

  /**
   * 获取策略对比数据
   */
  function getComparison() {
    if (!_metricsBefore || !_metricsAfter) return null;

    var before = _metricsBefore;
    var after = _metricsAfter;

    return {
      fromStrategy: STRATEGIES[_prevStrategy] ? STRATEGIES[_prevStrategy].name : '--',
      toStrategy: STRATEGIES[_currentStrategy] ? STRATEGIES[_currentStrategy].name : '--',
      fromColor: STRATEGIES[_prevStrategy] ? STRATEGIES[_prevStrategy].color : '#888',
      toColor: STRATEGIES[_currentStrategy] ? STRATEGIES[_currentStrategy].color : '#888',
      energy: {
        before: before.energyKWh,
        after: after.energyKWh,
        delta: after.energyKWh - before.energyKWh,
        powerBefore: before.totalPower,
        powerAfter: after.totalPower
      },
      alarms: {
        before: before.alarmCount,
        after: after.alarmCount,
        delta: after.alarmCount - before.alarmCount
      },
      safetyMargin: {
        before: before.safetyMargin * 100,
        after: after.safetyMargin * 100,
        delta: (after.safetyMargin - before.safetyMargin) * 100
      },
      tankLevel: {
        before: before.tankLevel * 100,
        after: after.tankLevel * 100
      },
      switchTime: _switchTime
    };
  }

  /**
   * 获取调度建议
   */
  function getDispatchAdvice(snap) {
    return _generateDispatchAdvice(snap);
  }

  /**
   * 获取切换历史
   */
  function getSwitchHistory() {
    return _switchHistory;
  }

  function reset() {
    _currentStrategy = 'safety';
    _prevStrategy = null;
    _switchTime = null;
    _metricsBefore = null;
    _metricsAfter = null;
    _switchHistory = [];
    _lastSnapEnergy = 0;
    _lastSnapAlarmCount = 0;
    _lastSnapTankLevel = 0.6;
    _strategyVersion++;  // 重置也递增版本号，使所有缓存失效
  }

  return {
    getCurrentStrategy: getCurrentStrategy,
    getStrategyConfig: getStrategyConfig,
    getStrategyList: getStrategyList,
    switchStrategy: switchStrategy,
    updateMetrics: updateMetrics,
    getComparison: getComparison,
    getDispatchAdvice: getDispatchAdvice,
    getSwitchHistory: getSwitchHistory,
    getVersion: function () { return _strategyVersion; },
    reset: reset,
    STRATEGIES: STRATEGIES
  };
})();
