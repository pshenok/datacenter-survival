// The chilled-water loop — two-stage cooling.
//
// The feature exists to make ONE trade-off felt, so that is what the tests
// pin: making cold once and distributing it beats making it everywhere —
// but only above a certain size, and only until the day the plant stops.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";

const DT = 0.05;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// IT on one chain, cooling on another, so a comparison of cooling costs is
// never confounded by a shared link clipping or tripping.
function hall(demandKw, rackSpots) {
    STATE.demandFixedKw = demandKw;
    STATE.heatwave.active = true;
    STATE.heatwave.endsAt = Infinity;
    const f1 = place("grid_feed", 2, 5);
    const x1 = place("transformer", 5, 5);
    wireBuildings(f1, x1);
    const pA = place("pdu", 8, 4);
    const pB = place("pdu", 8, 8);
    wireBuildings(x1, pA);
    wireBuildings(x1, pB);
    const racks = rackSpots.map(([gx, gz], i) => {
        const r = place("rack", gx, gz);
        wireBuildings(i % 2 ? pA : pB, r);
        return r;
    });
    const f2 = place("grid_feed", 2, 16);
    const x2 = place("transformer", 5, 16);
    const pC = place("pdu", 8, 16);
    wireBuildings(f2, x2);
    wireBuildings(x2, pC);
    return { racks, coolBus: pC };
}

function run(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
    }
}

const pue = () => STATE.totalDrawKw / Math.max(STATE.itDrawKw, 0.01);
const coolingKw = () => STATE.totalDrawKw - STATE.itDrawKw;

const BIG = [[13, 5], [15, 5], [13, 8], [15, 8]];
const HEADS = [[12, 6], [16, 6], [14, 4], [14, 9]];

beforeEach(() => {
    resetState();
    resetBuildingIds();
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
});

describe("the efficiency argument — and its limit", () => {
    it("AT SCALE the loop moves the same heat for materially less power", () => {
        const { coolBus } = hall(24, BIG);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crac", gx, gz));
        run(200);
        const cracPue = pue();
        const cracKw = coolingKw();

        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        const second = hall(24, BIG);
        wireBuildings(second.coolBus, place("chiller", 20, 16));
        for (const [gx, gz] of HEADS) wireBuildings(second.coolBus, place("crah", gx, gz));
        run(200);

        expect(STATE.itDrawKw).toBeCloseTo(24, 0);          // same IT load
        expect(second.racks.every((r) => r.throttleFactor === 1)).toBe(true);
        expect(coolingKw()).toBeLessThan(cracKw * 0.8);     // >20% less cooling power
        expect(pue()).toBeLessThan(cracPue - 0.05);
    });

    it("AT ONE RACK the plant's idle draw makes the loop the WORSE deal", () => {
        const small = hall(6, [[14, 7]]);
        wireBuildings(small.coolBus, place("crac", 15, 7));
        run(200);
        const cracPue = pue();

        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        const tiny = hall(6, [[14, 7]]);
        wireBuildings(tiny.coolBus, place("chiller", 20, 16));
        wireBuildings(tiny.coolBus, place("crah", 15, 7));
        run(200);

        // Scale is the whole argument: below it, the loop loses.
        expect(pue()).toBeGreaterThan(cracPue);
    });
});

describe("one pool, shared by everyone", () => {
    it("rations every CRAH proportionally when the plant is over-committed", () => {
        const { coolBus } = hall(24, BIG);
        const chiller = place("chiller", 20, 16);
        wireBuildings(coolBus, chiller);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(60);
        // Force the plant far below what the heads want.
        chiller.config.coolUnits = 8;
        run(20);
        expect(STATE.coolingLoop.ratio).toBeLessThan(1);
        expect(STATE.coolingLoop.demandUnits).toBeGreaterThan(STATE.coolingLoop.capacityUnits);
        chiller.config.coolUnits = 45;   // restore the shared config object
    });

    it("a CRAH without a plant cools nothing, however hard it wants to", () => {
        const { racks, coolBus } = hall(24, BIG);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(120);
        expect(STATE.coolingLoop.capacityUnits).toBe(0);
        // Heads asking a plant that does not exist get nothing — ratio 0,
        // not the "nobody is asking" identity of 1.
        expect(STATE.coolingLoop.demandUnits).toBeGreaterThan(0);
        expect(STATE.coolingLoop.ratio).toBe(0);
        expect(racks.some((r) => r.throttleFactor < 1)).toBe(true);
        expect(Math.max(...STATE.heatField)).toBeGreaterThan(CONFIG.buildings.rack.throttleStartC);
    });

    it("still bills the plant its idle draw when nobody is drinking", () => {
        const { coolBus } = hall(6, [[14, 7]]);
        wireBuildings(coolBus, place("chiller", 20, 16));   // no CRAHs at all
        run(30);
        expect(coolingKw()).toBeGreaterThanOrEqual(CONFIG.buildings.chiller.idleDrawKw * 0.95);
    });
});

