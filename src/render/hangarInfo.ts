/**
 * Hangar text: what each Lux3D model is called, which part of the game it
 * belongs to, the prompt that made it, and how the pipeline treated it.
 * Pure data, so it's unit-tested and the hangar screen only draws it.
 */
import type { ModelEntry } from "./manifest";

export interface HangarInfo {
  name: string;
  category: "Land" | "Space" | "Forge gallery" | "Forged this session";
  /** What it does in the game. */
  blurb: string;
  prompt: string | null;
  facts: string[];
}

const BLURBS: Record<string, string> = {
  "player.default": "You. Steer, aim, and build a run that clears the screen.",
  "enemy.grunt": "The bulk of the swarm. Shambles toward you in numbers.",
  "enemy.fast": "Sprinter. Arrives early and hits before you notice.",
  "enemy.tank": "Heavy brute. Soaks damage and stomps in slowly.",
  "enemy.splitter": "Bursts into two fast robots when destroyed.",
  "enemy.shooter": "Hovering turret drone that fires from range.",
  "enemy.boss": "Guardian of the surface. Kill it to launch into orbit.",
  "player.ship": "Your fighter in orbit: thrust, drift and bank.",
  "enemy.interceptor": "Weaves in on strafing runs and fires back.",
  "enemy.kamikaze": "Dives straight at you and detonates on contact.",
  "enemy.bomber": "Slow gunship with heavy side cannons.",
  "enemy.asteroid": "Drifts across the field. Shoot it apart for XP.",
  "enemy.capital": "Flagship of the swarm. Blow off its bridge, then finish it.",
};

/** Display order: the land cast, the space cast, then Forge bosses. */
const ORDER = [
  "player.default", "enemy.grunt", "enemy.fast", "enemy.tank", "enemy.splitter", "enemy.shooter", "enemy.boss",
  "player.ship", "enemy.interceptor", "enemy.kamikaze", "enemy.bomber", "enemy.asteroid", "enemy.capital",
];

const NAMES: Record<string, string> = {
  "player.default": "Hero",
  "enemy.grunt": "Grunt",
  "enemy.fast": "Fast",
  "enemy.tank": "Tank",
  "enemy.splitter": "Splitter",
  "enemy.shooter": "Shooter",
  "enemy.boss": "Warden",
  "player.ship": "Fighter",
  "enemy.interceptor": "Interceptor",
  "enemy.kamikaze": "Kamikaze",
  "enemy.bomber": "Bomber",
  "enemy.asteroid": "Asteroid",
  "enemy.capital": "Capital Ship",
};

const isForge = (role: string): boolean => role.startsWith("forge.");

/** Roles in hangar order; roles the hangar doesn't know are left out. */
export function hangarCatalog(roles: readonly string[]): string[] {
  const known = ORDER.filter((r) => roles.includes(r));
  const live = roles.filter((r) => r.startsWith("forge.boss.")).sort();
  const gallery = roles.filter((r) => r.startsWith("forge.gallery.")).sort();
  return [...known, ...live, ...gallery];
}

const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function hangarInfo(role: string, e: ModelEntry): HangarInfo {
  const category: HangarInfo["category"] = role.startsWith("forge.gallery.")
    ? "Forge gallery"
    : role.startsWith("forge.")
      ? "Forged this session"
      : ORDER.indexOf(role) >= ORDER.indexOf("player.ship")
        ? "Space"
        : "Land";
  const prompt = e.prompt ?? null;
  const name = isForge(role) ? titleCase(prompt ?? "Forged boss") : NAMES[role] ?? role;

  const facts: string[] = [];
  if (e.tris) facts.push(`${e.tris.toLocaleString("en-US")} triangles`);
  if (e.kind === "skinned") {
    facts.push("Auto-rigged and animated by Lux3D");
    const clips = [...new Set(Object.values(e.clips ?? {}))];
    if (clips.length) facts.push(`Clips: ${clips.join(", ")}`);
  } else {
    facts.push(isForge(role) ? "Generated in ~2 min with G1-Turbo" : "Rigid: motion done in code");
  }
  if (e.breakPart) facts.push(`Part split: the ${e.breakPart} breaks off in stage two`);
  const blurb = BLURBS[role] ?? (isForge(role) ? "A boss someone typed into the Forge. It hunts you as your next boss." : "");
  return { name, category, blurb, prompt, facts };
}
