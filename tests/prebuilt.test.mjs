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
import { tickCampaign, startLevelState, levelCfg } from "../src/campaign/campaign.js";
import { applyPreBuilt, preBuiltSpec, hasPreBuilt } from "../src/campaign/prebuilt.js";
import { placeBuilding, demolishBuilding, connect, resetWireIds } from "../src/sim/build.js";

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

describe("L8 one_bus — the shared rating", () => {
    it("LOSE: four racks on one 16 kW PDU all brown out together", () => {
        start("one_bus");
        runLevel("one_bus");
        expect(STATE.campaign.done).toBe("failed");
        // Not a heat problem, not a sizing problem — the bus.
        expect(STATE.losses.tickKw.link_clip).toBeGreaterThan(0);
        const culprit = STATE.buildings.find((b) => b.id === STATE.losses.blame[0].buildingId);
        expect(culprit.type).toBe("pdu");
    });

    it("WIN: $60 buys the second bus the room needed", () => {
        const made = start("one_bus");
        const xf = made[1];
        const pdu2 = placeBuilding("pdu", 9, 9);
        expect(typeof pdu2).not.toBe("string");
        connect(xf, pdu2);
        // Move half the racks onto it — re-wiring replaces the old feed.
        const racks = of("rack");
        connect(pdu2, racks[2]);
        connect(pdu2, racks[3]);
        runLevel("one_bus");
        expect(STATE.campaign.done).toBe("won");
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

describe("chapter wiring", () => {
    it("puts every diagnosis level in Chapter 3, in order, all prebuilt", () => {
        const ch3 = CONFIG.campaign.chapters.find((c) => c.id === "ch3");
        expect(ch3.levels).toEqual(["over_cooled", "one_bus", "cold_room"]);
        for (const id of ch3.levels) expect(hasPreBuilt(id)).toBe(true);
    });
});
