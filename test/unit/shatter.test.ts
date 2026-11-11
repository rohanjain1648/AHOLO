import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildChunkTemplates, cellOf } from "../../src/render/shatter";
import { introWeight, INTRO_SECONDS } from "../../src/render/bossIntro";

describe("cellOf", () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  it("puts points into one of 8 octants of the box", () => {
    expect(cellOf(new THREE.Vector3(-0.5, 0.5, -0.5), box, 2)).toBe(0);
    expect(cellOf(new THREE.Vector3(0.5, 1.5, 0.5), box, 2)).toBe(7);
  });
  it("clamps points on or outside the boundary", () => {
    expect(cellOf(new THREE.Vector3(1, 2, 1), box, 2)).toBe(7);
    expect(cellOf(new THREE.Vector3(-5, -5, -5), box, 2)).toBe(0);
  });
});

describe("buildChunkTemplates", () => {
  it("splits a mesh into pieces that together keep every triangle", () => {
    const body = new THREE.Group();
    const geo = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4); // 192 triangles spread over all octants
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.position.set(5, 0, 0); // baked into the pieces
    body.add(mesh);
    const chunks = buildChunkTemplates(body);
    expect(chunks.length).toBe(8);
    const tris = chunks.reduce((n, c) => n + c.geometry.getAttribute("position").count / 3, 0);
    expect(tris).toBe(192);
    for (const c of chunks) expect(c.center.x).toBeGreaterThan(3.5); // offset applied
  });

  it("returns nothing for an object without meshes", () => {
    expect(buildChunkTemplates(new THREE.Group())).toEqual([]);
  });
});

describe("introWeight", () => {
  it("swoops to the boss, holds, and returns to the player", () => {
    expect(introWeight(0)).toBe(0);
    expect(introWeight(INTRO_SECONDS * 0.5)).toBe(1);
    expect(introWeight(INTRO_SECONDS)).toBe(0);
    expect(introWeight(INTRO_SECONDS + 1)).toBe(0);
    expect(introWeight(0.2)).toBeGreaterThan(0);
    expect(introWeight(0.2)).toBeLessThan(1);
  });
});
