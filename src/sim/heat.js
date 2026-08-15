// Heat field + thermal response (design doc: "Simulation model" / heat field).
//
// OWNS (writes): STATE.heatField, STATE.coolingLoop, STATE.water.litersPerHour,
// and on Building instances: tempC (all buildings), throttleFactor (racks),
// duty (CRACs, CRAHs and chiller plants), waterLitersPerHour (plants).
// READS ONLY: STATE.buildings, STATE.heatwave.active, CONFIG.heat,
// CONFIG.buildings, CONFIG.gridSize, and crac.broken (owned by
// sim/crisis.js) — a broken CRAC's duty is forced to 0, so it neither
// cools nor requests power until repaired.
// Pure sim module — no DOM, no THREE, no clocks, no randomness.
//
// Tick order (tickHeat): rack heat injection -> 4-neighbour diffusion ->
// dissipation toward ambient -> CRAC cooling -> building thermals. Every
// stage takes dt (seconds, already timeScale-scaled) and is a no-op at dt=0.
//
// One-tick CRAC lag (INTENDED): this module writes crac.duty from THIS
// tick's local excess heat; sim/power.js turns that duty into a kW request
// on the NEXT tick; cooling here is gated on actualKw > 0, i.e. on power
// delivered against LAST tick's duty request. A CRAC therefore starts (and
// stops) cooling one tick behind the heat it sees — cheap thermal inertia.
// duty is still computed and stored while unpowered, so power.js can see
// the request and bootstrap the CRAC.
//
// Heatwave: while STATE.heatwave.active, ambient and the diffusion constant
// swap to CONFIG.heat.heatwaveAmbientC / heatwaveDiffusion. Dissipation then
// pulls cool cells UP toward the hotter ambient, and CRACs cannot cool below
// it — both intended.

import { CONFIG } from "../core/config.js";
import { STATE, heatIndex } from "../core/state.js";

const N = CONFIG.gridSize;

// Diffusion double buffer — allocated once at module scope, reused per tick.
const scratch = new Float32Array(N * N);

// The field's floor: what dissipation pulls every cell toward, what a CRAC
// may never cool below, and the zero point every localExcess is measured
// from.
//
// The Lab's ambient knob (STATE.lab.ambientC) moves it. null everywhere
// else, which is the whole of the inertness guarantee here — CONFIG.heat is
// never written, because a written-back CONFIG value survives resetState()
// into every later run (see docs/ARCHITECTURE.md). A heatwave still RAISES
// the floor and can never lower it: without the max, a room the player had
// set to 40 °C would get COOLER the moment they fired a heatwave at it, and
// the button would be teaching the opposite of what a heatwave is.
function currentAmbientC() {
    const base = STATE.lab.ambientC === null ? CONFIG.heat.ambientC : STATE.lab.ambientC;
    return STATE.heatwave.active ? Math.max(base, CONFIG.heat.heatwaveAmbientC) : base;
}

function currentDiffusion() {
    return STATE.heatwave.active ? CONFIG.heat.heatwaveDiffusion : CONFIG.heat.diffusion;
}

// Stage 1 — each powered rack adds actualKw * heatPerKw * dt to its own cell.
export function injectRackHeat(dt) {
    if (dt === 0) return;
    const field = STATE.heatField;
    for (const b of STATE.buildings) {
        if (b.type !== "rack" || b.actualKw <= 0) continue;
        field[heatIndex(b.gx, b.gz)] += b.actualKw * b.config.heatPerKw * dt;
    }
}

// Stage 2 — 4-neighbour diffusion: each cell exchanges rate = diffusion * dt
// of its excess over each neighbour (symmetric, so total heat is conserved).
// rate is clamped to 0.25 — the explicit-scheme stability limit for a
// 4-neighbour kernel — so dt spikes cannot make the field oscillate/explode.
export function diffuseField(dt) {
    if (dt === 0) return;
    const rate = Math.min(currentDiffusion() * dt, 0.25);
    const field = STATE.heatField;
    for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
            const i = z * N + x;
            const c = field[i];
            let flux = 0;
            if (x > 0) flux += field[i - 1] - c;
            if (x < N - 1) flux += field[i + 1] - c;
            if (z > 0) flux += field[i - N] - c;
            if (z < N - 1) flux += field[i + N] - c;
            scratch[i] = c + rate * flux;
        }
    }
    field.set(scratch);
}

