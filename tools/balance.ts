// Balance harness: plays the real simulation with a simple bot and reports how
// runs go. Run:  server/node_modules/.bin/tsx tools/balance.ts [runs] [--no-dash] [--no-new]
//
// The bot kites away from nearby enemies, drifts to gems when it's quiet,
// holds fire at the nearest enemy, dashes when something gets too close, and
// picks level-up cards at random. It's a stand-in for an average player, good
// for comparing settings against each other, not for absolute truth.
import { dist } from "../src/core/math";
import { ARCHETYPES } from "../src/game/archetypes";
import { IDLE_INPUT, type PlayerInput } from "../src/game/types";
import { World } from "../src/game/world";

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => /^\d+$/.test(a)) ?? 24);
const USE_DASH = !args.includes("--no-dash");
const NEW_WEAPONS = !args.includes("--no-new");
const DAMAGE: Record<string, number> = {};
const MAX_SECONDS = 20 * 60;
const DT = 1 / 60;

const audio = new Proxy({ muted: false } as Record<string, unknown>, {
  get: (t, k) => (k in t ? t[k as string] : () => {}),
}) as never;

interface Result {
  died: number;
  kills: number;
  level: number;
  launchAt: number | null;
  capitalDownAt: number | null;
  loops: number;
  survived: boolean;
  /** Seconds spent in the first orbit before dying or beating the capital ship. */
  orbitSeconds: number | null;
}

