/**
 * 智慧泵站系统 - 连续操作验证脚本
 *
 * 在浏览器控制台运行: App.runValidation()
 * 或加载此文件后运行: PumpStationTest.run()
 *
 * 覆盖场景:
 *   1. 快速模式切换同步性
 *   2. 泵停机时流量/功率归零
 *   3. 阀门状态与管道同步
 *   4. 水池液位全局一致
 *   5. 报警去重与确认持久化
 *   6. 定时器不重复启动
 *   7. 设备联锁顺序
 *   8. 暂停/恢复帧冻结
 *   9. 完整重置流程
 *  10. 帧快照与渲染帧一致
 *  11. 趋势数据一致性
 */
var PumpStationTest = (function(){
  'use strict';

  var results = [];
  var pass = 0, fail = 0;

  function assert(name, condition, detail) {
    var ok = !!condition;
    results.push({name:name, pass:ok, detail:detail||''});
    if(ok) pass++; else fail++;
    return ok;
  }

  function delay(ms) {
    return new Promise(function(resolve){ setTimeout(resolve, ms); });
  }

  function snap() { return App.getSnapshot(); }

  function findEq(s, id) {
    for(var i = 0; i < s.equipment.length; i++) {
      if(s.equipment[i].id === id) return s.equipment[i];
    }
    return null;
  }

  function findPipe(s, id) {
    for(var i = 0; i < s.pipes.length; i++) {
      if(s.pipes[i].id === id) return s.pipes[i];
    }
    return null;
  }

  function header(text) {
    console.log('%c\n--- ' + text + ' ---', 'color:#00d4ff;font-weight:bold;font-size:13px');
  }

  async function run() {
    results = []; pass = 0; fail = 0;
    console.clear();
    console.log('%c========================================', 'color:#00d4ff');
    console.log('%c  智慧泵站系统 连续操作验证', 'color:#00d4ff;font-size:16px;font-weight:bold');
    console.log('%c========================================', 'color:#00d4ff');

    /* ======== 1. 初始化验证 ======== */
    header('1. 初始化验证');
    App.resetAll();
    await delay(400);

    var s = snap();
    assert('1.1 快照已生成', !!s);
    assert('1.2 初始场景=normal', s && s.scene === 'normal');
    assert('1.3 初始模式=auto', s && s.mode === 'auto');
    assert('1.4 帧号>0', s && s.frameId > 0, 'frameId='+( s?s.frameId:'null'));
    assert('1.5 设备数=16', s && s.equipment.length === 16);
    assert('1.6 管道数=12', s && s.pipes.length === 12);

    /* ======== 2. 快速场景切换同步性 ======== */
    header('2. 快速场景切换 (每50ms切一次)');
    var scenes = ['highLevel','pumpFault','sensorOffline','nightLowLoad','normal',
                  'highLevel','normal','pumpFault','nightLowLoad','sensorOffline','normal'];
    for(var i = 0; i < scenes.length; i++) {
      App.switchScene(scenes[i]);
      await delay(50);
    }
    var s2 = snap();
    assert('2.1 最终场景=normal', s2 && s2.scene === 'normal');
    assert('2.2 帧号持续递增', s2 && s2.frameId > s.frameId, 'from='+s.frameId+' to='+s2.frameId);

    var renderFrame = Renderer.getAppliedFrameId();
    assert('2.3 渲染帧=快照帧', s2 && s2.frameId === renderFrame,
           'snap='+s2.frameId+' render='+renderFrame);

    /* ======== 3. 泵停→流量/功率归零 ======== */
    header('3. 泵停机 → 流量/功率必须为零');
    App.switchScene('pumpFault');
    await delay(300);
    var s3 = snap();

    var p1 = s3.sensorData.pump1;
    assert('3.1 故障泵(pump1)流量=0', p1 && p1.flow && p1.flow.value === 0, 'flow='+( p1?p1.flow.value:'?'));
    assert('3.2 故障泵(pump1)功率=0', p1 && p1.power && p1.power.value === 0, 'power='+( p1?p1.power.value:'?'));

    var p3 = s3.sensorData.pump3;
    assert('3.3 停机泵(pump3)流量=0', p3 && p3.flow && p3.flow.value === 0, 'flow='+( p3?p3.flow.value:'?'));
    assert('3.4 停机泵(pump3)功率=0', p3 && p3.power && p3.power.value === 0, 'power='+( p3?p3.power.value:'?'));
    assert('3.5 停机泵(pump3)压力=0', p3 && p3.pressure && p3.pressure.value === 0);

    var p2 = s3.sensorData.pump2;
    assert('3.6 运行泵(pump2)流量>0', p2 && p2.flow && p2.flow.value > 0, 'flow='+( p2?p2.flow.value:'?'));
    assert('3.7 运行泵(pump2)功率>0', p2 && p2.power && p2.power.value > 0, 'power='+( p2?p2.power.value:'?'));

    /* ======== 4. 阀门/管道同步 ======== */
    header('4. 阀门关闭 → 对应管道不活跃');
    var eq_v1 = findEq(s3, 'v1');
    var pipe_drop1 = findPipe(s3, 'drop1');
    assert('4.1 v1已停(pumpFault)', eq_v1 && eq_v1.state === 'stopped');
    assert('4.2 drop1管道不活跃', pipe_drop1 && pipe_drop1.active === false);

    var eq_v2 = findEq(s3, 'v2');
    var pipe_drop2 = findPipe(s3, 'drop2');
    assert('4.3 v2运行中', eq_v2 && eq_v2.state === 'running');
    assert('4.4 drop2管道活跃', pipe_drop2 && pipe_drop2.active === true);

    var pipe_riser1 = findPipe(s3, 'riser1');
    assert('4.5 故障泵riser1不活跃', pipe_riser1 && pipe_riser1.active === false);

    /* ======== 5. 水池液位全局一致 ======== */
    header('5. 液位全局一致性');
    var expectedLvl = Math.round(s3.tankLevel * 100);
    var allLevelOk = true;
    var levelMismatch = '';
    for(var eqId in s3.sensorData) {
      var d = s3.sensorData[eqId];
      if(d.level && d.level.value !== '--' && d.level.value !== expectedLvl) {
        allLevelOk = false;
        levelMismatch += eqId+'='+d.level.value+' ';
      }
    }
    assert('5.1 所有设备液位='+expectedLvl+'%', allLevelOk, levelMismatch || 'OK');

    App.switchScene('highLevel');
    await delay(200);
    var s5 = snap();
    var expectedLvl2 = Math.round(s5.tankLevel * 100);
    var allLevelOk2 = true;
    for(var eqId2 in s5.sensorData) {
      var d2 = s5.sensorData[eqId2];
      if(d2.level && d2.level.value !== '--' && d2.level.value !== expectedLvl2) { allLevelOk2 = false; }
    }
    assert('5.2 高液位场景液位='+expectedLvl2+'%', allLevelOk2);

    /* ======== 6. 报警去重与确认 ======== */
    header('6. 报警去重与确认持久化');
    App.switchScene('pumpFault');
    await delay(200);
    var s6 = snap();
    assert('6.1 有报警', s6.alarms.length > 0, 'count='+s6.alarms.length);

    var seen = {};
    var noDup = true;
    for(var ai = 0; ai < s6.alarms.length; ai++) {
      if(seen[s6.alarms[ai].text]) { noDup = false; break; }
      seen[s6.alarms[ai].text] = true;
    }
    assert('6.2 报警无重复文本', noDup);

    if(s6.alarms.length > 0) {
      var ackId = s6.alarms[0].id;
      var ackText = s6.alarms[0].text;
      App.ackAlarm(ackId);
      assert('6.3 确认后acked=true', s6.alarms[0].acked === true);

      /* 刷新快照，确认状态应保持 */
      App.pushSnapshot();
      await delay(200);
      var s6b = snap();
      var stillAcked = false;
      for(var bi = 0; bi < s6b.alarms.length; bi++) {
        if(s6b.alarms[bi].id === ackId) {
          stillAcked = s6b.alarms[bi].acked;
          break;
        }
      }
      assert('6.4 刷新后确认状态保持', stillAcked, 'alarm='+ackText);

      /* 确认的报警不应出现在DOM中 */
      var domAlarms = document.querySelectorAll('#alarmList li[data-alarm-id="'+ackId+'"]');
      assert('6.5 已确认报警不显示在列表', domAlarms.length === 0);
    }

    /* ======== 7. 联锁序列 ======== */
    header('7. 设备联锁顺序');
    var seq = DataModule.getInterlockSequence('normal','highLevel');
    assert('7.1 有联锁序列', seq.length > 0, 'steps='+seq.length);

    /* 验证 v3 在 pump3 之前启动 */
    var v3Idx = -1, p3Idx = -1;
    for(var si = 0; si < seq.length; si++) {
      if(seq[si].id === 'v3' && seq[si].action === 'start') v3Idx = si;
      if(seq[si].id === 'pump3' && seq[si].action === 'start') p3Idx = si;
    }
    assert('7.2 阀门v3先于泵pump3启动', v3Idx >= 0 && p3Idx >= 0 && v3Idx < p3Idx,
           'v3@'+v3Idx+' pump3@'+p3Idx);

    /* 反向：从highLevel到pumpFault，泵先停再关阀 */
    var seq2 = DataModule.getInterlockSequence('highLevel','pumpFault');
    var p1Stop = -1, v1Stop = -1;
    for(var si2 = 0; si2 < seq2.length; si2++) {
      if(seq2[si2].id === 'pump1' && seq2[si2].action === 'stop') p1Stop = si2;
      if(seq2[si2].id === 'v1' && seq2[si2].action === 'stop') v1Stop = si2;
    }
    if(p1Stop >= 0 && v1Stop >= 0) {
      assert('7.3 泵pump1先于阀v1停止', p1Stop < v1Stop, 'p1@'+p1Stop+' v1@'+v1Stop);
    }

    /* 联锁验证函数 */
    var iv = DataModule.validateInterlock('pump1','running', {v1:'stopped',v_inlet:'running'});
    assert('7.4 泵前阀未开→泵不可启动', !iv.valid, iv.reason);

    var iv2 = DataModule.validateInterlock('pump1','running', {v1:'running',v_inlet:'running'});
    assert('7.5 依赖满足→泵可启动', iv2.valid);

    var iv3 = DataModule.validateInterlock('v_inlet','stopped', {pump1:'running',pump2:'stopped',pump3:'stopped',v1:'running',v2:'stopped',v3:'stopped'});
    assert('7.6 泵运行时→进水阀不可关', !iv3.valid, iv3.reason);

    /* ======== 8. 暂停/恢复 ======== */
    header('8. 暂停/恢复帧冻结');
    App.switchScene('normal');
    await delay(300);
    var preFrame = snap().frameId;

    App.switchMode('paused');
    assert('8.1 渲染器已暂停', Renderer.isPaused());
    await delay(600);
    assert('8.2 暂停期间帧号不变', snap().frameId === preFrame, 'frame='+snap().frameId);

    App.switchMode('auto');
    assert('8.3 恢复后未暂停', !Renderer.isPaused());
    await delay(DATA_REFRESH_MS());
    assert('8.4 恢复后帧号增长', snap().frameId > preFrame, 'frame='+snap().frameId);

    /* ======== 9. 完整重置 ======== */
    header('9. 完整重置');
    App.switchScene('highLevel');
    App.switchMode('fault_sim');
    await delay(200);

    App.resetAll();
    await delay(500);
    var s9 = snap();
    assert('9.1 重置后场景=normal', s9 && s9.scene === 'normal');
    assert('9.2 重置后模式=auto', s9 && s9.mode === 'auto');
    assert('9.3 重置后无报警', s9 && s9.alarms.length === 0);
    assert('9.4 渲染器运行中', !Renderer.isPaused());

    /* ======== 10. 连续切换压力测试 ======== */
    header('10. 压力测试: 20次快速切换');
    var allScenes = ['normal','highLevel','pumpFault','sensorOffline','nightLowLoad'];
    for(var t = 0; t < 20; t++) {
      App.switchScene(allScenes[t % allScenes.length]);
    }
    await delay(200);
    var s10 = snap();
    var renderF = Renderer.getAppliedFrameId();
    assert('10.1 压力测试后快照帧=渲染帧', s10.frameId === renderF,
           'snap='+s10.frameId+' render='+renderF);

    /* 验证数据一致性：如果泵是停的，流量必须0 */
    var dataConsistent = true;
    for(var ei = 0; ei < s10.equipment.length; ei++) {
      var eq = s10.equipment[ei];
      if(eq.type !== 'pump') continue;
      var ed = s10.sensorData[eq.id];
      if(!ed) continue;
      if(eq.state === 'stopped' || eq.state === 'fault') {
        if(ed.flow && ed.flow.value !== 0 && ed.flow.value !== '--') {
          dataConsistent = false;
          console.log('  不一致: '+eq.id+' state='+eq.state+' flow='+ed.flow.value);
        }
      }
    }
    assert('10.2 压力测试后泵停=流量0', dataConsistent);

    /* ======== 11. 趋势数据一致 ======== */
    header('11. 趋势数据');
    App.resetAll();
    await delay(400);
    for(var tr = 0; tr < 5; tr++) {
      App.pushSnapshot();
      await delay(100);
    }
    /* 趋势数据通过 getSnapshot 的 frameId 递增可间接验证 */
    var sFinal = snap();
    assert('11.1 多次推送帧号递增', sFinal.frameId >= 5);

    /* ======== 结果汇总 ======== */
    console.log('\n%c========================================', 'color:#00d4ff');
    console.log('%c  验证结果汇总', 'color:#00d4ff;font-size:14px;font-weight:bold');
    console.log('%c========================================', 'color:#00d4ff');

    for(var r = 0; r < results.length; r++) {
      var res = results[r];
      console.log(
        '%c' + (res.pass ? ' PASS ' : ' FAIL ') + '%c ' + res.name +
        (res.detail ? ' %c(' + res.detail + ')' : ''),
        res.pass ? 'background:#1a3a2a;color:#00ff88' : 'background:#3a1515;color:#ff4455;font-weight:bold',
        'color:#c8d6e5',
        'color:#8899aa'
      );
    }

    var summary = '\n  通过: ' + pass + '/' + results.length + '  失败: ' + fail;
    console.log(
      '%c' + summary,
      fail === 0 ? 'color:#00ff88;font-weight:bold;font-size:14px' : 'color:#ff4455;font-weight:bold;font-size:14px'
    );

    if(fail === 0) {
      console.log('%c\n  所有验证通过! 系统状态同步正常。\n', 'color:#00ff88;font-size:13px');
    } else {
      console.log('%c\n  有 ' + fail + ' 项验证失败，请检查。\n', 'color:#ff4455;font-size:13px');
    }

    /* 恢复到正常状态 */
    App.resetAll();

    return { pass:pass, fail:fail, total:results.length, results:results };
  }

  function DATA_REFRESH_MS() { return 3500; }

  return { run: run };
})();
