# Datacenter Survival

**You run the physical layer of the cloud.** Racks earn money while they are
powered and cool — everything else is the fight to keep those two things true.

Sister game of [Server Survival](https://github.com/pshenok/server-survival):
that one teaches the *logical* layer (services, routing, scaling); this one
teaches the *physical* layer it all runs on — megawatts, heat, cooling, PUE.

[![PLAY NOW](https://img.shields.io/badge/PLAY_NOW-Datacenter_Survival-d97706?style=for-the-badge)](https://pshenok.github.io/datacenter-survival/)

![Datacenter Survival gameplay: wiring the power chain, the hot aisle blooming under the thermal overlay, cooling answering it, a city grid outage carried by UPS and generator, and the loss ledger naming where the money went](assets/demo.gif)

*Real capture, sped up with the game's own fast-forward: the chain goes live →
the rack block cooks itself past 45 °C and throttles → CRACs answer it (and
push PUE up) → the city grid dies, and only the UPS-backed half of the room
stays lit until the standby generator picks up. Throughout, badges name the
building responsible for every kilowatt you fail to serve — and the ledger
totals it in dollars.*

## The two systems

- **Power is wired.** Grid Feed → Transformer → UPS → PDU → Rack. Every link
  has a kW capacity. Overload one and it clips its whole subtree
  proportionally — push it further and its **breaker opens**, because real
  gear does not dim forever. A UPS bridges a blip in seconds; a standby
  generator carries the rest, for exactly as long as there is fuel in it.
- **Heat spreads.** Every kW a rack draws becomes heat in the cells around
  it. CRAC units cool a radius — and draw power themselves, idle draw
  included, so two half-loaded units cost more than one working one. That is
  why your **PUE** (total facility power ÷ IT power) is both your score and
  your power bill. Press **T** for the thermal overlay and watch hot aisles
  form from your own layout.

Overheated racks throttle, throttled racks miss SLA, missed SLA drains
reputation and money. And every kilowatt you fail to serve is **named**:
badges float the cause over the building responsible, and the ledger totals
the run in dollars — `Where the $65 went: AT CAPACITY 61%, TOO HOT 20%…`.

## The campaign

Ten levels in three chapters, each teaching one mechanic and each proven —
by machine-played tests — to be **winnable with that mechanic and losable
without it**.

- **Chapter 1 · Power & Heat** — the delivery chain, the hot aisle, PUE and
  placement, a grid sag that only headroom rides out, and a blackout that
  only a charged UPS bridges.
- **Chapter 2 · Backup** — a standby generator, its transfer switch, and the
  fuel gauge that is the real capacity of your backup.
- **Chapter 3 · Diagnosis** — levels that hand you a room that is already
  running and already wrong: four CRACs burying the PUE, four racks sharing
  one bus until its breaker opens, cooling installed in the wrong corner,
  and two "redundant" feeds that turn out to share a substation.

Optional bonus objectives sit on a different axis than the level's own goal
— serve *through* the sag, or bridge three blackouts and still finish with
money in the bank.

## What it teaches

- The datacenter power chain, and why a breaker opening is not the problem
- Thermal design: hot and cold aisles emerge from placement, not from rules
- PUE as a profit lever, and why over-cooling is as expensive as under-cooling
- Redundancy that is real (independent substations) versus redundancy that
  is decoration
- Batteries bridge seconds, generators carry hours, fuel is the actual limit
- Diagnosis: reading an attribution ledger instead of guessing

## Running it

Clone and open `index.html` — that's the whole setup. **No build step**: the
repo is served raw by GitHub Pages, native ES modules, Three.js from CDN.

For contributors: `npm i && npm run check` runs ESLint and the Vitest suite.
The simulation is tested headless (power conservation, heat conservation,
loss attribution that must sum exactly, breaker timing, no-NaN invariants),
and every campaign level is machine-played in both directions. `npm run
demo:capture && npm run demo:gif` re-records the README animation from a
real playthrough.

## Status

Ten campaign levels across three chapters, seven buildings, 247 tests.
Simulation: wired power with inverse-time breakers, a diffusing heat field
with part-load cooling, UPS buffers, standby generators with fuel, grid sags,
per-substation outages, peak tariffs, rolling contracts, and per-cause loss
attribution. English and Ukrainian.

Roadmap ([#5](https://github.com/pshenok/datacenter-survival/issues/5)):
two-stage cooling (chillers + towers), water usage, time-of-use tariff
strategy, and a Lab level with live knobs.
