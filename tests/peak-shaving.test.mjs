// Peak shaving (STATE.peakShave) — a player toggle that lets a charged UPS
// serve its subtree from the battery instead of the grid, so a room can
// choose WHEN it buys energy, not just how much.
//
// The whole mechanic rests on the battery being ENERGY and the energy
// balancing. A buffer-second is one second of capacityKw draw, so the battery
// holds capacityKw * bufferSec kW.s; shaving may hand out only what is
// actually in there this tick, and the charger buys back only what actually
// left. Get that wrong and a UPS is a generator: the first cut of this
// mechanic granted the full subtree draw whatever the charge, forgave the
// shortfall with a Math.max(0, ...), and settled into a two-tick pump that
// returned 400% of what it stored — profitable to leave switched on at a
// FLAT tariff, which is the definition of a mechanic that is a purchase
// rather than a decision.
//
// See src/sim/power.js (the mechanic, STATE.batteryKw, the charger on the
// chain), src/sim/demand.js (the meter subtracts batteryKw), and
// src/core/config.js (rechargeRate, roundTripEff) for the reasoning.
import { beforeEach, describe, expect, it } from "vitest";

import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { feedIsDark, resolvePower, unwire, wireBuildings } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickContracts } from "../src/sim/contracts.js";

const DT = 0.05;
const U = CONFIG.buildings.ups;

// The charger's nameplate draw, derived the way sim/power.js derives it.
const CHARGER_KW = (U.capacityKw * U.rechargeRate) / U.roundTripEff;
// Everything the battery holds when full, in kW.s.
const FULL_KWS = U.capacityKw * U.bufferSec;

function place(type, gx = 0, gz = 0) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// grid_feed -> transformer -> ups -> pdu, ready for loads. Mirrors
// tests/power.test.mjs's own chain() exactly — modest demand only (well
// under the transformer's 30kW rating), for tests that just need a live UPS
// with a buffer, not the UPS's full 36kW rating.
function chain() {
    const feed = place("grid_feed");
    const t = place("transformer");
    const ups = place("ups");
    const pdu = place("pdu");
    wireBuildings(feed, t);
    wireBuildings(t, ups);
    wireBuildings(ups, pdu);
    return { feed, t, ups, pdu };
}

// `shaved` racks behind one UPS on its own grid feed, plus `plain` racks on a
// SECOND, un-buffered feed. The plain half is what stops a credit bug from
// hiding: with the UPS carrying 100% of the facility, batteryKw equals
// totalDrawKw, demand.js's Math.max(0, ...) clamp floors the bill at zero,
// and a credit inflated by 50% bills exactly the same nothing.
function room(shaved, plain = 0) {
    STATE.demandFixedKw = (shaved + plain) * 6;
    const feed = place("grid_feed", 2, 5);
    const ups = place("ups", 8, 5);
    wireBuildings(feed, ups);
    const racks = [];
    for (let i = 0; i < Math.ceil(shaved / 2); i++) {
        const pdu = place("pdu", 11, 5 + i * 3);
        wireBuildings(ups, pdu);
        for (let j = 0; j < 2 && i * 2 + j < shaved; j++) {
            const rack = place("rack", 14, 5 + i * 3 + j);
            wireBuildings(pdu, rack);
            racks.push(rack);
        }
    }
    const plainRacks = [];
    if (plain > 0) {
        const feed2 = place("grid_feed", 2, 20);
        const pdu2 = place("pdu", 11, 20);
        wireBuildings(feed2, pdu2);
        for (let k = 0; k < plain; k++) {
            const rack = place("rack", 14, 20 + k);
            wireBuildings(pdu2, rack);
            plainRacks.push(rack);
        }
    }
    return { feed, ups, racks, plainRacks };
}

function runFull(seconds, onTick) {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        if (onTick) onTick(t);
        tickEvents(DT, t);
        tickDemand(DT, t);
        resolvePower(DT);
    }
}

function pinSchedules() {
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    pinSchedules();
});

describe("STATE.peakShave defaults off and resetState severs it", () => {
    it("is off by default and cleared by resetState", () => {
        expect(STATE.peakShave.on).toBe(false);
        STATE.peakShave.on = true;
        resetState();
        expect(STATE.peakShave.on).toBe(false);
    });
});

describe("while OFF, behaviour is bit-identical to before the mechanic existed", () => {
    it("a full, live-path UPS neither shaves nor bills a battery kW", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        for (let i = 0; i < 20; i++) resolvePower(1);
        expect(ups.bufferLeft).toBe(U.bufferSec); // never drained
        expect(ups.upsMode).toBe("idle");
        expect(STATE.batteryKw).toBe(0);
        expect(STATE.totalDrawKw).toBeCloseTo(4, 9); // no phantom charger draw
    });

    it("turning peakShave OFF mid-discharge stops the drain on the very next tick", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        STATE.peakShave.on = true;
        resolvePower(1);
        const bufferAfterOneSec = ups.bufferLeft;
        expect(bufferAfterOneSec).toBeLessThan(U.bufferSec);
        STATE.peakShave.on = false;
        resolvePower(1);
        // No longer shaving: the buffer only RECHARGES from here (it can only
        // move up, never down again), and batteryKw goes back to 0.
        expect(ups.bufferLeft).toBeGreaterThan(bufferAfterOneSec);
        expect(STATE.batteryKw).toBe(0);
    });
});

describe("ON: the battery spends only what it holds", () => {
    it("serves the subtree from the battery instead of the grid, spending the energy it delivers", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        STATE.peakShave.on = true;
        resolvePower(1);
        expect(ups.upsMode).toBe("shaving");
        // 4 kW for 1 s is 4 kW.s out of a 288 kW.s battery — 4/36 of a
        // buffer-second, NOT a whole second. A battery discharged at an
        // eighth of its rating lasts eight times as long, and the meter is
        // credited for the kW.s it really handed over.
        expect(ups.bufferLeft).toBeCloseTo(U.bufferSec - 4 / U.capacityKw, 9);
        expect(ups.bufferOwedKws).toBeCloseTo(4, 9);
        // The subtree is served in FULL despite the grid never being asked —
        // shaving must not degrade delivery to the racks.
        expect(rack.actualKw).toBeCloseTo(4, 9);
        expect(rack.powered).toBe(true);
        expect(STATE.batteryKw).toBeCloseTo(4, 9);
    });

    it("THE GRANT IS CAPPED BY THE CHARGE LEFT: a sliver of battery shaves a sliver, the grid carries the rest", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        ups.bufferLeft = 0.01;          // 0.36 kW.s left, and 4 kW.s wanted
        STATE.peakShave.on = true;
        resolvePower(1);
        // THE bug this file exists for: the old clause granted the whole
        // 4 kW from a battery holding 0.36 kW.s and clamped the overdraw
        // away, so the meter was credited 4 kW for energy that was never
        // there. It may credit exactly 0.36 kW.s' worth and no more.
        expect(STATE.batteryKw).toBeCloseTo(0.36, 9);
        expect(ups.bufferLeft).toBe(0);
        // ...and the racks still get every watt: the grid quietly carries
        // the 3.64 kW the battery could not.
        expect(rack.actualKw).toBeCloseTo(4, 9);
        expect(rack.powered).toBe(true);
    });

    it("an EMPTY buffer cannot shave — falls back to the grid and recharges exactly as if peakShave were off", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        ups.bufferLeft = 0;
        STATE.peakShave.on = true;
        resolvePower(1);
        // The shave condition (bufferLeft > 0) is false, so this falls
        // straight through to the ordinary charging branch — the SAME branch
        // peakShave OFF would have taken. Nothing tracked what left this
        // hand-set battery, so the charger falls back to the nameplate
        // reading of the missing seconds and refills at the classic dt/4.
        expect(ups.bufferLeft).toBeCloseTo(0.25, 9);
        expect(STATE.batteryKw).toBe(0);
        expect(rack.actualKw).toBeCloseTo(4, 9); // served by the grid instead
        expect(ups.upsMode).toBe("charging");
    });

    it("does not touch totalDrawKw/itDrawKw — PUE stays the same whoever paid for the kW", () => {
        // Twin rooms, identical topology and identical assignedKw, shaving
        // only on one. If shaving quietly changed what "drawn" means, PUE
        // (computed from totalDrawKw/itDrawKw in src/ui/hud.js) would lie.
        const on = chain();
        const rackOn = place("rack");
        rackOn.assignedKw = 5;
        wireBuildings(on.pdu, rackOn);
        const cracOn = place("crac");
        cracOn.duty = 0.6;
        wireBuildings(on.pdu, cracOn);
        STATE.peakShave.on = true;
        resolvePower(1);
        const { itDrawKw: itOn, totalDrawKw: totalOn } = STATE;

        resetState();
        resetBuildingIds();
        const off = chain();
        const rackOff = place("rack");
        rackOff.assignedKw = 5;
        wireBuildings(off.pdu, rackOff);
        const cracOff = place("crac");
        cracOff.duty = 0.6;
        wireBuildings(off.pdu, cracOff);
        STATE.peakShave.on = false;
        resolvePower(1);

        expect(itOn).toBe(STATE.itDrawKw);
        expect(totalOn).toBe(STATE.totalDrawKw);
        // But batteryKw itself DOES differ — that's the whole mechanic.
        expect(STATE.batteryKw).toBe(0);
    });

    it("the existing outage self-grant path is untouched — bridging happens the same whether or not peakShave is on", () => {
        for (const on of [false, true]) {
            resetState();
            resetBuildingIds();
            pinSchedules();
            const { ups, pdu } = chain();
            const rack = place("rack");
            rack.assignedKw = 4;
            wireBuildings(pdu, rack);
            unwire(ups); // upstream dead — the outage bridge, not shaving
            STATE.peakShave.on = on;
            resolvePower(1);
            expect(ups.upsMode).toBe("bridging");
            expect(ups.bufferLeft).toBeCloseTo(U.bufferSec - 1, 9);
            expect(rack.actualKw).toBeCloseTo(4, 9);
            expect(rack.powered).toBe(true);
            expect(STATE.batteryKw).toBe(0); // bridging is not billed as shaving
        }
    });
});

