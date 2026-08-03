// First test in the "sim" tier — headless UI over the REAL index.html DOM
// (tests/helpers/sim-setup.mjs installs the fixture and the THREE stub).
//
// Subject: the thermal-overlay legend. Its whole job is to tie the colours
// on the floor to the two numbers that matter, so what is pinned here is the
// tie itself: tick positions derived from CONFIG, and a hottest-cell readout
// that agrees with the field. A retune of throttleStartC / shutdownC that
// forgets the legend turns this red.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState, heatIndex } from "../../src/core/state.js";
import { toggleThermalOverlay, tickOverlay, heatColor } from "../../src/ui/overlay.js";

const LO = CONFIG.heat.ambientC;
const HI = CONFIG.buildings.rack.shutdownC;
const THROTTLE = CONFIG.buildings.rack.throttleStartC;
const legend = () => document.getElementById("overlay-legend");

beforeEach(() => {
    resetState();
    toggleThermalOverlay(false);
});

describe("thermal overlay legend", () => {
    it("is hidden until the overlay is on, and hides again with it", () => {
        expect(legend().classList.contains("hidden")).toBe(true);
        toggleThermalOverlay(true);
        expect(legend().classList.contains("hidden")).toBe(false);
        toggleThermalOverlay(false);
        expect(legend().classList.contains("hidden")).toBe(true);
    });

    it("labels the two thresholds from CONFIG, never hardcoded", () => {
        toggleThermalOverlay(true);
        const text = legend().textContent;
        expect(text).toContain(`${LO}°`);
        expect(text).toContain(`${THROTTLE}°`);
        expect(text).toContain(`${HI}°`);
    });

    it("puts the throttle tick at the position the colour scale uses", () => {
        toggleThermalOverlay(true);
        const expected = ((THROTTLE - LO) / (HI - LO)) * 100;
        const marks = [...legend().querySelectorAll("[style*='left']")]
            .map((el) => parseFloat(el.style.left));
        expect(marks.length).toBeGreaterThan(0);
        for (const m of marks) expect(m).toBeCloseTo(expected, 6);
    });

    it("reads the hottest cell out of the live field", () => {
        toggleThermalOverlay(true);
        STATE.heatField[heatIndex(4, 4)] = 58;
        tickOverlay(1);   // past the 0.2 s repaint cadence
        const el = document.getElementById("legend-hottest");
        expect(el.textContent).toContain("58.0");
        // Above the throttle threshold it must read as an alarm, not a fact.
        expect(el.className).toContain("text-red-300");
    });

    it("shares one colour ramp with the floor it explains", () => {
        // The legend samples heatColor() directly; if the plane ever painted
        // from a different function the two could disagree silently.
        const [r, g, b] = heatColor(HI);
        expect(r).toBeGreaterThan(200);   // deep red at shutdown
        expect(g).toBeLessThan(60);
        expect(b).toBeLessThan(60);
        const cold = heatColor(LO);
        expect(cold[2]).toBeGreaterThan(cold[0]);   // blue at ambient
    });
});
