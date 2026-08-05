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
  included, so two half-loaded units cost more than one working one. Above a
  certain size a **chiller** making chilled water for many **CRAH** heads
  beats cooling everywhere at once; below it, the plant's pumps cost more
  than they save. That is why your **PUE** (total facility power ÷ IT power)
  is both your score and your power bill. Press **T** for the thermal overlay
  and watch hot aisles form from your own layout.

Overheated racks throttle, throttled racks miss SLA, missed SLA drains
reputation and money. And every kilowatt you fail to serve is **named**:
badges float the cause over the building responsible, and the ledger totals
the run in dollars — `Where the $65 went: AT CAPACITY 61%, TOO HOT 20%…`.

## The campaign

Twelve levels in four chapters, each teaching one mechanic and each proven —
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
- **Chapter 4 · Scale** — one chiller plant feeding many cooling
  heads: cheaper than cooling everywhere at once, right up until the day the
  plant stops and every head on it stops together.

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
- Shared cooling is shared efficiency and shared blast radius — the same
  property, and scale decides which one you get
- Diagnosis: reading an attribution ledger instead of guessing

## Running it

**No build step**: the repo is served raw by GitHub Pages, native ES modules,
Three.js from CDN. But it does need a *server* — the game is ES modules, and
browsers block those over `file://`, so double-clicking `index.html` gives you
a HUD over an empty screen. Any static server works:

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

For contributors: `npm i && npm run check` runs ESLint and the Vitest suite.
The simulation is tested headless (power conservation, heat conservation,
loss attribution that must sum exactly, breaker timing, no-NaN invariants),
and every campaign level is machine-played in both directions. `npm run
demo:capture && npm run demo:gif` re-records the README animation from a
real playthrough.

## Status

Twelve campaign levels across four chapters, nine buildings, 259 tests.
Simulation: wired power with inverse-time breakers, a diffusing heat field
with part-load cooling, a shared chilled-water loop, UPS buffers, standby
generators with fuel, grid sags, per-substation outages, peak tariffs,
rolling contracts, and per-cause loss attribution. English and Ukrainian.

Next: time-of-use tariffs
([#4](https://github.com/pshenok/datacenter-survival/issues/4)) — day/night
pricing, pre-cooling and peak shaving — and a Lab level with live knobs, the
last open item on the roadmap
([#5](https://github.com/pshenok/datacenter-survival/issues/5)).

## Contributing

The bar is that a mechanic has to teach something true — a mechanic that
plays well and models the physics dishonestly is a bug. Everything a
contributor needs is in [CONTRIBUTING.md](CONTRIBUTING.md), with the
invariants behind it in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Starting points: anything tagged
[good first issue](https://github.com/pshenok/datacenter-survival/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
is a real, verified gap with the fix already located. Questions and mechanic
proposals go to
[Discussions](https://github.com/pshenok/datacenter-survival/discussions).
