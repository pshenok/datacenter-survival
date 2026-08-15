// The numbers the docs quote about the repo itself.
//
// CONTRIBUTING.md's own first lesson is that hand-written docs drift and
// generated ones cannot. The buildings table, the tariff bands and the
// shaving figures all obey it — they are rendered from CONFIG at display
// time. The counts the docs quote about the CODEBASE were the exception,
// and they drifted four times in a single working session: the test total,
// the level and chapter counts, and twice the number of places the game
// loop is hand-copied into.
//
// Nothing here checks prose. It checks the handful of numbers a reader
// would act on — a contributor who reads "hand-copied into ten test files"
// and greps for ten places will stop looking after ten.
//
// When one of these fails, the fix is the DOC, not the number here: this
// file counts reality, so a failure means reality moved and the sentence
// beside it is now telling a contributor something false.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG } from "../src/core/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const CONTRIBUTING = read("CONTRIBUTING.md");
const ARCHITECTURE = read("docs/ARCHITECTURE.md");
const README = read("README.md");

// Every file that hand-copies game.js's tick order into a local helper. The
// marker is a resolvePower call inside a test: nothing else in the suite
// drives the pipeline by hand.
function tickLoopFiles() {
    const files = [];
    for (const dir of ["tests", "tests/sim"]) {
        for (const name of readdirSync(join(ROOT, dir))) {
            if (!name.endsWith(".test.mjs")) continue;
            const body = read(join(dir, name));
            if (/resolvePower\s*\(/.test(body)) files.push(join(dir, name));
        }
    }
    return files;
}

function tickLoopCopies() {
    let n = 0;
    for (const f of tickLoopFiles()) {
        n += (read(f).match(/resolvePower\(DT/g) || []).length;
    }
    return n;
}

// Every number the doc quotes as "N test files" / "N copies" / "N tests".
const nums = (text, re) => [...text.matchAll(re)].map((m) => Number(m[1]));

describe("the docs' own numbers are still true", () => {
    it("the tick loop is copied into as many test files as CONTRIBUTING claims", () => {
        const real = tickLoopFiles().length;
        const claimed = nums(CONTRIBUTING, /hand-copied into (\d+)\s*\n?test files/g);
        expect(claimed.length).toBeGreaterThan(0);   // the sentence still exists
        for (const c of claimed) expect(c).toBe(real);
    });

    it("ARCHITECTURE quotes the same two numbers, and both are real", () => {
        const files = tickLoopFiles().length;
        const copies = tickLoopCopies();
        const m = ARCHITECTURE.match(/hand-copied into\s*\n?(\d+) test files, (\d+) copies/);
        expect(m, "the tick-order paragraph moved or lost its numbers").not.toBeNull();
        expect(Number(m[1])).toBe(files);
        expect(Number(m[2])).toBe(copies);
    });

    // The README's claim is about levels that are PROVEN — "each proven, by
    // machine-played tests, to be winnable with that mechanic and losable
    // without it". The Lab is a sandbox in its own chapter: it cannot be won,
    // so it is not one of them and counting it would make the sentence false
    // a different way. Level select shows the extra chapter, so the README
    // names it rather than leaving a reader to wonder why six looks like five.
    it("the level and chapter counts in the README are the campaign's own", () => {
        const isSandbox = (id) => Boolean(CONFIG.campaign.levels[id].sandbox);
        const proven = CONFIG.campaign.chapters
            .map((c) => c.levels.filter((id) => !isSandbox(id)))
            .filter((ls) => ls.length > 0);
        const chapters = proven.length;
        const levels = proven.reduce((n, ls) => n + ls.length, 0);
        const words = { 12: "Twelve", 13: "Thirteen", 14: "Fourteen", 15: "Fifteen" };
        const chapterWords = { 4: "four", 5: "five", 6: "six", 7: "seven" };
        expect(words[levels], `no word for ${levels} levels — extend the map`).toBeTruthy();
        expect(README).toContain(`${words[levels]} levels in ${chapterWords[chapters]} chapters`);
        expect(README).toContain(`${words[levels]} campaign levels across ${chapterWords[chapters]} chapters`);
    });

    it("the building count in the README is CONFIG's own", () => {
        const n = Object.keys(CONFIG.buildings).length;
        const words = { 8: "eight", 9: "nine", 10: "ten", 11: "eleven" };
        expect(words[n], `no word for ${n} buildings — extend the map`).toBeTruthy();
        expect(README).toContain(`${words[n]} buildings`);
    });

    // The test total is the one number that changes on almost every commit,
    // so it is quoted in three places and was stale in one of them twice.
    // Counting it from inside the suite is circular; what is checkable is
    // that every place quoting it quotes the SAME number.
    it("every doc that quotes a test total quotes the same one", () => {
        const quoted = [
            ...nums(CONTRIBUTING, /(\d+) tests, about/g),
            ...nums(CONTRIBUTING, /and all (\d+) tests still pass/g),
            ...nums(README, /(\d+) tests\./g),
        ];
        expect(quoted.length).toBeGreaterThanOrEqual(3);
        expect(new Set(quoted).size, `the docs disagree: ${[...new Set(quoted)].join(" vs ")}`).toBe(1);
    });
});
