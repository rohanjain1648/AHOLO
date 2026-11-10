import { CrowdVoteHost, type CrowdChoice } from "./crowdVote";
import { renderQuick, type QuickLine } from "./quickChat";

/**
 * All chat behaviour, with the Nexconn SDK behind a small interface so it can
 * be tested without a network. Game data never goes through here: if chat is
 * down the run carries on and the panel just stays hidden.
 *
 * Everything received is untrusted. Nexconn delivers whatever any channel
 * member sends, so lengths are capped, unknown quick lines are dropped, and
 * vote news is only believed from the host's chat id.
 */
export type ChatTarget = "squad" | "watch";
export type ChatRole = "host" | "player" | "spectator";

export interface IncomingChat {
  target: ChatTarget;
  senderUserId: string;
  /** "text", or a custom message type. */
  type: string;
  text?: string;
  name?: string;
  slot?: number;
  payload?: Record<string, unknown>;
}

export interface ChatTransport {
  onMessage: (m: IncomingChat) => void;
  connect(): Promise<{ userId: string }>;
  joinSquad(channelId: string): Promise<void>;
  joinWatch(channelId: string): Promise<void>;
  sendText(target: ChatTarget, text: string, sender: { name: string; slot: number }): Promise<void>;
  sendCustom(target: ChatTarget, type: string, payload: Record<string, unknown>): Promise<void>;
  stop(): Promise<void>;
}

export interface FeedEntry {
  id: number;
  userId: string;
  name: string;
  slot: number;
  text: string;
  crowd: boolean;
  quick: boolean;
  mine: boolean;
}

export const CUSTOM_TYPES = ["nova:quick", "nova:vote_open", "nova:vote", "nova:vote_result"];

const MAX_TEXT = 140;
const MAX_NAME = 12;
const MAX_FEED = 80;
const SEND_GAP_MS = 1000;
const BUBBLE_MS = 3500;

const cleanSlot = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= -1 && v < 4 ? v : -1);

export class ChatController {
  status: "off" | "connecting" | "ready" = "connecting";
  /** Open vote as a spectator sees it. */
  vote: { round: number; endsAt: number; mine: CrowdChoice | null } | null = null;
  /** Players and spectators: whether crowd chat shows in the feed. */
  showCrowd = true;
  onCrowdResult: (choice: CrowdChoice, supply: number, surge: number) => void = () => {};
  onVoteOpen: () => void = () => {};
  onChange: () => void = () => {};

  private entries: FeedEntry[] = [];
  private nextId = 1;
  private userId = "";
  private hostUserId: string | null = null;
  private hasSquad = false;
  private hasWatch = false;
  private lastSend = -Infinity;
  private readonly muted = new Set<string>();
  private readonly bubbles = new Map<number, { text: string; until: number }>();
  private readonly hostVote = new CrowdVoteHost();

  constructor(
    private readonly transport: ChatTransport,
    private readonly me: { role: ChatRole; name: string; slot: number },
    private readonly now: () => number = Date.now,
  ) {
    transport.onMessage = (m) => this.receive(m);
  }

  /** Connect to Nexconn, then ask the relay for this room's channels. */
  async start(requestChannels: (userId: string) => void): Promise<void> {
    try {
      const { userId } = await this.transport.connect();
      this.userId = userId;
      requestChannels(userId);
    } catch (e) {
      console.warn("chat unavailable:", e);
      this.onChatOff();
    }
  }

  async onChannels(ch: { squadId: string | null; watchId: string; hostUserId?: string | null }): Promise<void> {
    this.hostUserId = ch.hostUserId ?? null;
    try {
      if (ch.squadId && this.me.role !== "spectator") {
        await this.transport.joinSquad(ch.squadId);
        this.hasSquad = true;
      }
      await this.transport.joinWatch(ch.watchId);
      this.hasWatch = true;
      this.status = "ready";
    } catch (e) {
      console.warn("chat join failed:", e);
      this.status = this.hasSquad ? "ready" : "off";
    }
    this.onChange();
  }

  onChatOff(): void {
    this.status = "off";
    this.onChange();
  }

  get feed(): FeedEntry[] {
    return this.entries.filter((e) => !this.muted.has(e.userId) && (this.showCrowd || !e.crowd || e.mine));
  }

  sendChat(raw: string): void {
    const text = raw.trim().slice(0, MAX_TEXT);
    if (!text || this.now() - this.lastSend < SEND_GAP_MS) return;
    this.lastSend = this.now();
    const target: ChatTarget = this.me.role === "spectator" ? "watch" : "squad";
    this.fire(this.transport.sendText(target, text, { name: this.me.name, slot: this.me.slot }));
    this.push({ userId: this.userId, name: this.me.name, slot: this.me.slot, text, crowd: target === "watch", quick: false, mine: true });
  }

