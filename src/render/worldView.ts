/**
 * Syncs World's plain-data pools onto Three.js objects every frame. This is
 * the only place that knows both "gameplay data shape" and "Three.js scene
 * graph" — World stays renderer-agnostic, and everything here is read-only
 * with respect to gameplay state.
 */
import * as THREE from "three";
import { clamp } from "../core/math";
import { COOP, PALETTE } from "../game/config";
import type { Player } from "../game/player";
import type { World } from "../game/world";
import type { RobotHandle } from "./robots";
import type { ModelLibrary } from "./modelLibrary";
import { PLAYER_ROLE, roleForEnemy, SHIP_ROLE } from "./manifest";
import { spaceBlend } from "../game/phaseBlend";
import { createFxPools, RingPool, type FxPools } from "./fx";

const hexToNum = (s: string): number => parseInt(s.replace("#", ""), 16);

// Robots face +Z at rotation.y = 0 in this asset; tune if that's ever wrong.
const FORWARD_OFFSET = Math.PI / 2;

export interface FloatLabel {
  x: number;
  y: number;
  z: number;
  text: string;
  color: string;
  alpha: number;
  size: number;
}

const ORBITALS_PER_PLAYER = 8;

/** Per-slot visuals for one player robot. */
interface PlayerVisual {
  robot: RobotHandle;
  /** The fighter this robot flies in orbit. */
  ship: RobotHandle;
  /** Smoothed bank angle and last heading, for rolling the ship into turns. */
  roll: number;
  lastFacing: number;
  orbitals: THREE.Mesh[];
  /** Faint full ring + a bright arc whose draw range grows with revive progress. */
  reviveBg: THREE.Mesh;
  reviveArc: THREE.Mesh;
}

/** One enemy pool slot's model. Slots get reused by other enemy kinds, so the model can swap. */
interface EnemySlot {
  role: string;
  h: RobotHandle;
}

