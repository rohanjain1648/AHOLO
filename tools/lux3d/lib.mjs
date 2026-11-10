// Pure helpers for the Lux3D asset pipeline. No network, no filesystem, so
// they can be unit-tested (test/unit/lux3dLib.test.ts).

/** Minimal .env parser: KEY=VALUE lines, # comments, optional surrounding quotes. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const URL_RE = /^https?:\/\/\S+$/i;

/** Every http(s) URL in a value: a URL string, a JSON string, or a nested object. */
export function extractUrls(value) {
  const found = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (URL_RE.test(s)) found.push(s);
      else if (s.startsWith("{") || s.startsWith("[")) {
        try {
          walk(JSON.parse(s));
        } catch {
          /* not JSON */
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return found;
}

const extOf = (url) => {
  try {
    return new URL(url).pathname.split(".").pop().toLowerCase();
  } catch {
    return "";
  }
};

/** The first GLB URL among a task's outputs ([{content}]), or null. */
export function pickGlb(outputs) {
  if (!Array.isArray(outputs)) return null;
  for (const o of outputs) {
    for (const url of extractUrls(o && o.content)) if (extOf(url) === "glb") return url;
  }
  return null;
}

/** Lux3D task status → pending | succeeded | failed. */
export function taskState(status) {
  if (status === 3) return "succeeded";
  if (status === 4 || status === 6) return "failed";
  return "pending";
}

/** Auto-rigging returns a JSON string with `error` on failure; null when it is a URL. */
export function rigError(content) {
  if (typeof content !== "string") return "empty rig result";
  const s = content.trim();
  if (URL_RE.test(s)) return null;
  try {
    const j = JSON.parse(s);
    if (j && j.error) return String(j.error);
  } catch {
    /* fall through */
  }
  return null;
}

/** Map retargeted clip names onto the game's Idle / Walking / Running / Death. */
export function autoClipMap(names) {
  const find = (...patterns) => {
    for (const p of patterns) {
      const hit = names.find((n) => p.test(n));
      if (hit) return hit;
    }
    return undefined;
  };
  const map = {
    Idle: find(/^idle_loop$/i, /idle/i),
    Walking: find(/zombie_walk/i, /^walk_loop$/i, /walk/i),
    Running: find(/sprint/i, /jog/i, /run/i),
    Death: find(/death/i),
  };
  for (const k of Object.keys(map)) if (!map[k]) delete map[k];
  return map;
}

/** Which pipeline step an asset needs next, from its saved state. */
export function nextStep(spec, st) {
  if (st.optimized) return "done";
  if (st.rawFile) return "optimize";
  if (!st.glbUrl) return "generate";
  if (spec.rig === "humanoid") {
    if (!st.rigUrl) return "rig";
    if (!st.animUrl) return "retarget";
  }
  return "download";
}
