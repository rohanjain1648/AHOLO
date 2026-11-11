/**
 * Scene dressing: renderer, lights, ground/grid, fog, and a selective-bloom
 * post pipeline. Kept separate from gameplay so `World` never touches Three.js.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { edgeProximity } from "../game/arena";
import { WORLD } from "../game/config";

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly sunTarget = new THREE.Object3D();
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  /** Floor and grid: everything that belongs to the surface. */
  private readonly ground = new THREE.Group();
  /** Stars, planet and nebula glow for orbit. */
  private readonly space = new THREE.Group();
  private readonly planet: THREE.Mesh;
  /** Combat-zone frame and light walls; visible on the surface and in orbit. */
  private readonly zone = new THREE.Group();
  private readonly zoneSafe = new THREE.Color(0x4fd8ff);
  private readonly zoneDanger = new THREE.Color(0xff3d4e);
  private readonly zoneTint = new THREE.Color();
  private zoneFrameMat!: THREE.MeshBasicMaterial;
  private zoneWallMat!: THREE.MeshBasicMaterial;
  private zoneGlowMat!: THREE.MeshBasicMaterial;
  private zoneGrid!: THREE.GridHelper;
  private readonly surfaceBg = new THREE.Color(0x05060a);
  private readonly spaceBg = new THREE.Color(0x020109);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.FogExp2(0x05060a, 0.00035);

    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 1, 14000); // far enough for the orbit planet

    // Ambient + a single moving "sun" that casts the only real-time shadow
    // (kept tight around the player so a modest shadow map stays sharp).
    this.scene.add(new THREE.AmbientLight(0x8fb0ff, 0.55));
    const hemi = new THREE.HemisphereLight(0x6fa8ff, 0x0a0510, 0.5);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xbfd8ff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 1600;
    const s = 480;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0015;
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun, this.sunTarget);

    // Two slow-orbiting neon rim lights for atmosphere (cheap: only 2 extra lights).
    this.scene.add(this.makeRimLight(0xff2d8a, 900));
    this.scene.add(this.makeRimLight(0x2de1ff, 900));

    this.buildGround();
    this.buildZone();
    this.scene.add(this.ground);
    this.planet = this.buildSpace();
    this.space.visible = false;
    this.scene.add(this.space);

    // Post: selective bloom — threshold tuned so only emissive/bright bits
    // (bullets, gems, robot eyes, the arena boundary) bloom, not the whole scene.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.5, 0.72);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  private rimClock = 0;
  private rimLights: { light: THREE.PointLight; radius: number; speed: number; phase: number }[] = [];

  private makeRimLight(color: number, radius: number): THREE.PointLight {
    const light = new THREE.PointLight(color, 6, 1400, 2);
    light.position.set(radius, 140, 0);
    this.rimLights.push({ light, radius, speed: 0.12 + Math.random() * 0.05, phase: Math.random() * Math.PI * 2 });
    return light;
  }

  private buildGround(): void {
    const size = WORLD.half * 2.6;
    // Emissive-tinted rather than purely lit: guarantees the floor stays
    // visible regardless of shadow-map/light tuning, which matters a lot
    // here since it's the backdrop for the entire game.
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x141a2c,
      emissive: 0x0b0f1e,
      emissiveIntensity: 0.8,
      roughness: 0.95,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = false;
    this.ground.add(ground);

    const grid = new THREE.GridHelper(WORLD.half * 2, Math.round((WORLD.half * 2) / WORLD.bgGrid), 0x4a9bff, 0x1c3358);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = 0.5;
    this.ground.add(grid);

  }

  /**
   * The combat zone: a square frame, fading light walls and corner pylons that
   * match the real movement limit exactly (the clamp in World is a square of
   * WORLD.half). Unlike the ground it stays visible in orbit, so the edge of the
   * arena is always on screen. A coarse sector grid shows up only in orbit.
   */
  private buildZone(): void {
    const H = WORLD.half;
    const bar = 56; // a wide flat band: visible even from the near-top-down orbit camera
    const frameMat = new THREE.MeshBasicMaterial({ color: this.zoneSafe, toneMapped: false, fog: false });
    const frameGeo = new THREE.BoxGeometry(H * 2 + bar, 6, bar);
    for (const [x, z, rot] of [[0, -H, 0], [0, H, 0], [-H, 0, Math.PI / 2], [H, 0, Math.PI / 2]] as const) {
      const m = new THREE.Mesh(frameGeo, frameMat);
      m.position.set(x, 4, z);
      m.rotation.y = rot;
      this.zone.add(m);
    }

    // Light walls: bright at the floor, fading to nothing 140 units up (additive, so black = invisible).
    const wallH = 140;
    const wallGeo = new THREE.PlaneGeometry(H * 2, wallH);
    const colors = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]); // top verts, then bottom verts
    wallGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const wallMat = new THREE.MeshBasicMaterial({
      color: this.zoneSafe,
      vertexColors: true,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    for (const [x, z, rot] of [[0, -H, 0], [0, H, 0], [-H, 0, Math.PI / 2], [H, 0, Math.PI / 2]] as const) {
      const m = new THREE.Mesh(wallGeo, wallMat);
      m.position.set(x, wallH / 2, z);
      m.rotation.y = rot;
      this.zone.add(m);
    }

    // Inner glow: each edge lights up the floor 320 units inward, so approaching a wall is visible well before the warning.
    const glowW = 320;
    const glowGeo = new THREE.PlaneGeometry(H * 2, glowW);
    glowGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]), 3));
    const glowMat = new THREE.MeshBasicMaterial({
      color: this.zoneSafe, vertexColors: true, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
    });
    for (const [x, z, rot] of [[0, -H + glowW / 2, 0], [0, H - glowW / 2, Math.PI], [-H + glowW / 2, 0, Math.PI / 2], [H - glowW / 2, 0, -Math.PI / 2]] as const) {
      const m = new THREE.Mesh(glowGeo, glowMat);
      m.rotation.x = -Math.PI / 2; // lie flat; its bright edge now points toward -z
      // the holder yaws the strip so that bright edge faces the wall
      const holder = new THREE.Group();
      holder.position.set(x, 3, z);
      holder.rotation.y = rot;
      holder.add(m);
      this.zone.add(holder);
    }
    this.zoneGlowMat = glowMat;

    // Outside the zone is dead space: a dark red veil with a square hole, so "in" and "out" read at a glance.
    const outer = H * 4;
    const shape = new THREE.Shape();
    shape.moveTo(-outer, -outer); shape.lineTo(outer, -outer); shape.lineTo(outer, outer); shape.lineTo(-outer, outer); shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-H, -H); hole.lineTo(-H, H); hole.lineTo(H, H); hole.lineTo(H, -H); hole.closePath();
    shape.holes.push(hole);
    const veil = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: 0x1a0509, transparent: true, opacity: 0.78, depthWrite: false, toneMapped: false, fog: false }),
    );
    veil.rotation.x = -Math.PI / 2;
    veil.position.y = 1.5;
    this.zone.add(veil);

    // Corner pylons so the four corners read from anywhere in the arena.
    const pylonGeo = new THREE.BoxGeometry(26, 260, 26);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Mesh(pylonGeo, frameMat);
        p.position.set(sx * H, 130, sz * H);
        this.zone.add(p);
      }
    }

    // Orbit-only sector grid (400 units a cell) with an origin cross, for a sense of speed and place.
    const cells = Math.round((H * 2) / 400);
    const grid = new THREE.GridHelper(H * 2, cells, 0x7fd8ff, 0x2a6a9a);
    const gm = grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0;
    gm.fog = false;
    gm.depthWrite = false;
    grid.position.y = -2;
    this.zoneGrid = grid;
    this.zone.add(grid);

    this.zoneFrameMat = frameMat;
    this.zoneWallMat = wallMat;
    this.scene.add(this.zone);
  }

  /**
   * Tint the zone by how close the player is to the edge (cyan = safe, red = at the wall),
   * pulse it when close, and fade the sector grid in with the orbit blend `k`.
   * Returns 0..1 edge proximity so the HUD can match.
   */
  updateZone(px: number, py: number, k: number, time: number): number {
    const prox = edgeProximity(px, py);
    this.zoneTint.copy(this.zoneSafe).lerp(this.zoneDanger, prox);
    const pulse = prox > 0 ? 0.65 + 0.35 * Math.sin(time * 12) : 1;
    this.zoneFrameMat.color.copy(this.zoneTint).multiplyScalar(pulse);
    this.zoneWallMat.color.copy(this.zoneTint);
    this.zoneWallMat.opacity = 0.18 + 0.3 * prox * pulse;
    this.zoneGlowMat.color.copy(this.zoneTint);
    this.zoneGlowMat.opacity = 0.3 + 0.35 * prox * pulse;
    (this.zoneGrid.material as THREE.LineBasicMaterial).opacity = 0.6 * k * k;
    return prox;
  }

  /** Orbit backdrop: a deep starfield below and around the play plane, and a planet far beneath. */
  private buildSpace(): THREE.Mesh {
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const span = WORLD.half * 3.2;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * span;
      pos[i * 3 + 1] = -200 - Math.random() * 3000; // below the ships, so they read against stars
      pos[i * 3 + 2] = (Math.random() - 0.5) * span;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xcfe2ff, size: 5, sizeAttenuation: true, toneMapped: false, transparent: true, opacity: 0.9 }),
    );
    this.space.add(stars);

    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(2600, 48, 32),
      new THREE.MeshStandardMaterial({ color: 0x1d2c6b, emissive: 0x2a1650, emissiveIntensity: 0.55, roughness: 0.9 }),
    );
    // Far below and off to one side, so it frames the fight instead of sitting under it.
    planet.position.set(WORLD.half * 2.2, -7000, -WORLD.half * 1.4);
    this.space.add(planet);
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(2740, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x4fb4ff, transparent: true, opacity: 0.12, side: THREE.BackSide, toneMapped: false }),
    );
    planet.add(atmosphere);
    return planet;
  }

  /**
   * 0 = on the surface, 1 = in orbit. In between (launch / descent) the ground
   * drops away beneath the squad and the stars fade in.
   */
  setSpaceBlend(k: number): void {
    this.ground.visible = k < 0.999;
    this.ground.position.y = -k * k * 1600;
    this.space.visible = k > 0.001;
    const starMat = (this.space.children[0] as THREE.Points).material as THREE.PointsMaterial;
    starMat.opacity = 0.9 * Math.min(1, k * 1.5);
    (this.scene.background as THREE.Color).copy(this.surfaceBg).lerp(this.spaceBg, k);
    (this.scene.fog as THREE.FogExp2).density = 0.00035 * (1 - k) + 0.00006 * k;
    this.planet.rotation.y += 0.0004;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.renderer.setPixelRatio(dpr);
  }

  /** Keep the shadow-casting sun locked to a fixed offset above the player. */
  followSun(px: number, py: number): void {
    this.sun.position.set(px + 220, 420, py + 180);
    this.sunTarget.position.set(px, 0, py);
  }

  updateAtmosphere(dt: number, px: number, py: number): void {
    this.rimClock += dt;
    for (const r of this.rimLights) {
      const a = this.rimClock * r.speed + r.phase;
      r.light.position.set(px + Math.cos(a) * r.radius, 160 + Math.sin(a * 1.3) * 60, py + Math.sin(a) * r.radius);
    }
  }

  render(): void {
    this.composer.render();
  }
}
