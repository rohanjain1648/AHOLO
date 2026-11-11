/**
 * The Forge gallery: bosses pre-forged with Lux3D, used when live Forge can't
 * run (relay offline, rate limit, daily cap, or no credits left). The game is
 * honest about it: the player is told they got a pre-forged boss.
 */

export interface GalleryBoss {
  role: string;
  prompt: string;
}

const STOP = new Set([
  "a", "an", "the", "of", "with", "and", "made", "in", "on", "to", "for", "its", "it", "that", "is", "giant", "huge", "big",
]);

/** Lowercased content words with a trailing plural "s" dropped. */
function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (STOP.has(w) || w.length < 3) continue;
    out.add(w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

/** The gallery boss closest to the player's idea by shared words; random when none match. */
export function pickGalleryBoss(idea: string, gallery: readonly GalleryBoss[], rand: () => number = Math.random): GalleryBoss | null {
  if (gallery.length === 0) return null;
  const want = words(idea);
  let best: GalleryBoss | null = null;
  let bestScore = 0;
  for (const g of gallery) {
    let score = 0;
    for (const w of words(g.prompt)) {
      for (const v of want) if (w === v || (w.length > 4 && v.length > 4 && (w.startsWith(v) || v.startsWith(w)))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best ?? gallery[Math.min(gallery.length - 1, Math.floor(rand() * gallery.length))];
}
