# Pre-cooling — measured, and rejected

**Status:** rejected (2026-08-08)
**Issue:** [#4](https://github.com/pshenok/datacenter-survival/issues/4), the
"pre-cooling play"

Issue #4 proposed three plays on the time-of-use meter: a day/night cycle
(shipped), pre-cooling, and peak shaving. This records why the middle one is
not being built, so nobody spends a day rediscovering it.

## What the issue assumed

> **Pre-cooling play**: overcool the floor on cheap power so CRACs can idle
> through the peak window — the heat field already supports this, it just
> needs a price signal to make it matter.

Both halves of that last clause are wrong.

## The field cannot store cold

`src/sim/heat.js` clamps every removal with `Math.max(target, field[i] - …)`
and skips cells at or below the target (`if (e <= 0) continue`). Cooling can
never take a cell below ambient, and at ambient a unit's duty is zero. There
is no thermal mass to charge.

That part is fixable — a sub-ambient setpoint is a small change. The second
part is not.

## The economics do not work, at any depth swept

Measured against the shipped constants, in a deliberately cooling-BOUND room
(24 kW IT, permanent heatwave, four CRACs, peak ×2.5), comparing a fixed
window so every trial is scored over the same seconds:

| Depth | Lead 10 s | Lead 20 s | Lead 40 s |
|---|---|---|---|
| −1 °C | saves $0.18 | saves $0.35 | saves $0.71 |
| −2 °C | costs $0.17 | costs $0.29 | costs $0.44 |
| −4 °C | costs $0.28 | costs $0.79 | costs $1.53 |

Baseline over the window: ~$53. So the best result anywhere in the sweep is a
**1.3% saving**, and it inverts the moment the room is chilled harder than a
single degree.

**Why, structurally:** banking cold means chilling a unit's whole radius — 49
cells — including empty floor holding no heat that would ever need removing.
Dissipation drags all 49 back toward ambient at a rate proportional to
depth × area. The benefit is only the rack heat not removed during the window.
Cost scales with **area**; benefit scales with **rack heat**. In this model
the area term dominates, and no tuning of depth or lead time reverses that —
deeper chilling makes it strictly worse, which is the signature of a cost that
is structural rather than mis-parameterised.

## Why it is not being "fixed"

The two ways to make the numbers work are both dishonest:

- Exempt empty floor from dissipation, so banked cold persists where there is
  nothing to keep it cold. False, and it would quietly break the hot-aisle
  lesson that depends on heat spreading and decaying uniformly.
- Make cooling cheap enough that banking is nearly free. That deletes the PUE
  lessons in `the_bill`, `over_cooled` and `water_loop`, which are built on
  cooling being a permanent, expensive line.

CONTRIBUTING.md's first rule is that a mechanic which plays well and models
the physics dishonestly is a bug. A pre-cooling button that pays only because
the field was rigged to let it is exactly that.

## What replaces it

Peak shaving, the third play in the same issue, survives the same scrutiny.
A UPS discharging into a price peak and recharging off-peak shifts real
energy, and round-trip losses make the trade genuinely costly:

| Round-trip efficiency | Net per full discharge |
|---|---|
| 100% | +$12.53 |
| 88% | +$12.17 |
| 80% | +$11.88 |

…against a price the player feels immediately: the buffer is empty when the
next outage lands. That is a decision that can be got wrong in both
directions, which pre-cooling — at these constants — never was.
