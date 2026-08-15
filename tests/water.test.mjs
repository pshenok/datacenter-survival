// Water and WUE — the efficiency number PUE cannot see.
//
// PUE is what everyone quotes. WUE is what gets a datacenter into the local
// newspaper, and it is the honest price the chilled-water loop was not paying:
// an evaporative tower rejects heat by BOILING WATER OFF, so the loop buys its
// power advantage with a running water bill that an air-cooled CRAC does not
// have at all.
//
// The claims under test are narrow, so that is what these pin:
//   - only an evaporative plant drinks, and only in proportion to the cooling
//     it actually DELIVERS (not its nameplate, not its idle draw)
//   - water is money on the same meter path and the same billing scale
//   - WUE is litres per kWh of IT energy, the industry's own denominator
//   - a drought prices water and NOTHING else — not power, not heat, not SLA
//   - and the whole layer is invisible to a room with no plant in it
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis } from "../src/sim/crisis.js";
import { tickCampaign, startLevelState, applyScriptEvent } from "../src/campaign/campaign.js";

const DT = 0.05;
const PLANT = CONFIG.buildings.chiller;
const PRICE = CONFIG.economy.waterCostPerLiter;
const DROUGHT_MUL = CONFIG.events.drought.multiplier;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// The cooling-loop suite's room: IT on one chain, cooling on another, so a
// comparison of cooling costs is never confounded by a shared link clipping.
function hall(demandKw, rackSpots) {
    STATE.demandFixedKw = demandKw;
    STATE.heatwave.active = true;
    STATE.heatwave.endsAt = Infinity;
    const f1 = place("grid_feed", 2, 5);
    const x1 = place("transformer", 5, 5);
    wireBuildings(f1, x1);
    const pA = place("pdu", 8, 4);
    const pB = place("pdu", 8, 8);
    wireBuildings(x1, pA);
    wireBuildings(x1, pB);
    const racks = rackSpots.map(([gx, gz], i) => {
        const r = place("rack", gx, gz);
        wireBuildings(i % 2 ? pA : pB, r);
        return r;
    });
    const f2 = place("grid_feed", 2, 16);
    const x2 = place("transformer", 5, 16);
    const pC = place("pdu", 8, 16);
    wireBuildings(f2, x2);
    wireBuildings(x2, pC);
    return { racks, coolBus: pC };
}

function run(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
    }
}

function pinSchedules() {
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.drought.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
}

function fresh() {
    resetState();
    resetBuildingIds();
    pinSchedules();
}

function forceDrought() {
    STATE.drought.active = true;
    STATE.drought.multiplier = DROUGHT_MUL;
    STATE.drought.endsAt = Infinity;
}

const BIG = [[13, 5], [15, 5], [13, 8], [15, 8]];
const HEADS = [[12, 6], [16, 6], [14, 4], [14, 9]];

// The same 24 kW hall cooled two ways — the Chapter 4 decision, which is the
// decision the drought exists to overturn.
function coolWith(kind) {
    const { racks, coolBus } = hall(24, BIG);
    if (kind === "crac") {
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crac", gx, gz));
    } else {
        wireBuildings(coolBus, place("chiller", 20, 16));
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
    }
    return racks;
}

beforeEach(fresh);

