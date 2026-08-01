// Heat field + thermal response (design doc: "Simulation model" / heat field).
//
// OWNS (writes): STATE.heatField, and on Building instances: tempC (all
// buildings), throttleFactor (racks), duty (CRACs).
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

function currentAmbientC() {
    return STATE.heatwave.active ? CONFIG.heat.heatwaveAmbientC : CONFIG.heat.ambientC;
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
export function applyCracCooling(dt) {
    if (dt === 0) return;
    const field = STATE.heatField;
    const ambient = currentAmbientC();
    for (const b of STATE.buildings) {
        if (b.type !== "crac") continue;
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

        const duty = coolPerSec > 0 && !b.broken ? Math.min(1, localExcess / coolPerSec) : 0;
        b.duty = duty;

        if (b.actualKw <= 0 || duty === 0 || localExcess === 0) continue;

        const totalRemove = coolPerSec * duty * dt;
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
