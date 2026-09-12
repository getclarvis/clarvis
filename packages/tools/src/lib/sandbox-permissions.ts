import { ToolError } from "../errors.ts";
import type { RuntimeConfig } from "../config.ts";

/** Per-call sandbox posture advertised on `shell` and `monitor_start`. */
export type SandboxPermissions = "use_default" | "require_escalated";

/** Shared JSON Schema properties for per-call sandbox escalation. */
export const SANDBOX_PERMISSION_PROPERTIES = {
  sandbox_permissions: {
    type: "string",
    enum: ["use_default", "require_escalated"],
    description:
      'Omitted or "use_default" follows Isolation. "require_escalated" runs this one command on the host after review when Isolation is Sandbox. Isolated container runs reject it.',
  },
  justification: {
    type: "string",
    minLength: 1,
    maxLength: 4096,
    description: "Required with require_escalated. Short reason shown to the operator.",
  },
} as const;

/** JSON Schema `if`/`then` making `justification` required with `require_escalated`. */
export const SANDBOX_PERMISSION_CONDITION = {
  if: {
    properties: { sandbox_permissions: { const: "require_escalated" } },
    required: ["sandbox_permissions"],
  },
  then: { required: ["justification"] },
} as const;

/**
 * Resolve whether this call should spawn bare on the host.
 *
 * @throws {@link ToolError} `invalid_input` when escalation is requested without a
 *   justification, or `denied` when this process cannot leave an isolated runtime.
 */
export function resolveSandboxEscalation(
  args: Record<string, unknown>,
  config: RuntimeConfig,
): { forceBare: boolean } {
  if (args.sandbox_permissions !== "require_escalated") return { forceBare: false };
  const justification = args.justification;
  if (typeof justification !== "string" || justification.trim().length === 0) {
    throw new ToolError(
      "invalid_input",
      "justification is required when sandbox_permissions is require_escalated",
    );
  }
  if (config.allowHostEscalation === false) {
    throw new ToolError("denied", "Isolated container runs cannot reach the host this way");
  }
  return { forceBare: config.sandbox !== undefined };
}
