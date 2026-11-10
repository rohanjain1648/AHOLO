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

    const refHeight = this.fallback.naturalHeight;
    for (const m of this.models.values()) {
      const box = new THREE.Box3().setFromObject(m.gltf.scene);
      const h = box.max.y - box.min.y || 1;
      m.norm = (refHeight / h) * m.entry.heightMul;
      m.ref = refHeight * m.entry.heightMul;
      const c = box.getCenter(new THREE.Vector3());
      m.offset.set(-c.x * m.norm, -box.min.y * m.norm, -c.z * m.norm);
    }
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

function createGenerated(m: LoadedModel): RobotHandle {
  const root = new THREE.Object3D();
  const inner = cloneSkeleton(m.gltf.scene) as THREE.Object3D;
  inner.scale.setScalar(m.norm);
  inner.position.copy(m.offset);
  inner.rotation.y = m.entry.yaw;
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
      if ("emissive" in c && c.emissive) mats.push(c);
      return c;
    });
    mesh.material = Array.isArray(src) ? list : list[0];
  });

  let tint = 0x000000;
  let flashing = false;
  const applyGlow = () => {
    for (const mat of mats) {
      mat.emissive.setHex(flashing ? 0xffffff : tint);
      mat.emissiveIntensity = flashing ? 0.9 : 0.22;
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
    update(dt) {
      if (skinned) {
        mixer.update(dt);
        return;
      }
      t += dt * speed;
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
