// The visible half of a seeded run: the HUD pill, the shareable link, and the
// share row on the game-over screen. The streams themselves are proven
// headless in tests/seeded-run.test.mjs; this file is the other half of the
// promise — a seed the player can neither read nor hand over is not a
// shareable run — checked against the REAL index.html DOM, like
// tests/sim/water-hud.test.mjs.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, resetState } from "../../src/core/state.js";
import { resetBuildingIds } from "../../src/entities/Building.js";
import { tickHud, showGameOver, shareUrl } from "../../src/ui/hud.js";
import { SEED_MAX_LEN } from "../../src/core/rng.js";
import { EN_TRANSLATIONS } from "../../src/locales/en.js";
import { UK_TRANSLATIONS } from "../../src/locales/uk.js";
import { i18n } from "../../src/i18n.js";

const pill = () => document.getElementById("seed-pill");
const pillValue = () => document.getElementById("seed-pill-value");
const shareRow = () => document.getElementById("gameover-share");
const shareLabel = () => document.getElementById("gameover-share-label");
const shareField = () => document.getElementById("gameover-share-url");
const seedInput = () => document.getElementById("seed-input");

beforeEach(() => {
    resetState();
    resetBuildingIds();
    localStorage.clear();       // the best-run record, not this feature's business
    i18n.currentLocale = "en";
});

describe("the seed pill", () => {
    it("is INVISIBLE in an unseeded run — the game looks exactly as it did", () => {
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(true);
    });

    it("names the active seed during a seeded run", () => {
        STATE.seed = "KYIV";
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(false);
        expect(pillValue().textContent).toBe("KYIV");
    });

    it("is copyable — it is a button wired to the composition root, not decoration", () => {
        expect(pill().tagName).toBe("BUTTON");
        expect(pill().getAttribute("onclick")).toBe("copySeedLink()");
    });

    it("disappears again the moment the run is unseeded", () => {
        STATE.seed = "KYIV";
        tickHud();
        STATE.seed = null;
        tickHud();
        expect(pill().classList.contains("hidden")).toBe(true);
    });
});

describe("the shareable link", () => {
    it("carries the seed as the query the game reads back", () => {
        expect(shareUrl("KYIV")).toMatch(/\?seed=KYIV$/);
    });

    it("drops any seed already on the address bar instead of stacking a second one", () => {
        const url = shareUrl("A1B2C");
        expect(url.match(/\?/g)).toHaveLength(1);
        expect(url.startsWith(window.location.href.split("?")[0])).toBe(true);
    });

    it("is NULL when there is nothing honest to share", () => {
        expect(shareUrl(null)).toBeNull();
        expect(shareUrl("")).toBeNull();
    });
});

describe("the game-over screen", () => {
    it("offers the run to somebody else: the seed, and the link that reproduces it", () => {
        STATE.seed = "KYIV";
        STATE.elapsedGameTime = 252;
        showGameOver("bankrupt");
        expect(shareRow().classList.contains("hidden")).toBe(false);
        expect(shareField().value).toMatch(/\?seed=KYIV$/);
        expect(shareLabel().textContent).toBe("Send this link — the same room, seed KYIV");
    });

    it("shows NOTHING to share after an unseeded run — an empty box would imply there was", () => {
        STATE.elapsedGameTime = 100;
        showGameOver("reputation");
        expect(shareRow().classList.contains("hidden")).toBe(true);
    });

    it("keeps the stats it always had — the link is an addition, not a replacement", () => {
        STATE.seed = "KYIV";
        STATE.elapsedGameTime = 125;
        showGameOver("bankrupt");
        expect(document.getElementById("gameover-stats").textContent).toContain("Survived 2:05");
    });
});

describe("entering a seed", () => {
    it("the menu takes one, capped at the SAME length the token rules cap at", () => {
        expect(seedInput()).not.toBeNull();
        // Pinned to the constant, not to 12: a box that accepts more than
        // normalizeSeed keeps would silently start a different room from the
        // one the player typed.
        expect(seedInput().getAttribute("maxlength")).toBe(String(SEED_MAX_LEN));
    });

    it("a fresh seed is one button away — no URL editing", () => {
        expect(document.querySelector('[onclick="rollSeed()"]')).not.toBeNull();
    });
});

describe("both locales", () => {
    const KEYS = ["seed_label", "seed_placeholder", "seed_hint", "seed_pill_tip", "seed_roll_tip", "seed_copy_tip", "seed_copied", "seed_share"];

    it("carry every seed string — the parity test cannot catch a key missing from BOTH", () => {
        for (const k of KEYS) {
            expect(EN_TRANSLATIONS[k], `en.${k}`).toBeTruthy();
            expect(UK_TRANSLATIONS[k], `uk.${k}`).toBeTruthy();
        }
    });

    it("keep the {seed} placeholder in both, or the player is handed a token-less sentence", () => {
        for (const k of ["seed_copied", "seed_share"]) {
            expect(EN_TRANSLATIONS[k]).toContain("{seed}");
            expect(UK_TRANSLATIONS[k]).toContain("{seed}");
        }
    });

    it("render the share label in Ukrainian too", () => {
        i18n.currentLocale = "uk";
        STATE.seed = "A1B2C";
        showGameOver("bankrupt");
        expect(shareLabel().textContent).toContain("A1B2C");
        expect(shareLabel().textContent).not.toContain("{seed}");
    });
});
