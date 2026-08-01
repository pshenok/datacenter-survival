// Composition root. Owns the frame loop and the window boundary — every
// inline handler in index.html resolves here. Tick order is contractual
// (see docs/specs): demand assigns -> power resolves -> heat responds.
import { CONFIG } from "./src/core/config.js";
import { STATE, resetState } from "./src/core/state.js";
import { resetBuildingIds } from "./src/entities/Building.js";
import { resolvePower } from "./src/sim/power.js";
import { tickHeat } from "./src/sim/heat.js";
import { tickDemand, tickEvents, upcomingWave } from "./src/sim/demand.js";
import { tickCrisis } from "./src/sim/crisis.js";
import { tickContracts } from "./src/sim/contracts.js";
import { scene, camera, renderer, resetCamera, buildingGroup, wireGroup } from "./src/ui/scene.js";
import { tickMeshes, removeMesh, removeWireMesh } from "./src/ui/meshes.js";
import { tickHud, showBanner, showGameOver, resetHudStats, renderInspect, contractLabel } from "./src/ui/hud.js";
import { tickOverlay, toggleThermalOverlay } from "./src/ui/overlay.js";
import { tickPulses } from "./src/ui/pulses.js";
import { renderPalette, refreshAffordability } from "./src/ui/toolbar.js";
import { setTool, tickInspect } from "./src/input/handlers.js";
import { tutorial, startTutorial, shouldOfferTutorial, tickTutorial, notifyOverlayToggled } from "./src/ui/tutorial.js";
import { openFaq, closeFaq } from "./src/ui/faq.js";
import { i18n } from "./src/i18n.js";

let lastTime = 0;
let warnedWaveAt = 0;
let heatwaveWasActive = false;
let brownoutWasActive = false;
let brokenIds = new Set();
let seenContractId = 0;
let seenContractDone = null;
let gameOverShown = false;

function tick(dt) {
    // While the tutorial runs, game time is frozen: demand stays at the gentle
    // base value and no waves, heatwaves, crises or contracts fire (their
    // schedules key off elapsed) — but dt still flows, so a wired rack
    // visibly earns money mid-lesson.
    if (!tutorial.active) STATE.elapsedGameTime += dt;

    tickEvents(dt, STATE.elapsedGameTime);
    tickCrisis(dt, STATE.elapsedGameTime);      // brownout must precede power
    tickDemand(dt, STATE.elapsedGameTime);
    resolvePower(dt);
    tickHeat(dt);
    tickContracts(dt, STATE.elapsedGameTime);   // judged on THIS tick's facts

    // UI-side reactions to sim facts
    const wave = upcomingWave(STATE.elapsedGameTime);
    if (wave && wave.atSec !== warnedWaveAt) {
        warnedWaveAt = wave.atSec;
        showBanner(i18n.t("wave_warning", { mult: wave.multiplier }), 5000);
    }
    if (STATE.heatwave.active && !heatwaveWasActive) showBanner(i18n.t("heatwave_start"), 5000);
    if (!STATE.heatwave.active && heatwaveWasActive) showBanner(i18n.t("heatwave_end"), 2500);
    heatwaveWasActive = STATE.heatwave.active;

    if (STATE.brownout.active && !brownoutWasActive) {
        showBanner(i18n.t("brownout_start", { pct: Math.round(STATE.brownout.factor * 100) }), 6000);
    }
    if (!STATE.brownout.active && brownoutWasActive) showBanner(i18n.t("brownout_end"), 2500);
    brownoutWasActive = STATE.brownout.active;

    // CRAC breakdowns: diff the broken set (demolished units just vanish —
    // no banner). One repair banner covers both the paid and the free path.
    const nowBroken = new Set();
    for (const b of STATE.buildings) {
        if (b.broken) nowBroken.add(b.id);
        if (b.broken && !brokenIds.has(b.id)) {
            showBanner(i18n.t("crac_break", {
                cost: CONFIG.events.cracBreakdown.repairCost,
                wait: CONFIG.events.cracBreakdown.selfRepairSec,
            }), 6000);
        }
        if (!b.broken && brokenIds.has(b.id)) showBanner(i18n.t("crac_repaired"), 3000);
    }
    brokenIds = nowBroken;

    // Contracts: new offer, then completion/expiry.
    const c = STATE.contract;
    if (c.key && c.id !== seenContractId) {
        seenContractId = c.id;
        seenContractDone = null;
        showBanner(i18n.t("contract_new", { name: contractLabel(c), reward: c.reward }), 6000);
    }
    if (c.id === seenContractId && c.done !== seenContractDone) {
        seenContractDone = c.done;
        if (c.done === "paid") showBanner(i18n.t("contract_done", { reward: c.reward }), 5000);
        else if (c.done === "failed") showBanner(i18n.t("contract_failed"), 4000);
    }

    if (STATE.gameOver && !gameOverShown) {
        gameOverShown = true;
        STATE.timeScale = 0;
        syncPlayPauseUi();
        showGameOver(STATE.gameOver);
    }
}

function animate(time) {
    requestAnimationFrame(animate);
    const rawDt = Math.min(0.1, (time - lastTime) / 1000 || 0);
    lastTime = time;
    const dt = rawDt * STATE.timeScale;

    if (STATE.isRunning && dt > 0) tick(dt);
    tickTutorial();

    tickMeshes(rawDt);
    if (STATE.isRunning && STATE.timeScale > 0) tickPulses(rawDt);
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
    brownoutWasActive = false;
    brokenIds = new Set();
    seenContractId = 0;
    seenContractDone = null;
    gameOverShown = false;
}

// ---- window boundary (index.html inline handlers) ----
// Both entries start PAUSED (the Server Survival lesson: the player builds
// freely, demand only flows once they press Play). Reputation cannot drain
// while you are still reading.
function beginRun() {
    document.getElementById("main-menu").classList.add("hidden");
    clearWorld();
    STATE.isRunning = true;
    STATE.timeScale = 0;
    setTool("select");
    refreshAffordability();
    syncPlayPauseUi();
}
window.startGame = () => {
    beginRun();
    if (shouldOfferTutorial()) startTutorial();
};
window.startTutorialGame = () => {
    beginRun();
    startTutorial();
};
window.restartGame = () => {
    document.getElementById("gameover-modal").classList.add("hidden");
    window.startGame();
};
function syncPlayPauseUi() {
    const paused = STATE.timeScale === 0;
    document.getElementById("icon-play").classList.toggle("hidden", !paused);
    document.getElementById("icon-pause").classList.toggle("hidden", paused);
    const btn = document.getElementById("btn-pause");
    btn.classList.toggle("paused-cta", paused);
    document.getElementById("paused-pill").classList.toggle("hidden", !paused || !STATE.isRunning);
}
window.togglePause = () => {
    if (!STATE.isRunning) return;
    STATE.timeScale = STATE.timeScale === 0 ? 1 : 0;
    syncPlayPauseUi();
};
window.toggleThermalOverlay = () => { notifyOverlayToggled(); return toggleThermalOverlay(); };
window.setTool = setTool;
window.showHelp = openFaq;
window.closeHelp = closeFaq;

// ---- boot ----
renderPalette((type) => setTool(type));
resetCamera();
requestAnimationFrame(animate);

export { CONFIG, STATE, buildingGroup, wireGroup };
