// HUD numbers, event banner, contract line, inspect panel, and the
// best-run stats persisted to localStorage (guarded for node, like i18n).
// Reads STATE, writes DOM only.
import { CONFIG } from "../core/config.js";
import { STATE } from "../core/state.js";
import { i18n } from "../i18n.js";
import { lossLedger } from "../sim/attribution.js";
import { LOSS_CAUSES } from "../core/loss-causes.js";
import { utilityOf, feedIsDark } from "../sim/power.js";
import { tariffBandAt } from "../sim/demand.js";
import { pendingOrderFor, activeOrderFor } from "../sim/maintenance.js";

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
    // Meter pill. The tariff touches nothing but the money, so it has to
    // live ON the money — not in a banner that scrolls away while the
    // decision it should be informing is still open.
    //
    // One pill, showing the EFFECTIVE multiplier, because that is the number
    // the player is actually paying: a peak inside the day band costs day x
    // peak, and printing only "PEAK x2.5" there would understate the bill by
    // 40%. The label names whichever fact is dominant; the number is always
    // the truth.
    const tariffEl = el("hud-tariff");
    if (tariffEl) {
        const t = STATE.tariff;
        // STATE.tariff.band and .cycleMul are written by tickDemand, so they
        // are still null/1 for the whole of a PAUSED start — which is exactly
        // when a player is planning against the meter. Falling back to
        // tariffBandAt() (pure, and knowable in advance by design) is what
        // makes the pill readable then; without it the band label rendered
        // the literal key `tariff_band_null` over the money for the entire
        // build phase, in free play and in The Lab alike.
        const band = t.band !== null ? { key: t.band, mult: t.cycleMul } : tariffBandAt(STATE.elapsedGameTime);
        const effective = (t.active ? t.multiplier : 1) * (t.cycleOn ? band.mult : 1);
        const show = t.active || t.cycleOn;
        if (show) {
            tariffEl.textContent = t.active
                ? i18n.t("tariff_pill", { mult: round2(effective) })
                : i18n.t("tariff_band_pill", {
                    band: i18n.t("tariff_band_" + band.key),
                    mult: round2(effective),
                });
            // Amber is the alarm colour and belongs to the expensive half
            // only; a cheap band that shouted would train the player to
            // ignore the pill exactly when it starts mattering.
            tariffEl.className = "text-[9px] font-bold uppercase tracking-wide "
                + (effective > 1 ? "text-amber-300" : "text-emerald-300");
        }
        tariffEl.classList.toggle("hidden", !show);
    }
    // Peak-shave pill: the toggle alone tells a player nothing they can
    // learn from — the whole lesson is WHAT it is saving, right now, in the
    // same units the tariff pill already speaks (kW and $), or the mechanic
    // stays invisible even while it is running.
    const psEl = el("hud-peakshave");
    if (psEl) {
        const ps = STATE.peakShave;
        if (ps.on && STATE.batteryKw > 0.05) {
            const t = STATE.tariff;
            const mult = (t.active ? t.multiplier : 1) * (t.cycleOn ? t.cycleMul : 1);
            const rate = STATE.batteryKw * CONFIG.economy.powerCostPerKwh * mult;
            psEl.textContent = i18n.t("peakshave_active", { kw: STATE.batteryKw.toFixed(1), rate: rate.toFixed(2) });
            psEl.className = "text-[9px] font-bold uppercase tracking-wide text-emerald-300";
            psEl.classList.remove("hidden");
        } else if (ps.on) {
            psEl.textContent = i18n.t("peakshave_armed");
            psEl.className = "text-[9px] font-bold uppercase tracking-wide text-cyan-300";
            psEl.classList.remove("hidden");
        } else {
            psEl.classList.add("hidden");
        }
    }
    // Seed pill. Present only in a seeded run, and clickable there (game.js
    // owns the copy — src/ui/* reads STATE and writes DOM, nothing else).
    // An unseeded run must look exactly like the game did before seeds
    // existed, so the whole element stays hidden rather than showing a dash.
    const seedEl = el("seed-pill");
    if (seedEl) {
        const seeded = STATE.seed !== null;
        if (seeded) el("seed-pill-value").textContent = STATE.seed;
        seedEl.classList.toggle("hidden", !seeded);
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

    // WUE — litres of water per kWh of IT energy, the industry's own
    // definition and the number that gets a datacenter into the local
    // newspaper. Deliberately NOT colour-coded against a threshold the way
    // PUE is: 1.8 L/kWh is what a healthy evaporative plant reads, so an
    // amber "warning" there would be teaching that normal is bad. The alarm
    // belongs on the drought pill below, where a price actually changed.
    //
    // The whole readout is invisible in a room that does not evaporate
    // anything: no plant, no litres, no number — an air-cooled hall owes the
    // reservoir nothing and should not be shown a water score of zero as if
    // it were an achievement.
    const w = STATE.water;
    const wueEl = el("hud-wue");
    if (wueEl) {
        const live = STATE.itDrawKw > 0.05 && w.litersPerHour > 0
            ? w.litersPerHour / STATE.itDrawKw
            : null;
        wueEl.textContent = live !== null ? live.toFixed(2) : "—";
    }
    // The run total. WUE is a cumulative number everywhere it is really
    // quoted — an annual figure in every disclosure that publishes one — so
    // the litres and the run-average sit under the live reading rather than
    // replacing it.
    const runEl = el("hud-wue-run");
    if (runEl) {
        const show = w.totalLiters > 0.05;
        if (show) {
            runEl.textContent = i18n.t("wue_run", {
                liters: Math.round(w.totalLiters),
                wue: (w.itKwh > 0 ? w.totalLiters / w.itKwh : 0).toFixed(2),
            });
        }
        runEl.classList.toggle("hidden", !show);
    }
    // Drought pill, on the water number for the same reason the tariff pill
    // sits on the money: it changes exactly one price and belongs beside it.
    // Shown only to a facility that actually drinks — announcing a water
    // crisis to an air-cooled hall is the kind of noise that trains a player
    // to stop reading the HUD.
    const drEl = el("hud-drought");
    if (drEl) {
        const show = STATE.drought.active && (w.litersPerHour > 0 || w.totalLiters > 0);
        if (show) {
            drEl.textContent = i18n.t("drought_pill", { mult: round2(STATE.drought.multiplier) });
            // Assigning className drops the markup's classes, so the nowrap
            // has to be restated here — without it the pill wraps inside the
            // narrow HUD cell and collides with the paused pill below it.
            drEl.className = "text-[9px] font-bold uppercase tracking-wide whitespace-nowrap text-amber-300";
        }
        drEl.classList.toggle("hidden", !show);
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

    // Work orders: the deadline is the whole decision, so it stays on screen
    // rather than living in a banner that scrolls away while the player is
    // deciding when to open the window.
    const mline = el("maintenance-line");
    if (mline) {
        const orders = STATE.maintenance.orders;
        const active = orders.find((o) => o.state === "active");
        const next = orders.find((o) => o.state === "pending");
        if (active) {
            mline.textContent = i18n.t("maint_active", { s: Math.ceil(active.leftSec) });
        } else if (next) {
            mline.textContent = i18n.t("maint_pending", {
                name: i18n.t("b_" + nameOfOrder(next)),
                dur: next.durationSec,
                left: Math.max(0, Math.ceil(next.bySec - STATE.elapsedGameTime)),
            });
        }
        mline.classList.toggle("hidden", !active && !next);
    }
}

// The order's target type, for a human label. An order whose building has
// been demolished names nothing rather than crashing the HUD.
function nameOfOrder(order) {
    const b = STATE.buildings.find((x) => x.id === order.buildingId);
    return b ? b.type : "pdu";
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

// ---- loss ledger --------------------------------------------------------
// Where the run's unserved kWh actually went, priced at the same SLA rate
// the simulation charged for them. The score stops being a verdict and
// becomes a list of named, fixable causes.
export function renderLossLedger(hostId) {
    const host = document.getElementById(hostId);
    if (!host) return;
    const { rows, totalKwh, totalDollars } = lossLedger();
    if (rows.length === 0 || totalKwh < 0.05) {
        host.classList.add("hidden");
        return;
    }
    const body = rows.map((r) => {
        const meta = LOSS_CAUSES[r.cause];
        const pct = Math.round((r.kwh / totalKwh) * 100);
        return `<div class="flex items-center gap-2 text-[11px] py-0.5">
            <span class="w-2 h-2 rounded-full shrink-0" style="background:${meta.color}"></span>
            <span class="flex-1 text-gray-300">${i18n.t(meta.key)}</span>
            <span class="text-gray-500 tabular-nums">${pct}%</span>
            <span class="text-red-300 tabular-nums w-14 text-right">-$${Math.round(r.dollars)}</span>
        </div>`;
    }).join("");
    host.innerHTML =
        `<div class="text-[10px] text-gray-500 uppercase tracking-wide mb-1">${i18n.t("ledger_title", { total: Math.round(totalDollars) })}</div>`
        + body;
    host.classList.remove("hidden");
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
    if (b.tripped) {
        rows.push(`<div class="text-red-400 font-bold mb-1">${i18n.t("insp_tripped")}</div>`);
    }
    if (b.config.chainRole === "load" && !b.powered) {
        rows.push(`<div class="text-red-400 font-bold mb-1">${i18n.t("insp_unpowered")}</div>`);
    }
    const servicing = activeOrderFor(b);
    const pending = pendingOrderFor(b);
    if (servicing) {
        rows.push(`<div class="text-sky-300 font-bold mb-1">${i18n.t("insp_in_service", { s: Math.ceil(servicing.leftSec) })}</div>`);
    } else if (pending) {
        rows.push(`<div class="text-sky-300 font-bold mb-1">${i18n.t("insp_service_due", {
            dur: pending.durationSec,
            left: Math.max(0, Math.ceil(pending.bySec - STATE.elapsedGameTime)),
        })}</div>`);
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
    } else if (b.type === "chiller") {
        // A dead plant zeroes its own duty (sim/heat.js), which zeroes the
        // loop's capacity and its ratio — so WITHOUT this row the panel falls
        // through to "LOOP OVER-COMMITTED" and tells the player to buy fewer
        // heads when the truth is that the plant is gone. There is no repair
        // to offer: chiller_fail (campaign/campaign.js) sets repairAt to
        // Infinity and repairCrac refuses anything that is not a CRAC. The
        // permanence IS the lesson, so the row states it and promises nothing.
        if (b.broken) {
            rows.push(`<div class="text-red-400 font-bold mb-1">${i18n.t("insp_plant_dead")}</div>`);
        }
        rows.push(row(i18n.t("insp_draw"), `${b.actualKw.toFixed(1)} kW`));
        // The BILLED litres, written by sim/heat.js — the same rule the draw
        // row follows. A tower that is not rejecting heat is not evaporating,
        // and this row is where a player finds out that an idling plant costs
        // power but no water.
        rows.push(row(i18n.t("insp_water"), `${b.waterLitersPerHour.toFixed(1)} L/hr`));
        rows.push(row(i18n.t("insp_loop"),
            `${Math.round(STATE.coolingLoop.demandUnits)} / ${Math.round(STATE.coolingLoop.capacityUnits)}`));
        if (!b.broken && STATE.coolingLoop.ratio < 0.999) {
            rows.push(`<div class="text-amber-300 text-[11px] mt-1">${i18n.t("insp_loop_starved")}</div>`);
        }
    } else if (b.type === "crah") {
        rows.push(row(i18n.t("insp_draw"), `${b.actualKw.toFixed(1)} kW`));
        rows.push(row(i18n.t("insp_duty"), `${Math.round(b.duty * STATE.coolingLoop.ratio * 100)}%`));
        if (STATE.coolingLoop.capacityUnits <= 0) {
            rows.push(`<div class="text-red-400 font-bold text-[11px] mt-1">${i18n.t("insp_no_loop")}</div>`);
        } else if (STATE.coolingLoop.ratio < 0.999) {
            rows.push(`<div class="text-amber-300 text-[11px] mt-1">${i18n.t("insp_loop_starved")}</div>`);
        }
    } else if (b.type === "ups") {
        rows.push(row(i18n.t("insp_buffer"), `${b.bufferLeft.toFixed(1)}s / ${b.config.bufferSec}s`));
        // upsMode (owned by sim/power.js) is a first-class fact, not a
        // guess from bufferLeft's trend — "shaving" and "charging" look
        // identical from a single number (both move), and only the mode
        // says which direction is a choice and which is the bill.
        if (b.upsMode === "shaving") {
            rows.push(`<div class="text-emerald-300 font-bold mb-1">${i18n.t("insp_ups_shaving")}</div>`);
        } else if (b.upsMode === "charging") {
            rows.push(`<div class="text-cyan-300 font-bold mb-1">${i18n.t("insp_ups_charging")}</div>`);
        } else if (b.upsMode === "bridging") {
            rows.push(`<div class="text-amber-300 font-bold mb-1">${i18n.t("insp_ups_bridging")}</div>`);
        }
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
        // Links and sources CARRY, they do not draw (sim/power.js writes
        // actualKw as the kW crossing this node) — so the row is the carried
        // kW against the rating, the rack's shape. A bare nameplate never
        // moves, which left a player watching a bus approach its breaker with
        // nothing on screen that ever changed.
        rows.push(row(i18n.t("insp_carried"), `${b.actualKw.toFixed(1)} / ${b.config.capacityKw} kW`));
    }
    // Which substation a feed hangs off is derived from WHERE it stands, so
    // it has to be legible somewhere — otherwise a one-tile-wrong fix looks
    // identical to a correct one.
    if (b.type === "grid_feed") {
        rows.push(row(i18n.t("insp_utility"), utilityOf(b)));
        if (feedIsDark(b)) {
            rows.push(`<div class="text-red-400 font-bold mt-1">${i18n.t("insp_feed_dark")}</div>`);
        }
    }
    panel.innerHTML = rows.join("");
    panel.classList.remove("hidden");
}

function row(k, v) {
    return `<div class="flex justify-between py-0.5"><span class="text-gray-500">${k}</span><span>${v}</span></div>`;
}

// x1.4 and x0.6 read as prices; x1.4000000000000001 reads as a bug.
function round2(n) {
    return Math.round(n * 100) / 100;
}

// ---- the shareable run ---------------------------------------------------
// The link that reproduces THIS run, or null when there is nothing to share.
// Built from href rather than origin + pathname so it also works from a
// file:// copy, where origin is the literal string "null".
//
// Deliberately just the link. A pasted "4:12, PUE 1.19" line is the exact
// unfalsifiable claim seeded runs exist to replace — the numbers are already
// on the screen above it, and the URL is the half that lets someone check
// them. There is no backend and there will not be one; the scoreboard is two
// people playing the same room.
export function shareUrl(seed) {
    if (!seed) return null;
    if (typeof window === "undefined") return null;
    return `${window.location.href.split(/[?#]/)[0]}?seed=${encodeURIComponent(seed)}`;
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
    renderShare();
    renderLossLedger("gameover-ledger");
    document.getElementById("gameover-modal").classList.remove("hidden");
}

// The share row under the stats: the seed, and the link that reproduces the
// room. Hidden outright in an unseeded run — there is nothing honest to hand
// anyone, and an empty box would only imply there was.
function renderShare() {
    const row = document.getElementById("gameover-share");
    if (!row) return;
    const url = shareUrl(STATE.seed);
    if (url === null) {
        row.classList.add("hidden");
        return;
    }
    document.getElementById("gameover-share-label").textContent = i18n.t("seed_share", { seed: STATE.seed });
    document.getElementById("gameover-share-url").value = url;
    row.classList.remove("hidden");
}
