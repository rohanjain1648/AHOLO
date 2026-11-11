import { describe, expect, it } from "vitest";
import { bounceOffWall, edgeDistance, edgeProximity, EDGE_WARN } from "../../src/game/arena";
import { WORLD } from "../../src/game/config";
import { radarRect, sectorName } from "../../src/ui/hud";
import { World } from "../../src/game/world";
import { IDLE_INPUT } from "../../src/game/types";

describe("arena edge", () => {
  it("is 0 in the middle and 1 at the wall, whichever axis is nearer", () => {
    expect(edgeProximity(0, 0)).toBe(0);
    expect(edgeProximity(WORLD.half, 0)).toBe(1);
    expect(edgeProximity(0, -WORLD.half)).toBe(1);
    expect(edgeProximity(WORLD.half - EDGE_WARN / 2, 0)).toBeCloseTo(0.5);
    // the corner counts as the wall too: the arena is a square, not a circle
    expect(edgeDistance(WORLD.half - 10, WORLD.half - 10)).toBe(10);
  });

  it("bounces the outward velocity back, damped, and keeps the ship inside", () => {
    const b = bounceOffWall(WORLD.half + 30, 100, 400, 50);
    expect(b.x).toBe(WORLD.half);
    expect(b.vx).toBeCloseTo(-140);
    expect(b.vy).toBe(50); // the other axis is untouched
    const inside = bounceOffWall(10, 10, 5, 5);
    expect(inside).toEqual({ x: 10, y: 10, vx: 5, vy: 5 });
  });

  it("a drifting ship in orbit rebounds instead of sticking to the wall", () => {
    const w = new World(1);
    w.setPhase("orbit");
    const p = w.player;
    p.x = WORLD.half - 5;
    p.y = 0;
    p.vx = 500;
    p.vy = 0;
    w.stepPlayerMovement(p, { ...IDLE_INPUT }, 0.05);
    expect(p.x).toBeLessThanOrEqual(WORLD.half);
    expect(p.vx).toBeLessThan(0);
  });
});

describe("radar", () => {
  it("names sectors A-D by 1-4 across the arena", () => {
    expect(sectorName(-WORLD.half + 1, -WORLD.half + 1)).toBe("A1");
    expect(sectorName(WORLD.half - 1, WORLD.half - 1)).toBe("D4");
    expect(sectorName(0, 0)).toBe("C3");
  });

  it("sits in the bottom-right, inside the screen, above the ping button in co-op", () => {
    for (const [w, h] of [[1920, 970], [390, 700], [844, 390]] as const) {
      const solo = radarRect(w, h, false);
      const coop = radarRect(w, h, true);
      expect(solo.x + solo.w).toBeLessThanOrEqual(w);
      expect(solo.y + solo.h).toBeLessThanOrEqual(h);
      expect(coop.y + coop.h).toBeLessThan(h - 16 - 64); // clear of the ping button
      expect(coop.y).toBeGreaterThan(0);
    }
  });
});
