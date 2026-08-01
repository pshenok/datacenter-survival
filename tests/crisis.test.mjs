// Unit tests for src/sim/crisis.js (grid brownout + CRAC breakdown) and the
// minimal hooks it earns in sim/power.js (effective source capacity) and
// sim/heat.js (broken CRAC duty). Node env, real modules, no stubs — the
// demand.test.mjs discipline. Randomness goes through the rng parameter:
// a constant stub where a single deterministic value is wanted, a seeded
// LCG where the schedule bounds themselves are under test.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState, heatIndex } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { applyCracCooling } from "../src/sim/heat.js";
import { tickCrisis, repairCrac } from "../src/sim/crisis.js";

const rngZero = () => 0;    // every span lands on its minimum; pick index 0

function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// feed -> xf -> ups -> pdu -> 2 racks assigned 6 kW each (12 kW pull).
function upsChain() {
    const feed = place("grid_feed", 0, 0);
    const xf = place("transformer", 1, 0);
    const ups = place("ups", 2, 0);
    const pdu = place("pdu", 3, 0);
    const racks = [place("rack", 4, 0), place("rack", 5, 0)];
    wireBuildings(feed, xf);
    wireBuildings(xf, ups);
    wireBuildings(ups, pdu);
    for (const r of racks) {
        wireBuildings(pdu, r);
        r.assignedKw = 6;
    }
    return { feed, xf, ups, pdu, racks };
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("brownout scheduling", () => {
    it("first valid tick schedules nextAt within interval bounds; nothing fires before it", () => {
        const cfg = CONFIG.events.brownout;
        tickCrisis(1, 10, lcg(7));
        const at = STATE.brownout.nextAt;
        expect(at).toBeGreaterThanOrEqual(10 + cfg.minIntervalSec);
        expect(at).toBeLessThanOrEqual(10 + cfg.maxIntervalSec);
        tickCrisis(1, at - 0.01, lcg(7));
        expect(STATE.brownout.active).toBe(false);
    });

    it("fires at nextAt with duration and reschedule inside their configured ranges (seeded rng)", () => {
        const cfg = CONFIG.events.brownout;
        const rng = lcg(42);
        const dt = 0.5;
        let firedAt = null;
        for (let t = dt; t <= 400 && firedAt === null; t += dt) {
            const scheduled = STATE.brownout.nextAt;
            tickCrisis(dt, t, rng);
            if (STATE.brownout.active) firedAt = scheduled;
        }
        expect(firedAt).not.toBeNull();
        expect(STATE.brownout.factor).toBe(cfg.capacityFactor);
        expect(STATE.brownout.endsAt - firedAt).toBeGreaterThanOrEqual(cfg.minDurationSec);
        expect(STATE.brownout.endsAt - firedAt).toBeLessThanOrEqual(cfg.maxDurationSec);
        expect(STATE.brownout.nextAt - firedAt).toBeGreaterThanOrEqual(cfg.minIntervalSec);
        expect(STATE.brownout.nextAt - firedAt).toBeLessThanOrEqual(cfg.maxIntervalSec);
    });

    it("ends at endsAt and can fire again at the rescheduled nextAt", () => {
        const cfg = CONFIG.events.brownout;
        tickCrisis(1, 0, rngZero);                        // nextAt = min interval
        tickCrisis(1, cfg.minIntervalSec, rngZero);       // fire
        expect(STATE.brownout.active).toBe(true);
        const { endsAt, nextAt } = STATE.brownout;
        expect(endsAt).toBe(cfg.minIntervalSec + cfg.minDurationSec);
        tickCrisis(1, endsAt - 0.01, rngZero);
        expect(STATE.brownout.active).toBe(true);
        tickCrisis(1, endsAt, rngZero);
        expect(STATE.brownout.active).toBe(false);
        tickCrisis(1, nextAt, rngZero);                   // second fire
        expect(STATE.brownout.active).toBe(true);
    });
});

describe("brownout power effects", () => {
    it("halves the feed's EFFECTIVE capacity and clips its subtree proportionally", () => {
        // feed(40) -> 2 PDUs -> 2 racks each, 24 kW total pull.
        const feed = place("grid_feed", 0, 0);
        const racks = [];
        for (let p = 0; p < 2; p++) {
            const pdu = place("pdu", 1 + p, 0);
            wireBuildings(feed, pdu);
            for (let r = 0; r < 2; r++) {
                const rack = place("rack", 3 + p * 2 + r, 0);
                wireBuildings(pdu, rack);
                rack.assignedKw = 6;
                racks.push(rack);
            }
        }
        resolvePower(1);
        for (const r of racks) expect(r.actualKw).toBeCloseTo(6, 10);

        STATE.brownout.active = true;
        STATE.brownout.factor = 0.5;
        resolvePower(1);
        expect(feed.actualKw).toBeCloseTo(20, 10);        // 40 * 0.5
        for (const r of racks) {
            expect(r.actualKw).toBeCloseTo(6 * 20 / 24, 10);
            expect(r.powered).toBe(true);                 // browned out, not dark
        }
        expect(STATE.itDrawKw).toBeCloseTo(20, 10);
    });

    it("never mutates CONFIG and restores full capacity when the brownout ends", () => {
        const { racks } = upsChain();
        STATE.brownout.active = true;
        STATE.brownout.factor = 0.5;
        resolvePower(1);
        expect(CONFIG.buildings.grid_feed.capacityKw).toBe(40);
        STATE.brownout.active = false;
        resolvePower(1);
        for (const r of racks) expect(r.actualKw).toBeCloseTo(6, 10);
    });

    it("DOCUMENTED DECISION: the UPS does NOT engage under a brownout — degraded is not dead", () => {
        const { ups, racks } = upsChain();
        const max = CONFIG.buildings.ups.bufferSec;
        expect(ups.bufferLeft).toBe(max);                 // born charged
        STATE.brownout.active = true;
        STATE.brownout.factor = 0.25;                     // feed 10 < pull 12: clips
        resolvePower(1);
        expect(ups.powered).toBe(true);                   // chain alive
        expect(ups.bufferLeft).toBe(max);                 // buffer untouched
        for (const r of racks) expect(r.actualKw).toBeCloseTo(6 * 10 / 12, 10);
    });

    it("a facility inside the sagged capacity rides through at FULL service (the headroom lesson)", () => {
        const { ups, racks } = upsChain();                // 12 kW pull
        STATE.brownout.active = true;
        STATE.brownout.factor = CONFIG.events.brownout.capacityFactor; // feed 20 > 12
        resolvePower(1);
        for (const r of racks) expect(r.actualKw).toBeCloseTo(6, 10);
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec);
    });

    it("a sag to ZERO is an outage, and there the UPS does engage", () => {
        const { ups, racks } = upsChain();
        STATE.brownout.active = true;
        STATE.brownout.factor = 0;                        // feed carries nothing
        resolvePower(1);
        expect(ups.bufferLeft).toBeLessThan(CONFIG.buildings.ups.bufferSec);
        for (const r of racks) expect(r.actualKw).toBeCloseTo(6, 10);
    });
});

