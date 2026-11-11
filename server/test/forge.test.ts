import { describe, expect, it } from "vitest";
import { Forge, cleanPrompt, type ForgeApi } from "../src/forge";
import { createRelayServer } from "../src/server";

function fakeApi() {
  const tasks = new Map<number, { status: number; outputs: { content: string }[] }>();
  let next = 100;
  const created: string[] = [];
  const api: ForgeApi = {
    async create(prompt) {
      created.push(prompt);
      const id = next++;
      tasks.set(id, { status: 1, outputs: [] });
      return id;
    },
    async get(taskId) {
      return tasks.get(taskId)!;
    },
  };
  return { api, tasks, created };
}

describe("HTTP routes", () => {
  it("reports on/off, starts a job and serves its status; 404s junk ids", async () => {
    const { api, tasks } = fakeApi();
    const relay = await createRelayServer(0, { forge: new Forge(api, () => 0) });
    const base = `http://127.0.0.1:${relay.port}`;
    try {
      expect(await (await fetch(`${base}/forge`)).json()).toEqual({ on: true });
      const bad = await fetch(`${base}/forge`, { method: "POST", body: JSON.stringify({ prompt: "" }) });
      expect(bad.status).toBe(400);
      const res = await fetch(`${base}/forge`, { method: "POST", body: JSON.stringify({ prompt: "a crystal golem" }) });
      const { id } = (await res.json()) as { id: string };
      expect(id).toMatch(/^[a-z0-9]+$/);
      tasks.set(100, { status: 1, outputs: [] });
      expect(await (await fetch(`${base}/forge/${id}`)).json()).toMatchObject({ state: "pending", prompt: "a crystal golem" });
      expect((await fetch(`${base}/forge/..%2Fetc`)).status).toBe(404);
    } finally {
      await relay.close();
    }
  });

  it("says off when the relay has no Lux3D key", async () => {
    const relay = await createRelayServer(0, {});
    try {
      expect(await (await fetch(`http://127.0.0.1:${relay.port}/forge`)).json()).toEqual({ on: false });
    } finally {
      await relay.close();
    }
  });
});

describe("cleanPrompt", () => {
  it("trims, collapses whitespace and strips control/markup characters", () => {
    expect(cleanPrompt("  a  giant\n<b>crab</b>  ")).toBe("a giant b crab /b");
  });

  it("rejects empty and over-long prompts", () => {
    expect(cleanPrompt("   ")).toBeNull();
    expect(cleanPrompt("x".repeat(121))).toBeNull();
    expect(cleanPrompt(42 as unknown as string)).toBeNull();
  });
});

describe("Forge", () => {
  it("creates a Lux3D task with the prompt wrapped as a boss and reports progress", async () => {
    const { api, tasks, created } = fakeApi();
    let now = 0;
    const forge = new Forge(api, () => now);
    const r = await forge.request("1.1.1.1", "a mechanical scorpion");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(created[0]).toContain("a mechanical scorpion");
    expect(created[0]).toContain("boss");

    expect((await forge.status(r.id)).state).toBe("pending");

    tasks.set(100, { status: 3, outputs: [{ content: "https://cdn.example/x.glb?sig=1" }] });
    now += 10_000;
    const done = await forge.status(r.id);
    expect(done).toMatchObject({ state: "ready", url: "https://cdn.example/x.glb?sig=1", prompt: "a mechanical scorpion" });
  });

  it("does not hit the API more than once per poll interval", async () => {
    const { api } = fakeApi();
    let calls = 0;
    const counting: ForgeApi = { create: api.create, get: (id) => (calls++, api.get(id)) };
    let now = 0;
    const forge = new Forge(counting, () => now);
    const r = await forge.request("1.1.1.1", "slime king");
    if (!r.ok) throw new Error("expected ok");
    await forge.status(r.id); // just created: nothing to ask yet
    expect(calls).toBe(0);
    now += 5_000;
    await forge.status(r.id);
    await forge.status(r.id);
    expect(calls).toBe(1);
    now += 5_000;
    await forge.status(r.id);
    expect(calls).toBe(2);
  });

  it("reports failure when the task fails", async () => {
    const { api, tasks } = fakeApi();
    let now = 0;
    const forge = new Forge(api, () => now);
    const r = await forge.request("1.1.1.1", "a dragon");
    if (!r.ok) throw new Error("expected ok");
    tasks.set(100, { status: 4, outputs: [] });
    now += 10_000;
    expect((await forge.status(r.id)).state).toBe("failed");
  });

  it("limits each address and caps the whole day to protect credits", async () => {
    const { api } = fakeApi();
    let now = 0;
    const forge = new Forge(api, () => now, { perIpPerHour: 2, perDay: 3 });
    expect((await forge.request("a", "one")).ok).toBe(true);
    expect((await forge.request("a", "two")).ok).toBe(true);
    expect(await forge.request("a", "three")).toEqual({ ok: false, error: "rate_limited" });
    expect((await forge.request("b", "four")).ok).toBe(true);
    expect(await forge.request("c", "five")).toEqual({ ok: false, error: "daily_cap" });
    now += 25 * 3600_000;
    expect((await forge.request("a", "six")).ok).toBe(true);
  });

  it("rejects bad prompts without spending anything", async () => {
    const { api, created } = fakeApi();
    const forge = new Forge(api, () => 0);
    expect(await forge.request("a", "   ")).toEqual({ ok: false, error: "bad_prompt" });
    expect(created).toEqual([]);
  });

  it("returns unknown for ids it never issued", async () => {
    const { api } = fakeApi();
    const forge = new Forge(api, () => 0);
    expect((await forge.status("nope")).state).toBe("unknown");
  });
});
