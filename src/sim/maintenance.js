// sim/maintenance.js — scheduled work orders.
//
// STATE fields owned by this module:
//   STATE.maintenance.orders — the level's work orders and their state
// Building fields owned by this module (declared in entities/Building.js):
//   outForService, serviceLeftSec
//
// The model: a level declares orders as { target, durationSec, bySec }. Each
// is a promise the facility has to keep — that element WILL be out of service
// for durationSec, and it has to happen before bySec. The player chooses the
// moment; the deadline is what makes that a decision rather than a formality.
//
// Out-for-service gear is DEAD GEAR (see isDeadGear in sim/power.js), but it
// is not a fault: no breaker heat accrues, and sim/attribution.js names the
// resulting loss as planned work rather than as a trip.
//
// Pure module: no DOM, no THREE, no timers, no randomness.
import { STATE } from "../core/state.js";

// Build the runtime orders from a level's declaration. `target` indexes the
// buildings array the level was built with — these are preBuilt rooms, so the
// index is deterministic and needs no name resolution.
//
// Throws on a target that resolves to nothing, matching applyPreBuilt: an
// order pointing at gear that does not exist is a level nobody can finish,
// and failing at launch is far cheaper than failing silently at the deadline.
export function initMaintenance(orders, buildings) {
    STATE.maintenance.orders = (orders || []).map((o) => {
        const b = buildings[o.target];
        if (!b) {
            throw new Error(`maintenance: order target ${o.target} resolves to no building`);
        }
        return {
            buildingId: b.id,
            durationSec: o.durationSec,
            bySec: o.bySec,
            leftSec: o.durationSec,
            state: "pending",
        };
    });
}

function orderFor(building, states) {
    if (!building) return null;
    for (const o of STATE.maintenance.orders) {
        if (o.buildingId === building.id && states.includes(o.state)) return o;
    }
    return null;
}

export function pendingOrderFor(building) {
    return orderFor(building, ["pending"]);
}

export function activeOrderFor(building) {
    return orderFor(building, ["active"]);
}

export function activeOrderCount() {
    return STATE.maintenance.orders.filter((o) => o.state === "active").length;
}

// Open the window. Returns false — silently, like every other refusal in the
// sim layer — when there is no pending order for this building, which covers
// gear nobody scheduled and an order already opened, done, or missed.
export function openServiceWindow(building) {
    const order = pendingOrderFor(building);
    if (!order) return false;
    order.state = "active";
    order.leftSec = order.durationSec;
    building.outForService = true;
    building.serviceLeftSec = order.durationSec;
    return true;
}

export function tickMaintenance(dt, elapsed) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    const byId = new Map(STATE.buildings.map((b) => [b.id, b]));
    for (const o of STATE.maintenance.orders) {
        const b = byId.get(o.buildingId);
        if (o.state === "active") {
            o.leftSec = Math.max(0, o.leftSec - dt);
            if (b) b.serviceLeftSec = o.leftSec;
            if (o.leftSec <= 0) {
                o.state = "done";
                if (b) {
                    b.outForService = false;
                    b.serviceLeftSec = 0;
                }
            }
            // A window that OPENED before the deadline is allowed to run past
            // it. The promise was to start the work in time, not to have
            // finished it — otherwise a legal window opened at the last legal
            // second would be a trap.
            continue;
        }
        if (o.state === "pending" && Number.isFinite(elapsed) && elapsed >= o.bySec) {
            o.state = "missed";
        }
    }
}
