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
import { attributeLosses } from "./attribution.js";
import { feedIsDark, isDeadGear } from "./power.js";

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
    // Pinned demand (campaign) runs no waves — announcing one would be a lie.
    if (STATE.demandFixedKw !== null) return null;
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

// ---- time-of-use meter --------------------------------------------------
// The day/night band at a given moment. Pure and total: it reads CONFIG and
// the clock, nothing else, so a player (and the HUD) can work out what any
// future second will cost without playing it. That predictability IS the
// mechanic — you cannot plan against a price you cannot see coming.
export function tariffBandAt(elapsed) {
    const cfg = CONFIG.tariff;
    const bands = cfg.bands;
    // The Lab pins a band so a player can stand in one and watch the meter
    // instead of waiting out a 120 s cycle to see the other half of it.
    // STATE.lab.tariffBand is null everywhere else, and an unknown key falls
    // through to the clock rather than inventing a band.
    if (STATE.lab.tariffBand !== null) {
        const pinned = bands.find((b) => b.key === STATE.lab.tariffBand);
        if (pinned) return pinned;
    }
    if (!Number.isFinite(elapsed) || !cfg.periodSec || bands.length === 0) {
        return bands[0] || { fromSec: 0, mult: 1, key: null };
    }
    // Negative clocks fold forward rather than indexing off the front.
    const t = ((elapsed % cfg.periodSec) + cfg.periodSec) % cfg.periodSec;
    let band = bands[0];
    for (const b of bands) {
        if (t >= b.fromSec) band = b;
    }
    return band;
}

// The next band boundary as { atSec, band } when it is within warningSec,
// else null — the same shape and the same "already landed is not upcoming"
// rule as upcomingWave(), so the HUD treats both announcements alike.
export function upcomingBand(elapsed) {
    const cfg = CONFIG.tariff;
    // A pinned band never changes, so announcing a change is the same lie
    // upcomingWave() refuses to tell while demand is pinned.
    if (STATE.lab.tariffBand !== null) return null;
    if (!STATE.tariff.cycleOn || !Number.isFinite(elapsed) || !cfg.periodSec) return null;
    const t = ((elapsed % cfg.periodSec) + cfg.periodSec) % cfg.periodSec;
    let nextAt = cfg.periodSec;      // wrapping to band 0 is itself a boundary
    let next = cfg.bands[0];
    for (const b of cfg.bands) {
        if (b.fromSec > t && b.fromSec < nextAt) {
            nextAt = b.fromSec;
            next = b;
        }
    }
    const inSec = nextAt - t;
    return inSec <= cfg.warningSec ? { inSec, band: next } : null;
}

