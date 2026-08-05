// The time-of-use meter — day/night pricing.
//
// The claim this mechanic makes is narrow and testable: it changes WHEN you
// pay, not HOW MUCH, and it is knowable in advance. So that is what the tests
// pin — the bands average to exactly 1.0, the schedule is a pure function of
// the clock, and a room that shifts nothing pays what it always paid.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents, tariffBandAt, upcomingBand } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";

const DT = 0.05;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// A room that serves a pinned load and never changes what it does — the
// control group for every "does shifting pay?" question.
function steadyRoom(demandKw) {
    STATE.demandFixedKw = demandKw;
    const f = place("grid_feed", 2, 5);
    const x = place("transformer", 5, 5);
    const p = place("pdu", 8, 5);
    wireBuildings(f, x);
    wireBuildings(x, p);
    wireBuildings(p, place("rack", 12, 5));
    wireBuildings(p, place("crac", 13, 5));
    return p;
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

describe("the schedule is a promise, not a surprise", () => {
    it("THE INVARIANT: the bands average to exactly 1.0 over a period", () => {
        // This is the whole honesty claim. If it drifts, the mechanic stops
        // being about timing and silently becomes a difficulty knob.
        const cfg = CONFIG.tariff;
        let sum = 0;
        for (const [i, b] of cfg.bands.entries()) {
            const next = cfg.bands[i + 1];
            const span = (next ? next.fromSec : cfg.periodSec) - b.fromSec;
            sum += b.mult * span;
        }
        expect(sum / cfg.periodSec).toBeCloseTo(1, 10);
    });

    it("is a pure function of the clock — same second, same price, forever", () => {
        for (const t of [0, 17, 59.9, 60, 119.9]) {
            const a = tariffBandAt(t);
            const b = tariffBandAt(t + CONFIG.tariff.periodSec * 5);
            expect(b.key).toBe(a.key);
            expect(b.mult).toBe(a.mult);
        }
    });

    it("puts the boundary exactly where CONFIG says, not one tick either side", () => {
        const [night, day] = CONFIG.tariff.bands;
        expect(tariffBandAt(day.fromSec - 0.001).key).toBe(night.key);
        expect(tariffBandAt(day.fromSec).key).toBe(day.key);        // inclusive
        expect(tariffBandAt(CONFIG.tariff.periodSec).key).toBe(night.key);  // wraps
    });

    it("folds a negative clock forward instead of indexing off the front", () => {
        expect(tariffBandAt(-1).key).toBe(tariffBandAt(CONFIG.tariff.periodSec - 1).key);
        expect(Number.isFinite(tariffBandAt(-1).mult)).toBe(true);
    });

    it("survives a non-finite clock with a real band rather than undefined", () => {
        for (const bad of [NaN, Infinity, -Infinity]) {
            const b = tariffBandAt(bad);
            expect(Number.isFinite(b.mult)).toBe(true);
        }
    });

    it("announces the next band inside the warning window and not before", () => {
        STATE.tariff.cycleOn = true;
        const day = CONFIG.tariff.bands[1];
        const w = CONFIG.tariff.warningSec;
        expect(upcomingBand(day.fromSec - w - 1)).toBeNull();
        const soon = upcomingBand(day.fromSec - 1);
        expect(soon.band.key).toBe(day.key);
        expect(soon.inSec).toBeCloseTo(1, 9);
        // Landed is not upcoming — the same rule the demand waves follow.
        expect(upcomingBand(day.fromSec)?.band.key).not.toBe(day.key);
    });

    it("announces nothing while the cycle is off", () => {
        STATE.tariff.cycleOn = false;
        expect(upcomingBand(CONFIG.tariff.bands[1].fromSec - 1)).toBeNull();
    });
});

describe("what it costs a room that does not shift", () => {
    it("bills the SAME over a whole period as a flat meter — timing, not price", () => {
        const P = CONFIG.tariff.periodSec;
        steadyRoom(6);
        run(P);
        const withoutCycle = STATE.money;

        resetState();
        resetBuildingIds();
        STATE.tariff.nextAt = Infinity;
        STATE.heatwave.nextAt = Infinity;
        STATE.brownout.nextAt = Infinity;
        STATE.breakdown.nextAt = Infinity;
        STATE.gridOutage.nextAt = Infinity;
        STATE.contract.nextAt = Infinity;
        steadyRoom(6);
        STATE.tariff.cycleOn = true;
        run(P);

        // Not identical — the room's own draw ramps as it warms, so the
        // cheap half and the dear half do not carry equal kWh. Close, and
        // provably not a surcharge: a player who ignores the clock is not
        // being taxed for it.
        expect(Math.abs(STATE.money - withoutCycle)).toBeLessThan(Math.abs(withoutCycle) * 0.05);
    });

    // The room is profitable, so STATE.money climbs either way — what the
    // band changes is HOW FAST. Profit-per-second is the honest probe, and
    // the gap between two bands is exactly the energy bill times the gap in
    // their multipliers. Asserting that equality pins the meter to CONFIG
    // rather than merely to "day costs more".
    function profitPerSec(seconds) {
        const before = STATE.money;
        run(seconds);
        return (STATE.money - before) / seconds;
    }

    it("charges exactly the band multiplier — not merely more by day", () => {
        steadyRoom(6);
        STATE.tariff.cycleOn = true;
        const [night, day] = CONFIG.tariff.bands;

        run(30);                                        // settle, still night
        expect(STATE.tariff.band).toBe(night.key);
        const nightRate = profitPerSec(20);
        const drawKw = STATE.totalDrawKw;

        STATE.elapsedGameTime = day.fromSec;            // step into the day band
        run(1);
        expect(STATE.tariff.band).toBe(day.key);
        const dayRate = profitPerSec(20);

        expect(nightRate).toBeGreaterThan(dayRate);     // night is the cheap half
        // The whole gap is energy priced at the difference of the two bands.
        const expected = drawKw * CONFIG.economy.powerCostPerKwh * (day.mult - night.mult) / 60;
        expect(nightRate - dayRate).toBeCloseTo(expected, 2);
    });

    it("stacks with the peak window — they multiply, they do not replace", () => {
        steadyRoom(6);
        STATE.tariff.cycleOn = true;
        STATE.elapsedGameTime = CONFIG.tariff.bands[1].fromSec;   // day band
        run(31);
        const dayRate = profitPerSec(10);
        const drawKw = STATE.totalDrawKw;

        STATE.tariff.active = true;
        STATE.tariff.multiplier = CONFIG.events.tariff.multiplier;
        STATE.tariff.endsAt = Infinity;
        const peakRate = profitPerSec(10);

        // A peak inside the day band costs day x peak, not max(day, peak):
        // the extra is the energy bill times day.mult x (peak - 1).
        const day = CONFIG.tariff.bands[1].mult;
        const peak = CONFIG.events.tariff.multiplier;
        const expected = drawKw * CONFIG.economy.powerCostPerKwh * day * (peak - 1) / 60;
        expect(dayRate - peakRate).toBeCloseTo(expected, 2);
    });
});

describe("it stays off where it was never proven", () => {
    it("defaults OFF, so a flat-meter room is billed flat", () => {
        expect(STATE.tariff.cycleOn).toBe(false);
        steadyRoom(6);
        run(70);                                  // past the day boundary
        expect(STATE.tariff.cycleMul).toBe(1);
        expect(STATE.tariff.band).toBeNull();
    });

    it("resetState severs it", () => {
        STATE.tariff.cycleOn = true;
        STATE.tariff.cycleMul = 1.4;
        STATE.tariff.band = "day";
        resetState();
        expect(STATE.tariff.cycleOn).toBe(false);
        expect(STATE.tariff.cycleMul).toBe(1);
        expect(STATE.tariff.band).toBeNull();
    });

    it("touches the meter and NOTHING else — capacity, heat and SLA are untouched", () => {
        const snap = () => ({
            served: STATE.servedKw,
            it: STATE.itDrawKw,
            total: STATE.totalDrawKw,
            rep: STATE.reputation,
            heat: Array.from(STATE.heatField),
        });
        steadyRoom(6);
        run(80);
        const flat = snap();

        resetState();
        resetBuildingIds();
        STATE.tariff.nextAt = Infinity;
        STATE.heatwave.nextAt = Infinity;
        STATE.brownout.nextAt = Infinity;
        STATE.breakdown.nextAt = Infinity;
        STATE.gridOutage.nextAt = Infinity;
        STATE.contract.nextAt = Infinity;
        steadyRoom(6);
        STATE.tariff.cycleOn = true;
        run(80);
        const priced = snap();

        expect(priced.served).toBe(flat.served);
        expect(priced.it).toBe(flat.it);
        expect(priced.total).toBe(flat.total);
        expect(priced.rep).toBe(flat.rep);
        expect(priced.heat).toEqual(flat.heat);
    });
});
