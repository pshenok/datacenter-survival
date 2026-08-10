// Campaign UI: level-select modal, in-level objectives panel, level-result
// modal. Reads campaign/campaign.js state; owns no sim fields. game.js
// wires the window boundary (openCampaign / startCampaignLevel / …) and
// hands us a freeze() callback so play/pause UI stays game.js's business.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { completedLevels, isLevelUnlocked, levelOrder, earnedBonuses } from "../campaign/campaign.js";
import { isLab } from "../campaign/lab.js";
import { showBanner, renderLossLedger } from "./hud.js";
import { i18n } from "../i18n.js";

let freeze = () => {};
let lastResolved = null;   // level id whose result modal we already showed

export function initCampaignUi(opts) {
    freeze = opts.freeze;
    // The level list renders on open; re-render it live if the player
    // switches locale while the modal is up.
    window.addEventListener("localeChanged", () => {
        if (!document.getElementById("campaign-modal").classList.contains("hidden")) {
            renderCampaignLevels();
        }
    });
    document.getElementById("level-result-menu").addEventListener("click", () => {
        hideResult();
        window.backToMenu();
    });
    document.getElementById("level-result-retry").addEventListener("click", () => {
        hideResult();
        window.launchCampaignLevel(STATE.campaign.levelId);   // rerun, no briefing
    });
    document.getElementById("level-result-next").addEventListener("click", () => {
        const order = levelOrder();
        const next = order[order.indexOf(STATE.campaign.levelId) + 1];
        hideResult();
        if (next) window.startCampaignLevel(next);            // new level → briefing
        else window.backToMenu();
    });
}

// ---- level select --------------------------------------------------------
export function renderCampaignLevels() {
    const host = document.getElementById("campaign-levels");
    if (!host) return;
    const done = completedLevels();
    const earned = earnedBonuses();
    const order = levelOrder();
    host.innerHTML = CONFIG.campaign.chapters.map((ch) => {
        const rows = ch.levels.map((id) => {
            const unlocked = isLevelUnlocked(id, done);
            const finished = done.includes(id);
            const n = order.indexOf(id) + 1;
            // A star next to the tick when every bonus on the level is taken.
            const bonusCfg = CONFIG.campaign.levels[id].bonuses || [];
            const gotAll = bonusCfg.length > 0 && (earned[id] || []).length >= bonusCfg.length;
            const mark = finished
                ? `<span class="text-emerald-400">✓</span>${gotAll ? '<span class="text-amber-300">★</span>' : ""}`
                : unlocked ? `<span class="text-gray-500">${n}</span>`
                    : '<span class="text-gray-700">🔒</span>';
            const cls = unlocked
                ? "glass-panel hover:border-emerald-500/60 cursor-pointer"
                : "glass-panel opacity-40 cursor-not-allowed";
            return `<button data-level="${id}" ${unlocked ? "" : "disabled"}
                class="${cls} w-full text-left rounded-lg px-4 py-3 mb-2 flex items-center gap-3">
                <span class="w-8 text-center font-bold whitespace-nowrap">${mark}</span>
                <span class="flex-1">
                    <span class="block text-sm font-bold text-white">${i18n.t("lv_" + id)}</span>
                    <span class="block text-[11px] text-gray-500">${i18n.t("lv_" + id + "_brief")}</span>
                </span>
            </button>`;
        }).join("");
        return `<p class="text-emerald-300/80 text-xs uppercase tracking-wide mb-2 mt-3 first:mt-0">${i18n.t(ch.titleKey)}</p>${rows}`;
    }).join("");
    for (const btn of host.querySelectorAll("button[data-level]")) {
        if (!btn.disabled) {
            btn.addEventListener("click", () => window.startCampaignLevel(btn.dataset.level));
        }
    }
}

export function openCampaign() {
    renderCampaignLevels();
    document.getElementById("campaign-modal").classList.remove("hidden");
}

export function closeCampaign() {
    document.getElementById("campaign-modal").classList.add("hidden");
}

