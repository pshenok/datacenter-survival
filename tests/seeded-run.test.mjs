// Seeded runs: the PRNG, the seed token rules, and the promise the feature
// actually makes — "same seed, same run; no seed, the game you had before".
//
// The bar here is a REAL signature, not "it didn't crash": every schedule the
// two rng consumers draw at tick one, every event window that opened, every
// contract drawn and how it resolved, plus money and served kW sampled
// through the run. Two runs of a seed must agree on all of it; two seeds must
// disagree on it; an unseeded run must still be drawing from Math.random.
//
// The loop below is the game.js tick order, hand-copied like the other nine
// helpers in this suite (docs/ARCHITECTURE.md — nothing asserts the order, so
// it is copied rather than imported from a UI-bound module).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { mulberry32, normalizeSeed, randomSeedToken, seededRngs, SEED_LENGTH, SEED_MAX_LEN } from "../src/core/rng.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickContracts } from "../src/sim/contracts.js";
import { tickMaintenance } from "../src/sim/maintenance.js";
import { tickCampaign, startLevelState, levelOrder } from "../src/campaign/campaign.js";

const DT = 0.05;
const RUN_SEC = 240;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// A working hall that survives its own bill: feed -> transformer -> UPS ->
// three PDUs, three racks and two CRACs. Sized under every link's rating so
// the run is decided by the events, not by a breaker the layout was always
// going to open.
function hall() {
    const feed = place("grid_feed", 3, 5);
    const xf = place("transformer", 5, 5);
    const ups = place("ups", 7, 5);
    const pduA = place("pdu", 9, 4);
    const pduB = place("pdu", 9, 6);
    const pduC = place("pdu", 9, 8);
    wireBuildings(feed, xf);
    wireBuildings(xf, ups);
    for (const p of [pduA, pduB, pduC]) wireBuildings(ups, p);
    for (const [p, gx, gz] of [[pduA, 11, 3], [pduA, 11, 5], [pduB, 12, 4]]) {
        wireBuildings(p, place("rack", gx, gz));
    }
    for (const [gx, gz] of [[11, 7], [13, 6]]) wireBuildings(pduC, place("crac", gx, gz));
}

// game.js's tick order, exactly.
function step(rng) {
    STATE.elapsedGameTime += DT;
    tickEvents(DT, STATE.elapsedGameTime);
    tickCrisis(DT, STATE.elapsedGameTime, rng.crisis);
    tickDemand(DT, STATE.elapsedGameTime);
    resolvePower(DT);
    tickHeat(DT);
    tickContracts(DT, STATE.elapsedGameTime, rng.contracts);
    tickMaintenance(DT, STATE.elapsedGameTime);
    tickCampaign(DT, STATE.elapsedGameTime);
}

// Everything about a run that a second player could compare against.
function signature(rng, seconds = RUN_SEC) {
    hall();
    STATE.tariff.cycleOn = true;    // free play, as game.js's startGame arms it
    const sig = { schedule: null, windows: [], contracts: [], samples: [] };
    const opened = { brownout: false, gridOutage: false, tariff: false, drought: false };
    let seenId = 0;
    let seenDone = null;

    for (let i = 1; i <= Math.round(seconds / DT); i++) {
        step(rng);
        // Tick one is where every "not scheduled yet" (null) schedule is
        // drawn — six draws across the two streams, before any window has
        // had a chance to open. This is the part of the signature that a
        // seed threaded to only ONE consumer cannot reproduce.
        if (i === 1) {
            sig.schedule = {
                brownout: STATE.brownout.nextAt,
                breakdown: STATE.breakdown.nextAt,
                gridOutage: STATE.gridOutage.nextAt,
                tariff: STATE.tariff.nextAt,
                drought: STATE.drought.nextAt,
                contract: STATE.contract.nextAt,
            };
        }
        for (const kind of Object.keys(opened)) {
            const w = STATE[kind];
            if (w.active && !opened[kind]) sig.windows.push({ kind, at: round(STATE.elapsedGameTime), endsAt: round(w.endsAt) });
            opened[kind] = w.active;
        }
        const c = STATE.contract;
        if (c.id !== seenId) {
            seenId = c.id;
            seenDone = null;
            sig.contracts.push({ id: c.id, key: c.key, target: c.target, endsAt: round(c.endsAt) });
        }
        if (c.done !== seenDone) {
            seenDone = c.done;
            if (c.done !== null) sig.contracts.push({ id: c.id, done: c.done, at: round(STATE.elapsedGameTime) });
        }
        if (i % 400 === 0) {
            sig.samples.push({
                t: round(STATE.elapsedGameTime),
                money: round(STATE.money),
                served: round(STATE.servedKw),
                it: round(STATE.itDrawKw),
                rep: round(STATE.reputation),
            });
        }
    }
    return sig;
}

