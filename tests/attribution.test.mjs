// Loss attribution (Wave 2, the diagnosis layer).
//
// Two tests carry the whole feature. CONSERVATION: the buckets must sum to
// the same missedKw the SLA penalty is charged on — attribution that does
// not add up is worse than none, because it invents a story. INERTNESS:
// turning attribution on must not move a single simulation number, which is
// what makes it safe to bolt onto a shipped sim.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { CAUSE_IDS } from "../src/core/loss-causes.js";
import { lossLedger } from "../src/sim/attribution.js";

const DT = 0.05;
const rngZero = () => 0;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

const sumTick = () => CAUSE_IDS.reduce((s, c) => s + (STATE.losses.tickKw[c] || 0), 0);
const missed = () => Math.max(0, STATE.demandKw - STATE.servedKw);

function step() {
    STATE.elapsedGameTime += DT;
    const t = STATE.elapsedGameTime;
    tickEvents(DT, t);
    tickCrisis(DT, t, rngZero);
    tickDemand(DT, t);
    resolvePower(DT);
    tickHeat(DT);
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

describe("conservation — the buckets ARE the missed demand", () => {
    it("holds every tick through heat, brownout, outage and an over-subscribed PDU", () => {
        STATE.demandFixedKw = 26;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);         // 16 kW cap, deliberately
        wireBuildings(feed, xf);
        wireBuildings(xf, ups);
        wireBuildings(ups, pdu);
        // Five racks (30 kW nameplate) on one 16 kW PDU: over-subscribed,
        // and packed tightly so they cook each other too.
        for (const [gx, gz] of [[14, 4], [15, 4], [14, 5], [15, 5], [14, 6]]) {
            wireBuildings(pdu, place("rack", gx, gz));
        }

        let checked = 0;
        for (let i = 0; i < 180 / DT; i++) {
            // Drive every failure mode through the same run.
            const t = STATE.elapsedGameTime;
            STATE.brownout.active = t > 40 && t < 60;
            STATE.brownout.factor = 0.4;
            STATE.gridOutage.active = t > 100 && t < 112;
            step();
            expect(sumTick()).toBeCloseTo(missed(), 9);
            if (missed() > 0.01) checked++;
        }
        expect(checked).toBeGreaterThan(100);   // the run really did lose work
    });

    it("attributes nothing at all when the facility serves everything", () => {
        STATE.demandFixedKw = 4;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);
        wireBuildings(pdu, place("rack", 12, 5));
        wireBuildings(pdu, place("crac", 13, 5));
        for (let i = 0; i < 30 / DT; i++) step();
        expect(missed()).toBeLessThan(0.01);
        expect(sumTick()).toBeLessThan(0.01);
        expect(STATE.losses.blame.length).toBe(0);
    });
});

describe("inertness — diagnosis must not become physics", () => {
    it("leaves money, served, reputation and the heat field untouched", () => {
        // The sim has no switch to turn attribution off, so this compares a
        // full run against one where the module's own state is scrambled
        // between ticks: if anything read losses back, the two would diverge.
        function run(scramble) {
            resetState();
            resetBuildingIds();
            STATE.heatwave.nextAt = Infinity;
            STATE.brownout.nextAt = Infinity;
            STATE.breakdown.nextAt = Infinity;
            STATE.gridOutage.nextAt = Infinity;
            STATE.tariff.nextAt = Infinity;
            STATE.contract.nextAt = Infinity;
            STATE.demandFixedKw = 18;
            const feed = place("grid_feed", 2, 5);
            const xf = place("transformer", 5, 5);
            const pdu = place("pdu", 8, 5);
            wireBuildings(feed, xf);
            wireBuildings(xf, pdu);
            for (const [gx, gz] of [[12, 4], [12, 5], [12, 6]]) {
                wireBuildings(pdu, place("rack", gx, gz));
            }
            for (let i = 0; i < 120 / DT; i++) {
                step();
                if (scramble) {
                    for (const c of CAUSE_IDS) {
                        STATE.losses.tickKw[c] = 999;
                        STATE.losses.totalKwh[c] = 999;
                    }
                    STATE.losses.blame.push({ buildingId: "nonsense", cause: "thermal", kw: 999 });
                }
            }
            return {
                money: STATE.money,
                served: STATE.servedKw,
                rep: STATE.reputation,
                it: STATE.itDrawKw,
                total: STATE.totalDrawKw,
                heat: Array.from(STATE.heatField),
            };
        }
        const plain = run(false);
        const poisoned = run(true);
        expect(poisoned.money).toBe(plain.money);
        expect(poisoned.served).toBe(plain.served);
        expect(poisoned.rep).toBe(plain.rep);
        expect(poisoned.it).toBe(plain.it);
        expect(poisoned.total).toBe(plain.total);
        expect(poisoned.heat).toEqual(plain.heat);
    });
});

