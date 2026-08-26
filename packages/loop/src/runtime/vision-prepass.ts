import { sanitizeErrorMessage } from "@clarvis/capability";
import type { EnvConfig, TracePort } from "@clarvis/capability";
import type { RunRequest } from "@clarvis/capability";
import type { LLMProvider, LLMUsage } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { parseModelRef, resolveProvider } from "@clarvis/capability";
import type { TokenLedger } from "./budget/budget.ts";
import { userText } from "./subagents/build-subagent-input.ts";
import type { EntrySeed } from "./entry-seed.ts";
import type { UsageAccounting } from "./usage-accounting.ts";

/**
 * The ambient dependencies of the vision prepass: the env/config, the LLM
 * provider, and an optional logger.
 */
export interface VisionPrepassDeps {
  env: EnvConfig;
  llm: LLMProvider;
  logger?: Logger;
}

/**
 * The per-run inputs to {@link runVisionPrepass}: the abort signal, the
 * {@link VisionPrepassDeps}, the run request, the trace and token ledger, the
 * mutable {@link EntrySeed}, and the usage accounting the pass's tokens are
 * folded into.
 */
export interface VisionPrepassArgs {
  signal: AbortSignal | undefined;
  deps: VisionPrepassDeps;
  request: RunRequest;
  trace: TracePort;
  ledger: TokenLedger;
  seed: EntrySeed;
  accounting: UsageAccounting;
}

/** The instruction the reading model runs under. */
const VISION_SYSTEM_PROMPT =
  "You read images on behalf of another agent whose own model cannot see them. Describe the " +
  "attached image(s) faithfully and in full, extracting everything relevant to the request " +
  "below. Report what is actually visible; never guess at content you cannot make out, and say " +
  "so when something is illegible. Answer with the description alone.";

/**
 * The output ceiling for one reading, in tokens.
 *
 * @remarks Sized for the artefact rather than for the model: the reading is
 * spliced into the entry agent's message stream as an `[image analysis]` user
 * message, so it is paid once at the ceiling and then carried in the cached
 * prefix for the rest of the run. The prompt asks for a faithful description of
 * what is visible, which is prose about one turn's images — a bound that a
 * screenshot of dense text can reach and that a diagram will not approach. Too
 * low truncates the description the entry model is about to reason over, with no
 * way for it to ask for more; too high lets one unusual image displace the
 * conversation it was attached to.
 */
const VISION_MAX_OUTPUT_TOKENS = 4_096;

/**
 * When the entry model cannot see images, read the turn's images with the run's
 * `vision_model` and splice the reading into the entry message stream.
 *
 * A no-op unless the entry seed flagged that it stripped images, images are
 * present, and the request names a `vision_model`. It then issues **one**
 * completion — no tools, no workspace, no agent identity — over the images plus
 * any accompanying user text, and on a non-empty result appends an
 * `[image analysis]` user message to `p.seed.entryMessages`.
 *
 * @param p - the prepass inputs; see {@link VisionPrepassArgs}.
 * @returns nothing; effects are the appended entry message, one
 *   `vision_analysis` trace entry, the ledger charge, and the spend recorded on
 *   `p.accounting.vision` as its own `type: "vision"` usage row.
 * @remarks This is a single model call rather than a sub-agent run, which is
 *   why it names a *model* and not a profile. Reading an image needs no tool
 *   surface, no spawn identity and no iteration budget; running a nested agent
 *   to get one put an unaddressable child on the core run path and charged an
 *   entire agent loop for a description.
 *
 *   Failure is swallowed: a call that errors or is cancelled, or an empty
 *   reading, leaves the entry model to proceed on the numbered
 *   `[image #n omitted: …]` placeholders it would have seen anyway. What the
 *   provider managed to report as already billed is still charged, because a
 *   failed attempt still cost it.
 *
 *   A model that declares capabilities *without* `vision` is refused before the
 *   call. The provider boundary would strip the images and hand it the same
 *   placeholders, so it would answer from nothing and the entry agent would be
 *   told an image had been read on its behalf — a fabricated reading is worse
 *   than no reading. An *unknown* capability set still proceeds, matching the
 *   boundary's own `?? true`.
 *
 *   A reading the provider cut off at `maxOutputTokens` is kept rather than
 *   discarded — a partial description still beats placeholders — but it is
 *   labelled as cut off in both the trace and the message the agent reads.
 *   This is deliberately unlike `summarizeContext`, which refuses a truncated
 *   summary because it overwrites a rolling anchor no other copy exists of;
 *   this reading is transient and overwrites nothing.
 *
 *   The provider is resolved rather than required: `requireResolvableModelProviders`
 *   already rejected a request whose `vision_model` names an undeclared provider,
 *   so an unresolved config here means only that no per-provider overrides apply.
 *
 *   The append lands at the absolute end of `entryMessages`, which is sound only
 *   because `buildEntrySeed` leaves no volatile entry in the seed: it drops the
 *   ones a continuation restored, and none of the durable ones it emits is
 *   canonical or a runtime note. A volatile entry at the tail would be spliced
 *   out on the next iteration and shift this message, invalidating the cached
 *   prefix that covered it. If the seed ever grows a volatile tail, this push has
 *   to move ahead of it.
 */
