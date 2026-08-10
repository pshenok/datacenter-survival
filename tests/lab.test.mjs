// THE LAB — the rehearsal room, machine-played. Four things are proven here
// and none of them is "the room is fun":
//
//   1. a `sandbox` level NEVER resolves — not won, not failed, not on the
//      clock, not on a money or reputation floor, not on a game over;
//   2. `alwaysUnlocked` opens the Lab on a fresh profile and unlocks NOTHING
//      else — a level that can never be completed must never gate one;
//   3. every knob and every Fire button does what it says, through the same
//      STATE fields (and, where it exists, the same CODE) the real events
//      use — a rehearsed outage has to BE the outage;
//   4. INERTNESS: outside a sandbox level the whole feature is invisible.
//      The last one is the one that protects thirteen machine-proven levels,
//      so it is not an assertion in a comment — it is two identical runs,
//      one of them with every Lab entry point hammered on every tick,
//      compared with toBe.
//
// The run loop mirrors game.js's tick order exactly, and deliberately does
// NOT stop when the level resolves: a test that returns early on `done`
// cannot tell "never resolved" from "resolved on the tick after I stopped
// looking".
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents, upcomingBand } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickContracts } from "../src/sim/contracts.js";
import { tickMaintenance } from "../src/sim/maintenance.js";
import { tickCampaign, startLevelState, levelCfg, levelOrder, isLevelUnlocked } from "../src/campaign/campaign.js";
import { applyPreBuilt } from "../src/campaign/prebuilt.js";
import { placeBuilding, connect, resetWireIds } from "../src/sim/build.js";
import {
    isLab,
    setLabDemandKw,
    setLabAmbientC,
    setLabTariffBand,
    labTariffMode,
    fireLabEvent,
    resetLab,
    LAB_LIMITS,
    LAB_EVENTS,
} from "../src/campaign/lab.js";

const DT = 0.05;
const LAB = "the_lab";
const rngZero = () => 0;

function run(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickCrisis(DT, t, rngZero);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
        tickContracts(DT, t, rngZero);
        tickMaintenance(DT, t);
        tickCampaign(DT, t);
    }
}

function startLevel(id, { prebuilt = true } = {}) {
    resetState();
    resetBuildingIds();
    resetWireIds();
    expect(startLevelState(id)).toBe(true);
    return prebuilt ? applyPreBuilt(id) : [];
}

const startLab = (opts) => startLevel(LAB, opts);
const of = (type) => STATE.buildings.filter((b) => b.type === type);
const one = (type) => of(type)[0];

beforeEach(() => {
    resetState();
    resetBuildingIds();
    resetWireIds();
});