describe("THE AUDIT: the round trip cannot beat roundTripEff", () => {
    // kW.s out of the battery vs kW.s bought to put them back, measured over
    // a long machine-played run with the toggle simply left on — the exact
    // ledger that read 400% before the fix.
    function audit(seconds, shaved) {
        resetState();
        resetBuildingIds();
        pinSchedules();
        const { ups } = room(shaved);
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 1;
        STATE.tariff.endsAt = Infinity;
        STATE.peakShave.on = true;
        let outKws = 0;
        let storedKws = 0;
        for (let i = 0; i < Math.round(seconds / DT); i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            const owedBefore = ups.bufferOwedKws;
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            storedKws += Math.max(0, owedBefore - ups.bufferOwedKws);
            outKws += STATE.batteryKw * DT;
        }
        return {
            outKws,
            storedKws,
            boughtKws: storedKws / U.roundTripEff,
            owed: ups.bufferOwedKws,
            left: ups.bufferLeft,
        };
    }

    it("CONSERVATION: what came out equals what was stored plus what the battery is still short", () => {
        const a = audit(600, 6);
        // The battery holds FULL_KWS - owed. Start full, so
        //   out = stored + owed_at_the_end
        // to the last decimal — every kW.s delivered was either bought and
        // put there or drawn out of the charge it was built with. The old
        // clause failed this by a factor of four.
        expect(a.outKws).toBeCloseTo(a.storedKws + a.owed, 6);
        expect(a.outKws).toBeLessThanOrEqual(FULL_KWS + a.storedKws + 1e-6);
    });

    it("the MARGINAL round trip is roundTripEff — every kW.s cycled costs the loss", () => {
        const a = audit(600, 6);
        // Discount the charge the UPS was built with (an asset spent once,
        // not energy created) and what is left is the cycle itself.
        const marginal = (a.outKws - FULL_KWS) / a.boughtKws;
        expect(marginal).toBeCloseTo(U.roundTripEff, 3);
        expect(marginal).toBeLessThan(1);
    });

    it("THE TWO-TICK PUMP hands back 90% of what it just bought, not 400%", () => {
        // The exact loop that made the mechanic a generator: an empty
        // battery charges on one tick, the toggle spends it on the next, and
        // the old clause paid out the WHOLE subtree draw for a battery
        // holding one tick of charger output.
        const { ups } = room(4);         // 24 kW, so the charger is not clipped
        ups.bufferLeft = 0;
        ups.bufferOwedKws = FULL_KWS;
        STATE.peakShave.on = true;

        runFull(DT);                     // tick 1: charges, shaves nothing
        expect(ups.upsMode).toBe("charging");
        expect(STATE.batteryKw).toBe(0);
        const boughtKws = CHARGER_KW * DT;
        const storedKws = boughtKws * U.roundTripEff;
        expect(FULL_KWS - ups.bufferOwedKws).toBeCloseTo(storedKws, 9);

        runFull(DT);                     // tick 2: spends exactly that charge
        expect(ups.upsMode).toBe("shaving");
        const deliveredKws = STATE.batteryKw * DT;
        expect(deliveredKws).toBeCloseTo(storedKws, 9);
        expect(deliveredKws / boughtKws).toBeCloseTo(U.roundTripEff, 9);
        // Before the fix this delivered the full 24 kW for the tick — 1.2
        // kW.s out of a 0.45 kW.s battery.
        expect(STATE.batteryKw).toBeLessThan(24);
        expect(ups.bufferLeft).toBeCloseTo(0, 9);
    });
});

describe("batteryKw is credited ONCE per delivered kW, not once per UPS", () => {
    it("a UPS behind a UPS, with un-buffered load alongside, credits the shaved kW exactly once", () => {
        // feed -> ups -> ups -> pdu -> 2 racks  (8 kW, buffered twice over)
        // feed -> pdu -> rack                   (4 kW, no battery anywhere)
        const feedA = place("grid_feed", 2, 5);
        const upsA = place("ups", 5, 5);
        const upsB = place("ups", 8, 5);
        const pduA = place("pdu", 11, 5);
        wireBuildings(feedA, upsA);
        wireBuildings(upsA, upsB);   // ups -> ups is a legal link edge
        wireBuildings(upsB, pduA);
        for (let i = 0; i < 2; i++) {
            const r = place("rack", 14, 5 + i);
            r.assignedKw = 4;
            wireBuildings(pduA, r);
        }
        const feedB = place("grid_feed", 2, 20);
        const pduB = place("pdu", 11, 20);
        wireBuildings(feedB, pduB);
        const plain = place("rack", 14, 20);
        plain.assignedKw = 4;
        wireBuildings(pduB, plain);

        STATE.peakShave.on = true;
        resolvePower(1);

        expect(STATE.totalDrawKw).toBeCloseTo(12, 9);
        // Crediting per UPS traversed made this 16 — more than the whole
        // facility drew — so demand.js's clamp billed zero and the
        // un-buffered rack rode along free.
        expect(STATE.batteryKw).toBeCloseTo(8, 9);
        expect(STATE.batteryKw).toBeLessThan(STATE.totalDrawKw);
        // The un-buffered 4 kW is still fully on the meter.
        expect(STATE.totalDrawKw - STATE.batteryKw).toBeCloseTo(4, 9);
        // And the downstream UPS did not pointlessly dump its own battery to
        // displace kW its parent had already displaced.
        expect(upsA.bufferLeft).toBeLessThan(U.bufferSec);
        expect(upsB.bufferLeft).toBe(U.bufferSec);
    });

    it("a shaving UPS above a CHARGING one loses nothing in the gap between them", () => {
        // upsA is full and spending; upsB is flat and buying. upsA commits
        // its battery against upsB's whole pull — racks AND charger — so if
        // the charger then refuses battery-sourced power, that energy leaves
        // the battery and arrives nowhere. Measured before this was fixed:
        // 18 kW.s out of upsA, 8 kW.s to the racks, 10 kW.s deleted.
        const feed = place("grid_feed", 2, 5);
        const upsA = place("ups", 5, 5);
        const upsB = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);
        wireBuildings(feed, upsA);
        wireBuildings(upsA, upsB);
        wireBuildings(upsB, pdu);
        for (let i = 0; i < 2; i++) {
            const r = place("rack", 14, 5 + i);
            r.assignedKw = 4;
            wireBuildings(pdu, r);
        }
        upsB.bufferLeft = 0;
        upsB.bufferOwedKws = FULL_KWS;
        STATE.peakShave.on = true;
        resolvePower(1);

        expect(upsB.upsMode).toBe("charging");
        const spentKws = (U.bufferSec - upsA.bufferLeft) * U.capacityKw;
        const deliveredKws = STATE.batteryKw * 1;
        expect(deliveredKws).toBeCloseTo(spentKws, 9);   // nothing evaporates
        // 8 kW of racks plus a 10 kW charger, every watt off upsA's battery.
        expect(STATE.totalDrawKw).toBeCloseTo(8 + CHARGER_KW, 9);
        expect(STATE.batteryKw).toBeCloseTo(8 + CHARGER_KW, 9);
        expect(STATE.totalDrawKw - STATE.batteryKw).toBeCloseTo(0, 9);
        // And it is a bad idea, not free: the same energy is now paying the
        // round-trip loss twice over on its way into the second battery.
        expect(FULL_KWS - upsB.bufferOwedKws).toBeLessThan(spentKws);
    });

    it("a TRIPPED UPS credits nothing and spends nothing — it is isolated, not shaving", () => {
        // Two independent things have to hold for this, and it is worth
        // knowing which one carries it: the PULL phase zeroes dead gear's
        // capacity, so a tripped UPS has nothing to serve and the shave
        // branch never opens — and the credit is banked at the loads, which
        // received nothing. The dead-gear sweep in deliver() is too late to
        // help; it zeroes the DELIVERY, long after a battery could have been
        // spent and a meter credited.
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        STATE.peakShave.on = true;
        ups.tripped = true;
        resolvePower(1);
        expect(rack.actualKw).toBe(0);
        expect(rack.powered).toBe(false);
        expect(STATE.batteryKw).toBe(0);
        expect(ups.bufferLeft).toBe(U.bufferSec);
        expect(ups.bufferOwedKws).toBe(0);
    });
});

