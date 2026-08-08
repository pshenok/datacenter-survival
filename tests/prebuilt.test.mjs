// Chapter 3 — the diagnosis levels. Each hands the player a running room
// that is already wrong, so the machine-play pairs read differently from
// every earlier level: LOSE is "do nothing" (the room as handed over) and
// WIN is a repair — usually a DEMOLITION, the move a blank floor can never
// teach.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickContracts } from "../src/sim/contracts.js";
import { tickCampaign, startLevelState, levelCfg, startLevelMaintenance } from "../src/campaign/campaign.js";
import { applyPreBuilt, preBuiltSpec, hasPreBuilt } from "../src/campaign/prebuilt.js";
import { placeBuilding, demolishBuilding, connect, resetWireIds } from "../src/sim/build.js";
import { utilityOf, feedIsDark } from "../src/sim/power.js";
import { resetBreaker } from "../src/sim/crisis.js";
import { openServiceWindow, tickMaintenance } from "../src/sim/maintenance.js";

const DT = 0.05;
const rngZero = () => 0;

function start(id) {
    resetState();
    resetBuildingIds();
    resetWireIds();
    expect(startLevelState(id)).toBe(true);
    return applyPreBuilt(id);
}

function runLevel(id) {
    const limit = levelCfg(id).timeLimitSec + 5;
    for (let i = 0; i < limit / DT; i++) {
        if (STATE.campaign.done !== null) return;
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickCrisis(DT, t, rngZero);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
        tickContracts(DT, t, rngZero);
        tickCampaign(DT, t);
    }
}

const of = (type) => STATE.buildings.filter((b) => b.type === type);

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("preBuilt builder", () => {
    it("reproduces exactly the topology each level declares", () => {
        for (const id of ["over_cooled", "one_bus", "cold_room"]) {
            const made = start(id);
            const spec = preBuiltSpec(id);
            expect(made.length).toBe(spec.buildings.length);
            made.forEach((b, i) => {
                expect(b.type).toBe(spec.buildings[i].type);
                expect([b.gx, b.gz]).toEqual([spec.buildings[i].gx, spec.buildings[i].gz]);
            });
            for (const [from, to] of spec.wires) {
                expect(made[to].parentId, `${id}: ${from}->${to}`).toBe(made[from].id);
            }
            // Every declared edge also has a wire record for the UI to skin.
            expect(STATE.wires.length).toBe(spec.wires.length + (spec.standby || []).length);
        }
    });

    it("hands the room over FREE — the level's money is for the repair", () => {
        start("over_cooled");
        expect(STATE.money).toBe(levelCfg("over_cooled").startMoney);
        expect(STATE.buildings.length).toBeGreaterThan(0);
    });

    it("is a no-op on the blank-floor levels", () => {
        expect(hasPreBuilt("first_watt")).toBe(false);
        start("first_watt");
        expect(STATE.buildings.length).toBe(0);
    });

    it("resetState severs the prebuilt room", () => {
        start("cold_room");
        expect(STATE.buildings.length).toBeGreaterThan(0);
        resetState();
        expect(STATE.buildings).toEqual([]);
        expect(STATE.wires).toEqual([]);
    });
});

describe("L7 over_cooled — the fix is a demolition", () => {
    it("LOSE: the room as handed over is cool and ruinously expensive", () => {
        start("over_cooled");
        runLevel("over_cooled");
        expect(STATE.campaign.done).toBe("failed");
        const cool = STATE.campaign.objectives.find((o) => o.type === "no_throttle");
        const pue = STATE.campaign.objectives.find((o) => o.type === "pue_below");
        expect(cool.done).toBe(true);     // the racks are perfectly happy…
        expect(pue.done).toBe(false);     // …and that is exactly the problem
    });

    it("WIN: demolish two of the four CRACs — and the refund pays for it", () => {
        start("over_cooled");
        expect(STATE.money).toBe(0);
        const cracs = of("crac");
        expect(cracs.length).toBe(4);
        demolishBuilding(cracs[2]);
        demolishBuilding(cracs[3]);
        expect(of("crac").length).toBe(2);
        expect(STATE.money).toBeGreaterThan(0);   // the fix funds itself
        runLevel("over_cooled");
        expect(STATE.campaign.done).toBe("won");
    });

    it("LOSE: demolishing ALL the cooling swings it the other way", () => {
        start("over_cooled");
        for (const c of of("crac")) demolishBuilding(c);
        runLevel("over_cooled");
        expect(STATE.campaign.done).toBe("failed");
        const cool = STATE.campaign.objectives.find((o) => o.type === "no_throttle");
        expect(cool.done).toBe(false);
    });
});

