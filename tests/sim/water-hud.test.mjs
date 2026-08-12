// Water's visible half: the WUE readout, the run total, the drought pill, the
// plant's inspect row, and the FAQ's Water tab. The mechanic itself is proven
// headless in tests/water.test.mjs; this file is the other half of the promise
// — a number the player is never shown teaches nothing — checked against the
// REAL index.html DOM, like tests/sim/peak-shaving-hud.test.mjs.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState } from "../../src/core/state.js";
import { Building, resetBuildingIds } from "../../src/entities/Building.js";
import { tickHud, renderInspect } from "../../src/ui/hud.js";
import { openFaq, closeFaq } from "../../src/ui/faq.js";
import { i18n } from "../../src/i18n.js";

const PLANT = CONFIG.buildings.chiller;

function place(type, gx = 0, gz = 0) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

const wue = () => document.getElementById("hud-wue");
const runLine = () => document.getElementById("hud-wue-run");
const pill = () => document.getElementById("hud-drought");
const panel = () => document.getElementById("inspect-panel");

// A hall that is drawing IT power and evaporating water for it.
function drinkingRoom({ litersPerHour = 45, itDrawKw = 25 } = {}) {
    STATE.itDrawKw = itDrawKw;
    STATE.totalDrawKw = itDrawKw * 1.3;
    STATE.water.litersPerHour = litersPerHour;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("the WUE readout", () => {
    it("reads litres per kWh of IT energy — the industry's number, not a PUE-shaped one", () => {
        drinkingRoom({ litersPerHour: 45, itDrawKw: 25 });
        tickHud();
        expect(wue().textContent).toBe("1.80");
    });

    it("is a DASH in a room that evaporates nothing — an air-cooled hall has no water score", () => {
        STATE.itDrawKw = 25;
        STATE.totalDrawKw = 32;
        tickHud();
        expect(wue().textContent).toBe("—");
        expect(runLine().classList.contains("hidden")).toBe(true);
    });

    it("shows the run total once litres have actually accrued", () => {
        drinkingRoom();
        STATE.water.totalLiters = 240;
        STATE.water.itKwh = 150;
        tickHud();
        expect(runLine().classList.contains("hidden")).toBe(false);
        expect(runLine().textContent).toBe("Run 240 L · 1.60 L/kWh");
    });
});

describe("the drought pill", () => {
    it("is hidden while no drought is running", () => {
        drinkingRoom();
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(true);
    });

    it("names the multiplier while a drought prices the room's water", () => {
        drinkingRoom();
        STATE.drought.active = true;
        STATE.drought.multiplier = CONFIG.events.drought.multiplier;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(false);
        expect(pill().textContent).toBe(`DROUGHT ×${CONFIG.events.drought.multiplier}`);
    });

    it("INERT: an air-cooled hall is never told about a drought it cannot pay for", () => {
        STATE.itDrawKw = 25;
        STATE.totalDrawKw = 32;                 // a real, working, waterless room
        STATE.drought.active = true;
        STATE.drought.multiplier = CONFIG.events.drought.multiplier;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(true);
        expect(wue().textContent).toBe("—");
        expect(runLine().classList.contains("hidden")).toBe(true);
    });
});

describe("the plant's inspect panel", () => {
    it("shows the BILLED litres, not a formula restated in the HUD", () => {
        const plant = place("chiller");
        plant.duty = 0.5;
        plant.actualKw = 4;
        plant.waterLitersPerHour = 12.5;        // written by sim/heat.js
        renderInspect(plant);
        expect(panel().textContent).toContain("12.5 L/hr");
    });

    it("an idling plant shows power and ZERO water — the asymmetry, in one panel", () => {
        const plant = place("chiller");
        plant.duty = 0;
        plant.actualKw = PLANT.idleDrawKw;
        plant.waterLitersPerHour = 0;
        renderInspect(plant);
        expect(panel().textContent).toContain(`${PLANT.idleDrawKw.toFixed(1)} kW`);
        expect(panel().textContent).toContain("0.0 L/hr");
    });

    it("a CRAC has no water row at all — it drinks nothing, so it is asked nothing", () => {
        const crac = place("crac");
        crac.actualKw = 2;
        renderInspect(crac);
        expect(panel().textContent).not.toContain("L/hr");
    });
});

describe("FAQ Water tab is generated from CONFIG, never hand-written", () => {
    it("prints the plant's WUE, the price, the drought and the BREAK-EVEN off CONFIG", () => {
        const crac = CONFIG.buildings.crac;
        const crah = CONFIG.buildings.crah;
        const eco = CONFIG.economy;
        const units = PLANT.coolUnits;
        const cracKw = (units / crac.coolPerSec) * crac.drawKw;
        const loopKw = PLANT.drawKw + (units / crah.coolPerSec) * crah.drawKw;
        const savedPerHour = (cracKw - loopKw) * eco.powerCostPerKwh;
        const litersPerHour = units * PLANT.litersPerCoolUnit;

        openFaq();
        const tab = document.querySelector("[data-faqtab=\"water\"]");
        expect(tab).not.toBeNull();
        tab.click();
        const text = document.getElementById("faq-content").textContent;

        // Every one of these is a number the meter actually bills from, or an
        // arithmetic consequence of two of them. Change CONFIG and the page
        // changes with it — which is the entire reason it is generated.
        expect(text).toContain(`${PLANT.litersPerCoolUnit} L/kWh`);
        expect(text).toContain(`${litersPerHour.toFixed(0)} L/hr`);
        expect(text).toContain(`$${eco.waterCostPerLiter}/L`);
        expect(text).toContain(`$${(litersPerHour * eco.waterCostPerLiter).toFixed(2)}/hr`);
        expect(text).toContain(`$${savedPerHour.toFixed(2)}/hr`);
        // The row the whole decision turns on: the price at which the loop's
        // efficiency stops paying for its tower.
        expect(text).toContain(`$${(savedPerHour / litersPerHour).toFixed(3)}/L`);
        expect(text).toContain(`×${CONFIG.events.drought.multiplier} = $${(eco.waterCostPerLiter * CONFIG.events.drought.multiplier).toFixed(3)}/L`);
        closeFaq();
    });

    it("THE PAGE CANNOT LIE: the drought price it prints really is past break-even", () => {
        // The claim the tab makes in prose — that a drought flips the decision
        // — has to be true of the numbers the same tab prints. This is the
        // assertion that fails if the multiplier is ever tuned down below the
        // point where it matters, which is exactly when the copy starts lying.
        const crac = CONFIG.buildings.crac;
        const crah = CONFIG.buildings.crah;
        const units = PLANT.coolUnits;
        const savedPerHour = ((units / crac.coolPerSec) * crac.drawKw
            - (PLANT.drawKw + (units / crah.coolPerSec) * crah.drawKw)) * CONFIG.economy.powerCostPerKwh;
        const breakEven = savedPerHour / (units * PLANT.litersPerCoolUnit);
        const droughtPrice = CONFIG.economy.waterCostPerLiter * CONFIG.events.drought.multiplier;
        expect(CONFIG.economy.waterCostPerLiter).toBeLessThan(breakEven);   // normally the loop wins
        expect(droughtPrice).toBeGreaterThan(breakEven);                    // in a drought it does not
    });

    it("offers the tab in both locales with no raw keys left showing", () => {
        for (const loc of ["en", "uk"]) {
            i18n.setLocale(loc);
            openFaq();
            document.querySelector("[data-faqtab=\"water\"]").click();
            const text = document.getElementById("faq-content").textContent;
            expect(text, loc).not.toContain("faq_water");
            expect(text.length, loc).toBeGreaterThan(400);
            closeFaq();
        }
        i18n.setLocale("en");
    });
});
