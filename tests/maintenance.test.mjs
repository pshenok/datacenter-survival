// Scheduled maintenance — the Tier III mechanic.
//
// A work order is a promise the facility makes: this element WILL be out of
// service for this long, before this deadline. The tests pin the three things
// that makes true — the window really kills the gear, the deadline really
// expires, and a room that never declares an order never notices any of it.
import { describe, it, expect, beforeEach } from "vitest";
import { CONFIG } from "../src/core/config.js";
import { STATE, resetState } from "../src/core/state.js";
import { Building, resetBuildingIds } from "../src/entities/Building.js";
import { wireBuildings, resolvePower, isDeadGear } from "../src/sim/power.js";
import { tickDemand, tickEvents } from "../src/sim/demand.js";
import { tickHeat } from "../src/sim/heat.js";
import { resetBreaker } from "../src/sim/crisis.js";
import {
    initMaintenance, tickMaintenance, openServiceWindow,
    pendingOrderFor, activeOrderCount,
} from "../src/sim/maintenance.js";
import { tickCampaign, startLevelState, levelCfg } from "../src/campaign/campaign.js";
import { demolishBuilding } from "../src/sim/build.js";

const DT = 0.05;

function place(type, gx, gz) {
    const b = new Building(type, gx, gz);
    STATE.buildings.push(b);
    return b;
}

// Feed -> transformer -> pdu -> rack, plus a cooling unit so the room is real.
function room() {
    STATE.demandFixedKw = 6;
    const f = place("grid_feed", 2, 5);
    const x = place("transformer", 5, 5);
    const p = place("pdu", 8, 5);
    wireBuildings(f, x);
    wireBuildings(x, p);
    const r = place("rack", 12, 5);
    wireBuildings(p, r);
    wireBuildings(p, place("crac", 13, 5));
    return { f, x, p, r };
}

function run(seconds) {
    for (let i = 0; i < seconds / DT; i++) {
        STATE.elapsedGameTime += DT;
        const t = STATE.elapsedGameTime;
        tickEvents(DT, t);
        tickDemand(DT, t);
        resolvePower(DT);
        tickHeat(DT);
        tickMaintenance(DT, t);
    }
}

beforeEach(() => {
    resetState();
    resetBuildingIds();
    STATE.heatwave.nextAt = Infinity;
    STATE.brownout.nextAt = Infinity;
    STATE.breakdown.nextAt = Infinity;
    STATE.gridOutage.nextAt = Infinity;
    STATE.tariff.nextAt = Infinity;
    STATE.contract.nextAt = Infinity;
});

describe("a work order is a promise with a deadline", () => {
    it("resolves declared targets to real buildings", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 30, bySec: 90 }], STATE.buildings);
        expect(STATE.maintenance.orders.length).toBe(1);
        expect(STATE.maintenance.orders[0].buildingId).toBe(p.id);
        expect(STATE.maintenance.orders[0].state).toBe("pending");
        expect(pendingOrderFor(p)).not.toBeNull();
    });

    it("THROWS on a target that resolves to nothing — an order pointing at no gear is an unwinnable level", () => {
        room();
        expect(() => initMaintenance([{ target: 99, durationSec: 30, bySec: 90 }], STATE.buildings))
            .toThrow();
    });

    it("opening a window kills the gear, and the subtree with it", () => {
        const { p, r } = room();
        initMaintenance([{ target: 2, durationSec: 30, bySec: 90 }], STATE.buildings);
        run(20);
        expect(r.powered).toBe(true);

        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(true);
        expect(isDeadGear(p)).toBe(true);
        expect(activeOrderCount()).toBe(1);
        run(5);
        expect(r.powered).toBe(false);
        expect(STATE.servedKw).toBeLessThan(0.01);
    });

    it("closes itself when the window runs out, and the room comes back", () => {
        const { p, r } = room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 90 }], STATE.buildings);
        run(5);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(11);
        expect(p.outForService).toBe(false);
        expect(STATE.maintenance.orders[0].state).toBe("done");
        expect(activeOrderCount()).toBe(0);
        run(5);
        expect(r.powered).toBe(true);
    });

    it("accrues no breaker heat while out for service — this is not a fault", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(5);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(10);
        expect(p.breakerHeat).toBe(0);
        expect(p.tripped).toBe(false);
    });

    it("misses an order whose deadline passes while it is still pending — and missed is terminal", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 30 }], STATE.buildings);
        run(35);
        expect(STATE.maintenance.orders[0].state).toBe("missed");
        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(false);
        run(10);
        expect(STATE.maintenance.orders[0].state).toBe("missed");
        expect(p.outForService).toBe(false);
    });

    it("does not miss an order that was opened before the deadline but runs past it", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 30 }], STATE.buildings);
        run(25);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(25);
        expect(STATE.maintenance.orders[0].state).toBe("done");
    });

    it("refuses to open a second window on the same order", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        openServiceWindow(p, STATE.elapsedGameTime);
        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(false);
        expect(activeOrderCount()).toBe(1);
    });

    it("refuses gear with no order at all", () => {
        const { x } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        expect(openServiceWindow(x, STATE.elapsedGameTime)).toBe(false);
        expect(x.outForService).toBe(false);
    });
});