describe("L8 one_bus — the shared rating, and the handle that does not fix it", () => {
    it("LOSE: the bus is asked for more than its rating and OPENS", () => {
        start("one_bus");
        runLevel("one_bus");
        expect(STATE.campaign.done).toBe("failed");
        const pdu = of("pdu")[0];
        expect(pdu.tripped).toBe(true);
        // Not a heat problem, not a sizing problem — the bus, by name.
        expect(STATE.losses.tickKw.breaker_tripped).toBeGreaterThan(0);
        const culprit = STATE.buildings.find((b) => b.id === STATE.losses.blame[0].buildingId);
        expect(culprit.type).toBe("pdu");
    });

    it("LOSE: resetting it forever without fixing the cause is a slower outage", () => {
        // The impossible-for-a-human version — reset on EVERY tick — still
        // misses, because the bus opens again within seconds each time.
        start("one_bus");
        const limit = levelCfg("one_bus").timeLimitSec + 5;
        for (let i = 0; i < limit / DT; i++) {
            if (STATE.campaign.done !== null) break;
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickCrisis(DT, t, rngZero);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickCampaign(DT, t);
            for (const b of STATE.buildings) if (b.tripped) resetBreaker(b);
        }
        expect(STATE.campaign.done).toBe("failed");
        // It served real work — just never enough of it.
        expect(STATE.campaign.objectives[0].progress).toBeGreaterThan(20);
    });

    it("WIN: $60 buys the second bus, and THEN the handle stays in", () => {
        const made = start("one_bus");
        const xf = made[1];
        const pdu2 = placeBuilding("pdu", 9, 9);
        expect(typeof pdu2).not.toBe("string");
        connect(xf, pdu2);
        // Move half the load across — re-wiring replaces the old feed.
        connect(pdu2, of("rack")[2]);
        connect(pdu2, of("rack")[3]);
        connect(pdu2, of("crac")[1]);
        const limit = levelCfg("one_bus").timeLimitSec + 5;
        for (let i = 0; i < limit / DT; i++) {
            if (STATE.campaign.done !== null) break;
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickCrisis(DT, t, rngZero);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickCampaign(DT, t);
            for (const b of STATE.buildings) if (b.tripped) resetBreaker(b);
        }
        expect(STATE.campaign.done).toBe("won");
        // …and with the load split, nothing was tripped at the end.
        expect(STATE.buildings.every((b) => !b.tripped)).toBe(true);
    });
});

describe("L9 cold_room — cooling in the wrong place is no cooling", () => {
    it("LOSE: two CRACs at full tilt in an empty corner while the aisle cooks", () => {
        start("cold_room");
        runLevel("cold_room");
        expect(STATE.campaign.done).toBe("failed");
        expect(of("rack").some((r) => r.throttleFactor < 1)).toBe(true);
        // They ARE running — that is what makes the ticket confusing.
        expect(of("crac").every((c) => c.powered)).toBe(true);
    });

    it("WIN: move them into radius of the racks", () => {
        const made = start("cold_room");
        const pduCooling = made[3];
        for (const c of of("crac")) demolishBuilding(c);
        for (const [gx, gz] of [[13, 7], [16, 7]]) {
            const c = placeBuilding("crac", gx, gz);
            expect(typeof c).not.toBe("string");
            connect(pduCooling, c);
        }
        runLevel("cold_room");
        expect(STATE.campaign.done).toBe("won");
    });
});

describe("L10 two_utilities — redundancy that isn't", () => {
    it("LOSE: two feeds on the SAME side of the floor share a substation", () => {
        start("two_utilities");
        // Both feeds are A-side as handed over, so an A outage takes the
        // whole room — the redundancy is cosmetic.
        expect(of("grid_feed").every((f) => utilityOf(f) === "A")).toBe(true);
        runLevel("two_utilities");
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.campaign.objectives[0].progress).toBeLessThan(0.1);
    });

    it("LOSE: half a fix is not redundancy — saving one aisle still misses", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 20, 12);
        connect(feedB, made[3]);          // only the second chain moves over
        runLevel("two_utilities");
        expect(STATE.campaign.done).toBe("failed");
        // It served through the dark — just not enough of the room.
        expect(STATE.campaign.objectives[0].progress).toBeGreaterThan(3);
    });

    it("WIN: one feed on the far side, with the whole room behind it", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 20, 12);
        expect(utilityOf(feedB)).toBe("B");
        connect(feedB, made[3]);          // transformer 2 now hangs off B…
        connect(made[3], made[4]);        // …and so does the first PDU
        runLevel("two_utilities");
        expect(STATE.campaign.done).toBe("won");
    });

    it("a scoped outage kills only its own substation", () => {
        start("two_utilities");
        const feedB = placeBuilding("grid_feed", 20, 12);
        STATE.gridOutage.active = true;
        STATE.gridOutage.scope = "A";
        STATE.gridOutage.endsAt = Infinity;
        expect(feedIsDark(of("grid_feed")[0])).toBe(true);    // A-side, gx 4
        expect(feedIsDark(feedB)).toBe(false);                // B-side, gx 20
        STATE.gridOutage.scope = "all";
        expect(feedIsDark(feedB)).toBe(true);                 // the old behaviour
    });
});

