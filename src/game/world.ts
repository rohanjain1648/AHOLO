import { SpatialGrid } from "../core/grid";
import { angleTo, clamp, dist, dist2, len, RNG, TAU } from "../core/math";
import type { Audio } from "../core/audio";
import { BOSS_INTRO_SECONDS, COOP, DIRECTOR, isBossKind, PALETTE, PHASES, PLAYER, SPACE, WORLD, xpForLevel } from "./config";
import type { EnemyKind, Phase } from "./config";
import { ARCHETYPES, isArchetypeId, type ArchetypeId } from "./archetypes";
import { bounceOffWall } from "./arena";
import { applyEffect, type Effect, type HapticKind } from "./effects";
import { chooseKind, Director, initEnemy, ringPoint, shooterConfig } from "./enemies";
import { Particles } from "./particles";
import { Player } from "./player";
import { rollUpgrades, upgradeLabel, type Upgrade } from "./upgrades";
import { IDLE_INPUT, type Bullet, type Enemy, type EnemyBullet, type Gem, type PlayerInput } from "./types";

export interface NovaRing {
  x: number;
  y: number;
  r: number;
  maxR: number;
  life: number;
  dead: boolean;
}

export interface RunStats {
  time: number;
  kills: number;
  level: number;
}

export interface Ping {
  slot: number;
  x: number;
  y: number;
  life: number;
}

export interface SlotInfo {
  slot: number;
  name: string;
  /** Robot class (app players). Website players have none and keep the plain stats. */
  archetype?: ArchetypeId;
}

/**
 * Pure simulation — no rendering, no camera. Owns every entity in pooled
 * arrays and advances the world by one deterministic fixed step in `update`.
 * A separate renderer (see src/render/) reads these arrays each frame; World
 * has no idea whether it's being drawn in 2D or 3D.
 *
 * `traumaPulse` replaces the old camera's built-in shake: World just reports
 * "how much impact happened this step," and whatever camera is in use decides
 * how to turn that into a shake.
 *
 * Players live in `players`, indexed by co-op slot. Solo is simply a single
 * slot-0 player, and every co-op multiplier collapses to 1 for it.
 */
export class World {
  readonly particles = new Particles();
  private readonly grid = new SpatialGrid<Enemy>(WORLD.gridCell);
  private readonly rng = new RNG();
  private readonly director = new Director();

  players: Player[] = [World.makePlayer({ slot: 0, name: "YOU" })];
  enemies: Enemy[] = [];
  bullets: Bullet[] = [];
  enemyBullets: EnemyBullet[] = [];
  gems: Gem[] = [];
  readonly novaRings: NovaRing[] = [];
  readonly pings: Ping[] = [];

  time = 0;
  /** Where the run is: fighting on the ground, flying up, in orbit, or dropping back down. */
  phase: Phase = "surface";
  /** Seconds since the current phase began. */
  phaseT = 0;
  /** Completed surface -> orbit -> surface loops; each one toughens the swarm. */
  loop = 0;
  kills = 0;
  level = 1;
  xp = 0;
  xpToNext = xpForLevel(1);
  pendingLevelUps = 0;
  gameOver = false;
  private boss: Enemy | null = null;
  flashT = 0; // full-screen flash intensity (level up / boss / death), read by the HUD overlay
  flashColor = "255,255,255";
  /** Co-op client: the boss bar comes from the host's snapshot, not a local boss. */
  bossHpOverride: number | null = null;
  /** The player's Forge prompt once its model has loaded; the next boss wears it. Survives restarts. */
  forgeName: string | null = null;

  /** Watching without a robot: `localSlot` is just whoever the camera follows. */
  spectating = false;
  /** Which player's screen this World drives (effects targeted elsewhere are skipped). */
  localSlot = 0;
  /** App only: vibrate for this player's own hits, level-ups and going down. */
  onHaptic: ((kind: HapticKind) => void) | null = null;
  /** Host only: also buffer every emitted effect so it can be sent to clients. */
  recordEffects = false;
  private effectBuf: Effect[] = [];

  /** Spawn-ring radius around the player; the renderer sets this from its camera's visible extent. */
  private viewRadius = 900;
  private trauma = 0;

  constructor(private readonly audio: Audio) {}

  private static makePlayer(info: SlotInfo, active = true): Player {
    const p = new Player();
    p.slot = info.slot;
    p.name = info.name;
    p.active = active;
    if (isArchetypeId(info.archetype)) ARCHETYPES[info.archetype].apply(p);
    return p;
  }