describe("shared efficiency IS shared blast radius", () => {
    function failurePair(headSpots, cracSpots) {
        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        const { racks, coolBus } = hall(24, BIG);
        const chiller = place("chiller", 20, 16);
        wireBuildings(coolBus, chiller);
        for (const [gx, gz] of headSpots) wireBuildings(coolBus, place("crah", gx, gz));
        for (const [gx, gz] of cracSpots) wireBuildings(coolBus, place("crac", gx, gz));
        run(120);
        const before = Math.max(...STATE.heatField);
        chiller.broken = true;
        run(60);
        return { racks, before, after: Math.max(...STATE.heatField) };
    }

    it("an all-loop room cooks when the single plant fails", () => {
        const r = failurePair(HEADS, []);
        expect(r.after).toBeGreaterThan(r.before + 10);
        expect(r.racks[0].throttleFactor).toBeLessThan(0.8);
    });

    it("a mixed room barely notices the same failure", () => {
        const r = failurePair([[12, 6], [16, 6]], [[14, 4], [14, 9]]);
        expect(r.racks[0].throttleFactor).toBeGreaterThan(0.9);
    });

    it("adding ANOTHER CRAH does not help — it drinks from the same dead plant", () => {
        const allLoop = failurePair(HEADS, []);
        const moreHeads = failurePair([...HEADS, [12, 9], [16, 9]], []);
        expect(moreHeads.racks[0].throttleFactor).toBeLessThan(0.8);
        expect(moreHeads.after).toBeGreaterThan(allLoop.before + 10);
    });
});

describe("only machines that are actually running touch the loop", () => {
    it("an UNWIRED CRAH does not drink — dropping one on the floor must not starve the room", () => {
        const { racks, coolBus } = hall(24, BIG);
        wireBuildings(coolBus, place("chiller", 20, 16));
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(150);
        expect(STATE.coolingLoop.ratio).toBe(1);
        const before = STATE.coolingLoop.demandUnits;

        // Four more heads, connected to NOTHING. They are inert furniture.
        for (const [gx, gz] of [[11, 4], [17, 4], [11, 9], [17, 9]]) place("crah", gx, gz);
        run(40);
        expect(STATE.coolingLoop.demandUnits).toBeLessThan(before * 1.1);   // four heads, not eight
        expect(STATE.coolingLoop.ratio).toBe(1);
        expect(racks.every((r) => r.throttleFactor === 1)).toBe(true);
    });

    it("a head on a DEAD chain does not drink either", () => {
        const { coolBus } = hall(24, BIG);
        wireBuildings(coolBus, place("chiller", 20, 16));
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(150);
        const before = STATE.coolingLoop.demandUnits;
        expect(before).toBeGreaterThan(0);

        // A second bus with no feed behind it, carrying four more heads.
        const dead = place("pdu", 8, 20);
        for (const [gx, gz] of [[11, 4], [17, 4], [11, 9], [17, 9]]) {
            wireBuildings(dead, place("crah", gx, gz));
        }
        run(40);
        expect(STATE.buildings.filter((b) => b.type === "crah").length).toBe(8);
        expect(STATE.coolingLoop.demandUnits).toBeLessThan(before * 1.1);   // four heads, not eight
        expect(STATE.coolingLoop.ratio).toBe(1);
    });

    it("a dead plant's tower stops even when another plant is still running", () => {
        const { coolBus } = hall(24, BIG);
        const a = place("chiller", 20, 16);
        const b = place("chiller", 22, 16);
        wireBuildings(coolBus, a);
        wireBuildings(coolBus, b);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(120);
        b.broken = true;
        run(20);
        // duty drives both the power bill and the spinning tower: a broken
        // plant must read as stopped, not as busy as its healthy twin.
        expect(b.duty).toBe(0);
        expect(b.actualKw).toBe(0);
        expect(a.duty).toBeGreaterThan(0);
    });

    it("a starved head keeps its fans running — and keeps costing money", () => {
        const { coolBus } = hall(24, BIG);
        const head = place("crah", 14, 7);
        wireBuildings(coolBus, head);   // powered, but no plant anywhere
        run(120);
        expect(STATE.coolingLoop.ratio).toBe(0);
        expect(head.duty).toBeGreaterThan(0);                      // still commanded
        expect(head.actualKw).toBeGreaterThan(0.3);                // still billed
        expect(Math.max(...STATE.heatField)).toBeGreaterThan(40);  // still useless
    });
});