const round = (n) => Math.round(n * 1e6) / 1e6;

function runSeeded(seed, seconds = RUN_SEC) {
    resetState();
    resetBuildingIds();
    const rng = seededRngs(seed);
    expect(rng).not.toBeNull();
    return signature(rng, seconds);
}

// The unseeded path: no rng argument at all, so each tick falls back to the
// Math.random default it has always declared.
function runUnseeded(seconds = RUN_SEC) {
    resetState();
    resetBuildingIds();
    return signature({ crisis: undefined, contracts: undefined }, seconds);
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("mulberry32 — the generator itself", () => {
    it("is a pure function of its seed: the same seed replays the same numbers", () => {
        const a = mulberry32(12345);
        const b = mulberry32(12345);
        const first = Array.from({ length: 50 }, () => a());
        const second = Array.from({ length: 50 }, () => b());
        expect(second).toEqual(first);
    });

    it("two seeds one apart produce unrelated streams — no shared prefix", () => {
        const a = Array.from({ length: 20 }, mulberry32(999));
        const b = Array.from({ length: 20 }, mulberry32(1000));
        expect(a[0]).not.toBe(b[0]);
        expect(a.filter((v, i) => v === b[i]).length).toBe(0);
    });

    it("stays inside [0, 1) and is not degenerate — the Math.random contract", () => {
        const rng = mulberry32(7);
        const draws = Array.from({ length: 20000 }, rng);
        expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...draws)).toBeLessThan(1);
        expect(new Set(draws).size).toBeGreaterThan(19000);   // not a constant, not a short cycle
        const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
        expect(mean).toBeGreaterThan(0.48);
        expect(mean).toBeLessThan(0.52);
    });
});

describe("the seed token", () => {
    it("is idempotent — what the pill shows is exactly what re-runs", () => {
        for (const raw of ["kyiv", "  pue 1.19 ", "A-B-C", "KYIV", "verylongseedvalue"]) {
            const once = normalizeSeed(raw);
            expect(normalizeSeed(once)).toBe(once);
        }
    });

    it("folds case and strips what a URL or a chat client would mangle", () => {
        expect(normalizeSeed("kyiv")).toBe("KYIV");
        expect(normalizeSeed(" pue-1.19 ")).toBe("PUE119");
    });

    it("caps at SEED_MAX_LEN, so a pasted essay is still a pill", () => {
        expect(normalizeSeed("ABCDEFGHIJKLMNOPQRSTU")).toBe("ABCDEFGHIJKL");
        expect(normalizeSeed("ABCDEFGHIJKLMNOPQRSTU").length).toBe(SEED_MAX_LEN);
    });

    it("is NULL for everything that is not a seed — that is what an unseeded run is", () => {
        for (const raw of [null, undefined, "", "   ", "!!!", "—", 42, {}]) {
            expect(normalizeSeed(raw)).toBeNull();
        }
    });

    it("generates short tokens with no character you could misread aloud", () => {
        const pick = mulberry32(2026);
        for (let i = 0; i < 500; i++) {
            const token = randomSeedToken(pick);
            expect(token).toHaveLength(SEED_LENGTH);
            expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);   // no I, L, O, U
            expect(normalizeSeed(token)).toBe(token);          // already canonical
        }
    });

    it("survives a hostile entropy source rather than emitting undefined", () => {
        expect(randomSeedToken(() => 1)).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
        expect(randomSeedToken(() => NaN)).toBe("00000");
        expect(randomSeedToken(() => 0.999999999)).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}$/);
    });
});

