import { describe, it, expect } from "../bun-test.ts";
import {
  resolveSubagentProfiles,
  findInvalidToolRef,
} from "../../src/runtime/subagents/subagent-profiles.ts";
import { loadEnv } from "@clarvis/capability";
import {
  DEFAULT_COMPACTION_PROMPT,
  deriveMaxResultChars,
  derivePreserveRecentTokens,
} from "../../src/runtime/context/index.ts";
import type { AgentProfile, ProviderConfig } from "@clarvis/capability";

const providers: ProviderConfig[] = [{ name: "anthropic", kind: "anthropic" }];
const env = loadEnv();

describe("resolveSubagentProfiles", () => {
  it("returns an empty registry when the caller registered none", () => {
    expect(resolveSubagentProfiles(undefined, providers, env).size).toBe(0);
    expect(resolveSubagentProfiles([], providers, env).size).toBe(0);
  });

  it("strips the provider prefix from each profile's model", () => {
    const reg = resolveSubagentProfiles(
      [
        { name: "researcher", model: "anthropic/claude-haiku-4-5", base_prompt: "r", tools: [] },
        { name: "coder", model: "anthropic/claude-opus-4-5", base_prompt: "c", tools: [] },
      ],
      providers,
      env,
    );
    expect(reg.get("researcher")!.model).toBe("claude-haiku-4-5");
    expect(reg.get("coder")!.model).toBe("claude-opus-4-5");
  });

  it("carries name/description/basePrompt/tools through", () => {
    const reg = resolveSubagentProfiles(
      [
        {
          name: "researcher",
          description: "read-only",
          model: "anthropic/m",
          base_prompt: "be careful",
          tools: ["grep"],
        },
      ],
      providers,
      env,
    );
    expect(reg.get("researcher")).toMatchObject({
      name: "researcher",
      description: "read-only",
      basePrompt: "be careful",
      tools: ["grep"],
    });
  });

  it("carries reasoning_effort through, leaving it undefined when unset", () => {
    const reg = resolveSubagentProfiles(
      [
        { name: "deep", model: "anthropic/m", tools: [], reasoning_effort: "high" },
        { name: "plain", model: "anthropic/m", tools: [] },
      ],
      providers,
      env,
    );
    expect(reg.get("deep")!.reasoningEffort).toBe("high");
    expect(reg.get("plain")!.reasoningEffort).toBeUndefined();
  });

  it("falls back to CLARVIS_DEFAULT_REASONING_EFFORT when the profile sets none", () => {
    const reg = resolveSubagentProfiles(
      [{ name: "plain", model: "anthropic/m", tools: [] }],
      providers,
      loadEnv({ CLARVIS_DEFAULT_REASONING_EFFORT: "medium" }),
    );
    expect(reg.get("plain")!.reasoningEffort).toBe("medium");
  });

  it("carries grants through (used to gate the mutating built-in coding tools)", () => {
    const reg = resolveSubagentProfiles(
      [
        { name: "editor", model: "anthropic/m", tools: [], grants: ["edit_workspace"] },
        { name: "reader", model: "anthropic/m", tools: [] },
      ],
      providers,
      env,
    );
    expect(reg.get("editor")!.grants).toEqual(["edit_workspace"]);
    expect(reg.get("reader")!.grants).toBeUndefined();
  });

  describe("context window sizing (from the provider's per-model config)", () => {
    const withModels: ProviderConfig[] = [
      {
        name: "anthropic",
        kind: "anthropic",
        models: {
          "claude-sonnet-4-5": { context_window_tokens: 200000 },
        },
      },
      {
        name: "together",
        kind: "openai-compatible",
        base_url: "https://example.test/v1",
        models: {
          "meta-llama/Llama-3.3-70B-Instruct-Turbo": { context_window_tokens: 131072 },
        },
      },
    ];

    it("sizes compaction from providers[].models[modelId].context_window_tokens", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/claude-sonnet-4-5", tools: [] }],
        withModels,
        env,
      );
      const p = reg.get("lead")!;
      expect(p.contextWindowTokens).toBe(200000);
      expect(p.compaction.windowTokens).toBe(200000);
    });

    it("carries providers[].models[modelId].max_output_tokens, undefined when unset", () => {
      const providers: ProviderConfig[] = [
        {
          name: "anthropic",
          kind: "anthropic",
          models: {
            capped: { context_window_tokens: 200000, max_output_tokens: 32000 },
            uncapped: { context_window_tokens: 200000 },
          },
        },
      ];
      const reg = resolveSubagentProfiles(
        [
          { name: "a", model: "anthropic/capped", tools: [] },
          { name: "b", model: "anthropic/uncapped", tools: [] },
        ],
        providers,
        env,
      );
      expect(reg.get("a")!.maxOutputTokens).toBe(32000);
      expect(reg.get("b")!.maxOutputTokens).toBeUndefined();
    });

    it("keys by the full modelId, including a multi-slash openai-compatible id", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "together/meta-llama/Llama-3.3-70B-Instruct-Turbo", tools: [] }],
        withModels,
        env,
      );
      expect(reg.get("lead")!.contextWindowTokens).toBe(131072);
    });

    it("falls back to CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS for a model not declared on its provider", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/claude-haiku-4-5", tools: [] }],
        withModels,
        env,
      );
      expect(reg.get("lead")!.contextWindowTokens).toBe(env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS);
    });

    it("falls back to the env default when the provider has no models map at all", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/claude-sonnet-4-5", tools: [] }],
        providers,
        env,
      );
      expect(reg.get("lead")!.contextWindowTokens).toBe(env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS);
    });

    it("falls back to the env default for an unknown provider prefix", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "mystery/some-model", tools: [] }],
        withModels,
        env,
      );
      expect(reg.get("lead")!.contextWindowTokens).toBe(env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS);
    });
  });

  describe("capabilities (from the provider's per-model config)", () => {
    const withCaps: ProviderConfig[] = [
      {
        name: "anthropic",
        kind: "anthropic",
        models: {
          "claude-sonnet-4-5": {
            context_window_tokens: 200000,
            capabilities: ["tool_calling", "vision"],
          },
          "text-only-model": {
            context_window_tokens: 128000,
            capabilities: [],
          },
        },
      },
    ];

    it("reads capabilities from providers[].models[modelId].capabilities", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/claude-sonnet-4-5", tools: [] }],
        withCaps,
        env,
      );
      expect(reg.get("lead")!.capabilities).toEqual(new Set(["tool_calling", "vision"]));
    });

    it("yields an empty Set when capabilities is an empty array", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/text-only-model", tools: [] }],
        withCaps,
        env,
      );
      expect(reg.get("lead")!.capabilities).toEqual(new Set());
    });

    it("is undefined when capabilities is not declared (backward-compatible: all permitted)", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/claude-haiku-4-5", tools: [] }],
        withCaps,
        env,
      );
      expect(reg.get("lead")!.capabilities).toBeUndefined();
    });

    it("is undefined when the provider has no models map at all", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/claude-sonnet-4-5", tools: [] }],
        providers,
        env,
      );
      expect(reg.get("lead")!.capabilities).toBeUndefined();
    });
  });

  describe("compaction hysteresis (targetFraction low-water)", () => {
    it("defaults fraction/targetFraction from the env knobs", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/m", tools: [] }],
        providers,
        env,
      );
      const c = reg.get("lead")!.compaction;
      expect(c.fraction).toBe(env.CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION);
      expect(c.targetFraction).toBe(env.CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION);
    });

    it("takes a per-agent target_fraction override", () => {
      const reg = resolveSubagentProfiles(
        [
          {
            name: "lead",
            model: "anthropic/m",
            tools: [],
            compaction: { context_fraction: 0.9, target_fraction: 0.4 },
          },
        ],
        providers,
        env,
      );
      const c = reg.get("lead")!.compaction;
      expect(c.fraction).toBe(0.9);
      expect(c.targetFraction).toBe(0.4);
    });

    /**
     * A zero gap between the two water marks turns compaction into "evict one
     * entry, every iteration": `selectOldestEvictable` picks a single candidate,
     * drops back under the low-water mark and stops. Each of those evictions
     * rebuilds the transcript mid-array and costs a full provider prefix miss,
     * so the degenerate setting is ~50× more expensive per reclaimed token than
     * the default hysteresis. The floor is enforced, not documented.
     */
    it("keeps a hysteresis margin, so the low-water mark never meets the high-water", () => {
      const reg = resolveSubagentProfiles(
        [
          {
            name: "lead",
            model: "anthropic/m",
            tools: [],
            compaction: { target_fraction: 0.95 },
          },
        ],
        providers,
        env,
      );
      const c = reg.get("lead")!.compaction;
      expect(c.targetFraction).toBeLessThan(c.fraction);
      expect(c.targetFraction).toBeCloseTo(c.fraction * 0.8, 10);
    });

    it("leaves a target that already clears the margin untouched", () => {
      const reg = resolveSubagentProfiles(
        [
          {
            name: "lead",
            model: "anthropic/m",
            tools: [],
            compaction: { context_fraction: 0.8, target_fraction: 0.5 },
          },
        ],
        providers,
        env,
      );
      const c = reg.get("lead")!.compaction;
      expect(c.targetFraction).toBe(0.5);
    });
  });

  describe("maxResultChars (single-result cap)", () => {
    const lead = (
      compaction?: AgentProfile["compaction"],
      overrides?: Record<string, string>,
    ): number =>
      resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/m", tools: [], ...(compaction ? { compaction } : {}) }],
        providers,
        overrides ? loadEnv(overrides) : env,
      ).get("lead")!.compaction.maxResultChars;

    it("derives from the resolved context window when nothing overrides it", () => {
      expect(lead()).toBe(deriveMaxResultChars(env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS));
      expect(lead()).toBe(51_200);
    });

    it("scales with a wider window rather than staying flat", () => {
      const reg = resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/m", tools: [] }],
        [
          {
            name: "anthropic",
            kind: "anthropic",
            models: { m: { context_window_tokens: 1_000_000 } },
          },
        ],
        env,
      );
      expect(reg.get("lead")!.compaction.maxResultChars).toBe(200_000);
    });

    it("lets the env var beat the derivation", () => {
      expect(lead(undefined, { CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "4321" })).toBe(4321);
    });

    it("lets the profile beat the env var", () => {
      expect(
        lead({ max_result_chars: 777 }, { CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "4321" }),
      ).toBe(777);
    });
  });

  describe("preserveRecentTokens (protected tail budget)", () => {
    const lead = (
      compaction?: AgentProfile["compaction"],
      overrides?: Record<string, string>,
    ): number =>
      resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/m", tools: [], ...(compaction ? { compaction } : {}) }],
        providers,
        overrides ? loadEnv(overrides) : env,
      ).get("lead")!.compaction.preserveRecentTokens;

    it("derives from the resolved context window when nothing overrides it", () => {
      expect(lead()).toBe(derivePreserveRecentTokens(env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS));
      expect(lead()).toBe(10_240);
    });

    it("lets the env var beat the derivation", () => {
      expect(lead(undefined, { CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: "6000" })).toBe(
        6000,
      );
    });

    it("lets the profile beat the env var", () => {
      expect(
        lead(
          { preserve_recent_tokens: 123 },
          { CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: "6000" },
        ),
      ).toBe(123);
    });

    it("keeps an explicit zero rather than treating it as unset", () => {
      expect(lead({ preserve_recent_tokens: 0 })).toBe(0);
    });
  });

  describe("compactionPrompt", () => {
    const lead = (compaction?: AgentProfile["compaction"]): string | undefined =>
      resolveSubagentProfiles(
        [{ name: "lead", model: "anthropic/m", tools: [], ...(compaction ? { compaction } : {}) }],
        providers,
        env,
      ).get("lead")!.compactionPrompt;

    /**
     * The defect this pins: no shipped agent template declares a `compaction`
     * block, so this was always undefined and `runCompaction` fell through to
     * blind eviction — the LLM-summarization path was unreachable in the
     * product.
     */
    it("defaults to the built-in prompt when the profile declares no compaction block", () => {
      expect(lead()).toBe(DEFAULT_COMPACTION_PROMPT);
      expect(lead({ target_fraction: 0.4 })).toBe(DEFAULT_COMPACTION_PROMPT);
    });

    it("takes a declared prompt over the built-in one", () => {
      expect(lead({ prompt: "custom summarizer" })).toBe("custom summarizer");
    });

    it("falls back to the built-in prompt for a whitespace-only declared prompt", () => {
      expect(lead({ prompt: "   " })).toBe(DEFAULT_COMPACTION_PROMPT);
    });

    it('is unset under prompt_mode "none", restoring mechanical eviction', () => {
      expect(lead({ prompt_mode: "none" })).toBeUndefined();
    });

    it('keeps the built-in prompt under an explicit prompt_mode "summarize"', () => {
      expect(lead({ prompt_mode: "summarize" })).toBe(DEFAULT_COMPACTION_PROMPT);
    });
  });
});

