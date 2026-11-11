/**
 * Hands out model instances by role ("enemy.grunt", "player.default", ...).
 * Roles listed in public/models/manifest.json get their Lux3D-generated model;
 * every other role, and any model that fails to load, falls back to the
 * bundled robot, so the game always runs with or without generated assets.
 *
 * Generated models are normalized into the bundled robot's frame: a wrapper
 * Object3D whose child is scaled to the robot's natural height and sits with
 * its feet at y=0. WorldView's existing scale calibration then works
 * unchanged for every model.
 */
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { RobotFactory, type ClipName, type RobotHandle } from "./robots";
import { parseManifest, resolveClip, type GameClip, type ModelEntry } from "./manifest";

interface LoadedModel {
  entry: ModelEntry;
  gltf: GLTF;
  /** Scale that brings the model to the reference robot's height. */
  norm: number;
  /** Offset that centers it on x/z and puts its lowest point on y=0. */
  offset: THREE.Vector3;
  /** Reference robot height in wrapper units, for sizing procedural motion. */
  ref: number;
}

const GAME_CLIPS = new Set<string>(["Idle", "Walking", "Running", "Death"]);

export class ModelLibrary {
  readonly fallback = new RobotFactory();
  private readonly models = new Map<string, LoadedModel>();
  /** Roles that load and run on generated models, for the debug probe and the hangar. */
  readonly generatedRoles: string[] = [];
  private readonly lazy = new Map<string, ModelEntry>();
  private baseUrl = "/";

  /** Pre-forged gallery bosses (lazy manifest roles under forge.gallery.*) with their prompts. */
  gallery(): { role: string; prompt: string }[] {
    return [...this.lazy]
      .filter(([role]) => role.startsWith("forge.gallery."))
      .map(([role, e]) => ({ role, prompt: e.prompt ?? role }));
  }

  /** Fetch a lazy model now (no-op if already loaded). */
  async loadLazy(role: string): Promise<void> {
    if (this.models.has(role)) return;
    const entry = this.lazy.get(role);
    if (!entry) throw new Error(`no lazy model ${role}`);
    await this.loadRuntime(role, `${this.baseUrl}models/${entry.file}`, entry);
  }

  async load(baseUrl: string, onProgress?: (frac: number) => void): Promise<void> {
    let robotFrac = 0;
    let modelFrac = 1;
    const report = () => onProgress?.(robotFrac * 0.4 + modelFrac * 0.6);

    const robot = this.fallback.load(`${baseUrl}models/RobotExpressive.glb`, (f) => {
      robotFrac = f;
      report();
    });

    let entries: [string, ModelEntry][] = [];
    try {
      const res = await fetch(`${baseUrl}models/manifest.json`, { cache: "no-cache" });
      if (res.ok) entries = Object.entries(parseManifest(await res.json()).models);
    } catch {
      /* no manifest: everything uses the bundled robot */
    }
    // Lazy models (the Forge gallery) are only listed now and fetched when needed.
    this.baseUrl = baseUrl;
    for (const [role, entry] of entries) if (entry.lazy) this.lazy.set(role, entry);
    entries = entries.filter(([, entry]) => !entry.lazy);

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    let done = 0;
    modelFrac = entries.length ? 0 : 1;
    const loads = entries.map(async ([role, entry]) => {
      try {
        const gltf = await loader.loadAsync(`${baseUrl}models/${entry.file}`);
        this.models.set(role, { entry, gltf, norm: 1, offset: new THREE.Vector3(), ref: 1 });
        this.generatedRoles.push(role);
      } catch (err) {
        console.warn(`[models] ${role}: failed to load ${entry.file}, using the bundled robot`, err);
      } finally {
        modelFrac = ++done / entries.length;
        report();
      }
    });

    await Promise.all([robot, ...loads]);

    // Built-in stand-ins for the space cast until Lux3D models replace them.
    for (const [role, build] of Object.entries(PROCEDURAL)) {
      if (this.models.has(role)) continue;
      const scene = build();
      this.models.set(role, {
        entry: { file: "builtin.glb", kind: "rigid", yaw: 0, pitch: 0, heightMul: PROCEDURAL_SIZE[role] ?? 1, fit: "size", lazy: false },
        gltf: { scene, animations: [] } as unknown as GLTF,
        norm: 1,
        offset: new THREE.Vector3(),
        ref: 1,
      });
    }

    const refHeight = this.fallback.naturalHeight;
    for (const m of this.models.values()) normalize(m, refHeight);
  }

