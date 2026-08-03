// HUD numbers, event banner, contract line, inspect panel, and the
// best-run stats persisted to localStorage (guarded for node, like i18n).
// Reads STATE, writes DOM only.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";

const el = (id) => document.getElementById(id);
let bestPue = Infinity;
let peakDemand = 0;
let peakServed = 0;

export function resetHudStats() {
    bestPue = Infinity;
    peakDemand = 0;
    peakServed = 0;
}
export function getRunStats() {
    return { bestPue, peakDemand, peakServed };
}

export function tickHud() {
    el("hud-money").textContent = `$${Math.floor(STATE.money)}`;
    el("hud-money").className = `text-lg font-bold ${STATE.money >= 0 ? "text-green-400" : "text-red-400"}`;
    // Peak-tariff pill: the meter is the only thing this event touches, so
    // it has to be visible on the money, not in a banner that scrolls away.
    const tariffEl = el("hud-tariff");
    if (tariffEl) {
        tariffEl.textContent = i18n.t("tariff_pill", { mult: STATE.tariff.multiplier });
        tariffEl.classList.toggle("hidden", !STATE.tariff.active);
    }
    el("hud-rep").textContent = `${Math.round(STATE.reputation)}%`;
    el("hud-demand").textContent = `${STATE.demandKw.toFixed(1)} kW`;
    el("hud-served").textContent = `${STATE.servedKw.toFixed(1)} kW`;
    peakDemand = Math.max(peakDemand, STATE.demandKw);
    peakServed = Math.max(peakServed, STATE.servedKw);

    const pue = STATE.itDrawKw > 0.05 ? STATE.totalDrawKw / STATE.itDrawKw : null;
    if (pue !== null) {
        bestPue = Math.min(bestPue, pue);
        el("hud-pue").textContent = pue.toFixed(2);
        el("hud-pue").className = `text-lg font-bold ${pue < 1.4 ? "text-cyan-300" : pue < 1.9 ? "text-amber-300" : "text-red-400"}`;
    } else {
        el("hud-pue").textContent = "—";
    }

    // Active-contract line under the event banner.
    const c = STATE.contract;
    const line = el("contract-line");
    if (line) {
        if (c.key !== null && c.done === null) {
            line.textContent = i18n.t("contract_hud", {
                name: contractLabel(c),
                progress: Math.floor(c.progress),
                target: c.target,
                left: Math.max(0, Math.ceil(c.endsAt - STATE.elapsedGameTime)),
            });
            line.classList.remove("hidden");
        } else {
            line.classList.add("hidden");
        }
    }
}

// Human label for a contract from STATE.contract — shared by the HUD line
// and game.js's offer banner.
export function contractLabel(c) {
    const cfg = CONFIG.contracts.pool.find((p) => p.key === c.key);
    return i18n.t("contract_" + c.key, {
        target: c.target,
        pue: cfg && cfg.pueBelow,
    });
}

let bannerTimer = null;
export function showBanner(text, ms = 4000) {
    const b = el("event-banner");
    b.textContent = text;
    b.classList.remove("hidden");
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => b.classList.add("hidden"), ms);
}

