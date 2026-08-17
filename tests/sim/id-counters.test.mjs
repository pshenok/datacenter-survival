// The three id counters, driven through the SHIPPED game.js.
//
// resetState() cannot reach any of them — each is a module-scope `let` in the
// file that hands the ids out — so clearWorld() has to call all three by
// hand. It called two. Wire ids climbed forever while building ids restarted
// at b1, so a second run's first wire was w14 and its first building was b1.
//
// Nothing keyed off a wire id, which is exactly why it survived: the failure
// is not a wrong answer, it is a pair of counters that stopped agreeing, and
// the next thing to key off one would have inherited the disagreement.
//
// game.js drives itself with requestAnimationFrame, so the frame callback is
// captured before the module is imported — the same shape tests/sim/
// seed-wiring.test.mjs uses to step the real loop by hand.
import { describe, it, expect, beforeEach } from "vitest";

const pending = [];
globalThis.requestAnimationFrame = (cb) => pending.push(cb);
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { STATE } = await import("../../game.js");

// A run always begins through the window boundary, the way a player starts
// one — never by poking resetState directly, or the thing under test (the
// composition root's own bookkeeping) is the part being skipped.
function newRun() {
    globalThis.window.startGame();
}

beforeEach(() => {
    pending.length = 0;
});

describe("the id counters restart together", () => {
    it("a second run hands out the SAME first building id as the first", () => {
        newRun();
        const first = STATE.buildings.length;
        expect(first).toBe(0);
        newRun();
        expect(STATE.buildings.length).toBe(0);
    });

    it("THE BUG: wire ids used to climb across runs while building ids reset", async () => {
        const { placeBuilding, connect } = await import("../../src/sim/build.js");

        newRun();
        const f1 = placeBuilding("grid_feed", 2, 5, { free: true });
        const x1 = placeBuilding("transformer", 5, 5, { free: true });
        connect(f1, x1);
        const firstRun = { building: STATE.buildings[0].id, wire: STATE.wires[0].id };

        newRun();
        const f2 = placeBuilding("grid_feed", 2, 5, { free: true });
        const x2 = placeBuilding("transformer", 5, 5, { free: true });
        connect(f2, x2);
        const secondRun = { building: STATE.buildings[0].id, wire: STATE.wires[0].id };

        // Both counters are the composition root's to reset, so both must.
        expect(secondRun.building).toBe(firstRun.building);
        expect(secondRun.wire).toBe(firstRun.wire);
    });
});