// ---- level briefing ------------------------------------------------------
// The SS pattern: a level NEVER starts cold. The briefing explains the
// scenario, the lesson, and the win conditions — the level launches only
// from its Start button (retry skips the briefing, next-level shows it).
export function openBriefing(id) {
    const cfg = CONFIG.campaign.levels[id];
    const ch = CONFIG.campaign.chapters.find((c) => c.levels.includes(id));
    document.getElementById("briefing-chapter").textContent = ch ? i18n.t(ch.titleKey) : "";
    document.getElementById("briefing-title").textContent = i18n.t("lv_" + id);
    document.getElementById("briefing-scenario").textContent = i18n.t("lv_" + id + "_scenario");
    document.getElementById("briefing-learn").textContent = i18n.t("lv_" + id + "_learn");
    // A sandbox level has no goals and no clock, and printing the time limit
    // it carries (inert — see CONFIG.campaign.levels.the_lab) would be the
    // one lie the briefing tells.
    const goals = cfg.sandbox ? [i18n.t("lab_goal_none")] : cfg.objectives.map(objectiveLabel);
    if (!cfg.sandbox) {
        goals.push(i18n.t("brief_time", { s: cfg.timeLimitSec }));
        for (const b of cfg.bonuses || []) goals.push(`☆ ${objectiveLabel(b)}`);
    }
    document.getElementById("briefing-goals").innerHTML =
        goals.map((g) => `<li>${g}</li>`).join("");
    document.getElementById("briefing-start").onclick = () => window.launchCampaignLevel(id);
    document.getElementById("briefing-modal").classList.remove("hidden");
}

export function closeBriefing() {
    document.getElementById("briefing-modal").classList.add("hidden");
}

// ---- in-level UI ---------------------------------------------------------
export function onLevelStart(id) {
    lastResolved = null;
    // The Lab has nothing to track and no clock to count down; its knob
    // panel (src/ui/lab-panel.js) takes the same slot.
    const sandbox = !!CONFIG.campaign.levels[id].sandbox;
    document.getElementById("objectives-panel").classList.toggle("hidden", sandbox);
    if (!sandbox) renderObjectives();
    showBanner(i18n.t("lv_" + id + "_brief"), 7000);
}

function objectiveLabel(o) {
    if (o.type === "serve_kwh") return i18n.t("obj_serve_kwh", { target: o.target });
    if (o.type === "serve_kwh_during_event") return i18n.t("obj_serve_during", { target: o.target });
    if (o.type === "pue_below") return i18n.t("obj_pue_below", { value: o.value, hold: o.holdSec });
    if (o.type === "money_at_least") return i18n.t("obj_money_left", { target: o.target });
    if (o.type === "maintenance_without_loss") {
        return i18n.t("obj_maintenance", { pct: Math.round(o.minServedRatio * 100) });
    }
    return i18n.t("obj_no_throttle", { hold: o.holdSec });
}

function bonusRow(o) {
    const mark = o.done ? "★" : "☆";
    const cls = o.done ? "text-amber-300" : "text-gray-500";
    return `<div class="${cls} text-[11px] leading-5">${mark} ${objectiveLabel(o)}</div>`;
}

function objectiveRow(o) {
    let label;
    let progress;
    if (o.type === "serve_kwh") {
        label = i18n.t("obj_serve_kwh", { target: o.target });
        progress = `${Math.min(o.progress, o.target).toFixed(1)} / ${o.target}`;
    } else if (o.type === "serve_kwh_during_event") {
        label = i18n.t("obj_serve_during", { target: o.target });
        progress = `${Math.min(o.progress, o.target).toFixed(1)} / ${o.target}`;
    } else if (o.type === "pue_below") {
        label = i18n.t("obj_pue_below", { value: o.value, hold: o.holdSec });
        progress = `${Math.floor(Math.min(o.progress, o.holdSec))} / ${o.holdSec}s`;
    } else if (o.type === "maintenance_without_loss") {
        label = i18n.t("obj_maintenance", { pct: Math.round(o.minServedRatio * 100) });
        const orders = STATE.maintenance.orders;
        const done = orders.filter((m) => m.state === "done").length;
        progress = `${done} / ${orders.length}`;
    } else {
        label = i18n.t("obj_no_throttle", { hold: o.holdSec });
        progress = `${Math.floor(Math.min(o.progress, o.holdSec))} / ${o.holdSec}s`;
    }
    const mark = o.done
        ? '<span class="text-emerald-400">✓</span>'
        : '<span class="text-gray-600">○</span>';
    const cls = o.done ? "text-emerald-400" : "text-gray-300";
    return `<div class="${cls} text-[11px] leading-5 flex justify-between gap-2">
        <span>${mark} ${label}</span><span class="text-gray-500 whitespace-nowrap">${progress}</span>
    </div>`;
}

