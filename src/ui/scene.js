// Scene, camera, renderer, floor grid — the Three.js stage. Adapted from
// Server Survival's setup; THREE is the r128 CDN global.
import { CONFIG } from "../core/config.js";

export const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.007);

const aspect = window.innerWidth / window.innerHeight;
const d = 46;
export const camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 1000);
export const cameraTarget = new THREE.Vector3(0, 0, 0);

export function resetCamera() {
    camera.position.set(60, 60, 60);
    cameraTarget.set(0, 0, 0);
    camera.lookAt(cameraTarget);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
}
resetCamera();

// Slide the camera so a given world point sits in the middle of the shot,
// keeping the isometric angle. A prebuilt level hands the player a room
// somewhere on the floor and must not make them go looking for it.
export function focusWorld(x, z) {
    const dx = x - cameraTarget.x;
    const dz = z - cameraTarget.z;
    camera.position.x += dx;
    camera.position.z += dz;
    cameraTarget.x += dx;
    cameraTarget.z += dz;
    camera.lookAt(cameraTarget);
}

export const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const dirLight = new THREE.DirectionalLight(0xffe8c8, 0.7);
dirLight.position.set(25, 60, 15);
scene.add(dirLight);

const worldSize = CONFIG.gridSize * CONFIG.tileSize;
const gridHelper = new THREE.GridHelper(worldSize, CONFIG.gridSize, 0x1e3a5f, 0x132638);
scene.add(gridHelper);

export const buildingGroup = new THREE.Group();
export const wireGroup = new THREE.Group();
scene.add(buildingGroup);
scene.add(wireGroup);

// grid coords (0..gridSize-1) <-> world coords (tile centers)
export function gridToWorld(gx, gz) {
    const half = worldSize / 2;
    return {
        x: gx * CONFIG.tileSize - half + CONFIG.tileSize / 2,
        z: gz * CONFIG.tileSize - half + CONFIG.tileSize / 2,
    };
}
export function worldToGrid(x, z) {
    const half = worldSize / 2;
    return {
        gx: Math.max(0, Math.min(CONFIG.gridSize - 1, Math.floor((x + half) / CONFIG.tileSize))),
        gz: Math.max(0, Math.min(CONFIG.gridSize - 1, Math.floor((z + half) / CONFIG.tileSize))),
    };
}

window.addEventListener("resize", () => {
    const a = window.innerWidth / window.innerHeight;
    camera.left = -d * a;
    camera.right = d * a;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
