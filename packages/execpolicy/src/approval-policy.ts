/** The public request policy, independent of auto versus manual reviewer choice. */
export type ApprovalPolicy =
  | "on-request"
  | "untrusted"
  | "never"
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval?: boolean;
        request_permissions?: boolean;
        mcp_elicitations: boolean;
      };
    };

/** Request categories supported by the policy vocabulary. */
export type ApprovalCategory =
  "sandbox_approval" | "rules" | "skill_approval" | "request_permissions" | "mcp_elicitations";

/** Validate untrusted configuration without granting a request implicitly. */
export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (value === "on-request" || value === "untrusted" || value === "never") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("approval_policy must be a supported string or granular object");
  }
  const outer = value as Record<string, unknown>;
  if (
    Object.keys(outer).length !== 1 ||
    typeof outer.granular !== "object" ||
    outer.granular === null ||
    Array.isArray(outer.granular)
  ) {
    throw new Error("approval_policy granular object is invalid");
  }
  const fields = outer.granular as Record<string, unknown>;
  const required = ["sandbox_approval", "rules", "mcp_elicitations"];
  const optional = ["skill_approval", "request_permissions"];
  if (
    required.some((key) => typeof fields[key] !== "boolean") ||
    Object.keys(fields).some(
      (key) => ![...required, ...optional].includes(key) || typeof fields[key] !== "boolean",
    )
  ) {
    throw new Error("approval_policy granular fields are invalid");
  }
  return {
    granular: {
      sandbox_approval: fields.sandbox_approval as boolean,
      rules: fields.rules as boolean,
      skill_approval: (fields.skill_approval as boolean | undefined) ?? false,
      request_permissions: (fields.request_permissions as boolean | undefined) ?? false,
      mcp_elicitations: fields.mcp_elicitations as boolean,
    },
  };
}

/** Whether a category may open an approval flow; this never approves the action. */
export function canRequestApproval(policy: ApprovalPolicy, category: ApprovalCategory): boolean {
  if (policy === "never") return false;
  if (typeof policy === "string") return true;
  return policy.granular[category] ?? false;
}
