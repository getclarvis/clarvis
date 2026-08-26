import { describe, expect, it } from "../bun-test.ts";
import type { ProviderConfig } from "@clarvis/capability";
import { providerConfigSchema } from "../../src/validation/request/provider-schemas.ts";
import {
  rejectProviderConfigIssues,
  requireResolvableModelProviders,
} from "../../src/validation/request/provider-rules.ts";
import { parsedRequest, validationCode, VALID_REQUEST } from "../helpers/request.ts";

describe("request provider schema", () => {
  it.each(["openai-codex", "xai-grok"] as const)(
    "accepts strict token-free %s subscription providers",
    (kind) => {
      expect(
        providerConfigSchema.safeParse({
          name: kind,
          kind,
          models: { model: { context_window_tokens: 128_000 } },
        }).success,
      ).toBe(true);
      for (const field of ["api_key_env", "base_url", "headers", "body"] as const) {
        const value =
          field === "headers"
            ? { "x-test": "value" }
            : field === "body"
              ? { test: true }
              : field === "base_url"
                ? "https://example.test"
                : "TEST_KEY";
        const provider = { name: kind, kind, [field]: value };
        expect(providerConfigSchema.safeParse(provider).success).toBe(true);
        expect(() =>
          rejectProviderConfigIssues(
            parsedRequest({
              providers: [provider],
              profiles: [{ ...VALID_REQUEST.profiles[0]!, model: `${kind}/model` }],
            }),
          ),
        ).toThrow(/subscription billing and forbids/);
      }
    },
  );
  it("accepts the complete provider and per-model surface", () => {
    expect(
      providerConfigSchema.safeParse({
        name: "router_1",
        kind: "openai-compatible",
        base_url: "https://router.example/v1",
        api_key_env: "ROUTER_KEY",
        headers: { Authorization: "Bearer ${ROUTER_KEY}" },
        body: { provider: { order: ["one"] } },
        models: {
          "org/model": {
            context_window_tokens: 128_000,
            max_output_tokens: 8_000,
            capabilities: ["tool_calling", "vision"],
            reasoning_efforts: ["minimal", "low", "medium", "high"],
            prompt_cache: "explicit",
            headers: { "X-Model": "1" },
            body: { temperature: 0 },
          },
          "text-only": { context_window_tokens: 32_000, capabilities: [] },
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["provider name", { name: "Bad Name", kind: "anthropic" }],
    ["provider kind", { name: "x", kind: "unknown" }],
    ["api env", { name: "x", kind: "anthropic", api_key_env: "9BAD" }],
    ["missing context", { name: "x", kind: "anthropic", models: { m: {} } }],
    [
      "unknown model key",
      { name: "x", kind: "anthropic", models: { m: { context_window_tokens: 1, window: 1 } } },
    ],
    [
      "prompt cache",
      {
        name: "x",
        kind: "anthropic",
        models: { m: { context_window_tokens: 1, prompt_cache: "x" } },
      },
    ],
    ["unknown provider key", { name: "x", kind: "anthropic", extra: true }],
  ])("rejects an invalid %s", (_label, provider) => {
    expect(providerConfigSchema.safeParse(provider).success).toBe(false);
  });
});

describe("request provider semantic rules", () => {
  it("accepts a valid registry and resolves every profile token", () => {
    const data = parsedRequest();
    expect(() => rejectProviderConfigIssues(data)).not.toThrow();
    expect(() => requireResolvableModelProviders(data)).not.toThrow();
  });

  const semanticFailures: Array<[string, ProviderConfig[], string]> = [
    [
      "duplicate name",
      [
        { name: "anthropic", kind: "anthropic" },
        { name: "anthropic", kind: "google" },
      ],
      "duplicate_provider_name",
    ],
    [
      "malformed URL",
      [{ name: "anthropic", kind: "anthropic", base_url: "bad" }],
      "invalid_provider_config",
    ],
    [
      "missing compatible URL",
      [{ name: "anthropic", kind: "openai-compatible" }],
      "invalid_provider_config",
    ],
    [
      "malformed header reference",
      [{ name: "anthropic", kind: "anthropic", headers: { Authorization: "${BROKEN" } }],
      "invalid_provider_config",
    ],
    [
      "unsupported used body",
      [{ name: "anthropic", kind: "anthropic", body: { routing: true } }],
      "invalid_provider_config",
    ],
    [
      "forbidden body key",
      [
        {
          name: "anthropic",
          kind: "openai-compatible",
          base_url: "https://example.test/v1",
          body: { messages: [] },
        },
      ],
      "invalid_provider_config",
    ],
    [
      "malformed model header",
      [
        {
          name: "anthropic",
          kind: "anthropic",
          models: { model: { context_window_tokens: 1, headers: { A: "${BAD" } } },
        },
      ],
      "invalid_provider_config",
    ],
    [
      "forbidden model body key",
      [
        {
          name: "anthropic",
          kind: "openai-compatible",
          base_url: "https://example.test/v1",
          models: { model: { context_window_tokens: 1, body: { tools: [] } } },
        },
      ],
      "invalid_provider_config",
    ],
  ];

  it.each(semanticFailures)("rejects %s", (_label, providers, code) => {
    const data = parsedRequest({ providers });
    expect(validationCode(() => rejectProviderConfigIssues(data))).toBe(code);
  });

  it("allows a body on an unused first-party provider but counts the guard judge as used", () => {
    const unused = parsedRequest({
      providers: [
        ...VALID_REQUEST.providers,
        { name: "google", kind: "google", body: { routing: true } },
      ],
    });
    expect(() => rejectProviderConfigIssues(unused)).not.toThrow();

    const judged = parsedRequest({
      guard_judge: { prompt: "Judge this command.", model: "google/judge" },
      providers: [
        ...VALID_REQUEST.providers,
        { name: "google", kind: "google", body: { routing: true } },
      ],
    });
    expect(validationCode(() => rejectProviderConfigIssues(judged))).toBe(
      "invalid_provider_config",
    );
  });

  it("rejects an unresolved profile provider", () => {
    const data = parsedRequest({
      profiles: [{ ...VALID_REQUEST.profiles[0]!, model: "missing/model" }],
    });
    expect(validationCode(() => requireResolvableModelProviders(data))).toBe("unknown_provider");
  });
});