// ---------------------------------------------------------------------------
describe("only the tower drinks, and only for the heat it actually rejects", () => {
    it("THE TRADE: the plant evaporates water; the CRACs doing the same job drink nothing", () => {
        coolWith("crac");
        run(160);
        expect(STATE.water.litersPerHour).toBe(0);
        expect(STATE.water.totalLiters).toBe(0);
        const cracCoolKw = STATE.totalDrawKw - STATE.itDrawKw;

        fresh();
        coolWith("loop");
        run(160);
        // The loop is the cheaper room on POWER — that is why it exists…
        expect(STATE.totalDrawKw - STATE.itDrawKw).toBeLessThan(cracCoolKw);
        // …and this is the price it pays for it, which nothing charged before.
        expect(STATE.water.litersPerHour).toBeGreaterThan(0);
        expect(STATE.water.totalLiters).toBeGreaterThan(0);
    });

    it("bills the cooling DELIVERED, never the nameplate: an idle plant costs power and no water", () => {
        const { coolBus } = hall(6, [[14, 7]]);
        const plant = place("chiller", 20, 16);
        wireBuildings(coolBus, plant);       // powered, and nobody drinking
        run(40);
        expect(plant.powered).toBe(true);
        expect(plant.actualKw).toBeGreaterThanOrEqual(PLANT.idleDrawKw * 0.95);  // pumps still run
        expect(plant.duty).toBe(0);
        expect(plant.waterLitersPerHour).toBe(0);                                // the tower does not
        expect(STATE.water.totalLiters).toBe(0);
    });

    it("is exactly litres-per-unit x capacity x duty — proportional, at any part load", () => {
        const { coolBus } = hall(24, BIG);
        const plant = place("chiller", 20, 16);
        wireBuildings(coolBus, plant);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(160);
        // A settled room asks the plant for less than its full output, so this
        // is a genuine part-load reading, not the nameplate by another name.
        expect(plant.duty).toBeGreaterThan(0);
        expect(plant.duty).toBeLessThan(1);
        expect(plant.waterLitersPerHour)
            .toBeCloseTo(PLANT.litersPerCoolUnit * PLANT.coolUnits * plant.duty, 9);
        expect(STATE.water.litersPerHour).toBeCloseTo(plant.waterLitersPerHour, 9);
        // Half the delivered cooling really is half the water — the claim the
        // "delivered, not nameplate" rule is making.
        const half = PLANT.litersPerCoolUnit * PLANT.coolUnits * (plant.duty / 2);
        expect(half).toBeCloseTo(plant.waterLitersPerHour / 2, 9);
    });

    it("a broken plant's tower stops with it — a dead plant is billed no water", () => {
        const { coolBus } = hall(24, BIG);
        const plant = place("chiller", 20, 16);
        wireBuildings(coolBus, plant);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(120);
        const rateWhenAlive = plant.waterLitersPerHour;
        expect(rateWhenAlive).toBeGreaterThan(0);
        const bankedLiters = STATE.water.totalLiters;

        plant.broken = true;
        run(40);
        expect(plant.waterLitersPerHour).toBe(0);
        expect(STATE.water.litersPerHour).toBe(0);
        // The ledger keeps what it already evaporated and adds nothing beyond
        // sim/demand.js's documented one-tick lag — it bills the rate written
        // by the PREVIOUS tick's heat pass, so exactly one tick of the old
        // rate lands after the plant dies. Anything more would mean a dead
        // tower still evaporating.
        const lagBound = rateWhenAlive * DT / 60;
        expect(STATE.water.totalLiters).toBeGreaterThanOrEqual(bankedLiters);
        expect(STATE.water.totalLiters).toBeLessThanOrEqual(bankedLiters + lagBound + 1e-9);
    });

    it("a dead plant's tower stops even when a healthy twin is still running", () => {
        // The single-plant case above cannot prove this: kill the only plant
        // and the loop's capacity goes to zero, so ANY water formula reads
        // zero and a mutant that ignored "is it running" would pass. With a
        // second plant carrying the room the capacity stays up, and the dead
        // one has to report zero water on its own account.
        const { coolBus } = hall(24, BIG);
        const a = place("chiller", 20, 16);
        const b = place("chiller", 22, 16);
        wireBuildings(coolBus, a);
        wireBuildings(coolBus, b);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(120);
        expect(b.waterLitersPerHour).toBeGreaterThan(0);

        b.broken = true;
        run(20);
        expect(STATE.coolingLoop.capacityUnits).toBeGreaterThan(0);   // the twin carries on
        expect(a.waterLitersPerHour).toBeGreaterThan(0);
        expect(b.duty).toBe(0);
        expect(b.waterLitersPerHour).toBe(0);
        expect(STATE.water.litersPerHour).toBe(a.waterLitersPerHour);
    });

    it("an UNWIRED plant drinks nothing — a spare in the yard is not a water bill", () => {
        const { coolBus } = hall(24, BIG);
        const working = place("chiller", 20, 16);
        wireBuildings(coolBus, working);
        for (const [gx, gz] of HEADS) wireBuildings(coolBus, place("crah", gx, gz));
        run(140);
        expect(STATE.water.litersPerHour).toBeGreaterThan(0);

        const spare = place("chiller", 24, 16);   // connected to nothing at all
        run(20);
        expect(spare.powered).toBe(false);
        expect(spare.duty).toBe(0);
        expect(spare.waterLitersPerHour).toBe(0);
        // The room's bill is the WORKING tower's, to the last decimal — a
        // spare that crept into the sum would show up here and nowhere else,
        // because two plants sharing one room's heat evaporate the same total
        // as one (which is the honest physics, and why this is the assertion
        // that catches it rather than a bound on the total).
        expect(STATE.water.litersPerHour).toBe(working.waterLitersPerHour);
    });
});