describe("sim/demand.js bills grid-sourced draw only", () => {
    it("THE FORMULA: the meter charges what came off the GRID, not what the facility drew", () => {
        // Isolate the billing arithmetic from power.js entirely: pin the
        // draw split by hand and zero out demand so revenue and SLA terms
        // drop out, leaving only the power-cost term to compare. power.js is
        // what displaces shaved kW out of gridKw — the whole-loop proof of
        // that is the per-tick invariant at the bottom of this file.
        STATE.demandFixedKw = 0;
        // Three sources, three prices. The split is deliberately one no
        // single subtraction can reproduce: a meter that charged
        // (totalDrawKw - batteryKw) would bill 8 here, not 5, because a
        // generator is not a battery and neither of them is the utility.
        STATE.totalDrawKw = 20;     // the facility drew 20 — PUE's numerator
        STATE.batteryKw = 12;       // 12 of it came out of a battery
        STATE.gridKw = 5;           // 5 off a feed; the other 3 off diesel
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 2;
        STATE.tariff.endsAt = Infinity;
        const before = STATE.money;
        tickDemand(DT, 1);
        const perKw = CONFIG.economy.powerCostPerKwh * STATE.tariff.multiplier * (DT / 60);
        expect(STATE.money - before).toBeCloseTo(-(STATE.gridKw * perKw), 9);
        // ...and neither the facility draw nor the draw-minus-battery is
        // what was charged, which is the whole claim.
        expect(STATE.money - before).not.toBeCloseTo(-(STATE.totalDrawKw * perKw), 9);
        expect(STATE.money - before).not.toBeCloseTo(
            -((STATE.totalDrawKw - STATE.batteryKw) * perKw), 9
        );
    });

    // THE LESSON THIS LEVEL EXISTS FOR: a generator and a battery are how
    // you stop paying the utility for a while. The meter used to charge the
    // whole facility draw through a total blackout — the diesel the
    // generator was burning, and the kW coming out of a UPS — so the room
    // paid the city for energy the city had visibly stopped delivering, on
    // top of the fuel and the recharge it was already paying for.
    it("A UTILITY CANNOT BILL YOU FOR A BLACKOUT: nothing came off the meter, so nothing is charged", () => {
        STATE.demandFixedKw = 12;
        // One room on a generator, one behind a UPS buffer. No grid feed is
        // alive for either of them.
        const gen = place("generator", 2, 2);
        const pduG = place("pdu", 5, 2);
        wireBuildings(gen, pduG);
        for (let i = 0; i < 2; i++) wireBuildings(pduG, place("rack", 8, 2 + i));
        const feed = place("grid_feed", 2, 10);
        const ups = place("ups", 5, 10);
        const pduU = place("pdu", 8, 10);
        wireBuildings(feed, ups);
        wireBuildings(ups, pduU);
        wireBuildings(pduU, place("rack", 11, 10));

        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        STATE.gridOutage.scope = "all";

        let charged = 0;
        let drew = 0;
        let servedTicks = 0;
        runFull(6, () => {
            charged += STATE.gridKw;
            drew += STATE.totalDrawKw;
            if (STATE.itDrawKw > 0) servedTicks++;
        });

        // The room really did run — on diesel and on stored charge.
        expect(servedTicks).toBeGreaterThan(100);
        expect(drew).toBeGreaterThan(0);
        expect(gen.fuelLiters).toBeLessThan(gen.config.tankLiters);   // fuel paid for it
        expect(ups.bufferOwedKws).toBeGreaterThan(0);                 // recharge will pay for it
        // ...and the utility delivered NOT ONE kW, so it billed nothing.
        expect(charged).toBe(0);
    });

    // The mirror, and the reason this is not an `if (gridOutage.active)`:
    // the grid can be perfectly healthy and a room still be off it.
    it("A ROOM ON A GENERATOR pays in fuel, not on the meter — with the grid perfectly healthy", () => {
        STATE.demandFixedKw = 24;
        const gen = place("generator", 2, 2);
        const pduG = place("pdu", 5, 2);
        wireBuildings(gen, pduG);
        for (let i = 0; i < 2; i++) wireBuildings(pduG, place("rack", 8, 2 + i));
        const feed = place("grid_feed", 2, 10);
        const pduF = place("pdu", 5, 10);
        wireBuildings(feed, pduF);
        const metered = [];
        for (let i = 0; i < 2; i++) {
            const r = place("rack", 8, 10 + i);
            wireBuildings(pduF, r);
            metered.push(r);
        }

        let charged = 0;
        let meteredDraw = 0;
        let facilityDraw = 0;
        runFull(6, () => {
            charged += STATE.gridKw;
            meteredDraw += metered.reduce((s, x) => s + x.actualKw, 0);
            facilityDraw += STATE.totalDrawKw;
        });

        expect(STATE.gridOutage.active).toBe(false);   // nothing is wrong with the grid
        expect(gen.fuelLiters).toBeLessThan(gen.config.tankLiters);
        // The meter charged the fed half and ONLY the fed half — half the
        // facility's draw, to nine decimals.
        expect(charged).toBeCloseTo(meteredDraw, 9);
        expect(charged).toBeCloseTo(facilityDraw / 2, 9);
    });

    it("batteryKw >= totalDrawKw never bills a negative power cost (clamped)", () => {
        STATE.demandFixedKw = 0;
        STATE.totalDrawKw = 5;
        STATE.batteryKw = 999; // pathological — must never happen, but must not pay the player
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 2;
        STATE.tariff.endsAt = Infinity;
        const before = STATE.money;
        tickDemand(DT, 1);
        expect(STATE.money).toBeGreaterThanOrEqual(before); // no negative power cost
    });
});

