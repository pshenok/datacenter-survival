// Generators, fuel and the transfer switch (#2). The standby wave in
// sim/power.js, fuel logistics in sim/crisis.js, the survival grid-outage
// schedule, and the Chapter 2 campaign level machine-played in all three
// directions (with generator / without / with a dry tank).
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, unwire, resolvePower } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { tickCrisis, orderFuel } from "../src/sim/crisis.js";
import { tickContracts } from "../src/sim/contracts.js";
import { tickCampaign, startLevelState, levelCfg } from "../src/campaign/campaign.js";

const DT = 0.05;
const rngZero = () => 0;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

function chain(z, { ups = true } = {}) {
    const feed = place("grid_feed", 2, z);
    const xf = place("transformer", 5, z);
    wireBuildings(feed, xf);
    let tail = xf;
    if (ups) {
        const u = place("ups", 8, z);
        wireBuildings(xf, u);
        tail = u;
    }
    const pdu = place("pdu", 11, z);
    wireBuildings(tail, pdu);
    return { feed, xf, pdu, tail };
}

function run(seconds, { campaign = false } = {}) {
    for (let i = 0; i < seconds / DT; i++) {
        if (campaign && STATE.campaign.done !== null) return;
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickCrisis(DT, t, rngZero);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
        tickContracts(DT, t, rngZero);
        tickCampaign(DT, t);
    }
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    // Sandbox tests: keep random schedules parked so only what a test
    // arms can fire.
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
    STATE.demandFixedKw = 10;
});

describe("standby wiring (transfer switch edges)", () => {
    it("a generator wired to a fed child becomes STANDBY; to an unfed child, the primary parent", () => {
        const { xf } = chain(5);
        const g = place("generator", 2, 8);
        expect(wireBuildings(g, xf)).toBe(true);
        expect(xf.parentId).not.toBe(g.id);        // primary feed kept
        expect(xf.standbyParentId).toBe(g.id);     // standby edge set

        const lonePdu = place("pdu", 11, 9);
        expect(wireBuildings(g, lonePdu)).toBe(true);
        expect(lonePdu.parentId).toBe(g.id);       // ordinary primary edge
        expect(lonePdu.standbyParentId).toBeNull();
    });

    it("the standby edge SURVIVES a primary rewire — a paid transfer switch is not lost silently", () => {
        const { xf, feed } = chain(5);
        const g = place("generator", 2, 8);
        wireBuildings(g, xf);
        const feed2 = place("grid_feed", 2, 12);
        wireBuildings(feed2, xf);              // re-parent the primary feed
        expect(xf.parentId).toBe(feed2.id);
        expect(xf.standbyParentId).toBe(g.id); // backup still armed
        unwire(xf);                            // losing the primary feed…
        expect(xf.standbyParentId).toBe(g.id); // …doesn't disarm it either
        expect(feed).toBeDefined();
    });

    it("brownout clips grid feeds only — an off-grid generator as primary source serves full pull", () => {
        const g = place("generator", 2, 8);
        const pdu = place("pdu", 11, 9);
        wireBuildings(g, pdu);
        const racks = [place("rack", 14, 8), place("rack", 14, 10)];
        racks.forEach((r) => wireBuildings(pdu, r));
        STATE.brownout.active = true;
        STATE.brownout.factor = 0.5;
        STATE.brownout.endsAt = Infinity;
        run(10);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        expect(g.actualKw).toBeGreaterThan(9);
    });

    it("a generator-primary island is immune to a grid outage", () => {
        const g = place("generator", 2, 8);
        const pdu = place("pdu", 11, 9);
        wireBuildings(g, pdu);
        const racks = [place("rack", 14, 8), place("rack", 14, 10)];
        racks.forEach((r) => wireBuildings(pdu, r));
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        run(10);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        expect(g.fuelLiters).toBeLessThan(g.config.tankLiters);
    });
});

