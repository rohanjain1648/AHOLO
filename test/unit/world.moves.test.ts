import { describe, expect, it } from "vitest";
import { PLAYER } from "../../src/game/config";
import { UPGRADES } from "../../src/game/upgrades";
import { IDLE_INPUT, type Enemy, type PlayerInput } from "../../src/game/types";
import { World } from "../../src/game/world";
import { captureSnapshot, decodeSnapshot, encodeSnapshot } from "../../src/net/snapshot";
import { silentAudio } from "./helpers";

const DT = 1 / 60;
const DASH: PlayerInput = { ...IDLE_INPUT, dash: true };

/** A world with no random spawns, recording effects so tests can see what was emitted. */
function quietWorld(): World {
  const w = new World(silentAudio());
  (w as unknown as { director: { update: () => void } }).director.update = () => {};
  w.recordEffects = true;
  return w;
}

/** A sturdy, stationary enemy at (x, y), so damage is easy to read off its HP. */
function dummy(w: World, x: number, y: number): Enemy {
  const e = w.spawnEnemy("grunt", x, y);
  e.speed = 0;
  e.spawnT = 1;
  e.hp = e.maxHp = 1000;
  e.touchDamage = 0;
  return e;
}

const run = (w: World, seconds: number, input: PlayerInput = IDLE_INPUT) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) w.update(DT, [input]);
};

describe("dash", () => {
  it("bursts far faster than walking, in the move direction", () => {
    const w = quietWorld();
    const p = w.player;
    w.stepPlayerMovement(p, { ...DASH, moveX: 1 }, DT);
    for (let i = 0; i < 12; i++) w.stepPlayerMovement(p, { ...IDLE_INPUT, moveX: 1 }, DT);
    expect(p.x).toBeGreaterThan(150); // walking 0.2 s covers ~42
    expect(Math.abs(p.y)).toBeLessThan(1);
  });

  it("dashes along the facing direction when no movement keys are held", () => {
    const w = quietWorld();
    const p = w.player;
    p.facing = Math.PI / 2; // facing +y
    w.stepPlayerMovement(p, DASH, DT);
    for (let i = 0; i < 12; i++) w.stepPlayerMovement(p, IDLE_INPUT, DT);
    expect(p.y).toBeGreaterThan(120);
    expect(Math.abs(p.x)).toBeLessThan(1);
  });

  it("makes you invulnerable while it lasts", () => {
    const w = quietWorld();
    const p = w.player;
    p.invuln = 0;
    w.stepPlayerMovement(p, { ...DASH, moveX: 1 }, DT);
    expect(p.invuln).toBeGreaterThanOrEqual(PLAYER.dash.seconds);
    expect(p.takeDamage(50)).toBe(false);
  });

  it("has a cooldown, then works again", () => {
    const w = quietWorld();
    const p = w.player;
    w.stepPlayerMovement(p, { ...DASH, moveX: 1 }, DT);
    expect(p.dashCd).toBeGreaterThan(PLAYER.dash.cooldown - 0.1);
    for (let i = 0; i < 30; i++) w.stepPlayerMovement(p, IDLE_INPUT, DT);
    const x = p.x;
    w.stepPlayerMovement(p, { ...DASH, moveX: 1 }, DT); // too soon: no burst
    expect(p.dashT).toBe(0);
    for (let i = 0; i < 60 * PLAYER.dash.cooldown; i++) w.stepPlayerMovement(p, IDLE_INPUT, DT);
    p.vx = p.vy = 0;
    w.stepPlayerMovement(p, { ...DASH, moveX: 1 }, DT);
    expect(p.dashT).toBeGreaterThan(0);
    expect(p.x).toBeGreaterThanOrEqual(x);
  });

  it("is an afterburner in orbit: briefly beyond top speed", () => {
    const w = quietWorld();
    w.setPhase("orbit");
    const p = w.player;
    const top = p.speed * 1.6;
    w.stepPlayerMovement(p, { ...DASH, moveX: 1 }, DT);
    w.stepPlayerMovement(p, { ...IDLE_INPUT, moveX: 1 }, DT);
    expect(Math.hypot(p.vx, p.vy)).toBeGreaterThan(top * 1.5);
    for (let i = 0; i < 90; i++) w.stepPlayerMovement(p, { ...IDLE_INPUT, moveX: 1 }, DT);
    expect(Math.hypot(p.vx, p.vy)).toBeLessThanOrEqual(top + 1);
  });

  it("emits a whoosh and sparks", () => {
    const w = quietWorld();
    w.stepPlayerMovement(w.player, { ...DASH, moveX: 1 }, DT);
    const fx = w.drainEffects();
    expect(fx.some((e) => e.k === "sfx" && e.n === "dash")).toBe(true);
    expect(fx.some((e) => e.k === "spark")).toBe(true);
  });

  it("a co-op client's dash makes its robot invulnerable on the host", () => {
    const w = quietWorld();
    w.reset([{ slot: 0, name: "A" }, { slot: 1, name: "B" }]);
    const p = w.players[1];
    p.remote = true;
    p.invuln = 0;
    w.setRemotePose(1, p.x + 10, p.y, 0, false, true);
    expect(p.invuln).toBeGreaterThan(0);
    p.invuln = 0;
    w.setRemotePose(1, p.x + 10, p.y, 0, false, false);
    expect(p.invuln).toBe(0);
  });
});

