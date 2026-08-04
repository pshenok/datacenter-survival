// Breakers — real gear opens, it does not dim forever.
//
// The load-bearing test here is the FALSE POSITIVE one: a facility that
// never exceeds its ratings must never trip, because the whole campaign
// depends on that. The timing tests pin the inverse-time curve so a retune
// cannot silently turn a 20-second warning into an instant blackout.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { resetBreaker } from "../src/sim/crisis.js";

const DT = 0.05;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// A chain whose PDU carries exactly `rackCount` racks, with demand pinned so
// each rack asks for `perRack` kW.
function bus(rackCount, demandKw) {
    STATE.demandFixedKw = demandKw;
    const feed = place("grid_feed", 2, 5);
    const xf = place("transformer", 5, 5);
    const pdu = place("pdu", 8, 5);
    wireBuildings(feed, xf);
    wireBuildings(xf, pdu);
    const racks = [];
    for (let i = 0; i < rackCount; i++) {
        const r = place("rack", 12 + i * 2, 5);
        wireBuildings(pdu, r);
        racks.push(r);
    }
    return { feed, xf, pdu, racks };
}

function step() {
    STATE.elapsedGameTime += DT;
    const t = STATE.elapsedGameTime;
    tickEvents(DT, t);
    tickDemand(DT, t);
    resolvePower(DT);
    tickHeat(DT);
}

// Seconds until `b` opens, or null if it survived the window.
function timeToTrip(b, maxSec = 120) {
    for (let i = 0; i < maxSec / DT; i++) {
        step();
        if (b.tripped) return STATE.elapsedGameTime;
    }
    return null;
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

describe("the false-positive guard — the campaign depends on this", () => {
    it("never trips a link that stays within its rating, over five minutes", () => {
        const { pdu } = bus(2, 12);          // 12 kW on a 16 kW bus
        for (let i = 0; i < 300 / DT; i++) step();
        expect(pdu.tripped).toBe(false);
        expect(pdu.breakerHeat).toBe(0);
    });

    it("never trips at 100% of rating exactly", () => {
        const { pdu } = bus(3, 16);
        for (let i = 0; i < 300 / DT; i++) step();
        expect(pdu.tripped).toBe(false);
    });

    it("tolerates an overload UNDER the pickup ratio indefinitely — that is the clip regime", () => {
        const cap = CONFIG.buildings.pdu.capacityKw;
        const mild = cap * (CONFIG.breaker.pickupRatio - 0.02);   // just under pickup
        const { pdu } = bus(3, mild);
        for (let i = 0; i < 300 / DT; i++) step();
        expect(pdu.tripped).toBe(false);
    });
});

describe("inverse time — the harder the overload, the faster it opens", () => {
    it("opens a severe overload in about tripSeconds", () => {
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu } = bus(6, cap * 2);      // ~200% of rating
        const t = timeToTrip(pdu, 30);
        expect(t).not.toBeNull();
        expect(t).toBeGreaterThan(CONFIG.breaker.tripSeconds * 0.8);
        expect(t).toBeLessThan(CONFIG.breaker.tripSeconds * 1.6);
    });

    it("takes far longer at a mild overload than at a severe one", () => {
        const cap = CONFIG.buildings.pdu.capacityKw;
        const mild = bus(4, cap * 1.25);
        const tMild = timeToTrip(mild.pdu, 60);
        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        const severe = bus(6, cap * 2);
        const tSevere = timeToTrip(severe.pdu, 30);
        expect(tMild).not.toBeNull();
        expect(tSevere).not.toBeNull();
        expect(tMild).toBeGreaterThan(tSevere * 2);
    });

    it("bleeds the accumulated heat off once the overload goes away", () => {
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu, racks } = bus(4, cap * 1.3);
        for (let i = 0; i < 3 / DT; i++) step();
        expect(pdu.breakerHeat).toBeGreaterThan(0);
        expect(pdu.tripped).toBe(false);
        STATE.demandFixedKw = 4;                    // load drops away
        for (const r of racks) r.assignedKw = 1;
        for (let i = 0; i < 20 / DT; i++) step();
        expect(pdu.breakerHeat).toBe(0);
        expect(pdu.tripped).toBe(false);
    });
});

describe("an open breaker is a dead root", () => {
    it("takes its whole subtree dark and stays dark until reset", () => {
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu, racks } = bus(6, cap * 2);
        timeToTrip(pdu, 30);
        for (let i = 0; i < 5 / DT; i++) step();
        expect(racks.every((r) => r.actualKw === 0)).toBe(true);
        expect(STATE.servedKw).toBe(0);

        // The handle goes back in…
        STATE.demandFixedKw = 10;                   // …and this time it fits
        expect(resetBreaker(pdu)).toBe(true);
        expect(pdu.tripped).toBe(false);
        for (let i = 0; i < 10 / DT; i++) step();
        expect(STATE.servedKw).toBeGreaterThan(0);
        expect(pdu.tripped).toBe(false);
    });

    it("resetting into the SAME overload just opens it again", () => {
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu } = bus(6, cap * 2);
        timeToTrip(pdu, 30);
        resetBreaker(pdu);
        const again = timeToTrip(pdu, 30);
        expect(again).not.toBeNull();
    });

    it("resetBreaker refuses anything that is not open", () => {
        const { pdu } = bus(2, 10);
        expect(resetBreaker(pdu)).toBe(false);
        expect(resetBreaker(null)).toBe(false);
    });

    it("a tripped link is not a live root for assignment either", () => {
        // The bug this guards: if chainAlive missed the trip, racks below a
        // tripped UPS would still be assigned load and 'served' would lie.
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu, racks } = bus(6, cap * 2);
        timeToTrip(pdu, 30);
        for (let i = 0; i < 3 / DT; i++) step();
        expect(racks.every((r) => r.assignedKw === 0)).toBe(true);
    });
});
