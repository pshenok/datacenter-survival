// Tutorial v2 — the ceremony-and-spotlight version (player feedback: v1 was
// a corner card nobody noticed).
//
// Three acts:
//   1. CEREMONY  — a centered welcome modal: "Привет, Оператор", the fantasy,
//      three you-will-learn chips, one big CTA. The world waits, paused.
//   2. SPOTLIGHT — per step the screen dims EXCEPT the control you need
//      (box-shadow cutout that tracks the target every frame), with a callout
//      bubble anchored to it by an arrow. Build steps are two-phase: first the
//      toolbar button, then — once the tool is picked — the open floor.
//   3. CELEBRATION — every completed step pops a green "got it" toast; the
//      finale spotlights the Play button and fires expanding rings when the
//      datacenter comes alive.
//
// The engine stays action-gated: a step advances when the player actually
// does the thing. Step predicates are pure functions of STATE.
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";

const DONE_KEY = "dc_tutorial_done";

// ---- step predicates -----------------------------------------------------
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
function toolIs(type) {
    return typeof window !== "undefined" && window.__activeToolForTutorial === type;
}

// Each step: text key, done() predicate, and target() — what the spotlight
// hugs RIGHT NOW (two-phase build steps switch target mid-step). target may
// return an element, "__canvas" (free floor), or null (no spotlight).
export const TUTORIAL_STEPS = [
    {
        key: "tut2_place_feed", check: "tut2_check_feed", done: () => has("grid_feed"),
        target: () => toolIs("grid_feed") ? "__canvas" : btn("grid_feed"),
        hint: () => toolIs("grid_feed") ? "tut2_hint_tile" : "tut2_hint_pick",
        celebrate: "tut2_yay_feed",
    },
    {
        key: "tut2_place_chain", check: "tut2_check_chain",
        done: () => has("transformer") && has("ups") && has("pdu"),
        target: () => {
            if (!has("transformer")) return toolIs("transformer") ? "__canvas" : btn("transformer");
            if (!has("ups")) return toolIs("ups") ? "__canvas" : btn("ups");
            return toolIs("pdu") ? "__canvas" : btn("pdu");
        },
        hint: () => {
            const next = !has("transformer") ? "transformer" : !has("ups") ? "ups" : "pdu";
            return toolIs(next) ? "tut2_hint_tile" : "tut2_hint_pick";
        },
        celebrate: "tut2_yay_chain",
    },
    {
        key: "tut2_wire_chain", check: "tut2_check_wire", done: () => !!poweredOf("pdu"),
        target: () => toolIs("wire") ? "__canvas" : btn("wire"),
        hint: () => toolIs("wire") ? "tut2_hint_wire_go" : "tut2_hint_wire_pick",
        celebrate: "tut2_yay_wire",
    },
    {
        key: "tut2_place_rack", check: "tut2_check_rack", done: () => !!poweredOf("rack"),
        target: () => has("rack") ? (toolIs("wire") ? "__canvas" : btn("wire"))
            : (toolIs("rack") ? "__canvas" : btn("rack")),
        hint: () => has("rack")
            ? (toolIs("wire") ? "tut2_hint_wire_rack" : "tut2_hint_wire_pick")
            : (toolIs("rack") ? "tut2_hint_tile" : "tut2_hint_pick"),
        celebrate: "tut2_yay_rack",
    },
    {
        key: "tut2_overlay", check: "tut2_check_overlay", done: () => tutorial.overlayTouched,
        target: () => document.getElementById("btn-overlay"),
        hint: () => "tut2_hint_overlay",
        celebrate: "tut2_yay_overlay",
    },
    {
        key: "tut2_place_crac", check: "tut2_check_crac", done: () => !!poweredOf("crac"),
        target: () => has("crac") ? (toolIs("wire") ? "__canvas" : btn("wire"))
            : (toolIs("crac") ? "__canvas" : btn("crac")),
        hint: () => has("crac")
            ? (toolIs("wire") ? "tut2_hint_wire_crac" : "tut2_hint_wire_pick")
            : (toolIs("crac") ? "tut2_hint_tile_near" : "tut2_hint_pick"),
        celebrate: "tut2_yay_crac",
    },
    {
        key: "tut2_finish", check: "tut2_check_play", done: () => STATE.timeScale > 0,
        target: () => document.getElementById("btn-pause"),
        hint: () => "tut2_hint_play",
        celebrate: null, // the finale has its own fireworks
    },
];

function btn(tool) {
    return document.querySelector(`[data-tool="${tool}"]`);
}

export const tutorial = {
    active: false,
    step: 0,
    overlayTouched: false,
};

export function shouldOfferTutorial() {
    try {
        return typeof localStorage === "undefined" || !localStorage.getItem(DONE_KEY);
    } catch {
        return true;
    }
}

// ---- ceremony ------------------------------------------------------------
export function showCeremony() {
    const m = document.getElementById("ceremony-modal");
    if (!m) return;
    m.classList.remove("hidden");
    document.getElementById("ceremony-start").onclick = () => {
        m.classList.add("hidden");
        beginSteps();
    };
    document.getElementById("ceremony-skip").onclick = () => {
        m.classList.add("hidden");
        finish(false);
    };
}