describe("the pure-module contract", () => {
    it("no-ops on dt <= 0, NaN and Infinity", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 90 }], STATE.buildings);
        openServiceWindow(p, 0);
        const left = p.serviceLeftSec;
        for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
            tickMaintenance(bad, 5);
            expect(p.serviceLeftSec).toBe(left);
        }
    });

    it("resetState severs every order", () => {
        room();
        initMaintenance([{ target: 2, durationSec: 10, bySec: 90 }], STATE.buildings);
        expect(STATE.maintenance.orders.length).toBe(1);
        resetState();
        expect(STATE.maintenance).toEqual({ orders: [] });
    });

    it("is INERT where no order is declared — bit-identical room", () => {
        const snap = () => ({
            served: STATE.servedKw, it: STATE.itDrawKw, total: STATE.totalDrawKw,
            money: STATE.money, rep: STATE.reputation, heat: Array.from(STATE.heatField),
        });
        room();
        run(60);
        const withModule = snap();

        resetState();
        resetBuildingIds();
        STATE.heatwave.nextAt = Infinity;
        STATE.brownout.nextAt = Infinity;
        STATE.breakdown.nextAt = Infinity;
        STATE.gridOutage.nextAt = Infinity;
        STATE.tariff.nextAt = Infinity;
        STATE.contract.nextAt = Infinity;
        room();
        initMaintenance([], STATE.buildings);
        run(60);

        expect(snap()).toEqual(withModule);
    });
});

