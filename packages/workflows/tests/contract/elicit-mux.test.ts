import { describe, expect, test } from "bun:test";
import type { Elicit, ElicitParams } from "@clarvis/capability";
import { createElicitMux } from "../../src/elicit-mux.ts";

function params(message: string): ElicitParams {
  return { message, requestedSchema: { type: "object", properties: {}, required: [] } };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createElicitMux", () => {
  test("presents only one prompt at a time across concurrent leaders", async () => {
    const seen: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const user: Elicit = async (p) => {
      seen.push(p.message);
      calls += 1;
      if (calls === 1) await firstHeld;
      return { action: "accept", content: {} };
    };
    const mux = createElicitMux(user);

    const first = mux.forLeader("aaaaaaaa1111")(params("Q1"), {});
    const second = mux.forLeader("bbbbbbbb2222")(params("Q2"), {});
    await flush();

    expect(calls).toBe(1);
    expect(seen[0]).toContain("Q1");
    expect(seen[0]).toContain("leader aaaaaaaa");

    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(seen[1]).toContain("Q2");
    expect(seen[1]).toContain("leader bbbbbbbb");
  });

  test("the manager channel presents its prompt untagged", async () => {
    const seen: string[] = [];
    const user: Elicit = async (p) => {
      seen.push(p.message);
      return { action: "accept", content: {} };
    };
    await createElicitMux(user).manager(params("hello"), {});
    expect(seen[0]).toBe("hello");
  });

  test("a queued prompt whose signal aborts settles at once, without waiting its turn", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const user: Elicit = async () => {
      calls += 1;
      if (calls === 1) await firstHeld;
      return { action: "accept", content: {} };
    };
    const mux = createElicitMux(user);
    const controller = new AbortController();

    const first = mux.forLeader("aaaaaaaa1111")(params("Q1"), {});
    const queued = mux.forLeader("bbbbbbbb2222")(params("Q2"), { signal: controller.signal });
    await flush();

    controller.abort(new Error("its agent was stopped"));
    const started = Date.now();
    await expect(queued).resolves.toEqual({ action: "cancel" });
    expect(Date.now() - started).toBeLessThan(50);
    expect(calls).toBe(1);

    releaseFirst();
    await first;
  });

  test("an aborted prompt is never presented to the human, even when its turn comes", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const seen: string[] = [];
    let calls = 0;
    const user: Elicit = async (p) => {
      seen.push(p.message);
      calls += 1;
      if (calls === 1) await firstHeld;
      return { action: "accept", content: {} };
    };
    const mux = createElicitMux(user);
    const controller = new AbortController();

    const first = mux.forLeader("aaaaaaaa1111")(params("Q1"), {});
    const queued = mux.forLeader("bbbbbbbb2222")(params("Q2"), { signal: controller.signal });
    await flush();
    controller.abort(new Error("stopped"));
    await queued;

    releaseFirst();
    await first;
    await flush();

    expect(seen.some((m) => m.includes("Q2"))).toBe(false);
  });

  test("a real transport error propagates as a rejection, not a silent cancel", async () => {
    const failure = new Error("relay unreachable");
    const user: Elicit = async () => {
      throw failure;
    };
    const mux = createElicitMux(user);
    const controller = new AbortController();

    await expect(
      mux.forLeader("aaaaaaaa1111")(params("Q1"), { signal: controller.signal }),
    ).rejects.toBe(failure);
  });

  test("an already-aborted signal never reaches the transport at all", async () => {
    let calls = 0;
    const user: Elicit = async () => {
      calls += 1;
      return { action: "accept", content: {} };
    };
    const controller = new AbortController();
    controller.abort();
    const result = await createElicitMux(user).manager(params("Q"), {
      signal: controller.signal,
    });
    expect(result).toEqual({ action: "cancel" });
    expect(calls).toBe(0);
  });
});
