# Datacenter Survival

**You run the physical layer of the cloud.** Racks earn money while they are
powered and cool — everything else is the fight to keep those two things true.

Sister game of [Server Survival](https://github.com/pshenok/server-survival):
that one teaches the *logical* layer (services, routing, scaling); this one
teaches the *physical* layer it all runs on — megawatts, heat, cooling, PUE.

[![PLAY NOW](https://img.shields.io/badge/PLAY_NOW-Datacenter_Survival-d97706?style=for-the-badge)](https://pshenok.github.io/datacenter-survival/)

![Datacenter Survival gameplay: wiring the power chain, the hot aisle blooming under the thermal overlay, cooling answering it, and a city grid outage carried by UPS and generator](assets/demo.gif)

*Real capture, sped up with the game's own fast-forward: the chain goes live →
the rack block cooks itself past 45 °C and throttles → CRACs bring it back
(and push PUE up) → the city grid dies, and only the UPS-backed half of the
room stays lit until the standby generator picks up.*

## The two systems

- **Power is wired.** Grid Feed → Transformer → UPS → PDU → Rack. Every link
  has a kW capacity; overload a link and its whole subtree browns out. A UPS
  carries its subtree through a brief blip — for a few seconds.
- **Heat spreads.** Every kW a rack draws becomes heat in the cells around
  it. CRAC units cool a radius — and draw power themselves, which is why your
  **PUE** (total facility power ÷ IT power) is both your score and your
  power bill. Press **T** for the thermal overlay and watch hot aisles form
  from your own layout.

Overheated racks throttle, throttled racks miss SLA, missed SLA drains
reputation and money. Demand arrives in ramping waves; heatwaves arrive on
their own schedule. Survive.

## What it teaches

- The datacenter power chain and why N+1 exists
- Thermal design: hot/cold aisles emerge from placement, not rules
- PUE as a profit lever, not a vanity metric
- Why AI datacenters are limited by the socket, not the chips
- Throttling as protection, brownouts as proportional clipping

## Running it

Clone and open `index.html` — that's the whole setup. **No build step**: the
repo is served raw by GitHub Pages, native ES modules, Three.js from CDN.

For contributors: `npm i && npm run check` runs ESLint and the Vitest suite
(pure simulation modules are tested headless — power conservation, heat
conservation, SLA math, no-NaN invariants). CI runs on every PR.

## Status

v0.1 — MVP: 6 buildings, heat field with thermal overlay, demand waves,
heatwave event, PUE scoring, bankruptcy and reputation game-overs.
Roadmap: diesel generators + fuel, two-stage cooling (chillers + towers),
water usage, day/night power tariffs, campaign scenarios, more languages
(en/ru today).
