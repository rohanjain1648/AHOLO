import * as THREE from "three";
import { clamp } from "../core/math";
import { edgeProximity } from "../game/arena";
import { COOP, PALETTE, PLAYER, WORLD } from "../game/config";
import type { EnemyKind } from "../game/config";
import type { World } from "../game/world";
import type { Rect } from "./screens";

export const formatTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

function bar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  frac: number,
  color: string,
  bg = "rgba(255,255,255,0.08)",
): void {
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  if (frac > 0) {
    ctx.fillStyle = color;
    roundRect(ctx, x, y, Math.max(h, w * clamp(frac, 0, 1)), h, h / 2);
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Touch-friendly ping button (co-op only), bottom-right above the safe area. */
export function pingButtonRect(w: number, h: number): Rect {
  return { x: w - 16 - 64, y: h - 16 - 64, w: 64, h: 64 };
}

/** Draw the in-game HUD in screen space (no camera transform). */
export function drawHud(
  ctx: CanvasRenderingContext2D,
  world: World,
  muted: boolean,
  w: number,
  h: number,
  camera?: THREE.Camera,
): void {
  const p = world.player;
  const pad = 16;

  // XP bar across the very top
  bar(ctx, 0, 0, w, 6, world.xp / world.xpToNext, PALETTE.xp, "rgba(255,255,255,0.05)");

  // Level chip (top-left)
  ctx.font = "800 15px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = PALETTE.xp;
  ctx.fillText(`LV ${world.level}`, pad, 14);

  // HP bar (top-left, under level)
  const hpW = Math.min(240, w * 0.4);
  bar(ctx, pad, 36, hpW, 14, p.hp / p.maxHp, p.hp / p.maxHp < 0.35 ? PALETTE.danger : "#4dff9b");
  ctx.font = "700 12px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = PALETTE.text;
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.max(0, Math.ceil(p.hp))} / ${p.maxHp}`, pad + 8, 36 + 7);

  // Dash meter (under HP): fills as it recharges, lights up when ready.
  const dashReady = p.dashCd <= 0;
  const dashFrac = dashReady ? 1 : 1 - p.dashCd / PLAYER.dash.cooldown;
  bar(ctx, pad, 56, hpW * 0.55, 6, dashFrac, dashReady ? PALETTE.player : "rgba(63,233,255,0.4)", "rgba(255,255,255,0.08)");
  ctx.font = "800 10px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = dashReady ? PALETTE.player : "rgba(230,244,255,0.5)";
  ctx.fillText(dashReady ? "DASH  SHIFT / E" : "DASH", pad + hpW * 0.55 + 8, 59);

  // Timer + kills (top-center)
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = PALETTE.text;
  ctx.font = "900 34px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(formatTime(world.time), w / 2, 14);
  ctx.font = "700 14px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = "rgba(230,244,255,0.7)";
  ctx.fillText(`${world.kills} killed`, w / 2, 52);

  // Boss bar (center, below timer)
  const bossFrac = world.bossHpFraction;
  if (bossFrac != null) {
    const bw = Math.min(420, w * 0.6);
    ctx.font = "800 12px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#ffd27a";
    const label = world.bossLabel;
    ctx.fillText(`◆ ${label.length > 40 ? label.slice(0, 39) + "…" : label} ◆`, w / 2, 74);
    bar(ctx, w / 2 - bw / 2, 90, bw, 12, bossFrac, "#ffcf5a", "rgba(255,80,80,0.15)");
  }

  // Weapon chips (bottom-left)
  const chips: { icon: string; lvl: number; color: string }[] = [
    { icon: "➤", lvl: p.blaster, color: PALETTE.bullet },
  ];
  if (p.orbital > 0) chips.push({ icon: "◉", lvl: p.orbital, color: PALETTE.orbital });
  if (p.nova > 0) chips.push({ icon: "◎", lvl: p.nova, color: PALETTE.nova });
  if (p.chain > 0) chips.push({ icon: "↯", lvl: p.chain, color: PALETTE.chain });
  if (p.lance > 0) chips.push({ icon: "▬", lvl: p.lance, color: PALETTE.lance });
  let cx = pad;
  const cy = h - 44;
  for (const c of chips) {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, cx, cy, 54, 30, 8);
    ctx.fill();
    ctx.fillStyle = c.color;
    ctx.font = "700 16px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(c.icon, cx + 8, cy + 15);
    ctx.fillStyle = PALETTE.text;
    ctx.font = "800 13px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(`${c.lvl}`, cx + 34, cy + 15);
    cx += 62;
  }

  // Mute indicator (top-right)
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.font = "700 13px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = "rgba(230,244,255,0.55)";
  ctx.fillText(muted ? "🔇 M" : "🔊 M", w - pad, 14);
  ctx.fillText(world.spectating ? "ESC menu" : world.players.length > 1 ? "ESC menu · G ping" : "ESC pause", w - pad, 34);

  drawEdgeWarning(ctx, world, w, h);
  if (world.phase === "orbit") drawRadar(ctx, world, w, h);

  if (world.players.length > 1) {
    drawTeammates(ctx, world, pad, 60);
    if (camera) drawEdgeArrows(ctx, world, camera, w, h);
    if (!world.spectating) drawPingButton(ctx, world, w, h);
  }
}

/** Radar size and position: bottom-right, clear of the co-op ping button. */
export function radarRect(w: number, h: number, coop: boolean): Rect {
  const s = Math.round(clamp(Math.min(w, h) * 0.26, 96, 168));
  const lift = coop ? 64 + 12 : 0;
  return { x: w - 16 - s, y: h - 16 - s - lift, w: s, h: s };
}

/** Sector name for a world position: columns A-D left to right, rows 1-4 top to bottom. */
export function sectorName(x: number, y: number): string {
  const half = WORLD.half;
  const col = clamp(Math.floor(((x + half) / (half * 2)) * 4), 0, 3);
  const row = clamp(Math.floor(((y + half) / (half * 2)) * 4), 0, 3);
  return `${"ABCD"[col]}${row + 1}`;
}

/**
 * Red vignette and a message when the ship nears the wall of the combat zone, so the
 * limit never comes as a surprise. Works on the surface too.
 */
function drawEdgeWarning(ctx: CanvasRenderingContext2D, world: World, w: number, h: number): void {
  if (world.phase === "launch" || world.phase === "descent") return;
  const prox = edgeProximity(world.player.x, world.player.y);
  if (prox < 0.25) return;
  const k = (prox - 0.25) / 0.75;
  const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 90);
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(255,40,70,0)");
  g.addColorStop(1, `rgba(255,40,70,${(0.45 * k * pulse).toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "900 15px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = `rgba(255,120,130,${(0.5 + 0.5 * k).toFixed(2)})`;
  ctx.fillText(world.phase === "orbit" ? "◄ COMBAT ZONE EDGE · TURN BACK ►" : "ARENA EDGE", w / 2, Math.round(h * 0.2));
}

const RADAR_DOT: Partial<Record<EnemyKind, string>> = {
  asteroid: "rgba(160,170,190,0.7)",
  kamikaze: "#ff9a3d",
  bomber: "#ff7ab0",
};

/**
 * Orbit radar: the whole combat zone as a square map (it IS a square, matching the real
 * limit), with sector grid, enemies, the capital ship, teammates and your own ship. This is
 * how you pick which part of the arena to fight in and fly there without guessing.
 */
function drawRadar(ctx: CanvasRenderingContext2D, world: World, w: number, h: number): void {
  const r = radarRect(w, h, world.players.length > 1);
  const half = WORLD.half;
  const sx = (x: number): number => r.x + ((x + half) / (half * 2)) * r.w;
  const sy = (y: number): number => r.y + ((y + half) / (half * 2)) * r.h;
  const p = world.player;
  const prox = edgeProximity(p.x, p.y);

  ctx.save();
  ctx.fillStyle = "rgba(4,10,24,0.72)";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // Sector grid (4 x 4).
  ctx.strokeStyle = "rgba(120,200,255,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo(r.x + (r.w * i) / 4, r.y);
    ctx.lineTo(r.x + (r.w * i) / 4, r.y + r.h);
    ctx.moveTo(r.x, r.y + (r.h * i) / 4);
    ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 4);
  }
  ctx.stroke();
  // Sector letters along the top, numbers down the left.
  ctx.font = "700 9px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(160,215,255,0.5)";
  for (let i = 0; i < 4; i++) {
    ctx.fillText("ABCD"[i], r.x + (r.w * (i + 0.5)) / 4, r.y + 2);
    ctx.textAlign = "left";
    ctx.fillText(`${i + 1}`, r.x + 3, r.y + (r.h * (i + 0.5)) / 4 - 4);
    ctx.textAlign = "center";
  }
  // Border: cyan, flashing red at the edge.
  ctx.lineWidth = 2;
  ctx.strokeStyle = prox > 0.25 ? `rgba(255,${Math.round(90 - 50 * prox)},80,0.95)` : "rgba(90,215,255,0.9)";
  ctx.strokeRect(r.x, r.y, r.w, r.h);

  // Enemies.
  for (const e of world.enemies) {
    if (e.dead) continue;
    const big = e.isBoss || e.kind === "capital";
    ctx.fillStyle = big ? "#ffcf5a" : RADAR_DOT[e.kind] ?? "#ff5a5a";
    const d = big ? 7 : e.kind === "asteroid" ? 3 : 3.5;
    if (big) {
      ctx.fillRect(sx(e.x) - d / 2, sy(e.y) - d / 2, d, d);
      ctx.strokeStyle = "rgba(255,207,90,0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx(e.x) - d, sy(e.y) - d, d * 2, d * 2);
    } else {
      ctx.fillRect(sx(e.x) - d / 2, sy(e.y) - d / 2, d, d);
    }
  }
  // Teammates.
  for (const o of world.players) {
    if (!o.active || o.slot === world.localSlot) continue;
    ctx.fillStyle = COOP.slotColors[o.slot] ?? PALETTE.player;
    ctx.beginPath();
    ctx.arc(sx(o.x), sy(o.y), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // You: a ship-shaped arrow pointing along your facing.
  ctx.translate(sx(p.x), sy(p.y));
  ctx.rotate(p.facing);
  ctx.fillStyle = PALETTE.player;
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-5, -4.5);
  ctx.lineTo(-2.5, 0);
  ctx.lineTo(-5, 4.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Caption: sector of the ship.
  ctx.font = "800 11px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(190,230,255,0.85)";
  ctx.fillText(`COMBAT ZONE · SECTOR ${sectorName(p.x, p.y)}`, r.x + r.w, r.y - 4);
}

/** Teammate rows under your HP bar: name in slot colour, mini HP bar, DOWN tag. */
function drawTeammates(ctx: CanvasRenderingContext2D, world: World, x: number, y: number): void {
  let row = 0;
  for (const p of world.players) {
    if (!p.active || p.slot === world.localSlot) continue;
    const ry = y + row * 22;
    const color = COOP.slotColors[p.slot] ?? PALETTE.player;
    ctx.font = "800 12px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.fillText(p.name, x, ry + 5);
    if (p.downed) {
      ctx.fillStyle = PALETTE.danger;
      ctx.fillText(`DOWN ${Math.round(p.reviveT * 100)}%`, x + 96, ry + 5);
    } else {
      bar(ctx, x + 96, ry, 90, 10, p.hp / p.maxHp, color);
    }
    row++;
  }
}

const proj = new THREE.Vector3();

/** Arrows on the screen edge toward teammates and pings that are off-screen. */
function drawEdgeArrows(ctx: CanvasRenderingContext2D, world: World, camera: THREE.Camera, w: number, h: number): void {
  const targets: { x: number; y: number; color: string; ping: boolean }[] = [];
  for (const p of world.players) {
    if (p.active && p.slot !== world.localSlot) {
      targets.push({ x: p.x, y: p.y, color: COOP.slotColors[p.slot] ?? PALETTE.player, ping: false });
    }
  }
  for (const pg of world.pings) targets.push({ x: pg.x, y: pg.y, color: COOP.slotColors[pg.slot] ?? PALETTE.player, ping: true });

  const margin = 28;
  for (const t of targets) {
    proj.set(t.x, 0, t.y).project(camera);
    let sx = (proj.x * 0.5 + 0.5) * w;
    let sy = (1 - (proj.y * 0.5 + 0.5)) * h;
    if (proj.z > 1) {
      // Behind the camera: mirror so the arrow still points the right way.
      sx = w - sx;
      sy = h - sy;
    }
    const onScreen = proj.z <= 1 && sx >= margin && sx <= w - margin && sy >= margin && sy <= h - margin;
    if (onScreen) continue;
    const cx = w / 2;
    const cy = h / 2;
    const a = Math.atan2(sy - cy, sx - cx);
    // Push the point out from the centre until it meets the inset screen rectangle.
    const kx = (w / 2 - margin) / Math.max(1e-6, Math.abs(Math.cos(a)));
    const ky = (h / 2 - margin) / Math.max(1e-6, Math.abs(Math.sin(a)));
    const k = Math.min(kx, ky);
    const ax = cx + Math.cos(a) * k;
    const ay = cy + Math.sin(a) * k;

    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(a);
    ctx.fillStyle = t.color;
    ctx.globalAlpha = t.ping ? 0.95 : 0.8;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -10);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fill();
    if (t.ping) {
      ctx.rotate(-a);
      ctx.font = "900 14px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", -Math.cos(a) * 22, -Math.sin(a) * 22);
    }
    ctx.restore();
  }
}

function drawPingButton(ctx: CanvasRenderingContext2D, world: World, w: number, h: number): void {
  const r = pingButtonRect(w, h);
  const ready = world.player.pingCd <= 0 && !world.player.downed;
  ctx.globalAlpha = ready ? 0.9 : 0.35;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, r.x, r.y, r.w, r.h, 32);
  ctx.fill();
  ctx.strokeStyle = COOP.slotColors[world.localSlot] ?? PALETTE.player;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = PALETTE.text;
  ctx.font = "900 26px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", r.x + r.w / 2, r.y + r.h / 2 - 4);
  ctx.font = "700 10px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("PING", r.x + r.w / 2, r.y + r.h - 14);
  ctx.globalAlpha = 1;
}
