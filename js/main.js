/**
 * 智慧泵站 — 入口：初始化所有模块，启动渲染循环
 */

(function () {
  'use strict';

  const canvas = document.getElementById('station-canvas');
  if (!canvas) return;

  // 1. 创建引擎
  const engine = new PumpStationEngine();

  // 2. 创建渲染器
  const renderer = new PumpStationRenderer(canvas);
  renderer.setData(DEVICES, PIPES);
  renderer.updateStates(
    engine.deviceStates,
    engine.waterLevels,
    engine.isNightMode()
  );

  // 3. 创建 UI
  const ui = new PumpStationUI(engine, renderer);
  ui.init();

  // 4. 启动渲染循环
  renderer.start();

  // 5. 启动模拟数据刷新（每 2 秒）
  engine.startDataRefresh(() => {
    // 数据刷新时同步渲染器（水位可能微变）
    renderer.updateStates(
      engine.deviceStates,
      engine.waterLevels,
      engine.isNightMode()
    );
  });

  // 6. 告警栏折叠交互
  const alarmHeader = document.getElementById('alarm-header');
  const alarmBar = document.getElementById('alarm-bar');
  if (alarmHeader && alarmBar) {
    alarmHeader.addEventListener('click', () => {
      alarmBar.classList.toggle('expanded');
    });
  }

  // 7. 低性能检测：如果帧率过低自动降低 FPS 目标
  let perfCheckCount = 0;
  let perfCheckSum = 0;
  const perfObserver = () => {
    if (!renderer.running) return;
    const now = performance.now();
    if (renderer.lastFrameTime) {
      perfCheckSum += (now - renderer.lastFrameTime);
      perfCheckCount++;
      if (perfCheckCount >= 60) {
        const avgFrame = perfCheckSum / perfCheckCount;
        if (avgFrame > 50 && renderer.targetFPS > 15) {
          // 帧时间 > 50ms（< 20fps），降到 15fps
          renderer.setTargetFPS(15);
          console.info('[性能] 检测到低帧率，已降至 15 FPS');
        }
        perfCheckCount = 0;
        perfCheckSum = 0;
      }
    }
    requestAnimationFrame(perfObserver);
  };
  requestAnimationFrame(perfObserver);

  // 8. 页面卸载清理
  window.addEventListener('beforeunload', () => {
    renderer.destroy();
    engine.destroy();
    ui.destroy();
  });

  // 可选：按 Escape 关闭面板
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ui.hidePanel();
    }
  });
})();
