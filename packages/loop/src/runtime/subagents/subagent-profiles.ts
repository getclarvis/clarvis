import type {
  AgentProfile,
  CompactionConfigInput,
  Grant,
  ProviderConfig,
  ReasoningEffort,
  ReasoningSummary,
} from "@clarvis/capability";
import { DEFAULT_COMPACTION_PROMPT } from "../context/compaction-prompt.ts";
import type { ResolvedProviderConfig } from "@clarvis/capability";
import type { EnvConfig } from "@clarvis/capability";
import {
  deriveMaxResultChars,
  derivePreserveRecentTokens,
  type CompactionConfig,
} from "../context/context-compaction.ts";
import { resolveProvider } from "@clarvis/capability";
import { parseModelRef } from "@clarvis/capability";

/**
 * A fully resolved sub-agent profile: the raw {@link AgentProfile} frontmatter
 * merged with provider resolution, model config, and environment defaults into
 * the concrete fields the delegation runtime hands to `runSubagent`.
 *
 * @remarks Produced by {@link resolveSubagentProfiles}. `model` is the bare model
 *   id while `modelRef` keeps the original `provider/model` reference (used for
 *   usage accounting); `capabilities` mirrors the model's declared capability set
 *   (e.g. `"vision"`).
 */
export interface ResolvedSubagentProfile {
  name: string;
  description?: string;
  model: string;
  modelRef: string;
  provider: string;
  providerConfig?: ResolvedProviderConfig;
  basePrompt?: string;
  tools: string[];
  grants?: Grant[];
  iterationLimit?: number;
  compactionPrompt?: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  capabilities?: Set<string>;
  stagnationThreshold: number;
  callTimeoutMs: number;
  reasoningSummary: ReasoningSummary;
  reasoningEffort?: ReasoningEffort;
  maxRetries: number;
  maxRetryAfterMs: number;
  compaction: CompactionConfig;
  stream: boolean;
}

/**
 * The lead's lookup of sub-agent profiles by name, keyed in declaration order.
 */
export type SubagentProfileRegistry = Map<string, ResolvedSubagentProfile>;

/**
 * Resolves the effective iteration cap for a spawned sub-agent.
 *
 * @param profile - the profile, consulted only for its optional `iterationLimit`.
 * @param defaultLimit - the run-wide fallback when the profile sets none.
 * @returns the profile's `iterationLimit` if present, otherwise `defaultLimit`.
 */
export function resolveIterationCap(
  profile: Pick<ResolvedSubagentProfile, "iterationLimit">,
  defaultLimit: number,
): number {
  return profile.iterationLimit ?? defaultLimit;
}

/**
 * The summarization prompt an agent compacts with.
 *
 * @param c - the profile's compaction block, if any.
 * @returns `{ compactionPrompt }`, or `{}` when summarization is opted out of.
 * @remarks Absent ⇒ {@link DEFAULT_COMPACTION_PROMPT}. With no prompt at all
 *   `runCompaction`'s `if (!compactionPrompt)` guard falls straight through to
 *   blind oldest-first eviction, which is why no shipped agent template ever
 *   summarized: none declares a `compaction` block, so every run in the product
 *   took that branch. `prompt_mode: "none"` is now the only way back to it, and
 *   it is a deliberate choice rather than an omission.
 *
 *   The emptiness check is belt and braces: `compaction.prompt` is `.min(1)` in
 *   the request schema, but the kernel's settings assembler forwards raw agent
 *   frontmatter into this same shape.
 */
function resolveCompactionPrompt(c: CompactionConfigInput | undefined): {
  compactionPrompt?: string;
} {
  if (c?.prompt_mode === "none") return {};
  const declared = c?.prompt?.trim();
  return {
    compactionPrompt:
      declared !== undefined && declared.length > 0 ? declared : DEFAULT_COMPACTION_PROMPT,
  };
}

