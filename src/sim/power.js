// sim/power.js — the wired power chain: topology + per-tick resolution.
//
// STATE fields owned by this module:
//   STATE.itDrawKw    — sum of rack actualKw this tick (the PUE denominator)
//   STATE.totalDrawKw — rack + CRAC + UPS-recharge actualKw this tick (total
//                       facility draw — PUE's numerator, and what would be
//                       billed if nothing were battery-sourced). The recharge
//                       part is banked PER UPS and summed at the end of the
//                       tick for the same reason the battery credit is: the
//                       standby wave resolves a subtree twice and the second
//                       resolution has to replace the first, not add to it.
//   STATE.gridKw      — of totalDrawKw, how much actually came THROUGH A
//                       LIVE GRID FEED this tick. This is what sim/demand.js
//                       bills, and the only thing a utility may bill: the
//                       rest came off a generator (already paid for in fuel)
//                       or out of a battery (already paid for in the
//                       recharge). "Grid" enters the model in exactly one
//                       place — a source of type grid_feed that is not dark
//                       — and rides down the chain like the credit below, so
//                       a SCOPED outage and a generator-fed room on a
//                       perfectly healthy grid both come out right without
//                       anything reading STATE.gridOutage.
//   STATE.batteryKw   — of totalDrawKw, how much was served from a UPS
//                       buffer this tick (peak shaving) rather than the
//                       grid. The HUD's signal for what the toggle is
//                       saving; the meter does not subtract it, because
//                       shaving displaces the kW out of gridKw where it
//                       happens. totalDrawKw/PUE do not change meaning.
//                       Banked at the LOADS that consumed it, never once per
//                       UPS traversed: ups -> ups is a legal edge, and
//                       crediting per UPS bills a two-deep chain twice. Held
//                       per node and summed at the end of the tick, never
//                       added to a running total, because the standby wave
//                       resolves a subtree TWICE and the second resolution
//                       has to replace the first — see deliver().
// Building fields owned by this module (declared in entities/Building.js):
//   parentId, childIds — power topology, via wireBuildings()/unwire()
//   actualKw, powered  — per-tick resolution results (links carry, loads draw)
//   bufferLeft         — UPS buffer seconds remaining
//   bufferOwedKws      — kW.s that actually left the battery and must be
//                        bought back; what the charger works down. For the
//                        outage bridge it is booked in 5c, AFTER the standby
//                        wave, off what the UPS ended up carrying — a
//                        generator taking half a bridged subtree means the
//                        battery never handed that half over, and billing
//                        the pre-transfer pull made the recharge cost
//                        multiples of the outage that caused it.
//   rechargeReqKw      — the charger's request, folded into the pull so the
//                        link above the UPS has to carry it
//   upsMode            — "idle" | "charging" | "shaving" | "bridging"
// Inputs read, never written: assignedKw (sim/demand.js), duty (sim/heat.js),
// STATE.peakShave.on (the player's toggle; owned by game.js).
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
//     the subtree goes dark) — the existing outage bridge, untouched by any
//     of the below. Otherwise, while the path is live: PEAK SHAVING
//     (STATE.peakShave.on, a player toggle, off by default) spends the
//     battery into the subtree instead of buying the same kW from the grid
//     — the player's own choice to spend stored energy rather than pay
//     whatever the meter costs right now. When not shaving (or the buffer
//     is empty), the charger buys the energy back: see CONFIG.buildings.ups.
//
//     THE BUFFER IS ENERGY, AND THE ENERGY HAS TO BALANCE. Shaving may only
//     hand out what the battery actually holds this tick: delivering
//     `kw` for `dt` seconds costs `kw * dt` kW.s, which is
//     `kw * dt / capacityKw` buffer-seconds, and if the battery holds less
//     than that the grid carries the remainder — the subtree is never
//     under-served, but the meter is never credited for a kW.s that was not
//     in the battery. A grant that ignored the charge left (and a
//     Math.max(0, ...) that forgave the shortfall) made a UPS a 400%
//     round-trip generator, profitable to leave switched on at any tariff.
//     The charger is the mirror image: it puts back exactly what left, so a
//     full cycle returns roundTripEff of what it cost and never more.
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

