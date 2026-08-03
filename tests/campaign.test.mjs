// Campaign machine-play: every level is played by the test suite in BOTH
// directions — winnable with the mechanic it teaches, losable without it.
// The run loop mirrors game.js tick order exactly (events -> crisis ->
// demand -> power -> heat -> contracts -> campaign); rng is pinned where a
// module would draw (campaign levels pin every schedule to Infinity anyway).
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents, upcomingWave } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickContracts } from "../src/sim/contracts.js";
import {
    tickCampaign,
    startLevelState,
    levelCfg,
    levelOrder,
    isLevelUnlocked,
    completedLevels,
} from "../src/campaign/campaign.js";

const DT = 0.05;
const rngZero = () => 0;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// feed -> transformer -> ups? -> pdu, at a z-row offset so parallel chains
// don't share heat cells. Returns the fanout to hang loads on.
function chain(z, { ups = true } = {}) {
    const feed = place("grid_feed", 2, z);
    const xf = place("transformer", 5, z);
    wireBuildings(feed, xf);
    let tail = xf;
    if (ups) {
        const u = place("ups", 8, z);
        wireBuildings(xf, u);
        tail = u;
    }
    const pdu = place("pdu", 11, z);
    wireBuildings(tail, pdu);
    return { feed, xf, pdu, tail };
}

