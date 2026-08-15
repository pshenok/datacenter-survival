// The Lab's visible half, against the REAL index.html DOM (like
// tests/sim/overlay-legend.test.mjs). Two things are proven here:
//
//   INERTNESS — the panel does not render outside a sandbox level. The
//   mechanic itself is proven headless in tests/lab.test.mjs; this is the
//   half a player can see, and it must be invisible in the thirteen levels
//   and in survival.
//
//   THE BOUNDARY — src/ui/* reads STATE and never writes it. Every control
//   here is clicked with no-op callbacks and STATE comes out untouched, so
//   the knobs provably go through game.js, not through the panel.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState } from "../../src/core/state.js";
import { resetBuildingIds } from "../../src/entities/Building.js";
import { startLevelState } from "../../src/campaign/campaign.js";
import { LAB_LIMITS, LAB_EVENTS } from "../../src/campaign/lab.js";
import { initLabPanel, tickLabPanel, hideLabPanel, resetLabPanel } from "../../src/ui/lab-panel.js";
import { tickHud } from "../../src/ui/hud.js";
import { i18n } from "../../src/i18n.js";

const panel = () => document.getElementById("lab-panel");
const hidden = () => panel().classList.contains("hidden");
const btn = (sel) => panel().querySelector(sel);

let calls;

function spies() {
    calls = [];
    initLabPanel({
        setDemandKw: (kw) => calls.push(["demand", kw]),
        setAmbientC: (c) => calls.push(["ambient", c]),
        setTariffBand: (m) => calls.push(["band", m]),
        fire: (k) => calls.push(["fire", k]),
        reset: () => calls.push(["reset"]),
    });
}

// The panel only paints while a sandbox level is actually being played.
function runningLab() {
    startLevelState("the_lab");
    STATE.isRunning = true;
    tickLabPanel();
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    resetLabPanel();
    hideLabPanel();
    spies();
    i18n.setLocale("en");
});

describe("the panel is inert outside The Lab", () => {
    it("does not render on the main menu", () => {
        tickLabPanel();
        expect(hidden()).toBe(true);
        expect(panel().innerHTML).toBe("");
    });

    it("does not render in an ordinary campaign level, even mid-run", () => {
        startLevelState("first_watt");
        STATE.isRunning = true;
        tickLabPanel();
        expect(hidden()).toBe(true);
        expect(panel().innerHTML).toBe("");
    });

    it("does not render in survival", () => {
        STATE.isRunning = true;
        tickLabPanel();
        expect(hidden()).toBe(true);
    });

    it("hides again the moment the player leaves the Lab for another level", () => {
        runningLab();
        expect(hidden()).toBe(false);
        startLevelState("hot_aisle");
        tickLabPanel();
        expect(hidden()).toBe(true);
    });
});

describe("the panel in The Lab", () => {
    it("renders every control: two knobs, four meter positions, six fire buttons, a reset", () => {
        runningLab();
        expect(hidden()).toBe(false);
        expect(panel().textContent).toContain("THE LAB");
        expect(panel().querySelectorAll("[data-lab-step]").length).toBe(4);   // two knobs, -/+
        expect([...panel().querySelectorAll("[data-lab-band]")].map((b) => b.dataset.labBand))
            .toEqual(["auto", "night", "day", "off"]);
        // One button per firable event, generated from the same list
        // campaign/lab.js fires from — a sixth event cannot ship buttonless.
        expect([...panel().querySelectorAll("[data-lab-fire]")].map((b) => b.dataset.labFire))
            .toEqual(LAB_EVENTS);
        expect(LAB_EVENTS).toEqual(["heatwave", "brownout", "outage", "tariff", "drought", "crac_fail"]);
        expect(btn("#lab-reset")).not.toBeNull();
    });

    it("is a VIEW over STATE — the readings come from the simulation, not from a copy", () => {
        runningLab();
        expect(document.getElementById("lab-val-demand").textContent)
            .toBe(`${CONFIG.campaign.levels.the_lab.demandKw} kW`);
        expect(document.getElementById("lab-val-ambient").textContent)
            .toBe(`${CONFIG.heat.ambientC} °C`);

        // Move the simulation directly: the panel must follow it.
        STATE.demandFixedKw = 34;
        STATE.lab.ambientC = 41;
        tickLabPanel();
        expect(document.getElementById("lab-val-demand").textContent).toBe("34 kW");
        expect(document.getElementById("lab-val-ambient").textContent).toBe("41 °C");
    });

    it("marks the meter position STATE is actually in", () => {
        runningLab();
        const at = (mode) => panel().querySelector(`[data-lab-band="${mode}"]`).classList.contains("text-amber-300");
        expect(at("auto")).toBe(true);

        STATE.lab.tariffBand = "night";
        tickLabPanel();
        expect(at("night")).toBe(true);
        expect(at("auto")).toBe(false);

        STATE.tariff.cycleOn = false;
        STATE.lab.tariffBand = null;
        tickLabPanel();
        expect(at("off")).toBe(true);
    });

    it("survives a mid-game locale switch without being rebuilt", () => {
        runningLab();
        const en = panel().textContent;
        i18n.setLocale("uk");
        tickLabPanel();
        const uk = panel().textContent;
        expect(uk).not.toBe(en);
        expect(uk).toContain("ЛАБОРАТОРІЯ");
        expect(uk).toContain("кВт");
    });

    it("shows no raw keys in either locale", () => {
        for (const loc of ["en", "uk"]) {
            i18n.setLocale(loc);
            resetLabPanel();
            runningLab();
            expect(panel().textContent, loc).not.toContain("lab_");
            expect(panel().textContent, loc).not.toContain("tariff_band_");
            expect(panel().textContent.length).toBeGreaterThan(40);
        }
    });

    it("uses inline SVG icons and no emoji", () => {
        runningLab();
        expect(panel().querySelectorAll("svg").length).toBeGreaterThanOrEqual(8);
        expect(/\p{Extended_Pictographic}/u.test(panel().innerHTML)).toBe(false);
    });
});

