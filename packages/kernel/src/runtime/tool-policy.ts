/** Non-secret host policy that bounds the guest's shared coding-tool capability. */
export interface RuntimeToolPolicy {
  readonly enabled: boolean;
  readonly confine: boolean;
  readonly maxGrant: "none" | "read" | "edit" | "exec";
}

/** Reject missing or widened policy instead of defaulting an older guest envelope to exec. */
export function validRuntimeToolPolicy(value: unknown): value is RuntimeToolPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    Object.keys(policy).length === 3 &&
    typeof policy.enabled === "boolean" &&
    typeof policy.confine === "boolean" &&
    ["none", "read", "edit", "exec"].includes(policy.maxGrant as string)
  );
}
