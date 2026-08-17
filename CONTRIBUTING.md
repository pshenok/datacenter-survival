# Contributing to Datacenter Survival

This is a game with one real requirement: it has to teach something true about
running the physical layer of a datacenter. Fun is necessary but not
sufficient — a mechanic that plays well and models the physics dishonestly is
a bug, and gets filed and fixed like any other. Breakers were added because
"an overloaded link used to clip its subtree proportionally and stay that way
indefinitely, which is the one place the power model was plainly false."

The practical consequence is that most of this document is about proof. The
simulation is pure and headless so it can be machine-played; every campaign
level is played by the test suite in both directions; the loss ledger has to
sum exactly or it is inventing a story about where the player's money went.

**That bar is for mechanics, not for everything.** Typos, a stale comment, a
wrong number in the README, a Ukrainian word that reads like a calque, a
missing keyboard shortcut — those are just PRs, and welcome ones. Nobody will
ask you for a mutation list on a spelling fix. If you are not touching the
simulation, skip to [Sending the PR](#sending-the-pr).

## Run it

No build step: the repo is served raw by GitHub Pages, native ES modules,
Three.js from a CDN as a classic global.

```bash
git clone https://github.com/pshenok/datacenter-survival.git
cd datacenter-survival
python3 -m http.server 8000     # any static server; open http://localhost:8000
```

**It will not run from `file://`.** `index.html` loads
`<script type="module">`, browsers fetch module scripts in CORS mode, and a
`file://` origin is opaque — the whole module graph is blocked. You get the
full HUD over an empty canvas and it looks exactly like a broken repo. It is
not; you loaded it wrong.

The page also needs network on first load: Three.js r128 and Tailwind come
from CDNs (`index.html:7-8`), the Three.js tag SRI-pinned. Offline or behind
an SRI-breaking proxy you get the same blank canvas — except `THREE` is now
*undefined*, the mirror image of the `file://` symptom. Check the network tab
before you check your server.

Tooling is optional and only for contributors:

```bash
npm i
npm run check     # eslint . && vitest run — exactly what CI runs
```

Baseline today: lint clean, 33 test files, 558 tests, about 3 s. CI uses
Node 22. Nothing here downloads a browser: the demo recorder drives your
system Chrome through `playwright-core`, which ships no binaries.

## The invariants, and what breaks when you cross one

Six of these eight are caught by a test in under two seconds, so mostly you
will find out before anyone else does. Two are enforced only by review, and
those are the two that matter most.

| Invariant | What breaks | Caught by |
|---|---|---|
| Every level is winnable with its mechanic and **losable without it** | A level you win by doing nothing ships, and its WIN test certifies it | Review — and it is the review's first question |
| A mechanic ships with a **mutation list** | Tests that pass when the mechanic is broken certify the break | Review |
| The sim layer stays pure | Every node-tier test file fails at import | The whole `unit` project |
| `dt <= 0`, NaN and Infinity are a strict no-op | Pause keeps simulating; one NaN poisons power → heat → money | `power`, `demand`, `crisis`, `contracts` |
| A decided run stops | Contracts pay out and crises fire behind the result modal | `crisis`, `contracts`, `campaign`, `bonuses` |
| `CONFIG` is never written at runtime | Corruption survives `resetState()` into every later run | `crisis` |
| New `STATE` fields are added to `resetState()` too | The field is silently deleted on the first reset | Nothing — a one-way tripwire |
| EN and UK key sets are identical | Red suite | `contracts` |

The long-form version — why each rule exists, the failure it is named after,
and the code that implements it — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read the part that touches your
change before you write it. The five that bite hardest:

**The sim layer is pure.** Nothing under `src/sim/`, `src/core/`,
`src/campaign/` or `src/entities/` may touch `document`, `window`, `THREE`,
timers, or `Math.random`. `localStorage` is the one exception and only behind
a `typeof localStorage === "undefined"` guard — `src/campaign/campaign.js`
persists unlocks that way. Node has no `localStorage` but happy-dom does, so
an unguarded access leaves the `sim` tier green and takes down the node tier
alone. **ESLint will not catch any of this**; it hands every file browser
globals. Run `npm run check`, not `npm run lint`.

**A run can be decided two ways, and they are guarded differently.**
`STATE.gameOver` (bankrupt, reputation floor) is guarded inside the four
schedule-owning ticks. `STATE.campaign.done` is guarded only by
`tickCampaign`. Twelve of thirteen levels resolve as WON rather than as game
over, so a new tick function that checks only `gameOver` keeps simulating
behind the result modal on the *ordinary* path, not the rare one.

**Do not change the tick order.** `tickEvents → tickCrisis → tickDemand →
resolvePower → tickHeat → tickContracts → tickMaintenance → tickCampaign`. It
encodes causality, and nothing asserts it: the loop is hand-copied into 17
test files, so reordering `game.js` leaves the whole suite green while the
shipped game behaves differently. That is the worst failure mode a teaching
game has.

**Randomness is injected** — `tickCrisis(dt, elapsed, rng = Math.random)`.
Never call `Math.random` in a sim module. Schedules use two sentinel values:
`null` means "never drawn yet, draw on the first valid tick", `Infinity` means
"can never fire" (how a campaign level guarantees a deterministic script).

**`resetState()` is hand-maintained.** Add a field to the `STATE` literal and
forget `resetState()` and all 558 tests still pass — the field is silently
deleted on the first reset. Call `resetBuildingIds()` alongside every
`resetState()`, and `resetWireIds()` too if you use `src/sim/build.js`.

## Adding a building

The toolbar and the FAQ iterate `Object.entries(CONFIG.buildings)`, so your
button and your FAQ row appear the moment you add the config entry — whether
or not you did anything else. That is what makes this checklist worth
following in order.

| # | File | What you add | If you skip it |
|---|---|---|---|
| 1 | `src/core/config.js` | `buildings.<type>`: `cost`, `chainRole`, and either `capacityKw` or `drawKw` + `idleDrawKw` + `partLoadExp` | Nothing works |
| 2 | `src/core/config.js` | `colors.<type>` | Silent: white mesh |
| 3 | `src/entities/Building.js` | Per-building fields, each commented with its owning sim module | Silent: `undefined` on tick one |
| 4 | `src/sim/power.js` / `src/sim/heat.js` | The behaviour | Your tests |
| 5 | `src/sim/attribution.js` + `src/core/loss-causes.js` | A branch in `powerCause()` naming the new failure mode, its cause entry, and `loss_<cause>` in both locales | **Silent: the loss lands in `dead_chain` and the ledger mis-teaches** |
| 6 | `src/locales/en.js` | `b_<type>`, `faq_b_<type>`, any `insp_*` strings | Renders the raw key |
| 7 | `src/locales/uk.js` | The same keys, natively written | Red suite |
| 8 | `src/ui/toolbar.js` | `ICONS.<type>` — inline SVG path data | Silent: blank button |
| 9 | `src/ui/meshes.js` | A `case` in `attachMesh` | Silent: grey cube |
| 10 | `src/ui/meshes.js` | State tinting / animation in `tickMeshes` | Silent: the mesh never reflects duty, fuel or heat |
| 11 | `src/ui/hud.js` | Inspector rows | Silent: falls back to `cap N kW` |
| 12 | `tests/` | The mechanic, proven, plus a level that forces the trade-off | Review will ask |

Only step 7 is caught by a test. Skip 2, 8, 9 and 10 and your building ships
as a white box with a blank icon that never moves — visibly broken, silently
green.

Four specifics:

- **`chainRole` must be one of `source`, `link`, `fanout`, `load`.** Wire
  legality is keyed on the role: `{ source: ["link","fanout"], link:
  ["link","fanout"], fanout: ["load"] }`. A fifth role falls through as
  `undefined` and the building can never be wired to anything, in either
  direction. New wiring rules belong in that table, never in an ad-hoc check.
- **Let `sim/power.js` bill it.** Declare `drawKw`, `idleDrawKw` and
  `partLoadExp` and the part-load curve applies automatically. Never restate a
  draw formula in the HUD — the inspector shows the *billed* number on
  purpose, because a recomputed `duty × full` would deny the very mechanic it
  should be exposing.
- **`needsLoop: true` is only half of it.** The chilled-water ratio is applied
  generically, but loop *membership* is not: supply and demand are registered
  by literal type in `src/sim/heat.js` (the `b.type === "chiller"` /
  `b.type === "crah"` branches). A `needsLoop` building missing from the
  demand branch drinks from the loop without loading it, which makes
  over-provisioned cooling free and deletes the `water_loop` lesson. The suite
  stays green — nothing iterates CONFIG looking for the flag.
- **Animated parts are named child meshes.** `attachMesh` sets `.name =
  "fan"` / `"led"` / `"stack"`; `tickMeshes` finds them with
  `getObjectByName`. An unnamed child can never be animated.

## Adding a campaign level

**The contract: every level ships with a machine-played WIN case and at least
one LOSE case, where LOSE is the same room built without the mechanic the
level teaches.** All thirteen levels have their pair today. No meta-test
enforces it, which is exactly why it is the first thing a reviewer asks — a
level with no LOSE case may be a level you win by doing nothing, and its WIN
test will certify it.

In the WIN test, also assert the intended solve is affordable. The harness
places buildings for free, so without that assertion a config retune can leave
a level winnable only by a build the player cannot afford, and the test still
passes.

Register the level in **two** places: `CONFIG.campaign.levels` *and* a
chapter's `levels` array. `levelOrder()` reads the chapters, so a level
defined only under `levels` never appears in level select and no test catches
it.

To play your level before it unlocks, seed progress in devtools:

```js
localStorage.setItem('dc_campaign_done', JSON.stringify(['first_watt']))
localStorage.setItem('dc_tutorial_done', '1')
```

Traps that have already bitten, all silent:

| Trap | What happens |
|---|---|
| Unknown objective `type` | The `switch` has no `default` — `done` never becomes true and the level is permanently unwinnable |
| `money_at_least` as a primary objective | Resolved only once every *other* objective is met. Bonus only |
| Bonus sharing a `type` with a primary | Meeting the primaries ends the level, so the bonus is unreachable by construction |
| Streak objective without `afterSec` | A cold empty room satisfies `no_throttle` and `pue_below` before the scripted crisis lands |
| `serve_kwh` on a resilience level | Counts energy banked before the failure. Use `serve_kwh_during_event`, which lets the LOSE build score provably zero |
| Unknown script `kind` | Silently skipped. The five are `heatwave`, `brownout`, `outage`, `tariff`, `chiller_fail` — a typo produces a level that plays without its crisis, and the WIN test may pass for the wrong reason |
| **No objectives at all** | The level resolves as **WON on tick one**. `tickCampaign`'s sweep starts `allDone = true` and only an unfinished objective clears it, so an empty list is vacuously complete. A level that must not resolve needs `sandbox: true` — see below |

Two flags exist for a level that is not a level. `sandbox: true` makes
`tickCampaign` skip resolution *entirely* — no objective sweep, no
`failConditions` floors, no `endsAt` timeout — and `sim/demand.js` declines
to set `gameOver` while it runs, so the run has no verdict of any kind.
`alwaysUnlocked: true` opts the level out of the unlock chain so it opens on
a fresh profile. The Lab is the only level with either, and it carries both;
`tests/lab.test.mjs` pins the pair, including the rule that an
`alwaysUnlocked` level must never be another level's predecessor in
`levelOrder()` — one that can never be *completed* would gate everything
after it forever.

Six i18n keys per locale: `lv_<id>`, and `_brief`, `_scenario`, `_learn`,
`_tip`, `_tip_fail`.

## Localisation

**Parity is mechanical.** Every string goes into both `src/locales/en.js` and
`src/locales/uk.js` in the same commit; the suite compares sorted key sets.
The inverse trap it cannot catch: forget the key in *both* and the suite stays
green while the player sees the literal `lv_water_loop_tip` in a modal.

**Ukrainian must read as Ukrainian** — not a word-for-word rendering of the
English, and never with russian-influenced vocabulary. Generated uk copy has
been rewritten by hand twice: `Розділ`, not the russian-influenced `Глава`;
`Міський ввід`, not the calque `Ввід мережі`; `руйнує`, not the russism
`рушить`. A calque passes the parity test and still gets reverted.

If you cannot write native Ukrainian, open the PR with the EN string
duplicated into `uk.js` and say so. That is a normal contribution and it will
be picked up. A machine-translated one will not.

Icons in product UI are inline SVG. No emoji.

## Tests

Two tiers, and the directory names are the opposite of what they sound like:

| Project | Directory | Environment | For |
|---|---|---|---|
| `unit` | `tests/*.test.mjs` | `node`, no setup | The simulation |
| `sim` | `tests/sim/*.test.mjs` | `happy-dom` + a THREE stub | Anything importing `src/ui/*` |

Both globs are non-recursive: a test at `tests/anything/foo.test.mjs` matches
neither project, Vitest reports no error, CI stays green, and your tests
simply never run. Helpers must be named `.mjs` — the extension, not the
directory, is what gives them Node globals.

Inside a test: `resetState(); resetBuildingIds();` in `beforeEach`,
`const DT = 0.05` for multi-tick runs, `toBeCloseTo(expected, 9)` for
anything the sim divides proportionally, and pin every random schedule to
`Infinity` so a crisis cannot wander into your window.

Name tests after the lesson, not the code path:

```
it("THE LESSON: two half-loaded units cost more than one full one")
it("LOSE: without a UPS the level scores EXACTLY ZERO — the assertion no total can make")
it("AT ONE RACK the plant's idle draw makes the loop the WORSE deal")
```

**Mutation-test your own tests, and put the list in the commit body.** A test
that passes when the mechanic is broken is worse than no test, because it
certifies the break. Break your mechanic on purpose in every way it could be
wrong and confirm the suite goes red each time. This is what the commit log
already does — "ignoring the loop ratio, zeroing the plant's idle draw,
letting a CRAH cool without a plant, and reverting either of the two
membership rules each turn the suite red" — and a PR that cannot name the
breaks its tests catch has not shown that they catch anything.

## Sending the PR

```bash
git checkout -b feat/your-thing
npm run check
```

CI runs on every pull request: Node 22, `npm ci`, `npm run lint`, `npm test`.
That is the whole gate. The suite is under two seconds, so there is no reason
for a red PR. Commit the lockfile with any dependency change.

Lint enforces almost nothing stylistic — indent, quotes, semicolons and unused
variables all pass. Match the house style by hand: **4-space indent, double
quotes**. Nothing will stop you leaving debug logging in either; check your
diff.

Commit subjects are prefixed `feat:` / `fix:` / `docs:` / `ux:` and state the
player-visible change, not the code change:

```
feat: chilled-water loop — chillers, CRAHs, and Chapter 4 (#5)
feat: breakers — real gear opens instead of dimming forever
fix: uk — chapter is Розділ, not the russian-influenced Глава
```

The body explains **why** — what is already in the diff. Say what the mechanic
teaches, what you mutation-tested, and what you decided against. If your
change makes the simulation model something differently, say what was wrong
with the old model.

Update `README.md` if you change a mechanic, a control, or a count. Its
numbers are hand-written and have drifted before.

### What comes back

- A mechanic that plays well and models the physics falsely.
- A level without its LOSE case.
- A mechanic with no mutation list.
- A CONFIG retune to "balance" one level. Every level is proven against shared
  CONFIG values — `crac.idleDrawKw` underpins both `the_bill` and
  `over_cooled`, `pdu.capacityKw` is the entirety of `one_bus`. A single-number
  tweak can flip a LOSE case into a WIN and quietly delete a lesson. If a
  retune is genuinely right, re-run the pairs and say so.
- Mechanics already declined, listed under "Explicitly dropped" in issue
  [#5](https://github.com/pshenok/datacenter-survival/issues/5). Propose in
  Discussions first if you want to reopen one.

## Where to talk

| Where | For |
|---|---|
| [Discussions → Q&A](https://github.com/pshenok/datacenter-survival/discussions/categories/q-a) | Stuck on the sim model, the tick order, a test that will not go red |
| [Discussions → Ideas](https://github.com/pshenok/datacenter-survival/discussions/categories/ideas) | Proposing a mechanic. Lead with what it teaches and how a level would prove it losable without it |
| [Discussions → Show and tell](https://github.com/pshenok/datacenter-survival/discussions/categories/show-and-tell) | Screenshots, runs, levels you built, PUE numbers you are proud of |
| [Issues](https://github.com/pshenok/datacenter-survival/issues) | Bugs, and scoped work you intend to do |

Discussions are new here, so starting a thread is welcome rather than noise.
Open an issue before a large change so the scope can be agreed; small fixes
can go straight to a PR.

Looking for somewhere to start? Everything tagged
[good first issue](https://github.com/pshenok/datacenter-survival/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
is a real, verified gap with the fix already located.

## Licensing

**MIT**, the same as [Server Survival](https://github.com/pshenok/server-survival)
— see [LICENSE](LICENSE). By opening a pull request you are offering your
contribution under those terms.

`package.json` keeps `"private": true`, which is about npm and not about
rights: it stops the dev-tooling manifest being published as a package by
accident. The game itself is MIT and always served straight from the repo.
