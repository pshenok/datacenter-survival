// Peak tariff window (ported from Server Survival's COST_SPIKE): the event
// that multiplies the METER and touches nothing else.
//
// The two tests that matter are exactness and inertness — together they are
// the proof that a price event cannot secretly become a physics event.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";

const DT = 0.05;
const rngZero = () => 0;
const BILLING_HOUR_SEC = 60;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

function room() {
    const feed = place("grid_feed", 2, 5);
    const xf = place("transformer", 5, 5);
    const pdu = place("pdu", 8, 5);
    wireBuildings(feed, xf);
    wireBuildings(xf, pdu);
    const racks = [place("rack", 12, 4), place("rack", 12, 6)];
    racks.forEach((r) => wireBuildings(pdu, r));
    const crac = place("crac", 13, 5);
    wireBuildings(pdu, crac);
    return { racks, crac };
}

function run(seconds, { tariff = false } = {}) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        if (!tariff) tickCrisis(DT, t, rngZero);
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
    STATE.demandFixedKw = 8;
});

describe("peak tariff — the bill only", () => {
    it("charges exactly multiplier x the normal power cost, to the cent", () => {
        room();
        run(3);                       // settle the sim
        const draw = STATE.totalDrawKw;
        expect(draw).toBeGreaterThan(0);

        // One tick at normal price.
        const before = STATE.money;
        tickDemand(DT, STATE.elapsedGameTime);
        const normalDelta = STATE.money - before;

        // The same tick at peak price, from the same physical state.
        const mult = 2.5;
        STATE.tariff.active = true;
        STATE.tariff.multiplier = mult;
        const beforePeak = STATE.money;
        tickDemand(DT, STATE.elapsedGameTime);
        const peakDelta = STATE.money - beforePeak;

        // The whole difference is the extra power cost — nothing else moved.
        const extra = STATE.totalDrawKw * CONFIG.economy.powerCostPerKwh
            * (mult - 1) * (DT / BILLING_HOUR_SEC);
        expect(normalDelta - peakDelta).toBeCloseTo(extra, 9);
    });

    it("is provably economic-only: physics is bit-identical with and without it", () => {
        room();
        run(20);
        const plain = {
            served: STATE.servedKw,
            rep: STATE.reputation,
            it: STATE.itDrawKw,
            total: STATE.totalDrawKw,
            heat: Array.from(STATE.heatField),
            temp: STATE.buildings.map((b) => b.tempC),
        };

        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        STATE.demandFixedKw = 8;
        room();
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 2.5;
        STATE.tariff.endsAt = Infinity;
        run(20, { tariff: true });

        expect(STATE.servedKw).toBeCloseTo(plain.served, 12);
        expect(STATE.reputation).toBeCloseTo(plain.rep, 12);
        expect(STATE.itDrawKw).toBeCloseTo(plain.it, 12);
        expect(STATE.totalDrawKw).toBeCloseTo(plain.total, 12);
        expect(STATE.buildings.map((b) => b.tempC)).toEqual(plain.temp);
        expect(Array.from(STATE.heatField)).toEqual(plain.heat);
        // The wallet is the one thing allowed to differ — pinned separately
        // in the next test.
    });

    it("multiplies the METER only — the SLA penalty line is untouched", () => {
        // Every other test here runs fully served, so missedKw is 0 and the
        // penalty term is invisible. Under-provision on purpose: if the
        // multiplier ever leaked onto the SLA line (or onto revenue), the
        // delta below would not equal the power term alone.
        STATE.demandFixedKw = 30;         // far past what one PDU can serve
        room();
        run(4);
        expect(STATE.demandKw - STATE.servedKw).toBeGreaterThan(1);

        const before = STATE.money;
        tickDemand(DT, STATE.elapsedGameTime);
        const normalDelta = STATE.money - before;

        const mult = 2.5;
        STATE.tariff.active = true;
        STATE.tariff.multiplier = mult;
        const beforePeak = STATE.money;
        tickDemand(DT, STATE.elapsedGameTime);
        const peakDelta = STATE.money - beforePeak;

        const powerTermOnly = STATE.totalDrawKw * CONFIG.economy.powerCostPerKwh
            * (mult - 1) * (DT / BILLING_HOUR_SEC);
        expect(normalDelta - peakDelta).toBeCloseTo(powerTermOnly, 9);
    });

    it("costs strictly more money over the same window", () => {
        room();
        run(20);
        const plainMoney = STATE.money;

        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        STATE.demandFixedKw = 8;
        room();
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 2.5;
        STATE.tariff.endsAt = Infinity;
        run(20, { tariff: true });

        expect(STATE.money).toBeLessThan(plainMoney);
    });

    it("schedules, fires and closes like every other crisis event", () => {
        STATE.tariff.nextAt = null;   // survival: let it draw a schedule
        room();
        const cfg = CONFIG.events.tariff;
        run(cfg.minIntervalSec - 5);
        expect(STATE.tariff.active).toBe(false);
        expect(STATE.tariff.multiplier).toBe(1);
        run(10);                      // past minIntervalSec with rngZero
        expect(STATE.tariff.active).toBe(true);
        expect(STATE.tariff.multiplier).toBe(cfg.multiplier);
        run(cfg.minDurationSec + 2);
        expect(STATE.tariff.active).toBe(false);
        expect(STATE.tariff.multiplier).toBe(1);
    });
});