// ---------------------------------------------------------------------------
describe("the sandbox flag — a level that does not resolve", () => {
    it("THE LAB NEVER RESOLVES — three times past its own time limit, still running", () => {
        startLab();
        const limit = levelCfg(LAB).timeLimitSec;
        // The deadline is REAL and it is passed: this is what makes the test
        // about the flag rather than about an Infinity somewhere.
        expect(Number.isFinite(STATE.campaign.endsAt)).toBe(true);
        expect(STATE.campaign.endsAt).toBe(limit);

        run(limit * 3);
        expect(STATE.elapsedGameTime).toBeGreaterThan(STATE.campaign.endsAt * 2);
        expect(STATE.campaign.done).toBeNull();
        expect(STATE.campaign.reason).toBeNull();
    });

    it("has no objectives to sweep — and the FLAG, not the empty list, is what stops the win", () => {
        // An empty objective list resolves as WON on tick one: tickCampaign's
        // sweep starts allDone = true and only an unfinished objective clears
        // it. So the level declares both, and the assertion above (nothing
        // resolved after 360 s) is the proof the flag is doing the work.
        expect(levelCfg(LAB).objectives).toEqual([]);
        expect(levelCfg(LAB).sandbox).toBe(true);
    });

    it("is not on a money floor — the level's own failCondition can be blown straight through", () => {
        startLab();
        const floor = (levelCfg(LAB).failConditions || CONFIG.campaign.failConditions).moneyBelow;
        STATE.money = floor - 100;
        run(2);
        expect(STATE.money).toBeLessThan(floor);
        expect(STATE.campaign.done).toBeNull();
    });

    it("A DARK ROOM CANNOT END IT — a hundred seconds serving nothing, and the Lab is still open", () => {
        startLab({ prebuilt: false });   // an empty floor: demand asked, nothing delivered
        run(100);
        expect(STATE.servedKw).toBe(0);
        // Well under the survival reputation floor (gameOverAt + 0.5)…
        expect(STATE.reputation).toBeLessThan(0.5);
        // …and under the campaign floor too.
        expect(STATE.reputation).toBeLessThan(CONFIG.campaign.failConditions.repBelow);
        expect(STATE.gameOver).toBeNull();
        expect(STATE.campaign.done).toBeNull();
    });

    it("CONTROL: the same hundred seconds ends survival — the floor is SCOPED to the Lab, not deleted", () => {
        run(100);                        // survival, empty floor, nothing served
        expect(STATE.gameOver).toBe("reputation");
    });

    it("CONTROL: an ordinary level still resolves failed on its own floor", () => {
        startLevel("dark_chain", { prebuilt: false });
        run(100);
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.campaign.reason).toBe("fail_rep");
    });

    it("CONTROL: an ordinary level still resolves failed on the clock", () => {
        // first_watt with the chain built but never wired to a rack: nothing
        // to serve, so the objective cannot complete and the timer decides.
        startLevel("first_watt", { prebuilt: false });
        STATE.reputation = 100;
        const cfg = levelCfg("first_watt");
        for (let i = 0; i < (cfg.timeLimitSec + 5) / DT; i++) {
            STATE.elapsedGameTime += DT;
            STATE.reputation = 100;      // hold the rep floor off the verdict
            tickCampaign(DT, STATE.elapsedGameTime);
        }
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.campaign.reason).toBe("fail_time");
    });
});

