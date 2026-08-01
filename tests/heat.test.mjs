// sim/heat.js — heat field + thermal response, node-env unit tests over the
// real modules (no DOM, no THREE).
//
// Tolerance note: STATE.heatField is a Float32Array (contract, state.js), so
// every stored cell is quantized to ~1e-6 relative precision. Whole-field
// conservation sums therefore cannot be asserted at 1e-6 absolute; tests use
// 1e-3 where many float32 cells are rewritten, and tight bounds (1e-6) only
// where values are exactly representable in float32.

import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState, heatIndex } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import {
    tickHeat,
    injectRackHeat,
    diffuseField,
    dissipateField,
    applyCracCooling,
    updateBuildingThermals,
} from "../src/sim/heat.js";

const AMBIENT = CONFIG.heat.ambientC;
const N = CONFIG.gridSize;

function totalHeat() {
    let t = 0;
    for (let i = 0; i < STATE.heatField.length; i++) t += STATE.heatField[i];
    return t;
}

function minCell() {
    let m = Infinity;
    for (let i = 0; i < STATE.heatField.length; i++) m = Math.min(m, STATE.heatField[i]);
    return m;
}

function maxCell() {
    let m = -Infinity;
    for (let i = 0; i < STATE.heatField.length; i++) m = Math.max(m, STATE.heatField[i]);
    return m;
}

function cell(gx, gz) {
    return STATE.heatField[heatIndex(gx, gz)];
}

function setCell(gx, gz, value) {
    STATE.heatField[heatIndex(gx, gz)] = value;
}

function addRack(gx, gz, actualKw) {
    const b = new Building("rack", gx, gz);
    b.actualKw = actualKw;
    b.powered = actualKw > 0;
    STATE.buildings.push(b);
    return b;
}

function addCrac(gx, gz, powered = true) {
    const b = new Building("crac", gx, gz);
    b.actualKw = powered ? b.config.drawKw : 0;
    b.powered = powered;
    STATE.buildings.push(b);
    return b;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("heat injection", () => {
    it("a powered rack adds actualKw * heatPerKw * dt to its own cell", () => {
        addRack(5, 5, 4);
        injectRackHeat(0.125); // 4 kW * 1.0 * 0.125s = 0.5 -> 22.5, exact in float32
        expect(Math.abs(cell(5, 5) - 22.5)).toBeLessThan(1e-6);
        expect(cell(6, 5)).toBe(AMBIENT); // only its own cell
    });

    it("an unpowered rack (actualKw = 0) adds nothing", () => {
        addRack(5, 5, 0);
        injectRackHeat(0.5);
        expect(totalHeat()).toBe(N * N * AMBIENT);
    });

    it("injection accumulates across ticks", () => {
        addRack(5, 5, 4);
        injectRackHeat(0.125);
        injectRackHeat(0.125);
        expect(Math.abs(cell(5, 5) - 23)).toBeLessThan(1e-6);
    });
});

describe("diffusion", () => {
    it("conserves total heat and never creates it (no sinks active)", () => {
        setCell(10, 10, 30);
        const before = totalHeat();
        for (let i = 0; i < 5; i++) diffuseField(0.1);
        expect(Math.abs(totalHeat() - before)).toBeLessThan(1e-3); // float32 store quantization only
        expect(maxCell()).toBeLessThanOrEqual(30 + 1e-3);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT - 1e-6);
    });

    it("first step moves heat to the 4 neighbours only, by diffusion*dt of the excess", () => {
        setCell(10, 10, 30);
        diffuseField(0.1);
        const rate = CONFIG.heat.diffusion * 0.1; // 0.018
        const gained = rate * (30 - AMBIENT);
        expect(Math.abs(cell(9, 10) - (AMBIENT + gained))).toBeLessThan(1e-3);
        expect(Math.abs(cell(10, 9) - (AMBIENT + gained))).toBeLessThan(1e-3);
        expect(Math.abs(cell(10, 10) - (30 - 4 * gained))).toBeLessThan(1e-3);
        expect(cell(9, 9)).toBe(AMBIENT); // diagonal untouched by a 4-neighbour kernel
    });

    it("clamps diffusion*dt at 0.25, so a dt spike relaxes instead of exploding", () => {
        setCell(10, 10, 30);
        diffuseField(10); // 0.18 * 10 = 1.8 -> clamped 0.25
        // At rate 0.25 with 4 ambient neighbours the hot cell lands exactly on ambient.
        expect(Math.abs(cell(10, 10) - AMBIENT)).toBeLessThan(1e-3);
        expect(Math.abs(cell(11, 10) - (AMBIENT + 0.25 * 8))).toBeLessThan(1e-3);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT - 1e-6);
        expect(Number.isFinite(maxCell())).toBe(true);
    });

    it("boundary cells diffuse to in-grid neighbours only, still conserving", () => {
        setCell(0, 0, 30);
        const before = totalHeat();
        diffuseField(0.1);
        const gained = CONFIG.heat.diffusion * 0.1 * (30 - AMBIENT);
        expect(Math.abs(cell(0, 0) - (30 - 2 * gained))).toBeLessThan(1e-3); // corner: 2 neighbours
        expect(Math.abs(cell(1, 0) - (AMBIENT + gained))).toBeLessThan(1e-3);
        expect(Math.abs(totalHeat() - before)).toBeLessThan(1e-3);
    });
});

