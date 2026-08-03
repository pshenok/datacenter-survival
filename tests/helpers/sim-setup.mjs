// Vitest setup for the "sim" project. Runs BEFORE any test file is imported,
// i.e. before the UI modules' graph evaluates. Those modules grab DOM nodes
// and construct THREE objects at module-eval time with no null guards, so
// this must provide both up front:
//   1. globalThis.THREE — the game uses THREE as a classic CDN global.
//   2. The real index.html DOM — so a UI test asserts against the shipped
//      markup, not a hand-written fixture that can silently drift from it.
//
// Ported from the Server Survival harness (its two hard-won details are kept:
// the innerText/textContent coercion shim and the script-stripping), minus
// the audio stubs — Datacenter Survival has no sound layer.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { THREE_STUB } from "./three-stub.mjs";

globalThis.THREE = THREE_STUB;
globalThis.window.THREE = THREE_STUB;

// Browsers coerce `el.textContent = 42` to a string; happy-dom throws. The
// HUD assigns numbers all over, so shim both setters to coerce like a real
// DOM does.
for (const [proto, prop] of [
    [globalThis.window.HTMLElement.prototype, "innerText"],
    [globalThis.window.Node.prototype, "textContent"],
]) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc?.set) {
        Object.defineProperty(proto, prop, {
            ...desc,
            set(v) {
                desc.set.call(this, String(v));
            },
        });
    }
}

// happy-dom has no canvas raster layer, but src/ui/overlay.js paints the
// heat field into one at module scope. A minimal 2d context is enough — the
// pixels go to a THREE texture nothing renders in tests; what the tests read
// is the DOM the module builds around it.
const canvasProto = globalThis.window.HTMLCanvasElement.prototype;
if (!canvasProto.__stubbedGetContext) {
    canvasProto.getContext = function stubGetContext() {
        return {
            createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {},
            clearRect() {},
            fillRect() {},
            drawImage() {},
        };
    };
    canvasProto.__stubbedGetContext = true;
}

// ---- Real index.html DOM fixture ----
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(resolve(repoRoot, "index.html"), "utf8");
const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
if (!bodyMatch) throw new Error("sim-setup: could not extract <body> from index.html");
// Strip script tags so happy-dom never tries to fetch the CDN bundles.
globalThis.document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "");
