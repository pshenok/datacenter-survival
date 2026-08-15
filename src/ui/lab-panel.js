// The Lab's knob panel. Renders only while a `sandbox` level is running,
// and is a VIEW over STATE: every reading below is read back out of the
// simulation rather than remembered here, and every control calls a callback
// game.js handed us (which calls campaign/lab.js). This module never writes
// STATE — the src/ui/* boundary rule, and the reason the whole mechanic is
// provable headless in tests/lab.test.mjs.
//
// Built ONCE per level start, not re-rendered per frame: these are buttons
// with listeners, and replacing the DOM under a player's finger loses the
// click. That splits the locale problem in two, and both halves use a
// mechanism docs/ARCHITECTURE.md names — static labels carry `data-i18n`, so
// i18n.applyTranslations() relabels them on a switch; the live readings are
// re-rendered every frame through i18n.t and are therefore never stale.
//
// Icons are inline SVG. No emoji anywhere in product UI.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";
import { isLab, labTariffMode, LAB_LIMITS, LAB_EVENTS } from "../campaign/lab.js";

const ICONS = {
    heatwave: '<circle cx="12" cy="12" r="4"/><path stroke-linecap="round" d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    brownout: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 3 6 13h4l-1 8 7-10h-4z"/><path stroke-linecap="round" d="M3 20h4M17 20h4"/>',
    outage: '<path stroke-linecap="round" stroke-linejoin="round" d="M13 3 8 10h3l-1 5"/><path stroke-linecap="round" d="M4 4l16 16"/>',
    tariff: '<path stroke-linecap="round" d="M12 4v16M15.5 8a3.5 3 0 0 0-3.5-2c-2 0-3.5 1-3.5 2.5S10 11 12 11.5s3.5 1 3.5 2.5-1.5 2.5-3.5 2.5a3.5 3 0 0 1-3.5-2"/>',
    drought: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3S7 9.5 7 13a5 5 0 0 0 10 0c0-3.5-5-10-5-10z"/><path stroke-linecap="round" d="M3 21h4m3 0h2m3 0h4"/>',
    crac_fail: '<rect x="3" y="7" width="14" height="11" rx="1"/><circle cx="10" cy="12.5" r="2.4"/><path stroke-linecap="round" d="M18 6l4 4m0-4-4 4"/>',
};

const FIRE_LABELS = {
    heatwave: "lab_fire_heatwave",
    brownout: "lab_fire_brownout",
    outage: "lab_fire_outage",
    tariff: "lab_fire_tariff",
    drought: "lab_fire_drought",
    crac_fail: "lab_fire_crac",
};

const MINUS = '<path stroke-linecap="round" d="M6 12h12"/>';
const PLUS = '<path stroke-linecap="round" d="M12 6v12M6 12h12"/>';
const RESET = '<path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6"/><path stroke-linecap="round" d="M4.6 13a8 8 0 1 0 1.5-6"/>';

let cb = {
    setDemandKw: () => {},
    setAmbientC: () => {},
    setTariffBand: () => {},
    fire: () => {},
    reset: () => {},
};
let built = false;

export function initLabPanel(opts) {
    cb = { ...cb, ...opts };
}

const el = (id) => document.getElementById(id);
const icon = (paths, cls = "w-4 h-4") =>
    `<svg class="${cls}" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">${paths}</svg>`;

// A -/+ row: the label is static (data-i18n), the reading is live.
function stepper(key, labelKey) {
    return `<div class="flex items-center justify-between gap-1 mb-1.5">
        <span class="text-[10px] text-gray-400 uppercase tracking-wide" data-i18n="${labelKey}">${i18n.t(labelKey)}</span>
        <span class="flex items-center gap-1">
            <button data-lab-step="${key}:-1" class="glass-panel rounded px-1.5 py-1 text-gray-300 hover:text-white">${icon(MINUS, "w-3 h-3")}</button>
            <span id="lab-val-${key}" class="text-[11px] font-bold text-white w-14 text-center tabular-nums"></span>
            <button data-lab-step="${key}:1" class="glass-panel rounded px-1.5 py-1 text-gray-300 hover:text-white">${icon(PLUS, "w-3 h-3")}</button>
        </span>
    </div>`;
}

function bandButton(mode, labelKey) {
    return `<button data-lab-band="${mode}" class="glass-panel rounded px-1 py-1 text-[9px] uppercase" data-i18n="${labelKey}">${i18n.t(labelKey)}</button>`;
}