describe("the two streams", () => {
    it("a seed makes crisis and contracts INDEPENDENT: one drawing more never moves the other", () => {
        const plain = seededRngs("KYIV");
        const expected = Array.from({ length: 20 }, plain.contracts);

        const busy = seededRngs("KYIV");
        for (let i = 0; i < 37; i++) busy.crisis();      // a run with more crises in it
        expect(Array.from({ length: 20 }, busy.contracts)).toEqual(expected);
    });

    it("and they are genuinely two — the same seed does not hand both the same numbers", () => {
        const r = seededRngs("KYIV");
        const crisis = Array.from({ length: 12 }, r.crisis);
        const contracts = Array.from({ length: 12 }, r.contracts);
        expect(contracts).not.toEqual(crisis);
        expect(crisis.filter((v, i) => v === contracts[i]).length).toBe(0);
    });

    it("no seed means NO streams — the caller is left on each tick's own default", () => {
        for (const raw of [null, undefined, "", "  ", "!!!"]) {
            expect(seededRngs(raw)).toBeNull();
        }
    });
});

describe("THE PROMISE: same seed, same run", () => {
    it("replays a 240 s run tick for tick — schedules, windows, contracts, money", () => {
        const first = runSeeded("KYIV");
        const second = runSeeded("KYIV");
        expect(second).toEqual(first);
        // …and the run it replayed was a real one, not an empty room: the
        // identity would hold vacuously if nothing had ever happened.
        expect(first.windows.length).toBeGreaterThan(0);
        expect(first.contracts.length).toBeGreaterThan(1);
        expect(first.samples.some((s) => s.served > 0)).toBe(true);
    });

    it("reaches the same room from the URL a player would paste, however they typed it", () => {
        expect(runSeeded("kyiv")).toEqual(runSeeded("KYIV"));
        expect(runSeeded("k-y-i-v")).toEqual(runSeeded("KYIV"));
    });
});

describe("THE OTHER HALF: different seeds are different rooms", () => {
    const SEEDS = ["KYIV", "A1B2C", "ZZZZZ", "PUE119", "7GQTM"];

    it("five seeds produce five distinct runs, not five money totals of one run", () => {
        const sigs = SEEDS.map((s) => runSeeded(s, 120));
        expect(new Set(sigs.map((s) => JSON.stringify(s))).size).toBe(SEEDS.length);
        // The strong form: the CRISIS SCHEDULE itself differs, so the runs
        // diverge in what happens and when — not merely in how it went.
        const firstBrownout = sigs.map((s) => s.schedule.brownout);
        expect(new Set(firstBrownout).size).toBe(SEEDS.length);
        const firstContract = sigs.map((s) => s.schedule.contract);
        expect(new Set(firstContract).size).toBe(SEEDS.length);
    });

    it("one character of difference is a different room", () => {
        expect(runSeeded("KYIV1", 120)).not.toEqual(runSeeded("KYIV2", 120));
    });
});

