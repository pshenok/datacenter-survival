// Composition root. Owns the frame loop and the window boundary — every
// inline handler in index.html resolves here. Tick order is contractual
// (see docs/specs): demand assigns -> power resolves -> heat responds.
import { CONFIG } from "./src/core/config.js";
import { STATE, resetState } from "./src/core/state.js";
import { resetBuildingIds } from "./src/entities/Building.js";
import { resolvePower } from "./src/sim/power.js";
import { tickHeat } from "./src/sim/heat.js";
import { tickDemand, tickEvents, upcomingWave } from "./src/sim/demand.js";
import { scene, camera, renderer, resetCamera, buildingGroup, wireGroup } from "./src/ui/scene.js";
import { tickMeshes, removeMesh, removeWireMesh } from "./src/ui/meshes.js";
import { tickHud, showBanner, showGameOver, resetHudStats, renderInspect } from "./src/ui/hud.js";
import { tickOverlay, toggleThermalOverlay } from "./src/ui/overlay.js";
import { renderPalette, refreshAffordability } from "./src/ui/toolbar.js";
import { setTool, tickInspect } from "./src/input/handlers.js";
import { i18n } from "./src/i18n.js";

let lastTime = 0;
let warnedWaveAt = 0;
let heatwaveWasActive = false;
let gameOverShown = false;

function tick(dt) {
    STATE.elapsedGameTime += dt;

    tickEvents(dt, STATE.elapsedGameTime);
    tickDemand(dt, STATE.elapsedGameTime);
    resolvePower(dt);
    tickHeat(dt);

    // UI-side reactions to sim facts
    const wave = upcomingWave(STATE.elapsedGameTime);
    if (wave && wave.atSec !== warnedWaveAt) {
        warnedWaveAt = wave.atSec;
        showBanner(i18n.t("wave_warning", { mult: wave.multiplier }), 5000);
    }
    if (STATE.heatwave.active && !heatwaveWasActive) showBanner(i18n.t("heatwave_start"), 5000);
    if (!STATE.heatwave.active && heatwaveWasActive) showBanner(i18n.t("heatwave_end"), 2500);
    heatwaveWasActive = STATE.heatwave.active;

    if (STATE.gameOver && !gameOverShown) {
        gameOverShown = true;
        STATE.timeScale = 0;
        showGameOver(STATE.gameOver);
    }
}

function animate(time) {
    requestAnimationFrame(animate);
    const rawDt = Math.min(0.1, (time - lastTime) / 1000 || 0);
    lastTime = time;
    const dt = rawDt * STATE.timeScale;

    if (STATE.isRunning && dt > 0) tick(dt);

    tickMeshes(rawDt);
    tickOverlay(rawDt);
    tickHud();
    tickInspect();
    renderer.render(scene, camera);
}

function clearWorld() {
    for (const w of STATE.wires) removeWireMesh(w);
    for (const b of STATE.buildings) removeMesh(b);
    resetState();
    resetBuildingIds();
    resetHudStats();
    renderInspect(null);
    warnedWaveAt = 0;
    heatwaveWasActive = false;
    gameOverShown = false;
}

// ---- window boundary (index.html inline handlers) ----
window.startGame = () => {
    document.getElementById("main-menu").classList.add("hidden");
    clearWorld();
    STATE.isRunning = true;
    setTool("select");
    refreshAffordability();
};
window.restartGame = () => {
    document.getElementById("gameover-modal").classList.add("hidden");
    window.startGame();
};
window.togglePause = () => {
    STATE.timeScale = STATE.timeScale === 0 ? 1 : 0;
    document.getElementById("btn-pause").classList.toggle("text-amber-300", STATE.timeScale === 0);
};
window.toggleThermalOverlay = () => toggleThermalOverlay();
window.setTool = setTool;
window.showHelp = () => document.getElementById("help-modal").classList.remove("hidden");
window.closeHelp = () => document.getElementById("help-modal").classList.add("hidden");

// ---- boot ----
renderPalette((type) => setTool(type));
resetCamera();
requestAnimationFrame(animate);

export { CONFIG, STATE, buildingGroup, wireGroup };
