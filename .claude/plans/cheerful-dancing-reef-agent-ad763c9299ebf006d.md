# Pump Station Real-Time Simulation: Complete Implementation Plan

## Executive Summary

Transform a 3-file (520 LOC), 5-scene static visualization demo into an 8-file
real-time simulation system with a deterministic physics engine, device linkage
cascade, alarm management, trend curves, and a mode-switching state machine, all
rendered from a single immutable snapshot per tick.

---

## Part 1: Architectural Analysis of Current Code

### 1.1 Critical Defects Preventing Simulation

| Defect | Location | Impact |
|--------|----------|--------|
| Shared mutable equipment[] array | data.js:11-28, mutated at app.js:44 | Renderer reads same refs; no snapshot isolation |
| switchScene() directly mutates equipment | app.js:44 | No atomic state swap; partial updates visible mid-frame |
| Two unmanaged setInterval calls | app.js:7 (updateClock), app.js:19 (statFPS) | Timer IDs not stored; cannot cancel on reset |
| dataTimer generates random data every 3s | app.js:92-94 | No physics, no continuity |
| Renderer reads directly from currentEquipment | renderer.js:5,127 | Same mutable array |
| tankDisplayLevel lerps toward tankConfig.level | renderer.js:40 | Renderer reaches into data module |
| Scene presets are static snapshots | data.js:51-126 | Cannot emerge organically |
| No alarm model | app.js:82-86 | Just pre-baked arrays; no dedup, no ack |

### 1.2 What Must Be Preserved

- All Canvas drawing functions (~180 lines of high-quality rendering)
- Hit-test geometry and SIZES constants
- Building/tank geometry constants
- Equipment topology (ids, types, names, positions)
- Pipe topology (ids, points arrays)
- CSS design system (variables, dark theme, responsive breakpoints)
- Chinese labels and UI language

### 1.3 What Must Be Discarded

- `scenes` object replaced by emergent simulation state
- `generateData()` / `generateSceneData()` replaced by physics model
- `dataRanges` random range tables replaced by computed sensor values
- `switchScene()` in app.js replaced by mode/fault commands
- Scene button bar in HTML replaced by mode controls and fault injection
- 3-second setInterval data refresh replaced by engine tick

---

## Part 2: Target Architecture

### 2.1 Module Dependency Graph

    index.html
      data.js (static definitions, all Object.freeze-wrapped)
         |
         +---> engine.js (simulation core)
         |        |
         |        +---> produces frozen snapshot each tick
         |                    |
         |                    +---> renderer.js (Canvas, reads snapshot only)
         |                    +---> app.js (DOM updates from snapshot)
         |                    +---> trend.js (ring buffer + mini chart)
         |
         +---> verify.js (test driver, calls engine API)

### 2.2 Unidirectional Data Flow

    User Action --> App (mode state machine)
                        |
                        v
                  Engine.tick()
                        |
                        +-- 1. Read current mutable state
                        +-- 2. Compute physics (flow, level, pressure, temp)
                        +-- 3. Compute linkage cascade (interlocks)
                        +-- 4. Detect alarm conditions (with dedup)
                        +-- 5. Integrate energy (kWh)
                        +-- 6. Produce frozen snapshot (Object.freeze)
                        |
                        v
                  +--- Snapshot ---+
                  |                 |
                  v                 v
            Renderer.update()  App.updateDOM()
            (Canvas frame)     (panel, alarms, stats)
                  |
                  v
             Trend.push(snapshot)
             Trend.draw()

### 2.3 Snapshot Schema

    Object.freeze({
      timestamp:     Number,       // ms since epoch
      simTime:       Number,       // seconds since sim start
      mode:          'IDLE' | 'RUNNING' | 'PAUSED',
      subMode:       'AUTO' | 'MANUAL',

      equipment: {
        pump1: { state, flow, pressure, temperature, power, speed },
        v1:    { state, openPct },
        s_flow_in: { state, reading },
        tank: { state },
        alarm_light: { state },
        // ... all 16 equipment items, each sub-frozen
      },

      tank: { level, inflow, outflow },
      pipes: { inlet: true, header: true, drop1: true, ... },
      sensors: {
        s_flow_in:  { reading, unit, state, noisy },
        s_level:    { reading, unit, state, noisy },
        // ... all 5 sensors
      },
      alarms: {
        active: [{ id, timestamp, severity, message, source, dedupKey, acked }],
        unackedCount: Number
      },
      energy: { totalKWh, pumpKWh: { pump1, pump2, pump3 } },
      isNight: Boolean,
      activePipeIds: ['inlet', 'header', ...]
    })

