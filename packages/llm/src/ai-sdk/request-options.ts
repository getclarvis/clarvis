import {
  jsonSchema,
  tool,
  type JSONSchema7,
  type JSONValue,
  type ModelMessage,
  type SystemModelMessage,
  type ToolChoice as AiToolChoice,
  type ToolSet,
} from "ai";
import {
  reasoningOutputFloor,
  type LLMCallParams,
  type NamespacedTool,
  type PromptCacheTtl,
  type ToolChoice,
} from "@clarvis/capability";
import { cacheMarkerOptions } from "../openai-compatible-request.ts";

/**
 * Anthropic's ephemeral cache-control marker for one breakpoint.
 *
 * @param ttl - how long the written prefix should survive.
 * @returns the provider-options fragment to merge onto a message.
 * @remarks `"5m"` emits `{ type: "ephemeral" }` with **no** `ttl` key: five
 *   minutes is Anthropic's default, so omitting it keeps the request body
 *   byte-identical to a run that never set the field. `"1h"` adds `ttl: "1h"`,
 *   which `@ai-sdk/anthropic` passes straight through and which needs no beta
 *   header — extended TTL is generally available.
 */
function anthropicCacheControl(ttl: PromptCacheTtl | undefined): {
  anthropic: { cacheControl: { type: "ephemeral"; ttl?: "1h" } };
} {
  return {
    anthropic: { cacheControl: { type: "ephemeral", ...(ttl === "1h" ? { ttl } : {}) } },
  };
}

/**
 * The AI SDK's standardized, cross-provider reasoning-effort call setting — a
 * top-level `generateText`/`streamText` option (a sibling of `providerOptions`,
 * not nested under it). Anthropic and Google each translate it per-model: e.g.
 * Anthropic dispatches to its native `effort` field on models that support it
 * and to a manual `thinking` budget on older ones, entirely inside the
 * `@ai-sdk/anthropic`/`@ai-sdk/google` adapters, so Clarvis never needs its own
 * per-model capability table. It has no `"max"` slot — that Anthropic-only
 * ceiling tier is set directly via `providerOptions.anthropic.effort` instead.
 */
type StandardReasoning = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Which of the four mutually exclusive routes a call's reasoning effort took.
 *
 * @remarks Worth reporting because the four are silent about each other: an
 *   effort set on a provider whose branch does not run reaches the wire as
 *   nothing at all, and the request that results is indistinguishable from one
 *   that asked for no reasoning.
 */
type ReasoningPath = "standard" | "openai" | "compatible" | "anthropic_max";

/**
 * What {@link buildCallTuning} decided, for the adapter to log.
 *
 * @remarks Every member is a value the function already computed. Nothing here
 *   re-derives anything, and nothing here is model-authored.
 */
export interface RequestTuningDiagnostics {
  reasoning?: StandardReasoning;
  reasoning_path?: ReasoningPath;
  max_output_tokens?: number;
  thinking_floor?: number;
}

/**
 * What {@link buildRequestOptions} did about prompt caching, as indices and
 * counts.
 *
 * @remarks The single highest-value thing this package can say: a cache
 *   breakpoint that silently fails to land costs the full uncached prefix on
 *   every subsequent request, and nothing else in the stack can see it happen.
 *
 *   Built exclusively from values the marking pass already produced. It must
 *   never re-walk or re-mark the message array — the marking is index- and
 *   identity-sensitive, and a second pass over it is the shape of the defect
 *   `20a7a21` fixed. It carries counts and indices, never content.
 */
export interface RequestCacheDiagnostics {
  kind?: string;
  mode?: string;
  marked: "anthropic" | "compatible" | "none";
  requested_breakpoints: number;
  applied_breakpoints: number;
  walked_back: boolean;
  system_marked: boolean;
  cache_key_sent: boolean;
  /**
   * Whether this request pinned a backend by session, i.e. carried both the
   * `session_id` body field and the `x-session-id` header.
   *
   * @remarks Separate from {@link cache_key_sent} because the two answer
   *   different questions and can disagree: native OpenAI takes the cache key
   *   and not the session pin.
   */
  session_pinned: boolean;
  ttl?: PromptCacheTtl;
}

