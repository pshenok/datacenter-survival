// Crisis events: grid brownout + CRAC breakdown. Pure sim module — reads
// CONFIG and STATE only, no DOM, no THREE, no timers. Scheduling follows the
// sim/demand.js heatwave pattern exactly: pure state math against elapsed
// game time, fire/end anchored to the scheduled time, no Math.random at
// module scope — every random draw goes through the rng parameter
// (defaulting to Math.random; tests pass a seeded one).
//
// STATE fields owned by this module:
//   brownout   — { active, endsAt, nextAt, factor }. While active, every
//                grid_feed's EFFECTIVE capacity is capacityKw * factor —
//                consumed by sim/power.js; CONFIG.buildings is never mutated.
//   breakdown  — { nextAt } schedule for the next CRAC failure.
//   drought    — { active, endsAt, nextAt, multiplier }. While active, the
//                WATER bill in sim/demand.js is multiplied; nothing else in
//                the simulation reads it.
//   money      — debited by repairCrac() (the paid repair fee only; the free
//                self-repair charges nothing).
// Building fields owned (declared in entities/Building.js):
//   broken     — true while a CRAC is down; sim/heat.js forces duty to 0.
//   repairAt   — game time of the free self-repair.
// nextAt === null means "not scheduled yet": the first valid tick draws the
// schedule from the rng, so game.js's tutorial freeze (elapsed stands still)
// simply holds every crisis in the future.
//
// DESIGN DECISION — brownout is degraded-not-dead, and the UPS does NOT
// engage. A brownout halves the grid feed's effective capacity; the chain
// below stays LIVE, so power.js clips every load proportionally as with any
// overloaded link, and the UPS (which only takes over when its upstream path
// is dead) keeps recharging instead of discharging. That is the honest
// model and the honest lesson: batteries ride through OUTAGES, only
// overprovisioned feed HEADROOM rides through a sag. A facility drawing
// under half its feed capacity does not even notice the event. The banner
// copy ("headroom, not batteries") teaches exactly this; tests in
// tests/crisis.test.mjs pin both behaviours.

import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";

function span(minSec, maxSec, rng) {
    return minSec + (maxSec - minSec) * rng();
}