---

## Part 3: Detailed File Specifications

### 3.1 js/data.js -- REWRITE: Static Definitions Only

**Purpose:** Immutable configuration. No random data generation. No scenes.

**Key exports (via IIFE return, all Object.freeze-wrapped):**

- `STATES`, `STATE_LABELS` -- same as current but frozen
- `equipment[]` -- each item gets a `config` sub-object with type-specific params:
  - Pumps: ratedFlow (300 m3/h), ratedPressure (0.55 MPa), ratedPower (110 kW), ratedSpeed (1450 RPM), inertia (2.0 s)
  - Valves: pipeId, flowCoeff (350-500), pumpId (for pump-valve pairing)
  - Sensors: sensorType, source (what sim variable it reads), noiseSigma
  - Tank: area (50 m2), maxLevel, minLevel, drainCoeff (20 m3/h per sqrt(level))
- `pipes[]` -- same points/color, plus from/to junction names, optional valveId
- `tank` -- geometry (unchanged) plus physics params (area, levelHigh=0.85, levelLow=0.20, levelHighHigh=0.95, drainCoeff)
- `buildings` -- unchanged, frozen
- `linkageRules[]` -- ordered cascade steps per trigger type:
  - pump-fault: mark fault, close valve, trip pump, start backup (if AUTO), open backup valve, generate alarms, update alarm_light
  - tank-high-level: alarm, start all available pumps (if AUTO)
  - tank-low-level: alarm, update alarm_light
  - sensor-offline: mark offline, alarm, update alarm_light
- `pipeActivationMap{}` -- per pipe: which equipment determines active state + flow threshold
- `pumpValveMap{}` -- pump1->v1, pump2->v2, pump3->v3
- `valvePumpMap{}` -- reverse of above
- `pumpPriority[]` -- ['pump1', 'pump2', 'pump3'] for auto start/stop ordering
- `createInitialState()` -- factory function returning fresh deep-copy of initial state

**Removed:** scenes, generateData(), generateSceneData(), dataRanges

**createInitialState() returns:**
  - pump1/pump2: state=running; pump3: state=stopped
  - v_inlet/v_outlet/v1/v2: state=running, openPct=1.0; v3: stopped, openPct=0
  - All sensors: state=running, reading=0
  - tank: state=running; cabinet: running; alarm_light: stopped
  - tankLevel: 0.60, inflowRate: 500 (constant source supply)
  - energy: {totalKWh:0, pumpKWh:{pump1:0, pump2:0, pump3:0}}
  - alarms: {active:[], history:[], nextId:1}
  - simTime: 0, faultInjections:{}, manualOverrides:{}

### 3.2 js/engine.js -- NEW: Simulation Engine Core

**IIFE module, single authoritative tick loop.**

#### 3.2.1 Internal State and Timer Management

    _state = null           // mutable sim state (only engine writes)
    _snapshot = null        // latest frozen snapshot
    _tickIntervalId = null  // stored timer, always cancellable
    _tickRate = 10          // ticks/sec
    _tickDt = 0.1           // seconds per tick
    _listeners = []         // callback(snapshot) array
    _pendingAlarms = []     // queued during linkage, processed in alarm step

#### 3.2.2 Public API

- `init()` -- calls DataModule.createInitialState(), produces initial snapshot
- `start()` -- guards against double-start, sets mode=RUNNING, starts setInterval
- `stop()` -- clearInterval, null the ID
- `pause()` -- guards (only from RUNNING), stops interval, mode=PAUSED, emits snapshot
- `resume()` -- guards (only from PAUSED), mode=RUNNING, restarts interval
- `reset()` -- stops interval, re-creates state, mode=IDLE, emits snapshot
- `setSubMode(mode)` -- AUTO or MANUAL, stored in _state
- `injectFault(target, type)` -- writes to _state.faultInjections for next tick
- `clearFault(target)` -- removes injection, restores to stopped, clears cascade flag
- `manualToggle(eqId)` -- queues toggle for next tick (MANUAL mode only)
- `ackAlarm(alarmId)` -- marks acked, moves to history, updates alarm_light
- `getSnapshot()` -- returns latest frozen snapshot
- `onTick(callback)` -- registers snapshot consumer

