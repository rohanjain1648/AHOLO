// Thin Lux3D REST client (Aholo Open Platform, OpenAPI at
// https://labs.aholo.ai/api-docs/en/openapi.en.json). Auth is the raw API
// key in the Authorization header, no "Bearer" prefix. Every create call
// returns a task id; results come from one shared task query endpoint.

const DEFAULT_BASE = "https://api.aholo.ai";

export class Lux3D {
  constructor(apiKey, baseUrl = DEFAULT_BASE) {
    if (!apiKey) throw new Error("LUX3D_API_KEY is not set (put it in aholo/.env.local)");
    this.key = apiKey;
    this.base = baseUrl.replace(/\/$/, "");
  }

  async call(method, path, { body, query } = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.key, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!res.ok || json.c !== "0") {
      throw new Error(`${method} ${path}: HTTP ${res.status} c=${json.c} m=${json.m || ""} f=${JSON.stringify(json.f || null)}`);
    }
    return json.d;
  }

  textTo3d({ prompt, style, version, faceCount, img }) {
    return this.call("POST", "/global/lux3d/v1/generate/text-to-3d/task/create", {
      body: { prompt, style, version, faceCount, img, outputFormat: ["glb"], enablePbr: true, aiPredictSize: false },
    });
  }

  imgTo3d({ img, version, faceCount }) {
    return this.call("POST", "/global/lux3d/v1/generate/img-to-3d/task/create", {
      body: { img, version, faceCount, outputFormat: ["glb"], enablePbr: true, aiPredictSize: false },
    });
  }

  rig(modelUrl) {
    return this.call("POST", "/global/lux3d/v1/animations/rig/task/create", { body: { modelUrl } });
  }

  retarget(rigModelUrl, animationIds) {
    return this.call("POST", "/global/lux3d/v1/animations/retarget/task/create", {
      body: { rigModelUrl, animationIds, animationOutputMode: "combined", outFormat: "glb", animateInPlace: true },
    });
  }

  partSplit(glbUrl) {
    return this.call("POST", "/global/lux3d/v1/part-split/task/create", { body: { glbUrl } });
  }

  materialTransfer(meshUrl, img) {
    return this.call("POST", "/global/lux3d/v1/generate/material-transfer/task/create", {
      body: { meshUrl, img, version: "v3.0-standard", outputFormat: ["glb"] },
    });
  }

  getTask(taskid) {
    return this.call("GET", "/global/lux3d/v1/generate/task/get", { query: { taskid } });
  }
}