/** Everything {@link buildRequestOptions} observed while assembling a request. */
export interface RequestDiagnostics {
  cache: RequestCacheDiagnostics;
  tuning: RequestTuningDiagnostics;
}

/**
 * Translates the call's reasoning/caching knobs into a standardized `reasoning`
 * setting, per-provider `providerOptions`, and an effective `maxOutputTokens`.
 *
 * @param params - the call params carrying `reasoningSummary`/`reasoningEffort`/
 *   `maxOutputTokens`/`promptCacheKey` and the resolved provider `kind`.
 * @returns the standardized reasoning setting, provider-namespaced options, and
 *   output cap, each omitted when empty.
 * @remarks Reasoning effort maps per family: OpenAI/openai-compatible take a
 *   native `reasoningEffort` provider option directly (`"off"` becomes
 *   `"none"`, and both accept `"xhigh"`/`"max"` as plain strings). Anthropic and
 *   Google instead take the {@link StandardReasoning} top-level setting
 *   (`"off"` → `"none"`; Google's `"max"` clamps to `"xhigh"`, its own ceiling).
 *   Anthropic's `"max"` has no standardized slot, so it bypasses the
 *   standardized field entirely and sets `providerOptions.anthropic.effort`
 *   directly — the AI SDK gives an explicit `effort` provider option precedence
 *   over its own standardized-field translation, so the two never conflict.
 *   Any non-`"off"` Anthropic effort also floors the output cap (see
 *   {@link reasoningOutputFloor}) so the answer has room past thinking — this
 *   floor is applied here *and*, window-aware, by the loop's
 *   `clampOutputBudget` before the call ever reaches this function, so a
 *   near-full context window degrades the budget rather than exceeding it.
 *   Both OpenAI families forward a `prompt_cache_key`: native OpenAI as the
 *   camelCase `promptCacheKey` provider option, which `@ai-sdk/openai`
 *   serializes onto the Responses body, and openai-compatible as a snake_case
 *   passthrough alongside its usage request. Anthropic and Google have no
 *   equivalent knob — they key their caches on the prompt prefix — so the field
 *   is deliberately not forwarded there.
 *
 *   openai-compatible additionally sends the same value as `session_id`, and
 *   {@link buildRequestOptions} sends it again as an `x-session-id` header.
 *   They are not redundant: on OpenRouter `session_id` is the **primary**
 *   backend-affinity key and `prompt_cache_key` only a fallback, and the two
 *   engage at different moments — `session_id` pins a backend on any successful
 *   request, `prompt_cache_key` only once a hit has already been observed. That
 *   gap is measurable. A live append-only probe against `deepseek-v4-pro` with
 *   a byte-identical prefix and a fixed `prompt_cache_key` read 0 cached on
 *   turn 3 between a 99.6% hit and a run of ~96% hits: affinity had not yet
 *   taken hold. The value is the run's cache key because that is already
 *   session-scoped rather than run-scoped, so a continuation keeps the
 *   affinity its parent established.
 *
 *   It is scoped to this kind rather than sent everywhere: Anthropic and Google
 *   would reject it, and native OpenAI already has `promptCacheKey`. An
 *   endpoint that refuses unknown body fields can drop it through the
 *   provider's `body` escape hatch.
 */
