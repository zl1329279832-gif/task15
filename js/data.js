/**
 * DataModule - 智慧泵站静态拓扑与配置
 * 仅包含设备模板、管道布局、水池参数、联动规则等不变数据
 * 所有运行时状态由 Engine 管理，此模块不含任何动态逻辑
 */
var DataModule = (function () {
  'use strict';

  var STATE_LABELS = {
    running: '\u8fd0\u884c', stopped: '\u505c\u673a', fault: '\u6545\u969c',
    maintenance: '\u68c0\u4fee', offline: '\u79bb\u7ebf'
  };

  /* ---------- 设备拓扑 (16 台) ---------- */
  var equipment = [
    {id:'pump1',       type:'pump',        name:'1#\u6c34\u6cf5',        rx:0.22, ry:0.62},
    {id:'pump2',       type:'pump',        name:'2#\u6c34\u6cf5',        rx:0.37, ry:0.62},
    {id:'pump3',       type:'pump',        name:'3#\u6c34\u6cf5',        rx:0.52, ry:0.62},
    {id:'v_inlet',     type:'valve',       name:'\u8fdb\u6c34\u9600',   rx:0.09, ry:0.40},
    {id:'v_outlet',    type:'valve',       name:'\u51fa\u6c34\u9600',   rx:0.67, ry:0.40},
    {id:'v1',          type:'valve',       name:'1#\u6cf5\u524d\u9600', rx:0.22, ry:0.52},
    {id:'v2',          type:'valve',       name:'2#\u6cf5\u524d\u9600', rx:0.37, ry:0.52},
    {id:'v3',          type:'valve',       name:'3#\u6cf5\u524d\u9600', rx:0.52, ry:0.52},
    {id:'s_flow_in',   type:'sensor',      name:'\u8fdb\u6c34\u6d41\u91cf\u8ba1',    rx:0.05, ry:0.40, sensorType:'flow'},
    {id:'s_press_in',  type:'sensor',      name:'\u8fdb\u53e3\u538b\u529b\u53d8\u9001\u5668', rx:0.13, ry:0.40, sensorType:'pressure'},
    {id:'s_level',     type:'sensor',      name:'\u6c34\u6c60\u6db2\u4f4d\u8ba1',    rx:0.80, ry:0.32, sensorType:'level'},
    {id:'s_flow_out',  type:'sensor',      name:'\u51fa\u6c34\u6d41\u91cf\u8ba1',    rx:0.71, ry:0.40, sensorType:'flow'},
    {id:'s_temp',      type:'sensor',      name:'\u6cf5\u7ec4\u6e29\u5ea6\u4f20\u611f\u5668', rx:0.30, ry:0.73, sensorType:'temperature'},
    {id:'tank',        type:'tank',        name:'\u6e05\u6c34\u6c60',   rx:0.80, ry:0.50},
    {id:'cabinet',     type:'cabinet',     name:'\u4e3b\u7535\u63a7\u67dc', rx:0.58, ry:0.36},
    {id:'alarm_light', type:'alarm_light', name:'\u58f0\u5149\u62a5\u8b66\u5668', rx:0.35, ry:0.24}
  ];

  /* ---------- 管道 (12 段) ---------- */
  var pipes = [
    {id:'inlet',    color:'#3388cc', points:[[0.00,0.40],[0.17,0.40]]},
    {id:'header',   color:'#3388cc', points:[[0.17,0.40],[0.56,0.40]]},
    {id:'drop1',    color:'#3388cc', points:[[0.22,0.40],[0.22,0.58]]},
    {id:'drop2',    color:'#3388cc', points:[[0.37,0.40],[0.37,0.58]]},
    {id:'drop3',    color:'#3388cc', points:[[0.52,0.40],[0.52,0.58]]},
    {id:'riser1',   color:'#2299aa', points:[[0.22,0.66],[0.22,0.46],[0.62,0.46]]},
    {id:'riser2',   color:'#2299aa', points:[[0.37,0.66],[0.37,0.46]]},
    {id:'riser3',   color:'#2299aa', points:[[0.52,0.66],[0.52,0.46]]},
    {id:'discharge',color:'#2299aa', points:[[0.62,0.46],[0.62,0.40]]},
    {id:'outlet',   color:'#2299aa', points:[[0.62,0.40],[0.74,0.40]]},
    {id:'tank_in',  color:'#2299aa', points:[[0.74,0.40],[0.74,0.38],[0.76,0.38]]},
    {id:'drain',    color:'#446688', points:[[0.84,0.65],[0.84,0.78],[0.95,0.78]]}
  ];

  /* ---------- 水池几何 + 物理 ---------- */
  var tankGeom = {rx:0.80, ry:0.50, rw:0.14, rh:0.35};
  var tankPhysics = {
    area: 100,
    levelHigh: 0.85,
    levelLow: 0.20,
    levelHighHigh: 0.95,
    initialLevel: 0.60
  };

  /* ---------- 泵组参数 ---------- */
  var pumpConfig = {
    ratedFlow: 250,
    ratedPressure: 0.45,
    ratedPower: 90,
    maxTemp: 75,
    maxTempFault: 90
  };

  /* ---------- 进/出水边界 ---------- */
  var boundary = {
    inletFlow: 480,
    drainCoeff: 120,
    backPressure: 0.10
  };

  /* ---------- 初始状态 ---------- */
  var initialState = {
    pump1:'running',  pump2:'running',  pump3:'stopped',
    v_inlet:'running', v_outlet:'running',
    v1:'running',     v2:'running',     v3:'stopped',
    s_flow_in:'running', s_press_in:'running', s_level:'running',
    s_flow_out:'running', s_temp:'running',
    tank:'running',   cabinet:'running', alarm_light:'stopped'
  };

  /* ---------- 联动规则 ---------- */
  var linkageRules = [
    {
      trigger:'pump1:fault', mode:'auto',
      actions:[{target:'v1',state:'stopped'},{target:'pump3',state:'running'},{target:'v3',state:'running'}],
      alarmKey:'linkage:pump1_fault',
      alarmText:'1#\u6cf5\u6545\u969c\u8054\u9501\uff1a\u5173\u95ed1#\u6cf5\u524d\u9600\uff0c\u542f\u52a83#\u6cf5'
    },
    {
      trigger:'pump2:fault', mode:'auto',
      actions:[{target:'v2',state:'stopped'},{target:'pump3',state:'running'},{target:'v3',state:'running'}],
      alarmKey:'linkage:pump2_fault',
      alarmText:'2#\u6cf5\u6545\u969c\u8054\u9501\uff1a\u5173\u95ed2#\u6cf5\u524d\u9600\uff0c\u542f\u52a83#\u6cf5'
    },
    {
      trigger:'tank:level_high_high', mode:'auto',
      actions:[{target:'v_inlet',state:'stopped'}],
      alarmKey:'linkage:tank_overflow',
      alarmText:'\u6c34\u6c60\u8d85\u9ad8\u6db2\u4f4d\u8054\u9501\uff1a\u5173\u95ed\u8fdb\u6c34\u9600'
    }
  ];

  /* ---------- 管道激活映射 ---------- */
  var pipePumpMap = {
    pump1:{valve:'v1', drop:'drop1', riser:'riser1'},
    pump2:{valve:'v2', drop:'drop2', riser:'riser2'},
    pump3:{valve:'v3', drop:'drop3', riser:'riser3'}
  };
  var alwaysActivePipes = ['inlet','header','discharge','outlet','tank_in','drain'];

  /* ---------- 渲染尺寸 ---------- */
  var SIZES = {
    pump:{rw:0.055,rh:0.08}, valve:{rw:0.028,rh:0.028},
    sensor:{rw:0.022,rh:0.035}, tank:{rw:0.14,rh:0.35},
    cabinet:{rw:0.055,rh:0.11}, alarm_light:{rw:0.03,rh:0.04}
  };

  var buildings = {
    pumpHouse:{rx:0.14,ry:0.28,rw:0.50,rh:0.52},
    ground:{ry:0.80}
  };

  return {
    STATE_LABELS:STATE_LABELS,
    equipment:equipment, pipes:pipes,
    tankGeom:tankGeom, tankPhysics:tankPhysics,
    pumpConfig:pumpConfig, boundary:boundary,
    initialState:initialState, linkageRules:linkageRules,
    pipePumpMap:pipePumpMap, alwaysActivePipes:alwaysActivePipes,
    SIZES:SIZES, buildings:buildings
  };
})();
