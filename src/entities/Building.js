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

        // UPS buffer seconds remaining (owned by sim/power.js).
        this.bufferLeft = type === "ups" ? this.config.bufferSec : 0;

        this.mesh = null;            // attached by the UI layer only
    }
}

export function resetBuildingIds() {
    nextId = 1;
}