  /**
   * Load a model while the game runs (a Forge boss). Rigid and sized by its
   * largest dimension, since a generated creature can be any shape.
   */
  async loadRuntime(role: string, url: string, entry: Partial<ModelEntry> = {}): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const m: LoadedModel = {
      entry: { file: "runtime.glb", kind: "rigid", yaw: 0, pitch: 0, heightMul: 1, fit: "size", ...entry, lazy: false, selfLit: true },
      gltf,
      norm: 1,
      offset: new THREE.Vector3(),
      ref: 1,
    };
    normalize(m, this.fallback.naturalHeight);
    this.models.set(role, m);
  }

  get naturalHeight(): number {
    return this.fallback.naturalHeight;
  }

  isGenerated(role: string): boolean {
    return this.models.has(role);
  }

  create(role: string): RobotHandle {
    const m = this.models.get(role);
    return m ? createGenerated(m) : this.fallback.create();
  }
}

/** Scale and offset a model into the reference robot's frame (feet or belly on y=0, centered). */
function normalize(m: LoadedModel, refHeight: number): void {
  // Measure in the game's frame, i.e. after the manifest's pitch/yaw.
  const holder = new THREE.Group();
  holder.rotation.set(m.entry.pitch, m.entry.yaw, 0, "YXZ");
  const parent = m.gltf.scene.parent;
  holder.add(m.gltf.scene);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  holder.remove(m.gltf.scene);
  if (parent) parent.add(m.gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const measure = m.entry.fit === "size" ? Math.max(size.x, size.y, size.z) : size.y;
  m.norm = (refHeight / (measure || 1)) * m.entry.heightMul;
  m.ref = refHeight * m.entry.heightMul;
  const c = box.getCenter(new THREE.Vector3());
  // Characters stand on the ground; ships and rocks float centered on the play plane.
  const baseY = m.entry.fit === "size" ? c.y : box.min.y;
  m.offset.set(-c.x * m.norm, -baseY * m.norm, -c.z * m.norm);
}

// ---- Built-in space placeholders -------------------------------------------
// Low-poly shapes so orbit is playable before the Lux3D space cast exists.
// All face +Z like the robot, so WorldView's facing math applies unchanged.

const mat = (color: number, emissive: number, ei = 0.5) =>
  new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: ei, metalness: 0.6, roughness: 0.35, flatShading: true });

function fighter(hull: number, glow: number, wingSpan = 1): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1, 6), mat(hull, glow, 0.25));
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const wings = new THREE.Mesh(new THREE.BoxGeometry(0.95 * wingSpan, 0.05, 0.32), mat(hull, glow, 0.15));
  wings.position.z = -0.18;
  g.add(wings);
  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.08, 8), new THREE.MeshBasicMaterial({ color: glow }));
  engine.rotation.x = Math.PI / 2;
  engine.position.z = -0.52;
  g.add(engine);
  return g;
}

function rock(): THREE.Object3D {
  const geo = new THREE.DodecahedronGeometry(0.5, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.8 + Math.random() * 0.4;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.8, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6f6a78, roughness: 1, flatShading: true }));
}

function capital(): THREE.Object3D {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 1), mat(0x3a3f55, 0xff9a3d, 0.2));
  g.add(hull);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.22), mat(0x4a5068, 0xffb44d, 0.4));
  bridge.position.set(0, 0.16, -0.2);
  g.add(bridge);
  for (const x of [-0.18, 0.18]) {
    for (const z of [0.25, -0.05]) {
      const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.08, 8), mat(0x2a2e40, 0xff5a3d, 0.6));
      turret.position.set(x, 0.12, z);
      g.add(turret);
    }
  }
  const engines = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.05), new THREE.MeshBasicMaterial({ color: 0xffb44d, toneMapped: false }));
  engines.position.z = -0.52;
  g.add(engines);
  return g;
}

const PROCEDURAL: Record<string, () => THREE.Object3D> = {
  "player.ship": () => fighter(0x5d6b82, 0x3fe9ff, 1.1),
  "enemy.interceptor": () => fighter(0x3a2140, 0xff4fd8, 0.8),
  "enemy.kamikaze": () => fighter(0x402a18, 0xff8a2b, 0.5),
  "enemy.bomber": () => fighter(0x2a2448, 0x9d7bff, 1.4),
  "enemy.asteroid": rock,
  "enemy.capital": capital,
};

/** Largest dimension of each placeholder relative to the robot's height. */
const PROCEDURAL_SIZE: Record<string, number> = {
  "player.ship": 1.2,
  "enemy.interceptor": 1,
  "enemy.kamikaze": 0.8,
  "enemy.bomber": 1.1,
  "enemy.asteroid": 1,
  "enemy.capital": 1,
};

