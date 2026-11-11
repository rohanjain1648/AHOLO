#!/usr/bin/env node
// Lux3D asset pipeline: generate -> (auto-rig -> retarget) -> download -> optimize -> manifest.
//
// Run with node directly: PowerShell swallows the "--" in "npm run assets -- ...".
//
//   node tools/lux3d/generate.mjs                          dry run (spends nothing)
//   node tools/lux3d/generate.mjs --yes                    run the pipeline (spends credits)
//   node tools/lux3d/generate.mjs --only enemy.grunt --yes
//   node tools/lux3d/generate.mjs --phase land --yes
//   node tools/lux3d/generate.mjs --reset enemy.grunt      forget saved state (regenerate)
//   node tools/lux3d/generate.mjs --only enemy.grunt --reoptimize enemy.grunt   redo the free shrink step
//
// Resumable: task ids and result URLs are saved to tools/lux3d/state.json after
// every step, so a crash or Ctrl+C never pays for the same task twice. Result
// URLs expire after 2 hours, so finish an interrupted asset within that window.
// The API key is read from aholo/.env.local (LUX3D_API_KEY) and never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CAST } from "./cast.mjs";
import { Lux3D } from "./client.mjs";
import { autoClipMap, nextStep, parseEnv, pickGlb, rigError, taskState } from "./lib.mjs";
import { optimizeGlb } from "./optimize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const STATE_FILE = join(HERE, "state.json");
const RAW_DIR = join(HERE, "raw");
const LOG_DIR = join(HERE, "log");
const GEN_DIR = join(ROOT, "public/models/gen");
const MANIFEST = join(ROOT, "public/models/manifest.json");

const URL_TTL_MS = 110 * 60 * 1000; // Lux3D result URLs live 2 h; leave margin
const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

// --- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SPEND = flag("--yes");
const only = opt("--only")?.split(",");
const phase = opt("--phase");
const reset = opt("--reset");
const reoptimize = opt("--reoptimize"); // re-run only the free local shrink step for an id
const concurrency = Number(opt("--concurrency") || 3);

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback);
const writeJson = (f, v) => {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
};

const state = readJson(STATE_FILE, {});
const saveState = () => writeJson(STATE_FILE, state);

if (reset) {
  delete state[reset];
  saveState();
  console.log(`reset ${reset}`);
  process.exit(0);
}
if (reoptimize && state[reoptimize]) {
  state[reoptimize].optimized = false;
  saveState();
}

