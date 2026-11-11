import { describe, expect, it } from "vitest";
import { ForgeClient, forgeStatusLine } from "../../src/forge/forgeClient";

type Reply = { status?: number; body: unknown };

/** A fetch stand-in that answers from a queue per "METHOD path". */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: string[] = [];
  const fn = async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const key = `${init?.method ?? "GET"} ${path}`;
    calls.push(key);
    const queue = routes[key] ?? routes[`${init?.method ?? "GET"} *`];
    const r = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!r) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ForgeClient", () => {
  it("is off without a relay", async () => {
    const c = new ForgeClient(null);
    await c.checkAvailable();
    expect(c.state.kind).toBe("off");
  });

  it("goes idle when the relay has Forge on, off when it does not", async () => {
    const on = new ForgeClient("http://relay", fakeFetch({ "GET /forge": [{ body: { on: true } }] }).fn);
    await on.checkAvailable();
    expect(on.state.kind).toBe("idle");
    const off = new ForgeClient("http://relay", fakeFetch({ "GET /forge": [{ body: { on: false } }] }).fn);
    await off.checkAvailable();
    expect(off.state.kind).toBe("off");
  });

  it("sends the prompt, polls until ready, then reports the model once", async () => {
    let now = 0;
    const f = fakeFetch({
      "GET /forge": [{ body: { on: true } }],
      "POST /forge": [{ body: { id: "job1" } }],
      "GET /forge/job1": [
        { body: { state: "pending", prompt: "a crab", elapsedMs: 1000 } },
        { body: { state: "ready", prompt: "a crab", url: "https://cdn/x.glb" } },
      ],
    });
    const c = new ForgeClient("http://relay", f.fn, () => now);
    await c.checkAvailable();
    const ready: string[] = [];
    c.onReady = (url, prompt) => ready.push(`${prompt}@${url}`);

    await c.start("a crab");
    expect(c.state).toMatchObject({ kind: "pending", prompt: "a crab" });

    c.tick();
    await flush();
    expect(f.calls.filter((k) => k === "GET /forge/job1")).toHaveLength(0); // waits for the poll interval

    now += 4000;
    c.tick();
    await flush();
    expect(c.state.kind).toBe("pending");

    now += 4000;
    c.tick();
    await flush();
    expect(c.state).toMatchObject({ kind: "ready", url: "https://cdn/x.glb" });
    c.tick();
    await flush();
    expect(ready).toEqual(["a crab@https://cdn/x.glb"]);
  });

  it("surfaces rate limits and failures as readable states", async () => {
    const limited = new ForgeClient(
      "http://relay",
      fakeFetch({ "GET /forge": [{ body: { on: true } }], "POST /forge": [{ status: 429, body: { error: "rate_limited" } }] }).fn,
    );
    await limited.checkAvailable();
    await limited.start("x");
    expect(limited.state).toMatchObject({ kind: "failed", reason: "rate_limited" });
  });

  it("ignores a second start while a forge is running", async () => {
    const f = fakeFetch({ "GET /forge": [{ body: { on: true } }], "POST /forge": [{ body: { id: "a" } }] });
    const c = new ForgeClient("http://relay", f.fn);
    await c.checkAvailable();
    await c.start("one");
    await c.start("two");
    expect(f.calls.filter((k) => k === "POST /forge")).toHaveLength(1);
  });
});

describe("forgeStatusLine", () => {
  it("describes each state briefly", () => {
    expect(forgeStatusLine({ kind: "off" })).toBeNull();
    expect(forgeStatusLine({ kind: "idle" })).toBeNull();
    expect(forgeStatusLine({ kind: "pending", prompt: "a crab", elapsedMs: 65_000 })).toBe("⚒ Forging “a crab” · 1:05");
    expect(forgeStatusLine({ kind: "ready", prompt: "a crab", url: "u" })).toBe("⚒ “a crab” is forged. It comes with the next boss.");
    expect(forgeStatusLine({ kind: "failed", prompt: "a crab", reason: "daily_cap" })).toBe("⚒ Forge is out of energy today");
  });
});