/**
 * Resolves declared agent-profile frontmatter into the runtime
 * {@link SubagentProfileRegistry}.
 *
 * @param raw - the declared sub-agent profiles, or `undefined` for none.
 * @param providers - the run's provider configs, used to resolve each profile's
 *   provider credentials and per-model settings (context window, capabilities,
 *   max output tokens).
 * @param env - the environment defaults filled in wherever a profile leaves a
 *   field unset (compaction, stagnation, timeout, reasoning, retries, stream).
 * @returns a registry mapping each profile's `name` to its
 *   {@link ResolvedSubagentProfile}, in declaration order.
 * @remarks A model's context window falls back to
 *   `CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS`; the compaction `targetFraction` is
 *   clamped to stay a {@link MIN_COMPACTION_HYSTERESIS} margin below the trigger
 *   `fraction`, so compaction always frees a worthwhile block instead of
 *   trimming one entry per iteration. An unresolvable provider still yields a
 *   profile, just without a `providerConfig`.
 *
 *   `maxResultChars` resolves in three steps — the profile, then
 *   `CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS`, then
 *   {@link deriveMaxResultChars} over the resolved window. The env var carries
 *   no default of its own precisely so that an operator who sets nothing gets a
 *   cap that scales with the model rather than a flat number chosen for some
 *   other model's window. `preserveRecentTokens` resolves the same way through
 *   {@link derivePreserveRecentTokens}, and the summarization prompt through
 *   {@link resolveCompactionPrompt}.
 */
/**
 * The minimum gap between compaction's high- and low-water marks, as a fraction
 * of the high-water mark.
 *
 * @remarks Compaction's damage to a provider's prompt cache is paid **per
 * event**, not per evicted token: eviction rebuilds the transcript mid-array, so
 * every entry behind the cut shifts and the cached prefix dies from there. The
 * high/low hysteresis is what keeps that rare — with the defaults it fires at
 * 80% of the window and drops to 50%, so roughly one full miss per fifty
 * iterations.
 *
 * Nothing stopped an operator from setting `target_fraction` equal to
 * `context_fraction`, which collapses the gap to zero: `selectOldestEvictable`
 * then evicts a single entry, immediately falls back under the low-water mark
 * and stops — so every iteration past the line pays a full prefix miss to
 * reclaim one message. That is a 50× regression in cache cost from a setting
 * that reads like a mild tuning knob, which is why the floor is enforced here
 * rather than documented.
 *
 * The magnitude is what makes an eviction pass worth its own prefix miss: it
 * has to reclaim enough that the next several iterations fit under the trigger
 * again, and a gap narrower than the largest few entries in a transcript cannot
 * promise that. It also sits inside the shipped defaults with room to spare —
 * `CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION` is 0.8 against a target of 0.5,
 * a gap of 0.3 — so the clamp binds only on a configuration that has narrowed
 * that distance deliberately, never on the product's own.
 */
const MIN_COMPACTION_HYSTERESIS = 0.2;

