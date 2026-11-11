import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NexconnBackend, type ChatBackend } from "../src/chatBackend";
import { RoomManager, type Conn } from "../src/rooms";
import { createRelayServer, type RelayServer } from "../src/server";
import type { RelayToClient } from "../../src/net/relayProtocol";

// ---- NexconnBackend: signing and request shapes ------------------------------

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const path = new URL(url).pathname;
    return { ok: true, json: async () => responses[path] ?? { code: 0 } };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const CONFIG = { appKey: "KEY", appSecret: "SECRET", apiBase: "https://api.example.test" };

test("requests are signed with SHA1(secret + nonce + timestamp) and never send the secret", async () => {
  const { fn, calls } = fakeFetch({
    "/v4/auth/access-token/issue": { code: 0, result: { userId: "u1", accessToken: "tok" } },
  });
  await new NexconnBackend(CONFIG, fn).issueToken();
  const h = calls[0].headers;
  expect(h["App-Key"]).toBe("KEY");
  expect(h.Nonce.length).toBeLessThanOrEqual(18);
  expect(h.Signature).toBe(createHash("sha1").update(`SECRET${h.Nonce}${h.Timestamp}`).digest("hex"));
  expect(JSON.stringify(calls[0])).not.toContain("SECRET");
});

test("issueToken mints a random server-chosen user id and returns its token", async () => {
  const { fn, calls } = fakeFetch({
    "/v4/auth/access-token/issue": { code: 0, result: { userId: "x", accessToken: "tok" } },
  });
  const b = new NexconnBackend(CONFIG, fn);
  const s = await b.issueToken();
  expect(s.token).toBe("tok");
  expect(s.userId).toMatch(/^[A-Za-z0-9]+$/);
  expect(calls[0].body.userId).toBe(s.userId);
  expect(calls[0].body.name).toBeTruthy();
});

test("a non-zero API code is an error", async () => {
  const { fn } = fakeFetch({ "/v4/auth/access-token/issue": { code: 1002 } });
  await expect(new NexconnBackend(CONFIG, fn).issueToken()).rejects.toThrow(/1002/);
});

test("group create, join and open channel create use the documented paths and fields", async () => {
  const { fn, calls } = fakeFetch();
  const b = new NexconnBackend(CONFIG, fn);
  await b.createSquad("sq1", "owner1");
  await b.addToSquad("sq1", "u2");
  await b.createWatch("w1");
  await b.closeChannels("sq1", "w1");
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
    "/v4/group-channel/create",
    "/v4/group-channel/join",
    "/v4/open-channel/create",
    "/v4/group-channel/dismiss",
    "/v4/open-channel/destroy",
  ]);
  expect(calls[0].body).toMatchObject({ channelId: "sq1", owner: "owner1" });
  expect(calls[0].body.name).toBeTruthy();
  expect(calls[1].body).toEqual({ channelId: "sq1", userIds: ["u2"] });
  expect(calls[2].body).toMatchObject({ channelId: "w1" });
  expect(calls[3].body).toEqual({ channelId: "sq1" });
  expect(calls[4].body).toEqual({ channelIds: ["w1"] });
});

test("re-adding an existing squad member is not an error", async () => {
  const { fn } = fakeFetch({ "/v4/group-channel/join": { code: 25412 } });
  await expect(new NexconnBackend(CONFIG, fn).addToSquad("sq1", "u2")).resolves.toBeUndefined();
});

// ---- RoomManager: chat channels and spectators --------------------------------