// Stage 3 — passive loss toward ambient: field += (ambient - field) * k.
// k is clamped to 1 so a huge dt lands exactly on ambient, never beyond it.
export function dissipateField(dt) {
    if (dt === 0) return;
    const k = Math.min(CONFIG.heat.dissipation * dt, 1);
    const ambient = currentAmbientC();
    const field = STATE.heatField;
    for (let i = 0; i < field.length; i++) {
        field[i] += (ambient - field[i]) * k;
    }
}

// Stage 4 — CRAC cooling. localExcess = sum of (cell - ambient) over the
// Chebyshev-radius box (negative cells count as 0). duty = min(1,
// localExcess / coolPerSec) is ALWAYS written (it is next tick's power
// request) — except while broken (sim/crisis.js), which forces duty 0;
// heat is removed only while powered (actualKw > 0 — see the
// one-tick-lag note in the header), proportionally to each cell's excess,
// clamped so no cell drops below ambient.
// The chilled-water loop. Every CRAH drinks from ONE pool filled by every
// powered chiller plant: if the room asks for more cooling than the plant
// makes, the ratio falls below 1 and EVERY CRAH is throttled by it —
// shared efficiency and shared blast radius are the same property.
//
// Chillers carry the loop's utilisation in their own `duty`, so sim/power.js
// bills them on the same part-load curve as everything else (one tick later,
// the documented lag).
//
// BOTH sides count only machines that are actually RUNNING (powered, not
// broken). A head fed by nothing is inert furniture: without the check, a
// CRAH dropped on the floor and never wired — or one left on a dead bus —
// would drink from the pool it cannot physically reach and throttle every
// working head in the room, which is a punishment for owning a spare.
function isRunning(b) {
    return b.powered && !b.broken;
}

function updateCoolingLoop() {
    let capacity = 0;
    let demand = 0;
    for (const b of STATE.buildings) {
        if (!isRunning(b)) continue;
        if (b.type === "chiller") capacity += b.config.coolUnits;
        else if (b.type === "crah") demand += b.config.coolPerSec * b.duty;
    }
    const ratio = demand > 0 ? Math.min(1, capacity / demand) : 1;
    STATE.coolingLoop.capacityUnits = capacity;
    STATE.coolingLoop.demandUnits = demand;
    STATE.coolingLoop.ratio = ratio;

    const used = Math.min(demand, capacity);
    // WATER. An evaporative tower rejects heat by boiling water off, so the
    // litres follow the cooling actually DELIVERED — coolUnits x duty — and
    // never the nameplate: a plant nobody drinks from sits at duty 0 and
    // evaporates nothing while still paying idleDrawKw. The rate is read off
    // b.config, so a future dry-cooled plant declares no litersPerCoolUnit
    // and drinks nothing; a CRAC has never had the field, which is the entire
    // trade the chapter is about.
    //
    // Loop MEMBERSHIP is still by literal type here, exactly as the supply
    // and demand branches above are (see CONTRIBUTING) — a second plant type
    // added without a branch would drink nothing and the suite would stay
    // green, because nothing iterates CONFIG looking for the field.
    let litersPerHour = 0;
    for (const b of STATE.buildings) {
        if (b.type !== "chiller") continue;
        // A plant that nobody drinks from still pays its idle draw — that is
        // exactly why one chiller behind one CRAH is worse than one CRAC.
        // A plant that is DOWN reads as stopped, whatever its healthy twin is
        // doing: duty drives the bill, the spinning tower AND the water, so
        // leaving it at the loop's utilisation would render a dead plant as
        // busy and keep charging for water it never evaporated.
        b.duty = isRunning(b) && capacity > 0 ? Math.min(1, used / capacity) : 0;
        b.waterLitersPerHour = (b.config.litersPerCoolUnit || 0) * (b.config.coolUnits || 0) * b.duty;
        litersPerHour += b.waterLitersPerHour;
    }
    STATE.water.litersPerHour = litersPerHour;
}

