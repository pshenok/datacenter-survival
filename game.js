// Composition root. Owns the frame loop and the window boundary — every
// inline handler in index.html resolves here. Tick order is contractual
// (see docs/specs): demand assigns -> power resolves -> heat responds.
import { CONFIG } from "./src/core/config.js";
import { STATE, resetState } from "./src/core/state.js";
import { normalizeSeed, randomSeedToken, seededRngs } from "./src/core/rng.js";
import { resetBuildingIds } from "./src/entities/Building.js";
import { resolvePower } from "./src/sim/power.js";
import { tickHeat } from "./src/sim/heat.js";
import { tickDemand, tickEvents, upcomingWave, upcomingBand } from "./src/sim/demand.js";
import { tickCrisis } from "./src/sim/crisis.js";
import { tickContracts } from "./src/sim/contracts.js";
import { scene, camera, renderer, resetCamera, focusWorld, gridToWorld, buildingGroup, wireGroup } from "./src/ui/scene.js";
import { tickMeshes, removeMesh, removeWireMesh, attachMesh, addWireMesh } from "./src/ui/meshes.js";
import { tickHud, showBanner, showGameOver, resetHudStats, renderInspect, contractLabel, renderLossLedger, shareUrl } from "./src/ui/hud.js";
import { tickOverlay, toggleThermalOverlay } from "./src/ui/overlay.js";
import { tickPulses } from "./src/ui/pulses.js";
import { tickBadges, clearBadges } from "./src/ui/failure-badges.js";
import { renderPalette, refreshAffordability } from "./src/ui/toolbar.js";
import { setTool, tickInspect, tickCameraPan } from "./src/input/handlers.js";
import { tutorial, showCeremony, shouldOfferTutorial, tickTutorial, notifyOverlayToggled } from "./src/ui/tutorial.js";
import { openFaq, closeFaq } from "./src/ui/faq.js";
import { tickCampaign, startLevelState, startLevelMaintenance } from "./src/campaign/campaign.js";
import { tickMaintenance } from "./src/sim/maintenance.js";
import { resetWireIds } from "./src/sim/build.js";
import { applyPreBuilt } from "./src/campaign/prebuilt.js";
import { initCampaignUi, openCampaign, closeCampaign, openBriefing, closeBriefing, onLevelStart, tickCampaignUi } from "./src/ui/campaign-ui.js";
import { initLabPanel, tickLabPanel, hideLabPanel, resetLabPanel } from "./src/ui/lab-panel.js";
import { setLabDemandKw, setLabAmbientC, setLabTariffBand, fireLabEvent, resetLab } from "./src/campaign/lab.js";
import { i18n } from "./src/i18n.js";

let lastTime = 0;
let warnedWaveAt = 0;
let warnedBandKey = null;
let heatwaveWasActive = false;
let brownoutWasActive = false;
let brokenIds = new Set();
let trippedIds = new Set();
let seenContractId = 0;
let seenContractDone = null;
let gameOverShown = false;
let outageWasActive = false;
let tariffWasActive = false;
let droughtWasActive = false;
let missedOrders = new Set();

// ---- the run's randomness -------------------------------------------------
// An UNSEEDED run passes `undefined`, so each tick falls through to the
// `rng = Math.random` default it has always declared — not a captured copy of
// Math.random, which would read the same and quietly pin the reference at
// module-eval time. Nothing about an unseeded run changes. A seeded run swaps
// in the two streams src/core/rng.js derives from the token; nothing else in
// the game is touched, because nothing else in the game is random (the demand
// curve, the heatwave and the day/night bands are all pure functions of the
// clock).
const UNSEEDED = { crisis: undefined, contracts: undefined };
let runRng = UNSEEDED;