function runLevel(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
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

function buildCost() {
    return STATE.buildings.reduce((sum, b) => sum + b.config.cost, 0);
}

function start(id) {
    resetState();
    resetBuildingIds();
    expect(startLevelState(id)).toBe(true);
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

// ---- engine unit behaviour ----------------------------------------------

describe("campaign engine", () => {
    it("level start pins demand flat and freezes every random schedule", () => {
        start("first_watt");
        expect(STATE.money).toBe(levelCfg("first_watt").startMoney);
        expect(STATE.demandFixedKw).toBe(4);
        // The pins themselves — Infinity means "this schedule never draws".
        expect(STATE.heatwave.nextAt).toBe(Infinity);
        expect(STATE.brownout.nextAt).toBe(Infinity);
        expect(STATE.breakdown.nextAt).toBe(Infinity);
        expect(STATE.gridOutage.nextAt).toBe(Infinity);
        expect(STATE.tariff.nextAt).toBe(Infinity);
        expect(STATE.contract.nextAt).toBe(Infinity);
        runLevel(10);
        expect(STATE.demandKw).toBe(4);
        expect(STATE.heatwave.active).toBe(false);
        expect(STATE.brownout.active).toBe(false);
        expect(STATE.contract.key).toBeNull();
    });

    it("no survival wave is ever announced while demand is pinned", () => {
        start("first_watt");
        for (let t = 0; t < 250; t += 10) {
            expect(upcomingWave(t)).toBeNull();
        }
    });

    it("unlock order follows chapter order from the first level", () => {
        const order = levelOrder();
        expect(order[0]).toBe("first_watt");
        expect(isLevelUnlocked(order[0], [])).toBe(true);
        expect(isLevelUnlocked(order[1], [])).toBe(false);
        expect(isLevelUnlocked(order[1], [order[0]])).toBe(true);
        expect(isLevelUnlocked(order[4], [order[0], order[1]])).toBe(false);
    });

    it("a standard gameOver during a level resolves it as failed", () => {
        start("first_watt");
        STATE.gameOver = "bankrupt";
        runLevel(1);
        expect(STATE.campaign.done).toBe("failed");
    });

    it("scripted outage opens the window and closes it after durationSec", () => {
        start("dark_chain");
        const { pdu } = chain(5);
        const rack = place("rack", 14, 5);
        wireBuildings(pdu, rack);
        runLevel(41);
        expect(STATE.gridOutage.active).toBe(true);
        runLevel(8);
        expect(STATE.gridOutage.active).toBe(false);
    });

    it("a level resolving mid-outage closes the window on the way out", () => {
        start("dark_chain");
        // Empty room: reputation bleeds to game-over while the first outage
        // window is open — the resolve path must not leave the grid dead.
        runLevel(200);
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.gridOutage.active).toBe(false);
    });

    it("the death floors sit BELOW every winning run's worst moment", () => {
        // A floor tuned by intuition eventually kills a legitimate build.
        // This walks each level's canonical winning build and pins the
        // margin, so a future retune that crosses it turns red here.
        const floors = CONFIG.campaign.failConditions;
        const builds = {
            first_watt: () => {
                const { pdu } = chain(5);
                wireBuildings(pdu, place("rack", 14, 5));
            },
            hot_aisle: () => {
                const { tail, pdu } = chain(5);
                const pdu2 = place("pdu", 11, 8);
                wireBuildings(tail, pdu2);
                [[14, 5], [14, 7]].forEach(([gx, gz]) => wireBuildings(pdu, place("rack", gx, gz)));
                [[13, 6], [15, 6]].forEach(([gx, gz]) => wireBuildings(pdu2, place("crac", gx, gz)));
            },
        };
        for (const [id, build] of Object.entries(builds)) {
            start(id);
            build();
            let minRep = Infinity;
            let minMoney = Infinity;
            const cfgLvl = levelCfg(id);
            for (let i = 0; i < (cfgLvl.timeLimitSec + 5) / DT; i++) {
                if (STATE.campaign.done !== null) break;
                STATE.elapsedGameTime += DT;
                const t = STATE.elapsedGameTime;
                tickEvents(DT, t);
                tickCrisis(DT, t, rngZero);
                tickDemand(DT, t);
                resolvePower(DT);
                tickHeat(DT);
                tickCampaign(DT, t);
                minRep = Math.min(minRep, STATE.reputation);
                minMoney = Math.min(minMoney, STATE.money);
            }
            expect(STATE.campaign.done, `${id} still wins`).toBe("won");
            expect(minRep, `${id} rep margin`).toBeGreaterThan(floors.repBelow);
            expect(minMoney, `${id} money margin`).toBeGreaterThan(floors.moneyBelow);
        }
    });

    it("the money floor calls a bankrupt run early and by name", () => {
        start("the_bill");
        STATE.money = CONFIG.campaign.failConditions.moneyBelow - 1;
        STATE.elapsedGameTime = 5;
        tickCampaign(DT, STATE.elapsedGameTime);
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.campaign.reason).toBe("fail_money");
        expect(STATE.elapsedGameTime).toBeLessThan(levelCfg("the_bill").timeLimitSec);
    });

    it("a met objective beats a floor in the same tick — you cannot lose a won level", () => {
        start("first_watt");
        STATE.campaign.objectives.forEach((o) => { o.done = true; });
        STATE.reputation = 0;      // deep under the rep floor
        STATE.money = -10000;      // and under the money floor
        tickCampaign(DT, 1);
        expect(STATE.campaign.done).toBe("won");
    });

    it("won levels persist and unlock through the storage round-trip", () => {
        const store = new Map();
        globalThis.localStorage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        };
        try {
            start("first_watt");
            const { pdu } = chain(5);
            wireBuildings(pdu, place("rack", 14, 5));
            runLevel(120);
            expect(STATE.campaign.done).toBe("won");
            expect(JSON.parse(store.get("dc_campaign_done"))).toContain("first_watt");
            expect(completedLevels()).toContain("first_watt");
            expect(isLevelUnlocked("hot_aisle")).toBe(true);
        } finally {
            delete globalThis.localStorage;
        }
    });
});

// ---- the outage seam itself (power + assignment) -------------------------

describe("grid outage (offline source)", () => {
    it("a UPS-buffered chain serves through an outage; the same chain without a UPS goes dark", () => {
        // With UPS
        start("dark_chain");
        const withUps = chain(5);
        const r1 = place("rack", 14, 5);
        wireBuildings(withUps.pdu, r1);
        runLevel(42);   // inside the first outage window (40..46)
        const servedWithUps = STATE.servedKw;

        // Without UPS (transformer -> pdu is a legal edge)
        start("dark_chain");
        const noUps = chain(5, { ups: false });
        const r2 = place("rack", 14, 5);
        wireBuildings(noUps.pdu, r2);
        runLevel(42);
        const servedWithout = STATE.servedKw;

        expect(servedWithUps).toBeGreaterThan(0);
        expect(servedWithout).toBe(0);
    });
});

