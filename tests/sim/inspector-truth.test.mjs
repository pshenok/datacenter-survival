// The inspector's promise: every row is a fact the simulation computed, in a
// language the player selected. Two rows were neither.
//
// A LINK's panel read "Draw: cap 30 kW". The label said consumption, the
// value was a constant nameplate that never moved, and "cap" was hardcoded
// English no locale could translate. The carried kW — b.actualKw, the number
// the whole power model resolves — was shown nowhere in the game for a link,
// so a player watching a bus climb toward its rating had nothing to watch.
//
// A DEAD chiller plant read "LOOP OVER-COMMITTED — every CRAH is throttled",
// i.e. buy fewer heads. The truth was that the plant was gone and not coming
// back: chiller_fail zeroes its duty, which zeroes the loop's capacity and
// its ratio, which dropped the panel into the starvation row. On the level
// whose whole lesson is that one plant is a shared blast radius, the
// inspector named the wrong cause.
//
// Asserted against the REAL index.html DOM, like tests/sim/water-hud.test.mjs.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState } from "../../src/core/state.js";
import { Building, resetBuildingIds } from "../../src/entities/Building.js";
import { applyScriptEvent } from "../../src/campaign/campaign.js";
import { repairCrac } from "../../src/sim/crisis.js";
import { applyCracCooling } from "../../src/sim/heat.js";
import { renderInspect } from "../../src/ui/hud.js";
import { i18n } from "../../src/i18n.js";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import { UK_TRANSLATIONS } from "../../src/locales/uk.js";

const DT = 0.05;
const text = () => document.getElementById("inspect-panel").textContent;

// The three types renderInspect has no dedicated branch for — every one of
// them chain gear that CARRIES power (sim/power.js: "actualKw, powered —
// per-tick resolution results (links carry, loads draw)") rather than
// drawing it.
const LINKS = ["grid_feed", "transformer", "pdu"];

function place(type, gx = 0, gz = 0) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// A loop with real heat under it: the CRAHs' duty comes from the field
// (sim/heat.js pass 1), so an empty cold room would ask the plant for
// nothing and no ratio could ever fall.
function runningLoop(heads) {
    const plant = place("chiller", 2, 2);
    plant.powered = true;
    plant.actualKw = CONFIG.buildings.chiller.drawKw;
    for (let i = 0; i < heads; i++) {
        const crah = place("crah", 5 + i, 5);
        crah.powered = true;
        crah.actualKw = CONFIG.buildings.crah.drawKw;
    }
    STATE.heatField.fill(60);
    applyCracCooling(DT);
    return plant;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    i18n.setLocale("en");
});

describe("a link's inspector shows what it is CARRYING", () => {
    for (const type of LINKS) {
        it(`${type}: the carried kW against its rating, not a nameplate on its own`, () => {
            const link = place(type);
            link.actualKw = 9.4;
            renderInspect(link);
            expect(text()).toContain(`9.4 / ${CONFIG.buildings[type].capacityKw} kW`);
        });
    }

    it("THE POINT: the row MOVES with the load — a nameplate never did", () => {
        const pdu = place("pdu");
        pdu.actualKw = 0;
        renderInspect(pdu);
        const idle = text();
        pdu.actualKw = CONFIG.buildings.pdu.capacityKw - 1;
        renderInspect(pdu);
        expect(text()).not.toBe(idle);
        expect(text()).toContain(`${(CONFIG.buildings.pdu.capacityKw - 1).toFixed(1)} / `);
    });

    it("carries no hardcoded English: every label comes from the locale", () => {
        for (const [loc, table] of [["en", EN_TRANSLATIONS], ["uk", UK_TRANSLATIONS]]) {
            i18n.setLocale(loc);
            for (const type of LINKS) {
                const link = place(type);
                link.actualKw = 3.25;
                renderInspect(link);
                expect(text(), `${type} @ ${loc}`).toContain(table.insp_carried);
                expect(text(), `${type} @ ${loc}`).not.toContain("insp_");
                // The literal that no locale could ever translate.
                expect(text(), `${type} @ ${loc}`).not.toContain("cap ");
            }
        }
    });

    it("does not call a link's throughput its CONSUMPTION — a link consumes nothing", () => {
        const link = place("transformer");
        link.actualKw = 12;
        renderInspect(link);
        expect(text()).not.toContain(EN_TRANSLATIONS.insp_draw);
    });
});

describe("a failed chiller plant says it is DEAD, not that the loop is over-committed", () => {
    it("names the failure the script actually fired", () => {
        const plant = runningLoop(2);          // 2 heads: 20 units asked of 45
        expect(STATE.coolingLoop.ratio).toBe(1);

        expect(applyScriptEvent({ kind: "chiller_fail" }, 60)).toBe(true);
        applyCracCooling(DT);                  // the tick after the plant dies
        expect(plant.broken).toBe(true);
        expect(STATE.coolingLoop.capacityUnits).toBe(0);
        expect(STATE.coolingLoop.ratio).toBe(0);

        renderInspect(plant);
        expect(text()).toContain(EN_TRANSLATIONS.insp_plant_dead);
        // The wrong diagnosis: "buy fewer heads" when the heads are innocent.
        expect(text()).not.toContain(EN_TRANSLATIONS.insp_loop_starved);
    });

    it("promises no repair, because CONFIG offers none", () => {
        const plant = runningLoop(2);
        applyScriptEvent({ kind: "chiller_fail" }, 60);
        applyCracCooling(DT);
        renderInspect(plant);

        // The permanence is the lesson: chiller_fail sets repairAt to
        // Infinity, tickBreakdown's self-repair sweep can never reach it, and
        // repairCrac refuses anything that is not a CRAC even when rich.
        expect(plant.repairAt).toBe(Infinity);
        STATE.money = 10 * CONFIG.events.cracBreakdown.repairCost;
        expect(repairCrac(plant)).toBe(false);
        expect(text()).not.toContain(EN_TRANSLATIONS.insp_broken.split("(")[0].trim());
        expect(text()).not.toContain(String(CONFIG.events.cracBreakdown.repairCost));
    });

    it("STILL blames over-commitment when over-commitment is the truth", () => {
        // Five heads ask 50 units of a healthy 45 — nobody is broken, the
        // loop really is short, and the row that says so must survive.
        const plant = runningLoop(5);
        expect(STATE.coolingLoop.demandUnits).toBeGreaterThan(STATE.coolingLoop.capacityUnits);
        renderInspect(plant);
        expect(text()).toContain(EN_TRANSLATIONS.insp_loop_starved);
        expect(text()).not.toContain(EN_TRANSLATIONS.insp_plant_dead);
    });

    it("says it in both locales, with no raw key left showing", () => {
        const plant = runningLoop(2);
        applyScriptEvent({ kind: "chiller_fail" }, 60);
        applyCracCooling(DT);
        for (const [loc, table] of [["en", EN_TRANSLATIONS], ["uk", UK_TRANSLATIONS]]) {
            i18n.setLocale(loc);
            renderInspect(plant);
            expect(text(), loc).toContain(table.insp_plant_dead);
            expect(text(), loc).not.toContain("insp_");
        }
    });
});