#### 3.2.3 The Tick Function

    function _tick() {
      _state.simTime += _tickDt;
      _processManualOverrides();
      _advancePhysics(_tickDt);
      _processFaultInjections();
      _runLinkageCascade();
      _detectAlarmConditions();
      _integrateEnergy(_tickDt);
      _computePipeActivation();
      _computeSensorReadings();
      _produceSnapshot();
      _notifyListeners();
    }

#### 3.2.4 Physics: Tank Level Integration

Euler integration each tick:

    dLevel/dt = (sumInflow - sumOutflow) / (tankArea * 3600)

- Inflow: sum of running pump flows + source inflow through v_inlet (gated by openPct)
- Outflow: gravity drain = drainCoeff * sqrt(max(0, level))
- Clamp result to [0, 1.0]

#### 3.2.5 Physics: Pump Hydraulics

Per pump per tick:

- If fault/offline/maintenance/stopped:
  flow=0, pressure=0, power=0, speed decays toward 0, temp decays to ambient (22C)

- If running:
  - Speed ramps toward ratedSpeed: speed += (target - speed) * min(1, dt/inertia)
  - valveOpen from pumpValveMap[pumpId] equipment state
  - flow = ratedFlow * speedFrac * valveOpen
  - pressure = ratedPressure * speedFrac^2 - kQ * flow^2 (simplified pump curve)
    where kQ = ratedPressure / ratedFlow^2
  - power = flow * pressure / (efficiency * 3.6)  [kW, with flow m3/h, pressure MPa]
    efficiency = 0.75
  - Temperature model:
    powerLoss = power * (1 - efficiency)
    heatIn = powerLoss * 0.1  (fraction to pump body)
    heatOut = coolingRate * (temp - ambient), coolingRate = 0.5 kW/C
    dTemp = (heatIn - heatOut) / thermalMass * dt, thermalMass = 50 kJ/C

#### 3.2.6 Physics: Sensor Readings

Each sensor reads from simulation state + Gaussian noise (Box-Muller):
- s_flow_in: reads total inflow to tank
- s_press_in: reads average running pump pressure
- s_level: reads tankLevel * 100
- s_flow_out: reads total outflow from tank
- s_temp: reads max pump temperature
- If sensor state is offline: reading = null

#### 3.2.7 Energy Integration

Per pump: kWh += (power * dt) / 3600
Total kWh = sum of all pump kWh increments per tick

#### 3.2.8 Linkage Cascade (AUTO mode only)

Pump fault cascade (executed once per fault, guarded by _cascadeExecuted flag):
1. Set _cascadeExecuted on pump to prevent re-execution
2. Close upstream valve: pumpValveMap[pumpId] state=stopped, openPct=0
3. Pump stays in fault state (speed/flow already zeroed by physics)
4. Find next available backup (stopped, not faulted) -> state=running
5. Open backup valve -> state=running, openPct=1.0
6. Push alarm entries to _pendingAlarms with dedup keys
7. _updateAlarmLight() based on unacked count

Tank high-level linkage (latch pattern):
- Triggers once when level >= levelHigh; latched until level drops below
- Start all available stopped pumps (if AUTO)
- Generate alarm with dedup key tank:high_level

MANUAL mode: entire linkage cascade is skipped. Only direct fault injection applies.

#### 3.2.9 Alarm System

- `_addAlarm(pending)`: check dedup key vs active list; if not present, create with
  auto-incremented id, Date.now() timestamp, push to active array
- `_detectAlarmConditions()`: process _pendingAlarms from linkage, then check
  continuous conditions (sensor offline, pump high temp > 75C)
- `ackAlarm(id)`: find in active, set acked=true, copy to history with ackTime,
  remove from active, call _updateAlarmLight()
- Dedup keys: source:condition e.g. pump1:fault, tank:high_level, s_level:offline