// Two facts from the Task 1 review that pullOf() and the breaker block have
// to respect, not just deliver() and chainAlive: dead gear (tripped OR
// serviced — see isDeadGear) carries nothing UP the chain either, and it
// physically cannot overheat, because nothing is flowing through it. Both
// scenarios below load the serviced node with a CRAC, deliberately: a CRAC
// bills off its own duty cycle, never off assignLoad's chainAlive gate, so
// its demand survives being cut off exactly the way a naive fix would not.
describe("dead gear carries nothing — not downstream, and not to its own breaker", () => {
    it("a serviced node reports zero pull upstream, so a live sibling on the same bus keeps its whole share", () => {
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const serviced = place("pdu", 8, 3);
        const live = place("pdu", 8, 7);
        wireBuildings(feed, xf);
        wireBuildings(xf, serviced);
        wireBuildings(xf, live);

        // Five CRACs at full duty ask the serviced PDU's subtree for 15 kW —
        // well inside its own 16 kW rating, so nothing here is locally
        // clipped; whatever the parent sees is exactly what a "dead gear
        // still reports its rated capacity" bug would carry upstream.
        for (let i = 0; i < 5; i++) {
            const c = place("crac", 11 + i, 3);
            wireBuildings(serviced, c);
            c.duty = 1;
        }
        const racks = [];
        for (let i = 0; i < 3; i++) {
            const r = place("rack", 11 + i, 7);
            r.assignedKw = 6;
            wireBuildings(live, r);
            racks.push(r);
        }

        initMaintenance([{ target: 2, durationSec: 30, bySec: 90 }], STATE.buildings);
        expect(openServiceWindow(serviced, 0)).toBe(true);

        resolvePower(DT);

        // live's own 16 kW rating is the only real constraint on it — the
        // transformer (30 kW) has plenty of headroom once the serviced PDU
        // correctly reports zero, so live must not lose a single watt to a
        // sibling that is not actually drawing anything.
        expect(live.actualKw).toBeCloseTo(16, 5);
        // serviced asked its own subtree for 15 kW and delivered none of it.
        // The ledger has to name the whole 15 as clipped here — a clean zero
        // would hide the fact that this PDU is why the CRACs went dark.
        expect(serviced.clippedKw).toBeCloseTo(15, 5);
    });

    it("a serviced node accrues no breaker heat, however long the demand behind it stays overloaded", () => {
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);

        // Eight CRACs at full duty ask this 16 kW PDU for 24 kW — 150% of
        // rating. Live, that trips in about (2.0 / 0.5) = 4 seconds; the
        // window below runs for ten, five times CONFIG.breaker.tripSeconds.
        for (let i = 0; i < 8; i++) {
            const c = place("crac", 11 + i, 5);
            wireBuildings(pdu, c);
            c.duty = 1;
        }

        initMaintenance([{ target: 2, durationSec: 9999, bySec: 9999 }], STATE.buildings);
        expect(openServiceWindow(pdu, 0)).toBe(true);

        const ticks = Math.round((CONFIG.breaker.tripSeconds * 5) / DT);
        for (let i = 0; i < ticks; i++) {
            resolvePower(DT);
        }
        expect(pdu.breakerHeat).toBe(0);
        expect(pdu.tripped).toBe(false);
    });
});

describe("the ledger tells the truth about why the room went dark", () => {
    it("names planned work as planned work, not as a breaker trip", async () => {
        const { p, r } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(10);
        openServiceWindow(p, STATE.elapsedGameTime);
        run(5);

        expect(r.powered).toBe(false);
        expect(STATE.losses.tickKw.maintenance).toBeGreaterThan(0);
        expect(STATE.losses.tickKw.breaker_tripped || 0).toBe(0);
        expect(STATE.losses.tickKw.dead_chain || 0).toBe(0);
        const blamed = STATE.buildings.find((b) => b.id === STATE.losses.blame[0].buildingId);
        expect(blamed.id).toBe(p.id);
    });

    it("still sums exactly — the conservation identity survives a new bucket", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(10);
        openServiceWindow(p, STATE.elapsedGameTime);
        for (let i = 0; i < 300; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t);
            tickDemand(DT, t);
            resolvePower(DT);
            tickHeat(DT);
            tickMaintenance(DT, t);
            const missed = Math.max(0, STATE.demandKw - STATE.servedKw);
            const summed = Object.values(STATE.losses.tickKw).reduce((a, b) => a + b, 0);
            expect(summed).toBeCloseTo(missed, 9);
        }
    });

    it("won't let a scheduled window hide a live breaker trip — the fault has to be cleared first", () => {
        const { p } = room();
        // Four more racks on the same 16 kW PDU push its demandedKw to 30 kW
        // (187% of rating), so the breaker opens on its own in a few seconds
        // — nobody has to hand-set `tripped` for this to be real.
        for (let i = 0; i < 4; i++) {
            wireBuildings(p, place("rack", 12 + i, 3));
        }
        STATE.demandFixedKw = 30;
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        run(5);
        expect(p.tripped).toBe(true);

        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(false);
        expect(p.outForService).toBe(false);
        expect(STATE.maintenance.orders[0].state).toBe("pending");
        run(1);
        expect(STATE.losses.tickKw.breaker_tripped).toBeGreaterThan(0);
        expect(STATE.losses.tickKw.maintenance || 0).toBe(0);

        // Clear the fault the normal way — the select-click reset — and the
        // window that was refused a moment ago now opens.
        expect(resetBreaker(p)).toBe(true);
        expect(openServiceWindow(p, STATE.elapsedGameTime)).toBe(true);
        expect(p.outForService).toBe(true);
    });
});

