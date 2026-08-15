# Architecture

The invariants behind [CONTRIBUTING.md](../CONTRIBUTING.md), each with the
failure it is named after. Read the section that touches your change.

The shape of the codebase: `src/core/` holds CONFIG and STATE, `src/sim/`
holds the physics, `src/campaign/` holds levels and progression, `src/ui/`
draws, `src/input/` handles clicks, and `game.js` is the composition root that
owns the loop. Everything below `src/ui/` is pure and headless on purpose —
that is what makes the game machine-playable, and machine-playability is what
lets every campaign level be *proven* to teach something.

## The tick order

```
elapsedGameTime += dt          (skipped while the tutorial is active)
  → tickEvents                 heatwave, tariff, grid outage windows
  → tickCrisis                 brownout must precede power
  → tickDemand                 assignment, SLA, money
  → resolvePower               the wired chain resolves
  → tickHeat                   heat responds to actual draw
  → tickContracts              judged on THIS tick's facts
  → tickMaintenance            work-order windows and deadlines
  → tickCampaign               scripted events + objectives, judged last
```

The order encodes causality. Nothing asserts it: the loop is hand-copied into
nine test helpers (eleven copies, counting the second inline one in
`tests/campaign.test.mjs` and `tests/prebuilt.test.mjs`), so reordering
`game.js` leaves the whole suite green while the shipped game behaves
differently.

Three consequences, none of which are bugs:

**The one-tick lag.** `STATE.servedKw` pairs this tick's `assignedKw` with
last tick's `actualKw` and `throttleFactor`; the power bill uses last tick's
`STATE.totalDrawKw`; a cooling duty written by `heat.js` becomes a power
request only on the next tick. `tests/campaign.test.mjs` budgets an explicit
`lagBound` rather than asserting zero. "Fixing" the lag by reading fresh
values breaks the campaign objective bounds and the attribution conservation
identity.

**`chainAlive()` is topology-only.** It walks `parentId`s and checks
`isDeadGear`, `parentId === "grid"`, `chainRole`, UPS `bufferLeft` and
`standbyParentId` — never last tick's `powered` flag. Assignment runs *before*
power resolution, so a `powered`-based check deadlocks a freshly wired rack
forever and starves a UPS subtree so its buffer never carries anything. Both
are shipped bugs that `tests/integration.test.mjs` exists to prevent.

`isDeadGear` is checked FIRST, before the `"grid"` branch. A source (a
`grid_feed` or a `generator`, the only nodes with `parentId === "grid"`) is
dead gear too the moment it is tripped or out for service, and only a node
that passes the `isDeadGear` check reaches the branch that applies the
generator's `fuelLiters` rule or `feedIsDark`. Before scheduled maintenance
widened `isDeadGear` past breakers, only `link`/`fanout` roles could ever
trip, so a dead SOURCE reaching this function was unreachable and the
ordering did not matter; out-for-service made it reachable, and a fix moved
the check ahead of the `"grid"` branch in both `chainAlive` here and
`primaryPathDead` in `power.js` — a serviced grid feed or generator now reads
as a dead root exactly like a tripped one.

The `isDeadGear` check sits on **opposite sides of the UPS clause** in the two
modules, and both are deliberate:

- `demand.js` — *before* the UPS clause: "or a tripped UPS would still read as
  live and reintroduce the starvation bug pinned in tests/integration.test.mjs"
- `power.js` — *after* the UPS clause: "so a tripped UPS cannot self-grant
  from its buffer either"

Both encode the same physics: an open breaker is dead gear, and a UPS behind
its own open breaker is dead too. Both sites now call the shared
`isDeadGear(b)` predicate exported from `power.js`, so a new dead-gear
condition is added once rather than placed twice — placing it by hand is how
one copy ends up on the wrong side.

**Sim modules never read `STATE.timeScale`.** `dt` arrives already scaled by
`game.js`. Only the UI layer reads it directly.

## Stopping

Two guards, for two different things.

**`dt`.** Every exported tick function opens with:

```js
if (!Number.isFinite(dt) || dt <= 0) return;
```

`dt === 0` is the pause key. A leaky guard drains UPS buffers, advances event
schedules and charges the power bill while the player is paused. A single NaN
propagates power → heat → money until the whole HUD reads NaN with no clue
where it started. `tests/power.test.mjs` pins `0`, NaN, negative, `-0` and
`Infinity` explicitly.

*Known divergence:* `src/sim/heat.js` guards with `if (dt === 0) return;`
instead. `tickHeat(NaN)` poisons the entire heat field and `tickHeat(-1)` runs
the physics backwards; only `game.js`'s `Math.min(0.1, …)` clamp protects it
today. Aligning it is a good first issue — do not copy the pattern into new
code.

**A decided run.** There are two flags and they are guarded differently.

