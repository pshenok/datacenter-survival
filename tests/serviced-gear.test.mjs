// Out-for-service gear is DEAD GEAR. sim/maintenance.js says so outright,
// pointing at isDeadGear in sim/power.js, and resolvePower honoured it on the
// CHAIN half: the non-load branch of pullOf zeroes a dead node's capacity, so
// a serviced transformer or PDU carries nothing.
//
// The LOAD half never asked. Step 1 built a cooling machine's request as
// `b.broken ? 0 : idle + ...` — broken was checked, outForService was not — so
// a CRAC, CRAH or chiller on an open service window kept drawing its full
// part-load figure while nobody was allowed to be touching it. Measured
// before the fix: 3 kW, and powered = true.
//
// Not reachable in the shipped game. The only level that opens a work order
// (night_shift) points it at buildings 2 and 3, which are its two PDUs —
// fanout nodes, correctly killed. This is a trap set for the next level that
// schedules work on a cooling unit, which is the obvious next thing to do
// with the mechanic.
//
// BOTH sides move together. Stopping the draw without stopping the cooling
// would have been the worse bug: a machine moving heat for free.
import { describe, expect, it, beforeEach } from "vitest";

import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower, wireBuildings } from "../src/sim/power.js";
import { tickHeat } from "../src/sim/heat.js";

const DT = 0.05;
const place = (t, x, z) => { const b = new Building(t, x, z); STATE.buildings.push(b); return b; };

function roomWith(coolerType, { heat = false } = {}) {
    const feed = place("grid_feed", 2, 5);
    const tr = place("transformer", 5, 5);
    const pdu = place("pdu", 8, 5);
    wireBuildings(feed, tr); wireBuildings(tr, pdu);
    if (heat) {
        // A CRAH's demand on the loop is coolPerSec * duty, and duty is
        // derived from the heat actually present. Without something warm in
        // the room it settles at zero and the loop reads empty whether the
        // machine is serviced or not — which would make the test below pass
        // for the wrong reason.
        const rack = place("rack", 14, 5);
        wireBuildings(pdu, rack);
        rack.assignedKw = CONFIG.buildings.rack.capacityKw;
    }
    const cooler = place(coolerType, 11, 5);
    wireBuildings(pdu, cooler);
    cooler.duty = 1;
    return cooler;
}

describe("a machine out for service is off, on both sides of the loop", () => {
    beforeEach(() => { resetState(); resetBuildingIds(); STATE.isRunning = true; });

    for (const type of ["crac", "crah", "chiller"]) {
        it(`${type}: stops drawing power the moment its window opens`, () => {
            const cooler = roomWith(type);
            for (let k = 0; k < 20; k++) resolvePower(DT);
            expect(cooler.actualKw, "it must be running first").toBeGreaterThan(0);

            cooler.outForService = true;
            for (let k = 0; k < 20; k++) resolvePower(DT);
            expect(cooler.actualKw).toBe(0);
            expect(STATE.totalDrawKw, "nothing else is in this room").toBe(0);
        });
    }

    it("...AND stops cooling — a unit that drew nothing must not move heat", () => {
        // The mirror. Half a fix here is free air conditioning.
        const crah = roomWith("crah", { heat: true });
        for (let k = 0; k < 20; k++) { resolvePower(DT); tickHeat(DT); }
        const demandRunning = STATE.coolingLoop.demandUnits;
        expect(demandRunning, "the loop must be carrying it first").toBeGreaterThan(0);

        crah.outForService = true;
        for (let k = 0; k < 20; k++) { resolvePower(DT); tickHeat(DT); }
        expect(STATE.coolingLoop.demandUnits).toBe(0);
    });

    it("a serviced CHILLER stops supplying the loop as well as drawing from it", () => {
        const chiller = roomWith("chiller", { heat: true });
        for (let k = 0; k < 20; k++) { resolvePower(DT); tickHeat(DT); }
        expect(STATE.coolingLoop.capacityUnits).toBeGreaterThan(0);

        chiller.outForService = true;
        for (let k = 0; k < 20; k++) { resolvePower(DT); tickHeat(DT); }
        expect(STATE.coolingLoop.capacityUnits).toBe(0);
    });

    it("the window CLOSING brings it back — this is a pause, not a demolition", () => {
        const cooler = roomWith("crac");
        cooler.outForService = true;
        for (let k = 0; k < 20; k++) resolvePower(DT);
        expect(cooler.actualKw).toBe(0);

        cooler.outForService = false;
        for (let k = 0; k < 20; k++) resolvePower(DT);
        expect(cooler.actualKw).toBeCloseTo(CONFIG.buildings.crac.drawKw, 6);
    });
});
