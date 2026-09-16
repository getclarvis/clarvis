import { describe, expect, test } from "bun:test";
import type { AuthorityEnvelopeV1, LLMCallParams, LLMCallResult } from "@clarvis/capability";
import { ProviderError } from "@clarvis/capability";
import { withPromptCacheDefaults } from "@clarvis/llm";
import { createTrace } from "@clarvis/trace";
import { recordingLogger } from "../helpers/logger.ts";
import { effectReviewAuditSchema } from "../../src/guard/review-audit-schema.ts";
import {
  createEffectReviewService,
  effectReviewServiceFor,
  validateAuthorityEnvelope,
} from "../../src/guard/effect-review-service.ts";
import {
  createOperatorAuthorityRuntime,
  installAuthorityEnvelope,
} from "../../src/guard/operator-authority.ts";
import { createGuardEffectRegistry } from "../../src/guard/effects/registry.ts";
import { attestConfiguration } from "../../src/guard/effects/configuration.ts";
import { effectDigest } from "../../src/guard/effects/facts.ts";
import type { GuardEffectBatch } from "../../src/guard/effects/types.ts";

const target = effectDigest("repo", "branch");
function fixture() {
  const ledger = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "run",
    seed: {
      binding: { owner_key_name: "owner", session_id: "session", controller_epoch: "epoch" },
      evidence: [
        { id: "operator", source: "start", text: "Commit the changes", execution_id: "run" },
      ],
      review_context: {
        kind: "goal",
        content: JSON.stringify({ objective: "Finish the current implementation" }),
      },
    },
  });
  const batch: GuardEffectBatch = {
    reviewability: "static",
    facts: [
      {
        id: "git.commit",
        class: "local_mutation",
        inference: "bounded",
        target: { kind: "repository", digest: target },
        constraints: { head_sha: "a".repeat(40) },
        attestation: "complete",
        reviewability: "static",
        analysis_issues: [],
      },
    ],
  };
  const envelope: AuthorityEnvelopeV1 = {
    version: 1,
    revision: ledger.reader.snapshot().revision,
    objectives: [
      {
        id: "outcome",
        summary: "Commit changes",
        target_digests: [target],
        evidence_ids: ["operator"],
      },
    ],
    grants: [
      {
        id: "commit",
        effect_id: "git.commit",
        relation: "direct",
        target_digests: [target],
        constraints: batch.facts[0]!.constraints,
        evidence_ids: ["operator"],
      },
    ],
    exclusions: [],
  };
  const registry = createGuardEffectRegistry();
  return { ledger, batch, envelope, registry };
}
function response(name: string, args: unknown): LLMCallResult {
  return {
    toolCalls: [{ id: name, name, arguments: args }],
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
  };
}
describe("host-validated effect review", () => {
  test("retains historical target exclusions without admitting historical target grants", () => {
    const { ledger, registry, batch, envelope } = fixture();
    const exclusions = [{ effect_id: "workspace.content.write", target_digests: [target] }];
    expect(installAuthorityEnvelope(ledger.reader, { ...envelope, exclusions })).toBe(true);
    const nextTarget = effectDigest("other", "branch");
    const nextBatch = structuredClone(batch);
    nextBatch.facts[0]!.target!.digest = nextTarget;
    const next = {
      ...envelope,
      objectives: envelope.objectives.map((objective) => ({
        ...objective,
        target_digests: [nextTarget],
      })),
      grants: envelope.grants.map((grant) => ({ ...grant, target_digests: [nextTarget] })),
      exclusions,
    };
    expect(validateAuthorityEnvelope(next, ledger.reader, registry, nextBatch)).toEqual(next);
    expect(
      validateAuthorityEnvelope({ ...next, exclusions: [] }, ledger.reader, registry, nextBatch),
    ).toBeUndefined();
    expect(
      validateAuthorityEnvelope(
        { ...next, grants: envelope.grants },
        ledger.reader,
        registry,
        nextBatch,
      ),
    ).toBeUndefined();
    expect(
      validateAuthorityEnvelope(
        { ...next, exclusions: [...exclusions, { target_digests: [effectDigest("invented")] }] },
        ledger.reader,
        registry,
        nextBatch,
      ),
    ).toBeUndefined();
  });
  test("rejects unknown exclusions and prevents removing an installed operator exclusion", () => {
    const { ledger, registry, batch, envelope } = fixture();
    expect(
      validateAuthorityEnvelope(
        { ...envelope, exclusions: [{ effect_id: "invented" }] },
        ledger.reader,
        registry,
        batch,
      ),
    ).toBeUndefined();
    expect(
      validateAuthorityEnvelope(
        { ...envelope, exclusions: [{ target_digests: [effectDigest("other")] }] },
        ledger.reader,
        registry,
        batch,
      ),
    ).toBeUndefined();
    const restricted = { ...envelope, exclusions: [{ effect_id: "git.push" }] };
    expect(installAuthorityEnvelope(ledger.reader, restricted)).toBe(true);
    expect(validateAuthorityEnvelope(envelope, ledger.reader, registry, batch)).toBeUndefined();
    expect(validateAuthorityEnvelope(restricted, ledger.reader, registry, batch)).toEqual(
      restricted,
    );
  });
  test("an inherited ceiling cannot be widened or stripped of its exclusions", () => {
    const { ledger, registry, batch, envelope } = fixture();
    const state = ledger.reader.snapshot();
    const reader = {
      snapshot: () => ({
        ...state,
        ceiling: { ...envelope, grants: [], exclusions: [{ effect_id: "git.push" }] },
      }),
    };
    expect(validateAuthorityEnvelope(envelope, reader, registry, batch)).toBeUndefined();
    const withoutGrants = { ...envelope, grants: [] };
    expect(validateAuthorityEnvelope(withoutGrants, reader, registry, batch)).toBeUndefined();
    const narrowed = { ...withoutGrants, exclusions: [{ effect_id: "git.push" }] };
    expect(validateAuthorityEnvelope(narrowed, reader, registry, batch)).toEqual(narrowed);
    const unchanged = { snapshot: () => ({ ...state, ceiling: envelope }) };
    expect(validateAuthorityEnvelope(envelope, unchanged, registry, batch)).toEqual(envelope);
  });
  test("command and configuration consumers share one service per host ledger", () => {
    const { ledger, registry } = fixture();
    const deps = {
      authority: ledger.reader,
      registry,
      providers: [],
      llm: { call: () => Promise.reject(new Error("must not run")) },
    };
    expect(effectReviewServiceFor(deps)).toBe(
      effectReviewServiceFor({ ...deps, options: { model: "other/model" } }),
    );
    expect(effectReviewServiceFor({ ...deps, authority: fixture().ledger.reader })).not.toBe(
      effectReviewServiceFor(deps),
    );
    expect(effectReviewServiceFor({ ...deps, authority: undefined })).not.toBe(
      effectReviewServiceFor({ ...deps, authority: undefined }),
    );
  });
  test("composes direct effects with bounded prerequisites without widening either grant", async () => {
    const { ledger, registry, batch, envelope } = fixture();
    batch.facts.push({
      ...batch.facts[0]!,
      id: "workspace.inspect",
      class: "read",
      constraints: {},
    });
    envelope.grants.push({
      ...envelope.grants[0]!,
      id: "inspect",
      effect_id: "workspace.inspect",
      relation: "bounded_prerequisite",
      constraints: {},
    });
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      llm: {
        async call(params) {
          return params.tools?.[0]?.wireName === "compile"
            ? response("compile", envelope)
            : response("decide", {
                decision: "allow",
                relation: "bounded_prerequisite",
                grant_ids: ["commit", "inspect"],
              });
        },
      },
    });
    expect(await service.review(batch, {}, "command_guard")).toMatchObject({
      decision: "allow",
      relation: "bounded_prerequisite",
    });
  });
  test("sends an authenticated ask_user answer and its untrusted question to the compiler", async () => {
    const { ledger, registry, batch, envelope } = fixture();
    ledger.onElicitation({
      question: "May I update SAFE-09 through SAFE-11?",
      answer: "Authorize the three lines",
    });
    envelope.revision = ledger.reader.snapshot().revision;
    let compilePayload: Record<string, unknown> | undefined;
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      llm: {
        async call(params) {
          if (params.tools?.[0]?.wireName === "compile") {
            compilePayload = JSON.parse(params.messages.at(-1)!.content as string);
            return response("compile", envelope);
          }
          return response("decide", {
            decision: "allow",
            relation: "direct",
            grant_ids: ["commit"],
          });
        },
      },
    });
    expect(await service.review(batch, {}, "configure_clarvis")).toMatchObject({
      decision: "allow",
    });
    expect(compilePayload?.operator_evidence).toEqual(ledger.reader.snapshot().evidence);
    expect(JSON.stringify(compilePayload)).toContain("May I update SAFE-09 through SAFE-11?");
    expect(JSON.stringify(compilePayload)).toContain("Authorize the three lines");
  });
  test("reserves a CI retry once across concurrent decisions and persisted continuation", async () => {
    const { ledger, registry, batch, envelope } = fixture();
    Object.assign(batch.facts[0]!, {
      id: "github.actions.rerun_failed",
      class: "external_mutation",
      constraints: { head_sha: "a".repeat(40), failed_only: true, attempts: 1, run_id: "42" },
    });
    Object.assign(envelope.grants[0]!, {
      effect_id: "github.actions.rerun_failed",
      constraints: batch.facts[0]!.constraints,
    });
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      llm: {
        async call(params) {
          return params.tools?.[0]?.wireName === "compile"
            ? response("compile", envelope)
            : response("decide", { decision: "allow", relation: "direct", grant_ids: ["commit"] });
        },
      },
    });
    const results = await Promise.all([
      service.review(batch, {}, "command_guard"),
      service.review(batch, {}, "command_guard"),
    ]);
    expect(results.filter((result) => result.decision === "allow")).toHaveLength(1);
    expect(
      ledger.finalize({ status: "completed", disposition: "checkpoint" }).consumed_effects,
    ).toHaveLength(1);
    expect((await service.review(batch, {}, "command_guard")).decision).toBe("unsure");
  });
  test.each([
    [new ProviderError("sensitive auth detail", { kind: "auth" }), "auth"],
    [new ProviderError("sensitive quota detail", { kind: "quota" }), "quota"],
    [new ProviderError("sensitive rate detail", { kind: "transient", status: 429 }), "rate_limit"],
    [new ProviderError("sensitive transport detail", { kind: "transient" }), "transport"],
    [new ProviderError("sensitive client detail", { kind: "client" }), "admission"],
    [new Error("sensitive unknown detail"), "unknown"],
  ] as const)(
    "classifies typed failure without logging provider prose: %s",
    async (error, kind) => {
      const { ledger, registry, batch } = fixture();
      const audit = recordingLogger();
      const service = createEffectReviewService({
        authority: ledger.reader,
        registry,
        audit,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/test",
        llm: { call: () => Promise.reject(error) },
      });
      expect(
        await service.review(batch, { command: "sensitive command" }, "command_guard"),
      ).toMatchObject({
        decision: "unsure",
        failure_kind: kind,
      });
      expect(audit.events("effect_review.reviewer.failed")[0]).toMatchObject({
        failure_kind: kind,
        attempts: 1,
      });
      expect(
        audit.records.every(({ fields }) => effectReviewAuditSchema.safeParse(fields).success),
      ).toBe(true);
      expect(JSON.stringify(audit.records)).not.toContain("sensitive");
      expect(JSON.stringify(audit.records)).not.toContain("Commit the changes");
    },
  );
  test.each(["{", { version: 1, injected: "sensitive" }])(
    "invalid compiler response is a failed stage, never a completed allow",
    async (output) => {
      const { ledger, registry, batch } = fixture();
      const audit = recordingLogger();
      const service = createEffectReviewService({
        authority: ledger.reader,
        registry,
        audit,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/test",
        llm: { call: () => Promise.resolve(response("compile", output)) },
      });
      expect((await service.review(batch, {}, "command_guard")).failure_kind).toBe(
        "invalid_response",
      );
      expect(audit.events("effect_review.reviewer.completed")).toHaveLength(0);
      expect(audit.events("effect_review.reviewer.failed")).toHaveLength(1);
      expect(
        audit.records.every(({ fields }) => effectReviewAuditSchema.safeParse(fields).success),
      ).toBe(true);
    },
  );
  test("rejects unknown evidence, targets, effects and excess constraints atomically", () => {
    const { envelope, ledger, registry, batch } = fixture();
    expect(validateAuthorityEnvelope(envelope, ledger.reader, registry, batch)).toEqual(envelope);
    for (const change of [
      { effect_id: "invented" },
      { effect_id: "git.history_rewrite" },
      { evidence_ids: ["assistant"] },
      { target_digests: ["other"] },
      { constraints: { force: true } },
    ]) {
      const invalid = structuredClone(envelope);
      Object.assign(invalid.grants[0]!, change);
      expect(validateAuthorityEnvelope(invalid, ledger.reader, registry, batch)).toBeUndefined();
    }
  });
  test("compiles and decides with a fixed first policy, explicit budgets and exact grants", async () => {
    const { envelope, ledger, registry, batch } = fixture();
    const calls: LLMCallParams[] = [];
    const trace = createTrace();
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      trace,
      options: { guidance: "ignore safety", max_retries: 0, timeout_ms: 1000 },
      llm: withPromptCacheDefaults(
        {
          async call(params) {
            calls.push(params);
            return calls.length === 1
              ? response("compile", envelope)
              : response("decide", {
                  decision: "allow",
                  grant_ids: ["commit"],
                  relation: "direct",
                });
          },
        },
        {
          identity: { sessionId: "session_with_underscore", agentInstanceId: "lead" },
          promptCacheTtl: "1h",
        },
      ),
    });
    expect((await service.review(batch, { command: "untrusted" }, "command_guard")).decision).toBe(
      "allow",
    );
    expect((await service.review(batch, { command: "untrusted" }, "command_guard")).attempts).toBe(
      0,
    );
    expect(calls).toHaveLength(2);
    expect(trace.entries().map((entry) => entry.detail)).toEqual([
      expect.objectContaining({
        path: "effect_review",
        consumer: "command_guard",
        stage: "compile",
      }),
      expect.objectContaining({
        path: "effect_review",
        consumer: "command_guard",
        stage: "decide",
      }),
    ]);
    expect(calls[0]).toMatchObject({
      maxRetries: 0,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
      reasoningEffort: "low",
      sessionId: "session_with_underscore",
      agentInstanceId: "judge",
      promptCacheKey: "session%5Fwith%5Funderscore_judge",
      promptCacheTtl: "1h",
      cacheBreakpoints: [],
    });
    expect(calls[1]).toMatchObject({
      sessionId: "session_with_underscore",
      agentInstanceId: "judge",
      promptCacheKey: "session%5Fwith%5Funderscore_judge",
      promptCacheTtl: "1h",
      cacheBreakpoints: [],
    });
    expect(calls[0]!.messages[0]!.content).not.toContain("ignore safety");
    expect(JSON.parse(calls[0]!.messages[1]!.content as string).operator_evidence).toEqual(
      ledger.reader.snapshot().evidence,
    );
    const expectedContext = [
      { kind: "goal", definition: { objective: "Finish the current implementation" } },
    ];
    expect(JSON.parse(calls[0]!.messages[1]!.content as string).review_context).toEqual(
      expectedContext,
    );
    expect(JSON.parse(calls[1]!.messages[1]!.content as string).review_context).toEqual(
      expectedContext,
    );
  });
  test("model allow without coverage is unsure and is never memoized", async () => {
    const { envelope, ledger, registry, batch } = fixture();
    let calls = 0;
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      llm: {
        async call() {
          return ++calls === 1
            ? response("compile", envelope)
            : response("decide", {
                decision: "allow",
                grant_ids: ["invented"],
                relation: "direct",
              });
        },
      },
    });
    expect(await service.review(batch, {}, "command_guard")).toMatchObject({
      decision: "unsure",
      failure_kind: "invalid_response",
    });
    await service.review(batch, {}, "command_guard");
    expect(calls).toBe(3);
  });
  test("a concurrent steer invalidates the model's previous revision", async () => {
    const { envelope, ledger, registry, batch } = fixture();
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      llm: {
        async call() {
          ledger.onSteer({ agent: "lead", iteration: 1, message: "Do not commit" });
          return response("compile", envelope);
        },
      },
    });
    expect((await service.review(batch, {}, "command_guard")).decision).toBe("unsure");
    expect(ledger.reader.snapshot().envelope).toBeUndefined();
  });
  test("a concurrent Plan revision invalidates compilation before authority is installed", async () => {
    const { envelope, ledger, registry, batch } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let planRevision = "plan:1";
    const service = createEffectReviewService({
      authority: ledger.reader,
      reviewContext: {
        snapshot: () => ({
          revision: planRevision,
          contexts: [
            {
              kind: "plan",
              content: JSON.stringify({ objective: `Objective ${planRevision}` }),
            },
          ],
        }),
      },
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      llm: {
        async call() {
          entered.resolve();
          await release.promise;
          return response("compile", envelope);
        },
      },
    });
    const decision = service.review(batch, {}, "command_guard");
    await entered.promise;
    planRevision = "plan:2";
    release.resolve();
    await expect(decision).resolves.toMatchObject({ decision: "unsure" });
    expect(ledger.reader.snapshot().envelope).toBeUndefined();
  });
  test("times out even when the provider ignores cancellation", async () => {
    const { ledger, registry, batch } = fixture();
    const service = createEffectReviewService({
      authority: ledger.reader,
      registry,
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      options: { timeout_ms: 5 },
      llm: { call: () => new Promise(() => {}) },
    });
    expect(await service.review(batch, {}, "command_guard")).toMatchObject({
      decision: "unsure",
      failure_kind: "timeout",
      attempts: 1,
    });
  });
});