#### 3.2.10 Pipe Activation

For each pipe in pipeActivationMap:
- Check if ANY dependent equipment has flow > threshold or is running with openPct > 0
- Result: boolean map stored in snapshot

#### 3.2.11 Snapshot Production

Deep clone _state into new object structure. Object.freeze() top-level and all
sub-objects (equipment entries, alarm entries, pipe map). Store as _snapshot.
All consumers receive this same frozen reference until next tick replaces it.

### 3.3 js/renderer.js -- REWRITE: Snapshot-Only Canvas Renderer

**Key changes from current renderer.js:**

1. **Remove** module-level mutable refs: currentEquipment, currentPipes, tankConfig
2. **Remove** setters: setNight(), setTankLevel(), setActivePipes()
3. **Add** update(snapshot) method -- stores snapshot reference atomically
4. **Modify** init(cvs, buildings) -- only needs canvas and static buildings
5. **Add** _buildEquipmentList(snapshot) -- converts snapshot equipment map to
   renderable array using DataModule.equipment for positions/names
6. **Add** _buildPipeList(snapshot) -- converts snapshot pipe map to renderable array
   using DataModule.pipes for geometry
7. **Modify** _loop(now) -- add animTime pause guard: only advance animTime when
   currentSnapshot.mode !== PAUSED
8. **Modify** _render(dt) -- derive eqList and pipeList from currentSnapshot, pass
   to draw functions as parameters
9. **Parameterize** all draw functions to accept data as params:
   - drawBackground(isNight)
   - drawPumpHouse(isNight)
   - drawTank(tankSnap, displayLevel)
   - drawPipes(pipeList, dt)
   - drawAllEquipment(eqList)
   - drawLabels(eqList)
   - drawSelectionRing(eqList)

**All drawing function bodies preserved** -- only input source changes from mutable
module-level refs to snapshot-derived data passed as parameters.

**Lines preserved vs changed:**

| Section | Lines | Action |
|---------|-------|--------|
| Constants (FPS, PARTICLE, WAVE, SIZES, STATE_COLORS) | 1-14 | Keep |
| init, resize, start, stop, destroy | 16-29 | Modify: simplify init params, add update() |
| _loop, _render | 31-43 | Modify: pause guard, snapshot-derived data |
| drawBackground | 46-55 | Keep body, parameterize isNight |
| drawPumpHouse | 58-72 | Keep body, parameterize isNight |
| drawTank | 75-96 | Keep body, read from snapshot tank + displayLevel |
| drawPipes, drawFlowParticles | 98-123 | Keep body, iterate snapshot pipe list |
| drawAllEquipment + sub-draws | 126-182 | Keep body, iterate snapshot eq list |
| drawLabels | 184-189 | Keep body, parameterize eqList |
| drawSelectionRing | 191-200 | Keep body, parameterize eqList |
| Hit test | 202-209 | Keep as-is (uses static template positions) |
| Setters | 211-218 | Remove 3 setters; add update() |

### 3.4 js/app.js -- REWRITE: Controller + Mode State Machine

#### 3.4.1 DOM Cache (extended)

Cache all new elements: btnStart, btnPause, btnResume, btnReset, btnAuto,
btnManual, btnPumpFault, btnSensorOffline, btnClearFault, trendCanvas, statMode,
statSimTime, statEnergy, alarmBadge, simLabel.

#### 3.4.2 Mode State Machine

    modeTransitions = {
      IDLE:    { start:  RUNNING },
      RUNNING: { pause:  PAUSED,  reset: IDLE },
      PAUSED:  { resume: RUNNING, reset: IDLE }
    }

    transition(action):
      1. Look up nextMode; if null, return false (ignore invalid)
      2. Execute atomically:
         - start: Engine.setSubMode, Engine.start
         - pause: Engine.pause
         - resume: Engine.resume
         - reset: Engine.reset, Trend.clear, Trend.draw, reset subMode=AUTO
      3. Update currentMode, call updateModeUI()

    setSubMode(mode):
      Engine.setSubMode, updateSubModeUI

#### 3.4.3 Timer Lifecycle (fixing current defects)

