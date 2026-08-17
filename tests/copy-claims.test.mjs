// Prose is a mechanic here: a briefing or an FAQ row is where most players
// learn what the simulation does, and a sentence that reads well and says
// something the sim does not do is a bug like any other.
//
// Two shipped ones are pinned here, and both are checked against CONFIG and
// the sim rather than against a copy of the sentence — a test that quotes
// today's wording only pins today's wording.
//
//   dark_chain's briefing said generators were out because "their transfer
//   switch needs longer to pick up than the blackout lasts". The cutover is
//   3 s and the blackouts are 6 s: it is HALF the outage, so a generator
//   would have carried the room. The real reason is that the level bans
//   them, to isolate the gap a UPS bridges.
//
//   The uk FAQ said racks earn "поки ЗАТРЕБУВАНІ й ОХОЛОДЖЕНІ" — in demand
//   and cooled. The sim's two gates are POWER and heat, and it is the first
//   rule a Ukrainian player reads.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { tickDemand } from "../src/sim/demand.js";
import { EN_TRANSLATIONS } from "../src/locales/en.js";
import { UK_TRANSLATIONS } from "../src/locales/uk.js";

const DT = 0.05;
const LOCALES = [["en", EN_TRANSLATIONS], ["uk", UK_TRANSLATIONS]];

// The stems each locale uses when it talks about a standby set's changeover.
// Loose enough to catch a rewording, tight enough not to fire on the plain
// verb "pick up" the new copy uses about the battery.
const SWITCH_TALK = { en: /transfer switch|cutover/i, uk: /перемикач/i };
// "banned" in each locale, as a stem: bans/banned, забороняє/заборонені.
const BAN_TALK = { en: /\bban/i, uk: /заборон/i };

const scenario = (table, id) => table[`lv_${id}_scenario`] || "";
const outages = (id) => (CONFIG.campaign.levels[id].script || []).filter((e) => e.kind === "outage");

beforeEach(() => {
    resetState();
    resetBuildingIds();
});

describe("dark_chain's briefing states a reason CONFIG actually implements", () => {
    it("THE FACT THE OLD LINE GOT WRONG: the cutover is shorter than the dark", () => {
        const cutoverSec = CONFIG.buildings.generator.cutoverSec;
        const dark = outages("dark_chain");
        expect(dark.length, "dark_chain's outage script moved").toBeGreaterThan(0);
        for (const o of dark) {
            // A generator would pick up half-way through each blackout, so
            // "it needs longer than the blackout lasts" is false by the
            // config's own numbers — whichever way either is retuned.
            expect(cutoverSec, `outage ${o.durationSec}s`).toBeLessThan(o.durationSec);
        }
    });

    it("the reason it gives instead is real: the level bans generators", () => {
        expect(CONFIG.campaign.levels.dark_chain.banned).toContain("generator");
    });

    it("a level that BANS a building explains its absence with the ban, in both locales", () => {
        let checked = 0;
        for (const [id, cfg] of Object.entries(CONFIG.campaign.levels)) {
            for (const type of cfg.banned || []) {
                for (const [loc, table] of LOCALES) {
                    const text = scenario(table, id);
                    const name = (table["b_" + type] || "").toLowerCase();
                    // Only a briefing that raises the banned building at all
                    // owes the player a reason for its absence.
                    if (!name || !text.toLowerCase().includes(name)) continue;
                    checked++;
                    expect(text, `${id} @ ${loc}`).toMatch(BAN_TALK[loc]);
                }
            }
        }
        expect(checked, "no banned building is mentioned in any briefing").toBeGreaterThan(0);
    });

    it("and no level that bans generators blames their transfer switch", () => {
        for (const [loc, table] of LOCALES) {
            const talkers = Object.keys(CONFIG.campaign.levels)
                .filter((id) => SWITCH_TALK[loc].test(scenario(table, id)));
            // The detector is not vacuous: fuel_clock teaches the changeover
            // and says so. What it may not do is explain an ABSENCE.
            expect(talkers.length, `${loc}: nothing talks about the switch`).toBeGreaterThan(0);
            for (const id of talkers) {
                expect(CONFIG.campaign.levels[id].banned || [], `${id} @ ${loc}`)
                    .not.toContain("generator");
            }
        }
    });
});

describe("the FAQ's first rule is the rule the sim enforces", () => {
    // A live chain: grid-connected feed -> pdu -> rack, the shape
    // tests/demand.test.mjs uses. actualKw and throttleFactor are last
    // tick's power and heat results, per the documented one-tick lag.
    function room({ actualKw, throttleFactor }) {
        const feed = new Building("grid_feed", 0, 0);
        feed.parentId = "grid";
        const pdu = new Building("pdu", 1, 0);
        pdu.parentId = feed.id;
        feed.childIds.push(pdu.id);
        const rack = new Building("rack", 2, 0);
        rack.parentId = pdu.id;
        pdu.childIds.push(rack.id);
        rack.actualKw = actualKw;
        rack.throttleFactor = throttleFactor;
        STATE.buildings.push(feed, pdu, rack);
        STATE.demandFixedKw = CONFIG.buildings.rack.capacityKw;
        return rack;
    }

    function moneyDelta(opts) {
        const before = STATE.money;
        room(opts);
        tickDemand(DT, 10);
        return STATE.money - before;
    }

    it("POWERED and COOL are the two gates — either one shut and the rack earns nothing", () => {
        const cfg = CONFIG.buildings.rack;
        expect(moneyDelta({ actualKw: cfg.capacityKw, throttleFactor: 1 })).toBeGreaterThan(0);

        resetState(); resetBuildingIds();
        // No power delivered: the chain is dead above it.
        expect(moneyDelta({ actualKw: 0, throttleFactor: 1 })).toBeLessThan(0);

        resetState(); resetBuildingIds();
        // Powered, but cooked past shutdownC — heat closes the other gate.
        expect(moneyDelta({ actualKw: cfg.capacityKw, throttleFactor: 0 })).toBeLessThan(0);
    });

    it("and both locales name those two, not something else", () => {
        // Each locale's own words for the gates, taken from the rows the HUD
        // shows when one is shut. Stems, so declension cannot break this.
        const gates = {
            en: { power: "POWERED", cool: "COOL" },
            uk: { power: "ЖИВЛЕНН", cool: "ОХОЛОДЖ" },
        };
        // uk's stems are the HUD's own: "НЕМАЄ ЖИВЛЕННЯ" / "Охолодження".
        expect(UK_TRANSLATIONS.insp_unpowered.toUpperCase()).toContain(gates.uk.power);
        expect(UK_TRANSLATIONS.insp_duty.toUpperCase()).toContain(gates.uk.cool);

        for (const [loc, table] of LOCALES) {
            const rule = table.faq_basics_1.toUpperCase();
            expect(rule, `${loc} does not name the POWER gate`).toContain(gates[loc].power);
            expect(rule, `${loc} does not name the HEAT gate`).toContain(gates[loc].cool);
        }
    });
});

describe("uk calls a substation what the HUD calls a substation", () => {
    it("one word for one thing, everywhere in the locale", () => {
        const hudWord = UK_TRANSLATIONS.insp_utility;
        expect(hudWord).toMatch(/[Пп]ідстанц/);
        // "утиліта" is the English word wearing a Ukrainian coat, and it
        // appeared in the same rooms the HUD labels "Підстанція".
        for (const [key, value] of Object.entries(UK_TRANSLATIONS)) {
            if (typeof value !== "string") continue;
            expect(value, `${key} uses a second word for a substation`).not.toMatch(/утиліт/i);
        }
    });
});
