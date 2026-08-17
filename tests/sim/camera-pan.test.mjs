// Keyboard camera panning (#13). src/input/handlers.js kept a `keys` map
// written on keydown/keyup/blur and read nowhere — the blur handler was a
// real fix for a feature that was never wired up. This drives the SHIPPED
// game.js frame loop (the seed-wiring.test.mjs pattern) so the real
// per-frame wiring in animate() is under test, not a hand-copied stand-in —
// and this mechanic never touches resolvePower, so it stays out of the
// tick-loop-copy count CONTRIBUTING/ARCHITECTURE pin.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";

const pending = [];
globalThis.requestAnimationFrame = (cb) => pending.push(cb);
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

// Imported for its side effects: this is what installs window.startGame and
// the rest of the window boundary the tests below drive.
await import("../../game.js");
const { camera, cameraTarget } = await import("../../src/ui/scene.js");

let clock = 0;
// One frame at 50 ms — well under game.js's 0.1 s clamp, same as
// seed-wiring.test.mjs.
function frames(n) {
    for (let i = 0; i < n; i++) {
        const cb = pending.pop();
        pending.length = 0;
        clock += 50;
        cb(clock);
    }
}

function keydown(key) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}
function keyup(key) {
    window.dispatchEvent(new KeyboardEvent("keyup", { key }));
}

const boardHalf = (CONFIG.gridSize * CONFIG.tileSize) / 2;
const ceremony = () => document.getElementById("ceremony-modal");
const seedInput = () => document.getElementById("seed-input");
const target = () => ({ x: cameraTarget.x, z: cameraTarget.z });

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("dc_tutorial_done", "1");   // not a first run
    ceremony().classList.add("hidden");
    window.startGame(null);   // isRunning = true; deliberately left PAUSED —
    // panning must not need Play pressed, so no togglePause() here.
    camera.zoom = 1;
});

describe("a key pans", () => {
    it("D moves the camera target", () => {
        const before = target();
        keydown("d");
        frames(5);
        keyup("d");
        expect(target()).not.toEqual(before);
    });

    it("every WASD / arrow key moves it, and each pair moves on both world axes", () => {
        for (const key of ["w", "a", "s", "d", "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"]) {
            window.startGame(null);
            const before = target();
            keydown(key);
            frames(5);
            keyup(key);
            const after = target();
            expect(after.x, `key ${key} did not move x`).not.toBe(before.x);
            expect(after.z, `key ${key} did not move z`).not.toBe(before.z);
        }
    });
});

describe("the opposite key pans back", () => {
    it("D then A returns to the start, exactly", () => {
        const before = target();
        keydown("d");
        frames(6);
        keyup("d");
        keydown("a");
        frames(6);
        keyup("a");
        expect(cameraTarget.x).toBeCloseTo(before.x, 9);
        expect(cameraTarget.z).toBeCloseTo(before.z, 9);
    });

    it("ArrowUp then ArrowDown returns to the start, exactly", () => {
        const before = target();
        keydown("ArrowUp");
        frames(6);
        keyup("ArrowUp");
        keydown("ArrowDown");
        frames(6);
        keyup("ArrowDown");
        expect(cameraTarget.x).toBeCloseTo(before.x, 9);
        expect(cameraTarget.z).toBeCloseTo(before.z, 9);
    });
});

describe("the clamp holds at the board edge", () => {
    it.each(["w", "a", "s", "d"])("key %s: a long hold stops exactly at the board, and does not creep further", (key) => {
        keydown(key);
        frames(400);   // far more than enough to cross the 120-unit board
        const stuck = target();
        keyup(key);
        expect(Math.abs(stuck.x)).toBeLessThanOrEqual(boardHalf + 1e-9);
        expect(Math.abs(stuck.z)).toBeLessThanOrEqual(boardHalf + 1e-9);
        // At least one axis is pinned exactly to the board's edge — this is
        // what tells a clamped run apart from one that merely stopped short.
        expect(
            Math.abs(stuck.x) === boardHalf || Math.abs(stuck.z) === boardHalf,
            `key ${key} stopped at (${stuck.x}, ${stuck.z}) — not on the board edge`
        ).toBe(true);
        keydown(key);
        frames(60);
        keyup(key);
        expect(cameraTarget.x).toBeCloseTo(stuck.x, 9);
        expect(cameraTarget.z).toBeCloseTo(stuck.z, 9);
    });
});

describe("a key held while focus is lost does not keep panning", () => {
    it("window blur clears the held key, so panning stops without a keyup", () => {
        keydown("d");
        frames(3);
        const beforeBlur = target();
        window.dispatchEvent(new Event("blur"));
        frames(20);   // "d" was never released
        expect(cameraTarget.x).toBeCloseTo(beforeBlur.x, 9);
        expect(cameraTarget.z).toBeCloseTo(beforeBlur.z, 9);
    });
});

describe("typing in the seed box does not pan", () => {
    it("a literal 'w' typed into the seed box does not slide the camera", () => {
        const input = seedInput();
        input.focus();
        const before = target();
        keydown("w");
        frames(10);
        keyup("w");
        expect(cameraTarget.x).toBe(before.x);
        expect(cameraTarget.z).toBe(before.z);
        input.blur();
    });

    it("panning resumes once the box loses focus", () => {
        const input = seedInput();
        input.focus();
        keydown("d");
        frames(5);
        const whileTyping = target();
        expect(whileTyping).toEqual({ x: 0, z: 0 });
        input.blur();
        frames(5);
        keyup("d");
        expect(target()).not.toEqual(whileTyping);
    });
});

describe("panning distance per frame is zoom-invariant", () => {
    it("halves the world-space step when zoom doubles, so the on-screen speed holds", () => {
        keydown("d");
        frames(4);
        keyup("d");
        const distAtZoom1 = Math.hypot(cameraTarget.x, cameraTarget.z);
        expect(distAtZoom1).toBeGreaterThan(0);

        window.startGame(null);
        camera.zoom = 2;
        keydown("d");
        frames(4);
        keyup("d");
        const distAtZoom2 = Math.hypot(cameraTarget.x, cameraTarget.z);

        expect(distAtZoom2).toBeCloseTo(distAtZoom1 / 2, 9);
    });
});
