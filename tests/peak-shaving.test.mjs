// Peak shaving (STATE.peakShave) — a player toggle that lets a charged UPS
// serve its subtree from the buffer instead of the grid, so a room can
// choose WHEN it buys energy, not just how much. The trade-off that makes it
// a decision rather than free money: recharging draws real power
// (CONFIG.buildings.ups.rechargeKw) at a real round-trip loss
// (roundTripEff < 1), billed exactly like any other load.
//
// See src/sim/power.js (the mechanic + STATE.batteryKw), src/sim/demand.js
// (the meter subtracts batteryKw), src/core/config.js (rechargeKw,
// roundTripEff) for the full reasoning.
import { beforeEach, describe, expect, it } from "vitest";

import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower, unwire, wireBuildings } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";

const DT = 0.05;

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

// grid_feed (40kW, a "source" wires legally straight to a "link") -> ups ->
// 3 PDUs (48kW of fanout, so the PDUs never bottleneck below the UPS's own
// rating) -> 6 racks x 6kW = 36kW = ups.capacityKw. Used only where the test
// needs the UPS actually carrying its full nameplate rating, matching the
// task's own worked economics (36kW x 8s = 4.8 kWh-equivalent). No
// transformer in the middle: at 30kW it would itself bottleneck (and, under
// sustained 120% overload, eventually trip) below the UPS's 36kW.
function fullCapacityRoom(demandKw = CONFIG.buildings.ups.capacityKw) {
    STATE.demandFixedKw = demandKw;
    const feed = place("grid_feed", 2, 5);
    const ups = place("ups", 8, 5);
    wireBuildings(feed, ups);
    const racks = [];
    for (let i = 0; i < 3; i++) {
        const pdu = place("pdu", 11, 5 + i * 3);
        wireBuildings(ups, pdu);
        for (let j = 0; j < 2; j++) {
            const rack = place("rack", 14, 5 + i * 3 + j);
            wireBuildings(pdu, rack);
            racks.push(rack);
        }
    }
    return { feed, ups, racks };
}

function runFull(seconds) {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickDemand(DT, t);
        resolvePower(DT);
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
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec); // never drained
        expect(ups.upsMode).toBe("idle");
        expect(STATE.batteryKw).toBe(0);
        expect(STATE.totalDrawKw).toBeCloseTo(4, 9); // no phantom recharge draw either
    });

    it("turning peakShave OFF mid-discharge stops the drain on the very next tick", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        STATE.peakShave.on = true;
        resolvePower(1);
        const bufferAfterOneSec = ups.bufferLeft;
        expect(bufferAfterOneSec).toBeLessThan(CONFIG.buildings.ups.bufferSec);
        STATE.peakShave.on = false;
        resolvePower(1);
        // No longer shaving: buffer only RECHARGES from here (it can only
        // move up, never down again), and batteryKw goes back to 0.
        expect(ups.bufferLeft).toBeGreaterThanOrEqual(bufferAfterOneSec);
        expect(STATE.batteryKw).toBe(0);
    });
});

