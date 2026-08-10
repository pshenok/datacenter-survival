// THE LAB — the knobs behind CONFIG.campaign.levels.the_lab.
//
// Every crisis in this game arrives on a schedule: random in survival,
// scripted in a campaign level. So a player who wants to understand the
// transfer switch has to wait 220 s for an outage and then gets one shot at
// watching it. This module makes the phenomena summonable. It is the WRITE
// half of the rehearsal room — called from game.js, the composition root,
// next to togglePause and togglePeakShave — and src/ui/lab-panel.js reads
// STATE to draw it and writes nothing, per the boundary rule.
//
// STATE fields owned by this module:
//   lab.ambientC   — the heat field's ambient floor (read by sim/heat.js's
//                    currentAmbientC), or null for CONFIG.heat.ambientC
//   lab.tariffBand — a pinned day/night band key (read by sim/demand.js's
//                    tariffBandAt), or null to let the clock run the cycle
//   demandFixedKw  — the demand knob. The SAME field a campaign level pins;
//                    the Lab just lets the player move it
//   tariff.cycleOn — the meter's own on/off position (game.js writes it too)
// lab.on is written by campaign/campaign.js's startLevelState, never here.
//
// Everything else is reached through the code the real events already use:
// the four windows go through campaign.js's applyScriptEvent — the same call
// a level's `script` makes — and the CRAC breakdown through crisis.js's
// breakCrac, the same call the random scheduler makes. A rehearsed outage
// has to BE the outage, or the Lab teaches something the game does not do.
// Each window is then ended by sim/crisis.js and sim/demand.js on their own
// endsAt rules, exactly like a scripted one; nothing here closes a window on
// a timer of its own.
//
// EVERY setter refuses unless a sandbox level is running. That single check
// is the inertness guarantee: with it, the thirteen machine-proven levels
// and survival cannot see this file at all.
//
// Pure sim module — no DOM, no THREE, no timers, no randomness.

import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { levelCfg, applyScriptEvent } from "./campaign.js";
import { breakCrac } from "../sim/crisis.js";

// Knob travel. Demand tops out well past what the handed-over room can
// serve, because "ask for more than the room has" is one of the things worth
// rehearsing; ambient tops out at the rack's throttleStartC, so the knob can
// walk the room to the exact edge of throttling and no further by accident.
export const LAB_LIMITS = {
    demandKw: { min: 0, max: 40, step: 2 },
    ambientC: { min: 10, max: CONFIG.buildings.rack.throttleStartC + 1, step: 2 },
};

// The five things the Fire buttons summon, each built from the CONFIG the
// real event bills from — never a number typed here.
//
// A random window's duration is a RANGE (min..max, drawn from the rng). Sim
// modules never roll dice, so the Lab fires the MIDPOINT: the length of an
// average real one, and the same every time, which is what makes it a
// rehearsal rather than another draw.
const mid = (cfg) => (cfg.minDurationSec + cfg.maxDurationSec) / 2;

export const LAB_EVENTS = ["heatwave", "brownout", "outage", "tariff", "crac_fail"];

function eventSpec(kind) {
    const ev = CONFIG.events;
    switch (kind) {
        case "heatwave":
            return { kind, durationSec: ev.heatwave.durationSec };
        case "brownout":
            return { kind, durationSec: mid(ev.brownout), factor: ev.brownout.capacityFactor };
        case "outage":
            // "all" is the survival default: the scoped variant is a
            // two_utilities lesson and needs a floor laid out for it.
            return { kind, durationSec: mid(ev.gridOutage), scope: "all" };
        case "tariff":
            return { kind, durationSec: mid(ev.tariff), multiplier: ev.tariff.multiplier };
        default:
            return null;
    }
}

// Is a sandbox level running? The one question the UI asks before it draws
// the panel, and the one every setter below asks before it writes.
export function isLab() {
    return STATE.lab.on === true;
}

function clamp(value, { min, max }) {
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, value));
}

// ---- the knobs -----------------------------------------------------------

// Demand, in kW. Writes the same STATE.demandFixedKw a campaign level pins,
// so the demand curve and its waves stay switched off — the number on the
// HUD is the number the knob says, which is the point of a lab.
export function setLabDemandKw(kw) {
    if (!isLab()) return false;
    const v = clamp(kw, LAB_LIMITS.demandKw);
    if (v === null) return false;
    STATE.demandFixedKw = v;
    return true;
}

