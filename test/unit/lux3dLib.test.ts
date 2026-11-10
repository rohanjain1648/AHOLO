import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs tool module without type declarations
import * as lib from "../../tools/lux3d/lib.mjs";

describe("parseEnv", () => {
  it("reads KEY=VALUE lines, ignoring comments and quotes", () => {
    const env = lib.parseEnv('# comment\nLUX3D_API_KEY="abc123"\nOTHER=x=y\n\nBAD LINE\n');
    expect(env).toEqual({ LUX3D_API_KEY: "abc123", OTHER: "x=y" });
  });
});

describe("extractUrls", () => {
  it("finds URLs in plain strings, JSON strings and nested objects", () => {
    expect(lib.extractUrls("https://cdn.example/a.glb")).toEqual(["https://cdn.example/a.glb"]);
    const json = JSON.stringify({ actions: [{ id: "Walk_Loop", url: "https://cdn.example/w.glb" }, { error: "x" }] });
    expect(lib.extractUrls(json)).toEqual(["https://cdn.example/w.glb"]);
  });

  it("ignores NOT_REQUESTED placeholders and junk", () => {
    expect(lib.extractUrls("NOT_REQUESTED")).toEqual([]);
    expect(lib.extractUrls(null)).toEqual([]);
  });
});

describe("pickGlb", () => {
  it("picks the GLB even when URLs carry signed query strings", () => {
    const outputs = [
      { content: "https://cdn.example/r.zip?sig=1" },
      { content: "https://cdn.example/r.glb?sig=2" },
    ];
    expect(lib.pickGlb(outputs)).toBe("https://cdn.example/r.glb?sig=2");
  });

  it("returns null when there is no GLB", () => {
    expect(lib.pickGlb([{ content: "https://cdn.example/r.zip" }])).toBeNull();
    expect(lib.pickGlb(undefined)).toBeNull();
  });
});

describe("taskState", () => {
  it("classifies Lux3D task statuses", () => {
    expect(lib.taskState(0)).toBe("pending");
    expect(lib.taskState(1)).toBe("pending");
    expect(lib.taskState(3)).toBe("succeeded");
    expect(lib.taskState(4)).toBe("failed");
    expect(lib.taskState(6)).toBe("failed");
  });
});

describe("rigError", () => {
  it("detects the JSON error a failed auto-rig returns", () => {
    expect(lib.rigError(JSON.stringify({ error: "not humanoid" }))).toBe("not humanoid");
    expect(lib.rigError("https://cdn.example/rigged.glb")).toBeNull();
  });
});

describe("autoClipMap", () => {
  it("maps retargeted clip names onto the game's clip names", () => {
    const map = lib.autoClipMap(["Idle_Loop", "Walk_Loop", "Sprint_Loop", "Death01", "Hit_Chest"]);
    expect(map).toEqual({ Idle: "Idle_Loop", Walking: "Walk_Loop", Running: "Sprint_Loop", Death: "Death01" });
  });

  it("prefers sprint over jog for Running but accepts jog", () => {
    expect(lib.autoClipMap(["Jog_Fwd_Loop"]).Running).toBe("Jog_Fwd_Loop");
  });
});

describe("nextStep", () => {
  const humanoid = { id: "enemy.grunt", rig: "humanoid" };
  const rigid = { id: "enemy.shooter", rig: "none" };

  it("walks a humanoid through generate, rig, retarget, download", () => {
    expect(lib.nextStep(humanoid, {})).toBe("generate");
    expect(lib.nextStep(humanoid, { glbUrl: "u" })).toBe("rig");
    expect(lib.nextStep(humanoid, { glbUrl: "u", rigUrl: "r" })).toBe("retarget");
    expect(lib.nextStep(humanoid, { glbUrl: "u", rigUrl: "r", animUrl: "a" })).toBe("download");
    expect(lib.nextStep(humanoid, { glbUrl: "u", rigUrl: "r", animUrl: "a", rawFile: "f" })).toBe("optimize");
    expect(lib.nextStep(humanoid, { rawFile: "f", optimized: true })).toBe("done");
  });

  it("skips rigging for rigid models", () => {
    expect(lib.nextStep(rigid, { glbUrl: "u" })).toBe("download");
  });
});