// Task 1 review: chainAlive (demand.js) and primaryPathDead (power.js) both
// walked into the `node.parentId === "grid"` branch and RETURNED FROM INSIDE
// IT — before ever reaching the isDeadGear(node) check below. A grid_feed or
// generator out for service therefore still read as a live root even though
// isDeadGear was written to cover exactly this case. Both walks now check
// isDeadGear before the "grid" branch; these two tests pin the two proven
// consequences of the old order.
describe("dead SOURCES are dead roots too — isDeadGear runs before the grid branch", () => {
    it("a rack behind a serviced grid feed is not assigned work nobody can serve", () => {
        const { f, r } = room();
        initMaintenance([{ target: 0, durationSec: 30, bySec: 90 }], STATE.buildings);
        run(5);
        expect(r.powered).toBe(true);

        expect(openServiceWindow(f)).toBe(true);
        expect(isDeadGear(f)).toBe(true);
        run(1);
        // With the old order, chainAlive fell into the "grid" branch, found
        // chainRole "source", checked feedIsDark (false — no outage) and
        // returned true — so the rack kept getting assignedKw against a feed
        // that resolvePower's OWN isDeadGear check (a separate code path,
        // unaffected by this bug) was already refusing to deliver anything
        // through. Assigned-but-never-served is the exact starvation
        // tests/integration.test.mjs exists to prevent.
        expect(r.assignedKw).toBe(0);
        expect(STATE.servedKw).toBe(0);
    });

    it("a standby generator DOES pick up when the feed it backs is out for service, after cutoverSec — the canonical generator run", () => {
        STATE.demandFixedKw = 12;
        const feed = place("grid_feed", 2, 5);
        const xf = place("transformer", 5, 5);
        const pdu = place("pdu", 8, 5);
        wireBuildings(feed, xf);
        wireBuildings(xf, pdu);
        const racks = [place("rack", 12, 4), place("rack", 12, 6)];
        racks.forEach((rk) => wireBuildings(pdu, rk));
        const gen = place("generator", 2, 9);
        wireBuildings(gen, pdu);          // standby edge onto the bus

        initMaintenance([{ target: 0, durationSec: 9999, bySec: 9999 }], STATE.buildings);
        run(5);
        expect(gen.actualKw).toBe(0);     // idle while the utility feed is fine

        expect(openServiceWindow(feed)).toBe(true);
        run(CONFIG.buildings.generator.cutoverSec + 4);
        // With the old order, primaryPathDead fell into the "grid" branch for
        // the feed, checked feedIsDark (false) and returned false — "path is
        // alive" — so the transfer switch never started its cutover clock. A
        // standby generator refusing to cover a utility feed taken out for
        // planned service is the single most canonical real generator run
        // there is.
        expect(gen.actualKw).toBeGreaterThan(0);
        expect(STATE.servedKw).toBeGreaterThan(0);
    });
});