`STATE.gameOver` (bankrupt, reputation floor) is guarded inside the four
schedule-owning ticks — `tickDemand`, `tickEvents`, `tickCrisis`,
`tickContracts` — which take `|| STATE.gameOver !== null` on top of the `dt`
guard. `resolvePower` and `tickHeat` deliberately do not. The reason is
narrower than it looks: `tickDemand` sets `gameOver` *in the middle of a
tick*, and everything after it still runs in that same tick before `game.js`
sets `timeScale = 0` at the bottom. So the guard buys one tick in the shipped
game — and every tick in the test suite, whose hand-copied loops have no
`timeScale` to fall back on. Without it, a bankrupt run still pays out a
contract and fires a crisis on the way down.

`STATE.campaign.done` is guarded only by `tickCampaign`, which returns before
its own `dt` check; the freeze reaches everything else through the callback
`game.js` hands to the campaign UI. Twelve of thirteen levels resolve as WON
rather than as game over, so a new tick function that checks only `gameOver`
keeps simulating behind the result modal on the *ordinary* path.

## CONFIG is read-only at runtime

Model temporary effects as multipliers over CONFIG values held in `STATE`,
never by writing back. The brownout is the reference implementation:
`src/sim/power.js` computes an effective capacity as
`cap *= sanitize(STATE.brownout.factor, 0, 1)`, and `tests/crisis.test.mjs`
asserts `CONFIG.buildings.grid_feed.capacityKw` is still 40 after the brownout
resolves.

CONFIG is not frozen, so nothing stops you mechanically. A written-back
multiplier survives `resetState()` — which does not touch CONFIG — and
silently corrupts every subsequent run and every subsequent test in the file.
If a test genuinely must mutate CONFIG, restore it in a `finally` in the same
test; one test in the suite does exactly that and it is the only one.

CONFIG is also the documentation. The toolbar and the FAQ's building table are
*generated* from `Object.entries(CONFIG.buildings)` at render time, so a cost
or a capacity in the docs cannot drift from the one the simulation uses. Do
not hand-write a number that CONFIG already holds.

## resetState()

Any new field on the `STATE` literal must be added to `resetState()` by hand,
and any new mutable container must be **replaced** with a fresh instance
there, not cleared in place.

The tripwire fires in one direction only. Add a field to the STATE literal and
forget `resetState()` and the whole suite passes — the field is silently
deleted on the first reset, because `resetState` assigns fresh literals rather
than patching. Add it to *both* and `tests/crisis.test.mjs`'s "resetState
clears every crisis and contract field back to virgin" fails, because it uses
strict `toEqual` against exact literals; update that test in the same commit.

Building ids are a module-scope counter that `resetState()` cannot see. Call
`resetBuildingIds()` alongside every `resetState()`, plus `resetWireIds()` if
you use `src/sim/build.js`. Without the pair, ids climb across runs and any
test asserting on a specific id becomes order-dependent.

## Determinism

```js
export function tickCrisis(dt, elapsed, rng = Math.random)
```

Every draw funnels through the injected `rng`. Never call `Math.random` in a
sim module, never store an rng in `STATE`. This is the only reason crisis and
contract behaviour is reproducible; tests supply `() => 0` or a seeded LCG.

Schedules use two sentinel values, and the distinction is load-bearing:

- `null` — never drawn yet; the first valid tick draws it from the rng. This
  is what keeps `Math.random` out of module and state scope.
- `Infinity` — can never fire. `startLevelState` pins every random schedule to
  it, which is how a campaign level guarantees a deterministic script.

Never initialise a schedule with a concrete number in `state.js`. In any test
that must not be perturbed, pin all of them in `beforeEach` — leave one
unpinned and a long-running test goes flaky the moment its window opens.

### What a seed guarantees, and what it does not

A seed pins the run's **content**, exactly: which crisis fires, how far into
game time (`STATE.elapsedGameTime`, not wall-clock), how long it lasts, which
contract is offered, and what its target is. Every value `runRng.crisis` /
`runRng.contracts` produce is identical, to twelve significant digits, between
two loads of the same token — `tests/sim/seed-wiring.test.mjs` drives the
shipped `game.js` loop (not a hand-copied one) to prove it.

