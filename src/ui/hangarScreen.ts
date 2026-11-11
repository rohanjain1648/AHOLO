/**
 * Hangar overlay: the info card for the model on the turntable, plus
 * previous / next / back controls that work with mouse, keys and touch.
 */
import type { HangarInfo } from "../render/hangarInfo";
import { drawButton, fitFontSize, roundRect, type Rect } from "./screens";

export function hangarRects(w: number, h: number): { prev: Rect; next: Rect; back: Rect } {
  const s = Math.min(64, w * 0.12);
  const y = h * 0.45 - s / 2;
  const wide = w > h * 1.2;
  return {
    prev: { x: 16, y, w: s, h: s },
    next: { x: (wide ? w * 0.6 : w) - s - 16, y, w: s, h: s },
    back: { x: 16, y: 16, w: 112, h: 40 },
  };
}

/** Word-wrap `text` into lines no wider than `maxW` in the current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const CATEGORY_COLOR: Record<HangarInfo["category"], string> = {
  Land: "#3fe9ff",
  Space: "#9d7bff",
  "Forge gallery": "#ffb44d",
  "Forged this session": "#ffb44d",
};

export function drawHangar(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  time: number,
  info: HangarInfo | null,
  index: number,
  count: number,
  loading: boolean,
): void {
  const r = hangarRects(w, h);
  ctx.save();
  ctx.textBaseline = "middle";

  // Header
  ctx.textAlign = "center";
  ctx.fillStyle = "#eafcff";
  ctx.font = `900 ${Math.min(30, w * 0.06)}px 'Segoe UI', system-ui, sans-serif`;
  ctx.fillText("HANGAR", w / 2, 36);
  ctx.font = "600 13px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = "rgba(230,244,255,0.6)";
  ctx.fillText(`Every model in NOVA SWARM, generated with Aholo Lux3D  ·  ${index + 1} / ${count}`, w / 2, 62);

  drawButton(ctx, r.back, "← BACK", time, "#eafcff", 14);
  drawButton(ctx, r.prev, "‹", time, "#3fe9ff", 34);
  drawButton(ctx, r.next, "›", time, "#3fe9ff", 34);

  // Info card: right column on wide screens, bottom sheet otherwise.
  const wide = w > h * 1.2;
  const card: Rect = wide
    ? { x: w * 0.6, y: h * 0.2, w: w * 0.36, h: h * 0.62 }
    : { x: 16, y: h * 0.62, w: w - 32, h: h * 0.34 };
  roundRect(ctx, card.x, card.y, card.w, card.h, 16);
  ctx.fillStyle = "rgba(10,14,28,0.82)";
  ctx.fill();
  ctx.strokeStyle = "rgba(63,233,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const pad = 20;
  let y = card.y + pad + 8;
  ctx.textAlign = "left";
  if (loading || !info) {
    ctx.fillStyle = "rgba(230,244,255,0.7)";
    ctx.font = "600 16px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText("Loading model…", card.x + pad, y);
    ctx.restore();
    return;
  }

  const color = CATEGORY_COLOR[info.category];
  ctx.font = "800 12px 'Segoe UI', system-ui, sans-serif";
  const chip = info.category.toUpperCase();
  const cw = ctx.measureText(chip).width + 18;
  roundRect(ctx, card.x + pad, y - 11, cw, 22, 11);
  ctx.fillStyle = color + "33";
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(chip, card.x + pad + 9, y);
  y += 34;

  const nameSize = fitFontSize(ctx, info.name, 900, card.w - pad * 2, 28, 14);
  ctx.font = `900 ${nameSize}px 'Segoe UI', system-ui, sans-serif`;
  ctx.fillStyle = "#ffffff";
  for (const line of wrap(ctx, info.name, card.w - pad * 2).slice(0, 2)) {
    ctx.fillText(line, card.x + pad, y);
    y += nameSize * 1.15;
  }
  if (info.blurb) {
    ctx.font = "500 14px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "rgba(230,244,255,0.75)";
    for (const line of wrap(ctx, info.blurb, card.w - pad * 2).slice(0, 3)) {
      ctx.fillText(line, card.x + pad, y);
      y += 19;
    }
  }
  y += 14;

  if (info.prompt) {
    ctx.font = "800 11px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "rgba(230,244,255,0.5)";
    ctx.fillText("LUX3D PROMPT", card.x + pad, y);
    y += 20;
    ctx.font = "italic 500 14px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "rgba(230,244,255,0.9)";
    const lines = wrap(ctx, `“${info.prompt}”`, card.w - pad * 2);
    const maxLines = Math.max(2, Math.floor((card.y + card.h - y - 70) / 19));
    for (const line of lines.slice(0, maxLines)) {
      ctx.fillText(line, card.x + pad, y);
      y += 19;
    }
    y += 10;
  }

  ctx.font = "600 13px 'Segoe UI', system-ui, sans-serif";
  for (const f of info.facts) {
    if (y > card.y + card.h - 14) break;
    ctx.fillStyle = color;
    ctx.fillText("▸", card.x + pad, y);
    ctx.fillStyle = "rgba(230,244,255,0.85)";
    ctx.fillText(f, card.x + pad + 16, y);
    y += 21;
  }
  ctx.restore();
}
