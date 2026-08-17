// The game clock is gated on a module-scope flag nobody was clearing.
//
// game.js: `if (!tutorial.active) STATE.elapsedGameTime += dt;` — the
// tutorial freezes time on purpose, so a first-timer can wire a chain without
// a heatwave landing on them. The flag was cleared only by finish(): all
// seven steps done, or the Skip button.
//
// Esc opens the pause menu mid-lesson, and the pause menu goes back to the
// main menu. That path never reached finish(), so `active` stayed true for
// the life of the page — and EVERY run started afterwards had a frozen clock.
// Nothing crashes; the game simply stops having weather, crises, contracts,
// level timers or maintenance deadlines, silently, until a reload.
//
// Driven through the SHIPPED game.js, because the defect lives in the
// composition root's bookkeeping and reaching past it would skip the bug.
import { describe, it, expect, beforeEach } from "vitest";

const pending = [];
globalThis.requestAnimationFrame = (cb) => pending.push(cb);
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { STATE } = await import("../../game.js");
const { tutorial } = await import("../../src/ui/tutorial.js");

let clock = 0;
// One frame of the real animate(): 50 ms, under game.js's 0.1 s clamp.
function frames(n) {
    for (let i = 0; i < n; i++) {
        const cb = pending.pop();
        pending.length = 0;
        clock += 50;
        cb(clock);
    }
}

// What the ceremony's "teach me" button does: the lesson starts and the
// clock is deliberately held.
function enterTutorial() {
    tutorial.active = true;
    tutorial.step = 0;
}

beforeEach(() => {
    try {
        localStorage.clear();
        localStorage.setItem("dc_tutorial_done", "1");   // no ceremony unless a test wants one
    } catch { /* storage unavailable */ }
    document.getElementById("ceremony-modal")?.classList.add("hidden");
    tutorial.active = false;
});

describe("the tutorial holds the clock, and gives it back", () => {
    it("freezes game time while the lesson is running — the point of the flag", () => {
        globalThis.window.startGame();
        enterTutorial();
        globalThis.window.togglePause();
        const before = STATE.elapsedGameTime;
        frames(20);
        expect(STATE.elapsedGameTime).toBe(before);
    });

    it("THE BUG: walking out to the menu mid-lesson used to freeze every later run", () => {
        globalThis.window.startGame();
        enterTutorial();
        expect(tutorial.active).toBe(true);

        // Esc, then the pause menu's way out. Neither is the Skip button.
        globalThis.window.backToMenu();
        expect(tutorial.active).toBe(false);

        // A completely new run must have a clock again.
        globalThis.window.startGame();
        globalThis.window.togglePause();
        const before = STATE.elapsedGameTime;
        frames(20);
        expect(STATE.elapsedGameTime).toBeGreaterThan(before);
    });

    it("starting another run also releases it, whichever way the player left", () => {
        globalThis.window.startGame();
        enterTutorial();
        globalThis.window.startGame();          // clearWorld() runs on the way in
        expect(tutorial.active).toBe(false);
        globalThis.window.togglePause();
        const before = STATE.elapsedGameTime;
        frames(20);
        expect(STATE.elapsedGameTime).toBeGreaterThan(before);
    });

    it("abandoning does NOT count as done — the offer survives, unlike Skip", async () => {
        const { abandonTutorial } = await import("../../src/ui/tutorial.js");
        try {
            localStorage.removeItem("dc_tutorial_done");
        } catch { /* storage unavailable — the assertion below still holds */ }
        enterTutorial();
        expect(abandonTutorial()).toBe(true);
        let done = null;
        try {
            done = localStorage.getItem("dc_tutorial_done");
        } catch { /* ignore */ }
        expect(done).toBeNull();
        // Idempotent: leaving twice is not an error.
        expect(abandonTutorial()).toBe(false);
    });
});
