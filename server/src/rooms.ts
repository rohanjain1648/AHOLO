import { randomBytes, randomUUID } from "node:crypto";
import type { ChatBackend } from "./chatBackend";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  RECONNECT_GRACE_MS,
  SPECTATOR_SLOT,
  normalizeCode,
  type ClientToRelay,
  type RelayToClient,
  type RosterEntry,
} from "../../src/net/relayProtocol";

/** One socket, as the room logic sees it. main.ts adapts `ws` to this. */
export interface Conn {
  send(data: string | Uint8Array): void;
  close(): void;
}

interface Member {
  slot: number;
  name: string;
  token: string;
  conn: Conn | null;
  /** When the socket dropped; the slot is freed RECONNECT_GRACE_MS later. */
  droppedAt: number | null;
}

interface Room {
  code: string;
  started: boolean;
  members: Map<number, Member>;
  spectators: Set<Conn>;
  /** Nexconn channel ids, unique per room so a reused code never inherits old chat. */
  squadId: string;
  watchId: string;
  /** In-flight or finished channel creation; each happens once per room. */
  squadReady: Promise<void> | null;
  /** The host's chat id, so clients can tell real vote news from a forged message. */
  hostChatId: string | null;
  watchReady: Promise<void> | null;
}

/**
 * All room bookkeeping, with no sockets or timers of its own so it can be
 * tested with fake connections and a fake clock. Slot 0 is always the host;
 * the host leaving closes the room.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byConn = new Map<Conn, { room: Room; slot: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly rand: () => number = Math.random,
    private readonly chat: ChatBackend | null = null,
  ) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  onOpen(_c: Conn): void {
    // Nothing until the socket says host/join/rejoin.
  }

  onText(c: Conn, raw: string): void {
    let m: ClientToRelay;
    try {
      m = JSON.parse(raw) as ClientToRelay;
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    const at = this.byConn.get(c);

    if (!at) {
      if (m.t === "host") this.host(c, m.name);
      else if (m.t === "join") this.join(c, m.code, m.name);
      else if (m.t === "rejoin") this.rejoin(c, m.code, m.token);
      else if (m.t === "watch") this.watch(c, m.code);
      return;
    }

    const { room, slot } = at;
    if (m.t === "chatJoin") {
      void this.chatJoin(c, room, slot, String(m.userId ?? ""));
    } else if (slot === SPECTATOR_SLOT) {
      // Spectators only watch and chat; nothing else they send reaches the room.
    } else if (m.t === "send") {
      const msg: RelayToClient = { t: "msg", from: slot, data: m.data };
      if (slot !== 0) this.sendTo(room, 0, msg);
      else if (typeof m.to === "number") this.sendTo(room, m.to, msg);
      else this.broadcast(room, msg, true);
    } else if (slot === 0 && m.t === "start") {
      room.started = true;
      this.broadcast(room, { t: "start" });
    } else if (slot === 0 && m.t === "lobby") {
      room.started = false;
      this.broadcast(room, { t: "lobby" });
    }
  }

  onBinary(c: Conn, data: Uint8Array): void {
    const at = this.byConn.get(c);
    if (!at || at.slot !== 0) return;
    for (const mem of at.room.members.values()) {
      if (mem.slot !== 0 && mem.conn) mem.conn.send(data);
    }
    for (const fan of at.room.spectators) fan.send(data);
  }

  onClose(c: Conn): void {
    const at = this.byConn.get(c);
    if (!at) return;
    this.byConn.delete(c);
    const { room, slot } = at;
    if (slot === 0) {
      this.closeRoom(room);
      return;
    }
    if (slot === SPECTATOR_SLOT) {
      room.spectators.delete(c);
      this.sendRoster(room);
      return;
    }
    const mem = room.members.get(slot);
    if (!mem || mem.conn !== c) return;
    mem.conn = null;
    mem.droppedAt = this.now();
    this.sendRoster(room);
  }

  /** Free slots whose reconnect grace has run out. Call about once a second. */
  tick(): void {
    const t = this.now();
    for (const room of this.rooms.values()) {
      let changed = false;
      for (const mem of room.members.values()) {
        if (mem.droppedAt !== null && t - mem.droppedAt > RECONNECT_GRACE_MS) {
          room.members.delete(mem.slot);
          changed = true;
        }
      }
      if (changed) this.sendRoster(room);
    }
  }

  // ---- Handlers ------------------------------------------------------------
  private host(c: Conn, name: string): void {
    const id = randomBytes(10).toString("hex");
    const room: Room = {
      code: this.newCode(),
      started: false,
      members: new Map(),
      spectators: new Set(),
      squadId: `sq${id}`,
      watchId: `w${id}`,
      squadReady: null,
      hostChatId: null,
      watchReady: null,
    };
    this.rooms.set(room.code, room);
    this.admit(c, room, 0, name);
  }

  private join(c: Conn, rawCode: string, name: string): void {
    const code = normalizeCode(String(rawCode ?? ""));
    if (!code) return this.error(c, "bad_code");
    const room = this.rooms.get(code);
    if (!room) return this.error(c, "not_found");
    if (room.started) return this.error(c, "started");
    let slot = -1;
    for (let s = 1; s < MAX_PLAYERS; s++) {
      if (!room.members.has(s)) {
        slot = s;
        break;
      }
    }
    if (slot < 0) return this.error(c, "full");
    this.admit(c, room, slot, name);
  }

  private rejoin(c: Conn, rawCode: string, token: string): void {
    const code = normalizeCode(String(rawCode ?? ""));
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return this.error(c, "not_found");
    const mem = [...room.members.values()].find((m) => m.token === token);
    if (!mem) return this.error(c, "bad_token");
    if (mem.conn) {
      // A stale socket the server hasn't noticed is dead yet.
      this.byConn.delete(mem.conn);
      mem.conn.close();
    }
    mem.conn = c;
    mem.droppedAt = null;
    this.byConn.set(c, { room, slot: mem.slot });
    this.send(c, { t: "welcome", code: room.code, slot: mem.slot, token: mem.token });
    this.sendRoster(room);
  }

  private watch(c: Conn, rawCode: string): void {
    const code = normalizeCode(String(rawCode ?? ""));
    if (!code) return this.error(c, "bad_code");
    const room = this.rooms.get(code);
    if (!room) return this.error(c, "not_found");
    if (room.spectators.size >= MAX_SPECTATORS) return this.error(c, "watch_full");
    room.spectators.add(c);
    this.byConn.set(c, { room, slot: SPECTATOR_SLOT });
    this.send(c, { t: "welcome", code: room.code, slot: SPECTATOR_SLOT, token: "" });
    this.sendRoster(room);
  }

  /**
   * Hand a client the room's chat channels, creating them on first use. The
   * relay does this (not the browser) because it knows who is really in the
   * room, and only the server may hold the Nexconn secret. A failure only
   * costs chat: the game itself never waits on it.
   */
  private async chatJoin(c: Conn, room: Room, slot: number, userId: string): Promise<void> {
    if (!this.chat || !userId) return this.send(c, { t: "chatOff" });
    const chat = this.chat;
    if (slot === 0) room.hostChatId = userId;
    try {
      room.watchReady ??= chat.createWatch(room.watchId);
      if (slot === SPECTATOR_SLOT) {
        await room.watchReady;
        return this.send(c, { t: "chat", squadId: null, watchId: room.watchId, hostUserId: room.hostChatId });
      }
      room.squadReady ??= chat.createSquad(room.squadId, userId);
      await Promise.all([room.watchReady, room.squadReady]);
      await chat.addToSquad(room.squadId, userId);
      this.send(c, { t: "chat", squadId: room.squadId, watchId: room.watchId, hostUserId: room.hostChatId });
    } catch (e) {
      console.error("chat setup failed:", (e as Error).message);
      this.send(c, { t: "chatOff" });
    }
  }

  // ---- Helpers -------------------------------------------------------------
  private admit(c: Conn, room: Room, slot: number, name: string): void {
    const mem: Member = { slot, name: cleanName(name), token: randomUUID(), conn: c, droppedAt: null };
    room.members.set(slot, mem);
    this.byConn.set(c, { room, slot });
    this.send(c, { t: "welcome", code: room.code, slot, token: mem.token });
    this.sendRoster(room);
  }

  private closeRoom(room: Room): void {
    this.rooms.delete(room.code);
    for (const mem of room.members.values()) {
      if (!mem.conn) continue;
      this.byConn.delete(mem.conn);
      if (mem.slot !== 0) {
        this.send(mem.conn, { t: "closed", reason: "host_left" });
        mem.conn.close();
      }
    }
    for (const fan of room.spectators) {
      this.byConn.delete(fan);
      this.send(fan, { t: "closed", reason: "host_left" });
      fan.close();
    }
    if (this.chat && (room.squadReady || room.watchReady)) {
      this.chat
        .closeChannels(room.squadReady ? room.squadId : null, room.watchReady ? room.watchId : null)
        .catch(() => {
          // Best effort: Nexconn also destroys idle open channels by itself.
        });
    }
  }

  private newCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(this.rand() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private roster(room: Room): RosterEntry[] {
    return [...room.members.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((m) => ({ slot: m.slot, name: m.name, connected: m.conn !== null }));
  }

  private sendRoster(room: Room): void {
    this.broadcast(room, { t: "roster", players: this.roster(room), started: room.started, spectators: room.spectators.size });
  }

  private broadcast(room: Room, m: RelayToClient, clientsOnly = false): void {
    const raw = JSON.stringify(m);
    for (const mem of room.members.values()) {
      if (clientsOnly && mem.slot === 0) continue;
      mem.conn?.send(raw);
    }
    for (const fan of room.spectators) fan.send(raw);
  }

  private sendTo(room: Room, slot: number, m: RelayToClient): void {
    room.members.get(slot)?.conn?.send(JSON.stringify(m));
  }

  private send(c: Conn, m: RelayToClient): void {
    c.send(JSON.stringify(m));
  }

  private error(c: Conn, reason: Extract<RelayToClient, { t: "error" }>["reason"]): void {
    this.send(c, { t: "error", reason });
  }
}

function cleanName(raw: unknown): string {
  const s = String(raw ?? "").trim().slice(0, MAX_NAME_LENGTH);
  return s || "PLAYER";
}
