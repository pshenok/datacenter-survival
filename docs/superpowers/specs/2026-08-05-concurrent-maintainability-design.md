# Concurrent maintainability — design

**Status:** approved (2026-08-05)
**Issue:** [#17](https://github.com/pshenok/datacenter-survival/issues/17)
**Teaches:** Tier III is not "has a generator". It is "any element can be taken
out of service without dropping load."

## Why this mechanic

The game already has redundancy — a second utility feed, a standby generator,
a spare cooling unit. In every level so far, redundancy is *insurance against
something random*: an outage lands, and a player who happened to build a
second path survives it. That teaches luck, not engineering.

Real facilities are graded on something else entirely. Tier III's defining
requirement is **concurrent maintainability**: every capacity component and
every distribution path must be removable for planned service while the load
keeps running. Maintenance is not a risk you insure against — it is scheduled,
non-negotiable work that arrives whether you prepared or not.

Two consequences the game cannot currently express:

1. **Redundancy becomes a job requirement.** Without a spare path you cannot
   do the work at all. Not "you might get unlucky" — you are simply unable to
   perform routine maintenance, which is a failure in itself.
2. **N+1 must hold everywhere.** Work orders arrive in a rotation and target
   different elements. A room with one spare path in the wrong place passes
   the first two orders and fails the third. The player learns to audit the
   whole topology, not the part they worried about.

## The decision, and both ways to get it wrong

| Axis | Getting it wrong |
|---|---|
| Topology | No spare path for the targeted element — the work cannot be done without dropping load |
| Timing | The work is done during a demand peak or an expensive tariff band — survivable, but it bleeds money, and with a thin margin it clips |

The timing axis composes with what already ships: the demand curve has troughs
and the day/night meter has a cheap half. An operator who schedules the outage
into the quiet hour is doing exactly what a real one does.

## Sim model

### Out of service

New `Building` fields, owned by a new pure module `src/sim/maintenance.js`:

- `outForService` — boolean, true while the service window is open
- `serviceLeftSec` — remaining window, counted down by the tick

Physically, gear out for service is **dead gear**: it carries nothing and its
subtree loses its path, exactly like an open breaker.

**Care point.** The `tripped` check sits on deliberately *opposite* sides of
the UPS clause in the two modules that read it:

- `demand.js` `chainAlive` — **before** the UPS clause, or a tripped UPS reads
  as live and reintroduces the starvation bug pinned in `integration.test.mjs`
- `power.js` `deliver` — **after** the UPS clause, so a tripped UPS cannot
  self-grant from its buffer

Rather than adding a second flag at both sites and risking one of them landing
on the wrong side, introduce a single shared predicate — "this gear is not
passing power" — and substitute it at exactly the two existing positions.
Behaviour is preserved bit-for-bit and a tribal invariant becomes explicit.
`docs/ARCHITECTURE.md` gets updated in the same change.

### Work orders

Declared per level in CONFIG:

```js
maintenance: {
    orders: [
        { target: 3, durationSec: 30, bySec: 90 },
        { target: 5, durationSec: 30, bySec: 160 },
    ],
}
```

`target` is an index into the level's `preBuilt.buildings` array. These levels
hand the player a room that already exists, so the index is deterministic and
needs no name resolution. `applyPreBuilt` already throws on a rejected
placement, so an index that does not resolve must throw at level start too —
a work order pointing at nothing is a level that cannot be completed.

`STATE.maintenance.orders` mirrors CONFIG with runtime fields: `buildingId`,
`state` (`pending` / `active` / `done` / `missed`), `leftSec`.

### Player action

Clicking a building that has a pending order, with the select tool, opens its
window. This is the same click path that pushes a tripped breaker back in — no
new tool, no new mode. The window closes itself when `leftSec` reaches zero
and the order becomes `done`.

An order whose `bySec` passes while still `pending` becomes `missed`, and
`missed` is terminal.

## Objective: `maintenance_without_loss`

- **Fails** if any order reaches `missed`.
- **Fails** if served load drops below `minServedRatio` of demand on any tick
  while an order is `active`. That ratio is declared on the objective itself
  in `CONFIG.campaign.levels`, not globally: the tolerable dip depends on the
  room a level hands you, and a single global floor would either forgive a
  single-path room or condemn a legitimately thin one.
- **Done** when every order is `done`.

The served-ratio test only runs while a window is open, so the objective is
scoped to the thing it is judging. It reads `STATE.servedKw`, which carries
the documented one-tick lag — the level's ratio is tuned against that, not
against an idealised instant value.

## Loss attribution

New cause `maintenance` in `src/core/loss-causes.js`, severity `dropped`, its
own colour. `powerCause()` gains a branch above `dead_chain`: a subtree dark
because of an open service window is named as planned work, not as a fault.

Calling a scheduled outage "breaker tripped" would be a lie in the one place
whose entire job is telling the player where their money went, and the
conservation identity in `attribution.test.mjs` must still sum to nine
decimals with the new bucket in place.

`loss_maintenance` goes into both locales.

## The level

Chapter 5, `night_shift`. A preBuilt room on a single path, two orders
targeting different elements, and a demand curve with a visible trough.

Three machine-played cases, one more than the usual pair:

| Case | Play | Outcome |
|---|---|---|
| LOSE (passive) | Do nothing | Both orders `missed` |
| LOSE (naive) | Open the windows on the room as handed over | Load drops — the work is undoable as built |
| WIN | Build the second path first, then open both windows | Both orders `done`, load never dips |

Two *distinct* losing strategies is what makes this level stronger than the
standard pair: it forecloses both the passive read ("ignore it") and the naive
read ("just do the work"), and only the topology fix passes.

A stretch case worth pinning if the numbers allow: a WIN build that does the
work during the demand peak and still clears the objective but finishes with
materially less money than the same build doing it in the trough. That makes
the timing axis testable rather than merely available.

## UI

- **Work-order line** beside the contract line: target, window length, deadline.
- **Inspect panel** on the target: "Service due by 1:30", or "In service, 18 s
  left" while open.
- **Mesh state**: out-for-service reads differently from tripped. A fault and a
  planned outage looking identical would undo the distinction the ledger just
  made.
- **Banner** when an order is issued and when one is missed.
- No new toolbar entry.

## Testing

Beyond the three machine-played cases:

- The pure-module contract: no-op on `dt <= 0`, NaN and Infinity; `resetState`
  severs every new field; CONFIG never written.
- **Substitution safety**: the shared dead-gear predicate must leave every
  existing power and demand test green, which is the evidence that it landed
  on the same side of the UPS clause in both files.
- **Inertness**: with no orders declared, an identical room must produce
  bit-identical served kW, draw, reputation and heat field — the mechanic is
  invisible where it is not used.
- **Attribution**: the conservation identity still sums with `maintenance` in
  the taxonomy.

Mutation list to confirm the suite goes red: treat out-for-service gear as
live; let a missed order pass; drop the served-ratio check while a window is
open; move the predicate to the wrong side of the UPS clause in either file.

## Out of scope

- Maintenance in free play. The mechanic is a campaign lesson first; a random
  work order in a survival run is a crisis wearing a hat, which is the shape
  this design exists to avoid.
- Partial capacity during service (a component at half rating). Real, but it
  blurs the binary that makes the lesson legible.
- Deferring or rescheduling an order. Considered and dropped — the deadline is
  what makes the timing axis a decision.