// Ambient, in °C — the heat field's floor. Carried in STATE and read by
// sim/heat.js; CONFIG.heat.ambientC is never written, because a written-back
// CONFIG value survives resetState() into every later run.
export function setLabAmbientC(c) {
    if (!isLab()) return false;
    const v = clamp(c, LAB_LIMITS.ambientC);
    if (v === null) return false;
    STATE.lab.ambientC = v;
    return true;
}

// The meter, in four positions:
//   "auto"  — the day/night cycle runs off the clock (the Lab's default)
//   "night" | "day" — that band, pinned, until you say otherwise
//   "off"   — no time-of-use meter at all, a flat x1.0 bill
// Two STATE fields express it because they are two different facts: whether
// the cycle runs at all (tariff.cycleOn, which game.js already owns for free
// play) and which band it is standing in (lab.tariffBand). labTariffMode()
// below reads them back so the panel never keeps a copy of its own.
export function setLabTariffBand(mode) {
    if (!isLab()) return false;
    if (mode === "off") {
        STATE.tariff.cycleOn = false;
        STATE.lab.tariffBand = null;
        return true;
    }
    if (mode === "auto") {
        STATE.tariff.cycleOn = true;
        STATE.lab.tariffBand = null;
        return true;
    }
    if (!CONFIG.tariff.bands.some((b) => b.key === mode)) return false;
    STATE.tariff.cycleOn = true;
    STATE.lab.tariffBand = mode;
    return true;
}

// Which position the meter knob is in, derived from STATE — the panel is a
// view over this, not a second source of truth.
export function labTariffMode() {
    if (!STATE.tariff.cycleOn) return "off";
    return STATE.lab.tariffBand === null ? "auto" : STATE.lab.tariffBand;
}

// ---- fire now ------------------------------------------------------------

// Open one window NOW, at the clock the rest of the simulation is reading.
// Windows are anchored to STATE.elapsedGameTime because that is the only
// "now" there is: sim/crisis.js and sim/demand.js close them by comparing
// that same clock against the endsAt this writes.
export function fireLabEvent(kind) {
    if (!isLab()) return false;
    const at = STATE.elapsedGameTime;

    if (kind === "crac_fail") {
        // The random scheduler picks a powered, unbroken CRAC at random;
        // with no rng in a sim module the Lab takes the first one, which is
        // the same failure on a named victim. Nothing to break is a refusal,
        // not a silent success — the panel has no CRAC to point at either.
        const victim = STATE.buildings.find((b) => b.type === "crac" && b.powered && !b.broken);
        return breakCrac(victim, at);
    }

    const spec = eventSpec(kind);
    if (!spec) return false;
    // applyScriptEvent answers whether it really opened a window: a second
    // outage on top of a running one is a refusal, not a silent success.
    return applyScriptEvent(spec, at);
}

// ---- reset ---------------------------------------------------------------

// Every knob back to where the level handed it over, and every window the
// Fire buttons can open closed again.
//
// It does NOT undo the room: buildings you placed stay placed, a tripped
// breaker stays open until you push the handle back in, and a broken CRAC
// still self-repairs on its own 45 s clock — those clocks are among the
// things the Lab exists to let you watch.
export function resetLab() {
    if (!isLab()) return false;
    const cfg = levelCfg(STATE.campaign.levelId);
    STATE.demandFixedKw = cfg ? cfg.demandKw : 0;
    STATE.lab.ambientC = null;
    STATE.lab.tariffBand = null;
    STATE.tariff.cycleOn = cfg ? cfg.tariffCycle === true : false;
    STATE.heatwave.active = false;
    STATE.brownout.active = false;
    STATE.brownout.factor = 1;
    STATE.gridOutage.active = false;
    // Same pair sim/crisis.js restores when a peak window closes, and the
    // same pair campaign.js's resolve() clears: the multiplier outlives the
    // window otherwise and quietly triples the bill forever.
    STATE.tariff.active = false;
    STATE.tariff.multiplier = 1;
    return true;
}
