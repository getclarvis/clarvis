import type {
  ImagePart,
  LifecycleHook,
  Message,
  MessageContent,
  ReasoningEffort,
  ReasoningSummary,
  SteerSource,
  TracePort,
} from "@clarvis/capability";
import type { TokenAccumulator, TokenCounts } from "@clarvis/capability";
import type { LLMProvider, ResolvedProviderConfig } from "@clarvis/capability";
import type { NamespacedRegistry } from "@clarvis/capability";
import { createIterationCounter, type TokenLedger } from "../budget/budget.ts";
import { DISABLED_COMPACTION, type CompactionConfig } from "../context/context-compaction.ts";
import { createToolSpill } from "../context/tool-spill.ts";
import { runAgent } from "../loop/run-agent.ts";
import { toLlmTarget, type AgentResult } from "../loop/loop-shared.ts";
import {
  buildSubagentInputPersona,
  buildSystemSections,
  userText,
} from "./build-subagent-input.ts";
import type { AgentCapability } from "@clarvis/capability";
import type { ComputeClock, ComputeRegion } from "@clarvis/capability";

/**
 * The terminal outcome of a sub-agent run: a `completed` result text, a
 * `budget_exhausted` or `cancelled` partial, or an `error` with a code and
 * message.
 *
 * @remarks Derived from the loop's `AgentResult` by {@link toSubagentOutcome} and
 *   later rendered to lead-facing text by the delegation runtime.
 */
export type SubagentOutcome =
  | { status: "completed"; text: string }
  | { status: "budget_exhausted"; partialText: string }
  | { status: "cancelled"; partialText: string }
  | { status: "error"; code: string; message: string };

/** Token counts for a sub-agent run plus the number of iterations it took. */
export type SubagentUsageSnapshot = TokenCounts & { iterations: number };

/**
 * Everything {@link runSubagent} needs to run one sub-agent to completion: the
 * task and optional images, the resolved model/provider settings, the shared
 * token `ledger`, the sub-agent's own iteration `maxIterations`, the tool
 * `registry`, tracing, cancellation, compaction, capabilities, and an optional
 * `usageSink` that always receives the final counts.
 */
export interface RunSubagentInput {
  task?: string;
  images?: ImagePart[];
  basePrompt?: string;
  model: string;
  provider: string;
  providerConfig?: ResolvedProviderConfig;
  capabilities?: Set<string>;
  reasoningSummary?: ReasoningSummary;
  reasoningEffort?: ReasoningEffort;
  callTimeoutMs?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  subagentInstanceId: string;
  llm: LLMProvider;
  registry: NamespacedRegistry;
  ledger: TokenLedger;
  maxIterations: number;
  stagnationThreshold?: number;
  trace: TracePort;
  signal?: AbortSignal;
  /** This sub-agent's own steer channel, when its parent may redirect it
   * mid-flight (`agent_steer`). A run-level steer never reaches here. */
  steer?: SteerSource;
  /** This sub-agent's background compute region, when it was spawned in the
   * background — its dispatch pauses this rather than the shared clock. */
  computeRegion?: ComputeRegion;
  compaction?: CompactionConfig;
  compactionPrompt?: string;
  agentCapabilities?: AgentCapability[];
  /** Capability-contributed system-prompt sections (e.g. the skills catalog). */
  systemSections?: string[];
  /** Whether the built-in coding toolset is active for this agent (persona). */
  hasBuiltinTools?: boolean;
  usageSink?: SubagentUsageSnapshot;
  clock?: ComputeClock;
  workspaceRoot?: string;
  hooks?: LifecycleHook[];
}

/** A finished sub-agent run: its {@link SubagentOutcome} and usage snapshot. */
export interface RunSubagentResult {
  outcome: SubagentOutcome;
  usage: SubagentUsageSnapshot;
}

/**
 * Builds the sub-agent's seed message list from its task and prompt sections.
 *
 * @param task - the sub-task text (empty string when none was provided).
 * @param basePrompt - the profile's base prompt/identity, if any.
 * @param workspaceRoot - the workspace root for the `# Workspace` preamble.
 * @param images - image parts to attach alongside the task text.
 * @param capabilitySections - capability-contributed system sections.
 * @returns a `[system?, user]` message pair — the system message is emitted only
 *   when some section is present; images ride as extra content parts on the user
 *   message.
 */