describe("dissipation", () => {
    it("decays hot cells toward ambient and leaves ambient cells untouched", () => {
        setCell(10, 10, 30);
        dissipateField(0.5);
        const expected = 30 + (AMBIENT - 30) * CONFIG.heat.dissipation * 0.5;
        expect(Math.abs(cell(10, 10) - expected)).toBeLessThan(1e-3);
        expect(cell(0, 0)).toBe(AMBIENT);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT - 1e-6);
    });
});

describe("CRAC cooling", () => {
    it("an unpowered CRAC removes nothing but still posts its duty request", () => {
        setCell(10, 10, 40);
        const crac = addCrac(10, 10, false);
        const before = totalHeat();
        applyCracCooling(0.1);
        expect(totalHeat()).toBe(before);
        expect(crac.duty).toBeGreaterThan(0); // request visible to power.js next tick
    });

    it("at full duty a powered CRAC removes coolPerSec * dt", () => {
        for (let z = 9; z <= 11; z++) for (let x = 9; x <= 11; x++) setCell(x, z, 60);
        const crac = addCrac(10, 10, true);
        const before = totalHeat();
        applyCracCooling(0.1);
        expect(crac.duty).toBe(1); // excess (9 * 38) far above coolPerSec
        expect(Math.abs(before - totalHeat() - crac.config.coolPerSec * 0.1)).toBeLessThan(1e-3);
    });

    it("duty = min(1, localExcess / coolPerSec) when excess is small", () => {
        setCell(10, 10, 26); // excess 4, coolPerSec 10 -> duty 0.4
        const crac = addCrac(10, 10, true);
        applyCracCooling(0.1);
        expect(Math.abs(crac.duty - 0.4)).toBeLessThan(1e-6);
        // removed = 10 * 0.4 * 0.1 = 0.4, all from the single hot cell
        expect(Math.abs(cell(10, 10) - 25.6)).toBeLessThan(1e-3);
    });

    it("never cools a cell below ambient, even when the removal budget overshoots", () => {
        setCell(10, 10, 22.001);
        addCrac(10, 10, true);
        applyCracCooling(5); // budget far exceeds the 0.001 excess
        expect(cell(10, 10)).toBeGreaterThanOrEqual(AMBIENT);
        expect(Math.abs(cell(10, 10) - AMBIENT)).toBeLessThan(1e-6);
    });

    it("radius is Chebyshev: distance == radius is cooled, radius + 1 is not", () => {
        const r = CONFIG.buildings.crac.radius;
        setCell(15 + r, 15 + r, 30); // Chebyshev distance r (diagonal corner)
        setCell(15 + r + 1, 15, 30); // Chebyshev distance r + 1
        addCrac(15, 15, true);
        applyCracCooling(0.1);
        expect(cell(15 + r, 15 + r)).toBeLessThan(30);
        expect(cell(15 + r + 1, 15)).toBe(30);
    });

    it("removal is distributed proportionally to each cell's excess", () => {
        setCell(9, 10, 30);  // excess 8
        setCell(11, 10, 26); // excess 4
        addCrac(10, 10, true);
        applyCracCooling(0.1); // duty 1 (excess 12 > 10), removes 1 total: 2/3 vs 1/3
        const removedHot = 30 - cell(9, 10);
        const removedWarm = 26 - cell(11, 10);
        expect(Math.abs(removedHot - 2 / 3)).toBeLessThan(1e-3);
        expect(Math.abs(removedHot / removedWarm - 2)).toBeLessThan(1e-2);
    });
});

