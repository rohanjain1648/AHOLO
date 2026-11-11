/**
 * Shatter deaths: a dying enemy's own model (its Lux3D mesh and textures)
 * breaks into chunks that fly apart, spin, and shrink away.
 *
 * Each model is cut once, lazily, into up to 8 pieces by which octant of its
 * bounding box each triangle's centre falls in. Pieces share the model's
 * materials (no per-death clones); they fade by shrinking, not transparency.
 * Skinned models are cut in their bind pose, which reads fine for a 1 s burst.
 */
import * as THREE from "three";

export interface ChunkTemplate {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Piece centre in the body's space: the direction it flies out along. */
  center: THREE.Vector3;
}

/** Octant index (0..cells³-1) of `p` within `box`. */
export function cellOf(p: THREE.Vector3, box: THREE.Box3, cells: number): number {
  const size = box.getSize(new THREE.Vector3());
  const idx = (v: number, min: number, s: number) =>
    Math.min(cells - 1, Math.max(0, Math.floor(((v - min) / (s || 1)) * cells)));
  return idx(p.x, box.min.x, size.x) + cells * (idx(p.y, box.min.y, size.y) + cells * idx(p.z, box.min.z, size.z));
}

/** Cut every mesh under `body` into pieces, with positions baked into `body`'s space. */
export function buildChunkTemplates(body: THREE.Object3D, cells = 2): ChunkTemplate[] {
  body.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  body.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  if (meshes.length === 0) return [];

  // Bounds in body space decide the cut.
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const local = meshes.map((m) => new THREE.Matrix4().multiplyMatrices(toBody, m.matrixWorld));
  meshes.forEach((m, i) => {
    const pos = m.geometry.getAttribute("position");
    for (let k = 0; k < pos.count; k++) box.expandByPoint(v.fromBufferAttribute(pos, k).applyMatrix4(local[i]));
  });

  const out: ChunkTemplate[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  meshes.forEach((m, mi) => {
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const pos = geo.getAttribute("position");
    const nrm = geo.getAttribute("normal");
    const uv = geo.getAttribute("uv");
    const normalMat = new THREE.Matrix3().getNormalMatrix(local[mi]);
    const buckets = new Map<number, { p: number[]; n: number[]; u: number[] }>();
    for (let t = 0; t < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t).applyMatrix4(local[mi]);
      b.fromBufferAttribute(pos, t + 1).applyMatrix4(local[mi]);
      c.fromBufferAttribute(pos, t + 2).applyMatrix4(local[mi]);
      centroid.copy(a).add(b).add(c).divideScalar(3);
      const key = cellOf(centroid, box, cells);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { p: [], n: [], u: [] }));
      for (const [k, p] of [[t, a], [t + 1, b], [t + 2, c]] as [number, THREE.Vector3][]) {
        bucket.p.push(p.x, p.y, p.z);
        if (nrm) {
          v.fromBufferAttribute(nrm, k).applyMatrix3(normalMat).normalize();
          bucket.n.push(v.x, v.y, v.z);
        }
        if (uv) bucket.u.push(uv.getX(k), uv.getY(k));
      }
    }
    const material = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
    for (const bucket of buckets.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(bucket.p, 3));
      if (bucket.n.length) g.setAttribute("normal", new THREE.Float32BufferAttribute(bucket.n, 3));
      if (bucket.u.length) g.setAttribute("uv", new THREE.Float32BufferAttribute(bucket.u, 2));
      g.computeBoundingBox();
      const center = g.boundingBox!.getCenter(new THREE.Vector3());
      g.translate(-center.x, -center.y, -center.z); // pieces spin about their own centre
      out.push({ geometry: g, material, center });
    }
  });
  return out;
}

interface Piece {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  baseScale: THREE.Vector3;
}

interface Burst {
  pieces: Piece[];
  t: number;
  life: number;
}

const MAX_BURSTS = 16;

/** Live shatter bursts in the scene. */
export class Shatters {
  private readonly bursts: Burst[] = [];
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpP = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * Burst `templates` out from the pose `bodyMatrix` (the body's world matrix
   * at death). `power` scales speed and lifetime (bosses use ~2).
   */
  spawn(templates: readonly ChunkTemplate[], bodyMatrix: THREE.Matrix4, power = 1): void {
    if (templates.length === 0) return;
    if (this.bursts.length >= MAX_BURSTS) this.clear(this.bursts.shift()!);
    bodyMatrix.decompose(this.tmpP, this.tmpQ, this.tmpS);
    const pieces: Piece[] = [];
    for (const tpl of templates) {
      const mesh = new THREE.Mesh(tpl.geometry, tpl.material);
      mesh.position.copy(tpl.center).applyMatrix4(bodyMatrix);
      mesh.quaternion.copy(this.tmpQ);
      mesh.scale.copy(this.tmpS);
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      // Outward from the body centre (in world space), plus a kick upward.
      const out = tpl.center.clone().applyQuaternion(this.tmpQ).normalize();
      const speed = (90 + Math.random() * 120) * power;
      const vel = out.multiplyScalar(speed).add(new THREE.Vector3((Math.random() - 0.5) * 60, 120 * power, (Math.random() - 0.5) * 60));
      const spin = new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
      this.scene.add(mesh);
      pieces.push({ mesh, vel, spin, baseScale: this.tmpS.clone() });
    }
    this.bursts.push({ pieces, t: 0, life: 0.9 * Math.sqrt(power) + 0.2 });
  }

  /** `gravity`: world units/s² downward (0 in orbit, where pieces just drift). */
  update(dt: number, gravity: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.t += dt;
      const k = burst.t / burst.life;
      if (k >= 1) {
        this.clear(burst);
        this.bursts.splice(i, 1);
        continue;
      }
      const shrink = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
      for (const p of burst.pieces) {
        p.vel.y -= gravity * dt;
        p.vel.multiplyScalar(Math.exp(-0.8 * dt));
        p.mesh.position.addScaledVector(p.vel, dt);
        if (gravity > 0 && p.mesh.position.y < 0) {
          p.mesh.position.y = 0; // land and skid on the floor
          p.vel.y = Math.abs(p.vel.y) * 0.25;
          p.vel.x *= 0.7;
          p.vel.z *= 0.7;
        }
        p.mesh.rotation.x += p.spin.x * dt;
        p.mesh.rotation.y += p.spin.y * dt;
        p.mesh.rotation.z += p.spin.z * dt;
        p.mesh.scale.copy(p.baseScale).multiplyScalar(Math.max(0.001, shrink));
      }
    }
  }

  private clear(burst: Burst): void {
    for (const p of burst.pieces) this.scene.remove(p.mesh);
  }
}
