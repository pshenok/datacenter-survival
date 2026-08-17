// Input layer: camera pan/zoom, tool selection, placement, wiring, demolish,
// keyboard shortcuts. Carries the Server Survival lessons: blur clears held
// keys; occupied-tile placement rejected; all listeners are module side
// effects registered once.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { placeBuilding as simPlace, connect as simConnect, demolishBuilding as simDemolish } from "../sim/build.js";
import { repairCrac, orderFuel, resetBreaker } from "../sim/crisis.js";
import { pendingOrderFor, openServiceWindow } from "../sim/maintenance.js";
import { camera, cameraTarget, renderer, worldToGrid, buildingGroup, focusWorld } from "../ui/scene.js";
import { attachMesh, addWireMesh, removeWireMesh, removeMesh } from "../ui/meshes.js";
import { markActiveTool, refreshAffordability } from "../ui/toolbar.js";
import { renderInspect, showBanner } from "../ui/hud.js";
import { toggleThermalOverlay } from "../ui/overlay.js";
import { notifyOverlayToggled } from "../ui/tutorial.js";
import { i18n } from "../i18n.js";

export let activeTool = "select";
let wireSource = null;          // first click of the wire tool
let selectedId = null;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const container = document.getElementById("canvas-container");

function pick(clientX, clientY) {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(buildingGroup.children, true);
    if (hits.length) {
        let o = hits[0].object;
        while (o && !o.userData.buildingId) o = o.parent;
        if (o) return { building: STATE.buildings.find((b) => b.id === o.userData.buildingId) };
    }
    const pt = new THREE.Vector3();
    raycaster.ray.intersectPlane(groundPlane, pt);
    return pt ? { ground: worldToGrid(pt.x, pt.z) } : {};
}

export function setTool(tool) {
    activeTool = tool;
    window.__activeToolForTutorial = tool;
    wireSource = null;
    document.getElementById("wire-hint").classList.toggle("hidden", tool !== "wire");
    markActiveTool(tool);
}

// UI wrapper around the pure rule (src/sim/build.js): mesh + banner only.
function placeBuilding(type, gx, gz) {
    const result = simPlace(type, gx, gz);
    if (result === "banned") {
        showBanner(i18n.t("lv_banned"), 2500);
        return;
    }
    if (typeof result === "string") return;   // poor / occupied — silent, as before
    attachMesh(result);
    refreshAffordability();
}