describe("building thermals", () => {
    it("every building mirrors its cell into tempC", () => {
        const pdu = new Building("pdu", 3, 3);
        STATE.buildings.push(pdu);
        setCell(3, 3, 33.5);
        updateBuildingThermals(0.1);
        expect(Math.abs(pdu.tempC - 33.5)).toBeLessThan(1e-6);
    });

    it("rack throttleFactor: 1 at/below throttleStartC, ~0.5 halfway, 0 at/above shutdownC", () => {
        const { throttleStartC, shutdownC } = CONFIG.buildings.rack;
        const cool = addRack(1, 1, 0);
        const atStart = addRack(2, 1, 0);
        const halfway = addRack(3, 1, 0);
        const atShutdown = addRack(4, 1, 0);
        const beyond = addRack(5, 1, 0);
        setCell(1, 1, 30);
        setCell(2, 1, throttleStartC);
        setCell(3, 1, (throttleStartC + shutdownC) / 2); // 57.5, exact in float32
        setCell(4, 1, shutdownC);
        setCell(5, 1, shutdownC + 20);
        updateBuildingThermals(0.1);
        expect(cool.throttleFactor).toBe(1);
        expect(atStart.throttleFactor).toBe(1);
        expect(Math.abs(halfway.throttleFactor - 0.5)).toBeLessThan(1e-3);
        expect(atShutdown.throttleFactor).toBe(0);
        expect(beyond.throttleFactor).toBe(0);
    });

    it("a rack over shutdownC ends a full tickHeat with throttleFactor 0", () => {
        const rack = addRack(10, 10, 6);
        setCell(10, 10, 90);
        tickHeat(0.1);
        expect(rack.tempC).toBeGreaterThan(CONFIG.buildings.rack.shutdownC);
        expect(rack.throttleFactor).toBe(0);
    });
});

describe("heatwave", () => {
    it("dissipation pulls cells UP toward heatwaveAmbientC while active", () => {
        STATE.heatwave.active = true;
        dissipateField(1);
        const expected = AMBIENT
            + (CONFIG.heat.heatwaveAmbientC - AMBIENT) * CONFIG.heat.dissipation;
        expect(Math.abs(cell(10, 10) - expected)).toBeLessThan(1e-3);
    });

    it("diffusion uses heatwaveDiffusion while active", () => {
        STATE.heatwave.active = true;
        setCell(10, 10, 30);
        diffuseField(0.1);
        const gained = CONFIG.heat.heatwaveDiffusion * 0.1 * (30 - AMBIENT); // 0.08, not 0.144
        expect(Math.abs(cell(9, 10) - (AMBIENT + gained))).toBeLessThan(1e-3);
    });

    it("CRAC cooling floors at heatwaveAmbientC while active", () => {
        STATE.heatwave.active = true;
        setCell(10, 10, 40); // excess over heatwave ambient 34 is 6
        addCrac(10, 10, true);
        applyCracCooling(10); // overshooting budget -> clamps to the heatwave floor
        expect(Math.abs(cell(10, 10) - CONFIG.heat.heatwaveAmbientC)).toBeLessThan(1e-3);
        expect(cell(10, 10)).toBeGreaterThan(AMBIENT); // NOT cooled down to normal ambient
    });
});

