import { clamp } from "../core/math";
import { WORLD } from "./config";

/** Distance from the wall (world units) at which the edge warning starts. */
export const EDGE_WARN = 300;

/** Distance from the player to the nearest wall of the square arena (negative if outside). */
export const edgeDistance = (x: number, y: number): number => WORLD.half - Math.max(Math.abs(x), Math.abs(y));

/** 0 well inside, rising to 1 at the wall. */
export const edgeProximity = (x: number, y: number): number => clamp(1 - edgeDistance(x, y) / EDGE_WARN, 0, 1);

/**
 * Where a ship that touches the wall ends up: position clamped inside, and the velocity
 * component pointing out of the arena reversed and damped, so you bounce off the light
 * wall instead of sticking to it.
 */
export function bounceOffWall(
  x: number, y: number, vx: number, vy: number, restitution = 0.35,
): { x: number; y: number; vx: number; vy: number } {
  const H = WORLD.half;
  let nvx = vx;
  let nvy = vy;
  if (x > H || x < -H) nvx = -vx * restitution;
  if (y > H || y < -H) nvy = -vy * restitution;
  return { x: clamp(x, -H, H), y: clamp(y, -H, H), vx: nvx, vy: nvy };
}
