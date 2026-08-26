import { describe, expect, it, vi } from "bun:test";
import type { CatalogProvider, SubscriptionScheme } from "@clarvis/protocol";

import { SubscriptionManager } from "../../src/subscriptions/manager.ts";
import { subscriptionRegistration } from "../../src/subscriptions/registrations.ts";
import { SubscriptionHttpError, SubscriptionTransportError } from "../../src/subscriptions/http.ts";
import { SubscriptionError, subscriptionDiagnostic } from "../../src/subscriptions/redaction.ts";
import { createUnavailableProviderAuthService } from "../../src/subscriptions/unavailable.ts";
import type { SubscriptionStore } from "../../src/subscriptions/store.ts";
import type {
  SubscriptionAccountRecord,
  SubscriptionFileV1,
  SubscriptionSchemeAdapter,
  SubscriptionSchemeRegistration,
} from "../../src/subscriptions/types.ts";

describe("production subscription registrations", () => {
  it.each(["openai-codex", "xai-grok"] as const)(
    "enables the project-approved %s public-client registration",
    (scheme) => {
      expect(subscriptionRegistration(scheme)).toMatchObject({
        scheme,
        authorization: { owner: "project-owner-approved-public-reference" },
      });
    },
  );
});

const REGISTRATIONS: Record<SubscriptionScheme, SubscriptionSchemeRegistration> = {
  "openai-codex": {
    scheme: "openai-codex",
    clientId: "test-openai-client",
    issuer: "https://auth.openai.test",
    transportOrigin: "https://chatgpt.test",
    authorization: { owner: "clarvis", evidence: "test registration" },
  },
  "xai-grok": {
    scheme: "xai-grok",
    clientId: "test-xai-client",
    issuer: "https://auth.xai.test",
    transportOrigin: "https://grok.test",
    authorization: { owner: "clarvis", evidence: "test registration" },
  },
};

function account(token: string, id: string, expiresAt = 1_000_000): SubscriptionAccountRecord {
  return {
    access_token: `access-${token}`,
    refresh_token: `refresh-${token}`,
    expires_at: expiresAt,
    account_id: id,
  };
}

function memoryStore(
  initial: SubscriptionFileV1,
): SubscriptionStore & { value: SubscriptionFileV1 } {
  let tail = Promise.resolve();
  const store = {
    value: structuredClone(initial),
    path: () => "/test/subscriptions.json",
    async read() {
      return { ok: true as const, value: structuredClone(store.value) };
    },
    async mutateAccount<T>(
      scheme: SubscriptionScheme,
      mutate: (
        current: SubscriptionAccountRecord | undefined,
      ) =>
        | { account: SubscriptionAccountRecord | undefined; result: T }
        | Promise<{ account: SubscriptionAccountRecord | undefined; result: T }>,
    ): Promise<T> {
      let release!: () => void;
      const prior = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        const next = await mutate(store.value.accounts[scheme]);
        if (next.account === undefined) delete store.value.accounts[scheme];
        else store.value.accounts[scheme] = structuredClone(next.account);
        return next.result;
      } finally {
        release();
      }
    },
  };
  return store;
}

function adapter(
  scheme: SubscriptionScheme,
  options: {
    refresh?: (current: string) => Promise<SubscriptionAccountRecord>;
    apply?: (record: SubscriptionAccountRecord) => Response;
  } = {},
): SubscriptionSchemeAdapter {
  const catalog: CatalogProvider = {
    id: scheme,
    name: scheme,
    kind: scheme,
    needs_base_url: false,
    models: [{ id: `${scheme}-model`, capabilities: ["tool_calling"] }],
  };
  return {
    scheme,
    startDevice: async () => {
      throw new Error("not used");
    },
    pollDevice: async () => ({ state: "pending" }),
    async refresh(_registration, refreshToken) {
      const next = options.refresh
        ? await options.refresh(refreshToken)
        : account(`${scheme}-rotated`, `${scheme}-account`, 20_000);
      return {
        accessToken: next.access_token,
        refreshToken: next.refresh_token,
        expiresAt: next.expires_at,
        accountId: next.account_id,
      };
    },
    catalog: async () => catalog,
    apply: async (_registration, record) =>
      options.apply?.(record) ?? new Response(record.access_token, { status: 200 }),
  };
}