It does **not** pin the run's absolute wall-clock anchor. A schedule is
`elapsed + span(rng)`, and `elapsed` at the first draw is whatever
`STATE.elapsedGameTime` has accumulated to by then — which starts from the
first real frame's `dt` in `animate()`'s `rawDt = Math.min(0.1, (time -
lastTime) / 1000 || 0)`. Two players on the same seed do not press Play at
the same point in a frame, and then integrate at whatever refresh rate their
machine gives them, so the run's clock is anchored a frame-timing's worth
apart between them; the *durations* drawn from the seed ride unchanged on
top of wherever that anchor lands. Measured directly, at 30/60/144 Hz, the
first brownout in a fixed `KYIV` run fires at `elapsed` 159.867 s / 159.850 s
/ 159.826 s — a **41 ms** spread across ordinary refresh rates, growing to
**83 ms** when the very first unpaused frame is itself slow enough to hit the
`Math.min(0.1, …)` clamp (a stalled or backgrounded tab, not merely a
different monitor). Two to three orders of magnitude past an early estimate
of "about 0.1 ms" — this is frame-timing jitter, not a sub-millisecond
scheduler tick, and the corrected figures belong here rather than only in a
build report nobody after this PR will read.

Collapsing the anchor — e.g. dating every first draw from `elapsed = 0`
regardless of when Play was pressed — would change the sim's scheduling
semantics for every run, seeded or not, which is exactly the kind of change
the campaign proofs exist to catch. Left alone on purpose: the player-facing
promise is same seed, same crisis, same contract, same target, and that
holds regardless of frame rate.

## The UI boundary

`src/core/state.js` puts it plainly: sim modules mutate exactly the fields
they own; UI reads everything and writes nothing. The only sim-record field
the UI owns is `mesh`. `src/input/handlers.js` is bound by the same rule — it
calls into `src/sim/*` for every mutation and does mesh and banner work
itself, nothing more.

The reason is that the whole suite runs headless without the UI layer loaded.
A UI write to STATE is invisible to every test and surfaces only as a
divergence between what a player sees and what the tests prove. A placement
rule implemented in a click handler is untestable and will disagree with
`applyPreBuilt`, which builds campaign levels through the same sim API.

Panels built with `innerHTML` must survive a mid-game locale switch by exactly
one of three mechanisms: re-rendered every frame, `data-i18n` on their
generated nodes, or a `localeChanged` listener. Panels using none of the three
go stale until reopened.

## The standard of proof

Two patterns in the suite are the bar.

**Conservation.** `tests/attribution.test.mjs` asserts the per-cause loss
buckets sum to `missedKw` to nine decimals across every tick of a run that
drives a brownout, a grid outage, thermal throttle and an over-subscribed PDU
— and additionally asserts the run really did lose work, so the identity
cannot be satisfied by losing nothing. Attribution that does not add up
invents a story about where the player's money went.

**Inertness.** The same file runs the sim twice, scrambling every cause bucket
and pushing nonsense blame rows after each of 2400 ticks, then asserts money,
`servedKw`, reputation, `itDrawKw`, `totalDrawKw` and the whole heat field are
identical with `toBe`. Any purely diagnostic layer you add owes the same test:
if anything ever reads the ledger back, the diagnosis becomes physics and the
ledger starts explaining itself.

**Mutation testing** is the check on your own tests. Break the mechanic on
purpose in every way it could be wrong, confirm the suite goes red each time,
and put the list in the commit body. Both feature commits in the log do it.

## The campaign contract

Every level is machine-provably winnable with the mechanic it teaches and
losable without it — the same room, built without the mechanic, played by the
test suite, scoring provably short. All thirteen levels have their pair, in
`tests/campaign.test.mjs`, `tests/generator.test.mjs` and
`tests/prebuilt.test.mjs`.

For a resilience level, `serve_kwh` is the wrong objective: it counts energy
banked before the failure, so the naive build merely falls short.
`serve_kwh_during_event` gates the accumulator to the crisis window, which
lets the LOSE build score **exactly zero** — the assertion no total can make,
and the difference between a level that is hard and a level that is a lesson.

`preBuilt` topology is `{ buildings, wires, standby }` with indices into the
buildings array. `applyPreBuilt` *throws* on a rejected placement, so an
off-grid or doubled-up tile is a hard crash at level launch —
`tests/prebuilt.test.mjs` loops every level's geometry, so you get that one
for free. Prebuilt scenery is placed with `{ free: true }`, which bypasses both
the money check and the level's `banned` list; that is deliberate, and it is
how a level can ban a building type while starting you with one.

If you add a scripted event kind that leaves STATE latched, clear it when the
level resolves — `startLevelState` pins every random schedule to `Infinity`,
so nothing else will ever end an active window and the grid stays dead behind
the result modal.

## Persistence

All of it is localStorage, all of it `typeof`-guarded so the node tier can
import these modules headless:

| Key | Holds |
|---|---|
| `dc_campaign_done` | Completed level ids — what `isLevelUnlocked()` reads |
| `dc_campaign_bonus` | Bonus objectives earned, keyed by bonus `id` |
| `dc_tutorial_done` | Tutorial completion |
| `dc_locale` | Selected language |
| `dc_best_run` | Best time, peak served kW, best PUE |

Clear them to test a first-run experience; seed them to reach a level without
playing eleven others.