describe("INERTNESS: with no seed, this is the game that shipped before seeds", () => {
    const realRandom = Math.random;
    afterEach(() => {
        Math.random = realRandom;
    });

    it("still draws from Math.random — the test that catches a leaked module-scope generator", () => {
        let calls = 0;
        Math.random = () => {
            calls++;
            return realRandom();
        };
        runUnseeded(60);
        // Six schedules are drawn on tick one alone; a sim module that had
        // quietly kept a seeded stream would consume none of them.
        expect(calls).toBeGreaterThanOrEqual(6);
    });

    it("two unseeded runs DIVERGE — a seed must never become sticky", () => {
        const a = runUnseeded(120);
        const b = runUnseeded(120);
        expect(b).not.toEqual(a);
        expect(b.schedule.brownout).not.toBe(a.schedule.brownout);
        expect(b.schedule.contract).not.toBe(a.schedule.contract);
    });

    it("a seeded run does not follow the player into the next unseeded one", () => {
        runSeeded("KYIV", 30);
        const a = runUnseeded(60);
        const b = runUnseeded(60);
        expect(a.schedule).not.toEqual(b.schedule);
    });
});

describe("PURITY: no sim module reaches for Math.random", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const PURE_DIRS = ["src/sim", "src/core", "src/campaign", "src/entities"];

    it("the only Math.random in the pure layer is the injected default in a signature", () => {
        const offenders = [];
        let defaults = 0;
        let scanned = 0;
        for (const dir of PURE_DIRS) {
            for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".js"))) {
                scanned++;
                const path = join(dir, file);
                readFileSync(join(root, path), "utf8").split("\n").forEach((line, i) => {
                    if (!line.includes("Math.random")) return;
                    const code = line.trim();
                    if (code.startsWith("//") || code.startsWith("*")) return;  // prose about the rule
                    if (/rng = Math\.random/.test(code)) {
                        defaults++;
                        return;
                    }
                    offenders.push(`${path}:${i + 1}: ${code}`);
                });
            }
        }
        expect(offenders).toEqual([]);
        expect(scanned).toBeGreaterThan(8);       // the scan actually read the layer
        expect(defaults).toBe(2);                 // tickCrisis and tickContracts, and nothing else
    });
});

describe("THE CAMPAIGN takes no seed, because it takes no draws", () => {
    function countingRng() {
        const n = { crisis: 0, contracts: 0 };
        return {
            n,
            crisis: () => { n.crisis++; return 0.5; },
            contracts: () => { n.contracts++; return 0.5; },
        };
    }

    it("CONTROL: a survival run consumes both streams within one tick", () => {
        const rng = countingRng();
        hall();
        step(rng);
        expect(rng.n.crisis).toBeGreaterThan(0);
        expect(rng.n.contracts).toBeGreaterThan(0);
    });

    it("every campaign level draws ZERO random numbers over 30 s — a seed there would be decoration", () => {
        for (const id of levelOrder()) {
            resetState();
            resetBuildingIds();
            const rng = countingRng();
            expect(startLevelState(id)).toBe(true);
            for (let i = 0; i < 30 / DT; i++) step(rng);
            expect({ id, ...rng.n }).toEqual({ id, crisis: 0, contracts: 0 });
            // …because startLevelState pins every schedule out of reach, which
            // is the mechanism the claim rests on.
            expect(STATE.contract.nextAt).toBe(Infinity);
            expect(STATE.brownout.nextAt).toBe(Infinity);
            expect(STATE.gridOutage.nextAt).toBe(Infinity);
            expect(STATE.drought.nextAt).toBe(Infinity);
        }
    });
});

describe("STATE hygiene", () => {
    it("resetState severs the seed — the next run cannot inherit this one's room", () => {
        STATE.seed = "KYIV";
        resetState();
        expect(STATE.seed).toBeNull();
    });

    it("the seed is a token, never a generator: STATE holds nothing callable", () => {
        STATE.seed = seededRngs("KYIV").seed;
        expect(typeof STATE.seed).toBe("string");
        expect(STATE.seed).toBe("KYIV");
    });

    it("CONFIG is untouched by a seeded run", () => {
        const before = JSON.stringify(CONFIG.events);
        runSeeded("KYIV", 120);
        expect(JSON.stringify(CONFIG.events)).toBe(before);
    });
});