describe("CRAC breakdown", () => {
    it("breaks one powered CRAC within interval bounds and anchors its self-repair (seeded rng)", () => {
        const cfg = CONFIG.events.cracBreakdown;
        const crac = place("crac", 0, 0);
        crac.powered = true;
        const rng = lcg(99);
        const dt = 0.5;
        let firedAt = null;
        for (let t = dt; t <= 300 && firedAt === null; t += dt) {
            const scheduled = STATE.breakdown.nextAt;
            tickCrisis(dt, t, rng);
            if (crac.broken) firedAt = scheduled;
        }
        expect(firedAt).not.toBeNull();
        expect(firedAt).toBeGreaterThanOrEqual(dt + cfg.minIntervalSec);
        expect(firedAt).toBeLessThanOrEqual(dt + cfg.maxIntervalSec);
        expect(crac.repairAt).toBe(firedAt + cfg.selfRepairSec);
    });

    it("only powered, unbroken CRACs are candidates; with none, the schedule just advances", () => {
        const cfg = CONFIG.events.cracBreakdown;
        const dark = place("crac", 0, 0);                 // powered stays false
        const live = place("crac", 1, 0);
        live.powered = true;
        tickCrisis(1, 0, rngZero);                        // nextAt = min interval
        tickCrisis(1, cfg.minIntervalSec, rngZero);       // fire
        expect(dark.broken).toBe(false);
        expect(live.broken).toBe(true);

        resetState();
        resetBuildingIds();
        tickCrisis(1, 0, rngZero);
        const before = STATE.breakdown.nextAt;
        tickCrisis(1, before, rngZero);                   // no candidates at all
        expect(STATE.breakdown.nextAt).toBe(before + cfg.minIntervalSec);
    });

    it("a broken CRAC gets duty 0 and removes no heat until repaired", () => {
        const crac = place("crac", 5, 5);
        crac.actualKw = 3;                                // powered last tick
        STATE.heatField[heatIndex(5, 5)] = 60;            // plenty of local excess
        crac.broken = true;
        applyCracCooling(1);
        expect(crac.duty).toBe(0);
        expect(STATE.heatField[heatIndex(5, 5)]).toBe(60);

        crac.broken = false;
        applyCracCooling(1);
        expect(crac.duty).toBeGreaterThan(0);
        expect(STATE.heatField[heatIndex(5, 5)]).toBeLessThan(60);
    });

    it("paid repair charges the fee and clears the breakdown", () => {
        const cost = CONFIG.events.cracBreakdown.repairCost;
        const crac = place("crac", 0, 0);
        crac.broken = true;
        crac.repairAt = 500;
        expect(repairCrac(crac)).toBe(true);
        expect(crac.broken).toBe(false);
        expect(crac.repairAt).toBe(0);
        expect(STATE.money).toBe(CONFIG.economy.startMoney - cost);
    });

    it("repair refuses when the player cannot afford the fee", () => {
        const crac = place("crac", 0, 0);
        crac.broken = true;
        STATE.money = CONFIG.events.cracBreakdown.repairCost - 1;
        expect(repairCrac(crac)).toBe(false);
        expect(crac.broken).toBe(true);
        expect(STATE.money).toBe(CONFIG.events.cracBreakdown.repairCost - 1);
    });

    it("repair refuses non-broken CRACs and non-CRACs without charging", () => {
        const crac = place("crac", 0, 0);
        const rack = place("rack", 1, 0);
        rack.broken = true;                               // hostile flag on a rack
        expect(repairCrac(crac)).toBe(false);
        expect(repairCrac(rack)).toBe(false);
        expect(repairCrac(null)).toBe(false);
        expect(STATE.money).toBe(CONFIG.economy.startMoney);
    });

    it("self-repairs for free once elapsed reaches repairAt", () => {
        const crac = place("crac", 0, 0);
        crac.broken = true;
        crac.repairAt = 100;
        tickCrisis(1, 99.9, rngZero);
        expect(crac.broken).toBe(true);
        tickCrisis(1, 100, rngZero);
        expect(crac.broken).toBe(false);
        expect(crac.repairAt).toBe(0);
        expect(STATE.money).toBe(CONFIG.economy.startMoney);
    });
});

