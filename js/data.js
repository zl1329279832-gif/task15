var DataModule = (function () {
  'use strict';

  /* ============ 常量 ============ */
  var STATES = {
    RUNNING:'running', STOPPED:'stopped', FAULT:'fault',
    MAINTENANCE:'maintenance', OFFLINE:'offline'
  };
  var STATE_LABELS = {
    running:'运行', stopped:'停机', fault:'故障',
    maintenance:'检修', offline:'离线'
  };

  var MODES = {
    AUTO:'auto', MANUAL:'manual', FAULT_SIM:'fault_sim', PAUSED:'paused'
  };
  var MODE_LABELS = {
    auto:'自动运行', manual:'手动控制', fault_sim:'故障模拟', paused:'系统暂停'
  };

  /* ============ 设备定义 ============ */
  var equipment = [
    {id:'pump1',type:'pump',name:'1#水泵',rx:0.22,ry:0.62,state:'running'},
    {id:'pump2',type:'pump',name:'2#水泵',rx:0.37,ry:0.62,state:'running'},
    {id:'pump3',type:'pump',name:'3#水泵',rx:0.52,ry:0.62,state:'stopped'},
    {id:'v_inlet',type:'valve',name:'进水阀',rx:0.09,ry:0.40,state:'running',pipe:'inlet'},
    {id:'v_outlet',type:'valve',name:'出水阀',rx:0.67,ry:0.40,state:'running',pipe:'outlet'},
    {id:'v1',type:'valve',name:'1#泵前阀',rx:0.22,ry:0.52,state:'running',pipe:'drop1'},
    {id:'v2',type:'valve',name:'2#泵前阀',rx:0.37,ry:0.52,state:'running',pipe:'drop2'},
    {id:'v3',type:'valve',name:'3#泵前阀',rx:0.52,ry:0.52,state:'stopped',pipe:'drop3'},
    {id:'s_flow_in',type:'sensor',name:'进水流量计',rx:0.05,ry:0.40,state:'running',sensorType:'flow'},
    {id:'s_press_in',type:'sensor',name:'进口压力变送器',rx:0.13,ry:0.40,state:'running',sensorType:'pressure'},
    {id:'s_level',type:'sensor',name:'水池液位计',rx:0.80,ry:0.32,state:'running',sensorType:'level',tankId:'tank'},
    {id:'s_flow_out',type:'sensor',name:'出水流量计',rx:0.71,ry:0.40,state:'running',sensorType:'flow'},
    {id:'s_temp',type:'sensor',name:'泵组温度传感器',rx:0.30,ry:0.73,state:'running',sensorType:'temperature'},
    {id:'tank',type:'tank',name:'清水池',rx:0.80,ry:0.50,state:'running'},
    {id:'cabinet',type:'cabinet',name:'主电控柜',rx:0.58,ry:0.36,state:'running'},
    {id:'alarm_light',type:'alarm_light',name:'声光报警器',rx:0.35,ry:0.24,state:'stopped'}
  ];

  var pipes = [
    {id:'inlet',color:'#3388cc',active:true,points:[[0.00,0.40],[0.17,0.40]]},
    {id:'header',color:'#3388cc',active:true,points:[[0.17,0.40],[0.56,0.40]]},
    {id:'drop1',color:'#3388cc',active:true,points:[[0.22,0.40],[0.22,0.58]]},
    {id:'drop2',color:'#3388cc',active:true,points:[[0.37,0.40],[0.37,0.58]]},
    {id:'drop3',color:'#3388cc',active:false,points:[[0.52,0.40],[0.52,0.58]]},
    {id:'riser1',color:'#2299aa',active:true,points:[[0.22,0.66],[0.22,0.46],[0.62,0.46]]},
    {id:'riser2',color:'#2299aa',active:true,points:[[0.37,0.66],[0.37,0.46]]},
    {id:'riser3',color:'#2299aa',active:false,points:[[0.52,0.66],[0.52,0.46]]},
    {id:'discharge',color:'#2299aa',active:true,points:[[0.62,0.46],[0.62,0.40]]},
    {id:'outlet',color:'#2299aa',active:true,points:[[0.62,0.40],[0.74,0.40]]},
    {id:'tank_in',color:'#2299aa',active:true,points:[[0.74,0.40],[0.74,0.38],[0.76,0.38]]},
    {id:'drain',color:'#446688',active:true,points:[[0.84,0.65],[0.84,0.78],[0.95,0.78]]}
  ];

  var tank = {
    id:'tank',rx:0.80,ry:0.50,rw:0.14,rh:0.35,
    level:0.60,targetLevel:0.60,levelHigh:0.85,levelLow:0.20
  };

  var buildings = {
    pumpHouse:{rx:0.14,ry:0.28,rw:0.50,rh:0.52},
    ground:{ry:0.80}
  };

  /* ============ 场景定义 ============ */
  var scenes = {
    normal:{
      label:'正常运行',tankLevel:0.60,isNight:false,
      equipment:{
        pump1:'running',pump2:'running',pump3:'stopped',
        v_inlet:'running',v_outlet:'running',v1:'running',v2:'running',v3:'stopped',
        s_flow_in:'running',s_press_in:'running',s_level:'running',s_flow_out:'running',s_temp:'running',
        tank:'running',cabinet:'running',alarm_light:'stopped'
      },
      activePipes:['inlet','header','drop1','drop2','riser1','riser2','discharge','outlet','tank_in','drain'],
      alarms:[]
    },
    highLevel:{
      label:'液位过高',tankLevel:0.92,isNight:false,
      equipment:{
        pump1:'running',pump2:'running',pump3:'running',
        v_inlet:'running',v_outlet:'running',v1:'running',v2:'running',v3:'running',
        s_flow_in:'running',s_press_in:'running',s_level:'running',s_flow_out:'running',s_temp:'running',
        tank:'running',cabinet:'running',alarm_light:'running'
      },
      activePipes:['inlet','header','drop1','drop2','drop3','riser1','riser2','riser3','discharge','outlet','tank_in','drain'],
      alarms:[
        {level:'critical',text:'水池液位超高限 (92%)',time:'14:32:18'},
        {level:'warning',text:'3#水泵紧急启动',time:'14:32:20'},
        {level:'warning',text:'出水流量激增',time:'14:32:25'},
        {level:'info',text:'已通知值班工程师',time:'14:32:30'}
      ]
    },
    pumpFault:{
      label:'泵组故障',tankLevel:0.45,isNight:false,
      equipment:{
        pump1:'fault',pump2:'running',pump3:'stopped',
        v_inlet:'running',v_outlet:'running',v1:'stopped',v2:'running',v3:'stopped',
        s_flow_in:'running',s_press_in:'running',s_level:'running',s_flow_out:'running',s_temp:'running',
        tank:'running',cabinet:'running',alarm_light:'running'
      },
      activePipes:['inlet','header','drop2','riser2','discharge','outlet','tank_in','drain'],
      alarms:[
        {level:'critical',text:'1#水泵过流保护动作',time:'09:15:42'},
        {level:'critical',text:'1#水泵绕组温度过高',time:'09:15:43'},
        {level:'warning',text:'系统出力降低 33%',time:'09:15:45'},
        {level:'warning',text:'1#泵前阀已联锁关闭',time:'09:15:48'},
        {level:'info',text:'维修工单已派发',time:'09:16:00'}
      ]
    },
    sensorOffline:{
      label:'传感器离线',tankLevel:0.55,isNight:false,
      equipment:{
        pump1:'running',pump2:'running',pump3:'stopped',
        v_inlet:'running',v_outlet:'running',v1:'running',v2:'running',v3:'stopped',
        s_flow_in:'offline',s_press_in:'running',s_level:'offline',s_flow_out:'running',s_temp:'running',
        tank:'running',cabinet:'running',alarm_light:'running'
      },
      activePipes:['inlet','header','drop1','drop2','riser1','riser2','discharge','outlet','tank_in','drain'],
      alarms:[
        {level:'critical',text:'进水流量计通信中断',time:'11:08:33'},
        {level:'critical',text:'水池液位计数据丢失',time:'11:08:35'},
        {level:'warning',text:'自动调控模式降级为手动',time:'11:08:40'},
        {level:'info',text:'运维人员已出发巡检',time:'11:09:00'}
      ]
    },
    nightLowLoad:{
      label:'夜间低负载',tankLevel:0.40,isNight:true,
      equipment:{
        pump1:'running',pump2:'stopped',pump3:'stopped',
        v_inlet:'running',v_outlet:'running',v1:'running',v2:'stopped',v3:'stopped',
        s_flow_in:'running',s_press_in:'running',s_level:'running',s_flow_out:'running',s_temp:'running',
        tank:'running',cabinet:'running',alarm_light:'stopped'
      },
      activePipes:['inlet','header','drop1','riser1','discharge','outlet','tank_in','drain'],
      alarms:[
        {level:'info',text:'夜间低负载模式已启用',time:'23:00:00'},
        {level:'info',text:'仅1#水泵低频运行',time:'23:00:05'}
      ]
    }
  };

  /* ============ 数据范围 ============ */
  var dataRanges = {
    running:{
      flow:{min:180,max:320,unit:'m\u00B3/h'},
      pressure:{min:0.30,max:0.65,unit:'MPa',decimals:2},
      level:{min:40,max:80,unit:'%'},
      temperature:{min:35,max:55,unit:'\u00B0C'},
      power:{min:45,max:120,unit:'kW'},
      runtime:{min:1000,max:9999,unit:'h',decimals:0}
    },
    stopped:{
      flow:{min:0,max:0,unit:'m\u00B3/h'},
      pressure:{min:0,max:0,unit:'MPa',decimals:2},
      level:{min:40,max:80,unit:'%'},
      temperature:{min:20,max:28,unit:'\u00B0C'},
      power:{min:0,max:0,unit:'kW'},
      runtime:{min:1000,max:9999,unit:'h',decimals:0}
    },
    fault:{
      flow:{min:0,max:50,unit:'m\u00B3/h'},
      pressure:{min:0,max:0.15,unit:'MPa',decimals:2},
      level:{min:40,max:80,unit:'%'},
      temperature:{min:75,max:95,unit:'\u00B0C'},
      power:{min:0,max:10,unit:'kW'},
      runtime:{min:1000,max:9999,unit:'h',decimals:0}
    },
    maintenance:{
      flow:{min:0,max:0,unit:'m\u00B3/h'},
      pressure:{min:0,max:0,unit:'MPa',decimals:2},
      level:{min:40,max:80,unit:'%'},
      temperature:{min:20,max:25,unit:'\u00B0C'},
      power:{min:0,max:0,unit:'kW'},
      runtime:{min:1000,max:9999,unit:'h',decimals:0}
    },
    offline:{
      flow:{min:null,max:null,unit:'m\u00B3/h'},
      pressure:{min:null,max:null,unit:'MPa',decimals:2},
      level:{min:null,max:null,unit:'%'},
      temperature:{min:null,max:null,unit:'\u00B0C'},
      power:{min:null,max:null,unit:'kW'},
      runtime:{min:null,max:null,unit:'h',decimals:0}
    }
  };

  /* ============ 设备联动依赖图 ============ */
  var interlock = {
    pump1: { startDeps: ['v1','v_inlet'], stopBefore: [] },
    pump2: { startDeps: ['v2','v_inlet'], stopBefore: [] },
    pump3: { startDeps: ['v3','v_inlet'], stopBefore: [] },
    v1:    { startDeps: ['v_inlet'], stopBefore: ['pump1'] },
    v2:    { startDeps: ['v_inlet'], stopBefore: ['pump2'] },
    v3:    { startDeps: ['v_inlet'], stopBefore: ['pump3'] },
    v_inlet:  { startDeps: [], stopBefore: ['pump1','pump2','pump3','v1','v2','v3'] },
    v_outlet: { startDeps: [], stopBefore: [] }
  };

  /* 泵->管道映射 */
  var pumpPipeMap = {
    pump1: { drop:'drop1', riser:'riser1' },
    pump2: { drop:'drop2', riser:'riser2' },
    pump3: { drop:'drop3', riser:'riser3' }
  };

  /* ============ 工具函数 ============ */
  function rand(a,b){ return a + Math.random() * (b - a); }

  function generateData(state){
    var r = dataRanges[state] || dataRanges.stopped, d = {}, keys = Object.keys(r);
    for(var i = 0; i < keys.length; i++){
      var k = keys[i], c = r[k];
      if(c.min === null){ d[k] = {value:'--', unit:c.unit}; }
      else {
        var v = rand(c.min, c.max);
        d[k] = {value: c.decimals !== undefined ? parseFloat(v.toFixed(c.decimals)) : Math.round(v), unit:c.unit};
      }
    }
    return d;
  }

  function generateSceneData(sn){
    var sc = scenes[sn]; if(!sc) return {};
    var res = {};
    for(var i = 0; i < equipment.length; i++){
      var eq = equipment[i], st = sc.equipment[eq.id] || eq.state;
      res[eq.id] = generateData(st);
    }
    return res;
  }

  /* ============ 帧快照系统 ============ */
  var _frameSeq = 0;

  function createSnapshot(sceneName, mode, prevSnapshot) {
    var scene = scenes[sceneName];
    if (!scene) return null;

    _frameSeq++;
    var snap = {
      frameId: _frameSeq,
      timestamp: Date.now(),
      mode: mode || MODES.AUTO,
      scene: sceneName,
      sceneLabel: scene.label,
      isNight: !!scene.isNight,
      tankLevel: scene.tankLevel,
      equipment: [],
      pipes: [],
      sensorData: {},
      alarms: [],
      stats: { total: 0, running: 0, alarm: 0 }
    };

    /* 深拷贝设备状态 */
    for (var i = 0; i < equipment.length; i++) {
      var eq = equipment[i];
      var state = scene.equipment[eq.id] !== undefined ? scene.equipment[eq.id] : eq.state;
      snap.equipment.push({
        id: eq.id, type: eq.type, name: eq.name,
        rx: eq.rx, ry: eq.ry, state: state,
        pipe: eq.pipe, sensorType: eq.sensorType, tankId: eq.tankId
      });
    }

    /* 管道状态快照 */
    var activePipeSet = {};
    for (var j = 0; j < scene.activePipes.length; j++) {
      activePipeSet[scene.activePipes[j]] = true;
    }
    for (var k = 0; k < pipes.length; k++) {
      var p = pipes[k];
      snap.pipes.push({
        id: p.id, color: p.color, active: !!activePipeSet[p.id],
        points: p.points
      });
    }

    /* 物理关联传感器数据 */
    snap.sensorData = generateCorrelatedData(snap);

    /* 报警去重 + 保留确认状态 */
    snap.alarms = processAlarms(scene.alarms, sceneName, prevSnapshot);

    /* 统计 */
    snap.stats.total = snap.equipment.length;
    for (var m = 0; m < snap.equipment.length; m++) {
      if (snap.equipment[m].state === 'running') snap.stats.running++;
      if (snap.equipment[m].state === 'fault' || snap.equipment[m].state === 'offline') snap.stats.alarm++;
    }

    return snap;
  }

  /* 物理关联数据生成 - 泵运行数决定流量/压力/能耗 */
  function generateCorrelatedData(snap) {
    var data = {};
    var runningPumps = 0;

    for (var i = 0; i < snap.equipment.length; i++) {
      if (snap.equipment[i].type === 'pump' && snap.equipment[i].state === 'running') runningPumps++;
    }

    var pumpRatio = runningPumps / 3;
    var baseFlow = runningPumps > 0 ? (pumpRatio * 280 + rand(-15, 15)) : 0;
    var basePressure = runningPumps > 0 ? (pumpRatio * 0.50 + rand(-0.03, 0.03)) : 0;
    var basePower = runningPumps * 55 + (runningPumps > 0 ? rand(-8, 8) : 0);
    var tankPct = Math.round(snap.tankLevel * 100);

    for (var j = 0; j < snap.equipment.length; j++) {
      var eq = snap.equipment[j];
      var st = eq.state;
      var d;

      if (eq.type === 'pump') {
        if (st === 'running') {
          var perPumpFlow = runningPumps > 0 ? Math.round(baseFlow / runningPumps + rand(-8, 8)) : 0;
          var perPumpPower = runningPumps > 0 ? Math.round(basePower / runningPumps + rand(-4, 4)) : 0;
          d = {
            flow:        {value: perPumpFlow, unit:'m\u00B3/h'},
            pressure:    {value: parseFloat((basePressure + rand(-0.02, 0.02)).toFixed(2)), unit:'MPa'},
            level:       {value: tankPct, unit:'%'},
            temperature: {value: Math.round(rand(38, 52)), unit:'\u00B0C'},
            power:       {value: perPumpPower, unit:'kW'},
            runtime:     {value: Math.round(rand(1000, 9999)), unit:'h'}
          };
        } else if (st === 'fault') {
          d = {
            flow:        {value: 0, unit:'m\u00B3/h'},
            pressure:    {value: 0, unit:'MPa'},
            level:       {value: tankPct, unit:'%'},
            temperature: {value: Math.round(rand(75, 95)), unit:'\u00B0C'},
            power:       {value: 0, unit:'kW'},
            runtime:     {value: Math.round(rand(1000, 9999)), unit:'h'}
          };
        } else {
          d = {
            flow:        {value: 0, unit:'m\u00B3/h'},
            pressure:    {value: 0, unit:'MPa'},
            level:       {value: tankPct, unit:'%'},
            temperature: {value: Math.round(rand(20, 28)), unit:'\u00B0C'},
            power:       {value: 0, unit:'kW'},
            runtime:     {value: Math.round(rand(1000, 9999)), unit:'h'}
          };
        }
      } else if (eq.type === 'sensor') {
        if (st === 'offline') {
          d = generateData('offline');
        } else {
          d = {
            flow:        {value: Math.round(baseFlow + rand(-3, 3)), unit:'m\u00B3/h'},
            pressure:    {value: parseFloat((basePressure + rand(-0.01, 0.01)).toFixed(2)), unit:'MPa'},
            level:       {value: tankPct, unit:'%'},
            temperature: {value: Math.round(rand(35, 50)), unit:'\u00B0C'},
            power:       {value: Math.round(basePower + rand(-3, 3)), unit:'kW'},
            runtime:     {value: Math.round(rand(1000, 9999)), unit:'h'}
          };
        }
      } else {
        d = generateData(st);
        if (d.level) d.level = {value: tankPct, unit:'%'};
      }

      data[eq.id] = d;
    }
    return data;
  }

  /* 报警去重 + 确认状态保持 */
  function processAlarms(sceneAlarms, sceneName, prevSnapshot) {
    if (!sceneAlarms || sceneAlarms.length === 0) return [];

    var ackedSet = {};
    if (prevSnapshot && prevSnapshot.scene === sceneName && prevSnapshot.alarms) {
      for (var i = 0; i < prevSnapshot.alarms.length; i++) {
        if (prevSnapshot.alarms[i].acked) {
          ackedSet[prevSnapshot.alarms[i].id] = true;
        }
      }
    }

    var result = [];
    var seenTexts = {};
    for (var j = 0; j < sceneAlarms.length; j++) {
      var a = sceneAlarms[j];
      var alarmId = sceneName + ':' + j;

      if (seenTexts[a.text]) continue;
      seenTexts[a.text] = true;

      result.push({
        id: alarmId,
        level: a.level,
        text: a.text,
        time: a.time,
        acked: !!ackedSet[alarmId]
      });
    }
    return result;
  }

  /* ============ 联动验证 ============ */
  function validateInterlock(eqId, targetState, currentStates) {
    var rule = interlock[eqId];
    if (!rule) return { valid: true, reason: '' };

    if (targetState === 'running') {
      for (var i = 0; i < rule.startDeps.length; i++) {
        var depId = rule.startDeps[i];
        if (currentStates[depId] !== 'running') {
          return { valid: false, reason: depId + ' 必须先启动' };
        }
      }
    } else if (targetState === 'stopped') {
      for (var j = 0; j < rule.stopBefore.length; j++) {
        var dep2 = rule.stopBefore[j];
        if (currentStates[dep2] === 'running') {
          return { valid: false, reason: dep2 + ' 必须先停止' };
        }
      }
    }
    return { valid: true, reason: '' };
  }

  /* 获取场景切换的联锁执行序列 */
  function getInterlockSequence(fromScene, toScene) {
    var src = scenes[fromScene], dst = scenes[toScene];
    if (!src || !dst) return [];

    var toStop = [], toStart = [], unchanged = [];
    for (var i = 0; i < equipment.length; i++) {
      var eq = equipment[i];
      var srcSt = src.equipment[eq.id] || 'stopped';
      var dstSt = dst.equipment[eq.id] || 'stopped';
      if (srcSt === dstSt) { unchanged.push(eq.id); continue; }
      if (dstSt === 'running' && srcSt !== 'running') toStart.push(eq.id);
      else if (dstSt !== 'running' && srcSt === 'running') toStop.push(eq.id);
      else unchanged.push(eq.id);
    }

    /* 停止顺序: 下游先停 (泵 -> 泵前阀 -> 主阀) */
    var stopPriority = {pump1:0,pump2:1,pump3:2,v1:3,v2:4,v3:5,v_outlet:6,v_inlet:7};
    toStop.sort(function(a,b){ return (stopPriority[a]||99) - (stopPriority[b]||99); });

    /* 启动顺序: 上游先开 (主阀 -> 泵前阀 -> 泵) */
    var startPriority = {v_inlet:0,v_outlet:1,v1:2,v2:3,v3:4,pump1:5,pump2:6,pump3:7};
    toStart.sort(function(a,b){ return (startPriority[a]||99) - (startPriority[b]||99); });

    var sequence = [];
    for (var s = 0; s < toStop.length; s++) {
      sequence.push({ id: toStop[s], action: 'stop', target: dst.equipment[toStop[s]] || 'stopped' });
    }
    for (var t = 0; t < toStart.length; t++) {
      sequence.push({ id: toStart[t], action: 'start', target: dst.equipment[toStart[t]] || 'running' });
    }
    return sequence;
  }

  function resetFrameSeq() { _frameSeq = 0; }

  /* ============ 导出 ============ */
  return {
    STATES:STATES, STATE_LABELS:STATE_LABELS,
    MODES:MODES, MODE_LABELS:MODE_LABELS,
    equipment:equipment, pipes:pipes, tank:tank, buildings:buildings,
    scenes:scenes, dataRanges:dataRanges,
    interlock:interlock, pumpPipeMap:pumpPipeMap,
    generateData:generateData, generateSceneData:generateSceneData,
    createSnapshot:createSnapshot, processAlarms:processAlarms,
    validateInterlock:validateInterlock, getInterlockSequence:getInterlockSequence,
    resetFrameSeq:resetFrameSeq
  };
})();
