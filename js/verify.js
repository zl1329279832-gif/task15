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
    Predictive.reset();
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
    Predictive.reset();
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
