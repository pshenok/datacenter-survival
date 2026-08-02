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
    STATE.contract.nextAt = Infinity;

    STATE.campaign = {
        levelId: id,
        objectives: cfg.objectives.map((o) => ({ ...o, progress: 0, done: false })),
        endsAt: cfg.timeLimitSec,
        done: null,
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
            STATE.gridOutage.endsAt = ev.atSec + ev.durationSec;
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
        case "pue_below": {
            const ok = !gated
                && STATE.itDrawKw > PUE_MIN_IT_KW
                && STATE.totalDrawKw / STATE.itDrawKw < o.value;
            o.progress = ok ? o.progress + dt : 0;
            if (o.progress >= o.holdSec) o.done = true;
            break;
        }
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
        resolve(camp, "failed");
        return;
    }

    const cfg = levelCfg(camp.levelId);
    runScript(cfg, elapsed);

    let allDone = true;
    for (const o of camp.objectives) {
        if (!o.done) evaluateObjective(o, dt, elapsed);
        if (!o.done) allDone = false;
    }

    if (allDone) {
        resolve(camp, "won");
        markCompleted(camp.levelId);
    } else if (elapsed >= camp.endsAt) {
        resolve(camp, "failed");
    }
}

// Every resolution path closes a scripted outage window: with the level
// resolved the schedules stay pinned to Infinity, so nothing else would
// ever end an active outage and the grid would stay dead behind the modal.
function resolve(camp, verdict) {
    camp.done = verdict;
    STATE.gridOutage.active = false;
}
