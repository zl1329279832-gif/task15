/**
 * 智慧泵站 — 场景配置与模拟数据
 */

/* ========== 枚举 ========== */

const DeviceStatus = Object.freeze({
  RUNNING:  'running',
  STOPPED:  'stopped',
  FAULT:    'fault',
  MAINTAIN: 'maintain',
  OFFLINE:  'offline',
});

const DeviceType = Object.freeze({
  PUMP:        'pump',
  VALVE:       'valve',
  SENSOR:      'sensor',
  CONTROL_BOX: 'controlBox',
  ALARM_LIGHT: 'alarmLight',
  POOL:        'pool',
  PUMP_HOUSE:  'pumpHouse',
});

/* ========== 状态颜色 ========== */

const STATUS_COLORS = {
  [DeviceStatus.RUNNING]:  '#00e676',
  [DeviceStatus.STOPPED]:  '#9e9e9e',
  [DeviceStatus.FAULT]:    '#ff1744',
  [DeviceStatus.MAINTAIN]: '#ff9100',
  [DeviceStatus.OFFLINE]:  '#616161',
};

const STATUS_LABELS = {
  [DeviceStatus.RUNNING]:  '运行',
  [DeviceStatus.STOPPED]:  '停机',
  [DeviceStatus.FAULT]:    '故障',
  [DeviceStatus.MAINTAIN]: '检修',
  [DeviceStatus.OFFLINE]:  '离线',
};

/* ========== 设备定义 ========== */

const DEVICES = [
  // 水池
  {
    id: 'pool_in',   type: DeviceType.POOL, name: '进水池',
    x: 60,  y: 250, w: 170, h: 260, waterRatio: 0.65,
  },
  {
    id: 'pool_out',  type: DeviceType.POOL, name: '出水池',
    x: 1170, y: 250, w: 170, h: 260, waterRatio: 0.50,
  },
  // 泵房
  {
    id: 'house', type: DeviceType.PUMP_HOUSE, name: '泵房',
    x: 440, y: 180, w: 520, h: 420,
  },
  // 水泵
  {
    id: 'pump1', type: DeviceType.PUMP, name: '1# 水泵',
    cx: 620, cy: 310, r: 45, status: DeviceStatus.RUNNING,
  },
  {
    id: 'pump2', type: DeviceType.PUMP, name: '2# 水泵',
    cx: 620, cy: 470, r: 45, status: DeviceStatus.RUNNING,
  },
  // 阀门
  {
    id: 'valve1', type: DeviceType.VALVE, name: '进水阀门',
    cx: 350, cy: 390, size: 28, status: DeviceStatus.RUNNING,
  },
  {
    id: 'valve2', type: DeviceType.VALVE, name: '出水阀门',
    cx: 1060, cy: 390, size: 28, status: DeviceStatus.RUNNING,
  },
  // 传感器
  {
    id: 'sensor1', type: DeviceType.SENSOR, name: '进水压力传感器',
    cx: 500, cy: 570, size: 18, status: DeviceStatus.RUNNING,
  },
  {
    id: 'sensor2', type: DeviceType.SENSOR, name: '出水流量传感器',
    cx: 780, cy: 570, size: 18, status: DeviceStatus.RUNNING,
  },
  // 电控柜
  {
    id: 'ctrlBox', type: DeviceType.CONTROL_BOX, name: '电控柜',
    x: 600, y: 95, w: 200, h: 75, status: DeviceStatus.RUNNING,
  },
  // 告警灯
  {
    id: 'alarm', type: DeviceType.ALARM_LIGHT, name: '告警灯',
    cx: 700, cy: 62, r: 14, status: DeviceStatus.STOPPED, // stopped = 灯灭
  },
];

/* ========== 管道定义 ========== */
// 每段管道是一组折线点，relatedDevices 决定水流是否活跃

const PIPES = [
  {
    id: 'pipe_inlet',
    points: [[230, 390], [340, 390]],
    relatedDevices: ['valve1'],
  },
  {
    id: 'pipe_v1_to_split',
    points: [[360, 390], [500, 390]],
    relatedDevices: ['valve1'],
  },
  // 上支路 → 泵1
  {
    id: 'pipe_split_up',
    points: [[500, 390], [500, 310], [575, 310]],
    relatedDevices: ['pump1'],
  },
  {
    id: 'pipe_pump1_out',
    points: [[665, 310], [800, 310], [800, 390]],
    relatedDevices: ['pump1'],
  },
  // 下支路 → 泵2
  {
    id: 'pipe_split_down',
    points: [[500, 390], [500, 470], [575, 470]],
    relatedDevices: ['pump2'],
  },
  {
    id: 'pipe_pump2_out',
    points: [[665, 470], [800, 470], [800, 390]],
    relatedDevices: ['pump2'],
  },
  // 合流后
  {
    id: 'pipe_merge_to_v2',
    points: [[800, 390], [1050, 390]],
    relatedDevices: ['valve2'],
  },
  {
    id: 'pipe_outlet',
    points: [[1070, 390], [1170, 390]],
    relatedDevices: ['valve2'],
  },
];