function beginSteps() {
    tutorial.active = true;
    tutorial.step = 0;
    tutorial.overlayTouched = false;
    renderChecklist();
    document.getElementById("tut-spotlight").classList.remove("hidden");
    document.getElementById("tut-callout").classList.remove("hidden");
    document.getElementById("tut-checklist").classList.remove("hidden");
}

export function skipTutorial() {
    finish(false);
}

function finish(celebrated) {
    tutorial.active = false;
    try {
        if (typeof localStorage !== "undefined") localStorage.setItem(DONE_KEY, "1");
    } catch { /* storage unavailable — the offer just repeats next run */ }
    for (const id of ["tut-spotlight", "tut-callout", "tut-checklist"]) {
        const el = document.getElementById(id);
        if (el) el.classList.add("hidden");
    }
    if (celebrated) fireFinale();
}

export function notifyOverlayToggled() {
    tutorial.overlayTouched = true;
}

// ---- per-frame drive -----------------------------------------------------
let lastHintKey = null;

export function tickTutorial() {
    if (!tutorial.active) return;
    const step = TUTORIAL_STEPS[tutorial.step];
    if (!step) return;

    if (step.done()) {
        if (step.celebrate) toast(i18n.t(step.celebrate));
        tutorial.step++;
        lastHintKey = null;
        if (tutorial.step >= TUTORIAL_STEPS.length) {
            finish(true);
            return;
        }
        renderChecklist();
        return;
    }
    positionSpotlight(step);
}

// ---- spotlight + callout -------------------------------------------------
function positionSpotlight(step) {
    const spot = document.getElementById("tut-spotlight");
    const callout = document.getElementById("tut-callout");
    if (!spot || !callout) return;

    const target = step.target();
    const hintKey = step.hint();
    if (hintKey !== lastHintKey) {
        lastHintKey = hintKey;
        callout.querySelector("p").textContent = i18n.t(hintKey);
    }

    if (target === "__canvas") {
        // Free-floor phase: lift the dimmer entirely, park the callout top-center.
        spot.style.opacity = "0";
        callout.style.left = "50%";
        callout.style.top = "110px";
        callout.style.transform = "translateX(-50%)";
        callout.classList.add("arrow-up");
        callout.classList.remove("arrow-down");
        return;
    }
    if (!target) { spot.style.opacity = "0"; return; }

    const r = target.getBoundingClientRect();
    const pad = 8;
    spot.style.opacity = "1";
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;

    // Callout above toolbar targets, below HUD targets.
    const isHud = r.top < window.innerHeight / 2;
    callout.style.transform = "none";
    callout.style.left = `${Math.max(12, Math.min(window.innerWidth - 292, r.left + r.width / 2 - 140))}px`;
    if (isHud) {
        callout.style.top = `${r.bottom + 18}px`;
        callout.classList.add("arrow-up");
        callout.classList.remove("arrow-down");
    } else {
        callout.style.top = `${r.top - callout.offsetHeight - 18}px`;
        callout.classList.add("arrow-down");
        callout.classList.remove("arrow-up");
    }
}

// ---- checklist -----------------------------------------------------------
function renderChecklist() {
    const host = document.getElementById("tut-checklist");
    if (!host) return;
    const rows = TUTORIAL_STEPS.map((s, i) => {
        const state = i < tutorial.step ? "done" : i === tutorial.step ? "now" : "todo";
        const mark = state === "done"
            ? '<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" d="M5 13l4 4L19 7"/></svg>'
            : state === "now" ? "▸" : "○";
        const cls = state === "done" ? "text-emerald-400" : state === "now" ? "text-amber-300 font-bold" : "text-gray-600";
        return `<div class="${cls} text-[11px] leading-5">${mark} ${i18n.t(s.check)}</div>`;
    }).join("");
    host.innerHTML =
        `<div class="text-[10px] text-gray-500 uppercase mb-1">${i18n.t("tut2_title", { n: Math.min(tutorial.step + 1, TUTORIAL_STEPS.length), total: TUTORIAL_STEPS.length })}</div>` +
        rows +
        `<button id="tut-skip" class="mt-2 text-gray-600 hover:text-gray-400 text-[10px]">${i18n.t("tut_skip")}</button>`;
    document.getElementById("tut-skip").addEventListener("click", skipTutorial);
}

// ---- celebrations --------------------------------------------------------
let toastTimer = null;
function toast(text) {
    const t = document.getElementById("tut-toast");
    if (!t) return;
    t.textContent = text;
    t.classList.remove("hidden");
    t.classList.remove("toast-pop");
    void t.offsetWidth; // restart the animation
    t.classList.add("toast-pop");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function fireFinale() {
    const btnEl = document.getElementById("btn-pause");
    const host = document.getElementById("tut-rings");
    if (btnEl && host) {
        const r = btnEl.getBoundingClientRect();
        host.style.left = `${r.left + r.width / 2}px`;
        host.style.top = `${r.top + r.height / 2}px`;
        host.classList.remove("hidden");
        host.innerHTML = '<span class="ring"></span><span class="ring" style="animation-delay:.18s"></span><span class="ring" style="animation-delay:.36s"></span>';
        setTimeout(() => host.classList.add("hidden"), 1400);
    }
    toast(i18n.t("tut2_finale"));
}
