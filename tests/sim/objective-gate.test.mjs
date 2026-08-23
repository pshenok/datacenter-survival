// Streak objectives do not start counting when the level does.
//
// evaluateObjective holds pue_below and no_throttle until o.afterSec, and the
// gate is right: a cold empty room satisfies both trivially, so without it a
// level would be won before its heat ever arrived.
//
// Nothing ever printed it. objectiveLabel and objectiveRow render only
// holdSec, so a player who builds hot_aisle correctly in the first twenty
// seconds watches "No throttled racks for 45s · 0 / 45s" sit at zero for
// SEVENTY — the stated condition being met continuously, the counter frozen,
// on a level whose whole lesson is that the cooling is doing its job.
//
// Five of the thirteen levels are gated this way.
import { describe, expect, it, beforeEach } from "vitest";

import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState } from "../../src/core/state.js";
import { i18n } from "../../src/i18n.js";

const GATED_TYPES = new Set(["no_throttle", "pue_below"]);

// Every gated objective the campaign ships, so a new one cannot be added
// without its gate becoming visible too.
function gatedObjectives() {
    const out = [];
    for (const [id, lvl] of Object.entries(CONFIG.campaign.levels)) {
        for (const o of [...(lvl.objectives || []), ...(lvl.bonuses || [])]) {
            if ((o.afterSec || 0) > 0) out.push({ level: id, o });
        }
    }
    return out;
}

describe("an objective that has not started counting says so", () => {
    beforeEach(() => resetState());

    it("the campaign really does gate objectives — five levels' worth", () => {
        const gated = gatedObjectives();
        expect(gated.length).toBeGreaterThan(4);
        expect(new Set(gated.map((g) => g.level)).size).toBeGreaterThanOrEqual(5);
        for (const g of gated) {
            expect(GATED_TYPES.has(g.o.type), `${g.level}: ${g.o.type} carries afterSec`).toBe(true);
        }
    });

    for (const locale of ["en", "uk"]) {
        it(`${locale}: every gated objective's label names the second it starts`, async () => {
            await i18n.setLocale(locale);
            const { objectiveLabelForTest } = await import("../../src/ui/campaign-ui.js");
            for (const { level, o } of gatedObjectives()) {
                const label = objectiveLabelForTest(o);
                expect(
                    label.includes(String(o.afterSec)),
                    `${locale}/${level}: "${label}" never mentions afterSec ${o.afterSec}`
                ).toBe(true);
            }
        });
    }

    it("an UNGATED objective is not decorated with a gate it does not have", async () => {
        await i18n.setLocale("en");
        const { objectiveLabelForTest } = await import("../../src/ui/campaign-ui.js");
        const plain = { type: "no_throttle", holdSec: 40 };
        const label = objectiveLabelForTest(plain);
        expect(label).toContain("40");
        expect(label.toLowerCase()).not.toContain("counted from");
    });

    it("while the gate is shut the row counts DOWN, not up from zero", async () => {
        await i18n.setLocale("en");
        const { objectiveRowForTest } = await import("../../src/ui/campaign-ui.js");
        const o = { type: "no_throttle", holdSec: 45, afterSec: 70, progress: 0, done: false };

        STATE.elapsedGameTime = 20;
        const early = objectiveRowForTest(o);
        expect(early, "a frozen 0 / 45s reads as failing").not.toContain("0 / 45s");
        expect(early).toContain("50");                 // 70 - 20 seconds to go

        STATE.elapsedGameTime = 90;                    // gate open, streak running
        o.progress = 12;
        const later = objectiveRowForTest(o);
        expect(later).toContain("12 / 45s");
    });
});
