/**
 * Boss intro: when a boss arrives the camera swoops over to it, holds while
 * its name fills the screen, then swoops back. Purely presentational (the
 * simulation makes players briefly invulnerable so it never costs a hit), so
 * co-op clients and spectators run it locally from the synced enemies.
 */
import { BOSS_INTRO_SECONDS } from "../game/config";

export const INTRO_SECONDS = BOSS_INTRO_SECONDS;
const IN = 0.7;
const OUT = 0.7;

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** 0 = camera on the player, 1 = camera on the boss, for `t` seconds into the intro. */
export function introWeight(t: number): number {
  if (t <= 0 || t >= INTRO_SECONDS) return 0;
  if (t < IN) return ease(t / IN);
  if (t > INTRO_SECONDS - OUT) return ease((INTRO_SECONDS - t) / OUT);
  return 1;
}
