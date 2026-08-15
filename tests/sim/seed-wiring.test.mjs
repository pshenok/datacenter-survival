// The composition root's half of seeded runs, driven through the SHIPPED
// game.js — the one place the seed is read off the URL, turned into streams
// and threaded into the two ticks that consume them. tests/seeded-run.test.mjs
// proves the streams; this file proves the game is actually holding them.
//
// game.js drives itself with requestAnimationFrame, so the frame callback is
// captured here BEFORE the module is imported and stepped by hand. That makes
// the real loop — real tick order, real rng wiring — replayable at a fixed dt
// instead of at the mercy of a timer.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { seededRngs } from "../../src/core/rng.js";
import { shareUrl } from "../../src/ui/hud.js";

const pending = [];
globalThis.requestAnimationFrame = (cb) => pending.push(cb);
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;

const { STATE } = await import("../../game.js");

let clock = 0;
// One frame of the real animate(): 50 ms, well under game.js's 0.1 s clamp.
function frames(n) {
    for (let i = 0; i < n; i++) {
        const cb = pending.pop();
        pending.length = 0;
        clock += 50;
        cb(clock);
    }
}

// Start a run and let time flow, the way a player does.
function play(seed, n = 40) {
    window.startGame(seed);
    window.togglePause();       // runs start paused; this is the Play button
    frames(n);
}

// What the two rng consumers drew, straight out of STATE.
function schedules() {
    return {
        brownout: STATE.brownout.nextAt,
        breakdown: STATE.breakdown.nextAt,
        gridOutage: STATE.gridOutage.nextAt,
        tariff: STATE.tariff.nextAt,
        drought: STATE.drought.nextAt,
        contract: STATE.contract.nextAt,
    };
}

const ceremony = () => document.getElementById("ceremony-modal");
const seedInput = () => document.getElementById("seed-input");

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("dc_tutorial_done", "1");   // not a first run, unless a test says so
    ceremony().classList.add("hidden");
});

describe("the seed reaches the game", () => {
    it("starts a run on the token the player typed, normalized", () => {
        play("kyiv", 2);
        expect(STATE.seed).toBe("KYIV");
    });

    it("takes it from the menu box when Power On is pressed with nothing else to go on", () => {
        seedInput().value = "a1b2c";
        window.startGame();
        expect(STATE.seed).toBe("A1B2C");
        seedInput().value = "";
        window.startGame();
        expect(STATE.seed).toBeNull();
    });

    // A Cyrillic word is the single most natural thing to type here — this
    // game ships Ukrainian as a first-class locale, and the seed box is
    // labelled СІД (ЗА БАЖАННЯМ). normalizeSeed strips anything outside
    // [0-9A-Z], so "КИЇВ" collapses to nothing and the run starts UNSEEDED:
    // no ?seed=, no pill — indistinguishable from having left the box blank,
    // UNLESS the box itself shows what happened. Without the echo the input
    // still reads "КИЇВ" after Power On, next to a run that quietly is not
    // the one it names.
    it("echoes the box empty when a seed normalizes to NOTHING — a Cyrillic word, e.g.", () => {
        seedInput().value = "КИЇВ";
        window.startGame();
        expect(STATE.seed).toBeNull();
        expect(seedInput().value).toBe("");
    });

    // The other half of the same bug: a token that survives normalization
    // but not AS what was typed. "КИЇВ-42" is a real, seeded room — just not
    // the one the player named — and the box has to say so before Power On,
    // not leave the player to notice from the pill afterwards.
    it("echoes a token that normalized to something OTHER than what was typed", () => {
        seedInput().value = "КИЇВ-42";
        window.startGame();
        expect(STATE.seed).toBe("42");
        expect(seedInput().value).toBe("42");
    });

    it("the box's blur is wired to the same echo, so leaving the field shows the correction before Power On is even pressed", () => {
        expect(seedInput().getAttribute("onblur")).toBe("echoSeedInput()");
    });

    it("puts the run on the address bar, so the address bar IS the share link", () => {
        play("kyiv", 1);
        expect(window.location.search).toBe("?seed=KYIV");
    });

    it("takes the seed OFF the address bar when the next run is unseeded", () => {
        play("kyiv", 1);
        window.startGame(null);
        expect(window.location.search).toBe("");
    });

    it("hands out fresh seeds without anybody editing a URL", () => {
        window.rollSeed();
        expect(seedInput().value).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
        const first = seedInput().value;
        window.rollSeed();
        expect(seedInput().value).not.toBe(first);   // a NEW one, not the same room again
    });
});

describe("THREADED TO BOTH: a seeded run touches Math.random nowhere", () => {
    const real = Math.random;
    afterEach(() => {
        Math.random = real;
    });

    it("draws every schedule from the seed — the test that catches one unthreaded tick", () => {
        window.startGame("KYIV");
        window.togglePause();
        let calls = 0;
        Math.random = () => {
            calls++;
            return real();
        };
        frames(40);
        expect(STATE.elapsedGameTime).toBeGreaterThan(0);
        expect(STATE.wires.length).toBe(0);          // no wire pulses to draw, so this is the sim's count
        // Six schedules are drawn on tick one across the two streams. If
        // either tickCrisis or tickContracts lost its rng argument, that
        // consumer would fall back to the default and this would be > 0.
        expect(calls).toBe(0);
        expect(STATE.contract.nextAt).toBeGreaterThan(0);     // contracts really did draw
        expect(STATE.brownout.nextAt).toBeGreaterThan(0);     // and so did crisis
    });

    it("an UNSEEDED run does use Math.random — the default was never taken away", () => {
        window.startGame(null);
        window.togglePause();
        let calls = 0;
        Math.random = () => {
            calls++;
            return real();
        };
        frames(4);
        expect(calls).toBeGreaterThanOrEqual(6);
    });
});