describe("production subscription availability", () => {
  it("exposes both project-approved schemes to the local manager", async () => {
    const manager = new SubscriptionManager({
      store: memoryStore({ version: 1, accounts: {} }),
      adapters: [adapter("openai-codex"), adapter("xai-grok")],
    });
    expect(await manager.list()).toEqual([
      { scheme: "openai-codex", state: "disconnected", authorization_available: true },
      { scheme: "xai-grok", state: "disconnected", authorization_available: true },
    ]);
  });
});

describe("SubscriptionManager coexistence", () => {
  it("runs and cancels manager-owned device attempts", async () => {
    vi.useFakeTimers();
    try {
      let state: "connected" | "pending" = "connected";
      const base = adapter("openai-codex");
      const deviceAdapter: SubscriptionSchemeAdapter = {
        ...base,
        startDevice: async () => ({
          deviceCode: "secret-device",
          userCode: "SAFE-CODE",
          verificationUrl: "https://auth.openai.test/device",
          expiresInSeconds: 60,
          intervalSeconds: 1,
        }),
        pollDevice: async () =>
          state === "connected"
            ? {
                state: "connected",
                tokens: {
                  accessToken: "connected-access",
                  refreshToken: "connected-refresh",
                  expiresAt: 500_000,
                  accountId: "oa-account",
                },
              }
            : { state: "pending" },
      };
      const store = memoryStore({ version: 1, accounts: {} });
      const manager = new SubscriptionManager({
        store,
        registrations: REGISTRATIONS,
        adapters: [deviceAdapter, adapter("xai-grok")],
        now: () => 1_000,
      });
      const device = await manager.startDevice("openai-codex");
      const waiting = manager.wait(device.attempt_id);
      vi.advanceTimersByTime(1_000);
      await expect(waiting).resolves.toMatchObject({ state: "connected" });
      expect(store.value.accounts["openai-codex"]?.access_token).toBe("connected-access");

      state = "pending";
      const second = await manager.startDevice("openai-codex");
      const cancelled = manager.wait(second.attempt_id);
      await manager.cancel(second.attempt_id);
      await expect(cancelled).resolves.toMatchObject({ state: "disconnected" });
      await manager.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the unavailable service and diagnostic projection closed", async () => {
    const unavailable = createUnavailableProviderAuthService();
    expect(await unavailable.list()).toHaveLength(2);
    await expect(unavailable.startDevice("openai-codex")).rejects.toMatchObject({
      code: "subscription_unavailable",
    });
    await expect(unavailable.wait("missing")).rejects.toMatchObject({
      code: "subscription_login_failed",
    });
    await unavailable.cancel("missing");
    await unavailable.disconnect("openai-codex");
    expect(
      subscriptionDiagnostic(
        new SubscriptionError("subscription_login_failed", "safe", "invalid_grant"),
      ),
    ).toBe("invalid_grant");
    expect(subscriptionDiagnostic(new Error("provider detail"))).toBe("network");
  });

  it("reports unavailable, disconnected, expired, and unreadable credential states", async () => {
    const store = memoryStore({
      version: 1,
      accounts: { "openai-codex": account("old", "oa-account", 500) },
    });
    const manager = new SubscriptionManager({
      store,
      registrations: { "openai-codex": REGISTRATIONS["openai-codex"] },
      adapters: [adapter("openai-codex")],
      now: () => 1_000,
    });
    expect(await manager.list()).toEqual([
      expect.objectContaining({ scheme: "openai-codex", state: "expired" }),
      expect.objectContaining({ scheme: "xai-grok", state: "unavailable" }),
    ]);
    await expect(manager.startDevice("xai-grok")).rejects.toMatchObject({
      code: "subscription_unavailable",
    });
    await expect(manager.resolve("xai-grok")).rejects.toMatchObject({
      code: "subscription_unavailable",
    });

    delete store.value.accounts["openai-codex"];
    await expect(manager.resolve("openai-codex")).rejects.toMatchObject({
      code: "subscription_login_required",
    });
    const unreadable = new SubscriptionManager({
      store: { ...store, read: async () => ({ ok: false as const, diagnostic: "unreadable" }) },
      registrations: REGISTRATIONS,
      adapters: [adapter("openai-codex"), adapter("xai-grok")],
    });
    expect(await unreadable.list()).toEqual([
      expect.objectContaining({ state: "reauthentication_required" }),
      expect.objectContaining({ state: "reauthentication_required" }),
    ]);
    await expect(unreadable.resolve("openai-codex")).rejects.toMatchObject({
      code: "subscription_reauthentication_required",
    });
  });

  it("caches entitled catalogs and retries one catalog authentication failure after refresh", async () => {
    const store = memoryStore({
      version: 1,
      accounts: { "openai-codex": account("old", "oa-account") },
    });
    let catalogs = 0;
    const base = adapter("openai-codex", {
      refresh: async () => account("new", "oa-account", 500_000),
    });
    const catalogAdapter: SubscriptionSchemeAdapter = {
      ...base,
      async catalog() {
        catalogs += 1;
        if (catalogs === 1) throw new SubscriptionHttpError(401, "catalog");
        return {
          id: "openai-codex",
          name: "ChatGPT",
          kind: "openai-codex",
          needs_base_url: false,
          models: [{ id: `model-${catalogs}`, capabilities: ["tool_calling"] }],
        };
      },
    };
    const manager = new SubscriptionManager({
      store,
      registrations: REGISTRATIONS,
      adapters: [catalogAdapter, adapter("xai-grok")],
      now: () => 1_000,
    });
    expect((await manager.getEntitled("openai-codex")).models[0]?.id).toBe("model-2");
    expect((await manager.getEntitled("openai-codex")).models[0]?.id).toBe("model-2");
    const service = manager.catalogService({
      get: async () => ({ source: "bundle", providers: [] }),
      refresh: async () => ({ source: "bundle", providers: [] }),
    });
    expect((await service.get()).source).toBe("bundle");
    expect((await service.refresh()).source).toBe("bundle");
    expect((await service.getEntitled("openai-codex")).models[0]?.id).toBe("model-2");
    expect((await service.refreshEntitled("openai-codex")).models[0]?.id).toBe("model-3");
    expect(catalogs).toBe(3);
  });

  it("maps request transport, entitlement, quota, and post-refresh authentication failures", async () => {
    const run = async (status: number) => {
      const store = memoryStore({
        version: 1,
        accounts: { "openai-codex": account("old", "oa-account") },
      });
      const manager = new SubscriptionManager({
        store,
        registrations: REGISTRATIONS,
        adapters: [
          adapter("openai-codex", { apply: () => new Response(null, { status }) }),
          adapter("xai-grok"),
        ],
        now: () => 1_000,
      });
      return (await manager.resolve("openai-codex")).apply("https://chatgpt.test/responses");
    };
    await expect(run(401)).rejects.toMatchObject({
      code: "subscription_reauthentication_required",
    });
    await expect(run(403)).rejects.toMatchObject({ code: "subscription_entitlement_denied" });
    await expect(run(429)).rejects.toMatchObject({ code: "subscription_quota_exhausted" });

    const transportAdapter: SubscriptionSchemeAdapter = {
      ...adapter("openai-codex"),
      apply: async () => {
        throw new SubscriptionTransportError();
      },
    };
    const manager = new SubscriptionManager({
      store: memoryStore({
        version: 1,
        accounts: { "openai-codex": account("old", "oa-account") },
      }),
      registrations: REGISTRATIONS,
      adapters: [transportAdapter, adapter("xai-grok")],
      now: () => 1_000,
    });
    await expect(
      (await manager.resolve("openai-codex")).apply("https://chatgpt.test/responses"),
    ).rejects.toMatchObject({ code: "subscription_transport_refused" });
  });

  it("maps catalog entitlement failures before and after a refresh retry", async () => {
    const build = (statuses: number[]) => {
      const base = adapter("openai-codex", {
        refresh: async () => account("new", "oa-account", 500_000),
      });
      let call = 0;
      const failing: SubscriptionSchemeAdapter = {
        ...base,
        catalog: async () => {
          throw new SubscriptionHttpError(
            statuses[Math.min(call++, statuses.length - 1)]!,
            "catalog",
          );
        },
      };
      return new SubscriptionManager({
        store: memoryStore({
          version: 1,
          accounts: { "openai-codex": account("old", "oa-account") },
        }),
        registrations: REGISTRATIONS,
        adapters: [failing, adapter("xai-grok")],
        now: () => 1_000,
      });
    };
    await expect(build([403]).getEntitled("openai-codex")).rejects.toMatchObject({
      code: "subscription_entitlement_denied",
    });
    await expect(build([401, 403]).getEntitled("openai-codex")).rejects.toMatchObject({
      code: "subscription_entitlement_denied",
    });
    await expect(build([401, 401]).getEntitled("openai-codex")).rejects.toMatchObject({
      code: "subscription_reauthentication_required",
    });
  });

  it("keeps ChatGPT and Grok connected and request-authorized independently", async () => {
    const store = memoryStore({
      version: 1,
      accounts: {
        "openai-codex": account("openai", "oa-account"),
        "xai-grok": account("grok", "xai-account"),
      },
    });
    const manager = new SubscriptionManager({
      store,
      registrations: REGISTRATIONS,
      adapters: [adapter("openai-codex"), adapter("xai-grok")],
      now: () => 1_000,
    });

    expect(await manager.list()).toEqual([
      expect.objectContaining({ scheme: "openai-codex", state: "connected" }),
      expect.objectContaining({ scheme: "xai-grok", state: "connected" }),
    ]);
    const openai = await manager.resolve("openai-codex");
    const grok = await manager.resolve("xai-grok");
    expect(await (await openai.apply("https://chatgpt.test/responses")).text()).toBe(
      "access-openai",
    );
    expect(await (await grok.apply("https://grok.test/responses")).text()).toBe("access-grok");

    await manager.disconnect("openai-codex");
    expect(store.value.accounts["openai-codex"]).toBeUndefined();
    expect(store.value.accounts["xai-grok"]?.access_token).toBe("access-grok");
    expect((await manager.list()).find((item) => item.scheme === "xai-grok")?.state).toBe(
      "connected",
    );
  });

  it("single-flights a rotating refresh without touching the other scheme", async () => {
    const store = memoryStore({
      version: 1,
      accounts: {
        "openai-codex": account("old", "oa-account", 1_100),
        "xai-grok": account("grok", "xai-account", 50_000),
      },
    });
    let refreshes = 0;
    const openaiAdapter = adapter("openai-codex", {
      refresh: async () => {
        refreshes += 1;
        await Promise.resolve();
        return account("new", "oa-account", 50_000);
      },
    });
    const manager = new SubscriptionManager({
      store,
      registrations: REGISTRATIONS,
      adapters: [openaiAdapter, adapter("xai-grok")],
      now: () => 1_000,
    });

    const [first, second] = await Promise.all([
      manager.resolve("openai-codex"),
      manager.resolve("openai-codex"),
    ]);
    expect(refreshes).toBe(1);
    expect(await (await first.apply("https://chatgpt.test/responses")).text()).toBe("access-new");
    expect(await (await second.apply("https://chatgpt.test/responses")).text()).toBe("access-new");
    expect(store.value.accounts["xai-grok"]?.refresh_token).toBe("refresh-grok");
  });

  it("deletes a rotated record when account continuity changes", async () => {
    const store = memoryStore({
      version: 1,
      accounts: { "openai-codex": account("old", "account-a", 1_100) },
    });
    const manager = new SubscriptionManager({
      store,
      registrations: REGISTRATIONS,
      adapters: [
        adapter("openai-codex", {
          refresh: async () => account("new", "account-b", 50_000),
        }),
        adapter("xai-grok"),
      ],
      now: () => 1_000,
    });

    await expect(manager.resolve("openai-codex")).rejects.toMatchObject({
      code: "subscription_reauthentication_required",
    });
    expect(store.value.accounts["openai-codex"]).toBeUndefined();
  });

  it("does not replay a rotating token across two managers after concurrent 401s", async () => {
    const store = memoryStore({
      version: 1,
      accounts: { "openai-codex": account("old", "oa-account", 1_000_000) },
    });
    let refreshes = 0;
    const sharedAdapter = adapter("openai-codex", {
      refresh: async () => {
        refreshes += 1;
        return account("new", "oa-account", 1_000_000);
      },
      apply: (record) =>
        new Response(record.access_token, {
          status: record.access_token === "access-old" ? 401 : 200,
        }),
    });
    const build = () =>
      new SubscriptionManager({
        store,
        registrations: REGISTRATIONS,
        adapters: [sharedAdapter, adapter("xai-grok")],
        now: () => 1_000,
      });
    const first = await build().resolve("openai-codex");
    const second = await build().resolve("openai-codex");

    const responses = await Promise.all([
      first.apply("https://chatgpt.test/responses"),
      second.apply("https://chatgpt.test/responses"),
    ]);
    expect(refreshes).toBe(1);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      "access-new",
      "access-new",
    ]);
    expect(store.value.accounts["openai-codex"]?.refresh_token).toBe("refresh-new");
  });
});
