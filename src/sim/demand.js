// Demand curve, load assignment, SLA economy, heatwave scheduling, and game
// over — the "business" half of the simulation. Pure sim module: reads CONFIG
// and STATE only, no DOM, no THREE, so node-env vitest imports it directly.
//
// STATE fields owned by this module:
//   demandKw    — output of the demand curve (kW asked of the facility)
//   servedKw    — kW actually delivered against that demand this tick
//   money       — per-tick revenue / power-bill / SLA-penalty flows (capex
//                 for placing buildings is charged by the build action in
//                 the UI layer, not here)
//   reputation  — drifts toward the served/demand ratio, clamped 0..100
//   heatwave    — { active, endsAt, nextAt } event schedule (pure state
//                 math against elapsed game time; no timers)
//   gameOver    — null | "bankrupt" | "reputation"; once set, every tick
//                 function in this module is a no-op. Both tick functions
//                 are also strict no-ops unless dt is a finite positive
//                 number (same guard as sim/power.js)
// Building fields owned: rack.assignedKw. Reads rack.actualKw (sim/power.js)
// and rack.throttleFactor (sim/heat.js) but never writes them.
//
// One-tick lag (deliberate, documented): the loop order in game.js is
// demand -> power -> heat. Assignment therefore runs BEFORE this tick's
// power resolution, so servedKw pairs this tick's assignedKw with LAST
// tick's actualKw and throttleFactor. Same for STATE.totalDrawKw on the
// power bill. The lag is one frame and invisible at game dt.
//
// Billing scale (documented decision): revenue/cost/penalty rates are $/kWh,
// but billing real hours at game seconds would make the numbers invisible.
// One GAME MINUTE is treated as the billing hour: every $/kWh rate is
// applied as rate * kW * dt / 60.

import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";

// Seconds of game time per billing "hour" (see header).
const BILLING_HOUR_SEC = 60;

// Reputation drifts asymptotically toward its target, so it can never
// mathematically reach the configured gameOverAt of 0 — <= gameOverAt + 0.5
// is the documented "close enough to dead" threshold.
const REPUTATION_GAMEOVER_EPSILON = 0.5;

// Multiplier of the LAST wave whose atSec has been reached; 1 before any
// wave. Waves replace each other (last one wins) — they do not stack.
export function activeWaveMultiplier(elapsed) {
    let bestAtSec = -Infinity;
    let multiplier = 1;
    for (const wave of CONFIG.demand.waves) {
        if (elapsed >= wave.atSec && wave.atSec >= bestAtSec) {
            bestAtSec = wave.atSec;
            multiplier = wave.multiplier;
        }
    }
    return multiplier;
}

// Survival DNA ramp: log growth + slow linear creep, scaled by the active
// wave multiplier (the multiplier applies to the whole ramp).
export function demandCurveKw(elapsed) {
    const d = CONFIG.demand;
    const rampKw = d.baseKw
        + Math.log(1 + elapsed / 30) * d.logGrowthFactor
        + elapsed * d.linearPerSec;
    return rampKw * activeWaveMultiplier(elapsed);
}

// For the UI banner: the next wave as { atSec, multiplier } when we are
// within waveWarningSec of it, else null. A wave stops being "upcoming" the
// moment it lands (atSec itself is active, not upcoming).
export function upcomingWave(elapsed) {
    let next = null;
    for (const wave of CONFIG.demand.waves) {
        if (wave.atSec > elapsed && (next === null || wave.atSec < next.atSec)) {
            next = wave;
        }
    }
    if (next !== null && next.atSec - elapsed <= CONFIG.demand.waveWarningSec) {
        return { atSec: next.atSec, multiplier: next.multiplier };
    }
    return null;
}

// A rack only takes assignment if its wire chain reaches a grid-connected
// source (a building whose parentId is "grid" AND whose chainRole is
// "source"). This is a topology-only check — deliberately NOT last tick's
// `powered` flag, so a freshly wired rack is assignable the same tick and
// there is no bootstrap deadlock with power resolution (which runs after
// assignment). Capacity clipping / brownout is power.js's job and shows up
// here via actualKw next tick. Unwired nodes, dangling parent ids, and
// wiring cycles all count as dead.
function chainAlive(building, byId) {
    const maxHops = STATE.buildings.length + 1;
    let node = building;
    let hops = 0;
    while (node) {
        if (node.parentId === "grid") {
            return node.config.chainRole === "source";
        }
        // A UPS with charge is a live root for assignment purposes: work must
        // keep flowing to its subtree during an upstream blip, or the buffer
        // in sim/power.js has nothing to carry and the blip becomes a blackout.
        if (node.type === "ups" && node.bufferLeft > 0) {
            return true;
        }
        if (node.parentId === null || ++hops > maxHops) {
            return false;
        }
        node = byId.get(node.parentId);
    }
    return false;
}