- clockTimerId and fpsTimerId stored as module vars
- init() sets them via setInterval
- destroy() clears them via clearInterval and nulls them
- No more dataTimer -- replaced by engine tick

#### 3.4.4 Snapshot Consumer

    function onEngineTick(snapshot) {
      Renderer.update(snapshot);
      Trend.push(snapshot);
      Trend.draw();
      updateStats(snapshot);
      updateAlarmPanel(snapshot);
      if (selectedEqId) updateEquipmentPanel(snapshot);
      updateFooter(snapshot);
    }

Registered via Engine.onTick() during init.

#### 3.4.5 DOM Updates

- updateStats(snap): count running from snap.equipment, read
  snap.alarms.unackedCount, display simTime and totalKWh
- updateAlarmPanel(snap): render snap.alarms.active sorted newest-first,
  with ack buttons for unacked items, acked label for acked items.
  Badge shows unackedCount. Delegated click handler for ack.
- updateEquipmentPanel(snap): read physics values from snap.equipment[id].
  Type-appropriate fields:
  - Pump: flow, pressure, temperature, power, speed, cumulative kWh
  - Valve: openPct
  - Sensor: reading
  - Tank: level, inflow, outflow
  In MANUAL mode: show toggle button for pumps/valves.

#### 3.4.6 Event Binding

- Mode buttons: start/pause/resume/reset call transition()
- Sub-mode: auto/manual call setSubMode()
- Fault injection: Engine.injectFault() / Engine.clearFault()
- Alarm ack: delegated click on .alarm-ack-btn -> Engine.ackAlarm()
- Manual toggle: delegated click on .manual-toggle-btn -> Engine.manualToggle()
- Canvas click/hover: unchanged logic
- Resize: debounce 200ms, call Renderer.resize() + Trend.resize()

### 3.5 js/trend.js -- NEW: Ring Buffer + Mini Chart

**Ring buffer:**
- Capacity: 300 samples (5 minutes at 1 sample/sec)
- Sampling: push() called every engine tick, but only stores if simTime
  advanced >= 1 second since last sample
- Stores per sample: simTime, tankLevel%, totalFlow, totalPower
- clear() resets head/count for reset flow

**Rendering (mini canvas in right panel):**
- Background fill, horizontal grid lines
- 3 traces: tank level (blue, 0-100%), total flow (cyan, 0-1000 m3/h),
  total power (purple, 0-400 kW)
- Each trace: line plot normalized to its own min/max range
- Legend at top, time axis labels at bottom (mm:ss format)
- Empty state: centered waiting message

**API:** init(canvas), resize(), push(snapshot), draw(), clear(), destroy()

### 3.6 js/verify.js -- NEW: Automated Verification Script

**8-test sequence, runs via Verify.runAll() in browser console (async):**

1. **Start AUTO**: reset -> AUTO -> start. Wait 2s.
   Assert: mode=RUNNING, subMode=AUTO, pump1/pump2 running, v1/v2 open,
   tank level 30-90%, inlet/drop1 pipes active.

2. **Inject pump1 fault**: Engine.injectFault(pump1, pump-fault). Wait 500ms.
   Assert: pump1=fault, v1=stopped+openPct=0, pump3=running (backup),
   v3=running, pump1:fault alarm exists, v1:interlock_close alarm exists,
   alarm_light=running, pipe drop1 inactive.

3. **Switch to MANUAL**: App.setSubMode(MANUAL). Inject pump2 fault. Wait 500ms.
   Assert: pump2=fault (direct injection works) but NO auto-linkage
   (v2 not auto-closed, no backup auto-start).

4. **Manual toggle**: Engine.manualToggle(pump3). Wait 300ms.
   Assert: pump3 state changed from previous state.

5. **Pause**: App.transition(pause). Record tankLevel and simTime. Wait 5s.
   Assert: mode=PAUSED, tankLevel unchanged (delta < 0.001),
   simTime unchanged (delta < 0.001).

6. **Resume**: App.transition(resume). Wait 2s.
   Assert: mode=RUNNING, simTime advanced > 1.5s.

7. **Reset**: App.transition(reset). Wait 500ms.
   Assert: mode=IDLE, tankLevel ~= 0.60, energy=0, alarms empty,
   pump1=running (initial), pump3=stopped (initial), alarm_light=stopped.