function tickBrownout(elapsed, rng) {
    const bo = STATE.brownout;
    const cfg = CONFIG.events.brownout;
    if (bo.nextAt === null) {
        bo.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
    if (!bo.active && elapsed >= bo.nextAt) {
        bo.endsAt = bo.nextAt + span(cfg.minDurationSec, cfg.maxDurationSec, rng);
        bo.nextAt += span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
        bo.factor = cfg.capacityFactor;
        bo.active = true;
    }
    if (bo.active && elapsed >= bo.endsAt) {
        bo.active = false;
    }
}

// Break one CRAC. The ONLY place a breakdown starts, so The Lab's Fire
// button (campaign/lab.js) rehearses exactly the failure the random
// scheduler deals out — same flag, same free self-repair clock, healed by
// the loop in tickBreakdown like any other. atSec anchors the repair to the
// SCHEDULED time rather than to frame timing, the rule every window in this
// file follows.
export function breakCrac(b, atSec) {
    if (!b || b.type !== "crac" || b.broken) return false;
    b.broken = true;
    b.repairAt = atSec + CONFIG.events.cracBreakdown.selfRepairSec;
    return true;
}

function tickBreakdown(elapsed, rng) {
    const bd = STATE.breakdown;
    const cfg = CONFIG.events.cracBreakdown;
    if (bd.nextAt === null) {
        bd.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
    if (elapsed >= bd.nextAt) {
        const candidates = STATE.buildings.filter(
            (b) => b.type === "crac" && b.powered && !b.broken
        );
        if (candidates.length > 0) {
            const pick = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
            breakCrac(pick, bd.nextAt);
        }
        bd.nextAt += span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
    // Free self-repair: an AFK player is not doomed, just billed in downtime.
    for (const b of STATE.buildings) {
        if (b.broken && elapsed >= b.repairAt) {
            b.broken = false;
            b.repairAt = 0;
        }
    }
}

// Survival grid outage: the city feed dies completely for the window
// (power.js kills every grid_feed root while active). Same schedule pattern
// as brownout; campaign levels pin nextAt to Infinity and script the window
// directly, and this tick's end-check closes those too.
function tickGridOutage(elapsed, rng) {
    const go = STATE.gridOutage;
    const cfg = CONFIG.events.gridOutage;
    if (go.nextAt === null) {
        go.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
    if (!go.active && elapsed >= go.nextAt) {
        go.endsAt = go.nextAt + span(cfg.minDurationSec, cfg.maxDurationSec, rng);
        go.nextAt += span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
        go.active = true;
    }
    if (go.active && elapsed >= go.endsAt) {
        go.active = false;
    }
}

// Peak tariff window. Same scheduling pattern as brownout; the only reader
// is the power-bill line in sim/demand.js, so this event is provably
// economic-only — no capacity, heat or SLA path touches it.
function tickTariff(elapsed, rng) {
    const tf = STATE.tariff;
    const cfg = CONFIG.events.tariff;
    if (tf.nextAt === null) {
        tf.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
    if (!tf.active && elapsed >= tf.nextAt) {
        tf.endsAt = tf.nextAt + span(cfg.minDurationSec, cfg.maxDurationSec, rng);
        tf.nextAt += span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
        tf.multiplier = cfg.multiplier;
        tf.active = true;
    }
    if (tf.active && elapsed >= tf.endsAt) {
        tf.active = false;
        tf.multiplier = 1;
    }
}

// Drought window. Same scheduling pattern as the peak tariff above, and the
// same narrowness: the ONLY reader is the water line in sim/demand.js, so
// this event is provably economic-only — no capacity, no heat, no SLA, and
// not the power meter either. A facility with no evaporative plant in it
// cannot tell a drought is happening, which is exactly right: the CRAC
// beside it rejects its heat to air and owes the reservoir nothing.
function tickDrought(elapsed, rng) {
    const dr = STATE.drought;
    const cfg = CONFIG.events.drought;
    if (dr.nextAt === null) {
        dr.nextAt = elapsed + span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
    }
    if (!dr.active && elapsed >= dr.nextAt) {
        dr.endsAt = dr.nextAt + span(cfg.minDurationSec, cfg.maxDurationSec, rng);
        dr.nextAt += span(cfg.minIntervalSec, cfg.maxIntervalSec, rng);
        dr.multiplier = cfg.multiplier;
        dr.active = true;
    }
    if (dr.active && elapsed >= dr.endsAt) {
        dr.active = false;
        dr.multiplier = 1;
    }
}

// Fuel logistics: a paid refill lands fuelDeliverySec after the order.
function tickFuelDeliveries(elapsed) {
    for (const b of STATE.buildings) {
        if (b.type !== "generator" || b.fuelArrivesAt === null) continue;
        if (elapsed >= b.fuelArrivesAt) {
            b.fuelLiters = b.config.tankLiters;
            b.fuelArrivesAt = null;
        }
    }
}

// Main tick. dt is in seconds, already timeScale-scaled by the caller; the
// guard matches sim/demand.js — dt must be a finite positive number and the
// game must not be over, otherwise this is a strict no-op (pause and the
// tutorial's frozen elapsed both keep every schedule untouched).
export function tickCrisis(dt, elapsed, rng = Math.random) {
    if (!Number.isFinite(dt) || dt <= 0 || STATE.gameOver !== null) {
        return;
    }
    tickBrownout(elapsed, rng);
    tickBreakdown(elapsed, rng);
    tickGridOutage(elapsed, rng);
    tickTariff(elapsed, rng);
    tickDrought(elapsed, rng);
    tickFuelDeliveries(elapsed);
}

// Paid repair (wired to the select tool's click in src/input/handlers.js).
// Charges CONFIG.events.cracBreakdown.repairCost; refuses when the target is
// not a broken CRAC or the player cannot afford the fee (the placeBuilding
// affordability rule — a broke player waits out the free self-repair).
export function repairCrac(b) {
    if (!b || b.type !== "crac" || !b.broken) return false;
    if (STATE.money < CONFIG.events.cracBreakdown.repairCost) return false;
    STATE.money -= CONFIG.events.cracBreakdown.repairCost;
    b.broken = false;
    b.repairAt = 0;
    return true;
}

// Push the handle back in (wired to the select tool's click on a tripped
// link). Free — the downtime already cost you. Resetting a breaker whose
// cause you have not fixed simply trips it again, which is the lesson.
export function resetBreaker(b) {
    if (!b || !b.tripped) return false;
    b.tripped = false;
    b.breakerHeat = 0;
    return true;
}

// Order a refill (wired to the select tool's click on a generator). Refuses
// on a full tank, an order already in transit, or an empty wallet — same
// affordability rule as repairCrac. The tank fills when the truck arrives
// (tickFuelDeliveries), not at purchase.
export function orderFuel(b, elapsed) {
    if (!b || b.type !== "generator") return false;
    if (b.fuelArrivesAt !== null || b.fuelLiters >= b.config.tankLiters) return false;
    if (STATE.money < b.config.fuelCost) return false;
    STATE.money -= b.config.fuelCost;
    b.fuelArrivesAt = elapsed + b.config.fuelDeliverySec;
    return true;
}