export function resolveSubagentProfiles(
  raw: AgentProfile[] | undefined,
  providers: ProviderConfig[] | undefined,
  env: EnvConfig,
): SubagentProfileRegistry {
  const registry: SubagentProfileRegistry = new Map();
  for (const p of raw ?? []) {
    const ref = parseModelRef(p.model);
    const res = resolveProvider(ref.provider, providers, ref.modelId);
    const modelConfig = providers?.find((pr) => pr.name === ref.provider)?.models?.[ref.modelId];
    const contextWindowTokens =
      modelConfig?.context_window_tokens ?? env.CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS;
    const capabilitySet = modelConfig?.capabilities ? new Set(modelConfig.capabilities) : undefined;
    const fraction =
      p.compaction?.context_fraction ?? env.CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION;
    const compaction: CompactionConfig = {
      enabled: p.compaction?.enabled ?? env.CLARVIS_DEFAULT_COMPACTION_ENABLED,
      windowTokens: contextWindowTokens,
      fraction,
      targetFraction: Math.min(
        p.compaction?.target_fraction ?? env.CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION,
        fraction * (1 - MIN_COMPACTION_HYSTERESIS),
      ),
      maxResultChars:
        p.compaction?.max_result_chars ??
        env.CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS ??
        deriveMaxResultChars(contextWindowTokens),
      preserveRecentTokens:
        p.compaction?.preserve_recent_tokens ??
        env.CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS ??
        derivePreserveRecentTokens(contextWindowTokens),
      llmTimeoutMs: env.CLARVIS_COMPACTION_LLM_TIMEOUT_MS,
    };
    registry.set(p.name, {
      name: p.name,
      ...(p.description !== undefined ? { description: p.description } : {}),
      model: ref.modelId,
      modelRef: p.model,
      provider: ref.provider,
      ...(res.ok ? { providerConfig: res.config } : {}),
      ...(p.base_prompt !== undefined ? { basePrompt: p.base_prompt } : {}),
      tools: p.tools,
      ...(p.grants !== undefined ? { grants: p.grants } : {}),
      ...(p.iteration_limit !== undefined ? { iterationLimit: p.iteration_limit } : {}),
      ...resolveCompactionPrompt(p.compaction),
      contextWindowTokens,
      ...(modelConfig?.max_output_tokens !== undefined
        ? { maxOutputTokens: modelConfig.max_output_tokens }
        : {}),
      ...(capabilitySet !== undefined ? { capabilities: capabilitySet } : {}),
      stagnationThreshold: p.stagnation_threshold ?? env.CLARVIS_DEFAULT_STAGNATION_THRESHOLD,
      callTimeoutMs: p.call_timeout_ms ?? env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
      reasoningSummary: p.reasoning_summary ?? env.CLARVIS_DEFAULT_REASONING_SUMMARY,
      ...((p.reasoning_effort ?? env.CLARVIS_DEFAULT_REASONING_EFFORT)
        ? { reasoningEffort: p.reasoning_effort ?? env.CLARVIS_DEFAULT_REASONING_EFFORT }
        : {}),
      maxRetries: p.retry?.max_retries ?? env.CLARVIS_DEFAULT_MAX_RETRIES,
      maxRetryAfterMs: p.retry?.max_retry_after_ms ?? env.CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS,
      compaction,
      stream: env.CLARVIS_STREAM,
    });
  }
  return registry;
}

/**
 * Whether any of these profiles could be handed an image — that is, whether any
 * runs on a model declaring the `vision` capability.
 *
 * @param profiles - the candidate profiles.
 * @returns `true` when at least one qualifies.
 * @remarks Gates the `image_refs` property on both child-spawn tools: offering the
 *   parameter when nothing could receive an image only invites a refusal.
 *
 *   A model whose capabilities are unknown counts as blind here, unlike the
 *   provider boundary and the entry seed, which assume vision. The asymmetry is
 *   deliberate: sending images to a model that turns out to be blind costs a
 *   placeholder, while *routing* images to a sub-agent that turns out to be
 *   blind costs a whole wasted agent run.
 */
export function hasVisionCapableProfile(profiles: Iterable<ResolvedSubagentProfile>): boolean {
  for (const p of profiles) {
    if (p.capabilities?.has("vision") ?? false) return true;
  }
  return false;
}

/**
 * Finds the first tool reference that names a tool absent from the allowed pool.
 *
 * @param refs - labeled tool-name lists to validate (e.g. per profile).
 * @param poolNames - the set of known/available tool names.
 * @returns the offending `{ label, tool }` at the first unknown reference, or
 *   `null` when every referenced tool exists in the pool.
 */
export function findInvalidToolRef(
  refs: { label: string; tools: string[] }[],
  poolNames: string[],
): { label: string; tool: string } | null {
  const known = new Set(poolNames);
  for (const ref of refs) {
    for (const tool of ref.tools) {
      if (!known.has(tool)) return { label: ref.label, tool };
    }
  }
  return null;
}