describe("invariants", () => {
    it("tickHeat(0) is a full no-op: field, duty, tempC, throttleFactor all frozen", () => {
        const rack = addRack(8, 8, 6);
        const crac = addCrac(12, 8, true);
        setCell(8, 8, 55);
        rack.tempC = 51;
        rack.throttleFactor = 0.3;
        crac.duty = 0.77;
        const snapshot = Array.from(STATE.heatField);
        tickHeat(0);
        expect(Array.from(STATE.heatField)).toEqual(snapshot);
        expect(rack.tempC).toBe(51);
        expect(rack.throttleFactor).toBe(0.3);
        expect(crac.duty).toBe(0.77);
    });

    it("conservation: field delta per stage matches added - dissipated - removed", () => {
        const rack = addRack(8, 8, 6);
        const crac = addCrac(12, 8, true);
        for (let z = 7; z <= 9; z++) for (let x = 11; x <= 13; x++) setCell(x, z, 40);
        const dt = 0.25;

        const t0 = totalHeat();
        injectRackHeat(dt);
        const t1 = totalHeat();
        const added = rack.actualKw * rack.config.heatPerKw * dt; // 1.5
        expect(Math.abs(t1 - t0 - added)).toBeLessThan(1e-3);

        diffuseField(dt);
        const t2 = totalHeat();
        expect(Math.abs(t2 - t1)).toBeLessThan(1e-3); // diffusion is conservative

        // Expected dissipation computed independently from the field snapshot.
        let expectedDissipation = 0;
        for (let i = 0; i < STATE.heatField.length; i++) {
            expectedDissipation += (STATE.heatField[i] - AMBIENT) * CONFIG.heat.dissipation * dt;
        }
        dissipateField(dt);
        const t3 = totalHeat();
        expect(Math.abs(t2 - t3 - expectedDissipation)).toBeLessThan(1e-3);

        applyCracCooling(dt);
        const t4 = totalHeat();
        expect(crac.duty).toBe(1); // local excess (~9 * 18) far above coolPerSec
        const removed = crac.config.coolPerSec * crac.duty * dt; // 2.5
        expect(Math.abs(t3 - t4 - removed)).toBeLessThan(1e-3);

        // The full identity, all three terms measured in the test.
        expect(Math.abs(t4 - t0 - (added - expectedDissipation - removed))).toBeLessThan(5e-3);
    });

    it("no cell drops below ambient across sustained heating + cooling", () => {
        addRack(10, 10, 6);
        addCrac(11, 10, true);
        for (let i = 0; i < 100; i++) tickHeat(0.25);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT);
    });

    it("no NaN and no blow-up over 300 mixed ticks with dt spikes and heatwave toggling", () => {
        addRack(10, 10, 6);
        addRack(11, 10, 6);
        addRack(20, 20, 6);
        addCrac(12, 11, true);
        addCrac(0, 0, false);
        const dts = [0.016, 0.016, 0.5, 0.125];
        for (let i = 0; i < 300; i++) {
            STATE.heatwave.active = i % 50 >= 25;
            tickHeat(dts[i % dts.length]);
        }
        for (let i = 0; i < STATE.heatField.length; i++) {
            expect(Number.isFinite(STATE.heatField[i])).toBe(true);
        }
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT);
        expect(maxCell()).toBeLessThan(1000); // bounded, not exploding
        for (const b of STATE.buildings) {
            expect(Number.isFinite(b.tempC)).toBe(true);
            expect(Number.isFinite(b.duty)).toBe(true);
            expect(Number.isFinite(b.throttleFactor)).toBe(true);
        }
    });
});