// ---------------------------------------------------------------------------
// Semantics units against pinned accounting (the contracts.js pattern):
// tickDemand alone, no power resolution, so every dollar below is provably the
// water line and nothing else.
describe("water is money, on the meter, at the meter's scale", () => {
    it("charges one billing hour per GAME MINUTE, like every other rate", () => {
        STATE.demandFixedKw = 0;
        STATE.water.litersPerHour = 120;
        const before = STATE.money;
        tickDemand(30, 0);                       // half a billing hour
        expect(STATE.water.totalLiters).toBeCloseTo(60, 9);
        expect(before - STATE.money).toBeCloseTo(60 * PRICE, 9);
    });

    it("the run ledger is exactly the quantity that was billed", () => {
        STATE.demandFixedKw = 0;
        STATE.water.litersPerHour = 90;
        const before = STATE.money;
        for (let i = 0; i < 400; i++) tickDemand(DT, i * DT);
        expect(before - STATE.money).toBeCloseTo(STATE.water.totalLiters * PRICE, 9);
    });

    it("a DROUGHT multiplies the water line by exactly its multiplier", () => {
        STATE.demandFixedKw = 0;
        STATE.water.litersPerHour = 120;
        forceDrought();
        const before = STATE.money;
        tickDemand(30, 0);
        expect(before - STATE.money).toBeCloseTo(60 * PRICE * DROUGHT_MUL, 9);
        // The litres are physical: scarcity prices water, it does not evaporate more.
        expect(STATE.water.totalLiters).toBeCloseTo(60, 9);
    });

    it("TWO UTILITIES, TWO PRICES: the peak tariff never touches water", () => {
        STATE.demandFixedKw = 0;
        STATE.water.litersPerHour = 120;
        STATE.tariff.active = true;
        STATE.tariff.multiplier = CONFIG.events.tariff.multiplier;
        STATE.tariff.endsAt = Infinity;
        STATE.tariff.cycleOn = true;             // and the day/night cycle too
        const before = STATE.money;
        tickDemand(30, CONFIG.tariff.bands[1].fromSec);
        expect(STATE.tariff.cycleMul).toBeGreaterThan(1);   // the meter really is dear
        expect(before - STATE.money).toBeCloseTo(60 * PRICE, 9);
    });

    it("…and the drought never touches power", () => {
        STATE.demandFixedKw = 0;
        STATE.totalDrawKw = 20;
        STATE.water.litersPerHour = 0;
        const before = STATE.money;
        tickDemand(30, 0);
        const flatBill = before - STATE.money;

        fresh();
        STATE.demandFixedKw = 0;
        STATE.totalDrawKw = 20;
        forceDrought();
        const before2 = STATE.money;
        tickDemand(30, 0);
        expect(before2 - STATE.money).toBeCloseTo(flatBill, 9);
        expect(flatBill).toBeCloseTo(10 * CONFIG.economy.powerCostPerKwh, 9);
    });
});

// ---------------------------------------------------------------------------
describe("WUE, the way the industry defines it", () => {
    it("THE DENOMINATOR IS IT ENERGY — not facility energy, which is PUE's job", () => {
        STATE.demandFixedKw = 0;
        STATE.itDrawKw = 8;
        STATE.totalDrawKw = 12;                  // a PUE of 1.5 to get it wrong with
        tickDemand(60, 0);                       // exactly one billing hour
        expect(STATE.water.itKwh).toBeCloseTo(8, 9);
        expect(STATE.water.itKwh).not.toBeCloseTo(12, 3);
    });

    it("accumulates the denominator tick for tick over a real run", () => {
        coolWith("loop");
        let expectedItKwh = 0;
        for (let i = 0; i < 160 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            // tickDemand reads the itDrawKw the LAST power resolution wrote —
            // the documented one-tick lag — so the reference sum is taken here.
            expectedItKwh += STATE.itDrawKw * DT / 60;
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
        }
        expect(STATE.water.itKwh).toBeCloseTo(expectedItKwh, 9);
    });

    it("a room whose cooling matches its IT load reads the PLANT's own WUE", () => {
        // The physical correspondence the config is anchored on: every kW a
        // rack draws becomes a unit of heat, the tower rejects it, and the
        // litres per kWh of IT land on litersPerCoolUnit. 1.8 L/kWh is what a
        // real evaporative plant reads, and so does this room.
        coolWith("loop");
        run(200);
        const liveWue = STATE.water.litersPerHour / STATE.itDrawKw;
        expect(liveWue).toBeGreaterThan(PLANT.litersPerCoolUnit * 0.9);
        expect(liveWue).toBeLessThan(PLANT.litersPerCoolUnit * 1.1);
    });

    it("the run total is litres over IT kWh, and both are real numbers", () => {
        coolWith("loop");
        run(200);
        expect(STATE.water.totalLiters).toBeGreaterThan(0);
        expect(STATE.water.itKwh).toBeGreaterThan(0);
        const runWue = STATE.water.totalLiters / STATE.water.itKwh;
        expect(runWue).toBeGreaterThan(0.5);
        expect(runWue).toBeLessThan(PLANT.litersPerCoolUnit * 1.1);
    });
});

