import { PHASES, type Phase } from "./config";

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Big centered callout for the current phase, faded by `alpha`, or null when nothing to say. */
export function phaseCallout(phase: Phase, phaseT: number, loop: number): { title: string; sub: string; alpha: number } | null {
  const fade = (t: number, hold: number) => (t < hold ? 1 : Math.max(0, 1 - (t - hold) / 0.8));
  switch (phase) {
    case "launch":
      return { title: "LAUNCH", sub: "Breaking atmosphere", alpha: 1 };
    case "descent":
      return { title: "RE-ENTRY", sub: "Back to the surface", alpha: 1 };
    case "orbit": {
      const a = fade(phaseT, 2.2);
      return a > 0 ? { title: "ORBIT", sub: "Survive the fleet. Destroy the capital ship.", alpha: a } : null;
    }
    case "surface": {
      if (loop === 0) return null;
      const a = fade(phaseT, 2.2);
      return a > 0 ? { title: `SURFACE · LOOP ${loop + 1}`, sub: "The swarm is stronger", alpha: a } : null;
    }
  }
}

/**
 * How "in space" the view is: 0 on the surface, 1 in orbit, easing between
 * during launch and descent. The renderer drives the ground, stars, camera
 * height and robot-vs-ship visibility from this one number.
 */
export function spaceBlend(phase: Phase, phaseT: number): number {
  switch (phase) {
    case "surface":
      return 0;
    case "orbit":
      return 1;
    case "launch":
      return smooth(phaseT / PHASES.launchSeconds);
    case "descent":
      return 1 - smooth(phaseT / PHASES.descentSeconds);
  }
}
