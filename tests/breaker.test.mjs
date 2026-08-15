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

    it("everything below it reads UNPOWERED, not merely idle", () => {
        // Zeroing the capacity is not enough: a tripped link that stays
        // 'powered' hands a live chain to its now-idle subtree, so racks
        // render green, skip the NOT POWERED row, and keep feeding
        // no-throttle streaks while the room serves nothing.
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu, racks } = bus(6, cap * 2);
        timeToTrip(pdu, 30);
        for (let i = 0; i < 3 / DT; i++) step();
        expect(pdu.powered).toBe(false);
        expect(racks.every((r) => r.powered === false)).toBe(true);
        expect(STATE.servedKw).toBe(0);
    });

    it("a CRAC below it stops drawing — the delivery-side gate, which chainAlive cannot cover", () => {
        // CRACs are assigned nothing by demand.js (they request their own
        // draw), so only the power-side cap=0 keeps them off a dead bus.
        const cap = CONFIG.buildings.pdu.capacityKw;
        const { pdu } = bus(6, cap * 2);
        const crac = place("crac", 12, 9);
        wireBuildings(pdu, crac);
        crac.duty = 1;
        timeToTrip(pdu, 30);
        for (let i = 0; i < 3 / DT; i++) step();
        expect(crac.actualKw).toBe(0);
        expect(crac.powered).toBe(false);
        expect(STATE.totalDrawKw).toBe(0);
    });

    it("a tripped UPS is not a live root either — the trip must beat the buffer clause", () => {
        // chainAlive checks `tripped` BEFORE its UPS-with-charge clause. If
        // that order flipped, a tripped UPS would read as live purely because
        // it still has battery, and assignment would starve the room.
        STATE.demandFixedKw = 40;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, ups);
        wireBuildings(ups, pdu);
        const racks = [];
        for (let i = 0; i < 8; i++) {
            const r = place("rack", 14 + i, 5);
            wireBuildings(pdu, r);
            racks.push(r);
        }
        // Trip the UPS directly, with its buffer still full.
        ups.tripped = true;
        expect(ups.bufferLeft).toBeGreaterThan(0);
        for (let i = 0; i < 3 / DT; i++) step();
        expect(racks.every((r) => r.assignedKw === 0)).toBe(true);
        expect(STATE.servedKw).toBe(0);
    });

    // The test above loads its PDU hard enough (48 kW of racks on a 16 kW
    // bus) that the PDU trips on its own within a few ticks — which means it
    // passes even if the UPS-clause ordering were wrong, because the PDU's
    // own trip masks it. isDeadGear sits on OPPOSITE sides of the UPS clause
    // in chainAlive (before it) and deliver() (after it), and neither site is
    // proven by a mutation that stays isolated to the UPS itself. These two
    // keep the bus safely inside its rating so nothing else can trip.
    it("assignedKw goes to zero within a tick or two of a UPS trip — not only once its buffer runs dry", () => {
        STATE.demandFixedKw = 10;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, ups);
        wireBuildings(ups, pdu);
        const racks = [place("rack", 14, 4), place("rack", 14, 6)]; // 12 kW rated, well under the 16 kW pdu
        racks.forEach((r) => wireBuildings(pdu, r));
        for (let i = 0; i < 5 / DT; i++) step(); // steady state
        expect(racks.some((r) => r.assignedKw > 0)).toBe(true);

        ups.tripped = true;
        expect(ups.bufferLeft).toBeGreaterThan(0); // the buffer has not even started draining
        for (let i = 0; i < 2; i++) step();         // a tick or two, not the ~bufferSec a drain would take
        expect(racks.every((r) => r.assignedKw === 0)).toBe(true);
    });

    it("a tripped UPS reads powered: false even while its own primary path stays live", () => {
        STATE.demandFixedKw = 10;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, ups);
        wireBuildings(ups, pdu);
        const racks = [place("rack", 14, 4), place("rack", 14, 6)];
        racks.forEach((r) => wireBuildings(pdu, r));
        for (let i = 0; i < 5 / DT; i++) step();
        expect(ups.powered).toBe(true);

        ups.tripped = true;
        step();
        // The primary chain above it (feed -> xf) is still fine. A deliver()
        // that checked isDeadGear before the UPS clause would zero it there,
        // then let the UPS clause see outLive === false and self-grant right
        // back to live from its own full buffer — a tripped UPS powering
        // itself off its own battery.
        expect(ups.powered).toBe(false);
    });

    it("an UPSTREAM trip starts the standby generator's cutover and it carries the bus", () => {
        // The generator exists to carry a dead primary path, and an open
        // breaker upstream IS a dead path. If primaryPathDead ignored trips,
        // the cutover clock would reset every tick while demand.js kept
        // assigning the subtree work nobody delivers — the assigned-but-
        // never-served starvation the integration suite exists to prevent.
        STATE.demandFixedKw = 12;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);
        const racks = [place("rack", 12, 4), place("rack", 12, 6)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const gen = place("generator", 2, 9);
        wireBuildings(gen, pdu);           // standby edge onto the bus
        for (let i = 0; i < 5 / DT; i++) step();
        expect(gen.actualKw).toBe(0);      // idle while the primary is fine

        xf.tripped = true;                 // the transformer above it opens…
        for (let i = 0; i < (CONFIG.buildings.generator.cutoverSec + 4) / DT; i++) step();
        // …and the transfer switch picks the bus up, which only happens if
        // primaryPathDead noticed the trip.
        expect(gen.actualKw).toBeGreaterThan(0);
        expect(STATE.servedKw).toBeGreaterThan(0);
    });

    it("a generator cannot paper over the breaker BELOW it — an open bus carries nothing", () => {
        // The counterpart: if the tripped link is the bus itself, no source
        // upstream of it can help. An open breaker protects its own load.
        STATE.demandFixedKw = 12;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);
        for (const [gx, gz] of [[12, 4], [12, 6]]) wireBuildings(pdu, place("rack", gx, gz));
        const gen = place("generator", 2, 9);
        wireBuildings(gen, pdu);
        for (let i = 0; i < 5 / DT; i++) step();

        pdu.tripped = true;
        for (let i = 0; i < (CONFIG.buildings.generator.cutoverSec + 4) / DT; i++) step();
        expect(STATE.servedKw).toBe(0);
        expect(gen.actualKw).toBe(0);
    });
});
