// Build palette — one button per building type, injected from CONFIG so a
// new building is one config entry (the Server Survival registry lesson).
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";

const ICONS = {
    grid_feed: '<path stroke-linecap="round" d="M12 3v7m0 0-3 4h6l-3 7M5 10h14"/>',
    transformer: '<rect x="5" y="7" width="14" height="12" rx="1"/><path d="M9 7V4m6 3V4M9 12h6m-6 4h6"/>',
    ups: '<rect x="6" y="5" width="12" height="15" rx="1"/><path stroke-linecap="round" d="M12 8v5l2.5-1.8"/>',
    pdu: '<circle cx="12" cy="12" r="7"/><path d="M12 5v3m0 8v3M5 12h3m8 0h3"/>',
    generator: '<rect x="4" y="9" width="13" height="9" rx="1"/><path d="M17 12h3v4h-3M7 9V6h4v3M9 12.5l-1.5 2h3L9 16.5"/>',
    rack: '<rect x="7" y="4" width="10" height="17" rx="1"/><path d="M9 8h6M9 12h6M9 16h6"/>',
    crac: '<rect x="4" y="7" width="16" height="11" rx="1"/><circle cx="12" cy="12.5" r="3"/><path d="M12 9.5v6M9.4 11l5.2 3M9.4 14l5.2-3"/>',
    chiller: '<rect x="3" y="9" width="18" height="10" rx="1"/><path d="M7 9V6h10v3M9 13h6M12 11v4"/><path stroke-linecap="round" d="M5 22c1.2-1.6 2.4-1.6 3.6 0M11 22c1.2-1.6 2.4-1.6 3.6 0"/>',
    crah: '<rect x="7" y="5" width="10" height="15" rx="1"/><circle cx="12" cy="12" r="2.6"/><path stroke-linecap="round" d="M3 8h3M3 12h3M3 16h3"/>',
};

export function renderPalette(onPick) {
    const host = document.getElementById("build-palette");
    host.innerHTML = "";
    for (const [type, cfg] of Object.entries(CONFIG.buildings)) {
        const btn = document.createElement("button");
        btn.className = "build-btn glass-panel rounded-lg w-16 h-16 flex flex-col items-center justify-center text-gray-300 relative";
        btn.dataset.tool = type;
        btn.innerHTML =
            `<span class="absolute top-1 right-1 text-[8px] text-amber-300">$${cfg.cost}</span>` +
            `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">${ICONS[type] || ""}</svg>` +
            `<span class="text-[9px] mt-1 uppercase" data-i18n="b_${type}">${i18n.t("b_" + type)}</span>`;
        btn.addEventListener("click", () => onPick(type));
        host.appendChild(btn);
    }
}

export function markActiveTool(tool) {
    document.querySelectorAll("[data-tool]").forEach((b) => {
        b.classList.toggle("active", b.dataset.tool === tool);
    });
}

export function refreshAffordability() {
    const levelId = STATE.campaign.levelId;
    const banned = (levelId && CONFIG.campaign.levels[levelId].banned) || [];
    for (const [type, cfg] of Object.entries(CONFIG.buildings)) {
        const btn = document.querySelector(`#build-palette [data-tool="${type}"]`);
        if (btn) btn.disabled = STATE.money < cfg.cost || banned.includes(type);
    }
}
