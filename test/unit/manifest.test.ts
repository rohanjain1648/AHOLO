import { describe, expect, it } from "vitest";
import { parseManifest, resolveClip, roleForEnemy, PLAYER_ROLE } from "../../src/render/manifest";

describe("parseManifest", () => {
  it("accepts a valid manifest and keeps known fields", () => {
    const m = parseManifest({
      version: 1,
      models: {
        "enemy.grunt": {
          file: "gen/enemy-grunt.glb",
          kind: "skinned",
          clips: { Idle: "Idle_Loop", Running: "Sprint_Loop" },
          yaw: 1.5,
          heightMul: 1.1,
        },
        "enemy.shooter": { file: "gen/enemy-shooter.glb", kind: "rigid" },
      },
    });
    expect(Object.keys(m.models)).toEqual(["enemy.grunt", "enemy.shooter"]);
    expect(m.models["enemy.grunt"].clips?.Running).toBe("Sprint_Loop");
    expect(m.models["enemy.shooter"].yaw).toBe(0);
    expect(m.models["enemy.shooter"].pitch).toBe(0);
    expect(m.models["enemy.shooter"].heightMul).toBe(1);
  });

  it("defaults fit to height and accepts size for flat models like ships", () => {
    const m = parseManifest({
      version: 1,
      models: {
        a: { file: "gen/a.glb", kind: "rigid" },
        b: { file: "gen/b.glb", kind: "rigid", fit: "size" },
        c: { file: "gen/c.glb", kind: "rigid", fit: "sideways" },
      },
    });
    expect(m.models.a.fit).toBe("height");
    expect(m.models.b.fit).toBe("size");
    expect(m.models.c.fit).toBe("height");
  });

  it("keeps the lazy flag (loaded on demand, not at boot)", () => {
    const m = parseManifest({
      version: 1,
      models: { g: { file: "gen/g.glb", kind: "rigid", lazy: true }, n: { file: "gen/n.glb", kind: "rigid" } },
    });
    expect(m.models.g.lazy).toBe(true);
    expect(m.models.n.lazy).toBe(false);
  });

  it("returns an empty manifest for garbage instead of throwing", () => {
    expect(parseManifest(null).models).toEqual({});
    expect(parseManifest("nope").models).toEqual({});
    expect(parseManifest({ version: 2, models: {} }).models).toEqual({});
  });

  it("drops entries that are malformed but keeps the good ones", () => {
    const m = parseManifest({
      version: 1,
      models: {
        good: { file: "gen/a.glb", kind: "rigid" },
        noFile: { kind: "rigid" },
        badKind: { file: "gen/b.glb", kind: "wobbly" },
        escapes: { file: "../../secret.glb", kind: "rigid" },
        absolute: { file: "https://evil.example/x.glb", kind: "rigid" },
      },
    });
    expect(Object.keys(m.models)).toEqual(["good"]);
  });
});

describe("resolveClip", () => {
  const clips = { Idle: "Idle_Loop", Walking: "Walk_Loop", Death: "Death01" };

  it("maps a game clip to the model's clip", () => {
    expect(resolveClip(clips, "Walking")).toBe("Walk_Loop");
  });

  it("falls back Running -> Walking -> Idle when a clip is missing", () => {
    expect(resolveClip(clips, "Running")).toBe("Walk_Loop");
    expect(resolveClip({ Idle: "Idle_Loop" }, "Running")).toBe("Idle_Loop");
  });

  it("returns null when nothing usable exists", () => {
    expect(resolveClip({}, "Running")).toBeNull();
    expect(resolveClip(undefined, "Idle")).toBeNull();
  });

  it("does not substitute a looping clip for Death", () => {
    expect(resolveClip({ Idle: "Idle_Loop" }, "Death")).toBeNull();
  });
});

describe("roles", () => {
  it("names enemy roles by kind", () => {
    expect(roleForEnemy("grunt")).toBe("enemy.grunt");
    expect(roleForEnemy("boss")).toBe("enemy.boss");
  });

  it("has a single player role on the website", () => {
    expect(PLAYER_ROLE).toBe("player.default");
  });
});