// ---- machine-play: every level, both directions --------------------------

describe("L1 first_watt", () => {
    it("WIN: the full chain serves the objective inside the limit", () => {
        start("first_watt");
        const { pdu } = chain(5);
        const rack = place("rack", 14, 5);
        wireBuildings(pdu, rack);
        expect(buildCost()).toBeLessThanOrEqual(levelCfg("first_watt").startMoney);
        runLevel(levelCfg("first_watt").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("won");
        expect(STATE.elapsedGameTime).toBeLessThan(levelCfg("first_watt").timeLimitSec);
    });

    it("LOSE: an unwired room hits the reputation floor long before the clock", () => {
        start("first_watt");
        place("grid_feed", 2, 5);
        place("rack", 14, 5); // never wired
        runLevel(levelCfg("first_watt").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
        // The level-scoped floor calls it early and by name — a dead run is
        // not watched for its full time limit.
        expect(STATE.campaign.reason).toBe("fail_rep");
        expect(STATE.elapsedGameTime).toBeLessThan(levelCfg("first_watt").timeLimitSec);
    });
});

describe("L2 hot_aisle", () => {
    it("WIN: in-radius CRACs hold a cool room through the permanent heatwave", () => {
        start("hot_aisle");
        const { tail, pdu } = chain(5);
        const pdu2 = place("pdu", 11, 8);
        wireBuildings(tail, pdu2);
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const cracs = [place("crac", 13, 6), place("crac", 15, 6)];
        cracs.forEach((c) => wireBuildings(pdu2, c));
        expect(buildCost()).toBeLessThanOrEqual(levelCfg("hot_aisle").startMoney);

        // The afterSec gate: a perfectly cool room holds ZERO streak progress
        // until the gate opens — deleting the gate turns this red.
        const obj = levelCfg("hot_aisle").objectives[0];
        runLevel(obj.afterSec - 5);
        expect(STATE.campaign.done).toBeNull();
        expect(STATE.campaign.objectives[0].progress).toBe(0);

        runLevel(levelCfg("hot_aisle").timeLimitSec + 5);
        expect(STATE.heatwave.active).toBe(true);   // the scripted wave stays on
        expect(STATE.campaign.done).toBe("won");
        expect(STATE.elapsedGameTime).toBeGreaterThanOrEqual(obj.afterSec + obj.holdSec);
    });

    it("LOSE: the same racks with no cooling throttle in the heatwave and time out", () => {
        start("hot_aisle");
        const { pdu } = chain(5);
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        runLevel(levelCfg("hot_aisle").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
        expect(racks.some((r) => r.throttleFactor < 1)).toBe(true);
    });
});

describe("L3 the_bill", () => {
    function denseAisle(pduA, pduB) {
        const racks = [
            place("rack", 14, 5), place("rack", 15, 5),
            place("rack", 14, 6), place("rack", 15, 6),
        ];
        wireBuildings(pduA, racks[0]);
        wireBuildings(pduA, racks[1]);
        wireBuildings(pduB, racks[2]);
        wireBuildings(pduB, racks[3]);
        return racks;
    }

    // The intended solve: the MINIMUM cooling that holds the aisle.
    it("WIN: two in-radius CRACs keep the dense aisle cool AND efficient", () => {
        start("the_bill");
        const { tail, pdu } = chain(3);
        const pdu2 = place("pdu", 11, 8);
        wireBuildings(tail, pdu2);
        denseAisle(pdu, pdu2);
        const pdu3 = place("pdu", 11, 11);
        wireBuildings(tail, pdu3);
        const cracs = [place("crac", 13, 5), place("crac", 16, 6)];
        cracs.forEach((c) => wireBuildings(pdu3, c));
        expect(buildCost()).toBeLessThanOrEqual(levelCfg("the_bill").startMoney);
        runLevel(levelCfg("the_bill").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("won");
    });

    it("LOSE: over-cooling — four CRACs hold the aisle but blow the PUE cap", () => {
        // Impossible to express before CRAC part-load draw: under a linear
        // model four quarter-duty units cost exactly what one full unit does,
        // so over-provisioned cooling was free. Now idle draw makes it the
        // other way a player can fail this level.
        start("the_bill");
        const { tail, pdu } = chain(3);
        const pdu2 = place("pdu", 11, 8);
        wireBuildings(tail, pdu2);
        denseAisle(pdu, pdu2);
        const pdu3 = place("pdu", 11, 11);
        wireBuildings(tail, pdu3);
        for (const [gx, gz] of [[13, 5], [16, 6], [14, 7], [13, 7]]) {
            wireBuildings(pdu3, place("crac", gx, gz));
        }
        runLevel(levelCfg("the_bill").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
        const cool = STATE.campaign.objectives.find((o) => o.type === "no_throttle");
        const pue = STATE.campaign.objectives.find((o) => o.type === "pue_below");
        expect(cool.done).toBe(true);    // the room IS cool…
        expect(pue.done).toBe(false);    // …and that is exactly the problem
    });

    it("LOSE: no cooling at all — the summer heat throttles the dense aisle", () => {
        start("the_bill");
        const { tail, pdu } = chain(3);
        const pdu2 = place("pdu", 11, 8);
        wireBuildings(tail, pdu2);
        const racks = denseAisle(pdu, pdu2);
        runLevel(levelCfg("the_bill").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
        expect(racks.some((r) => r.throttleFactor < 1)).toBe(true);
    });

    it("LOSE: CRACs parked outside the radius don't save the aisle — no_throttle is the failing objective", () => {
        start("the_bill");
        const { tail, pdu } = chain(3);
        const pdu2 = place("pdu", 11, 8);
        wireBuildings(tail, pdu2);
        denseAisle(pdu, pdu2);
        const pdu3 = place("pdu", 11, 11);
        wireBuildings(tail, pdu3);
        // Far CRACs: outside Chebyshev radius 3 of every rack, in the pool.
        const cracs = [place("crac", 21, 6), place("crac", 23, 6), place("crac", 21, 8)];
        cracs.forEach((c) => wireBuildings(pdu3, c));
        runLevel(levelCfg("the_bill").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
        const noThrottle = STATE.campaign.objectives.find((o) => o.type === "no_throttle");
        expect(noThrottle.done).toBe(false);
    });

    it("pue_below is load-bearing: an inefficient facility holds zero streak, an efficient one completes", () => {
        // Semantics unit against pinned power accounting (the contracts.js
        // test pattern): tickCampaign alone, no power resolution. An
        // always-true pue_below mutant turns both halves red.
        start("the_bill");
        const DT = 0.05;
        const obj = () => STATE.campaign.objectives.find((o) => o.type === "pue_below");
        const cfg = levelCfg("the_bill").objectives.find((o) => o.type === "pue_below");

        // PUE 1.5 — above the 1.35 cap: the streak must never start.
        STATE.itDrawKw = 10;
        STATE.totalDrawKw = 15;
        for (let t = 0; t < cfg.afterSec + cfg.holdSec + 10; t += DT) {
            STATE.elapsedGameTime = t;
            tickCampaign(DT, t);
        }
        expect(obj().progress).toBe(0);
        expect(obj().done).toBe(false);

        // PUE 1.2 — under the cap: the streak completes in holdSec.
        STATE.totalDrawKw = 12;
        for (let t = 0; t < cfg.holdSec + 5 && !obj().done; t += DT) {
            STATE.elapsedGameTime += DT;
            tickCampaign(DT, STATE.elapsedGameTime);
        }
        expect(obj().done).toBe(true);
    });
});

describe("L4 sag", () => {
    function sagRacksAndCooling(pduA, pduB) {
        const racks = [
            place("rack", 14, 4), place("rack", 14, 6),
            place("rack", 14, 12), place("rack", 14, 14),
        ];
        wireBuildings(pduA, racks[0]);
        wireBuildings(pduA, racks[1]);
        wireBuildings(pduB, racks[2]);
        wireBuildings(pduB, racks[3]);
        const cracs = [place("crac", 15, 5), place("crac", 15, 13)];
        wireBuildings(pduA, cracs[0]);
        wireBuildings(pduB, cracs[1]);
    }

    it("WIN: two feeds keep headroom through the sag", () => {
        start("sag");
        const a = chain(5);
        const b = chain(13);
        sagRacksAndCooling(a.pdu, b.pdu);
        expect(buildCost()).toBeLessThanOrEqual(levelCfg("sag").startMoney);
        runLevel(levelCfg("sag").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("won");
    });

    it("LOSE: one feed clips hard through the sag and misses the target", () => {
        start("sag");
        const a = chain(5);
        const pdu2 = place("pdu", 11, 13);
        wireBuildings(a.tail, pdu2);   // same single feed carries everything
        sagRacksAndCooling(a.pdu, pdu2);
        runLevel(levelCfg("sag").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
    });
});

describe("L5 dark_chain", () => {
    function darkLoads(pdu) {
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const crac = place("crac", 15, 6);
        wireBuildings(pdu, crac);
    }

    it("WIN: a charged UPS carries all three outages", () => {
        start("dark_chain");
        const { pdu } = chain(6);
        darkLoads(pdu);
        expect(buildCost()).toBeLessThanOrEqual(levelCfg("dark_chain").startMoney);
        runLevel(levelCfg("dark_chain").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("won");
    });

    it("LOSE: the same chain without a UPS goes dark three times and misses the target on the clock", () => {
        start("dark_chain");
        const { pdu } = chain(6, { ups: false });
        darkLoads(pdu);
        runLevel(levelCfg("dark_chain").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("failed");
        // A genuine timeout — the facility survives, the target doesn't.
        expect(STATE.gameOver).toBeNull();
        expect(STATE.elapsedGameTime).toBeGreaterThanOrEqual(levelCfg("dark_chain").timeLimitSec);
    });

    it("bans the generator — and the ban is load-bearing: the forbidden build would win", () => {
        // (a) the config seam the UI gate reads:
        expect(levelCfg("dark_chain").banned).toContain("generator");
        // (b) machine-play the build the ban forbids (UPS-less chain + standby
        // generator, cost 860 ≤ 1200): it WINS, proving the level's UPS lesson
        // needs the gate. The gate itself lives in the UI layer
        // (handlers.placeBuilding), so the config field is the tested seam.
        start("dark_chain");
        const { xf, pdu } = chain(6, { ups: false });
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        wireBuildings(pdu, place("crac", 15, 6));
        const g = place("generator", 2, 9);
        wireBuildings(g, xf);
        runLevel(levelCfg("dark_chain").timeLimitSec + 5);
        expect(STATE.campaign.done).toBe("won");
    });

    it("LOSE: a spare feed placed MID-OUTAGE is just as dead — the exploit does not beat the level", () => {
        // The outage window kills every source, including one bought after
        // the lights went out. Without a UPS the money cannot buy the win.
        start("dark_chain");
        const { pdu } = chain(6, { ups: false });
        darkLoads(pdu);
        const DT = 0.05;
        let spareWired = false;
        for (let i = 0; i < (levelCfg("dark_chain").timeLimitSec + 5) / DT; i++) {
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
            // One second into the first outage, the player buys a fresh feed
            // and re-parents the transformer onto it.
            if (!spareWired && STATE.gridOutage.active) {
                const spare = place("grid_feed", 2, 9);
                const xf = STATE.buildings.find((b) => b.type === "transformer");
                wireBuildings(spare, xf);
                spareWired = true;
            }
        }
        expect(spareWired).toBe(true);
        expect(STATE.campaign.done).toBe("failed");
    });
});