describe("chapter wiring", () => {
    it("puts every diagnosis level in Chapter 3, all prebuilt", () => {
        const ch3 = CONFIG.campaign.chapters.find((c) => c.id === "ch3");
        expect(ch3.levels).toEqual(["over_cooled", "one_bus", "cold_room", "two_utilities"]);
        for (const id of ch3.levels) expect(hasPreBuilt(id)).toBe(true);
    });

    it("every level's preBuilt geometry stays on the floor and never doubles up", () => {
        for (const [id, cfg] of Object.entries(CONFIG.campaign.levels)) {
            if (!cfg.preBuilt) continue;
            const seen = new Set();
            for (const b of cfg.preBuilt.buildings) {
                expect(b.gx, `${id}`).toBeGreaterThanOrEqual(0);
                expect(b.gx, `${id}`).toBeLessThan(CONFIG.gridSize);
                expect(b.gz, `${id}`).toBeGreaterThanOrEqual(0);
                expect(b.gz, `${id}`).toBeLessThan(CONFIG.gridSize);
                const key = `${b.gx},${b.gz}`;
                expect(seen.has(key), `${id}: two buildings on ${key}`).toBe(false);
                seen.add(key);
            }
        }
    });
});

describe("L11 water_loop — the cooling decision, and nothing else", () => {
    const HEADS = [[12, 6], [16, 6], [14, 4], [14, 9]];
    const coolBus = (made) => made[10];

    it("LOSE: four CRACs hold the temperature and miss the efficiency target", () => {
        const made = start("water_loop");
        for (const [gx, gz] of HEADS) connect(coolBus(made), placeBuilding("crac", gx, gz));
        runLevel("water_loop");
        expect(STATE.campaign.done).toBe("failed");
        const cool = STATE.campaign.objectives.find((o) => o.type === "no_throttle");
        const pue = STATE.campaign.objectives.find((o) => o.type === "pue_below");
        expect(cool.done).toBe(true);     // the room is fine…
        expect(pue.done).toBe(false);     // …the bill is not
    });

    it("WIN: one plant making chilled water for four heads clears the same job for less", () => {
        const made = start("water_loop");
        connect(coolBus(made), placeBuilding("chiller", 20, 16));
        for (const [gx, gz] of HEADS) connect(coolBus(made), placeBuilding("crah", gx, gz));
        expect(STATE.money).toBeGreaterThanOrEqual(0);   // $600 covers it
        runLevel("water_loop");
        expect(STATE.campaign.done).toBe("won");
    });

    it("LOSE: heads without a plant are furniture", () => {
        const made = start("water_loop");
        for (const [gx, gz] of HEADS) connect(coolBus(made), placeBuilding("crah", gx, gz));
        runLevel("water_loop");
        expect(STATE.campaign.done).toBe("failed");
        expect(of("rack").some((r) => r.throttleFactor < 1)).toBe(true);
    });
});

describe("L12 single_point_of_cold — the day the plant stops", () => {
    it("LOSE: the room as handed over runs on one plant and cooks when it fails", () => {
        start("single_point_of_cold");
        runLevel("single_point_of_cold");
        expect(STATE.campaign.done).toBe("failed");
        expect(of("chiller")[0].broken).toBe(true);
        expect(of("rack").some((r) => r.throttleFactor < 1)).toBe(true);
    });

    it("LOSE: another CRAH drinks from the same dead plant", () => {
        const made = start("single_point_of_cold");
        connect(made[10], placeBuilding("crah", 12, 9));
        runLevel("single_point_of_cold");
        expect(STATE.campaign.done).toBe("failed");
    });

    it("WIN: swap two heads for air-cooled units — a second FAILURE MODE, not a second unit", () => {
        const made = start("single_point_of_cold");
        const heads = of("crah");
        demolishBuilding(heads[2]);
        demolishBuilding(heads[3]);
        for (const [gx, gz] of [[14, 4], [14, 9]]) {
            const c = placeBuilding("crac", gx, gz);
            expect(typeof c).not.toBe("string");
            connect(made[10], c);
        }
        runLevel("single_point_of_cold");
        expect(STATE.campaign.done).toBe("won");
    });
});

