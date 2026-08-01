// Input layer: camera pan/zoom, tool selection, placement, wiring, demolish,
// keyboard shortcuts. Carries the Server Survival lessons: blur clears held
// keys; occupied-tile placement rejected; all listeners are module side
// effects registered once.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { Building } from "../entities/Building.js";
import { wireBuildings, unwireBuilding, demolish } from "../sim/power.js";
import { camera, cameraTarget, renderer, worldToGrid, gridToWorld, buildingGroup } from "../ui/scene.js";
import { attachMesh, addWireMesh, removeWireMesh, removeMesh } from "../ui/meshes.js";
import { markActiveTool, refreshAffordability } from "../ui/toolbar.js";
import { renderInspect, showBanner } from "../ui/hud.js";
import { toggleThermalOverlay } from "../ui/overlay.js";
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
    wireSource = null;
    document.getElementById("wire-hint").classList.toggle("hidden", tool !== "wire");
    markActiveTool(tool);
}

function placeBuilding(type, gx, gz) {
    const cfg = CONFIG.buildings[type];
    if (STATE.money < cfg.cost) return;
    if (STATE.buildings.some((b) => b.gx === gx && b.gz === gz)) return; // occupied tile
    const b = new Building(type, gx, gz);
    STATE.money -= cfg.cost;
    STATE.buildings.push(b);
    attachMesh(b);
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
            const wire = wireBuildings(wireSource, hit.building);
            if (wire) addWireMesh(wire, wireSource, hit.building);
            wireSource = null;
        }
        return;
    }
    if (activeTool === "demolish") {
        if (hit.building) {
            const removedWires = demolish(hit.building);
            removedWires.forEach(removeWireMesh);
            removeMesh(hit.building);
            refreshAffordability();
        }
        return;
    }
    // select
    selectedId = hit.building ? hit.building.id : null;
    renderInspect(hit.building || null);
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

window.addEventListener("keydown", (e) => { keys[e.key] = true; if (e.key === "t" || e.key === "T") toggleThermalOverlay(); if (e.key === "Escape") setTool("select"); });
window.addEventListener("keyup", (e) => { keys[e.key] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

renderer.domElement && container.appendChild(renderer.domElement);
