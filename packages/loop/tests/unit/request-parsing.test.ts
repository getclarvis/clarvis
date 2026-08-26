import { describe, expect, test } from "bun:test";
import { createCapabilityRegistry } from "@clarvis/capability";
import { z } from "zod";
import { parseRunRequest } from "../../src/validation/request/parsing.ts";
import { VALID_REQUEST, validationCode } from "../helpers/request.ts";

describe("request parsing", () => {
  test.each([
    ["execution id", { execution_id: "contains spaces" }, "invalid_execution_id"],
    ["continuation id", { continue_from: "contains spaces" }, "invalid_execution_id"],
    ["prompt cache key", { prompt_cache_key: "" }, "invalid_prompt_cache_key"],
    ["prompt cache ttl", { prompt_cache_ttl: "day" }, "invalid_prompt_cache_ttl"],
    ["empty messages", { messages: [] }, "messages_empty"],
    [
      "malformed messages",
      { messages: [{ role: "tool", content: "x" }] },
      "invalid_message_format",
    ],
    ["empty profiles", { profiles: [] }, "invalid_profile"],
    [
      "malformed profile model",
      { profiles: [{ ...VALID_REQUEST.profiles[0]!, model: "missing-slash" }] },
      "invalid_model_format",
    ],
    [
      "profile iteration limit",
      { profiles: [{ ...VALID_REQUEST.profiles[0]!, iteration_limit: 0 }] },
      "invalid_iteration_limit",
    ],
    ["empty entry", { entry: "" }, "unknown_profile"],
    ["elicitation wait", { elicit_wait_ms: -1 }, "invalid_elicit_wait"],
    ["budget mode", { budget: { on_exceed: "pause" } }, "invalid_on_exceed"],
    ["token limit", { budget: { on_exceed: "stop", total_token_limit: 0 } }, "invalid_token_limit"],
    [
      "timeout",
      { budget: { on_exceed: "stop", total_token_limit: 1, timeout_ms: 0 } },
      "invalid_timeout",
    ],
    [
      "escalation count",
      { budget: { on_exceed: "escalate", max_escalations: 0 } },
      "invalid_max_escalations",
    ],
    ["budget shape", { budget: { on_exceed: "stop", unexpected: true } }, "invalid_budget_mode"],
    ["server", { servers: [{ name: "bad" }] }, "invalid_server_config"],
    ["provider", { providers: [{ name: "bad", kind: "custom" }] }, "invalid_provider_config"],
    ["unknown top-level field", { unexpected: true }, "invalid_message_format"],
  ])("classifies a structural %s failure", (_label, patch, code) => {
    expect(validationCode(() => parseRunRequest({ ...VALID_REQUEST, ...patch }))).toBe(code);
  });

  test("composes request params declared by registered capabilities", () => {
    const registry = createCapabilityRegistry();
    registry.register({
      key: "widgets",
      schema: z.object({}).strict(),
      merge: "lastWins",
      pluginContributable: false,
      requestParams: { widget_mode: z.enum(["safe", "fast"]).optional() },
    });

    const parsed = parseRunRequest({ ...VALID_REQUEST, widget_mode: "safe" }, registry);
    expect((parsed as unknown as Record<string, unknown>).widget_mode).toBe("safe");
    expect(
      validationCode(() => parseRunRequest({ ...VALID_REQUEST, widget_mode: "unsafe" }, registry)),
    ).toBe("invalid_message_format");
  });

  test("rejects a capability request param that shadows an engine field", () => {
    const registry = createCapabilityRegistry();
    registry.register({
      key: "collision",
      schema: z.object({}).strict(),
      merge: "lastWins",
      pluginContributable: false,
      requestParams: { messages: z.string() },
    });

    expect(() => parseRunRequest(VALID_REQUEST, registry)).toThrow("collides with a built-in");
  });
});

/**
 * A run cannot set its own diagnostic verbosity.
 *
 * @remarks Verbosity is environment-only, and the reason is not tidiness: a run
 * that could raise or silence its own record would be deciding what evidence
 * exists about itself. It is the same argument that keeps `guard_mode` out of the
 * server's run schema. The rule used to be argued from the keys appearing only in
 * the environment schema — an absence, which stops being evidence the moment
 * someone extends the request "for symmetry", and a capability extending the
 * request schema is a supported thing to do.
 *
 * The settings half of the rule lives in the kernel's capability-settings suite,
 * where the assembled schema is reachable.
 */
describe("verbosity is not a run-request field", () => {
  test.each([
    "log",
    "log_level",
    "logging",
    "CLARVIS_LOG",
    "CLARVIS_LOG_LEVEL",
    "CLARVIS_LOG_AUDIT",
  ])("rejects a request carrying %s", (key) => {
    expect(() => parseRunRequest({ ...VALID_REQUEST, [key]: "debug" })).toThrow();
  });

  test("accepts the same request without it, so the key is what was refused", () => {
    expect(() => parseRunRequest({ ...VALID_REQUEST })).not.toThrow();
  });

  /**
   * The bound on the guarantee, asserted rather than assumed: the engine refuses
   * these keys because it declares none of them, not because it forbids them. A
   * capability that declared `log_level` as a request param would be admitted
   * here, so the rule is upheld by *which capabilities a host registers* — which
   * is why the kernel's suite additionally checks its assembled registry
   * contributes no such key.
   */
  test("the refusal comes from the schema, so a capability declaring one would be admitted", () => {
    const registry = createCapabilityRegistry();
    registry.register({
      name: "noisy",
      requestParams: { log_level: z.string().optional() },
    } as never);

    expect(() => parseRunRequest({ ...VALID_REQUEST, log_level: "debug" })).toThrow();
    expect(() => parseRunRequest({ ...VALID_REQUEST, log_level: "debug" }, registry)).not.toThrow();
  });
});
