// Datacenter Survival — every tunable in one place, the Server Survival
// discipline. Sim modules read this and STATE only; nothing here touches DOM
// or THREE. See docs/specs/2026-07-29-datacenter-survival-mvp-design.md.

export const CONFIG = {
    gridSize: 30,
    tileSize: 4,

    // ---- Buildings ----------------------------------------------------
    // capacityKw: how much power the link can carry / the rack can draw at
    // full load. drawKw (CRAC): its own consumption at full duty.
    buildings: {
        grid_feed: {
            name: "Grid Feed",
            cost: 100,
            capacityKw: 40,
            chainRole: "source",
        },
        transformer: {
            name: "Transformer",
            cost: 80,
            capacityKw: 30,
            chainRole: "link",
        },
        ups: {
            name: "UPS",
            cost: 120,
            capacityKw: 24,
            chainRole: "link",
            // Seconds of full-subtree draw it can carry when its source goes
            // dark (a blip, not a blackout — generators are post-MVP).
            bufferSec: 8,
        },
        pdu: {
            name: "PDU",
            cost: 50,
            capacityKw: 16,
            chainRole: "fanout",
        },
        rack: {
            name: "Rack",
            cost: 150,
            capacityKw: 6,      // full-load draw
            chainRole: "load",
            revenuePerKwhServed: 3.0,
            heatPerKw: 1.0,      // 1 kW drawn -> 1 heat unit/sec into its cell
            throttleStartC: 45,  // linear throttle begins
            shutdownC: 70,       // serves nothing at/above this
        },
        crac: {
            name: "CRAC Unit",
            cost: 110,
            capacityKw: 0,
            chainRole: "load",   // it draws power like a load
            drawKw: 3,           // consumption at full duty
            coolPerSec: 10,      // heat units removed/sec at full duty, split over radius
            radius: 3,           // cells (Chebyshev)
        },
    },

    // ---- Heat field ---------------------------------------------------
    heat: {
        ambientC: 22,            // field floor and starting value
        diffusion: 0.18,         // 4-neighbour kernel share per tick-second
        dissipation: 0.015,      // passive loss toward ambient per second
        heatwaveAmbientC: 34,    // ambient during the heatwave event
        heatwaveDiffusion: 0.10, // stagnant air: heat spreads less, pools more
    },

    // ---- Demand (Survival DNA: log ramp + milestone surges) -----------
    demand: {
        baseKw: 4,
        logGrowthFactor: 3.0,    // baseKw + log(1 + t/30) * factor
        linearPerSec: 0.02,
        waves: [
            // Surge multipliers announced shortly before they land.
            { atSec: 60, multiplier: 1.4 },
            { atSec: 120, multiplier: 1.8 },
            { atSec: 200, multiplier: 2.4 },
        ],
        waveWarningSec: 8,
    },

    // ---- Economy ------------------------------------------------------
    economy: {
        startMoney: 800,
        powerCostPerKwh: 0.9,    // paid on TOTAL facility draw — PUE in the wallet
        bankruptcyAt: -500,
        slaPenaltyPerKwhMissed: 1.5,
    },

    // ---- Reputation / SLA ---------------------------------------------
    sla: {
        startReputation: 100,
        // Reputation drifts toward the served/demand ratio mapped to 0..100,
        // at this fraction of the gap per second.
        driftPerSec: 0.08,
        gameOverAt: 0,
    },

    // ---- Events -------------------------------------------------------
    events: {
        heatwave: {
            firstAtSec: 90,
            intervalSec: 120,
            durationSec: 25,
        },
    },

    colors: {
        bg: 0x0a0f14,
        grid_feed: 0xfacc15,
        transformer: 0xf97316,
        ups: 0x22d3ee,
        pdu: 0xa78bfa,
        rack: 0x34d399,
        crac: 0x60a5fa,
        wire: 0xfde047,
        overlayCold: 0x2563eb,
        overlayHot: 0xdc2626,
    },
};
