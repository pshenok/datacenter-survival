// sim/power.js — the wired power chain: topology + per-tick resolution.
//
// STATE fields owned by this module:
//   STATE.itDrawKw    — sum of rack actualKw this tick (the PUE denominator)
//   STATE.totalDrawKw — rack + CRAC actualKw this tick (the power bill)
// Building fields owned by this module (declared in entities/Building.js):
//   parentId, childIds — power topology, via wireBuildings()/unwire()
//   actualKw, powered  — per-tick resolution results (links carry, loads draw)
//   bufferLeft         — UPS buffer seconds remaining
// Inputs read, never written: assignedKw (sim/demand.js), duty (sim/heat.js).
//
// Model per tick (dt in seconds, already timeScale-scaled by the caller;
// strict no-op when dt === 0 or dt is not a finite positive number):
//   - each rack requests min(assignedKw, capacityKw); each CRAC requests
//     drawKw * duty. Demand propagates leaf -> root as a "pull": a link's
//     pull = min(capacityKw, sum of child pulls) — clipping cascades, so an
//     overloaded link browns out its whole subtree proportionally and no
//     link ever carries more than its capacityKw.
//   - grid_feed (chainRole "source") has parent "grid" implicitly: it IS a
//     root, never a child of a wire. While STATE.brownout.active (owned by
//     sim/crisis.js), a source's EFFECTIVE capacity is capacityKw *
//     brownout.factor — config is never mutated. The chain stays LIVE, so
//     this clips proportionally like any overload and the UPS does NOT
//     engage (degraded-not-dead; see the sim/crisis.js design decision).
//   - UPS: when its path to a root is broken or dead, it serves its subtree
//     from bufferLeft (draining dt per tick while carrying draw > 0; at 0
//     the subtree goes dark) and recharges at 1/4 rate while the path is
//     live and the buffer is below max.
//   - a load is powered when it sits on a live chain and either draws power
//     or requested none (an idle rack on a live chain is powered).
//
// Pure module: no DOM, no THREE, no timers, no randomness — node-env vitest
// imports it directly.

import { STATE } from "../core/state.js";

// Legal wire edges: parent chainRole -> allowed child chainRoles.
// Racks and CRACs (loads) wire to PDUs (fanout) ONLY; nothing wires to a
// load; nothing wires INTO a source.
const LEGAL_EDGES = {
    source: ["link", "fanout"],
    link: ["link", "fanout"],
    fanout: ["load"],
};

function findById(id) {
    for (const b of STATE.buildings) {
        if (b.id === id) return b;
    }
    return null;
}

// Wire child under parent. Returns false on any illegal edge (bad roles,
// self-wire, would-be cycle). Enforces single parent: a rewire unwires the
// old parent first. Idempotent for an already-existing edge.
export function wireBuildings(parent, child) {
    if (!parent || !child || parent === child) return false;
    const pRole = parent.config && parent.config.chainRole;
    const cRole = child.config && child.config.chainRole;
    const allowed = LEGAL_EDGES[pRole];
    if (!allowed || !allowed.includes(cRole)) return false;
    if (child.parentId === parent.id) return true;

    // Cycle guard: reject if child is an ancestor of parent. (With single
    // parents plus this walk, cycles are impossible by construction.)
    const seen = new Set();
    for (let anc = parent; anc;) {
        if (anc.id === child.id) return false;
        if (seen.has(anc.id)) break;
        seen.add(anc.id);
        anc = anc.parentId && anc.parentId !== "grid" ? findById(anc.parentId) : null;
    }

    unwire(child);
    child.parentId = parent.id;
    parent.childIds.push(child.id);
    return true;
}

// Remove child's parent wire. Returns true if a wire was removed, false if
// there was none (a grid_feed's implicit "grid" parent is not a wire).
export function unwire(child) {
    if (!child || !child.parentId || child.parentId === "grid") return false;
    const parent = findById(child.parentId);
    if (parent) {
        const i = parent.childIds.indexOf(child.id);
        if (i !== -1) parent.childIds.splice(i, 1);
    }
    child.parentId = null;
    return true;
}

function sanitize(value, min, max) {
    const n = typeof value === "number" && !Number.isNaN(value) ? value : 0;
    return Math.min(Math.max(n, min), max);
}