  /** Quick lines also go to the crowd channel so spectators see the bubbles. */
  sendQuick(line: QuickLine): void {
    const text = renderQuick(line);
    if (!text || this.now() - this.lastSend < SEND_GAP_MS) return;
    this.lastSend = this.now();
    const payload = { ...line, name: this.me.name, slot: this.me.slot };
    this.fire(this.transport.sendCustom("squad", "nova:quick", payload));
    this.fire(this.transport.sendCustom("watch", "nova:quick", payload));
    this.showQuick(this.userId, this.me.name, this.me.slot, text, true);
  }

  mute(userId: string): void {
    if (userId === this.userId) return;
    this.muted.add(userId);
    this.onChange();
  }

  bubbleFor(slot: number): string | null {
    const b = this.bubbles.get(slot);
    return b && this.now() < b.until ? b.text : null;
  }

  /** Spectators only, once per round. */
  castVote(choice: CrowdChoice): void {
    if (this.me.role !== "spectator" || !this.vote || this.vote.mine) return;
    this.vote.mine = choice;
    this.fire(this.transport.sendCustom("watch", "nova:vote", { round: this.vote.round, choice }));
    this.onChange();
  }

  /**
   * Host, once per game tick: run the crowd vote. Returns the winning choice
   * on the tick a vote closes, for the caller to apply to the World.
   */
  hostTick(dt: number, canRun: boolean): CrowdChoice | null {
    if (this.me.role !== "host" || this.status !== "ready" || !this.hasWatch) return null;
    const ev = this.hostVote.tick(dt, canRun);
    if (!ev) return null;
    if (ev.kind === "open") {
      this.fire(this.transport.sendCustom("watch", "nova:vote_open", { round: ev.round, seconds: ev.seconds }));
      this.onVoteOpen();
      return null;
    }
    this.fire(this.transport.sendCustom("watch", "nova:vote_result", { ...ev }));
    if (ev.choice) this.onCrowdResult(ev.choice, ev.supply, ev.surge);
    return ev.choice;
  }

  async stop(): Promise<void> {
    this.status = "off";
    await this.transport.stop().catch(() => {});
  }

  // ---- Receiving ------------------------------------------------------------
  private receive(m: IncomingChat): void {
    if (m.type === "text") {
      const text = String(m.text ?? "").trim().slice(0, MAX_TEXT);
      if (!text) return;
      this.push({
        userId: m.senderUserId,
        name: String(m.name ?? "PLAYER").slice(0, MAX_NAME),
        slot: cleanSlot(m.slot),
        text,
        crowd: m.target === "watch",
        quick: false,
        mine: false,
      });
      return;
    }
    const p = m.payload ?? {};
    if (m.type === "nova:quick") {
      // Only squad members can post in the squad channel. Spectators have no
      // such channel, so for them the (forgeable) crowd copy is all there is.
      if (m.target !== (this.me.role === "spectator" ? "watch" : "squad")) return;
      const text = renderQuick({ id: String(p.id ?? ""), arg: typeof p.arg === "string" ? p.arg : undefined });
      if (text) this.showQuick(m.senderUserId, String(p.name ?? "PLAYER").slice(0, MAX_NAME), cleanSlot(p.slot), text, false);
    } else if (m.type === "nova:vote") {
      if (this.me.role === "host" && m.target === "watch") {
        this.hostVote.cast(m.senderUserId, Number(p.round), p.choice as CrowdChoice);
      }
    } else if (m.senderUserId === this.hostUserId && this.me.role !== "host") {
      if (m.type === "nova:vote_open") {
        const seconds = Math.min(30, Math.max(1, Number(p.seconds) || 10));
        this.vote = { round: Number(p.round), endsAt: this.now() + seconds * 1000, mine: null };
        this.onVoteOpen();
        this.onChange();
      } else if (m.type === "nova:vote_result") {
        this.vote = null;
        if (p.choice === "supply" || p.choice === "surge") {
          this.onCrowdResult(p.choice, Number(p.supply) || 0, Number(p.surge) || 0);
        }
        this.onChange();
      }
    }
  }

  private showQuick(userId: string, name: string, slot: number, text: string, mine: boolean): void {
    if (this.muted.has(userId)) return;
    if (slot >= 0) this.bubbles.set(slot, { text, until: this.now() + BUBBLE_MS });
    this.push({ userId, name, slot, text, crowd: false, quick: true, mine });
  }

  private push(e: Omit<FeedEntry, "id">): void {
    this.entries.push({ ...e, id: this.nextId++ });
    if (this.entries.length > MAX_FEED) this.entries.shift();
    this.onChange();
  }

  private fire(p: Promise<void>): void {
    p.catch((e) => console.warn("chat send failed:", e));
  }
}
