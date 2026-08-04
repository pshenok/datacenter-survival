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
        // Backup source. Wire it to a building that already has a live feed
        // and the edge becomes a STANDBY (transfer switch): the generator
        // only picks up when the primary path is dead, after cutoverSec —
        // the gap the UPS buffer exists to bridge. Burns fuel while carrying
        // (litersPerKwh at the billing scale); an empty tank is a dead root.
        // Select-click orders a refill: fuelCost now, arrives fuelDeliverySec
        // later. Immune to grid outages — that is the point of it.
        generator: {
            name: "Generator",
            cost: 220,
            capacityKw: 20,
            chainRole: "source",
            tankLiters: 60,
            litersPerKwh: 0.25,
            fuelCost: 90,
            fuelDeliverySec: 15,
            cutoverSec: 3,
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
            drawKw: 3,           // consumption at FULL duty
            // Part-load draw (sim/power.js): fans and pumps spin whether or
            // not there is heat to move, so a CRAC at 10% duty does NOT cost
            // 10%. draw = idle + (full - idle) * duty^partLoadExp. The
            // consequence is the lesson: two half-loaded units cost more than
            // one full one, so cooling you don't need is a permanent line on
            // the bill — and on your PUE.
            idleDrawKw: 0.9,
            partLoadExp: 0.7,
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
        // City grid sags: every grid_feed's EFFECTIVE capacity is multiplied
        // by capacityFactor for the duration. Degraded-not-dead: the chain
        // stays live, so the UPS never engages — headroom is the defense
        // (see sim/crisis.js header for the design decision).
        brownout: {
            minIntervalSec: 100,
            maxIntervalSec: 160,
            minDurationSec: 12,
            maxDurationSec: 18,
            capacityFactor: 0.5,
        },
        // One random POWERED CRAC breaks (duty forced 0). Select-click it to
        // repair for repairCost; untouched it self-repairs after selfRepairSec
        // (an AFK player is not doomed — paid attention is just cheaper).
        cracBreakdown: {
            minIntervalSec: 90,
            maxIntervalSec: 140,
            selfRepairSec: 45,
            repairCost: 40,
        },
        // The city feed DIES (0%, not a sag): every grid_feed is a dead root
        // for the duration. UPS buffers bridge seconds; generators carry the
        // rest. Rare and late — by the first one the player can afford the
        // answer.
        gridOutage: {
            minIntervalSec: 220,
            maxIntervalSec: 320,
            minDurationSec: 12,
            maxDurationSec: 20,
        },
        // Peak pricing window: the utility bills every kW at multiplier for
        // the duration. It touches NOTHING else — no capacity, no heat, no
        // SLA. The answer is not more hardware; it is having built an
        // efficient facility before the window opened.
        tariff: {
            minIntervalSec: 75,
            maxIntervalSec: 120,
            minDurationSec: 20,
            maxDurationSec: 30,
            multiplier: 2.5,
        },
    },

    // ---- Rolling mini-contracts (sim/contracts.js) --------------------
    // One active at a time, drawn every minIntervalSec..maxIntervalSec of
    // game time. demandShare targets scale with the demand curve at draw
    // time so a contract stays meaningful early AND late.
    contracts: {
        minIntervalSec: 45,
        maxIntervalSec: 70,
        redrawGraceSec: 5,       // breather after a contract resolves
        pool: [
            { key: "serve_kwh", windowSec: 60, reward: 120, demandShare: 0.75, minTarget: 5 },
            { key: "pue_hold", windowSec: 75, reward: 150, holdSec: 45, pueBelow: 1.35 },
            { key: "no_throttle", windowSec: 90, reward: 100, holdSec: 60 },
            { key: "peak_kw", windowSec: 45, reward: 80, demandShare: 0.95, minTarget: 4 },
        ],
    },

    // ---- Campaign (campaign/campaign.js) ------------------------------
    // One mechanic per level; every level must be machine-provably winnable
    // WITH the taught mechanic and losable WITHOUT it (tests/campaign.test.mjs).
    // Campaign levels pin demand flat (demandFixedKw), disable every random
    // event/contract schedule, and run only the events in `script`.
    campaign: {
        // Level-scoped death floors. Survival's bankruptcyAt (-500) sits far
        // below a level's startMoney, so without these a provably-dead run is
        // watched for its full time limit — retry latency nobody budgeted for.
        // Checked AFTER the objective sweep, so a player who has already met
        // everything can never be killed by a floor. Levels may override.
        // tests/campaign.test.mjs proves every winning build's worst moment
        // stays above these.
        failConditions: { repBelow: 25, moneyBelow: -150 },
        chapters: [
            { id: "ch1", titleKey: "ch1_title", levels: ["first_watt", "hot_aisle", "the_bill", "sag", "dark_chain"] },
            { id: "ch2", titleKey: "ch2_title", levels: ["fuel_clock"] },
            { id: "ch3", titleKey: "ch3_title", levels: ["over_cooled", "one_bus", "cold_room"] },
        ],
        levels: {
            // Teach: the delivery chain. Wire feed→transformer→ups→pdu→rack
            // and serve. Money is exactly the chain + slack.
            first_watt: {
                startMoney: 520,
                timeLimitSec: 120,
                demandKw: 4,
                script: [],
                objectives: [{ type: "serve_kwh", target: 3 }],
            },
            // Teach: heat is real. A permanent heatwave rolls in at 20s
            // (ambient 34, stagnant air) — uncooled racks throttle; hold a
            // cool room through it to win. The streak only counts from
            // afterSec, once the heat has actually arrived.
            hot_aisle: {
                startMoney: 1200,
                timeLimitSec: 240,
                demandKw: 12,
                script: [{ atSec: 20, kind: "heatwave", durationSec: 100000 }],
                objectives: [{ type: "no_throttle", holdSec: 45, afterSec: 70 }],
            },
            // Teach: PUE — cooling is not free, and MORE of it is not better.
            // Summer heat + a dense four-rack aisle make cooling mandatory,
            // but every CRAC pays idle draw whether it is working or not
            // (see buildings.crac part-load), so the cap punishes both
            // mistakes at once: too little cooling throttles the racks, too
            // much cooling blows the PUE. Two in-radius units clear both;
            // three is already over-provisioned.
            the_bill: {
                startMoney: 1500,
                timeLimitSec: 240,
                demandKw: 20,
                script: [{ atSec: 20, kind: "heatwave", durationSec: 100000 }],
                objectives: [
                    { type: "no_throttle", holdSec: 45, afterSec: 70 },
                    { type: "pue_below", value: 1.3, holdSec: 40, afterSec: 70 },
                ],
            },
            // Teach: headroom rides a sag (brownout = degraded-not-dead, the
            // UPS never engages). One feed clips hard at 35%; two feeds carry.
            sag: {
                startMoney: 1800,
                timeLimitSec: 150,
                demandKw: 20,
                script: [{ atSec: 45, kind: "brownout", durationSec: 60, factor: 0.35 }],
                objectives: [{ type: "serve_kwh", target: 46 }],
            },
            // Teach: batteries ride an OUTAGE. The city feed dies three times;
            // only a chain with a charged UPS serves through the dark. The
            // generator is banned here — it would trivialise the UPS lesson
            // it exists to extend (it gets its own level in Chapter 2).
            dark_chain: {
                startMoney: 1200,
                timeLimitSec: 150,
                demandKw: 12,
                banned: ["generator"],
                script: [
                    { atSec: 40, kind: "outage", durationSec: 6 },
                    { atSec: 80, kind: "outage", durationSec: 6 },
                    { atSec: 120, kind: "outage", durationSec: 6 },
                ],
                // Scored ONLY while the lights are out: kWh banked in the
                // calm minutes cannot pay for the lesson this level teaches.
                // 18s of blackout at 12 kW is 3.6 kWh on the table.
                objectives: [{ type: "serve_kwh_during_event", event: "outage", target: 3 }],
            },
            // Teach: batteries bridge, generators carry, fuel is the real
            // capacity of your backup. Two 35s outages: the UPS covers 8s of
            // each — only a standby generator with fuel in the tank serves
            // the rest.
            fuel_clock: {
                startMoney: 1250,
                timeLimitSec: 180,
                demandKw: 10,
                script: [
                    { atSec: 50, kind: "outage", durationSec: 35 },
                    { atSec: 120, kind: "outage", durationSec: 35 },
                ],
                // 70s of blackout at 10 kW is 11.7 kWh available; the UPS
                // alone covers 8s of each 35s window, so the generator has to
                // carry the rest.
                objectives: [{ type: "serve_kwh_during_event", event: "outage", target: 8 }],
            },

            // ---- Chapter 3: DIAGNOSIS -----------------------------------
            // These hand the player a room that is already running and
            // already wrong. Nothing here can be solved by building more;
            // every answer is "find the mistake, then remove or move it".
            // A blank floor cannot express any of them.

            // Teach: more cooling is not better cooling. Four CRACs hold this
            // room beautifully and bury the PUE — the fix is DEMOLISHING two,
            // which even pays (50% refund). Only expressible because a CRAC
            // now pays idle draw whether or not it is moving heat.
            over_cooled: {
                startMoney: 0,
                timeLimitSec: 180,
                demandKw: 12,
                script: [{ atSec: 0, kind: "heatwave", durationSec: 100000 }],
                preBuilt: {
                    buildings: [
                        { type: "grid_feed", gx: 3, gz: 5 },
                        { type: "transformer", gx: 6, gz: 5 },
                        { type: "pdu", gx: 9, gz: 5 },
                        { type: "pdu", gx: 9, gz: 9 },
                        { type: "rack", gx: 13, gz: 6 },
                        { type: "rack", gx: 13, gz: 8 },
                        { type: "crac", gx: 12, gz: 7 },
                        { type: "crac", gx: 14, gz: 7 },
                        { type: "crac", gx: 13, gz: 5 },
                        { type: "crac", gx: 13, gz: 9 },
                    ],
                    wires: [[0, 1], [1, 2], [1, 3], [2, 4], [2, 5], [3, 6], [3, 7], [3, 8], [3, 9]],
                },
                objectives: [
                    { type: "no_throttle", holdSec: 40, afterSec: 50 },
                    { type: "pue_below", value: 1.45, holdSec: 40, afterSec: 50 },
                ],
            },

            // Teach: a PDU's kW rating is shared by everything on it. Four
            // racks on one 16 kW bus all brown out together and look equally
            // sick; the badge names the bus, and $60 buys exactly the second
            // PDU the room needs.
            one_bus: {
                startMoney: 60,
                timeLimitSec: 180,
                demandKw: 20,
                script: [],
                preBuilt: {
                    buildings: [
                        { type: "grid_feed", gx: 3, gz: 5 },
                        { type: "transformer", gx: 6, gz: 5 },
                        { type: "pdu", gx: 9, gz: 5 },
                        { type: "rack", gx: 13, gz: 4 },
                        { type: "rack", gx: 13, gz: 6 },
                        { type: "rack", gx: 13, gz: 8 },
                        { type: "rack", gx: 13, gz: 10 },
                        { type: "crac", gx: 15, gz: 5 },
                        { type: "crac", gx: 15, gz: 9 },
                    ],
                    wires: [[0, 1], [1, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7], [2, 8]],
                },
                objectives: [{ type: "serve_kwh", target: 48 }],
            },

            // Teach: cooling works in a RADIUS. These two CRACs run flat out
            // in an empty corner while the aisle cooks — the classic "we have
            // cooling, why is it hot" ticket. Demolish and re-place in radius.
            cold_room: {
                startMoney: 120,
                timeLimitSec: 200,
                demandKw: 14,
                script: [{ atSec: 0, kind: "heatwave", durationSec: 100000 }],
                preBuilt: {
                    buildings: [
                        { type: "grid_feed", gx: 3, gz: 5 },
                        { type: "transformer", gx: 6, gz: 5 },
                        { type: "pdu", gx: 9, gz: 5 },
                        { type: "pdu", gx: 9, gz: 9 },
                        { type: "rack", gx: 14, gz: 6 },
                        { type: "rack", gx: 14, gz: 8 },
                        { type: "rack", gx: 15, gz: 7 },
                        { type: "crac", gx: 24, gz: 6 },
                        { type: "crac", gx: 24, gz: 10 },
                    ],
                    wires: [[0, 1], [1, 2], [1, 3], [2, 4], [2, 5], [2, 6], [3, 7], [3, 8]],
                },
                objectives: [{ type: "no_throttle", holdSec: 40, afterSec: 60 }],
            },
        },
    },

    colors: {
        bg: 0x0a0f14,
        grid_feed: 0xfacc15,
        transformer: 0xf97316,
        ups: 0x22d3ee,
        pdu: 0xa78bfa,
        generator: 0xa8a29e,
        rack: 0x34d399,
        crac: 0x60a5fa,
        wire: 0xfde047,
        wireStandby: 0x94a3b8,
        overlayCold: 0x2563eb,
        overlayHot: 0xdc2626,
    },
};