describe("the charger buys back what actually left, at a rate set by the UPS's own capacity", () => {
    it("CONFIG sizes the charger from capacityKw, and a full-rating drain still refills at dt/4", () => {
        // rechargeRate is the share of capacityKw that LANDS in the battery
        // each second; the draw is that grossed up by the loss.
        expect(CHARGER_KW).toBeCloseTo(10, 9);
        expect(U.rechargeRate).toBeCloseTo(0.25, 9);
        // A battery emptied at the UPS's full rating comes back at the pace
        // it always did: bufferSec / rechargeRate seconds.
        expect(U.bufferSec / U.rechargeRate).toBeCloseTo(32, 9);
    });

    it("a recharging UPS adds its draw into totalDrawKw — billed like any load", () => {
        const { t, ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        resolvePower(3); // drain some buffer via the (untouched) outage bridge
        expect(ups.bufferLeft).toBeLessThan(U.bufferSec);
        wireBuildings(t, ups); // path restored — now it recharges
        resolvePower(0.2);
        expect(ups.upsMode).toBe("charging");
        // totalDrawKw is MORE than the rack alone: the charger draw is in it.
        expect(STATE.totalDrawKw).toBeGreaterThan(4);
        expect(STATE.totalDrawKw).toBeCloseTo(4 + CHARGER_KW, 6);
    });

    it("A SHALLOW DISCHARGE BUYS A SHALLOW RECHARGE — the bill is the energy, not the nameplate", () => {
        const { t, ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        resolvePower(4);  // 4 s of bridging a 4 kW room
        // Bridging spends 4 SECONDS of buffer but only 16 kW.s of energy.
        expect(ups.bufferLeft).toBeCloseTo(U.bufferSec - 4, 9);
        expect(ups.bufferOwedKws).toBeCloseTo(16, 9);
        wireBuildings(t, ups);
        const owed = ups.bufferOwedKws;
        let charged = 0;
        for (let i = 0; i < 2000 && ups.bufferOwedKws > 0; i++) {
            resolvePower(DT);
            charged += DT;
        }
        // Energy in = energy out / roundTripEff, and the window is that over
        // the charger's draw — 2 s, not the 16 s a nameplate refill of the
        // same four seconds would have billed.
        expect(ups.bufferLeft).toBe(U.bufferSec);
        expect(charged).toBeCloseTo(owed / U.roundTripEff / CHARGER_KW, 1);
        expect(charged).toBeLessThan(4 / U.rechargeRate);
    });

    it("pue_hold IS WINNABLE AGAIN after a full-drain outage", () => {
        // The contract holds PUE under a bar for holdSec of a windowSec
        // window, as one unbroken streak. Billing a nameplate refill after
        // every outage parked a small room over the bar for 32 s, and
        // windowSec - 32 is less than holdSec: arithmetically unwinnable, by
        // a mechanic the player never switched on.
        const cfg = CONFIG.contracts.pool.find((p) => p.key === "pue_hold");
        expect(cfg.windowSec - U.bufferSec / U.rechargeRate).toBeLessThan(cfg.holdSec);

        STATE.demandFixedKw = 12;
        const feed = place("grid_feed", 2, 5);
        const ups = place("ups", 8, 5);
        wireBuildings(feed, ups);
        const pdu = place("pdu", 11, 5);
        wireBuildings(ups, pdu);
        for (let i = 0; i < 2; i++) wireBuildings(pdu, place("rack", 14, 5 + i));
        const crac = place("crac", 14, 8);
        wireBuildings(pdu, crac);

        const step = () => {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickContracts(DT, t, () => 0.3);   // pool[1] === pue_hold
        };
        for (let i = 0; i < 600; i++) step();               // settle
        expect(STATE.totalDrawKw / STATE.itDrawKw).toBeLessThan(cfg.pueBelow);

        // A blackout long enough to empty the battery completely.
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = STATE.elapsedGameTime + 12;
        for (let i = 0; i < 240; i++) step();
        STATE.gridOutage.active = false;
        expect(ups.bufferLeft).toBe(0);
        expect(ups.bufferOwedKws).toBeGreaterThan(0);

        // Offer the contract the instant the lights come back — the worst
        // moment there is, with the whole recharge still ahead of it.
        STATE.contract.nextAt = STATE.elapsedGameTime;
        STATE.contract.key = null;
        STATE.contract.done = null;
        step();
        expect(STATE.contract.key).toBe("pue_hold");
        STATE.contract.nextAt = Infinity;
        for (let i = 0; i < Math.round(cfg.windowSec / DT); i++) step();
        expect(STATE.contract.done).toBe("paid");
    });
});

describe("a recharging UPS is a load on its own upstream", () => {
    it("IS CLIPPED BY UPSTREAM CAPACITY — a charger cannot conjure kW a transformer will not pass", () => {
        STATE.demandFixedKw = 24;
        const feed = place("grid_feed", 2, 5);
        const t = place("transformer", 5, 5);      // 30 kW — the bottleneck
        const ups = place("ups", 8, 5);
        wireBuildings(feed, t);
        wireBuildings(t, ups);
        for (let i = 0; i < 2; i++) {
            const pdu = place("pdu", 11, 5 + i * 3);
            wireBuildings(ups, pdu);
            for (let j = 0; j < 2; j++) wireBuildings(pdu, place("rack", 14, 5 + i * 3 + j));
        }
        runFull(20);
        expect(STATE.itDrawKw).toBeCloseTo(24, 6);
        unwire(ups);
        runFull(10);                               // drain the battery flat
        expect(ups.bufferLeft).toBe(0);
        wireBuildings(t, ups);
        runFull(1);

        expect(ups.upsMode).toBe("charging");
        expect(ups.rechargeReqKw).toBeCloseTo(CHARGER_KW, 9);
        // 24 kW of racks under a 30 kW transformer leaves 6 kW of headroom,
        // so the 10 kW charger gets 6. The link is pinned at its rating, not
        // carrying 34.
        expect(t.actualKw).toBeCloseTo(t.config.capacityKw, 6);
        expect(STATE.totalDrawKw).toBeCloseTo(30, 6);
        expect(STATE.totalDrawKw).toBeLessThan(24 + CHARGER_KW);
    });

    it("BURNS GENERATOR FUEL when a generator is the one carrying it", () => {
        STATE.demandFixedKw = 10;
        const feed = place("grid_feed", 2, 5);
        const t = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);
        wireBuildings(feed, t);
        wireBuildings(t, ups);
        wireBuildings(ups, pdu);
        for (let i = 0; i < 2; i++) wireBuildings(pdu, place("rack", 14, 5 + i));
        const g = place("generator", 2, 12);
        wireBuildings(g, t);                       // standby transfer switch
        runFull(20);
        const rackKw = STATE.itDrawKw;

        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        // Bridge through the cutoverSec gap, then the generator picks up and
        // the UPS starts buying back the seconds it just spent.
        runFull(g.config.cutoverSec + 0.5);
        expect(ups.bufferOwedKws).toBeGreaterThan(0);
        expect(ups.upsMode).toBe("charging");
        const fuelBefore = g.fuelLiters;
        const window = 1;
        runFull(window);
        expect(ups.upsMode).toBe("charging");
        // The generator carries the room AND the charger — the classic way
        // to under-size a standby set.
        expect(g.actualKw).toBeCloseTo(rackKw + CHARGER_KW, 4);
        const burned = fuelBefore - g.fuelLiters;
        const racksAlone = rackKw * (window / 60) * g.config.litersPerKwh;
        expect(burned).toBeGreaterThan(racksAlone * 1.5);
        expect(burned).toBeCloseTo((rackKw + CHARGER_KW) * (window / 60) * g.config.litersPerKwh, 3);
    });

    it("DOES NOT RECHARGE AT ALL while its upstream is dead — no utility bill during a blackout", () => {
        STATE.demandFixedKw = 12;
        const { ups } = room(2);
        runFull(10);
        // Half-drain it, then leave the grid dark for the rest of the run.
        unwire(ups);
        runFull(4);
        const drained = ups.bufferLeft;
        expect(drained).toBeLessThan(U.bufferSec);
        expect(drained).toBeGreaterThan(0);

        let maxOverhead = 0;
        for (let i = 0; i < 200; i++) {
            const before = ups.bufferLeft;
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            // The battery can only fall while its own feed is gone.
            expect(ups.bufferLeft).toBeLessThanOrEqual(before + 1e-12);
            expect(ups.upsMode).not.toBe("charging");
            maxOverhead = Math.max(maxOverhead, STATE.totalDrawKw - STATE.itDrawKw);
        }
        expect(maxOverhead).toBeCloseTo(0, 9);     // not one kW of charger on the meter
    });
});

// A UPS bridging an outage spends SECONDS at its full rating however little
// it is carrying — that is the question the bridge answers, "how long do I
// have?", and every campaign level is proven against it. bufferOwedKws is a
// different quantity: the ENERGY that actually left, and the exact figure the
// charger buys back on the meter. When a transfer switch below the UPS hands
// part of the bridged subtree to a generator, the battery stops delivering
// that part — and a book that still says otherwise makes the recharge cost a
// multiple of the outage that caused it.
describe("a bridged subtree a GENERATOR took is not energy the battery gave up", () => {
    // feed -> ups -> transformer -> { pduGen -> 2 racks , pduStay -> 1 rack }
    // generator --standby--> pduGen
    function room() {
        STATE.demandFixedKw = 18;
        const feed = place("grid_feed", 2, 2);
        const ups = place("ups", 5, 2);
        const tr = place("transformer", 8, 2);
        const pduGen = place("pdu", 11, 2);
        const pduStay = place("pdu", 11, 8);
        wireBuildings(feed, ups);
        wireBuildings(ups, tr);
        wireBuildings(tr, pduGen);
        wireBuildings(tr, pduStay);
        const taken = [];
        for (let i = 0; i < 2; i++) {
            const r = place("rack", 14, 2 + i);
            wireBuildings(pduGen, r);
            taken.push(r);
        }
        const left = [place("rack", 14, 8)];
        wireBuildings(pduStay, left[0]);
        const gen = place("generator", 2, 12);
        wireBuildings(gen, pduGen);
        return { feed, ups, tr, pduGen, pduStay, taken, left, gen };
    }

    it("THE BATTERY OWES WHAT IT HANDED OVER, not what the room pulled before the switch closed", () => {
        const r = room();
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;

        let booked = 0;
        let reallyLeft = 0;
        let afterPickupBooked = 0;
        let afterPickupReal = 0;
        let pickupTicks = 0;

        for (let i = 0; i < Math.round(12 / DT); i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickDemand(DT, t);
            const owedBefore = r.ups.bufferOwedKws;
            const secBefore = r.ups.bufferLeft;
            resolvePower(DT);
            const drainedSec = secBefore - r.ups.bufferLeft;
            // GROUND TRUTH, read off the delivered state: the load under this
            // UPS that the GENERATOR is not carrying. Before the cutover
            // that is the whole room; after it, only the branch the wave
            // left behind.
            const allLoad = [...r.taken, ...r.left].reduce((s, x) => s + x.actualKw, 0);
            const onBattery = Math.max(0, allLoad - r.gen.actualKw);
            booked += r.ups.bufferOwedKws - owedBefore;
            reallyLeft += onBattery * drainedSec;
            if (r.gen.actualKw > 0) {
                pickupTicks++;
                afterPickupBooked += r.ups.bufferOwedKws - owedBefore;
                afterPickupReal += onBattery * drainedSec;
            }
        }

        // The run really went through a cutover with the bridge still live.
        expect(pickupTicks).toBeGreaterThan(50);
        expect(afterPickupReal).toBeGreaterThan(0);
        // The generator took 12 of the 18 kW, so a book that never noticed
        // charges the battery 3x on every tick after pickup.
        expect(afterPickupBooked).toBeCloseTo(afterPickupReal, 9);
        expect(booked).toBeCloseTo(reallyLeft, 9);
        expect(booked).toBeGreaterThan(0);
    });

    it("...and the UPS stops REPORTING the kW a generator is carrying", () => {
        const r = room();
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        runFull(r.gen.config.cutoverSec + 1);
        expect(r.gen.actualKw).toBeGreaterThan(0);       // the switch closed
        expect(r.ups.upsMode).toBe("bridging");          // ...and the bridge is still up
        // 18 kW before the switch closed, 6 after it. The inspector reads
        // this field, so a stale one tells the player the battery is
        // carrying three times what it is.
        expect(r.ups.actualKw).toBeCloseTo(6, 9);
        expect(r.left[0].actualKw).toBeCloseTo(6, 9);    // and the branch really is served
    });
});

describe("THE DECISION: when to leave it on, and when it is a bill", () => {
    // Both directions are machine-played on the real tick loop, with the
    // toggle driven the way a player drives it — nothing releases at a moment
    // no button exists for.
    function play(seconds, shaveAt, { cycle = false } = {}) {
        resetState();
        resetBuildingIds();
        pinSchedules();
        const { ups } = room(5);
        STATE.tariff.cycleOn = cycle;
        if (!cycle) {
            STATE.tariff.active = true;
            STATE.tariff.multiplier = 1;
            STATE.tariff.endsAt = Infinity;
        }
        const before = STATE.money;
        runFull(seconds, (t) => { STATE.peakShave.on = shaveAt(t); });
        return { delta: STATE.money - before, buffer: ups.bufferLeft };
    }
    const always = () => true;
    const never = () => false;
    const inDayBand = (t) => (t % CONFIG.tariff.periodSec) >= CONFIG.tariff.bands[1].fromSec;
    const RUN_SEC = 1200;

    it("THE LESSON: left ON for the whole run at a FLAT meter, shaving LOSES money", () => {
        // No release, no timing, no clairvoyance — the toggle is simply on,
        // which is what the button actually lets a player do. With nothing to
        // arbitrage, every lap of the battery pays the round-trip loss.
        const shaved = play(RUN_SEC, always);
        const control = play(RUN_SEC, never);
        expect(shaved.delta).toBeLessThan(control.delta);
    });

    it("AND leaves the room with no ride-through: the buffer it spent is the buffer an outage needed", () => {
        const shaved = play(RUN_SEC, always);
        const control = play(RUN_SEC, never);
        expect(shaved.buffer).toBeLessThan(0.05);
        expect(control.buffer).toBe(U.bufferSec);
    });

    it("THE PAIR: the same timed schedule PAYS against the day/night spread and LOSES at a flat meter", () => {
        // Identical player behaviour — on through the expensive band, off
        // through the cheap one — judged by two different meters. That the
        // answer flips is the whole reason this is a decision and not a
        // purchase.
        const spreadShaved = play(RUN_SEC, inDayBand, { cycle: true });
        const spreadControl = play(RUN_SEC, never, { cycle: true });
        expect(spreadShaved.delta).toBeGreaterThan(spreadControl.delta);

        const flatShaved = play(RUN_SEC, inDayBand);
        const flatControl = play(RUN_SEC, never);
        expect(flatShaved.delta).toBeLessThan(flatControl.delta);
    });
});

describe("measured in-game: one full discharge at day x peak, recharged at night", () => {
    it("shifts capacityKw*bufferSec/60 kWh and nets solidly positive money — a real trade, not free money", () => {
        const dayPeak = CONFIG.tariff.bands[1].mult * CONFIG.events.tariff.multiplier; // 1.4 x 2.5
        const night = CONFIG.tariff.bands[0].mult; // 0.6
        const RECHARGE_WINDOW = 90;

        function scenario(shave) {
            resetState();
            resetBuildingIds();
            pinSchedules();
            // 36 kW behind the UPS, 6 kW that never touches a battery. With
            // the UPS carrying the whole facility this test could not see an
            // inflated credit at all: the clamp would bill zero either way.
            const { ups } = room(6, 1);
            STATE.tariff.active = true;
            STATE.tariff.multiplier = dayPeak;
            STATE.tariff.endsAt = Infinity;
            STATE.peakShave.on = shave;
            const m0 = STATE.money;
            runFull(U.bufferSec, null);
            const afterDischarge = STATE.money;
            const bufferAfterDischarge = ups.bufferLeft;
            STATE.peakShave.on = false;
            STATE.tariff.multiplier = night;
            runFull(RECHARGE_WINDOW, null);
            return {
                dischargeDelta: afterDischarge - m0,
                rechargeDelta: STATE.money - afterDischarge,
                bufferAfterDischarge,
                owed: ups.bufferOwedKws,
            };
        }

        const shaved = scenario(true);
        const control = scenario(false);

        const kwhShifted = FULL_KWS / 60;
        expect(kwhShifted).toBeCloseTo(4.8, 9);
        expect(shaved.bufferAfterDischarge).toBeCloseTo(0, 6);
        expect(shaved.owed).toBe(0);              // fully bought back

        const avoided = shaved.dischargeDelta - control.dischargeDelta;
        const rechargeCost = control.rechargeDelta - shaved.rechargeDelta;
        const net = avoided - rechargeCost;

        expect(avoided).toBeGreaterThan(14);
        expect(avoided).toBeLessThan(16);
        expect(rechargeCost).toBeGreaterThan(2);
        expect(rechargeCost).toBeLessThan(4);
        expect(net).toBeGreaterThan(10);
        expect(net).toBeLessThan(14);
    });

    it("while shaving, the meter bills EXACTLY the un-buffered load and nothing else", () => {
        resetState();
        resetBuildingIds();
        pinSchedules();
        room(6, 1);
        STATE.peakShave.on = true;
        let samples = 0;
        runFull(U.bufferSec / 2, null);
        for (let i = 0; i < 40; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            // 36 kW off the battery, 6 kW off the meter. A credit inflated
            // by any amount shows here as an under-bill; the clamp cannot
            // hide it, because the bill is not floored at zero.
            expect(STATE.totalDrawKw - STATE.batteryKw).toBeCloseTo(6, 6);
            samples++;
        }
        expect(samples).toBe(40);
    });
});

// Three bugs shipped on this branch and all three were the SAME bug: the
// credit on the meter and the energy that left the battery disagreed, and
// nothing in this suite ever put the two numbers side by side. The 457% pump
// credited kW the battery did not hold; the chained-UPS double count credited
// the same kW at every UPS it passed through; the standby wave rolled a
// re-delivered subtree's buffers back to the snapshot and kept the credit
// anyway. Each was found by a person reading the code, one at a time, after
// it had already shipped. This is that reading, done every tick.
// THE OTHER DIRECTION. Every clause of the ledger invariant below reads
// `x > y`: they catch a meter or a booking that charges TOO MUCH, which is
// unfair, and say nothing about one that charges too little — which is free
// energy, and worse. These pin the floor for the topologies a player actually
// builds: with no generator and no battery discharging, the utility delivered
// every kW the facility drew, so gridKw and totalDrawKw are the same number.
//
// (The chaotic run below cannot carry this clause yet: a bridge that runs its
// buffer to zero hands out one final tick it no longer has — carried 6 kW,
// booked 0 — which shows up here as an under-bill. That is a real defect, it
// predates gridKw, and it is written up rather than papered over with a
// tolerance wide enough to hide it.)
describe("the meter's floor: kW nobody paid for is free energy", () => {
    it("a plain grid-fed room bills every kW it drew", () => {
        const feed = place("grid_feed", 2, 5);
        const t = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, t); wireBuildings(t, pdu);
        for (let i = 0; i < 3; i++) {
            const r = place("rack", 11 + i, 5);
            wireBuildings(pdu, r);
            r.assignedKw = CONFIG.buildings.rack.capacityKw;
        }
        for (let k = 0; k < 40; k++) resolvePower(DT);
        expect(STATE.totalDrawKw).toBeGreaterThan(0);
        expect(STATE.batteryKw).toBe(0);
        expect(STATE.gridKw).toBeCloseTo(STATE.totalDrawKw, 9);
    });

    it("a UPS in the chain with shaving OFF bills the racks AND its charger", () => {
        const feed = place("grid_feed", 2, 5);
        const t = place("transformer", 5, 5);
        const ups = place("ups", 8, 5);
        const pdu = place("pdu", 11, 5);
        wireBuildings(feed, t); wireBuildings(t, ups); wireBuildings(ups, pdu);
        for (let i = 0; i < 3; i++) {
            const r = place("rack", 14 + i, 5);
            wireBuildings(pdu, r);
            r.assignedKw = CONFIG.buildings.rack.capacityKw;
        }
        for (let k = 0; k < 40; k++) resolvePower(DT);
        expect(STATE.totalDrawKw).toBeGreaterThan(0);
        expect(STATE.gridKw).toBeCloseTo(STATE.totalDrawKw, 9);
    });

    it("a generator branch beside a grid branch: each kW billed to its own source", () => {
        const feed = place("grid_feed", 2, 5);
        const t = place("transformer", 5, 5);
        const pduA = place("pdu", 8, 5);
        wireBuildings(feed, t); wireBuildings(t, pduA);
        for (let i = 0; i < 2; i++) {
            const r = place("rack", 11 + i, 5);
            wireBuildings(pduA, r);
            r.assignedKw = CONFIG.buildings.rack.capacityKw;
        }
        const gen = place("generator", 2, 15);
        const pduB = place("pdu", 8, 15);
        wireBuildings(gen, pduB);
        for (let i = 0; i < 2; i++) {
            const r = place("rack", 11 + i, 15);
            wireBuildings(pduB, r);
            r.assignedKw = CONFIG.buildings.rack.capacityKw;
        }
        for (let k = 0; k < 60; k++) resolvePower(DT);
        const gens = STATE.buildings
            .filter((b) => b.type === "generator")
            .reduce((s, b) => s + Math.max(0, b.actualKw), 0);
        expect(gens).toBeGreaterThan(0);
        // Nothing drawn off-meter, and nothing billed that diesel produced.
        expect(STATE.gridKw + gens).toBeCloseTo(STATE.totalDrawKw, 9);
        expect(STATE.gridKw).toBeCloseTo(STATE.totalDrawKw - gens, 9);
    });
});