8. **Rapid switching**: 10 cycles of start->pause->resume->reset with 50ms gaps.
   Assert: final mode=IDLE, no stale alarms. Then start again and verify
   system functional (pump1 running).

### 3.7 index.html -- MODIFIED

Changes from current index.html:

- Title: updated to real-time simulation system
- Header right: ADD mode indicator stat, simTime stat, cumulative energy stat
- Replace #sceneBar (5 scene buttons) with #controlBar containing:
  - Run control group: Start, Pause, Resume, Reset buttons
  - Mode group: Auto, Manual buttons
  - Fault injection group: Pump Fault, Sensor Offline, Clear Fault buttons
- Panel: ADD #panelTrend section with #trendCanvas (height=150)
- Alarm section: ADD #alarmBadge span in h2
- Footer: update version to v2.0.0, change label to sim state
- Script tags: data.js -> engine.js -> trend.js -> renderer.js -> app.js -> verify.js

### 3.8 css/style.css -- MODIFIED

Additions to existing CSS:

- Mode indicator styles (.mode-indicator.idle/.running/.paused)
- Energy stat style (.stat-val.energy)
- #controlBar: absolute bottom, flex layout, backdrop blur, rounded border
- .control-group: flex row, gap, separator border between groups
- .ctrl-btn: base style matching scene-btn aesthetic
- .ctrl-btn.start/.pause/.resume/.reset: colored borders
- .ctrl-btn.mode-btn.active: accent highlight
- .fault-btn: red-tinted
- #trendCanvas: full width, fixed height, dark background, border
- .alarm-badge: red pill badge, hidden when empty
- .alarm-ack-btn: small outlined button
- .acked-label: gray text
- #alarmList li.acked: reduced opacity
- .manual-controls: margin-top block
- .manual-toggle-btn: full-width accent button
- Responsive: controlBar wraps at 900px, full-width at 640px

---

## Part 4: Implementation Order (Step-by-Step with Dependencies)

### Phase 1: Foundation (no visual changes yet)

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 1.1 | js/data.js | Rewrite: freeze configs, add equipment config objects, linkageRules, pipeActivationMap, pumpValveMap, pumpPriority, createInitialState() factory. Remove scenes, generateData, dataRanges. | -- | ~200 |
| 1.2 | js/engine.js | Create skeleton: IIFE shell, state/snapshot/timer vars, init/start/stop/pause/resume/reset/getSnapshot/onTick. Implement _tick() calling stubs. Implement _produceSnapshot() with deep clone + freeze. | 1.1 | ~150 |
| 1.3 | js/engine.js | Implement _computeTankLevel(dt) -- Euler integration. | 1.2 | ~30 |
| 1.4 | js/engine.js | Implement _computePumpHydraulics(pumpId, dt) -- flow, pressure, power, temperature. | 1.2 | ~60 |
| 1.5 | js/engine.js | Implement _computeSensorReadings() -- sim state + Gaussian noise. | 1.4 | ~40 |
| 1.6 | js/engine.js | Implement _integrateEnergy(dt) -- cumulative kWh. | 1.4 | ~15 |
| 1.7 | js/engine.js | Implement _computePipeActivation() -- derives active pipes. | 1.4 | ~25 |

**Phase 1 total: ~520 lines. Testable in console: engine ticks, snapshot has valid physics.**

### Phase 2: Linkage and Alarms

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 2.1 | js/engine.js | Implement _processFaultInjections(), injectFault(), clearFault(). | 1.2 | ~30 |
| 2.2 | js/engine.js | Implement _runLinkageCascade() -- pump fault cascade, tank high-level, backup pump start. | 2.1, 1.4 | ~80 |
| 2.3 | js/engine.js | Implement _addAlarm(), _detectAlarmConditions(), ackAlarm() with dedup. | 2.2 | ~60 |
| 2.4 | js/engine.js | Implement manualToggle(eqId). | 1.2 | ~20 |
| 2.5 | js/engine.js | Implement setSubMode() -- gates linkage. | 2.2 | ~10 |
| 2.6 | js/engine.js | Implement _processManualOverrides(). | 2.4 | ~15 |

**Phase 2 total: ~215 lines. Testable: fault injection -> cascade -> alarms in console.**