describe("Chain Lightning", () => {
  it("arcs from the nearest enemy to its neighbours, hitting up to 2 + level targets", () => {
    const w = quietWorld();
    const p = w.player;
    p.chain = 1;
    const near = dummy(w, p.x + 150, p.y);
    const second = dummy(w, p.x + 150, p.y + 120);
    const third = dummy(w, p.x + 150, p.y + 240);
    const fourth = dummy(w, p.x + 150, p.y + 360); // beyond 3 targets at level 1
    const far = dummy(w, p.x - 900, p.y); // out of reach
    run(w, 0.3);
    expect(near.hp).toBeLessThan(near.maxHp);
    expect(second.hp).toBeLessThan(second.maxHp);
    expect(third.hp).toBeLessThan(third.maxHp);
    expect(fourth.hp).toBe(fourth.maxHp);
    expect(far.hp).toBe(far.maxHp);
    expect(near.maxHp - near.hp).toBeGreaterThan(second.maxHp - second.hp); // damage falls off per jump
  });

  it("draws the arc as sparks and does nothing without a target in reach", () => {
    const w = quietWorld();
    w.player.chain = 1;
    run(w, 1);
    expect(w.drainEffects().some((e) => e.k === "spark")).toBe(false);
    dummy(w, w.player.x + 100, w.player.y);
    w.player.chainCd = 0;
    run(w, 0.1);
    expect(w.drainEffects().filter((e) => e.k === "spark").length).toBeGreaterThan(3);
  });

  it("gets stronger and faster with levels", () => {
    const w = quietWorld();
    const p = w.player;
    p.chain = 1;
    const i1 = p.chainInterval, d1 = p.chainDamage, t1 = p.chainTargets;
    p.chain = 5;
    expect(p.chainInterval).toBeLessThan(i1);
    expect(p.chainDamage).toBeGreaterThan(d1);
    expect(p.chainTargets).toBeGreaterThan(t1);
  });
});

describe("Rail Lance", () => {
  it("pierces everything along the line to the nearest enemy, and nothing beside it", () => {
    const w = quietWorld();
    const p = w.player;
    p.lance = 1;
    const a = dummy(w, p.x + 200, p.y);
    const b = dummy(w, p.x + 420, p.y + 4);
    const beside = dummy(w, p.x + 300, p.y + 160);
    const behind = dummy(w, p.x - 200, p.y);
    run(w, 0.3);
    expect(a.hp).toBeLessThan(a.maxHp);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(beside.hp).toBe(beside.maxHp);
    expect(behind.hp).toBe(behind.maxHp);
  });

  it("draws the beam and shakes the screen", () => {
    const w = quietWorld();
    w.player.lance = 1;
    dummy(w, w.player.x + 250, w.player.y);
    w.player.lanceCd = 0;
    run(w, 0.1);
    const fx = w.drainEffects();
    expect(fx.filter((e) => e.k === "spark").length).toBeGreaterThan(8);
    expect(fx.some((e) => e.k === "trauma")).toBe(true);
  });
});

describe("upgrades", () => {
  it("offers the new weapons as unlocks, then as upgrades", () => {
    const w = quietWorld();
    const p = w.player;
    const get = (id: string) => UPGRADES.find((u) => u.id === id)!;
    for (const [unlock, level, field] of [["chain_unlock", "chain", "chain"], ["lance_unlock", "lance", "lance"]] as const) {
      expect(get(unlock).eligible!(p, {})).toBe(true);
      expect(get(level).eligible!(p, {})).toBe(false);
      get(unlock).apply(p);
      expect(p[field]).toBe(1);
      expect(get(unlock).eligible!(p, {})).toBe(false);
      expect(get(level).eligible!(p, {})).toBe(true);
      get(level).apply(p);
      expect(p[field]).toBe(2);
    }
  });

  it("player.reset clears the new state", () => {
    const w = quietWorld();
    const p = w.player;
    p.chain = 3;
    p.lance = 2;
    p.dashCd = 2;
    p.reset();
    expect([p.chain, p.lance, p.dashCd, p.dashT]).toEqual([0, 0, 0, 0]);
  });
});

describe("snapshot", () => {
  it("carries the new weapon levels", () => {
    const w = quietWorld();
    w.player.chain = 3;
    w.player.lance = 2;
    const s = decodeSnapshot(encodeSnapshot(captureSnapshot(w, 1, 0, [])));
    expect([s.players[0].chain, s.players[0].lance]).toEqual([3, 2]);
  });
});
