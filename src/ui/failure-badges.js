// Floating cause-of-loss badges — Server Survival's best legibility idea,
// translated to a continuous simulation.
//
// SS floats a label over the node that dropped a request. DC never drops a
// request; it fails to serve kilowatts, so a badge here names the BUILDING
// most responsible for the kW going unserved right now ("PDU AT CAP",
// "TOO HOT") and counts up while it keeps happening instead of spraying.
//
// Pooled sprites with their own canvas textures — the src/ui/pulses.js
// pattern, extended with disposal, because these allocate textures.
import { STATE } from "../core/state.js";
import { LOSS_CAUSES } from "../core/loss-causes.js";
import { scene } from "./scene.js";
import { i18n } from "../i18n.js";

const MAX_BADGES = 8;
const SHOW_SEC = 2.6;        // how long a badge lives without being refreshed
const MIN_KW = 0.35;         // ignore rounding-noise losses
const REFRESH_SEC = 0.5;     // how often the set is recomputed

const badges = [];           // { sprite, key, cause, buildingId, life, count, label }
let acc = 0;

function makeTexture(text, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
        ctx.fillStyle = "rgba(8,12,18,0.82)";
        ctx.fillRect(0, 0, 256, 64);
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, 252, 60);
        ctx.fillStyle = color;
        ctx.font = "bold 30px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 128, 34);
    }
    return new THREE.CanvasTexture(canvas);
}

function disposeBadge(b) {
    scene.remove(b.sprite);
    if (b.sprite.material) {
        if (b.sprite.material.map) b.sprite.material.map.dispose();
        b.sprite.material.dispose();
    }
}

function spawn(buildingId, cause, label, color) {
    const texture = makeTexture(label, color);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(7, 1.75, 1);
    scene.add(sprite);
    const badge = { sprite, cause, buildingId, life: SHOW_SEC, count: 1, label };
    badges.push(badge);
    return badge;
}

// Recompute which buildings deserve a badge from this tick's blame list.
function refresh() {
    const blame = STATE.losses.blame.filter((b) => b.kw >= MIN_KW).slice(0, MAX_BADGES);
    for (const entry of blame) {
        const meta = LOSS_CAUSES[entry.cause];
        if (!meta) continue;
        const existing = badges.find((b) => b.buildingId === entry.buildingId && b.cause === entry.cause);
        if (existing) {
            existing.life = SHOW_SEC;   // still happening — hold it, don't stack
            existing.count++;
            continue;
        }
        if (badges.length >= MAX_BADGES) {
            const oldest = badges.reduce((a, b) => (b.life < a.life ? b : a), badges[0]);
            disposeBadge(oldest);
            badges.splice(badges.indexOf(oldest), 1);
        }
        spawn(entry.buildingId, entry.cause, i18n.t(meta.key), meta.color);
    }
}

// dt is UNSCALED wall time (like tickPulses): a paused or resolved board must
// keep its badges readable — that is what turns the game-over screen into a
// crime scene instead of a shrug.
export function tickBadges(dt) {
    acc += dt;
    if (acc >= REFRESH_SEC) {
        acc = 0;
        if (STATE.isRunning) refresh();
    }

    for (let i = badges.length - 1; i >= 0; i--) {
        const b = badges[i];
        const host = STATE.buildings.find((x) => x.id === b.buildingId);
        // Only age while time is actually moving; a paused board holds.
        if (STATE.timeScale > 0) b.life -= dt;
        if (!host || !host.mesh || b.life <= 0) {
            disposeBadge(b);
            badges.splice(i, 1);
            continue;
        }
        // Adjacent buildings put their labels on top of each other, so stagger
        // the height deterministically by index — the same badge keeps the
        // same lane instead of jittering between frames.
        b.sprite.position.set(host.mesh.position.x, 5.2 + (i % 3) * 1.5, host.mesh.position.z);
        b.sprite.material.opacity = Math.min(1, b.life / 0.6);
    }
}

export function clearBadges() {
    for (const b of badges) disposeBadge(b);
    badges.length = 0;
    acc = 0;
}

// Test seam.
export function activeBadges() {
    return badges.map((b) => ({ buildingId: b.buildingId, cause: b.cause, label: b.label }));
}