### Phase 3: Renderer Refactor

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 3.1 | js/renderer.js | Remove setNight/setTankLevel/setActivePipes. Remove module-level mutable refs. Add update(snapshot). | -- | net -20 |
| 3.2 | js/renderer.js | Add _buildEquipmentList(snapshot) and _buildPipeList(snapshot). | 3.1, 1.1 | ~30 |
| 3.3 | js/renderer.js | Modify _render(dt): derive from snapshot. Add animTime pause guard in _loop. | 3.2 | ~25 |
| 3.4 | js/renderer.js | Parameterize all draw functions to accept data params. | 3.3 | ~40 changed |
| 3.5 | js/renderer.js | Modify init() to accept only (canvas, buildings). | 3.1 | ~5 |

**Phase 3 total: ~80 new/changed, ~20 removed. All draw function bodies preserved.**

### Phase 4: App Controller

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 4.1 | js/app.js | Rewrite skeleton: IIFE, cacheDom(), init(), destroy() with stored timer IDs. | 3.5 | ~50 |
| 4.2 | js/app.js | Implement mode state machine: transition(), setSubMode(), updateModeUI(). | 4.1, 2.5 | ~60 |
| 4.3 | js/app.js | Implement onEngineTick(snapshot) consumer. | 4.1, 3.1 | ~20 |
| 4.4 | js/app.js | Rewrite updateStats(snapshot) from snapshot. | 4.3 | ~15 |
| 4.5 | js/app.js | Rewrite updateAlarmPanel(snapshot) with ack buttons, badge. | 4.3 | ~40 |
| 4.6 | js/app.js | Rewrite updateEquipmentPanel(snapshot) with physics values. | 4.3, 1.1 | ~80 |
| 4.7 | js/app.js | Rewrite bindEvents(): mode/fault/alarm/manual handlers. | 4.2 | ~60 |
| 4.8 | js/app.js | Remove switchScene, startDataRefresh, old scene code. | 4.7 | net -30 |

**Phase 4 total: ~295 new, ~30 removed.**

### Phase 5: Trend Chart

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 5.1 | js/trend.js | Implement ring buffer: init(), push(snapshot), clear(). | -- | ~40 |
| 5.2 | js/trend.js | Implement draw(): grid, traces, legend, time axis. | 5.1 | ~80 |
| 5.3 | js/trend.js | Implement resize(), destroy(). | 5.1 | ~15 |

**Phase 5 total: ~135 lines. Parallelizable with Phases 2-3.**

### Phase 6: HTML and CSS

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 6.1 | index.html | Replace scene bar with control bar. Add trend canvas, alarm badge, new header stats. Update script tags. | 4.7 | ~32 added |
| 6.2 | css/style.css | Add styles for: control bar, buttons, trend, alarm badge/ack, manual controls, mode indicator. | 6.1 | ~81 added |

### Phase 7: Verification

| Step | File | Action | Depends On | Est. Lines |
|------|------|--------|-----------|------------|
| 7.1 | js/verify.js | Implement test harness: runAll(), assert(), wait(). | 4.2, 2.1 | ~30 |
| 7.2 | js/verify.js | Implement tests 1-4: AUTO start, pump fault, MANUAL, manual toggle. | 7.1 | ~80 |
| 7.3 | js/verify.js | Implement tests 5-8: pause/resume, reset, rapid switching stress test. | 7.2 | ~80 |

**Phase 7 total: ~190 lines.**

---

## Part 5: Dependency Graph (Critical Path)

    Step 1.1 (data.js rewrite)
        |
        +---> Step 1.2 (engine skeleton)
        |        |
        |        +---> Step 1.3 (tank physics) ----+
        |        +---> Step 1.4 (pump physics) ----+---> Steps 1.5, 1.6, 1.7
        |        |                                  |
        |        +---> Step 2.1 (fault injection)   |
        |                 |                         |
        |                 +---> Step 2.2 (linkage, needs 1.4+2.1)
        |                          |
        |                          +---> Step 2.3 (alarms)
        |                          +---> Step 2.5 (sub-mode)
        |                          +---> Step 2.4 (manual toggle)
        |                                   |
        |                                   +---> Step 2.6 (overrides)
        |
        +---> Step 3.1 (renderer: remove setters) -- PARALLEL with Phase 2
                 |
                 +---> Steps 3.2-3.5 (renderer refactor)

    Steps 5.1-5.3 (trend.js) -- PARALLEL with Phases 2-3

    Steps 4.1-4.8 (app.js) -- depends on Phases 2, 3, 5

    Steps 6.1-6.2 (HTML/CSS) -- depends on Phase 4

    Steps 7.1-7.3 (verify.js) -- depends on Phase 4