// Generated from LAB_EVENTS, the same list campaign/lab.js fires from — the
// toolbar's rule, so a sixth event cannot ship with no button for it.
function fireButton(kind) {
    const labelKey = FIRE_LABELS[kind];
    return `<button data-lab-fire="${kind}"
        class="glass-panel rounded-lg py-1.5 flex flex-col items-center justify-center gap-0.5 text-gray-300 hover:text-white hover:border-amber-500/60">
        ${icon(ICONS[kind])}
        <span class="text-[8px] uppercase leading-none text-center" data-i18n="${labelKey}">${i18n.t(labelKey)}</span>
    </button>`;
}

function build(host) {
    host.innerHTML =
        `<div class="text-[10px] text-amber-300/90 uppercase tracking-wide font-bold" data-i18n="lab_title">${i18n.t("lab_title")}</div>`
        + `<div class="text-[9px] text-gray-500 mb-2" data-i18n="lab_sub">${i18n.t("lab_sub")}</div>`
        + stepper("demand", "lab_demand")
        + stepper("ambient", "lab_ambient")
        + `<div class="flex items-center justify-between gap-1 mb-2">
            <span class="text-[10px] text-gray-400 uppercase tracking-wide" data-i18n="lab_meter">${i18n.t("lab_meter")}</span>
            <span class="grid grid-cols-4 gap-1">
                ${bandButton("auto", "lab_band_auto")}
                ${bandButton("night", "tariff_band_night")}
                ${bandButton("day", "tariff_band_day")}
                ${bandButton("off", "lab_band_off")}
            </span>
        </div>`
        + `<div class="text-[10px] text-gray-400 uppercase tracking-wide mb-1 pt-1 border-t border-gray-700" data-i18n="lab_fire">${i18n.t("lab_fire")}</div>`
        + `<div class="grid grid-cols-3 gap-1 mb-2">${LAB_EVENTS.map(fireButton).join("")}</div>`
        + `<button id="lab-reset" class="glass-panel rounded-lg w-full py-1.5 flex items-center justify-center gap-1.5 text-gray-300 hover:text-white text-[10px] uppercase">
            ${icon(RESET, "w-3 h-3")}<span data-i18n="lab_reset">${i18n.t("lab_reset")}</span>
        </button>`;

    for (const btn of host.querySelectorAll("[data-lab-step]")) {
        const [knob, dir] = btn.dataset.labStep.split(":");
        btn.addEventListener("click", () => step(knob, Number(dir)));
    }
    for (const btn of host.querySelectorAll("[data-lab-band]")) {
        btn.addEventListener("click", () => cb.setTariffBand(btn.dataset.labBand));
    }
    for (const btn of host.querySelectorAll("[data-lab-fire]")) {
        btn.addEventListener("click", () => cb.fire(btn.dataset.labFire));
    }
    el("lab-reset").addEventListener("click", () => cb.reset());
    built = true;
}

// Read the knob's current position out of STATE, move it one step, hand it
// back. The clamping lives in campaign/lab.js with the rest of the rules —
// a second copy here is a second answer to "how far does this go".
function step(knob, dir) {
    if (knob === "demand") {
        cb.setDemandKw((STATE.demandFixedKw || 0) + dir * LAB_LIMITS.demandKw.step);
    } else {
        cb.setAmbientC(ambientReading() + dir * LAB_LIMITS.ambientC.step);
    }
}

// An unset ambient override reads as CONFIG's own ambient — the knob shows
// where the room actually IS, so the first click moves from there and not
// from zero.
function ambientReading() {
    return STATE.lab.ambientC === null ? CONFIG.heat.ambientC : STATE.lab.ambientC;
}

export function hideLabPanel() {
    const host = el("lab-panel");
    if (host) host.classList.add("hidden");
}

// Per-frame. Hidden unless a sandbox level is actually running, so the panel
// cannot paint over the main menu or over any of the thirteen real levels.
export function tickLabPanel() {
    const host = el("lab-panel");
    if (!host) return;
    const show = STATE.isRunning && isLab();
    host.classList.toggle("hidden", !show);
    if (!show) return;
    if (!built) build(host);

    el("lab-val-demand").textContent = i18n.t("lab_val_kw", { v: Math.round(STATE.demandFixedKw || 0) });
    el("lab-val-ambient").textContent = i18n.t("lab_val_c", { v: Math.round(ambientReading()) });

    const mode = labTariffMode();
    for (const btn of host.querySelectorAll("[data-lab-band]")) {
        const active = btn.dataset.labBand === mode;
        btn.classList.toggle("text-amber-300", active);
        btn.classList.toggle("border-amber-500/60", active);
        btn.classList.toggle("text-gray-400", !active);
    }
}

// A level start rebuilds the panel: the level's own starting values are the
// knob positions, and a stale DOM from a previous run would keep its
// listeners pointing at nothing in particular.
export function resetLabPanel() {
    built = false;
    const host = el("lab-panel");
    if (host) host.innerHTML = "";
}
