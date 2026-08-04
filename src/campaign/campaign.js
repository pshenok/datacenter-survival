// Campaign engine: level lifecycle, scripted events, objective evaluation,
// unlock persistence. Pure sim module — reads CONFIG and STATE only, no DOM,
// no THREE, no timers, no randomness; localStorage access is typeof-guarded
// (node tests import this headless), following src/i18n.js.
//
// STATE fields owned by this module:
//   campaign      — { levelId, objectives, endsAt, done, outage }
//     levelId     null = survival/sandbox; every hook here is then a no-op
//     objectives  [{ type, target, holdSec?, value?, progress, done }]
//     endsAt      game time of the level's time limit
//     done        null while running; "won" | "failed" once resolved (the
//                 UI reacts to the transition, game.js freezes time)
//     outage      { active, endsAt } — the scripted grid outage window
//   demandFixedKw — pinned to the level's flat demand
//   money         — set to the level's startMoney at level start
//   brownout      — a scripted brownout is INJECTED here (active/factor/
//                   endsAt); sim/crisis.js ends it by its normal endsAt rule
//   heatwave/brownout/breakdown/contract .nextAt — pinned to Infinity so no
//                 random event or contract ever fires during a level (the
//                 modules only draw a schedule when nextAt === null)
// Building fields owned: offline (sources only, during the outage window).
//
// Objective semantics mirror sim/contracts.js exactly (same billing scale,
// same PUE gate, same streak-resets-to-zero rule) — a campaign objective is
// a contract the level is built around.

import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";

const BILLING_HOUR_SEC = 60;    // same scale as sim/demand.js
const PUE_MIN_IT_KW = 0.05;     // below this, PUE is undefined (HUD rule)
const DONE_KEY = "dc_campaign_done";
// Bonuses live under their OWN key: dc_campaign_done is a plain array of
// level ids and changing its shape would break every existing save.
const BONUS_KEY = "dc_campaign_bonus";

export function levelCfg(id) {
    return CONFIG.campaign.levels[id] || null;
}

export function levelOrder() {
    return CONFIG.campaign.chapters.flatMap((ch) => ch.levels);
}

