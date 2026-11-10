import { beforeEach, expect, test } from "vitest";
import { ChatController, type ChatTransport, type IncomingChat, type ChatTarget } from "../../src/chat/chatController";
import { CrowdVoteHost, VOTE_GAP_SEC, VOTE_WINDOW_SEC } from "../../src/chat/crowdVote";
import { quickOptions, renderQuick } from "../../src/chat/quickChat";
import { DIRECTOR } from "../../src/game/config";
import { IDLE_INPUT } from "../../src/game/types";
import { World } from "../../src/game/world";
import { silentAudio } from "./helpers";

// ---- Quick chat ----------------------------------------------------------------

test("quick chat always offers 4 lines and leads with what the moment calls for", () => {
  expect(quickOptions({ meDowned: false, downedTeammates: [], bossAlive: false })).toHaveLength(4);
  expect(renderQuick(quickOptions({ meDowned: true, downedTeammates: [], bossAlive: false })[0])).toBe("Revive me!");
  expect(renderQuick(quickOptions({ meDowned: false, downedTeammates: ["BOLT-7"], bossAlive: false })[0])).toBe("Coming, BOLT-7!");
  expect(renderQuick(quickOptions({ meDowned: false, downedTeammates: [], bossAlive: true })[0])).toBe("Focus the Warden!");
});

test("a downed player isn't offered 'Coming' and lines never repeat", () => {
  const o = quickOptions({ meDowned: true, downedTeammates: ["ARC-1"], bossAlive: true }).map(renderQuick);
  expect(o).not.toContain("Coming, ARC-1!");
  expect(new Set(o).size).toBe(o.length);
});

test("an unknown quick line renders as nothing, so it can't carry free text", () => {
  expect(renderQuick({ id: "you are bad" })).toBeNull();
  expect(renderQuick({ id: "coming" })).toBeNull();
  expect(renderQuick({ id: "coming", arg: "x".repeat(50) })!.length).toBeLessThan(25);
});

// ---- Crowd vote ------------------------------------------------------------------

const toOpen = (v: CrowdVoteHost) => {
  for (let t = 0; t <= VOTE_GAP_SEC + 1; t += 0.5) {
    const ev = v.tick(0.5, true);
    if (ev) return ev;
  }
  throw new Error("never opened");
};
const toResult = (v: CrowdVoteHost) => {
  for (let t = 0; t <= VOTE_WINDOW_SEC + 1; t += 0.5) {
    const ev = v.tick(0.5, true);
    if (ev) return ev;
  }
  throw new Error("never closed");
};

test("a vote opens after the gap, closes after the window, and the most votes win", () => {
  const v = new CrowdVoteHost();
  const open = toOpen(v);
  expect(open).toMatchObject({ kind: "open", round: 1 });
  v.cast("a", 1, "surge");
  v.cast("b", 1, "surge");
  v.cast("c", 1, "supply");
  expect(toResult(v)).toEqual({ kind: "result", round: 1, choice: "surge", supply: 1, surge: 2 });
});

test("each viewer counts once, stale rounds and bad choices are ignored, and a tie helps the squad", () => {
  const v = new CrowdVoteHost();
  toOpen(v);
  v.cast("a", 1, "surge");
  v.cast("a", 1, "surge");
  v.cast("b", 1, "supply");
  v.cast("c", 99, "surge");
  v.cast("d", 1, "nuke" as never);
  expect(toResult(v)).toMatchObject({ choice: "supply", supply: 1, surge: 1 });
});

test("no votes means nothing happens; no timer runs while voting can't run", () => {
  const v = new CrowdVoteHost();
  for (let i = 0; i < 500; i++) expect(v.tick(1, false)).toBeNull();
  toOpen(v);
  expect(toResult(v)).toMatchObject({ choice: null });
});

// ---- Crowd effects in the World --------------------------------------------------

test("supply drop puts heal gems near every living player", () => {
  const w = new World(silentAudio());
  w.reset([{ slot: 0, name: "A" }, { slot: 1, name: "B" }]);
  w.crowdSupplyDrop();
  expect(w.gems.filter((g) => !g.dead && g.kind === "heal").length).toBe(2);
});

test("swarm surge adds enemies right away, but never past the enemy cap", () => {
  const w = new World(silentAudio());
  w.reset([{ slot: 0, name: "A" }, { slot: 1, name: "B" }]);
  w.crowdSurge();
  const n = w.enemies.filter((e) => !e.dead).length;
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < 40; i++) w.crowdSurge();
  expect(w.enemies.filter((e) => !e.dead).length).toBeLessThanOrEqual(DIRECTOR.maxEnemies);
  w.update(1 / 60, [IDLE_INPUT, IDLE_INPUT]);
});