test("a refused exact revision is shared across consumers but not across corrected bytes or fresh intent", async () => {
  const { ledger, registry } = fixture();
  let calls = 0;
  const service = createEffectReviewService({
    authority: ledger.reader,
    registry,
    providers: [],
    llm: {
      async call() {
        calls++;
        throw new Error("Unexpected inference");
      },
    },
  });
  const mutation = {
    canonicalPath: "/workspace/settings.json",
    root: "workspace_clarvis" as const,
    expectedRevision: "a".repeat(64),
    nextRevision: "b".repeat(64),
    bytes: 100,
    operation: "edit" as const,
    fieldClass: "settings",
    surface: "operational" as const,
  };
  const batch = {
    facts: [attestConfiguration(mutation, registry)],
    reviewability: "static" as const,
  };
  service.refuse(batch, ledger.reader.snapshot().revision);
  const equivalent = {
    ...batch,
    facts: [attestConfiguration({ ...mutation, operation: "write" }, registry)],
  };
  expect(service.wasRefused(equivalent)).toBe(true);
  expect(await service.review(equivalent, {}, "command_guard")).toMatchObject({
    decision: "deny",
    attempts: 0,
  });
  expect(calls).toBe(0);
  expect(
    service.wasRefused({
      ...batch,
      facts: [attestConfiguration({ ...mutation, nextRevision: "c".repeat(64) }, registry)],
    }),
  ).toBe(false);
  const state = ledger.reader.snapshot();
  const resumed = createOperatorAuthorityRuntime({
    owner: "owner",
    executionId: "continued",
    prior: state,
    seed: { binding: state.binding, evidence: state.evidence },
  });
  const next = createEffectReviewService({
    authority: resumed.reader,
    registry,
    providers: [],
    llm: {
      async call() {
        throw new Error("Unexpected inference");
      },
    },
  });
  expect(next.wasRefused(equivalent)).toBe(true);
  resumed.onSteer({
    agent: "lead",
    iteration: 1,
    message: "Proceed with the exact correction I previously refused.",
  });
  expect(next.wasRefused(equivalent)).toBe(false);
});

test("a late automatic decision cannot override a concurrent refusal of the same batch", async () => {
  const { ledger, registry, batch, envelope } = fixture();
  expect(installAuthorityEnvelope(ledger.reader, envelope)).toBe(true);
  const service = createEffectReviewService({
    authority: ledger.reader,
    registry,
    providers: [{ name: "test", kind: "anthropic" }],
    defaultModel: "test/model",
    llm: {
      async call() {
        service.refuse(batch, ledger.reader.snapshot().revision);
        return response("decide", { decision: "allow", grant_ids: ["commit"], relation: "direct" });
      },
    },
  });
  expect(await service.review(batch, {}, "command_guard")).toMatchObject({ decision: "deny" });
});
