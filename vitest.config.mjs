import { defineConfig } from "vitest/config";

// Two tiers (#155 PR 10):
//   unit — pure-logic tests that import leaf modules with no DOM/THREE needs
//          (locales, config, levels, i18n usage, campaign objectives).
//   sim  — headless simulation tests over the REAL game modules. game.js's
//          module graph touches THREE and the index.html DOM at eval time, so
//          this project runs under happy-dom with a THREE stub + HTML fixture
//          installed by tests/helpers/sim-setup.mjs BEFORE any game import.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/*.test.mjs"],
        },
      },
      {
        test: {
          name: "sim",
          environment: "happy-dom",
          include: ["tests/sim/*.test.mjs"],
          setupFiles: ["tests/helpers/sim-setup.mjs"],
          // These tests PLAY the game — the economics pair below runs four
          // full timed sessions and takes ~2.3 s on an idle machine and over
          // 5 s when the rest of the suite is running beside it. Vitest's
          // default is 5 s, which is a default and not a budget anyone chose
          // for a suite like this, so the slowest honest test sat a busy CI
          // runner away from a spurious red. 20 s still catches a genuine
          // hang, which is the only thing a timeout is for here: nothing in
          // these tests waits on IO, a timer or a clock.
          testTimeout: 20000,
        },
      },
    ],
  },
});