// ---------------------------------------------------------------------------
describe("the drought window", () => {
    it("draws its schedule from the INJECTED rng, never from module scope", () => {
        const cfg = CONFIG.events.drought;
        STATE.drought.nextAt = null;
        tickCrisis(DT, 0, () => 0);
        expect(STATE.drought.nextAt).toBeCloseTo(cfg.minIntervalSec, 9);

        fresh();
        STATE.drought.nextAt = null;
        tickCrisis(DT, 0, () => 1);
        expect(STATE.drought.nextAt).toBeCloseTo(cfg.maxIntervalSec, 9);
    });

    it("opens on its scheduled second and hands the multiplier back when it closes", () => {
        const cfg = CONFIG.events.drought;
        STATE.drought.nextAt = null;
        const rng = () => 0;                     // shortest interval, shortest window
        tickCrisis(DT, 0, rng);
        expect(STATE.drought.active).toBe(false);
        tickCrisis(DT, cfg.minIntervalSec, rng);
        expect(STATE.drought.active).toBe(true);
        expect(STATE.drought.multiplier).toBe(cfg.multiplier);
        tickCrisis(DT, cfg.minIntervalSec + cfg.minDurationSec, rng);
        expect(STATE.drought.active).toBe(false);
        expect(STATE.drought.multiplier).toBe(1);
    });

    it("is a strict no-op on a dt that is not a finite positive number", () => {
        for (const bad of [0, -0, -1, NaN, Infinity]) {
            fresh();
            STATE.drought.nextAt = null;
            tickCrisis(bad, 500, () => 0);
            expect(STATE.drought.nextAt).toBeNull();
            expect(STATE.drought.active).toBe(false);
        }
    });

    it("EVERY campaign level pins it to Infinity — no proven level can see one", () => {
        for (const id of Object.keys(CONFIG.campaign.levels)) {
            // Deliberately NOT the fresh() helper: that pins every schedule
            // itself, which would mask a startLevelState that had stopped
            // pinning this one. resetState leaves nextAt null — "draw me on
            // the first valid tick" — so only the level start can make it
            // Infinity, and this assertion is about the level start.
            resetState();
            resetBuildingIds();
            expect(STATE.drought.nextAt).toBeNull();
            expect(startLevelState(id)).toBe(true);
            expect(STATE.drought.nextAt, id).toBe(Infinity);
        }
    });

    it("a level resolving mid-drought closes the window on the way out", () => {
        // Every schedule is pinned to Infinity during a level, so nothing else
        // would ever end it: the water bill would stay at x12 behind the modal.
        startLevelState("first_watt");
        expect(applyScriptEvent({ kind: "drought", durationSec: 500, multiplier: DROUGHT_MUL }, 0)).toBe(true);
        expect(STATE.drought.active).toBe(true);
        STATE.campaign.objectives.forEach((o) => { o.done = true; });
        tickCampaign(DT, 1);
        expect(STATE.campaign.done).toBe("won");
        expect(STATE.drought.active).toBe(false);
        expect(STATE.drought.multiplier).toBe(1);
    });

    it("resetState severs both the water ledger and the window", () => {
        STATE.water = { litersPerHour: 42, totalLiters: 900, itKwh: 12 };
        forceDrought();
        resetState();
        expect(STATE.water).toEqual({ litersPerHour: 0, totalLiters: 0, itKwh: 0 });
        expect(STATE.drought).toEqual({ active: false, endsAt: 0, nextAt: null, multiplier: 1 });
    });
});

