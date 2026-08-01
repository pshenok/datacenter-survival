// First-run tutorial. Step-driven and action-gated (the Server Survival
// pattern): a step advances when the player actually does the thing, not when
// they click "next". The whole run starts PAUSED, so the player builds and
// reads freely; the finale is pressing Play — the moment the datacenter
// actually powers up.
//
// Step conditions are pure functions of STATE so they are unit-testable; the
// DOM rendering is the thin part.
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";

const DONE_KEY = "dc_tutorial_done";

function has(type) {
    return STATE.buildings.some((b) => b.type === type);
}
function wiredThroughToFeed(b, hops = 0) {
    if (!b || hops > STATE.buildings.length) return false;
    if (b.parentId === "grid") return b.config.chainRole === "source";
    if (!b.parentId) return false;
    return wiredThroughToFeed(STATE.buildings.find((x) => x.id === b.parentId), hops + 1);
}
function poweredOf(type) {
    return STATE.buildings.find((b) => b.type === type && wiredThroughToFeed(b));
}

// Each step: i18n key, done(STATE) predicate, optional toolbar button to pulse.
export const TUTORIAL_STEPS = [
    { key: "tut_welcome", done: () => tutorial.acknowledged, pulse: null, showNext: true },
    { key: "tut_place_feed", done: () => has("grid_feed"), pulse: "grid_feed" },
    { key: "tut_place_chain", done: () => has("transformer") && has("ups") && has("pdu"), pulse: "transformer" },
    { key: "tut_wire_chain", done: () => !!poweredOf("pdu"), pulse: "wire" },
    { key: "tut_place_rack", done: () => !!poweredOf("rack"), pulse: "rack" },
    { key: "tut_overlay", done: () => tutorial.overlayTouched, pulse: null },
    { key: "tut_place_crac", done: () => !!poweredOf("crac"), pulse: "crac" },
    // The finale is a real action too: press PLAY. The whole tutorial runs
    // paused, so this is the moment the datacenter actually powers up.
    { key: "tut_finish", done: () => STATE.timeScale > 0, pulse: "__play", showNext: false },
];

export const tutorial = {
    active: false,
    step: 0,
    acknowledged: false,
    overlayTouched: false,
};

export function shouldOfferTutorial() {
    try {
        return typeof localStorage === "undefined" || !localStorage.getItem(DONE_KEY);
    } catch {
        return true;
    }
}

export function startTutorial() {
    tutorial.active = true;
    tutorial.step = 0;
    tutorial.acknowledged = false;
    tutorial.overlayTouched = false;
    render();
}

export function skipTutorial() {
    finish();
}

function finish() {
    tutorial.active = false;
    try {
        if (typeof localStorage !== "undefined") localStorage.setItem(DONE_KEY, "1");
    } catch { /* storage unavailable — the offer just repeats next run */ }
    const panel = document.getElementById("tutorial-panel");
    if (panel) panel.classList.add("hidden");
    clearPulse();
}

export function notifyOverlayToggled() {
    tutorial.overlayTouched = true;
}
export function tutorialNext() {
    tutorial.acknowledged = true;
}

// Called every frame from game.js while active.
export function tickTutorial() {
    if (!tutorial.active) return;
    const step = TUTORIAL_STEPS[tutorial.step];
    if (step && step.done()) {
        tutorial.acknowledged = false;
        tutorial.step++;
        if (tutorial.step >= TUTORIAL_STEPS.length) {
            finish();
            return;
        }
        render();
    }
}

function clearPulse() {
    document.querySelectorAll(".tut-pulse").forEach((el) => el.classList.remove("tut-pulse"));
}

function render() {
    const panel = document.getElementById("tutorial-panel");
    if (!panel) return;
    const step = TUTORIAL_STEPS[tutorial.step];
    panel.classList.remove("hidden");
    const dots = TUTORIAL_STEPS.map((_, i) =>
        `<span class="inline-block w-1.5 h-1.5 rounded-full ${i <= tutorial.step ? "bg-amber-400" : "bg-gray-700"}"></span>`
    ).join(" ");
    panel.innerHTML =
        `<div class="flex gap-1 mb-2">${dots}</div>` +
        `<p class="text-sm text-gray-200 leading-relaxed">${i18n.t(step.key)}</p>` +
        `<div class="flex gap-2 mt-3">` +
        (step.showNext
            ? `<button id="tut-next" class="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-4 py-1.5 rounded">${i18n.t("tut_next")}</button>`
            : "") +
        `<button id="tut-skip" class="text-gray-500 hover:text-gray-300 text-xs px-2 py-1.5">${i18n.t("tut_skip")}</button>` +
        `</div>`;
    document.getElementById("tut-skip").addEventListener("click", skipTutorial);
    const next = document.getElementById("tut-next");
    if (next) next.addEventListener("click", () => { tutorialNext(); });
    clearPulse();
    if (step.pulse) {
        const btn = step.pulse === "__play"
            ? document.getElementById("btn-pause")
            : document.querySelector(`[data-tool="${step.pulse}"]`);
        if (btn) btn.classList.add("tut-pulse");
    }
}