class FakeConn implements Conn {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  msgs(): RelayToClient[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
  last<T extends RelayToClient["t"]>(t: T): Extract<RelayToClient, { t: T }> | undefined {
    return this.msgs().filter((m) => m.t === t).at(-1) as Extract<RelayToClient, { t: T }> | undefined;
  }
  binaries(): Uint8Array[] {
    return this.sent.filter((s): s is Uint8Array => typeof s !== "string");
  }
}

class FakeBackend implements ChatBackend {
  log: string[] = [];
  fail = false;
  async createSquad(id: string, owner: string): Promise<void> {
    if (this.fail) throw new Error("down");
    this.log.push(`squad ${id} ${owner}`);
  }
  async addToSquad(id: string, user: string): Promise<void> {
    this.log.push(`add ${id} ${user}`);
  }
  async createWatch(id: string): Promise<void> {
    if (this.fail) throw new Error("down");
    this.log.push(`watch ${id}`);
  }
  async closeChannels(squadId: string, watchId: string): Promise<void> {
    this.log.push(`close ${squadId} ${watchId}`);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Wait until `get()` returns something (async chat setup can take more than a turn or two under load). */
async function until<T>(get: () => T | undefined | null, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await flush();
  }
}
let rm: RoomManager;
let chat: FakeBackend;
const send = (c: Conn, m: unknown) => rm.onText(c, JSON.stringify(m));
const hostRoom = () => {
  const host = new FakeConn();
  send(host, { t: "host", name: "HOST" });
  return { host, code: host.last("welcome")!.code };
};
const joinRoom = (code: string) => {
  const c = new FakeConn();
  send(c, { t: "join", code, name: "GUEST" });
  return c;
};
const watchRoom = (code: string) => {
  const c = new FakeConn();
  send(c, { t: "watch", code, name: "FAN" });
  return c;
};

beforeEach(() => {
  chat = new FakeBackend();
  rm = new RoomManager(Date.now, Math.random, chat);
});

test("the first chatJoin creates the room's channels once and everyone gets the same ids", async () => {
  const { host, code } = hostRoom();
  const guest = joinRoom(code);
  send(host, { t: "chatJoin", userId: "h1" });
  send(guest, { t: "chatJoin", userId: "g1" });
  await flush();
  await flush();
  const a = host.last("chat")!;
  const b = guest.last("chat")!;
  expect(a.squadId).toBeTruthy();
  expect(a.watchId).toBeTruthy();
  expect(b).toEqual(a);
  expect(a.squadId).toMatch(/^[A-Za-z0-9]+$/);
  expect(chat.log.filter((l) => l.startsWith("squad"))).toEqual([`squad ${a.squadId} h1`]);
  expect(chat.log.filter((l) => l.startsWith("watch"))).toHaveLength(1);
  expect(chat.log).toContain(`add ${a.squadId} g1`);
});

test("a reused room code gets fresh channel ids", async () => {
  const first = hostRoom();
  send(first.host, { t: "chatJoin", userId: "h1" });
  await flush();
  await flush();
  const a = first.host.last("chat")!;
  rm.onClose(first.host);
  const second = hostRoom();
  send(second.host, { t: "chatJoin", userId: "h2" });
  await flush();
  await flush();
  expect(second.host.last("chat")!.squadId).not.toBe(a.squadId);
});

test("chat failing tells only that client chat is off, and the room keeps working", async () => {
  chat.fail = true;
  const { host, code } = hostRoom();
  send(host, { t: "chatJoin", userId: "h1" });
  await flush();
  await flush();
  expect(host.last("chatOff")).toEqual({ t: "chatOff" });
  expect(joinRoom(code).last("welcome")!.slot).toBe(1);
});

test("with no chat backend configured, chatJoin answers chatOff", async () => {
  rm = new RoomManager();
  const { host } = hostRoom();
  send(host, { t: "chatJoin", userId: "h1" });
  await flush();
  expect(host.last("chatOff")).toBeTruthy();
});

test("closing a room dismisses its channels", async () => {
  const { host } = hostRoom();
  send(host, { t: "chatJoin", userId: "h1" });
  await flush();
  await flush();
  const ids = host.last("chat")!;
  rm.onClose(host);
  expect(chat.log).toContain(`close ${ids.squadId} ${ids.watchId}`);
});

test("a spectator takes no player slot, can join a started run, and gets snapshots", () => {
  const { host, code } = hostRoom();
  const guest = joinRoom(code);
  send(host, { t: "start" });
  const fan = watchRoom(code);
  expect(fan.last("welcome")!.slot).toBe(-1);
  expect(fan.last("roster")).toMatchObject({ started: true, spectators: 1 });
  expect(fan.last("roster")!.players).toHaveLength(2);
  expect(host.last("roster")!.spectators).toBe(1);
  rm.onBinary(host, new Uint8Array([7]));
  expect(fan.binaries()).toHaveLength(1);
  expect(guest.binaries()).toHaveLength(1);
});

test("spectators receive host broadcasts but can't message the host, send binary or control the room", () => {
  const { host, code } = hostRoom();
  const fan = watchRoom(code);
  send(host, { t: "send", data: { k: "over" } });
  expect(fan.last("msg")).toEqual({ t: "msg", from: 0, data: { k: "over" } });
  send(fan, { t: "send", data: { k: "ping" } });
  send(fan, { t: "start" });
  rm.onBinary(fan, new Uint8Array([9]));
  expect(host.last("msg")).toBeUndefined();
  expect(host.last("start")).toBeUndefined();
  expect(host.binaries()).toHaveLength(0);
});

test("a spectator doesn't count toward the 4-player limit", () => {
  const { code } = hostRoom();
  for (let i = 0; i < 5; i++) watchRoom(code);
  joinRoom(code);
  joinRoom(code);
  expect(joinRoom(code).last("welcome")!.slot).toBe(3);
});

test("a spectator leaving updates the count; the spectator limit and unknown rooms are refused", () => {
  const { host, code } = hostRoom();
  const fan = watchRoom(code);
  rm.onClose(fan);
  expect(host.last("roster")!.spectators).toBe(0);
  const fans = Array.from({ length: 20 }, () => watchRoom(code));
  expect(fans.at(-1)!.last("welcome")).toBeTruthy();
  expect(watchRoom(code).last("error")!.reason).toBe("watch_full");
  expect(watchRoom(code === "ZZZZ" ? "YYYY" : "ZZZZ").last("error")!.reason).toBe("not_found");
  expect(watchRoom("ab0d").last("error")!.reason).toBe("bad_code");
});

test("the host leaving closes the room for spectators too", () => {
  const { host, code } = hostRoom();
  const fan = watchRoom(code);
  rm.onClose(host);
  expect(fan.last("closed")).toEqual({ t: "closed", reason: "host_left" });
  expect(fan.closed).toBe(true);
});

test("a spectator's chatJoin gets only the crowd channel and isn't added to the squad", async () => {
  const { host, code } = hostRoom();
  send(host, { t: "chatJoin", userId: "h1" });
  const fan = watchRoom(code);
  send(fan, { t: "chatJoin", userId: "f1" });
  const got = await until(() => fan.last("chat"));
  const hostChat = await until(() => host.last("chat"));
  expect(got.squadId).toBeNull();
  expect(got.watchId).toBe(hostChat.watchId);
  expect(chat.log.some((l) => l.includes("f1"))).toBe(false);
});

// ---- HTTP: /chat/session --------------------------------------------------------

let relay: RelayServer | null = null;
afterEach(async () => {
  await relay?.close();
  relay = null;
});

test("POST /chat/session returns the app key and a token, with CORS, and never the secret", async () => {
  const { fn } = fakeFetch({
    "/v4/auth/access-token/issue": { code: 0, result: { userId: "x", accessToken: "tok" } },
  });
  relay = await createRelayServer(0, { chat: { backend: new NexconnBackend(CONFIG, fn), appKey: "KEY" } });
  const res = await fetch(`http://localhost:${relay.port}/chat/session`, { method: "POST" });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const text = await res.text();
  expect(text).not.toContain("SECRET");
  expect(JSON.parse(text)).toMatchObject({ appKey: "KEY", token: "tok" });
});

test("/chat/session says chat is off when unconfigured, and is rate-limited per address", async () => {
  relay = await createRelayServer(0);
  const off = await fetch(`http://localhost:${relay.port}/chat/session`, { method: "POST" });
  expect(off.status).toBe(200);
  expect(await off.json()).toEqual({ off: true });
  await relay.close();

  const { fn } = fakeFetch({
    "/v4/auth/access-token/issue": { code: 0, result: { userId: "x", accessToken: "tok" } },
  });
  relay = await createRelayServer(0, { chat: { backend: new NexconnBackend(CONFIG, fn), appKey: "KEY" } });
  const url = `http://localhost:${relay.port}/chat/session`;
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await fetch(url, { method: "POST" })).status;
  expect(last).toBe(429);
});
