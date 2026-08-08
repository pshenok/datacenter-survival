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
import { resolvePower, unwire, wireBuildings } from "../src/sim/power.js";
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
    it("THE FORMULA: money is charged on (totalDrawKw - batteryKw), not totalDrawKw", () => {
        // Isolate the billing arithmetic from power.js entirely: pin
        // totalDrawKw/batteryKw by hand and zero out demand so revenue and
        // SLA terms drop out, leaving only the power-cost term to compare.
        STATE.demandFixedKw = 0;
        STATE.totalDrawKw = 20;
        STATE.batteryKw = 12;
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 2;
        STATE.tariff.endsAt = Infinity;
        const before = STATE.money;
        tickDemand(DT, 1);
        const billedKw = STATE.totalDrawKw - STATE.batteryKw; // 8, unless demand.js mutated them
        const expected = -(billedKw * CONFIG.economy.powerCostPerKwh * STATE.tariff.multiplier * (DT / 60));
        expect(STATE.money - before).toBeCloseTo(expected, 9);
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