function handlePrimary(e) {
    const hit = pick(e.clientX, e.clientY);

    if (CONFIG.buildings[activeTool]) {
        if (hit.ground) placeBuilding(activeTool, hit.ground.gx, hit.ground.gz);
        return;
    }
    if (activeTool === "wire") {
        if (!hit.building) { wireSource = null; return; }
        if (!wireSource) {
            wireSource = hit.building;
            showBanner(i18n.t("wire_hint"), 1500);
        } else if (wireSource !== hit.building) {
            // A generator wired to an already-fed child becomes a STANDBY edge
            // (transfer switch) — grey wire — replacing only a previous
            // standby, never the primary feed. sim/build.js owns that rule.
            const made = simConnect(wireSource, hit.building);
            if (made) {
                if (made.stale) removeWireMesh(made.stale);
                addWireMesh(made.wire, wireSource, hit.building);
            }
            wireSource = null;
        }
        return;
    }
    if (activeTool === "demolish") {
        if (hit.building) {
            for (const wire of simDemolish(hit.building)) removeWireMesh(wire);
            removeMesh(hit.building);
            if (selectedId === hit.building.id) { selectedId = null; renderInspect(null); }
            refreshAffordability();
        }
        return;
    }
    // select. Clicking a broken CRAC is the paid repair (fee in the banner
    // and inspect panel); the repair banner itself comes from game.js's
    // broken-set diff. A refusal here can only mean "can't afford it".
    if (hit.building && hit.building.broken) {
        if (repairCrac(hit.building)) {
            refreshAffordability();
        } else {
            showBanner(i18n.t("repair_no_funds", { cost: CONFIG.events.cracBreakdown.repairCost }), 2500);
        }
    }
    // Clicking a tripped link pushes its handle back in. Captured before the
    // reset: gear that is ALSO a maintenance target must not go straight
    // from "tripped" to "out for service" in the same click, or a bus that
    // is overloaded for a real reason could be pulled from service without
    // the player ever seeing whether that was safe.
    const wasTripped = !!(hit.building && hit.building.tripped);
    if (wasTripped) {
        resetBreaker(hit.building);
        showBanner(i18n.t("breaker_reset"), 3000);
    }
    // Clicking gear with a pending work order opens its service window. Same
    // click as pushing a breaker handle back in — the player already knows
    // that gesture, and a second tool for a once-a-level action is clutter —
    // unless the gear was tripped this same click: openServiceWindow refuses
    // (and mutates nothing) over an unresolved trip, so a bus that just had
    // its fault cleared gets a banner saying the window still needs another
    // click, not the "opened" banner claiming it already happened.
    if (hit.building && pendingOrderFor(hit.building)) {
        if (wasTripped) {
            showBanner(i18n.t("maint_blocked", { name: i18n.t("b_" + hit.building.type) }), 4000);
        } else if (openServiceWindow(hit.building)) {
            showBanner(i18n.t("maint_opened", { name: i18n.t("b_" + hit.building.type) }), 4000);
        }
    }
    // Clicking a generator below a full tank orders the refill truck.
    if (hit.building && hit.building.type === "generator") {
        const g = hit.building;
        if (orderFuel(g, STATE.elapsedGameTime)) {
            showBanner(i18n.t("fuel_ordered", { s: g.config.fuelDeliverySec }), 3000);
            refreshAffordability();
        } else if (g.fuelArrivesAt === null && g.fuelLiters < g.config.tankLiters) {
            showBanner(i18n.t("repair_no_funds", { cost: g.config.fuelCost }), 2500);
        }
    }
    selectedId = hit.building ? hit.building.id : null;
    renderInspect(hit.building || null);
}

// clearWorld() hides the panel and restarts building ids at b1, but the
// module-scope selection outlived both: the next run's b1 is a different
// building, and the inspector re-opened on it a frame later without anyone
// clicking anything.
export function clearSelection() {
    selectedId = null;
}

export function tickInspect() {
    if (!selectedId) return;
    const b = STATE.buildings.find((x) => x.id === selectedId);
    if (!b) { selectedId = null; renderInspect(null); return; }
    renderInspect(b);
}

// ---- camera ----
let isPanning = false, lastX = 0, lastY = 0;
const keys = {};

