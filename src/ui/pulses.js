// Energy pulses — the board's life. Small glowing dots travel along every
// wire that carries power, at a rate proportional to the carried kW. This is
// Datacenter Survival's answer to Server Survival's flying requests: you SEE
// the electricity move, and a browned-out or dead branch goes visibly still.
// Pooled sprites, no per-frame allocation.
import { STATE } from "../core/state.js";
import { scene } from "./scene.js";

const POOL = 90;
const pool = [];
let poolBuilt = false;

function buildPool() {
    const geo = new THREE.SphereGeometry(0.45, 6, 6);
    for (let i = 0; i < POOL; i++) {
        const m = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.9 })
        );
        m.visible = false;
        scene.add(m);
        pool.push({ mesh: m, wire: null, t: 0, speed: 1 });
    }
    poolBuilt = true;
}

function carriedKw(wire) {
    const to = STATE.buildings.find((b) => b.id === wire.to);
    return to ? Math.max(0, to.actualKw) : 0;
}

let spawnAcc = 0;

export function tickPulses(dt) {
    if (!poolBuilt) buildPool();

    // advance live pulses
    for (const p of pool) {
        if (!p.wire) continue;
        p.t += dt * p.speed;
        if (p.t >= 1 || !STATE.wires.includes(p.wire)) {
            p.wire = null;
            p.mesh.visible = false;
            continue;
        }
        const from = STATE.buildings.find((b) => b.id === p.wire.from);
        const to = STATE.buildings.find((b) => b.id === p.wire.to);
        if (!from || !to || !from.mesh || !to.mesh) { p.wire = null; p.mesh.visible = false; continue; }
        p.mesh.position.lerpVectors(from.mesh.position, to.mesh.position, p.t);
        p.mesh.position.y = 0.6;
    }

    // spawn on carrying wires, heavier flow = more pulses
    spawnAcc += dt;
    if (spawnAcc < 0.12) return;
    spawnAcc = 0;
    for (const wire of STATE.wires) {
        const kw = carriedKw(wire);
        if (kw <= 0.05) continue;
        if (Math.random() > Math.min(0.85, kw / 8)) continue;
        const slot = pool.find((p) => !p.wire);
        if (!slot) return;
        slot.wire = wire;
        slot.t = 0;
        slot.speed = 0.9 + Math.min(1.6, kw / 6);
        slot.mesh.visible = true;
    }
}