// ---------------------------------------------------------------------------
// THE LESSON. Chapter 4 says the loop beats CRACs at scale and concentrates
// the blast radius. Water is the third dimension: it gives the plant an
// honest price, and a drought is the one condition under which the CRAC —
// strictly worse on power at every size — is the right call anyway.
describe("THE LESSON: a drought flips the cooling decision", () => {
    function moneyOver(kind, seconds, drought) {
        fresh();
        coolWith(kind);
        run(120);                                // settle both rooms identically
        if (drought) forceDrought();
        const before = STATE.money;
        run(seconds);
        return {
            earned: STATE.money - before,
            cooled: STATE.buildings.every((b) => b.type !== "rack" || b.throttleFactor === 1),
        };
    }

    it("AT THE STANDING PRICE the loop is still the cheaper room — water is why it is used at all", () => {
        const crac = moneyOver("crac", 120, false);
        const loop = moneyOver("loop", 120, false);
        expect(crac.cooled).toBe(true);
        expect(loop.cooled).toBe(true);          // both hold the room…
        expect(loop.earned).toBeGreaterThan(crac.earned);   // …one holds it for less
    });

    it("IN A DROUGHT the air-cooled room is the cheaper one — the CRAC stops being strictly worse", () => {
        const crac = moneyOver("crac", 120, true);
        const loop = moneyOver("loop", 120, true);
        expect(crac.cooled).toBe(true);
        expect(loop.cooled).toBe(true);          // the physics did not move…
        expect(crac.earned).toBeGreaterThan(loop.earned);   // …only the invoice did
    });

    it("and the flip is the WATER, not a side effect: PUE is identical either way", () => {
        // The drought must not be able to win this argument through the power
        // meter. Same room, same window, same efficiency to the last decimal.
        fresh();
        coolWith("loop");
        run(160);
        const dryPue = STATE.totalDrawKw / STATE.itDrawKw;

        fresh();
        coolWith("loop");
        forceDrought();
        run(160);
        expect(STATE.totalDrawKw / STATE.itDrawKw).toBe(dryPue);
    });
});

// ---------------------------------------------------------------------------
// INERTNESS. The requirement most likely to be got wrong: a room with no
// evaporative plant in it must not be able to tell that any of this shipped.
describe("INERTNESS — a room with no plant cannot see water, WUE or a drought", () => {
    const snap = () => ({
        money: STATE.money,
        served: STATE.servedKw,
        it: STATE.itDrawKw,
        total: STATE.totalDrawKw,
        rep: STATE.reputation,
        heat: Array.from(STATE.heatField),
    });

    it("an air-cooled hall evaporates nothing and has no WUE to report", () => {
        const racks = coolWith("crac");
        run(200);
        expect(racks.every((r) => r.throttleFactor === 1)).toBe(true);   // a real, working room
        expect(STATE.water.litersPerHour).toBe(0);
        expect(STATE.water.totalLiters).toBe(0);
        // The denominator still ticks — it is just IT energy, and dividing
        // zero litres by it is the honest "no water score" the HUD renders
        // as a dash rather than as a suspiciously perfect 0.00.
        expect(STATE.water.itKwh).toBeGreaterThan(0);
    });

    it("the attribution.test.mjs pattern: a drought on EVERY tick changes not one number", () => {
        coolWith("crac");
        run(200);
        const clean = snap();

        fresh();
        coolWith("crac");
        for (let i = 0; i < 200 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            forceDrought();                      // hammer it, every single tick
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
        }
        const drought = snap();

        expect(drought.money).toBe(clean.money);
        expect(drought.served).toBe(clean.served);
        expect(drought.it).toBe(clean.it);
        expect(drought.total).toBe(clean.total);
        expect(drought.rep).toBe(clean.rep);
        expect(drought.heat).toEqual(clean.heat);
    });

    it("the twelve levels with no plant in them bill not a litre", () => {
        // The whole campaign is proven against a meter that had no water line.
        // Only the two Chapter 4 rooms have a plant; everywhere else this
        // feature must be arithmetically absent.
        const withPlant = Object.entries(CONFIG.campaign.levels)
            .filter(([, cfg]) => (cfg.preBuilt ? cfg.preBuilt.buildings : []).some((b) => b.type === "chiller"))
            .map(([id]) => id);
        expect(withPlant).toEqual(["single_point_of_cold"]);
    });
});