export function applyCracCooling(dt) {
    if (dt === 0) return;
    const field = STATE.heatField;
    const ambient = currentAmbientC();
    // Pass 1: every cooling head works out how hard it WANTS to run, from
    // the heat it can actually reach. This is next tick's power request.
    for (const b of STATE.buildings) {
        if (b.type !== "crac" && b.type !== "crah") continue;
        const { radius, coolPerSec } = b.config;
        const x0 = Math.max(0, b.gx - radius);
        const x1 = Math.min(N - 1, b.gx + radius);
        const z0 = Math.max(0, b.gz - radius);
        const z1 = Math.min(N - 1, b.gz + radius);
        let localExcess = 0;
        for (let z = z0; z <= z1; z++) {
            for (let x = x0; x <= x1; x++) {
                const e = field[z * N + x] - ambient;
                if (e > 0) localExcess += e;
            }
        }
        b.duty = coolPerSec > 0 && !b.broken ? Math.min(1, localExcess / coolPerSec) : 0;
    }

    // Pass 2: settle the shared loop from those wants.
    updateCoolingLoop();

    // Pass 3: actually move the heat. A CRAC delivers its own duty; a CRAH
    // delivers duty x the loop ratio, because it can only spend what the
    // plant made.
    for (const b of STATE.buildings) {
        if (b.type !== "crac" && b.type !== "crah") continue;
        const { radius, coolPerSec } = b.config;
        const x0 = Math.max(0, b.gx - radius);
        const x1 = Math.min(N - 1, b.gx + radius);
        const z0 = Math.max(0, b.gz - radius);
        const z1 = Math.min(N - 1, b.gz + radius);

        let localExcess = 0;
        for (let z = z0; z <= z1; z++) {
            for (let x = x0; x <= x1; x++) {
                const e = field[z * N + x] - ambient;
                if (e > 0) localExcess += e;
            }
        }

        const duty = b.duty;
        // A CRAH can only spend what the plant made. An over-committed or
        // failed loop throttles every head on it at once, which an air-cooled
        // CRAC beside it does not even notice.
        const delivered = b.config.needsLoop ? duty * STATE.coolingLoop.ratio : duty;

        if (b.actualKw <= 0 || delivered <= 0 || localExcess === 0) continue;

        const totalRemove = coolPerSec * delivered * dt;
        for (let z = z0; z <= z1; z++) {
            for (let x = x0; x <= x1; x++) {
                const i = z * N + x;
                const e = field[i] - ambient;
                if (e <= 0) continue;
                const removed = totalRemove * (e / localExcess);
                field[i] = Math.max(ambient, field[i] - removed);
            }
        }
    }
}

// Stage 5 — mirror the field back onto buildings: every building reads its
// cell into tempC; racks derive throttleFactor (1 at/below throttleStartC,
// linear to 0 at shutdownC, 0 above).
export function updateBuildingThermals(dt) {
    if (dt === 0) return;
    const field = STATE.heatField;
    for (const b of STATE.buildings) {
        b.tempC = field[heatIndex(b.gx, b.gz)];
        if (b.type !== "rack") continue;
        const { throttleStartC, shutdownC } = b.config;
        if (b.tempC <= throttleStartC) {
            b.throttleFactor = 1;
        } else if (b.tempC >= shutdownC) {
            b.throttleFactor = 0;
        } else {
            b.throttleFactor = (shutdownC - b.tempC) / (shutdownC - throttleStartC);
        }
    }
}

// One thermal tick. dt is in seconds, already timeScale-scaled by the
// caller; dt === 0 (pause) freezes the field and every derived value.
export function tickHeat(dt) {
    if (dt === 0) return;
    injectRackHeat(dt);
    diffuseField(dt);
    dissipateField(dt);
    applyCracCooling(dt);
    updateBuildingThermals(dt);
}