// Gear that is not passing power, whatever the reason. Today: an open
// breaker, or an open service window (sim/maintenance.js).
//
// This exists as one predicate because its two call sites sit on DELIBERATELY
// opposite sides of the UPS clause — before it in demand.js's chainAlive, so
// a tripped UPS cannot read as live and reintroduce the starvation bug pinned
// in tests/integration.test.mjs; after it in deliver(), so a tripped UPS
// cannot self-grant from its own buffer. Adding a second condition at each
// site by hand is how one of them ends up on the wrong side.
export function isDeadGear(b) {
    return b.tripped || b.outForService;
}

// The charger's draw while topping a UPS off, in kW — sized from the UPS's
// own capacity, not a flat number (see CONFIG.buildings.ups). Zero unless
// this UPS is actually going to charge, because the pull phase folds it into
// what the link ABOVE has to carry: a charger that is not running must not
// reserve a single kW of an upstream feed.
//
// Spending the battery and filling it in the same tick is not a thing, so a
// UPS with charge left and the shave toggle on asks for nothing. That is
// also what makes leaving the toggle on cost money rather than make it: the
// battery empties, the charger buys it back, the toggle spends it again, and
// every lap pays the round-trip loss for no change in when the energy was
// bought.
function chargerRequestKw(b) {
    const max = b.config.bufferSec || 0;
    if (b.bufferLeft >= max || isDeadGear(b)) return 0;
    if (STATE.peakShave.on && b.bufferLeft > 0) return 0;
    const eff = b.config.roundTripEff > 0 ? b.config.roundTripEff : 1;
    return ((b.config.capacityKw || 0) * (b.config.rechargeRate || 0)) / eff;
}

