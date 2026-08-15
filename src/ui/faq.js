// FAQ modal — tabbed reference. The Buildings tab is GENERATED from CONFIG at
// render time (the Server Survival lesson: docs written by hand drift; docs
// generated from config cannot lie about a cost or a capacity).
import { CONFIG } from "../core/config.js";
import { i18n } from "../i18n.js";

const TABS = ["basics", "buildings", "power", "heat", "cooling", "water", "tariff", "shaving", "events", "losses", "controls"];
let activeTab = "basics";

function buildingRows() {
    return Object.entries(CONFIG.buildings).map(([type, c]) => {
        const cap = c.drawKw !== undefined
            ? `${c.drawKw} kW ${i18n.t("faq_draw")}`
            : `${c.capacityKw} kW`;
        const extra = type === "chiller" ? ` · ${c.coolUnits} ${i18n.t("faq_loop_supply")}`
            : type === "ups" ? ` · ${c.bufferSec}s ${i18n.t("faq_buffer")}`
            : c.coolPerSec ? ` · ${i18n.t("faq_cools")} ${c.coolPerSec}/s, r=${c.radius}`
            : type === "rack" ? ` · $${c.revenuePerKwhServed}/kWh` : "";
        return `<div class="flex justify-between items-baseline py-1.5 border-b border-gray-800">
            <span class="text-white font-bold">${i18n.t("b_" + type)}</span>
            <span class="text-gray-400 text-right">$${c.cost} · ${cap}${extra}</span>
        </div>
        <p class="text-gray-500 text-[11px] mb-2">${i18n.t("faq_b_" + type)}</p>`;
    }).join("");
}

function bandRows() {
    const cfg = CONFIG.tariff;
    return cfg.bands.map((b, i) => {
        const next = cfg.bands[i + 1];
        const to = next ? next.fromSec : cfg.periodSec;
        return `<div class="flex justify-between py-1 border-b border-gray-800">
            <span class="text-white font-bold">${i18n.t("tariff_band_" + b.key)}</span>
            <span class="text-gray-400">${b.fromSec}–${to}s · <span class="${b.mult > 1 ? "text-amber-300" : "text-emerald-300"}">×${b.mult}</span></span>
        </div>`;
    }).join("");
}

// Every number here is derived from CONFIG.buildings.ups, for the same
// reason the buildings table and the tariff bands are: a page that tells the
// player what a round trip costs must not be able to drift from the code
// that charges them for it.
function shavingRows() {
    const u = CONFIG.buildings.ups;
    const chargerKw = (u.capacityKw * u.rechargeRate) / u.roundTripEff;
    const storedKwh = (u.capacityKw * u.bufferSec) / 60;   // billing-hour scale
    const spread = CONFIG.tariff.bands[1].mult / CONFIG.tariff.bands[0].mult;
    const rows = [
        [i18n.t("faq_shave_row_energy"), `${storedKwh.toFixed(1)} kWh`],
        [i18n.t("faq_shave_row_eff"), `${Math.round(u.roundTripEff * 100)}%`],
        [i18n.t("faq_shave_row_charger"), `${chargerKw.toFixed(1)} kW`],
        [i18n.t("faq_shave_row_refill"), `${(u.bufferSec / u.rechargeRate).toFixed(0)}s`],
        [i18n.t("faq_shave_row_breakeven"), `x${(1 / u.roundTripEff).toFixed(2)}`],
        [i18n.t("faq_shave_row_spread"), `x${spread.toFixed(2)}`],
    ];
    return rows.map(([label, value]) =>
        `<div class="flex justify-between py-1 border-b border-gray-800">
            <span class="text-white font-bold">${label}</span>
            <span class="text-gray-400">${value}</span>
        </div>`
    ).join("");
}

