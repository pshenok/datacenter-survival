// Build actions — the SIM half of placing, wiring and demolishing.
//
// These used to live inside src/input/handlers.js, tangled with meshes and
// banners, which meant the campaign could never machine-play a level that
// required DEMOLISHING something. They are pure now (STATE + money + wire
// records only); the UI layer keeps the THREE side and calls these for the
// rules. Every wire record this module creates is meshless — attachWireMesh
// walks STATE.wires afterwards.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { Building } from "../entities/Building.js";
import { wireBuildings, unwire } from "./power.js";
import { missOrdersForBuilding } from "./maintenance.js";

let wireId = 1;

export function resetWireIds() {
    wireId = 1;
}

// Levels may forbid a building that would bypass the mechanic they teach.
export function isBanned(type) {
    const id = STATE.campaign.levelId;
    if (id === null) return false;
    const cfg = CONFIG.campaign.levels[id];
    return !!(cfg && cfg.banned && cfg.banned.includes(type));
}

// Returns the Building, or a reason string the UI can turn into a banner.
export function placeBuilding(type, gx, gz, { free = false } = {}) {
    const cfg = CONFIG.buildings[type];
    if (!cfg) return "unknown";
    // `free` is the preBuilt path: a level may HAND you the very thing it
    // forbids you to build more of (two_utilities bans generators and still
    // starts you with feeds). The ban gates the player's toolbar, not the
    // scenery — and applyPreBuilt would otherwise throw at level start.
    if (!free && isBanned(type)) return "banned";
    if (!free && STATE.money < cfg.cost) return "poor";
    if (STATE.buildings.some((b) => b.gx === gx && b.gz === gz)) return "occupied";
    const b = new Building(type, gx, gz);
    if (!free) STATE.money -= cfg.cost;
    STATE.buildings.push(b);
    return b;
}

// Wire parent -> child and record the edge. Returns the wire record (so the
// UI can attach a mesh), or null if the edge was illegal.
export function connect(parent, child) {
    if (!wireBuildings(parent, child)) return null;
    const standby = child.standbyParentId === parent.id;
    const stale = dropWireRecord(child.id, standby);
    const wire = { id: "w" + wireId++, from: parent.id, to: child.id, standby, mesh: null };
    STATE.wires.push(wire);
    return { wire, stale };
}

// Remove a recorded edge into `childId`. Returns the removed record (the UI
// disposes its mesh) or null.
export function dropWireRecord(childId, standby = false) {
    const idx = STATE.wires.findIndex((w) => w.to === childId && !!w.standby === standby);
    if (idx === -1) return null;
    return STATE.wires.splice(idx, 1)[0];
}

// Demolish: cut this building's own feed, cut its children loose (they keep
// their standby edges — a paid transfer switch outlives its primary), drop
// every standby edge pointing AT it, refund half, and miss any work order
// still open on it — an order cannot survive the gear it targets, or
// tickMaintenance counts an orphaned order down to "done" and the level
// credits completed maintenance on a building that no longer exists. Returns
// the wire records the caller must dispose.
export function demolishBuilding(b) {
    const dropped = [];
    const take = (rec) => { if (rec) dropped.push(rec); };

    missOrdersForBuilding(b.id);
    unwire(b);
    take(dropWireRecord(b.id));
    take(dropWireRecord(b.id, true));
    for (const cid of [...b.childIds]) {
        const child = STATE.buildings.find((x) => x.id === cid);
        if (child) {
            unwire(child);
            take(dropWireRecord(child.id));
        }
    }
    for (const other of STATE.buildings) {
        if (other.standbyParentId === b.id) {
            other.standbyParentId = null;
            take(dropWireRecord(other.id, true));
        }
    }
    STATE.buildings = STATE.buildings.filter((x) => x.id !== b.id);
    STATE.money += Math.floor(b.config.cost / 2);
    return dropped;
}
