// Campaign engine: level lifecycle, scripted events, objective evaluation,
// unlock persistence. Pure sim module — reads CONFIG and STATE only, no DOM,
// no THREE, no timers, no randomness; localStorage access is typeof-guarded
// (node tests import this headless), following src/i18n.js.
//
// STATE fields owned by this module:
//   campaign      — { levelId, objectives, endsAt, done, outage }
//     levelId     null = survival/sandbox; every hook here is then a no-op
//     objectives  [{ type, target, holdSec?, value?, progress, done, failed }]
//                 failed is true only for "maintenance_without_loss" — the
//                 one objective type that can end a level on its own (see
//                 tickCampaign's objective sweep)
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
import { activeOrderCount, initMaintenance } from "../sim/maintenance.js";

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
//
// `alwaysUnlocked` opts a level out of that chain entirely. The Lab is worth
// nothing behind thirteen wins: you want to rehearse the transfer switch
// BEFORE fuel_clock asks you to use it, not after you have beaten the game.
// The flag opens ITS OWN level and nothing else — it is not a completion, so
// nothing downstream moves (tests/lab.test.mjs pins that, and pins the other
// half of the deal too: an alwaysUnlocked level must never be another
// level's predecessor, because a level that can never be COMPLETED would
// gate everything after it forever).
export function isLevelUnlocked(id, done = completedLevels()) {
    const order = levelOrder();
    const i = order.indexOf(id);
    if (i < 0) return false;
    const cfg = levelCfg(id);
    if (cfg && cfg.alwaysUnlocked) return true;
    if (i === 0) return true;
    return done.includes(order[i - 1]);
}

// The "next level" after a win: the first FOLLOWING level in levelOrder()
// that is not itself alwaysUnlocked. The Lab sits last in levelOrder() so it
// is reachable from a fresh profile (see isLevelUnlocked above), but that
// same position would otherwise make it look like "level 14" the moment a
// player wins night_shift, the campaign finale. alwaysUnlocked already means
// "not a completion, opts out of the unlock chain" — this is the same idea
// applied to the OTHER direction of that chain: a level nothing can complete
// must not be what "next" resolves to, either. Returns null when there is no
// such level, which is what lets the campaign actually end.
export function nextLevelId(id) {
    const order = levelOrder();
    for (let i = order.indexOf(id) + 1; i < order.length; i++) {
        const cfg = levelCfg(order[i]);
        if (!cfg || !cfg.alwaysUnlocked) return order[i];
    }
    return null;
}

// ---- level lifecycle -----------------------------------------------------
// State-side start only: the caller (game.js) owns the world reset and UI.
// Must run AFTER resetState() — it overrides the survival defaults.
export function startLevelState(id) {
    const cfg = levelCfg(id);
    if (!cfg) return false;

    STATE.money = cfg.startMoney;
    STATE.demandFixedKw = cfg.demandKw;
    // The Lab's knobs (campaign/lab.js) are armed by exactly this flag and
    // refuse to write anything while it is false — so the whole feature is a
    // no-op in the thirteen proven levels and in survival. Written on EVERY
    // level start as a fresh literal, not only on the sandbox one: leaving
    // the previous run's overrides in place is how a room the player set to
    // 40 °C in the Lab follows them into hot_aisle.
    STATE.lab = { on: cfg.sandbox === true, ambientC: null, tariffBand: null };

    // No random events, no contracts — a level runs only its script.
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.drought.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
    // The day/night meter is per-level, and off unless the level teaches it.
    // Switching it on globally would re-price all twelve existing levels and
    // quietly invalidate the machine-played pairs that make them lessons.
    STATE.tariff.cycleOn = cfg.tariffCycle === true;
    // Work orders resolve against the room the level hands over, so this must
    // run AFTER applyPreBuilt. game.js calls it; see onLevelStart.
    STATE.maintenance = { orders: [] };

    STATE.campaign = {
        levelId: id,
        objectives: cfg.objectives.map((o) => ({ ...o, progress: 0, done: false, failed: false })),
        bonuses: (cfg.bonuses || []).map((o) => ({ ...o, progress: 0, done: false, failed: false })),
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
        applyScriptEvent(ev, ev.atSec);
    }
}

