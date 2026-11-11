/**
 * The hangar: a turntable showroom for every Lux3D model in the game. Uses
 * the game's renderer with its own small scene, lights and camera, and only
 * renders while the hangar screen is open.
 */
import * as THREE from "three";
import type { RobotHandle } from "./robots";
import type { ClipName } from "./robots";

const DISPLAY_SIZE = 2.2;
const CLIP_CYCLE: ClipName[] = ["Idle", "Running", "Walking", "Idle"];

export class Hangar {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.01, 100);
  private readonly turntable = new THREE.Group();
  private current: RobotHandle | null = null;
  private t = 0;
  private clipIdx = 0;

  constructor() {
    this.scene.background = new THREE.Color(0x060912);
    this.scene.fog = new THREE.Fog(0x060912, 6, 16);
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a1030, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x3fe9ff, 18, 12, 2);
    rim.position.set(-3, 2.5, -2.5);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff9a5a, 10, 12, 2);
    warm.position.set(3, 1.5, -3);
    this.scene.add(warm);

    // Pedestal: a dark disc with a glowing edge.
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.8, 0.12, 64),
      new THREE.MeshStandardMaterial({ color: 0x111a2e, metalness: 0.6, roughness: 0.35 }),
    );
    disc.position.y = -0.06;
    this.scene.add(disc);
    const edge = new THREE.Mesh(new THREE.TorusGeometry(1.78, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: 0x3fe9ff }));
    edge.rotation.x = Math.PI / 2;
    this.scene.add(edge);
    const grid = new THREE.GridHelper(20, 40, 0x1c3358, 0x101c33);
    grid.position.y = -0.12;
    this.scene.add(grid);

    this.scene.add(this.turntable);
  }

  /** Put a model on the turntable, scaled to fit and standing on the pedestal. */
  show(handle: RobotHandle): void {
    if (this.current) this.turntable.remove(this.current.root);
    this.current = handle;
    this.t = 0;
    this.clipIdx = 0;
    const root = handle.root;
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.scale.setScalar(1);
    root.visible = true;
    this.turntable.add(root);
    this.turntable.rotation.y = -0.6;
    handle.setFlash(false);
    handle.setTint(0x000000);
    handle.setBroken?.(false);
    handle.play("Idle", 0);
    handle.update(0);

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const s = DISPLAY_SIZE / (Math.max(size.x, size.y, size.z) || 1);
    root.scale.setScalar(s);
    box.setFromObject(root);
    const c = box.getCenter(new THREE.Vector3());
    root.position.set(-c.x, -box.min.y, -c.z);

    const h = box.max.y - box.min.y;
    this.camera.position.set(0, h * 0.55 + 1.1, 5.4);
    this.camera.lookAt(0, h * 0.45, 0);
  }

  update(dt: number): void {
    this.t += dt;
    this.turntable.rotation.y += dt * 0.45;
    const h = this.current;
    if (!h) return;
    // Walk characters through their Lux3D clips; rigid models just turn.
    const step = Math.floor(this.t / 3) % CLIP_CYCLE.length;
    if (step !== this.clipIdx) {
      this.clipIdx = step;
      h.play(CLIP_CYCLE[step], 0.3);
    }
    h.update(dt);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    // Keep the model in the left two-thirds on wide screens, beside the info card.
    this.camera.setViewOffset(w, h, w > h * 1.2 ? w * 0.16 : 0, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }
}
