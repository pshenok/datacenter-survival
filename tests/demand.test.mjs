// Unit tests for src/sim/demand.js — node env (the vitest "unit" project).
// Real modules, no stubs: power/heat outputs (actualKw, throttleFactor,
// totalDrawKw) are set directly on STATE/buildings to simulate "last tick",
// matching the documented demand -> power -> heat one-tick lag.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import {
    tickDemand,
    tickEvents,
    upcomingWave,
    demandCurveKw,
    activeWaveMultiplier,
} from "../src/sim/demand.js";

function wire(parent, child) {
    child.parentId = parent.id;
    parent.childIds.push(child.id);
}

// Minimal live chain: grid-connected feed -> pdu; racks hang off the pdu.
function makeFeedAndPdu() {
    const feed = new Building("grid_feed", 0, 0);
    feed.parentId = "grid";
    const pdu = new Building("pdu", 1, 0);
    wire(feed, pdu);
    STATE.buildings.push(feed, pdu);
    return pdu;
}

function addRack(pdu, gx = 2) {
    const rack = new Building("rack", gx, 1);
    wire(pdu, rack);
    STATE.buildings.push(rack);
    return rack;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("demand curve and waves", () => {
    it("starts at baseKw and grows monotonically", () => {
        expect(demandCurveKw(0)).toBe(CONFIG.demand.baseKw);
        expect(demandCurveKw(10)).toBeGreaterThan(demandCurveKw(0));
        expect(demandCurveKw(50)).toBeGreaterThan(demandCurveKw(10));
    });

    it("applies a wave multiplier from its atSec onward", () => {
        expect(activeWaveMultiplier(59.99)).toBe(1);
        expect(activeWaveMultiplier(60)).toBe(1.4);
        expect(activeWaveMultiplier(119.99)).toBe(1.4);
    });

    it("takes the LAST reached wave's multiplier (no stacking)", () => {
        expect(activeWaveMultiplier(120)).toBe(1.8);
        expect(activeWaveMultiplier(200)).toBe(2.4);
        expect(activeWaveMultiplier(10000)).toBe(2.4);
    });

    it("multiplies the whole ramp, not just baseKw", () => {
        const rawKw = CONFIG.demand.baseKw
            + Math.log(1 + 60 / 30) * CONFIG.demand.logGrowthFactor
            + 60 * CONFIG.demand.linearPerSec;
        expect(demandCurveKw(60)).toBeCloseTo(rawKw * 1.4, 10);
    });

    it("upcomingWave warns only within waveWarningSec of the next wave", () => {
        expect(upcomingWave(51.9)).toBeNull();  // 8.1s out — too early
        expect(upcomingWave(52)).toEqual({ atSec: 60, multiplier: 1.4 });
        expect(upcomingWave(60)).toBeNull();    // landed; next wave is 60s out
        expect(upcomingWave(193)).toEqual({ atSec: 200, multiplier: 2.4 });
        expect(upcomingWave(500)).toBeNull();   // no waves left
    });
});

describe("assignment", () => {
    it("splits demand proportionally among equal racks", () => {
        const pdu = makeFeedAndPdu();
        const a = addRack(pdu, 2);
        const b = addRack(pdu, 3);
        tickDemand(1, 0);                   // demand 4 over 12 kW available
        expect(STATE.demandKw).toBe(4);
        expect(a.assignedKw).toBeCloseTo(2, 10);
        expect(b.assignedKw).toBeCloseTo(2, 10);
    });

    it("weights shares by throttleFactor", () => {
        const pdu = makeFeedAndPdu();
        const a = addRack(pdu, 2);          // avail 6
        const b = addRack(pdu, 3);
        b.throttleFactor = 0.5;             // avail 3
        tickDemand(1, 0);                   // demand 4 over 9 kW available
        expect(a.assignedKw).toBeCloseTo(6 * 4 / 9, 10);
        expect(b.assignedKw).toBeCloseTo(3 * 4 / 9, 10);
    });

    it("caps each rack at capacityKw * throttleFactor when demand exceeds supply", () => {
        const pdu = makeFeedAndPdu();
        const rack = addRack(pdu, 2);
        tickDemand(1, 200);                 // waves active, demand >> 6 kW
        expect(STATE.demandKw).toBeGreaterThan(rack.config.capacityKw);
        expect(rack.assignedKw).toBe(rack.config.capacityKw);
        expect(STATE.servedKw).toBeLessThanOrEqual(STATE.demandKw);
    });

    it("gives zero to thermally shut down and unwired racks", () => {
        const pdu = makeFeedAndPdu();
        const alive = addRack(pdu, 2);
        const cooked = addRack(pdu, 3);
        cooked.throttleFactor = 0;
        cooked.assignedKw = 5;              // stale value must be overwritten
        const unwired = new Building("rack", 4, 1);
        unwired.assignedKw = 5;
        STATE.buildings.push(unwired);
        tickDemand(1, 0);
        expect(alive.assignedKw).toBeGreaterThan(0);
        expect(cooked.assignedKw).toBe(0);
        expect(unwired.assignedKw).toBe(0);
    });

    it("treats wiring cycles and fake grid parents as dead chains", () => {
        const pdu = new Building("pdu", 0, 0);
        const looped = new Building("rack", 1, 0);
        wire(pdu, looped);
        pdu.parentId = looped.id;           // cycle — must terminate, not hang
        const fake = new Building("rack", 2, 0);
        fake.parentId = "grid";             // non-source claiming the grid
        STATE.buildings.push(pdu, looped, fake);
        tickDemand(1, 0);
        expect(looped.assignedKw).toBe(0);
        expect(fake.assignedKw).toBe(0);
        expect(STATE.servedKw).toBe(0);
    });

    it("follows the full chain to a grid-connected source, and dies with it", () => {
        const feed = new Building("grid_feed", 0, 0);
        feed.parentId = "grid";
        const xfmr = new Building("transformer", 1, 0);
        wire(feed, xfmr);
        const ups = new Building("ups", 2, 0);
        wire(xfmr, ups);
        const pdu = new Building("pdu", 3, 0);
        wire(ups, pdu);
        const rack = new Building("rack", 4, 0);
        wire(pdu, rack);
        STATE.buildings.push(feed, xfmr, ups, pdu, rack);

        tickDemand(1, 0);
        expect(rack.assignedKw).toBeGreaterThan(0);

        feed.parentId = null;               // sever the root
        // The chain holds a charged UPS, so assignment legitimately continues
        // — work must keep flowing for the buffer to carry (the blip-vs-
        // blackout integration fix; see tests/integration.test.mjs).
        tickDemand(1, 0);
        expect(rack.assignedKw).toBeGreaterThan(0);

        ups.bufferLeft = 0;                 // buffer spent: NOW the chain is dead
        tickDemand(1, 0);
        expect(rack.assignedKw).toBe(0);
    });
});

describe("servedKw (one-tick lag)", () => {
    it("uses last tick's actualKw, capped by this tick's assignment", () => {
        const pdu = makeFeedAndPdu();
        const rack = addRack(pdu, 2);
        rack.actualKw = 1.5;                // what power delivered LAST tick
        tickDemand(1, 0);                   // demand 4 -> assigned ~4 of avail 6
        expect(rack.assignedKw).toBeCloseTo(4, 10);
        expect(STATE.servedKw).toBeCloseTo(1.5, 10);
    });

    it("multiplies served by throttleFactor", () => {
        const pdu = makeFeedAndPdu();
        const rack = addRack(pdu, 2);
        rack.throttleFactor = 0.5;          // avail 3 < demand 4 -> assigned 3
        rack.actualKw = 3;
        tickDemand(1, 0);
        expect(rack.assignedKw).toBe(3);
        expect(STATE.servedKw).toBeCloseTo(1.5, 10);
    });

    it("never serves more than demand, even with absurd delivered power", () => {
        const pdu = makeFeedAndPdu();
        for (let i = 0; i < 4; i++) {
            addRack(pdu, 2 + i).actualKw = 999;
        }
        for (let t = 0; t <= 300 && STATE.gameOver === null; t += 10) {
            tickDemand(1, t);
            expect(STATE.servedKw).toBeLessThanOrEqual(STATE.demandKw);
        }
    });
});

describe("economy", () => {
    it("turns a profit when serving with modest facility draw", () => {
        const pdu = makeFeedAndPdu();
        addRack(pdu, 2).actualKw = 6;
        addRack(pdu, 3).actualKw = 6;
        STATE.totalDrawKw = 5;              // last tick's facility draw
        STATE.gridKw = 5;                   // ...all of it off the feed, so all billable
        tickDemand(60, 0);                  // one game minute = one billing hour
        // revenue 4 kW * $3/kWh - cost 5 kW * $0.9/kWh, no SLA miss
        expect(STATE.money).toBeCloseTo(CONFIG.economy.startMoney + 12 - 4.5, 6);
        expect(STATE.money).toBeGreaterThan(CONFIG.economy.startMoney);
    });

    it("bleeds money on idle draw: power bill plus SLA penalty", () => {
        STATE.totalDrawKw = 3;              // a CRAC idling, nothing served
        STATE.gridKw = 3;                   // idling ON THE UTILITY, so the meter runs
        tickDemand(6, 0);                   // demand 4, served 0
        const expected = CONFIG.economy.startMoney
            - 3 * CONFIG.economy.powerCostPerKwh * 6 / 60
            - 4 * CONFIG.economy.slaPenaltyPerKwhMissed * 6 / 60;
        expect(STATE.money).toBeCloseTo(expected, 10);
        expect(STATE.money).toBeLessThan(CONFIG.economy.startMoney);
    });
});

describe("reputation", () => {
    it("holds at 100 under full service", () => {
        const pdu = makeFeedAndPdu();
        addRack(pdu, 2).actualKw = 10;
        tickDemand(1, 0);
        expect(STATE.reputation).toBeCloseTo(100, 6);
        expect(STATE.gameOver).toBeNull();
    });

    it("decays to game over under sustained zero service", () => {
        // No racks at all: demand > 0 and served 0 every tick.
        for (let i = 0; i < 200 && STATE.gameOver === null; i++) {
            tickDemand(1, i);
            expect(STATE.reputation).toBeGreaterThanOrEqual(0);
        }
        expect(STATE.gameOver).toBe("reputation");
        expect(STATE.reputation).toBeLessThanOrEqual(0.5);
    });

    it("clamps at 100 even when a huge dt makes the drift overshoot", () => {
        const pdu = makeFeedAndPdu();
        addRack(pdu, 2).actualKw = 10;
        STATE.reputation = 30;
        tickDemand(100, 0);                 // gap 70 * 0.08 * 100 -> ~590 raw
        expect(STATE.reputation).toBe(100);
    });
});

describe("game over", () => {
    it("bankruptcy fires at bankruptcyAt and wins over reputation in the same tick", () => {
        STATE.money = -499;
        STATE.totalDrawKw = 20;
        tickDemand(60, 0);                  // bill 18 + penalty 6; rep also crashes
        expect(STATE.money).toBeLessThanOrEqual(CONFIG.economy.bankruptcyAt);
        expect(STATE.gameOver).toBe("bankrupt");
    });

    it("freezes every tick function once set", () => {
        const pdu = makeFeedAndPdu();
        const rack = addRack(pdu, 2);
        rack.actualKw = 6;
        STATE.totalDrawKw = 4;
        STATE.gameOver = "bankrupt";
        const before = {
            money: STATE.money,
            reputation: STATE.reputation,
            demandKw: STATE.demandKw,
            servedKw: STATE.servedKw,
            assignedKw: rack.assignedKw,
            heatwave: { ...STATE.heatwave },
        };
        tickDemand(1, 100);
        tickEvents(1, 95);                  // past the first heatwave's nextAt
        expect(STATE.money).toBe(before.money);
        expect(STATE.reputation).toBe(before.reputation);
        expect(STATE.demandKw).toBe(before.demandKw);
        expect(STATE.servedKw).toBe(before.servedKw);
        expect(rack.assignedKw).toBe(before.assignedKw);
        expect(STATE.heatwave).toEqual(before.heatwave);
    });

    it("dt === 0 is a full no-op for both tick functions", () => {
        const pdu = makeFeedAndPdu();
        const rack = addRack(pdu, 2);
        rack.actualKw = 6;
        rack.assignedKw = 5;                // stale value must survive dt=0
        STATE.totalDrawKw = 4;
        tickDemand(0, 500);
        tickEvents(0, 500);                 // way past nextAt — still no fire
        expect(STATE.demandKw).toBe(0);
        expect(STATE.servedKw).toBe(0);
        expect(STATE.money).toBe(CONFIG.economy.startMoney);
        expect(STATE.reputation).toBe(CONFIG.sla.startReputation);
        expect(rack.assignedKw).toBe(5);
        expect(STATE.heatwave.active).toBe(false);
        expect(STATE.heatwave.nextAt).toBe(CONFIG.events.heatwave.firstAtSec);
        expect(STATE.gameOver).toBeNull();
    });
});

describe("adversarial", () => {
    it("treats NaN, negative, and Infinity dt as full no-ops (like power.js)", () => {
        const pdu = makeFeedAndPdu();
        const rack = addRack(pdu, 2);
        rack.actualKw = 6;
        STATE.totalDrawKw = 4;
        tickDemand(1, 10);                  // establish a normal baseline tick
        tickEvents(1, 10);
        const before = {
            money: STATE.money,
            reputation: STATE.reputation,
            demandKw: STATE.demandKw,
            servedKw: STATE.servedKw,
            assignedKw: rack.assignedKw,
            heatwave: { ...STATE.heatwave },
        };
        for (const dt of [NaN, -1, Infinity]) {
            tickDemand(dt, 50);
            tickEvents(dt, 500);            // way past nextAt — must not fire
        }
        expect(STATE.money).toBe(before.money);
        expect(STATE.reputation).toBe(before.reputation);
        expect(STATE.demandKw).toBe(before.demandKw);
        expect(STATE.servedKw).toBe(before.servedKw);
        expect(rack.assignedKw).toBe(before.assignedKw);
        expect(STATE.heatwave).toEqual(before.heatwave);
        expect(STATE.gameOver).toBeNull();
    });

    it("50 racks on one PDU: equal shares summing to demand, then hard caps under overload", () => {
        const pdu = makeFeedAndPdu();
        const racks = [];
        for (let i = 0; i < 50; i++) {
            racks.push(addRack(pdu, 2 + (i % 20)));
        }
        tickDemand(1, 0);                   // demand 4 over 300 kW available
        let sum = 0;
        for (const r of racks) {
            expect(r.assignedKw).toBeCloseTo(STATE.demandKw / 50, 10);
            sum += r.assignedKw;
        }
        expect(sum).toBeCloseTo(STATE.demandKw, 8);

        for (const r of racks) {
            r.actualKw = 999;               // absurd stale delivery
        }
        tickDemand(1, 10000);               // demand ~531 kW > 300 kW supply
        expect(STATE.demandKw).toBeGreaterThan(300);
        for (const r of racks) {
            expect(r.assignedKw).toBe(r.config.capacityKw);
        }
        expect(STATE.servedKw).toBeCloseTo(300, 8);
        expect(STATE.servedKw).toBeLessThanOrEqual(STATE.demandKw);
    });

    it("empty world: ticks safely, bleeds exactly the SLA penalty, events still fire", () => {
        let expected = CONFIG.economy.startMoney;
        for (let t = 1; t <= 10; t++) {
            tickDemand(1, t);
            expected -= demandCurveKw(t) * CONFIG.economy.slaPenaltyPerKwhMissed / 60;
            expect(Number.isFinite(STATE.money)).toBe(true);
            expect(STATE.servedKw).toBe(0);
        }
        expect(STATE.money).toBeCloseTo(expected, 10);
        expect(STATE.reputation).toBeLessThan(CONFIG.sla.startReputation);
        expect(STATE.gameOver).toBeNull();
        tickEvents(1, 90);                  // schedule runs with no buildings
        expect(STATE.heatwave.active).toBe(true);
    });

    it("survives a chain as long as the whole world, and kills full rings", () => {
        const feed = new Building("grid_feed", 0, 0);
        feed.parentId = "grid";
        STATE.buildings.push(feed);
        let top = feed;
        for (let i = 0; i < 24; i++) {
            const t = new Building("transformer", 1 + i, 0);
            wire(top, t);
            STATE.buildings.push(t);
            top = t;
        }
        const pdu = new Building("pdu", 26, 0);
        wire(top, pdu);
        STATE.buildings.push(pdu);
        const rack = addRack(pdu, 27);      // 27 hops from grid — still alive
        tickDemand(1, 0);
        expect(rack.assignedKw).toBeCloseTo(Math.min(STATE.demandKw, 6), 10);

        resetState();
        resetBuildingIds();
        const ring = [];
        for (let i = 0; i < 12; i++) {
            ring.push(new Building("pdu", i, 1));
        }
        for (let i = 0; i < 12; i++) {
            ring[i].parentId = ring[(i + 1) % 12].id;
        }
        const orphan = new Building("rack", 0, 2);
        wire(ring[0], orphan);
        const selfie = new Building("rack", 1, 2);
        selfie.parentId = selfie.id;        // self-parented — must terminate
        STATE.buildings.push(...ring, orphan, selfie);
        tickDemand(1, 0);                   // must return, not hang
        expect(orphan.assignedKw).toBe(0);
        expect(selfie.assignedKw).toBe(0);
        expect(STATE.servedKw).toBe(0);
    });

    it("wave logic is order-independent when config waves are unsorted", () => {
        CONFIG.demand.waves.push({ atSec: 30, multiplier: 9 });
        try {
            expect(activeWaveMultiplier(45)).toBe(9);     // 30 is last REACHED
            expect(activeWaveMultiplier(65)).toBe(1.4);   // 60 outranks 30
            expect(upcomingWave(25)).toEqual({ atSec: 30, multiplier: 9 });
            expect(upcomingWave(55)).toEqual({ atSec: 60, multiplier: 1.4 });
        } finally {
            CONFIG.demand.waves.pop();
        }
    });

    it("huge dt with zero service: reputation clamps to 0 (never negative/NaN) and ends the game", () => {
        tickDemand(200, 0);                 // drift raw delta would be -1600
        expect(STATE.reputation).toBe(0);
        expect(STATE.money).toBeCloseTo(
            CONFIG.economy.startMoney - 4 * CONFIG.economy.slaPenaltyPerKwhMissed * 200 / 60, 10);
        expect(STATE.gameOver).toBe("reputation");
    });
});

describe("heatwave events", () => {
    it("fires at nextAt (not before), sets endsAt, reschedules nextAt", () => {
        tickEvents(1, 89.9);
        expect(STATE.heatwave.active).toBe(false);
        tickEvents(1, 90);
        expect(STATE.heatwave.active).toBe(true);
        expect(STATE.heatwave.endsAt).toBe(115);    // 90 + durationSec 25
        expect(STATE.heatwave.nextAt).toBe(210);    // 90 + intervalSec 120
    });

    it("stays active through the window and ends at endsAt", () => {
        tickEvents(1, 90);
        tickEvents(1, 114.9);
        expect(STATE.heatwave.active).toBe(true);
        tickEvents(1, 115);
        expect(STATE.heatwave.active).toBe(false);
        expect(STATE.heatwave.nextAt).toBe(210);
    });

    it("fires again at the rescheduled nextAt", () => {
        tickEvents(1, 90);
        tickEvents(1, 115);
        tickEvents(1, 209.9);
        expect(STATE.heatwave.active).toBe(false);
        tickEvents(1, 210);
        expect(STATE.heatwave.active).toBe(true);
        expect(STATE.heatwave.endsAt).toBe(235);
        expect(STATE.heatwave.nextAt).toBe(330);
    });
});
