// Loss attribution — the diagnosis layer's data source.
//
// Server Survival attributes DISCRETE events (this request died at that
// node). Datacenter Survival loses a CONTINUOUS quantity: sim/demand.js
// already computes missedKw = demandKw - servedKw every tick and charges an
// SLA penalty on it, then throws the cause away. This module decomposes that
// same number by cause instead.
//
// STATE fields owned:
//   losses.tickKw   — cause -> kW unserved THIS tick. Sums to missedKw.
//   losses.totalKwh — cause -> kWh unserved this run (the ledger).
//   losses.blame    — [{ buildingId, cause, kw }] for the floating badges.
//
// PURELY DIAGNOSTIC. Nothing in the simulation reads any of it back, and
// tests/attribution.test.mjs pins both halves of that promise: the buckets
// must sum to missedKw, and running with attribution must leave money,
// served, reputation and the heat field bit-identical.
//
// The decomposition is exact by construction, not by fudging:
//   missed = (demand - SUM assigned)            <- capacity never offered
//          + (SUM assigned - served)            <- offered but not delivered
// The first term is split across the reasons capacity was missing; the
// second is split per rack into the power side and the thermal side.

import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { CAUSE_IDS } from "../core/loss-causes.js";
import { chainAlive } from "./demand.js";

const BILLING_HOUR_SEC = 60;    // same scale as sim/demand.js
const EPS = 1e-12;

function resetTick() {
    for (const c of CAUSE_IDS) {
        if (STATE.losses.tickKw[c] === undefined) STATE.losses.tickKw[c] = 0;
        else STATE.losses.tickKw[c] = 0;
        if (STATE.losses.totalKwh[c] === undefined) STATE.losses.totalKwh[c] = 0;
    }
    STATE.losses.blame.length = 0;
}

function add(cause, kw, buildingId = null) {
    if (!(kw > EPS)) return;
    STATE.losses.tickKw[cause] += kw;
    if (buildingId) {
        const hit = STATE.losses.blame.find((b) => b.buildingId === buildingId && b.cause === cause);
        if (hit) hit.kw += kw;
        else STATE.losses.blame.push({ buildingId, cause, kw });
    }
}

// Walk a rack's primary chain and name what starved it. Order matters:
// the most specific explanation wins (a dry generator or a flat battery
// beats "some link clipped"), and a clipped grid feed during a sag is a
// brownout, not a sizing mistake.
function powerCause(rack, byId) {
    const maxHops = STATE.buildings.length + 1;
    let node = rack;
    let hops = 0;
    let clipped = null;
    while (node && hops++ <= maxHops) {
        if (node.tripped) {
            return { cause: "breaker_tripped", id: node.id };
        }
        if (node.type === "generator" && node.fuelLiters <= 0) {
            return { cause: "tank_dry", id: node.id };
        }
        if (node.type === "ups" && node.bufferLeft <= 0 && STATE.gridOutage.active) {
            return { cause: "battery_empty", id: node.id };
        }
        if (!clipped && node.clippedKw > EPS) clipped = node;
        if (!node.parentId || node.parentId === "grid") break;
        node = byId.get(node.parentId);
    }
    if (clipped) {
        const isSaggingFeed = clipped.type === "grid_feed" && STATE.brownout.active;
        return { cause: isSaggingFeed ? "brownout" : "link_clip", id: clipped.id };
    }
    if (STATE.gridOutage.active) return { cause: "dead_chain", id: rack.id };
    return { cause: "dead_chain", id: rack.id };
}

// Runs at the END of sim/demand.js's tick, on the same facts assignLoad just
// settled (so it inherits the documented one-tick actualKw lag rather than
// inventing a second convention).
export function attributeLosses(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    resetTick();

    const missed = STATE.demandKw - STATE.servedKw;
    if (!(missed > EPS)) return;

    const byId = new Map();
    for (const b of STATE.buildings) byId.set(b.id, b);

    // ---- Part A: capacity that was never on the table -------------------
    let totalNameplate = 0;
    let totalAvail = 0;
    let thermalGap = 0;
    let deadGap = 0;
    const racks = [];
    for (const b of STATE.buildings) {
        if (b.type !== "rack") continue;
        const nameplate = b.config.capacityKw;
        const alive = b.throttleFactor > 0 && chainAlive(b, byId);
        const avail = alive ? nameplate * b.throttleFactor : 0;
        totalNameplate += nameplate;
        totalAvail += avail;
        if (alive) thermalGap += nameplate * (1 - b.throttleFactor);
        else deadGap += nameplate;
        racks.push({ rack: b, alive });
    }

    const gapCapacity = Math.max(0, STATE.demandKw - totalAvail);
    if (gapCapacity > EPS) {
        const hardGap = Math.max(0, STATE.demandKw - totalNameplate);
        const total = thermalGap + deadGap + hardGap;
        if (total > EPS) {
            // Proportional split so the three reasons fill gapCapacity exactly.
            const k = gapCapacity / total;
            if (thermalGap > EPS) {
                for (const { rack, alive } of racks) {
                    if (!alive) continue;
                    add("thermal", rack.config.capacityKw * (1 - rack.throttleFactor) * k, rack.id);
                }
            }
            if (deadGap > EPS) {
                for (const { rack, alive } of racks) {
                    if (alive) continue;
                    const share = rack.config.capacityKw * k;
                    const { cause, id } = powerCause(rack, byId);
                    add(cause, share, id);
                }
            }
            add("no_capacity", hardGap * k);
        } else {
            add("no_capacity", gapCapacity);
        }
    }

    // ---- Part B: assigned but not delivered ------------------------------
    for (const { rack } of racks) {
        const assigned = rack.assignedKw;
        if (!(assigned > EPS)) continue;
        const delivered = Math.min(assigned, rack.actualKw);
        const powerShort = Math.max(0, assigned - delivered);
        const thermalShort = delivered * (1 - rack.throttleFactor);
        if (powerShort > EPS) {
            const { cause, id } = powerCause(rack, byId);
            add(cause, powerShort, id);
        }
        add("thermal", thermalShort, rack.id);
    }

    // ---- ledger ----------------------------------------------------------
    const hours = dt / BILLING_HOUR_SEC;
    for (const c of CAUSE_IDS) STATE.losses.totalKwh[c] += STATE.losses.tickKw[c] * hours;

    STATE.losses.blame.sort((a, b) => b.kw - a.kw);
}

// Money the run has forfeited per cause, at the same SLA rate demand.js
// charges — the ledger's headline number.
export function lossLedger() {
    const rate = CONFIG.economy.slaPenaltyPerKwhMissed;
    const all = CAUSE_IDS
        .map((cause) => ({ cause, kwh: STATE.losses.totalKwh[cause] || 0 }))
        .filter((r) => r.kwh > 0);
    // Total over EVERY cause, so the shares below always add up even after
    // the noise rows are dropped from the display.
    const totalKwh = all.reduce((s, r) => s + r.kwh, 0);
    const rows = all
        .filter((r) => r.kwh / totalKwh >= 0.01 && r.kwh * rate >= 0.5)
        .map((r) => ({ ...r, dollars: r.kwh * rate }))
        .sort((a, b) => b.kwh - a.kwh);
    return { rows, totalKwh, totalDollars: totalKwh * rate };
}
