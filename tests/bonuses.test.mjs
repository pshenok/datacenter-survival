// Bonus objectives — the trade-off on top of the recipe.
//
// The contract every bonus must satisfy is a PAIR: one build that earns it
// and one WINNING build that does not. A bonus nobody can take is decoration;
// a bonus everybody takes for free is not a choice.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickCampaign, startLevelState, levelCfg } from "../src/campaign/campaign.js";
import { placeBuilding, connect, resetWireIds } from "../src/sim/build.js";

const DT = 0.05;
const rngZero = () => 0;
const place = (t, gx, gz) => placeBuilding(t, gx, gz);

function play(id, build) {
    resetState();
    resetBuildingIds();
    resetWireIds();
    startLevelState(id);
    build();
    const limit = levelCfg(id).timeLimitSec + 5;
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
    }
    return STATE.campaign;
}

// feed -> transformer -> ups -> pdu at row z
function chain(z) {
    const f = place("grid_feed", 2, z);
    const x = place("transformer", 5, z);
    const u = place("ups", 8, z);
    const p = place("pdu", 11, z);
    connect(f, x);
    connect(x, u);
    connect(u, p);
    return p;
}

const bonus = (camp, id) => camp.bonuses.find((b) => b.id === id);

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("bonuses are optional by construction", () => {
    it("never gate a win — a level with an unearned bonus still resolves won", () => {
        const camp = play("dark_chain", () => {
            const p = chain(6);
            connect(p, place("rack", 14, 5));
            connect(p, place("rack", 14, 7));
            for (const [gx, gz] of [[15, 6], [13, 6]]) connect(p, place("crac", gx, gz));
        });
        expect(camp.done).toBe("won");
        expect(bonus(camp, "thrift").done).toBe(false);   // spent too much
    });

    it("are declared with an id, so progress can be stored per level", () => {
        for (const [id, cfg] of Object.entries(CONFIG.campaign.levels)) {
            for (const b of cfg.bonuses || []) {
                expect(b.id, `${id} bonus needs an id`).toBeTruthy();
                expect(typeof b.type).toBe("string");
            }
        }
    });

    it("are never the same axis as the level's own objective", () => {
        // A harder target of the SAME type is unreachable: meeting the
        // primary ends the level before the bonus can pass it.
        for (const [id, cfg] of Object.entries(CONFIG.campaign.levels)) {
            const primary = new Set(cfg.objectives.map((o) => o.type));
            for (const b of cfg.bonuses || []) {
                expect(primary.has(b.type), `${id}: bonus '${b.id}' duplicates an objective type`).toBe(false);
            }
        }
    });
});

describe("sag / headroom — serving THROUGH the sag, not around it", () => {
    function sagRoom(feeds) {
        const pdus = [];
        for (const z of feeds) pdus.push(chain(z));
        const racks = [[14, 4], [14, 6], [14, 12], [14, 14]];
        racks.forEach(([gx, gz], i) => connect(pdus[i < 2 ? 0 : pdus.length - 1], place("rack", gx, gz)));
        connect(pdus[0], place("crac", 15, 5));
        connect(pdus[pdus.length - 1], place("crac", 15, 13));
    }

    it("EARNED by the two-feed build that actually has headroom", () => {
        const camp = play("sag", () => sagRoom([5, 13]));
        expect(camp.done).toBe("won");
        expect(bonus(camp, "headroom").done).toBe(true);
    });

    it("SKIPPED by a single-feed build — which is exactly the trade-off", () => {
        const camp = play("sag", () => {
            const p = chain(5);
            for (const [gx, gz] of [[14, 4], [14, 6], [14, 12]]) connect(p, place("rack", gx, gz));
            connect(p, place("crac", 15, 5));
        });
        expect(bonus(camp, "headroom").done).toBe(false);
    });
});

describe("dark_chain / thrift — the money you did not spend", () => {
    it("EARNED by the lean build that bridges the dark with one CRAC", () => {
        const camp = play("dark_chain", () => {
            const p = chain(6);
            connect(p, place("rack", 14, 5));
            connect(p, place("rack", 14, 7));
            connect(p, place("crac", 15, 6));
        });
        expect(camp.done).toBe("won");
        expect(bonus(camp, "thrift").done).toBe(true);
        expect(STATE.money).toBeGreaterThanOrEqual(levelCfg("dark_chain").bonuses[0].target);
    });

    it("is judged on the books as they CLOSE, not on a lucky moment mid-run", () => {
        const camp = play("dark_chain", () => {
            const p = chain(6);
            connect(p, place("rack", 14, 5));
            connect(p, place("rack", 14, 7));
            connect(p, place("crac", 15, 6));
        });
        // money_at_least accrues no progress — it is an end-state question.
        expect(bonus(camp, "thrift").progress).toBe(0);
        expect(bonus(camp, "thrift").done).toBe(true);
    });
});
