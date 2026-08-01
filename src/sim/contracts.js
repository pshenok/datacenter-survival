// Rolling mini-contracts: one active at a time, drawn from CONFIG.contracts
// .pool, evaluated per tick against the sim facts of THIS tick (game.js runs
// tickContracts after demand/power/heat), paid on completion, failed on
// window expiry. Pure sim module — reads CONFIG and STATE only, no DOM, no
// THREE, no timers, no Math.random at module scope: every random draw goes
// through the rng parameter (default Math.random; tests pass a seeded one).
//
// STATE fields owned by this module:
//   contract — { id, key, progress, target, reward, endsAt, done, nextAt }
//     id       increments per draw (0 = none ever drawn)
//     key      pool key of the active/last contract; null before the first
//     progress kWh served (serve_kwh), streak seconds (pue_hold /
//              no_throttle), or max instantaneous servedKw (peak_kw)
//     done     null while running; "paid" | "failed" once resolved — the
//              resolved contract stays in STATE until the next draw so the
//              UI can react to the transition
//     nextAt   game time of the next draw; null = not scheduled yet (first
//              valid tick draws it — the demand.js heatwave pattern)
//   money    — credited with reward on completion (once).
//
// Targets that scale with demand (serve_kwh, peak_kw) are computed from
// STATE.demandKw at draw time, so an early contract is winnable and a late
// one is not a freebie. served <= demand always (sim/demand.js), so both
// demandShare factors stay below 1. kWh uses the documented billing scale
// (one game minute = one billing hour): kWh accrued = servedKw * dt / 60.
//
// Redraw pacing: a draw schedules nextAt = drawTime + interval; when a
// window outlives the interval the next draw lands right after resolution
// ("rolling"), pushed back by redrawGraceSec so the resolution banner is
// readable before the next offer replaces it.

import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";

const BILLING_HOUR_SEC = 60;    // same scale as sim/demand.js
const PUE_MIN_IT_KW = 0.05;     // below this, PUE is undefined (HUD rule)

function span(minSec, maxSec, rng) {
    return minSec + (maxSec - minSec) * rng();
}

function poolCfg(key) {
    return CONFIG.contracts.pool.find((p) => p.key === key) || null;
}

function targetFor(pick) {
    switch (pick.key) {
        case "serve_kwh":
            return Math.max(pick.minTarget,
                Math.round(STATE.demandKw * pick.demandShare * pick.windowSec / BILLING_HOUR_SEC));
        case "peak_kw":
            return Math.max(pick.minTarget, Math.round(STATE.demandKw * pick.demandShare));
        default: // pue_hold / no_throttle hold a condition for holdSec
            return pick.holdSec;
    }
}

// Advance progress for the active contract. Streak contracts reset to 0 the
// moment the condition breaks — "continuously" means continuously.
function evaluate(c, dt) {
    const cfg = poolCfg(c.key);
    switch (c.key) {
        case "serve_kwh":
            c.progress += STATE.servedKw * dt / BILLING_HOUR_SEC;
            break;
        case "pue_hold": {
            const ok = STATE.itDrawKw > PUE_MIN_IT_KW
                && STATE.totalDrawKw / STATE.itDrawKw < cfg.pueBelow;
            c.progress = ok ? c.progress + dt : 0;
            break;
        }
        case "no_throttle": {
            // Needs at least one POWERED rack (an empty room is not a win)
            // and no rack anywhere below full throttle.
            let poweredRacks = 0;
            let throttled = 0;
            for (const b of STATE.buildings) {
                if (b.type !== "rack") continue;
                if (b.powered) poweredRacks++;
                if (b.throttleFactor < 1) throttled++;
            }
            c.progress = poweredRacks > 0 && throttled === 0 ? c.progress + dt : 0;
            break;
        }
        case "peak_kw":
            c.progress = Math.max(c.progress, STATE.servedKw);
            break;
    }
}

// Main tick. dt guard matches sim/demand.js: finite positive dt and a live
// game, else strict no-op (pause / tutorial freeze hold everything).
export function tickContracts(dt, elapsed, rng = Math.random) {
    if (!Number.isFinite(dt) || dt <= 0 || STATE.gameOver !== null) {
        return;
    }
    const c = STATE.contract;
    const cfg = CONFIG.contracts;

    if (c.nextAt === null) {
        c.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }

    // 1) Evaluate + resolve the active contract.
    if (c.key !== null && c.done === null) {
        evaluate(c, dt);
        if (c.progress >= c.target) {
            c.done = "paid";
            STATE.money += c.reward;
            c.nextAt = Math.max(c.nextAt, elapsed + cfg.redrawGraceSec);
        } else if (elapsed >= c.endsAt) {
            c.done = "failed";
            c.nextAt = Math.max(c.nextAt, elapsed + cfg.redrawGraceSec);
        }
    }

    // 2) Draw a new contract when none is running and the schedule is due.
    if ((c.key === null || c.done !== null) && elapsed >= c.nextAt) {
        const pool = cfg.pool;
        const pick = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
        c.id += 1;
        c.key = pick.key;
        c.reward = pick.reward;
        c.progress = 0;
        c.target = targetFor(pick);
        c.endsAt = elapsed + pick.windowSec;
        c.done = null;
        c.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
}