describe("naming the right culprit", () => {
    function room({ demand, racks, cracs = [], pduCount = 1 }) {
        STATE.demandFixedKw = demand;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, ups);
        const pdus = [];
        for (let i = 0; i < pduCount; i++) {
            const p = place("pdu", 11, 5 + i * 3);
            wireBuildings(ups, p);
            pdus.push(p);
        }
        racks.forEach(([gx, gz], i) => wireBuildings(pdus[i % pdus.length], place("rack", gx, gz)));
        cracs.forEach(([gx, gz], i) => wireBuildings(pdus[i % pdus.length], place("crac", gx, gz)));
        return { feed, xf, ups, pdus };
    }

    it("blames HEAT when a cool-enough room would have served it", () => {
        // Enough PDU capacity for the whole load (two PDUs, 32 kW) and no
        // cooling: the only thing standing between demand and served is the
        // temperature the racks create themselves.
        room({ demand: 22, racks: [[14, 4], [15, 4], [14, 5], [15, 5]], pduCount: 2 });
        for (let i = 0; i < 200 / DT; i++) step();
        expect(STATE.losses.tickKw.thermal).toBeGreaterThan(0);
        // The dominant cause is heat, not wiring or sizing.
        const top = CAUSE_IDS.reduce((a, c) =>
            (STATE.losses.tickKw[c] > STATE.losses.tickKw[a] ? c : a), CAUSE_IDS[0]);
        expect(top).toBe("thermal");
        expect(STATE.losses.blame[0].cause).toBe("thermal");
    });

    it("blames the CLIPPED LINK when the racks are cool but the PDU is over-subscribed", () => {
        // A MILD overload — three racks (17 kW of demand) on one 16 kW PDU,
        // cooling on its own bus. Above the rating (so it clips) but under
        // the breaker's pickup (so it never opens): the sustained-clip
        // regime, which is what "over-subscribed" means when nothing trips.
        STATE.demandFixedKw = 17;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const busy = place("pdu", 8, 5);
        const cool = place("pdu", 8, 9);
        wireBuildings(feed, xf);
        wireBuildings(xf, busy);
        wireBuildings(xf, cool);
        for (const [gx, gz] of [[14, 4], [16, 4], [14, 8]]) wireBuildings(busy, place("rack", gx, gz));
        for (const [gx, gz] of [[15, 6], [15, 10]]) wireBuildings(cool, place("crac", gx, gz));
        for (let i = 0; i < 60 / DT; i++) step();
        expect(STATE.buildings.every((b) => !b.tripped)).toBe(true);
        expect(STATE.losses.tickKw.link_clip).toBeGreaterThan(0);
        expect(STATE.losses.tickKw.link_clip).toBeGreaterThan(STATE.losses.tickKw.thermal);
        const culprit = STATE.buildings.find((b) => b.id === STATE.losses.blame[0].buildingId);
        expect(culprit.type).toBe("pdu");
    });

    it("blames NO CAPACITY when the room is simply too small", () => {
        room({ demand: 20, racks: [[14, 4]], cracs: [[15, 4]] });   // 6 kW of rack
        for (let i = 0; i < 30 / DT; i++) step();
        expect(STATE.losses.tickKw.no_capacity).toBeGreaterThan(10);
    });

    it("blames the DEAD CHAIN during a blackout, and the flat battery once the UPS drains", () => {
        room({ demand: 12, racks: [[14, 4], [14, 6]] });
        for (let i = 0; i < 20 / DT; i++) step();
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        for (let i = 0; i < 4 / DT; i++) step();   // still on battery
        const duringBuffer = sumTick();
        for (let i = 0; i < 30 / DT; i++) step();  // buffer long gone
        expect(duringBuffer).toBeLessThan(missed());
        expect(STATE.losses.tickKw.battery_empty).toBeGreaterThan(0);
    });

    it("calls a sag a BROWNOUT, not a sizing mistake", () => {
        room({ demand: 20, racks: [[14, 4], [16, 4], [14, 8], [16, 8]], cracs: [[15, 6]], pduCount: 2 });
        for (let i = 0; i < 30 / DT; i++) step();
        STATE.brownout.active = true;
        STATE.brownout.factor = 0.25;
        STATE.brownout.endsAt = Infinity;
        for (let i = 0; i < 10 / DT; i++) step();
        expect(STATE.losses.tickKw.brownout).toBeGreaterThan(0);
        const culprit = STATE.buildings.find((b) => b.id === STATE.losses.blame[0].buildingId);
        expect(culprit.type).toBe("grid_feed");
    });
});

describe("the ledger", () => {
    it("prices every cause at the same SLA rate the sim charges", () => {
        STATE.demandFixedKw = 20;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);
        wireBuildings(pdu, place("rack", 12, 5));
        for (let i = 0; i < 60 / DT; i++) step();

        const ledger = lossLedger();
        expect(ledger.rows.length).toBeGreaterThan(0);
        expect(ledger.totalDollars).toBeCloseTo(
            ledger.totalKwh * CONFIG.economy.slaPenaltyPerKwhMissed, 9);
        // Sorted worst-first, so the panel always leads with the real problem.
        for (let i = 1; i < ledger.rows.length; i++) {
            expect(ledger.rows[i - 1].kwh).toBeGreaterThanOrEqual(ledger.rows[i].kwh);
        }
    });
});
