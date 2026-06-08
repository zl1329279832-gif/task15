var DataModule = (function () {
  'use strict';
  var STATES = {
    RUNNING:'running', STOPPED:'stopped', FAULT:'fault',
    MAINTENANCE:'maintenance', OFFLINE:'offline'
  };
  var STATE_LABELS = {
    running:'运行', stopped:'停机', fault:'故障',
    maintenance:'检修', offline:'离线'
  };
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
  function rand(a,b){return a+Math.random()*(b-a)}
  function generateData(state){
    var r=dataRanges[state]||dataRanges.stopped, d={}, keys=Object.keys(r);
    for(var i=0;i<keys.length;i++){
      var k=keys[i],c=r[k];
      if(c.min===null){d[k]={value:'--',unit:c.unit}}
      else{
        var v=rand(c.min,c.max);
        d[k]={value:c.decimals!==undefined?parseFloat(v.toFixed(c.decimals)):Math.round(v),unit:c.unit};
      }
    }
    return d;
  }
  function generateSceneData(sn){
    var sc=scenes[sn];if(!sc)return {};
    var res={};
    for(var i=0;i<equipment.length;i++){
      var eq=equipment[i],st=sc.equipment[eq.id]||eq.state;
      res[eq.id]=generateData(st);
    }
    return res;
  }
  return{
    STATES:STATES,STATE_LABELS:STATE_LABELS,
    equipment:equipment,pipes:pipes,tank:tank,buildings:buildings,scenes:scenes,
    generateData:generateData,generateSceneData:generateSceneData
  };
})();
