import { describe, expect, it } from "vitest";
import { hangarCatalog, hangarInfo } from "../../src/render/hangarInfo";
import type { ModelEntry } from "../../src/render/manifest";

const entry = (over: Partial<ModelEntry>): ModelEntry => ({
  file: "gen/x.glb", kind: "rigid", yaw: 0, pitch: 0, heightMul: 1, fit: "height", lazy: false, ...over,
});

describe("hangarInfo", () => {
  it("describes a rigged Lux3D character with its animations", () => {
    const info = hangarInfo("enemy.grunt", entry({
      kind: "skinned", tris: 5462, prompt: "a rusty robot soldier",
      clips: { Idle: "Idle_Loop", Walking: "Zombie_Walk_Fwd_Loop", Running: "Sprint_Loop", Death: "Death01" },
    }));
    expect(info.name).toBe("Grunt");
    expect(info.category).toBe("Land");
    expect(info.prompt).toBe("a rusty robot soldier");
    expect(info.facts).toContain("5,462 triangles");
    expect(info.facts).toContain("Auto-rigged and animated by Lux3D");
    expect(info.facts).toContain("Clips: Idle_Loop, Zombie_Walk_Fwd_Loop, Sprint_Loop, Death01");
    expect(info.blurb).toMatch(/swarm/i);
  });

  it("mentions part split on a model with a breakable part", () => {
    const info = hangarInfo("enemy.capital", entry({ breakPart: "bridge", tris: 9410 }));
    expect(info.name).toBe("Capital Ship");
    expect(info.category).toBe("Space");
    expect(info.facts.some((f) => f.includes("Part split"))).toBe(true);
  });

  it("names Forge models after their prompt", () => {
    const g = hangarInfo("forge.gallery.3", entry({ prompt: "a colossal cyber dragon", lazy: true }));
    expect(g.category).toBe("Forge gallery");
    expect(g.name).toBe("A Colossal Cyber Dragon");
    const live = hangarInfo("forge.boss.2", entry({ prompt: "a slime king" }));
    expect(live.category).toBe("Forged this session");
  });
});

describe("hangarCatalog", () => {
  it("orders land, space, then Forge, and leaves out unknown roles", () => {
    const roles = ["forge.gallery.1", "enemy.capital", "player.default", "enemy.grunt", "player.ship", "mystery.thing", "forge.boss.1"];
    expect(hangarCatalog(roles)).toEqual([
      "player.default", "enemy.grunt", "player.ship", "enemy.capital", "forge.boss.1", "forge.gallery.1",
    ]);
  });
});
