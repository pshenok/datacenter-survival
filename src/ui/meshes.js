// Building mesh factory + wire lines. Shapes are simple primitives with a
// per-type silhouette; state tinting (unpowered/hot) happens in tickMeshes.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { buildingGroup, wireGroup, gridToWorld } from "./scene.js";

const T = CONFIG.tileSize;

export function attachMesh(b) {
    const color = CONFIG.colors[b.type] || 0xffffff;
    const mat = new THREE.MeshLambertMaterial({ color });
    let mesh;
    switch (b.type) {
        case "grid_feed":
            mesh = new THREE.Mesh(new THREE.CylinderGeometry(T * 0.22, T * 0.34, T * 0.9, 6), mat);
            mesh.position.y = T * 0.45;
            break;
        case "transformer":
            mesh = new THREE.Mesh(new THREE.BoxGeometry(T * 0.62, T * 0.5, T * 0.62), mat);
            mesh.position.y = T * 0.25;
            break;
        case "ups":
            mesh = new THREE.Mesh(new THREE.BoxGeometry(T * 0.5, T * 0.66, T * 0.5), mat);
            mesh.position.y = T * 0.33;
            break;
        case "pdu":
            mesh = new THREE.Mesh(new THREE.CylinderGeometry(T * 0.3, T * 0.3, T * 0.34, 8), mat);
            mesh.position.y = T * 0.17;
            break;
        case "generator": {
            mesh = new THREE.Mesh(new THREE.BoxGeometry(T * 0.72, T * 0.44, T * 0.5), mat);
            mesh.position.y = T * 0.22;
            const stack = new THREE.Mesh(
                new THREE.CylinderGeometry(T * 0.06, T * 0.06, T * 0.34, 6),
                new THREE.MeshBasicMaterial({ color: 0x525252 })
            );
            stack.position.set(T * 0.24, T * 0.36, -T * 0.14);
            stack.name = "stack";
            mesh.add(stack);
            break;
        }
        case "rack": {
            mesh = new THREE.Mesh(new THREE.BoxGeometry(T * 0.44, T * 1.0, T * 0.62), mat);
            mesh.position.y = T * 0.5;
            // front "LED strip" — tinted by load in tickMeshes
            const led = new THREE.Mesh(
                new THREE.BoxGeometry(T * 0.46, T * 0.08, T * 0.1),
                new THREE.MeshBasicMaterial({ color: 0x113311 })
            );
            led.position.set(0, T * 0.3, T * 0.28);
            led.name = "led";
            mesh.add(led);
            break;
        }
        case "crac": {
            mesh = new THREE.Mesh(new THREE.BoxGeometry(T * 0.7, T * 0.58, T * 0.42), mat);
            mesh.position.y = T * 0.29;
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(T * 0.18, T * 0.045, 8, 20),
                new THREE.MeshBasicMaterial({ color: 0xbfdbfe })
            );
            ring.position.set(0, 0, T * 0.24);
            ring.name = "fan";
            mesh.add(ring);
            break;
        }
        default:
            mesh = new THREE.Mesh(new THREE.BoxGeometry(T * 0.5, T * 0.5, T * 0.5), mat);
            mesh.position.y = T * 0.25;
    }
    const w = gridToWorld(b.gx, b.gz);
    mesh.position.x = w.x;
    mesh.position.z = w.z;
    mesh.userData.buildingId = b.id;
    b.mesh = mesh;
    buildingGroup.add(mesh);
    return mesh;
}

export function removeMesh(b) {
    if (!b.mesh) return;
    buildingGroup.remove(b.mesh);
    b.mesh.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    b.mesh = null;
}

export function addWireMesh(wire, fromB, toB) {
    const a = fromB.mesh.position, c = toB.mesh.position;
    const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, 0.4, a.z),
        new THREE.Vector3((a.x + c.x) / 2, 0.4, (a.z + c.z) / 2),
        new THREE.Vector3(c.x, 0.4, c.z),
    ]);
    // Standby edges (transfer switch) read as "not carrying" — muted grey.
    const color = wire.standby ? CONFIG.colors.wireStandby : CONFIG.colors.wire;
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    wire.mesh = line;
    wireGroup.add(line);
}

export function removeWireMesh(wire) {
    if (!wire.mesh) return;
    wireGroup.remove(wire.mesh);
    wire.mesh.geometry.dispose();
    wire.mesh.material.dispose();
    wire.mesh = null;
}

// Per-frame state tinting: unpowered = dark, rack LED by load, hot = red pulse,
// CRAC fan spins with duty.
export function tickMeshes(dt) {
    for (const b of STATE.buildings) {
        if (!b.mesh) continue;
        const base = CONFIG.colors[b.type];
        if (b.broken) {
            b.mesh.material.color.setHex(0x7f1d1d); // broken CRAC: dark red
        } else if (b.type === "generator") {
            // Dry tank = dark; carrying = amber glow; idle standby = base.
            if (b.fuelLiters <= 0) b.mesh.material.color.setHex(0x37414d);
            else if (b.actualKw > 0) b.mesh.material.color.setHex(0xf59e0b);
            else b.mesh.material.color.setHex(base);
        } else if (b.config.chainRole === "load" && !b.powered) {
            b.mesh.material.color.setHex(0x37414d);
        } else if (b.type === "rack" && b.tempC >= b.config.throttleStartC) {
            const k = Math.min(1, (b.tempC - b.config.throttleStartC) / (b.config.shutdownC - b.config.throttleStartC));
            b.mesh.material.color.setHex(base).lerp(new THREE.Color(0xef4444), k);
        } else {
            b.mesh.material.color.setHex(base);
        }
        if (b.type === "rack") {
            const led = b.mesh.getObjectByName("led");
            if (led) {
                const u = b.config.capacityKw ? b.actualKw / b.config.capacityKw : 0;
                led.material.color.setRGB(0.1 + 0.8 * u, 0.9 - 0.6 * u, 0.15);
            }
        }
        if (b.type === "crac") {
            const fan = b.mesh.getObjectByName("fan");
            if (fan) fan.rotation.z += dt * 6 * (b.duty || 0);
        }
    }
}