describe("standby double-count guards", () => {
    it("belt-and-braces wiring (one generator standby to xf AND pdu) burns fuel once, not twice", () => {
        const { xf, pdu } = chain(5);
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const g = place("generator", 2, 8);
        wireBuildings(g, xf);
        wireBuildings(g, pdu);   // nested standby edge — must not double-count
        run(5);
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        run(20);
        // Carries the real subtree pull (~10-13 kW), NOT double.
        expect(g.actualKw).toBeLessThan(15);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        // Burn for ~18s of carrying at real pull: well under the doubled rate.
        const burned = g.config.tankLiters - g.fuelLiters;
        const carriedKwh = g.actualKw * 18 / 60;
        expect(burned).toBeLessThan(carriedKwh * g.config.litersPerKwh * 1.6);
    });

    it("two generators over the same subtree: only one carries and burns", () => {
        const { xf, pdu } = chain(5);
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const gA = place("generator", 2, 8);
        const gB = place("generator", 2, 11);
        wireBuildings(gA, xf);
        wireBuildings(gB, pdu);
        run(5);
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        run(20);
        const totalGenKw = gA.actualKw + gB.actualKw;
        expect(totalGenKw).toBeLessThan(15);              // one subtree's pull, once
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        const burners = [gA, gB].filter((g) => g.fuelLiters < g.config.tankLiters - 0.01);
        expect(burners.length).toBe(1);
    });

    it("an ancestor UPS stops draining once the generator carries everything below it", () => {
        // Standby attached BELOW the UPS: chain feed→xf→ups→pdu, generator
        // standby to the PDU. During the outage the UPS bridges the cutover,
        // then must hold its buffer while the generator carries.
        const { pdu } = chain(5);
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const g = place("generator", 2, 8);
        wireBuildings(g, pdu);
        const ups = STATE.buildings.find((b) => b.type === "ups");
        run(5);
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        run(g.config.cutoverSec + 1);   // pickup done
        const bufAtPickup = ups.bufferLeft;
        expect(bufAtPickup).toBeGreaterThan(0);
        run(10);
        expect(g.actualKw).toBeGreaterThan(0);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        expect(ups.bufferLeft).toBeGreaterThanOrEqual(bufAtPickup - 0.01); // held, not draining
    });
});

describe("transfer switch pickup", () => {
    function world() {
        const parts = chain(5);
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(parts.pdu, r));
        const g = place("generator", 2, 8);
        wireBuildings(g, parts.xf);
        return { ...parts, racks, g };
    }

    it("the generator stays idle while the grid is up", () => {
        const { g } = world();
        run(10);
        expect(g.actualKw).toBe(0);
        expect(g.fuelLiters).toBe(g.config.tankLiters);
    });

    it("on an outage it picks up after cutoverSec, the UPS bridges the gap, and serve never drops", () => {
        const { g } = world();
        run(10);
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        const upsB = STATE.buildings.find((b) => b.type === "ups");
        // During the cutover the UPS carries from its buffer...
        run(g.config.cutoverSec - 0.5);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        expect(g.actualKw).toBe(0);
        expect(upsB.bufferLeft).toBeLessThan(upsB.config.bufferSec);
        // ...then the generator carries and the buffer recharges.
        run(6);
        expect(g.actualKw).toBeGreaterThan(0);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
        const bufAfterPickup = upsB.bufferLeft;
        run(4);
        expect(upsB.bufferLeft).toBeGreaterThanOrEqual(bufAfterPickup);
    });

    it("burns fuel while carrying and goes dark on a dry tank", () => {
        const { g } = world();
        run(5);
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = Infinity;
        g.fuelLiters = 0.05;    // nearly dry
        run(30);
        expect(g.fuelLiters).toBe(0);
        expect(g.actualKw).toBe(0);
        expect(STATE.servedKw).toBe(0);   // UPS buffer long gone too
    });

    it("hands back to the grid when the outage ends", () => {
        const { g } = world();
        run(5);
        STATE.gridOutage.active = true;
        STATE.gridOutage.endsAt = STATE.elapsedGameTime + 10;
        run(15);
        expect(STATE.gridOutage.active).toBe(false);
        expect(g.actualKw).toBe(0);
        expect(STATE.servedKw).toBeCloseTo(10, 0);
    });
});

