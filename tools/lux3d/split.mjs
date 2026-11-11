#!/usr/bin/env node
// Lux3D part split for one generated asset: node tools/lux3d/split.mjs enemy.capital --yes
// Uses the asset's saved Lux3D GLB URL (valid 2 h after generation), downloads the
// split GLB to tools/lux3d/raw/<id>.parts.glb and lists the parts it contains.
// Resumable: the split task id is saved in state.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Lux3D } from "./client.mjs";
import { parseEnv, pickGlb, taskState } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const STATE_FILE = join(HERE, "state.json");
const id = process.argv[2];
const SPEND = process.argv.includes("--yes");
if (!id) throw new Error("usage: split.mjs <asset id> [--yes]");

const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
const st = state[id];
if (!st?.glbUrl) throw new Error(`${id} has no Lux3D GLB URL in state.json`);
const env = { ...parseEnv(existsSync(join(ROOT, ".env.local")) ? readFileSync(join(ROOT, ".env.local"), "utf8") : ""), ...process.env };
const api = new Lux3D(env.LUX3D_API_KEY, env.LUX3D_BASE_URL);
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

if (!st.splitTask) {
  if (Date.now() - Date.parse(st.glbUrlAt) > 110 * 60_000) throw new Error("GLB URL expired; regenerate or upload via the Asset API");
  if (!SPEND) {
    console.log(`DRY RUN: would part-split ${id} (add --yes)`);
    process.exit(0);
  }
  st.splitTask = await api.partSplit(st.glbUrl);
  save();
  console.log(`split task ${st.splitTask} created`);
}

const start = Date.now();
let outputs;
for (;;) {
  const d = await api.getTask(st.splitTask);
  const s = taskState(d.status);
  if (s === "succeeded") {
    outputs = d.outputs || [];
    break;
  }
  if (s === "failed") throw new Error(`split failed: ${JSON.stringify(d.outputs)}`);
  if (Date.now() - start > 30 * 60_000) throw new Error("split still running after 30 min");
  await new Promise((r) => setTimeout(r, 5000));
}
const url = pickGlb(outputs);
if (!url) throw new Error(`split returned no GLB: ${JSON.stringify(outputs)}`);
const file = join(HERE, "raw", `${id.replace(/\./g, "-")}.parts.glb`);
writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
st.partsFile = file;
st.splitMs = Date.now() - start;
save();

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(file);
const root = doc.getRoot();
console.log(`split done in ${(st.splitMs / 1000).toFixed(0)}s: ${root.listMeshes().length} meshes, ${root.listNodes().length} nodes`);
const parts = [];
for (const n of root.listNodes()) {
  const m = n.getMesh();
  if (!m) continue;
  let tris = 0;
  for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  parts.push({ n, tris });
  console.log(`  ${n.getName() || "(unnamed)"}  mesh=${m.getName() || "-"}  tris=${tris}`);
}

// --install <breakName>: name the biggest part "hull" and the rest "<breakName>",
// shrink it, and make it this asset's game model with that part breakable.
const i = process.argv.indexOf("--install");
if (i >= 0) {
  const breakName = process.argv[i + 1] || "part";
  parts.sort((a, b) => b.tris - a.tris);
  parts.forEach((p, k) => p.n.setName(k === 0 ? "hull" : parts.length > 2 ? `${breakName}${k}` : breakName));
  const named = join(HERE, "raw", `${id.replace(/\./g, "-")}.parts.named.glb`);
  await io.write(named, doc);

  const { optimizeGlb } = await import("./optimize.mjs");
  const { findSpec } = await import("./cast.mjs");
  const spec = findSpec(id);
  const out = join(ROOT, "public/models/gen", `${id.replace(/\./g, "-")}.glb`);
  const r = await optimizeGlb(named, out, spec);
  const manifestFile = join(ROOT, "public/models/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.models[id] = { ...manifest.models[id], tris: r.trisAfter, breakPart: breakName };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  const logFile = join(HERE, "log", `${id.replace(/\./g, "-")}.json`);
  const log = JSON.parse(readFileSync(logFile, "utf8"));
  log.partSplit = { task: st.splitTask, ms: st.splitMs, parts: parts.map((p) => ({ name: p.n.getName(), tris: p.tris })) };
  writeFileSync(logFile, JSON.stringify(log, null, 2) + "\n");
  console.log(`installed ${out} (${r.trisAfter} tris), breakable part "${breakName}"`);
}
