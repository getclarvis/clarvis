/**
 * How an OpenAI-compatible request is shaped beyond what
 * `@ai-sdk/openai-compatible` decides on its own: the configured `headers`, the
 * standard streaming-usage opt-in, the operator's `body` extras, and the
 * `cache_control` markers an explicitly-cached model needs.
 *
 * @remarks Kept free of every `@ai-sdk/*` import for two reasons. The adapter's
 * own tests replace `generateText`/`streamText` with doubles, so the constructed
 * client's `transformRequestBody` never executes there and nothing in this file
 * would otherwise be reachable by a test at all. And `lazy-entry.test.ts` walks
 * the static import graph from `@clarvis/llm`'s main entry to prove a decorator
 * import does not drag four provider SDKs in with it; a module that touches only
 * plain objects can never break that.
 */

import {
  FORBIDDEN_PROVIDER_BODY_KEYS,
  ProviderError,
  resolveStringMapWith,
  MissingEnvVarsError,
  type ResolvedProviderConfig,
} from "@clarvis/capability";

/**
 * The marker key an adapter attaches to the messages that should carry a
 * `cache_control` block, and that {@link applyCacheControlMarkers} consumes.
 *
 * @remarks It travels inside `providerOptions.openaiCompatible`, which
 * `@ai-sdk/openai-compatible` spreads verbatim onto the serialised message —
 * the only channel that survives the SDK's own message conversion. Locating the
 * marked messages by *identity* rather than by index is what makes this correct:
 * the caller's array is reshaped three times before it becomes `body.messages`
 * (system messages are collapsed and lifted out, one is re-prepended, and a
 * tool-role message expands to one wire message per result part), so an index
 * map would silently mark the wrong message — no error, no symptom, a 0% hit
 * rate.
 *
 * Because it is not a field any provider knows, {@link applyCacheControlMarkers}
 * **must** delete it. Left in place it is an unknown top-level message field: a
 * 400 from a strict provider, silently ignored by a lax one.
 */
export const CACHE_MARKER_KEY = "__clarvis_cache_control";

/**
 * The provider-options fragment that marks one message for a cache breakpoint.
 *
 * @remarks Carries no TTL. Anthropic's native marker takes one and
 * `anthropicCacheControl` passes it through, but the OpenAI-compatible
 * endpoints that accept `cache_control` document a fixed lifetime that resets
 * on a hit, so there is nothing to send and inventing a field would be a guess
 * at another vendor's API.
 */
export function cacheMarkerOptions(): { openaiCompatible: Record<string, boolean> } {
  return { openaiCompatible: { [CACHE_MARKER_KEY]: true } };
}

/** A text block as an OpenAI-compatible `content` array carries it. */
interface TextBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
  [key: string]: unknown;
}

/**
 * Removes the sentinel from a content block, wherever it landed.
 *
 * @remarks The SDK copies a content part's `providerOptions` **into the block it
 *   emits**, so a marker attached at part level arrives here inside the block
 *   rather than on the message. {@link markMessage} only ever marks a part when
 *   that is the one site the SDK reads, but this sweep is unconditional on
 *   purpose: an unstripped sentinel is an unknown field inside a content block,
 *   which is a 400 from a strict endpoint and a silent no-op from a lax one —
 *   the two hardest outcomes to attribute.
 */
function stripBlockMarker(block: TextBlock): TextBlock {
  if (!(CACHE_MARKER_KEY in block)) return block;
  const { [CACHE_MARKER_KEY]: _marker, ...rest } = block;
  return rest;
}

/**
 * Rewrites every marked message's `content` into a block array carrying
 * `cache_control`, and strips the marker from the message and from every block.
 *
 * @param body - the assembled request body, mutated in place on a shallow copy.
 * @returns the body with markers applied and removed.
 * @remarks Three content shapes reach here. A plain string becomes a
 *   single-element text block. An existing block array has the marker attached
 *   to its **last** text block, because the cache boundary is the end of the
 *   message, not its start. A `null` content (an assistant turn carrying only
 *   `tool_calls`) has nowhere to put a marker, so the marker is dropped and
 *   nothing else changes — a message with no text cannot be a cache boundary.
 *
 *   A message is recognised as marked from **either** site: the sentinel on the
 *   message itself, or on any of its blocks, because the SDK spreads a part's
 *   options either onto the wire message or into the block it emits depending on
 *   the turn's shape.
 *
 *   A `role: "tool"` message, **and any message carrying `tool_calls`**, is
 *   stripped and otherwise left alone, never promoted. Its wire `content` is a plain string, and several
 *   OpenAI-compatible gateways accept only a string there, so rewriting it into
 *   a block array is a schema change unrelated to caching that reads as an
 *   unrelated 400. The adapter already refuses to mark a tool turn
 *   (`markerSiteOf`), nor an assistant turn holding tool calls; this is the
 *   second half of the same rule, for a host that builds its own markers with no
 *   adapter in the path — the same reasoning that makes {@link stripBlockMarker}'s
 *   sweep unconditional. An assistant turn is checked by its `tool_calls` field
 *   rather than its role, because that is what the wire shape actually is by the
 *   time this runs.
 */