describe("THE LEDGER: a credited kW.s came out of a battery, or it did not happen", () => {
    // Every UPS keeps two independent books on the same physical event: the
    // CHARGE it gave up (bufferLeft, denominated in seconds of capacityKw)
    // and the DEBT it took on (bufferOwedKws, what the charger has to buy
    // back). Shaving moves them in lockstep. The outage bridge deliberately
    // spends a second of buffer per second whatever it is carrying, so there
    // the seconds read high and the debt is the honest number. The TIGHTER of
    // the two is therefore the most energy that can possibly have left that
    // battery this tick — and a bug that inflates one book cannot hide behind
    // the other.
    function books() {
        const m = new Map();
        for (const b of STATE.buildings) {
            if (b.type === "ups") m.set(b.id, { sec: b.bufferLeft, owed: b.bufferOwedKws });
        }
        return m;
    }

    // ...and only the UPSes that actually SHAVED count toward what may be
    // credited. Every credited kW traces to the shaving branch in
    // sim/power.js — a root grants grantBattKw 0, the bridge sets outBattKw
    // to 0 explicitly, and nothing else adds — so a UPS in any other mode
    // contributes energy the meter was never credited for. Summing all of
    // them instead leaves STANDING SLACK: a partially-transferred outage
    // bridge books its debt against the pass-1 subtree pull, and measured on
    // this exact run that slack is 321 kW.s spread over 318 ticks, enough to
    // hide an injected 25% credit inflation on 318 of the 2900 credited ticks
    // — the whole-facility pool caught it on 2582, this pool on all 2900.
    //
    // (Attributing the credit itself back to the UPS it came out of would be
    // tighter still, and is NOT free: a load's credit is a proportional clip
    // of a battery share that may be mixed from two UPSes in series, so it
    // would mean threading originating ids through grantBattKw in
    // sim/power.js — production complexity for a test's benefit, in the one
    // function on this branch that has now been wrong four times. Filtering
    // by mode removes all of the masking that was actually measurable.)
    function energyOutKws(before) {
        let out = 0;
        for (const b of STATE.buildings) {
            if (b.type !== "ups" || b.upsMode !== "shaving") continue;
            const was = before.get(b.id);
            const byCharge = (was.sec - b.bufferLeft) * (b.config.capacityKw || 0);
            const byDebt = b.bufferOwedKws - was.owed;
            out += Math.max(0, Math.min(byCharge, byDebt));
        }
        return out;
    }

    // The same two books read the other way: what LANDED in a battery this
    // tick. Same argument for taking the tighter of the two — the charger
    // moves seconds and debt from one `restored` number, so they agree, and a
    // bug that inflates either one alone cannot hide behind the other.
    function energyInKws(before) {
        let inn = 0;
        for (const b of STATE.buildings) {
            if (b.type !== "ups") continue;
            const was = before.get(b.id);
            const byCharge = (b.bufferLeft - was.sec) * (b.config.capacityKw || 0);
            const byDebt = was.owed - b.bufferOwedKws;
            inn += Math.max(0, Math.min(byCharge, byDebt));
        }
        return inn;
    }

    // What the CHARGERS put on the meter this tick. sim/power.js builds
    // totalDrawKw as racks + cooling + charger draw, so subtracting every
    // load's actualKw leaves exactly the charger term — no test-only field,
    // and it reads the same number a broken implementation would publish.
    function billedChargerKw() {
        let loads = 0;
        for (const b of STATE.buildings) {
            if (b.config.chainRole === "load") loads += b.actualKw;
        }
        return STATE.totalDrawKw - loads;
    }

    // The nameplate-refill fallback in sim/power.js (`owed = deficitSec *
    // cap` when a UPS has seconds missing but no debt) is unreachable from
    // play — every second that leaves a battery books its energy on the way
    // out — and the two books only agree while that stays true. Counted so
    // that if it ever becomes reachable this test says WHICH assumption
    // broke instead of going red somewhere confusing.
    function nameplateRefillsPending() {
        let n = 0;
        for (const b of STATE.buildings) {
            if (b.type !== "ups") continue;
            if (b.bufferOwedKws === 0 && b.bufferLeft < (b.config.bufferSec || 0)) n++;
        }
        return n;
    }

    // One facility with every hazard in it at once, because each of the three
    // bugs needed a DIFFERENT one and a suite of single-purpose rooms is how
    // they kept getting through:
    //   grid_feed -> ups -> ups -> pdu -> 2 racks + a CRAC   chained batteries
    //   generator -> pdu -> 2 racks                          never buffered
    //   generator --standby--> the first UPS                 the transfer switch
    //   grid_feed -> pdu -> 3 racks                          18 kW on a 16 kW bus
    //   grid_feed -> pdu -> a CRAC                           still billed after it opens
    //   grid_feed -> ups -> transformer -> pdu -> 2 racks    the ANCESTOR case:
    //   generator --standby--> that pdu                      a UPS on LIVE power
    //                                                        above a serviced link
    //   grid_feed -> ups -> ups -> pdu -> 2 racks            a CHARGER inside a
    //   generator --standby--> the upper ups                 re-delivered subtree
    //   grid_feed -> transformer -> pdu -> 2 racks           TWO TRANSFER
    //   generator --standby--> that transformer              SWITCHES IN SERIES,
    //   generator --standby--> that pdu                      deep one placed first
    //   grid_feed -> ups -> transformer -> pdu -> 2 racks    a bridge only
    //                              \--> pdu -> 1 rack        PARTLY transferred
    //   generator --standby--> the first of those pdus
    function facility() {
        STATE.demandFixedKw = 96;                      // every rack at its full 6 kW
        const feedA = place("grid_feed", 2, 5);
        const upsA = place("ups", 5, 5);
        const upsB = place("ups", 8, 5);
        const pduA = place("pdu", 11, 5);
        wireBuildings(feedA, upsA);
        wireBuildings(upsA, upsB);                     // ups -> ups is a legal edge
        wireBuildings(upsB, pduA);
        for (let i = 0; i < 2; i++) wireBuildings(pduA, place("rack", 14, 5 + i));
        const cracA = place("crac", 14, 8);            // a buffered load that is not a rack
        cracA.duty = 0.5;
        wireBuildings(pduA, cracA);

        const gen = place("generator", 2, 12);
        const pduG = place("pdu", 11, 12);
        wireBuildings(gen, pduG);                      // the generator's own room
        for (let i = 0; i < 2; i++) wireBuildings(pduG, place("rack", 14, 12 + i));
        wireBuildings(gen, upsA);                      // ...and standby for the UPS chain

        const feedB = place("grid_feed", 2, 20);
        const pduB = place("pdu", 11, 20);
        wireBuildings(feedB, pduB);
        for (let i = 0; i < 3; i++) wireBuildings(pduB, place("rack", 14, 20 + i));
        const pduC = place("pdu", 11, 25);
        wireBuildings(feedB, pduC);
        const cracB = place("crac", 14, 25);
        cracB.duty = 0.5;
        wireBuildings(pduC, cracB);

        // The ancestor case. upsC never loses its own feed — the death is
        // BELOW it, a transformer that goes out for service — so it sits on
        // live utility power and legitimately charges back what the toggle
        // spent, while a second generator carries the subtree underneath.
        // That is a UPS "above a standby attach point on a dead primary path"
        // that was never bridging, and rolling its charge back is a recharge
        // billed and never delivered.
        const feedC = place("grid_feed", 18, 5);
        const upsC = place("ups", 21, 5);
        const trC = place("transformer", 24, 5);
        const pduD = place("pdu", 27, 5);
        wireBuildings(feedC, upsC);
        wireBuildings(upsC, trC);
        wireBuildings(trC, pduD);
        for (let i = 0; i < 2; i++) wireBuildings(pduD, place("rack", 27, 8 + i));
        const gen2 = place("generator", 18, 12);
        wireBuildings(gen2, pduD);                     // standby: pduD is already fed

        // A charger INSIDE a re-delivered subtree. The wave rolls upsE's
        // buffer back to the snapshot and resolves it a second time, so a
        // charger that ran once gets billed once per pass unless the draw is
        // banked per node. It only lines up when upsD is STILL BRIDGING as
        // the cutover completes — that is what keeps upsE live on pass 1 —
        // which is why this branch gets its own generator with headroom and
        // its own outage before the one that matters: a bridge books far less
        // debt per second of buffer than shaving does, so a room that has
        // already been through a blackout recharges its SECONDS fast enough
        // to still be carrying when the transfer switch lands.
        const feedD = place("grid_feed", 18, 18);
        const upsD = place("ups", 21, 18);
        const upsE = place("ups", 24, 18);
        const pduE = place("pdu", 27, 18);
        wireBuildings(feedD, upsD);
        wireBuildings(upsD, upsE);                     // ups -> ups again
        wireBuildings(upsE, pduE);
        for (let i = 0; i < 2; i++) wireBuildings(pduE, place("rack", 27, 21 + i));
        const gen3 = place("generator", 18, 25);       // wired standby mid-run

        // TWO TRANSFER SWITCHES IN SERIES on one chain: one generator's
        // candidate is an ANCESTOR of the other's. The DEEP machine is placed
        // FIRST on purpose — that is the order in which the shallower
        // candidate is invisible to a guard that only walks a candidate's
        // parents, and both machines then carry (and buy diesel for) the same
        // two racks. Placement order is not a physical fact about a room, so
        // the invariants below have to hold in this order too.
        const feedE = place("grid_feed", 2, 27);
        const trE = place("transformer", 5, 27);
        const pduF = place("pdu", 8, 27);
        wireBuildings(feedE, trE);
        wireBuildings(trE, pduF);
        for (let i = 0; i < 2; i++) wireBuildings(pduF, place("rack", 11, 27 + i));
        const gen5 = place("generator", 14, 27);       // deep
        const gen4 = place("generator", 14, 29);       // shallow
        wireBuildings(gen4, trE);
        wireBuildings(gen5, pduF);

        // A BRIDGE THE WAVE ONLY PARTLY TAKES. upsF loses its own feed and
        // bridges the whole 18 kW below it; the transfer switch then hands
        // the 12 kW under pduG2 to a generator and LEAVES the 6 kW under
        // pduH on the battery. The bridge is still up, so it still spends
        // seconds — but the energy it hands over is 6 kW, not 18, and only
        // this shape can tell those two numbers apart.
        const feedF = place("grid_feed", 17, 27);
        const upsF = place("ups", 20, 27);
        const trF = place("transformer", 23, 27);
        const pduG2 = place("pdu", 26, 27);
        const pduH = place("pdu", 29, 27);
        wireBuildings(feedF, upsF);
        wireBuildings(upsF, trF);
        wireBuildings(trF, pduG2);
        wireBuildings(trF, pduH);
        for (let i = 0; i < 2; i++) wireBuildings(pduG2, place("rack", 26, 28 + i));
        wireBuildings(pduH, place("rack", 29, 28));
        const gen6 = place("generator", 17, 29);
        wireBuildings(gen6, pduG2);

        return {
            upsA, upsB, upsC, upsD, upsE, upsF,
            gen, gen2, gen3, gen4, gen5, gen6,
            pduB, trC, armed: false,
        };
    }

    // The player's hand on the toggle and the city's hand on the meter. The
    // stretches are long enough to empty the battery and land in the
    // charge-a-tick/spend-a-tick regime, which is where an uncapped grant
    // pays out most, and the last stretch flips the button every two seconds.
    function script(t, room) {
        STATE.peakShave.on = t < 40
            || (t >= 55 && t < 75)
            || (t >= 95 && t < 160)
            || (t >= 160 && Math.floor(t / 2) % 2 === 0);
        STATE.brownout.active = t >= 55 && t < 75;
        STATE.brownout.factor = CONFIG.events.brownout.capacityFactor;
        // Three blackouts, and the two SCOPED ones are the point: a substation
        // outage takes down half the room, which is the only way to put the
        // B-side chain through a cutover while the A-side keeps shaving. The
        // wide one is the original.
        const wide = t >= 95 && t < 130;
        const bSide = (t >= 2 && t < 22) || (t >= 48 && t < 55);
        STATE.gridOutage.active = wide || bSide;
        STATE.gridOutage.scope = wide ? "all" : "B";
        // The maintenance window opens AFTER the toggle has emptied upsC, so
        // the ancestor UPS has a real debt to work down while the generator
        // below it carries the racks it used to feed.
        room.trC.outForService = t >= 45;
        // The player buys the transfer switch after the first blackout, which
        // is also what starts gen3's cutover clock from full at the second.
        if (!room.armed && t >= 40) {
            wireBuildings(room.gen3, room.upsD);
            room.armed = true;
        }
    }

    it("holds on EVERY tick of a run with chained UPSes, a cutover, an outage, a sag, a trip and the toggle flipping", () => {
        const room = facility();
        const { upsA, upsB, gen, pduB } = room;
        const seen = {
            shaving: 0, bridging: 0, charging: 0, chained: 0, onGenerator: 0,
            sagging: 0, flips: 0, creditedKws: 0, outKws: 0, minBilledKw: Infinity,
        };
        let broke = null;
        let was = false;

        for (let i = 0; i < Math.round(200 / DT); i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            script(t, room);
            if (STATE.peakShave.on !== was) seen.flips++;
            was = STATE.peakShave.on;
            tickEvents(DT, t);
            tickDemand(DT, t);
            const before = books();
            resolvePower(DT);

            const creditedKws = STATE.batteryKw * DT;
            const outKws = energyOutKws(before);
            // THE INVARIANT. Not "close to", not "on average over the run" —
            // the meter may never, on any single tick, be credited for a
            // kW.s more than the batteries actually gave up.
            if (creditedKws > outKws + 1e-9 && broke === null) {
                broke = {
                    atSec: Number(t.toFixed(2)),
                    creditedKws,
                    leftABatteryKws: outKws,
                    batteryKw: STATE.batteryKw,
                    totalDrawKw: STATE.totalDrawKw,
                    upsA: upsA.upsMode,
                    upsB: upsB.upsMode,
                };
            }

            seen.creditedKws += creditedKws;
            seen.outKws += outKws;
            seen.minBilledKw = Math.min(seen.minBilledKw, STATE.totalDrawKw - STATE.batteryKw);
            if (upsA.upsMode === "shaving") {
                seen.shaving++;
                if (upsB.actualKw > 0) seen.chained++;
                if (STATE.brownout.active) seen.sagging++;
            }
            if (upsA.upsMode === "bridging") seen.bridging++;
            if (upsA.upsMode === "charging") seen.charging++;
            if (STATE.gridOutage.active && upsA.powered && gen.actualKw > 0) seen.onGenerator++;
        }

        expect(broke).toBe(null);

        // ...and the run really did put the machine through all of it, so a
        // green result cannot mean "nothing happened". Each of these is the
        // condition one of the three bugs needed.
        expect(seen.shaving).toBeGreaterThan(200);      // the mechanic ran, at length
        expect(seen.chained).toBeGreaterThan(200);      // through a UPS behind a UPS
        expect(seen.bridging).toBeGreaterThan(0);       // the outage bridge, before cutover
        expect(seen.charging).toBeGreaterThan(200);     // and bought it all back
        expect(seen.onGenerator).toBeGreaterThan(0);    // the standby wave re-delivered it
        expect(seen.sagging).toBeGreaterThan(0);        // shaved through a sag
        expect(seen.flips).toBeGreaterThan(10);         // the button, worked
        expect(pduB.tripped).toBe(true);                // a breaker opened mid-run
        expect(seen.outKws).toBeGreaterThan(FULL_KWS);  // more than a battery-full cycled
        expect(seen.creditedKws).toBeGreaterThan(FULL_KWS);
        // The un-buffered half of the room is never zero, so an inflated
        // credit shows up as an under-bill instead of vanishing into
        // demand.js's Math.max(0, ...) clamp.
        expect(seen.minBilledKw).toBeGreaterThan(0);
    });

    // THE MIRROR. The assertion above watches only the money going OUT of the
    // meter, and that is exactly why two more of the same bug lived on this
    // branch after it was written: both were in the charger, the direction it
    // never looked. A charger that is billed and does not deliver is the same
    // lie as a credit that is paid and did not happen — the facility draw
    // goes up, the bill goes up, PUE goes up, and no battery is any fuller
    // for it. The two failures found were a running `+=` that let the standby
    // wave bill a re-delivered UPS's charger twice, and an ancestor-UPS fixup
    // that rolled a live-fed UPS's charge back every tick while it kept
    // paying for it. This is the reading the LEDGER should always have had.
    //
    // roundTripEff is the whole content of the claim: the charger's draw is
    // what it BUYS, `restored` is what LANDS, and the loss between them is
    // the reason leaving the toggle on costs money. Billed draw above
    // landed/roundTripEff is energy the player paid for that is nowhere.
    it("THE MIRROR: no charger is billed for a kW.s that never landed in a battery", () => {
        const room = facility();
        const { upsA, upsB, upsC, upsD, upsE, gen2, gen3, trC } = room;
        const seen = {
            charging: 0, billedKws: 0, landedKws: 0,
            reDeliveredCharger: 0, ancestorCharger: 0, nameplateRefills: 0,
        };
        let broke = null;

        for (let i = 0; i < Math.round(200 / DT); i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            script(t, room);
            tickEvents(DT, t);
            tickDemand(DT, t);
            const before = books();
            seen.nameplateRefills += nameplateRefillsPending();
            resolvePower(DT);

            const billedKws = billedChargerKw() * DT;
            const landedKws = energyInKws(before);
            // THE INVARIANT. Every tick, not on average: the meter may never
            // carry more charger draw than the energy that actually landed in
            // the batteries can account for, once the round-trip loss is
            // allowed for.
            const allowedKws = landedKws / U.roundTripEff;
            if (billedKws > allowedKws + 1e-9 && broke === null) {
                broke = {
                    atSec: Number(t.toFixed(2)),
                    billedKws,
                    landedKws,
                    allowedKws,
                    billedChargerKw: billedChargerKw(),
                    totalDrawKw: STATE.totalDrawKw,
                    upsA: upsA.upsMode, upsB: upsB.upsMode,
                    upsC: upsC.upsMode, upsD: upsD.upsMode, upsE: upsE.upsMode,
                };
            }
            seen.billedKws += billedKws;
            seen.landedKws += landedKws;
            if (billedChargerKw() > 1e-9) seen.charging++;
            // A UPS INSIDE a subtree the standby wave re-delivered, charging
            // while the UPS above it still holds buffer on a dark feed — so
            // phase 4 bridged upsD, upsE charged off that bridge, and the wave
            // then rolled upsD back and charged upsE a second time. The tick a
            // running total bills one charger twice.
            if (gen3.actualKw > 0 && upsD.bufferLeft > 0 && upsE.upsMode === "charging") {
                seen.reDeliveredCharger++;
            }
            // A UPS ABOVE the attach point, on live utility power, charging
            // while the generator carries what used to be its subtree — the
            // tick the fixup rolled the charge back and kept the bill.
            if (trC.outForService && gen2.actualKw > 0 && upsC.upsMode === "charging") {
                seen.ancestorCharger++;
            }
        }

        expect(broke).toBe(null);

        // ...and the run really did reach both shapes, so green cannot mean
        // the charger simply never ran.
        expect(seen.charging).toBeGreaterThan(400);            // chargers ran, at length
        expect(seen.landedKws).toBeGreaterThan(FULL_KWS);      // more than a battery-full landed
        expect(seen.billedKws).toBeGreaterThan(seen.landedKws); // and the round trip was paid
        expect(seen.reDeliveredCharger).toBeGreaterThan(0);
        expect(seen.ancestorCharger).toBeGreaterThan(0);
        // The two books never disagree, so `restored` is read exactly and the
        // invariant above carries no slack for a bug to hide in.
        expect(seen.nameplateRefills).toBe(0);
    });

    // ---- THE OTHER THREE BOOKS ------------------------------------------
    // The two invariants above watch the battery credit. Three more pairs of
    // numbers describe one physical quantity each, and each pair has been
    // caught disagreeing: the fuel a generator burns against the kW it
    // carries, the energy a bridge books against the energy it handed over,
    // and the kW the meter charges against the kW a utility delivered. They
    // are asserted here, on the same all-hazards run, because a room with
    // one hazard in it is how the first six of these shipped.

    // What every LIVE ROOT put out this tick. A grid feed's actualKw is its
    // carry; a dark one carries nothing and neither does an empty generator.
    function rootOutput() {
        let feeds = 0;
        let gens = 0;
        for (const b of STATE.buildings) {
            if (b.config.chainRole !== "source") continue;
            if (b.type === "generator") gens += Math.max(0, b.actualKw);
            else if (!feedIsDark(b)) feeds += Math.max(0, b.actualKw);
        }
        return { feeds, gens };
    }

    const byId = (id) => STATE.buildings.find((b) => b.id === id) || null;

    function subtreeOf(node) {
        const out = [];
        const stack = [...node.childIds];
        while (stack.length) {
            const k = byId(stack.pop());
            if (!k) continue;
            out.push(k);
            stack.push(...k.childIds);
        }
        return out;
    }

    // A charging UPS's draw, recovered from the ENERGY that landed in it
    // rather than from any carried-kW field: restored = draw * eff * dt is
    // the module's own definition, so inverting it gives the charger back
    // without asking a link what it thinks it is carrying.
    function chargerKwOf(u, before) {
        const was = before.get(u.id);
        const byCharge = (u.bufferLeft - was.sec) * (u.config.capacityKw || 0);
        const byDebt = was.owed - u.bufferOwedKws;
        const landed = Math.max(0, Math.min(byCharge, byDebt));
        return landed / ((u.config.roundTripEff || 1) * DT);
    }

    // What a bridging UPS is REALLY handing down, per UPS rather than pooled
    // over the facility: the load its subtree actually drew, plus any charger
    // running inside it, MINUS whatever a closed transfer switch inside that
    // subtree is carrying instead. Pooling this across the whole room leaves
    // standing slack — the peak-shaved kW of some unrelated room is sourced
    // from a battery and still carried by the feed above it, and a pooled
    // ceiling has to allow for that, which is exactly the room an inflated
    // bridge needs to hide in. Per UPS, nothing has to be allowed for.
    function handedDownByBridge(ups, before) {
        const under = subtreeOf(ups);
        const inside = new Set(under.map((n) => n.id));
        let sum = 0;
        for (const n of under) {
            if (n.config.chainRole === "load") sum += Math.max(0, n.actualKw);
            else if (n.type === "ups") sum += chargerKwOf(n, before);
        }
        // A transfer switch that has actually closed is carrying its node,
        // not the battery upstream of it. cutoverLeft === 0 is the switch
        // being shut; before that the bridge is still feeding the node and
        // the load below it must stay in the ceiling.
        for (const n of STATE.buildings) {
            if (!n.standbyParentId || !inside.has(n.id)) continue;
            const g = byId(n.standbyParentId);
            if (!g || g.actualKw <= 0 || g.cutoverLeft > 0) continue;
            sum -= Math.max(0, n.actualKw);
        }
        return sum;
    }

    it("holds on EVERY tick: fuel burned, energy bridged, and kW billed each match what physically happened", () => {
        const room = facility();
        const seen = {
            burning: 0, twoBurning: 0, bridging: 0, transferredBridge: 0,
            metered: 0, darkTicks: 0, shaved: 0, nestedPair: 0,
            fuelBurnedL: 0, genKwTicks: 0, billedKw: 0, feedKw: 0,
        };
        let brokeFuel = null;
        let brokeBridge = null;
        let brokeMeter = null;
        const owedBefore = new Map();

        for (let i = 0; i < Math.round(200 / DT); i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            script(t, room);
            tickEvents(DT, t);
            tickDemand(DT, t);

            const before = books();
            const tank = new Map();
            for (const b of STATE.buildings) {
                if (b.type === "generator") tank.set(b.id, b.fuelLiters);
            }
            resolvePower(DT);

            // -- 1. FUEL BURNED vs kW CARRIED ---------------------------
            // Per machine the burn follows its own carry exactly, and
            // between them no two machines may carry the same load: the
            // facility cannot draw less than its generators are burning
            // diesel for. Two transfer switches in series used to bill two
            // tanks for one set of racks, and which of them depended only on
            // the order the buildings sat in STATE.buildings.
            let genKw = 0;
            let burning = 0;
            for (const b of STATE.buildings) {
                if (b.type !== "generator") continue;
                genKw += Math.max(0, b.actualKw);
                const burned = tank.get(b.id) - b.fuelLiters;
                if (burned > 1e-12) burning++;
                seen.fuelBurnedL += burned;
                const expected = b.actualKw > 0
                    ? Math.min(tank.get(b.id), b.actualKw * (DT / 60) * b.config.litersPerKwh)
                    : 0;
                if (Math.abs(burned - expected) > 1e-9 && brokeFuel === null) {
                    brokeFuel = { atSec: +t.toFixed(2), why: "burn does not match carry", burned, expected, actualKw: b.actualKw };
                }
            }
            if (genKw > STATE.totalDrawKw + 1e-9 && brokeFuel === null) {
                brokeFuel = {
                    atSec: +t.toFixed(2), why: "generators carry more than the facility drew",
                    genKw, totalDrawKw: STATE.totalDrawKw,
                };
            }
            seen.genKwTicks += genKw;
            if (burning > 0) seen.burning++;
            if (burning > 1) seen.twoBurning++;
            // The two-switches-in-series branch really transferred: the
            // SHALLOW machine is the one that must end up carrying, whichever
            // order the two were placed in.
            if (room.gen4.actualKw > 0) seen.nestedPair++;

            // -- 2. bufferOwedKws vs ENERGY THAT ACTUALLY LEFT ----------
            // A bridge may only book the load no live root is carrying. A
            // generator picking up part of a bridged subtree means the
            // battery never handed that part over — and the charger buys
            // this exact figure back on the meter, so an inflated book is
            // an inflated bill.
            let bridging = 0;
            for (const b of STATE.buildings) {
                if (b.type !== "ups" || b.upsMode !== "bridging") continue;
                bridging++;
                const booked = b.bufferOwedKws - before.get(b.id).owed;
                const ceilingKws = Math.max(0, handedDownByBridge(b, before)) * DT;
                if (booked > ceilingKws + 1e-9 && brokeBridge === null) {
                    brokeBridge = {
                        atSec: +t.toFixed(2), ups: b.id, booked, ceilingKws,
                        upsActualKw: b.actualKw, totalDrawKw: STATE.totalDrawKw,
                    };
                }
            }
            if (bridging > 0) seen.bridging++;
            // THE shape this invariant exists for, named exactly rather than
            // as "some generator somewhere was running": upsF is bridging
            // and the transfer switch below it has taken part — not all — of
            // what it was carrying.
            if (room.upsF.upsMode === "bridging" && room.gen6.actualKw > 0) {
                seen.transferredBridge++;
            }

            // -- 3. kW BILLED vs kW THAT CAME FROM A GRID FEED ----------
            // The meter may never charge for more than the live feeds put
            // out, and during a total blackout it may not charge at all —
            // the generator already paid in fuel and the battery pays in the
            // recharge, so billing them too is charging twice for energy no
            // utility delivered.
            const { feeds, gens } = rootOutput();
            const anyFeedLive = STATE.buildings.some(
                (b) => b.type === "grid_feed" && !feedIsDark(b)
            );
            if (STATE.gridKw > feeds + 1e-9 && brokeMeter === null) {
                brokeMeter = { atSec: +t.toFixed(2), why: "billed more than the feeds delivered", gridKw: STATE.gridKw, feeds };
            }
            if (!anyFeedLive && STATE.gridKw > 1e-9 && brokeMeter === null) {
                brokeMeter = { atSec: +t.toFixed(2), why: "billed during a total blackout", gridKw: STATE.gridKw, totalDrawKw: STATE.totalDrawKw };
            }
            if (STATE.gridKw > STATE.totalDrawKw + 1e-9 && brokeMeter === null) {
                brokeMeter = { atSec: +t.toFixed(2), why: "billed more than the facility drew", gridKw: STATE.gridKw, totalDrawKw: STATE.totalDrawKw };
            }
            // ...AND THE FLOOR, which is the dangerous side. The three
            // clauses above all read `gridKw > x`: they catch a meter that
            // charges too much, which is unfair, and say nothing about one
            // that charges too little — which is FREE ENERGY, and worse.
            //
            // Every kW the facility drew came off a feed, out of a generator,
            // or out of a battery, and the battery leaves through exactly two
            // doors: peak shaving (STATE.batteryKw) and the outage bridge,
            // which batteryKw deliberately does not count. bufferOwedKws is
            // the bridge's own meter of what left, so the residual is closed
            // with that measurement rather than a second guess at it. Only
            // the RISING side per buffer: owed falls when the charger buys
            // the energy back, and that recharge is already in totalDrawKw as
            // charger draw and already billed.
            //
            // This clause could not be written until the bridge stopped
            // handing out a final tick it did not have — it fired on the
            // exhaustion tick, which is exactly what it is for.
            let bridgeKw = 0;
            for (const b of STATE.buildings) {
                if (!("bufferOwedKws" in b)) continue;
                const prev = owedBefore.get(b.id) || 0;
                const now = b.bufferOwedKws || 0;
                if (now > prev) bridgeKw += (now - prev) / DT;
                owedBefore.set(b.id, now);
            }
            const offMeter = STATE.totalDrawKw - STATE.batteryKw - gens - bridgeKw;
            if (STATE.gridKw < offMeter - 1e-6 && brokeMeter === null) {
                brokeMeter = {
                    atSec: +t.toFixed(2), why: "drew kW that nothing paid for",
                    gridKw: STATE.gridKw, owed: offMeter, bridgeKw,
                    totalDrawKw: STATE.totalDrawKw, batteryKw: STATE.batteryKw, gens,
                };
            }
            seen.billedKw += STATE.gridKw;
            seen.feedKw += feeds;
            if (STATE.gridKw > 1e-9) seen.metered++;
            if (!anyFeedLive) seen.darkTicks++;
            if (STATE.batteryKw > 1e-9) seen.shaved++;
        }

        expect(brokeFuel).toBe(null);
        expect(brokeBridge).toBe(null);
        expect(brokeMeter).toBe(null);

        // ...and the run really did reach every shape each invariant is
        // about, so green cannot mean the hazard never happened.
        expect(seen.burning).toBeGreaterThan(200);        // generators carried, at length
        expect(seen.twoBurning).toBeGreaterThan(0);       // and two of them at once
        expect(seen.nestedPair).toBeGreaterThan(100);     // incl. two switches in series
        expect(seen.fuelBurnedL).toBeGreaterThan(1);      // real diesel
        expect(seen.bridging).toBeGreaterThan(0);         // buffers bridged
        expect(seen.transferredBridge).toBeGreaterThan(0);// with a transfer alongside
        expect(seen.darkTicks).toBeGreaterThan(100);      // a total blackout happened
        expect(seen.metered).toBeGreaterThan(1000);       // and the meter ran the rest
        expect(seen.shaved).toBeGreaterThan(200);         // through shaving too
        // The meter charged strictly less than the facility drew, and
        // strictly more than nothing — an invariant satisfied by billing
        // zero would prove nothing at all.
        expect(seen.billedKw).toBeGreaterThan(0);
        expect(seen.billedKw).toBeLessThan(seen.feedKw + 1e-9);
        expect(seen.genKwTicks).toBeGreaterThan(0);
    });

    // The invariant above proves STATE.gridKw is the honest quantity. This
    // one proves it is the quantity the METER actually charges, which is a
    // separate claim living in a separate module — and it reads the charge
    // out of the player's money rather than restating demand.js's formula,
    // because a test that restates the formula it is checking proves only
    // that two copies of it agree.
    //
    // The trick: STATE.tariff multiplies the power line and NOTHING else
    // (not water, not SLA, not revenue — that separation is the two_utilities
    // lesson). Play the identical run twice, once with the multiplier at
    // zero, and the difference in money IS the power bill, tick by tick.
    it("THE METER: the money charged for power is the kW that came off a feed, and nothing else", () => {
        const PRICE = CONFIG.economy.powerCostPerKwh;

        function pass(zeroTariff) {
            resetState();
            resetBuildingIds();
            pinSchedules();
            const room = facility();
            if (zeroTariff) {
                STATE.tariff.active = true;
                STATE.tariff.multiplier = 0;
                STATE.tariff.endsAt = Infinity;
            }
            const deltas = [];
            const gridKws = [];
            for (let i = 0; i < Math.round(200 / DT); i++) {
                STATE.elapsedGameTime += DT;
                const t = STATE.elapsedGameTime;
                script(t, room);
                tickEvents(DT, t);
                const before = STATE.money;
                tickDemand(DT, t);
                deltas.push(STATE.money - before);
                resolvePower(DT);
                gridKws.push(STATE.gridKw);
            }
            return { deltas, gridKws, gameOver: STATE.gameOver };
        }

        const paid = pass(false);
        const free = pass(true);
        // Both passes must have played the SAME run, or the subtraction is
        // comparing two different facilities.
        expect(paid.gameOver).toBe(null);
        expect(free.gameOver).toBe(null);
        expect(paid.gridKws).toEqual(free.gridKws);

        let broke = null;
        let chargedKws = 0;
        let meteredTicks = 0;
        let freeTicks = 0;
        for (let i = 0; i < paid.deltas.length; i++) {
            // What the utility took off the player this tick, in kW.
            const chargedKw = (free.deltas[i] - paid.deltas[i]) / (PRICE * (DT / 60));
            // tickDemand bills on the PREVIOUS tick's resolution — the
            // one-tick lag documented in docs/ARCHITECTURE.md — so this
            // tick's charge answers to the gridKw resolved last tick.
            const owedKw = i === 0 ? 0 : paid.gridKws[i - 1];
            if (Math.abs(chargedKw - owedKw) > 1e-6 && broke === null) {
                broke = {
                    atSec: +((i + 1) * DT).toFixed(2),
                    chargedKw, kwFromAGridFeed: owedKw,
                };
            }
            chargedKws += chargedKw * DT;
            if (chargedKw > 1e-9) meteredTicks++;
            if (chargedKw <= 1e-9 && owedKw <= 1e-9) freeTicks++;
        }

        expect(broke).toBe(null);
        // The run really did both: pay a utility, and run stretches on
        // diesel and stored charge paying it nothing.
        expect(meteredTicks).toBeGreaterThan(1000);
        expect(freeTicks).toBeGreaterThan(100);
        expect(chargedKws).toBeGreaterThan(0);
    });
});

