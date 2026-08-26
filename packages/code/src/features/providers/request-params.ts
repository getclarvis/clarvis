/**
 * What the Providers panel offers, and refuses, while a provider's or a model's
 * `headers` and `body` are being authored.
 *
 * @remarks Both maps reach the wire untouched — `headers` after `${VAR}`
 * substitution, `body` overlaid onto the assembled request body — so the only
 * thing standing between a typo and a silent misroute is what this module
 * catches. Neither rule is in `kernelSettingsSchema`: a malformed `${TOKEN`
 * and a `body.messages` both save cleanly and fail only at request time, the
 * first reaching the provider verbatim while looking exactly like a resolved
 * value, the second dropped without a word by `applyBodyExtras`. The two rules
 * enter through Code's provider-request policy adapter rather than being
 * restated here, because a TUI rule narrower than the engine's would refuse
 * what works and one wider than it would promise what does not.
 *
 * The suggestions are a discovery aid, not a schema. Every provider's body
 * fields are its own, and a key absent from these lists is still typeable.
 */

import {
  hasMalformedEnvironmentReference,
  isReservedProviderBodyKey,
} from "../../adapters/provider-request-policy.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { MapSuggestion } from "../../ui/patterns/index.ts";
import type { ProviderKind } from "../../adapters/settings.ts";

/**
 * The header each SDK actually sends the credential in, which is the only one a
 * configured value **overrides**.
 *
 * @remarks Read off each provider factory: all four spread `options.headers`
 * last, so whichever name they authenticate with is the one an authored header
 * replaces. `Authorization` is that name for `openai` and `openai-compatible`
 * only — `anthropic` sends `x-api-key` and `google` sends `x-goog-api-key`, so
 * an `Authorization` offered there would override nothing, travel alongside the
 * real credential, and give the user no behaviour change and no diagnostic to
 * explain why.
 */
const AUTH_HEADER: Record<ProviderKind, string> = {
  "openai-compatible": "Authorization",
  openai: "Authorization",
  anthropic: "x-api-key",
  google: "x-goog-api-key",
  "openai-codex": "Authorization",
  "xai-grok": "Authorization",
};

/** The header names offered for every provider kind. */
const COMMON_HEADER_SUGGESTIONS: readonly MapSuggestion[] = [
  { key: "HTTP-Referer", detail: "OpenRouter app attribution: your site URL" },
  { key: "X-Title", detail: "OpenRouter app attribution: your app name" },
  { key: "OpenAI-Organization", detail: "bills the call to a specific OpenAI org" },
  { key: "OpenAI-Project", detail: "bills the call to a specific OpenAI project" },
  { key: "anthropic-beta", detail: "opts a call into an Anthropic beta feature" },
];

/**
 * Header names worth offering for one provider kind, with what each is for.
 *
 * @param kind - the provider kind, which decides how the credential header is
 *   spelled; see {@link AUTH_HEADER}.
 * @returns the suggestions, credential header first.
 * @remarks The credential header is listed even though `api_key_env` already
 * produces one, because a configured value **overrides** the SDK's — which is
 * the point for a gateway that wants a different scheme, and a trap for anyone
 * who did not mean to.
 */
export function headerSuggestions(kind: ProviderKind): readonly MapSuggestion[] {
  return [
    {
      key: AUTH_HEADER[kind],
      detail: `overrides the credential api_key_env produces ${glyph("emDash")} write it as \${VAR}`,
    },
    ...COMMON_HEADER_SUGGESTIONS,
  ];
}

/** Top-level `body` keys, in the order the picker offers them. */
const BODY_ROOT_SUGGESTIONS: readonly MapSuggestion[] = [
  {
    key: "provider",
    detail: "OpenRouter upstream routing — order, allow_fallbacks, only/ignore",
    value: { order: [], allow_fallbacks: false },
  },
  { key: "models", detail: "OpenRouter fallback model list, tried in order", value: [] },
  { key: "route", detail: "OpenRouter routing strategy, e.g. 'fallback'", value: "fallback" },
  { key: "transforms", detail: "OpenRouter prompt transforms, e.g. middle-out", value: [] },
  { key: "reasoning", detail: "reasoning controls: effort, max_tokens, exclude", value: {} },
  { key: "usage", detail: "OpenRouter usage accounting", value: { include: true } },
  { key: "temperature", detail: "sampling temperature" },
  { key: "top_p", detail: "nucleus sampling cutoff" },
  { key: "top_k", detail: "top-k sampling cutoff" },
  { key: "min_p", detail: "minimum token probability, relative to the top token" },
  { key: "repetition_penalty", detail: "penalises tokens already in the context" },
  { key: "frequency_penalty", detail: "penalises tokens by how often they appeared" },
  { key: "presence_penalty", detail: "penalises tokens that appeared at all" },
  { key: "seed", detail: "requests deterministic sampling where the provider supports it" },
  { key: "logit_bias", detail: "per-token bias map", value: {} },
  { key: "service_tier", detail: "provider service tier, e.g. 'flex' / 'priority'" },
  { key: "user", detail: "opaque end-user id some providers use for abuse tracking" },
];

