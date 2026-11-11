// Dev-only model preview: lays every manifest model out on a grid, seen from
// straight above, with the manifest's pitch/yaw applied and an arrow showing
// the game's forward axis. Open /tools/preview/index.html on the dev server.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { parseManifest } from "../../src/render/manifest";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070910);
scene.add(new THREE.HemisphereLight(0xffffff, 0x222244, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(2, 5, 3);
scene.add(sun);

const manifest = parseManifest(await (await fetch("/models/manifest.json")).json());
const entries = Object.entries(manifest.models);
const cols = Math.ceil(Math.sqrt(entries.length * 1.6));
const cell = 1.6;
const camera = new THREE.OrthographicCamera();
const rows = Math.ceil(entries.length / cols);
const fit = () => {
  const w = cols * cell;
  const h = rows * cell + 0.6;
  const aspect = innerWidth / innerHeight;
  const half = Math.max(w / aspect, h) / 2;
  camera.left = -half * aspect;
  camera.right = half * aspect;
  camera.top = half;
  camera.bottom = -half;
  camera.near = -50;
  camera.far = 50;
  camera.position.set(0, 10, 0);
  camera.up.set(0, 0, -1); // screen up = world -Z, like the game camera
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
};
fit();
addEventListener("resize", fit);

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const labels = document.getElementById("labels")!;

await Promise.all(
  entries.map(async ([role, e], i) => {
    const gltf = await loader.loadAsync(`/models/${e.file}`);
    const obj = gltf.scene;
    const pivot = new THREE.Group();
    const holder = new THREE.Group();
    holder.add(obj);
    holder.rotation.order = "YXZ";
    holder.rotation.x = e.pitch;
    holder.rotation.y = e.yaw;
    pivot.add(holder);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const s = 1 / Math.max(size.x, size.y, size.z);
    pivot.scale.setScalar(s);
    const c = box.getCenter(new THREE.Vector3());
    holder.position.set(-c.x, -c.y, -c.z);

    const x = ((i % cols) - (cols - 1) / 2) * cell;
    const z = (Math.floor(i / cols) - (rows - 1) / 2) * cell;
    pivot.position.set(x, 0, z);
    scene.add(pivot);
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(x, 0.8, z - 0.1), 0.7, 0xffa040, 0.18, 0.12);
    scene.add(arrow);

    const label = document.createElement("div");
    label.textContent = `${role}  pitch ${e.pitch.toFixed(2)}  yaw ${e.yaw.toFixed(2)}`;
    labels.appendChild(label);
    const place = () => {
      const p = new THREE.Vector3(x, 0, z + 0.62).project(camera);
      label.style.left = `${((p.x + 1) / 2) * innerWidth}px`;
      label.style.top = `${((1 - p.y) / 2) * innerHeight}px`;
    };
    place();
    addEventListener("resize", place);
  }),
);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
