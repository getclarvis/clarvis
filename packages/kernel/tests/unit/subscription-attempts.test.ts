import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import { DeviceAttemptManager } from "../../src/subscriptions/attempts.ts";
import type {
  SubscriptionAccountRecord,
  SubscriptionPollResult,
  SubscriptionSchemeAdapter,
  SubscriptionSchemeRegistration,
} from "../../src/subscriptions/types.ts";

const registration: SubscriptionSchemeRegistration = {
  scheme: "openai-codex",
  clientId: "test-client",
  issuer: "https://auth.test",
  transportOrigin: "https://transport.test",
  authorization: { owner: "clarvis", evidence: "test" },
};

function adapter(poll: () => SubscriptionPollResult): SubscriptionSchemeAdapter {
  return {
    scheme: "openai-codex",
    startDevice: async () => ({
      deviceCode: "provider-device-secret",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.test/device",
      expiresInSeconds: 600,
      intervalSeconds: 0.1,
    }),
    pollDevice: async () => poll(),
    refresh: async () => {
      throw new Error("not used");
    },
    catalog: async () => {
      throw new Error("not used");
    },
    apply: async () => new Response("not used"),
  };
}

describe("device subscription attempts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses the one-second floor and persists a completed token response", async () => {
    let now = 0;
    const persisted: SubscriptionAccountRecord[] = [];
    const manager = new DeviceAttemptManager({
      now: () => now,
      persist: async (_scheme, account) => {
        persisted.push(account);
        return { scheme: "openai-codex", state: "connected", authorization_available: true };
      },
    });
    const grant = await manager.start(
      registration,
      adapter(() => ({
        state: "connected",
        tokens: {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: 20_000,
          accountId: "account",
        },
      })),
    );
    expect(grant.polling_interval_ms).toBe(1_000);

    const waiting = manager.wait(grant.attempt_id);
    now = 1_000;
    vi.advanceTimersByTime(1_000);
    expect(await waiting).toMatchObject({ state: "connected" });
    expect(persisted).toEqual([
      {
        access_token: "access",
        refresh_token: "refresh",
        expires_at: 20_000,
        account_id: "account",
      },
    ]);
  });

  it("adds five seconds after slow_down before polling again", async () => {
    let now = 0;
    let polls = 0;
    const manager = new DeviceAttemptManager({
      now: () => now,
      persist: async () => ({
        scheme: "openai-codex",
        state: "connected",
        authorization_available: true,
      }),
    });
    const grant = await manager.start(
      registration,
      adapter(() => {
        polls += 1;
        return polls === 1
          ? { state: "slow_down" }
          : {
              state: "connected",
              tokens: { accessToken: "a", refreshToken: "r", expiresAt: 20_000 },
            };
      }),
    );
    const waiting = manager.wait(grant.attempt_id);
    now = 1_000;
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(polls).toBe(1);
    now = 7_000;
    vi.advanceTimersByTime(5_999);
    await Promise.resolve();
    expect(polls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(await waiting).toMatchObject({ state: "connected" });
    expect(polls).toBe(2);
  });

  it("returns stable denied and expired outcomes without persisting", async () => {
    for (const outcome of ["denied", "expired"] as const) {
      let now = 0;
      let persists = 0;
      const manager = new DeviceAttemptManager({
        now: () => now,
        persist: async () => {
          persists += 1;
          throw new Error("unexpected");
        },
      });
      const grant = await manager.start(
        registration,
        adapter(() => ({ state: outcome })),
      );
      const waiting = manager.wait(grant.attempt_id);
      now = 1_000;
      vi.advanceTimersByTime(1_000);
      expect(await waiting).toMatchObject({
        state: outcome === "expired" ? "expired" : "disconnected",
      });
      expect(persists).toBe(0);
    }
  });

  it("cancels polling and refuses a duplicate live start", async () => {
    const manager = new DeviceAttemptManager({
      persist: async () => {
        throw new Error("unexpected");
      },
    });
    const grant = await manager.start(
      registration,
      adapter(() => ({ state: "pending" })),
    );
    await expect(
      manager.start(
        registration,
        adapter(() => ({ state: "pending" })),
      ),
    ).rejects.toThrow("already active");
    const waiting = manager.wait(grant.attempt_id);
    await manager.cancel(grant.attempt_id);
    expect(await waiting).toMatchObject({ state: "disconnected" });
    expect(manager.connecting("openai-codex")).toBe(false);
  });

  it("rate-limits repeated starts and cancels every live scheme", async () => {
    let now = 60_000;
    const manager = new DeviceAttemptManager({
      now: () => now,
      persist: async () => {
        throw new Error("unexpected");
      },
    });
    for (let index = 0; index < 3; index += 1) {
      const grant = await manager.start(
        registration,
        adapter(() => ({ state: "pending" })),
      );
      await manager.cancel(grant.attempt_id);
      now += 1;
    }
    await expect(
      manager.start(
        registration,
        adapter(() => ({ state: "pending" })),
      ),
    ).rejects.toThrow("Too many");

    now = 121_000;
    await manager.start(
      registration,
      adapter(() => ({ state: "pending" })),
    );
    await manager.start(
      { ...registration, scheme: "xai-grok" },
      { ...adapter(() => ({ state: "pending" })), scheme: "xai-grok" },
    );
    await manager.cancelAll();
    expect(manager.connecting("openai-codex")).toBe(false);
    expect(manager.connecting("xai-grok")).toBe(false);
  });
});