// Is a building's PRIMARY parent path dead? Walks parentIds to the root,
// ignoring UPS buffers — a bridged subtree still has a dead primary, which
// is exactly when the transfer switch must start its cutover countdown.
function primaryPathDead(b, byId) {
    const maxHops = STATE.buildings.length + 1;
    let node = b;
    let hops = 0;
    while (node) {
        // Dead gear (an open breaker OR an open service window) anywhere up
        // the primary path is a dead path — the same rule demand.js
        // chainAlive follows. Checked BEFORE the "grid" branch below, or a
        // SOURCE that is dead gear (a serviced grid_feed or generator) would
        // return from inside that branch and never reach this check at all —
        // only link/fanout nodes used to be able to trip, so that ordering
        // was unreachable before out-for-service widened isDeadGear to cover
        // sources too. Without this the generator's cutover clock resets
        // every tick while assignment keeps feeding the subtree work nobody
        // delivers: the assigned-but-never-served starvation the integration
        // suite exists to prevent — and the canonical case this misses is a
        // serviced UTILITY FEED, exactly when the standby generator must be
        // free to pick up.
        if (isDeadGear(node)) return true;
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
        // Seconds AND the energy they owe travel together — restoring one
        // without the other leaves a UPS that reads full and still bills a
        // recharge, or the reverse.
        if (b.type === "ups") bufSnap.set(b.id, { sec: b.bufferLeft, owed: b.bufferOwedKws });
        b.clippedKw = 0;
    }

    // Peak shaving (battCredit) and UPS charger draw (chargerDraw), gathered
    // as deliver() visits each node. See the header and CONFIG.buildings.ups
    // for what each becomes at the bottom of this tick.
    //
    // BOTH ARE BANKED PER NODE, NOT ADDED TO A RUNNING SUM.
    // A node can be resolved twice in one tick: the standby wave below rolls
    // a re-delivered subtree's UPS buffers back to bufSnap and delivers it
    // again off the generator. Every other per-node result of deliver() —
    // actualKw, powered, bufferLeft — is an ASSIGNMENT, so the second pass
    // simply replaces the first. A running total is the one shape that ADDS,
    // and it keeps the first pass's kW on the books after the charge behind
    // them has been handed back to the battery. That was true of the credit
    // (which kept billing racks the generator ended up serving) and it was
    // equally true of the charger draw: a UPS that charged on pass 1 had its
    // buffer rolled back and charged AGAIN on pass 2, so totalDrawKw carried
    // a charger that ran once and was billed twice — 22 kW of draw against
    // 12 kW of energy on the reference feed(dark) -> ups -> ups room, and
    // straight into the power bill and PUE. Keyed by the node that consumed
    // the kW (a load, or a UPS's own charger), so re-delivering a subtree
    // overwrites exactly what it re-resolves and nothing else.
    const battCredit = new Map();
    const chargerDraw = new Map();
    // Of what each node consumed, how much came THROUGH A LIVE GRID FEED —
    // the only kW a utility may bill. Banked per node under exactly the same
    // rule as the credit, and for the same reason.
    const gridDraw = new Map();
    // Seconds each bridging UPS drained this tick. The ENERGY behind them is
    // NOT booked here: the standby wave below may still take part of a
    // bridged subtree onto a generator, and bufferOwedKws is "what actually
    // left the battery", not "what the subtree pulled before the transfer
    // switch closed". Booked in 5c, once the wave has finished moving load.
    // Banked per node for the same reason as the two maps above.
    const bridgeDrain = new Map();

    // 1) Sanitized load requests.
    const requests = new Map();
    for (const b of STATE.buildings) {
        if (b.config.chainRole !== "load") continue;
        let req;
        if (b.config.drawKw !== undefined) {
            // Every cooling machine — CRAC, CRAH, chiller plant — is billed
            // on the same part-load curve, not a straight line: it pays its
            // idle draw (fans, pumps, the tower) before it moves any heat at
            // all, and the variable part rises sub-linearly with duty. A
            // broken unit is off, not idling — sim/heat.js forces its duty
            // to 0 and it must not bill.
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
            // What the subtree asked for, before the cap — this is the
            // overload signal the breaker integrates (the carried number
            // never exceeds 100% by construction and would never trip).
            b.demandedKw = sum;
            // Dead gear (tripped OR out for service) carries nothing UP the
            // chain either: without this, a serviced node still reports its
            // subtree's raw pull to its parent, under-reporting its own
            // clippedKw and making the parent split capacity with a phantom
            // sibling that is not actually drawing anything.
            if (isDeadGear(b)) cap = 0;
            p = Math.min(cap, sum);
            // Diagnostic only (sim/attribution.js reads it to name WHICH link
            // starved a rack). Nothing in the resolution reads it back.
            b.clippedKw = Math.max(0, sum - p);
            // A RECHARGING UPS IS A LOAD ON ITS OWN UPSTREAM. The charger
            // hangs off the input side, so it rides ON TOP of the output the
            // UPS is rated to carry (capacityKw is an output rating) but is
            // still carried, and therefore clipped, by every link above —
            // and burned as fuel by a generator that happens to be the one
            // carrying it. Billing the charger straight into totalDrawKw
            // without ever putting it on the chain is how a UPS recharged on
            // utility power in the middle of a total blackout.
            //
            // demandedKw and clippedKw stay output-side on purpose: the
            // breaker below integrates what the SUBTREE demanded of this
            // link, and a charger must not trip the UPS's own breaker.
            if (b.type === "ups") {
                b.rechargeReqKw = chargerRequestKw(b);
                p += b.rechargeReqKw;
            }
        }
        pulls.set(b.id, p);
        return p;
    }

    // 3) Top-down delivery: grants split proportionally to child pulls, so
    // every clip browns out its subtree uniformly.
    const visited = new Set();
    // grantBattKw: how much of grantKw came out of a battery upstream rather
    // than off the meter. It rides DOWN the chain and is banked at the loads,
    // because that is the only place a kW is counted exactly once — a UPS
    // may sit under another UPS, and crediting each one as it is traversed
    // bills a two-deep chain twice and lets the un-buffered half of the room
    // ride free behind demand.js's clamp.
    function deliver(b, live, grantKw, grantBattKw = 0, grantGridKw = 0) {
        if (visited.has(b.id)) return;
        visited.add(b.id);
        // Whatever this node banked on an earlier pass is void the moment it
        // is resolved again: this pass's grant is the truth. BOTH books get
        // cleared — whichever one is left behind outlives the buffer state it
        // was billed against.
        battCredit.delete(b.id);
        chargerDraw.delete(b.id);
        gridDraw.delete(b.id);
        bridgeDrain.delete(b.id);
        const pull = pullOf(b);

        if (b.config.chainRole === "load") {
            const got = live ? Math.min(grantKw, pull) : 0;
            b.actualKw = got;
            b.powered = live && (got > 0 || pull === 0);
            // THE ONE PLACE a load banks battery credit.
            if (got > 0 && grantBattKw > 0) battCredit.set(b.id, Math.min(got, grantBattKw));
            // ...and the one place it banks METERED draw, for the same
            // reason: a kW is counted where it is consumed, never once per
            // link it travelled through.
            if (got > 0 && grantGridKw > 0) gridDraw.set(b.id, Math.min(got, grantGridKw));
            return;
        }

        let outLive = live;
        let outKw = live ? Math.min(grantKw, pull) : 0;
        // Battery-sourced share of what this link actually carries. A link
        // clipped to half its grant carries half the battery kW too.
        let outBattKw = 0;
        if (outKw > 0 && grantBattKw > 0 && Number.isFinite(grantKw) && grantKw > 0) {
            outBattKw = Math.min(outKw, grantBattKw * Math.min(1, outKw / grantKw));
        }
        // Metered share of what this link carries, clipped the same way. It
        // ENTERS the model in exactly one place — a live grid feed — and a
        // root's grant is Infinity, so a source names its own share outright
        // instead of taking a fraction of one. That single entry point is
        // what makes the answer right for a SCOPED outage (the dark feed
        // contributes nothing, its healthy neighbour still does) and for a
        // generator-fed room on a perfectly healthy grid, neither of which
        // an `if (gridOutage.active)` special case could tell apart.
        let outGridKw = 0;
        if (outKw > 0) {
            if (b.config.chainRole === "source") {
                outGridKw = b.type === "grid_feed" ? outKw : 0;
            } else if (grantGridKw > 0 && Number.isFinite(grantKw) && grantKw > 0) {
                outGridKw = Math.min(outKw, grantGridKw * Math.min(1, outKw / grantKw));
            }
        }
        // What this node draws from its PARENT. Identical to outKw for
        // everything except a charging UPS, which also draws its charger.
        let carriedKw = outKw;

        if (b.type === "ups") {
            const max = b.config.bufferSec || 0;
            const cap = b.config.capacityKw || 0;
            const eff = b.config.roundTripEff > 0 ? b.config.roundTripEff : 1;
            // pull = the output-side subtree (already clipped by cap) PLUS
            // the charger request folded in by the pull phase. Only the
            // subtree part may go to the children.
            const subtreePull = Math.max(0, pull - (b.rechargeReqKw || 0));

            if (outLive) {
                // The load is served first; the charger lives on whatever is
                // left of the grant, battery-sourced or not. Refusing it
                // battery power sounds tidier and is not: a UPS one level up
                // has already committed that charge against this node's
                // whole pull, charger included, so declining it here deletes
                // the energy instead of delivering it. Taking it keeps the
                // books exact and charges the player honestly for it —
                // stacking UPSes and leaving the toggle on cycles the same
                // energy through two batteries at roundTripEff each.
                const served = Math.min(outKw, subtreePull);
                let battOut = Math.min(served, outBattKw);
                const spare = Math.max(0, outKw - served);
                const battSpare = Math.max(0, outBattKw - battOut);
                // The metered share splits in the same order: the subtree is
                // served first and the charger lives on what is left. Battery
                // kW are allocated to the load first, so the meter covers
                // only what the battery did not.
                let gridOut = Math.min(Math.max(0, served - battOut), outGridKw);
                const gridSpare = Math.max(0, outGridKw - gridOut);
                let chargeKw = 0;

                if (STATE.peakShave.on && b.bufferLeft > 0 && served > battOut) {
                    // PEAK SHAVING. Displace the GRID-sourced part of what
                    // this UPS is already delivering — same kW to the racks,
                    // bought from the battery instead of the meter — and
                    // only as far as the charge actually in the battery this
                    // tick reaches. Serving `displaceable` kW for dt seconds
                    // is displaceable*dt kW.s, which is that over capacityKw
                    // in buffer-seconds (bufferSec's own definition); when
                    // the battery holds less, the grid quietly carries the
                    // rest and the meter is credited only for what was
                    // really in there.
                    const displaceable = served - battOut;
                    const wantSec = cap > 0 ? (displaceable * dt) / cap : 0;
                    const useSec = Math.min(wantSec, b.bufferLeft);
                    const fromBattery = (useSec * cap) / dt;
                    b.bufferLeft -= useSec;
                    b.bufferOwedKws += fromBattery * dt;
                    battOut += fromBattery;
                    // Shaving DISPLACES metered kW — the same kW to the same
                    // racks, bought from the battery instead of the meter —
                    // so whatever it displaces stops being grid-sourced.
                    gridOut = Math.max(0, gridOut - fromBattery);
                    b.upsMode = fromBattery > 0 ? "shaving" : "idle";
                } else if ((b.rechargeReqKw || 0) > 0 && spare > 0 && b.bufferLeft < max) {
                    // RECHARGE. The charger draws what its rating and its
                    // upstream will allow, and puts back exactly the energy
                    // that left (bufferOwedKws) — never a nameplate refill.
                    // Seconds come back in step with the energy, so both hit
                    // full together however deep or shallow the discharge.
                    const deficitSec = max - b.bufferLeft;
                    const owed = b.bufferOwedKws > 0 ? b.bufferOwedKws : deficitSec * cap;
                    if (owed > 0) {
                        const draw = Math.min(b.rechargeReqKw, spare);
                        const restored = Math.min(owed, draw * eff * dt);
                        chargeKw = restored / (eff * dt);
                        b.bufferLeft = Math.min(max, b.bufferLeft + deficitSec * (restored / owed));
                        b.bufferOwedKws = Math.max(0, owed - restored);
                        if (b.bufferOwedKws === 0) b.bufferLeft = max;
                        chargerDraw.set(b.id, chargeKw);
                        // The charger is a load like any other, so the kW it
                        // took off an upstream battery is banked here, where
                        // it was consumed — the same rule the racks follow.
                        if (battSpare > 0 && chargeKw > 0) {
                            battCredit.set(b.id, Math.min(chargeKw, battSpare * (chargeKw / spare)));
                        }
                        // ...and so is the metered part of it. A charger
                        // running off a generator is fuel, not a bill.
                        if (gridSpare > 0 && chargeKw > 0) {
                            gridDraw.set(b.id, Math.min(chargeKw, gridSpare * (chargeKw / spare)));
                        }
                        b.upsMode = "charging";
                    } else {
                        b.upsMode = "idle";
                    }
                } else {
                    b.upsMode = "idle";
                }

                outKw = served;
                outBattKw = battOut;
                outGridKw = gridOut;
                carriedKw = served + chargeKw;
            } else if (b.bufferLeft > 0) {
                // The outage bridge, unchanged: seconds are spent at the
                // UPS's full rating however little it is carrying, because
                // that is the question this path answers — "how long do I
                // have?" — and every campaign level is proven against it.
                // The ENERGY it really handed over is what the charger will
                // have to buy back, so that is what gets recorded.
                outLive = true;
                outKw = subtreePull; // self-grant: serve the subtree from the buffer
                if (subtreePull > 0) {
                    const drainedSec = Math.min(dt, b.bufferLeft);
                    b.bufferLeft -= drainedSec;
                    // SECONDS now, ENERGY at 5c. Booking `subtreePull *
                    // drainedSec` here charges the battery for the whole
                    // PRE-TRANSFER subtree, and the standby wave has not run
                    // yet — a generator picking up half this subtree left
                    // the UPS owing for load it never ended up carrying, and
                    // the charger then bought that inflated figure back on
                    // the meter.
                    bridgeDrain.set(b.id, drainedSec);
                }
                outBattKw = 0; // bridged load is not peak shaving; see demand.js
                outGridKw = 0; // ...and it is the battery, not the meter
                carriedKw = outKw;
                b.upsMode = "bridging";
            } else {
                outKw = 0;
                outBattKw = 0;
                outGridKw = 0;
                carriedKw = 0;
                b.upsMode = "idle";
            }
        }

        // An OPEN breaker is dead, not merely zero-capacity: without this the
        // link keeps powered=true and hands a "live" chain to its now-idle
        // subtree, so racks behind an open breaker render green, skip the
        // NOT POWERED row, and keep counting toward no-throttle streaks
        // while serving nothing. Placed after the UPS clause so a tripped
        // UPS cannot self-grant from its buffer either.
        if (isDeadGear(b)) {
            outLive = false;
            outKw = 0;
            outBattKw = 0;
            outGridKw = 0;
            carriedKw = 0;
        }

        b.actualKw = carriedKw; // carried kW through this link/source
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
            const frac = totalChildPull > 0 ? pullOf(c) / totalChildPull : 0;
            deliver(c, childLive, outKw * frac, outBattKw * frac, outGridKw * frac);
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

    // Every fueled generator's transfer candidates, gathered BEFORE any of
    // them delivers. coveredByEarlierWave above walks a candidate's PARENTS
    // looking for an already-redelivered node, so it can only ever see a
    // candidate BELOW a wave that has already run. When the deeper
    // generator's wave runs first, the shallower generator's candidate is an
    // ANCESTOR of the redelivered set, that walk never sees it, and both
    // generators deliver — and burn fuel for — the same racks. Which of the
    // two happened depended on nothing but STATE.buildings order.
    const rawCandidates = new Map();
    for (const g of STATE.buildings) {
        if (g.type !== "generator" || g.fuelLiters <= 0) continue;
        const list = [];
        for (const b of STATE.buildings) {
            if (b.standbyParentId === g.id && primaryPathDead(b, byId) && pullOf(b) > 0) {
                list.push(b);
            }
        }
        if (list.length > 0) rawCandidates.set(g.id, list);
    }
    const candidateOwner = new Map();
    for (const [gid, list] of rawCandidates) {
        for (const c of list) candidateOwner.set(c.id, gid);
    }
    // When a generator is ready to carry, measured AFTER this tick's cutover
    // step. Comparing post-decrement clocks is what makes the handover
    // atomic: the shallower switch picks up on the same tick the deeper one
    // lets go, so the racks are never carried twice and never dropped in
    // between. A generator whose switch is still counting down cannot
    // supersede one that is already carrying — wiring a second generator
    // ABOVE a working one must not black the room out for a cutover.
    const readyAt = (gid) => Math.max(0, byId.get(gid).cutoverLeft - dt);
    // THE TOPMOST TRANSFER POINT WINS. This is the rule the wave already
    // applied between ONE generator's nested candidates ("keep only the
    // topmost"); applying it between generators too is what makes the answer
    // independent of placement order. Nothing loses coverage — the shallower
    // point's subtree strictly contains the deeper one's — and the
    // superseded generator simply idles with its cutover clock reset,
    // exactly as a covered candidate has always left it.
    const supersededByShallower = (c) => {
        const mine = readyAt(candidateOwner.get(c.id));
        let node = c.parentId && c.parentId !== "grid" ? byId.get(c.parentId) : null;
        let hops = 0;
        while (node && ++hops <= STATE.buildings.length) {
            const owner = candidateOwner.get(node.id);
            if (owner !== undefined && readyAt(owner) <= mine) return true;
            node = node.parentId && node.parentId !== "grid" ? byId.get(node.parentId) : null;
        }
        return false;
    };

    for (const g of STATE.buildings) {
        if (g.type !== "generator") continue;
        const standbys = (rawCandidates.get(g.id) || []).filter(
            (c) => !supersededByShallower(c) && !coveredByEarlierWave(c)
        );
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
                    n.bufferLeft = bufSnap.get(n.id).sec;
                    n.bufferOwedKws = bufSnap.get(n.id).owed;
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
    //
    // A UPS the wave ITSELF re-delivered is excluded: it was reset from the
    // snapshot and re-resolved a few lines up, on a live path, off the
    // generator. Restoring it again undoes the charge it just took, so it
    // sits pinned at the same bufferLeft for the whole outage while billing
    // its charger every tick — a recharge that is charged for and never
    // happens, which is what "the UPS spent 21.90 s recharging during a
    // total blackout" actually was.
    //
    // So is a UPS that was never bridging in the first place, and that is the
    // SAME failure by a different door. "Above a standby attach point on a
    // dead primary path" does not mean "running off its battery": the death
    // can sit BELOW the UPS — a tripped transformer, a serviced one — while
    // the UPS itself is on live utility power, legitimately charging. Such a
    // node carries nothing outside the redelivered set either, so the test
    // below passed it and rolled its charge back every tick: 300 kW.s billed
    // against 27 kW.s landed over 30 s on the reference room, the UPS pinned
    // at 2.25 s of buffer forever while paying 10 kW a tick. upsMode is the
    // signal that distinguishes them, and it is written by THIS tick's
    // deliver() — "bridging" is set on exactly the path that self-grants from
    // the buffer, which is the only drain this fixup exists to undo.
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
        // Did the wave reach anywhere inside this branch? A link BETWEEN a
        // bridging UPS and the transfer point is left holding a pre-transfer
        // actualKw for exactly the same reason the UPS is, so the carry has
        // to be rebuilt from the children rather than read off any one link.
        const waveTouched = (node) => {
            for (const cid of node.childIds) {
                const k = byId.get(cid);
                if (!k) continue;
                if (redelivered.has(k.id) || waveTouched(k)) return true;
            }
            return false;
        };
        // What a bridging UPS STILL hands down once the wave has taken part
        // of its subtree: the branches it still feeds, at this tick's
        // delivered numbers, plus any charger running inside them (banked
        // per node above, and drawn from this UPS like any other load).
        const stillOnBridgeKw = (node) => {
            let sum = chargerDraw.get(node.id) || 0;
            for (const cid of node.childIds) {
                const k = byId.get(cid);
                if (!k || redelivered.has(k.id)) continue;
                sum += waveTouched(k) ? stillOnBridgeKw(k) : k.actualKw;
            }
            return sum;
        };
        for (const c of STATE.buildings) {
            if (!c.standbyParentId || !redelivered.has(c.id)) continue;
            let node = byId.get(c.parentId);
            let hops = 0;
            while (node && ++hops <= STATE.buildings.length) {
                if (node.type === "ups" && node.upsMode === "bridging"
                    && !redelivered.has(node.id)) {
                    if (!carriesOutsideRedelivered(node)) {
                        node.bufferLeft = bufSnap.get(node.id).sec;
                        node.bufferOwedKws = bufSnap.get(node.id).owed;
                        node.actualKw = 0;
                    } else {
                        // PARTIAL transfer. The generator took some of this
                        // bridge's subtree and left the rest, so the bridge
                        // is still carrying and still spending SECONDS — but
                        // only over what it actually still feeds. Leaving the
                        // pre-transfer figure here is what billed a battery
                        // for racks a generator was carrying, and then billed
                        // the recharge back on the inflated number.
                        node.actualKw = stillOnBridgeKw(node);
                    }
                }
                node = node.parentId && node.parentId !== "grid" ? byId.get(node.parentId) : null;
            }
        }
    }

    // 5b) BREAKERS. Inverse-time: overload heat accrues at (ratio - 1) per
    // second and opens the link at tripSeconds, so a mild overload takes
    // ~20 s and a severe one 2 s. Below pickup nothing accrues and the heat
    // bleeds away, so a facility that never overloads can never trip. A
    // tripped link carries nothing until the player resets it — real gear
    // opens, it does not dim forever. Out-for-service gear (isDeadGear) is
    // skipped the same as a tripped one, but for the opposite reason: it is
    // isolated, so no current flows through it and it physically cannot
    // overheat — a service window must never trip its own breaker.
    const brk = CONFIG.breaker;
    for (const b of STATE.buildings) {
        const role = b.config.chainRole;
        if (role !== "link" && role !== "fanout") continue;
        const cap = Number.isFinite(b.config.capacityKw) ? b.config.capacityKw : 0;
        if (isDeadGear(b) || cap <= 0) continue;
        const ratio = b.demandedKw / cap;
        if (ratio > brk.pickupRatio) {
            b.breakerHeat += dt * (ratio - 1);
            if (b.breakerHeat >= brk.tripSeconds) {
                b.tripped = true;
                b.breakerHeat = 0;
            }
        } else {
            b.breakerHeat = Math.max(0, b.breakerHeat - dt * brk.coolPerSec);
        }
    }

    // 5c) THE BRIDGE'S ENERGY BOOK, after the wave has finished moving load.
    // bufferLeft counts SECONDS and the bridge spends them at the UPS's full
    // rating however little it carries; bufferOwedKws counts the ENERGY that
    // actually left, and that is the one the charger buys back on the meter.
    // Two different quantities, and only the second one may follow the load —
    // booking it against the pre-transfer subtree pull up in deliver() is how
    // one physical discharge ended up with two numbers describing it.
    for (const [id, drainedSec] of bridgeDrain) {
        const b = byId.get(id);
        // Still bridging: a UPS the wave re-delivered took the live branch on
        // its second pass and had its buffer rolled back to the snapshot, so
        // there is no discharge left to book.
        if (!b || b.upsMode !== "bridging") continue;
        b.bufferOwedKws += Math.max(0, b.actualKw) * drainedSec;
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
        else if (b.config.chainRole === "load") coolKw += b.actualKw;
    }
    STATE.itDrawKw = itKw;
    // Total facility draw still means what it always meant — racks, cooling,
    // and now UPS recharge draw, billed like any other load. PUE (computed
    // from this in src/ui/hud.js) legitimately rises while a UPS recharges:
    // that overhead is real, same as a CRAC's idle draw. Summed here, once,
    // over the LAST resolution of every charger that ran this tick — same
    // rule as the credit below, and for the same reason.
    let rechargeSum = 0;
    for (const kw of chargerDraw.values()) rechargeSum += kw;
    STATE.totalDrawKw = itKw + coolKw + rechargeSum;
    // What sim/demand.js subtracts before billing — see the header. Summed
    // here, once, over the LAST resolution of every node that consumed
    // battery kW this tick: a subtree the standby wave re-delivered counts
    // as the generator served it, not as the battery served it and then the
    // generator served it again.
    let batterySum = 0;
    for (const kw of battCredit.values()) batterySum += kw;
    STATE.batteryKw = batterySum;
    // What the UTILITY actually delivered, and therefore all it may bill.
    // Summed the same way, once, over the LAST resolution of every node —
    // a subtree the standby wave re-delivered came off the generator, and
    // the generator is already paying for it in fuel.
    let gridSum = 0;
    for (const kw of gridDraw.values()) gridSum += kw;
    STATE.gridKw = gridSum;
}
