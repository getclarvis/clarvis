import { RuntimeLaunchError } from "./types.ts";

const containerIdPattern = /^(?:sha256:)?([a-f0-9]{64})$/u;

/** Return an object record without accepting arrays or null. */
export function containerRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parse one engine inspect response and require its single-object envelope. */
export function parseContainerInspect(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new RuntimeLaunchError("operational_failure", `${label} returned invalid JSON`, {
      cause,
    });
  }
  const root = containerRecord(
    Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined,
  );
  if (root === undefined)
    throw new RuntimeLaunchError("operational_failure", `${label} returned an invalid envelope`);
  return root;
}

/** Canonical full engine object id, excluding its optional algorithm prefix. */
export function exactContainerId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return containerIdPattern.exec(value.toLowerCase())?.[1];
}

function capabilityName(value: unknown): string {
  return String(value).toLowerCase().replace(/^cap_/u, "");
}

const defaultLinuxCapabilities = new Set([
  "audit_write",
  "chown",
  "dac_override",
  "fowner",
  "fsetid",
  "kill",
  "mknod",
  "net_bind_service",
  "net_raw",
  "setfcap",
  "setgid",
  "setpcap",
  "setuid",
  "sys_chroot",
]);

/** Require either the engine's ALL sentinel or the complete default Linux capability set. */
function hasCompleteCapabilityDrop(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const dropped = new Set(value.map(capabilityName));
  return dropped.has("all") || [...defaultLinuxCapabilities].every((cap) => dropped.has(cap));
}

/** Compare effective additions exactly, tolerating the engine's null representation for none. */
function hasExactCapabilityAdditions(value: unknown, expected: readonly string[]): boolean {
  if (value === null) return expected.length === 0;
  if (!Array.isArray(value)) return false;
  const actual = value.map(capabilityName).sort();
  const wanted = expected.map(capabilityName).sort();
  return actual.length === wanted.length && actual.every((cap, index) => cap === wanted[index]);
}

/**
 * Require the declared drop/add policy or an engine's exact effective-capability projection.
 * Podman normalizes an added capability out of CapAdd and back into EffectiveCaps/BoundingCaps.
 */
export function hasExactEffectiveCapabilities(
  root: Record<string, unknown>,
  host: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const projectsEffective = root.EffectiveCaps !== undefined || root.BoundingCaps !== undefined;
  if (!projectsEffective)
    return (
      hasCompleteCapabilityDrop(host.CapDrop) && hasExactCapabilityAdditions(host.CapAdd, expected)
    );
  return (
    Array.isArray(host.CapDrop) &&
    host.CapDrop.length > 0 &&
    (hasExactCapabilityAdditions(host.CapAdd, expected) ||
      hasExactCapabilityAdditions(host.CapAdd, [])) &&
    hasExactCapabilityAdditions(root.EffectiveCaps, expected) &&
    hasExactCapabilityAdditions(root.BoundingCaps, expected)
  );
}

/** Accept only an explicitly enabled no-new-privileges security option. */
export function hasNoNewPrivileges(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    (value[0] === "no-new-privileges" ||
      value[0] === "no-new-privileges=true" ||
      value[0] === "no-new-privileges:true")
  );
}

/** Compare a tmpfs option string as an exact set, rejecting duplicates and implicit extras. */
export function hasExactTmpfsOptions(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "string") return false;
  const actual = value.split(",");
  const wanted = new Set(expected);
  return (
    actual.length === wanted.size &&
    new Set(actual).size === wanted.size &&
    actual.every((entry) => wanted.has(entry))
  );
}