// The water table, and the reason this tab exists at all. Every row is
// derived from the CONFIG the meter bills from — the buildings table's rule —
// but the last three are the point: they are the ARITHMETIC OF THE DECISION,
// worked at full output for both options, so what the player is told can
// never drift from what the simulation charges.
//
// The comparison is like for like: the same coolUnits of cooling, done once
// by a plant feeding the CRAHs that spend it, and again by the CRACs it would
// take to do it alone. A real room runs at part load, where the plant's fixed
// draw is spread over less cooling and break-even sits a little higher — the
// drought multiplier is sized to clear both figures.
function waterRows() {
    const plant = CONFIG.buildings.chiller;
    const crac = CONFIG.buildings.crac;
    const crah = CONFIG.buildings.crah;
    const eco = CONFIG.economy;
    const units = plant.coolUnits;
    const cracKw = (units / crac.coolPerSec) * crac.drawKw;
    const loopKw = plant.drawKw + (units / crah.coolPerSec) * crah.drawKw;
    const savedPerHour = (cracKw - loopKw) * eco.powerCostPerKwh;
    const litersPerHour = units * plant.litersPerCoolUnit;
    const droughtMul = CONFIG.events.drought.multiplier;
    const rows = [
        [i18n.t("faq_water_row_wue"), `${plant.litersPerCoolUnit} L/kWh`],
        [i18n.t("faq_water_row_full"), `${litersPerHour.toFixed(0)} L/hr`],
        [i18n.t("faq_water_row_price"), `$${eco.waterCostPerLiter}/L`],
        [i18n.t("faq_water_row_bill"), `$${(litersPerHour * eco.waterCostPerLiter).toFixed(2)}/hr`],
        [i18n.t("faq_water_row_saved"), `$${savedPerHour.toFixed(2)}/hr`],
        [i18n.t("faq_water_row_breakeven"), `$${(savedPerHour / litersPerHour).toFixed(3)}/L`],
        [i18n.t("faq_water_row_drought"), `×${droughtMul} = $${(eco.waterCostPerLiter * droughtMul).toFixed(3)}/L`],
    ];
    return rows.map(([label, value]) =>
        `<div class="flex justify-between py-1 border-b border-gray-800">
            <span class="text-white font-bold">${label}</span>
            <span class="text-gray-400">${value}</span>
        </div>`
    ).join("");
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
            <p>${i18n.t("faq_power_3")}</p>
            <p>${i18n.t("faq_power_4")}</p>`;
        case "heat": return `
            <p>${i18n.t("faq_heat_1")}</p>
            <p>${i18n.t("faq_heat_2")}</p>
            <p class="text-cyan-300">${i18n.t("faq_pue")}</p>`;
        case "cooling": return `
            <p>${i18n.t("faq_cool_1")}</p>
            <p class="text-cyan-300">${i18n.t("faq_cool_2")}</p>`;
        // Generated from CONFIG, like the buildings table and the tariff
        // bands: a page that tells the player when the loop stops paying must
        // not be able to drift from the meter that charges them for it.
        case "water": return `
            <p>${i18n.t("faq_water_1")}</p>
            <p>${i18n.t("faq_water_2")}</p>
            <div class="text-xs my-2">${waterRows()}</div>
            <p>${i18n.t("faq_water_3")}</p>
            <p class="text-cyan-300">${i18n.t("faq_water_4")}</p>`;
        // Generated from CONFIG, like the buildings table: a schedule the
        // player is told to plan against must not be able to drift from the
        // one the meter actually charges.
        case "tariff": return `
            <p>${i18n.t("faq_tariff_1")}</p>
            <div class="text-xs my-2">${bandRows()}</div>
            <p>${i18n.t("faq_tariff_2")}</p>
            <p class="text-cyan-300">${i18n.t("faq_tariff_3")}</p>`;
        // Same rule as the tariff bands above: generated, never hand-written.
        case "shaving": return `
            <p>${i18n.t("faq_shave_1")}</p>
            <div class="text-xs my-2">${shavingRows()}</div>
            <p>${i18n.t("faq_shave_2")}</p>
            <p>${i18n.t("faq_shave_3")}</p>
            <p class="text-cyan-300">${i18n.t("faq_shave_4")}</p>`;
        case "events": return `
            <p>${i18n.t("faq_events_1")}</p>
            <p>${i18n.t("faq_events_2")}</p>
            <p>${i18n.t("faq_events_3", { pct: Math.round(CONFIG.events.brownout.capacityFactor * 100) })}</p>
            <p>${i18n.t("faq_events_4", { cost: CONFIG.events.cracBreakdown.repairCost, wait: CONFIG.events.cracBreakdown.selfRepairSec })}</p>
            <p>${i18n.t("faq_events_5")}</p>
            <p>${i18n.t("faq_events_6")}</p>
            <p>${i18n.t("faq_events_7")}</p>
            <p>${i18n.t("faq_events_8")}</p>
            <p>${i18n.t("faq_events_9", { mult: CONFIG.events.drought.multiplier })}</p>`;
        case "losses": return `
            <p>${i18n.t("faq_loss_1")}</p>
            <p>${i18n.t("faq_loss_2")}</p>
            <p class="text-cyan-300">${i18n.t("faq_loss_3")}</p>`;
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
