/**
 * The generated-model manifest (public/models/manifest.json), written by the
 * Lux3D pipeline in tools/lux3d and read at boot. Pure data + validation, no
 * Three.js, so it can be unit-tested and never crashes the game: anything
 * malformed is dropped and that role falls back to the bundled robot.
 */
import type { EnemyKind } from "../game/config";

/** Clip names the game asks for; each model maps them onto its own clips. */
export type GameClip = "Idle" | "Walking" | "Running" | "Death";

export type ModelKind = "skinned" | "rigid";

export interface ModelEntry {
  /** Path relative to public/models/. */
  file: string;
  /** skinned = rigged and animated by Lux3D; rigid = animated procedurally in code. */
  kind: ModelKind;
  clips?: Partial<Record<GameClip, string>>;
  /** Extra Y rotation (radians) to make the model face the game's forward axis. */
  yaw: number;
  /** X rotation (radians) applied before yaw: lays down models generated standing up (nose-up ships). */
  pitch: number;
  /** Height relative to the reference robot (1 = same height). */
  heightMul: number;
  /** What heightMul measures: standing height (characters) or largest dimension (ships, rocks). */
  fit: "height" | "size";
  /** Loaded on demand (Forge gallery), not at boot. */
  lazy: boolean;
  /** Lit by its own texture instead of tinted (Forge bosses: Turbo output is dark, and a boss must read). */
  selfLit?: boolean;
  /** Name of a Lux3D part-split node that blows off in the boss's second stage. */
  breakPart?: string;
  /** Informational, from the pipeline: prompt and triangle count. */
  prompt?: string;
  tris?: number;
}

export interface Manifest {
  version: 1;
  models: Record<string, ModelEntry>;
}

export const PLAYER_ROLE = "player.default";
/** The squad's fighter in orbit. */
export const SHIP_ROLE = "player.ship";
export const roleForEnemy = (kind: EnemyKind): string => `enemy.${kind}`;

const GAME_CLIPS: readonly GameClip[] = ["Idle", "Walking", "Running", "Death"];
const SAFE_FILE = /^[a-z0-9][a-z0-9_\-./]*\.glb$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function parseEntry(raw: unknown): ModelEntry | null {
  if (!isObj(raw)) return null;
  const { file, kind } = raw;
  if (typeof file !== "string" || !SAFE_FILE.test(file) || file.includes("..")) return null;
  if (kind !== "skinned" && kind !== "rigid") return null;

  let clips: ModelEntry["clips"];
  if (isObj(raw.clips)) {
    clips = {};
    for (const c of GAME_CLIPS) {
      const v = raw.clips[c];
      if (typeof v === "string" && v) clips[c] = v;
    }
  }
  return {
    file,
    kind,
    clips,
    yaw: num(raw.yaw, 0),
    pitch: num(raw.pitch, 0),
    heightMul: num(raw.heightMul, 1) > 0 ? num(raw.heightMul, 1) : 1,
    fit: raw.fit === "size" ? "size" : "height",
    lazy: raw.lazy === true,
    breakPart: typeof raw.breakPart === "string" && raw.breakPart ? raw.breakPart : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    tris: typeof raw.tris === "number" ? raw.tris : undefined,
  };
}

export function parseManifest(raw: unknown): Manifest {
  const out: Manifest = { version: 1, models: {} };
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.models)) return out;
  for (const [role, entry] of Object.entries(raw.models)) {
    const parsed = parseEntry(entry);
    if (parsed) out.models[role] = parsed;
  }
  return out;
}

/** Fallback order when a model lacks a clip. Death never falls back to a loop. */
const FALLBACK: Record<GameClip, GameClip[]> = {
  Idle: ["Idle", "Walking"],
  Walking: ["Walking", "Running", "Idle"],
  Running: ["Running", "Walking", "Idle"],
  Death: ["Death"],
};

export function resolveClip(clips: ModelEntry["clips"], want: GameClip): string | null {
  if (!clips) return null;
  for (const c of FALLBACK[want]) {
    const name = clips[c];
    if (name) return name;
  }
  return null;
}
