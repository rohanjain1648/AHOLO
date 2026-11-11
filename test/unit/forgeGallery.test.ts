import { describe, expect, it } from "vitest";
import { pickGalleryBoss } from "../../src/forge/gallery";

const gallery = [
  { role: "forge.gallery.1", prompt: "a giant mechanical scorpion made of rusty scrap with a glowing green stinger" },
  { role: "forge.gallery.2", prompt: "a crystal golem made of glowing purple amethyst with molten lava cracks" },
  { role: "forge.gallery.3", prompt: "a colossal cyber dragon with neon blue circuit scales" },
];

describe("pickGalleryBoss", () => {
  it("picks the gallery boss sharing the most meaningful words with the player's idea", () => {
    expect(pickGalleryBoss("a huge dragon made of circuits", gallery, () => 0)?.role).toBe("forge.gallery.3");
    expect(pickGalleryBoss("Scorpion robot!!", gallery, () => 0)?.role).toBe("forge.gallery.1");
    expect(pickGalleryBoss("purple crystals", gallery, () => 0)?.role).toBe("forge.gallery.2");
  });

  it("matches simple plurals and ignores filler words like 'a', 'with', 'made'", () => {
    expect(pickGalleryBoss("dragons", gallery, () => 0)?.role).toBe("forge.gallery.3");
    expect(pickGalleryBoss("a thing made with a", gallery, () => 0.99)?.role).toBe("forge.gallery.3");
  });

  it("falls back to a random pick when nothing matches", () => {
    expect(pickGalleryBoss("banana", gallery, () => 0)?.role).toBe("forge.gallery.1");
    expect(pickGalleryBoss("banana", gallery, () => 0.99)?.role).toBe("forge.gallery.3");
  });

  it("returns null for an empty gallery", () => {
    expect(pickGalleryBoss("dragon", [], () => 0)).toBeNull();
  });
});