function renderObjectives() {
    const host = document.getElementById("objectives-panel");
    const camp = STATE.campaign;
    if (!host || camp.levelId === null) return;
    const left = Math.max(0, Math.ceil(camp.endsAt - STATE.elapsedGameTime));
    host.innerHTML =
        `<div class="text-[10px] text-emerald-300/80 uppercase tracking-wide mb-1">${i18n.t("lv_" + camp.levelId)}</div>` +
        camp.objectives.map(objectiveRow).join("") +
        (camp.bonuses.length
            ? `<div class="text-[10px] text-amber-300/70 uppercase tracking-wide mt-2 mb-0.5">${i18n.t("obj_bonus")}</div>`
              + camp.bonuses.map(bonusRow).join("")
            : "") +
        `<div class="text-[10px] text-gray-500 mt-1">${i18n.t("obj_time_left", { s: left })}</div>`;
}

// ---- per-frame -----------------------------------------------------------
export function tickCampaignUi() {
    const camp = STATE.campaign;
    if (camp.levelId === null) return;
    // A sandbox level never resolves and has no objective rows to draw, so
    // there is nothing here for it — and rendering the timer into a hidden
    // panel every frame would leave a countdown waiting to be un-hidden.
    if (isLab()) return;

    if (camp.done === null) {
        renderObjectives();
        return;
    }
    if (lastResolved === camp.levelId) return;
    lastResolved = camp.levelId;

    freeze();
    document.getElementById("objectives-panel").classList.add("hidden");
    const title = document.getElementById("level-result-title");
    const sub = document.getElementById("level-result-sub");
    const next = document.getElementById("level-result-next");
    const retry = document.getElementById("level-result-retry");
    // The debrief tip: the highest-attention moment in the game, so it
    // carries the real-world takeaway — and the LOSS path gets its own,
    // because that is where a player actually wants to know why.
    const tip = document.getElementById("level-result-tip");
    if (camp.done === "won") {
        title.textContent = i18n.t("level_won_title");
        title.className = "text-3xl font-black mb-2 text-emerald-400";
        sub.textContent = i18n.t("level_won_sub", { time: Math.round(STATE.elapsedGameTime) });
        if (tip) tip.textContent = i18n.t(`lv_${camp.levelId}_tip`);
        if (camp.bonuses.length) {
            sub.textContent += "  " + camp.bonuses.map((b) => (b.done ? "★" : "☆")).join("");
        }
        const order = levelOrder();
        const hasNext = order.indexOf(camp.levelId) < order.length - 1;
        next.classList.toggle("hidden", !hasNext);
        retry.classList.add("hidden");
    } else {
        // Only a real timeout gets the clock headline; a collapse gets its own.
        title.textContent = i18n.t(camp.reason === "fail_time" || !camp.reason
            ? "level_failed_title" : "level_down_title");
        title.className = "text-3xl font-black mb-2 text-red-400";
        // Name what ended the run, not a shrug.
        sub.textContent = i18n.t(camp.reason || "level_failed_sub");
        if (tip) tip.textContent = i18n.t(`lv_${camp.levelId}_tip_fail`);
        next.classList.add("hidden");
        retry.classList.remove("hidden");
    }
    if (tip) tip.classList.toggle("hidden", !tip.textContent || tip.textContent.startsWith("lv_"));
    renderLossLedger("level-result-ledger");
    document.getElementById("level-result-modal").classList.remove("hidden");
}

function hideResult() {
    document.getElementById("level-result-modal").classList.add("hidden");
}
