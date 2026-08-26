import { describe, it, expect } from "../helpers/bun-test.ts";
import { resolveProvider } from "../../src/provider-resolver.ts";
import type { ProviderConfig } from "../../src/api.ts";

const registry: ProviderConfig[] = [
  {
    name: "deepinfra",
    kind: "openai-compatible",
    base_url: "https://api.deepinfra.com/v1/openai",
    api_key_env: "DI_KEY",
  },
  { name: "together", kind: "openai-compatible", base_url: "https://api.together.xyz/v1" },
];

describe("resolveProvider", () => {
  it("resolves a registry entry to its config (NAMES only — no key value)", () => {
    expect(resolveProvider("deepinfra", registry)).toEqual({
      ok: true,
      config: {
        kind: "openai-compatible",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKeyEnv: "DI_KEY",
      },
    });
  });

  it("omits apiKeyEnv when the registry entry declares none", () => {
    const r = resolveProvider("together", registry);
    expect(r.ok && r.config).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
    });
  });

  it("resolves an entry whose name matches a provider-kind token", () => {
    const shadow: ProviderConfig[] = [
      {
        name: "openai-compatible",
        kind: "openai-compatible",
        base_url: "https://shadow.example/v1",
      },
    ];
    const r = resolveProvider("openai-compatible", shadow);
    expect(r.ok && r.config?.baseUrl).toBe("https://shadow.example/v1");
  });

  it("returns unknown_provider for a token absent from the registry", () => {
    const r = resolveProvider("madeup", registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_provider");
  });

  it("returns unknown_provider for a known-kind token when no registry is given", () => {
    for (const t of ["openai", "anthropic", "google", "gemini", "openai-compatible"]) {
      const r = resolveProvider(t, undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("unknown_provider");
    }
  });
});

describe("provider-resolver config spreads", () => {
  const registry: ProviderConfig[] = [
    {
      name: "deepinfra",
      kind: "openai-compatible",
      base_url: "https://api.deepinfra.com/v1/openai",
      api_key_env: "DI_KEY",
    },
    { name: "bare", kind: "openai" },
  ];

  it("omits baseUrl and apiKeyEnv when the entry declares neither", () => {
    const r = resolveProvider("bare", registry);
    expect(r.ok && r.config).toEqual({ kind: "openai" });
  });
});

describe("resolveProvider per-model projection", () => {
  const registry: ProviderConfig[] = [
    {
      name: "openrouter",
      kind: "openai-compatible",
      base_url: "https://openrouter.ai/api/v1",
      api_key_env: "OPENROUTER_API_KEY",
      headers: { "HTTP-Referer": "https://example.dev", "X-Partner": "${PARTNER_TOKEN}" },
      body: { provider: { order: ["deepseek"], allow_fallbacks: false }, top_k: 40 },
      models: {
        "deepseek/v4": {
          context_window_tokens: 1_048_576,
          prompt_cache: "explicit",
          headers: { "X-Partner": "${OTHER_TOKEN}" },
          body: { provider: { allow_fallbacks: true } },
        },
        "plain/model": { context_window_tokens: 128_000 },
      },
    },
  ];

  it("projects nothing model-scoped when no modelId is supplied", () => {
    const r = resolveProvider("openrouter", registry);
    expect(r.ok && r.config.promptCache).toBeUndefined();
    expect(r.ok && r.config.headers).toEqual({
      "HTTP-Referer": "https://example.dev",
      "X-Partner": "${PARTNER_TOKEN}",
    });
  });

  it("carries headers as ${VAR} templates, never resolved values", () => {
    const r = resolveProvider("openrouter", registry, "deepseek/v4");
    expect(r.ok && r.config.headers?.["X-Partner"]).toBe("${OTHER_TOKEN}");
  });

  it("merges headers per key — the model wins, provider-only keys survive", () => {
    const r = resolveProvider("openrouter", registry, "deepseek/v4");
    expect(r.ok && r.config.headers).toEqual({
      "HTTP-Referer": "https://example.dev",
      "X-Partner": "${OTHER_TOKEN}",
    });
  });

  it("merges body SHALLOWLY — a model's nested object REPLACES the provider's", () => {
    const r = resolveProvider("openrouter", registry, "deepseek/v4");
    const body = (r.ok ? r.config.body : undefined) as
      { provider: Record<string, unknown>; top_k?: number } | undefined;
    expect(body?.provider.allow_fallbacks).toBe(true);
    expect(body?.top_k).toBe(40);
    // The whole assertion: a deep merge would keep `order` and still pass every
    // line above. Only a shallow, per-top-level-key merge drops it.
    expect("order" in body!.provider).toBe(false);
  });

  it("projects the provider's own maps for a model that overrides neither", () => {
    const r = resolveProvider("openrouter", registry, "plain/model");
    expect(r.ok && r.config.headers).toEqual({
      "HTTP-Referer": "https://example.dev",
      "X-Partner": "${PARTNER_TOKEN}",
    });
    expect(r.ok && r.config.promptCache).toBeUndefined();
  });

  it("projects prompt_cache from the model, and leaves it absent when unset", () => {
    const on = resolveProvider("openrouter", registry, "deepseek/v4");
    expect(on.ok && on.config.promptCache).toBe("explicit");
    const off = resolveProvider("openrouter", registry, "plain/model");
    expect(off.ok && "promptCache" in off.config).toBe(false);
  });

  it("ignores a modelId the provider does not declare", () => {
    const r = resolveProvider("openrouter", registry, "not/declared");
    expect(r.ok && r.config.promptCache).toBeUndefined();
    expect(r.ok && r.config.body).toEqual({
      provider: { order: ["deepseek"], allow_fallbacks: false },
      top_k: 40,
    });
  });
});
