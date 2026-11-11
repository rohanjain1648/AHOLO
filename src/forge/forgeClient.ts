/**
 * Browser side of Forge: send a boss idea to the relay, poll the Lux3D job,
 * and hand the finished model URL to the game. The relay holds the Lux3D key;
 * this never sees it. Call `tick()` every frame; it polls at most every 4 s.
 */

export type ForgeState =
  | { kind: "off" }
  | { kind: "idle" }
  | { kind: "sending"; prompt: string }
  | { kind: "pending"; prompt: string; elapsedMs: number }
  | { kind: "ready"; prompt: string; url: string }
  | { kind: "failed"; prompt: string; reason: string };

const POLL_MS = 4000;

export class ForgeClient {
  state: ForgeState = { kind: "off" };
  /** Fired once when a forged model is ready to load. */
  onReady: ((url: string, prompt: string) => void) | null = null;
  private id: string | null = null;
  private lastPoll = 0;
  private polling = false;
  private announced = false;

  constructor(
    private readonly base: string | null,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = () => performance.now(),
  ) {}

  async checkAvailable(): Promise<void> {
    if (!this.base) return;
    try {
      const r = (await (await this.fetchFn(`${this.base}/forge`)).json()) as { on?: boolean };
      if (r.on && this.state.kind === "off") this.state = { kind: "idle" };
    } catch {
      /* relay asleep or unreachable: Forge stays off */
    }
  }

  get busy(): boolean {
    return this.state.kind === "sending" || this.state.kind === "pending";
  }

  async start(prompt: string): Promise<void> {
    if (!this.base || this.state.kind === "off" || this.busy) return;
    this.state = { kind: "sending", prompt };
    this.announced = false;
    try {
      const res = await this.fetchFn(`${this.base}/forge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !body.id) {
        this.state = { kind: "failed", prompt, reason: body.error ?? `http_${res.status}` };
        return;
      }
      this.id = body.id;
      this.lastPoll = this.now();
      this.state = { kind: "pending", prompt, elapsedMs: 0 };
    } catch {
      this.state = { kind: "failed", prompt, reason: "network" };
    }
  }

  tick(): void {
    const s = this.state;
    if (s.kind === "ready" && !this.announced) {
      this.announced = true;
      this.onReady?.(s.url, s.prompt);
      return;
    }
    if (s.kind !== "pending" || this.polling || !this.id) return;
    if (this.now() - this.lastPoll < POLL_MS) return;
    this.lastPoll = this.now();
    this.polling = true;
    const id = this.id;
    void this.fetchFn(`${this.base}/forge/${encodeURIComponent(id)}`)
      .then((r) => r.json() as Promise<{ state: string; prompt?: string; url?: string; elapsedMs?: number }>)
      .then((r) => {
        if (this.id !== id) return;
        if (r.state === "ready" && r.url) this.state = { kind: "ready", prompt: s.prompt, url: r.url };
        else if (r.state === "pending") this.state = { kind: "pending", prompt: s.prompt, elapsedMs: r.elapsedMs ?? 0 };
        else this.state = { kind: "failed", prompt: s.prompt, reason: r.state === "unknown" ? "expired" : "generation_failed" };
      })
      .catch(() => {
        /* transient; next tick retries */
      })
      .finally(() => {
        this.polling = false;
      });
  }

  /** Back to idle after a failure, so the player can try another prompt. */
  reset(): void {
    if (this.state.kind === "failed") this.state = { kind: "idle" };
  }
}

const REASONS: Record<string, string> = {
  rate_limited: "⚒ Forge is cooling down. Try again in a while",
  daily_cap: "⚒ Forge is out of energy today",
  bad_prompt: "⚒ Forge couldn't read that idea",
  network: "⚒ Forge couldn't reach the server",
};

/** One short HUD/title line for the current Forge state, or null when there's nothing to show. */
export function forgeStatusLine(s: ForgeState): string | null {
  switch (s.kind) {
    case "off":
    case "idle":
      return null;
    case "sending":
      return `⚒ Sending “${s.prompt}” to the Forge…`;
    case "pending": {
      const sec = Math.floor(s.elapsedMs / 1000);
      return `⚒ Forging “${s.prompt}” · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    }
    case "ready":
      return `⚒ “${s.prompt}” is forged. It comes with the next boss.`;
    case "failed":
      return REASONS[s.reason] ?? "⚒ The Forge failed. Try another idea";
  }
}
