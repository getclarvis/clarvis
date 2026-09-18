import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentToText,
  loadEnv,
  type LLMCallParams,
  type LLMProvider,
  type ProviderConfig,
  type TracePort,
} from "@clarvis/capability";
import type { GuardJudgeConfig } from "@clarvis/judge/settings";
import { createTestRunInfrastructure } from "@clarvis/loop/testing";
import type { GuardElicit } from "@clarvis/loop";
import { createJudgeCoordinator } from "@clarvis/judge/testing";
import { createCommandReview } from "../../src/guard/command-review.ts";
import { createHostEffectReview } from "../../src/guard/effect-review.ts";
import { callReviewerWithTrace, reviewerFailureKind } from "../../src/guard/reviewer-trace.ts";

type HostDeps = Omit<Parameters<typeof createHostEffectReview>[0], "judge">;
type ProviderDeps = {
  llm: LLMProvider;
  providers: ProviderConfig[];
  defaultModel?: string;
  trace?: TracePort;
};
const cleanups: Array<() => Promise<void>> = [];

/** Retire every real coordinator and its test-owned storage after the test settles. */
export async function closeReviewFixtures() {
  for (const close of cleanups.splice(0)) await close();
}

/** Compose the production coordinator and Loop with test-owned infrastructure, never a second reviewer. */
function runtime(deps: ProviderDeps & { signal?: AbortSignal }, config: GuardJudgeConfig) {
  const root = mkdtempSync(join(tmpdir(), "review-runtime-"));
  const env = loadEnv({ CLARVIS_LOG_LEVEL: "silent" });
  const infrastructure = createTestRunInfrastructure({ env, workspaceRoot: root });
  const judge = createJudgeCoordinator({
    owner: "owner",
    workExecutionId: crypto.randomUUID(),
    sessionId: "session_with_underscore",
    executionBaseLlm: deps.llm,
    promptCacheTtl: "1h",
    model: config.model ?? deps.defaultModel,
    providers: deps.providers,
    timeoutMs: config.timeout_ms ?? env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
    maxRetries: config.max_retries ?? env.CLARVIS_DEFAULT_MAX_RETRIES,
    signal: deps.signal,
    createServices: (descriptor) => ({
      ...infrastructure,
      env,
      llm: {
        call: (params) =>
          callReviewerWithTrace(descriptor.executionBaseLlm, params, {
            trace: deps.trace,
            path: descriptor.observation!.path,
            consumer: descriptor.observation!.consumer,
            stage: descriptor.stage(),
            judge_execution_id: descriptor.executionId,
            failureKind: (error) => reviewerFailureKind(error, descriptor.signal),
          }),
      },
    }),
  });
  cleanups.push(async () => {
    await judge.close();
    await infrastructure.connections.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return judge;
}

/** Exercise the real command consumer and isolated Judge rather than the retired direct-provider protocol. */
export function commandReviewFixture(
  deps: ProviderDeps & Omit<Parameters<typeof createCommandReview>[0], "judge">,
  config: GuardJudgeConfig,
  human: GuardElicit | undefined,
) {
  const judge = runtime(deps, config);
  return createCommandReview({ ...deps, judge: () => judge }, config, human);
}

/** Exercise host attestation, authority installation and private Judge execution together. */
export function effectReviewFixture(deps: ProviderDeps & HostDeps) {
  const judge = runtime(deps, deps.options ?? {});
  return createHostEffectReview({ ...deps, judge: () => judge });
}

/** Decode one actual framed region for assertions without altering provider input. */
export function reviewFrame(params: LLMCallParams, name: string): unknown {
  const text = params.messages
    .map((m) => contentToText(m.content))
    .find((t) => t.startsWith(`<${name}>\n`));
  if (text === undefined) throw new Error(`Missing ${name}`);
  return JSON.parse(text.slice(name.length + 3, text.lastIndexOf(`\n</${name}>`)));
}

/** Gather chronological authenticated evidence from the real prompt for fixture assertions. */
export function reviewEvidence(params: LLMCallParams): unknown[] {
  return params.messages
    .map((m) => contentToText(m.content))
    .filter((t) => t.startsWith("<judge_operator_evidence_v1>\n"))
    .map((t) =>
      JSON.parse(
        t.slice(
          "<judge_operator_evidence_v1>\n".length,
          t.lastIndexOf("\n</judge_operator_evidence_v1>"),
        ),
      ),
    );
}