// ---- unlock persistence (typeof-guarded like src/i18n.js) ----------------
export function completedLevels() {
    try {
        if (typeof localStorage === "undefined") return [];
        const raw = localStorage.getItem(DONE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function markCompleted(id) {
    try {
        if (typeof localStorage === "undefined") return;
        const done = completedLevels();
        if (!done.includes(id)) {
            done.push(id);
            localStorage.setItem(DONE_KEY, JSON.stringify(done));
        }
    } catch { /* storage unavailable — progress just doesn't persist */ }
}

// ---- bonus objectives ----------------------------------------------------
// A level's primary objectives teach the recipe; a bonus asks for the
// trade-off on top — "serve it AND hold PUE under 1.25". Optional by
// construction: they never gate a win, and every one of them is proven
// beatable AND genuinely skippable by a machine-play pair.
export function earnedBonuses() {
    try {
        if (typeof localStorage === "undefined") return {};
        const raw = localStorage.getItem(BONUS_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === "object" ? obj : {};
    } catch {
        return {};
    }
}

function markBonuses(levelId, ids) {
    if (ids.length === 0) return;
    try {
        if (typeof localStorage === "undefined") return;
        const all = earnedBonuses();
        const have = new Set(all[levelId] || []);
        for (const id of ids) have.add(id);
        all[levelId] = [...have];
        localStorage.setItem(BONUS_KEY, JSON.stringify(all));
    } catch { /* storage unavailable — the star just isn't kept */ }
}

// The first level is always open; each next unlocks when its predecessor in
// chapter order is completed.
export function isLevelUnlocked(id, done = completedLevels()) {
    const order = levelOrder();
    const i = order.indexOf(id);
    if (i <= 0) return i === 0;
    return done.includes(order[i - 1]);
}

// ---- level lifecycle -----------------------------------------------------
// State-side start only: the caller (game.js) owns the world reset and UI.
// Must run AFTER resetState() — it overrides the survival defaults.
export function startLevelState(id) {
    const cfg = levelCfg(id);
    if (!cfg) return false;

    STATE.money = cfg.startMoney;
    STATE.demandFixedKw = cfg.demandKw;

    // No random events, no contracts — a level runs only its script.
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;

    STATE.campaign = {
        levelId: id,
        objectives: cfg.objectives.map((o) => ({ ...o, progress: 0, done: false })),
        bonuses: (cfg.bonuses || []).map((o) => ({ ...o, progress: 0, done: false })),
        endsAt: cfg.timeLimitSec,
        done: null,
        reason: null,
    };
    return true;
}

// ---- scripted events -----------------------------------------------------
// One-shot fire at atSec (anchored to the scheduled time, the sim pattern).
// Scripted events are handed to their normal STATE homes (brownout/heatwave/
// gridOutage) and end by sim/crisis.js / sim/demand.js's own endsAt rules —
// the window alone is authoritative, so e.g. a grid feed placed mid-outage
// is exactly as dead as one that existed at fire time.
function runScript(cfg, elapsed) {
    for (const ev of cfg.script) {
        if (elapsed < ev.atSec || elapsed - ev.atSec > 1) continue; // fire window
        if (ev.kind === "brownout" && !STATE.brownout.active) {
            STATE.brownout.active = true;
            STATE.brownout.factor = ev.factor;
            STATE.brownout.endsAt = ev.atSec + ev.durationSec;
        } else if (ev.kind === "heatwave" && !STATE.heatwave.active) {
            STATE.heatwave.active = true;
            STATE.heatwave.endsAt = ev.atSec + ev.durationSec;
        } else if (ev.kind === "outage" && !STATE.gridOutage.active) {
            STATE.gridOutage.active = true;
            // Default "all" keeps every earlier level (and the mid-outage
            // exploit test) on exactly the behaviour they were written for.
            STATE.gridOutage.scope = ev.scope || "all";
            STATE.gridOutage.endsAt = ev.atSec + ev.durationSec;
        } else if (ev.kind === "tariff" && !STATE.tariff.active) {
            STATE.tariff.active = true;
            STATE.tariff.multiplier = ev.multiplier;
            STATE.tariff.endsAt = ev.atSec + ev.durationSec;
        }
    }
}

// ---- objective evaluation (sim/contracts.js semantics) -------------------
// Streak objectives (pue_below / no_throttle) only start counting at
// afterSec: a cold empty room trivially satisfies both conditions, so
// without the gate a level would be "won" before its heat ever arrives.
function evaluateObjective(o, dt, elapsed) {
    const gated = (o.afterSec || 0) > elapsed;
    switch (o.type) {
        case "serve_kwh":
            o.progress += STATE.servedKw * dt / BILLING_HOUR_SEC;
            if (o.progress >= o.target) o.done = true;
            break;
        // Resilience is proven DURING the failure, not averaged over the calm
        // minutes around it. A total-kWh objective quietly counts energy
        // banked before the lights went out — this one only counts what the
        // facility served while the event was live.
        case "serve_kwh_during_event": {
            const live = o.event === "brownout" ? STATE.brownout.active
                : o.event === "heatwave" ? STATE.heatwave.active
                    : STATE.gridOutage.active;
            if (live) o.progress += STATE.servedKw * dt / BILLING_HOUR_SEC;
            if (o.progress >= o.target) o.done = true;
            break;
        }
        case "pue_below": {
            const ok = !gated
                && STATE.itDrawKw > PUE_MIN_IT_KW
                && STATE.totalDrawKw / STATE.itDrawKw < o.value;
            o.progress = ok ? o.progress + dt : 0;
            if (o.progress >= o.holdSec) o.done = true;
            break;
        }
        // Evaluated only when the level resolves (see resolve()): "finish
        // with money left" is a statement about the end, not a streak, and
        // it gives bonuses an axis the primary objectives never use — buy
        // less, risk more.
        case "money_at_least":
            break;
        case "no_throttle": {
            if (gated) {
                o.progress = 0;
                break;
            }
            let poweredRacks = 0;
            let throttled = 0;
            for (const b of STATE.buildings) {
                if (b.type !== "rack") continue;
                if (b.powered) poweredRacks++;
                if (b.throttleFactor < 1) throttled++;
            }
            o.progress = poweredRacks > 0 && throttled === 0 ? o.progress + dt : 0;
            if (o.progress >= o.holdSec) o.done = true;
            break;
        }
    }
}

// Main tick — runs LAST in the game.js pipeline, judging THIS tick's facts
// (the contracts rule). dt guard matches every sim module. A resolved level
// (done !== null) freezes evaluation; standard gameOver counts as a loss.
export function tickCampaign(dt, elapsed) {
    const camp = STATE.campaign;
    if (camp.levelId === null || camp.done !== null) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    if (STATE.gameOver !== null) {
        resolve(camp, "failed", "fail_" + STATE.gameOver);
        return;
    }

    const cfg = levelCfg(camp.levelId);
    runScript(cfg, elapsed);

    // Level-scoped floors: survival's bankruptcyAt (-500) is far below a
    // level's startMoney, so without these a provably-dead run is watched
    // for its full time limit. Retry latency is difficulty nobody budgeted.
    // Checked BEFORE the objective sweep only after it — see below — so a
    // player who has already met every objective can never be killed by one.
    const floors = cfg.failConditions || CONFIG.campaign.failConditions;

    let allDone = true;
    for (const o of camp.objectives) {
        if (!o.done) evaluateObjective(o, dt, elapsed);
        if (!o.done) allDone = false;
    }
    // Bonuses are scored on the same facts but excluded from allDone —
    // optional by construction, not by convention.
    for (const b of camp.bonuses) {
        if (!b.done) evaluateObjective(b, dt, elapsed);
    }

    if (allDone) {
        // End-state bonuses are judged now, on the books as they close.
        for (const b of camp.bonuses) {
            if (b.type === "money_at_least" && STATE.money >= b.target) b.done = true;
        }
        resolve(camp, "won");
        markCompleted(camp.levelId);
        markBonuses(camp.levelId, camp.bonuses.filter((b) => b.done).map((b) => b.id));
    } else if (floors && floors.repBelow !== undefined && STATE.reputation < floors.repBelow) {
        resolve(camp, "failed", "fail_rep");
    } else if (floors && floors.moneyBelow !== undefined && STATE.money < floors.moneyBelow) {
        resolve(camp, "failed", "fail_money");
    } else if (elapsed >= camp.endsAt) {
        resolve(camp, "failed", "fail_time");
    }
}

// Every resolution path closes a scripted outage window: with the level
// resolved the schedules stay pinned to Infinity, so nothing else would
// ever end an active outage and the grid would stay dead behind the modal.
// reason names WHY it ended, for the debrief.
function resolve(camp, verdict, reason = null) {
    camp.done = verdict;
    camp.reason = reason;
    STATE.gridOutage.active = false;
    STATE.tariff.active = false;
    STATE.tariff.multiplier = 1;
}
