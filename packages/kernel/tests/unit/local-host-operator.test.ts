import { describe, expect, test } from "bun:test";
import type { LocalHostStatus } from "@clarvis/protocol";
import { createLocalHostOperator } from "../../src/hosting/operator.ts";

function fixture() {
  let now = 1_000;
  const controllers = new Map<string, string>();
  const operations: string[] = [];
  const status: LocalHostStatus = {
    host_generation: "generation",
    runtime: { kind: "native", host_platform: "test", isolation: "sandbox", lifecycle: "ready" },
    restart_requested: false,
  };
  const operator = createLocalHostOperator({
    inspect: () => status,
    canControl: (peer, session) => controllers.get(session) === peer,
    retryRuntime: async () => {
      operations.push("retry");
    },
    requestRestart: async () => {
      operations.push("restart");
    },
    now: () => now,
    browserTimeoutMs: 30_000,
  });
  return {
    operator,
    controllers,
    status,
    operations,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("local host operator authority", () => {
  test("browser claims follow current conversation control and stale responses cannot settle them", async () => {
    const f = fixture();
    try {
      const first = f.operator.connect("first");
      const next = f.operator.connect("next");
      f.controllers.set("conversation", "first");
      const outcome = f.operator.withSession("conversation", async () => {
        await Promise.resolve();
        return f.operator.openAuthorizationUrl("https://provider.example/authorize");
      });
      await Promise.resolve();
      expect(await next.takeBrowserRequest()).toBeNull();
      const claim = (await first.takeBrowserRequest())!;
      expect(claim.url).toBe("https://provider.example/authorize");
      claim.url = "https://other.example/changed";
      f.controllers.set("conversation", "next");
      await expect(first.respondBrowser(claim.id, true)).rejects.toMatchObject({
        code: "unauthorized",
      });
      expect((await next.takeBrowserRequest())?.url).toBe("https://provider.example/authorize");
      await next.respondBrowser(claim.id, false);
      expect(await outcome).toBe(false);
      await expect(next.respondBrowser(claim.id, true)).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      f.operator.close();
    }
  });

  test("disconnect relinquishes an unscoped browser claim and invalidates every old operator method", async () => {
    const f = fixture();
    try {
      const first = f.operator.connect("first");
      const next = f.operator.connect("next");
      const outcome = f.operator.openAuthorizationUrl("https://provider.example/authorize");
      const claim = (await first.takeBrowserRequest())!;
      expect(await next.takeBrowserRequest()).toBeNull();
      f.operator.disconnect("first");
      await expect(first.inspect()).rejects.toMatchObject({ code: "unavailable" });
      await expect(first.respondBrowser(claim.id, true)).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(first.requestRestart()).rejects.toMatchObject({ code: "unavailable" });
      expect((await next.takeBrowserRequest())?.id).toBe(claim.id);
      await next.respondBrowser(claim.id, true);
      expect(await outcome).toBe(true);
      expect(f.operations).toEqual([]);
    } finally {
      f.operator.close();
    }
  });

  test("fixed expiry and aggregate limits settle unanswered handoffs without opening a browser", async () => {
    const f = fixture();
    try {
      const client = f.operator.connect("operator");
      const outcomes = Array.from({ length: 8 }, () =>
        f.operator.openAuthorizationUrl("https://provider.example/authorize"),
      );
      await expect(
        f.operator.openAuthorizationUrl("https://provider.example/ninth"),
      ).rejects.toMatchObject({ code: "resource_exhausted" });
      const claimed = (await client.takeBrowserRequest())!;
      f.advance(30_000);
      expect(await client.takeBrowserRequest()).toBeNull();
      expect(await Promise.all(outcomes)).toEqual(Array(8).fill(false));
      await expect(client.respondBrowser(claimed.id, true)).rejects.toMatchObject({
        code: "not_found",
      });
      const pending = f.operator.openAuthorizationUrl("https://provider.example/new");
      f.operator.close();
      expect(await pending).toBe(false);
      await expect(client.takeBrowserRequest()).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.operator.close();
    }
  });

  test("inspection is a copy and only explicit operator actions request retry or restart", async () => {
    const f = fixture();
    try {
      const client = f.operator.connect("operator");
      const copy = await client.inspect();
      copy.restart_requested = true;
      expect((await client.inspect()).restart_requested).toBe(false);
      expect(f.operations).toEqual([]);
      for (const url of [
        "http://provider.example/auth",
        "https://user:pass@provider.example/",
        "file:///tmp/auth",
        "not a url",
      ])
        await expect(f.operator.openAuthorizationUrl(url)).rejects.toMatchObject({
          code: "invalid_request",
        });
      await client.retryRuntime();
      await client.requestRestart();
      expect(f.operations).toEqual(["retry", "restart"]);
    } finally {
      f.operator.close();
    }
  });
});
