import type { ModelConfig, ProviderConfig } from "./api.ts";
import type { ResolvedProviderConfig } from "./llm-port.ts";

/**
 * The result of resolving a provider token against the run's registry: either
 * the {@link ResolvedProviderConfig} on success, or an `"unknown_provider"`
 * failure with a human-readable `message`.
 */
export type ProviderResolution =
  | { ok: true; config: ResolvedProviderConfig }
  | { ok: false; code: "unknown_provider"; message: string };

/**
 * Request-body keys a provider's or model's `body` may never carry.
 *
 * @remarks Not paternalism — each one breaks something the caller cannot see.
 * `messages` and `tools` **are** the cached prefix a provider serialises, so
 * setting either destroys every cache hit in every run with no error and no
 * symptom other than the bill. `model` would route to a model whose
 * configuration was resolved for another. `stream` is decided by whether the
 * caller supplied a stream sink, and contradicting it desynchronises the delta
 * plumbing. `tool_choice` is resolved per call.
 *
 * **`stream_options` is deliberately absent**, though it sat here once. It is
 * not `stream`: it decides only whether the provider appends a usage chunk, and
 * contradicting it costs token accounting, never the delta plumbing. Meanwhile
 * Clarvis now *forces* `include_usage` on every OpenAI-compatible streaming
 * call, so an endpoint that rejects the field — a strict local llama.cpp or
 * vLLM front-end, an older Azure-compatible shim — would 400 on every streaming
 * request with no configuration path out, because the operator's one lever was
 * the very key this list blocked. An operator who overrides it loses usage
 * numbers, and with them budget accounting; that is a visible, chosen trade,
 * unlike an unusable endpoint.
 *
 * Enforced twice on purpose: a settings schema refuses them so the operator
 * sees a diagnostic, and the adapter strips them from the merged map so the
 * rule also holds for a host that constructs a {@link ResolvedProviderConfig}
 * directly, without any schema having run.
 */
export const FORBIDDEN_PROVIDER_BODY_KEYS: readonly string[] = [
  "messages",
  "tools",
  "model",
  "stream",
  "tool_choice",
];

/**
 * Overlays a model's map onto its provider's, replacing whole top-level values.
 *
 * @param base - the provider-level map, or `undefined`.
 * @param override - the model-level map, or `undefined`.
 * @returns the merged map, or `undefined` when neither side supplied one.
 * @remarks **Shallow, per top-level key**: an override's nested object
 *   *replaces* the base's rather than merging into it. A deep merge would make
 *   it impossible to remove a key the provider set — the model could only ever
 *   add to it — and the failure would be invisible in the file, since the
 *   surviving key looks exactly like one the author wrote.
 */
function mergeShallow<T>(
  base: Record<string, T> | undefined,
  override: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return { ...base, ...override };
}

/**
 * Resolves a provider token to its configuration by matching the run's
 * `providers` registry on `name`, optionally narrowed to one model.
 *
 * @param token - the provider token a model declares (must equal a
 *   `providers[].name`).
 * @param registry - the declared providers, or `undefined` when none are
 *   configured.
 * @param modelId - the model being resolved. When supplied, that model's
 *   `headers`, `body` and `prompt_cache` override the provider's, per top-level
 *   key; when omitted, only the provider's own are projected.
 * @returns a successful {@link ProviderResolution} carrying the projected
 *   {@link ResolvedProviderConfig}, or an `"unknown_provider"` failure when no
 *   entry matches.
 * @remarks `headers` are projected as authored — `${VAR}` templates, not
 *   resolved values. Substitution belongs to whoever builds the client, which
 *   is also the only layer holding a key lookup.
 */
export function resolveProvider(
  token: string,
  registry: ProviderConfig[] | undefined,
  modelId?: string,
): ProviderResolution {
  const entry = registry?.find((p) => p.name === token);
  if (entry) {
    const model: ModelConfig | undefined =
      modelId !== undefined ? entry.models?.[modelId] : undefined;
    const headers = mergeShallow(entry.headers, model?.headers);
    const body = mergeShallow(entry.body, model?.body);
    const promptCache = model?.prompt_cache;
    return {
      ok: true,
      config: {
        kind: entry.kind,
        ...(entry.base_url !== undefined ? { baseUrl: entry.base_url } : {}),
        ...(entry.api_key_env !== undefined ? { apiKeyEnv: entry.api_key_env } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(promptCache !== undefined ? { promptCache } : {}),
      },
    };
  }
  return {
    ok: false,
    code: "unknown_provider",
    message: `Provider '${token}' is not declared in 'providers'. Every model's provider token must match a providers[].name entry.`,
  };
}
