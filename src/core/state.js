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

    // Chilled-water loop (owned by sim/heat.js). Every CRAH drinks from one
    // shared pool: ratio < 1 means the plant is over-committed and EVERY
    // CRAH is throttled proportionally — the cooling analogue of a browned
    // out power link, and the price of shared efficiency.
    coolingLoop: { capacityUnits: 0, demandUnits: 0, ratio: 1 },

    // WATER — the other efficiency number, and the one that gets a facility
    // into the local newspaper. An evaporative tower rejects heat by boiling
    // water off, so a chilled-water loop has a running water bill that an
    // air-cooled CRAC simply does not.
    //   litersPerHour — the CURRENT evaporation rate, written by sim/heat.js
    //                   from the cooling actually delivered. Stated at the
    //                   billing scale (one game minute = one billing hour),
    //                   the same units the power bill speaks, so sim/demand.js
    //                   charges it with the identical rate * dt / 60 rule.
    //   totalLiters   — the run ledger, accumulated by sim/demand.js from
    //                   exactly what it billed, so the two can never diverge.
    //   itKwh         — WUE's denominator. The industry defines WUE as litres
    //                   per kWh of IT energy, so this is IT energy: NOT
    //                   facility energy (that is PUE's numerator) and not the
    //                   heat the plant rejected.
    water: { litersPerHour: 0, totalLiters: 0, itKwh: 0 },

    // DROUGHT (owned by sim/crisis.js): the water utility prices scarcity for
    // a window. Multiplies the water line in sim/demand.js and NOTHING else —
    // the exact shape of the peak tariff above, on the other utility. nextAt
    // === null means "not drawn yet"; campaign levels pin it to Infinity.
    drought: { active: false, endsAt: 0, nextAt: null, multiplier: 1 },

    // demand & delivery (owned by sim/demand.js)
    demandKw: 0,
    servedKw: 0,
    // Campaign override: when not null, tickDemand uses this flat kW instead
    // of the survival curve (and ignores waves). Owned by campaign/campaign.js.
    demandFixedKw: null,
    // power accounting (owned by sim/power.js)
    itDrawKw: 0,            // racks only — the PUE denominator
    totalDrawKw: 0,         // racks + cooling + UPS recharge — total facility
                             // draw; PUE's numerator, UNCHANGED in meaning by
                             // peak shaving (see batteryKw below)
    // kW of totalDrawKw sourced from a UPS buffer THIS tick (peak shaving),
    // not from the grid. The HUD reads it to show what the toggle is saving;
    // the meter no longer subtracts it, because gridKw below already counts
    // only what came off a feed.
    batteryKw: 0,
    // kW of totalDrawKw that actually came THROUGH A LIVE GRID FEED this
    // tick — the only quantity a utility may bill, and what sim/demand.js
    // bills. Everything else the facility drew came out of a generator or a
    // battery, both of which already pay for themselves (fuel, and the
    // recharge). Derived from the topology in sim/power.js, never from the
    // outage flag: a scoped outage and a generator-fed room on a perfectly
    // healthy grid are the same question, and only the topology answers both.
    gridKw: 0,

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
    // Grid OUTAGE: the city feed is DEAD (not sagging) — every grid_feed is a
    // dead root while active; generators and UPS buffers are the only power.
    // Survival schedules it randomly (sim/crisis.js); campaign levels pin
    // nextAt to Infinity and script the window directly (campaign/campaign.js).
    // scope: "all" kills every feed (the survival default and the shape the
    // early levels were written against); a utility tag ("A" | "B") kills
    // only the feeds on that side of the floor, which is what makes a
    // SECOND, INDEPENDENT substation worth paying for.
    gridOutage: { active: false, endsAt: 0, nextAt: null, scope: "all" },
    // PEAK TARIFF: the utility prices this window higher. Touches nothing in
    // the simulation — only the power bill in sim/demand.js is multiplied.
    // The only defence is having built efficiently before it opened.
    // The peak WINDOW (random, sim/crisis.js) and the day/night CYCLE
    // (deterministic, sim/demand.js) are separate facts that multiply on the
    // meter. cycleOn is opt-in so the levels proven against a flat meter stay
    // proven; cycleMul is what the cycle currently costs, band its name.
    tariff: {
        active: false, multiplier: 1, endsAt: 0, nextAt: null,
        cycleOn: false, cycleMul: 1, band: null,
    },

    // Scheduled work orders (owned by sim/maintenance.js). Empty outside the
    // levels that declare them, which is what keeps the mechanic invisible
    // everywhere it is not being taught.
    maintenance: { orders: [] },

    // rolling mini-contract (owned by sim/contracts.js). key === null means
    // no contract yet; done: null while running, "paid" | "failed" once
    // resolved (the resolved contract stays visible until the next draw).
    contract: { id: 0, key: null, progress: 0, target: 0, reward: 0, endsAt: 0, done: null, nextAt: null },

    // campaign (owned by campaign/campaign.js). levelId === null means
    // survival/sandbox — every campaign hook is a no-op.
    campaign: { levelId: null, objectives: [], bonuses: [], endsAt: 0, done: null, reason: null },

    // Loss attribution (owned by sim/attribution.js). tickKw decomposes THIS
    // tick's unserved demand by cause and must sum to it exactly; totalKwh is
    // the run's ledger; blame carries per-building shares for the floating
    // badges. Diagnostic only — nothing in the simulation reads it back.
    losses: { tickKw: {}, totalKwh: {}, blame: [] },

    // Peak shaving (owned by sim/power.js reading it; written only by the
    // player, via game.js's togglePeakShave — see src/ui/* boundary rule).
    // While on, a UPS with a live upstream and a charged buffer serves its
    // subtree from the buffer instead of the grid. Off by default: the
    // mechanic must be invisible until chosen, same as STATE.tariff.cycleOn.
    peakShave: { on: false },

    // THE LAB (owned by campaign/lab.js; written only by the player, through
    // game.js, exactly like peakShave above). A rehearsal room: the knobs
    // summon the phenomena the rest of the game puts on a schedule.
    //   on        — a level flagged `sandbox` is running. Set by
    //               startLevelState, false everywhere else, and the single
    //               condition every knob checks — which is what keeps the
    //               Lab inert in the thirteen proven levels and in survival.
    //   ambientC  — the heat field's ambient floor (sim/heat.js), or null
    //               for CONFIG.heat.ambientC. NEVER write CONFIG.
    //   tariffBand— a pinned day/night band key (sim/demand.js), or null to
    //               let the clock run the cycle.
    lab: { on: false, ambientC: null, tariffBand: null },

    // SEEDED RUN (owned by game.js, the composition root — the same place
    // STATE.peakShave.on and STATE.tariff.cycleOn are written; src/ui/* only
    // reads it). The normalized seed TOKEN of this run, or null for an
    // unseeded one. The token, never a generator: an rng in STATE would be a
    // function every reset has to remember to replace, and the streams
    // themselves are game.js's business (see src/core/rng.js). Survival only
    // — a campaign level pins every random schedule to Infinity, so a seed
    // there would be decoration, and game.js leaves this null for one.
    seed: null,

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
    STATE.coolingLoop = { capacityUnits: 0, demandUnits: 0, ratio: 1 };
    STATE.water = { litersPerHour: 0, totalLiters: 0, itKwh: 0 };
    STATE.drought = { active: false, endsAt: 0, nextAt: null, multiplier: 1 };
    STATE.demandKw = 0;
    STATE.servedKw = 0;
    STATE.demandFixedKw = null;
    STATE.itDrawKw = 0;
    STATE.totalDrawKw = 0;
    STATE.batteryKw = 0;
    STATE.gridKw = 0;
    STATE.money = CONFIG.economy.startMoney;
    STATE.reputation = CONFIG.sla.startReputation;
    STATE.heatwave = { active: false, endsAt: 0, nextAt: CONFIG.events.heatwave.firstAtSec };
    STATE.brownout = { active: false, endsAt: 0, nextAt: null, factor: 1 };
    STATE.breakdown = { nextAt: null };
    STATE.gridOutage = { active: false, endsAt: 0, nextAt: null, scope: "all" };
    STATE.tariff = {
        active: false, multiplier: 1, endsAt: 0, nextAt: null,
        cycleOn: false, cycleMul: 1, band: null,
    };
    STATE.maintenance = { orders: [] };
    STATE.contract = { id: 0, key: null, progress: 0, target: 0, reward: 0, endsAt: 0, done: null, nextAt: null };
    STATE.campaign = { levelId: null, objectives: [], bonuses: [], endsAt: 0, done: null, reason: null };
    STATE.losses = { tickKw: {}, totalKwh: {}, blame: [] };
    STATE.peakShave = { on: false };
    STATE.lab = { on: false, ambientC: null, tariffBand: null };
    // Severed like peakShave.on and tariff.cycleOn: game.js re-arms the seed
    // after clearWorld(), so a run can never inherit the previous one's.
    STATE.seed = null;
    STATE.gameOver = null;
}

// Heat-field indexing helpers (world grid coords are 0..gridSize-1).
export function heatIndex(gx, gz) {
    return gz * CONFIG.gridSize + gx;
}
