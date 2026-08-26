import { envRefPattern, FORBIDDEN_PROVIDER_BODY_KEYS } from "@clarvis/kernel/policy";

/** Whether a text value contains a `${...}` environment reference that cannot be resolved. */
export function hasMalformedEnvironmentReference(value: string): boolean {
  return value.replace(envRefPattern(), "").includes("${");
}

/** Whether a provider body key is owned by per-request assembly and cannot be overridden. */
export function isReservedProviderBodyKey(key: string): boolean {
  return FORBIDDEN_PROVIDER_BODY_KEYS.includes(key);
}
