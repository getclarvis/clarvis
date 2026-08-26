import {
  envRefPattern,
  FORBIDDEN_PROVIDER_BODY_KEYS,
  parseModelRef,
  resolveProvider,
  ValidationError,
} from "@clarvis/capability";
import { isWellFormedHttpUrl } from "../../http-url.ts";
import type { ParsedRunRequest } from "./request-schema.ts";

function envRefsWellFormed(value: string): boolean {
  return !value.replace(envRefPattern(), "").includes("${");
}

function rejectProviderMapIssues(
  name: string,
  where: string | undefined,
  kind: string,
  headers: Record<string, string> | undefined,
  body: Record<string, unknown> | undefined,
  used: boolean,
): void {
  const at = where === undefined ? `Provider '${name}'` : `Provider '${name}' model '${where}'`;
  for (const [header, value] of Object.entries(headers ?? {})) {
    if (!envRefsWellFormed(value)) {
      throw new ValidationError(
        "invalid_provider_config",
        `${at} header '${header}' contains a malformed '\${...}' reference. A variable reference is \${NAME} with NAME matching [A-Za-z_][A-Za-z0-9_]*.`,
        { name, reason: "malformed_env_ref", header },
      );
    }
  }
  if (body === undefined) return;
  if (kind !== "openai-compatible" && used) {
    throw new ValidationError(
      "invalid_provider_config",
      `${at} sets 'body', which only kind 'openai-compatible' can send; the '${kind}' SDK exposes no request-body seam.`,
      { name, reason: "body_unsupported_kind", kind },
    );
  }
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_PROVIDER_BODY_KEYS.includes(key)) {
      throw new ValidationError(
        "invalid_provider_config",
        `${at} sets body['${key}'], which is not overridable: 'messages' and 'tools' ARE the cached prefix, and 'model'/'stream'/'tool_choice'/'stream_options' are resolved per call.`,
        { name, reason: "forbidden_body_key", key },
      );
    }
  }
}

/**
 * The provider tokens this run actually resolves a model against.
 *
 * @param data - the parsed request.
 * @returns the set of provider names some model reference in this run names.
 * @remarks Every profile's model, **and the guard judge's**. The judge is not a
 *   profile and never appears in `profiles`, yet it resolves through the very
 *   same registry, so a provider reached only by it would read as unused — and
 *   the one rule {@link rejectProviderMapIssues} applies only to a used provider
 *   is the refusal of a `body` the SDK cannot send. That is the silent drop the
 *   rule exists to make loud, on every judge call, with nothing said anywhere.
 *
 *   A judge with no `model` of its own falls back to the settings default, which
 *   the host has already written onto the entry profile by the time a request is
 *   assembled, so that case is covered by `profiles`.
 */
function referencedProviders(data: ParsedRunRequest): Set<string> {
  const tokens = data.profiles.map((p) => p.model);
  const judge = data.guard_judge?.model;
  if (judge !== undefined) tokens.push(judge);
  return new Set(tokens.map((t) => parseModelRef(t).provider));
}

/**
 * Validate the provider registry: unique names, well-formed `base_url`s, a
 * `base_url` present for every `openai-compatible` provider, and well-formed
 * `headers`/`body` at both the provider and the model level.
 *
 * @throws {@link ValidationError} (`duplicate_provider_name` or
 *   `invalid_provider_config`) on the first violation.
 */
export function rejectProviderConfigIssues(data: ParsedRunRequest): void {
  const registry = data.providers;
  if (registry.length === 0) return;
  const referenced = referencedProviders(data);
  const seenProviders = new Set<string>();
  for (const e of registry) {
    if (seenProviders.has(e.name)) {
      throw new ValidationError(
        "duplicate_provider_name",
        `Duplicate provider name '${e.name}' in providers[]`,
        { name: e.name },
      );
    }
    seenProviders.add(e.name);
    if (e.base_url !== undefined && !isWellFormedHttpUrl(e.base_url)) {
      throw new ValidationError(
        "invalid_provider_config",
        `Provider '${e.name}' has a 'base_url' that is not a well-formed http(s) URL.`,
        { name: e.name, reason: "malformed_base_url" },
      );
    }
    if (e.kind === "openai-compatible" && e.base_url === undefined) {
      throw new ValidationError(
        "invalid_provider_config",
        `Provider '${e.name}' (openai-compatible) requires 'base_url' to be set.`,
        { name: e.name, reason: "missing_base_url" },
      );
    }
    if (e.kind === "openai-codex" || e.kind === "xai-grok") {
      const incompatible = [
        e.base_url === undefined ? undefined : "base_url",
        e.api_key_env === undefined ? undefined : "api_key_env",
        e.headers === undefined ? undefined : "headers",
        e.body === undefined ? undefined : "body",
      ].filter((field): field is string => field !== undefined);
      for (const [modelId, model] of Object.entries(e.models ?? {})) {
        if (model.headers !== undefined) incompatible.push(`models.${modelId}.headers`);
        if (model.body !== undefined) incompatible.push(`models.${modelId}.body`);
      }
      if (incompatible.length > 0) {
        throw new ValidationError(
          "invalid_provider_config",
          `Provider '${e.name}' uses subscription billing and forbids ${incompatible.join(", ")}; credentials, endpoints, headers, and request bodies are kernel-owned.`,
          { name: e.name, reason: "subscription_field_forbidden", field: incompatible[0] },
        );
      }
    }
    const used = referenced.has(e.name);
    rejectProviderMapIssues(e.name, undefined, e.kind, e.headers, e.body, used);
    for (const [modelId, model] of Object.entries(e.models ?? {})) {
      rejectProviderMapIssues(e.name, modelId, e.kind, model.headers, model.body, used);
    }
  }
}

/**
 * Require every model provider token the request names to resolve against its
 * provider registry via {@link resolveProvider}.
 *
 * @throws {@link ValidationError} with the resolver's own code/message (e.g.
 *   `unknown_provider`) for the first unresolvable token.
 * @remarks Covers `vision_model` alongside every profile's `model`. It is not a
 *   profile, so nothing else would check it, and an unresolvable one would
 *   surface only as a silently skipped vision pass.
 */
export function requireResolvableModelProviders(data: ParsedRunRequest): void {
  const refs = data.profiles.map((p) => p.model);
  if (data.vision_model !== undefined) refs.push(data.vision_model);
  for (const ref of refs) {
    const token = parseModelRef(ref).provider;
    const resolution = resolveProvider(token, data.providers);
    if (!resolution.ok) {
      throw new ValidationError(resolution.code, resolution.message, { provider: token });
    }
  }
}

/**
 * Enforce per-profile semantic rules: `orchestration` is lead-only,
 * `reasoning_summary` is valid only for an `openai`-kind provider, and
 * `call_timeout_ms`/`retry.*` stay within their env ceilings.
 *
 * @param env - the resolved {@link EnvConfig} holding the relevant ceilings.
 * @throws {@link ValidationError} (`invalid_profile`) on the first violation.
 */
