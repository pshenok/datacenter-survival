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
    // power accounting (owned by sim/power.js)
    itDrawKw: 0,            // racks only — the PUE denominator
    totalDrawKw: 0,         // racks + cooling — what the power bill charges

    // economy & standing
    money: CONFIG.economy.startMoney,
    reputation: CONFIG.sla.startReputation,

    // events (owned by sim/events.js)
    heatwave: { active: false, endsAt: 0, nextAt: CONFIG.events.heatwave.firstAtSec },

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
    STATE.itDrawKw = 0;
    STATE.totalDrawKw = 0;
    STATE.money = CONFIG.economy.startMoney;
    STATE.reputation = CONFIG.sla.startReputation;
    STATE.heatwave = { active: false, endsAt: 0, nextAt: CONFIG.events.heatwave.firstAtSec };
    STATE.gameOver = null;
}

// Heat-field indexing helpers (world grid coords are 0..gridSize-1).
export function heatIndex(gx, gz) {
    return gz * CONFIG.gridSize + gx;
}
