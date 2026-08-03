// Thermal overlay — the game's signature visual. A translucent plane over the
// floor whose texture is painted from STATE.heatField every few frames: deep
// blue at ambient through amber to red past rack-shutdown temperature.
// Toggled with T; cheap (one 30x30 canvas upload).
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { scene } from "./scene.js";
import { i18n } from "../i18n.js";

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
export function heatColor(t) {
    const lo = CONFIG.heat.ambientC;
    const hi = CONFIG.buildings.rack.shutdownC;
    const u = Math.max(0, Math.min(1, (t - lo) / (hi - lo)));
    if (u < 0.33) { const k = u / 0.33; return [Math.round(30 + 30 * k), Math.round(80 + 140 * k), 235, 90]; }
    if (u < 0.66) { const k = (u - 0.33) / 0.33; return [Math.round(60 + 190 * k), Math.round(220 - 60 * k), Math.round(235 - 190 * k), 140]; }
    const k = (u - 0.66) / 0.34;
    return [Math.round(250), Math.round(160 - 130 * k), Math.round(45 - 35 * k), 190];
}

// ---- legend -------------------------------------------------------------
// The colours mean nothing until the two numbers behind them are on screen:
// racks start throttling at throttleStartC and stop at shutdownC. Built by
// sampling the SAME heatColor() the floor uses, so the legend can never
// disagree with what the player is looking at, and labelled from CONFIG so
// a retune cannot leave a stale number here.
//
// Deliberate: the scale's low anchor stays at the static ambientC even
// during a heatwave (heatColor keys on it too). A scale that slides under
// the player defeats the only purpose a legend has.
const LO = CONFIG.heat.ambientC;
const HI = CONFIG.buildings.rack.shutdownC;
const THROTTLE = CONFIG.buildings.rack.throttleStartC;

// Rebuilt on every toggle-on (25 gradient stops is cheap) and marked with
// data-i18n so i18n.applyTranslations() re-labels it on a locale switch —
// a cached DOM here left the legend permanently half-translated.
function buildLegend() {
    const host = document.getElementById("overlay-legend");
    if (!host) return;
    const stops = [];
    for (let i = 0; i <= 24; i++) {
        const [r, g, b] = heatColor(LO + (HI - LO) * (i / 24));
        stops.push(`rgb(${r},${g},${b}) ${Math.round((i / 24) * 100)}%`);
    }
    const pct = (t) => ((t - LO) / (HI - LO)) * 100;
    host.innerHTML =
        `<div class="text-[9px] text-gray-400 uppercase tracking-wide mb-1" data-i18n="legend_title">${i18n.t("legend_title")}</div>` +
        `<div class="relative h-2 rounded-sm" style="background:linear-gradient(90deg,${stops.join(",")})">` +
        `<span class="absolute -top-0.5 h-3 w-px bg-white/80" style="left:${pct(THROTTLE)}%"></span>` +
        `</div>` +
        `<div class="relative text-[9px] text-gray-400 mt-0.5 h-3">` +
        `<span class="absolute left-0">${LO}°</span>` +
        `<span class="absolute -translate-x-1/2 text-amber-200" style="left:${pct(THROTTLE)}%">${THROTTLE}°</span>` +
        `<span class="absolute right-0 text-red-300">${HI}°</span>` +
        `</div>` +
        `<div class="text-[9px] text-gray-500 mt-1" data-i18n="legend_throttle">${i18n.t("legend_throttle")}</div>` +
        `<div id="legend-hottest" class="text-[10px] text-gray-300 mt-1"></div>`;
}

function updateLegend() {
    const el = document.getElementById("legend-hottest");
    if (!el) return;
    let hottest = LO;
    const f = STATE.heatField;
    for (let i = 0; i < f.length; i++) if (f[i] > hottest) hottest = f[i];
    el.textContent = i18n.t("legend_hottest", { t: hottest.toFixed(1) });
    el.className = `text-[10px] mt-1 ${hottest >= THROTTLE ? "text-red-300 font-bold" : "text-gray-300"}`;
}

export function toggleThermalOverlay(force) {
    enabled = force !== undefined ? force : !enabled;
    plane.visible = enabled;
    const legend = document.getElementById("overlay-legend");
    if (legend) {
        if (enabled) buildLegend();
        legend.classList.toggle("hidden", !enabled);
    }
    if (enabled) {
        repaint();
        updateLegend();
    }
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
        updateLegend();
    }
}
