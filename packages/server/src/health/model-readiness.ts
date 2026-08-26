import { parseModelRef } from "@clarvis/capability";

/** Offline model readiness against the already-resolved kernel environment. */
export function isDefaultModelReady(
  merged: unknown,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (merged === null || typeof merged !== "object" || Array.isArray(merged)) return false;
  const settings = merged as Record<string, unknown>;
  if (typeof settings.default_model !== "string") return false;

  const ref = parseModelRef(settings.default_model);
  const providers = Array.isArray(settings.providers)
    ? (settings.providers as { name?: string; api_key_env?: string }[])
    : [];
  const provider = providers.find((candidate) => candidate.name === ref.provider);
  if (provider === undefined) return false;
  return provider.api_key_env === undefined || (environment[provider.api_key_env]?.length ?? 0) > 0;
}