describe("THE PROMISE, through the shipped loop", () => {
    it("the same seed schedules the same run", () => {
        play("KYIV");
        const first = schedules();
        play("KYIV");
        expect(schedules()).toEqual(first);
    });

    it("a different seed schedules a different one", () => {
        play("KYIV");
        const first = schedules();
        play("A1B2C");
        expect(schedules()).not.toEqual(first);
    });

    it("two unseeded runs differ, exactly as they always did", () => {
        play(null);
        const first = schedules();
        play(null);
        expect(schedules()).not.toEqual(first);
    });

    // The sharpest assertion in the suite: not "the run repeats" but "the run
    // is THIS stream, consumed from the start, in order". A generator rebuilt
    // per tick still repeats — it just repeats the wrong run — and only
    // checking the third draw against an independently advanced stream can
    // tell the two apart.
    it("consumes ONE continuous stream: the exact numbers the seed promises, in the order it promises them", () => {
        const ref = seededRngs("KYIV").contracts;
        const cfg = CONFIG.contracts;
        const span = (v) => cfg.minIntervalSec + (cfg.maxIntervalSec - cfg.minIntervalSec) * v;

        window.startGame("KYIV");
        window.togglePause();
        frames(1);
        expect(STATE.contract.nextAt).toBeCloseTo(STATE.elapsedGameTime + span(ref()), 9);   // draw 1

        // Bring the next draw forward rather than waiting 45 game-seconds.
        STATE.contract.nextAt = STATE.elapsedGameTime + 0.01;
        frames(1);
        const pool = cfg.pool;
        const pick = pool[Math.min(pool.length - 1, Math.floor(ref() * pool.length))];         // draw 2
        expect(STATE.contract.key).toBe(pick.key);
        expect(STATE.contract.nextAt).toBeCloseTo(STATE.elapsedGameTime + span(ref()), 9);   // draw 3
    });

    it("Restart replays the SAME room — not a fresh roll of the dice", () => {
        play("KYIV");
        const first = schedules();
        window.restartGame();
        expect(STATE.seed).toBe("KYIV");
        window.togglePause();
        frames(40);
        expect(schedules()).toEqual(first);
    });

    it("Retry from the pause menu replays it too", () => {
        play("KYIV");
        const first = schedules();
        window.retryFromPause();
        expect(STATE.seed).toBe("KYIV");
        window.togglePause();
        frames(40);
        expect(schedules()).toEqual(first);
    });
});

describe("the campaign is never seeded", () => {
    it("launching a level clears the seed a survival run left behind", () => {
        play("KYIV", 2);
        expect(STATE.seed).toBe("KYIV");
        window.launchCampaignLevel("first_watt");
        expect(STATE.seed).toBeNull();
    });

    it("and the level's schedules stay pinned out of reach, seed or no seed", () => {
        play("KYIV", 2);
        window.launchCampaignLevel("first_watt");
        window.togglePause();
        frames(40);
        expect(STATE.contract.nextAt).toBe(Infinity);
        expect(STATE.brownout.nextAt).toBe(Infinity);
    });
});

describe("a seeded run starts the same room for everyone", () => {
    it("does NOT open the tutorial, even on a profile that has never played", () => {
        localStorage.clear();
        window.startGame("KYIV");
        expect(ceremony().classList.contains("hidden")).toBe(true);
    });

    it("but an unseeded first run still gets it — the seed did not steal the tutorial", () => {
        localStorage.clear();
        window.startGame(null);
        expect(ceremony().classList.contains("hidden")).toBe(false);
    });

    it("and it leaves the saved profile alone: a shared link rewrites nobody's progress", () => {
        localStorage.clear();
        window.startGame("KYIV");
        expect(localStorage.getItem("dc_tutorial_done")).toBeNull();
    });
});

// copySeedLink must not CLAIM a copy that did not happen. navigator.clipboard
// is undefined on a non-secure origin (a LAN IP — exactly how you test on a
// phone), and a denied permission rejects the promise; both used to be
// swallowed while the "Link copied" banner fired unconditionally anyway.
describe("copying the seed link tells the truth", () => {
    const banner = () => document.getElementById("event-banner");
    // happy-dom's navigator.clipboard is a getter on the prototype; defining
    // an own property shadows it for one test, and `delete` uncovers the
    // prototype's getter again for the next.
    afterEach(() => {
        delete navigator.clipboard;
    });

    it("claims success only once the clipboard write actually resolves", async () => {
        play("KYIV", 2);
        await window.copySeedLink();
        expect(banner().textContent).toBe("Link copied — seed KYIV");
    });

    it("does NOT claim a copy that did not happen — clipboard absent, e.g. a non-secure origin", async () => {
        play("KYIV", 2);
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
        await window.copySeedLink();
        expect(banner().textContent).not.toMatch(/Link copied/);
        expect(banner().textContent).toContain(shareUrl("KYIV"));
    });

    it("does NOT claim a copy that did not happen — permission denied", async () => {
        play("KYIV", 2);
        Object.defineProperty(navigator, "clipboard", {
            value: { writeText: () => Promise.reject(new Error("denied")) },
            configurable: true,
        });
        await window.copySeedLink();
        expect(banner().textContent).not.toMatch(/Link copied/);
        expect(banner().textContent).toContain(shareUrl("KYIV"));
    });
});
