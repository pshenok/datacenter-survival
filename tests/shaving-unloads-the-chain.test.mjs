// Peak shaving says a charged UPS serves its subtree from the battery instead
// of the grid. It only ever did half of that.
//
// The delivery phase swapped which SOURCE paid for the kW — the meter was
// credited, the battery was spent — while the pull phase had already asked the
// parents for the whole subtree draw. So every link above the UPS carried kW
// that never came off a feed.
//
// Two things followed, and both are the opposite of what the mechanic is for:
//
//   - a room could brown out, or trip its own transformer, WHILE the battery
//     was carrying it;
//   - shaving could not be used for the thing an operator actually buys it
//     for, which is staying under a rating.
//
// Measured before the fix, on a room drawing 36 kW behind a 30 kW transformer
// with a full battery and the toggle on: the transformer carried 36, heated,
// and opened at second 11. The racks were served 30 of the 36 they asked for
// the whole time.
import { describe, expect, it, beforeEach } from "vitest";

import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { resolvePower, wireBuildings } from "../src/sim/power.js";

const place = (t) => { const b = new Building(t, 0, 0); STATE.buildings.push(b); return b; };
const TR = CONFIG.buildings.transformer.capacityKw;   // 30
const RACK = CONFIG.buildings.rack.capacityKw;        // 6

// 36 kW of racks behind one UPS, split across three PDUs so no PDU exceeds its
// own 16 kW rating — the constraint under test is the TRANSFORMER, six kW short
// of the room, and nothing else.
function room() {
    const feed = place("grid_feed"), tr = place("transformer"), ups = place("ups");
    wireBuildings(feed, tr); wireBuildings(tr, ups);
    const racks = [];
    for (let p = 0; p < 3; p++) {
        const pdu = place("pdu");
        wireBuildings(ups, pdu);
        for (let i = 0; i < 2; i++) {
            const r = place("rack");
            r.assignedKw = RACK;
            wireBuildings(pdu, r);
            racks.push(r);
        }
    }
    return { feed, tr, ups, racks };
}

describe("shaving takes the load off the chain, not just off the meter", () => {
    beforeEach(() => { resetState(); resetBuildingIds(); STATE.isRunning = true; });

    it("THE CHAIN ABOVE CARRIES LESS — it used to carry the same", () => {
        const { tr, ups, racks } = room();
        const served = () => +racks.reduce((s, r) => s + r.actualKw, 0).toFixed(6);
        for (let k = 0; k < 5; k++) resolvePower(1);

        expect(tr.actualKw, "clipped at its rating before shaving").toBeCloseTo(TR, 6);
        expect(served(), "and the room is short by the difference").toBeCloseTo(TR, 6);

        STATE.peakShave.on = true;
        resolvePower(1);

        expect(tr.actualKw, "the transformer still carried the battery's kW").toBeLessThan(TR);
        expect(ups.upsMode).toBe("shaving");
    });

    it("...AND THE ROOM IS NO LONGER SHORT while the battery holds", () => {
        const { racks } = room();
        const want = racks.length * RACK;
        for (let k = 0; k < 5; k++) resolvePower(1);
        const before = racks.reduce((s, r) => s + r.actualKw, 0);
        expect(before).toBeLessThan(want);

        STATE.peakShave.on = true;
        resolvePower(1);
        expect(racks.reduce((s, r) => s + r.actualKw, 0)).toBeCloseTo(want, 6);
    });

    it("the relief lasts exactly as long as the charge does, and no longer", () => {
        const { tr, ups, racks } = room();
        for (let k = 0; k < 5; k++) resolvePower(1);
        STATE.peakShave.on = true;

        let relieved = 0;
        for (let k = 0; k < 40; k++) {
            resolvePower(1);
            if (tr.actualKw < TR - 1e-9) relieved++;
        }
        expect(relieved, "the battery carried the room for a while").toBeGreaterThan(3);
        expect(ups.bufferLeft).toBeCloseTo(0, 6);
        // ...and then the overload is simply back. This room asks 36 kW of a
        // 30 kW transformer for good, so once the charge is gone the breaker
        // heats and opens exactly as it would have with no UPS at all. The
        // battery buys TIME, which is the honest thing for a battery to buy.
        expect(tr.tripped, "the overload resumed once the charge was spent").toBe(true);
        expect(racks.reduce((s, r) => s + r.actualKw, 0)).toBe(0);
    });

    it("EVERY kW SERVED CAME FROM SOMEWHERE — grid plus battery, every tick", () => {
        // The failure this guards against is the one the first cut of this fix
        // shipped: the pull phase promised relief the buffer could not back,
        // and 89 kWh over a 1200 s run were served by nobody.
        const { ups } = room();
        for (let k = 0; k < 5; k++) resolvePower(1);
        STATE.peakShave.on = true;

        let worstGap = 0;
        for (let k = 0; k < 60; k++) {
            resolvePower(1);
            const gap = STATE.totalDrawKw - STATE.gridKw - STATE.batteryKw;
            if (gap > worstGap) worstGap = gap;
        }
        expect(worstGap, "kW were drawn that neither the meter nor the battery paid for")
            .toBeLessThan(1e-9);
        expect(ups.bufferOwedKws).toBeGreaterThan(0);   // ...and the charger owes for it
    });

    it("A SLIVER OF BATTERY COVERS A SLIVER OF THE SHORTFALL, not all of it", () => {
        // The case the first cut of this fix got wrong, and the one the
        // obvious test misses: while the buffer can cover the whole shortfall,
        // "serve what the pull phase promised" and "serve what the buffer can
        // back" are the same number. They part company only when the charge
        // runs short — and that is where 89 kWh came from nowhere.
        const { tr, ups, racks } = room();
        for (let k = 0; k < 5; k++) resolvePower(1);
        STATE.peakShave.on = true;

        // Leave a tenth of a buffer-second: far less than the 6 kW shortfall
        // needs for a whole tick.
        ups.bufferLeft = 0.1;
        const cap = CONFIG.buildings.ups.capacityKw;
        resolvePower(1);

        const served = racks.reduce((s, r) => s + r.actualKw, 0);
        const fromBattery = 0.1 * cap;              // everything the sliver holds
        expect(ups.bufferLeft).toBeCloseTo(0, 9);   // spent to the last drop
        // Served is the clipped grant plus the sliver — NOT the full room.
        expect(served).toBeLessThan(racks.length * RACK);
        expect(served).toBeCloseTo(tr.actualKw + fromBattery, 6);
        // ...and the ledger closes on the tick that ran short.
        expect(STATE.totalDrawKw - STATE.gridKw - STATE.batteryKw).toBeCloseTo(0, 6);
    });

    it("the toggle OFF is byte-identical to a chain that never had a battery", () => {
        // The mechanic stays opt-in: nothing above changes until the player
        // presses the button, which is what keeps the thirteen proven levels
        // proven — none of them turns it on.
        const a = room();
        for (let k = 0; k < 5; k++) resolvePower(1);

        expect(STATE.peakShave.on, "off by default").toBe(false);
        // Clipped at the rating and short by the difference, with the battery
        // sitting there full and untouched — the behaviour every one of the
        // thirteen proven levels is balanced against.
        expect(a.tr.actualKw).toBeCloseTo(TR, 6);
        expect(a.racks.reduce((s, r) => s + r.actualKw, 0)).toBeCloseTo(TR, 6);
        expect(a.ups.bufferLeft).toBeCloseTo(CONFIG.buildings.ups.bufferSec, 6);
        expect(a.ups.shaveReliefKw).toBe(0);
    });
});