// Found by playing the Lab in a browser, and true of free play too: both
// switch the day/night meter on and then sit PAUSED while the player builds,
// and STATE.tariff.band is written by tickDemand, which has not run yet.
describe("the meter pill at a paused start", () => {
    it("names a real band instead of rendering the raw key", () => {
        runningLab();
        expect(STATE.tariff.cycleOn).toBe(true);
        expect(STATE.tariff.band).toBeNull();      // nothing has ticked
        tickHud();
        const pill = document.getElementById("hud-tariff");
        expect(pill.classList.contains("hidden")).toBe(false);
        expect(pill.textContent).not.toContain("tariff_band_");
        expect(pill.textContent).toBe("Night ×0.6");
    });

    it("follows the pinned band while the Lab holds one", () => {
        runningLab();
        STATE.lab.tariffBand = "day";
        tickHud();
        expect(document.getElementById("hud-tariff").textContent).toBe("Day ×1.4");
    });
});

describe("every control goes through game.js, never through the panel", () => {
    it("the knobs hand back the CURRENT reading plus one step", () => {
        runningLab();
        const step = LAB_LIMITS.demandKw.step;
        panel().querySelector('[data-lab-step="demand:1"]').click();
        expect(calls).toEqual([["demand", CONFIG.campaign.levels.the_lab.demandKw + step]]);

        calls = [];
        panel().querySelector('[data-lab-step="ambient:-1"]').click();
        expect(calls).toEqual([["ambient", CONFIG.heat.ambientC - LAB_LIMITS.ambientC.step]]);
    });

    it("the meter buttons name their own position", () => {
        runningLab();
        for (const mode of ["auto", "night", "day", "off"]) {
            calls = [];
            panel().querySelector(`[data-lab-band="${mode}"]`).click();
            expect(calls).toEqual([["band", mode]]);
        }
    });

    it("the fire buttons name their own event", () => {
        runningLab();
        for (const kind of ["heatwave", "brownout", "outage", "tariff", "crac_fail"]) {
            calls = [];
            panel().querySelector(`[data-lab-fire="${kind}"]`).click();
            expect(calls).toEqual([["fire", kind]]);
        }
    });

    it("reset asks, and does not do it itself", () => {
        runningLab();
        btn("#lab-reset").click();
        expect(calls).toEqual([["reset"]]);
    });

    it("CLICKING EVERYTHING WRITES NOTHING — the callbacks are the only door to STATE", () => {
        runningLab();
        const before = JSON.stringify({
            lab: STATE.lab,
            demandFixedKw: STATE.demandFixedKw,
            tariff: STATE.tariff,
            heatwave: STATE.heatwave,
            brownout: STATE.brownout,
            gridOutage: STATE.gridOutage,
            money: STATE.money,
        });
        for (const b of panel().querySelectorAll("button")) b.click();
        tickLabPanel();
        expect(JSON.stringify({
            lab: STATE.lab,
            demandFixedKw: STATE.demandFixedKw,
            tariff: STATE.tariff,
            heatwave: STATE.heatwave,
            brownout: STATE.brownout,
            gridOutage: STATE.gridOutage,
            money: STATE.money,
        })).toBe(before);
        expect(calls.length).toBe(15);   // 4 steppers + 4 meter + 6 fire + 1 reset
    });
});