// Distribute STATE.demandKw across racks proportionally to each rack's
// available capacity (capacityKw * throttleFactor), capped per rack — with
// proportional shares the cap binds exactly when demand exceeds total
// available capacity, so every eligible rack gets availKw * min(1, D/total).
// Also settles STATE.servedKw from the same loop (see one-tick lag note in
// the header). served <= demand always: sum(assigned) <= demandKw and each
// term is min(assigned, actual) * throttle with throttle <= 1.
function assignLoad() {
    const byId = new Map();
    for (const b of STATE.buildings) {
        byId.set(b.id, b);
    }

    const racks = [];
    let totalAvailKw = 0;
    for (const b of STATE.buildings) {
        if (b.type !== "rack") {
            continue;
        }
        const availKw = (b.throttleFactor > 0 && chainAlive(b, byId))
            ? b.config.capacityKw * b.throttleFactor
            : 0;
        racks.push({ rack: b, availKw });
        totalAvailKw += availKw;
    }

    const scale = totalAvailKw > 0 ? Math.min(1, STATE.demandKw / totalAvailKw) : 0;
    let servedKw = 0;
    for (const { rack, availKw } of racks) {
        rack.assignedKw = availKw * scale;
        servedKw += Math.min(rack.assignedKw, rack.actualKw) * rack.throttleFactor;
    }
    STATE.servedKw = servedKw;
}

// Main tick: demand curve -> assignment/served -> economy -> reputation ->
// game over. dt is in seconds, already timeScale-scaled by the caller; a set
// gameOver freezes this completely, and — matching sim/power.js — so does any
// dt that is not a finite positive number (0 = pause; NaN/negative/Infinity
// would corrupt money and reputation irrecoverably).
export function tickDemand(dt, elapsed) {
    if (!Number.isFinite(dt) || dt <= 0 || STATE.gameOver !== null) {
        return;
    }

    STATE.demandKw = demandCurveKw(elapsed);
    assignLoad();

    // Economy (game-minute-as-billing-hour, see header). The power bill uses
    // TOTAL facility draw — racks + cooling — which is PUE in the wallet.
    const billingHours = dt / BILLING_HOUR_SEC;
    const eco = CONFIG.economy;
    const missedKw = Math.max(0, STATE.demandKw - STATE.servedKw);
    STATE.money += STATE.servedKw * CONFIG.buildings.rack.revenuePerKwhServed * billingHours;
    STATE.money -= STATE.totalDrawKw * eco.powerCostPerKwh * billingHours;
    STATE.money -= missedKw * eco.slaPenaltyPerKwhMissed * billingHours;

    // Reputation drifts toward the SLA compliance ratio mapped to 0..100.
    const target = STATE.demandKw > 0
        ? (STATE.servedKw / STATE.demandKw) * 100
        : 100;
    STATE.reputation += (target - STATE.reputation) * CONFIG.sla.driftPerSec * dt;
    STATE.reputation = Math.min(100, Math.max(0, STATE.reputation));

    // Game over. Bankruptcy is checked first — if both trip in the same
    // tick, the verdict is "bankrupt" (documented ordering).
    if (STATE.money <= eco.bankruptcyAt) {
        STATE.gameOver = "bankrupt";
    } else if (STATE.reputation <= CONFIG.sla.gameOverAt + REPUTATION_GAMEOVER_EPSILON) {
        STATE.gameOver = "reputation";
    }
}

// Heatwave scheduling: fires when elapsed reaches nextAt, stays active until
// endsAt (both anchored to the scheduled nextAt, not to frame timing), then
// reschedules nextAt += intervalSec. One fire per tick — fine while dt is a
// frame and durationSec/intervalSec are tens of seconds. sim/heat.js reads
// STATE.heatwave.active to switch ambient/diffusion; this module only keeps
// the schedule.
export function tickEvents(dt, elapsed) {
    if (!Number.isFinite(dt) || dt <= 0 || STATE.gameOver !== null) {
        return;
    }
    const hw = STATE.heatwave;
    const cfg = CONFIG.events.heatwave;
    if (!hw.active && elapsed >= hw.nextAt) {
        hw.endsAt = hw.nextAt + cfg.durationSec;
        hw.nextAt += cfg.intervalSec;
        hw.active = true;
    }
    if (hw.active && elapsed >= hw.endsAt) {
        hw.active = false;
    }
}