describe("freeze semantics", () => {
    it("frozen elapsed (the tutorial) schedules once and never fires", () => {
        place("crac", 0, 0).powered = true;
        for (let i = 0; i < 50; i++) tickCrisis(1, 5, rngZero);
        expect(STATE.brownout.nextAt).toBe(5 + CONFIG.events.brownout.minIntervalSec);
        expect(STATE.breakdown.nextAt).toBe(5 + CONFIG.events.cracBreakdown.minIntervalSec);
        expect(STATE.brownout.active).toBe(false);
        expect(STATE.buildings[0].broken).toBe(false);
    });

    it("dt = 0 is a strict no-op even with everything due", () => {
        const crac = place("crac", 0, 0);
        crac.powered = true;
        crac.broken = true;
        crac.repairAt = 10;                               // self-repair long overdue
        tickCrisis(0, 500, rngZero);
        expect(STATE.brownout.nextAt).toBeNull();
        expect(STATE.breakdown.nextAt).toBeNull();
        expect(STATE.brownout.active).toBe(false);
        expect(crac.broken).toBe(true);
    });

    it("NaN, negative, Infinity dt and gameOver are all strict no-ops", () => {
        place("crac", 0, 0).powered = true;
        for (const dt of [NaN, -1, Infinity]) tickCrisis(dt, 500, rngZero);
        expect(STATE.brownout.nextAt).toBeNull();
        STATE.gameOver = "bankrupt";
        tickCrisis(1, 500, rngZero);
        expect(STATE.brownout.nextAt).toBeNull();
        expect(STATE.breakdown.nextAt).toBeNull();
    });

    it("resetState clears every crisis and contract field back to virgin", () => {
        tickCrisis(1, 200, rngZero);                      // schedule things
        STATE.brownout.active = true;
        STATE.contract.key = "serve_kwh";
        STATE.contract.id = 3;
        resetState();
        expect(STATE.brownout).toEqual({ active: false, endsAt: 0, nextAt: null, factor: 1 });
        expect(STATE.breakdown).toEqual({ nextAt: null });
        expect(STATE.contract).toEqual({
            id: 0, key: null, progress: 0, target: 0, reward: 0, endsAt: 0, done: null, nextAt: null,
        });
    });
});
