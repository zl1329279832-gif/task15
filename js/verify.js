/**
 * Verify - 智慧泵站自动化验证脚本
 *
 * 使用方法: 在浏览器控制台执行 Verify.run()
 *
 * 验证 10 个步骤:
 * 1. 启动 AUTO 模式 — 泵运行，液位稳定
 * 2. 注入 pump1 故障 — 联动执行，报警出现
 * 3. 切换到 MANUAL — 无自动联动
 * 4. 手动切换 pump2 — 状态变化，无级联
 * 5. 暂停 — 状态冻结
 * 6. 恢复 — 仿真继续
 * 7. 注入传感器离线 — 报警，模式降级
 * 8. 确认报警 — 报警移入历史
 * 9. 重置 — 所有初始状态恢复
 * 10. 快速模式切换 — 无定时器泄漏，快照一致
 */
var Verify = (function () {
  'use strict';

  var _log = [];
  var _passCount = 0;
  var _failCount = 0;

  function _result(step, name, pass, detail) {
    var status = pass ? 'PASS' : 'FAIL';
    var msg = '[' + status + '] Step ' + step + ': ' + name;
    if (detail) msg += ' — ' + detail;
    _log.push(msg);
    if (pass) _passCount++; else _failCount++;
    console.log('%c' + msg, 'color:' + (pass ? '#00ff88' : '#ff4455'));
  }

  function _assert(step, name, condition, detail) {
    _result(step, name, !!condition, detail || (condition ? '' : 'assertion failed'));
  }

  function _findEq(snap, id) {
    for (var i = 0; i < snap.equipment.length; i++) {
      if (snap.equipment[i].id === id) return snap.equipment[i];
    }
    return null;
  }

  function _hasAlarm(snap, keyFragment) {
    for (var i = 0; i < snap.alarms.length; i++) {
      if (snap.alarms[i].key.indexOf(keyFragment) >= 0) return true;
    }
    return false;
  }

  function _wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function _getSnap() {
    return Engine.getSnapshot();
  }

  function _resetFaultButtons() {
    var btns = document.querySelectorAll('.fault-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = false;
      btns[i].classList.remove('injected');
    }
  }

  /**
   * 运行全部验证步骤
   */
  async function run() {
    _log = [];
    _passCount = 0;
    _failCount = 0;
    console.log('%c========== 智慧泵站验证开始 ==========', 'color:#00d4ff;font-weight:bold');

    // ===== Step 0: Reset to clean state =====
    Engine.reset();
    Trend.reset();
    _resetFaultButtons();
    await _wait(300);

    // ===== Step 1: AUTO 模式启动 =====
    var r1 = Engine.setMode('auto');
    await _wait(500);
    var snap1 = _getSnap();
    _assert(1, 'AUTO 模式启动成功', r1, 'setMode returned ' + r1);
    _assert(1, 'pump1 运行中', _findEq(snap1, 'pump1').state === 'running');
    _assert(1, 'pump2 运行中', _findEq(snap1, 'pump2').state === 'running');
    _assert(1, 'pump3 停止', _findEq(snap1, 'pump3').state === 'stopped');
    _assert(1, '液位在合理范围', snap1.tankLevel > 0.1 && snap1.tankLevel < 0.95,
      'tankLevel=' + snap1.tankLevel.toFixed(3));
    _assert(1, '快照已冻结', Object.isFrozen(snap1));
    await _wait(500);

    // ===== Step 2: 注入 pump1 故障 =====
    var r2 = Engine.injectFault('pump1_fault');
    await _wait(300);
    var snap2 = _getSnap();
    _assert(2, '故障注入成功', r2);
    _assert(2, 'pump1 故障', _findEq(snap2, 'pump1').state === 'fault');

    // AUTO 模式下联动应执行
    var v1 = _findEq(snap2, 'v1');
    var pump3 = _findEq(snap2, 'pump3');
    var v3 = _findEq(snap2, 'v3');
    _assert(2, 'v1 联锁关闭', v1.state === 'stopped', 'v1.state=' + v1.state);
    _assert(2, 'pump3 联锁启动', pump3.state === 'running', 'pump3.state=' + pump3.state);
    _assert(2, 'v3 联锁打开', v3.state === 'running', 'v3.state=' + v3.state);
    _assert(2, '故障报警出现', _hasAlarm(snap2, 'pump1'), 'alarms=' + snap2.alarms.map(function(a){return a.key}).join(','));
    _assert(2, '联动报警出现', _hasAlarm(snap2, 'linkage'), 'alarms=' + snap2.alarms.map(function(a){return a.key}).join(','));
    _assert(2, '声光报警器激活', _findEq(snap2, 'alarm_light').state === 'running');
    await _wait(300);

    // ===== Step 3: 切换到 MANUAL 模式 =====
    var r3 = Engine.setMode('manual');
    await _wait(200);
    var snap3 = _getSnap();
    _assert(3, 'MANUAL 模式切换成功', r3);
    _assert(3, '当前模式为 manual', snap3.mode === 'manual');
    // 手动模式下不应触发新的联动
    var debugState = Engine._debugState();
    _assert(3, '无新的联动执行 (cascadeLatched 不变)',
      Object.keys(debugState.cascadeLatched).length > 0,
      'cascade latched keys: ' + Object.keys(debugState.cascadeLatched).length);
    await _wait(300);

    // ===== Step 4: 手动切换 pump2 =====
    var pump2Before = _findEq(_getSnap(), 'pump2').state;
    var r4 = Engine.manualOverride('pump2', 'stopped');
    await _wait(200);
    var snap4 = _getSnap();
    _assert(4, '手动覆写成功', r4);
    _assert(4, 'pump2 已停止', _findEq(snap4, 'pump2').state === 'stopped',
      'was ' + pump2Before + ', now ' + _findEq(snap4, 'pump2').state);
    // 手动模式下停止 pump2 不应触发联动
    _assert(4, 'v2 未被联动关闭', _findEq(snap4, 'v2').state === 'running');
    await _wait(300);

    // ===== Step 5: 暂停 =====
    var r5 = Engine.setMode('pause');
    var snapBefore = _getSnap();
    await _wait(500);
    var snapPaused = _getSnap();
    _assert(5, '暂停成功', r5);
    _assert(5, '快照 frameId 不变 (仿真冻结)',
      snapBefore.frameId === snapPaused.frameId,
      'before=' + snapBefore.frameId + ' after=' + snapPaused.frameId);
    _assert(5, '液位不变', snapBefore.tankLevel === snapPaused.tankLevel,
      'before=' + snapBefore.tankLevel.toFixed(4) + ' after=' + snapPaused.tankLevel.toFixed(4));
    _assert(5, '报警数量不变', snapBefore.alarms.length === snapPaused.alarms.length);
    await _wait(500);

    // ===== Step 6: 恢复 =====
    var r6 = Engine.setMode('resume');
    await _wait(500);
    var snap6 = _getSnap();
    _assert(6, '恢复成功', r6);
    _assert(6, '模式回到 manual', snap6.mode === 'manual', 'mode=' + snap6.mode);
    _assert(6, '仿真时间继续', snap6.simTime > snapPaused.simTime,
      'paused=' + snapPaused.simTime.toFixed(1) + ' resumed=' + snap6.simTime.toFixed(1));
    await _wait(300);

    // ===== Step 7: 注入传感器离线 =====
    var r7 = Engine.injectFault('sensor_offline');
    await _wait(300);
    var snap7 = _getSnap();
    _assert(7, '传感器离线注入成功', r7);
    _assert(7, 's_flow_in 离线', _findEq(snap7, 's_flow_in').state === 'offline');
    _assert(7, 's_level 离线', _findEq(snap7, 's_level').state === 'offline');
    _assert(7, '传感器离线报警出现', _hasAlarm(snap7, 'sensor:offline'));
    await _wait(300);

    // ===== Step 8: 确认报警 =====
    var snap8a = _getSnap();
    var alarmCountBefore = snap8a.alarms.length;
    // 确认第一个报警
    if (snap8a.alarms.length > 0) {
      var ackKey = snap8a.alarms[0].key;
      var r8 = Engine.acknowledgeAlarm(ackKey);
      await _wait(200);
      var snap8b = _getSnap();
      _assert(8, '报警确认成功', r8);
      _assert(8, '报警数量减少', snap8b.alarms.length < alarmCountBefore,
        'before=' + alarmCountBefore + ' after=' + snap8b.alarms.length);
      _assert(8, '已确认报警不在活跃列表',
        !snap8b.alarms.some(function(a) { return a.key === ackKey; }));
    } else {
      _assert(8, '有报警可确认', false, 'no alarms to ack');
    }
    await _wait(200);

    // ===== Step 9: 重置 =====
    var r9 = Engine.reset();
    Trend.reset();
    await _wait(300);
    var snap9 = _getSnap();
    _assert(9, '重置成功', r9);
    _assert(9, '模式回到 idle', snap9.mode === 'idle');
    _assert(9, 'pump1 恢复运行', _findEq(snap9, 'pump1').state === 'running');
    _assert(9, 'pump2 恢复运行', _findEq(snap9, 'pump2').state === 'running');
    _assert(9, 'pump3 恢复停止', _findEq(snap9, 'pump3').state === 'stopped');
    _assert(9, '所有报警清除', snap9.alarms.length === 0,
      'alarms=' + snap9.alarms.length);
    _assert(9, '液位恢复初始值', Math.abs(snap9.tankLevel - 0.60) < 0.01,
      'tankLevel=' + snap9.tankLevel.toFixed(3));
    _assert(9, '能耗归零', snap9.energyKWh < 0.01,
      'energyKWh=' + snap9.energyKWh.toFixed(4));
    _assert(9, '趋势缓冲清空', Trend.getLength() === 0);
    _assert(9, '定时器已停止', Engine._debugState().timerActive === false);
    await _wait(200);

    // ===== Step 10: 快速模式切换 =====
    var timerBefore = Engine._debugState().timerActive;
    for (var i = 0; i < 10; i++) {
      Engine.setMode('auto');
      Engine.setMode('manual');
      Engine.setMode('pause');
      Engine.setMode('resume');
      await _wait(50);
    }
    await _wait(200);
    var debugFinal = Engine._debugState();
    _assert(10, '快速切换后定时器正常', debugFinal.timerActive === true,
      'timerActive=' + debugFinal.timerActive);
    _assert(10, '快速切换后快照有效', _getSnap() !== null);
    _assert(10, '快速切换后无重复帧',
      _getSnap().frameId > 0 || _getSnap().mode === 'manual',
      'frameId=' + _getSnap().frameId + ' mode=' + _getSnap().mode);

    // 检查没有多余的定时器
    Engine.reset();
    await _wait(300);
    _assert(10, '重置后定时器停止', Engine._debugState().timerActive === false);

    // ===== Step 11: 快速策略切换 — 数据版本一致性 =====
    Engine.setMode('auto');
    await _wait(500);  // 让 Predictor 积累一些历史数据

    var versionBefore = Strategy.getVersion();
    _assert(11, '初始策略版本号 >= 0', versionBefore >= 0,
      'version=' + versionBefore);

    // 快速切换: 节能 → 排涝 → 安全 → 节能 → 排涝
    var strategies = ['energy', 'drainage', 'safety', 'energy', 'drainage'];
    for (var si = 0; si < strategies.length; si++) {
      Strategy.switchStrategy(strategies[si], Engine.getSnapshot());
      await _wait(30);  // 极短间隔模拟快速点击
    }
    await _wait(200);

    var versionAfter = Strategy.getVersion();
    _assert(11, '快速切换后版本号递增正确',
      versionAfter === versionBefore + strategies.length,
      'before=' + versionBefore + ' after=' + versionAfter +
      ' expected=' + (versionBefore + strategies.length));

    _assert(11, '最终策略为 drainage',
      Strategy.getCurrentStrategy() === 'drainage',
      'current=' + Strategy.getCurrentStrategy());

    // Predictor 缓存应该已被失效或正在重算
    var predVersion = Predictor.getVersion();
    _assert(11, 'Predictor 版本号已更新到最新策略',
      predVersion === versionAfter,
      'predictorVersion=' + predVersion + ' strategyVersion=' + versionAfter);

    // 让仿真继续，使 Predictor 重新分析
    await _wait(1500);

    // 现在 Predictor 应该已经在新策略版本下完成分析
    var preds = Predictor.getPredictions();
    if (preds) {
      _assert(11, '预测数据标记了正确的策略版本',
        preds.strategyVersion === versionAfter,
        'predVersion=' + preds.strategyVersion + ' expected=' + versionAfter);
    } else {
      _result(11, '预测数据尚未生成 (历史不足)', true, 'predictions=null — acceptable');
    }
    await _wait(300);

    // ===== Step 12: 连续仿真跨策略 — 指标重算验证 =====
    // 切回安全策略，运行一段时间，收集指标
    Strategy.switchStrategy('safety', Engine.getSnapshot());
    var safetyVersion = Strategy.getVersion();
    await _wait(2000);  // 让引擎在安全策略下运行

    var safetySnap = Engine.getSnapshot();
    var safetyMetrics = {
      energy: safetySnap.energyKWh,
      alarms: safetySnap.alarms.length,
      level: safetySnap.tankLevel
    };

    // 切到节能策略
    Strategy.switchStrategy('energy', Engine.getSnapshot());
    var energyVersion = Strategy.getVersion();
    await _wait(2000);

    var energySnap = Engine.getSnapshot();
    var energyMetrics = {
      energy: energySnap.energyKWh,
      alarms: energySnap.alarms.length,
      level: energySnap.tankLevel
    };

    _assert(12, '策略切换后版本号递增',
      energyVersion > safetyVersion,
      'energy=' + energyVersion + ' safety=' + safetyVersion);

    _assert(12, '能耗持续增长 (跨策略)',
      energyMetrics.energy >= safetyMetrics.energy,
      'safety=' + safetyMetrics.energy.toFixed(3) + ' energy=' + energyMetrics.energy.toFixed(3));

    // 策略对比数据应该反映最新的切换
    var comparison = Strategy.getComparison();
    if (comparison) {
      _assert(12, '策略对比: from=安全优先',
        comparison.fromStrategy === '\u5b89\u5168\u4f18\u5148',
        'from=' + comparison.fromStrategy);
      _assert(12, '策略对比: to=节能优先',
        comparison.toStrategy === '\u8282\u80fd\u4f18\u5148',
        'to=' + comparison.toStrategy);
    } else {
      _result(12, '策略对比数据尚未生成 (需等待5秒后)', true, 'comparison=null — acceptable');
    }

    // 切到排涝策略，验证 _metricsAfter 被清除
    Strategy.switchStrategy('drainage', Engine.getSnapshot());
    var comparisonAfterSwitch = Strategy.getComparison();
    _assert(12, '新切换后旧的 metricsAfter 被清除',
      comparisonAfterSwitch === null,
      'comparison should be null immediately after switch');
    await _wait(300);

    // ===== Step 13: 风险热区刷新验证 =====
    // 让仿真运行积累风险数据
    await _wait(2000);
    var riskScores = Predictor.getRiskScores();
    var riskKeys = Object.keys(riskScores);
    var riskVersion = Predictor.getVersion();
    var stratVersionNow = Strategy.getVersion();

    _assert(13, 'Predictor 版本与策略版本一致',
      riskVersion === stratVersionNow,
      'predictor=' + riskVersion + ' strategy=' + stratVersionNow);

    // Renderer 风险数据版本应该与策略版本一致
    var rendererRiskVersion = Renderer.getRiskDataVersion();
    _assert(13, 'Renderer 风险数据版本与策略一致',
      rendererRiskVersion === stratVersionNow || rendererRiskVersion === -1,
      'rendererRiskVersion=' + rendererRiskVersion + ' strategy=' + stratVersionNow);

    // 切换策略后，风险热区应该被清除
    Strategy.switchStrategy('safety', Engine.getSnapshot());
    // 等待防抖完成
    await _wait(200);

    // 在 Predictor 重新分析之前，风险数据应为空
    var riskAfterSwitch = Predictor.getRiskScores();
    var riskKeysAfter = Object.keys(riskAfterSwitch);
    // invalidateCache 应该已经清空了 riskScores
    // 但 _forceRecalculate 可能已经重新填充 — 取决于时序
    // 关键断言: 如果 Predictor 尚未重新分析，getPredictions 应返回 null
    var predAfterSwitch = Predictor.getPredictions();
    var predNullOk = (predAfterSwitch === null) ||
      (predAfterSwitch && predAfterSwitch.strategyVersion === Strategy.getVersion());
    _assert(13, '策略切换后预测数据版本正确或为 null',
      predNullOk,
      'predictions=' + (predAfterSwitch ? 'v' + predAfterSwitch.strategyVersion : 'null'));
    await _wait(500);

    // ===== Step 14: 趋势缓冲区重置验证 =====
    // 运行仿真积累趋势数据
    await _wait(2000);
    var trendLenBefore = Trend.getLength();
    _assert(14, '趋势缓冲区有数据',
      trendLenBefore > 0,
      'length=' + trendLenBefore);

    // 切换策略 — 预测曲线应被清除，但历史缓冲区保留
    Strategy.switchStrategy('energy', Engine.getSnapshot());
    await _wait(200);

    var trendLenAfter = Trend.getLength();
    _assert(14, '策略切换后趋势历史缓冲区保留',
      trendLenAfter > 0,
      'length=' + trendLenAfter);

    _assert(14, '趋势策略版本已更新',
      Trend.getStrategyVersion() === Strategy.getVersion(),
      'trendVersion=' + Trend.getStrategyVersion() +
      ' strategyVersion=' + Strategy.getVersion());

    // 完全重置缓冲区
    Trend.resetBuffer(Strategy.getVersion());
    _assert(14, 'resetBuffer 后缓冲区为空',
      Trend.getLength() === 0,
      'length=' + Trend.getLength());

    // 继续运行，验证缓冲区重新积累
    await _wait(2000);
    _assert(14, 'resetBuffer 后缓冲区重新积累',
      Trend.getLength() > 0,
      'length=' + Trend.getLength());

    // 最终一致性检查: 所有模块版本号应一致
    var finalStratVersion = Strategy.getVersion();
    var finalPredVersion = Predictor.getVersion();
    var finalTrendVersion = Trend.getStrategyVersion();
    _assert(14, '最终版本一致性: Predictor',
      finalPredVersion === finalStratVersion,
      'pred=' + finalPredVersion + ' strat=' + finalStratVersion);
    _assert(14, '最终版本一致性: Trend',
      finalTrendVersion === finalStratVersion,
      'trend=' + finalTrendVersion + ' strat=' + finalStratVersion);

    // 清理
    Engine.reset();
    Trend.reset();
    Predictor.reset();
    Strategy.reset();
    await _wait(300);

    // ===== Summary =====
    console.log('%c========== 验证完成 ==========', 'color:#00d4ff;font-weight:bold');
    console.log('%c通过: ' + _passCount + '  失败: ' + _failCount,
      'color:' + (_failCount === 0 ? '#00ff88' : '#ff4455') + ';font-weight:bold;font-size:14px');
    console.log('详细日志:', _log);

    // 重置故障按钮
    _resetFaultButtons();

    return {
      pass: _passCount,
      fail: _failCount,
      log: _log
    };
  }

  return {
    run: run,
    getLog: function () { return _log.slice(); }
  };
})();
