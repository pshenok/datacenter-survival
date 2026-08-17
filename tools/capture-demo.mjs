// Records the README demo GIF by playing the game for real: a headless
// Chromium loads the live page, a scripted "player" builds a datacenter
// through the same module API the mouse handlers use, and frames are grabbed
// while the game's own animate loop renders. Nothing is faked — every number,
// the heat bloom, the throttling and the banners are the actual simulation
// (the sim is fast-forwarded with the game's own timeScale so a 4-minute run
// fits in a 20-second loop).
//
//   node tools/capture-demo.mjs [port] [outDir]
//
// Frames land as PNGs; assemble with ffmpeg (see tools/make-gif.sh).
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";

const PORT = process.argv[2] || "8299";
const OUT = process.argv[3] || "/tmp/dc-frames";
const W = 1440, H = 810;    // 16:9, downscaled at encode time — crisp text
const FPS = 12;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Uses the system Chrome (channel) so no 150 MB browser download is needed.
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) console.log("PAGE ERROR:", m.text()); });

await page.addInitScript(() => {
    localStorage.setItem("dc_tutorial_done", "1");
    localStorage.setItem("dc_locale", "en");
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.startGame === "function" && window.THREE);

// Expose a scripted-player API in page context: the same calls the mouse
// handlers make, so meshes/wires/HUD all come up through the real path.
await page.evaluate(async () => {
    const [state, power, meshes, toolbar, scene] = await Promise.all([
        import("/src/core/state.js"),
        import("/src/sim/power.js"),
        import("/src/ui/meshes.js"),
        import("/src/ui/toolbar.js"),
        import("/src/ui/scene.js"),
    ]);
    const { Building } = await import("/src/entities/Building.js");
    const S = state.STATE;
    let wireId = 1;
    window.__demo = {
        S,
        place(type, gx, gz) {
            const b = new Building(type, gx, gz);
            S.money -= b.config.cost;
            S.buildings.push(b);
            meshes.attachMesh(b);
            toolbar.refreshAffordability();
            return b;
        },
        wire(a, b) {
            if (!power.wireBuildings(a, b)) return;
            const standby = b.standbyParentId === a.id;
            const w = { id: "w" + wireId++, from: a.id, to: b.id, standby, mesh: null };
            S.wires.push(w);
            meshes.addWireMesh(w, a, b);
        },
        // Frame the build: zoom, then slide the camera so the machine hall
        // sits in the middle of the shot instead of the world origin.
        frame(zoom, gx, gz) {
            const c = scene.camera;
            const w = scene.gridToWorld(gx, gz);
            const d = new THREE.Vector3(w.x, 0, w.z).sub(scene.cameraTarget);
            c.position.add(d);
            scene.cameraTarget.add(d);
            c.zoom = zoom;
            c.updateProjectionMatrix();
            c.lookAt(scene.cameraTarget);
        },
        // The game's own fast-forward: dt is scaled, every rule unchanged.
        speed(x) { S.timeScale = x; },
    };
    window.__b = {};
});

const run = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = () => run(() => {
    const S = window.__demo.S;
    const rack = S.buildings.find((b) => b.type === "rack");
    return {
        t: Math.round(S.elapsedGameTime),
        maxC: Math.round(Math.max(...S.heatField)),
        demand: +S.demandKw.toFixed(1),
        served: +S.servedKw.toFixed(1),
        rep: Math.round(S.reputation),
        money: Math.round(S.money),
        throttle: rack ? +rack.throttleFactor.toFixed(2) : null,
    };
});

// ---- frame grabber: fires on a fixed cadence for the whole take ---------
let frame = 0;
let grabbing = true;
const grabber = (async () => {
    while (grabbing) {
        const t0 = Date.now();
        await page.screenshot({ path: `${OUT}/f${String(frame++).padStart(4, "0")}.png` });
        const wait = 1000 / FPS - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
    }
})();

// ---- the take -----------------------------------------------------------
// Beat 1: an empty machine hall — then the power chain appears link by link.
await run(() => {
    window.startGame();
    window.__demo.frame(1.7, 16, 15);    // centre on the hall we are about to build
    window.__demo.S.money = 2800;        // a demo build, not a balance claim
});
await sleep(700);

for (const [key, type, gx, gz] of [
    ["feedA", "grid_feed", 8, 12],
    ["xfA", "transformer", 11, 12],
    ["upsA", "ups", 14, 12],
    ["pduA", "pdu", 17, 12],
]) {
    await run(([k, t, x, z]) => { window.__b[k] = window.__demo.place(t, x, z); }, [key, type, gx, gz]);
    await sleep(330);
}

// Beat 2: wire it — electricity starts running down the chain.
await run(() => {
    const d = window.__demo, b = window.__b;
    d.wire(b.feedA, b.xfA); d.wire(b.xfA, b.upsA); d.wire(b.upsA, b.pduA);
});
await sleep(650);

// Beat 3: a second feed for the other half of the room (no UPS on this one).
await run(() => {
    const d = window.__demo, b = window.__b;
    b.feedB = d.place("grid_feed", 8, 17);
    b.xfB = d.place("transformer", 11, 17);
    b.pduB = d.place("pdu", 17, 17);
    d.wire(b.feedB, b.xfB); d.wire(b.xfB, b.pduB);
});
await sleep(750);

// Beat 4: eight racks in a tight block — the datacenter goes live.
await run(() => {
    const d = window.__demo, b = window.__b;
    const spots = [[21, 12], [22, 12], [23, 12], [24, 12], [21, 14], [22, 14], [23, 14], [24, 14]];
    spots.forEach(([gx, gz], i) => d.wire(i < 4 ? b.pduA : b.pduB, d.place("rack", gx, gz)));
});
await sleep(500);
await run(() => window.togglePause());
await sleep(1500);

// Beat 5: demand ramps and the block cooks itself. Thermal overlay on, the
// game's own fast-forward engaged: blue floor turns amber, then red, racks
// throttle past 45°C and SLA starts slipping.
await run(() => { window.toggleThermalOverlay(); window.__demo.speed(35); });
await sleep(6400);
console.log("heat peak:", await stat());

// Beat 6: cooling answers — CRACs on their own PDU, drawing power to do it.
// That is PUE, and the red recedes.
await run(() => {
    const d = window.__demo, b = window.__b;
    b.pduC = d.place("pdu", 17, 20);
    d.wire(b.xfB, b.pduC);
    for (const [gx, gz] of [[22, 16], [25, 13], [20, 10]]) d.wire(b.pduC, d.place("crac", gx, gz));
});
await sleep(4600);
console.log("after cooling:", await stat());
await run(() => { window.__demo.speed(1); window.toggleThermalOverlay(); });
await sleep(900);

// Beat 7: a generator on standby (the grey wire is the transfer switch),
// then the city grid dies — chain B goes dark, the UPS bridges chain A,
// and the generator picks the load up.
await run(() => {
    const d = window.__demo, b = window.__b;
    b.gen = d.place("generator", 8, 21);
    d.wire(b.gen, b.xfA);
});
await sleep(1100);
await run(() => {
    const S = window.__demo.S;
    S.gridOutage.active = true;
    S.gridOutage.endsAt = S.elapsedGameTime + 30;
});
await sleep(4600);
console.log("during outage:", await stat());

// Beat 8: the diagnosis layer. Badges have been naming the culprit over
// each building all along; the ledger says where the money went.
await run(() => {
    const S = window.__demo.S;
    S.gridOutage.active = false;
    window.openPauseMenu();
});
await sleep(3600);
console.log("ledger:", await run(() => document.getElementById("pause-ledger").innerText.replace(/\n+/g, " | ")));

grabbing = false;
await grabber;
await browser.close();
console.log(`captured ${frame} frames at ${FPS} fps -> ${OUT}`);
