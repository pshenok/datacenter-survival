// TEMPORARY review probe — delete after use.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower, utilityOf } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickContracts } from "../src/sim/contracts.js";
import { tickCampaign, startLevelState, levelCfg } from "../src/campaign/campaign.js";
import { applyPreBuilt } from "../src/campaign/prebuilt.js";
import { placeBuilding, demolishBuilding, connect, resetWireIds } from "../src/sim/build.js";

const DT = 0.05;
const rngZero = () => 0;

function start(id) {
    resetState();
    resetBuildingIds();
    resetWireIds();
    startLevelState(id);
    return applyPreBuilt(id);
}

function runLevel(id) {
    const limit = levelCfg(id).timeLimitSec + 5;
    let minMoney = Infinity, minRep = Infinity;
    for (let i = 0; i < limit / DT; i++) {
        if (STATE.campaign.done !== null) break;
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickCrisis(DT, t, rngZero);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
        tickContracts(DT, t, rngZero);
        tickCampaign(DT, t);
        minMoney = Math.min(minMoney, STATE.money);
        minRep = Math.min(minRep, STATE.reputation);
    }
    return {
        done: STATE.campaign.done,
        progress: STATE.campaign.objectives[0].progress,
        target: STATE.campaign.objectives[0].target,
        minMoney, minRep,
        money: STATE.money,
        t: STATE.elapsedGameTime,
    };
}

const of = (type) => STATE.buildings.filter((b) => b.type === type);
const spent = (m0) => m0 - STATE.money;

beforeEach(() => { resetState(); resetBuildingIds(); });

describe("PROBE two_utilities", () => {
    it("P0 utilityOf boundary", () => {
        const rows = [];
        for (const gx of [0, 14, 15, 16, 29]) {
            resetState(); resetBuildingIds(); resetWireIds();
            startLevelState("two_utilities");
            const f = placeBuilding("grid_feed", gx, 20);
            rows.push([gx, typeof f === "string" ? f : utilityOf(f)]);
        }
        console.log("P0 utilityOf:", JSON.stringify(rows), "gridSize", CONFIG.gridSize);
    });

    it("P1 intended WIN (buy feed on B, whole room behind it)", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 20, 12);
        connect(feedB, made[3]);
        connect(made[3], made[4]);
        const r = runLevel("two_utilities");
        console.log("P1 intended win:", JSON.stringify(r));
    });

    it("P1b intended WIN via demolish+replace (cheapest)", () => {
        const made = start("two_utilities");
        demolishBuilding(made[1]);              // demolish the 2nd A feed (+50)
        const feedB = placeBuilding("grid_feed", 20, 12);
        expect(typeof feedB).not.toBe("string");
        connect(feedB, made[3]);
        connect(made[3], made[4]);
        const r = runLevel("two_utilities");
        console.log("P1b demolish+replace:", JSON.stringify(r), "moneyAfterBuild", 260 - r.minMoney);
    });

    it("P2 half fix (feed on B, only one aisle behind it)", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 20, 12);
        connect(feedB, made[3]);
        const r = runLevel("two_utilities");
        console.log("P2 half fix:", JSON.stringify(r), "ratio", r.progress / r.target);
    });

    it("P3 half fix + ONE EXTRA RACK on the surviving aisle ($250)", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 20, 12);   // 100
        connect(feedB, made[3]);
        const extra = placeBuilding("rack", 16, 20);        // 150
        expect(typeof extra).not.toBe("string");
        connect(made[5], extra);                            // onto pdu of aisle 2
        console.log("P3 spend:", 260 - STATE.money);
        const r = runLevel("two_utilities");
        console.log("P3 half fix + rack:", JSON.stringify(r), "ratio", r.progress / r.target);
    });

    it("P3b demolish A-feed, buy B-feed, buy extra rack (net $200)", () => {
        const made = start("two_utilities");
        demolishBuilding(made[1]);
        const feedB = placeBuilding("grid_feed", 20, 12);
        connect(feedB, made[3]);
        const extra = placeBuilding("rack", 16, 20);
        connect(made[5], extra);
        console.log("P3b spend:", 260 - STATE.money);
        const r = runLevel("two_utilities");
        console.log("P3b:", JSON.stringify(r), "ratio", r.progress / r.target);
    });

    it("P4 NO feed move: two UPS in series carrying the merged room ($240)", () => {
        const made = start("two_utilities");
        // merge both PDUs behind transformer 2 (index 2), then insert 2 UPS
        const u1 = placeBuilding("ups", 9, 8);
        const u2 = placeBuilding("ups", 10, 8);
        expect(typeof u1).not.toBe("string");
        expect(typeof u2).not.toBe("string");
        connect(made[2], u1);
        connect(u1, u2);
        connect(u2, made[4]);
        connect(u2, made[5]);
        console.log("P4 spend:", 260 - STATE.money);
        const r = runLevel("two_utilities");
        console.log("P4 two-UPS-in-series:", JSON.stringify(r), "ratio", r.progress / r.target);
    });

    it("P5 NO feed move: one UPS per aisle ($240)", () => {
        const made = start("two_utilities");
        const u1 = placeBuilding("ups", 9, 6);
        const u2 = placeBuilding("ups", 9, 12);
        connect(made[2], u1); connect(u1, made[4]);
        connect(made[3], u2); connect(u2, made[5]);
        const r = runLevel("two_utilities");
        console.log("P5 one-UPS-per-aisle:", JSON.stringify(r), "ratio", r.progress / r.target);
    });

    it("P6 do nothing but buy 1 rack", () => {
        const made = start("two_utilities");
        const extra = placeBuilding("rack", 16, 20);
        connect(made[5], extra);
        const r = runLevel("two_utilities");
        console.log("P6 rack only:", JSON.stringify(r), "ratio", r.progress / r.target);
    });

    it("P7 feed placed at EXACTLY gridSize/2", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 15, 12);
        console.log("P7 utilityOf(gx=15):", utilityOf(feedB));
        connect(feedB, made[3]);
        connect(made[3], made[4]);
        const r = runLevel("two_utilities");
        console.log("P7 feed at gx=15:", JSON.stringify(r));
    });

    it("P8 feed at gx=14 (one tile short) — the near miss", () => {
        const made = start("two_utilities");
        const feedB = placeBuilding("grid_feed", 14, 12);
        console.log("P8 utilityOf(gx=14):", utilityOf(feedB));
        connect(feedB, made[3]);
        connect(made[3], made[4]);
        const r = runLevel("two_utilities");
        console.log("P8 feed at gx=14:", JSON.stringify(r));
    });
});