describe("fuel logistics", () => {
    it("orderFuel charges now, fills the tank fuelDeliverySec later, and refuses double orders", () => {
        const g = place("generator", 2, 8);
        g.fuelLiters = 5;
        STATE.money = 500;
        expect(orderFuel(g, 100)).toBe(true);
        expect(STATE.money).toBe(500 - g.config.fuelCost);
        expect(orderFuel(g, 101)).toBe(false);   // already in transit
        STATE.elapsedGameTime = 100;
        run(g.config.fuelDeliverySec - 2);
        expect(g.fuelLiters).toBe(5);            // still in transit — no instant fill
        run(3);
        expect(g.fuelLiters).toBe(g.config.tankLiters);
        expect(g.fuelArrivesAt).toBeNull();
    });

    it("refuses on a full tank or an empty wallet", () => {
        const g = place("generator", 2, 8);
        expect(orderFuel(g, 0)).toBe(false);     // tank is full at birth
        g.fuelLiters = 0;
        STATE.money = 10;
        expect(orderFuel(g, 0)).toBe(false);     // cannot afford
    });
});

describe("survival grid outage schedule", () => {
    it("draws, fires and ends by the crisis pattern", () => {
        STATE.gridOutage.nextAt = null;          // survival: let it schedule
        chain(5);
        const rack = place("rack", 14, 5);
        wireBuildings(STATE.buildings.find((b) => b.type === "pdu"), rack);
        const cfg = CONFIG.events.gridOutage;
        run(cfg.minIntervalSec - 5);
        expect(STATE.gridOutage.active).toBe(false);
        run(10);                                  // past minIntervalSec (rngZero)
        expect(STATE.gridOutage.active).toBe(true);
        run(cfg.minDurationSec + 2);
        expect(STATE.gridOutage.active).toBe(false);
    });
});

describe("L6 fuel_clock", () => {
    function startLevel() {
        resetState();
        resetBuildingIds();
        expect(startLevelState("fuel_clock")).toBe(true);
    }

    function loads(pdu) {
        const racks = [place("rack", 14, 5), place("rack", 14, 7)];
        racks.forEach((r) => wireBuildings(pdu, r));
        const crac = place("crac", 15, 6);
        wireBuildings(pdu, crac);
    }

    it("WIN: a standby generator with a full tank carries both outages", () => {
        startLevel();
        const { xf, pdu } = chain(6);
        loads(pdu);
        const g = place("generator", 2, 9);
        wireBuildings(g, xf);
        const cost = STATE.buildings.reduce((s, b) => s + b.config.cost, 0);
        expect(cost).toBeLessThanOrEqual(levelCfg("fuel_clock").startMoney);
        run(levelCfg("fuel_clock").timeLimitSec + 5, { campaign: true });
        expect(STATE.campaign.done).toBe("won");
        expect(g.fuelLiters).toBeGreaterThan(0);  // the tank was enough
    });

    it("LOSE: without a generator the UPS covers 8 of 35 seconds — timeout", () => {
        startLevel();
        const { pdu } = chain(6);
        loads(pdu);
        run(levelCfg("fuel_clock").timeLimitSec + 5, { campaign: true });
        expect(STATE.campaign.done).toBe("failed");
        expect(STATE.gameOver).toBeNull();        // survived, just short
    });

    it("LOSE: a generator with a DRAINED tank is a dead root — fuel is the real capacity", () => {
        startLevel();
        const { xf, pdu } = chain(6);
        loads(pdu);
        const g = place("generator", 2, 9);
        wireBuildings(g, xf);
        g.fuelLiters = 0;
        run(levelCfg("fuel_clock").timeLimitSec + 5, { campaign: true });
        expect(STATE.campaign.done).toBe("failed");
    });
});