function buildCallTuning(params: LLMCallParams): {
  tuning: {
    reasoning?: StandardReasoning;
    providerOptions?: Record<string, Record<string, JSONValue>>;
    maxOutputTokens?: number;
  };
  diagnostics: RequestTuningDiagnostics;
} {
  const kind = params.providerConfig?.kind;
  const opts: Record<string, Record<string, JSONValue>> = {};
  let reasoning: StandardReasoning | undefined;
  let thinkingFloor: number | undefined;
  let reasoningPath: ReasoningPath | undefined;

  if (kind === "openai-codex" || kind === "xai-grok") {
    opts.openai = { store: false, forceReasoning: true };
  }

  if (
    (kind === "openai" || kind === "openai-codex" || kind === "xai-grok") &&
    params.reasoningSummary &&
    params.reasoningSummary !== "off"
  ) {
    opts.openai = { ...opts.openai, reasoningSummary: params.reasoningSummary };
  }

  const effort = params.reasoningEffort;
  if (effort !== undefined) {
    if (kind === "openai" || kind === "openai-codex" || kind === "xai-grok") {
      opts.openai = { ...opts.openai, reasoningEffort: effort === "off" ? "none" : effort };
      reasoningPath = "openai";
    } else if (kind === "openai-compatible") {
      opts.openaiCompatible = { reasoningEffort: effort === "off" ? "none" : effort };
      reasoningPath = "compatible";
    } else if (kind === "anthropic") {
      if (effort === "max") {
        opts.anthropic = { ...opts.anthropic, effort: "max" };
        reasoningPath = "anthropic_max";
      } else {
        reasoning = effort === "off" ? "none" : effort;
        reasoningPath = "standard";
      }
      thinkingFloor = reasoningOutputFloor(kind, effort);
    } else if (kind === "google") {
      reasoning = effort === "off" ? "none" : effort === "max" ? "xhigh" : effort;
      reasoningPath = "standard";
    }
  }

  if (kind === "openai-compatible") {
    opts.openaiCompatible = {
      ...opts.openaiCompatible,
      usage: { include: true },
      ...(params.promptCacheKey !== undefined
        ? { prompt_cache_key: params.promptCacheKey, session_id: params.promptCacheKey }
        : {}),
    };
  }

  if ((kind === "openai" || kind === "openai-codex") && params.promptCacheKey !== undefined) {
    opts.openai = { ...opts.openai, promptCacheKey: params.promptCacheKey };
  }

  const configured = params.maxOutputTokens;
  const maxOutputTokens =
    configured !== undefined && thinkingFloor !== undefined
      ? Math.max(configured, thinkingFloor)
      : (configured ?? thinkingFloor);

  return {
    tuning: {
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(Object.keys(opts).length > 0 ? { providerOptions: opts } : {}),
      ...(maxOutputTokens !== undefined && kind !== "openai-codex" ? { maxOutputTokens } : {}),
    },
    diagnostics: {
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(reasoningPath !== undefined ? { reasoning_path: reasoningPath } : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(thinkingFloor !== undefined ? { thinking_floor: thinkingFloor } : {}),
    },
  };
}

/**
 * How many message-level cache breakpoints a request may carry.
 *
 * @remarks Anthropic allows four `cache_control` blocks per request. This
 *   adapter spends at most three of them: one on the system block whenever it
 *   marks at all, plus these two. The fourth is deliberately left unspent — the
 *   ceiling is a request-level hard limit, so overshooting it is an error rather
 *   than a degradation, and this adapter is not the only layer that can add a
 *   marker to the request it builds.
 *
 *   Two rather than one because the useful breakpoints are the end of the stable
 *   head and the end of the current turn; two rather than three because the
 *   third would have to come out of that reserve, and because a breakpoint only
 *   pays for itself where a prefix is genuinely re-read — see
 *   `specs/cross-cutting/prompt-cache.md`.
 */
const MAX_MESSAGE_CACHE_BREAKPOINTS = 2;

/**
 * Resolve which message indices should carry a cache breakpoint.
 *
 * @param messages - the request's messages, before the system split.
 * @param requested - caller-supplied indices, or `undefined` to roll the single
 *   breakpoint onto the last non-system message.
 * @returns up to {@link MAX_MESSAGE_CACHE_BREAKPOINTS} ascending indices, with
 *   out-of-range, duplicate, and system-role entries discarded; a system-role
 *   index is dropped rather than consuming a slot, because the system content is
 *   lifted out of the message array and a marker left there would vanish.
 */
function cacheBreakpointTargets(
  messages: ModelMessage[],
  requested: readonly number[] | undefined,
): number[] {
  const usable = (i: number): boolean =>
    Number.isInteger(i) && i >= 0 && i < messages.length && messages[i]!.role !== "system";
  if (requested === undefined) {
    for (let i = messages.length - 1; i >= 0; i -= 1) if (usable(i)) return [i];
    return [];
  }
  const kept = [...new Set(requested.filter(usable))].sort((a, b) => a - b);
  return kept.slice(-MAX_MESSAGE_CACHE_BREAKPOINTS);
}

/**
 * Mark the chosen messages with Anthropic's ephemeral cache-control so the
 * prompt prefixes up to them are cached.
 *
 * @param messages - the request's messages, before the system split.
 * @param requested - see {@link cacheBreakpointTargets}.
 * @param ttl - how long each written prefix should survive.
 * @returns the messages, with the selected ones cloned and marked; the original
 *   list is returned unchanged when nothing is markable.
 * @remarks Must run before the system split so the indices still address the
 *   caller's own message array; the split preserves object identity, so the
 *   markers survive it.
 */
function withCacheBreakpoints(
  messages: ModelMessage[],
  requested: readonly number[] | undefined,
  ttl: PromptCacheTtl | undefined,
): { messages: ModelMessage[]; applied: number } {
  const targets = new Set(cacheBreakpointTargets(messages, requested));
  if (targets.size === 0) return { messages, applied: 0 };
  const marker = anthropicCacheControl(ttl);
  return {
    messages: messages.map((m, i) =>
      targets.has(i) ? { ...m, providerOptions: { ...m.providerOptions, ...marker } } : m,
    ),
    applied: targets.size,
  };
}

/**
 * Where `@ai-sdk/openai-compatible` reads a message's provider metadata from,
 * which decides where a marker has to be attached to survive serialisation.
 *
 * @remarks Three answers, and getting this wrong is silent in both directions —
 *   a marker on the shape the SDK ignores is simply never sent, and one on a
 *   shape it copies *verbatim into a content block* reaches the wire as an
 *   unknown field. Read off `convertToOpenAICompatibleChatMessages`:
 *
 *   - `"message"` — a system turn, a multi-part user turn, or an assistant turn:
 *     the message's own `providerOptions` are spread onto the wire message.
 *   - `"only-part"` — a user turn carrying exactly one text part: the SDK takes
 *     the shortcut `content: content[0].text, ...getOpenAIMetadata(content[0])`
 *     and **drops** the message's own options. It is the only site that reads a
 *     part instead of the message, and only for that one shape — a plain string
 *     included, since the SDK normalises it to exactly that before serialising.
 *     Assistant and system turns always have their own options spread, so
 *     marking a part of one would be dropped.
 *   - `"none"` — nothing here can carry a boundary.
 *
 *   Two shapes answer `"none"`. An assistant turn holding only tool calls has
 *   no text to put a boundary on. And **every tool turn**, which is excluded on
 *   its wire *shape* rather than on where its metadata is read: the SDK emits
 *   one wire message per result part with `content` as a plain string, so a
 *   marker there would make {@link applyCacheControlMarkers} rewrite that string
 *   into a content-part array — a schema change unrelated to caching, on the one
 *   role whose `content` several OpenAI-compatible gateways accept only as a
 *   string. Since the mode is derived from the catalog rather than opted into,
 *   the resulting 400 would arrive unasked and read as unrelated to the cache.
 *   {@link withOpenAICompatibleCacheMarkers} walks back to the newest markable
 *   message instead, so the breakpoint moves earlier rather than being lost —
 *   and a tool turn is a frequent `stable`, so this is the common path, not an
 *   edge case.
 *
 *   **An assistant turn carrying `tool-call` parts is excluded for the same
 *   reason, even when it also has text.** It would answer `"message"` on the
 *   text alone, and the promotion would put it on the wire as
 *   `content: [ … ], tool_calls: [ … ]` — a shape a gateway strict enough to
 *   reject an array on a tool turn has no reason to accept here either. Prose
 *   plus tool calls in one turn is ordinary in an agent loop, so leaving it in
 *   would have reopened the hazard the line above closes, one message earlier.
 */
type MarkerSite = "message" | "only-part" | "none";

function markerSiteOf(m: ModelMessage): MarkerSite {
  if (m.role === "tool") return "none";
  if (
    m.role === "assistant" &&
    Array.isArray(m.content) &&
    (m.content as { type: string }[]).some((p) => p.type === "tool-call")
  )
    return "none";
  const hasText =
    typeof m.content === "string"
      ? m.content.length > 0
      : Array.isArray(m.content) &&
        (m.content as { type: string }[]).some((p) => p.type === "text");
  if (!hasText) return "none";
  if (m.role !== "user") return "message";
  return typeof m.content === "string" || (m.content as unknown[]).length === 1
    ? "only-part"
    : "message";
}

/**
 * Marks the messages an explicitly-cached OpenAI-compatible model should carry a
 * `cache_control` block on.
 *
 * @param messages - the request's messages, before the system split.
 * @param requested - the caller's breakpoint indices. `undefined` marks
 *   **nothing**: it means the caller has no reuse in mind, and on a provider
 *   that bills to create an entry a marker there is a pure surcharge for a
 *   prefix no later request can match. The compaction summarizer and the guard
 *   judge are exactly that shape.
 * @returns the messages, with the selected ones cloned and marked; the original
 *   list is returned unchanged when nothing is markable.
 * @remarks Marks up to {@link MAX_MESSAGE_CACHE_BREAKPOINTS}, the same budget as
 *   the Anthropic path, and for the same reason. The older breakpoint is what
 *   keeps a *readable* entry alive: a marked message serialises its `content` as
 *   a block array and an unmarked one as a plain string, so if only the newest
 *   were marked, last iteration's boundary would revert to a string and the
 *   entry written at it could never be matched again — every iteration paying
 *   the creation premium for a hit rate of zero. Keeping the previous
 *   breakpoint marked keeps that prefix byte-identical.
 *
 *   A requested index that cannot carry a marker (see {@link markerSiteOf})
 *   walks back to the newest one that can, rather than being dropped — an
 *   assistant turn holding only tool calls and a tool turn are both common, and
 *   skipping either silently would cost the whole tool exchange.
 *
 *   The walk-back is resolved **newest first and skips an index another target
 *   already claimed**, which is what keeps the two breakpoints two. Both
 *   requested indices routinely walk back to the *same* message — `stable` on a
 *   tool turn and `prior` on the assistant turn before it is an ordinary
 *   iteration — and collapsing them would leave a single marker, which is
 *   exactly the state this function's budget exists to avoid: last iteration's
 *   boundary reverts to a plain string and every iteration pays the creation
 *   premium for a hit rate of zero. Newest first, because the newer boundary is
 *   the one worth putting closest to where it was asked for.
 *
 *   The system block is marked separately by the caller and is free: it is
 *   always the first message, its content is stable for a run, and it never
 *   moves.
 */
function withOpenAICompatibleCacheMarkers(
  messages: ModelMessage[],
  requested: readonly number[] | undefined,
): { messages: ModelMessage[]; applied: number; walkedBack: boolean } {
  if (requested === undefined) return { messages, applied: 0, walkedBack: false };
  const targets = new Set<number>();
  let walkedBack = false;
  const markable = (i: number): number => {
    for (let j = i; j >= 0; j -= 1) {
      if (targets.has(j)) continue;
      if (messages[j]!.role !== "system" && markerSiteOf(messages[j]!) !== "none") return j;
    }
    return -1;
  };
  for (const requestedIndex of [...cacheBreakpointTargets(messages, requested)].reverse()) {
    const at = markable(requestedIndex);
    if (at >= 0) targets.add(at);
    if (at !== requestedIndex) walkedBack = true;
  }
  if (targets.size === 0) return { messages, applied: 0, walkedBack };
  const marker = cacheMarkerOptions();
  return {
    messages: messages.map((m, i) => (targets.has(i) ? markMessage(m, marker) : m)),
    applied: targets.size,
    walkedBack,
  };
}

/**
 * Attaches a provider-options fragment wherever the SDK will actually read it.
 *
 * @remarks Attaches to exactly one site, chosen by {@link markerSiteOf} — never
 *   belt-and-braces to several. A second copy is not harmless: the SDK writes a
 *   part's options *into the content block it emits*, so a marker left on a part
 *   of a multi-part message reaches the wire as an unknown field inside that
 *   block, where `applyCacheControlMarkers` (which rewrites the block it chose,
 *   not the one the marker sits on) would not remove it.
 *
 *   String content is promoted to a single text part on the `"only-part"` path
 *   because the SDK would otherwise normalise it to exactly that shape *after*
 *   the marker was attached and then take the metadata-dropping shortcut.
 *   Promotion is byte-identical on the wire apart from the marker, and only a
 *   marked message is ever touched, so no unmarked message's serialisation moves.
 *
 *   Goes through `unknown` because the edit is structural and `ModelMessage` is
 *   a discriminated union whose four `content` shapes cannot be mapped
 *   generically — every part type carries `providerOptions`, but no single
 *   signature expresses "the same union, with one part's options widened". The
 *   output shape is the input shape; only that field changes.
 */
function markMessage(m: ModelMessage, marker: Record<string, unknown>): ModelMessage {
  const site = markerSiteOf(m);
  if (site === "none") return m;
  const marked: Record<string, unknown> = { ...m };
  if (site === "message") {
    marked.providerOptions = { ...m.providerOptions, ...marker };
    return marked as unknown as ModelMessage;
  }
  marked.content = Array.isArray(m.content)
    ? (m.content as { providerOptions?: Record<string, unknown> }[]).map((p) => ({
        ...p,
        providerOptions: { ...p.providerOptions, ...marker },
      }))
    : [{ type: "text", text: m.content, providerOptions: { ...marker } }];
  return marked as unknown as ModelMessage;
}

/**
 * Separates system messages from the rest, joining all system content with blank
 * lines into a single `system` string (omitted when there are no system
 * messages) — the shape the AI SDK expects for a top-level system prompt.
 */
function splitSystemMessages(messages: ModelMessage[]): {
  system?: string;
  rest: ModelMessage[];
} {
  const systemParts: string[] = [];
  const rest: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else rest.push(m);
  }
  return systemParts.length > 0 ? { system: systemParts.join("\n\n"), rest } : { rest };
}

