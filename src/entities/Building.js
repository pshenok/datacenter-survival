// A placed building. Deliberately THREE-free: the UI layer attaches `mesh`
// after construction, so sim modules and node-env tests use the same class.
import { CONFIG } from "../core/config.js";

let nextId = 1;

export class Building {
    constructor(type, gx, gz) {
        this.id = "b" + nextId++;
        this.type = type;
        this.config = CONFIG.buildings[type];
        this.gx = gx;                // grid coords, 0..gridSize-1
        this.gz = gz;

        // Power topology (owned by sim/power.js via topology helpers):
        // a chain node has at most one parent wire and any number of children.
        // Sources are born with the implicit "grid" parent — both sim modules
        // key on that exact value to recognise a live root.
        this.parentId = this.config.chainRole === "source" ? "grid" : null;
        this.childIds = [];

        // Per-tick power resolution results (owned by sim/power.js):
        this.assignedKw = 0;         // what demand assignment asked of a rack
        this.actualKw = 0;           // what the chain actually delivered
        this.powered = false;

        // Thermal (owned by sim/heat.js):
        this.tempC = CONFIG.heat.ambientC;
        this.throttleFactor = 1;     // 1 = full service, 0 = thermal shutdown

        // CRAC duty cycle (owned by sim/heat.js): 0..1 of coolPerSec applied.
        this.duty = 0;

        // Litres this plant's cooling tower is evaporating right now, at the
        // billing scale (owned by sim/heat.js). Stored rather than recomputed
        // for the same reason actualKw is: the inspector must show the number
        // the meter charges, and a formula restated in the HUD is a formula
        // that can disagree with the simulation. 0 for everything that is not
        // an evaporatively cooled plant — a CRAC never drinks.
        this.waterLitersPerHour = 0;

        // CRAC breakdown (owned by sim/crisis.js): while broken, sim/heat.js
        // forces duty to 0; repairAt is the game time of the free self-repair.
        this.broken = false;
        this.repairAt = 0;

        // UPS buffer seconds remaining (owned by sim/power.js).
        this.bufferLeft = type === "ups" ? this.config.bufferSec : 0;

        // ENERGY (kW.s) the battery still owes itself — what actually left
        // it, not what a nameplate refill would cost. Owned by sim/power.js:
        // the outage bridge and peak shaving add the energy they really
        // delivered, the charger works it back down. bufferLeft counts
        // SECONDS and the bridge spends them at the UPS's full rating
        // whatever it is carrying, so the two are not interchangeable — a
        // UPS that bridged a light room has burned its seconds without
        // burning the matching energy, and billing it for the seconds is
        // what made a recharge cost three times what the outage did.
        this.bufferOwedKws = 0;

        // The charger's request this tick (kW), written by sim/power.js's
        // pull phase so the link ABOVE this UPS has to carry it: a
        // recharging UPS is a load on its own upstream, clipped by that
        // upstream's capacity and burning a generator's fuel when the
        // generator is the one carrying it.
        this.rechargeReqKw = 0;

        // UPS status this tick (owned by sim/power.js): "idle" | "charging"
        // | "shaving" (peak shaving, draining into the meter's expensive
        // window) | "bridging" (existing outage self-grant). Read by the
        // inspect panel so it never has to re-derive what the buffer is
        // doing from bufferLeft's trend.
        this.upsMode = "idle";

        // How much demand this link had to refuse this tick because it hit
        // its kW cap. Diagnostic only — written by sim/power.js, read by
        // sim/attribution.js to name the link that starved a rack.
        this.clippedKw = 0;

        // What the subtree ASKED this link for, before its cap clipped it.
        // The overload signal has to be the demanded load, not the carried
        // one — a link pinned at its rating carries exactly 100% forever.
        this.demandedKw = 0;

        // Breaker (owned by sim/power.js): thermal accumulator and state.
        // A tripped link is a dead root until the player clicks it.
        this.breakerHeat = 0;
        this.tripped = false;

        // Planned maintenance (owned by sim/maintenance.js). Out-for-service
        // gear is dead gear — see isDeadGear() in sim/power.js — but it is
        // NOT a fault: no breaker heat accrues and the ledger names it as
        // planned work.
        this.outForService = false;
        this.serviceLeftSec = 0;

        // Generator (owned by sim/power.js + sim/crisis.js): born with a
        // full tank; standby children list is the transfer switch — those
        // buildings keep their primary feed and fall to this generator only
        // when that path dies, after cutoverSec.
        this.fuelLiters = type === "generator" ? this.config.tankLiters : 0;
        this.fuelArrivesAt = null;      // game time a paid refill lands, or null
        this.cutoverLeft = type === "generator" ? this.config.cutoverSec : 0;
        this.standbyParentId = null;    // set on the CHILD of a standby edge

        this.mesh = null;            // attached by the UI layer only
    }
}

export function resetBuildingIds() {
    nextId = 1;
}