// Resolve the whole power forest for this tick.
export function resolvePower(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    const byId = new Map();
    for (const b of STATE.buildings) byId.set(b.id, b);

    // 1) Sanitized load requests.
    const requests = new Map();
    for (const b of STATE.buildings) {
        if (b.config.chainRole !== "load") continue;
        let req;
        if (b.type === "crac") {
            req = (b.config.drawKw || 0) * sanitize(b.duty, 0, 1);
        } else {
            req = sanitize(b.assignedKw, 0, b.config.capacityKw || 0);
        }
        requests.set(b.id, req);
    }

    // 2) Bottom-up pull: what actually flows through a node when granted in
    // full. Capacity clipping cascades here, so upstream links see carried
    // demand, not raw requests.
    const pulls = new Map();
    function pullOf(b) {
        if (pulls.has(b.id)) return pulls.get(b.id);
        let p;
        if (b.config.chainRole === "load") {
            p = requests.get(b.id) || 0;
        } else {
            pulls.set(b.id, 0); // re-entry guard for malformed graphs
            let sum = 0;
            for (const cid of b.childIds) {
                const c = byId.get(cid);
                if (c) sum += pullOf(c);
            }
            let cap = Number.isFinite(b.config.capacityKw) ? b.config.capacityKw : 0;
            if (b.config.chainRole === "source" && STATE.brownout.active) {
                cap *= sanitize(STATE.brownout.factor, 0, 1);
            }
            p = Math.min(cap, sum);
        }
        pulls.set(b.id, p);
        return p;
    }

    // 3) Top-down delivery: grants split proportionally to child pulls, so
    // every clip browns out its subtree uniformly.
    const visited = new Set();
    function deliver(b, live, grantKw) {
        if (visited.has(b.id)) return;
        visited.add(b.id);
        const pull = pullOf(b);

        if (b.config.chainRole === "load") {
            const got = live ? Math.min(grantKw, pull) : 0;
            b.actualKw = got;
            b.powered = live && (got > 0 || pull === 0);
            return;
        }

        let outLive = live;
        let outKw = live ? Math.min(grantKw, pull) : 0;

        if (b.type === "ups") {
            const max = b.config.bufferSec || 0;
            if (outLive) {
                if (b.bufferLeft < max) {
                    b.bufferLeft = Math.min(max, b.bufferLeft + dt / 4);
                }
            } else if (b.bufferLeft > 0) {
                outLive = true;
                outKw = pull; // self-grant: serve the subtree from the buffer
                if (pull > 0) {
                    b.bufferLeft = Math.max(0, b.bufferLeft - dt);
                }
            }
        }

        b.actualKw = outKw; // carried kW through this link/source
        b.powered = outLive;

        let totalChildPull = 0;
        const kids = [];
        for (const cid of b.childIds) {
            const c = byId.get(cid);
            if (!c) continue;
            kids.push(c);
            totalChildPull += pullOf(c);
        }
        // "Overloaded to zero" or dead upstream kills the chain below; an
        // idle (zero-pull) subtree on a live chain stays live.
        const childLive = outLive && (outKw > 0 || totalChildPull === 0);
        for (const c of kids) {
            const share = totalChildPull > 0 ? outKw * (pullOf(c) / totalChildPull) : 0;
            deliver(c, childLive, share);
        }
    }

    // 4) Roots. Sources are live roots (implicit "grid" parent) — unless a
    // campaign-scripted grid OUTAGE window is active, which kills every
    // source at once: unlike a brownout (degraded-not-dead), the chain
    // below is dead and a buffered UPS takes over. The window is the truth,
    // not a per-building stamp — a feed placed or rewired mid-outage is just
    // as dead as one that existed when the lights went out. Anything with no
    // live parent path is likewise a dead root. A final sweep catches
    // malformed leftovers.
    const gridDown = STATE.campaign.outage.active;
    for (const b of STATE.buildings) {
        if (b.config.chainRole === "source") deliver(b, !gridDown, gridDown ? 0 : Infinity);
    }
    for (const b of STATE.buildings) {
        if (visited.has(b.id)) continue;
        if (!b.parentId || b.parentId === "grid" || !byId.has(b.parentId)) {
            deliver(b, false, 0);
        }
    }
    for (const b of STATE.buildings) {
        if (!visited.has(b.id)) deliver(b, false, 0);
    }

    // 5) Accounting.
    let itKw = 0;
    let coolKw = 0;
    for (const b of STATE.buildings) {
        if (b.type === "rack") itKw += b.actualKw;
        else if (b.type === "crac") coolKw += b.actualKw;
    }
    STATE.itDrawKw = itKw;
    STATE.totalDrawKw = itKw + coolKw;
}