/** The keys of OpenRouter's `provider` routing block. */
const BODY_PROVIDER_SUGGESTIONS: readonly MapSuggestion[] = [
  { key: "order", detail: 'upstreams to try, in order, e.g. ["deepseek"]', value: [] },
  {
    key: "allow_fallbacks",
    detail: "false pins the request to `order` — the cache-affinity setting",
    value: false,
  },
  { key: "only", detail: "the only upstreams allowed to serve this request", value: [] },
  { key: "ignore", detail: "upstreams never allowed to serve this request", value: [] },
  {
    key: "require_parameters",
    detail: "skip upstreams that would drop a parameter you sent",
    value: true,
  },
  { key: "data_collection", detail: "'deny' skips upstreams that train on the request" },
  { key: "quantizations", detail: "acceptable weight quantizations", value: [] },
  { key: "sort", detail: "'price' | 'throughput' | 'latency' — orders the candidates" },
  { key: "max_price", detail: "per-million-token ceilings for prompt/completion", value: {} },
];

/** The keys of the `reasoning` block. */
const BODY_REASONING_SUGGESTIONS: readonly MapSuggestion[] = [
  { key: "effort", detail: "'low' | 'medium' | 'high'" },
  { key: "max_tokens", detail: "explicit thinking budget, where the provider takes one" },
  {
    key: "exclude",
    detail: "true asks the provider to think but not return the trace",
    value: true,
  },
  {
    key: "enabled",
    detail: "false turns reasoning off on a model that defaults to it",
    value: false,
  },
];

/**
 * The keys offered when adding to `body` at `path`.
 *
 * @param path - the keys drilled into below `body`; `[]` is its root.
 * @returns the suggestions for that level, empty where nothing is documented.
 * @remarks Path-aware because the parameters worth naming are nested: the two
 *   the routing problem actually turns on, `order` and `allow_fallbacks`, live
 *   inside `provider` and would be invisible from the root.
 */
export function bodySuggestions(path: readonly string[]): readonly MapSuggestion[] {
  if (path.length === 0) return BODY_ROOT_SUGGESTIONS;
  if (path.length === 1 && path[0] === "provider") return BODY_PROVIDER_SUGGESTIONS;
  if (path.length === 1 && path[0] === "reasoning") return BODY_REASONING_SUGGESTIONS;
  return [];
}

/**
 * Rejects a header name that is not a legal HTTP field name.
 *
 * @param key - the authored header name.
 * @returns the reason to show the user, or `undefined` when the name is usable.
 * @remarks Stricter than the settings schema, which asks only for a non-empty
 *   string. The schema is right to be lenient — it validates files this UI did
 *   not write — but a name carrying a space or a colon is a mistake at the
 *   moment it is typed, and no provider will ever accept it.
 */
export function headerKeyProblem(key: string): string | undefined {
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)
    ? undefined
    : `'${key}' is not a legal header name ${glyph("emDash")} letters, digits and -_. only`;
}

/**
 * Rejects a header value whose `${` is not a well-formed reference.
 *
 * @param value - the authored value.
 * @returns the reason to show the user, or `undefined` when the value is usable.
 * @remarks The same rule the run request is validated against, and the same
 *   reason: `Bearer ${TOKEN` reaches the provider exactly as typed, and a 401
 *   is the only symptom.
 */
export function headerValueProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "a header value must be text";
  return hasMalformedEnvironmentReference(value)
    ? `malformed \${...} reference ${glyph("emDash")} it would reach the provider verbatim`
    : undefined;
}

/**
 * Rejects a `body` key the request assembles for itself.
 *
 * @param key - the authored key.
 * @param path - where in `body` it is being added; only the root is guarded.
 * @returns the reason to show the user, or `undefined` when the key is usable.
 * @remarks Only the top level, because that is the only level `applyBodyExtras`
 *   overlays — a `provider.messages` is just a key called `messages` inside an
 *   object the provider owns.
 */
export function bodyKeyProblem(key: string, path: readonly string[]): string | undefined {
  if (path.length > 0) return undefined;
  return isReservedProviderBodyKey(key)
    ? `'${key}' is assembled per request ${glyph("emDash")} an override here is dropped`
    : undefined;
}

/**
 * The line shown under a `headers` map, naming where the values end up.
 *
 * @param scope - whose headers these are, for the sentence.
 * @returns the footnote text.
 */
export function headersFootnote(scope: "provider" | "model"): string {
  return (
    `sent on every ${scope === "model" ? "call to this model" : "call to this provider"} ` +
    `${glyph("separator")} \${VAR} resolves from the environment ${glyph("separator")} ` +
    `settings.json is committed, so never paste a key here`
  );
}

/**
 * The line shown under a `body` map, including the warning that earns its place.
 *
 * @param kind - the provider kind, which decides whether `body` is honoured at all.
 * @param path - where in `body` the user is standing.
 * @returns the footnote text.
 * @remarks A `body` on any kind but `openai-compatible` is refused when a run
 *   targets the provider — the other three SDKs expose no request-body seam —
 *   and the refusal happens at run time, far from the panel that accepted it.
 *   Saying so here is the only place the two are next to each other.
 */
export function bodyFootnote(kind: ProviderKind, path: readonly string[]): string {
  if (kind !== "openai-compatible")
    return (
      `${glyph("warning")} kind '${kind}' has no request-body seam ${glyph("separator")} ` +
      `a run targeting this provider is refused while body is set`
    );
  return path.length === 0
    ? `merged into every request body ${glyph("separator")} a model's key replaces the provider's whole value`
    : `inside '${path.join(".")}' ${glyph("separator")} this object is sent as the provider defines it`;
}