// ---- ChatController ---------------------------------------------------------------

class FakeTransport implements ChatTransport {
  onMessage: (m: IncomingChat) => void = () => {};
  joined: string[] = [];
  sent: { target: ChatTarget; text?: string; type?: string; payload?: Record<string, unknown> }[] = [];
  failConnect = false;
  async connect(): Promise<{ userId: string }> {
    if (this.failConnect) throw new Error("down");
    return { userId: "me" };
  }
  async joinSquad(id: string): Promise<void> {
    this.joined.push(`squad:${id}`);
  }
  async joinWatch(id: string): Promise<void> {
    this.joined.push(`watch:${id}`);
  }
  async sendText(target: ChatTarget, text: string): Promise<void> {
    this.sent.push({ target, text });
  }
  async sendCustom(target: ChatTarget, type: string, payload: Record<string, unknown>): Promise<void> {
    this.sent.push({ target, type, payload });
  }
  async stop(): Promise<void> {}
}

let now = 0;
let t: FakeTransport;
const make = (role: "host" | "player" | "spectator", slot = role === "host" ? 0 : role === "player" ? 1 : -1) => {
  now = 1000;
  t = new FakeTransport();
  return new ChatController(t, { role, name: "ME", slot }, () => now);
};
const text = (from: string, s: string, target: ChatTarget = "squad"): IncomingChat => ({
  target, senderUserId: from, type: "text", text: s, name: "THEM", slot: 2,
});
const custom = (from: string, type: string, payload: Record<string, unknown>, target: ChatTarget = "watch"): IncomingChat => ({
  target, senderUserId: from, type, payload,
});

beforeEach(() => {
  now = 1000;
});

test("connect then channels: asks the relay for channels and joins what it's given", async () => {
  const c = make("player");
  const asked: string[] = [];
  await c.start((id) => asked.push(id));
  expect(asked).toEqual(["me"]);
  expect(c.status).toBe("connecting");
  await c.onChannels({ squadId: "s1", watchId: "w1", hostUserId: "h" });
  expect(t.joined).toEqual(["squad:s1", "watch:w1"]);
  expect(c.status).toBe("ready");
});

test("a spectator joins only the crowd channel and talks there", async () => {
  const c = make("spectator");
  await c.start(() => {});
  await c.onChannels({ squadId: null, watchId: "w1", hostUserId: "h" });
  expect(t.joined).toEqual(["watch:w1"]);
  c.sendChat("go go go");
  expect(t.sent[0]).toMatchObject({ target: "watch", text: "go go go" });
});

test("chat failing to connect or join turns chat off without throwing", async () => {
  const c = make("player");
  t.failConnect = true;
  await c.start(() => {});
  expect(c.status).toBe("off");
  const d = make("player");
  d.onChatOff();
  expect(d.status).toBe("off");
});

test("typed chat is trimmed, length-capped, rate-limited, and echoed to my own feed", async () => {
  const c = make("player");
  await c.start(() => {});
  await c.onChannels({ squadId: "s", watchId: "w", hostUserId: "h" });
  c.sendChat("   ");
  expect(t.sent).toHaveLength(0);
  c.sendChat("y".repeat(500));
  expect(t.sent[0].text!.length).toBe(140);
  c.sendChat("too fast");
  expect(t.sent).toHaveLength(1);
  now += 1100;
  c.sendChat("ok now");
  expect(t.sent).toHaveLength(2);
  expect(c.feed.map((f) => f.mine)).toEqual([true, true]);
});

test("incoming chat lands in the feed, capped in length, with crowd messages marked", async () => {
  const c = make("player");
  await c.start(() => {});
  t.onMessage(text("u2", "z".repeat(999)));
  t.onMessage(text("u3", "hype", "watch"));
  expect(c.feed[0].text.length).toBe(140);
  expect(c.feed[0].crowd).toBe(false);
  expect(c.feed[1].crowd).toBe(true);
});

test("muting a person hides their old and new messages", async () => {
  const c = make("player");
  await c.start(() => {});
  t.onMessage(text("rude", "bad"));
  t.onMessage(text("nice", "hi"));
  c.mute("rude");
  t.onMessage(text("rude", "bad again"));
  expect(c.feed.map((f) => f.text)).toEqual(["hi"]);
});