  /** The player whose screen this is (camera, HUD, level-up cards). */
  get player(): Player {
    return this.players[this.localSlot] ?? this.players[0];
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.players) if (p.active) n++;
    return n;
  }

  private isLiving(p: Player): boolean {
    return p.active && !p.downed;
  }

  setViewRadius(r: number): void {
    this.viewRadius = r;
  }

  /** Read + reset the accumulated screen-shake impulse for this frame. */
  consumeTrauma(): number {
    const t = this.trauma;
    this.trauma = 0;
    return t;
  }

  addTrauma(v: number): void {
    this.trauma = Math.max(this.trauma, v);
  }

  /** Apply an effect to this World's screen/speakers (clients call this for replayed host effects). */
  applyEffect(ev: Effect): void {
    applyEffect(this, this.audio, ev, this.localSlot);
  }

  /** Return and clear the effects recorded since the last drain. */
  drainEffects(): Effect[] {
    const out = this.effectBuf;
    this.effectBuf = [];
    return out;
  }

  private emit(ev: Effect): void {
    this.applyEffect(ev);
    if (this.recordEffects) this.effectBuf.push(ev);
  }

  /**
   * Start a fresh run. `slots` lists the players taking part (solo: just slot
   * 0); gaps in slot numbers become inactive placeholders so `players[slot]`
   * always indexes by slot.
   */
  reset(slots: SlotInfo[] = [{ slot: 0, name: "YOU" }]): void {
    const size = Math.max(...slots.map((s) => s.slot)) + 1;
    this.players = [];
    for (let i = 0; i < size; i++) {
      const info = slots.find((s) => s.slot === i);
      this.players.push(World.makePlayer(info ?? { slot: i, name: "" }, !!info));
    }
    // Co-op squads start in a small circle around the origin; solo stays at (0,0).
    if (slots.length > 1) {
      slots.forEach((s, k) => {
        const a = (k / slots.length) * TAU;
        this.players[s.slot].x = Math.cos(a) * 50;
        this.players[s.slot].y = Math.sin(a) * 50;
      });
    }
    for (const e of this.enemies) e.dead = true;
    for (const b of this.bullets) b.dead = true;
    for (const b of this.enemyBullets) b.dead = true;
    for (const g of this.gems) g.dead = true;
    this.novaRings.length = 0;
    this.pings.length = 0;
    this.particles.reset();
    this.director.reset("land");
    this.phase = "surface";
    this.phaseT = 0;
    this.loop = 0;
    this.time = 0;
    this.kills = 0;
    this.level = 1;
    this.xp = 0;
    this.xpToNext = xpForLevel(1);
    this.pendingLevelUps = 0;
    this.gameOver = false;
    this.boss = null;
    this.flashT = 0;
    this.trauma = 0;
    this.effectBuf = [];
    this.bossHpOverride = null;
  }

  // ---- Pool helpers -------------------------------------------------------
  private acquireEnemy(): Enemy {
    for (let i = 0; i < this.enemies.length; i++) if (this.enemies[i].dead) return this.enemies[i];
    const e: Enemy = {
      x: 0, y: 0, vx: 0, vy: 0, radius: 10, hp: 1, maxHp: 1, speed: 0,
      touchDamage: 0, xp: 0, kind: "grunt", color: "#fff",
      modelScale: 1, anim: "Idle", animSpeed: 1,
      dead: true, flash: 0, kbx: 0, kby: 0, shootCd: 0,
      isBoss: false, spawnT: 0, punchT: 0,
    };
    this.enemies.push(e);
    return e;
  }

  private acquireBullet(): Bullet {
    for (let i = 0; i < this.bullets.length; i++) if (this.bullets[i].dead) return this.bullets[i];
    const b: Bullet = {
      x: 0, y: 0, vx: 0, vy: 0, radius: 5, damage: 0, pierce: 0,
      life: 0, dead: true, crit: false, hitCd: 0, owner: 0,
    };
    this.bullets.push(b);
    return b;
  }

  private acquireEnemyBullet(): EnemyBullet {
    for (let i = 0; i < this.enemyBullets.length; i++) if (this.enemyBullets[i].dead) return this.enemyBullets[i];
    const b: EnemyBullet = { x: 0, y: 0, vx: 0, vy: 0, radius: 7, damage: 0, life: 0, dead: true };
    this.enemyBullets.push(b);
    return b;
  }

  private acquireGem(): Gem {
    for (let i = 0; i < this.gems.length; i++) if (this.gems[i].dead) return this.gems[i];
    const g: Gem = { x: 0, y: 0, vx: 0, vy: 0, radius: 7, value: 0, dead: true, magnet: false, kind: "xp" };
    this.gems.push(g);
    return g;
  }

  /**
   * The clock enemy strength and spawn rate follow. On the surface it's run time. In orbit it restarts
   * near the 1:15 mark and climbs with time in orbit (never past run time), so launching at 5:00 doesn't
   * throw a 5:00-strength fleet at a fresh ship. Later loops are toughened by `hpMul` instead.
   */
  get difficultyT(): number {
    return this.phase === "orbit" ? Math.min(this.time, PHASES.orbitStartDifficulty + this.phaseT) : this.time;
  }

  /** Enemy HP multiplier for the current squad size (1 in solo) and completed loops. */
  private get hpMul(): number {
    return (1 + COOP.hpPerExtra * (this.activeCount - 1)) * PHASES.loopHpMul ** this.loop;
  }

  /** Spawn one enemy now. Public for the crowd/Forge features and tests. */
  spawnEnemy(kind: EnemyKind, x: number, y: number): Enemy {
    const e = this.acquireEnemy();
    initEnemy(e, kind, x, y, this.difficultyT, this.hpMul);
    if (kind === "asteroid") {
      // Rocks don't chase: they cross the field in a straight line, roughly toward the squad.
      const p = this.nearestLiving(x, y) ?? this.player;
      const a = angleTo(x, y, p.x, p.y) + (this.rng.next() - 0.5) * 1.2;
      e.vx = Math.cos(a) * e.speed;
      e.vy = Math.sin(a) * e.speed;
    }
    e.forged = isBossKind(kind) && this.forgeName !== null;
    e.enraged = false;
    if (isBossKind(kind)) {
      this.boss = e;
      // The camera swoops to the boss for its intro: nobody gets hit while looking away.
      for (const p of this.players) if (p.active) p.invuln = Math.max(p.invuln, BOSS_INTRO_SECONDS);
      this.emit({ k: "sfx", n: "bossWarn", slot: -1 });
      this.emit({ k: "flash", color: "255,200,90", i: 0.7, slot: -1 });
      this.emit({ k: "trauma", v: 0.6, slot: -1 });
    }
    return e;
  }

  private spawnEnemyAt = (kind: EnemyKind, x: number, y: number): void => {
    this.spawnEnemy(kind, x, y);
  };

  /**
   * Enter a phase. Launch and descent wipe the field (no XP for the wiped
   * enemies; dropped gems are banked during the flight) and freeze the squad.
   */
  setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseT = 0;
    if (phase === "launch" || phase === "descent") {
      for (const e of this.enemies) {
        if (e.dead) continue;
        this.emit({ k: "spark", x: e.x, y: e.y, color: e.color, count: 8, speed: 300, size: 3 });
        e.dead = true;
      }
      for (const b of this.enemyBullets) b.dead = true;
      this.boss = null;
      this.director.bossActive = false;
      for (const p of this.players) p.vx = p.vy = 0;
      this.emit({ k: "sfx", n: "bossWarn", slot: -1 });
      this.emit({ k: "flash", color: phase === "launch" ? "140,200,255" : "255,170,110", i: 0.6, slot: -1 });
      this.emit({ k: "trauma", v: 0.5, slot: -1 });
    } else {
      this.director.reset(phase === "orbit" ? "space" : "land");
    }
  }

  /** Launch / descent: nobody moves or gets hurt; gems fly home; then the next phase starts. */
  private stepTransition(dt: number): void {
    this.phaseT += dt;
    for (const p of this.players) {
      if (!p.active) continue;
      p.vx = p.vy = 0;
      p.invuln = Math.max(p.invuln, 0.6);
    }
    const banker = this.players.find((p) => this.isLiving(p)) ?? this.player;
    for (const g of this.gems) {
      if (g.dead) continue;
      g.dead = true;
      if (g.kind === "xp") this.addXp(g.value * banker.xpMul);
    }
    const duration = this.phase === "launch" ? PHASES.launchSeconds : PHASES.descentSeconds;
    if (this.phaseT < duration) return;
    if (this.phase === "launch") {
      this.setPhase("orbit");
    } else {
      this.loop++;
      this.setPhase("surface");
    }
  }

  private aliveEnemyCount(): number {
    let n = 0;
    for (let i = 0; i < this.enemies.length; i++) if (!this.enemies[i].dead) n++;
    return n;
  }

  flash(color: string, intensity: number): void {
    this.flashColor = color;
    this.flashT = Math.max(this.flashT, intensity);
  }

  /** Nearest living player to (x, y), or null when everyone is down. */
  private nearestLiving(x: number, y: number): Player | null {
    let best: Player | null = null;
    let bestD = Infinity;
    for (const p of this.players) {
      if (!this.isLiving(p)) continue;
      const d = dist2(x, y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // ---- Simulation ---------------------------------------------------------
  update(dt: number, inputs: readonly PlayerInput[]): void {
    if (this.gameOver) return;
    this.time += dt;
    if (this.phase === "launch" || this.phase === "descent") {
      this.stepTransition(dt);
      this.tickCosmetics(dt);
      return;
    }
    this.phaseT += dt;

    for (const p of this.players) {
      if (this.isLiving(p) && !p.remote) this.stepPlayerMovement(p, inputs[p.slot] ?? IDLE_INPUT, dt);
    }
    this.updateEnemies(dt);
    this.grid.rebuild(this.enemies);

    for (const p of this.players) {
      if (!this.isLiving(p)) continue;
      const firing = p.remote ? p.remoteFiring : (inputs[p.slot] ?? IDLE_INPUT).firing;
      this.fireWeapons(p, dt, firing);
    }
    this.updateBullets(dt);
    this.updateEnemyBullets(dt);
    this.contactDamage();
    this.updateGems(dt);
    this.updateNovaRings(dt);

    // Player timers
    for (const p of this.players) {
      if (!p.active) continue;
      if (p.invuln > 0) p.invuln -= dt;
      if (p.hurtFlash > 0) p.hurtFlash = Math.max(0, p.hurtFlash - dt * 3);
      if (p.recoilT > 0) p.recoilT = Math.max(0, p.recoilT - dt * 4);
      if (p.pingCd > 0) p.pingCd -= dt;
      if (!p.downed && p.regen > 0 && p.hp < p.maxHp) {
        p.regenFrac += p.regen * dt;
        if (p.regenFrac >= 1) {
          const add = Math.floor(p.regenFrac);
          p.hp = Math.min(p.maxHp, p.hp + add);
          p.regenFrac -= add;
        }
      }
    }
    this.updateRevives(dt);
    this.updatePings(dt);

    // A boss kill earlier in this step may have started a launch/descent: no new waves then.
    if (this.phase === "surface" || this.phase === "orbit") {
      const centre = this.spawnCentre();
      this.director.update(
        dt, this.difficultyT, centre.x, centre.y, this.viewRadius, this.aliveEnemyCount(), this.rng, this.spawnEnemyAt,
        1 + COOP.spawnPerExtra * (this.activeCount - 1),
      );
    }
    this.tickCosmetics(dt);

    for (const p of this.players) if (this.isLiving(p) && p.hp <= 0) this.down(p);
    if (!this.players.some((p) => this.isLiving(p))) this.gameOver = true;
  }

  /** A living player to ring spawns around (random in co-op so nobody escapes pressure). */
  private spawnCentre(): Player {
    const living = this.players.filter((p) => this.isLiving(p));
    if (living.length === 0) return this.player;
    if (living.length === 1) return living[0];
    return living[Math.floor(this.rng.next() * living.length)];
  }

  /**
   * Move one player from their controls and turn them to face aim/movement.
   * Public so a co-op client can predict its own robot with the exact same
   * code the host runs.
   */
  stepPlayerMovement(p: Player, input: PlayerInput, dt: number): void {
    if (this.phase === "launch" || this.phase === "descent") return;
    if (p.dashCd > 0) p.dashCd -= dt;
    if (input.dash && p.dashCd <= 0 && p.dashT <= 0) this.startDash(p, input);
    if (p.dashT > 0) {
      // Dashing: a straight burst that ignores steering and the speed cap.
      p.dashT -= dt;
      p.vx = p.dashVx;
      p.vy = p.dashVy;
      this.emit({ k: "spark", x: p.x, y: p.y, color: PALETTE.player, count: 2, speed: 60, size: 3 });
      if (p.dashT <= 0) {
        p.dashT = 0;
        p.vx *= 0.4; // bleed off the burst so you don't skid across the arena
        p.vy *= 0.4;
      }
      this.integratePlayer(p, dt);
      return;
    }
    if (this.phase === "orbit") {
      // Ship: thrust adds velocity, a little drag bleeds it off, so you drift and slide.
      const max = p.speed * SPACE.speedMul;
      p.vx += input.moveX * SPACE.thrust * dt;
      p.vy += input.moveY * SPACE.thrust * dt;
      const keep = Math.exp(-SPACE.drag * dt);
      p.vx *= keep;
      p.vy *= keep;
      const sp = len(p.vx, p.vy);
      if (sp > max) {
        p.vx = (p.vx / sp) * max;
        p.vy = (p.vy / sp) * max;
      }
    } else {
      const targetVx = input.moveX * p.speed;
      const targetVy = input.moveY * p.speed;
      // Snappy but not instant — small accel for weightiness.
      p.vx += (targetVx - p.vx) * Math.min(1, dt * 16);
      p.vy += (targetVy - p.vy) * Math.min(1, dt * 16);
    }
    this.integratePlayer(p, dt);

    // Twin-input control: keys move the robot; the held cursor only turns it
    // and fires — it never moves it. Aim wins over movement for facing, and
    // with no input at all the robot holds heading and stays silent. Touch
    // drag (mobile, single input) both moves and fires.
    if (input.aimActive) {
      p.facing = Math.atan2(input.aimY, input.aimX);
    } else if (input.moveX !== 0 || input.moveY !== 0) {
      p.facing = Math.atan2(input.moveY, input.moveX);
    } else if (this.phase === "orbit" && len(p.vx, p.vy) > 40) {
      p.facing = Math.atan2(p.vy, p.vx); // a coasting ship points where it drifts
    }
  }

  private integratePlayer(p: Player, dt: number): void {
    const nx = p.x + p.vx * dt;
    const ny = p.y + p.vy * dt;
    if (this.phase === "orbit" && p.dashT <= 0) {
      // A drifting ship bounces off the light wall instead of sticking to it.
      const b = bounceOffWall(nx, ny, p.vx, p.vy);
      p.x = b.x;
      p.y = b.y;
      p.vx = b.vx;
      p.vy = b.vy;
      return;
    }
    // Hitting the arena edge kills that axis of velocity.
    if (Math.abs(nx) > WORLD.half) p.vx = 0;
    if (Math.abs(ny) > WORLD.half) p.vy = 0;
    p.x = clamp(nx, -WORLD.half, WORLD.half);
    p.y = clamp(ny, -WORLD.half, WORLD.half);
  }

  /** Begin a dash along the move direction (or where the robot faces), invulnerable for its length. */
  private startDash(p: Player, input: PlayerInput): void {
    const l = len(input.moveX, input.moveY);
    const dx = l > 0.01 ? input.moveX / l : Math.cos(p.facing);
    const dy = l > 0.01 ? input.moveY / l : Math.sin(p.facing);
    const d = PLAYER.dash;
    p.dashT = d.seconds;
    p.dashCd = d.cooldown;
    p.dashVx = dx * d.speed;
    p.dashVy = dy * d.speed;
    p.invuln = Math.max(p.invuln, d.seconds + 0.12);
    this.emit({ k: "sfx", n: "dash", slot: p.slot });
    this.emit({ k: "spark", x: p.x, y: p.y, color: PALETTE.player, count: 14, speed: 260, size: 3 });
  }

  /**
   * Host: accept a remote client's self-reported pose. The jump is clamped so
   * a stale or bogus packet can't teleport the robot across the arena.
   */
  setRemotePose(slot: number, x: number, y: number, facing: number, firing: boolean, dashing = false): void {
    const p = this.players[slot];
    if (!p || !p.active) return;
    // The client dashes on its own screen; the host honours the i-frames it earned.
    if (dashing) p.invuln = Math.max(p.invuln, PLAYER.dash.seconds + 0.12);
    let dx = x - p.x;
    let dy = y - p.y;
    const d = len(dx, dy);
    const maxStep = p.speed * COOP.poseMaxLagSec;
    if (d > maxStep) {
      dx = (dx / d) * maxStep;
      dy = (dy / d) * maxStep;
    }
    const elapsed = Math.max(this.time - p.lastPoseT, 1 / 60);
    p.lastPoseT = this.time;
    if (!p.downed) {
      p.x = clamp(p.x + dx, -WORLD.half, WORLD.half);
      p.y = clamp(p.y + dy, -WORLD.half, WORLD.half);
      p.vx = dx / elapsed;
      p.vy = dy / elapsed;
      p.facing = facing;
    }
    p.remoteFiring = firing;
  }

  /** The crowd voted to help: a heal gem lands next to every living player. */
  crowdSupplyDrop(): void {
    for (const p of this.players) {
      if (!this.isLiving(p)) continue;
      const [x, y] = ringPoint(p.x, p.y, 60, this.rng);
      this.dropGem(x, y, 0, "heal");
    }
    this.emit({ k: "sfx", n: "levelup", slot: -1 });
    this.emit({ k: "flash", color: "255,107,168", i: 0.35, slot: -1 });
  }

  /** The crowd voted for chaos: an extra wave rings the squad, within the usual enemy cap. */
  crowdSurge(): void {
    const living = this.players.filter((p) => this.isLiving(p));
    if (living.length === 0 || this.phase === "launch" || this.phase === "descent") return;
    const room = DIRECTOR.maxEnemies - this.aliveEnemyCount();
    const n = Math.min(room, 6 + 2 * living.length);
    for (let i = 0; i < n; i++) {
      const p = living[i % living.length];
      const [x, y] = ringPoint(p.x, p.y, this.viewRadius + 60, this.rng);
      const kind = this.phase === "orbit" ? chooseKind(this.phaseT, this.rng, "space") : chooseKind(this.time, this.rng);
      this.spawnEnemyAt(kind, x, y);
    }
    this.emit({ k: "sfx", n: "bossWarn", slot: -1 });
    this.emit({ k: "trauma", v: 0.4, slot: -1 });
  }

  /** A player left the run for good: their robot and shots vanish. */
  removePlayer(slot: number): void {
    const p = this.players[slot];
    if (!p) return;
    p.active = false;
    for (const b of this.bullets) if (b.owner === slot) b.dead = true;
  }

  /** Drop a ping marker at the player's robot; false while on cooldown or downed. */
  addPing(slot: number): boolean {
    const p = this.players[slot];
    if (!p || !this.isLiving(p) || p.pingCd > 0) return false;
    p.pingCd = COOP.pingCooldownSec;
    this.pings.push({ slot, x: p.x, y: p.y, life: COOP.pingLifeSec });
    return true;
  }

  private updatePings(dt: number): void {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i].life -= dt;
      if (this.pings[i].life <= 0) this.pings.splice(i, 1);
    }
  }

  private updateRevives(dt: number): void {
    for (const p of this.players) {
      if (!p.active || !p.downed) continue;
      let helped = false;
      for (const q of this.players) {
        if (q !== p && this.isLiving(q) && dist(p.x, p.y, q.x, q.y) <= COOP.reviveRange) {
          helped = true;
          break;
        }
      }
      if (!helped) {
        p.reviveT = 0;
        continue;
      }
      p.reviveT += dt / COOP.reviveSeconds;
      if (p.reviveT >= 1) {
        p.downed = false;
        p.reviveT = 0;
        p.hp = Math.round(p.maxHp * COOP.reviveHpFrac);
        p.invuln = PLAYER.iFrames;
        this.emit({ k: "text", x: p.x, y: p.y - 20, text: "REVIVED", color: PALETTE.heal, size: 20 });
        this.emit({ k: "sfx", n: "levelup", slot: -1 });
      }
    }
  }

  private updateEnemies(dt: number): void {
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead) continue;
      e.spawnT += dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 5);
      if (e.punchT > 0) e.punchT = Math.max(0, e.punchT - dt);

      const p = this.nearestLiving(e.x, e.y) ?? this.player;
      let a = angleTo(e.x, e.y, p.x, p.y);
      if (e.kind !== "asteroid") {
        // Interceptors weave on their approach instead of flying straight in.
        if (e.kind === "interceptor") a += Math.sin(this.time * 2.4 + i * 1.7) * 0.75;
        const spawnBoost = e.spawnT < 0.4 ? 0 : 1; // brief pause as they fade in
        e.vx = Math.cos(a) * e.speed * spawnBoost;
        e.vy = Math.sin(a) * e.speed * spawnBoost;
      }

      // Knockback decays quickly and adds to motion.
      e.kbx *= 1 - Math.min(1, dt * 8);
      e.kby *= 1 - Math.min(1, dt * 8);

      const nx = e.x + (e.vx + e.kbx) * dt;
      const ny = e.y + (e.vy + e.kby) * dt;
      if (e.kind === "asteroid" && (Math.abs(nx) > WORLD.half || Math.abs(ny) > WORLD.half)) {
        e.dead = true; // drifted out of the arena
        continue;
      }
      e.x = clamp(nx, -WORLD.half, WORLD.half);
      e.y = clamp(ny, -WORLD.half, WORLD.half);

      // Ranged enemies + boss fire at the player they're chasing.
      const sc = shooterConfig(e.kind);
      if (sc) {
        e.shootCd -= dt;
        const d = dist(e.x, e.y, p.x, p.y);
        if (e.shootCd <= 0 && d < sc.range) {
          e.shootCd = sc.cooldown * (e.enraged ? 0.65 : 1);
          if (e.isBoss) {
            // Boss fires a fanned volley.
            const n = sc.volley ?? 5;
            for (let i = 0; i < n; i++) this.fireEnemyBullet(e, a + (i - (n - 1) / 2) * 0.26, sc.bulletSpeed, sc.bulletDmg);
          } else {
            this.fireEnemyBullet(e, a, sc.bulletSpeed, sc.bulletDmg);
          }
        }
      }
    }
  }

  private fireEnemyBullet(e: Enemy, angle: number, speed: number, dmg: number): void {
    const b = this.acquireEnemyBullet();
    b.x = e.x;
    b.y = e.y;
    b.vx = Math.cos(angle) * speed;
    b.vy = Math.sin(angle) * speed;
    b.radius = 7;
    b.damage = dmg;
    b.life = 5;
    b.dead = false;
  }

  // ---- Weapons ------------------------------------------------------------
  private fireWeapons(p: Player, dt: number, firing: boolean): void {
    // Blaster: volley along the direction the player is steering. Fires only
    // while there is manual input, so an idle robot never shoots on its own.
    p.blasterCd -= dt;
    if (p.blasterCd <= 0 && firing) {
      p.blasterCd = p.blasterInterval;
      p.recoilT = 1;
      const n = p.blasterProjectiles;
      const spread = n > 1 ? 0.24 : 0;
      const base = p.facing;
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) - 0.5 : 0;
        this.fireBullet(p, base + t * spread * (n - 1) * 0.5 + t * spread);
      }
      this.emit({ k: "sfx", n: "shoot", slot: p.slot });
    }

    // Orbitals: continuous contact damage around rotating points.
    if (p.orbital > 0) {
      p.orbitAngle += dt * 2.6;
      const count = p.orbitalCount;
      for (let i = 0; i < count; i++) {
        const a = p.orbitAngle + (i / count) * TAU;
        const ox = p.x + Math.cos(a) * p.orbitalRadius;
        const oy = p.y + Math.sin(a) * p.orbitalRadius;
        this.grid.query(ox, oy, 18 + 30, (e) => {
          if (dist(ox, oy, e.x, e.y) <= 18 + e.radius) {
            this.damageEnemy(e, p.orbitalDamage * dt, false, ox, oy, 0, p);
          }
        });
      }
    }

    // Nova: periodic shockwave.
    if (p.nova > 0) {
      p.novaCd -= dt;
      if (p.novaCd <= 0) {
        p.novaCd = p.novaInterval;
        const r = p.novaRadius;
        this.novaRings.push({ x: p.x, y: p.y, r: 8, maxR: r, life: 0.45, dead: false });
        this.grid.query(p.x, p.y, r + 40, (e) => {
          const d = dist(p.x, p.y, e.x, e.y);
          if (d <= r + e.radius) {
            const a = angleTo(p.x, p.y, e.x, e.y);
            this.damageEnemy(e, p.novaDamage, false, e.x, e.y, 260, p);
            e.kbx += Math.cos(a) * 260;
            e.kby += Math.sin(a) * 260;
          }
        });
        this.emit({ k: "sfx", n: "hit", slot: -1 });
        this.emit({ k: "trauma", v: 0.18, slot: p.slot });
      }
    }

    // Chain Lightning: arcs from the nearest enemy to its neighbours.
    if (p.chain > 0) {
      p.chainCd -= dt;
      if (p.chainCd <= 0) {
        const first = this.nearestEnemy(p.x, p.y, p.chainReach);
        if (first) {
          p.chainCd = p.chainInterval;
          this.fireChain(p, first);
        } else {
          p.chainCd = 0.15; // nothing in reach: look again soon
        }
      }
    }

    // Rail Lance: a piercing beam toward the nearest enemy.
    if (p.lance > 0) {
      p.lanceCd -= dt;
      if (p.lanceCd <= 0) {
        const target = this.nearestEnemy(p.x, p.y, p.lanceLength * 0.9);
        if (target) {
          p.lanceCd = p.lanceInterval;
          this.fireLance(p, target);
        } else {
          p.lanceCd = 0.2;
        }
      }
    }
  }

  /** Nearest living enemy to (x, y) within `maxR`, ignoring those in `skip`. */
  private nearestEnemy(x: number, y: number, maxR: number, skip?: ReadonlySet<Enemy>): Enemy | null {
    let best: Enemy | null = null;
    let bestD = maxR * maxR;
    for (const e of this.enemies) {
      if (e.dead || (skip && skip.has(e))) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** A line of lingering sparks from (x1, y1) to (x2, y2): how bolts and beams are drawn. */
  private bolt(x1: number, y1: number, x2: number, y2: number, color: string, size: number, jitter: number, spacing = 22): void {
    const l = dist(x1, y1, x2, y2);
    const n = Math.max(2, Math.floor(l / spacing));
    const nx = l > 0 ? -(y2 - y1) / l : 0;
    const ny = l > 0 ? (x2 - x1) / l : 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const j = i === 0 || i === n ? 0 : (this.rng.next() - 0.5) * 2 * jitter;
      this.emit({ k: "spark", x: x1 + (x2 - x1) * t + nx * j, y: y1 + (y2 - y1) * t + ny * j, color, count: 1, speed: 6, size });
    }
  }

  private fireChain(p: Player, first: Enemy): void {
    const hit = new Set<Enemy>();
    let fromX = p.x;
    let fromY = p.y;
    let target: Enemy | null = first;
    let dmg = p.chainDamage;
    for (let i = 0; i < p.chainTargets && target; i++) {
      this.bolt(fromX, fromY, target.x, target.y, PALETTE.chain, 2.6, 9, 13);
      hit.add(target);
      fromX = target.x;
      fromY = target.y;
      this.damageEnemy(target, dmg, false, target.x, target.y, 50, p);
      dmg *= 0.85; // each jump hits a little softer
      target = this.nearestEnemy(fromX, fromY, p.chainHop, hit);
    }
    this.emit({ k: "sfx", n: "zap", slot: p.slot });
    this.emit({ k: "trauma", v: 0.06, slot: p.slot });
  }

  private fireLance(p: Player, target: Enemy): void {
    const a = angleTo(p.x, p.y, target.x, target.y);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const length = p.lanceLength;
    const half = p.lanceWidth / 2;
    for (const e of this.enemies) {
      if (e.dead) continue;
      // Distance along the beam, and sideways off it.
      const rx = e.x - p.x;
      const ry = e.y - p.y;
      const along = rx * cos + ry * sin;
      const side = Math.abs(-rx * sin + ry * cos);
      if (along < 0 || along > length + e.radius || side > half + e.radius) continue;
      this.damageEnemy(e, p.lanceDamage, false, e.x, e.y, 0, p);
      e.kbx += cos * 140;
      e.kby += sin * 140;
    }
    this.bolt(p.x, p.y, p.x + cos * length, p.y + sin * length, PALETTE.lance, 3, 2, 10);
    this.emit({ k: "spark", x: p.x + cos * 24, y: p.y + sin * 24, color: PALETTE.lance, count: 10, speed: 280, size: 4 });
    this.emit({ k: "sfx", n: "zap", slot: p.slot });
    this.emit({ k: "trauma", v: 0.16, slot: p.slot });
  }

  private fireBullet(p: Player, angle: number): void {
    const b = this.acquireBullet();
    const speed = 640 * p.projSpeedMul;
    b.x = p.x + Math.cos(angle) * 18;
    b.y = p.y + Math.sin(angle) * 18;
    b.vx = Math.cos(angle) * speed;
    b.vy = Math.sin(angle) * speed;
    b.radius = 5;
    b.crit = this.rng.chance(p.critChance);
    b.damage = p.blasterDamage * (b.crit ? p.critMul : 1);
    b.pierce = p.pierceBonus;
    b.life = 1.4;
    b.hitCd = 0;
    b.owner = p.slot;
    b.dead = false;
  }

  private updateBullets(dt: number): void {
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (b.dead) continue;
      b.life -= dt;
      if (b.life <= 0) { b.dead = true; continue; }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (Math.abs(b.x) > WORLD.half + 40 || Math.abs(b.y) > WORLD.half + 40) { b.dead = true; continue; }
      if (b.hitCd > 0) { b.hitCd -= dt; continue; }

      const owner = this.players[b.owner] ?? this.player;
      // Broad-phase query; boss radius (64) is the largest, pad accordingly.
      this.grid.query(b.x, b.y, b.radius + 70, (e) => {
        if (b.dead || b.hitCd > 0) return;
        if (dist(b.x, b.y, e.x, e.y) <= b.radius + e.radius) {
          this.damageEnemy(e, b.damage, b.crit, b.x, b.y, 90, owner);
          b.hitCd = 0.04;
          if (b.pierce <= 0) b.dead = true;
          else b.pierce--;
        }
      });
    }
  }

  private updateEnemyBullets(dt: number): void {
    for (let i = 0; i < this.enemyBullets.length; i++) {
      const b = this.enemyBullets[i];
      if (b.dead) continue;
      b.life -= dt;
      if (b.life <= 0) { b.dead = true; continue; }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      for (const p of this.players) {
        if (!this.isLiving(p)) continue;
        if (dist(b.x, b.y, p.x, p.y) <= b.radius + p.radius) {
          b.dead = true;
          if (p.takeDamage(b.damage)) this.onPlayerHurt(p);
          break;
        }
      }
    }
  }

  private damageEnemy(
    e: Enemy, dmg: number, crit: boolean, hx: number, hy: number, knockback: number, owner: Player,
  ): void {
    if (e.dead) return;
    e.hp -= dmg;
    e.flash = 1;
    if (knockback > 0) {
      const a = angleTo(owner.x, owner.y, e.x, e.y);
      e.kbx += Math.cos(a) * knockback;
      e.kby += Math.sin(a) * knockback;
    }
    this.emit({ k: "spark", x: hx, y: hy, color: e.color, count: crit ? 6 : 2, speed: 200, size: crit ? 3.5 : 2.2 });
    if (crit) this.emit({ k: "text", x: hx, y: hy - 6, text: `${Math.round(dmg)}`, color: "#fff2a8", size: 20 });
    if (e.hp <= 0) this.killEnemy(e, owner);
    else this.emit({ k: "sfx", n: "hit", slot: -1 });
    if (!e.dead && e.kind === "capital" && !e.enraged && e.hp < e.maxHp * 0.5) {
      // Stage two: the bridge blows off (the renderer flings the Lux3D-split part away).
      e.enraged = true;
      this.emit({ k: "spark", x: e.x, y: e.y, color: "#ffb44d", count: 50, speed: 420, size: 5 });
      this.emit({ k: "text", x: e.x, y: e.y - 40, text: "BRIDGE DESTROYED", color: "#ffb44d", size: 26 });
      this.emit({ k: "sfx", n: "bigKill", slot: -1 });
      this.emit({ k: "trauma", v: 0.7, slot: -1 });
      this.emit({ k: "flash", color: "255,180,90", i: 0.5, slot: -1 });
    }
  }

  private killEnemy(e: Enemy, killer: Player): void {
    e.dead = true;
    this.kills++;
    killer.kills++;
    this.emit({
      k: "spark", x: e.x, y: e.y, color: e.color,
      count: e.isBoss ? 60 : 12, speed: e.isBoss ? 460 : 260, size: e.isBoss ? 5 : 3,
    });

    if (e.isBoss) {
      this.emit({ k: "sfx", n: "bigKill", slot: -1 });
      this.emit({ k: "trauma", v: 0.8, slot: -1 });
      this.emit({ k: "flash", color: "255,230,140", i: 0.8, slot: -1 });
      this.boss = null;
      this.director.bossActive = false;
      // Boss showers rewards.
      for (let i = 0; i < 24; i++) {
        const [gx, gy] = ringPoint(e.x, e.y, 20 + Math.random() * 90, this.rng);
        this.dropGem(gx, gy, Math.ceil(e.xp / 24), "xp");
      }
      this.dropGem(e.x, e.y, 0, "heal");
      // Beating a boss patches up the squad, so you don't launch (or land) on your last HP.
      for (const q of this.players) {
        if (!this.isLiving(q)) continue;
        q.hp = Math.min(q.maxHp, q.hp + q.maxHp * 0.35);
        this.emit({ k: "text", x: q.x, y: q.y - 24, text: "HULL REPAIRED", color: PALETTE.heal, size: 18 });
      }
      // Each boss ends its half of the loop.
      if (e.kind === "boss" && this.phase === "surface") this.setPhase("launch");
      else if (e.kind === "capital" && this.phase === "orbit") this.setPhase("descent");
    } else {
      this.emit({ k: "sfx", n: "kill", slot: -1 });
      this.emit({ k: "trauma", v: 0.08, slot: -1 });
      this.dropGem(e.x, e.y, e.xp, "xp");
      if (this.rng.chance(0.02)) this.dropGem(e.x + 12, e.y, 0, "heal");
      // Splitters spawn children on death.
      if (e.splitInto) {
        // Read these first: a child may reuse this very slot (it's free now), which overwrites `e`.
        const kind = e.splitInto;
        const { x, y } = e;
        for (let i = 0; i < 2; i++) {
          const child = this.acquireEnemy();
          initEnemy(child, kind, x + (Math.random() - 0.5) * 24, y + (Math.random() - 0.5) * 24, this.difficultyT, this.hpMul);
        }
      }
    }
  }

  private dropGem(x: number, y: number, value: number, kind: "xp" | "heal"): void {
    const g = this.acquireGem();
    g.x = x;
    g.y = y;
    const a = Math.random() * TAU;
    const s = 40 + Math.random() * 60;
    g.vx = Math.cos(a) * s;
    g.vy = Math.sin(a) * s;
    g.radius = kind === "heal" ? 10 : 7;
    g.value = value;
    g.magnet = false;
    g.kind = kind;
    g.dead = false;
  }

  private contactDamage(): void {
    for (const p of this.players) {
      if (!this.isLiving(p)) continue;
      this.grid.query(p.x, p.y, p.radius + 70, (e) => {
        if (e.dead) return;
        if (dist(p.x, p.y, e.x, e.y) <= p.radius + e.radius) {
          if (e.kind === "kamikaze") {
            // Kamikazes detonate on contact, hit or not.
            if (p.takeDamage(e.touchDamage)) this.onPlayerHurt(p);
            e.dead = true;
            this.emit({ k: "spark", x: e.x, y: e.y, color: e.color, count: 24, speed: 380, size: 4 });
            this.emit({ k: "sfx", n: "kill", slot: -1 });
            this.emit({ k: "trauma", v: 0.3, slot: p.slot });
            return;
          }
          if (p.takeDamage(e.touchDamage)) {
            this.onPlayerHurt(p);
            e.punchT = 0.35;
            // Small knockback to the enemy so you're not instantly re-hit.
            const a = angleTo(e.x, e.y, p.x, p.y);
            e.kbx -= Math.cos(a) * 160;
            e.kby -= Math.sin(a) * 160;
          }
        }
      });
    }
  }

  private onPlayerHurt(p: Player): void {
    this.emit({ k: "sfx", n: "hurt", slot: p.slot });
    this.emit({ k: "trauma", v: 0.5, slot: p.slot });
    this.emit({ k: "flash", color: "255,60,90", i: 0.45, slot: p.slot });
    this.emit({ k: "spark", x: p.x, y: p.y, color: PALETTE.danger, count: 14, speed: 240, size: 3 });
  }

  private updateGems(dt: number): void {
    for (let i = 0; i < this.gems.length; i++) {
      const g = this.gems[i];
      if (g.dead) continue;
      const p = this.nearestLiving(g.x, g.y);
      if (!p) continue;
      const d = dist(g.x, g.y, p.x, p.y);
      const a = angleTo(g.x, g.y, p.x, p.y);
      // Enemies die at blaster range, far from the player, so a gentle global
      // magnet streams every gem back toward you (great "vacuum" game feel);
      // inside the pickup radius it snaps in fast. Pickup upgrades widen the
      // snap zone and tighten the stream.
      const inRange = d < p.pickupRadius;
      if (inRange) g.magnet = true;
      const pull = g.magnet ? 1400 : 240;
      g.vx += Math.cos(a) * pull * dt;
      g.vy += Math.sin(a) * pull * dt;
      const sp = len(g.vx, g.vy);
      const maxSp = g.magnet ? 1100 : 300;
      if (sp > maxSp) {
        g.vx = (g.vx / sp) * maxSp;
        g.vy = (g.vy / sp) * maxSp;
      }
      g.x += g.vx * dt;
      g.y += g.vy * dt;

      if (d <= p.radius + g.radius) {
        g.dead = true;
        if (g.kind === "heal") {
          p.hp = Math.min(p.maxHp, p.hp + Math.max(15, p.maxHp * 0.15));
          this.emit({ k: "text", x: p.x, y: p.y - 20, text: "+HP", color: PALETTE.heal, size: 18 });
          this.emit({ k: "sfx", n: "pickup", slot: p.slot });
        } else {
          this.addXp(g.value * p.xpMul);
          this.emit({ k: "sfx", n: "pickup", slot: p.slot });
        }
      }
    }
  }

  private addXp(value: number): void {
    this.xp += value;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = xpForLevel(this.level);
      this.pendingLevelUps++;
    }
  }

  private updateNovaRings(dt: number): void {
    for (let i = this.novaRings.length - 1; i >= 0; i--) {
      const n = this.novaRings[i];
      n.life -= dt;
      n.r += (n.maxR - n.r) * Math.min(1, dt * 10);
      if (n.life <= 0) this.novaRings.splice(i, 1);
    }
  }

  /**
   * Advance the purely visual state (particles, screen flash, music intensity).
   * Runs inside `update` on the host/solo; a co-op client, which never runs
   * `update`, calls it every frame on its own.
   */
  tickCosmetics(dt: number): void {
    this.particles.update(dt);
    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt * 2.2);
    // Music intensity ramps with time + on-screen pressure.
    this.audio.setIntensity(clamp(this.time / 240 + this.aliveEnemyCount() / 400, 0, 1));
  }

  /** A player hit 0 HP: in solo this is death; in co-op they wait for a revive. */
  private down(p: Player): void {
    p.downed = true;
    p.hp = 0;
    p.reviveT = 0;
    p.vx = p.vy = 0;
    this.emit({ k: "sfx", n: "bigKill", slot: p.slot });
    this.emit({ k: "trauma", v: 1, slot: p.slot });
    this.emit({ k: "flash", color: "255,60,90", i: 1, slot: p.slot });
    this.emit({ k: "spark", x: p.x, y: p.y, color: COOP.slotColors[p.slot] ?? PALETTE.player, count: 80, speed: 420, size: 5 });
  }

  // ---- Level-up interface (driven by the UI layer) ------------------------
  rollUpgradeChoices(slot = this.localSlot): Upgrade[] {
    const p = this.players[slot];
    return rollUpgrades(p, p.taken, this.rng, 3);
  }

  choiceLabel(u: Upgrade, slot = this.localSlot): string {
    const p = this.players[slot];
    return upgradeLabel(u, p, p.taken);
  }

  /** Apply one player's pick. Does not close the level-up — see `finishLevelUp`. */
  applyUpgrade(slot: number, u: Upgrade): void {
    const p = this.players[slot];
    u.apply(p);
    p.taken[u.id] = (p.taken[u.id] ?? 0) + 1;
  }

  /** Everyone has picked for one team level: consume it. */
  finishLevelUp(): void {
    this.pendingLevelUps = Math.max(0, this.pendingLevelUps - 1);
    this.emit({ k: "sfx", n: "levelup", slot: -1 });
    this.emit({ k: "flash", color: "120,200,255", i: 0.4, slot: -1 });
  }

  get stats(): RunStats {
    return { time: this.time, kills: this.kills, level: this.level };
  }

  /** Name over the boss bar: the Forge prompt when this boss wears it. */
  get bossLabel(): string {
    // A co-op client has no local boss; it reads the boss from the synced enemies.
    const b = this.boss ?? this.enemies.find((e) => !e.dead && e.isBoss) ?? null;
    if (b && b.forged && this.forgeName) return this.forgeName.toUpperCase();
    if (b ? b.kind === "capital" : this.phase === "orbit") return "CAPITAL SHIP";
    return "WARDEN";
  }

  get bossHpFraction(): number | null {
    if (this.bossHpOverride !== null) return this.bossHpOverride;
    return this.boss && !this.boss.dead ? clamp(this.boss.hp / this.boss.maxHp, 0, 1) : null;
  }
}