// A rack only takes assignment if its wire chain reaches a grid-connected
// source (a building whose parentId is "grid" AND whose chainRole is
// "source"). This is a topology-only check — deliberately NOT last tick's
// `powered` flag, so a freshly wired rack is assignable the same tick and
// there is no bootstrap deadlock with power resolution (which runs after
// assignment). Capacity clipping / brownout is power.js's job and shows up
// here via actualKw next tick. Unwired nodes, dangling parent ids, and
// wiring cycles all count as dead.
export function chainAlive(building, byId) {
    const maxHops = STATE.buildings.length + 1;
    let node = building;
    let hops = 0;
    while (node) {
        // Dead gear (an open breaker OR an open service window) is a dead
        // root — checked FIRST, before the "grid" branch below, or a SOURCE
        // that is dead gear (a serviced grid_feed or generator) would return
        // from inside that branch and never reach this check: only
        // link/fanout nodes used to be able to trip, so this ordering was
        // unreachable until out-for-service widened isDeadGear to cover
        // sources too. Also checked BEFORE the UPS clause below, or a
        // tripped UPS would still read as live and reintroduce the
        // starvation bug pinned in tests/integration.test.mjs.
        if (isDeadGear(node)) return false;
        if (node.parentId === "grid") {
            // During a grid outage EVERY grid feed is a dead root (the
            // window is the truth, not a per-building stamp) — assignment
            // must fall back to the UPS/standby clauses below, exactly like
            // a cut chain. Generators are outage-immune but die dry.
            if (node.config.chainRole !== "source") return false;
            if (node.type === "generator") return node.fuelLiters > 0;
            return !feedIsDark(node);
        }
        // A UPS with charge is a live root for assignment purposes: work must
        // keep flowing to its subtree during an upstream blip, or the buffer
        // in sim/power.js has nothing to carry and the blip becomes a blackout.
        if (node.type === "ups" && node.bufferLeft > 0) {
            return true;
        }
        // A standby edge to a fueled generator keeps the subtree assignable
        // for the same reason — the transfer switch (sim/power.js) gates the
        // actual delivery through its cutover.
        if (node.standbyParentId) {
            const g = byId.get(node.standbyParentId);
            if (g && g.type === "generator" && g.fuelLiters > 0) return true;
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

    // Campaign levels pin demand flat (STATE.demandFixedKw); survival runs
    // the ramp-and-waves curve.
    STATE.demandKw = STATE.demandFixedKw !== null ? STATE.demandFixedKw : demandCurveKw(elapsed);
    assignLoad();

    // Economy (game-minute-as-billing-hour, see header). The power bill uses
    // TOTAL facility draw — racks + cooling — which is PUE in the wallet.
    const billingHours = dt / BILLING_HOUR_SEC;
    const eco = CONFIG.economy;
    const missedKw = Math.max(0, STATE.demandKw - STATE.servedKw);
    // The meter, and nothing but the meter. Two independent facts multiply
    // here and nowhere else in the simulation: the random peak WINDOW
    // (sim/crisis.js) and the deterministic day/night CYCLE. Neither touches
    // capacity, heat or SLA — which is exactly why "run the same room at a
    // different hour" is the only play either of them offers.
    const band = tariffBandAt(elapsed);
    STATE.tariff.cycleMul = STATE.tariff.cycleOn ? band.mult : 1;
    STATE.tariff.band = STATE.tariff.cycleOn ? band.key : null;
    const tariffMul = (STATE.tariff.active ? STATE.tariff.multiplier : 1) * STATE.tariff.cycleMul;
    STATE.money += STATE.servedKw * CONFIG.buildings.rack.revenuePerKwhServed * billingHours;
    // PEAK SHAVING (sim/power.js, STATE.peakShave): kW served from a UPS
    // buffer this tick already left the grid — battery-sourced draw does
    // not hit the meter, which is the entire point of the mechanic.
    // totalDrawKw itself is untouched (still every watt the facility drew,
    // whatever it came from — PUE's numerator stays honest); only the BILL
    // subtracts it, here and nowhere else.
    const billedDrawKw = Math.max(0, STATE.totalDrawKw - STATE.batteryKw);
    STATE.money -= billedDrawKw * eco.powerCostPerKwh * tariffMul * billingHours;
    STATE.money -= missedKw * eco.slaPenaltyPerKwhMissed * billingHours;

    // Reputation drifts toward the SLA compliance ratio mapped to 0..100.
    const target = STATE.demandKw > 0
        ? (STATE.servedKw / STATE.demandKw) * 100
        : 100;
    STATE.reputation += (target - STATE.reputation) * CONFIG.sla.driftPerSec * dt;
    STATE.reputation = Math.min(100, Math.max(0, STATE.reputation));

    // Name what the missed kW went to (diagnostic only; see attribution.js).
    attributeLosses(dt);

    // Game over. Bankruptcy is checked first — if both trip in the same
    // tick, the verdict is "bankrupt" (documented ordering).
    //
    // A SANDBOX level (STATE.lab.on — The Lab, false everywhere else) has no
    // loss condition at all, matching campaign/campaign.js's refusal to
    // resolve it: leave the room dark for about seventy seconds and
    // reputation reaches the floor, and a rehearsal room that ends in a
    // frozen clock behind no modal at all is worse than one you cannot lose.
    // The meter, the SLA penalty and the reputation drift all still run —
    // they are what the knobs are there to show you.
    if (!STATE.lab.on) {
        if (STATE.money <= eco.bankruptcyAt) {
            STATE.gameOver = "bankrupt";
        } else if (STATE.reputation <= CONFIG.sla.gameOverAt + REPUTATION_GAMEOVER_EPSILON) {
            STATE.gameOver = "reputation";
        }
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