export async function runVisionPrepass(p: VisionPrepassArgs): Promise<void> {
  if (!p.seed.entryStripsImages || p.seed.turnImages.length === 0) return;
  const modelRef = p.request.vision_model;
  if (modelRef === undefined) return;

  const ref = parseModelRef(modelRef);
  const resolution = resolveProvider(ref.provider, p.request.providers, ref.modelId);
  const modelConfig = p.request.providers.find((pr) => pr.name === ref.provider)?.models?.[
    ref.modelId
  ];
  const capabilities = modelConfig?.capabilities ? new Set(modelConfig.capabilities) : undefined;
  if (capabilities !== undefined && !capabilities.has("vision")) {
    p.deps.logger?.warn(
      { event: "vision.capability_missing", model: modelRef },
      "vision_model does not declare the 'vision' capability; no image analysis is attempted",
    );
    p.trace.record("vision_analysis", {
      model: modelRef,
      image_count: p.seed.turnImages.length,
      status: "failed",
      result: `'${modelRef}' does not declare the 'vision' capability, so it cannot read an image.`,
    });
    return;
  }

  const accompanying = userText(p.request.messages);
  const request =
    accompanying.length > 0 ? accompanying : "(no accompanying text — describe the image(s))";

  let usage: LLMUsage | undefined;
  let text: string | null = null;
  let failure: string | null = null;
  let truncated = false;
  try {
    const result = await p.deps.llm.call({
      model: ref.modelId,
      provider: ref.provider,
      ...(resolution.ok ? { providerConfig: resolution.config } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [{ type: "text", text: request }, ...p.seed.turnImages],
        },
      ],
      tools: [],
      reasoningEffort: "off",
      maxOutputTokens: Math.min(
        modelConfig?.max_output_tokens ?? VISION_MAX_OUTPUT_TOKENS,
        VISION_MAX_OUTPUT_TOKENS,
      ),
      timeoutMs: p.deps.env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS,
      ...(p.signal ? { signal: p.signal } : {}),
    });
    usage = result.usage;
    const trimmed = (result.text ?? "").trim();
    if (trimmed.length === 0) {
      failure = "the vision model returned no description";
    } else if (result.finishReason === "length") {
      truncated = true;
      text = trimmed;
    } else {
      text = trimmed;
    }
  } catch (err) {
    const aborted = p.signal?.aborted === true;
    failure = aborted ? "the vision pass was cancelled" : errorMessage(err);
    usage = partialUsageOf(err);
    p.deps.logger?.warn(
      { event: "vision.call_failed", model: modelRef, err: sanitizeErrorMessage(failure) },
      "vision pass failed; the entry model proceeds without an image analysis",
    );
  } finally {
    if (usage !== undefined) {
      p.ledger.consume(usage);
      p.accounting.vision.current = {
        model: modelRef,
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cached: usage.cached_tokens,
          cache_write: usage.cache_write_tokens,
        },
      };
    }
  }

  p.trace.record("vision_analysis", {
    model: modelRef,
    image_count: p.seed.turnImages.length,
    status: text !== null ? "completed" : "failed",
    result: text ?? failure ?? "the vision pass produced no usable reading",
  });

  if (text !== null) {
    p.seed.entryMessages.push({
      role: "user",
      content:
        `[image analysis] The '${modelRef}' model read the attached image(s) on your behalf ` +
        "(your model cannot view images directly). Its reading" +
        (truncated ? ", which was CUT OFF at the output limit and may omit detail" : "") +
        ":\n\n" +
        text,
    });
  }
}

/**
 * The tokens a failed provider call had already billed, when it could say.
 *
 * @remarks A failed attempt still costs the full prompt, so dropping it
 *   under-counts the ledger silently — which is exactly why
 *   {@link import("@clarvis/capability").ProviderError} carries `partialUsage`.
 */
function partialUsageOf(err: unknown): LLMUsage | undefined {
  const partial = (err as { partialUsage?: LLMUsage } | null)?.partialUsage;
  return partial ?? undefined;
}

/** The message of a thrown value, whatever its shape. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
