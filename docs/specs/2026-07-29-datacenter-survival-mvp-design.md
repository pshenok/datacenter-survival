# Datacenter Survival — MVP design

**Date:** 2026-07-29
**Status:** approved (core loop approved explicitly; buildings/tech sections delegated)

## What this is

The sister game of [Server Survival](https://github.com/pshenok/server-survival).
Server Survival teaches the **logical** layer of the cloud — services, routing,
scaling. Datacenter Survival teaches the **physical** layer it runs on — racks,
megawatts, heat, cooling, PUE. Same engine DNA, same hard constraint, same
education north star.

**Hard constraint (inherited):** no build step. The repo is served raw by
GitHub Pages. Native ESM, vanilla JS, Three.js r128 from CDN, Tailwind from
CDN. Dev tooling (ESLint, Vitest, CI) is optional and contributor-only.

## Core loop (approved)

You operate a datacenter. Demand for capacity arrives in ramping waves
(Survival DNA). Racks earn money while they are **powered** and **cool**.
Everything else is the fight to keep those two conditions true.

Two systems, two verbs:

- **Power is wired** (the proven connection mechanic): Grid Feed → Transformer
  → UPS → PDU → Rack. Every link has a kW capacity; an overloaded link browns
  out its whole subtree.
- **Heat spreads** (the new verb): every kW a rack draws becomes a kW of heat
  in the cells around it. Simple diffusion over the grid; CRAC units remove
  heat in a radius. Hot/cold aisles *emerge from placement*, not from rules.
  The **thermal overlay** (key T) is the game's signature visual.

Loop: demand wave → need racks → racks need power (wire the chain) and cold
(place cooling wisely) → overheat = throttling = SLA penalties → money and
reputation → bankruptcy or the next wave.

**Score is PUE** (total facility power / IT power) — the metric the real
industry lives by. Reputation = SLA compliance, as in Server Survival.

**What it teaches:** the power chain and N+1 thinking, thermal design
(aisles, containment), PUE, "AI datacenters are limited by the socket, not
the chips", throttling as protection.

## Buildings (MVP roster — 6 + tools)

| Building | Role | Behavior that matters |
|---|---|---|
| **Grid Feed** | power intake (map edge) | source of kW, capacity-limited; the root of every chain |
| **Transformer** | power link | steps capacity down/out; chain link with kW limit |
| **UPS** | power link + buffer | chain link; carries its subtree through a brief source blip (seconds of stored energy) |
| **PDU** | power fan-out | the only node racks may wire to; kW limit across its racks |
| **Rack** | the earner | draws kW under assigned load, earns $ per kWh served, emits heat ∝ actual draw; throttles above temp threshold (serves less, SLA hit); hard-stops at critical temp |
| **CRAC unit** | cooling | removes heat/sec in a radius; **draws power itself** — cooling is on the power bill, which is the PUE lesson in the wallet |

Tools: select, wire, demolish, unwire. Thermal overlay toggle.

Post-MVP (explicitly out): diesel generators + fuel, chillers/cooling towers
(two-stage cooling), water usage, day/night tariffs, named contracts,
campaign, achievements. One event ships in MVP: **heatwave** (ambient
temperature and diffusion rise for a window). Grid brownout event lands with
generators later.

## Simulation model

- **Power resolution** (per tick): each rack requests kW for its assigned
  load; demand propagates up the wired chain; any link over capacity clips
  its subtree proportionally (brownout — racks dim, serve less). CRACs draw
  from their own wired chain the same way.
- **Heat field**: scalar °C-like value per grid cell. Each tick: racks add
  heat to their cell ∝ actual kW drawn; simple 4-neighbor diffusion kernel;
  small ambient dissipation; CRACs subtract in radius down to a floor.
  Cheap on a 30×30 grid; freezes on pause like every other system.
- **Rack thermal response**: linear throttle from `throttleStartC` to
  `shutdownC` (0% served at shutdown). Throttled/served ratio is the SLA
  input.
- **Demand**: global kW demand ramps in waves (log growth + milestone
  surges, tuned like Server Survival's RPS curve). Auto-assigned to powered,
  non-shutdown racks proportionally to their headroom. Unserved demand =
  SLA misses → reputation drain; served demand = revenue.
- **Money**: capex per building; opex = $/kW for TOTAL facility draw
  (racks + cooling + chain losses). Revenue per served kWh. This makes PUE
  a profit lever, not just a vanity number.
- **PUE** display: total draw / rack draw, live. Reputation: drifts toward
  SLA compliance ratio. Game over: bankruptcy (< −$500) or reputation 0.

## Invariants (tested, the Server Survival discipline)

- **Conservation**: heat added − heat removed − dissipation = field delta
  (within epsilon); power clipped never exceeds any link capacity; served ≤
  demand; no NaN anywhere in the field or the money path.
- **Pause freezes everything** (field, demand, UPS buffers, events).
- Sim modules are pure (no DOM/THREE imports) → node-env vitest, fast.
- Every tunable in one CONFIG block; every level/wave param data-driven.

## Tech seeding from Server Survival

Copy-and-adapt (not shared-runtime): scene/camera/isometric grid setup, input
handling patterns (drag/wire/demolish, the blur-key fix), i18n system (seed
with **en + ru**, other locales later), toolbar shell, vitest + happy-dom +
THREE-stub test infra, ESLint flat config, CI workflow, launch.json pattern.
The games stay independent repos — divergence is expected and fine; a shared
engine package is a decision for a hypothetical third game, not now (YAGNI).

Module layout mirrors the post-#155 structure: `src/core/` (state, config,
loop glue), `src/sim/` (power.js, heat.js, demand.js — pure), `src/ui/`
(hud, toolbar, overlay), `src/input/`, `src/i18n.js`, `src/locales/`,
`game.js` thin composition root, `tests/`.

## MVP acceptance

A session where: you wire Grid Feed→Transformer→UPS→PDU→3 racks, place 2
CRACs, watch the thermal overlay, survive 3 demand waves; misplacing cooling
visibly overheats and throttles a rack (badge + SLA hit); an overloaded PDU
browns out its racks; heatwave forces a cooling upgrade; PUE responds to
overcooling; bankruptcy and rep-zero both end the game. Verified in a real
browser, sim invariants under vitest in CI.
