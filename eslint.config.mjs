import js from "@eslint/js";
import globals from "globals";

// Lint for the native-ESM codebase (#155 PR 2 of 10).
//
// Every first-party file is now a real ES module with explicit imports, so
// no-undef is ON: any bare identifier that isn't imported or a known browser
// global is an error. THREE stays a classic CDN global (r128), so it is
// declared here instead of imported.
//
// no-unused-vars is ON. It was parked "until the split PRs land"; they have,
// and turning it on surfaced exactly three dead imports across 29 test files
// and 30 modules — cheap to keep honest, and the rule that catches a
// half-finished refactor before review does.
export default [
  {
    ignores: ["node_modules/**", "assets/**", "market/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        THREE: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Node-side tooling: the headless test suite and the demo recorder.
    files: ["tests/**/*.mjs", "tools/**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
];
