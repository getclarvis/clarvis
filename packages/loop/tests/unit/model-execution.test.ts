import { expect, test } from "../bun-test.ts";
import { loadEnv, type ModelExecutionInfo, type ModelExecutionResolver } from "@clarvis/capability";
import { validateBody } from "../../src/validation/request-schema.ts";
import { resolveSubagentProfiles } from "../../src/runtime/subagents/subagent-profiles.ts";
import { toLlmTarget } from "../../src/runtime/loop/loop-shared.ts";
import { summarizeContext } from "../../src/runtime/context/llm-compaction.ts";
import { MockLLM } from "../../src/testing/mock-llm.ts";
import { VALID_REQUEST } from "../helpers/request.ts";

const env = loadEnv({});
const info: ModelExecutionInfo = {
  provider: "alias",
  model: "org/model:tag",
  kind: "openai",
  contextWindowTokens: 12345,
  maxOutputTokens: 321,
  capabilities: ["tool_calling"],
  reasoningEfforts: ["low"],
  promptCache: "implicit",
};
const resolver: ModelExecutionResolver = {
  resolve: (provider, model) =>
    provider === info.provider && model === info.model ? info : undefined,
};
const request = {
  ...VALID_REQUEST,
  providers: [],
  profiles: [
    {
      ...VALID_REQUEST.profiles[0]!,
      model: "alias/org/model:tag",
      reasoning_summary: "auto" as const,
    },
  ],
};

test("closed catalog validates exact aliases and projects metadata without native transport", () => {
  const parsed = validateBody(request, env, undefined, {
    modelExecutionResolver: resolver,
  }).request;
  const profile = resolveSubagentProfiles(parsed.profiles, parsed.providers, env, resolver).get(
    "solo",
  )!;
  expect(profile.modelExecution).toBe(info);
  expect(profile.providerConfig).toBeUndefined();
  expect(profile.contextWindowTokens).toBe(12345);
  expect(profile.maxOutputTokens).toBe(321);
  expect(profile.capabilities).toEqual(new Set(["tool_calling"]));
  expect(toLlmTarget(new MockLLM({ script: [] }), profile).modelExecution).toBe(info);
});

test("closed catalog uses the context window as the conservative output ceiling when absent", () => {
  const uncapped = { ...info, maxOutputTokens: undefined };
  const profile = resolveSubagentProfiles(request.profiles, [], env, {
    resolve: () => uncapped,
  }).get("solo")!;
  expect(profile.maxOutputTokens).toBe(uncapped.contextWindowTokens);
});

test("catalog refuses transports, missing models, and resolver aliases", () => {
  const validate = (body: unknown, catalog = resolver) =>
    validateBody(body, env, undefined, { modelExecutionResolver: catalog });
  expect(() => validate({ ...request, providers: VALID_REQUEST.providers })).toThrow(
    /providers must be empty/,
  );
  expect(() =>
    validate({ ...request, profiles: [{ ...request.profiles[0]!, model: "alias/missing" }] }),
  ).toThrow(/execution catalog/);
  expect(() => validate(request, { resolve: () => ({ ...info, provider: "other" }) })).toThrow(
    /execution catalog/,
  );
  expect(() =>
    resolveSubagentProfiles(request.profiles, VALID_REQUEST.providers, env, resolver),
  ).toThrow(/providers must be empty/);
});

test.each(["openai-codex", "xai-grok", "anthropic"] as const)(
  "catalog reasoning-summary rule uses %s kind, not alias",
  (kind) => {
    const catalog = { resolve: () => ({ ...info, kind }) };
    expect(() =>
      validateBody(request, env, undefined, { modelExecutionResolver: catalog }),
    ).toThrow(/reasoning_summary/);
    expect(() =>
      validateBody(
        { ...request, profiles: [{ ...request.profiles[0]!, reasoning_summary: "off" }] },
        env,
        undefined,
        { modelExecutionResolver: catalog },
      ),
    ).not.toThrow();
  },
);

test("native aliases retain provider and URL validation without requiring a model catalog entry", () => {
  const native = {
    ...request,
    providers: [{ name: "alias", kind: "openai" as const, base_url: "https://example.test/v1" }],
  };
  const parsed = validateBody(native, env).request;
  const profile = resolveSubagentProfiles(parsed.profiles, parsed.providers, env).get("solo")!;
  expect(profile.providerConfig?.kind).toBe("openai");
  expect(profile.modelExecution).toBeUndefined();
  expect(() =>
    validateBody(
      { ...native, providers: [{ ...native.providers[0]!, base_url: "not-a-url" }] },
      env,
    ),
  ).toThrow();
  expect(() => validateBody(request, env)).toThrow();
});

test.each(["openai-codex", "xai-grok"] as const)(
  "native %s aliases retain subscription resolution and summary restrictions",
  (kind) => {
    const native = {
      ...request,
      providers: [{ name: "alias", kind }],
      profiles: [{ ...request.profiles[0]!, reasoning_summary: "off" as const }],
    };
    const parsed = validateBody(native, env).request;
    expect(
      resolveSubagentProfiles(parsed.profiles, parsed.providers, env).get("solo")?.providerConfig
        ?.kind,
    ).toBe(kind);
    expect(() => validateBody({ ...native, profiles: request.profiles }, env)).toThrow(
      /reasoning_summary/,
    );
  },
);

test.each(["openai-codex", "xai-grok", "openai"] as const)(
  "compaction uses catalog %s metadata without fake provider config",
  async (kind) => {
    const llm = new MockLLM({ script: [{ text: "summary" }] });
    await summarizeContext({
      llm,
      model: info.model,
      provider: info.provider,
      modelExecution: { ...info, kind },
      prompt: "summarize",
      span: [],
      maxOutputTokens: 100,
    });
    expect(llm.calls[0]?.providerConfig).toBeUndefined();
    expect(llm.calls[0]?.reasoningEffort).toBe(kind === "openai" ? "off" : undefined);
  },
);
