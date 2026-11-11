import { defFor, DIRECTOR, ENEMIES, isBossKind, PHASES, SPACE_ENEMIES, WORLD } from "./config";
import type { EnemyDef, EnemyKind } from "./config";
import type { Enemy } from "./types";
import { clamp, RNG, TAU } from "../core/math";

/** Multiplicative HP scaling as the run goes on. */
export const hpScale = (t: number): number => 1 + (t / 60) * DIRECTOR.hpScalePerMin;
export const speedScale = (t: number): number =>
  clamp(1 + (t / 60) * DIRECTOR.speedScalePerMin, 1, 1.9);

/** Seconds between spawn ticks, shrinking over the run. */
export const spawnInterval = (t: number): number => {
  const k = clamp(t / DIRECTOR.spawnRampSeconds, 0, 1);
  return DIRECTOR.baseSpawnInterval + (DIRECTOR.minSpawnInterval - DIRECTOR.baseSpawnInterval) * k;
};

/** How many enemies to release per tick, grows slowly with time. */
const batchSize = (t: number): number => DIRECTOR.batchBase + Math.floor(t / DIRECTOR.batchGrowthSeconds);

/** Populate a (possibly recycled) enemy struct in place. */
export function initEnemy(e: Enemy, kind: EnemyKind, x: number, y: number, t: number, hpMul = 1): void {
  const def = defFor(kind);
  const boss = isBossKind(kind);
  // Bosses scale gently with run time. (They used to also ride the regular-enemy curve, which made
  // the first Warden a ~2,800 HP wall that most runs never beat, and the Warden gates orbit.)
  const hs = (boss ? 1 + t / DIRECTOR.bossHpScaleSeconds : hpScale(t)) * hpMul;
  const ss = speedScale(t);
  e.kind = kind;
  e.x = x;
  e.y = y;
  e.vx = 0;
  e.vy = 0;
  e.radius = def.radius;
  e.maxHp = Math.round(def.baseHp * hs);
  e.hp = e.maxHp;
  e.speed = def.baseSpeed * ss;
  e.touchDamage = def.touchDamage;
  e.xp = def.xp;
  e.color = def.color;
  e.modelScale = def.modelScale;
  e.anim = def.anim;
  e.animSpeed = def.animSpeed;
  e.dead = false;
  e.flash = 0;
  e.kbx = 0;
  e.kby = 0;
  e.shootCd = def.shooter ? def.shooter.cooldown * (0.5 + Math.random()) : 0;
  e.isBoss = boss;
  e.splitInto = def.splitInto;
  e.spawnT = 0;
  e.punchT = 0;
}

export const shooterConfig = (kind: EnemyKind) => defFor(kind).shooter;

export type Roster = "land" | "space";

/**
 * Weighted pick of an unlocked enemy kind. `t` is run time for the land
 * roster and seconds into the current orbit for the space roster.
 */
export function chooseKind(t: number, rng: RNG, roster: Roster = "land"): EnemyKind {
  let total = 0;
  const eligible: EnemyDef[] = [];
  const pool: Record<string, EnemyDef> = roster === "space" ? SPACE_ENEMIES : ENEMIES;
  for (const d of Object.values(pool)) {
    if (t >= d.unlockAt) {
      eligible.push(d);
      total += d.weight;
    }
  }
  let r = rng.next() * total;
  for (const d of eligible) {
    r -= d.weight;
    if (r <= 0) return d.kind;
  }
  return roster === "space" ? "interceptor" : "grunt";
}

/**
 * Spawn director: owns spawn cadence + boss timing. Kept free of World
 * references — it calls back into a `spawn` function so there's no import cycle.
 */
export class Director {
  private spawnTimer = spawnInterval(0);
  private bossTimer = DIRECTOR.bossEverySeconds;
  bossPending = false;
  bossActive = false;
  /** Land waves + the Warden, or orbit waves + the capital ship. */
  roster: Roster = "land";
  /** Seconds since this roster started (the space roster unlocks by orbit time). */
  private rosterT = 0;

  reset(roster: Roster = "land"): void {
    this.roster = roster;
    this.rosterT = 0;
    this.spawnTimer = roster === "space" ? 1 : spawnInterval(0);
    this.bossTimer = roster === "space" ? PHASES.orbitBossDelay : DIRECTOR.bossEverySeconds;
    this.bossPending = false;
    this.bossActive = false;
  }

  update(
    dt: number,
    t: number,
    px: number,
    py: number,
    viewRadius: number,
    enemyCount: number,
    rng: RNG,
    spawn: (kind: EnemyKind, x: number, y: number) => void,
    spawnRateMul = 1,
  ): void {
    this.rosterT += dt;
    // Boss cadence
    this.bossTimer -= dt;
    if (this.bossTimer <= 0 && !this.bossActive) {
      this.bossTimer = DIRECTOR.bossEverySeconds;
      const [bx, by] = ringPoint(px, py, viewRadius + 120, rng);
      spawn(this.roster === "space" ? "capital" : "boss", bx, by);
      this.bossActive = true;
      this.bossPending = true;
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer += spawnInterval(t);
      if (enemyCount < DIRECTOR.maxEnemies) {
        let n = batchSize(t);
        // Co-op: scale the batch, rounding the fraction probabilistically. A
        // multiplier of exactly 1 (solo) draws no extra randomness.
        if (spawnRateMul !== 1) {
          const scaled = n * spawnRateMul;
          n = Math.floor(scaled) + (rng.next() < scaled - Math.floor(scaled) ? 1 : 0);
        }
        for (let i = 0; i < n; i++) {
          const kind = this.roster === "space" ? chooseKind(this.rosterT, rng, "space") : chooseKind(t, rng);
          const [x, y] = ringPoint(px, py, viewRadius + 60 + rng.next() * 120, rng);
          spawn(kind, x, y);
        }
      }
    }
  }
}

/** A point on a ring around (px,py), clamped inside the arena. */
export function ringPoint(px: number, py: number, radius: number, rng: RNG): [number, number] {
  const a = rng.next() * TAU;
  const x = clamp(px + Math.cos(a) * radius, -WORLD.half, WORLD.half);
  const y = clamp(py + Math.sin(a) * radius, -WORLD.half, WORLD.half);
  return [x, y];
}
