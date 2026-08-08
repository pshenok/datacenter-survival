// Unit tests for src/sim/power.js — topology rules, proportional brownout,
// UPS buffer mechanics, and the no-NaN / no-op guards. Node env, real modules.
import { beforeEach, describe, expect, it } from "vitest";

import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower, unwire, wireBuildings } from "../src/sim/power.js";

function place(type, gx = 0, gz = 0) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// grid_feed -> transformer -> ups -> pdu, ready for loads.
function chain() {
    const feed = place("grid_feed");
    const t = place("transformer");
    const ups = place("ups");
    const pdu = place("pdu");
    wireBuildings(feed, t);
    wireBuildings(t, ups);
    wireBuildings(ups, pdu);
    return { feed, t, ups, pdu };
}

// Sum of load actualKw in a node's subtree — the kW the link really carries.
function carriedBy(node) {
    const byId = new Map(STATE.buildings.map((b) => [b.id, b]));
    let sum = 0;
    const stack = [...node.childIds];
    while (stack.length > 0) {
        const b = byId.get(stack.pop());
        if (!b) continue;
        if (b.config.chainRole === "load") sum += b.actualKw;
        else stack.push(...b.childIds);
    }
    return sum;
}

// feed(40) -> t1,t2(30) -> two pdus each(16) -> 3 racks each @ full 6 kW.
// Raw demand 72, source-limited to exactly 40.
function overloadedTree() {
    const feed = place("grid_feed");
    const racks = [];
    for (let i = 0; i < 2; i++) {
        const t = place("transformer");
        wireBuildings(feed, t);
        for (let j = 0; j < 2; j++) {
            const pdu = place("pdu");
            wireBuildings(t, pdu);
            for (let k = 0; k < 3; k++) {
                const rack = place("rack");
                rack.assignedKw = 6;
                wireBuildings(pdu, rack);
                racks.push(rack);
            }
        }
    }
    return { feed, racks };
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("topology helpers", () => {
    it("wires a legal chain and maintains parentId/childIds", () => {
        const { feed, t, ups, pdu } = chain();
        const rack = place("rack");
        expect(wireBuildings(pdu, rack)).toBe(true);
        expect(t.parentId).toBe(feed.id);
        expect(feed.childIds).toEqual([t.id]);
        expect(ups.parentId).toBe(t.id);
        expect(pdu.parentId).toBe(ups.id);
        expect(rack.parentId).toBe(pdu.id);
        expect(pdu.childIds).toEqual([rack.id]);
        expect(feed.parentId).toBe("grid"); // sources are born rooted on the grid
    });

    it("rejects every illegal edge without mutating topology", () => {
        const feed = place("grid_feed");
        const t = place("transformer");
        const pdu = place("pdu");
        const pdu2 = place("pdu");
        const rack = place("rack");
        const crac = place("crac");
        expect(wireBuildings(feed, rack)).toBe(false); // source -> load
        expect(wireBuildings(t, rack)).toBe(false); // link -> load
        expect(wireBuildings(pdu, pdu2)).toBe(false); // fanout -> fanout
        expect(wireBuildings(pdu, t)).toBe(false); // fanout -> link
        expect(wireBuildings(rack, crac)).toBe(false); // load -> anything
        expect(wireBuildings(t, feed)).toBe(false); // nothing wires INTO a source
        expect(wireBuildings(t, t)).toBe(false); // self-wire
        expect(rack.parentId).toBeNull();
        expect(feed.childIds).toEqual([]);
        expect(pdu.childIds).toEqual([]);
    });

    it("enforces single parent: rewiring unwires the old parent", () => {
        chain();
        const pdu1 = STATE.buildings[3];
        const pdu2 = place("pdu");
        wireBuildings(STATE.buildings[2], pdu2); // ups -> pdu2
        const rack = place("rack");
        wireBuildings(pdu1, rack);
        expect(wireBuildings(pdu2, rack)).toBe(true);
        expect(rack.parentId).toBe(pdu2.id);
        expect(pdu1.childIds).not.toContain(rack.id);
        expect(pdu2.childIds).toEqual([rack.id]);
    });

    it("is idempotent for an existing edge (no duplicate childIds)", () => {
        const feed = place("grid_feed");
        const t = place("transformer");
        expect(wireBuildings(feed, t)).toBe(true);
        expect(wireBuildings(feed, t)).toBe(true);
        expect(feed.childIds).toEqual([t.id]);
    });

    it("rejects a wire that would create a cycle", () => {
        const t1 = place("transformer");
        const t2 = place("transformer");
        const t3 = place("transformer");
        expect(wireBuildings(t1, t2)).toBe(true);
        expect(wireBuildings(t2, t3)).toBe(true);
        expect(wireBuildings(t3, t1)).toBe(false); // would close a ring
        expect(wireBuildings(t2, t1)).toBe(false);
        expect(t1.parentId).toBeNull();
    });

    it("unwire removes the edge once and reports it", () => {
        const feed = place("grid_feed");
        const t = place("transformer");
        wireBuildings(feed, t);
        expect(unwire(t)).toBe(true);
        expect(t.parentId).toBeNull();
        expect(feed.childIds).toEqual([]);
        expect(unwire(t)).toBe(false); // nothing left to unwire
        expect(unwire(feed)).toBe(false); // a root has no wire to remove
    });
});

describe("resolvePower — delivery and brownout", () => {
    it("delivers a full request through a live chain and writes STATE draws", () => {
        const { pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 5;
        wireBuildings(pdu, rack);
        resolvePower(1);
        expect(rack.actualKw).toBeCloseTo(5, 9);
        expect(rack.powered).toBe(true);
        expect(STATE.itDrawKw).toBeCloseTo(5, 9);
        expect(STATE.totalDrawKw).toBeCloseTo(5, 9);
    });

    it("an idle rack on a live chain is powered; an unwired rack is not", () => {
        const { pdu } = chain();
        const idle = place("rack");
        wireBuildings(pdu, idle);
        const orphan = place("rack");
        orphan.assignedKw = 4;
        resolvePower(1);
        expect(idle.powered).toBe(true);
        expect(idle.actualKw).toBe(0);
        expect(orphan.powered).toBe(false);
        expect(orphan.actualKw).toBe(0);
        expect(STATE.itDrawKw).toBe(0);
    });

    it("clamps a rack request to its own capacityKw", () => {
        const { pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 50;
        wireBuildings(pdu, rack);
        resolvePower(1);
        expect(rack.actualKw).toBeCloseTo(CONFIG.buildings.rack.capacityKw, 9);
    });

    it("brownout at an overloaded PDU clips all racks proportionally", () => {
        const { pdu } = chain();
        const racks = [];
        for (let i = 0; i < 3; i++) {
            const rack = place("rack");
            rack.assignedKw = 6;
            wireBuildings(pdu, rack);
            racks.push(rack);
        }
        resolvePower(1); // 18 kW asked of a 16 kW PDU
        for (const rack of racks) {
            expect(rack.actualKw).toBeCloseTo(6 * (16 / 18), 9);
            expect(rack.powered).toBe(true);
        }
        expect(STATE.itDrawKw).toBeCloseTo(16, 9);
    });

    it("multi-level clipping multiplies factors down the path", () => {
        const { racks } = overloadedTree();
        resolvePower(1);
        // pulls: pdu 16 of 18 asked, transformer 30 of 32, source 40 of 60
        const expected = 6 * (16 / 18) * (30 / 32) * (40 / 60);
        for (const rack of racks) {
            expect(rack.actualKw).toBeCloseTo(expected, 9);
        }
        expect(STATE.itDrawKw).toBeCloseTo(40, 9); // exactly the source cap
    });

    it("no link ever carries more than its capacityKw", () => {
        const { feed } = overloadedTree();
        resolvePower(1);
        for (const b of STATE.buildings) {
            if (b.config.chainRole === "load") continue;
            const carried = carriedBy(b);
            expect(carried).toBeLessThanOrEqual(b.config.capacityKw + 1e-9);
            expect(b.actualKw).toBeCloseTo(carried, 9); // links report carried kW
        }
        expect(carriedBy(feed)).toBeCloseTo(40, 9); // saturated, not exceeded
    });

    it("clips asymmetric sibling subtrees by the same shared factor", () => {
        const feed = place("grid_feed");
        const t = place("transformer");
        wireBuildings(feed, t);
        const pulls = [1, 2, 3]; // racks per pdu
        const firstRacks = [];
        for (const n of pulls) {
            const pdu = place("pdu");
            wireBuildings(t, pdu);
            for (let k = 0; k < n; k++) {
                const rack = place("rack");
                rack.assignedKw = 6;
                wireBuildings(pdu, rack);
                if (k === 0) firstRacks.push(rack);
            }
        }
        resolvePower(1);
        // pdu pulls 6, 12, 16 -> transformer sees 34, carries its 30 cap.
        const tFactor = 30 / 34;
        expect(firstRacks[0].actualKw).toBeCloseTo(6 * tFactor, 9);
        expect(firstRacks[1].actualKw).toBeCloseTo(6 * tFactor, 9);
        expect(firstRacks[2].actualKw).toBeCloseTo(6 * (16 / 18) * tFactor, 9);
        expect(STATE.itDrawKw).toBeCloseTo(30, 9);
    });

    it("CRAC draw lands in totalDrawKw but never in itDrawKw", () => {
        const { pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        const crac = place("crac");
        crac.duty = 1;
        wireBuildings(pdu, crac);
        resolvePower(1);
        const cfg = CONFIG.buildings.crac;
        expect(crac.actualKw).toBeCloseTo(cfg.drawKw, 9);
        expect(crac.powered).toBe(true);
        expect(STATE.itDrawKw).toBeCloseTo(4, 9);
        expect(STATE.totalDrawKw).toBeCloseTo(4 + cfg.drawKw, 9);
    });
});

// Part-load physics: fans and pumps spin whether or not there is heat to
// move, so draw is idle + (full - idle) * duty^exp — NOT a straight line.
// The consequence is the lesson the game teaches with PUE, so it is pinned
// here: split the same cooling job across more units and you pay more.
describe("CRAC part-load draw", () => {
    const cfg = () => CONFIG.buildings.crac;
    function drawAt(duty, broken = false) {
        resetState();
        resetBuildingIds();
        const { pdu } = chain();
        const crac = place("crac");
        crac.duty = duty;
        crac.broken = broken;
        wireBuildings(pdu, crac);
        resolvePower(1);
        return crac.actualKw;
    }

    it("pays idle draw at zero duty and full draw at full duty", () => {
        // Absolute, CONFIG-independent: idle draw existing AT ALL is the
        // mechanic. Tuning idleDrawKw to 0 must turn this red, and reading
        // the bound from CONFIG would let it pass.
        expect(drawAt(0)).toBeGreaterThan(0);
        expect(drawAt(0)).toBeLessThan(drawAt(1));
        expect(drawAt(0)).toBeCloseTo(cfg().idleDrawKw, 9);
        expect(drawAt(1)).toBeCloseTo(cfg().drawKw, 9);
    });

    it("is CONCAVE, not merely affine — the curve is the point", () => {
        // An affine draw (partLoadExp = 1) already beats the old linear
        // model, but the sub-linear curve is what makes the first fraction
        // of duty the expensive one. Margin chosen so exp=1 fails.
        const lo = drawAt(0);
        const hi = drawAt(1);
        expect(drawAt(0.5)).toBeGreaterThan(lo + (hi - lo) * 0.55);
    });

    it("is monotonic in duty and always between idle and full", () => {
        let prev = -Infinity;
        for (const d of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
            const kw = drawAt(d);
            expect(kw).toBeGreaterThanOrEqual(prev);
            expect(kw).toBeGreaterThanOrEqual(cfg().idleDrawKw - 1e-9);
            expect(kw).toBeLessThanOrEqual(cfg().drawKw + 1e-9);
            prev = kw;
        }
    });

    it("THE LESSON: two half-loaded units cost more than one full one", () => {
        // Cooling delivered is coolPerSec * duty — linear — so 2 x 0.5 duty
        // removes exactly the heat 1 x 1.0 does. The power bill does not agree.
        expect(2 * drawAt(0.5)).toBeGreaterThan(drawAt(1));
        expect(4 * drawAt(0.25)).toBeGreaterThan(2 * drawAt(0.5));
    });

    it("a broken unit is off, not idling — it must not bill", () => {
        expect(drawAt(0, true)).toBe(0);
        expect(drawAt(1, true)).toBe(0);
    });
});

describe("resolvePower — UPS buffer", () => {
    it("carries its subtree exactly bufferSec seconds through an outage, then dark", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        resolvePower(1);
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec);
        unwire(ups); // the blip: path to the root breaks
        for (let s = 1; s <= CONFIG.buildings.ups.bufferSec; s++) {
            resolvePower(1);
            expect(rack.actualKw).toBeCloseTo(4, 9);
            expect(rack.powered).toBe(true);
            expect(ups.powered).toBe(true);
            expect(ups.bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec - s, 9);
        }
        resolvePower(1); // buffer exhausted: subtree goes dark
        expect(ups.bufferLeft).toBe(0);
        expect(ups.powered).toBe(false);
        expect(rack.actualKw).toBe(0);
        expect(rack.powered).toBe(false);
        expect(STATE.itDrawKw).toBe(0);
    });

    it("drains by dt for fractional ticks too", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        const ticks = CONFIG.buildings.ups.bufferSec / 0.5;
        for (let i = 0; i < ticks; i++) {
            resolvePower(0.5);
            expect(rack.powered).toBe(true);
        }
        expect(ups.bufferLeft).toBeCloseTo(0, 9);
        resolvePower(0.5);
        expect(rack.powered).toBe(false);
    });

    it("recharges by the ENERGY that left, not the seconds, capped at bufferSec", () => {
        const u = CONFIG.buildings.ups;
        const { t, ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        for (let i = 0; i < 3; i++) resolvePower(1);
        expect(ups.bufferLeft).toBeCloseTo(5, 9);
        // Bridging spends SECONDS at the UPS's full rating whatever it is
        // carrying, but the battery only handed over what the room drew:
        // 3 s at 4 kW is 12 kW.s, not the 3 x 36 = 108 kW.s a nameplate
        // refill would make the player buy back.
        expect(ups.bufferOwedKws).toBeCloseTo(12, 9);
        wireBuildings(t, ups); // power restored
        // The charger is sized off the UPS's own capacity and lands
        // roundTripEff of its draw in the battery: 10 kW in, 9 kW.s/s stored.
        resolvePower(0.5);
        expect(ups.bufferOwedKws).toBeCloseTo(12 - 4.5, 9);
        // Seconds come back in step with the energy, so both reach full
        // together: 37.5% of the energy is 37.5% of the 3 missing seconds.
        expect(ups.bufferLeft).toBeCloseTo(5 + 3 * (4.5 / 12), 9);
        expect(rack.actualKw).toBeCloseTo(4, 9); // served by the grid again
        resolvePower(1);
        expect(ups.bufferLeft).toBe(u.bufferSec); // capped, and paid off
        expect(ups.bufferOwedKws).toBe(0);
        resolvePower(100);
        expect(ups.bufferLeft).toBe(u.bufferSec);
    });

    it("does not drain while the outage subtree draws nothing, and keeps it live", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        wireBuildings(pdu, rack); // idle: assignedKw 0
        unwire(ups);
        resolvePower(1);
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec);
        expect(rack.powered).toBe(true); // idle rack on a buffer-live chain
        expect(rack.actualKw).toBe(0);
    });

    it("a never-wired UPS roots its own subtree from the buffer", () => {
        const ups = place("ups");
        const pdu = place("pdu");
        wireBuildings(ups, pdu);
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        resolvePower(1);
        expect(rack.actualKw).toBeCloseTo(4, 9);
        expect(rack.powered).toBe(true);
        expect(ups.bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec - 1, 9);
    });
});

