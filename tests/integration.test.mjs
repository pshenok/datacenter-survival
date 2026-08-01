// Cross-module integration — the seams the per-module suites cannot see.
// Both bugs below shipped past three green module suites and were caught only
// by running demand + power + heat together in the browser:
//   1. chainAlive treated a null-parent grid_feed as dead (constructor now
//      births sources with parentId "grid").
//   2. chainAlive declared a cut chain dead at the break, so assignment
//      starved the UPS and the buffer never carried anything.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, unwire, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";

const DT = 0.05;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

function fullChain() {
    const feed = place("grid_feed", 3, 5);
    const xf = place("transformer", 6, 5);
    const ups = place("ups", 9, 5);
    const pdu = place("pdu", 12, 5);
    const racks = [place("rack", 15, 3), place("rack", 15, 5)];
    wireBuildings(feed, xf);
    wireBuildings(xf, ups);
    wireBuildings(ups, pdu);
    racks.forEach((r) => wireBuildings(pdu, r));
    return { feed, xf, ups, pdu, racks };
}

function run(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        tickEvents(DT, STATE.elapsedGameTime);
        tickDemand(DT, STATE.elapsedGameTime);
        resolvePower(DT);
        tickHeat(DT);
    }
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("full-loop integration", () => {
    it("a freshly built chain serves demand without any manual parent bootstrapping", () => {
        fullChain();
        run(20);
        expect(STATE.servedKw).toBeGreaterThan(0);
        expect(STATE.servedKw).toBeCloseTo(Math.min(STATE.demandKw, 12), 0);
    });

    it("PUE is finite and > 1 once CRACs cool a working room", () => {
        const { pdu } = fullChain();
        const crac = place("crac", 14, 4);
        wireBuildings(pdu, crac);
        run(60);
        const pue = STATE.totalDrawKw / STATE.itDrawKw;
        expect(Number.isFinite(pue)).toBe(true);
        expect(pue).toBeGreaterThan(1);
        expect(pue).toBeLessThan(3);
    });

    it("UPS carries its subtree through an upstream cut for ~bufferSec, then dark", () => {
        const { xf, ups, racks } = fullChain();
        run(20); // steady state, buffer full
        expect(racks.some((r) => r.actualKw > 0)).toBe(true);

        unwire(xf); // cut ABOVE the UPS

        run(CONFIG.buildings.ups.bufferSec / 2);
        expect(racks.some((r) => r.actualKw > 0)).toBe(true); // still carried
        expect(ups.bufferLeft).toBeLessThan(CONFIG.buildings.ups.bufferSec);

        run(CONFIG.buildings.ups.bufferSec); // well past the buffer
        expect(ups.bufferLeft).toBe(0);
        expect(racks.every((r) => r.actualKw === 0)).toBe(true); // now dark
    });

    it("UPS recharges after the feed is rewired and can carry again", () => {
        const { feed, xf, ups, racks } = fullChain();
        run(20);
        unwire(xf);
        run(CONFIG.buildings.ups.bufferSec + 4); // drain fully
        expect(ups.bufferLeft).toBe(0);

        wireBuildings(feed, xf); // restore power
        run(CONFIG.buildings.ups.bufferSec * 8); // recharge at 1/4 rate
        expect(ups.bufferLeft).toBeGreaterThan(CONFIG.buildings.ups.bufferSec * 0.9);
        expect(racks.some((r) => r.actualKw > 0)).toBe(true);
    });

    it("uncooled racks heat their cells above cooled ones", () => {
        const { pdu, racks } = fullChain();
        run(90);
        const hot = racks[0].tempC;
        const crac = place("crac", 16, 4);
        wireBuildings(pdu, crac);
        run(60);
        expect(racks[0].tempC).toBeLessThan(hot + 5); // cooling bends the curve
    });
});