function createGenerated(m: LoadedModel): RobotHandle {
  const root = new THREE.Object3D();
  const inner = cloneSkeleton(m.gltf.scene) as THREE.Object3D;
  inner.scale.setScalar(m.norm);
  inner.position.copy(m.offset);
  inner.rotation.set(m.entry.pitch, m.entry.yaw, 0, "YXZ");
  root.add(inner);

  // Per-instance materials so tint and hit-flash stay per robot; textures stay shared.
  const mats: THREE.MeshStandardMaterial[] = [];
  inner.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // skinned bounds come from the bind pose and can cull wrongly
    const src = mesh.material;
    const list = (Array.isArray(src) ? src : [src]).map((mat) => {
      const c = (mat as THREE.Material).clone() as THREE.MeshStandardMaterial;
      if ("emissive" in c && c.emissive) {
        if (m.entry.selfLit && c.map) c.emissiveMap = c.map; // glow in its own colors
        mats.push(c);
      }
      return c;
    });
    mesh.material = Array.isArray(src) ? list : list[0];
  });

  let tint = 0x000000;
  let flashing = false;
  const applyGlow = () => {
    for (const mat of mats) {
      if (m.entry.selfLit) {
        // Self-lit: brighten the texture's own colors; no tier tint.
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = flashing ? 1.4 : 0.55;
        continue;
      }
      mat.emissive.setHex(flashing ? 0xffffff : tint);
      // Keep the accent faint so the Lux3D texture, not the tier color, carries the look.
      mat.emissiveIntensity = flashing ? 0.9 : 0.08;
    }
  };

  const skinned = m.entry.kind === "skinned" && m.gltf.animations.length > 0;
  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<string, THREE.AnimationAction>();
  if (skinned) for (const clip of m.gltf.animations) actions.set(clip.name, mixer.clipAction(clip));
  const deathName = resolveClip(m.entry.clips, "Death");
  const death = deathName ? actions.get(deathName) : undefined;
  if (death) {
    death.setLoop(THREE.LoopOnce, 1);
    death.clampWhenFinished = true;
  }

  let current: THREE.AnimationAction | null = null;
  let currentName: string | null = null;
  let speed = 1;

  // Rigid models: procedural motion instead of clips (bob, sway, topple on death).
  let t = Math.random() * 10;
  let wanted: ClipName = "Idle";
  let topple = 0;

  // Breakable part (Lux3D part split): flung up and away, tumbling, then hidden.
  const part = m.entry.breakPart ? inner.getObjectByName(m.entry.breakPart) ?? null : null;
  const partHome = part ? { p: part.position.clone(), q: part.quaternion.clone() } : null;
  let broken = false;
  let breakT = 0;
  const fly = new THREE.Vector3();
  const spin = new THREE.Vector3();
  const stepPart = (dt: number) => {
    if (!part || !broken || !part.visible) return;
    breakT += dt;
    fly.y -= 1.6 * dt; // gentle arc
    part.position.addScaledVector(fly, dt);
    part.rotation.x += spin.x * dt;
    part.rotation.y += spin.y * dt;
    part.rotation.z += spin.z * dt;
    if (breakT > 1.8) part.visible = false;
  };

  return {
    root,
    mixer,
    play(name: ClipName, fade = 0.25) {
      wanted = name;
      if (!skinned || !GAME_CLIPS.has(name)) return;
      const clipName = resolveClip(m.entry.clips, name as GameClip);
      if (!clipName || currentName === clipName) return;
      const next = actions.get(clipName);
      if (!next) return;
      next.reset().fadeIn(fade).play();
      if (current) current.fadeOut(fade);
      current = next;
      currentName = clipName;
    },
    setTint(hex) {
      tint = hex;
      applyGlow();
    },
    setFlash(on) {
      if (on === flashing) return;
      flashing = on;
      applyGlow();
    },
    setSpeed(mul) {
      speed = mul;
      if (current) current.timeScale = mul;
    },
    setBroken(on) {
      if (!part || !partHome || on === broken) return;
      broken = on;
      breakT = 0;
      if (on) {
        fly.set((Math.random() - 0.5) * 0.8, 1.4, (Math.random() - 0.5) * 0.8);
        spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
      } else {
        part.position.copy(partHome.p);
        part.quaternion.copy(partHome.q);
        part.visible = true;
      }
    },
    update(dt) {
      stepPart(dt);
      if (skinned) {
        mixer.update(dt);
        return;
      }
      t += dt * speed;
      if (m.entry.fit === "size") {
        // Ships and rocks hover; heading and banking come from WorldView.
        inner.position.y = m.offset.y + Math.sin(t * 2.2) * 0.04 * m.ref;
        return;
      }
      const moving = wanted === "Walking" || wanted === "Running";
      const rate = wanted === "Running" ? 14 : moving ? 9 : 3;
      topple = wanted === "Death" ? Math.min(1, topple + dt * 3) : 0;
      inner.position.y = m.offset.y + (moving ? Math.abs(Math.sin(t * rate)) * 0.06 : Math.sin(t * rate) * 0.02) * m.ref;
      inner.rotation.z = Math.sin(t * rate * 0.5) * (moving ? 0.08 : 0.02);
      inner.rotation.x = -topple * (Math.PI / 2);
    },
    dispose() {
      mixer.stopAllAction();
      for (const mat of mats) mat.dispose();
    },
  };
}