describe("L13 night_shift — Tier III is about being serviceable", () => {
    function startShift() {
        resetState();
        resetBuildingIds();
        resetWireIds();
        expect(startLevelState("night_shift")).toBe(true);
        const made = applyPreBuilt("night_shift");
        startLevelMaintenance("night_shift", made);
        return made;
    }

    function runShift() {
        const limit = levelCfg("night_shift").timeLimitSec + 5;
        for (let i = 0; i < limit / DT; i++) {
            if (STATE.campaign.done !== null) return;
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickCrisis(DT, t, rngZero);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickMaintenance(DT, t);
            tickCampaign(DT, t);
        }
    }

    it("LOSE (passive): do nothing and the first work order's deadline ends the level", () => {
        startShift();
        runShift();
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.campaign.reason).toBe("fail_maintenance");
        // The level resolves the instant the FIRST order misses its deadline
        // (bySec 90) — the second order (bySec 170) never gets the chance to
        // miss its own, and is still sitting "pending" when the clock stops.
        expect(STATE.maintenance.orders[0].state).toBe("missed");
        expect(STATE.maintenance.orders[1].state).toBe("pending");
    });

    it("LOSE (naive): move the load onto the surviving bus and TRIP it", () => {
        const made = startShift();
        const [, , pduA, pduB, r1, , r3] = made;
        // The obvious play: shove both of A's racks across to B. B already
        // carries a rack and the CRAC, so this alone puts 21 kW of demand
        // (18 of racks + the CRAC) on a 16 kW bus — the breaker opens
        // before anyone has even opened A's service window.
        connect(pduB, r1);
        connect(pduB, r3);
        for (let i = 0; i < 200; i++) {          // let the transfer settle
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT); tickMaintenance(DT, t);
        }
        expect(pduB.tripped).toBe(true);
        // A itself is now empty (both its racks left), so its own window
        // opens clean — the failure is not "can't do the work", it is
        // "doing the work is safe, the ROOM behind it was not".
        expect(openServiceWindow(pduA)).toBe(true);
        const openedAt = STATE.elapsedGameTime;
        runShift();
        expect(STATE.campaign.done).toBe("failed");
        // Not a near miss: 21 kW on a 16 kW bus opens it and the hall is dark.
        expect(pduB.tripped).toBe(true);
        expect(STATE.servedKw).toBe(0);
        // The headline claim is that the trip lands almost immediately — not
        // merely that the run eventually fails via order 2's own deadline
        // (bySec 170), which it would do anyway even with a neutered
        // served-ratio check. Pin the mechanism: the verdict lands within
        // about a second of opening the window, and order 2 never got the
        // chance to miss its own deadline.
        expect(STATE.elapsedGameTime - openedAt).toBeLessThan(1);
        expect(STATE.maintenance.orders[1].state).toBe("pending");
    });

    it("WIN: a third bus makes any single window survivable", () => {
        const made = startShift();
        const [, xf, pduA, pduB, r1, , r3] = made;
        const pduC = placeBuilding("pdu", 9, 15);
        expect(typeof pduC).not.toBe("string");
        expect(STATE.money).toBeGreaterThanOrEqual(0);   // $120 covers the $50 bus
        connect(xf, pduC);

        // Order 1: transfer everything off A, then open its window.
        connect(pduC, r1);
        connect(pduB, r3);
        for (let i = 0; i < 200; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT); tickMaintenance(DT, t);
        }
        expect(pduB.tripped).toBe(false);   // B now carries 15 kW — inside its 16 kW rating
        expect(openServiceWindow(pduA)).toBe(true);
        for (let i = 0; i < 30 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.maintenance.orders[0].state).toBe("done");
        expect(STATE.campaign.objectives[0].failed).toBe(false);

        // Order 2: same move, the other way — B's turn is next, so pull its
        // remaining rack over to A (now free) and give C the one A had.
        const r2 = STATE.buildings.find((b) => b.id === made[5].id);
        connect(pduA, r2);
        connect(pduC, r3);
        for (let i = 0; i < 200; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT); tickMaintenance(DT, t);
        }
        // By now every rack has left B — only the CRAC (index 7) is still
        // wired to it, exactly as the level hands it over. Losing the CRAC
        // for the 25s window does not starve any rack of power, and with no
        // heatwave scripted here it never builds enough heat to throttle one
        // either, so B's window is survivable without moving the CRAC too.
        expect(openServiceWindow(pduB)).toBe(true);
        runShift();
        expect(STATE.campaign.done).toBe("won");
        expect(STATE.maintenance.orders.every((o) => o.state === "done")).toBe(true);
    });
});
