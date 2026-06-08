var App=(function(){
  'use strict';
  var dom={},DATA_REFRESH_INTERVAL=3000,dataTimer=null,resizeTimer=null;
  var currentScene='normal',selectedEqId=null,sceneData={};
  var STATE_BG={running:'rgba(0,255,136,0.12)',stopped:'rgba(102,119,136,0.10)',fault:'rgba(255,68,85,0.12)',maintenance:'rgba(255,170,0,0.12)',offline:'rgba(85,102,119,0.10)'};

  function init(){cacheDom();initRenderer();bindEvents();switchScene('normal');startDataRefresh();updateClock();setInterval(updateClock,1000)}

  function cacheDom(){
    dom.canvas=document.getElementById('scene');dom.sceneBar=document.getElementById('sceneBar');
    dom.panelContent=document.getElementById('panelContent');dom.alarmList=document.getElementById('alarmList');
    dom.sceneLabel=document.getElementById('sceneLabel');dom.headerTime=document.getElementById('headerTime');
    dom.statTotal=document.getElementById('statTotal');dom.statRunning=document.getElementById('statRunning');
    dom.statAlarm=document.getElementById('statAlarm');dom.statFPS=document.getElementById('statFPS');
    dom.perfInfo=document.getElementById('perfInfo');
  }
  function initRenderer(){
    Renderer.init(dom.canvas,DataModule.equipment,DataModule.pipes,DataModule.tank,DataModule.buildings);
    Renderer.start();setInterval(function(){dom.statFPS.textContent=Renderer.getFPS()},1000);
  }

  function bindEvents(){
    dom.canvas.addEventListener('click',onCanvasClick,false);
    dom.canvas.addEventListener('mousemove',onCanvasMove,false);
    var btns=dom.sceneBar.querySelectorAll('.scene-btn');
    for(var i=0;i<btns.length;i++)btns[i].addEventListener('click',onSceneBtnClick,false);
    window.addEventListener('resize',function(){clearTimeout(resizeTimer);resizeTimer=setTimeout(function(){Renderer.resize()},200)},false);
  }
  function onCanvasClick(e){
    var rect=dom.canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
    var hitId=Renderer.hitTest(x,y);if(hitId)selectEquipment(hitId);else deselectEquipment();
  }
  function onCanvasMove(e){
    var rect=dom.canvas.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
    var hitId=Renderer.hitTest(x,y);dom.canvas.style.cursor=hitId?'pointer':'default';Renderer.setHover(hitId);
  }
  function onSceneBtnClick(e){
    var btn=e.currentTarget,sc=btn.getAttribute('data-scene');
    if(sc&&sc!==currentScene){var all=dom.sceneBar.querySelectorAll('.scene-btn');for(var i=0;i<all.length;i++)all[i].classList.remove('active');btn.classList.add('active');switchScene(sc)}
  }

  function switchScene(sn){
    var scene=DataModule.scenes[sn];if(!scene)return;currentScene=sn;
    var eqList=DataModule.equipment;for(var i=0;i<eqList.length;i++){var eq=eqList[i];if(scene.equipment[eq.id]!==undefined)eq.state=scene.equipment[eq.id]}
    Renderer.setTankLevel(scene.tankLevel);Renderer.setActivePipes(scene.activePipes);Renderer.setNight(!!scene.isNight);Renderer.rebuildHitAreas();
    updateAlarms(scene.alarms);updateStats();dom.sceneLabel.textContent='\u5F53\u524D\u573A\u666F\uFF1A'+scene.label;
    sceneData=DataModule.generateSceneData(sn);if(selectedEqId)showEquipmentPanel(selectedEqId);
  }

  function selectEquipment(id){selectedEqId=id;Renderer.setSelected(id);showEquipmentPanel(id)}
  function deselectEquipment(){selectedEqId=null;Renderer.setSelected(null);dom.panelContent.innerHTML='<div class="panel-placeholder">\u70B9\u51FB\u753B\u5E03\u4E2D\u7684\u8BBE\u5907\u67E5\u770B\u8BE6\u60C5</div>'}

  function showEquipmentPanel(id){
    var eq=null,eqList=DataModule.equipment;for(var i=0;i<eqList.length;i++){if(eqList[i].id===id){eq=eqList[i];break}}
    if(!eq)return;var data=sceneData[id]||DataModule.generateData(eq.state);
    var stateLabel=DataModule.STATE_LABELS[eq.state]||eq.state;
    var icons={pump:'\u2699',valve:'\u2638',sensor:'\u26A1',tank:'\u26C6',cabinet:'\u26A0',alarm_light:'\u26A0'};
    var html='<div class="eq-header"><div class="eq-icon" style="background:'+(STATE_BG[eq.state]||'#111')+'">'+(icons[eq.type]||'\u2699')+'</div><div><div class="eq-name">'+eq.name+'</div><span class="eq-state '+eq.state+'">'+stateLabel+'</span></div></div>';
    var fields=[
      {key:'flow',label:'\u6D41\u91CF',icon:'\u2248',color:'#00d4ff'},
      {key:'pressure',label:'\u538B\u529B',icon:'\u25CE',color:'#00ff88'},
      {key:'level',label:'\u6DB2\u4F4D',icon:'\u25A6',color:'#4488ff'},
      {key:'temperature',label:'\u6E29\u5EA6',icon:'\u2600',color:'#ffaa00'},
      {key:'power',label:'\u80FD\u8017',icon:'\u26A1',color:'#aa66ff'},
      {key:'runtime',label:'\u8FD0\u884C\u65F6\u957F',icon:'\u23F1',color:'#88aacc'}
    ];
    html+='<div class="data-grid">';
    for(var f=0;f<fields.length;f++){
      var field=fields[f],d=data[field.key];if(!d)continue;
      var valStr=d.value==='--'?'--':d.value,barPct=0;
      if(d.value!=='--'){
        var ref=dataRanges_max[field.key]||1;barPct=Math.min(100,Math.round(d.value/(ref*1.2)*100));
      }
      html+='<div class="data-item"><div class="data-label">'+field.icon+' '+field.label+'</div><div class="data-value" style="color:'+field.color+'">'+valStr+'<span class="data-unit">'+d.unit+'</span></div><div class="data-bar"><div class="data-bar-fill" style="width:'+barPct+'%;background:'+field.color+'"></div></div></div>';
    }
    html+='</div>';dom.panelContent.innerHTML=html;
  }

  // Reference max values for progress bars
  var dataRanges_max={flow:320,pressure:0.65,level:80,temperature:55,power:120,runtime:9999};

  function updateAlarms(alarms){
    if(!alarms||alarms.length===0){dom.alarmList.innerHTML='<li class="alarm-empty">\u6682\u65E0\u544A\u8B66</li>';return}
    var html='';for(var i=0;i<alarms.length;i++){var a=alarms[i];html+='<li class="'+a.level+'"><span class="alarm-time">'+a.time+'</span><span class="alarm-text">'+a.text+'</span></li>'}
    dom.alarmList.innerHTML=html;
  }
  function updateStats(){
    var eqList=DataModule.equipment,total=eqList.length,rc=0,ac=0;
    for(var i=0;i<eqList.length;i++){if(eqList[i].state==='running')rc++;if(eqList[i].state==='fault'||eqList[i].state==='offline')ac++}
    dom.statTotal.textContent=total;dom.statRunning.textContent=rc;dom.statAlarm.textContent=ac;
  }
  function startDataRefresh(){
    if(dataTimer)clearInterval(dataTimer);
    dataTimer=setInterval(function(){sceneData=DataModule.generateSceneData(currentScene);if(selectedEqId)showEquipmentPanel(selectedEqId)},DATA_REFRESH_INTERVAL);
  }
  function updateClock(){
    var n=new Date(),p=function(v){return v<10?'0'+v:''+v};
    dom.headerTime.textContent=n.getFullYear()+'-'+p(n.getMonth()+1)+'-'+p(n.getDate())+' '+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds());
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
  return{switchScene:switchScene,selectEquipment:selectEquipment,deselectEquipment:deselectEquipment};
})();
