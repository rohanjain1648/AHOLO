import { describe, expect, it } from "vitest";
import { titleButtonRects, type Rect } from "../../src/ui/screens";

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("title buttons", () => {
  for (const [w, h] of [[1920, 970], [1366, 650], [1280, 720], [390, 700], [844, 390]] as const) {
    it(`don't overlap and stay on screen horizontally at ${w}x${h}`, () => {
      const r = titleButtonRects(w, h);
      const all = Object.entries(r) as [string, Rect][];
      expect(all.map(([k]) => k).sort()).toEqual(["forge", "hangar", "host", "join", "orbit", "solo"]);
      for (const [name, rect] of all) {
        expect(rect.x, name).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w, name).toBeLessThanOrEqual(w);
        expect(rect.w, name).toBeGreaterThan(20);
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          expect(overlaps(all[i][1], all[j][1]), `${all[i][0]} vs ${all[j][0]}`).toBe(false);
        }
      }
    });
  }

  it("puts ORBIT on the PLAY SOLO row, to its right, smaller than it", () => {
    const { solo, orbit, host } = titleButtonRects(1280, 720);
    expect(orbit.y).toBeCloseTo(solo.y);
    expect(orbit.h).toBeCloseTo(solo.h);
    expect(orbit.x).toBeGreaterThan(solo.x + solo.w);
    expect(orbit.w).toBeLessThan(solo.w);
    // together they span the same width as the co-op row below
    expect(solo.x).toBeCloseTo(host.x);
  });
});