container.addEventListener("contextmenu", (e) => e.preventDefault());
container.addEventListener("mousedown", (e) => {
    if (!STATE.isRunning) return;
    if (e.button === 2 || e.button === 1) { isPanning = true; lastX = e.clientX; lastY = e.clientY; return; }
    if (e.button === 0) handlePrimary(e);
});
window.addEventListener("mousemove", (e) => {
    if (!isPanning) return;
    const dx = (e.clientX - lastX) * 0.12, dy = (e.clientY - lastY) * 0.12;
    lastX = e.clientX; lastY = e.clientY;
    const right = new THREE.Vector3().crossVectors(camera.up, camera.getWorldDirection(new THREE.Vector3())).normalize();
    const fwd = new THREE.Vector3(-1, 0, -1).normalize();
    camera.position.addScaledVector(right, dx).addScaledVector(fwd, -dy);
    cameraTarget.addScaledVector(right, dx).addScaledVector(fwd, -dy);
});
window.addEventListener("mouseup", () => { isPanning = false; });
container.addEventListener("wheel", (e) => {
    e.preventDefault();
    camera.zoom = Math.max(0.5, Math.min(3, camera.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    camera.updateProjectionMatrix();
}, { passive: false });

window.addEventListener("keydown", (e) => { keys[e.key] = true; if (e.key === "t" || e.key === "T") { notifyOverlayToggled(); toggleThermalOverlay(); }
    if (e.key === "Escape") {
        // Two-step: first Esc drops back to the select tool, second (or Esc
        // with nothing selected) opens the pause menu; Esc on the open menu
        // resumes — the SS pattern, so the player is never trapped in a run.
        const pauseMenu = document.getElementById("pause-menu-modal");
        if (!pauseMenu.classList.contains("hidden")) window.resumeRun();
        else if (activeTool !== "select") setTool("select");
        else if (STATE.isRunning) window.openPauseMenu();
    }
    if (e.key === " ") { e.preventDefault(); window.togglePause(); } });
window.addEventListener("keyup", (e) => { keys[e.key] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

// ---- keyboard camera pan (#13) ----
// `keys` above was already written on every keydown/keyup/blur (the blur
// clear was a fix for a feature that was never wired up) and read nowhere;
// this reads it. The camera is fixed-angle isometric — resetCamera always
// places it at cameraTarget + (60,60,60) with up = (0,1,0), and nothing in
// this game ever orbits it — so the screen-right / screen-up directions in
// world XZ are constants rather than something to recompute from camera
// state every frame. They are exactly the `right` / `fwd` basis the
// right/middle-drag pan above already uses (cross(camera.up, view
// direction), and the ground-plane component of the view direction itself),
// so WASD moves the camera along the same screen axes a mouse drag does.
const PAN_RIGHT = { x: -Math.SQRT1_2, z: Math.SQRT1_2 };
const PAN_FWD = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };
// World units/second at zoom 1 — a held key crosses the 120-unit board
// (CONFIG.gridSize * CONFIG.tileSize) in about three seconds.
const KEY_PAN_SPEED = 40;
const boardHalf = (CONFIG.gridSize * CONFIG.tileSize) / 2;

// Anything that takes text — today just the seed box — must own its own
// keystrokes: a "w" typed there must not also slide the camera.
function isTypingTarget(el) {
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable === true);
}

// Called once per rendered frame from game.js's animate(), beside its other
// per-frame UI work (tickMeshes, tickOverlay, tickInspect, ...) — panning is
// a viewport concern, not a sim tick, so it reads rawDt and keeps working
// through a pause or a fast-forward, exactly like those. The camera is not
// STATE (src/ui/scene.js owns the THREE object — see docs/ARCHITECTURE.md's
// UI boundary), so this file writing to it is not the STATE write this
// module is barred from; it goes through focusWorld() so the position/target
// offset resetCamera relies on is preserved exactly the way the mouse-drag
// pan above preserves it, rather than writing camera.position directly.
export function tickCameraPan(rawDt) {
    if (!STATE.isRunning) return;
    if (isTypingTarget(document.activeElement)) return;
    let x = 0, z = 0;
    if (keys["w"] || keys["W"] || keys["ArrowUp"]) { x += PAN_FWD.x; z += PAN_FWD.z; }
    if (keys["s"] || keys["S"] || keys["ArrowDown"]) { x -= PAN_FWD.x; z -= PAN_FWD.z; }
    if (keys["a"] || keys["A"] || keys["ArrowLeft"]) { x -= PAN_RIGHT.x; z -= PAN_RIGHT.z; }
    if (keys["d"] || keys["D"] || keys["ArrowRight"]) { x += PAN_RIGHT.x; z += PAN_RIGHT.z; }
    if (x === 0 && z === 0) return;
    const len = Math.hypot(x, z);
    // Divided by zoom, not multiplied: zoom MAGNIFIES the scene (a zoom of 2
    // shows half the world width in the same screen width), so holding the
    // ON-SCREEN pan speed constant means the WORLD-space step must shrink as
    // zoom grows.
    const step = (KEY_PAN_SPEED * rawDt) / camera.zoom;
    const targetX = cameraTarget.x + (x / len) * step;
    const targetZ = cameraTarget.z + (z / len) * step;
    focusWorld(
        Math.max(-boardHalf, Math.min(boardHalf, targetX)),
        Math.max(-boardHalf, Math.min(boardHalf, targetZ))
    );
}

renderer.domElement && container.appendChild(renderer.domElement);
