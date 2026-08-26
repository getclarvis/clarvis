import { describe, expect, it } from "../bun-test.ts";
import { loadEnv, type AgentProfile } from "@clarvis/capability";
import { agentProfileSchema } from "../../src/validation/request/profile-schemas.ts";
import { enforcePerProfileRules } from "../../src/validation/request/profile-rules.ts";
import { parsedRequest, validationCode, VALID_REQUEST } from "../helpers/request.ts";

describe("request profile schema", () => {
  it("accepts the complete profile surface", () => {
    expect(
      agentProfileSchema.safeParse({
        name: "lead",
        description: "coordinates",
        model: "openai/gpt-5",
        base_prompt: "Lead well.",
        tools: ["docs.read"],
        grants: ["ask_user"],
        can_spawn: ["worker"],
        default_spawn: "worker",
        iteration_limit: 5,
        stagnation_threshold: 0,
        call_timeout_ms: 1_000,
        reasoning_summary: "auto",
        reasoning_effort: "high",
        retry: { max_retries: 0, max_retry_after_ms: 1 },
        compaction: {
          enabled: true,
          context_fraction: 0.8,
          target_fraction: 0.5,
          max_result_chars: 1,
          preserve_recent_tokens: 0,
          prompt_mode: "summarize",
          prompt: "summarize",
        },
        orchestration: { force_tool_on_nudge: true, capability_owned: "preserved" },
      }).success,
    ).toBe(true);
  });

  it("accepts a provider-native tagged model id", () => {
    expect(
      agentProfileSchema.safeParse({
        ...VALID_REQUEST.profiles[0]!,
        model: "local/qwen2.5-coder:7b",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty name", { name: "" }],
    ["model format", { model: "missing-slash" }],
    ["empty base prompt", { base_prompt: "" }],
    ["missing tools", { tools: undefined }],
    ["zero iteration", { iteration_limit: 0 }],
    ["negative stagnation", { stagnation_threshold: -1 }],
    ["retry key", { retry: { unknown: 1 } }],
    ["compaction range", { compaction: { context_fraction: 0 } }],
    ["compaction watermarks", { compaction: { context_fraction: 0.5, target_fraction: 0.8 } }],
    ["compaction prompt mode", { compaction: { prompt_mode: "none", prompt: "unused" } }],
    ["unknown profile key", { unknown: true }],
  ])("rejects %s", (_label, over) => {
    expect(agentProfileSchema.safeParse({ ...VALID_REQUEST.profiles[0]!, ...over }).success).toBe(
      false,
    );
  });

  it("rejects adversarial tool and spawn fanout", () => {
    expect(
      agentProfileSchema.safeParse({
        ...VALID_REQUEST.profiles[0]!,
        tools: Array(513).fill("tool"),
      }).success,
    ).toBe(false);
    expect(
      agentProfileSchema.safeParse({
        ...VALID_REQUEST.profiles[0]!,
        can_spawn: Array(65).fill("worker"),
      }).success,
    ).toBe(false);
  });
});

describe("request per-profile semantic rules", () => {
  const env = loadEnv({
    CLARVIS_TIMEOUT_CEILING_MS: "10",
    CLARVIS_RETRY_CEILING: "2",
    CLARVIS_RETRY_AFTER_CEILING_MS: "20",
    CLARVIS_DEFAULT_TIMEOUT_MS: "10",
    CLARVIS_DEFAULT_CALL_TIMEOUT_MS: "10",
    CLARVIS_DEFAULT_MAX_RETRIES: "2",
    CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS: "20",
  });

  it("accepts valid lead and OpenAI-specific settings", () => {
    const data = parsedRequest({
      profiles: [
        {
          ...VALID_REQUEST.profiles[0]!,
          model: "openai/model",
          can_spawn: ["worker"],
          orchestration: { force_tool_on_nudge: true },
          reasoning_summary: "auto",
          call_timeout_ms: 10,
          retry: { max_retries: 2, max_retry_after_ms: 20 },
        },
      ],
      providers: [{ name: "openai", kind: "openai" }],
    });
    expect(() => enforcePerProfileRules(data, env)).not.toThrow();
  });

  const semanticFailures: Array<[string, Partial<AgentProfile>]> = [
    ["orchestration", { orchestration: { force_tool_on_nudge: true } }],
    ["reasoning provider", { reasoning_summary: "detailed" }],
    ["call timeout", { call_timeout_ms: 11 }],
    ["retry count", { retry: { max_retries: 3 } }],
    ["retry-after", { retry: { max_retry_after_ms: 21 } }],
  ];

  it.each(semanticFailures)("rejects invalid %s", (_label, over) => {
    const data = parsedRequest({
      profiles: [{ ...VALID_REQUEST.profiles[0]!, ...over }],
    });
    expect(validationCode(() => enforcePerProfileRules(data, env))).toBe("invalid_profile");
  });

  it("rejects an aggregate profile prompt payload above the retained bound", () => {
    const prompt = "x".repeat(256 * 1024);
    const data = parsedRequest({
      profiles: Array.from({ length: 33 }, (_, index) => ({
        ...VALID_REQUEST.profiles[0]!,
        name: `agent-${index}`,
        base_prompt: prompt,
      })),
    });
    expect(validationCode(() => enforcePerProfileRules(data, env))).toBe("invalid_profile");
  });
});