// Open ONE scripted window, anchored to atSec (the scheduled time, not frame
// timing — the sim pattern). Exported because The Lab's Fire buttons
// (campaign/lab.js) come through here too: a rehearsed outage has to be the
// same outage a level scripts, or the Lab teaches something the game does
// not do. Unknown kinds are silently skipped, which is why CONTRIBUTING
// warns that a typo produces a level that plays without its crisis.
//
// Returns whether anything actually opened. runScript ignores it — a script
// event that lands on an already-open window has always been a no-op — but
// the Lab needs it: a Fire button that silently does nothing reads as broken
// rather than as "that window is already open".
export function applyScriptEvent(ev, atSec) {
    if (ev.kind === "brownout" && !STATE.brownout.active) {
        STATE.brownout.active = true;
        STATE.brownout.factor = ev.factor;
        STATE.brownout.endsAt = atSec + ev.durationSec;
        return true;
    } else if (ev.kind === "heatwave" && !STATE.heatwave.active) {
        STATE.heatwave.active = true;
        STATE.heatwave.endsAt = atSec + ev.durationSec;
        return true;
    } else if (ev.kind === "outage" && !STATE.gridOutage.active) {
        STATE.gridOutage.active = true;
        // Default "all" keeps every earlier level (and the mid-outage
        // exploit test) on exactly the behaviour they were written for.
        STATE.gridOutage.scope = ev.scope || "all";
        STATE.gridOutage.endsAt = atSec + ev.durationSec;
        return true;
    } else if (ev.kind === "chiller_fail") {
        // Kills the plant, not a head: everything drinking from the loop
        // stops at once, which is the whole point of the lesson.
        for (const b of STATE.buildings) {
            if (b.type === "chiller" && !b.broken) {
                b.broken = true;
                b.repairAt = Infinity;   // this one does not self-heal
                return true;
            }
        }
    } else if (ev.kind === "tariff" && !STATE.tariff.active) {
        STATE.tariff.active = true;
        STATE.tariff.multiplier = ev.multiplier;
        STATE.tariff.endsAt = atSec + ev.durationSec;
        return true;
    } else if (ev.kind === "drought" && !STATE.drought.active) {
        // The water utility's peak window. Prices the tower and nothing else,
        // so a room with no evaporative plant cannot tell it happened.
        STATE.drought.active = true;
        STATE.drought.multiplier = ev.multiplier;
        STATE.drought.endsAt = atSec + ev.durationSec;
        return true;
    }
    return false;
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
        // The Tier III objective, and the only one that can FAIL a level
        // rather than merely not complete. Two ways to lose it, matching the
        // two ways a facility fails the standard: the work never happened,
        // or the work dropped the load.
        case "maintenance_without_loss": {
            const orders = STATE.maintenance.orders;
            if (orders.some((m) => m.state === "missed")) {
                o.failed = true;
                break;
            }
            // Judged ONLY while a window is open. A dip caused by a heatwave
            // or a trip is a different lesson with its own objective; this
            // one is about whether the work could be done safely.
            if (activeOrderCount() > 0 && STATE.demandKw > 0) {
                const ratio = STATE.servedKw / STATE.demandKw;
                if (ratio < o.minServedRatio) {
                    o.failed = true;
                    break;
                }
            }
            if (orders.length > 0 && orders.every((m) => m.state === "done")) o.done = true;
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

    const cfg = levelCfg(camp.levelId);

    // A SANDBOX level does not resolve. Not "an objective that can never
    // complete" — an explicit statement that this level has no verdict: the
    // objective sweep, the failConditions floors, the endsAt timeout and the
    // gameOver branch below are all skipped, and sim/demand.js declines to
    // set gameOver at all while STATE.lab.on, for the same reason. The Lab
    // is a rehearsal room; a rehearsal you can lose is a level.
    //
    // An EMPTY objective list would do the exact opposite of what it looks
    // like. The sweep below starts `allDone = true` and only an unfinished
    // objective clears it, so a level with no objectives resolves as WON on
    // its first tick — which is why the flag has to say "does not resolve"
    // rather than the level simply having nothing to do.
    //
    // The script still runs: a sandbox level may still declare one, and the
    // Lab's Fire buttons go through the same applyScriptEvent().
    if (cfg.sandbox) {
        runScript(cfg, elapsed);
        return;
    }

    if (STATE.gameOver !== null) {
        resolve(camp, "failed", "fail_" + STATE.gameOver);
        return;
    }

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
        // An objective that can FAIL is new: every other type can only fail
        // to complete, and the level ends on the clock or a floor. This ends
        // it immediately, because "you missed the maintenance window" is a
        // verdict, not a shortfall you can still recover from.
        if (o.failed) {
            resolve(camp, "failed", "fail_maintenance");
            return;
        }
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
    // The drought is a latched window like the two above: with the level
    // resolved every schedule stays pinned to Infinity, so nothing else would
    // ever close it and the water bill would stay at x12 behind the modal.
    STATE.drought.active = false;
    STATE.drought.multiplier = 1;
}

// Work orders index into the room applyPreBuilt just built, so this runs
// after it, not inside startLevelState.
export function startLevelMaintenance(id, built) {
    const cfg = levelCfg(id);
    initMaintenance(cfg && cfg.maintenance ? cfg.maintenance.orders : [], built);
}
