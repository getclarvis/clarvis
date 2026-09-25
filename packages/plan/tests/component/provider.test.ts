import { describe, expect, test } from "bun:test";

import { PlanProviderUnavailableError, createPlanFactory } from "../../src/index.ts";
import { markdownStore } from "../helpers/provider.ts";

describe("PlanFactory", () => {
  test("defaults to Markdown and memoizes one store per owner", async () => {
    let constructions = 0;
    const factory = createPlanFactory({
      loadProvider: () => undefined,
      markdownStoreFor: () => {
        constructions += 1;
        return markdownStore();
      },
    });
    const first = await factory.storeFor("alice");
    expect((await factory.storeFor("alice")).store).toBe(first.store);
    expect((await factory.storeFor("bob")).store).not.toBe(first.store);
    expect(constructions).toBe(2);
  });

  test("evicts one inactive owner's provider resolutions without touching peers", async () => {
    let constructions = 0;
    const factory = createPlanFactory({
      loadProvider: () => undefined,
      markdownStoreFor: () => {
        constructions += 1;
        return markdownStore();
      },
    });
    const alice = await factory.storeFor("alice");
    const bob = await factory.storeFor("bob");

    factory.evictOwner?.("alice");

    expect((await factory.storeFor("alice")).store).not.toBe(alice.store);
    expect((await factory.storeFor("bob")).store).toBe(bob.store);
    expect(constructions).toBe(3);
  });

  test("rejects unsupported provider settings", async () => {
    const factory = createPlanFactory({
      loadProvider: () => ({ kind: "executable" }) as never,
      markdownStoreFor: markdownStore,
    });
    await expect(factory.storeFor("alice")).rejects.toBeInstanceOf(PlanProviderUnavailableError);
  });
});