/**
 * Builds the AI SDK {@link ToolSet} keyed by each tool's `wireName`, using its
 * `inputSchema` as the JSON-schema input and a synthesized description fallback;
 * returns `undefined` when there are no tools so the call omits the field.
 */
function toAiSdkTools(tools: NamespacedTool[]): ToolSet | undefined {
  if (tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.wireName] = tool({
      description: t.description ?? `Tool ${t.fullName}`,
      inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
    });
  }
  return set;
}

/**
 * Maps our {@link ToolChoice} onto the AI SDK's tool-choice shape, translating a
 * forced function call into `{ type: "tool", toolName }`.
 */
function toAiSdkToolChoice(tc: ToolChoice): AiToolChoice<ToolSet> {
  if (tc === "auto") return "auto";
  if (tc === "required") return "required";
  return { type: "tool", toolName: tc.function.name };
}
/**
 * Assembles the AI SDK call options for one model call, and reports what it
 * decided.
 *
 * @param params - the call inputs.
 * @param modelMessages - the already-converted messages.
 * @returns `request`, spread straight onto the SDK call, and `diagnostics`,
 *   which the adapter logs and never forwards to a provider.
 * @remarks The diagnostics are a return value rather than a logger parameter so
 *   this module stays free of a sink and every field stays provably a value the
 *   assembly already produced. `request` and `diagnostics` are separate keys for
 *   a blunter reason: spreading one object onto the SDK call would put a
 *   `diagnostics` field on the wire.
 */
