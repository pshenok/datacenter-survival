## What this changes

<!-- The player-visible change, and why. What the mechanic teaches, or what was wrong before. -->

## How it is proven

<!-- Which tests, and what they would catch. For a mechanic: the mutation list — the ways you broke
     it on purpose to confirm the suite goes red. See CONTRIBUTING.md. -->

## Checklist

- [ ] `npm run check` passes (lint + the full suite)
- [ ] Touching the sim? No DOM, THREE, timers or `Math.random` in `src/sim`, `src/core`, `src/campaign`, `src/entities`
- [ ] New tick function? It no-ops on `dt <= 0`, NaN and Infinity
- [ ] New `STATE` field? Added to `resetState()` as well
- [ ] No `CONFIG` written at runtime — temporary effects are multipliers held in `STATE`
- [ ] New user-facing string? In **both** `en.js` and `uk.js`
- [ ] New or changed level? Machine-played WIN **and** LOSE cases in the suite
- [ ] New building? Walked the checklist in CONTRIBUTING.md, including `attribution.js` if it can fail
- [ ] README updated if a mechanic, control or count changed