function seedFromTask(
  task: string,
  basePrompt?: string,
  workspaceRoot?: string,
  images?: ImagePart[],
  capabilitySections?: readonly string[],
): Message[] {
  const sections = buildSystemSections({
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(basePrompt !== undefined ? { basePrompt } : {}),
    ...(capabilitySections !== undefined ? { capabilitySections } : {}),
  });
  const systemContent = sections.length > 0 ? sections.join("\n\n") : undefined;
  const userContent: MessageContent =
    images !== undefined && images.length > 0
      ? [{ type: "text" as const, text: task }, ...images]
      : task;
  if (systemContent !== undefined && systemContent.length > 0) {
    return [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ];
  }
  return [{ role: "user", content: userContent }];
}

/**
 * Runs one sub-agent loop to termination and reports its outcome and usage.
 *
 * @param input - the fully resolved run inputs; see {@link RunSubagentInput}.
 * @returns the {@link RunSubagentResult} — the outcome plus a usage snapshot
 *   carrying the final token counts and iteration count.
 * @remarks Seeds the conversation via {@link seedFromTask}, pins the task text as
 *   the sub-agent's static anchor, and delegates to `runAgent` with the
 *   sub-agent persona. Compaction defaults to `DISABLED_COMPACTION` when the
 *   profile sets none. The `usageSink`, when supplied, is always populated in a
 *   `finally` block, so partial usage survives even if `runAgent` throws.
 */
export async function runSubagent(input: RunSubagentInput): Promise<RunSubagentResult> {
  const counter = createIterationCounter(input.maxIterations);
  const usage: TokenAccumulator = { input: 0, output: 0, cached: 0, cache_write: 0 };
  const messages: Message[] = seedFromTask(
    input.task ?? "",
    input.basePrompt,
    input.workspaceRoot,
    input.images,
    input.systemSections,
  );
  const subagentTaskBody = userText(messages);

  try {
    const result = await runAgent({
      agent: "subagent",
      subagentInstanceId: input.subagentInstanceId,
      messages,
      target: toLlmTarget(input.llm, input),
      budget: { ledger: input.ledger, counter, usage },
      runtime: { trace: input.trace, ...(input.signal ? { signal: input.signal } : {}) },
      compaction: input.compaction ?? DISABLED_COMPACTION,
      ...(input.compactionPrompt !== undefined ? { compactionPrompt: input.compactionPrompt } : {}),
      ...(input.workspaceRoot !== undefined
        ? { spillToolResult: createToolSpill(input.workspaceRoot) }
        : {}),
      registry: input.registry,
      ...(input.stagnationThreshold !== undefined
        ? { stagnationThreshold: input.stagnationThreshold }
        : {}),
      ...(input.clock ? { clock: input.clock } : {}),
      ...(input.computeRegion ? { computeRegion: input.computeRegion } : {}),
      ...(input.steer ? { steer: input.steer } : {}),
      ...(input.agentCapabilities ? { agentCapabilities: input.agentCapabilities } : {}),
      ...(input.hooks ? { hooks: input.hooks } : {}),
      ...buildSubagentInputPersona({
        registry: input.registry,
        subagentTaskBody,
        subagentInstanceId: input.subagentInstanceId,
        model: input.model,
        trace: input.trace,
        hasBuiltinTools: input.hasBuiltinTools ?? false,
      }),
    });

    const outcome = toSubagentOutcome(result);
    return { outcome, usage: { ...usage, iterations: counter.count() } };
  } finally {
    if (input.usageSink) {
      input.usageSink.input = usage.input;
      input.usageSink.output = usage.output;
      input.usageSink.cached = usage.cached;
      input.usageSink.cache_write = usage.cache_write;
      input.usageSink.iterations = counter.count();
    }
  }
}

/**
 * Maps a loop `AgentResult` onto the narrower {@link SubagentOutcome}.
 *
 * @param result - the loop's terminal result for the sub-agent.
 * @returns the corresponding outcome. A `completed` result prefers its `text`,
 *   falling back to `partialText`; `soft_limit_declined` collapses into
 *   `budget_exhausted`; an `error` fills in `"empty_response"` / a default
 *   message when the loop left them unset.
 */
export function toSubagentOutcome(result: AgentResult): SubagentOutcome {
  switch (result.status) {
    case "completed":
      return { status: "completed", text: result.text ?? result.partialText };
    case "budget_exhausted":
      return { status: "budget_exhausted", partialText: result.partialText };
    case "soft_limit_declined":
      return { status: "budget_exhausted", partialText: result.partialText };
    case "cancelled":
      return { status: "cancelled", partialText: result.partialText };
    case "error":
      return {
        status: "error",
        code: result.error?.code ?? "empty_response",
        message: result.error?.message ?? "Sub-agent terminated with no result.",
      };
  }
}