/* ========== 场景配置 ========== */

const SCENARIOS = {
  normal: {
    label: '正常运行',
    description: '所有设备正常运行，水位正常',
    devices: {
      pump1:   DeviceStatus.RUNNING,
      pump2:   DeviceStatus.RUNNING,
      valve1:  DeviceStatus.RUNNING,
      valve2:  DeviceStatus.RUNNING,
      sensor1: DeviceStatus.RUNNING,
      sensor2: DeviceStatus.RUNNING,
      ctrlBox: DeviceStatus.RUNNING,
      alarm:   DeviceStatus.STOPPED,
    },
    waterLevels: { pool_in: 0.65, pool_out: 0.50 },
    alarms: [],
  },

  highLevel: {
    label: '液位过高',
    description: '进水池液位超限，告警触发',
    devices: {
      pump1:   DeviceStatus.RUNNING,
      pump2:   DeviceStatus.RUNNING,
      valve1:  DeviceStatus.RUNNING,
      valve2:  DeviceStatus.RUNNING,
      sensor1: DeviceStatus.RUNNING,
      sensor2: DeviceStatus.RUNNING,
      ctrlBox: DeviceStatus.RUNNING,
      alarm:   DeviceStatus.RUNNING, // 告警灯亮
    },
    waterLevels: { pool_in: 0.92, pool_out: 0.70 },
    alarms: [
      { level: 'error',   msg: '进水池液位超高限 (92%)，请立即处理' },
      { level: 'warning', msg: '出水池液位偏高 (70%)' },
    ],
  },

  pumpFault: {
    label: '泵组故障',
    description: '2# 水泵故障停机，1# 水泵满负荷运行',
    devices: {
      pump1:   DeviceStatus.RUNNING,
      pump2:   DeviceStatus.FAULT,
      valve1:  DeviceStatus.RUNNING,
      valve2:  DeviceStatus.RUNNING,
      sensor1: DeviceStatus.RUNNING,
      sensor2: DeviceStatus.RUNNING,
      ctrlBox: DeviceStatus.RUNNING,
      alarm:   DeviceStatus.RUNNING,
    },
    waterLevels: { pool_in: 0.78, pool_out: 0.35 },
    alarms: [
      { level: 'error',   msg: '2# 水泵过载保护跳闸，已停机' },
      { level: 'warning', msg: '1# 水泵满负荷运行，注意监控温度' },
      { level: 'info',    msg: '已通知维修班组' },
    ],
  },

  sensorOffline: {
    label: '传感器离线',
    description: '进水压力传感器离线，数据丢失',
    devices: {
      pump1:   DeviceStatus.RUNNING,
      pump2:   DeviceStatus.STOPPED,
      valve1:  DeviceStatus.RUNNING,
      valve2:  DeviceStatus.RUNNING,
      sensor1: DeviceStatus.OFFLINE,
      sensor2: DeviceStatus.RUNNING,
      ctrlBox: DeviceStatus.RUNNING,
      alarm:   DeviceStatus.RUNNING,
    },
    waterLevels: { pool_in: 0.55, pool_out: 0.40 },
    alarms: [
      { level: 'error',   msg: '进水压力传感器通信中断，数据不可用' },
      { level: 'warning', msg: '2# 水泵计划停机检修' },
    ],
  },

  nightLow: {
    label: '夜间低负载',
    description: '夜间用水量低，仅1台泵低速运行',
    devices: {
      pump1:   DeviceStatus.RUNNING,
      pump2:   DeviceStatus.STOPPED,
      valve1:  DeviceStatus.RUNNING,
      valve2:  DeviceStatus.RUNNING,
      sensor1: DeviceStatus.RUNNING,
      sensor2: DeviceStatus.RUNNING,
      ctrlBox: DeviceStatus.RUNNING,
      alarm:   DeviceStatus.STOPPED,
    },
    waterLevels: { pool_in: 0.45, pool_out: 0.38 },
    alarms: [],
  },
};

/* ========== 模拟数据生成 ========== */