describe("deriveMaxResultChars", () => {
  it("is ~10% of the window in characters", () => {
    expect(deriveMaxResultChars(128_000)).toBe(51_200);
    expect(deriveMaxResultChars(100_000)).toBe(40_000);
  });

  it("clamps a small window up and a huge window down", () => {
    expect(deriveMaxResultChars(32_000)).toBe(16_000);
    expect(deriveMaxResultChars(1)).toBe(16_000);
    expect(deriveMaxResultChars(1_000_000)).toBe(200_000);
    expect(deriveMaxResultChars(10_000_000)).toBe(200_000);
  });
});

describe("findInvalidToolRef", () => {
  const refs = [
    { label: "profile 'researcher'", tools: ["docs.search"] },
    { label: "profile 'coder'", tools: ["edit_file", "shell"] },
  ];

  it("returns null when every referenced tool is in the pool", () => {
    expect(findInvalidToolRef(refs, ["docs.search", "edit_file", "shell"])).toBeNull();
  });

  it("returns the first label/tool that is not a pool tool name", () => {
    const bad = findInvalidToolRef(refs, ["docs.search", "edit_file"]);
    expect(bad).toEqual({ label: "profile 'coder'", tool: "shell" });
  });

  it("an empty tool list never offends", () => {
    expect(findInvalidToolRef([{ label: "profile 'x'", tools: [] }], [])).toBeNull();
  });
});
