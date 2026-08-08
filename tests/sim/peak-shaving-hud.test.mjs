// Peak shaving's visible half: the HUD pill and the UPS inspect rows. The
// mechanic in src/sim/power.js is proven headless in tests/peak-shaving.test.mjs;
// this file is the promise from the task itself — "the HUD must show when
// shaving is active and what it is saving, or the player cannot learn the
// trade" — checked against the REAL index.html DOM, like
// tests/sim/overlay-legend.test.mjs.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState } from "../../src/core/state.js";
import { Building, resetBuildingIds } from "../../src/entities/Building.js";
import { tickHud, renderInspect } from "../../src/ui/hud.js";
import { openFaq, closeFaq } from "../../src/ui/faq.js";
import { i18n } from "../../src/i18n.js";

function place(type, gx = 0, gz = 0) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

const pill = () => document.getElementById("hud-peakshave");
const panel = () => document.getElementById("inspect-panel");

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("HUD peak-shave pill", () => {
    it("is hidden while the toggle is off", () => {
        STATE.peakShave.on = false;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(true);
    });

    it("shows 'armed' while on but nothing is currently being shaved", () => {
        STATE.peakShave.on = true;
        STATE.batteryKw = 0;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(false);
        expect(pill().textContent).toBe("PEAK SHAVE ARMED — buffer ready, nothing to spend yet");
    });

    it("shows the kW and the $/hr being saved while actively shaving", () => {
        STATE.peakShave.on = true;
        STATE.batteryKw = 12;
        STATE.totalDrawKw = 20;
        STATE.tariff.active = true;
        STATE.tariff.multiplier = 3.5; // day x peak
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(false);
        const expectedRate = (12 * CONFIG.economy.powerCostPerKwh * 3.5).toFixed(2);
        expect(pill().textContent).toBe(`SHAVING −12.0 kW · saving $${expectedRate}/hr`);
    });

    it("hides again the instant the toggle goes off, even mid-discharge", () => {
        STATE.peakShave.on = true;
        STATE.batteryKw = 12;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(false);
        STATE.peakShave.on = false;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(true);
    });
});

describe("UPS inspect panel: buffer plus what it is doing right now", () => {
    it("names shaving, charging, and bridging distinctly — not just a moving number", () => {
        const ups = place("ups");
        ups.bufferLeft = 4;
        for (const [mode, key] of [
            ["shaving", "DISCHARGING — peak shaving"],
            ["charging", "RECHARGING"],
            ["bridging", "BRIDGING — upstream is dark"],
        ]) {
            ups.upsMode = mode;
            renderInspect(ups);
            expect(panel().textContent).toContain(key);
        }
    });

    it("shows plain buffer numbers with no status line when idle", () => {
        const ups = place("ups");
        ups.bufferLeft = CONFIG.buildings.ups.bufferSec;
        ups.upsMode = "idle";
        renderInspect(ups);
        expect(panel().textContent).not.toContain("DISCHARGING");
        expect(panel().textContent).not.toContain("RECHARGING");
        expect(panel().textContent).not.toContain("BRIDGING");
        expect(panel().textContent).toContain(`${CONFIG.buildings.ups.bufferSec}s`);
    });
});

describe("FAQ Shaving tab is generated from CONFIG, never hand-written", () => {
    it("prints the round trip, the charger and the break-even spread straight off CONFIG", () => {
        const u = CONFIG.buildings.ups;
        openFaq();
        const tab = document.querySelector("[data-faqtab=\"shaving\"]");
        expect(tab).not.toBeNull();
        tab.click();
        const text = document.getElementById("faq-content").textContent;

        // Each of these is a number the meter actually bills from. Change
        // CONFIG and the page changes with it — that is the whole point of
        // generating it, and the reason no number here is typed by hand.
        expect(text).toContain(`${((u.capacityKw * u.bufferSec) / 60).toFixed(1)} kWh`);
        expect(text).toContain(`${Math.round(u.roundTripEff * 100)}%`);
        expect(text).toContain(`${((u.capacityKw * u.rechargeRate) / u.roundTripEff).toFixed(1)} kW`);
        expect(text).toContain(`${(u.bufferSec / u.rechargeRate).toFixed(0)}s`);
        // The spread you must beat to come out ahead, and the one the
        // day/night meter actually offers.
        expect(text).toContain(`x${(1 / u.roundTripEff).toFixed(2)}`);
        expect(text).toContain(`x${(CONFIG.tariff.bands[1].mult / CONFIG.tariff.bands[0].mult).toFixed(2)}`);
        closeFaq();
    });

    it("offers the tab in both locales with no raw keys left showing", () => {
        for (const loc of ["en", "uk"]) {
            i18n.setLocale(loc);
            openFaq();
            document.querySelector("[data-faqtab=\"shaving\"]").click();
            const text = document.getElementById("faq-content").textContent;
            expect(text).not.toContain("faq_shave");
            expect(text.length).toBeGreaterThan(200);
            closeFaq();
        }
        i18n.setLocale("en");
    });
});
