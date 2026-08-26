import {
  NOOP_LOGGER,
  type ContextSnapshotEntry,
  type EnvConfig,
  type LLMProvider,
  type Logger,
  type RunRequest,
  type TokenAccumulator,
} from "@clarvis/capability";
import { createTokenLedger } from "../budget/budget.ts";
import { deriveRunShape } from "../run-shape.ts";
import { resolveSubagentProfiles } from "../subagents/subagent-profiles.ts";
import { attemptCompaction } from "./llm-compaction.ts";
import { createLiveContext } from "./live-context.ts";
import {
  deriveMaxResultChars,
  derivePreserveRecentTokens,
  liveMessageChars,
} from "./compaction-policy.ts";

/** Outcome of compacting a settled run's restorable context. */
export type StoredContextCompactionResult =
  | {
      status: "compacted";
      context: ContextSnapshotEntry[];
      freedChars: number;
      usage: TokenAccumulator;
    }
  | {
      status: "skipped";
      reason:
        | "disabled"
        | "nothing_to_compact"
        | "summarization_disabled"
        | "summarization_failed"
        | "summary_not_effective";
      usage: TokenAccumulator;
    };

/** Inputs needed to compact an already-persisted continuation snapshot. */
export interface CompactStoredContextArgs {
  context: readonly ContextSnapshotEntry[];
  request: RunRequest;
  guidance?: string;
  env: EnvConfig;
  llm: LLMProvider;
  logger?: Logger;
  signal?: AbortSignal;
}

/** Estimate the provider-facing size of a persisted continuation snapshot. */
export function estimateStoredContextTokens(context: readonly ContextSnapshotEntry[]): number {
  return Math.ceil(storedContextChars(context) / 4);
}

function storedContextChars(context: readonly ContextSnapshotEntry[]): number {
  return context.reduce((total, entry) => total + liveMessageChars(entry.message), 0);
}

/** Mechanically evict old context until it fits a smaller model window. */
export function fitStoredContextToWindow(
  context: readonly ContextSnapshotEntry[],
  targetWindowTokens: number,
  env: EnvConfig,
  logger: Logger = NOOP_LOGGER,
):
  | { status: "compacted"; context: ContextSnapshotEntry[]; freedChars: number }
  | {
      status: "skipped";
      reason: "nothing_to_compact" | "cannot_fit";
    } {
  const fraction = env.CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION;
  const targetFraction = Math.min(env.CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION, fraction * 0.8);
  const ctx = createLiveContext(
    context,
    {
      enabled: true,
      windowTokens: targetWindowTokens,
      fraction,
      targetFraction,
      maxResultChars:
        env.CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS ?? deriveMaxResultChars(targetWindowTokens),
      preserveRecentTokens:
        env.CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS ??
        derivePreserveRecentTokens(targetWindowTokens),
      llmTimeoutMs: env.CLARVIS_COMPACTION_LLM_TIMEOUT_MS,
    },
    { agent: "lead", logger },
  );
  const beforeChars = storedContextChars(context);
  const highWater = Math.floor(targetWindowTokens * fraction);
  let changed = false;
  while (ctx.estimateTokens() > highWater) {
    if (ctx.compact({ mode: "forced" }) === undefined) break;
    changed = true;
  }
  const snapshot = ctx.snapshot();
  if (estimateStoredContextTokens(snapshot) > highWater) {
    return { status: "skipped", reason: "cannot_fit" };
  }
  if (!changed) return { status: "skipped", reason: "nothing_to_compact" };
  return {
    status: "compacted",
    context: snapshot,
    freedChars: Math.max(0, beforeChars - storedContextChars(snapshot)),
  };
}

/**
 * Compact a settled run's continuation snapshot without executing another agent turn.
 *
 * @remarks The caller owns persistence. The old snapshot is never mutated in place;
 *   this returns a replacement only after an effective forced pass succeeds.
 */
export async function compactStoredContext(
  args: CompactStoredContextArgs,
): Promise<StoredContextCompactionResult> {
  const profiles = resolveSubagentProfiles(args.request.profiles, args.request.providers, args.env);
  const shape = deriveRunShape(args.request, profiles);
  const profile = shape.entryResolved;
  const usage: TokenAccumulator = { input: 0, output: 0, cached: 0, cache_write: 0 };
  if (!profile.compaction.enabled) return { status: "skipped", reason: "disabled", usage };

  const guidance = args.guidance?.trim();
  if (guidance && profile.compactionPrompt === undefined) {
    return { status: "skipped", reason: "summarization_disabled", usage };
  }

  const ctx = createLiveContext(args.context, profile.compaction, {
    agent: shape.isLead ? "lead" : "subagent",
    logger: args.logger ?? NOOP_LOGGER,
  });
  const outcome = await attemptCompaction({
    ctx,
    ...(profile.compactionPrompt !== undefined
      ? { compactionPrompt: profile.compactionPrompt }
      : {}),
    ...(guidance ? { contributions: [{ source: "user", text: guidance }] } : {}),
    llm: args.llm,
    model: profile.model,
    provider: profile.provider,
    ...(profile.providerConfig !== undefined ? { providerConfig: profile.providerConfig } : {}),
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    timeoutMs: profile.compaction.llmTimeoutMs,
    windowTokens: profile.compaction.windowTokens,
    ledger: createTokenLedger(Number.POSITIVE_INFINITY),
    usage,
    logger: args.logger ?? NOOP_LOGGER,
    mode: "forced",
    fallbackOnFailure: guidance === undefined,
  });
  if (outcome.kind === "skipped") return { status: "skipped", reason: outcome.reason, usage };
  return {
    status: "compacted",
    context: ctx.snapshot(),
    freedChars: outcome.event.freed_chars ?? 0,
    usage,
  };
}