export function renderInspect(b) {
    const panel = el("inspect-panel");
    if (!b) {
        panel.classList.add("hidden");
        return;
    }
    const rows = [];
    rows.push(`<div class="text-sm font-bold text-white mb-2">${i18n.t("b_" + b.type)}</div>`);
    if (b.config.chainRole === "load" && !b.powered) {
        rows.push(`<div class="text-red-400 font-bold mb-1">${i18n.t("insp_unpowered")}</div>`);
    }
    if (b.type === "rack") {
        rows.push(row(i18n.t("insp_load"), `${b.actualKw.toFixed(1)} / ${b.config.capacityKw} kW`));
        rows.push(row(i18n.t("insp_temp"), `${b.tempC.toFixed(1)}°C`));
    } else if (b.type === "crac") {
        if (b.broken) {
            rows.push(`<div class="text-red-400 font-bold mb-1">${i18n.t("insp_broken", { cost: CONFIG.events.cracBreakdown.repairCost })}</div>`);
        }
        // The BILLED number, like the rack and generator rows — never a
        // formula restated here. Under part-load draw an idling CRAC still
        // costs ~idleDrawKw, and this panel is where a player goes to find
        // out why their PUE is bad; a recomputed duty×full would deny the
        // very mechanic it should be exposing.
        rows.push(row(i18n.t("insp_draw"), `${b.actualKw.toFixed(1)} kW`));
        rows.push(row(i18n.t("insp_duty"), `${Math.round(b.duty * 100)}%`));
    } else if (b.type === "ups") {
        rows.push(row(i18n.t("insp_buffer"), `${b.bufferLeft.toFixed(1)}s / ${b.config.bufferSec}s`));
    } else if (b.type === "generator") {
        rows.push(row(i18n.t("insp_fuel"), `${b.fuelLiters.toFixed(0)} / ${b.config.tankLiters} L`));
        rows.push(row(i18n.t("insp_draw"), `${b.actualKw.toFixed(1)} / ${b.config.capacityKw} kW`));
        if (b.fuelArrivesAt !== null) {
            rows.push(`<div class="text-amber-300 mb-1">${i18n.t("insp_fuel_incoming", {
                s: Math.max(0, Math.ceil(b.fuelArrivesAt - STATE.elapsedGameTime)),
            })}</div>`);
        } else if (b.fuelLiters < b.config.tankLiters) {
            rows.push(`<div class="text-gray-500 text-[11px] mb-1">${i18n.t("insp_fuel_hint", { cost: b.config.fuelCost })}</div>`);
        }
    } else {
        rows.push(row(i18n.t("insp_draw"), `cap ${b.config.capacityKw} kW`));
    }
    panel.innerHTML = rows.join("");
    panel.classList.remove("hidden");
}

function row(k, v) {
    return `<div class="flex justify-between py-0.5"><span class="text-gray-500">${k}</span><span>${v}</span></div>`;
}

// ---- best-run stats (localStorage, guarded like i18n for node) ----------
const BEST_KEY = "dc_best_run";

function fmtTime(sec) {
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

function loadBest() {
    try {
        if (typeof localStorage === "undefined") return null;
        const raw = localStorage.getItem(BEST_KEY);
        if (!raw) return null;
        const b = JSON.parse(raw);
        return {
            timeSec: Number.isFinite(b.timeSec) ? b.timeSec : 0,
            peakServedKw: Number.isFinite(b.peakServedKw) ? b.peakServedKw : 0,
            bestPue: Number.isFinite(b.bestPue) ? b.bestPue : null,
        };
    } catch {
        return null; // corrupted storage — start a fresh record
    }
}

function saveBest(best) {
    try {
        if (typeof localStorage !== "undefined") localStorage.setItem(BEST_KEY, JSON.stringify(best));
    } catch { /* storage unavailable — the record just isn't kept */ }
}

// Fold this run into the stored record (each metric bests independently)
// and return the updated record.
function updateBest(timeSec, stats) {
    const prev = loadBest() || { timeSec: 0, peakServedKw: 0, bestPue: null };
    const runPue = isFinite(stats.bestPue) ? stats.bestPue : null;
    const best = {
        timeSec: Math.max(prev.timeSec, timeSec),
        peakServedKw: Math.max(prev.peakServedKw, stats.peakServed),
        bestPue: runPue === null ? prev.bestPue
            : prev.bestPue === null ? runPue : Math.min(prev.bestPue, runPue),
    };
    saveBest(best);
    return best;
}

export function showGameOver(reason) {
    const stats = getRunStats();
    const best = updateBest(STATE.elapsedGameTime, stats);
    document.getElementById("gameover-reason").textContent = i18n.t("gameover_" + reason);
    const statsEl = document.getElementById("gameover-stats");
    statsEl.textContent = i18n.t("gameover_stats", {
        time: fmtTime(STATE.elapsedGameTime),
        kw: stats.peakDemand.toFixed(0),
        pue: isFinite(stats.bestPue) ? stats.bestPue.toFixed(2) : "—",
    });
    const bestLine = document.createElement("span");
    bestLine.className = "block text-gray-600 mt-1";
    bestLine.textContent = i18n.t("gameover_best", {
        time: fmtTime(best.timeSec),
        kw: best.peakServedKw.toFixed(0),
        pue: best.bestPue !== null ? best.bestPue.toFixed(2) : "—",
    });
    statsEl.appendChild(bestLine);
    document.getElementById("gameover-modal").classList.remove("hidden");
}