export function buildRequestOptions(
  params: LLMCallParams,
  modelMessages: ModelMessage[],
): {
  request: {
    system?: string | SystemModelMessage[];
    /** Per-call headers merged over the provider's constructed ones. */
    headers?: Record<string, string>;
    messages: ModelMessage[];
    tools?: ToolSet;
    toolChoice?: AiToolChoice<ToolSet>;
    reasoning?: StandardReasoning;
    providerOptions?: Record<string, Record<string, JSONValue>>;
    maxOutputTokens?: number;
  };
  diagnostics: RequestDiagnostics;
} {
  const tools = toAiSdkTools(params.tools);
  const tuning = buildCallTuning(params);
  const kind = params.providerConfig?.kind;
  const mode = params.providerConfig?.promptCache;
  const markAnthropic = kind === "anthropic" && mode !== "off";
  const markCompatible =
    kind === "openai-compatible" && mode === "explicit" && params.cacheBreakpoints !== undefined;

  const anthropicMarked = markAnthropic
    ? withCacheBreakpoints(modelMessages, params.cacheBreakpoints, params.promptCacheTtl)
    : undefined;
  const compatibleMarked =
    anthropicMarked === undefined && markCompatible
      ? withOpenAICompatibleCacheMarkers(modelMessages, params.cacheBreakpoints)
      : undefined;
  const split = splitSystemMessages(
    anthropicMarked?.messages ?? compatibleMarked?.messages ?? modelMessages,
  );
  const systemMarked = split.system !== undefined && (markAnthropic || markCompatible);
  const system: string | SystemModelMessage[] | undefined =
    split.system === undefined
      ? undefined
      : markAnthropic
        ? [
            {
              role: "system",
              content: split.system,
              providerOptions: anthropicCacheControl(params.promptCacheTtl),
            },
          ]
        : markCompatible
          ? [{ role: "system", content: split.system, providerOptions: cacheMarkerOptions() }]
          : split.system;
  const sessionHeaders =
    kind === "openai-compatible" && params.promptCacheKey !== undefined
      ? { "x-session-id": params.promptCacheKey }
      : undefined;
  const cache: RequestCacheDiagnostics = {
    ...(kind !== undefined ? { kind } : {}),
    ...(mode !== undefined ? { mode } : {}),
    marked: anthropicMarked !== undefined ? "anthropic" : markCompatible ? "compatible" : "none",
    requested_breakpoints: params.cacheBreakpoints?.length ?? 0,
    applied_breakpoints: anthropicMarked?.applied ?? compatibleMarked?.applied ?? 0,
    walked_back: compatibleMarked?.walkedBack ?? false,
    system_marked: systemMarked,
    cache_key_sent:
      params.promptCacheKey !== undefined &&
      (kind === "openai" || kind === "openai-codex" || kind === "openai-compatible"),
    session_pinned: sessionHeaders !== undefined,
    ...(params.promptCacheTtl !== undefined ? { ttl: params.promptCacheTtl } : {}),
  };
  return {
    request: {
      ...(system !== undefined ? { system } : {}),
      ...(sessionHeaders !== undefined ? { headers: sessionHeaders } : {}),
      messages: split.rest,
      ...(tools !== undefined ? { tools } : {}),
      ...(tools !== undefined && params.toolChoice !== undefined
        ? { toolChoice: toAiSdkToolChoice(params.toolChoice) }
        : {}),
      ...tuning.tuning,
    },
    diagnostics: { cache, tuning: tuning.diagnostics },
  };
}