describe("resolvePower — guards", () => {
    it("dt === 0 is a strict no-op, even mid-outage", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        unwire(ups);
        resolvePower(1); // carrying: buffer 7, rack served
        const snapshot = STATE.buildings.map((b) => ({
            actualKw: b.actualKw,
            powered: b.powered,
            bufferLeft: b.bufferLeft,
        }));
        const { itDrawKw, totalDrawKw } = STATE;
        resolvePower(0);
        STATE.buildings.forEach((b, i) => {
            expect(b.actualKw).toBe(snapshot[i].actualKw);
            expect(b.powered).toBe(snapshot[i].powered);
            expect(b.bufferLeft).toBe(snapshot[i].bufferLeft);
        });
        expect(STATE.itDrawKw).toBe(itDrawKw);
        expect(STATE.totalDrawKw).toBe(totalDrawKw);
    });

    it("NaN or negative dt is also a no-op", () => {
        const { pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        resolvePower(NaN);
        resolvePower(-1);
        expect(rack.actualKw).toBe(0); // never resolved
        expect(STATE.itDrawKw).toBe(0);
    });

    it("absurd inputs never produce NaN", () => {
        const { pdu } = chain();
        const nanRack = place("rack");
        nanRack.assignedKw = NaN;
        wireBuildings(pdu, nanRack);
        const negRack = place("rack");
        negRack.assignedKw = -5;
        wireBuildings(pdu, negRack);
        const infRack = place("rack");
        infRack.assignedKw = Infinity;
        wireBuildings(pdu, infRack);
        const crac = place("crac");
        crac.duty = NaN;
        wireBuildings(pdu, crac);
        resolvePower(1);
        expect(nanRack.actualKw).toBe(0);
        expect(nanRack.powered).toBe(true); // sanitized to an idle rack
        expect(negRack.actualKw).toBe(0);
        expect(infRack.actualKw).toBeCloseTo(CONFIG.buildings.rack.capacityKw, 9);
        // NaN duty sanitizes to 0 — which is idle, not off (see part-load).
        expect(crac.actualKw).toBeCloseTo(CONFIG.buildings.crac.idleDrawKw, 9);
        expect(Number.isFinite(STATE.itDrawKw)).toBe(true);
        expect(Number.isFinite(STATE.totalDrawKw)).toBe(true);
        for (const b of STATE.buildings) {
            expect(Number.isFinite(b.actualKw)).toBe(true);
        }
    });

    it("independent roots resolve as a forest", () => {
        const { pdu } = chain();
        const rackA = place("rack");
        rackA.assignedKw = 3;
        wireBuildings(pdu, rackA);
        const feed2 = place("grid_feed");
        const t2 = place("transformer");
        const pdu2 = place("pdu");
        wireBuildings(feed2, t2);
        wireBuildings(t2, pdu2);
        const rackB = place("rack");
        rackB.assignedKw = 5;
        wireBuildings(pdu2, rackB);
        resolvePower(1);
        expect(rackA.actualKw).toBeCloseTo(3, 9);
        expect(rackB.actualKw).toBeCloseTo(5, 9);
        expect(STATE.itDrawKw).toBeCloseTo(8, 9);
    });

    it("an empty world resolves to zero draws without throwing", () => {
        resolvePower(1);
        expect(STATE.itDrawKw).toBe(0);
        expect(STATE.totalDrawKw).toBe(0);
    });
});

