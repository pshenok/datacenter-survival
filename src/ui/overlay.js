// Thermal overlay — the game's signature visual. A translucent plane over the
// floor whose texture is painted from STATE.heatField every few frames: deep
// blue at ambient through amber to red past rack-shutdown temperature.
// Toggled with T; cheap (one 30x30 canvas upload).
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { scene } from "./scene.js";

const N = CONFIG.gridSize;
const canvas = document.createElement("canvas");
canvas.width = N;
canvas.height = N;
const ctx = canvas.getContext("2d");
const img = ctx.createImageData(N, N);

const texture = new THREE.CanvasTexture(canvas);
texture.magFilter = THREE.LinearFilter;
texture.minFilter = THREE.LinearFilter;

const worldSize = N * CONFIG.tileSize;
const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(worldSize, worldSize),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.55, depthWrite: false })
);
plane.rotation.x = -Math.PI / 2;
plane.position.y = 0.15;
plane.visible = false;
scene.add(plane);

let enabled = false;
let repaintAcc = 0;

// ambient -> shutdown mapped over blue -> cyan -> amber -> red
function heatColor(t) {
    const lo = CONFIG.heat.ambientC;
    const hi = CONFIG.buildings.rack.shutdownC;
    const u = Math.max(0, Math.min(1, (t - lo) / (hi - lo)));
    if (u < 0.33) { const k = u / 0.33; return [Math.round(30 + 30 * k), Math.round(80 + 140 * k), 235, 90]; }
    if (u < 0.66) { const k = (u - 0.33) / 0.33; return [Math.round(60 + 190 * k), Math.round(220 - 60 * k), Math.round(235 - 190 * k), 140]; }
    const k = (u - 0.66) / 0.34;
    return [Math.round(250), Math.round(160 - 130 * k), Math.round(45 - 35 * k), 190];
}

export function toggleThermalOverlay(force) {
    enabled = force !== undefined ? force : !enabled;
    plane.visible = enabled;
    if (enabled) repaint();
    return enabled;
}
export function isThermalOverlayOn() {
    return enabled;
}

function repaint() {
    const f = STATE.heatField;
    for (let i = 0; i < f.length; i++) {
        const [r, g, b, a] = heatColor(f[i]);
        const o = i * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    texture.needsUpdate = true;
}

// Called from the frame loop; repaints at ~5 Hz while visible.
export function tickOverlay(dt) {
    if (!enabled) return;
    repaintAcc += dt;
    if (repaintAcc >= 0.2) {
        repaintAcc = 0;
        repaint();
    }
}
