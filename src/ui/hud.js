// HUD numbers, event banner, inspect panel. Reads STATE, writes DOM only.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";

const el = (id) => document.getElementById(id);
let bestPue = Infinity;
let peakDemand = 0;

export function resetHudStats() {
    bestPue = Infinity;
    peakDemand = 0;
}
export function getRunStats() {
    return { bestPue, peakDemand };
}

export function tickHud() {
    el("hud-money").textContent = `$${Math.floor(STATE.money)}`;
    el("hud-money").className = `text-lg font-bold ${STATE.money >= 0 ? "text-green-400" : "text-red-400"}`;
    el("hud-rep").textContent = `${Math.round(STATE.reputation)}%`;
    el("hud-demand").textContent = `${STATE.demandKw.toFixed(1)} kW`;
    el("hud-served").textContent = `${STATE.servedKw.toFixed(1)} kW`;
    peakDemand = Math.max(peakDemand, STATE.demandKw);

    const pue = STATE.itDrawKw > 0.05 ? STATE.totalDrawKw / STATE.itDrawKw : null;
    if (pue !== null) {
        bestPue = Math.min(bestPue, pue);
        el("hud-pue").textContent = pue.toFixed(2);
        el("hud-pue").className = `text-lg font-bold ${pue < 1.4 ? "text-cyan-300" : pue < 1.9 ? "text-amber-300" : "text-red-400"}`;
    } else {
        el("hud-pue").textContent = "—";
    }
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
        rows.push(row(i18n.t("insp_draw"), `${(b.config.drawKw * b.duty).toFixed(1)} kW`));
        rows.push(row(i18n.t("insp_duty"), `${Math.round(b.duty * 100)}%`));
    } else if (b.type === "ups") {
        rows.push(row(i18n.t("insp_buffer"), `${b.bufferLeft.toFixed(1)}s / ${b.config.bufferSec}s`));
    } else {
        rows.push(row(i18n.t("insp_draw"), `cap ${b.config.capacityKw} kW`));
    }
    panel.innerHTML = rows.join("");
    panel.classList.remove("hidden");
}

function row(k, v) {
    return `<div class="flex justify-between py-0.5"><span class="text-gray-500">${k}</span><span>${v}</span></div>`;
}

export function showGameOver(reason) {
    const stats = getRunStats();
    const mins = Math.floor(STATE.elapsedGameTime / 60);
    const secs = Math.floor(STATE.elapsedGameTime % 60);
    document.getElementById("gameover-reason").textContent = i18n.t("gameover_" + reason);
    document.getElementById("gameover-stats").textContent = i18n.t("gameover_stats", {
        time: `${mins}:${String(secs).padStart(2, "0")}`,
        kw: stats.peakDemand.toFixed(0),
        pue: isFinite(stats.bestPue) ? stats.bestPue.toFixed(2) : "—",
    });
    document.getElementById("gameover-modal").classList.remove("hidden");
}
