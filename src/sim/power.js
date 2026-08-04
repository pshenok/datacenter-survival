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

import { CONFIG } from "../core/config.js";
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
//
// TRANSFER SWITCH: wiring a GENERATOR to a child that already has a primary
// feed does not re-parent — it sets a STANDBY edge (child.standbyParentId).
// The child keeps drawing from its primary path; the generator picks up only
// when that path is dead (see the standby wave in resolvePower). Wiring a
// generator to an unfed child makes it the ordinary primary parent.
export function wireBuildings(parent, child) {
    if (!parent || !child || parent === child) return false;
    const pRole = parent.config && parent.config.chainRole;
    const cRole = child.config && child.config.chainRole;
    const allowed = LEGAL_EDGES[pRole];
    if (!allowed || !allowed.includes(cRole)) return false;
    if (parent.type === "generator" && child.parentId !== null && child.parentId !== parent.id) {
        child.standbyParentId = parent.id;
        return true;
    }
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

// Remove child's PRIMARY parent wire. Returns true if a wire was removed,
// false if there was none (a grid_feed's implicit "grid" parent is not a
// wire). The standby edge is deliberately untouched: a paid transfer switch
// survives a primary rewire and the loss of a primary parent — it dies only
// with the generator (demolition sweeps standbyParentId) or when another
// generator replaces it.
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

// Which utility substation a grid feed hangs off. Derived from PLACEMENT,
// not from a control the player has to discover: the left half of the floor
// is fed by substation A, the right half by B. "Two independent feeds" then
// literally means putting them on opposite sides of the room — the map
// geometry becomes the teaching device.
export function utilityOf(building) {
    return building.gx < CONFIG.gridSize / 2 ? "A" : "B";
}

// Is this grid feed dark right now? A scoped outage only takes down its own
// substation; the default "all" keeps the original behaviour, which the
// early levels (and the mid-outage exploit test) are written against.
export function feedIsDark(building) {
    if (!STATE.gridOutage.active) return false;
    const scope = STATE.gridOutage.scope || "all";
    return scope === "all" || scope === utilityOf(building);
}

// Is a building's PRIMARY parent path dead? Walks parentIds to the root,
// ignoring UPS buffers — a bridged subtree still has a dead primary, which
// is exactly when the transfer switch must start its cutover countdown.
function primaryPathDead(b, byId) {
    const maxHops = STATE.buildings.length + 1;
    let node = b;
    let hops = 0;
    while (node) {
        if (node.parentId === "grid") {
            if (node.config.chainRole !== "source") return true;
            if (node.type === "generator") return node.fuelLiters <= 0;
            return feedIsDark(node);
        }
        if (node.parentId === null || ++hops > maxHops) return true;
        node = byId.get(node.parentId);
    }
    return true;
}

// Resolve the whole power forest for this tick.
export function resolvePower(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    const byId = new Map();
    for (const b of STATE.buildings) byId.set(b.id, b);

    // Snapshot UPS buffers: a subtree re-delivered by the standby wave must
    // not pay double buffer mutations (drained as dead, then recharged).
    const bufSnap = new Map();
    for (const b of STATE.buildings) {
        if (b.type === "ups") bufSnap.set(b.id, b.bufferLeft);
        b.clippedKw = 0;
    }

    // 1) Sanitized load requests.
    const requests = new Map();
    for (const b of STATE.buildings) {
        if (b.config.chainRole !== "load") continue;
        let req;
        if (b.type === "crac") {
            // Part-load curve, not a straight line: a running CRAC pays its
            // idle draw (fans, pumps) before it moves any heat at all, and
            // the variable part rises sub-linearly with duty. A broken unit
            // is off, not idling — sim/heat.js forces its duty to 0 and it
            // must not bill.
            const duty = sanitize(b.duty, 0, 1);
            const full = b.config.drawKw || 0;
            const idle = Math.min(b.config.idleDrawKw || 0, full);
            req = b.broken ? 0 : idle + (full - idle) * Math.pow(duty, b.config.partLoadExp || 1);
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
            // A brownout is a CITY-grid sag: it clips grid feeds only. A
            // generator is off-grid — immune by definition, on every path.
            if (b.type === "grid_feed" && STATE.brownout.active) {
                cap *= sanitize(STATE.brownout.factor, 0, 1);
            }
            p = Math.min(cap, sum);
            // Diagnostic only (sim/attribution.js reads it to name WHICH link
            // starved a rack). Nothing in the resolution reads it back.
            b.clippedKw = Math.max(0, sum - p);
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

    // 4) Roots. Sources are live roots (implicit "grid" parent). A grid
    // OUTAGE window (STATE.gridOutage.active) kills every GRID FEED at once:
    // unlike a brownout (degraded-not-dead), the chain below is dead and a
    // buffered UPS takes over. The window is the truth, not a per-building
    // stamp — a feed placed or rewired mid-outage is just as dead as one
    // that existed when the lights went out. Generators are immune to the
    // outage (that is their whole point) but die on an empty tank. Anything
    // with no live parent path is likewise a dead root. A final sweep
    // catches malformed leftovers.
    for (const b of STATE.buildings) {
        if (b.config.chainRole !== "source") continue;
        const live = b.type === "generator" ? b.fuelLiters > 0 : !feedIsDark(b);
        deliver(b, live, live ? Infinity : 0);
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

    // 5) STANDBY WAVE — the transfer switch. For each fueled generator, its
    // standby children whose PRIMARY path is dead start the cutover clock;
    // when it hits zero the generator re-delivers those subtrees out of its
    // remaining capacity. Double-count guards: a candidate whose primary
    // chain passes through another candidate of the same generator is
    // dropped (its pull is already inside the ancestor's), and a subtree
    // another generator re-delivered this tick counts as live, not dead —
    // belt-and-braces wiring must not burn fuel twice for the same racks.
    // UPS buffers in a re-delivered subtree are restored from the snapshot,
    // and a primary-ancestor UPS left bridging NOTHING (the generator took
    // its whole load) is restored too — while the generator carries, the
    // bridge stops draining, which is the whole lesson.
    const redelivered = new Set();
    const coveredByEarlierWave = (b) => {
        const maxHops = STATE.buildings.length + 1;
        let node = b;
        let hops = 0;
        while (node) {
            if (redelivered.has(node.id)) return true;
            if (!node.parentId || node.parentId === "grid" || ++hops > maxHops) return false;
            node = byId.get(node.parentId);
        }
        return false;
    };
    for (const g of STATE.buildings) {
        if (g.type !== "generator") continue;
        const candidates = [];
        for (const b of STATE.buildings) {
            if (b.standbyParentId === g.id && primaryPathDead(b, byId)
                && !coveredByEarlierWave(b) && pullOf(b) > 0) {
                candidates.push(b);
            }
        }
        // Intra-generator dedup: keep only the topmost of nested candidates.
        const candidateIds = new Set(candidates.map((c) => c.id));
        const standbys = candidates.filter((c) => {
            let node = byId.get(c.parentId);
            let hops = 0;
            while (node && ++hops <= STATE.buildings.length) {
                if (candidateIds.has(node.id)) return false;
                node = node.parentId && node.parentId !== "grid" ? byId.get(node.parentId) : null;
            }
            return true;
        });
        if (standbys.length === 0 || g.fuelLiters <= 0) {
            g.cutoverLeft = g.config.cutoverSec;
            continue;
        }
        g.cutoverLeft = Math.max(0, g.cutoverLeft - dt);
        if (g.cutoverLeft > 0) continue;

        const capLeft = Math.max(0, g.config.capacityKw - g.actualKw);
        let totalPull = 0;
        for (const c of standbys) totalPull += pullOf(c);
        const grantTotal = Math.min(capLeft, totalPull);
        if (grantTotal <= 0) continue;

        for (const c of standbys) {
            const stack = [c];
            while (stack.length) {
                const n = stack.pop();
                visited.delete(n.id);
                redelivered.add(n.id);
                if (n.type === "ups" && bufSnap.has(n.id)) {
                    n.bufferLeft = bufSnap.get(n.id);
                }
                for (const cid of n.childIds) {
                    const k = byId.get(cid);
                    if (k) stack.push(k);
                }
            }
            deliver(c, true, grantTotal * (pullOf(c) / totalPull));
        }
        g.actualKw += grantTotal;
        g.powered = true;
    }

    // Ancestor-UPS fixup: a UPS on the dead primary path above a standby
    // attach point self-granted in phase 4 and drained its buffer — but if
    // the generator has now taken over EVERYTHING the UPS was bridging, the
    // drain didn't happen physically. Restore its snapshot (held, neither
    // draining nor recharging: its own upstream is still dead). A UPS still
    // bridging other, non-transferred loads keeps its drain — buffer time is
    // time, however many kW it carries.
    if (redelivered.size > 0) {
        const carriesOutsideRedelivered = (node) => {
            for (const cid of node.childIds) {
                const k = byId.get(cid);
                if (!k) continue;
                if (redelivered.has(k.id)) continue;
                if (pullOf(k) > 0) return true;
                if (carriesOutsideRedelivered(k)) return true;
            }
            return false;
        };
        for (const c of STATE.buildings) {
            if (!c.standbyParentId || !redelivered.has(c.id)) continue;
            let node = byId.get(c.parentId);
            let hops = 0;
            while (node && ++hops <= STATE.buildings.length) {
                if (node.type === "ups" && !carriesOutsideRedelivered(node)) {
                    node.bufferLeft = bufSnap.get(node.id);
                    node.actualKw = 0;
                }
                node = node.parentId && node.parentId !== "grid" ? byId.get(node.parentId) : null;
            }
        }
    }

    // 6) Fuel burn (billing scale: one game minute = one billing hour) and
    // accounting.
    for (const b of STATE.buildings) {
        if (b.type === "generator" && b.actualKw > 0) {
            b.fuelLiters = Math.max(
                0,
                b.fuelLiters - b.actualKw * (dt / 60) * b.config.litersPerKwh
            );
        }
    }
    let itKw = 0;
    let coolKw = 0;
    for (const b of STATE.buildings) {
        if (b.type === "rack") itKw += b.actualKw;
        else if (b.type === "crac") coolKw += b.actualKw;
    }
    STATE.itDrawKw = itKw;
    STATE.totalDrawKw = itKw + coolKw;
}