// ---------------------------------------------------------------------------
describe("alwaysUnlocked — reachable before the campaign, and a rung on nothing", () => {
    it("THE LAB OPENS ON A FRESH PROFILE — an empty completion list, and it is already there", () => {
        expect(isLevelUnlocked(LAB, [])).toBe(true);
    });

    it("and it unlocks NOTHING: the flag is not a completion", () => {
        const order = levelOrder();
        for (const id of order) {
            if (id === LAB || id === order[0]) continue;
            expect(isLevelUnlocked(id, [LAB]), `${id} should still be locked`).toBe(false);
        }
    });

    it("is never another level's predecessor — a level that cannot be COMPLETED must not gate one", () => {
        const order = levelOrder();
        for (let i = 1; i < order.length; i++) {
            const prev = levelCfg(order[i - 1]);
            expect(
                prev.alwaysUnlocked === true,
                `${order[i]} is gated by ${order[i - 1]}, which can never be completed`
            ).toBe(false);
        }
    });

    it("leaves the ordinary chain exactly as it was: each level still needs its own predecessor", () => {
        const order = levelOrder();
        expect(order[0]).toBe("first_watt");
        expect(isLevelUnlocked(order[0], [])).toBe(true);
        for (let i = 1; i < order.length; i++) {
            const id = order[i];
            if (levelCfg(id).alwaysUnlocked) continue;
            expect(isLevelUnlocked(id, []), `${id} with nothing done`).toBe(false);
            expect(isLevelUnlocked(id, [order[i - 1]]), `${id} after ${order[i - 1]}`).toBe(true);
        }
    });

    it("an id that is in no chapter is still locked", () => {
        expect(isLevelUnlocked("not_a_level", [])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe("the demand knob", () => {
    it("writes the SAME field a campaign level pins, and the room serves the new number", () => {
        startLab();
        run(10);
        expect(STATE.demandKw).toBe(levelCfg(LAB).demandKw);

        expect(setLabDemandKw(6)).toBe(true);
        expect(STATE.demandFixedKw).toBe(6);
        run(5);
        expect(STATE.demandKw).toBe(6);
        expect(STATE.servedKw).toBeCloseTo(6, 9);
    });

    it("clamps to its own travel and refuses a number that is not one", () => {
        startLab();
        setLabDemandKw(10_000);
        expect(STATE.demandFixedKw).toBe(LAB_LIMITS.demandKw.max);
        setLabDemandKw(-40);
        expect(STATE.demandFixedKw).toBe(LAB_LIMITS.demandKw.min);
        expect(setLabDemandKw(NaN)).toBe(false);
        expect(setLabDemandKw(Infinity)).toBe(false);
        expect(STATE.demandFixedKw).toBe(LAB_LIMITS.demandKw.min);
    });

    it("WINDS THE BUS PAST ITS RATING AND THE BREAKER OPENS — a trip, one knob away", () => {
        startLab();
        run(20);
        const pdu = one("pdu");
        expect(pdu.tripped).toBe(false);

        setLabDemandKw(20);              // 18 kW of racks + the CRAC on a 16 kW bus
        run(30);
        expect(pdu.tripped).toBe(true);
        expect(STATE.servedKw).toBe(0);  // and the whole room goes with it
    });
});

// ---------------------------------------------------------------------------
describe("the ambient knob", () => {
    it("MOVES THE FIELD'S FLOOR, both ways — and never writes CONFIG", () => {
        startLab({ prebuilt: false });
        setLabAmbientC(40);
        run(500);
        for (const c of STATE.heatField) expect(c).toBeCloseTo(40, 1);

        setLabAmbientC(12);
        run(500);
        for (const c of STATE.heatField) expect(c).toBeCloseTo(12, 1);

        // The reference implementation rule: temporary effects are held in
        // STATE, never written back into CONFIG (docs/ARCHITECTURE.md).
        expect(CONFIG.heat.ambientC).toBe(22);
    });

    it("takes the racks to the edge of throttling without touching a heatwave", () => {
        startLab();
        run(30);
        expect(of("rack").every((r) => r.throttleFactor === 1)).toBe(true);
        setLabAmbientC(LAB_LIMITS.ambientC.max);   // one degree past throttleStartC
        run(400);
        expect(of("rack").some((r) => r.throttleFactor < 1)).toBe(true);
    });

    it("a heatwave RAISES the floor and can never lower it", () => {
        startLab({ prebuilt: false });
        setLabAmbientC(LAB_LIMITS.ambientC.max);   // hotter than the heatwave itself
        run(500);
        const settled = STATE.heatField[0];
        expect(settled).toBeGreaterThan(CONFIG.heat.heatwaveAmbientC);

        fireLabEvent("heatwave");
        run(20);
        // Firing a heatwave at a room already hotter than one must not cool it.
        expect(STATE.heatField[0]).toBeGreaterThanOrEqual(settled - 1e-9);
    });

    it("a heatwave still works normally under a COLD knob setting", () => {
        startLab({ prebuilt: false });
        setLabAmbientC(12);
        run(400);
        expect(STATE.heatField[0]).toBeCloseTo(12, 0);

        fireLabEvent("heatwave");
        run(20);
        // Dissipation is slow on purpose (0.015/s), so twenty seconds is a
        // quarter of the way from 12 °C to the heatwave's 34 — the direction
        // is the assertion, and it is UP.
        expect(STATE.heatField[0]).toBeGreaterThan(15);
        expect(STATE.heatField[0]).toBeLessThan(CONFIG.heat.heatwaveAmbientC);
    });

    it("is severed by resetState(), like every other STATE field", () => {
        startLab();
        setLabAmbientC(40);
        setLabTariffBand("day");
        expect(STATE.lab).toEqual({ on: true, ambientC: 40, tariffBand: "day" });
        resetState();
        expect(STATE.lab).toEqual({ on: false, ambientC: null, tariffBand: null });
    });

    it("does not survive into the NEXT level either", () => {
        startLab();
        setLabAmbientC(40);
        // A retry straight out of the Lab into an ordinary level, with no
        // resetState() in between — startLevelState writes a fresh literal.
        startLevelState("hot_aisle");
        expect(STATE.lab).toEqual({ on: false, ambientC: null, tariffBand: null });
    });
});

// ---------------------------------------------------------------------------
describe("the tariff knob", () => {
    const NIGHT = CONFIG.tariff.bands.find((b) => b.key === "night");
    const DAY = CONFIG.tariff.bands.find((b) => b.key === "day");

    it("pins a band, and it STAYS pinned across a whole cycle", () => {
        startLab();
        expect(setLabTariffBand("day")).toBe(true);
        expect(labTariffMode()).toBe("day");
        run(1);
        expect(STATE.tariff.band).toBe("day");
        expect(STATE.tariff.cycleMul).toBe(DAY.mult);
        run(CONFIG.tariff.periodSec + 5);        // a full period and change
        expect(STATE.tariff.band).toBe("day");
        expect(STATE.tariff.cycleMul).toBe(DAY.mult);
    });

    it("night is the cheap half of the same clock", () => {
        startLab();
        setLabTariffBand("night");
        run(1);
        expect(STATE.tariff.band).toBe("night");
        expect(STATE.tariff.cycleMul).toBe(NIGHT.mult);
    });

    it("OFF is a flat meter: no band, no multiplier", () => {
        startLab();
        expect(setLabTariffBand("off")).toBe(true);
        expect(labTariffMode()).toBe("off");
        run(1);
        expect(STATE.tariff.cycleOn).toBe(false);
        expect(STATE.tariff.cycleMul).toBe(1);
        expect(STATE.tariff.band).toBeNull();
    });

    it("AUTO hands the clock back", () => {
        startLab();
        setLabTariffBand("night");
        expect(setLabTariffBand("auto")).toBe(true);
        expect(labTariffMode()).toBe("auto");
        expect(STATE.lab.tariffBand).toBeNull();
        expect(STATE.tariff.cycleOn).toBe(true);
        // The clock is running again: bands change with elapsed time.
        run(DAY.fromSec + 1);
        expect(STATE.tariff.band).toBe("day");
        run(CONFIG.tariff.periodSec - DAY.fromSec);
        expect(STATE.tariff.band).toBe("night");
    });

    it("THE BILL IS THE BAND — the same room, thirty seconds, two prices", () => {
        startLab();
        setLabTariffBand("night");
        run(20);                          // settle
        const nightStart = STATE.money;
        run(30);
        const nightDelta = STATE.money - nightStart;

        startLab();
        setLabTariffBand("day");
        run(20);
        const dayStart = STATE.money;
        run(30);
        const dayDelta = STATE.money - dayStart;

        expect(dayDelta).toBeLessThan(nightDelta);
    });

    it("never announces a change that will not come while a band is pinned", () => {
        startLab();
        setLabTariffBand("night");
        for (let t = 0; t < 2 * CONFIG.tariff.periodSec; t += 5) {
            expect(upcomingBand(t), `t=${t}`).toBeNull();
        }
        setLabTariffBand("auto");
        expect(upcomingBand(DAY.fromSec - 1)).not.toBeNull();
    });

    it("refuses a band that does not exist rather than inventing one", () => {
        startLab();
        expect(setLabTariffBand("dusk")).toBe(false);
        expect(STATE.lab.tariffBand).toBeNull();
    });
});

// ---------------------------------------------------------------------------
describe("fire now — the same window the real event opens", () => {
    it("each button opens its own STATE window, for the duration CONFIG gives it", () => {
        startLab();
        run(10);
        const at = STATE.elapsedGameTime;
        const ev = CONFIG.events;
        const mid = (c) => (c.minDurationSec + c.maxDurationSec) / 2;

        expect(fireLabEvent("heatwave")).toBe(true);
        expect(STATE.heatwave.active).toBe(true);
        expect(STATE.heatwave.endsAt).toBeCloseTo(at + ev.heatwave.durationSec, 9);

        expect(fireLabEvent("brownout")).toBe(true);
        expect(STATE.brownout.active).toBe(true);
        expect(STATE.brownout.factor).toBe(ev.brownout.capacityFactor);
        expect(STATE.brownout.endsAt).toBeCloseTo(at + mid(ev.brownout), 9);

        expect(fireLabEvent("outage")).toBe(true);
        expect(STATE.gridOutage.active).toBe(true);
        expect(STATE.gridOutage.scope).toBe("all");
        expect(STATE.gridOutage.endsAt).toBeCloseTo(at + mid(ev.gridOutage), 9);

        expect(fireLabEvent("tariff")).toBe(true);
        expect(STATE.tariff.active).toBe(true);
        expect(STATE.tariff.multiplier).toBe(ev.tariff.multiplier);
        expect(STATE.tariff.endsAt).toBeCloseTo(at + mid(ev.tariff), 9);
    });

    it("and each one is CLOSED by the simulation's own endsAt rule, not by a timer of ours", () => {
        const ev = CONFIG.events;
        const mid = (c) => (c.minDurationSec + c.maxDurationSec) / 2;
        const cases = [
            ["heatwave", () => STATE.heatwave, ev.heatwave.durationSec],
            ["brownout", () => STATE.brownout, mid(ev.brownout)],
            ["outage", () => STATE.gridOutage, mid(ev.gridOutage)],
            ["tariff", () => STATE.tariff, mid(ev.tariff)],
        ];
        for (const [kind, win, duration] of cases) {
            startLab();
            run(5);
            fireLabEvent(kind);
            run(duration - 1);
            expect(win().active, `${kind} should still be open`).toBe(true);
            run(2);
            expect(win().active, `${kind} should have closed itself`).toBe(false);
        }
    });

    it("the rehearsed brownout is the SAME sag: it clips the feed and leaves CONFIG alone", () => {
        startLab();
        // The handed-over room never asks the feed for more than one 16 kW
        // bus can carry, so a 50% sag on a 40 kW feed cannot touch it — which
        // is the brownout's own lesson, not a bug. Spend some of the level's
        // money on a second bus and the feed becomes the binding link.
        const pdu2 = placeBuilding("pdu", 12, 12);
        connect(one("ups"), pdu2);
        connect(pdu2, placeBuilding("rack", 20, 6));
        connect(pdu2, placeBuilding("rack", 20, 10));
        setLabDemandKw(24);
        run(6);

        const feed = one("grid_feed");
        const before = feed.actualKw;
        expect(STATE.buildings.some((b) => b.tripped)).toBe(false);
        expect(before).toBeGreaterThan(20);

        fireLabEvent("brownout");
        run(2);
        // 40 kW of feed at 50% is 20 kW, and the room is asking for more.
        expect(feed.actualKw).toBeLessThan(before);
        expect(feed.actualKw).toBeLessThanOrEqual(
            CONFIG.buildings.grid_feed.capacityKw * CONFIG.events.brownout.capacityFactor + 1e-9
        );
        expect(STATE.servedKw).toBeLessThan(24);
        // The reference implementation: a temporary effect is a multiplier
        // over CONFIG held in STATE, never a write-back.
        expect(CONFIG.buildings.grid_feed.capacityKw).toBe(40);
    });

    it("THE REHEARSED OUTAGE IS THE SAME BLACKOUT — the UPS bridges, the transfer switch picks up", () => {
        startLab();
        run(20);
        const ups = one("ups");
        const gen = one("generator");
        expect(ups.bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec, 9);
        expect(gen.actualKw).toBe(0);

        expect(fireLabEvent("outage")).toBe(true);
        run(1);
        expect(ups.upsMode).toBe("bridging");
        expect(STATE.servedKw).toBeGreaterThan(11);        // the load never noticed

        run(CONFIG.buildings.generator.cutoverSec + 1);    // past the cutover
        expect(gen.actualKw).toBeGreaterThan(0);
        expect(gen.fuelLiters).toBeLessThan(CONFIG.buildings.generator.tankLiters);
        run(8);
        expect(STATE.servedKw).toBeGreaterThan(11);        // …and still has not
    });

    it("the rehearsed CRAC breakdown is the SAME failure — and self-repairs on the SAME clock", () => {
        startLab();
        run(10);
        const crac = one("crac");
        const at = STATE.elapsedGameTime;
        expect(fireLabEvent("crac_fail")).toBe(true);
        expect(crac.broken).toBe(true);
        expect(crac.repairAt).toBeCloseTo(at + CONFIG.events.cracBreakdown.selfRepairSec, 9);

        run(1);
        expect(crac.duty).toBe(0);          // sim/heat.js forces it
        expect(crac.actualKw).toBe(0);      // and sim/power.js stops billing it

        run(CONFIG.events.cracBreakdown.selfRepairSec);
        expect(crac.broken).toBe(false);    // the free repair, by crisis.js's own loop
    });

    it("refuses a window that is already open, and refuses a breakdown with nothing to break", () => {
        startLab();
        expect(fireLabEvent("outage")).toBe(true);
        expect(fireLabEvent("outage")).toBe(false);

        startLab({ prebuilt: false });      // no CRAC on an empty floor
        expect(fireLabEvent("crac_fail")).toBe(false);
    });

    it("refuses a kind nobody defined", () => {
        startLab();
        expect(fireLabEvent("earthquake")).toBe(false);
        expect(LAB_EVENTS).toEqual(["heatwave", "brownout", "outage", "tariff", "crac_fail"]);
    });
});

// ---------------------------------------------------------------------------
describe("reset", () => {
    it("puts every knob back and closes every window it can open — and leaves the ROOM alone", () => {
        startLab();
        run(5);
        setLabDemandKw(LAB_LIMITS.demandKw.max);
        setLabAmbientC(40);
        setLabTariffBand("day");
        for (const kind of ["heatwave", "brownout", "outage", "tariff"]) fireLabEvent(kind);
        const rooms = STATE.buildings.length;
        const money = STATE.money;

        expect(resetLab()).toBe(true);
        expect(STATE.demandFixedKw).toBe(levelCfg(LAB).demandKw);
        expect(STATE.lab.ambientC).toBeNull();
        expect(STATE.lab.tariffBand).toBeNull();
        expect(labTariffMode()).toBe("auto");
        expect(STATE.heatwave.active).toBe(false);
        expect(STATE.brownout.active).toBe(false);
        expect(STATE.brownout.factor).toBe(1);
        expect(STATE.gridOutage.active).toBe(false);
        expect(STATE.tariff.active).toBe(false);
        expect(STATE.tariff.multiplier).toBe(1);

        // Not a level restart: what the player built stays built.
        expect(STATE.buildings.length).toBe(rooms);
        expect(STATE.money).toBe(money);
    });

    it("leaves the clocks the Lab exists to show you running — a broken CRAC still heals on its own", () => {
        startLab();
        run(10);
        const crac = one("crac");
        fireLabEvent("crac_fail");
        resetLab();
        expect(crac.broken).toBe(true);
        run(CONFIG.events.cracBreakdown.selfRepairSec + 1);
        expect(crac.broken).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The requirement most likely to be got wrong, and the one that protects
// thirteen machine-proven levels.
describe("INERTNESS — the Lab cannot be seen from anywhere else", () => {
    const hammer = () => {
        setLabDemandKw(LAB_LIMITS.demandKw.max);
        setLabAmbientC(LAB_LIMITS.ambientC.max);
        setLabTariffBand("day");
        setLabTariffBand("off");
        for (const kind of LAB_EVENTS) fireLabEvent(kind);
        resetLab();
    };

    it("EVERY entry point refuses inside an ordinary level", () => {
        startLevel("first_watt", { prebuilt: false });
        expect(isLab()).toBe(false);
        expect(setLabDemandKw(30)).toBe(false);
        expect(setLabAmbientC(40)).toBe(false);
        expect(setLabTariffBand("day")).toBe(false);
        expect(setLabTariffBand("off")).toBe(false);
        expect(fireLabEvent("outage")).toBe(false);
        expect(fireLabEvent("crac_fail")).toBe(false);
        expect(resetLab()).toBe(false);

        expect(STATE.demandFixedKw).toBe(levelCfg("first_watt").demandKw);
        expect(STATE.lab).toEqual({ on: false, ambientC: null, tariffBand: null });
        expect(STATE.gridOutage.active).toBe(false);
        expect(STATE.tariff.cycleOn).toBe(false);
    });

    it("EVERY entry point refuses in survival", () => {
        expect(STATE.campaign.levelId).toBeNull();
        expect(isLab()).toBe(false);
        hammer();
        expect(STATE.demandFixedKw).toBeNull();
        expect(STATE.lab).toEqual({ on: false, ambientC: null, tariffBand: null });
        expect(STATE.heatwave.active).toBe(false);
        expect(STATE.brownout.active).toBe(false);
        expect(STATE.gridOutage.active).toBe(false);
        expect(STATE.tariff.active).toBe(false);
    });

    // The attribution.test.mjs pattern: run the same thing twice, abuse the
    // new layer on every tick of the second run, and compare with toBe.
    function playLevel(id, seconds, build, abuse) {
        startLevel(id, { prebuilt: false });
        build();
        for (let i = 0; i < seconds / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickCrisis(DT, t, rngZero);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickContracts(DT, t, rngZero);
            tickMaintenance(DT, t);
            tickCampaign(DT, t);
            if (abuse) hammer();
        }
        return {
            money: STATE.money,
            servedKw: STATE.servedKw,
            reputation: STATE.reputation,
            itDrawKw: STATE.itDrawKw,
            totalDrawKw: STATE.totalDrawKw,
            heatField: [...STATE.heatField],
            done: STATE.campaign.done,
            lab: { ...STATE.lab },
        };
    }

    function place(type, gx, gz) {
        const b = new Building(type, gx, gz);
        STATE.buildings.push(b);
        return b;
    }

    // hot_aisle: a scripted heatwave, racks, cooling, a live bill — every
    // subsystem the Lab touches is moving in this run.
    function hotAisleRoom() {
        const feed = place("grid_feed", 2, 6);
        const xf = place("transformer", 5, 6);
        const pdu = place("pdu", 8, 6);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);
        for (const [gx, gz] of [[12, 5], [12, 7]]) wireBuildings(pdu, place("rack", gx, gz));
        for (const [gx, gz] of [[11, 6], [13, 6]]) wireBuildings(pdu, place("crac", gx, gz));
    }

    it("A CAMPAIGN LEVEL IS BIT-IDENTICAL with every Lab entry point hammered on every tick", () => {
        const plain = playLevel("hot_aisle", 150, hotAisleRoom, false);
        const hammered = playLevel("hot_aisle", 150, hotAisleRoom, true);

        expect(hammered.money).toBe(plain.money);
        expect(hammered.servedKw).toBe(plain.servedKw);
        expect(hammered.reputation).toBe(plain.reputation);
        expect(hammered.itDrawKw).toBe(plain.itDrawKw);
        expect(hammered.totalDrawKw).toBe(plain.totalDrawKw);
        expect(hammered.heatField).toEqual(plain.heatField);
        expect(hammered.done).toBe(plain.done);
        expect(hammered.lab).toEqual({ on: false, ambientC: null, tariffBand: null });

        // …and the run really did something, so "identical" is not
        // "identically empty".
        expect(plain.servedKw).toBeGreaterThan(0);
        expect(plain.money).not.toBe(levelCfg("hot_aisle").startMoney);
        expect(Math.max(...plain.heatField)).toBeGreaterThan(CONFIG.heat.ambientC + 5);
        expect(plain.done).toBe("won");
    });

    it("SURVIVAL IS BIT-IDENTICAL too", () => {
        function survival(abuse) {
            resetState();
            resetBuildingIds();
            resetWireIds();
            STATE.tariff.cycleOn = true;      // free play runs the meter
            hotAisleRoom();
            for (let i = 0; i < 120 / DT; i++) {
                STATE.elapsedGameTime += DT;
                const t = STATE.elapsedGameTime;
                tickEvents(DT, t);
                tickCrisis(DT, t, rngZero);
                tickDemand(DT, t);
                resolvePower(DT);
                tickHeat(DT);
                tickContracts(DT, t, rngZero);
                tickMaintenance(DT, t);
                tickCampaign(DT, t);
                if (abuse) hammer();
            }
            return {
                money: STATE.money,
                servedKw: STATE.servedKw,
                reputation: STATE.reputation,
                itDrawKw: STATE.itDrawKw,
                totalDrawKw: STATE.totalDrawKw,
                cycleMul: STATE.tariff.cycleMul,
                band: STATE.tariff.band,
                heatField: [...STATE.heatField],
            };
        }
        const plain = survival(false);
        const hammered = survival(true);
        expect(hammered.money).toBe(plain.money);
        expect(hammered.servedKw).toBe(plain.servedKw);
        expect(hammered.reputation).toBe(plain.reputation);
        expect(hammered.itDrawKw).toBe(plain.itDrawKw);
        expect(hammered.totalDrawKw).toBe(plain.totalDrawKw);
        expect(hammered.cycleMul).toBe(plain.cycleMul);
        expect(hammered.band).toBe(plain.band);
        expect(hammered.heatField).toEqual(plain.heatField);
        expect(plain.servedKw).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
describe("the room the Lab hands you", () => {
    it("arrives LIVE: everything powered, nothing throttled, nothing tripped", () => {
        startLab();
        run(2);
        for (const b of STATE.buildings) {
            if (b.type === "generator") continue;         // standby, and idle
            expect(b.powered, `${b.type} should be live`).toBe(true);
        }
        expect(of("rack").every((r) => r.throttleFactor === 1)).toBe(true);
        expect(STATE.buildings.some((b) => b.tripped)).toBe(false);
        expect(one("ups").bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec, 9);
        expect(one("generator").fuelLiters).toBe(CONFIG.buildings.generator.tankLiters);
    });

    it("is CALM at the demand it starts on — a rehearsal room starts quiet", () => {
        startLab();
        run(150);
        expect(STATE.servedKw).toBeCloseTo(levelCfg(LAB).demandKw, 9);
        expect(of("rack").every((r) => r.throttleFactor === 1)).toBe(true);
        expect(one("pdu").tripped).toBe(false);
        expect(STATE.reputation).toBeCloseTo(100, 3);
        // …and it pays for itself, so the money is for extending the room.
        expect(STATE.money).toBeGreaterThan(levelCfg(LAB).startMoney);
    });

    it("is handed over FREE, with the level's money left to build on", () => {
        startLab();
        expect(STATE.money).toBe(levelCfg(LAB).startMoney);
        expect(STATE.buildings.length).toBe(levelCfg(LAB).preBuilt.buildings.length);
        // Enough for a second chain plus a rack, which is what "extend it" means.
        const chain = ["grid_feed", "transformer", "ups", "pdu", "rack"]
            .reduce((sum, t) => sum + CONFIG.buildings[t].cost, 0);
        expect(STATE.money).toBeGreaterThan(chain);
    });

    it("has the transfer switch already wired — the point of the room", () => {
        const made = startLab();
        const gen = one("generator");
        const xf = one("transformer");
        expect(xf.standbyParentId).toBe(gen.id);
        expect(made.length).toBe(levelCfg(LAB).preBuilt.buildings.length);
        expect(STATE.wires.filter((w) => w.standby).length).toBe(1);
    });
});