export class WorldView {
  private readonly playerVisuals: PlayerVisual[] = [];
  private readonly enemySlots: (EnemySlot | null)[] = [];
  /** Idle model instances per role, reused when an enemy slot changes kind. */
  private readonly spare = new Map<string, RobotHandle[]>();
  private readonly pingBeams: THREE.Mesh[] = [];
  private pickupRing!: THREE.Mesh;
  private novaRings!: RingPool;
  private fx!: FxPools;
  /** Recomputed each sync(); read by the HUD overlay to draw floating combat text in screen space. */
  readonly floatLabels: FloatLabel[] = [];
  /** World-space scale applied to every robot instance; calibrated once the model loads. */
  robotBaseScale = 60;
  /** Model role of the current Forge boss, once loaded; forged bosses use it. */
  forgeRole: string | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly factory: ModelLibrary,
  ) {
    for (let slot = 0; slot < COOP.maxPlayers; slot++) this.playerVisuals.push(this.createPlayerVisual(slot));

    // Ping beams: at most one live ping per player per cooldown window.
    for (let i = 0; i < COOP.maxPlayers * 2; i++) {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(6, 6, 260, 12, 1, true),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, toneMapped: false, depthWrite: false }),
      );
      beam.visible = false;
      scene.add(beam);
      this.pingBeams.push(beam);
    }

    const ringGeo = new THREE.RingGeometry(1, 1.04, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: hexToNum(PALETTE.player),
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.pickupRing = new THREE.Mesh(ringGeo, ringMat);
    this.pickupRing.rotation.x = -Math.PI / 2;
    this.pickupRing.position.y = 1;
    scene.add(this.pickupRing);

    this.novaRings = new RingPool(scene, hexToNum(PALETTE.nova));
    this.fx = createFxPools(scene, {
      bullet: hexToNum(PALETTE.bullet),
      enemyBullet: hexToNum(PALETTE.enemyBullet),
      xp: hexToNum(PALETTE.xp),
      heal: hexToNum(PALETTE.heal),
      danger: hexToNum(PALETTE.danger),
    });
  }

  private createPlayerVisual(slot: number): PlayerVisual {
    const color = hexToNum(COOP.slotColors[slot]);
    const robot = this.factory.create(PLAYER_ROLE);
    robot.setTint(color);
    robot.root.castShadow = true;
    robot.root.visible = false;
    this.scene.add(robot.root);
    const ship = this.factory.create(SHIP_ROLE);
    ship.setTint(color);
    ship.root.visible = false;
    this.scene.add(ship.root);

    const orbitals: THREE.Mesh[] = [];
    for (let i = 0; i < ORBITALS_PER_PLAYER; i++) {
      const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(9, 0),
        new THREE.MeshStandardMaterial({
          color: hexToNum(PALETTE.orbital),
          emissive: hexToNum(PALETTE.orbital),
          emissiveIntensity: 1.4,
          toneMapped: false,
        }),
      );
      mesh.visible = false;
      this.scene.add(mesh);
      orbitals.push(mesh);
    }

    const flatRing = (opacity: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(COOP.reviveRange - 6, COOP.reviveRange, 64, 1, -Math.PI / 2, Math.PI * 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, toneMapped: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 2;
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    return { robot, ship, roll: 0, lastFacing: 0, orbitals, reviveBg: flatRing(0.18), reviveArc: flatRing(0.9) };
  }

  /** Call once the GLB has loaded to size robots sensibly relative to the arena. */
  calibrateScale(desiredPlayerHeight: number): void {
    const natural = this.factory.naturalHeight;
    this.robotBaseScale = natural > 0 ? desiredPlayerHeight / natural : this.robotBaseScale;
  }

  /** The model for enemy slot i, swapped to the right role's model if the slot changed kind. */
  private enemyModel(i: number, role: string): RobotHandle {
    const cur = this.enemySlots[i];
    if (cur && cur.role === role) return cur.h;
    if (cur) {
      cur.h.root.visible = false;
      let list = this.spare.get(cur.role);
      if (!list) this.spare.set(cur.role, (list = []));
      list.push(cur.h);
    }
    let h = this.spare.get(role)?.pop();
    if (!h) {
      h = this.factory.create(role);
      h.root.visible = false;
      h.root.castShadow = true;
      this.scene.add(h.root);
    }
    this.enemySlots[i] = { role, h };
    return h;
  }

  sync(world: World, dt: number): void {
    this.floatLabels.length = 0;
    const p = world.player;

    // --- Players --------------------------------------------------------
    for (let slot = 0; slot < this.playerVisuals.length; slot++) {
      this.syncPlayer(world, this.playerVisuals[slot], world.players[slot], slot === world.localSlot, dt);
    }

    // Pickup radius ring is only drawn for your own robot, mid-run.
    this.pickupRing.visible = !world.gameOver && !p.downed;
    this.pickupRing.position.x = p.x;
    this.pickupRing.position.z = p.y;
    this.pickupRing.scale.setScalar(p.pickupRadius);

    // --- Pings ----------------------------------------------------------
    for (let i = 0; i < this.pingBeams.length; i++) {
      const beam = this.pingBeams[i];
      const ping = world.pings[i];
      beam.visible = !!ping;
      if (!ping) continue;
      beam.position.set(ping.x, 130, ping.y);
      const mat = beam.material as THREE.MeshBasicMaterial;
      mat.color.setHex(hexToNum(COOP.slotColors[ping.slot] ?? PALETTE.player));
      mat.opacity = 0.55 * clamp(ping.life / COOP.pingLifeSec, 0, 1);
    }

    // --- Enemies --------------------------------------------------------
    for (let i = 0; i < world.enemies.length; i++) {
      const e = world.enemies[i];
      if (e.dead) {
        const slot = this.enemySlots[i];
        if (slot) slot.h.root.visible = false;
        continue;
      }
      const h = this.enemyModel(i, e.forged && this.forgeRole ? this.forgeRole : roleForEnemy(e.kind));
      h.root.visible = true;
      h.root.position.set(e.x, 0, e.y);
      if (e.kind === "asteroid") {
        // Rocks tumble along their drift instead of turning to face anyone.
        h.root.rotation.y += dt * (0.4 + (i % 5) * 0.15);
        h.root.rotation.x += dt * 0.25;
      } else {
        const target = nearestActive(world.players, e.x, e.y) ?? p;
        const angle = Math.atan2(target.y - e.y, target.x - e.x);
        h.root.rotation.y = FORWARD_OFFSET - angle;
      }

      const spawnIn = e.spawnT < 0.4;
      const spawnScale = spawnIn ? clamp(e.spawnT / 0.4, 0.15, 1) : 1;
      h.root.scale.setScalar(this.robotBaseScale * e.modelScale * spawnScale);

      h.play(spawnIn ? "Idle" : e.anim, 0.2);
      h.setSpeed(spawnIn ? 1 : e.animSpeed);
      h.setTint(hexToNum(e.color));
      h.setFlash(e.flash > 0);
      h.update(dt);
    }

    this.syncFx(world);
  }

  private syncPlayer(world: World, v: PlayerVisual, p: Player | undefined, isLocal: boolean, dt: number): void {
    const shown = !!p && p.active;
    // Robot on the ground, fighter in orbit; the swap happens halfway through launch/descent.
    const k = spaceBlend(world.phase, world.phaseT);
    const inShip = k >= 0.5;
    v.robot.root.visible = shown && !inShip;
    v.ship.root.visible = shown && inShip;
    v.reviveBg.visible = v.reviveArc.visible = shown && p.downed && !world.gameOver;
    if (!shown) {
      for (const o of v.orbitals) o.visible = false;
      return;
    }

    const transition = world.phase === "launch" || world.phase === "descent";
    const altitude = Math.sin(Math.PI * k) * 70; // a little lift-off during the flight up / down
    const blinking = !transition && p.invuln > 0 && Math.floor(world.time * 20) % 2 === 0;
    const r = inShip ? v.ship : v.robot;
    r.root.position.set(p.x, altitude, p.y);
    r.root.rotation.y = FORWARD_OFFSET - p.facing;
    r.root.scale.setScalar(this.robotBaseScale);

    if (inShip) {
      // Bank into turns: roll follows the rate of heading change.
      let turn = p.facing - v.lastFacing;
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      const target = clamp((turn / Math.max(dt, 1e-3)) * 0.12, -0.7, 0.7);
      v.roll += (target - v.roll) * Math.min(1, dt * 6);
      r.root.rotation.z = p.downed ? 1.2 : v.roll;
      r.root.visible = !blinking;
      r.play(Math.hypot(p.vx, p.vy) > 30 ? "Running" : "Idle");
    } else if (world.gameOver || p.downed) {
      r.play("Death", 0.2);
    } else {
      const moving = Math.hypot(p.vx, p.vy) > 12;
      r.play(moving ? "Running" : "Idle", 0.15);
      r.setSpeed(moving ? 1.15 : 1);
      r.root.visible = !blinking;
    }
    v.lastFacing = p.facing;
    r.update(dt);

    if (p.downed) {
      for (const ring of [v.reviveBg, v.reviveArc]) ring.position.set(p.x, 2, p.y);
      // RingGeometry with one radial segment indexes 6 per angular segment.
      const total = v.reviveArc.geometry.index!.count;
      v.reviveArc.geometry.setDrawRange(0, Math.floor((total / 6) * clamp(p.reviveT, 0, 1)) * 6);
    }

    // Orbitals only make sense mid-run.
    const orbitalCount = world.gameOver || p.downed ? 0 : p.orbitalCount;
    for (let i = 0; i < v.orbitals.length; i++) {
      const o = v.orbitals[i];
      if (i < orbitalCount) {
        const a = p.orbitAngle + (i / orbitalCount) * Math.PI * 2;
        o.visible = true;
        o.position.set(p.x + Math.cos(a) * p.orbitalRadius, 26, p.y + Math.sin(a) * p.orbitalRadius);
        o.rotation.y += dt * 4;
      } else {
        o.visible = false;
      }
    }

    // Teammates get a name tag (yours would just cover your robot).
    if (!isLocal && world.players.length > 1) {
      this.floatLabels.push({
        x: p.x,
        y: 150,
        z: p.y,
        text: p.downed ? `${p.name} · DOWN` : p.name,
        color: COOP.slotColors[p.slot] ?? PALETTE.player,
        alpha: 0.95,
        size: 14,
      });
    }
  }

  private syncFx(world: World): void {
    const fx = this.fx;
    let i = 0;
    for (; i < world.bullets.length; i++) {
      const b = world.bullets[i];
      if (b.dead) fx.bullets.hide(i);
      else fx.bullets.set(i, b.x, 18, b.y, b.radius * 1.3);
    }
    fx.bullets.hideFrom(world.bullets.length);
    fx.bullets.finish();

    for (i = 0; i < world.enemyBullets.length; i++) {
      const b = world.enemyBullets[i];
      if (b.dead) fx.enemyBullets.hide(i);
      else fx.enemyBullets.set(i, b.x, 20, b.y, b.radius * 1.2);
    }
    fx.enemyBullets.hideFrom(world.enemyBullets.length);
    fx.enemyBullets.finish();

    // Gems are split across two fixed-color pools (xp/heal), so each pool
    // gets its own compact index sequence rather than sharing world.gems'
    // indices directly.
    let xpI = 0;
    let healI = 0;
    for (i = 0; i < world.gems.length; i++) {
      const g = world.gems[i];
      if (g.dead) continue;
      const bob = 14 + Math.sin(world.time * 6 + g.x) * 4;
      if (g.kind === "heal") fx.gemsHeal.set(healI++, g.x, bob, g.y, g.radius * 1.1);
      else fx.gemsXp.set(xpI++, g.x, bob, g.y, g.radius * 1.1);
    }
    fx.gemsXp.hideFrom(xpI);
    fx.gemsHeal.hideFrom(healI);
    fx.gemsXp.finish();
    fx.gemsHeal.finish();

    // Same reassignment trick for particles: danger-red hurt sparks vs
    // everything else (hit/kill flashes), each into their own fixed-color pool.
    let sparkI = 0;
    let hurtI = 0;
    const items = world.particles.items;
    for (i = 0; i < items.length; i++) {
      const pt = items[i];
      if (pt.dead) continue;
      const a = clamp(pt.life / pt.maxLife, 0, 1);
      const scale = pt.size * a * 0.9;
      if (pt.color === PALETTE.danger) fx.hurtSparks.set(hurtI++, pt.x, 16, pt.y, scale);
      else fx.sparks.set(sparkI++, pt.x, 16, pt.y, scale);
    }
    fx.sparks.hideFrom(sparkI);
    fx.hurtSparks.hideFrom(hurtI);
    fx.sparks.finish();
    fx.hurtSparks.finish();

    this.novaRings.sync(world.novaRings);

    const texts = world.particles.texts;
    for (let t = 0; t < texts.length; t++) {
      const ft = texts[t];
      if (ft.dead) continue;
      this.floatLabels.push({
        x: ft.x,
        y: 40,
        z: ft.y,
        text: ft.text,
        color: ft.color,
        alpha: clamp(ft.life / ft.maxLife, 0, 1),
        size: ft.size,
      });
    }
  }
}

/** Nearest active, not-downed player — the one an enemy is chasing. */
function nearestActive(players: readonly Player[], x: number, y: number): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const p of players) {
    if (!p.active || p.downed) continue;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
