import { describe, expect, test } from "bun:test";
import { NOOP_LOGGER, ProviderError, type ResolvedProviderConfig } from "@clarvis/capability";
import { buildRegistryFactory } from "#src/ai-sdk/provider-factory.ts";
import { SerializedPrefixWatch } from "#src/ai-sdk/request-prefix.ts";

function dependencies(readKey: (name: string) => string | undefined = () => "key") {
  return {
    resolveRegistryKey: readKey,
    boundedFetch: (async () => {
      throw new Error("factory construction must not issue a request");
    }) as unknown as typeof fetch,
    prefixWatch: new SerializedPrefixWatch(),
    maxResponseBytes: 1000,
    maxSseEventBytes: 100,
    logger: NOOP_LOGGER,
  };
}

describe("AI SDK provider factory", () => {
  test("constructs each registry variant without a request", () => {
    const seen: string[] = [];
    const deps = dependencies((name) => {
      seen.push(name);
      return "secret";
    });
    for (const kind of ["openai", "openai-compatible", "anthropic", "google"] as const) {
      const cfg: ResolvedProviderConfig = {
        kind,
        apiKeyEnv: "MODEL_KEY",
        ...(kind === "openai-compatible" ? { baseUrl: "https://gateway.example/v1" } : {}),
      };
      const built = buildRegistryFactory(cfg, undefined, [], deps);
      expect(built.factory("model")).toBeDefined();
      expect(built.apiKeyPresent).toBeTrue();
    }
    expect(seen).toEqual(["MODEL_KEY", "MODEL_KEY", "MODEL_KEY", "MODEL_KEY"]);
  });

  test("a changed or revoked key is resolved again for the next factory", () => {
    let key: string | undefined = "first";
    const deps = dependencies(() => key);
    const cfg: ResolvedProviderConfig = { kind: "openai", apiKeyEnv: "MODEL_KEY" };
    expect(buildRegistryFactory(cfg, undefined, [], deps).apiKeyPresent).toBeTrue();
    key = "second";
    expect(buildRegistryFactory(cfg, undefined, [], deps).apiKeyPresent).toBeTrue();
    key = undefined;
    expect(() => buildRegistryFactory(cfg, undefined, [], deps)).toThrow(ProviderError);
  });

  test("a keyed provider without a credential setting fails before constructing the client", () => {
    expect(() => buildRegistryFactory({ kind: "openai" }, undefined, [], dependencies())).toThrow(
      /requires api_key_env/,
    );
  });

  test("subscription authorization stays at fetch time", () => {
    let resolutions = 0;
    const deps = {
      ...dependencies(),
      resolveSubscription: async () => {
        resolutions++;
        return { apply: async () => new Response("unused") };
      },
    };
    for (const kind of ["openai-codex", "xai-grok"] as const) {
      const built = buildRegistryFactory({ kind }, "conversation", [], deps);
      expect(built.factory("model")).toBeDefined();
      expect(built.apiKeyPresent).toBeFalse();
    }
    expect(resolutions).toBe(0);
    expect(() =>
      buildRegistryFactory({ kind: "openai-codex" }, undefined, [], dependencies()),
    ).toThrow(ProviderError);
  });
});