describe("a bridge cannot hand out energy it does not have", () => {
    // bufferLeft counts SECONDS at the UPS's full rating — that is the
    // ride-through model every campaign level is proven against and it is
    // deliberately untouched here. What was wrong is the kW handed DOWN on
    // the tick that empties the buffer: the branch is entered on
    // `bufferLeft > 0`, however little is left, and then grants the whole
    // subtree pull for the whole tick. A buffer with 4 ms left powered a
    // 50 ms tick, and the difference is energy no source produced.
    it("THE LAST TICK: what it carries matches what left the battery, every tick", () => {
        const { ups, pdu } = chain();
        const racks = [];
        for (let i = 0; i < 1; i++) {
            const r = place("rack", 14 + i, 5);
            wireBuildings(pdu, r);
            r.assignedKw = CONFIG.buildings.rack.capacityKw;
            racks.push(r);
        }
        STATE.demandFixedKw = racks.length * CONFIG.buildings.rack.capacityKw;
        for (let k = 0; k < 40; k++) resolvePower(DT);          // charge up
        expect(ups.bufferLeft).toBeGreaterThan(0);

        STATE.gridOutage = { active: true, endsAt: 1e9, nextAt: Infinity, scope: "all" };

        let worst = null;
        let bridgingTicks = 0;
        let prevOwed = ups.bufferOwedKws || 0;
        for (let k = 0; k < 4000; k++) {
            resolvePower(DT);
            const owed = ups.bufferOwedKws || 0;
            const bookedKw = (owed - prevOwed) / DT;
            prevOwed = owed;
            if (ups.upsMode !== "bridging" || ups.actualKw <= 1e-9) continue;
            bridgingTicks++;
            const gap = ups.actualKw - bookedKw;
            if (worst === null || gap > worst.gap) {
                worst = {
                    tick: k, gap: +gap.toFixed(6),
                    carriedKw: ups.actualKw, bookedKw: +bookedKw.toFixed(6),
                    bufferLeft: ups.bufferLeft,
                };
            }
        }
        // The run really did bridge, and to exhaustion, or this proves nothing.
        expect(bridgingTicks).toBeGreaterThan(100);
        expect(ups.bufferLeft).toBeCloseTo(0, 9);
        // Every tick, including the one that empties it.
        expect(worst.gap, `carried more than left the battery: ${JSON.stringify(worst)}`)
            .toBeLessThan(1e-9);
    });

    it("...and the seconds are still spent at full rating — the ride-through is unchanged", () => {
        // The fix must not buy honesty by shortening the bridge: how long a
        // UPS holds a room is the number the campaign levels are balanced on.
        const { ups, pdu } = chain();
        const r = place("rack", 14, 5);
        wireBuildings(pdu, r);
        r.assignedKw = CONFIG.buildings.rack.capacityKw;
        STATE.demandFixedKw = CONFIG.buildings.rack.capacityKw;
        for (let k = 0; k < 40; k++) resolvePower(DT);
        const full = ups.bufferLeft;
        expect(full).toBeCloseTo(U.bufferSec, 6);

        STATE.gridOutage = { active: true, endsAt: 1e9, nextAt: Infinity, scope: "all" };
        let held = 0;
        for (let k = 0; k < 4000 && ups.bufferLeft > 0; k++) {
            resolvePower(DT);
            if (ups.upsMode === "bridging") held += DT;
        }
        // Seconds spent at the rating, not at the load: the whole buffer.
        expect(held).toBeCloseTo(U.bufferSec, 1);
    });
});