describe("ON: a charged UPS with a live upstream shaves the meter", () => {
    it("serves the subtree from the buffer, draining it, instead of the grid", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        STATE.peakShave.on = true;
        resolvePower(1);
        expect(ups.upsMode).toBe("shaving");
        expect(ups.bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec - 1, 9);
        // The subtree is served in FULL despite the grid never being asked —
        // shaving must not degrade delivery to the racks.
        expect(rack.actualKw).toBeCloseTo(4, 9);
        expect(rack.powered).toBe(true);
        expect(STATE.batteryKw).toBeCloseTo(4, 9);
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
        // straight through to the ordinary "outLive" charging branch — the
        // SAME branch peakShave OFF would have taken. It does NOT stay
        // pinned at 0 (that would mean shaving somehow suppressed the
        // existing free-standing recharge behaviour); it starts climbing at
        // the normal dt/4 rate.
        expect(ups.bufferLeft).toBeGreaterThan(0);
        expect(ups.bufferLeft).toBeCloseTo(0.25, 9); // +dt/4 over 1 second
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
            const { ups, pdu } = chain();
            const rack = place("rack");
            rack.assignedKw = 4;
            wireBuildings(pdu, rack);
            unwire(ups); // upstream dead — the outage bridge, not shaving
            STATE.peakShave.on = on;
            resolvePower(1);
            expect(ups.upsMode).toBe("bridging");
            expect(ups.bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec - 1, 9);
            expect(rack.actualKw).toBeCloseTo(4, 9);
            expect(rack.powered).toBe(true);
            expect(STATE.batteryKw).toBe(0); // bridging is not billed as shaving
        }
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

describe("recharging is not free: it draws power and the round trip loses energy", () => {
    it("CONFIG's numbers reproduce the pre-existing dt/4 recharge rate exactly", () => {
        const u = CONFIG.buildings.ups;
        expect((u.rechargeKw * u.roundTripEff) / u.capacityKw).toBeCloseTo(0.25, 9);
    });

    it("a recharging UPS adds its draw into totalDrawKw — billed like any load", () => {
        const { t, ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        resolvePower(3); // drain some buffer via the (untouched) outage bridge
        expect(ups.bufferLeft).toBeLessThan(CONFIG.buildings.ups.bufferSec);
        wireBuildings(t, ups); // path restored — now it recharges
        resolvePower(1);
        expect(ups.upsMode).toBe("charging");
        // totalDrawKw is MORE than the rack alone: the recharge draw is in it.
        expect(STATE.totalDrawKw).toBeGreaterThan(4);
        expect(STATE.totalDrawKw).toBeCloseTo(4 + CONFIG.buildings.ups.rechargeKw, 6);
    });

    it("the buffer still refills at exactly dt/4, capped at bufferSec — the pinned behaviour is unchanged", () => {
        const { t, ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        for (let i = 0; i < 3; i++) resolvePower(1);
        expect(ups.bufferLeft).toBeCloseTo(5, 9);
        wireBuildings(t, ups);
        resolvePower(2);
        expect(ups.bufferLeft).toBeCloseTo(5.5, 9); // +dt/4
        resolvePower(100);
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec); // capped
    });

    it("THE LESSON: a full discharge-then-recharge round trip costs money even at a FLAT price — the loss is real, not a wash", () => {
        // At a CONSTANT tariff, buying back what you spent should net to
        // exactly zero if the round trip were lossless. It doesn't: the
        // roundTripEff loss means recharging always costs strictly more
        // energy than was delivered out of the buffer.
        const u = CONFIG.buildings.ups;
        const rechargeSec = u.bufferSec / ((u.rechargeKw * u.roundTripEff) / u.capacityKw);
        const totalSec = u.bufferSec + rechargeSec + 1; // +1s margin to finish topping off

        function runRoundTrip(shave) {
            resetState();
            resetBuildingIds();
            fullCapacityRoom();
            STATE.tariff.active = true;
            STATE.tariff.multiplier = 1; // flat, no day/night, no peak
            STATE.tariff.endsAt = Infinity;
            const before = STATE.money;
            STATE.peakShave.on = shave;
            runFull(u.bufferSec); // one full discharge (a no-op when shave=false)
            STATE.peakShave.on = false;
            runFull(totalSec - u.bufferSec); // recharge (a no-op when it never drained)
            return STATE.money - before;
        }

        const shavedDelta = runRoundTrip(true);
        const controlDelta = runRoundTrip(false); // never touches its buffer

        // Both rooms serve the SAME demand throughout (revenue/SLA cancel);
        // the only difference is the round trip. It must cost, not pay.
        expect(shavedDelta).toBeLessThan(controlDelta);
    });
});

describe("measured in-game: one full discharge at day x peak, recharged at night", () => {
    it("shifts capacityKw*bufferSec/60 kWh and nets solidly positive money — a real trade, not free money", () => {
        const dayPeak = CONFIG.tariff.bands[1].mult * CONFIG.events.tariff.multiplier; // 1.4 x 2.5
        const night = CONFIG.tariff.bands[0].mult; // 0.6
        const u = CONFIG.buildings.ups;
        const rechargeSec = u.bufferSec / ((u.rechargeKw * u.roundTripEff) / u.capacityKw);

        function scenario(shave) {
            resetState();
            resetBuildingIds();
            const { ups } = fullCapacityRoom();
            STATE.tariff.active = true;
            STATE.tariff.multiplier = dayPeak;
            STATE.tariff.endsAt = Infinity;
            STATE.peakShave.on = shave;
            const m0 = STATE.money;
            runFull(u.bufferSec);
            const afterDischarge = STATE.money;
            const bufferAfterDischarge = ups.bufferLeft; // captured BEFORE recharging
            STATE.peakShave.on = false;
            STATE.tariff.multiplier = night;
            runFull(rechargeSec);
            const afterRecharge = STATE.money;
            return {
                dischargeDelta: afterDischarge - m0,
                rechargeDelta: afterRecharge - afterDischarge,
                bufferAfterDischarge,
            };
        }

        const shaved = scenario(true);
        const control = scenario(false);

        const kwhShifted = (u.capacityKw * u.bufferSec) / 60;
        expect(kwhShifted).toBeCloseTo(4.8, 9);
        expect(shaved.bufferAfterDischarge).toBeCloseTo(0, 2);

        const avoided = shaved.dischargeDelta - control.dischargeDelta;
        const rechargeCost = control.rechargeDelta - shaved.rechargeDelta;
        const net = avoided - rechargeCost;

        // Matches the task's own worked economics: avoiding ~$15.12 at day x
        // peak, paying ~$2.6-3.3 back at night, netting ~+$11.9 to +$12.5.
        expect(avoided).toBeGreaterThan(14);
        expect(avoided).toBeLessThan(16);
        expect(rechargeCost).toBeGreaterThan(2);
        expect(rechargeCost).toBeLessThan(4);
        expect(net).toBeGreaterThan(10);
        expect(net).toBeLessThan(14);
    });
});
