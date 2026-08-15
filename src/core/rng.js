// Seeded runs: the pseudo-random generator, the seed token rules, and the
// per-run streams. Pure module — no DOM, no THREE, no timers, and NO
// Math.random: the one place entropy could enter is randomSeedToken(), which
// takes its randomness as an argument so the composition root (game.js) owns
// that call, exactly as it owns every other window-facing decision.
//
// This module knows nothing about URLs. game.js reads `?seed=` off
// location.search and hands the raw string to normalizeSeed(); src/ui/hud.js
// builds the shareable link. A sim module's business is the stream, not the
// address bar.
//
// WHY a hand-written generator. tickCrisis and tickContracts already take an
// injected rng because the campaign proofs need determinism — the only thing
// missing was something to inject. mulberry32 is ~6 lines, has a full 2^32
// period, passes gjrand's basic suite, and adds no dependency to a repo that
// deliberately has no build step.

// Crockford base32 minus the confusables: no I, L, O (misread as 1, 1, 0)
// and no U (so a generated seed cannot spell something unfortunate). A seed
// read aloud over a call has exactly one spelling.
const SEED_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Five characters = 32^5 ≈ 33.5 million rooms. Short enough to say out loud,
// wide enough that two players comparing runs are comparing the same one.
export const SEED_LENGTH = 5;

// A player may type a word instead ("KYIV", "PUE119"). Capped so the pill
// stays a pill; the cap is applied BEFORE hashing and before display, so the
// token shown is always exactly the token that ran.
export const SEED_MAX_LEN = 12;

// mulberry32 — 32-bit state, one multiply-xorshift round per draw. Returns
// [0, 1), the Math.random contract every consumer here already assumes.
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// FNV-1a, 32-bit. Turns a seed token into a state word; the salt is what
// makes two streams out of one seed (see seededRngs).
function hash32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// The token rules, in one place: uppercase, [0-9A-Z] only, capped.
// Idempotent by construction — normalizeSeed(normalizeSeed(x)) === the same
// token — which is what lets the pill, the share link and the URL round-trip
// without any of them being a special case. Anything that normalizes to
// nothing (null, "", "!!!") is NOT a seeded run.
export function normalizeSeed(raw) {
    if (typeof raw !== "string") return null;
    const token = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, SEED_MAX_LEN);
    return token.length > 0 ? token : null;
}

// A fresh seed. `pick` supplies the entropy (game.js passes Math.random) —
// this module stays pure and this function stays testable.
export function randomSeedToken(pick) {
    let out = "";
    for (let i = 0; i < SEED_LENGTH; i++) {
        const r = pick();
        const unit = Number.isFinite(r) ? Math.abs(r) % 1 : 0;
        out += SEED_ALPHABET[Math.min(SEED_ALPHABET.length - 1, Math.floor(unit * SEED_ALPHABET.length))];
    }
    return out;
}

// The run's streams, or null when there is no seed — the caller then leaves
// each tick function on its own Math.random default, which is what makes an
// unseeded run byte-for-byte the game that shipped before seeds existed.
//
// TWO streams, not one, and the salt is what separates them. Sharing a
// single generator between crisis and contracts would make each subsystem's
// sequence depend on how many draws the OTHER one happened to take, so
// adding a crisis event later would silently re-roll every contract of every
// existing seed. Independent streams keep a seed's meaning stable per
// subsystem; tests/seeded-run.test.mjs pins that independence directly.
export function seededRngs(seed) {
    const token = normalizeSeed(seed);
    if (token === null) return null;
    return {
        seed: token,
        crisis: mulberry32(hash32("crisis:" + token)),
        contracts: mulberry32(hash32("contracts:" + token)),
    };
}
