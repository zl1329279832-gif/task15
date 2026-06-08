/**
 * 智慧泵站 — UI 交互：侧边面板、场景按钮、告警列表
 */

class PumpStationUI {
  constructor(engine, renderer) {
    this.engine = engine;
    this.renderer = renderer;

    // DOM 缓存
    this.$panel      = document.getElementById('side-panel');
    this.$panelTitle  = document.getElementById('panel-title');
    this.$panelStatus = document.getElementById('panel-status');
    this.$panelData   = document.getElementById('panel-data');
    this.$panelClose  = document.getElementById('panel-close');
    this.$alarmList   = document.getElementById('alarm-list');
    this.$alarmCount  = document.getElementById('alarm-count');
    this.$sceneBar    = document.getElementById('scene-buttons');
    this.$scenarioLabel = document.getElementById('scenario-label');
    this.$clock       = document.getElementById('header-clock');

    this._currentDeviceId = null;
    this._refreshTimer = null;
  }

  init() {
    this._initSceneButtons();
    this._initPanelEvents();
    this._initRendererCallback();
    this._initEngineEvents();
    this._updateAlarms();
    this._startClock();
    // 默认选中 normal
    this._setActiveSceneBtn('normal');
  }

  /* ────── 场景按钮 ────── */

  _initSceneButtons() {
    const btns = this.$sceneBar.querySelectorAll('[data-scene]');
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.scene;
        this.engine.switchScenario(key);
        this._setActiveSceneBtn(key);
        this._syncRenderer();
        this._updateAlarms();
        // 如果有打开的面板，刷新数据
        if (this._currentDeviceId) {
          this._refreshPanel();
        }
      });
    });
  }

  _setActiveSceneBtn(key) {
    const btns = this.$sceneBar.querySelectorAll('[data-scene]');
    btns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scene === key);
    });
    const sc = SCENARIOS[key];
    if (sc && this.$scenarioLabel) {
      this.$scenarioLabel.textContent = sc.description;
    }
  }

  /* ────── 侧边面板 ────── */

  _initPanelEvents() {
    this.$panelClose.addEventListener('click', () => {
      this.hidePanel();
    });
  }

  showPanel(device) {
    this._currentDeviceId = device.id;
    this.$panel.classList.add('open');
    this._refreshPanel();
  }

  hidePanel() {
    this._currentDeviceId = null;
    this.$panel.classList.remove('open');
    this.renderer.clearSelection();
  }

  _refreshPanel() {
    const id = this._currentDeviceId;
    if (!id) return;

    const dev = this.engine.getDevice(id);
    if (!dev) return;

    const data = this.engine.getDeviceData(id);
    if (!data) return;

    // 标题
    this.$panelTitle.textContent = dev.name;

    // 状态
    const statusColor = STATUS_COLORS[data.status] || '#999';
    this.$panelStatus.innerHTML =
      '<span class="status-dot" style="background:' + statusColor + '"></span>' +
      '<span class="status-text" style="color:' + statusColor + '">' +
      (data.statusLabel || '未知') + '</span>';

    // 数据字段
    const fields = DATA_FIELDS[dev.type] || [];
    let html = '';
    for (const f of fields) {
      const val = data[f.key];
      const unit = data[f.key + 'Unit'] || '';
      const displayVal = val === null ? '<span class="offline-val">--</span>'
                       : (typeof val === 'number' ? val.toLocaleString() : val);
      html += '<div class="data-row">' +
                '<span class="data-label">' + f.label + '</span>' +
                '<span class="data-value">' + displayVal +
                  '<span class="data-unit">' + unit + '</span>' +
                '</span>' +
              '</div>';
    }
    this.$panelData.innerHTML = html;
  }

  /* ────── 告警列表 ────── */

  _updateAlarms() {
    const alarms = this.engine.getAlarms();
    this.$alarmCount.textContent = alarms.length;
    this.$alarmCount.className = 'alarm-badge' + (alarms.length > 0 ? ' has-alarm' : '');

    if (alarms.length === 0) {
      this.$alarmList.innerHTML = '<div class="alarm-empty">系统运行正常，无告警</div>';
      return;
    }

    let html = '';
    for (const a of alarms) {
      html += '<div class="alarm-item alarm-' + a.level + '">' +
                '<span class="alarm-icon">' + this._alarmIcon(a.level) + '</span>' +
                '<span class="alarm-msg">' + a.msg + '</span>' +
                '<span class="alarm-time">' + a.time + '</span>' +
              '</div>';
    }
    this.$alarmList.innerHTML = html;
  }

  _alarmIcon(level) {
    switch (level) {
      case 'error':   return '&#9888;';  // ⚠
      case 'warning': return '&#9888;';
      case 'info':    return '&#8505;';   // ℹ
      default:        return '&#8226;';
    }
  }

  /* ────── Renderer 联动 ────── */

  _initRendererCallback() {
    this.renderer.onDeviceClick = (dev) => {
      this.showPanel(dev);
    };
  }

  _syncRenderer() {
    this.renderer.updateStates(
      this.engine.deviceStates,
      this.engine.waterLevels,
      this.engine.isNightMode()
    );
  }

  /* ────── Engine 事件 ────── */

  _initEngineEvents() {
    this.engine.on('dataRefresh', () => {
      if (this._currentDeviceId) {
        this._refreshPanel();
      }
    });
  }

  /* ────── 时钟 ────── */

  _startClock() {
    const tick = () => {
      const now = new Date();
      const str = now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' ' +
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
      if (this.$clock) this.$clock.textContent = str;
    };
    tick();
    this._clockTimer = setInterval(tick, 1000);
  }

  /* ────── 资源释放 ────── */

  destroy() {
    if (this._clockTimer) clearInterval(this._clockTimer);
    this.hidePanel();
  }
}