function tick(dt) {
    // While the tutorial runs, game time is frozen: demand stays at the gentle
    // base value and no waves, heatwaves, crises or contracts fire (their
    // schedules key off elapsed) — but dt still flows, so a wired rack
    // visibly earns money mid-lesson.
    if (!tutorial.active) STATE.elapsedGameTime += dt;

    tickEvents(dt, STATE.elapsedGameTime);
    tickCrisis(dt, STATE.elapsedGameTime, runRng.crisis);       // brownout must precede power
    tickDemand(dt, STATE.elapsedGameTime);
    resolvePower(dt);
    tickHeat(dt);
    tickContracts(dt, STATE.elapsedGameTime, runRng.contracts); // judged on THIS tick's facts
    tickMaintenance(dt, STATE.elapsedGameTime);
    tickCampaign(dt, STATE.elapsedGameTime);    // scripted events + objectives, judged last

    // UI-side reactions to sim facts
    const wave = upcomingWave(STATE.elapsedGameTime);
    if (wave && wave.atSec !== warnedWaveAt) {
        warnedWaveAt = wave.atSec;
        showBanner(i18n.t("wave_warning", { mult: wave.multiplier }), 5000);
    }
    // The band change is announced, not sprung. A price you can only learn
    // by being charged it is a punishment; a price you can see coming is a
    // plan — and the plan is the entire mechanic.
    const band = upcomingBand(STATE.elapsedGameTime);
    if (band && band.band.key !== warnedBandKey) {
        warnedBandKey = band.band.key;
        showBanner(i18n.t("band_warning", {
            band: i18n.t("tariff_band_" + band.band.key),
            mult: band.band.mult,
            sec: Math.ceil(band.inSec),
        }), 5000);
    } else if (!band) {
        warnedBandKey = null;
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

    // Breaker trips: real gear opens instead of dimming forever, so say so
    // loudly — the badge names the link, this says what to do about it.
    const nowTripped = new Set();
    for (const b of STATE.buildings) {
        if (!b.tripped) continue;
        nowTripped.add(b.id);
        if (!trippedIds.has(b.id)) {
            showBanner(i18n.t("breaker_trip", { name: i18n.t("b_" + b.type) }), 6000);
        }
    }
    trippedIds = nowTripped;

    // Work orders: issued once at level start, and the miss is the verdict.
    for (const o of STATE.maintenance.orders) {
        if (o.state === "missed" && !missedOrders.has(o.buildingId)) {
            missedOrders.add(o.buildingId);
            showBanner(i18n.t("maint_missed"), 6000);
        }
    }

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

    // Grid outage (survival-random or campaign-scripted): banner on both edges.
    if (STATE.gridOutage.active && !outageWasActive) {
        // A substation outage is NOT a city-wide blackout, and saying so is
        // the whole point of the level that teaches independent feeds.
        const scoped = STATE.gridOutage.scope !== "all";
        showBanner(scoped
            ? i18n.t("outage_start_scoped", { utility: STATE.gridOutage.scope })
            : i18n.t("outage_start"), 5000);
    }
    if (!STATE.gridOutage.active && outageWasActive) showBanner(i18n.t("outage_end"), 2500);
    outageWasActive = STATE.gridOutage.active;

    // Peak tariff: the meter, not the machinery.
    if (STATE.tariff.active && !tariffWasActive) {
        showBanner(i18n.t("tariff_start", { mult: STATE.tariff.multiplier }), 5000);
    }
    if (!STATE.tariff.active && tariffWasActive) showBanner(i18n.t("tariff_end"), 2500);
    tariffWasActive = STATE.tariff.active;

    // Drought: the OTHER meter. Announced only to a facility that actually
    // evaporates water, which is why the edge is "the window is open AND we
    // drink" rather than the window alone — an air-cooled hall owes the
    // reservoir nothing and a banner about it there is pure noise. Build a
    // chiller mid-drought and the announcement arrives then, which is exactly
    // when it starts being true of you.
    const drinking = STATE.water.litersPerHour > 0;
    if (STATE.drought.active && drinking && !droughtWasActive) {
        droughtWasActive = true;
        showBanner(i18n.t("drought_start", { mult: STATE.drought.multiplier }), 6000);
    }
    if (!STATE.drought.active && droughtWasActive) {
        droughtWasActive = false;
        showBanner(i18n.t("drought_end"), 2500);
    }

    if (STATE.gameOver && !gameOverShown) {
        gameOverShown = true;
        STATE.timeScale = 0;
        syncPlayPauseUi();
        // In a campaign level the result modal (with Retry) covers the loss;
        // the survival game-over screen would double up on top of it.
        if (STATE.campaign.levelId === null) showGameOver(STATE.gameOver);
    }
}

function animate(time) {
    requestAnimationFrame(animate);
    const rawDt = Math.min(0.1, (time - lastTime) / 1000 || 0);
    lastTime = time;
    const dt = rawDt * STATE.timeScale;

    if (STATE.isRunning && dt > 0) tick(dt);
    tickTutorial();
    tickCampaignUi();
    tickLabPanel();

    tickMeshes(rawDt);
    tickBadges(rawDt);
    if (STATE.isRunning && STATE.timeScale > 0) tickPulses(rawDt);
    tickOverlay(rawDt);
    tickHud();
    tickInspect();
    tickCameraPan(rawDt);
    renderer.render(scene, camera);
}

function clearWorld() {
    for (const w of STATE.wires) removeWireMesh(w);
    for (const b of STATE.buildings) removeMesh(b);
    resetState();
    // The three id counters travel together. resetState() cannot see any of
    // them — they are module-scope in their own files — so a missing one
    // leaves ids climbing across runs while its siblings restart at 1.
    resetBuildingIds();
    resetWireIds();
    resetHudStats();
    clearBadges();
    renderInspect(null);
    // The knob panel is rebuilt per level start, so a Lab run cannot leave
    // its listeners (or its readings) behind in the next room.
    resetLabPanel();
    hideLabPanel();
    warnedWaveAt = 0;
    warnedBandKey = null;
    heatwaveWasActive = false;
    brownoutWasActive = false;
    brokenIds = new Set();
    trippedIds = new Set();
    seenContractId = 0;
    seenContractDone = null;
    gameOverShown = false;
    outageWasActive = false;
    tariffWasActive = false;
    droughtWasActive = false;
    missedOrders = new Set();
}

// ---- window boundary (index.html inline handlers) ----
// Both entries start PAUSED (the Server Survival lesson: the player builds
// freely, demand only flows once they press Play). Reputation cannot drain
// while you are still reading.
function beginRun() {
    document.getElementById("main-menu").classList.add("hidden");
    clearWorld();
    resetCamera();      // a campaign level's focus must not follow you out
    STATE.isRunning = true;
    STATE.timeScale = 0;
    setTool("select");
    refreshAffordability();
    syncPlayPauseUi();
    syncPeakShaveUi(); // resetState() (inside clearWorld) severs the toggle
    // Every entry point lands here, so this is the one place that can promise
    // a run never inherits the previous one's stream. armRun() puts a seed
    // back afterwards; a campaign level simply never calls it.
    armRun(null);
}
// Arm (or disarm) the run's randomness. Called AFTER beginRun, because
// clearWorld -> resetState nulls STATE.seed on the way through.
function armRun(seed) {
    const rngs = seededRngs(seed);
    STATE.seed = rngs ? rngs.seed : null;
    runRng = rngs || UNSEEDED;
    syncSeedUrl();
}
// The address bar IS the share link, so keep it honest: a seeded run puts its
// token there, an unseeded one takes it away. Guarded — a sandboxed or
// file:// context throws on replaceState and a run must not die for a URL.
function syncSeedUrl() {
    try {
        const base = window.location.href.split(/[?#]/)[0];
        window.history.replaceState(null, "", STATE.seed === null ? base : `${base}?seed=${STATE.seed}`);
    } catch { /* no history API here — the pill still shows the seed */ }
}
function seedFromUrl() {
    try {
        return normalizeSeed(new URLSearchParams(window.location.search).get("seed"));
    } catch {
        return null;
    }
}
// Normalizes the seed box IN PLACE and returns the token. This is the fix
// for a token that silently normalizes to something other than what was
// typed — worst case, to nothing at all. `normalizeSeed` strips anything
// outside `[0-9A-Z]`, so a Cyrillic word like "КИЇВ" (the single most
// natural thing to type in a game that ships Ukrainian as a first-class
// locale) collapses to "" and the run starts unseeded with the box still
// showing "КИЇВ" — indistinguishable from having left it blank, and silent
// about it. Echoing the normalized token back means the box always shows
// the room that is actually about to run: it goes visibly empty instead of
// keeping dead text, or shows "42" in place of "КИЇВ-42" so the mismatch is
// caught before Power On rather than discovered on the pill afterwards.
// Deliberately NOT a transliteration scheme — that reshapes what tokens
// mean and is a bigger call than this fix.
function echoSeedInput() {
    const input = document.getElementById("seed-input");
    if (!input) return null;
    const token = normalizeSeed(input.value);
    input.value = token || "";
    return token;
}
function readSeedInput() {
    return echoSeedInput();
}
// `seed === undefined` means "whatever the menu box says" (the Power On
// button); an explicit value — including null — overrides it, which is what
// Restart and Retry pass so a seeded run replays the SAME room.
window.startGame = (seed) => {
    const wanted = seed === undefined ? readSeedInput() : seed;
    beginRun();
    armRun(wanted);
    // Free play runs the day/night meter. The bands average to 1.0, so this
    // is not a harder game — it is the same bill with a clock attached, and
    // the only mode long enough for load-shifting to be worth learning.
    STATE.tariff.cycleOn = true;
    // A seeded run never opens with the tutorial. The lesson earns money and
    // builds gear before the clock starts, so a tutorial'd run and a skipped
    // one are not the same starting room — and "same seed, same run" has to
    // mean the room too, not just the crises. The saved profile flag is left
    // exactly as it was: a link someone sent you must not rewrite what you
    // have already learned.
    if (STATE.seed === null && shouldOfferTutorial()) showCeremony();
};
window.startTutorialGame = () => {
    beginRun();
    showCeremony();
};
window.restartGame = () => {
    document.getElementById("gameover-modal").classList.add("hidden");
    window.startGame(STATE.seed);   // read BEFORE beginRun clears it
};
// Roll a fresh room without editing the URL by hand. Fills the box rather
// than launching: the player sees the token they are about to play, and the
// same button works for "give me another one" before they commit.
window.rollSeed = () => {
    const input = document.getElementById("seed-input");
    if (!input) return;
    input.value = randomSeedToken(Math.random);
};
// Wired to the box's blur, so leaving the field (including by clicking
// Power On) shows the correction BEFORE the run starts, not only after.
window.echoSeedInput = echoSeedInput;
// The seed is copyable wherever it is visible — the HUD pill mid-run and the
// game-over line — because a run you cannot hand to someone else is exactly
// the unfalsifiable claim this feature exists to replace. Which is exactly
// why the "copied" banner must not lie: `navigator.clipboard` is undefined
// on a non-secure origin (a LAN IP — precisely how you test on a phone), and
// a denied permission rejects the promise. AWAIT it, and claim success only
// on success. On failure, surface the URL itself in the banner — mid-run the
// pill is the only copy affordance (the game-over screen has a selectable
// field as a fallback; the pill has none but the address bar), so the banner
// has to carry the link this time.
window.copySeedLink = async () => {
    const url = shareUrl(STATE.seed);
    if (!url) return;
    try {
        if (!navigator.clipboard) throw new Error("no clipboard API");
        await navigator.clipboard.writeText(url);
        showBanner(i18n.t("seed_copied", { seed: STATE.seed }), 2500);
    } catch {
        showBanner(i18n.t("seed_copy_failed", { url }), 6000);
    }
};
// Campaign entries. Selecting a level opens its BRIEFING (the SS pattern —
// a level never starts cold); the briefing's Start button launches it,
// paused like every run. Retry relaunches directly.
window.openCampaign = openCampaign;
window.closeCampaign = closeCampaign;
window.startCampaignLevel = (id) => {
    closeCampaign();
    document.getElementById("level-result-modal").classList.add("hidden");
    openBriefing(id);
};
window.launchCampaignLevel = (id) => {
    closeBriefing();
    document.getElementById("level-result-modal").classList.add("hidden");
    beginRun();
    startLevelState(id);
    // A diagnosis level hands the player a room that is already running:
    // the pure builder makes the topology, this pass gives it bodies.
    const prebuilt = applyPreBuilt(id);
    // Work orders index into the room applyPreBuilt just built, so this must
    // run after it, not inside startLevelState.
    startLevelMaintenance(id, prebuilt);
    for (const b of prebuilt) attachMesh(b);
    for (const w of STATE.wires) {
        const from = STATE.buildings.find((x) => x.id === w.from);
        const to = STATE.buildings.find((x) => x.id === w.to);
        if (from && to && !w.mesh) addWireMesh(w, from, to);
    }
    // Resolve once so the room reads as ALIVE while the level sits paused:
    // without this every prebuilt load renders as an unpowered grey box
    // until the player presses Play, which is the opposite of the point.
    if (prebuilt.length > 0) resolvePower(1 / 60);
    // …and put the camera on it, or the player opens the level looking at
    // an empty corner of the floor.
    resetCamera();
    if (prebuilt.length > 0) {
        const cx = prebuilt.reduce((s, b) => s + b.gx, 0) / prebuilt.length;
        const cz = prebuilt.reduce((s, b) => s + b.gz, 0) / prebuilt.length;
        const w = gridToWorld(Math.round(cx), Math.round(cz));
        focusWorld(w.x, w.z);
    }
    refreshAffordability();     // re-run under the level's money AND its bans
    onLevelStart(id);
};
window.briefingBack = () => {
    closeBriefing();
    openCampaign();
};
window.backToMenu = () => {
    STATE.isRunning = false;
    for (const id of ["gameover-modal", "objectives-panel", "lab-panel", "pause-menu-modal", "briefing-modal", "level-result-modal"]) {
        document.getElementById(id).classList.add("hidden");
    }
    document.getElementById("main-menu").classList.remove("hidden");
};

// ---- pause menu (Esc / the ☰ button): the always-available way OUT ------
window.openPauseMenu = () => {
    if (!STATE.isRunning) return;
    STATE.timeScale = 0;
    syncPlayPauseUi();
    // Survival has no "retry this level" — the button reads as restart there.
    renderLossLedger("pause-ledger");
    document.getElementById("pause-menu-modal").classList.remove("hidden");
};
window.resumeRun = () => {
    document.getElementById("pause-menu-modal").classList.add("hidden");
    // A decided run (game over / level resolved) stays frozen.
    if (STATE.gameOver === null && STATE.campaign.done === null) {
        STATE.timeScale = 1;
        syncPlayPauseUi();
    }
};
window.retryFromPause = () => {
    document.getElementById("pause-menu-modal").classList.add("hidden");
    if (STATE.campaign.levelId !== null) window.launchCampaignLevel(STATE.campaign.levelId);
    else window.startGame(STATE.seed);   // retrying a seeded run replays THAT room
};
window.menuFromPause = () => {
    window.backToMenu();
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
    // No resume once the run is decided: a survival game-over or a resolved
    // campaign level freezes time for good — Space behind the result modal
    // must not restart the sim (Retry/Next/Menu are the only exits).
    if (!STATE.isRunning || STATE.gameOver !== null || STATE.campaign.done !== null) return;
    STATE.timeScale = STATE.timeScale === 0 ? 1 : 0;
    syncPlayPauseUi();
};
window.toggleThermalOverlay = () => { notifyOverlayToggled(); return toggleThermalOverlay(); };

// ---- peak shaving toggle --------------------------------------------------
// A player choice, not a diagnostic: owned here (the composition root), the
// same place STATE.tariff.cycleOn and STATE.timeScale get written — src/ui/*
// and src/input/* only ever read STATE, per the architecture boundary.
function syncPeakShaveUi() {
    const btn = document.getElementById("btn-peakshave");
    if (!btn) return;
    // Own exactly one colour class at a time. Leaving both on the element
    // makes the winner Tailwind's emission order rather than the toggle —
    // the pause and overlay buttons avoid it the same way.
    btn.classList.toggle("text-emerald-300", STATE.peakShave.on);
    btn.classList.toggle("text-gray-300", !STATE.peakShave.on);
}
window.togglePeakShave = () => {
    // Same gate as togglePause: no arming a mechanic from the menu, and none
    // behind a result modal. Without it the button paints lit over a room
    // that does not exist yet.
    if (!STATE.isRunning || STATE.gameOver !== null || STATE.campaign.done !== null) return;
    STATE.peakShave.on = !STATE.peakShave.on;
    syncPeakShaveUi();
};
// ---- The Lab's knobs ------------------------------------------------------
// Same boundary as togglePeakShave above: src/ui/lab-panel.js draws the panel
// and reads STATE, and every write goes through campaign/lab.js from HERE.
// Each of these refuses unless a sandbox level is running (STATE.lab.on), so
// there is nothing to gate a second time — but a refused Fire is worth
// saying out loud, because a button that silently does nothing reads as
// broken rather than as "that window is already open".
const labHandlers = {
    setDemandKw: (kw) => setLabDemandKw(kw),
    setAmbientC: (c) => setLabAmbientC(c),
    setTariffBand: (mode) => setLabTariffBand(mode),
    fire: (kind) => {
        if (!fireLabEvent(kind)) showBanner(i18n.t("lab_fire_refused"), 3500);
    },
    reset: () => {
        if (resetLab()) showBanner(i18n.t("lab_reset_done"), 2500);
    },
};

window.setTool = setTool;
window.showHelp = openFaq;
window.closeHelp = closeFaq;

// ---- boot ----
renderPalette((type) => setTool(type));
initLabPanel(labHandlers);
initCampaignUi({
    freeze: () => {
        STATE.timeScale = 0;
        syncPlayPauseUi();
    },
});
resetCamera();
requestAnimationFrame(animate);

// A shared link lands you IN the run, not on a menu with a box to retype:
// ?seed=<token> starts free play on that room immediately. Without the
// parameter this is a no-op and the game boots exactly as it always has.
const bootSeed = seedFromUrl();
if (bootSeed !== null) {
    const input = document.getElementById("seed-input");
    if (input) input.value = bootSeed;      // so Menu -> Power On replays it
    window.startGame(bootSeed);
}

export { CONFIG, STATE, buildingGroup, wireGroup };