export function applyCacheControlMarkers(body: Record<string, unknown>): Record<string, unknown> {
  const messages: unknown[] | undefined = Array.isArray(body.messages)
    ? (body.messages as unknown[])
    : undefined;
  if (messages === undefined) return body;
  let touched = false;
  const next = messages.map((raw): unknown => {
    if (typeof raw !== "object" || raw === null) return raw;
    const message = raw as Record<string, unknown>;
    const blocks = Array.isArray(message.content) ? (message.content as TextBlock[]) : undefined;
    const markedOnMessage = CACHE_MARKER_KEY in message;
    const markedOnBlock =
      blocks?.some((b) => typeof b === "object" && b !== null && CACHE_MARKER_KEY in b) ?? false;
    if (!markedOnMessage && !markedOnBlock) return message;
    touched = true;
    const { [CACHE_MARKER_KEY]: _marker, ...rest } = message;
    const content = rest.content;
    if (rest.role === "tool" || Array.isArray(rest.tool_calls)) {
      return Array.isArray(content)
        ? { ...rest, content: (content as TextBlock[]).map(stripBlockMarker) }
        : rest;
    }
    if (typeof content === "string") {
      return {
        ...rest,
        content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }],
      };
    }
    if (Array.isArray(content)) {
      const clean = (content as TextBlock[]).map(stripBlockMarker);
      const lastText = clean
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.type === "text")
        .pop();
      if (lastText === undefined) return { ...rest, content: clean };
      return {
        ...rest,
        content: clean.map((b, i) =>
          i === lastText.i ? { ...b, cache_control: { type: "ephemeral" } } : b,
        ),
      };
    }
    return rest;
  });
  return touched ? { ...body, messages: next } : body;
}

/**
 * Overlays the operator's `body` extras onto the assembled request body.
 *
 * @param body - the body `@ai-sdk/openai-compatible` assembled.
 * @param extras - the merged provider/model `body`, or `undefined`.
 * @returns the body with every permitted extra applied at the top level.
 * @remarks {@link FORBIDDEN_PROVIDER_BODY_KEYS} are dropped here as well as
 *   refused by the settings schema. The schema is what gives an operator a
 *   diagnostic; this is what makes the rule hold for a host that builds a
 *   {@link ResolvedProviderConfig} directly, with no schema in the path.
 *
 *   **A `null` value removes the key rather than sending `null`.** Without it
 *   the hatch could only ever add or replace, and several of the fields worth
 *   escaping are ones Clarvis itself puts in the body — `stream_options` above
 *   all, which is now unconditional. An endpoint that rejects a field outright
 *   needs it *gone*, and `null` is the only way JSON lets a settings file say
 *   so. The cost is that an API wanting a literal `null` cannot be given one
 *   through `body`; no endpoint Clarvis targets needs that, and an explicit
 *   `null` is far more often a typo than an intention.
 */
export function applyBodyExtras(
  body: Record<string, unknown>,
  extras: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (extras === undefined) return body;
  const out = { ...body };
  for (const [key, value] of Object.entries(extras)) {
    if (FORBIDDEN_PROVIDER_BODY_KEYS.includes(key)) continue;
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

/**
 * The settings object `createOpenAICompatible` is constructed with for one call.
 *
 * @param cfg - the resolved per-`(provider, model)` configuration.
 * @param headers - the already-resolved headers, or `undefined`. Taken resolved
 *   rather than re-resolved from `cfg.headers` because the caller has them
 *   in hand for every provider kind; resolving again would put a second lookup
 *   per environment variable on every model call, which for a host whose
 *   `resolveRegistryKey` reaches a vault or keychain is a second round-trip.
 * @param apiKey - the resolved API key, or `undefined`.
 * @returns the provider settings, including a `transformRequestBody` closure.
 * @throws {@link ProviderError} of kind `"client"` when `baseUrl` is missing.
 * @remarks `includeUsage: true` is unconditional and is a fix, not a knob: it is
 *   what makes `@ai-sdk/openai-compatible` send the **standard**
 *   `stream_options: { include_usage: true }`. Without it a streaming call
 *   reports usage only from OpenRouter's proprietary `usage: { include: true }`,
 *   so every other OpenAI-compatible provider was being asked for nothing.
 */
export function openAICompatibleSettings(
  cfg: ResolvedProviderConfig,
  headers: Record<string, string> | undefined,
  apiKey: string | undefined,
): {
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  includeUsage: true;
  transformRequestBody: (args: Record<string, unknown>) => Record<string, unknown>;
} {
  if (cfg.baseUrl === undefined) {
    throw new ProviderError("openai-compatible provider endpoint is not configured.", {
      kind: "client",
    });
  }
  const extras = cfg.body;
  return {
    name: "openai-compatible",
    baseURL: cfg.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(headers !== undefined ? { headers } : {}),
    includeUsage: true,
    transformRequestBody: (args) => applyCacheControlMarkers(applyBodyExtras(args, extras)),
  };
}

/**
 * Substitutes the `${VAR}` references in a configured header map.
 *
 * @param headers - the authored templates, or `undefined`.
 * @param lookup - resolves a variable name to its value.
 * @returns the resolved headers, or `undefined` when none were configured.
 * @throws {@link ProviderError} of kind `"client"` naming the unset variables.
 * @remarks The rethrow is the point. {@link MissingEnvVarsError} reaching the
 *   adapter's outer catch is classified as an unrecognised — hence transient —
 *   transport failure, so a misconfigured header would be retried on every call
 *   forever instead of failing once with a message that says what is unset.
 */
export function resolveConfiguredHeaders(
  headers: Record<string, string> | undefined,
  lookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  try {
    return resolveStringMapWith(headers, lookup);
  } catch (e) {
    if (e instanceof MissingEnvVarsError) {
      throw new ProviderError(
        `Configured provider headers reference unset environment variable(s): ${e.missing.join(", ")}.`,
        { kind: "client" },
      );
    }
    throw e;
  }
}
