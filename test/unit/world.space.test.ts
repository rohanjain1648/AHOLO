import { describe, expect, it } from "vitest";
import { PHASES, SPACE_KINDS } from "../../src/game/config";
import { IDLE_INPUT, type PlayerInput } from "../../src/game/types";
import { World } from "../../src/game/world";
import { captureSnapshot, decodeSnapshot, encodeSnapshot } from "../../src/net/snapshot";
import { runFor, silentAudio } from "./helpers";

const FIRE_RIGHT: PlayerInput = { ...IDLE_INPUT, firing: true, aimActive: true, aimX: 1, aimY: 0 };

/** Put a 1-HP boss of `kind` right in front of the player and shoot it down. */
function killBoss(w: World, kind: "boss" | "capital"): void {
  const p = w.player;
  const e = w.spawnEnemy(kind, p.x + 120, p.y);
  e.hp = 1;
  e.speed = 0;
  for (let i = 0; i < 120 && !e.dead; i++) w.update(1 / 60, [FIRE_RIGHT]);
  expect(e.dead).toBe(true);
}

describe("surface -> launch -> orbit -> descent loop", () => {
  it("starts on the surface", () => {
    const w = new World(silentAudio());
    expect(w.phase).toBe("surface");
    expect(w.loop).toBe(0);
  });

  it("killing the land boss launches the squad into orbit", () => {
    const w = new World(silentAudio());
    runFor(w, 2, [IDLE_INPUT]);
    killBoss(w, "boss");
    expect(w.phase).toBe("launch");

    // During launch the swarm is cleared and nobody can be hurt or move.
    const p = w.player;
    const x0 = p.x;
    runFor(w, 0.5, [{ ...IDLE_INPUT, moveX: 1 }]);
    expect(w.enemies.every((e) => e.dead)).toBe(true);
    expect(p.x).toBe(x0);
    expect(p.invuln).toBeGreaterThan(0);

    runFor(w, PHASES.launchSeconds, [IDLE_INPUT]);
    expect(w.phase).toBe("orbit");
  });

  it("orbit spawns only space enemies", () => {
    const w = new World(silentAudio());
    w.setPhase("orbit");
    runFor(w, 12, [FIRE_RIGHT]);
    const kinds = new Set(w.enemies.filter((e) => !e.dead).map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(0);
    for (const k of kinds) expect(SPACE_KINDS).toContain(k);
  });

  it("ships drift: velocity carries on after thrust stops", () => {
    const surface = new World(silentAudio());
    const orbit = new World(silentAudio());
    orbit.setPhase("orbit");
    for (const w of [surface, orbit]) {
      runFor(w, 1, [{ ...IDLE_INPUT, moveX: 1 }]);
      runFor(w, 0.5, [IDLE_INPUT]);
    }
    expect(Math.abs(surface.player.vx)).toBeLessThan(5);
    expect(Math.abs(orbit.player.vx)).toBeGreaterThan(60);
  });

  it("killing the capital ship descends to a harder surface loop", () => {
    const w = new World(silentAudio());
    w.setPhase("orbit");
    killBoss(w, "capital");
    expect(w.phase).toBe("descent");
    runFor(w, PHASES.descentSeconds + 0.1, [IDLE_INPUT]);
    expect(w.phase).toBe("surface");
    expect(w.loop).toBe(1);
  });

  it("the capital ship arrives on its own after the orbit warm-up", () => {
    const w = new World(silentAudio());
    w.setPhase("orbit");
    w.player.maxHp = w.player.hp = 1e9; // survive long enough to see it
    runFor(w, PHASES.orbitBossDelay + 1, [IDLE_INPUT]);
    expect(w.enemies.some((e) => !e.dead && e.kind === "capital")).toBe(true);
  });
});

describe("snapshot carries the phase", () => {
  it("round-trips phase, loop and space enemy kinds", () => {
    const w = new World(silentAudio());
    w.setPhase("orbit");
    w.loop = 2;
    w.spawnEnemy("interceptor", 100, 0);
    w.spawnEnemy("asteroid", -100, 0);
    const s = decodeSnapshot(encodeSnapshot(captureSnapshot(w, 1, 0, [])));
    expect(s.phase).toBe("orbit");
    expect(s.loop).toBe(2);
    expect(s.enemies.map((e) => e.kind).sort()).toEqual(["asteroid", "interceptor"]);
  });
});
