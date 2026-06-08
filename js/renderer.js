var Renderer=(function(){
  'use strict';
  var TARGET_FPS=30,FRAME_INTERVAL=1000/TARGET_FPS,PARTICLE_COUNT=6,PARTICLE_RADIUS=2.5,WAVE_SEGMENTS=40;
  var canvas,ctx,W,H;
  var currentEquipment=[],currentPipes=[],tankConfig=null,buildings=null;
  var tankDisplayLevel=0.6,isNight=false,selectedId=null,hoverId=null;
  var animTime=0,lastFrameTime=0,animFrameId=null,running=false;
  var perf={frameCount:0,fps:0,lastFpsTime:0};
  var hitAreas=[];
  var SIZES={
    pump:{rw:0.055,rh:0.08},valve:{rw:0.028,rh:0.028},sensor:{rw:0.022,rh:0.035},
    tank:{rw:0.14,rh:0.35},cabinet:{rw:0.055,rh:0.11},alarm_light:{rw:0.03,rh:0.04}
  };
  var STATE_COLORS={running:'#00e87b',stopped:'#667788',fault:'#ff4455',maintenance:'#ffaa00',offline:'#556677'};

  function init(cvs,eq,pp,tk,bd){
    canvas=cvs;ctx=canvas.getContext('2d',{alpha:false});
    currentEquipment=eq;currentPipes=pp;tankConfig=tk;buildings=bd;
    tankDisplayLevel=tk.level;resize();
  }
  function resize(){
    var dpr=Math.min(window.devicePixelRatio||1,2);
    W=canvas.clientWidth;H=canvas.clientHeight;
    canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);rebuildHitAreas();
  }
  function start(){if(running)return;running=true;lastFrameTime=performance.now();perf.lastFpsTime=lastFrameTime;perf.frameCount=0;animFrameId=requestAnimationFrame(_loop)}
  function stop(){running=false;if(animFrameId){cancelAnimationFrame(animFrameId);animFrameId=null}}
  function destroy(){stop();currentEquipment=null;currentPipes=null;tankConfig=null;hitAreas=[];ctx=null;canvas=null}

  function _loop(now){
    if(!running)return;animFrameId=requestAnimationFrame(_loop);
    var elapsed=now-lastFrameTime;if(elapsed<FRAME_INTERVAL)return;
    lastFrameTime=now-(elapsed%FRAME_INTERVAL);
    var dt=Math.min(elapsed/1000,0.1);animTime+=dt;_render(dt);
    perf.frameCount++;if(now-perf.lastFpsTime>=1000){perf.fps=perf.frameCount;perf.frameCount=0;perf.lastFpsTime=now}
  }
  function _render(dt){
    ctx.save();
    if(tankConfig){var diff=tankConfig.level-tankDisplayLevel;tankDisplayLevel+=diff*Math.min(dt*2,1)}
    drawBackground();drawPumpHouse();drawTank();drawPipes(dt);drawAllEquipment();drawLabels();drawSelectionRing();
    ctx.restore();
  }

  /* ---- Background ---- */
  function drawBackground(){
    var gY=buildings.ground.ry*H;
    var sg=ctx.createLinearGradient(0,0,0,gY);
    if(isNight){sg.addColorStop(0,'#050510');sg.addColorStop(1,'#0a1020')}
    else{sg.addColorStop(0,'#0a1628');sg.addColorStop(1,'#162040')}
    ctx.fillStyle=sg;ctx.fillRect(0,0,W,gY);
    if(isNight){ctx.fillStyle='rgba(255,255,255,0.5)';for(var i=0;i<30;i++){var sx=(i*137.5)%W,sy=(i*97.3+20)%(gY*0.7),sr=0.5+(i%3)*0.5;ctx.beginPath();ctx.arc(sx,sy,sr,0,6.283);ctx.fill()}}
    var gg=ctx.createLinearGradient(0,gY,0,H);gg.addColorStop(0,'#1a2a18');gg.addColorStop(0.05,'#141e12');gg.addColorStop(1,'#0a120a');
    ctx.fillStyle=gg;ctx.fillRect(0,gY,W,H-gY);
    ctx.strokeStyle='#2a3a28';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,gY);ctx.lineTo(W,gY);ctx.stroke();
  }

  /* ---- Pump House ---- */
  function drawPumpHouse(){
    var ph=buildings.pumpHouse,x=ph.rx*W,y=ph.ry*H,w=ph.rw*W,h=ph.rh*H,gY=buildings.ground.ry*H;
    var wg=ctx.createLinearGradient(x,y,x,gY);wg.addColorStop(0,'#2a3040');wg.addColorStop(1,'#1e2430');
    ctx.fillStyle=wg;ctx.fillRect(x,y,w,gY-y);ctx.strokeStyle='#3a4a5a';ctx.lineWidth=1.5;ctx.strokeRect(x,y,w,gY-y);
    var rp=y-H*0.06;ctx.fillStyle='#3a4858';ctx.beginPath();ctx.moveTo(x-W*0.02,y);ctx.lineTo(x+w/2,rp);ctx.lineTo(x+w+W*0.02,y);ctx.closePath();ctx.fill();ctx.strokeStyle='#4a5a6a';ctx.lineWidth=1.5;ctx.stroke();
    ctx.fillStyle='#8899aa';ctx.font=Math.max(10,W*0.012)+'px sans-serif';ctx.textAlign='center';ctx.fillText('\u6CF5 \u623F',x+w/2,y-H*0.015);
    ctx.fillStyle='#111820';ctx.fillRect(x,gY,w,h-(gY-y));ctx.strokeStyle='#2a3a4a';ctx.lineWidth=1;ctx.strokeRect(x,gY,w,h-(gY-y));
    ctx.fillStyle='#445566';ctx.font=Math.max(9,W*0.009)+'px sans-serif';ctx.textAlign='left';ctx.fillText('\u5730\u4E0B\u5C42',x+6,gY+14);
    var wW=w*0.06,wH=(gY-y)*0.12;
    for(var i=0;i<4;i++){var wx=x+w*0.15+i*w*0.2,wy=y+(gY-y)*0.15;
      if(isNight){ctx.fillStyle='rgba(255,220,100,0.4)';ctx.shadowColor='rgba(255,220,100,0.3)';ctx.shadowBlur=8}
      else{ctx.fillStyle='rgba(100,160,200,0.15)';ctx.shadowBlur=0}
      ctx.fillRect(wx,wy,wW,wH);ctx.shadowBlur=0;ctx.strokeStyle='#4a5a6a';ctx.lineWidth=0.8;ctx.strokeRect(wx,wy,wW,wH)}
  }

  /* ---- Tank ---- */
  function drawTank(){
    if(!tankConfig)return;var tc=tankConfig,x=tc.rx*W,y=tc.ry*H,w=tc.rw*W,h=tc.rh*H;
    ctx.fillStyle='#1e2830';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#3a5060';ctx.lineWidth=2;ctx.strokeRect(x,y,w,h);
    var wTop=y+h*(1-tankDisplayLevel),wH=h*tankDisplayLevel,lr=tankDisplayLevel;
    if(wH>0){
      ctx.save();ctx.beginPath();ctx.rect(x+2,wTop,w-4,wH);ctx.clip();
      var wgd=ctx.createLinearGradient(x,wTop,x,y+h);
      if(lr>0.8){wgd.addColorStop(0,'rgba(255,80,60,0.55)');wgd.addColorStop(1,'rgba(200,40,30,0.65)')}
      else if(lr>0.6){wgd.addColorStop(0,'rgba(60,160,220,0.45)');wgd.addColorStop(1,'rgba(30,100,180,0.60)')}
      else{wgd.addColorStop(0,'rgba(40,130,200,0.35)');wgd.addColorStop(1,'rgba(20,80,150,0.50)')}
      ctx.fillStyle=wgd;ctx.fillRect(x+2,wTop,w-4,wH);
      ctx.beginPath();ctx.moveTo(x+2,wTop);
      for(var i=0;i<=WAVE_SEGMENTS;i++){var wx2=x+2+(w-4)*(i/WAVE_SEGMENTS),wy2=wTop+Math.sin(i*0.5+animTime*3)*2.5+Math.sin(i*0.3+animTime*2)*1.5;ctx.lineTo(wx2,wy2)}
      ctx.lineTo(x+w-2,wTop+8);ctx.lineTo(x+2,wTop+8);ctx.closePath();ctx.fillStyle='rgba(120,200,255,0.15)';ctx.fill();ctx.restore();
      ctx.strokeStyle='rgba(100,200,255,0.5)';ctx.lineWidth=1;ctx.beginPath();
      for(var j=0;j<=WAVE_SEGMENTS;j++){var lx=x+2+(w-4)*(j/WAVE_SEGMENTS),ly=wTop+Math.sin(j*0.5+animTime*3)*2.5+Math.sin(j*0.3+animTime*2)*1.5;if(j===0)ctx.moveTo(lx,ly);else ctx.lineTo(lx,ly)}
      ctx.stroke();
    }
    var highY=y+h*(1-tc.levelHigh);ctx.setLineDash([4,3]);ctx.strokeStyle=lr>tc.levelHigh?'#ff4455':'rgba(255,68,85,0.3)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x+4,highY);ctx.lineTo(x+w-4,highY);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=lr>0.8?'#ff6655':'#88bbdd';ctx.font='bold '+Math.max(11,W*0.012)+'px monospace';ctx.textAlign='center';ctx.fillText(Math.round(tankDisplayLevel*100)+'%',x+w/2,y+h+16);
    ctx.fillStyle='#5a7a8a';ctx.font=Math.max(9,W*0.01)+'px sans-serif';ctx.fillText('\u6E05\u6C34\u6C60',x+w/2,y-6);
  }

  /* ---- Pipes ---- */
  function drawPipes(dt){
    for(var p=0;p<currentPipes.length;p++){
      var pipe=currentPipes[p];if(!pipe.points||pipe.points.length<2)continue;
      var pts=pipe.points,isA=pipe.active;
      ctx.strokeStyle='#2a3a4a';ctx.lineWidth=8;ctx.lineCap='round';ctx.lineJoin='round';
      ctx.beginPath();ctx.moveTo(pts[0][0]*W,pts[0][1]*H);for(var i=1;i<pts.length;i++)ctx.lineTo(pts[i][0]*W,pts[i][1]*H);ctx.stroke();
      ctx.strokeStyle=isA?(pipe.color||'#3388cc'):'#1a2a3a';ctx.lineWidth=5;
      ctx.beginPath();ctx.moveTo(pts[0][0]*W,pts[0][1]*H);for(var j=1;j<pts.length;j++)ctx.lineTo(pts[j][0]*W,pts[j][1]*H);ctx.stroke();
      if(isA)drawFlowParticles(pipe,pts);
    }
  }
  function drawFlowParticles(pipe,pts){
    var segs=[],totalLen=0;
    for(var i=0;i<pts.length-1;i++){var x1=pts[i][0]*W,y1=pts[i][1]*H,x2=pts[i+1][0]*W,y2=pts[i+1][1]*H,len=Math.sqrt((x2-x1)*(x2-x1)+(y2-y1)*(y2-y1));segs.push({x1:x1,y1:y1,x2:x2,y2:y2,len:len});totalLen+=len}
    if(totalLen<1)return;
    var speed=80,offset=(animTime*speed)%totalLen,spacing=totalLen/PARTICLE_COUNT;
    ctx.fillStyle='rgba(100,220,255,0.8)';
    for(var p=0;p<PARTICLE_COUNT;p++){
      var dist=(offset+p*spacing)%totalLen,acc=0;
      for(var s=0;s<segs.length;s++){
        if(acc+segs[s].len>=dist){var t=(dist-acc)/segs[s].len,px=segs[s].x1+(segs[s].x2-segs[s].x1)*t,py=segs[s].y1+(segs[s].y2-segs[s].y1)*t;ctx.beginPath();ctx.arc(px,py,PARTICLE_RADIUS,0,6.283);ctx.fill();break}
        acc+=segs[s].len;
      }
    }
  }

  /* ---- Equipment ---- */
  function drawAllEquipment(){
    for(var i=0;i<currentEquipment.length;i++){
      var eq=currentEquipment[i],cx=eq.rx*W,cy=eq.ry*H,sz=SIZES[eq.type];if(!sz)continue;
      var hw=sz.rw*W/2,hh=sz.rh*H/2;
      if(eq.type==='pump')drawPump(cx,cy,hw,hh,eq);
      else if(eq.type==='valve')drawValve(cx,cy,hw,hh,eq);
      else if(eq.type==='sensor')drawSensor(cx,cy,hw,hh,eq);
      else if(eq.type==='cabinet')drawCabinet(cx,cy,hw,hh,eq);
      else if(eq.type==='alarm_light')drawAlarmLight(cx,cy,hw,hh,eq);
    }
  }
  function drawPump(cx,cy,hw,hh,eq){
    var st=eq.state,col=STATE_COLORS[st]||STATE_COLORS.stopped,r=Math.min(hw,hh)*0.85;
    ctx.fillStyle='#2a3040';_rr(cx-hw,cy+hh*0.3,hw*2,hh*0.7,3);ctx.fill();
    var gd=ctx.createRadialGradient(cx,cy-hh*0.1,r*0.2,cx,cy-hh*0.1,r);
    if(st==='running'){gd.addColorStop(0,'#2a5a3a');gd.addColorStop(1,'#1a3a2a')}
    else if(st==='fault'){gd.addColorStop(0,'#5a2020');gd.addColorStop(1,'#3a1515')}
    else{gd.addColorStop(0,'#2a3040');gd.addColorStop(1,'#1a2030')}
    ctx.fillStyle=gd;ctx.beginPath();ctx.arc(cx,cy-hh*0.1,r,0,6.283);ctx.fill();ctx.strokeStyle=col;ctx.lineWidth=2;ctx.stroke();
    if(st==='running'){var ang=animTime*6;ctx.save();ctx.translate(cx,cy-hh*0.1);ctx.rotate(ang);ctx.strokeStyle='rgba(0,232,123,0.6)';ctx.lineWidth=2;for(var b=0;b<3;b++){var ba=b*6.283/3;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.cos(ba)*r*0.65,Math.sin(ba)*r*0.65);ctx.stroke()}ctx.restore()}
    ctx.fillStyle=col;ctx.beginPath();ctx.arc(cx,cy-hh*0.1,3,0,6.283);ctx.fill();
    if(st==='fault'){ctx.strokeStyle='#ff4455';ctx.lineWidth=3;var xs=r*0.45;ctx.beginPath();ctx.moveTo(cx-xs,cy-hh*0.1-xs);ctx.lineTo(cx+xs,cy-hh*0.1+xs);ctx.moveTo(cx+xs,cy-hh*0.1-xs);ctx.lineTo(cx-xs,cy-hh*0.1+xs);ctx.stroke()}
    if(st==='maintenance'){ctx.fillStyle='#ffaa00';ctx.font=Math.max(10,r*0.7)+'px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('\u2692',cx,cy-hh*0.1)}
    ctx.fillStyle=col;ctx.shadowColor=col;ctx.shadowBlur=st==='running'?6:0;ctx.beginPath();ctx.arc(cx+hw*0.7,cy-hh*0.6,3,0,6.283);ctx.fill();ctx.shadowBlur=0;
  }
  function drawValve(cx,cy,hw,hh,eq){
    var st=eq.state,col=STATE_COLORS[st]||STATE_COLORS.stopped,r=Math.min(hw,hh)*0.9,isO=st==='running';
    ctx.fillStyle=isO?'#1a3a2a':'#2a2530';ctx.beginPath();ctx.arc(cx,cy,r,0,6.283);ctx.fill();ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.stroke();
    ctx.save();ctx.translate(cx,cy);ctx.rotate(isO?1.5708:0);ctx.strokeStyle=col;ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(-r*0.7,0);ctx.lineTo(r*0.7,0);ctx.stroke();ctx.restore();
    ctx.strokeStyle='#5a6a7a';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy-r-H*0.015);ctx.stroke();
    ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(cx,cy-r-H*0.015,r*0.35,0,6.283);ctx.stroke();
  }
  function drawSensor(cx,cy,hw,hh,eq){
    var st=eq.state,col=STATE_COLORS[st]||STATE_COLORS.stopped,isOff=st==='offline';
    ctx.fillStyle=isOff?'#222830':'#1e2a38';_rr(cx-hw*0.6,cy-hh*0.4,hw*1.2,hh*0.8,2);ctx.fill();ctx.strokeStyle=isOff?'#444a55':col;ctx.lineWidth=1;ctx.stroke();
    ctx.strokeStyle='#5a6a7a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(cx,cy+hh*0.4);ctx.lineTo(cx,cy+hh);ctx.stroke();
    if(!isOff){ctx.strokeStyle=col;ctx.lineWidth=1;var wR=hw*0.4;for(var w=0;w<2;w++){var al=0.4-w*0.15+Math.sin(animTime*4+w)*0.1;ctx.globalAlpha=Math.max(0,al);ctx.beginPath();ctx.arc(cx,cy-hh*0.2,wR+w*hw*0.3,-0.8,0.8);ctx.stroke()}ctx.globalAlpha=1}
    if(isOff){ctx.strokeStyle='#667788';ctx.lineWidth=2;var xs=hw*0.4;ctx.beginPath();ctx.moveTo(cx-xs,cy-hh*0.1-xs);ctx.lineTo(cx+xs,cy-hh*0.1+xs);ctx.moveTo(cx+xs,cy-hh*0.1-xs);ctx.lineTo(cx-xs,cy-hh*0.1+xs);ctx.stroke()}
    ctx.fillStyle=col;ctx.beginPath();ctx.arc(cx,cy-hh*0.6,2.5,0,6.283);ctx.fill();
  }
  function drawCabinet(cx,cy,hw,hh,eq){
    var st=eq.state;ctx.fillStyle='#2a3545';_rr(cx-hw,cy-hh,hw*2,hh*2,4);ctx.fill();ctx.strokeStyle='#4a5a6a';ctx.lineWidth=1.5;ctx.stroke();
    ctx.strokeStyle='#3a4a5a';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(cx,cy-hh+4);ctx.lineTo(cx,cy+hh-4);ctx.stroke();
    var ledY=cy-hh*0.5,lc=['#00ff88','#ffaa00','#ff4455'];
    for(var i=0;i<3;i++){var lx=cx-hw*0.5+i*hw*0.5,isLit=(i===0&&st==='running')||(i===1&&st==='maintenance')||(i===2&&st==='fault');ctx.fillStyle=isLit?lc[i]:'#1a2030';ctx.shadowColor=isLit?lc[i]:'transparent';ctx.shadowBlur=isLit?5:0;ctx.beginPath();ctx.arc(lx,ledY,3,0,6.283);ctx.fill()}
    ctx.shadowBlur=0;ctx.fillStyle=st==='running'?'rgba(0,180,255,0.15)':'rgba(50,60,70,0.3)';_rr(cx-hw*0.65,cy-hh*0.15,hw*1.3,hh*0.5,2);ctx.fill();
    if(st==='running'){ctx.fillStyle='#00aacc';ctx.font=Math.max(7,hw*0.35)+'px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('AUTO',cx,cy+hh*0.1)}
  }
  function drawAlarmLight(cx,cy,hw,hh,eq){
    var isA=eq.state==='running';ctx.fillStyle='#3a3a40';_rr(cx-hw*0.5,cy+hh*0.3,hw,hh*0.4,2);ctx.fill();
    var gd=ctx.createRadialGradient(cx,cy-hh*0.1,1,cx,cy-hh*0.1,hw*0.8);
    if(isA){var pulse=0.5+0.5*Math.sin(animTime*8);gd.addColorStop(0,'rgba(255,60,30,'+(0.8+pulse*0.2)+')');gd.addColorStop(0.5,'rgba(255,40,20,'+(0.4+pulse*0.2)+')');gd.addColorStop(1,'rgba(255,20,10,0.05)')}
    else{gd.addColorStop(0,'rgba(80,30,20,0.4)');gd.addColorStop(1,'rgba(40,15,10,0.1)')}
    ctx.fillStyle=gd;ctx.beginPath();ctx.arc(cx,cy-hh*0.1,hw*0.8,0,6.283);ctx.fill();
    ctx.strokeStyle=isA?'#ff6644':'#4a3030';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(cx,cy-hh*0.1,hw*0.8,0,6.283);ctx.stroke();
    if(isA){ctx.fillStyle='rgba(255,50,30,0.06)';ctx.beginPath();ctx.arc(cx,cy-hh*0.1,hw*2.5,0,6.283);ctx.fill()}
  }

  /* ---- Labels ---- */
  function drawLabels(){
    ctx.font=Math.max(9,W*0.01)+'px sans-serif';ctx.textAlign='center';ctx.textBaseline='top';
    for(var i=0;i<currentEquipment.length;i++){var eq=currentEquipment[i];if(eq.type==='tank')continue;var sz=SIZES[eq.type];if(!sz)continue;
      ctx.fillStyle='#7a8a9a';ctx.fillText(eq.name,eq.rx*W,eq.ry*H+sz.rh*H/2+4)}
  }

  /* ---- Selection ---- */
  function drawSelectionRing(){
    if(!selectedId)return;var eq=null;
    for(var i=0;i<currentEquipment.length;i++){if(currentEquipment[i].id===selectedId){eq=currentEquipment[i];break}}
    if(!eq)return;var sz=SIZES[eq.type];if(!sz&&eq.type!=='tank')return;
    var cx2,cy2,r2;
    if(eq.type==='tank'){cx2=tankConfig.rx*W+tankConfig.rw*W/2;cy2=tankConfig.ry*H+tankConfig.rh*H/2;r2=Math.max(tankConfig.rw*W,tankConfig.rh*H)/2+6}
    else{cx2=eq.rx*W;cy2=eq.ry*H;r2=Math.max(sz.rw*W,sz.rh*H)/2+6}
    var al=0.4+0.3*Math.sin(animTime*4);ctx.strokeStyle='rgba(0,212,255,'+al+')';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.beginPath();ctx.arc(cx2,cy2,r2,0,6.283);ctx.stroke();ctx.setLineDash([]);
  }

  /* ---- Hit test ---- */
  function rebuildHitAreas(){
    hitAreas=[];if(!currentEquipment)return;
    for(var i=0;i<currentEquipment.length;i++){var eq=currentEquipment[i],sz;
      if(eq.type==='tank'&&tankConfig)sz={rw:tankConfig.rw,rh:tankConfig.rh};else sz=SIZES[eq.type];if(!sz)continue;
      var pad=0.008;hitAreas.push({id:eq.id,x1:(eq.rx-sz.rw/2-pad)*W,y1:(eq.ry-sz.rh/2-pad)*H,x2:(eq.rx+sz.rw/2+pad)*W,y2:(eq.ry+sz.rh/2+pad)*H})}
  }
  function hitTest(px,py){for(var i=hitAreas.length-1;i>=0;i--){var a=hitAreas[i];if(px>=a.x1&&px<=a.x2&&py>=a.y1&&py<=a.y2)return a.id}return null}

  /* ---- Setters ---- */
  function setNight(v){isNight=!!v}
  function setSelected(id){selectedId=id||null}
  function setHover(id){hoverId=id||null}
  function setTankLevel(l){if(tankConfig)tankConfig.level=l}
  function setActivePipes(ids){if(!currentPipes)return;for(var i=0;i<currentPipes.length;i++)currentPipes[i].active=ids.indexOf(currentPipes[i].id)!==-1}
  function getFPS(){return perf.fps}
  function _rr(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath()}

  return{init:init,resize:resize,start:start,stop:stop,destroy:destroy,hitTest:hitTest,rebuildHitAreas:rebuildHitAreas,setNight:setNight,setSelected:setSelected,setHover:setHover,setTankLevel:setTankLevel,setActivePipes:setActivePipes,getFPS:getFPS};
})();
