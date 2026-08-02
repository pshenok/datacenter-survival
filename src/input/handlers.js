// Input layer: camera pan/zoom, tool selection, placement, wiring, demolish,
// keyboard shortcuts. Carries the Server Survival lessons: blur clears held
// keys; occupied-tile placement rejected; all listeners are module side
// effects registered once.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { Building } from "../entities/Building.js";
import { wireBuildings, unwire } from "../sim/power.js";
import { repairCrac, orderFuel } from "../sim/crisis.js";
import { camera, cameraTarget, renderer, worldToGrid, gridToWorld, buildingGroup } from "../ui/scene.js";
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

function placeBuilding(type, gx, gz) {
    const cfg = CONFIG.buildings[type];
    if (isBannedHere(type)) {
        showBanner(i18n.t("lv_banned"), 2500);
        return;
    }
    if (STATE.money < cfg.cost) return;
    if (STATE.buildings.some((b) => b.gx === gx && b.gz === gz)) return; // occupied tile
    const b = new Building(type, gx, gz);
    STATE.money -= cfg.cost;
    STATE.buildings.push(b);
    attachMesh(b);
    refreshAffordability();
}

// Some campaign levels ban a building that would bypass the taught mechanic
// (e.g. the generator on the UPS level).
function isBannedHere(type) {
    const id = STATE.campaign.levelId;
    if (id === null) return false;
    const cfg = CONFIG.campaign.levels[id];
    return !!(cfg && cfg.banned && cfg.banned.includes(type));
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
            if (wireBuildings(wireSource, hit.building)) {
                // A generator wired to an already-fed child became a STANDBY
                // edge (transfer switch) — dashed-grey wire, and it replaces
                // only a previous standby, never the primary feed.
                const standby = hit.building.standbyParentId === wireSource.id;
                dropWireTo(hit.building.id, standby);
                const wire = { id: "w" + wireId++, from: wireSource.id, to: hit.building.id, standby, mesh: null };
                STATE.wires.push(wire);
                addWireMesh(wire, wireSource, hit.building);
            }
            wireSource = null;
        }
        return;
    }
    if (activeTool === "demolish") {
        if (hit.building) {
            demolishBuilding(hit.building);
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

let wireId = 1;

function dropWireTo(childId, standby = false) {
    const idx = STATE.wires.findIndex((w) => w.to === childId && !!w.standby === standby);
    if (idx === -1) return;
    removeWireMesh(STATE.wires[idx]);
    STATE.wires.splice(idx, 1);
}

// Demolish: unwire self and every child (they lose their PRIMARY feed;
// their standby edges survive — the transfer switch dies only with its
// generator), clean the visual wires, refund half the cost — the Server
// Survival economics.
function demolishBuilding(b) {
    unwire(b);
    dropWireTo(b.id);
    dropWireTo(b.id, true);
    for (const cid of [...b.childIds]) {
        const child = STATE.buildings.find((x) => x.id === cid);
        if (child) { unwire(child); dropWireTo(child.id); }
    }
    // A demolished generator takes its standby edges with it.
    for (const other of STATE.buildings) {
        if (other.standbyParentId === b.id) {
            other.standbyParentId = null;
            dropWireTo(other.id, true);
        }
    }
    STATE.buildings = STATE.buildings.filter((x) => x.id !== b.id);
    STATE.money += Math.floor(b.config.cost / 2);
    removeMesh(b);
    if (selectedId === b.id) { selectedId = null; renderInspect(null); }
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

window.addEventListener("keydown", (e) => { keys[e.key] = true; if (e.key === "t" || e.key === "T") { notifyOverlayToggled(); toggleThermalOverlay(); } if (e.key === "Escape") setTool("select");
    if (e.key === " ") { e.preventDefault(); window.togglePause(); } });
window.addEventListener("keyup", (e) => { keys[e.key] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

renderer.domElement && container.appendChild(renderer.domElement);
