// Unit tests for src/sim/contracts.js — node env, real modules. Sim facts
// (servedKw, itDrawKw, totalDrawKw, rack flags) are set directly on STATE,
// the demand.test.mjs pattern: contracts are judged on facts, not on how the
// facts were produced. Constant rng stubs steer the pool pick (index =
// floor(rng * poolLength)); a seeded LCG covers the schedule bounds.
// Locale parity for every new string lives here too.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { tickContracts } from "../src/sim/contracts.js";
import { EN_TRANSLATIONS } from "../src/locales/en.js";
import { UK_TRANSLATIONS } from "../src/locales/uk.js";

const rngZero = () => 0;            // pool[0] = serve_kwh, minimum intervals

function lcg(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// Draw a contract deterministically: schedule on a first tick at elapsed 0,
// then jump to the scheduled draw time. Returns the draw elapsed.
function drawContract(rng, demandKw = 20) {
    tickContracts(1, 0, rng);
    STATE.demandKw = demandKw;
    const at = STATE.contract.nextAt;
    tickContracts(1, at, rng);
    expect(STATE.contract.key).not.toBeNull();
    return at;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("scheduling", () => {
    it("first valid tick schedules the draw within interval bounds (seeded rng)", () => {
        const cfg = CONFIG.contracts;
        tickContracts(1, 10, lcg(5));
        expect(STATE.contract.nextAt).toBeGreaterThanOrEqual(10 + cfg.minIntervalSec);
        expect(STATE.contract.nextAt).toBeLessThanOrEqual(10 + cfg.maxIntervalSec);
        expect(STATE.contract.key).toBeNull();
    });

    it("does not draw before nextAt, draws exactly at it, and reschedules within bounds", () => {
        const cfg = CONFIG.contracts;
        tickContracts(1, 0, rngZero);
        const at = STATE.contract.nextAt;
        expect(at).toBe(cfg.minIntervalSec);
        tickContracts(1, at - 0.01, rngZero);
        expect(STATE.contract.key).toBeNull();
        STATE.demandKw = 20;
        tickContracts(1, at, rngZero);
        const c = STATE.contract;
        expect(c.id).toBe(1);
        expect(c.key).toBe("serve_kwh");
        expect(c.done).toBeNull();
        expect(c.progress).toBe(0);
        expect(c.reward).toBe(120);
        expect(c.endsAt).toBe(at + 60);
        expect(c.nextAt).toBe(at + cfg.minIntervalSec);
    });

    it("keeps ONE contract at a time: a due nextAt does not redraw over a running contract", () => {
        const at = drawContract(rngZero);
        STATE.servedKw = 1;
        tickContracts(1, STATE.contract.nextAt + 10, rngZero); // schedule long due
        expect(STATE.contract.id).toBe(1);
        expect(STATE.contract.endsAt).toBe(at + 60);
    });

    it("frozen elapsed (the tutorial) schedules once and never draws", () => {
        for (let i = 0; i < 60; i++) tickContracts(1, 5, rngZero);
        expect(STATE.contract.nextAt).toBe(5 + CONFIG.contracts.minIntervalSec);
        expect(STATE.contract.key).toBeNull();
    });
});

describe("serve_kwh", () => {
    it("targets a demand share at draw time and accrues billing-scale kWh from servedKw", () => {
        drawContract(rngZero, 20);                        // target 0.75 * 20 = 15
        expect(STATE.contract.target).toBe(15);
        STATE.servedKw = 12;
        tickContracts(5, 50, rngZero);
        expect(STATE.contract.progress).toBeCloseTo(12 * 5 / 60, 10);
    });

    it("falls back to minTarget when demand is tiny", () => {
        drawContract(rngZero, 0.5);
        expect(STATE.contract.target).toBe(CONFIG.contracts.pool[0].minTarget);
    });

    it("pays the reward exactly once on completion", () => {
        const at = drawContract(rngZero, 20);
        const before = STATE.money;
        STATE.servedKw = 15;
        tickContracts(60, at + 55, rngZero);              // +15 kWh: done
        expect(STATE.contract.done).toBe("paid");
        expect(STATE.money).toBe(before + 120);
        STATE.servedKw = 999;
        tickContracts(60, at + 56, rngZero);              // resolved: no re-pay
        expect(STATE.money).toBe(before + 120);
    });

    it("expires unmet at endsAt as failed, without pay", () => {
        const at = drawContract(rngZero, 20);
        const before = STATE.money;
        STATE.servedKw = 0;
        tickContracts(1, at + 59, rngZero);
        expect(STATE.contract.done).toBeNull();
        tickContracts(1, at + 60, rngZero);
        expect(STATE.contract.done).toBe("failed");
        expect(STATE.money).toBe(before);
    });
});

describe("pue_hold", () => {
    const rngPue = () => 0.3;                             // pool[1]

    it("counts a continuous streak and resets it the moment PUE crosses the bar", () => {
        drawContract(rngPue);
        expect(STATE.contract.key).toBe("pue_hold");
        expect(STATE.contract.target).toBe(45);
        STATE.itDrawKw = 10;
        STATE.totalDrawKw = 13;                           // PUE 1.30 < 1.35
        tickContracts(10, 60, rngPue);
        expect(STATE.contract.progress).toBeCloseTo(10, 10);
        STATE.totalDrawKw = 20;                           // PUE 2.0
        tickContracts(1, 61, rngPue);
        expect(STATE.contract.progress).toBe(0);
    });

    it("treats an idle room (PUE undefined) as not holding", () => {
        drawContract(rngPue);
        STATE.itDrawKw = 0.01;                            // below the HUD PUE floor
        STATE.totalDrawKw = 0.01;
        tickContracts(10, 60, rngPue);
        expect(STATE.contract.progress).toBe(0);
    });

    it("pays when the streak reaches holdSec inside the window", () => {
        const at = drawContract(rngPue);
        const before = STATE.money;
        STATE.itDrawKw = 10;
        STATE.totalDrawKw = 13;
        tickContracts(45, at + 46, rngPue);               // streak 45 in one tick
        expect(STATE.contract.done).toBe("paid");
        expect(STATE.money).toBe(before + 150);
    });
});

describe("no_throttle", () => {
    const rngNt = () => 0.5;                              // pool[2]

    it("needs at least one POWERED rack for the streak to count", () => {
        drawContract(rngNt);
        expect(STATE.contract.key).toBe("no_throttle");
        tickContracts(10, 60, rngNt);                     // empty room
        expect(STATE.contract.progress).toBe(0);
        const rack = new Building("rack", 0, 0);
        rack.powered = true;
        STATE.buildings.push(rack);
        tickContracts(10, 61, rngNt);
        expect(STATE.contract.progress).toBeCloseTo(10, 10);
    });

    it("resets on ANY throttled rack and pays after a clean holdSec", () => {
        const at = drawContract(rngNt);
        const a = new Building("rack", 0, 0);
        a.powered = true;
        const b = new Building("rack", 1, 0);
        STATE.buildings.push(a, b);
        tickContracts(10, at + 1, rngNt);
        expect(STATE.contract.progress).toBeCloseTo(10, 10);
        b.throttleFactor = 0.8;                           // even an unpowered hot rack counts
        tickContracts(1, at + 2, rngNt);
        expect(STATE.contract.progress).toBe(0);
        b.throttleFactor = 1;
        const before = STATE.money;
        tickContracts(60, at + 62, rngNt);                // clean 60s inside the 90s window
        expect(STATE.contract.done).toBe("paid");
        expect(STATE.money).toBe(before + 100);
    });
});

describe("peak_kw", () => {
    const rngPk = () => 0.9;                              // pool[3]

    it("tracks the instantaneous served peak against a demand-scaled target and pays on touch", () => {
        drawContract(rngPk, 10);                          // target round(9.5) = 10
        expect(STATE.contract.key).toBe("peak_kw");
        expect(STATE.contract.target).toBe(10);
        STATE.servedKw = 9.4;
        tickContracts(1, 70, rngPk);
        expect(STATE.contract.progress).toBeCloseTo(9.4, 10);
        expect(STATE.contract.done).toBeNull();
        const before = STATE.money;
        STATE.servedKw = 10.2;
        tickContracts(1, 71, rngPk);
        expect(STATE.contract.done).toBe("paid");
        expect(STATE.money).toBe(before + 80);
    });
});

describe("redraw pacing", () => {
    it("after a resolution the next draw waits out redrawGraceSec, then a new id rolls", () => {
        const cfg = CONFIG.contracts;
        const at = drawContract(rngZero, 20);
        STATE.servedKw = 20;
        const doneAt = at + 50;
        tickContracts(60, doneAt, rngZero);               // completes mid-window
        expect(STATE.contract.done).toBe("paid");
        const expectedNext = Math.max(at + cfg.minIntervalSec, doneAt + cfg.redrawGraceSec);
        expect(STATE.contract.nextAt).toBe(expectedNext);
        tickContracts(1, expectedNext - 0.01, rngZero);
        expect(STATE.contract.id).toBe(1);
        tickContracts(1, expectedNext, rngZero);
        expect(STATE.contract.id).toBe(2);
        expect(STATE.contract.done).toBeNull();
    });
});

describe("freeze semantics", () => {
    it("dt = 0 / NaN / negative / Infinity are strict no-ops mid-contract", () => {
        const at = drawContract(rngZero, 20);
        STATE.servedKw = 999;
        const before = { ...STATE.contract };
        const money = STATE.money;
        for (const dt of [0, NaN, -5, Infinity]) {
            tickContracts(dt, at + 500, rngZero);         // way past endsAt AND nextAt
        }
        expect(STATE.contract).toEqual(before);
        expect(STATE.money).toBe(money);
    });

    it("gameOver freezes scheduling and evaluation completely", () => {
        STATE.gameOver = "reputation";
        tickContracts(1, 100, rngZero);
        expect(STATE.contract.nextAt).toBeNull();
        expect(STATE.contract.key).toBeNull();
    });
});

describe("locales", () => {
    it("EN and UK carry identical key sets (every new string is translated)", () => {
        expect(Object.keys(UK_TRANSLATIONS).sort()).toEqual(Object.keys(EN_TRANSLATIONS).sort());
    });

    it("every contract pool key has a name string in both locales", () => {
        for (const p of CONFIG.contracts.pool) {
            expect(EN_TRANSLATIONS["contract_" + p.key]).toBeTruthy();
            expect(UK_TRANSLATIONS["contract_" + p.key]).toBeTruthy();
        }
    });
});
