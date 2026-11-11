/**
 * Forge: players type a boss idea, Lux3D turns it into a 3D model, and the
 * next boss in their run wears it. The Lux3D key lives only here on the
 * relay; the browser only ever sees a job id and, when done, the model URL.
 *
 * Every request spends real credits, so prompts are validated before any
 * call, each address is rate-limited, and the whole relay has a daily cap.
 */

export interface ForgeApi {
  /** Start a text-to-3D task; resolves to the Lux3D task id. */
  create(prompt: string): Promise<number>;
  get(taskId: number): Promise<{ status: number; outputs?: { content?: string | null }[] }>;
}

export type ForgeStatus =
  | { state: "pending"; prompt: string; elapsedMs: number }
  | { state: "ready"; prompt: string; url: string }
  | { state: "failed"; prompt: string }
  | { state: "unknown" };

export type ForgeRequest = { ok: true; id: string } | { ok: false; error: "bad_prompt" | "rate_limited" | "daily_cap" | "api_error" };

interface Job {
  taskId: number;
  prompt: string;
  createdAt: number;
  checkedAt: number;
  state: "pending" | "ready" | "failed";
  url?: string;
}

const POLL_MS = 4_000;
const JOB_TTL_MS = 2 * 3600_000; // Lux3D result URLs expire after 2 h
const MAX_PROMPT = 120;

/** Normalize a player's prompt; null if unusable. */
export function cleanPrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f<>{}\\`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.length > MAX_PROMPT) return null;
  return s;
}

/** The player's idea, framed so Lux3D returns one readable, centered boss. */
export const bossPrompt = (idea: string): string =>
  `${idea}, a giant menacing boss creature for a sci-fi video game, full body, strong silhouette, centered, plain background`;

function firstGlb(outputs: { content?: string | null }[] | undefined): string | null {
  for (const o of outputs ?? []) {
    const c = (o?.content ?? "").trim();
    if (!/^https?:\/\//i.test(c)) continue;
    try {
      if (new URL(c).pathname.toLowerCase().endsWith(".glb")) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

export class Forge {
  private readonly jobs = new Map<string, Job>();
  private readonly perIp = new Map<string, number[]>();
  private day: number[] = [];

  constructor(
    private readonly api: ForgeApi,
    private readonly now: () => number = Date.now,
    private readonly limits = { perIpPerHour: 3, perDay: 40 },
  ) {}

  async request(ip: string, rawPrompt: unknown): Promise<ForgeRequest> {
    const prompt = cleanPrompt(rawPrompt);
    if (!prompt) return { ok: false, error: "bad_prompt" };

    const t = this.now();
    this.day = this.day.filter((x) => t - x < 24 * 3600_000);
    if (this.day.length >= this.limits.perDay) return { ok: false, error: "daily_cap" };
    const mine = (this.perIp.get(ip) ?? []).filter((x) => t - x < 3600_000);
    if (mine.length >= this.limits.perIpPerHour) return { ok: false, error: "rate_limited" };

    let taskId: number;
    try {
      taskId = await this.api.create(bossPrompt(prompt));
    } catch (e) {
      console.error("forge create failed:", (e as Error).message);
      return { ok: false, error: "api_error" };
    }
    mine.push(t);
    if (this.perIp.size > 10_000) this.perIp.clear();
    this.perIp.set(ip, mine);
    this.day.push(t);

    this.prune(t);
    const id = Math.random().toString(36).slice(2, 10) + t.toString(36).slice(-4);
    this.jobs.set(id, { taskId, prompt, createdAt: t, checkedAt: t, state: "pending" });
    return { ok: true, id };
  }

  async status(id: string): Promise<ForgeStatus> {
    const job = this.jobs.get(id);
    if (!job) return { state: "unknown" };
    const t = this.now();
    if (job.state === "pending" && t - job.checkedAt >= POLL_MS) {
      job.checkedAt = t;
      try {
        const d = await this.api.get(job.taskId);
        if (d.status === 3) {
          const url = firstGlb(d.outputs);
          if (url) {
            job.state = "ready";
            job.url = url;
          } else job.state = "failed";
        } else if (d.status === 4 || d.status === 6) {
          job.state = "failed";
        }
      } catch (e) {
        console.error("forge poll failed:", (e as Error).message); // transient: try again next poll
      }
    }
    if (job.state === "ready") return { state: "ready", prompt: job.prompt, url: job.url! };
    if (job.state === "failed") return { state: "failed", prompt: job.prompt };
    return { state: "pending", prompt: job.prompt, elapsedMs: t - job.createdAt };
  }

  private prune(t: number): void {
    for (const [id, job] of this.jobs) if (t - job.createdAt > JOB_TTL_MS) this.jobs.delete(id);
  }
}

const BASE = "https://api.aholo.ai";

/** The real Lux3D API: G1-Turbo text-to-3D at the minimum face count, GLB only (fastest, cheapest). */
export function lux3dForgeApi(apiKey: string, base = BASE): ForgeApi {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as { c?: string; m?: string; d?: unknown };
    if (!res.ok || json.c !== "0") throw new Error(`${path}: HTTP ${res.status} c=${json.c} ${json.m ?? ""}`);
    return json.d;
  };
  return {
    create: async (prompt) =>
      (await call("POST", "/global/lux3d/v1/generate/text-to-3d/task/create", {
        prompt,
        style: "cyberpunk",
        version: "G1-Turbo",
        faceCount: 10000,
        outputFormat: ["glb"],
        enablePbr: true,
        aiPredictSize: false,
      })) as number,
    get: async (taskId) =>
      (await call("GET", `/global/lux3d/v1/generate/task/get?taskid=${encodeURIComponent(taskId)}`)) as {
        status: number;
        outputs?: { content?: string }[];
      },
  };
}
