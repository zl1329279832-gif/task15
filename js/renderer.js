/**
 * 智慧泵站 — Canvas 渲染引擎
 * 性能优化：离屏缓存、帧率节流、对象复用
 */

class PumpStationRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // 逻辑坐标系
    this.LOGICAL_W = 1400;
    this.LOGICAL_H = 800;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    // 离屏 Canvas — 缓存静态背景
    this.offCanvas = document.createElement('canvas');
    this.offCtx = this.offCanvas.getContext('2d');
    this.staticDirty = true;

    // 动画状态
    this.dashOffset = 0;
    this.pumpAngle = 0;
    this.blinkOn = false;
    this.blinkCounter = 0;
    this.waveOffset = 0;

    // 帧率控制
    this.targetFPS = 30;
    this.frameDuration = 1000 / this.targetFPS;
    this.lastFrameTime = 0;
    this.rafId = null;
    this.running = false;

    // 外部数据引用
    this.devices = [];
    this.pipes = [];
    this.deviceStates = {};
    this.waterLevels = { pool_in: 0.65, pool_out: 0.5 };
    this.nightMode = false;
    this.selectedDeviceId = null;

    // 点击回调
    this.onDeviceClick = null;

    // 可复用的 Path2D 对象池
    this._hitAreas = new Map();

    this._bindEvents();
    this._resize();
  }

  /* ────── 初始化 ────── */

  setData(devices, pipes) {
    this.devices = devices;
    this.pipes = pipes;
    this.staticDirty = true;
  }

  updateStates(states, waterLevels, nightMode) {
    this.deviceStates = states;
    this.waterLevels = waterLevels;
    this.nightMode = nightMode;
    this.staticDirty = true;
  }

  /* ────── 事件 ────── */

  _bindEvents() {
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);

    this._clickHandler = (e) => this._handleClick(e);
    this.canvas.addEventListener('click', this._clickHandler);

    this._moveHandler = (e) => this._handleMove(e);
    this.canvas.addEventListener('mousemove', this._moveHandler);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // 限制 DPR 以优化性能
    const w = parent.clientWidth;
    const h = parent.clientHeight;

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    this.offCanvas.width = this.canvas.width;
    this.offCanvas.height = this.canvas.height;

    // 计算缩放，保持比例居中
    const scaleX = (w * dpr) / this.LOGICAL_W;
    const scaleY = (h * dpr) / this.LOGICAL_H;
    this.scale = Math.min(scaleX, scaleY);
    this.offsetX = ((w * dpr) - this.LOGICAL_W * this.scale) / 2;
    this.offsetY = ((h * dpr) - this.LOGICAL_H * this.scale) / 2;
    this.dpr = dpr;
    this.displayW = w;
    this.displayH = h;

    this.staticDirty = true;
  }

  _toLogical(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * this.dpr;
    const py = (clientY - rect.top) * this.dpr;
    return {
      x: (px - this.offsetX) / this.scale,
      y: (py - this.offsetY) / this.scale,
    };
  }

  _handleClick(e) {
    const pos = this._toLogical(e.clientX, e.clientY);
    const dev = this._hitTest(pos.x, pos.y);
    if (dev && this.onDeviceClick) {
      this.selectedDeviceId = dev.id;
      this.onDeviceClick(dev);
    }
  }

  _handleMove(e) {
    const pos = this._toLogical(e.clientX, e.clientY);
    const dev = this._hitTest(pos.x, pos.y);
    this.canvas.style.cursor = dev ? 'pointer' : 'default';
  }

  _hitTest(lx, ly) {
    // 逆序遍历，顶层优先
    for (let i = this.devices.length - 1; i >= 0; i--) {
      const d = this.devices[i];
      if (d.type === DeviceType.PUMP_HOUSE) continue; // 泵房不可点击
      if (this._pointInDevice(lx, ly, d)) return d;
    }
    return null;
  }

  _pointInDevice(x, y, d) {
    const margin = 15;
    switch (d.type) {
      case DeviceType.PUMP:
        return Math.hypot(x - d.cx, y - d.cy) <= d.r + margin;
      case DeviceType.VALVE:
        return Math.abs(x - d.cx) <= d.size + margin && Math.abs(y - d.cy) <= d.size + margin;
      case DeviceType.SENSOR:
        return Math.abs(x - d.cx) <= d.size + margin && Math.abs(y - d.cy) <= d.size + margin + 10;
      case DeviceType.ALARM_LIGHT:
        return Math.hypot(x - d.cx, y - d.cy) <= d.r + margin;
      case DeviceType.CONTROL_BOX:
      case DeviceType.POOL:
        return x >= d.x - margin && x <= d.x + d.w + margin &&
               y >= d.y - margin && y <= d.y + d.h + margin;
      default:
        return false;
    }
  }

  /* ────── 渲染循环 ────── */

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this._loop(this.lastFrameTime);
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  _loop(now) {
    if (!this.running) return;
    this.rafId = requestAnimationFrame((t) => this._loop(t));

    const delta = now - this.lastFrameTime;
    if (delta < this.frameDuration) return; // 帧率节流
    this.lastFrameTime = now - (delta % this.frameDuration);

    this._updateAnimation(delta);
    this._render();
  }

  _updateAnimation(dt) {
    const speed = this.nightMode ? 0.8 : 2.0;
    this.dashOffset += speed;
    this.pumpAngle += (this.nightMode ? 0.03 : 0.06);
    this.waveOffset += 0.04;
    this.blinkCounter++;
    if (this.blinkCounter >= 15) {
      this.blinkOn = !this.blinkOn;
      this.blinkCounter = 0;
    }
  }

  _render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // 绘制静态层到离屏 Canvas（仅在 dirty 时）
    if (this.staticDirty) {
      this._renderStatic();
      this.staticDirty = false;
    }

    // 先画静态层
    ctx.drawImage(this.offCanvas, 0, 0);

    // 再画动态层
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);
    this._drawDynamic(ctx);
    ctx.restore();
  }

  _renderStatic() {
    const ctx = this.offCtx;
    ctx.clearRect(0, 0, this.offCanvas.width, this.offCanvas.height);
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    this._drawBackground(ctx);
    this._drawPumpHouse(ctx);
    this._drawControlBox(ctx);
    this._drawPipesStatic(ctx);

    ctx.restore();
  }

  _drawDynamic(ctx) {
    this._drawPools(ctx);
    this._drawPipesFlow(ctx);
    this._drawPumps(ctx);
    this._drawValves(ctx);
    this._drawSensors(ctx);
    this._drawAlarmLight(ctx);
    this._drawDeviceLabels(ctx);
    this._drawSelectedHighlight(ctx);
  }

  /* ────── 背景 ────── */

  _drawBackground(ctx) {
    // 天空渐变
    const skyGrad = ctx.createLinearGradient(0, 0, 0, this.LOGICAL_H);
    if (this.nightMode) {
      skyGrad.addColorStop(0, '#0a1628');
      skyGrad.addColorStop(1, '#1a2a4a');
    } else {
      skyGrad.addColorStop(0, '#87CEEB');
      skyGrad.addColorStop(0.6, '#b8e2f8');
      skyGrad.addColorStop(1, '#d4edda');
    }
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, this.LOGICAL_W, this.LOGICAL_H);

    // 地面
    ctx.fillStyle = this.nightMode ? '#1a2e1a' : '#4a7c4a';
    ctx.fillRect(0, 620, this.LOGICAL_W, 180);
    ctx.fillStyle = this.nightMode ? '#2a3e2a' : '#5a8c5a';
    ctx.fillRect(0, 620, this.LOGICAL_W, 8);
  }

  /* ────── 泵房 ────── */

  _drawPumpHouse(ctx) {
    const h = this.devices.find(d => d.id === 'house');
    if (!h) return;

    // 建筑主体
    ctx.fillStyle = this.nightMode ? '#2a3040' : '#e0e0e0';
    ctx.strokeStyle = this.nightMode ? '#4a5060' : '#999';
    ctx.lineWidth = 2;
    this._roundRect(ctx, h.x, h.y, h.w, h.h, 6);
    ctx.fill();
    ctx.stroke();

    // 屋顶
    ctx.fillStyle = this.nightMode ? '#3a4050' : '#78909c';
    ctx.beginPath();
    ctx.moveTo(h.x - 15, h.y);
    ctx.lineTo(h.x + h.w / 2, h.y - 40);
    ctx.lineTo(h.x + h.w + 15, h.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = this.nightMode ? '#5a6070' : '#607d8b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 标题
    ctx.fillStyle = this.nightMode ? '#8899aa' : '#37474f';
    ctx.font = 'bold 20px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('智慧泵站', h.x + h.w / 2, h.y - 10);
  }

  /* ────── 电控柜 ────── */

  _drawControlBox(ctx) {
    const cb = this.devices.find(d => d.id === 'ctrlBox');
    if (!cb) return;
    const st = this.deviceStates[cb.id] || DeviceStatus.STOPPED;

    ctx.fillStyle = this.nightMode ? '#2d333b' : '#455a64';
    ctx.strokeStyle = this.nightMode ? '#555' : '#333';
    ctx.lineWidth = 2;
    this._roundRect(ctx, cb.x, cb.y, cb.w, cb.h, 4);
    ctx.fill();
    ctx.stroke();

    // 面板指示灯
    const ledColors = st === DeviceStatus.RUNNING
      ? ['#4caf50', '#2196f3', '#ff9800']
      : ['#666', '#666', '#666'];
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cb.x + 30 + i * 25, cb.y + 25, 6, 0, Math.PI * 2);
      ctx.fillStyle = ledColors[i];
      ctx.fill();
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 屏幕区域
    ctx.fillStyle = st === DeviceStatus.RUNNING ? '#1b5e20' : '#333';
    this._roundRect(ctx, cb.x + 100, cb.y + 12, 85, 50, 3);
    ctx.fill();

    // 屏幕文字
    ctx.fillStyle = st === DeviceStatus.RUNNING ? '#76ff03' : '#555';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('STATUS: OK', cb.x + 108, cb.y + 30);
    ctx.fillText('LOAD: 78%', cb.x + 108, cb.y + 44);

    // 标签
    ctx.fillStyle = this.nightMode ? '#8899aa' : '#ccc';
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('电控柜', cb.x + cb.w / 2, cb.y + cb.h + 16);
  }

  /* ────── 管道（静态管壁） ────── */

  _drawPipesStatic(ctx) {
    ctx.strokeStyle = this.nightMode ? '#4a5a6a' : '#78909c';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const pipe of this.pipes) {
      const pts = pipe.points;
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0], pts[i][1]);
      }
      ctx.stroke();
    }
  }

  /* ────── 管道水流（动态） ────── */

  _drawPipesFlow(ctx) {
    for (const pipe of this.pipes) {
      const active = this._isPipeActive(pipe);
      if (!active) continue;

      const pts = pipe.points;
      if (pts.length < 2) continue;

      ctx.strokeStyle = this.nightMode ? 'rgba(30,136,229,0.6)' : 'rgba(33,150,243,0.8)';
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([12, 8]);
      ctx.lineDashOffset = -this.dashOffset;

      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0], pts[i][1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _isPipeActive(pipe) {
    for (const devId of pipe.relatedDevices) {
      const st = this.deviceStates[devId];
      if (st !== DeviceStatus.RUNNING) return false;
    }
    return true;
  }

  /* ────── 水池 ────── */

  _drawPools(ctx) {
    const pools = this.devices.filter(d => d.type === DeviceType.POOL);
    for (const p of pools) {
      const wl = this.waterLevels[p.id] || 0.5;
      this._drawPool(ctx, p, wl);
    }
  }

  _drawPool(ctx, p, waterLevel) {
    // 池壁
    ctx.fillStyle = this.nightMode ? '#2a3040' : '#cfd8dc';
    ctx.strokeStyle = this.nightMode ? '#556' : '#90a4ae';
    ctx.lineWidth = 3;
    this._roundRect(ctx, p.x, p.y, p.w, p.h, 4);
    ctx.fill();
    ctx.stroke();

    // 水面
    const waterH = p.h * waterLevel;
    const waterY = p.y + p.h - waterH;

    const waterGrad = ctx.createLinearGradient(0, waterY, 0, p.y + p.h);
    if (waterLevel > 0.85) {
      waterGrad.addColorStop(0, 'rgba(244,67,54,0.7)');
      waterGrad.addColorStop(1, 'rgba(183,28,28,0.8)');
    } else {
      waterGrad.addColorStop(0, this.nightMode ? 'rgba(21,101,192,0.6)' : 'rgba(33,150,243,0.6)');
      waterGrad.addColorStop(1, this.nightMode ? 'rgba(13,71,161,0.8)' : 'rgba(25,118,210,0.8)');
    }

    // 波浪效果
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x + 2, p.y + 2, p.w - 4, p.h - 4);
    ctx.clip();

    ctx.fillStyle = waterGrad;
    ctx.beginPath();
    ctx.moveTo(p.x, waterY);
    for (let x = p.x; x <= p.x + p.w; x += 4) {
      const wave = Math.sin((x - p.x) * 0.05 + this.waveOffset) * 3;
      ctx.lineTo(x, waterY + wave);
    }
    ctx.lineTo(p.x + p.w, p.y + p.h);
    ctx.lineTo(p.x, p.y + p.h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 液位标注
    ctx.fillStyle = waterLevel > 0.85 ? '#ff1744' : (this.nightMode ? '#82b1ff' : '#1565c0');
    ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((waterLevel * 100).toFixed(0) + '%', p.x + p.w / 2, waterY - 8);

    // 池名
    ctx.fillStyle = this.nightMode ? '#8899aa' : '#37474f';
    ctx.font = '13px "Microsoft YaHei", sans-serif';
    ctx.fillText(p.name, p.x + p.w / 2, p.y + p.h + 20);
  }

  /* ────── 水泵 ────── */

  _drawPumps(ctx) {
    const pumps = this.devices.filter(d => d.type === DeviceType.PUMP);
    for (const p of pumps) {
      const st = this.deviceStates[p.id] || DeviceStatus.STOPPED;
      this._drawPump(ctx, p, st);
    }
  }

  _drawPump(ctx, p, status) {
    const color = STATUS_COLORS[status];
    const isRunning = status === DeviceStatus.RUNNING;

    // 外圈
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
    ctx.fillStyle = this.nightMode ? '#1a2030' : '#eceff1';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();

    // 内部叶片
    ctx.save();
    ctx.translate(p.cx, p.cy);
    if (isRunning) {
      ctx.rotate(this.pumpAngle);
    }

    const bladeR = p.r * 0.65;
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI / 2) * i;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, bladeR, angle - 0.3, angle + 0.3);
      ctx.closePath();
      ctx.fillStyle = isRunning ? color : '#999';
      ctx.globalAlpha = 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 中心圆
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.restore();

    // 状态指示灯
    ctx.beginPath();
    ctx.arc(p.cx + p.r - 5, p.cy - p.r + 5, 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 故障闪烁
    if (status === DeviceStatus.FAULT && this.blinkOn) {
      ctx.beginPath();
      ctx.arc(p.cx, p.cy, p.r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,23,68,0.6)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  /* ────── 阀门 ────── */

  _drawValves(ctx) {
    const valves = this.devices.filter(d => d.type === DeviceType.VALVE);
    for (const v of valves) {
      const st = this.deviceStates[v.id] || DeviceStatus.STOPPED;
      this._drawValve(ctx, v, st);
    }
  }

  _drawValve(ctx, v, status) {
    const color = STATUS_COLORS[status];
    const s = v.size;

    // 蝶形阀体
    ctx.beginPath();
    ctx.moveTo(v.cx - s, v.cy - s);
    ctx.lineTo(v.cx + s, v.cy);
    ctx.lineTo(v.cx - s, v.cy + s);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(v.cx + s, v.cy - s);
    ctx.lineTo(v.cx - s, v.cy);
    ctx.lineTo(v.cx + s, v.cy + s);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 中心轴
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 手轮
    ctx.beginPath();
    ctx.arc(v.cx, v.cy - s - 10, 8, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(v.cx, v.cy - s);
    ctx.lineTo(v.cx, v.cy - s - 10);
    ctx.stroke();
  }

  /* ────── 传感器 ────── */

  _drawSensors(ctx) {
    const sensors = this.devices.filter(d => d.type === DeviceType.SENSOR);
    for (const s of sensors) {
      const st = this.deviceStates[s.id] || DeviceStatus.STOPPED;
      this._drawSensor(ctx, s, st);
    }
  }

  _drawSensor(ctx, s, status) {
    const color = STATUS_COLORS[status];
    const sz = s.size;

    // 传感器主体
    ctx.fillStyle = this.nightMode ? '#2d333b' : '#eceff1';
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    this._roundRect(ctx, s.cx - sz, s.cy - sz, sz * 2, sz * 2, 3);
    ctx.fill();
    ctx.stroke();

    // 天线
    ctx.beginPath();
    ctx.moveTo(s.cx, s.cy - sz);
    ctx.lineTo(s.cx, s.cy - sz - 16);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 天线顶端圆点
    ctx.beginPath();
    ctx.arc(s.cx, s.cy - sz - 16, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 信号波纹（运行时）
    if (status === DeviceStatus.RUNNING) {
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.arc(s.cx, s.cy - sz - 16, 6 + i * 5, -Math.PI * 0.7, -Math.PI * 0.3);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4 / i;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // 离线叉号
    if (status === DeviceStatus.OFFLINE) {
      ctx.strokeStyle = '#ff1744';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s.cx - 10, s.cy - 10);
      ctx.lineTo(s.cx + 10, s.cy + 10);
      ctx.moveTo(s.cx + 10, s.cy - 10);
      ctx.lineTo(s.cx - 10, s.cy + 10);
      ctx.stroke();
    }
  }

  /* ────── 告警灯 ────── */

  _drawAlarmLight(ctx) {
    const al = this.devices.find(d => d.type === DeviceType.ALARM_LIGHT);
    if (!al) return;
    const st = this.deviceStates[al.id] || DeviceStatus.STOPPED;
    const active = st === DeviceStatus.RUNNING;

    // 底座
    ctx.fillStyle = this.nightMode ? '#333' : '#555';
    ctx.fillRect(al.cx - 4, al.cy + al.r, 8, 12);

    // 灯体
    ctx.beginPath();
    ctx.arc(al.cx, al.cy, al.r, 0, Math.PI * 2);

    if (active && this.blinkOn) {
      ctx.fillStyle = '#ff1744';
      ctx.shadowColor = '#ff1744';
      ctx.shadowBlur = 20;
    } else if (active) {
      ctx.fillStyle = '#c62828';
      ctx.shadowBlur = 0;
    } else {
      ctx.fillStyle = '#555';
      ctx.shadowBlur = 0;
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /* ────── 设备标签 ────── */

  _drawDeviceLabels(ctx) {
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';

    for (const d of this.devices) {
      if (d.type === DeviceType.PUMP_HOUSE || d.type === DeviceType.POOL ||
          d.type === DeviceType.CONTROL_BOX) continue;

      const st = this.deviceStates[d.id] || DeviceStatus.STOPPED;
      let lx, ly;

      switch (d.type) {
        case DeviceType.PUMP:
          lx = d.cx; ly = d.cy + d.r + 18; break;
        case DeviceType.VALVE:
          lx = d.cx; ly = d.cy + d.size + 30; break;
        case DeviceType.SENSOR:
          lx = d.cx; ly = d.cy + d.size + 16; break;
        case DeviceType.ALARM_LIGHT:
          lx = d.cx; ly = d.cy + d.r + 30; break;
        default: continue;
      }

      // 名称
      ctx.fillStyle = this.nightMode ? '#8899aa' : '#37474f';
      ctx.fillText(d.name, lx, ly);

      // 状态标签
      const label = STATUS_LABELS[st];
      if (label) {
        ctx.fillStyle = STATUS_COLORS[st];
        ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
        ctx.fillText('[' + label + ']', lx, ly + 15);
        ctx.font = '12px "Microsoft YaHei", sans-serif';
      }
    }
  }

  /* ────── 选中高亮 ────── */

  _drawSelectedHighlight(ctx) {
    if (!this.selectedDeviceId) return;
    const d = this.devices.find(dev => dev.id === this.selectedDeviceId);
    if (!d) return;

    ctx.save();
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 3]);
    ctx.lineDashOffset = -this.dashOffset * 0.5;

    switch (d.type) {
      case DeviceType.PUMP:
        ctx.beginPath();
        ctx.arc(d.cx, d.cy, d.r + 10, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case DeviceType.VALVE:
        ctx.strokeRect(d.cx - d.size - 8, d.cy - d.size - 18, d.size * 2 + 16, d.size * 2 + 26);
        break;
      case DeviceType.SENSOR:
        ctx.strokeRect(d.cx - d.size - 6, d.cy - d.size - 22, d.size * 2 + 12, d.size * 2 + 28);
        break;
      case DeviceType.CONTROL_BOX:
        ctx.strokeRect(d.x - 6, d.y - 6, d.w + 12, d.h + 12);
        break;
      case DeviceType.POOL:
        ctx.strokeRect(d.x - 6, d.y - 6, d.w + 12, d.h + 12);
        break;
      case DeviceType.ALARM_LIGHT:
        ctx.beginPath();
        ctx.arc(d.cx, d.cy, d.r + 10, 0, Math.PI * 2);
        ctx.stroke();
        break;
    }

    ctx.restore();
  }

  /* ────── 工具方法 ────── */

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  clearSelection() {
    this.selectedDeviceId = null;
  }

  setTargetFPS(fps) {
    this.targetFPS = fps;
    this.frameDuration = 1000 / fps;
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this._resizeHandler);
    this.canvas.removeEventListener('click', this._clickHandler);
    this.canvas.removeEventListener('mousemove', this._moveHandler);
    this.offCanvas = null;
    this.offCtx = null;
    this._hitAreas.clear();
  }
}