// Task 2 review: demolishBuilding had no awareness of STATE.maintenance —
// open a window on a PDU, demolish it, and tickMaintenance counted the
// orphaned order down to "done" on gear that no longer exists. A refund AND
// a free completed work order, on a level whose objective is literally
// maintenance_without_loss.
describe("demolishing a building cannot complete its own work order", () => {
    it("misses a PENDING order the moment its building is demolished", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        demolishBuilding(p);
        expect(STATE.maintenance.orders[0].state).toBe("missed");
    });

    it("misses an ACTIVE order too, and tickMaintenance never resurrects it into 'done'", () => {
        const { p } = room();
        initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
        expect(openServiceWindow(p)).toBe(true);
        demolishBuilding(p);
        expect(STATE.maintenance.orders[0].state).toBe("missed");
        run(25); // well past durationSec — the old bug ran the countdown to "done" here
        expect(STATE.maintenance.orders[0].state).toBe("missed");
    });

    it("leaves an order targeting OTHER gear alone", () => {
        const { p, x } = room();
        initMaintenance([{ target: 1, durationSec: 20, bySec: 90 }], STATE.buildings); // targets the transformer, index 1
        expect(x).toBeTruthy();
        demolishBuilding(p);
        expect(STATE.maintenance.orders[0].state).toBe("pending");
    });

    it("fails the maintenance_without_loss objective — a refund is not a completed work order", () => {
        const { p } = (() => {
            const built = room();
            STATE.campaign = {
                levelId: "first_watt",
                objectives: [{ type: "maintenance_without_loss", minServedRatio: 0.9, progress: 0, done: false, failed: false }],
                bonuses: [], endsAt: 9999, done: null, reason: null,
            };
            initMaintenance([{ target: 2, durationSec: 20, bySec: 90 }], STATE.buildings);
            return built;
        })();
        demolishBuilding(p);
        for (let i = 0; i < 5 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(true);
    });
});

describe("the objective can fail a level, which nothing else in the engine does", () => {
    // tickCampaign no-ops on levelId === null (that's the documented survival/
    // sandbox sentinel in core/state.js) so a synthetic objective test needs a
    // REAL level id or the sweep below never runs at all. "first_watt" is
    // picked only because its script is empty — runScript(cfg, elapsed) is
    // then a no-op and it cannot inject a brownout/heatwave/outage into a
    // room this test never asked for.
    function objRoom(orders, objective) {
        const built = room();
        STATE.campaign = {
            levelId: "first_watt",
            objectives: [{ ...objective, progress: 0, done: false, failed: false }],
            bonuses: [], endsAt: 9999, done: null, reason: null,
        };
        initMaintenance(orders, STATE.buildings);
        return built;
    }

    it("fails the moment an order is missed", () => {
        objRoom([{ target: 2, durationSec: 10, bySec: 20 }],
            { type: "maintenance_without_loss", minServedRatio: 0.9 });
        for (let i = 0; i < 30 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(true);
    });

    it("fails when load drops while a window is open", () => {
        const { p } = objRoom([{ target: 2, durationSec: 20, bySec: 90 }],
            { type: "maintenance_without_loss", minServedRatio: 0.9 });
        for (let i = 0; i < 10 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(false);
        openServiceWindow(p, STATE.elapsedGameTime);
        for (let i = 0; i < 10 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(true);
    });

    it("ignores a load dip while NO window is open — it judges the work, not the weather", () => {
        const { p } = objRoom([{ target: 2, durationSec: 10, bySec: 900 }],
            { type: "maintenance_without_loss", minServedRatio: 0.9 });
        p.tripped = true;                       // a fault, not planned work
        for (let i = 0; i < 20 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].failed).toBe(false);
    });

    it("is inert for a level that declares no orders — an empty work list can never win or lose it", () => {
        objRoom([], { type: "maintenance_without_loss", minServedRatio: 0.9 });
        for (let i = 0; i < 30 / DT; i++) {
            STATE.elapsedGameTime += DT;
            const t = STATE.elapsedGameTime;
            tickEvents(DT, t); tickDemand(DT, t); resolvePower(DT); tickHeat(DT);
            tickMaintenance(DT, t); tickCampaign(DT, t);
        }
        expect(STATE.campaign.objectives[0].done).toBe(false);
        expect(STATE.campaign.objectives[0].failed).toBe(false);
    });
});
