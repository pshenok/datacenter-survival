# Concurrent Maintainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled maintenance work orders so a campaign level can prove the Tier III lesson — a facility is only redundant if any element can be taken out of service without dropping load.

**Architecture:** Gear out for service behaves as dead gear, identical to an open breaker. Rather than adding a second flag at the two places that check `tripped` (which sit on deliberately opposite sides of the UPS clause), a shared `isDeadGear()` predicate is substituted at exactly those positions. A new pure module `src/sim/maintenance.js` owns work-order state; the player opens a window by clicking the target with the select tool, against a deadline. A new objective type can fail a level, which the campaign engine cannot currently express.

**Tech Stack:** Native ES modules, no build step. Vitest (node tier), ESLint. Three.js r128 as a CDN global in the UI layer only.

**Spec:** `docs/superpowers/specs/2026-08-05-concurrent-maintainability-design.md`
**Issue:** [#17](https://github.com/pshenok/datacenter-survival/issues/17)

## Global Constraints

- Sim modules (`src/sim/`, `src/core/`, `src/campaign/`, `src/entities/`) are pure: no DOM, no `THREE`, no timers, no `Math.random`. `localStorage` only behind `typeof localStorage === "undefined"`.
- Every exported tick function opens with `if (!Number.isFinite(dt) || dt <= 0) return;`.
- `CONFIG` is never written at runtime. Temporary effects are multipliers held in `STATE`.
- Every new `STATE` field must be added to `resetState()` as a fresh literal.
- Every new user-facing string goes into **both** `src/locales/en.js` and `src/locales/uk.js` in the same commit. Ukrainian must read natively, never as a calque.
- House style: 4-space indent, double quotes. `npm run check` (ESLint + Vitest) must be green before every commit.
- Baseline before this plan: **272 tests, 16 files, all green.**
- Test conventions: `resetState(); resetBuildingIds();` in `beforeEach`, `const DT = 0.05;`, pin all six random schedules to `Infinity`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/sim/power.js` (modify) | Export `isDeadGear(b)`; substitute at the two `tripped` sites it owns |
| `src/sim/demand.js` (modify) | Substitute `isDeadGear` at the `chainAlive` site |
| `src/entities/Building.js` (modify) | `outForService`, `serviceLeftSec` fields |
| `src/sim/maintenance.js` (create) | Work-order state machine: init, tick, open a window |
| `src/core/state.js` (modify) | `STATE.maintenance` + `resetState` |
| `src/core/loss-causes.js` (modify) | `maintenance` cause |
| `src/sim/attribution.js` (modify) | `powerCause` branch naming planned work |
| `src/campaign/campaign.js` (modify) | `maintenance_without_loss` objective; objective-driven failure; init orders on level start |
| `src/core/config.js` (modify) | Chapter 5 + `night_shift` level |
| `src/input/handlers.js` (modify) | Select-click opens a pending window |
| `src/ui/hud.js` (modify) | Work-order line + inspect rows |
| `src/ui/meshes.js` (modify) | Out-for-service tint, distinct from tripped |
| `index.html` (modify) | `#maintenance-line` element |
| `src/locales/{en,uk}.js` (modify) | All new strings |
| `tests/maintenance.test.mjs` (create) | The mechanic |
| `tests/prebuilt.test.mjs` (modify) | The three machine-played cases |
| `docs/ARCHITECTURE.md` (modify) | Record the dead-gear predicate |

---

### Task 1: The shared dead-gear predicate

A pure refactor with **zero behaviour change**. Its whole value is that the
next task can add a second dead-gear condition in one place instead of two,
without having to re-derive which side of the UPS clause each site sits on.

**Files:**
- Modify: `src/sim/power.js` (add export; substitute at lines ~149 and ~268)
- Modify: `src/sim/demand.js` (substitute at line ~151)
- Modify: `docs/ARCHITECTURE.md`
- Test: existing `tests/power.test.mjs`, `tests/demand.test.mjs`, `tests/integration.test.mjs`, `tests/breaker.test.mjs` are the test — they must stay green

**Interfaces:**
- Consumes: nothing
- Produces: `isDeadGear(building) => boolean`, exported from `src/sim/power.js`

- [ ] **Step 1: Confirm the baseline is green before touching anything**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: lint clean, `Tests  272 passed (272)`. If it is not 272, stop and report — the rest of this plan measures against that number.

- [ ] **Step 2: Add the predicate to `src/sim/power.js`**

Insert immediately after the `feedIsDark` function (around line 129):

```js
// Gear that is not passing power, whatever the reason. Today: an open
// breaker, or an open service window (sim/maintenance.js).
//
// This exists as one predicate because its two call sites sit on DELIBERATELY
// opposite sides of the UPS clause — before it in demand.js's chainAlive, so
// a tripped UPS cannot read as live and reintroduce the starvation bug pinned
// in tests/integration.test.mjs; after it in deliver(), so a tripped UPS
// cannot self-grant from its own buffer. Adding a second condition at each
// site by hand is how one of them ends up on the wrong side.
export function isDeadGear(b) {
    return b.tripped || b.outForService;
}
```

- [ ] **Step 3: Substitute at the two sites power.js owns**

In `primaryPathDead`, replace:

```js
        if (node.tripped) return true;
```

with:

```js
        if (isDeadGear(node)) return true;
```

In `deliver`, replace:

```js
        if (b.tripped) {
            outLive = false;
            outKw = 0;
        }
```

with:

```js
        if (isDeadGear(b)) {
            outLive = false;
            outKw = 0;
        }
```

Leave `if (b.tripped) cap = 0;` in `pullOf` and the breaker block at the
bottom alone — those are about the breaker specifically, not about dead gear.
Capacity clipping and trip accumulation are breaker mechanics; service does
not accrue breaker heat.

- [ ] **Step 4: Substitute the site demand.js owns**

Add to the import at the top of `src/sim/demand.js`:

```js
import { feedIsDark, isDeadGear } from "./power.js";
```

In `chainAlive`, replace:

```js
        if (node.tripped) return false;
```

with:

```js
        if (isDeadGear(node)) return false;
```

Keep the existing comment above it — it explains the ordering and is still true.

- [ ] **Step 5: Run the suite to prove the substitution changed nothing**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: `Tests  272 passed (272)`. `outForService` is `undefined` on every
building until Task 2, so `b.tripped || undefined` is falsy exactly where
`b.tripped` was — behaviour is bit-identical. A single failure here means the
predicate landed on the wrong side of a UPS clause; revert and re-read Step 3.

- [ ] **Step 6: Record the predicate in ARCHITECTURE.md**

In `docs/ARCHITECTURE.md`, in the "The tick order" section, replace the two
bullet points describing the opposite-sides rule with:

```markdown
The `tripped` check sits on **opposite sides of the UPS clause** in the two
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
```

- [ ] **Step 7: Commit**

```bash
cd /Users/kp/Projects/my/datacenter-survival
git add src/sim/power.js src/sim/demand.js docs/ARCHITECTURE.md
git commit -m "refactor: one predicate for gear that is not passing power

The tripped check sits on deliberately opposite sides of the UPS clause
in demand.js and power.js, and the reason lives only in two comments.
The next dead-gear condition would have to be placed twice, by hand,
against a rule nothing enforces.

isDeadGear() makes it one substitution instead of two placements.
Behaviour is bit-identical: outForService is undefined everywhere until
service windows land, so the predicate is exactly b.tripped today. The
272 tests staying green is the evidence it went to the right places."
```

---

### Task 2: Service windows

**Files:**
- Modify: `src/entities/Building.js`
- Modify: `src/core/state.js`
- Create: `src/sim/maintenance.js`
- Create: `tests/maintenance.test.mjs`

**Interfaces:**
- Consumes: `isDeadGear` (Task 1)
- Produces:
  - `initMaintenance(orders, buildings)` — builds `STATE.maintenance.orders` from a level's declared orders; throws on an unresolvable target
  - `tickMaintenance(dt, elapsed)` — counts windows down, marks orders `missed`
  - `openServiceWindow(building, elapsed) => boolean` — true if a pending order was opened
  - `pendingOrderFor(building) => order | null`
  - `activeOrderCount() => number`

- [ ] **Step 1: Add the Building fields**

In `src/entities/Building.js`, immediately after the breaker block
(`this.tripped = false;`):

```js
        // Planned maintenance (owned by sim/maintenance.js). Out-for-service
        // gear is dead gear — see isDeadGear() in sim/power.js — but it is
        // NOT a fault: no breaker heat accrues and the ledger names it as
        // planned work.
        this.outForService = false;
        this.serviceLeftSec = 0;
```

- [ ] **Step 2: Add the state and sever it in resetState**

In `src/core/state.js`, after the `tariff` block:

```js
    // Scheduled work orders (owned by sim/maintenance.js). Empty outside the
    // levels that declare them, which is what keeps the mechanic invisible
    // everywhere it is not being taught.
    maintenance: { orders: [] },
```

In `resetState()`:

```js
    STATE.maintenance = { orders: [] };
```

- [ ] **Step 3: Write the failing test**

Create `tests/maintenance.test.mjs`:

```js
// Scheduled maintenance — the Tier III mechanic.
//
// A work order is a promise the facility makes: this element WILL be out of
// service for this long, before this deadline. The tests pin the three things
// that makes true — the window really kills the gear, the deadline really
// expires, and a room that never declares an order never notices any of it.
import { describe, it, expect, beforeEach } from "vitest";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower, isDeadGear } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import {
    initMaintenance, tickMaintenance, openServiceWindow,
    pendingOrderFor, activeOrderCount,
} from "../src/sim/maintenance.js";

const DT = 0.05;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// Feed -> transformer -> pdu -> rack, plus a cooling unit so the room is real.
function room() {
    STATE.demandFixedKw = 6;
    const f = place("grid_feed", 2, 5);
    const x = place("transformer", 5, 5);
    const p = place("pdu", 8, 5);
    wireBuildings(f, x);
    wireBuildings(x, p);
    const r = place("rack", 12, 5);
    wireBuildings(p, r);
    wireBuildings(p, place("crac", 13, 5));
    return { f, x, p, r };
}

function run(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
        tickMaintenance(DT, t);
    }
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
});

describe("a work order is a promise with a deadline", () => {
    it("resolves declared targets to real buildings", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 30, bySec: 90 }], STATE.buildings);
        expect(STATE.maintenance.orders.length).toBe(1);
        expect(STATE.maintenance.orders[0].buildingId).toBe(p.id);
        expect(STATE.maintenance.orders[0].state).toBe("pending");
        expect(pendingOrderFor(p)).not.toBeNull();
    });

    it("THROWS on a target that resolves to nothing — an order pointing at no gear is an unwinnable level", () => {
        room();
        expect(() => initMaintenance([{ target: 99, durationSec: 30, bySec: 90 }], STATE.buildings))
            .toThrow();
    });

    it("opening a window kills the gear, and the subtree with it", () => {
        const { p, r } = room();
        initMaintenance([{ target: 2, durationSec: 30, bySec: 90 }], STATE.buildings);
        run(20);
        expect(r.powered).toBe(true);

        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(true);
        expect(isDeadGear(p)).toBe(true);
        expect(activeOrderCount()).toBe(1);
        run(5);
        expect(r.powered).toBe(false);
        expect(STATE.servedKw).toBeLessThan(0.01);
    });

    it("closes itself when the window runs out, and the room comes back", () => {
        const { p, r } = room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 90 }], STATE.buildings);
        run(5);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(11);
        expect(p.outForService).toBe(false);
        expect(STATE.maintenance.orders[0].state).toBe("done");
        expect(activeOrderCount()).toBe(0);
        run(5);
        expect(r.powered).toBe(true);
    });

    it("accrues no breaker heat while out for service — this is not a fault", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(5);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(10);
        expect(p.breakerHeat).toBe(0);
        expect(p.tripped).toBe(false);
    });

    it("misses an order whose deadline passes while it is still pending — and missed is terminal", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 30 }], STATE.buildings);
        run(35);
        expect(STATE.maintenance.orders[0].state).toBe("missed");
        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(false);
        run(10);
        expect(STATE.maintenance.orders[0].state).toBe("missed");
        expect(p.outForService).toBe(false);
    });

    it("does not miss an order that was opened before the deadline but runs past it", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 30 }], STATE.buildings);
        run(25);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(25);
        expect(STATE.maintenance.orders[0].state).toBe("done");
    });

    it("refuses to open a second window on the same order", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        openServiceWindow(p, STATE.elapsedGameTime);
        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(false);
        expect(activeOrderCount()).toBe(1);
    });

    it("refuses gear with no order at all", () => {
        const { x } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        expect(openServiceWindow(x, STATE.elapsedGameTime)).toBe(false);
        expect(x.outForService).toBe(false);
    });
});

describe("the pure-module contract", () => {
    it("no-ops on dt <= 0, NaN and Infinity", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 90 }], STATE.buildings);
        openServiceWindow(p, 0);
        const left = p.serviceLeftSec;
        for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
            tickMaintenance(bad, 5);
            expect(p.serviceLeftSec).toBe(left);
        }
    });

    it("resetState severs every order", () => {
        room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 90 }], STATE.buildings);
        expect(STATE.maintenance.orders.length).toBe(1);
        resetState();
        expect(STATE.maintenance).toEqual({ orders: [] });
    });

    it("is INERT where no order is declared — bit-identical room", () => {
        const snap = () => ({
            served: STATE.servedKw, it: STATE.itDrawKw, total: STATE.totalDrawKw,
            money: STATE.money, rep: STATE.reputation, heat: Array.from(STATE.heatField),
        });
        room();
        run(60);
        const withModule = snap();

        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        STATE.brownout.nextAt = Infinity;
        STATE.breakdown.nextAt = Infinity;
        STATE.gridOutage.nextAt = Infinity;
        STATE.tariff.nextAt = Infinity;
        STATE.contract.nextAt = Infinity;
        room();
        initMaintenance([], STATE.buildings);
        run(60);

        expect(snap()).toEqual(withModule);
    });
});
```

- [ ] **Step 4: Run it to confirm it fails for the right reason**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npx vitest run tests/maintenance.test.mjs
```

Expected: fails at import — `Failed to resolve import "../src/sim/maintenance.js"`. Not an assertion failure; the module does not exist yet.

- [ ] **Step 5: Write `src/sim/maintenance.js`**

```js
// sim/maintenance.js — scheduled work orders.
//
// STATE fields owned by this module:
//   STATE.maintenance.orders — the level's work orders and their state
// Building fields owned by this module (declared in entities/Building.js):
//   outForService, serviceLeftSec
//
// The model: a level declares orders as { target, durationSec, bySec }. Each
// is a promise the facility has to keep — that element WILL be out of service
// for durationSec, and it has to happen before bySec. The player chooses the
// moment; the deadline is what makes that a decision rather than a formality.
//
// Out-for-service gear is DEAD GEAR (see isDeadGear in sim/power.js), but it
// is not a fault: no breaker heat accrues, and sim/attribution.js names the
// resulting loss as planned work rather than as a trip.
//
// Pure module: no DOM, no THREE, no timers, no randomness.
import { STATE } from "../core/state.js";

// Build the runtime orders from a level's declaration. `target` indexes the
// buildings array the level was built with — these are preBuilt rooms, so the
// index is deterministic and needs no name resolution.
//
// Throws on a target that resolves to nothing, matching applyPreBuilt: an
// order pointing at gear that does not exist is a level nobody can finish,
// and failing at launch is far cheaper than failing silently at the deadline.
export function initMaintenance(orders, buildings) {
    STATE.maintenance.orders = (orders || []).map((o) => {
        const b = buildings[o.target];
        if (!b) {
            throw new Error(`maintenance: order target ${o.target} resolves to no building`);
        }
        return {
            buildingId: b.id,
            durationSec: o.durationSec,
            bySec: o.bySec,
            leftSec: o.durationSec,
            state: "pending",
        };
    });
}

function orderFor(building, states) {
    if (!building) return null;
    for (const o of STATE.maintenance.orders) {
        if (o.buildingId === building.id && states.includes(o.state)) return o;
    }
    return null;
}

export function pendingOrderFor(building) {
    return orderFor(building, ["pending"]);
}

export function activeOrderFor(building) {
    return orderFor(building, ["active"]);
}

export function activeOrderCount() {
    return STATE.maintenance.orders.filter((o) => o.state === "active").length;
}

// Open the window. Returns false — silently, like every other refusal in the
// sim layer — when there is no pending order for this building, which covers
// gear nobody scheduled and an order already opened, done, or missed.
export function openServiceWindow(building) {
    const order = pendingOrderFor(building);
    if (!order) return false;
    order.state = "active";
    order.leftSec = order.durationSec;
    building.outForService = true;
    building.serviceLeftSec = order.durationSec;
    return true;
}

export function tickMaintenance(dt, elapsed) {
    if (!Number.isFinite(dt) || dt <= 0) return;

    const byId = new Map(STATE.buildings.map((b) => [b.id, b]));
    for (const o of STATE.maintenance.orders) {
        const b = byId.get(o.buildingId);
        if (o.state === "active") {
            o.leftSec = Math.max(0, o.leftSec - dt);
            if (b) b.serviceLeftSec = o.leftSec;
            if (o.leftSec <= 0) {
                o.state = "done";
                if (b) {
                    b.outForService = false;
                    b.serviceLeftSec = 0;
                }
            }
            // A window that OPENED before the deadline is allowed to run past
            // it. The promise was to start the work in time, not to have
            // finished it — otherwise a legal window opened at the last legal
            // second would be a trap.
            continue;
        }
        if (o.state === "pending" && Number.isFinite(elapsed) && elapsed >= o.bySec) {
            o.state = "missed";
        }
    }
}
```

- [ ] **Step 6: Run the test**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npx vitest run tests/maintenance.test.mjs
```

Expected: PASS, 12 tests.

- [ ] **Step 7: Run the whole suite and lint**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: lint clean, `Tests  284 passed (284)`.

- [ ] **Step 8: Commit**

```bash
cd /Users/kp/Projects/my/datacenter-survival
git add src/entities/Building.js src/core/state.js src/sim/maintenance.js tests/maintenance.test.mjs
git commit -m "feat: service windows — gear you take out on purpose

A work order is a promise: this element will be out of service for this
long, before this deadline. The player picks the moment, which is what
makes it a decision instead of a formality.

Out-for-service gear is dead gear, but it is not a fault: no breaker
heat accrues while a window is open. A window opened before the
deadline may run past it — the promise was to start the work in time,
or a legal window opened at the last legal second would be a trap.

An order whose target resolves to nothing throws at init, the way
applyPreBuilt does. An order pointing at gear that does not exist is a
level nobody can finish, and failing at launch beats failing silently
at the deadline."
```

---

### Task 3: The ledger names planned work

**Files:**
- Modify: `src/core/loss-causes.js`
- Modify: `src/sim/attribution.js`
- Modify: `src/locales/en.js`, `src/locales/uk.js`
- Test: `tests/maintenance.test.mjs` (append), existing `tests/attribution.test.mjs` must stay green

**Interfaces:**
- Consumes: `outForService` (Task 2)
- Produces: loss cause id `"maintenance"`

- [ ] **Step 1: Write the failing test**

Append to `tests/maintenance.test.mjs`:

```js
describe("the ledger tells the truth about why the room went dark", () => {
    it("names planned work as planned work, not as a breaker trip", async () => {
        const { p, r } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(10);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(5);

        expect(r.powered).toBe(false);
        expect(STATE.losses.tickKw.maintenance).toBeGreaterThan(0);
        expect(STATE.losses.tickKw.breaker_tripped || 0).toBe(0);
        expect(STATE.losses.tickKw.dead_chain || 0).toBe(0);
        const blamed = STATE.buildings.find((b) => b.id === STATE.losses.blame[0].buildingId);
        expect(blamed.id).toBe(p.id);
    });

    it("still sums exactly — the conservation identity survives a new bucket", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(10);
        openServiceWindow(p, STATE.elapsedGameTime);
        for (let i = 0; i < 300; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickMaintenance(DT, t);
            const missed = Math.max(0, STATE.demandKw - STATE.servedKw);
            const summed = Object.values(STATE.losses.tickKw).reduce((a, b) => a + b, 0);
            expect(summed).toBeCloseTo(missed, 9);
        }
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npx vitest run tests/maintenance.test.mjs -t "names planned work"
```

Expected: FAIL — `expected undefined to be greater than 0`, because the loss currently lands in `dead_chain`.

- [ ] **Step 3: Add the cause**

In `src/core/loss-causes.js`, add above `dead_chain`:

```js
    maintenance: { key: "loss_maintenance", severity: "dropped", color: "#38bdf8" },
```

Sky blue, deliberately not the red of the fault causes: this loss was
scheduled, and colouring it like an incident would undo the distinction the
row exists to make.

- [ ] **Step 4: Add the branch to `powerCause`**

In `src/sim/attribution.js`, inside the walk loop, **above** the
`node.tripped` check:

```js
        // Checked before the breaker: gear can only be one of the two, but
        // naming a scheduled outage "breaker tripped" would be a lie in the
        // one place whose whole job is telling the player where the money went.
        if (node.outForService) {
            return { cause: "maintenance", id: node.id };
        }
```

- [ ] **Step 5: Add the strings to both locales**

`src/locales/en.js`:

```js
    "loss_maintenance": "PLANNED WORK",
```

`src/locales/uk.js`:

```js
    "loss_maintenance": "ПЛАНОВІ РОБОТИ",
```

- [ ] **Step 6: Run the tests**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: lint clean, `Tests  286 passed (286)`. `tests/attribution.test.mjs`'s conservation and inertness tests must be among the passes — they are the proof the new bucket did not break the identity.

- [ ] **Step 7: Commit**

```bash
cd /Users/kp/Projects/my/datacenter-survival
git add src/core/loss-causes.js src/sim/attribution.js src/locales/en.js src/locales/uk.js tests/maintenance.test.mjs
git commit -m "feat: the ledger names planned work

A room dark because you opened a service window is not a room dark
because a breaker tripped, and the ledger is the one place whose whole
job is telling the player where the money went. Sky blue, not the red
of the fault causes — this loss was scheduled.

Checked above the breaker branch in powerCause: gear can only be one of
the two, and the specific cause has to win. The conservation identity
still sums to nine decimals with the bucket in place."
```

---

### Task 4: An objective that can fail a level

The campaign engine currently has no way for an objective to fail a level —
objectives only ever become `done`, and failure arrives from `gameOver`, a
`failConditions` floor, or the clock. This objective needs a fourth path.

**Files:**
- Modify: `src/campaign/campaign.js`
- Modify: `src/locales/en.js`, `src/locales/uk.js`
- Test: `tests/maintenance.test.mjs` (append)

**Interfaces:**
- Consumes: `activeOrderCount`, `tickMaintenance`, `initMaintenance` (Task 2)
- Produces: objective type `"maintenance_without_loss"` with fields `{ type, minServedRatio }`; objective field `o.failed`

- [ ] **Step 1: Write the failing test**

Append to `tests/maintenance.test.mjs`:

```js
import { tickCampaign, startLevelState, levelCfg } from "../src/campaign/campaign.js";

describe("the objective can fail a level, which nothing else in the engine does", () => {
    function objRoom(orders, objective) {
        const built = room();
        STATE.campaign = {
            levelId: null,
            objectives: [{ ...objective, progress: 0, done: false, failed: false }],
            bonuses: [], endsAt: 9999, done: null, reason: null,
        };
        initMaintenance(orders, STATE.buildings);
        return built;
    }

    it("fails the moment an order is missed", () => {
        objRoom([{ target: 2, durationSec: 10, bySec: 20 }],
            { type: "maintenance_without_loss", minServedRatio: 0.9 });
        for (let i = 0; i < 30 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(true);
    });

    it("fails when load drops while a window is open", () => {
        const { p } = objRoom([{ target: 2, durationSec: 20, bySec: 90 }],
            { type: "maintenance_without_loss", minServedRatio: 0.9 });
        for (let i = 0; i < 10 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(false);
        openServiceWindow(p, STATE.elapsedGameTime);
        for (let i = 0; i < 10 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(true);
    });

    it("ignores a load dip while NO window is open — it judges the work, not the weather", () => {
        const { p } = objRoom([{ target: 2, durationSec: 10, bySec: 900 }],
            { type: "maintenance_without_loss", minServedRatio: 0.9 });
        p.tripped = true;                       // a fault, not planned work
        for (let i = 0; i < 20 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(false);
    });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npx vitest run tests/maintenance.test.mjs -t "fails the moment"
```

Expected: FAIL — `expected false to be true`. The objective type is unknown, and the `switch` has no `default`, so nothing happens.

- [ ] **Step 3: Add the objective**

In `src/campaign/campaign.js`, import at the top:

```js
import { activeOrderCount, initMaintenance } from "../sim/maintenance.js";
```

Add to the `evaluateObjective` switch, after `no_throttle`:

```js
        // The Tier III objective, and the only one that can FAIL a level
        // rather than merely not complete. Two ways to lose it, matching the
        // two ways a facility fails the standard: the work never happened,
        // or the work dropped the load.
        case "maintenance_without_loss": {
            const orders = STATE.maintenance.orders;
            if (orders.some((m) => m.state === "missed")) {
                o.failed = true;
                break;
            }
            // Judged ONLY while a window is open. A dip caused by a heatwave
            // or a trip is a different lesson with its own objective; this
            // one is about whether the work could be done safely.
            if (activeOrderCount() > 0 && STATE.demandKw > 0) {
                const ratio = STATE.servedKw / STATE.demandKw;
                if (ratio < o.minServedRatio) {
                    o.failed = true;
                    break;
                }
            }
            if (orders.length > 0 && orders.every((m) => m.state === "done")) o.done = true;
            break;
        }
```

- [ ] **Step 4: Give objectives a failure path**

In `startLevelState`, in the objectives map, add the field:

```js
        objectives: cfg.objectives.map((o) => ({ ...o, progress: 0, done: false, failed: false })),
```

and the same for `bonuses`.

Immediately after `initMaintenance` is needed there too — add after the
schedule pinning block:

```js
    // Work orders resolve against the room the level hands over, so this must
    // run AFTER applyPreBuilt. game.js calls it; see onLevelStart.
    STATE.maintenance = { orders: [] };
```

In `tickCampaign`, in the objective sweep, replace:

```js
    let allDone = true;
    for (const o of camp.objectives) {
        if (!o.done) evaluateObjective(o, dt, elapsed);
        if (!o.done) allDone = false;
    }
```

with:

```js
    let allDone = true;
    for (const o of camp.objectives) {
        if (!o.done) evaluateObjective(o, dt, elapsed);
        // An objective that can FAIL is new: every other type can only fail
        // to complete, and the level ends on the clock or a floor. This ends
        // it immediately, because "you missed the maintenance window" is a
        // verdict, not a shortfall you can still recover from.
        if (o.failed) {
            resolve(camp, "failed", "fail_maintenance");
            return;
        }
        if (!o.done) allDone = false;
    }
```

- [ ] **Step 5: Export `initMaintenance` wiring for level start**

In `src/campaign/campaign.js`, export a helper the composition root calls
after `applyPreBuilt`:

```js
// Work orders index into the room applyPreBuilt just built, so this runs
// after it, not inside startLevelState.
export function startLevelMaintenance(id, built) {
    const cfg = levelCfg(id);
    initMaintenance(cfg && cfg.maintenance ? cfg.maintenance.orders : [], built);
}
```

- [ ] **Step 6: Add the debrief string to both locales**

`src/locales/en.js`:

```js
    "fail_maintenance": "The work did not get done — or it did, and the load went with it. Tier III is not about surviving surprises; it is about being able to service any element without dropping a watt.",
```

`src/locales/uk.js`:

```js
    "fail_maintenance": "Роботи або не відбулися, або відбулися разом із падінням навантаження. Tier III — це не про те, щоб пережити несподіванку, а про можливість обслужити будь-який елемент, не втративши жодного вата.",
```

- [ ] **Step 7: Run the tests**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: lint clean, `Tests  289 passed (289)`. Every existing campaign and bonus test must stay green — `failed` defaults to `false` and no existing objective type ever sets it, so the new branch is unreachable for them.

- [ ] **Step 8: Commit**

```bash
cd /Users/kp/Projects/my/datacenter-survival
git add src/campaign/campaign.js src/locales/en.js src/locales/uk.js tests/maintenance.test.mjs
git commit -m "feat: an objective that can fail a level

Every objective type so far can only fail to COMPLETE — the level ends
on the clock, a money floor, or a reputation floor. \"You missed the
maintenance window\" is not a shortfall you can still recover from, it
is a verdict, so this one ends the level where it stands.

Judged only while a window is open. A load dip from a heatwave or a
trip is a different lesson with its own objective; this one asks
whether the work could be done safely, and nothing else."
```

---


### Task 5: The level, and three ways to play it

The level design was probed numerically before any config was written (the
house pattern). Verified numbers, 18 kW pinned demand across three 6 kW racks
plus one CRAC, PDU capacity 16 kW:

| Room | Transfer the load off PDU-A, then open its window | Why |
|---|---|---|
| 2 PDUs (as handed over) | served / demand = **0.000** | 21 kW lands on the surviving 16 kW bus, its breaker opens, the whole hall goes dark |
| 3 PDUs (N+1) | served / demand = **1.000** | any one bus out still leaves enough capacity for everything |

That 0.000 is what makes the level teach. The naive play is not merely
insufficient — dumping the load onto the one remaining bus **trips it**, which
is a real operational failure during maintenance. The lesson is N+1 *sizing*,
not "own a spare".

Note the model constraint this rests on: a rack has exactly one parent, so
gear under a serviced bus is dark unless the load is **transferred first**.
That transfer is the operator move the level is teaching.

**Files:**
- Modify: `src/core/config.js` (chapter + level + preBuilt + maintenance orders)
- Modify: `game.js` (call `startLevelMaintenance` after `applyPreBuilt`)
- Modify: `src/locales/en.js`, `src/locales/uk.js`
- Test: `tests/prebuilt.test.mjs` (append)

**Interfaces:**
- Consumes: `startLevelMaintenance(id, built)` (Task 4), `openServiceWindow(building)` (Task 2)
- Produces: level id `"night_shift"`, chapter entry `"ch5"`

- [ ] **Step 1: Add the level to CONFIG**

In `src/core/config.js`, add to `campaign.levels`:

```js
            // Chapter 5 — the Tier III lesson. The room is handed over
            // working and correctly sized for NORMAL operation: two buses,
            // 18 kW of racks, nobody overloaded. It is only wrong for the one
            // thing Tier III actually grades — being serviceable.
            //
            // Probed: transferring the load onto the surviving bus puts 21 kW
            // on a 16 kW rating, its breaker opens, and the hall goes to
            // ZERO. The naive play does not fall short, it fails harder than
            // doing nothing. A third bus makes any single window survivable.
            night_shift: {
                startMoney: 120,          // one PDU is 50 — the fix is affordable, the slack is not
                timeLimitSec: 200,
                demandKw: 18,
                script: [],
                maintenance: {
                    orders: [
                        { target: 2, durationSec: 25, bySec: 90 },
                        { target: 3, durationSec: 25, bySec: 170 },
                    ],
                },
                objectives: [
                    { type: "maintenance_without_loss", minServedRatio: 0.95 },
                ],
                preBuilt: {
                    buildings: [
                        { type: "grid_feed", gx: 3, gz: 8 },     // 0
                        { type: "transformer", gx: 6, gz: 8 },   // 1
                        { type: "pdu", gx: 9, gz: 5 },           // 2  <- first order
                        { type: "pdu", gx: 9, gz: 11 },          // 3  <- second order
                        { type: "rack", gx: 13, gz: 4 },         // 4
                        { type: "rack", gx: 13, gz: 8 },         // 5
                        { type: "rack", gx: 13, gz: 12 },        // 6
                        { type: "crac", gx: 16, gz: 8 },         // 7
                    ],
                    wires: [
                        [0, 1],
                        [1, 2], [1, 3],
                        [2, 4], [3, 5], [2, 6],
                        [3, 7],
                    ],
                },
            },
```

Add the chapter to `campaign.chapters`:

```js
            { id: "ch5", titleKey: "ch5_title", levels: ["night_shift"] },
```

- [ ] **Step 2: Wire level start in the composition root**

In `game.js`, find where `applyPreBuilt` is called on level start and add the
maintenance init immediately after it, using its return value:

```js
    const built = applyPreBuilt(id);
    startLevelMaintenance(id, built);
```

Add to the campaign import:

```js
import { tickCampaign, startLevelState, startLevelMaintenance } from "./src/campaign/campaign.js";
```

And add the tick, immediately before `tickCampaign` in the pipeline — the
work-order clock is a fact the objective judges, so it settles first:

```js
    tickMaintenance(dt, STATE.elapsedGameTime);
    tickCampaign(dt, STATE.elapsedGameTime);    // scripted events + objectives, judged last
```

with:

```js
import { tickMaintenance } from "./src/sim/maintenance.js";
```

- [ ] **Step 3: Write the three machine-played cases**

Append to `tests/prebuilt.test.mjs`:

```js
import { openServiceWindow } from "../src/sim/maintenance.js";
import { startLevelMaintenance } from "../src/campaign/campaign.js";
import { tickMaintenance } from "../src/sim/maintenance.js";

describe("L13 night_shift — Tier III is about being serviceable", () => {
    function startShift() {
        resetState();
        resetBuildingIds();
        resetWireIds();
        expect(startLevelState("night_shift")).toBe(true);
        const made = applyPreBuilt("night_shift");
        startLevelMaintenance("night_shift", made);
        return made;
    }

    function runShift() {
        const limit = levelCfg("night_shift").timeLimitSec + 5;
        for (let i = 0; i < limit / DT; i++) {
            if (STATE.campaign.done !== null) return;
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickCrisis(DT, t, rngZero);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickMaintenance(DT, t);
            tickCampaign(DT, t);
        }
    }

    it("LOSE (passive): do nothing and both work orders expire", () => {
        startShift();
        runShift();
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.maintenance.orders.every((o) => o.state === "missed")).toBe(true);
    });

    it("LOSE (naive): move the load onto the surviving bus and TRIP it", () => {
        const made = startShift();
        const [, , pduA, pduB, r1, , r3] = made;
        // The obvious play: shove everything across, then do the work.
        connect(pduB, r1);
        connect(pduB, r3);
        for (let i = 0; i < 200; i++) {          // let the transfer settle
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT); tickMaintenance(DT, t);
        }
        openServiceWindow(pduA);
        runShift();
        expect(STATE.campaign.done).toBe("failed");
        // Not a near miss: 21 kW on a 16 kW bus opens it and the hall is dark.
        expect(pduB.tripped).toBe(true);
    });

    it("WIN: a third bus makes any single window survivable", () => {
        const made = startShift();
        const [, xf, pduA, pduB, r1, , r3] = made;
        const pduC = placeBuilding("pdu", 9, 15);
        expect(typeof pduC).not.toBe("string");
        expect(STATE.money).toBeGreaterThanOrEqual(0);   // $120 covers the $50 bus
        connect(xf, pduC);

        // Order 1: transfer everything off A, then open its window.
        connect(pduC, r1);
        connect(pduB, r3);
        for (let i = 0; i < 200; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT); tickMaintenance(DT, t);
        }
        expect(openServiceWindow(pduA)).toBe(true);
        for (let i = 0; i < 30 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.maintenance.orders[0].state).toBe("done");

        // Order 2: same move, the other way.
        connect(pduA, STATE.buildings.find((b) => b.id === made[5].id));
        connect(pduC, r3);
        for (let i = 0; i < 200; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickDemand(DT, t); resolvePower(DT); tickHeat(DT); tickMaintenance(DT, t);
        }
        expect(openServiceWindow(pduB)).toBe(true);
        runShift();
        expect(STATE.campaign.done).toBe("won");
        expect(STATE.maintenance.orders.every((o) => o.state === "done")).toBe(true);
    });
});
```

- [ ] **Step 4: Run the three cases**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npx vitest run tests/prebuilt.test.mjs
```

Expected: PASS. If the WIN case fails on the CRAC (index 7 hangs off PDU-B and
must also move before B's window), move it too and record that in the level's
`lv_night_shift_tip` string — it is part of the lesson, not an oversight.

- [ ] **Step 5: Add the level strings to both locales**

`src/locales/en.js` — six level keys plus the chapter title:

```js
    "ch5_title": "Chapter 5 — Serviceable",
    "lv_night_shift": "Night Shift",
    "lv_night_shift_brief": "Two work orders, two buses, and eighteen kilowatts that are not allowed to notice.",
    "lv_night_shift_scenario": "The room works. It is correctly sized, nobody is overloaded, and it has run like this for a year. Tonight both distribution buses are due for scheduled service — twenty-five seconds each, and the deadlines are not yours to move.",
    "lv_night_shift_learn": "Tier III is not \"has a backup\". It is concurrent maintainability: any element can be taken out for planned work while the load keeps running. That is a statement about CAPACITY, not about spares — with one bus out, what remains has to carry everything.",
    "lv_night_shift_tip": "Transfer the load off a bus before you open its window. Then check what the surviving buses are actually carrying: two buses cannot hold eighteen kilowatts plus cooling, and the one you leave standing will open its own breaker.",
    "lv_night_shift_tip_fail": "Either the work never happened, or it took the hall with it. Both are Tier III failures. Count the kilowatts the remaining buses have to carry with one of them out — if that number is over sixteen, you need another bus, not a better plan.",
```

`src/locales/uk.js`:

```js
    "ch5_title": "Розділ 5 — Придатна до обслуговування",
    "lv_night_shift": "Нічна зміна",
    "lv_night_shift_brief": "Два наряди, дві шини і вісімнадцять кіловат, які не мають цього помітити.",
    "lv_night_shift_scenario": "Зала працює. Розрахована правильно, ніхто не перевантажений, і так вона живе вже рік. Сьогодні вночі обидві розподільчі шини мають пройти планове обслуговування — по двадцять пʼять секунд кожна, і терміни пересувати не тобі.",
    "lv_night_shift_learn": "Tier III — це не «є резерв». Це придатність до обслуговування: будь-який елемент можна вивести на планові роботи, поки навантаження живе далі. І це твердження про ЄМНІСТЬ, а не про запасні деталі — коли одна шина вимкнена, решта мусить витягнути все.",
    "lv_night_shift_tip": "Переведи навантаження з шини, перш ніж відкривати її вікно. А тоді порахуй, що насправді тягнуть ті, які лишились: дві шини не втримають вісімнадцять кіловат плюс охолодження, і та, що залишиться, вибʼє власний автомат.",
    "lv_night_shift_tip_fail": "Або роботи не відбулися, або забрали залу з собою. І те, і те — провал за Tier III. Порахуй кіловати, які доведеться нести шинам, коли однієї з них немає: якщо вийшло більше шістнадцяти, потрібна ще одна шина, а не кращий план.",
```

- [ ] **Step 6: Run the whole suite**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: lint clean, `Tests  292 passed (292)`.

- [ ] **Step 7: Commit**

```bash
cd /Users/kp/Projects/my/datacenter-survival
git add src/core/config.js game.js src/locales/en.js src/locales/uk.js tests/prebuilt.test.mjs
git commit -m "feat: night_shift — Tier III is about being serviceable (#17)

The room is handed over working: correctly sized, nobody overloaded,
running like this for a year. It is wrong for exactly one thing, and it
is the thing Tier III actually grades.

Three machine-played cases instead of the usual pair, because the naive
read needed foreclosing too:

  passive  do nothing            both orders expire
  naive    shove the load across 21 kW on a 16 kW bus, its breaker
                                 opens, the hall goes to ZERO
  win      add a third bus       any single window survivable

That zero is the level. Dumping load onto the one surviving bus does
not fall short of the target, it fails harder than doing nothing — which
is a real thing that happens to real facilities during maintenance. The
lesson is N+1 SIZING, not owning a spare."
```

---

### Task 6: Making it visible

A mechanic the player cannot see is a mechanic they cannot plan against, and
this one is entirely about planning.

**Files:**
- Modify: `index.html` (work-order line element)
- Modify: `src/input/handlers.js` (select-click opens a window)
- Modify: `src/ui/hud.js` (work-order line + inspect rows)
- Modify: `src/ui/meshes.js` (out-for-service tint)
- Modify: `src/locales/en.js`, `src/locales/uk.js`
- Modify: `game.js` (banners)

**Interfaces:**
- Consumes: `pendingOrderFor`, `activeOrderFor`, `openServiceWindow` (Task 2)
- Produces: nothing the sim reads — this task is display and input only

- [ ] **Step 1: Add the work-order line to index.html**

Directly below the existing `#contract-line` div (line ~93):

```html
  <div id="maintenance-line" class="hidden absolute top-48 left-1/2 -translate-x-1/2 z-10 glass-panel rounded-lg px-4 py-1.5 text-sky-200 text-xs font-bold"></div>
```

Sky, matching the ledger's `maintenance` colour — planned work reads the same
everywhere it appears.

- [ ] **Step 2: Render it in the HUD**

In `src/ui/hud.js`, add to `tickHud()` after the contract-line block:

```js
    // Work orders: the deadline is the whole decision, so it stays on screen
    // rather than living in a banner that scrolls away while the player is
    // deciding when to open the window.
    const mline = el("maintenance-line");
    if (mline) {
        const orders = STATE.maintenance.orders;
        const active = orders.find((o) => o.state === "active");
        const next = orders.find((o) => o.state === "pending");
        if (active) {
            mline.textContent = i18n.t("maint_active", { s: Math.ceil(active.leftSec) });
        } else if (next) {
            mline.textContent = i18n.t("maint_pending", {
                name: i18n.t("b_" + nameOfOrder(next)),
                dur: next.durationSec,
                left: Math.max(0, Math.ceil(next.bySec - STATE.elapsedGameTime)),
            });
        }
        mline.classList.toggle("hidden", !active && !next);
    }
```

and the helper beside `round2`:

```js
// The order's target type, for a human label. An order whose building has
// been demolished names nothing rather than crashing the HUD.
function nameOfOrder(order) {
    const b = STATE.buildings.find((x) => x.id === order.buildingId);
    return b ? b.type : "pdu";
}
```

- [ ] **Step 3: Add inspect rows**

In `renderInspect`, immediately after the `insp_tripped` block:

```js
    const pending = pendingOrderFor(b);
    const servicing = activeOrderFor(b);
    if (servicing) {
        rows.push(`<div class="text-sky-300 font-bold mb-1">${i18n.t("insp_in_service", { s: Math.ceil(servicing.leftSec) })}</div>`);
    } else if (pending) {
        rows.push(`<div class="text-sky-300 font-bold mb-1">${i18n.t("insp_service_due", {
            dur: pending.durationSec,
            left: Math.max(0, Math.ceil(pending.bySec - STATE.elapsedGameTime)),
        })}</div>`);
    }
```

with the import:

```js
import { pendingOrderFor, activeOrderFor } from "../sim/maintenance.js";
```

- [ ] **Step 4: Open the window on a select-click**

In `src/input/handlers.js`, in `handlePrimary`'s select branch, after the
tripped-link block:

```js
    // Clicking gear with a pending work order opens its service window. Same
    // click as pushing a breaker handle back in — the player already knows
    // that gesture, and a second tool for a once-a-level action is clutter.
    if (hit.building && pendingOrderFor(hit.building)) {
        openServiceWindow(hit.building);
        showBanner(i18n.t("maint_opened", { name: i18n.t("b_" + hit.building.type) }), 4000);
    }
```

with:

```js
import { pendingOrderFor, openServiceWindow } from "../sim/maintenance.js";
```

- [ ] **Step 5: Make it look different from a fault**

In `src/ui/meshes.js`, in `tickMeshes`, add before the existing per-type
blocks:

```js
        // Out for service reads as sky, not as the red of a fault. The ledger
        // just went to the trouble of distinguishing planned work from a
        // trip; the room must not undo that.
        if (b.outForService && b.mesh.material) {
            b.mesh.material.color.setHex(0x38bdf8);
        }
```

- [ ] **Step 6: Add the banners**

In `game.js`, after the breaker-trip block:

```js
    // Work orders: issued once at level start, and the miss is the verdict.
    for (const o of STATE.maintenance.orders) {
        if (o.state === "missed" && !missedOrders.has(o.buildingId)) {
            missedOrders.add(o.buildingId);
            showBanner(i18n.t("maint_missed"), 6000);
        }
    }
```

with the module-scope latch beside the others:

```js
let missedOrders = new Set();
```

and its reset in `clearWorld()`:

```js
    missedOrders = new Set();
```

- [ ] **Step 7: Add all the strings to both locales**

`src/locales/en.js`:

```js
    "maint_pending": "WORK ORDER · {name} · {dur}s out of service · {left}s to start",
    "maint_active": "IN SERVICE · {s}s remaining",
    "maint_opened": "{name} out of service — the clock is running",
    "maint_missed": "Work order expired. The service never happened, and a facility that cannot be serviced is not Tier III.",
    "insp_service_due": "SERVICE DUE · {dur}s window · {left}s to start",
    "insp_in_service": "OUT FOR SERVICE · {s}s left",
```

`src/locales/uk.js`:

```js
    "maint_pending": "НАРЯД · {name} · {dur}с поза роботою · почати за {left}с",
    "maint_active": "НА ОБСЛУГОВУВАННІ · лишилось {s}с",
    "maint_opened": "{name} виведено з роботи — час пішов",
    "maint_missed": "Наряд прострочено. Роботи так і не відбулися, а зала, яку не можна обслужити, — це не Tier III.",
    "insp_service_due": "ПОТРІБНЕ ОБСЛУГОВУВАННЯ · вікно {dur}с · почати за {left}с",
    "insp_in_service": "НА ОБСЛУГОВУВАННІ · лишилось {s}с",
```

- [ ] **Step 8: Verify in the browser**

Bump the port in `.claude/launch.json` to bust the module cache, start the
preview, open `night_shift` from level select (seed
`localStorage.setItem('dc_campaign_done', JSON.stringify(['first_watt','hot_aisle','the_bill','sag','dark_chain','fuel_clock','over_cooled','one_bus','cold_room','two_utilities','water_loop','single_point_of_cold']))`
first), and confirm:

- the work-order line shows the target, the window and the countdown
- clicking the target opens the window and the mesh turns sky, not red
- the inspect panel counts the window down
- the ledger shows PLANNED WORK, not a breaker trip
- both locales render with no raw keys
- `read_console_messages` is clean

- [ ] **Step 9: Run everything and commit**

```bash
cd /Users/kp/Projects/my/datacenter-survival && npm run check
```

Expected: lint clean, `Tests  292 passed (292)`.

```bash
git add -A
git commit -m "feat: work orders on screen — a deadline you can plan against

The whole mechanic is choosing WHEN, so the deadline lives on the HUD
rather than in a banner that scrolls away mid-decision. Clicking the
target opens the window — the same gesture as pushing a breaker handle
back in, because a second tool for a once-a-level action is clutter.

Out-for-service gear renders sky, not the red of a fault. The ledger
just went to the trouble of distinguishing planned work from a trip and
the room should not undo it."
```

---

## Mutation testing

Before calling this done, break the mechanic on purpose and confirm the suite
goes red for each. Put the list in the final commit body — house rule.

| Mutation | Should turn red |
|---|---|
| `isDeadGear` returns `b.tripped` only | maintenance window tests, night_shift WIN/LOSE |
| Move `isDeadGear` in `deliver` to BEFORE the UPS clause | existing UPS/generator integration tests |
| Move `isDeadGear` in `chainAlive` to AFTER the UPS clause | `tests/integration.test.mjs` starvation test |
| `tickMaintenance` never marks `missed` | passive LOSE case, "misses an order" test |
| Objective ignores `minServedRatio` while a window is open | naive LOSE case |
| `powerCause` drops the `outForService` branch | "names planned work" test |
| `initMaintenance` returns `[]` instead of throwing on a bad target | "THROWS on a target that resolves to nothing" |

## Self-review notes

- **Spec coverage.** Every section of the design maps to a task: dead-gear
  predicate → 1, service windows → 2, ledger → 3, objective → 4, level → 5,
  UI → 6. The one thing the spec did NOT anticipate is that objectives had no
  failure path at all; Task 4 adds it explicitly rather than smuggling it in.
- **Spec correction.** The spec described the level as "a single path" needing
  "a second path". Probing showed that is wrong: a rack has exactly one
  parent, so the play is *transferring load* before opening a window, and the
  real lesson is N+1 **sizing** — with two buses the naive transfer trips the
  survivor and the hall goes to zero. Task 5 records the verified numbers.
  Update the spec's "The level" section to match after Task 5 lands.
- **Deferred.** The spec's stretch case (a WIN that does the work during the
  demand peak and finishes measurably poorer) is not in this plan. The level
  pins demand flat, so there is no trough to exploit yet; it belongs with a
  level that runs the tariff cycle. Not a gap — a follow-up.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-05-concurrent-maintainability.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
