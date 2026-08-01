// FAQ modal — tabbed reference. The Buildings tab is GENERATED from CONFIG at
// render time (the Server Survival lesson: docs written by hand drift; docs
// generated from config cannot lie about a cost or a capacity).
import { CONFIG } from "../core/config.js";
import { i18n } from "../i18n.js";

const TABS = ["basics", "buildings", "power", "heat", "events", "controls"];
let activeTab = "basics";

function buildingRows() {
    return Object.entries(CONFIG.buildings).map(([type, c]) => {
        const cap = c.chainRole === "load" && type === "crac"
            ? `${c.drawKw} kW ${i18n.t("faq_draw")}`
            : `${c.capacityKw} kW`;
        const extra = type === "ups" ? ` · ${c.bufferSec}s ${i18n.t("faq_buffer")}`
            : type === "crac" ? ` · ${i18n.t("faq_cools")} ${c.coolPerSec}/s, r=${c.radius}`
            : type === "rack" ? ` · $${c.revenuePerKwhServed}/kWh` : "";
        return `<div class="flex justify-between items-baseline py-1.5 border-b border-gray-800">
            <span class="text-white font-bold">${i18n.t("b_" + type)}</span>
            <span class="text-gray-400 text-right">$${c.cost} · ${cap}${extra}</span>
        </div>
        <p class="text-gray-500 text-[11px] mb-2">${i18n.t("faq_b_" + type)}</p>`;
    }).join("");
}

function tabContent() {
    switch (activeTab) {
        case "basics": return `
            <p>${i18n.t("faq_basics_1")}</p>
            <p>${i18n.t("faq_basics_2")}</p>
            <p>${i18n.t("faq_basics_3")}</p>`;
        case "buildings": return `<div class="text-xs">${buildingRows()}</div>`;
        case "power": return `
            <p>${i18n.t("faq_power_1")}</p>
            <p>${i18n.t("faq_power_2")}</p>
            <p>${i18n.t("faq_power_3")}</p>`;
        case "heat": return `
            <p>${i18n.t("faq_heat_1")}</p>
            <p>${i18n.t("faq_heat_2")}</p>
            <p class="text-cyan-300">${i18n.t("faq_pue")}</p>`;
        case "events": return `
            <p>${i18n.t("faq_events_1")}</p>
            <p>${i18n.t("faq_events_2")}</p>
            <p>${i18n.t("faq_events_3", { pct: Math.round(CONFIG.events.brownout.capacityFactor * 100) })}</p>
            <p>${i18n.t("faq_events_4", { cost: CONFIG.events.cracBreakdown.repairCost, wait: CONFIG.events.cracBreakdown.selfRepairSec })}</p>
            <p>${i18n.t("faq_events_5")}</p>`;
        case "controls": return `
            <p>${i18n.t("faq_controls_1")}</p>
            <p>${i18n.t("faq_controls_2")}</p>`;
        default: return "";
    }
}

export function renderFaq() {
    const host = document.getElementById("faq-content");
    if (!host) return;
    const tabs = TABS.map((t) =>
        `<button data-faqtab="${t}" class="px-3 py-1.5 rounded text-xs uppercase ${t === activeTab ? "bg-amber-600 text-white" : "text-gray-400 hover:text-white"}">${i18n.t("faq_tab_" + t)}</button>`
    ).join("");
    host.innerHTML =
        `<div class="flex flex-wrap gap-1 mb-4 border-b border-gray-700 pb-3">${tabs}</div>` +
        `<div class="space-y-3 text-sm text-gray-300 leading-relaxed max-h-[50vh] overflow-y-auto pr-2">${tabContent()}</div>`;
    host.querySelectorAll("[data-faqtab]").forEach((b) =>
        b.addEventListener("click", () => { activeTab = b.dataset.faqtab; renderFaq(); })
    );
}

export function openFaq() {
    document.getElementById("faq-modal").classList.remove("hidden");
    renderFaq();
}
export function closeFaq() {
    document.getElementById("faq-modal").classList.add("hidden");
}