**Critical path:** 1.1 -> 1.2 -> 1.4 -> 2.2 -> 2.3 -> 4.1-4.8 -> 7.1-7.3

**Parallelizable tracks:**
- Phase 3 (renderer) can proceed in parallel with Phase 2 (linkage/alarms)
- Phase 5 (trend) can proceed in parallel with Phases 2 and 3
- Step 6.2 (CSS) can be done incrementally as HTML elements are added

---

## Part 6: Risk Register

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Physics model diverges (level negative/infinite) | High | Medium | Clamp all values in _advancePhysics; _sanitizeState() guard |
| Timer leak from rapid mode switching | High | Medium | start() guards double-start; stop() nulls ID; test 8 stress tests |
| Snapshot not truly immutable | High | Low | Object.freeze recursive; strict mode catches mutation |
| Linkage cascade re-entrance | Medium | Medium | _cascadeExecuted flag per pump per fault; cleared on reset only |
| Alarm storm (continuous condition every tick) | Medium | Low | Dedup key in _addAlarm; latch pattern for continuous conditions |
| Renderer draws stale data after reset | Low | Low | Engine.reset() synchronously produces snapshot before notifying |
| Ring buffer head/count error | Low | Low | Modular arithmetic with explicit count cap; verified in test |
| Canvas resize during tick (race) | Low | Low | Resize only affects canvas dimensions, not simulation state |
| Equipment panel references stale snapshot | Low | Low | Panel reads from latest snapshot in onEngineTick, not cached ref |

---

## Part 7: Final File Inventory

| File | Lines (est.) | Status |
|------|-------------|--------|
| js/data.js | ~200 | REWRITE (from 196) |
| js/engine.js | ~520 | NEW |
| js/renderer.js | ~250 | REWRITE (from 221, net +30) |
| js/app.js | ~350 | REWRITE (from 103) |
| js/trend.js | ~135 | NEW |
| js/verify.js | ~190 | NEW |
| index.html | ~85 | MODIFY (from 53, +32) |
| css/style.css | ~180 | MODIFY (from 99, +81) |
| **Total** | **~1910** | **(from ~670 original)** |

Estimated implementation time: 3-4 focused coding sessions.

---

## Part 8: Key Implementation Patterns

### 8.1 Snapshot Immutability Pattern

Every tick, _produceSnapshot() creates a new object tree with Object.freeze() applied
to the top level and all nested objects/arrays. The previous snapshot is simply replaced.
No consumer can mutate state. The renderer and DOM updater receive the same frozen
reference, guaranteeing frame coherence (both see identical data).

### 8.2 Timer Lifecycle Pattern

Every setInterval/setTimeout ID is stored in a named module variable.
Every start function guards against double-start (if id !== null, return).
Every stop function clears and nulls (clearInterval(id); id = null).
Reset calls stop() before re-initializing. Destroy calls stop on all timers.

### 8.3 State Machine Guard Pattern

All transitions are defined in a lookup table. Invalid transitions return false
and are silently ignored. No intermediate state is visible: the transition
function executes atomically before updating currentMode. Guards prevent
PAUSE when already paused, RESUME when not paused, etc.

### 8.4 Dedup Alarm Pattern

Each alarm condition has a dedupKey string (source:condition). Before adding
a new alarm, the active list is searched for the same key. If found, the
alarm is suppressed. This prevents alarm storms from continuous conditions.
Alarms are only re-generated if the condition clears and re-triggers.

### 8.5 Linkage Latch Pattern

For continuous conditions (tank high level), a latch variable prevents
repeated cascade execution. The latch is set on first trigger and cleared
only when the condition returns to normal. This ensures the cascade runs
exactly once per threshold crossing.
