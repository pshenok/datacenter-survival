// The single mutable world state. Sim modules mutate exactly the fields they
// own (documented per module); UI reads everything, writes nothing.
import { CONFIG } from "./config.js";

export const STATE = {
    // lifecycle
    isRunning: false,
    timeScale: 1,           // 0 = paused; every system freezes on 0
    elapsedGameTime: 0,

    // world
    buildings: [],          // Building instances (entities/Building.js)
    wires: [],              // { id, from, to, mesh } — power edges, from parent to child

    // heat field, row-major gridSize x gridSize, degrees-ish
    heatField: new Float32Array(CONFIG.gridSize * CONFIG.gridSize).fill(CONFIG.heat.ambientC),

    // demand & delivery (owned by sim/demand.js)
    demandKw: 0,
    servedKw: 0,
    // Campaign override: when not null, tickDemand uses this flat kW instead
    // of the survival curve (and ignores waves). Owned by campaign/campaign.js.
    demandFixedKw: null,
    // power accounting (owned by sim/power.js)
    itDrawKw: 0,            // racks only — the PUE denominator
    totalDrawKw: 0,         // racks + cooling — what the power bill charges

    // economy & standing
    money: CONFIG.economy.startMoney,
    reputation: CONFIG.sla.startReputation,

    // events (owned by sim/events.js)
    heatwave: { active: false, endsAt: 0, nextAt: CONFIG.events.heatwave.firstAtSec },

    // crisis events (owned by sim/crisis.js). nextAt === null means "not
    // scheduled yet" — the first valid tick draws it from the rng, keeping
    // Math.random out of module/state scope. power.js reads brownout.
    brownout: { active: false, endsAt: 0, nextAt: null, factor: 1 },
    breakdown: { nextAt: null },

    // rolling mini-contract (owned by sim/contracts.js). key === null means
    // no contract yet; done: null while running, "paid" | "failed" once
    // resolved (the resolved contract stays visible until the next draw).
    contract: { id: 0, key: null, progress: 0, target: 0, reward: 0, endsAt: 0, done: null, nextAt: null },

    // campaign (owned by campaign/campaign.js). levelId === null means
    // survival/sandbox — every campaign hook is a no-op.
    campaign: { levelId: null, objectives: [], endsAt: 0, done: null, outage: { active: false, endsAt: 0 } },

    // meta
    gameOver: null,         // null | "bankrupt" | "reputation"
    sound: null,
};

export function resetState() {
    STATE.isRunning = false;
    STATE.timeScale = 1;
    STATE.elapsedGameTime = 0;
    STATE.buildings = [];
    STATE.wires = [];
    STATE.heatField = new Float32Array(CONFIG.gridSize * CONFIG.gridSize).fill(CONFIG.heat.ambientC);
    STATE.demandKw = 0;
    STATE.servedKw = 0;
    STATE.demandFixedKw = null;
    STATE.itDrawKw = 0;
    STATE.totalDrawKw = 0;
    STATE.money = CONFIG.economy.startMoney;
    STATE.reputation = CONFIG.sla.startReputation;
    STATE.heatwave = { active: false, endsAt: 0, nextAt: CONFIG.events.heatwave.firstAtSec };
    STATE.brownout = { active: false, endsAt: 0, nextAt: null, factor: 1 };
    STATE.breakdown = { nextAt: null };
    STATE.contract = { id: 0, key: null, progress: 0, target: 0, reward: 0, endsAt: 0, done: null, nextAt: null };
    STATE.campaign = { levelId: null, objectives: [], endsAt: 0, done: null, outage: { active: false, endsAt: 0 } };
    STATE.gameOver = null;
}

// Heat-field indexing helpers (world grid coords are 0..gridSize-1).
export function heatIndex(gx, gz) {
    return gz * CONFIG.gridSize + gx;
}
