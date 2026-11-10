import { createHash, randomBytes } from "node:crypto";

/** The Nexconn operations a co-op room needs. Tests use a fake; see NexconnBackend for the real one. */
export interface ChatBackend {
  createSquad(channelId: string, ownerUserId: string): Promise<void>;
  addToSquad(channelId: string, userId: string): Promise<void>;
  createWatch(channelId: string): Promise<void>;
  closeChannels(squadId: string | null, watchId: string | null): Promise<void>;
}

export interface NexconnConfig {
  appKey: string;
  appSecret: string;
  /** e.g. https://api.sg-light-api.com (must match the app's data center). */
  apiBase: string;
}

const ALREADY_MEMBER = 25412;

/**
 * Nexconn's server API. The App Secret lives only here (from the environment)
 * and only ever leaves as a signature; browsers get short per-user tokens.
 */
export class NexconnBackend implements ChatBackend {
  constructor(
    private readonly config: NexconnConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Mint a new chat user. The id is chosen here so a client can't ask for someone else's. */
  async issueToken(): Promise<{ userId: string; token: string }> {
    const userId = `p${randomBytes(12).toString("hex")}`;
    const r = (await this.call("/v4/auth/access-token/issue", { userId, name: "NOVA SWARM player" })) as {
      result?: { accessToken?: string };
    };
    const token = r.result?.accessToken;
    if (!token) throw new Error("Nexconn returned no access token");
    return { userId, token };
  }

  async createSquad(channelId: string, ownerUserId: string): Promise<void> {
    await this.call("/v4/group-channel/create", { channelId, name: "NOVA SWARM squad", owner: ownerUserId });
  }

  async addToSquad(channelId: string, userId: string): Promise<void> {
    await this.call("/v4/group-channel/join", { channelId, userIds: [userId] }, [ALREADY_MEMBER]);
  }

  async createWatch(channelId: string): Promise<void> {
    await this.call("/v4/open-channel/create", { channelId });
  }

  async closeChannels(squadId: string | null, watchId: string | null): Promise<void> {
    if (squadId) await this.call("/v4/group-channel/dismiss", { channelId: squadId });
    if (watchId) await this.call("/v4/open-channel/destroy", { channelIds: [watchId] });
  }

  private async call(path: string, body: unknown, okCodes: number[] = []): Promise<unknown> {
    const nonce = randomBytes(8).toString("hex");
    const timestamp = String(Date.now());
    const signature = createHash("sha1").update(`${this.config.appSecret}${nonce}${timestamp}`).digest("hex");
    const res = await this.fetchFn(`${this.config.apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "App-Key": this.config.appKey,
        Nonce: nonce,
        Timestamp: timestamp,
        Signature: signature,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { code?: number };
    if (json.code !== 0 && !okCodes.includes(json.code ?? -1)) {
      throw new Error(`Nexconn ${path} failed with code ${json.code}`);
    }
    return json;
  }
}

/** Build the real backend from the environment, or null when chat isn't configured. */
export function chatFromEnv(env: NodeJS.ProcessEnv): { backend: NexconnBackend; appKey: string } | null {
  const appKey = env.NEXCONN_APP_KEY;
  const appSecret = env.NEXCONN_APP_SECRET;
  if (!appKey || !appSecret) return null;
  const apiBase = (env.NEXCONN_API_BASE || "https://api.sg-light-api.com").replace(/\/+$/, "");
  return { backend: new NexconnBackend({ appKey, appSecret, apiBase }), appKey };
}
