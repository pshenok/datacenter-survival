// preBuilt — a level can hand the player a RUNNING facility instead of an
// empty floor. Server Survival's single biggest pedagogy multiplier: a blank
// floor can only teach construction, but a prebuilt board can teach
// DIAGNOSIS, which is the actual job. It also makes "delete the wrong thing"
// a legal, teachable move, which an empty floor can never express.
//
// Pure on purpose (no DOM, no THREE): tests/campaign.test.mjs machine-plays
// prebuilt levels with the same three lines it uses for every other level,
// and game.js does a mesh pass over the result. Server Survival buries the
// equivalent loop inside its UI, which is exactly why it cannot test it.
//
// Schema (CONFIG.campaign.levels[id].preBuilt):
//   buildings: [{ type, gx, gz }]              — index order is the wire ref
//   wires:     [[parentIdx, childIdx]]         — applied in order
//   standby:   [[generatorIdx, childIdx]]      — transfer-switch edges
//
// The buildings are free (they are scenery the level starts with, not a
// purchase), and no ban applies to them — a level may hand you the very
// thing it forbids you to build more of.
import { CONFIG } from "../core/config.js";

import { placeBuilding, connect } from "../sim/build.js";

export function applyPreBuilt(levelId) {
    const cfg = CONFIG.campaign.levels[levelId];
    const spec = cfg && cfg.preBuilt;
    if (!spec) return [];

    const made = [];
    for (const b of spec.buildings) {
        const built = placeBuilding(b.type, b.gx, b.gz, { free: true });
        if (typeof built === "string") {
            throw new Error(`preBuilt(${levelId}): ${b.type} at ${b.gx},${b.gz} -> ${built}`);
        }
        made.push(built);
    }
    // Standby edges must be applied AFTER the primary wires, or the generator
    // would become an ordinary parent of a child that has no feed yet.
    for (const [from, to] of spec.wires || []) connect(made[from], made[to]);
    for (const [from, to] of spec.standby || []) connect(made[from], made[to]);

    // Power has to resolve once before the player looks at the board,
    // otherwise every prebuilt load renders unpowered for a frame.
    return made;
}

// Does this level start with a room instead of a floor?
export function hasPreBuilt(levelId) {
    const cfg = CONFIG.campaign.levels[levelId];
    return !!(cfg && cfg.preBuilt);
}

// A prebuilt level's own topology, for the tests that pin it.
export function preBuiltSpec(levelId) {
    const cfg = CONFIG.campaign.levels[levelId];
    return (cfg && cfg.preBuilt) || null;
}