describe("adversarial", () => {
    it("empty world: 50 full ticks leave the field bitwise at ambient", () => {
        for (let i = 0; i < 50; i++) tickHeat(0.5);
        for (let i = 0; i < STATE.heatField.length; i++) {
            expect(STATE.heatField[i]).toBe(AMBIENT); // exact, not approximate
        }
    });

    it("per-stage dt=0 guards hold on dirty state (tickHeat(0) never reaches them)", () => {
        const rack = addRack(8, 8, 6);
        const crac = addCrac(12, 8, true);
        setCell(8, 8, 55);
        setCell(12, 8, 60);
        rack.tempC = 51;
        rack.throttleFactor = 0.3;
        crac.duty = 0.77;
        const snapshot = Array.from(STATE.heatField);
        injectRackHeat(0);
        diffuseField(0);
        dissipateField(0);
        applyCracCooling(0); // must NOT rewrite duty either
        updateBuildingThermals(0); // must NOT rewrite tempC/throttleFactor
        expect(Array.from(STATE.heatField)).toEqual(snapshot);
        expect(crac.duty).toBe(0.77);
        expect(rack.tempC).toBe(51);
        expect(rack.throttleFactor).toBe(0.3);
    });

    it("CRAC at the grid corner: clipped box cools exactly, outside stays untouched", () => {
        const r = CONFIG.buildings.crac.radius;
        for (let z = 0; z <= r; z++) for (let x = 0; x <= r; x++) setCell(x, z, 40);
        setCell(r + 1, 0, 40); // just outside the clipped box
        setCell(0, r + 1, 40);
        const crac = addCrac(0, 0, true);
        const before = totalHeat();
        applyCracCooling(0.1);
        expect(crac.duty).toBe(1); // (r+1)^2 cells * 18 excess >> coolPerSec
        expect(Math.abs(before - totalHeat() - crac.config.coolPerSec * 0.1)).toBeLessThan(1e-3);
        expect(cell(r + 1, 0)).toBe(40);
        expect(cell(0, r + 1)).toBe(40);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT);
    });

    it("checkerboard worst case at the 0.25 clamp: bounded, conserving, finite", () => {
        for (let z = 0; z < N; z++) {
            for (let x = 0; x < N; x++) {
                setCell(x, z, (x + z) % 2 === 0 ? 60 : AMBIENT);
            }
        }
        const before = totalHeat();
        for (let i = 0; i < 50; i++) diffuseField(10); // rate clamps to 0.25 every step
        for (let i = 0; i < STATE.heatField.length; i++) {
            expect(Number.isFinite(STATE.heatField[i])).toBe(true);
        }
        // Each stencil update is a convex combination, so the field can never
        // leave the [min, max] envelope of its initial values.
        expect(maxCell()).toBeLessThanOrEqual(60);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT);
        // 900 float32 cells rewritten 50 times: allow quantization drift only.
        expect(Math.abs(totalHeat() - before)).toBeLessThan(0.5);
    });

    it("50 racks stacked on one cell survive 200 mixed ticks with spikes + heatwave", () => {
        for (let i = 0; i < 50; i++) addRack(15, 15, 6); // 300 heat units/sec into ONE cell
        addCrac(15, 15, true);
        addCrac(16, 16, false);
        const dts = [0.016, 0.25, 0.5, 10]; // includes a dissipation-saturating spike
        for (let i = 0; i < 200; i++) {
            STATE.heatwave.active = i % 40 >= 20;
            tickHeat(dts[i % dts.length]);
            expect(minCell()).toBeGreaterThanOrEqual(AMBIENT);
        }
        for (let i = 0; i < STATE.heatField.length; i++) {
            expect(Number.isFinite(STATE.heatField[i])).toBe(true);
        }
        for (const b of STATE.buildings) {
            expect(b.duty).toBeGreaterThanOrEqual(0);
            expect(b.duty).toBeLessThanOrEqual(1);
            expect(b.throttleFactor).toBeGreaterThanOrEqual(0);
            expect(b.throttleFactor).toBeLessThanOrEqual(1);
            expect(Number.isFinite(b.tempC)).toBe(true);
        }
    });

    it("full heatwave cycle with two overlapping CRACs: bounded up, recovers down, never below ambient", () => {
        const cracA = addCrac(10, 10, true);
        const cracB = addCrac(11, 10, true); // boxes overlap almost entirely
        // Phase 1 — heatwave, no racks: dissipation pulls the whole field UP
        // toward heatwaveAmbientC; nothing is above it, so CRACs must idle.
        STATE.heatwave.active = true;
        for (let i = 0; i < 100; i++) {
            tickHeat(0.25);
            expect(maxCell()).toBeLessThanOrEqual(CONFIG.heat.heatwaveAmbientC + 1e-3);
            expect(minCell()).toBeGreaterThanOrEqual(AMBIENT - 1e-6);
        }
        expect(cracA.duty).toBe(0);
        expect(cracB.duty).toBe(0);
        expect(cell(10, 10)).toBeGreaterThan(AMBIENT + 1); // it actually warmed up
        // Phase 2 — heatwave ends: the leftover warmth is now excess. Both
        // CRACs spin up and drag their boxes back to ambient, never past it.
        STATE.heatwave.active = false;
        tickHeat(0.25);
        expect(cracA.duty).toBeGreaterThan(0);
        expect(cracB.duty).toBeGreaterThan(0);
        for (let i = 0; i < 400; i++) {
            tickHeat(0.25);
            expect(minCell()).toBeGreaterThanOrEqual(AMBIENT - 1e-6);
        }
        expect(Math.abs(cell(10, 10) - AMBIENT)).toBeLessThan(0.5);
        expect(Math.abs(cell(11, 10) - AMBIENT)).toBeLessThan(0.5);
        expect(minCell()).toBeGreaterThanOrEqual(AMBIENT);
    });
});