describe("adversarial", () => {
    it("browns out 50 racks + 6 CRACs on one PDU proportionally, sum exactly at cap", () => {
        const feed = place("grid_feed");
        const t = place("transformer");
        const pdu = place("pdu");
        wireBuildings(feed, t);
        wireBuildings(t, pdu);
        const racks = [];
        for (let i = 0; i < 50; i++) {
            const rack = place("rack");
            rack.assignedKw = 6;
            wireBuildings(pdu, rack);
            racks.push(rack);
        }
        const cracs = [];
        for (let i = 0; i < 6; i++) {
            const crac = place("crac");
            crac.duty = 1;
            wireBuildings(pdu, crac);
            cracs.push(crac);
        }
        resolvePower(1);
        // Raw demand 50*6 + 6*3 = 318 kW over a 16 kW PDU.
        const factor = 16 / 318;
        for (const rack of racks) {
            expect(rack.actualKw).toBeCloseTo(6 * factor, 9);
            expect(rack.powered).toBe(true);
        }
        for (const crac of cracs) {
            expect(crac.actualKw).toBeCloseTo(3 * factor, 9);
            expect(crac.powered).toBe(true);
        }
        expect(pdu.actualKw).toBeCloseTo(16, 9);
        expect(STATE.itDrawKw).toBeCloseTo(300 * factor, 9);
        expect(STATE.totalDrawKw).toBeCloseTo(16, 9);
    });

    it("resolves a 300-transformer-deep chain without blowing the stack", () => {
        const feed = place("grid_feed");
        let upstream = feed;
        const links = [];
        for (let i = 0; i < 300; i++) {
            const t = place("transformer");
            wireBuildings(upstream, t);
            links.push(t);
            upstream = t;
        }
        const pdu = place("pdu");
        wireBuildings(upstream, pdu);
        const rack = place("rack");
        rack.assignedKw = 6;
        wireBuildings(pdu, rack);
        resolvePower(1);
        expect(rack.actualKw).toBeCloseTo(6, 9);
        expect(rack.powered).toBe(true);
        for (const t of links) {
            expect(t.actualKw).toBeCloseTo(6, 9);
            expect(t.powered).toBe(true);
        }
        expect(STATE.itDrawKw).toBeCloseTo(6, 9);
    });

    it("chained UPSes carry an outage back-to-back for 2x bufferSec, then dark", () => {
        const bufferSec = CONFIG.buildings.ups.bufferSec;
        const ups1 = place("ups");
        const ups2 = place("ups");
        const pdu = place("pdu");
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(ups1, ups2);
        wireBuildings(ups2, pdu);
        wireBuildings(pdu, rack);
        // Never wired to any source: ups1 is a dead root from tick one.
        for (let s = 1; s <= bufferSec; s++) {
            resolvePower(1);
            expect(rack.actualKw).toBeCloseTo(4, 9);
            expect(rack.powered).toBe(true);
            expect(ups1.bufferLeft).toBeCloseTo(bufferSec - s, 9);
            expect(ups2.bufferLeft).toBe(bufferSec); // fed by ups1, not draining
        }
        for (let s = 1; s <= bufferSec; s++) {
            resolvePower(1);
            expect(rack.actualKw).toBeCloseTo(4, 9);
            expect(rack.powered).toBe(true);
            expect(ups1.powered).toBe(false); // exhausted, dead link
            expect(ups2.bufferLeft).toBeCloseTo(bufferSec - s, 9);
        }
        resolvePower(1); // both buffers spent
        expect(rack.powered).toBe(false);
        expect(rack.actualKw).toBe(0);
        expect(STATE.itDrawKw).toBe(0);
    });

    it("survives demolition leftovers: stale childIds and vanished parents", () => {
        const { ups, pdu } = chain();
        const rackA = place("rack");
        rackA.assignedKw = 5;
        wireBuildings(pdu, rackA);
        const feed2 = place("grid_feed");
        const t2 = place("transformer");
        const pdu2 = place("pdu");
        wireBuildings(feed2, t2);
        wireBuildings(t2, pdu2);
        const rackB = place("rack");
        rackB.assignedKw = 3;
        wireBuildings(pdu2, rackB);
        resolvePower(1);
        expect(STATE.itDrawKw).toBeCloseTo(8, 9);
        // Demolish without unwiring — the worst-case caller.
        STATE.buildings.splice(STATE.buildings.indexOf(rackA), 1); // stale id in pdu.childIds
        STATE.buildings.splice(STATE.buildings.indexOf(t2), 1); // pdu2's parent vanishes
        resolvePower(1);
        expect(STATE.itDrawKw).toBe(0); // rackA gone, rackB dark
        expect(STATE.totalDrawKw).toBe(0);
        expect(rackB.powered).toBe(false);
        expect(rackB.actualKw).toBe(0);
        expect(pdu2.powered).toBe(false);
        expect(ups.powered).toBe(true); // chain A itself is still live, just idle
        expect(pdu.actualKw).toBe(0);
        for (const b of STATE.buildings) {
            expect(Number.isFinite(b.actualKw)).toBe(true);
        }
    });

    it("dt boundaries: Infinity and -0 are no-ops, MIN_VALUE still serves", () => {
        const { ups, pdu } = chain();
        const rack = place("rack");
        rack.assignedKw = 5;
        wireBuildings(pdu, rack);
        resolvePower(1);
        resolvePower(Infinity);
        resolvePower(-0);
        expect(rack.actualKw).toBeCloseTo(5, 9); // untouched by the no-ops
        expect(STATE.itDrawKw).toBeCloseTo(5, 9);
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec);
        unwire(ups);
        resolvePower(Number.MIN_VALUE); // tiniest legal tick, mid-outage
        expect(rack.actualKw).toBeCloseTo(5, 9); // buffer serves the full request
        expect(rack.powered).toBe(true);
        expect(ups.bufferLeft).toBe(CONFIG.buildings.ups.bufferSec); // drain of 5e-324 rounds away
    });

    it("a rejected cycle rewire leaves the existing wire untouched", () => {
        const feed = place("grid_feed");
        const t1 = place("transformer");
        const t2 = place("transformer");
        wireBuildings(feed, t1);
        wireBuildings(t1, t2);
        expect(wireBuildings(t2, t1)).toBe(false); // cycle: t1 is t2's ancestor
        expect(t1.parentId).toBe(feed.id); // the old wire must survive the rejection
        expect(feed.childIds).toContain(t1.id);
        expect(t2.parentId).toBe(t1.id);
        const pdu = place("pdu");
        expect(wireBuildings(pdu, t1)).toBe(false); // illegal role, same guarantee
        expect(t1.parentId).toBe(feed.id);
        wireBuildings(t2, pdu);
        const rack = place("rack");
        rack.assignedKw = 4;
        wireBuildings(pdu, rack);
        resolvePower(1);
        expect(rack.actualKw).toBeCloseTo(4, 9); // chain still fully functional
    });
});
