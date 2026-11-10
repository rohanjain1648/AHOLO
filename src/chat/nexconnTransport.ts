import { CUSTOM_TYPES, type ChatTarget, type ChatTransport, type IncomingChat } from "./chatController";

/**
 * The Nexconn Web SDK behind ChatTransport. The SDK is loaded on first use, so
 * solo players never download it. Nexconn wants `initialize` once per page and
 * handlers registered before connecting, so that state lives at module level
 * while `active` points at whichever room's transport is current.
 */
interface ChatSession {
  appKey: string;
  userId: string;
  token: string;
}

type Sdk = typeof import("@nexconn/chat");

let sdkReady: Promise<Sdk> | null = null;
let active: NexconnTransport | null = null;

function loadSdk(appKey: string): Promise<Sdk> {
  sdkReady ??= import("@nexconn/chat").then((sdk) => {
    sdk.NCEngine.initialize({ appKey, areaCode: sdk.AreaCode.SG });
    sdk.NCEngine.registerCustomMessages(
      CUSTOM_TYPES.map((messageType) => ({ messageType, isPersisted: false, isCounted: false })),
    );
    sdk.NCEngine.addMessageHandler(
      "nova-chat",
      new sdk.MessageHandler({
        onMessageReceived({ messages }) {
          for (const msg of messages) active?.deliver(msg);
        },
      }),
    );
    return sdk;
  });
  return sdkReady;
}

// ---- Identity ------------------------------------------------------------------

/**
 * Pick this tab's identity slot. A browser keeps one chat identity, so a
 * returning player counts as one user, but two tabs must be two people or
 * Nexconn would sign the first one out. Each tab holds a lock on the first free
 * slot for as long as it's open.
 */
async function identitySlot(): Promise<number> {
  const locks = navigator.locks;
  if (!locks) return Math.floor(Math.random() * 1000) + 100;
  for (let slot = 0; slot < 8; slot++) {
    const got = await new Promise<boolean>((resolve) => {
      void locks.request(`novaswarm.chat.${slot}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock ? new Promise(() => {}) : undefined;
      });
    });
    if (got) return slot;
  }
  return 8;
}

let slotReady: Promise<number> | null = null;

async function loadSession(relayHttp: string, fresh: boolean): Promise<ChatSession> {
  slotReady ??= identitySlot();
  const key = `novaswarm.chat.${await slotReady}`;
  if (!fresh) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null") as ChatSession | null;
      if (saved?.token && saved.userId && saved.appKey) return saved;
    } catch {
      // Unreadable or blocked storage: fall through and fetch a new identity.
    }
  }
  const res = await fetch(`${relayHttp}/chat/session`, { method: "POST" });
  if (!res.ok) throw new Error(`chat session: HTTP ${res.status}`);
  const session = (await res.json()) as ChatSession;
  if (!session.token) throw new Error("chat is off on this server");
  try {
    localStorage.setItem(key, JSON.stringify(session));
  } catch {
    // Private mode: this identity just lasts for the page.
  }
  return session;
}

// ---- Transport -----------------------------------------------------------------

export class NexconnTransport implements ChatTransport {
  onMessage: (m: IncomingChat) => void = () => {};
  private sdk: Sdk | null = null;
  private squadId: string | null = null;
  private watchId: string | null = null;

  constructor(private readonly relayHttp: string) {}

  async connect(): Promise<{ userId: string }> {
    active = this;
    let session = await loadSession(this.relayHttp, false);
    this.sdk = await loadSdk(session.appKey);
    let res = await this.sdk.NCEngine.connect({ token: session.token });
    if (res.code !== 0) {
      // A saved token can go stale (for example if the App Secret was rotated).
      session = await loadSession(this.relayHttp, true);
      res = await this.sdk.NCEngine.connect({ token: session.token });
      if (res.code !== 0) throw new Error(`chat connect failed: code ${res.code}`);
    }
    return { userId: session.userId };
  }

  async joinSquad(channelId: string): Promise<void> {
    this.squadId = channelId;
  }

  async joinWatch(channelId: string): Promise<void> {
    const res = await new (this.need().OpenChannel)(channelId).enterChannel({ messageCount: 0 });
    if (res.code !== 0) throw new Error(`crowd channel join failed: code ${res.code}`);
    this.watchId = channelId;
  }

  async sendText(target: ChatTarget, text: string, sender: { name: string; slot: number }): Promise<void> {
    const sdk = this.need();
    const params = new sdk.SendTextMessageParams({
      text,
      senderUserInfo: { name: sender.name, extra: String(sender.slot) },
    });
    this.check(await this.channel(target).sendMessage(params));
  }

  async sendCustom(target: ChatTarget, type: string, payload: Record<string, unknown>): Promise<void> {
    const sdk = this.need();
    this.check(await this.channel(target).sendMessage(new sdk.SendMessageParams(payload, type)));
  }

  async stop(): Promise<void> {
    if (active === this) active = null;
    // Disconnecting also leaves the crowd channel.
    if (this.sdk) await this.sdk.NCEngine.disconnect();
  }

  /** Called by the shared SDK handler. */
  deliver(msg: {
    channelIdentifier: { channelId: string };
    senderUserId: string;
    messageType: string;
    content: Record<string, unknown>;
  }): void {
    const id = msg.channelIdentifier.channelId;
    const target: ChatTarget | null = id === this.squadId ? "squad" : id === this.watchId ? "watch" : null;
    if (!target) return;
    const base = { target, senderUserId: msg.senderUserId };
    if (CUSTOM_TYPES.includes(msg.messageType)) {
      this.onMessage({ ...base, type: msg.messageType, payload: msg.content });
    } else if (typeof msg.content.text === "string") {
      const info = msg.content.senderUserInfo as { name?: string; extra?: string } | undefined;
      this.onMessage({
        ...base,
        type: "text",
        text: msg.content.text,
        name: info?.name,
        slot: info?.extra === undefined ? undefined : Number(info.extra),
      });
    }
  }

  private channel(target: ChatTarget) {
    const sdk = this.need();
    const id = target === "squad" ? this.squadId : this.watchId;
    if (!id) throw new Error(`not in the ${target} channel`);
    return target === "squad" ? new sdk.GroupChannel(id) : new sdk.OpenChannel(id);
  }

  private check(res: { code: number }): void {
    if (res.code !== 0) throw new Error(`chat send failed: code ${res.code}`);
  }

  private need(): Sdk {
    if (!this.sdk) throw new Error("chat not connected");
    return this.sdk;
  }
}