const env = { ...parseEnv(existsSync(join(ROOT, ".env.local")) ? readFileSync(join(ROOT, ".env.local"), "utf8") : ""), ...process.env };
const fileId = (id) => id.replace(/\./g, "-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// --- steps ------------------------------------------------------------------
async function poll(api, taskId, label) {
  const start = Date.now();
  for (;;) {
    const d = await api.getTask(taskId);
    const s = taskState(d.status);
    if (s === "succeeded") return { outputs: d.outputs || [], ms: Date.now() - start };
    if (s === "failed") {
      const detail = (d.outputs || []).map((o) => (o && o.content) || "").map((c) => rigError(c) || c).filter(Boolean).join("; ");
      throw new Error(`${label}: task ${taskId} ended with status ${d.status}${detail ? `: ${detail}` : ""}`);
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) throw new Error(`${label}: task ${taskId} still running after 30 min`);
    await sleep(POLL_MS);
  }
}

function freshUrl(st, key) {
  const at = st[`${key}At`];
  if (at && Date.now() - Date.parse(at) > URL_TTL_MS) {
    throw new Error(`${key} expired (Lux3D URLs last 2 h). Run with --reset to regenerate this asset.`);
  }
  return st[key];
}

async function download(url, file) {
  // Large files over a long link sometimes drop mid-transfer ("terminated"); retry a few times.
  let buf;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(3000 * attempt);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
  return buf.length;
}

/** Create a task (only with --yes) or resume the saved one, then wait for it. */
async function runTask(api, spec, st, key, create) {
  const idKey = `${key}Task`;
  if (!st[idKey]) {
    if (!SPEND) return null;
    st[idKey] = await create();
    st[`${key}CreatedAt`] = now();
    saveState();
    console.log(`  ${spec.id}: ${key} task ${st[idKey]} created`);
  } else {
    console.log(`  ${spec.id}: resuming ${key} task ${st[idKey]}`);
  }
  const { outputs, ms } = await poll(api, st[idKey], `${spec.id} ${key}`);
  st.timings = { ...st.timings, [key]: ms };
  return outputs;
}

async function processAsset(api, spec) {
  const st = (state[spec.id] ||= {});
  for (;;) {
    const step = nextStep(spec, st);
    if (step === "done") return "done";

    if (step === "generate") {
      if (!SPEND && !st.generateTask) return "would generate";
      const outputs = await runTask(api, spec, st, "generate", () =>
        api.textTo3d({ prompt: spec.prompt, style: spec.style, version: spec.version || "G1", faceCount: spec.faceCount || 10000 }),
      );
      const url = pickGlb(outputs);
      if (!url) throw new Error(`${spec.id}: generation succeeded but returned no GLB: ${JSON.stringify(outputs)}`);
      st.glbUrl = url;
      st.glbUrlAt = now();
      saveState();
      await download(url, join(RAW_DIR, `${fileId(spec.id)}.base.glb`)); // kept for the report's iteration shots
    } else if (step === "rig") {
      if (!SPEND && !st.rigTask) return "would rig";
      const modelUrl = freshUrl(st, "glbUrl");
      const outputs = await runTask(api, spec, st, "rig", () => api.rig(modelUrl));
      const content = outputs[0] && outputs[0].content;
      const err = rigError(content);
      if (err) throw new Error(`${spec.id}: auto-rig failed: ${err}`);
      st.rigUrl = content.trim();
      st.rigUrlAt = now();
      saveState();
    } else if (step === "retarget") {
      if (!SPEND && !st.retargetTask) return "would retarget";
      const rigUrl = freshUrl(st, "rigUrl");
      const outputs = await runTask(api, spec, st, "retarget", () => api.retarget(rigUrl, spec.anims));
      const url = pickGlb(outputs);
      if (!url) throw new Error(`${spec.id}: retarget returned no GLB: ${JSON.stringify(outputs)}`);
      st.animUrl = url;
      st.animUrlAt = now();
      saveState();
    } else if (step === "download") {
      const url = spec.rig === "humanoid" ? freshUrl(st, "animUrl") : freshUrl(st, "glbUrl");
      const file = join(RAW_DIR, `${fileId(spec.id)}.glb`);
      st.rawBytes = await download(url, file);
      st.rawFile = file;
      saveState();
    } else if (step === "optimize") {
      const out = join(GEN_DIR, `${fileId(spec.id)}.glb`);
      mkdirSync(GEN_DIR, { recursive: true });
      const r = await optimizeGlb(st.rawFile, out, spec);
      const kind = spec.rig === "humanoid" ? "skinned" : "rigid";
      const clips = kind === "skinned" ? autoClipMap(r.clips) : undefined;
      const manifest = readJson(MANIFEST, { version: 1, models: {} });
      manifest.models[spec.id] = {
        file: `gen/${fileId(spec.id)}.glb`,
        kind,
        ...(clips ? { clips } : {}),
        yaw: spec.yaw ?? 0,
        pitch: spec.pitch ?? 0,
        heightMul: spec.heightMul ?? 1,
        fit: spec.fit ?? "height",
        prompt: spec.prompt,
        tris: r.trisAfter,
      };
      writeJson(MANIFEST, manifest);
      st.optimized = true;
      saveState();
      writeJson(join(LOG_DIR, `${fileId(spec.id)}.json`), {
        id: spec.id,
        prompt: spec.prompt,
        style: spec.style,
        rig: spec.rig,
        anims: spec.anims || [],
        tasks: { generate: st.generateTask, rig: st.rigTask, retarget: st.retargetTask },
        timingsMs: st.timings || {},
        trisFromLux3D: r.trisBefore,
        trisInGame: r.trisAfter,
        clips: r.clips,
        rawBytes: st.rawBytes,
        finishedAt: now(),
      });
      console.log(`  ${spec.id}: done, ${r.trisBefore} -> ${r.trisAfter} tris, clips [${r.clips.join(", ")}]`);
    }
  }
}

// --- main -------------------------------------------------------------------
const specs = CAST.filter((s) => (!only || only.includes(s.id)) && (!phase || s.phase === phase));
if (specs.length === 0) {
  console.error("No cast entries match. Ids:", CAST.map((s) => s.id).join(", "));
  process.exit(1);
}

let api = null;
const needsApi = specs.some((s) => nextStep(s, state[s.id] || {}) !== "done" && nextStep(s, state[s.id] || {}) !== "optimize");
if (needsApi && (SPEND || specs.some((s) => state[s.id] && state[s.id].generateTask))) {
  api = new Lux3D(env.LUX3D_API_KEY, env.LUX3D_BASE_URL);
}

console.log(`${SPEND ? "RUN" : "DRY RUN (add --yes to spend credits)"}: ${specs.length} asset(s)`);
const queue = [...specs];
const results = [];
await Promise.all(
  Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      try {
        const r = await processAsset(api, spec);
        results.push([spec.id, r]);
      } catch (err) {
        results.push([spec.id, `FAILED: ${err.message}`]);
      }
    }
  }),
);
for (const [id, r] of results) console.log(`${id.padEnd(18)} ${r}`);
if (results.some(([, r]) => String(r).startsWith("FAILED"))) process.exitCode = 1;
