// A serve_kwh_during_event objective is gated on ONE event: campaign.js's
// evaluateObjective reads o.event and counts kWh only while THAT window is
// live. The label printed one string for all of them — "Serve N kWh WHILE the
// grid is down" (uk: "ПОКИ мережа лежить") — ignoring the field entirely.
//
// On `sag` that is the level arguing with itself. Its bonus carries
// event: "brownout", and a brownout is degraded-not-dead by design
// (sim/crisis.js: "batteries ride through OUTAGES, only overprovisioned feed
// HEADROOM rides through a sag") — the grid is emphatically still up, which
// is the entire lesson, printed underneath a line saying it is down.
//
// Both places that print the label are covered: the briefing's goal list
// (openBriefing) and the in-level objectives panel (tickCampaignUi).
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../../src/core/config.js";
import { STATE, resetState } from "../../src/core/state.js";
import { resetBuildingIds } from "../../src/entities/Building.js";
import { startLevelState, applyScriptEvent } from "../../src/campaign/campaign.js";
import { openBriefing, closeBriefing, tickCampaignUi } from "../../src/ui/campaign-ui.js";
import { i18n } from "../../src/i18n.js";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import { UK_TRANSLATIONS } from "../../src/locales/uk.js";

const goals = () => document.getElementById("briefing-goals").textContent;
const panel = () => document.getElementById("objectives-panel").textContent;

// evaluateObjective's own mapping, read back out: brownout and heatwave name
// their own STATE window, anything else falls through to the grid outage.
const KEY_FOR = { brownout: "obj_serve_sag", heatwave: "obj_serve_heat" };
const keyFor = (o) => KEY_FOR[o.event] || "obj_serve_during";

// Every during-event objective the campaign actually ships, primary or bonus.
function duringObjectives() {
    const out = [];
    for (const [id, cfg] of Object.entries(CONFIG.campaign.levels)) {
        for (const o of [...(cfg.objectives || []), ...(cfg.bonuses || [])]) {
            if (o.type === "serve_kwh_during_event") out.push({ id, o });
        }
    }
    return out;
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    i18n.setLocale("en");
});

describe("the objective label names the event it is gated on", () => {
    it("THE SIM SAYS SO: during sag's scripted event the grid is UP, just weak", () => {
        const ev = CONFIG.campaign.levels.sag.script.find((s) => s.kind === "brownout");
        expect(ev, "sag's brownout script moved").toBeTruthy();
        startLevelState("sag");
        applyScriptEvent(ev, ev.atSec);
        expect(STATE.brownout.active).toBe(true);
        expect(STATE.brownout.factor).toBeLessThan(1);
        // The claim "the grid is down" has no state behind it here.
        expect(STATE.gridOutage.active).toBe(false);
    });

    it("so the sag bonus does not tell the player the grid is down", () => {
        const bonus = CONFIG.campaign.levels.sag.bonuses[0];
        expect(bonus.event).toBe("brownout");

        openBriefing("sag");
        expect(goals()).toContain(i18n.t("obj_serve_sag", { target: bonus.target }));
        expect(goals()).not.toContain(i18n.t("obj_serve_during", { target: bonus.target }));
        closeBriefing();

        startLevelState("sag");
        tickCampaignUi();
        expect(panel()).toContain(i18n.t("obj_serve_sag", { target: bonus.target }));
        expect(panel()).not.toContain(i18n.t("obj_serve_during", { target: bonus.target }));
    });

    it("every shipped during-event objective prints ITS event, in both locales", () => {
        for (const { id, o } of duringObjectives()) {
            for (const loc of ["en", "uk"]) {
                i18n.setLocale(loc);
                openBriefing(id);
                const want = i18n.t(keyFor(o), { target: o.target });
                expect(goals(), `${id} @ ${loc}`).toContain(want);
                for (const other of ["obj_serve_during", "obj_serve_sag", "obj_serve_heat"]) {
                    if (other === keyFor(o)) continue;
                    expect(goals(), `${id} @ ${loc}`)
                        .not.toContain(i18n.t(other, { target: o.target }));
                }
                closeBriefing();
            }
        }
    });

    it("the heatwave branch has a label too — evaluateObjective can gate on it", () => {
        startLevelState("sag");
        // The UI reads STATE; a test writes it. This is the objective shape
        // campaign.js already evaluates against STATE.heatwave.active.
        STATE.campaign.bonuses = [
            { id: "x", type: "serve_kwh_during_event", event: "heatwave", target: 9, progress: 0, done: false },
        ];
        tickCampaignUi();
        expect(panel()).toContain(i18n.t("obj_serve_heat", { target: 9 }));
        expect(panel()).not.toContain(i18n.t("obj_serve_during", { target: 9 }));
    });
});

describe("the three labels are three different sentences, in both locales", () => {
    for (const [loc, table] of [["en", EN_TRANSLATIONS], ["uk", UK_TRANSLATIONS]]) {
        it(`${loc}: a sag, a heatwave and a blackout do not read alike`, () => {
            const said = [table.obj_serve_during, table.obj_serve_sag, table.obj_serve_heat];
            for (const s of said) expect(s, loc).toBeTruthy();
            expect(new Set(said).size, `${loc} reuses a sentence`).toBe(3);
        });
    }
});