test("hiding the crowd hides crowd chat only", async () => {
  const c = make("player");
  await c.start(() => {});
  t.onMessage(text("a", "squad msg"));
  t.onMessage(text("b", "crowd msg", "watch"));
  c.showCrowd = false;
  expect(c.feed.map((f) => f.text)).toEqual(["squad msg"]);
});

test("a quick line goes to squad and crowd, and shows as a bubble over my robot", async () => {
  const c = make("player");
  await c.start(() => {});
  await c.onChannels({ squadId: "s", watchId: "w", hostUserId: "h" });
  c.sendQuick({ id: "nice" });
  expect(t.sent.map((s) => s.target).sort()).toEqual(["squad", "watch"]);
  expect(t.sent[0].type).toBe("nova:quick");
  expect(c.bubbleFor(1)).toBe("Nice!");
  now += 10_000;
  expect(c.bubbleFor(1)).toBeNull();
});

test("players trust quick lines only from the squad channel; forged or unknown ones are dropped", async () => {
  const c = make("player");
  await c.start(() => {});
  t.onMessage(custom("fan", "nova:quick", { id: "nice", slot: 2, name: "FAKE" }, "watch"));
  t.onMessage(custom("u2", "nova:quick", { id: "free text!", slot: 2, name: "X" }, "squad"));
  expect(c.feed).toHaveLength(0);
  t.onMessage(custom("u2", "nova:quick", { id: "help", slot: 2, name: "ARC-1" }, "squad"));
  expect(c.bubbleFor(2)).toBe("Need help!");
  expect(c.feed[0].text).toBe("Need help!");
});

test("spectators see players' quick lines through the crowd channel", async () => {
  const c = make("spectator");
  await c.start(() => {});
  t.onMessage(custom("u2", "nova:quick", { id: "help", slot: 2, name: "ARC-1" }, "watch"));
  expect(c.bubbleFor(2)).toBe("Need help!");
});

test("host runs the vote: announces it, tallies crowd votes and returns the winner once", async () => {
  const c = make("host");
  await c.start(() => {});
  await c.onChannels({ squadId: "s", watchId: "w", hostUserId: "me" });
  let got: unknown = null;
  for (let i = 0; i < 200 && !t.sent.some((s) => s.type === "nova:vote_open"); i++) got = c.hostTick(0.5, true) ?? got;
  expect(got).toBeNull();
  const open = t.sent.find((s) => s.type === "nova:vote_open")!;
  expect(open.target).toBe("watch");
  t.onMessage(custom("fan1", "nova:vote", { round: open.payload!.round, choice: "surge" }));
  for (let i = 0; i < 100 && !got; i++) got = c.hostTick(0.5, true);
  expect(got).toBe("surge");
  expect(t.sent.find((s) => s.type === "nova:vote_result")!.payload).toMatchObject({ choice: "surge", surge: 1 });
});

test("a spectator can vote once per round; vote news from anyone but the host is ignored", async () => {
  const c = make("spectator");
  const results: string[] = [];
  c.onCrowdResult = (choice) => results.push(choice);
  await c.start(() => {});
  await c.onChannels({ squadId: null, watchId: "w", hostUserId: "host1" });
  t.onMessage(custom("troll", "nova:vote_open", { round: 1, seconds: 10 }));
  expect(c.vote).toBeNull();
  t.onMessage(custom("host1", "nova:vote_open", { round: 1, seconds: 10 }));
  expect(c.vote).toMatchObject({ round: 1, mine: null });
  c.castVote("supply");
  c.castVote("surge");
  expect(t.sent.filter((s) => s.type === "nova:vote")).toHaveLength(1);
  expect(c.vote!.mine).toBe("supply");
  t.onMessage(custom("troll", "nova:vote_result", { round: 1, choice: "surge", supply: 0, surge: 9 }));
  expect(results).toEqual([]);
  t.onMessage(custom("host1", "nova:vote_result", { round: 1, choice: "supply", supply: 1, surge: 0 }));
  expect(results).toEqual(["supply"]);
  expect(c.vote).toBeNull();
});

test("players can't vote, and a vote from a player's client isn't sent", async () => {
  const c = make("player");
  await c.start(() => {});
  await c.onChannels({ squadId: "s", watchId: "w", hostUserId: "h" });
  t.onMessage(custom("h", "nova:vote_open", { round: 1, seconds: 10 }));
  c.castVote("surge");
  expect(t.sent.filter((s) => s.type === "nova:vote")).toHaveLength(0);
});
