/**
 * 智慧泵站 — 主引擎：设备管理、场景切换、数据模拟
 */

class PumpStationEngine {
  constructor() {
    this.devices = new Map();
    this.deviceStates = {};
    this.waterLevels = { pool_in: 0.65, pool_out: 0.5 };
    this.currentScenario = 'normal';
    this.alarms = [];
    this._listeners = [];
    this._dataTimer = null;
    this._dataInterval = 2000; // 模拟数据刷新周期 ms

    // 初始化设备
    DEVICES.forEach(d => {
      this.devices.set(d.id, { ...d });
      if (d.status !== undefined) {
        this.deviceStates[d.id] = d.status;
      }
    });

    this.applyScenario('normal');
  }

  /* ────── 场景切换 ────── */

  applyScenario(key) {
    const sc = SCENARIOS[key];
    if (!sc) return;

    this.currentScenario = key;

    // 设置设备状态
    for (const [devId, status] of Object.entries(sc.devices)) {
      this.deviceStates[devId] = status;
    }

    // 设置水位
    this.waterLevels = { ...sc.waterLevels };

    // 设置告警
    this.alarms = (sc.alarms || []).map((a, i) => ({
      id: i,
      level: a.level,
      msg: a.msg,
      time: this._timeStr(),
    }));

    this._notify('scenarioChange', { scenario: key, label: sc.label });
  }

  switchScenario(key) {
    this.applyScenario(key);
  }

  /* ────── 设备查询 ────── */

  getDevice(id) {
    return this.devices.get(id) || null;
  }

  getDeviceList() {
    return Array.from(this.devices.values());
  }

  getDeviceStatus(id) {
    return this.deviceStates[id] || DeviceStatus.STOPPED;
  }

  setDeviceStatus(id, status) {
    this.deviceStates[id] = status;
    this._notify('statusChange', { deviceId: id, status });
  }

  /* ────── 模拟数据 ────── */

  getDeviceData(id) {
    const dev = this.devices.get(id);
    if (!dev) return null;
    return generateDeviceData(dev, this.currentScenario);
  }

  startDataRefresh(callback) {
    this.stopDataRefresh();
    this._dataCallback = callback;
    this._dataTimer = setInterval(() => {
      if (this._dataCallback) {
        this._dataCallback();
      }
      this._notify('dataRefresh');
    }, this._dataInterval);
  }

  stopDataRefresh() {
    if (this._dataTimer) {
      clearInterval(this._dataTimer);
      this._dataTimer = null;
    }
  }

  /* ────── 告警 ────── */

  getAlarms() {
    return this.alarms;
  }

  /* ────── 夜间模式 ────── */

  isNightMode() {
    return this.currentScenario === 'nightLow';
  }

  /* ────── 事件系统 ────── */

  on(event, fn) {
    this._listeners.push({ event, fn });
  }

  off(event, fn) {
    this._listeners = this._listeners.filter(
      l => !(l.event === event && l.fn === fn)
    );
  }

  _notify(event, data) {
    for (const l of this._listeners) {
      if (l.event === event) {
        try { l.fn(data); } catch (e) { console.error(e); }
      }
    }
  }

  /* ────── 工具 ────── */

  _timeStr() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' +
           d.getMinutes().toString().padStart(2, '0') + ':' +
           d.getSeconds().toString().padStart(2, '0');
  }

  /* ────── 资源释放 ────── */

  destroy() {
    this.stopDataRefresh();
    this._listeners = [];
    this.devices.clear();
  }
}