function playOne(): Result {
  const w = new World(audio);
  w.reset([{ slot: 0, name: "BOT" }]);
  void ARCHETYPES;
  const res: Result = { died: 0, kills: 0, level: 1, launchAt: null, capitalDownAt: null, loops: 0, survived: false, orbitSeconds: null };
  let orbitStart: number | null = null;
  let prevPhase = w.phase;
  // Tally damage taken by size: 14 = Warden bullet, 26 = Warden touch, 8 = grunt/shooter, 16 = tank, etc.
  const orig = w.player.takeDamage.bind(w.player);
  w.player.takeDamage = (raw: number) => {
    const hurt = orig(raw);
    if (hurt) {
      const k = (w.phase === "surface" ? "" : w.phase + ":") + raw;
      DAMAGE[k] = (DAMAGE[k] ?? 0) + Math.max(1, raw - w.player.armor);
    }
    return hurt;
  };

  while (!w.gameOver && w.time < MAX_SECONDS) {
    const p = w.player;
    const inp: PlayerInput = { ...IDLE_INPUT };

    // Nearest enemy, and a flee vector from everything close.
    let nearest: { x: number; y: number; d: number } | null = null;
    let fx = 0;
    let fy = 0;
    for (const e of w.enemies) {
      if (e.dead) continue;
      const d = dist(p.x, p.y, e.x, e.y);
      if (!nearest || d < nearest.d) nearest = { x: e.x, y: e.y, d };
      if (d < 320) {
        const k = (e.isBoss ? 2.2 : 1) / Math.max(40, d);
        fx += ((p.x - e.x) / d) * k;
        fy += ((p.y - e.y) / d) * k;
      }
    }
    // Gentle pull toward the arena centre so the bot doesn't get pinned in a corner.
    fx += (-p.x / 1600) * 0.004;
    fy += (-p.y / 1600) * 0.004;
    // When it's quiet, go for gems.
    if (!nearest || nearest.d > 300) {
      let best: { x: number; y: number; d: number } | null = null;
      for (const g of w.gems) {
        if (g.dead) continue;
        const d = dist(p.x, p.y, g.x, g.y);
        if (!best || d < best.d) best = { x: g.x, y: g.y, d };
      }
      if (best && best.d < 500) {
        fx += ((best.x - p.x) / best.d) * 0.004;
        fy += ((best.y - p.y) / best.d) * 0.004;
      }
    }
    const fl = Math.hypot(fx, fy);
    if (fl > 1e-6) {
      inp.moveX = fx / fl;
      inp.moveY = fy / fl;
    }
    // A player focuses the boss when it's in range; otherwise shoots the nearest enemy.
    let target = nearest;
    for (const e of w.enemies) {
      if (e.dead || !e.isBoss) continue;
      const d = dist(p.x, p.y, e.x, e.y);
      if (d < 850) target = { x: e.x, y: e.y, d };
    }
    if (nearest && target) {
      const l = target.d || 1;
      inp.aimActive = true;
      inp.aimX = (target.x - p.x) / l;
      inp.aimY = (target.y - p.y) / l;
      inp.firing = true;
      if (USE_DASH && nearest.d < 70 && p.dashCd <= 0) inp.dash = true;
    }

    w.update(DT, [inp]);

    // Level-ups: pick a random card (optionally never the new weapons, for comparison).
    while (w.pendingLevelUps > 0) {
      let choices = w.rollUpgradeChoices(0);
      if (!NEW_WEAPONS) choices = choices.filter((u) => !u.id.startsWith("chain") && !u.id.startsWith("lance"));
      const pick = choices[Math.floor(Math.random() * choices.length)] ?? w.rollUpgradeChoices(0)[0];
      if (pick) w.applyUpgrade(0, pick);
      w.finishLevelUp();
    }

    if (w.phase !== prevPhase) {
      if (w.phase === "launch" && res.launchAt === null) res.launchAt = w.time;
      if (w.phase === "orbit" && orbitStart === null) orbitStart = w.time;
      if (w.phase === "descent" && orbitStart !== null && res.orbitSeconds === null) res.orbitSeconds = w.time - orbitStart;
      if (w.phase === "descent" && res.capitalDownAt === null) res.capitalDownAt = w.time;
      prevPhase = w.phase;
    }
  }
  if (orbitStart !== null && res.orbitSeconds === null) res.orbitSeconds = w.time - orbitStart;
  res.died = w.time;
  res.kills = w.kills;
  res.level = w.level;
  res.loops = w.loop;
  res.survived = !w.gameOver;
  return res;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

const results: Result[] = [];
for (let i = 0; i < RUNS; i++) results.push(playOne());

const died = results.map((r) => r.died);
const launched = results.filter((r) => r.launchAt !== null);
const cleared = results.filter((r) => r.capitalDownAt !== null);
console.log(`bot runs: ${RUNS}  dash: ${USE_DASH ? "on" : "off"}  new weapons offered: ${NEW_WEAPONS ? "yes" : "no"}`);
console.log(`survival time   median ${fmt(med(died))}   min ${fmt(Math.min(...died))}   max ${fmt(Math.max(...died))}`);
console.log(`kills           median ${med(results.map((r) => r.kills))}   level median ${med(results.map((r) => r.level))}`);
console.log(`beat the Warden (launched to orbit): ${launched.length}/${RUNS}` + (launched.length ? `   at median ${fmt(med(launched.map((r) => r.launchAt!)))}` : ""));
console.log(`beat the capital ship:               ${cleared.length}/${RUNS}` + (cleared.length ? `   at median ${fmt(med(cleared.map((r) => r.capitalDownAt!)))}` : ""));
console.log(`finished a full loop and survived into loop 2+: ${results.filter((r) => r.loops >= 1).length}/${RUNS}`);
console.log(`still alive at ${MAX_SECONDS / 60} min: ${results.filter((r) => r.survived).length}/${RUNS}`);
// Where do runs end? (surface before the Warden / orbit / later)
const bucket = (r: Result) => (r.launchAt === null ? "died before the Warden" : r.capitalDownAt === null ? "died in orbit" : "died after the capital ship");
const counts: Record<string, number> = {};
for (const r of results.filter((x) => !x.survived)) counts[bucket(r)] = (counts[bucket(r)] ?? 0) + 1;
console.log("where runs end:", JSON.stringify(counts));

if (args.includes("--damage")) {
  const total = Object.values(DAMAGE).reduce((a, b) => a + b, 0) || 1;
  console.log("damage taken by hit size (share of all damage):");
  for (const [k, v] of Object.entries(DAMAGE).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log("  hit " + k.padEnd(10) + " " + ((v / total) * 100).toFixed(0) + "%");
}

const inOrbit = results.filter((r) => r.orbitSeconds !== null);
const orbitDied = inOrbit.filter((r) => r.capitalDownAt === null && !r.survived);
if (inOrbit.length) console.log(`time in first orbit: median ${fmt(med(inOrbit.map((r) => r.orbitSeconds!)))}  (those who died there: median ${orbitDied.length ? fmt(med(orbitDied.map((r) => r.orbitSeconds!))) : "-"}, n=${orbitDied.length}; capital arrives at 0:40)`);