function generateDeviceData(device, scenarioKey) {
  const scenario = SCENARIOS[scenarioKey] || SCENARIOS.normal;
  const status = scenario.devices[device.id] || DeviceStatus.STOPPED;
  const isRunning = status === DeviceStatus.RUNNING;
  const isFault   = status === DeviceStatus.FAULT;
  const isOffline = status === DeviceStatus.OFFLINE;
  const isNight   = scenarioKey === 'nightLow';

  const base = {
    status,
    statusLabel: STATUS_LABELS[status],
  };

  switch (device.type) {
    case DeviceType.PUMP:
      return {
        ...base,
        flow:       isRunning ? +(Math.random() * 200 + (isNight ? 80 : 300)).toFixed(1) : 0,
        pressure:   isRunning ? +(Math.random() * 0.2 + (isNight ? 0.3 : 0.45)).toFixed(2) : 0,
        temperature:isRunning ? +(Math.random() * 5 + (isFault ? 78 : 42)).toFixed(1) : 25.0,
        power:      isRunning ? +(Math.random() * 10 + (isNight ? 25 : 55)).toFixed(1) : 0,
        runtime:    isRunning ? Math.floor(Math.random() * 5000 + 1200) : 0,
        vibration:  isRunning ? +(Math.random() * 0.5 + (isFault ? 4.2 : 1.1)).toFixed(2) : 0,
        flowUnit:   'm³/h',
        pressureUnit: 'MPa',
        temperatureUnit: '°C',
        powerUnit:  'kW',
        runtimeUnit:'h',
        vibrationUnit: 'mm/s',
      };

    case DeviceType.VALVE:
      return {
        ...base,
        opening:    isRunning ? +(Math.random() * 5 + (isNight ? 45 : 85)).toFixed(1) : 0,
        flow:       isRunning ? +(Math.random() * 100 + (isNight ? 150 : 500)).toFixed(1) : 0,
        pressure:   isRunning ? +(Math.random() * 0.1 + 0.35).toFixed(2) : 0,
        runtime:    isRunning ? Math.floor(Math.random() * 8000 + 2000) : 0,
        openingUnit:'%',
        flowUnit:   'm³/h',
        pressureUnit:'MPa',
        runtimeUnit:'h',
      };

    case DeviceType.SENSOR:
      return {
        ...base,
        value:      isOffline ? null : +(Math.random() * 0.2 + 0.4).toFixed(2),
        signal:     isOffline ? 0 : Math.floor(Math.random() * 15 + 85),
        battery:    isOffline ? 0 : Math.floor(Math.random() * 20 + 75),
        runtime:    isRunning ? Math.floor(Math.random() * 10000 + 5000) : 0,
        valueUnit:  device.id === 'sensor1' ? 'MPa' : 'm³/h',
        signalUnit: '%',
        batteryUnit:'%',
        runtimeUnit:'h',
      };

    case DeviceType.CONTROL_BOX:
      return {
        ...base,
        voltage:    isRunning ? +(Math.random() * 5 + 378).toFixed(1) : 0,
        current:    isRunning ? +(Math.random() * 10 + 85).toFixed(1) : 0,
        power:      isRunning ? +(Math.random() * 20 + (isNight ? 30 : 100)).toFixed(1) : 0,
        temperature:isRunning ? +(Math.random() * 3 + 35).toFixed(1) : 25.0,
        runtime:    isRunning ? Math.floor(Math.random() * 15000 + 8000) : 0,
        voltageUnit:'V',
        currentUnit:'A',
        powerUnit:  'kW',
        temperatureUnit:'°C',
        runtimeUnit:'h',
      };

    case DeviceType.POOL: {
      const wl = scenario.waterLevels[device.id] || 0.5;
      return {
        ...base,
        status: DeviceStatus.RUNNING,
        statusLabel: STATUS_LABELS[DeviceStatus.RUNNING],
        level:       +(wl * 100).toFixed(1),
        volume:      +(wl * 500).toFixed(0),
        temperature: +(Math.random() * 2 + 18).toFixed(1),
        levelUnit:   '%',
        volumeUnit:  'm³',
        temperatureUnit: '°C',
      };
    }

    case DeviceType.ALARM_LIGHT:
      return {
        ...base,
        activeAlarms: scenario.alarms.length,
      };

    default:
      return base;
  }
}

/* ========== 数据面板字段映射 ========== */

const DATA_FIELDS = {
  [DeviceType.PUMP]: [
    { key: 'flow',        label: '流量' },
    { key: 'pressure',    label: '压力' },
    { key: 'temperature', label: '温度' },
    { key: 'power',       label: '功率' },
    { key: 'vibration',   label: '振动' },
    { key: 'runtime',     label: '运行时长' },
  ],
  [DeviceType.VALVE]: [
    { key: 'opening',  label: '开度' },
    { key: 'flow',     label: '流量' },
    { key: 'pressure', label: '压力' },
    { key: 'runtime',  label: '运行时长' },
  ],
  [DeviceType.SENSOR]: [
    { key: 'value',   label: '测量值' },
    { key: 'signal',  label: '信号强度' },
    { key: 'battery', label: '电池电量' },
    { key: 'runtime', label: '运行时长' },
  ],
  [DeviceType.CONTROL_BOX]: [
    { key: 'voltage',     label: '电压' },
    { key: 'current',     label: '电流' },
    { key: 'power',       label: '功率' },
    { key: 'temperature', label: '温度' },
    { key: 'runtime',     label: '运行时长' },
  ],
  [DeviceType.POOL]: [
    { key: 'level',       label: '液位' },
    { key: 'volume',      label: '容量' },
    { key: 'temperature', label: '水温' },
  ],
  [DeviceType.ALARM_LIGHT]: [
    { key: 'activeAlarms', label: '活跃告警数' },
  ],
};
