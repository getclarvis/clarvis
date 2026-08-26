/**
 * The operator's recording policy: composition, and where it is allowed to land.
 *
 * @remarks Two properties here are decisions rather than behaviour, and both are
 * invisible to a type-checker. The scopes **concatenate** instead of shadowing,
 * unlike `guard-judge.md` — a personal "always keep the exact commands" and a
 * repository's "record the migration traps" are both true at once, and
 * shadowing would drop the personal half the moment a project added its own. And
 * the composed text reaches only the two places that cost no prompt cache: the
 * isolated pass's base prompt, which is that pass's own prefix, and the
 * continuation's trailing message. It must never reach the capability's
 * `systemSection`, which sits in every ordinary run's system head.
 */
import { describe, expect, it } from "bun:test";

import type { StoredExecution } from "@clarvis/loop";

import { composeMemoryPolicy, MEMORY_POLICY_MAX_CHARS } from "../../src/recording-policy.ts";
import { buildIndexerContinuationRequest, buildIndexerRequest } from "../../src/indexer/request.ts";

/** Providers as the factory resolves them from live settings. */
const LIVE_PROVIDERS = [{ name: "anthropic", kind: "anthropic" as const }];

const GLOBAL = "Always keep the exact commands, never a paraphrase.";
const WORKSPACE = "Record the migration traps in this repo.";

describe("composing the two scopes", () => {
  it("concatenates them, personal first, so the repo reads as a refinement", () => {
    const composed = composeMemoryPolicy({ global: GLOBAL, workspace: WORKSPACE })!;
    expect(composed.indexOf(GLOBAL)).toBeLessThan(composed.indexOf(WORKSPACE));
  });

  it("keeps whichever scope is present on its own", () => {
    expect(composeMemoryPolicy({ global: GLOBAL })).toContain(GLOBAL);
    expect(composeMemoryPolicy({ workspace: WORKSPACE })).toContain(WORKSPACE);
  });

  it("is absent when neither scope says anything", () => {
    expect(composeMemoryPolicy({})).toBeUndefined();
    expect(composeMemoryPolicy({ global: "   \n  ", workspace: "" })).toBeUndefined();
  });

  it("treats a blank scope as absent rather than as an empty rule", () => {
    const composed = composeMemoryPolicy({ global: "  \n ", workspace: WORKSPACE })!;
    expect(composed).toContain(WORKSPACE);
  });

  it("bounds each scope separately, so a long repo file cannot crowd out the personal one", () => {
    const composed = composeMemoryPolicy({
      global: GLOBAL,
      workspace: "x".repeat(MEMORY_POLICY_MAX_CHARS * 2),
    })!;
    expect(composed).toContain(GLOBAL);
  });

  it("restates the two limits, because what follows is arbitrary prose", () => {
    const composed = composeMemoryPolicy({ workspace: WORKSPACE })!;
    expect(composed).toContain("does NOT change the structure");
    expect(composed).toContain("topic names remain");
  });
});

describe("where the policy is allowed to land", () => {
  const policy = composeMemoryPolicy({ workspace: WORKSPACE })!;

  it("rides the isolated pass's base prompt, which is that pass's own prefix", () => {
    const request = buildIndexerRequest({
      executionId: "run_pass",
      task: "digest",
      modelRef: "anthropic/x",
      providers: [{ name: "anthropic", kind: "anthropic" }],
      policy,
    });
    expect(request.profiles[0]!.base_prompt).toContain(WORKSPACE);
  });

  it("rides the continuation's trailing message, never its inherited prompt", () => {
    const subject = {
      id: "run_subject",
      request: {
        messages: [{ role: "user", content: "task" }],
        servers: [],
        entry: "coder",
        profiles: [{ name: "coder", model: "anthropic/x", tools: [], iteration_limit: 9 }],
        providers: [{ name: "anthropic", kind: "anthropic" }],
        budget: { on_exceed: "stop", total_token_limit: 1 },
      },
      final_context: [{ message: { role: "user", content: "task" } }],
    } as unknown as StoredExecution;

    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject,
      providers: LIVE_PROVIDERS,
      policy,
    });
    const content = request.messages[0]!.content;
    expect(typeof content).toBe("string");
    expect(content as string).toContain(WORKSPACE);
    expect(request.profiles[0]!.base_prompt).toBeUndefined();
  });

  it("changes nothing when there is no policy", () => {
    const request = buildIndexerRequest({
      executionId: "run_pass",
      task: "digest",
      modelRef: "anthropic/x",
      providers: [{ name: "anthropic", kind: "anthropic" }],
    });
    expect(request.profiles[0]!.base_prompt).not.toContain("OPERATOR RECORDING POLICY");
  });
});
