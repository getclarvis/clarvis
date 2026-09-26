import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

export const approvalModeSchema = z.enum(["manual", "auto"]);

const granular = z
  .object({
    sandbox_approval: z.boolean(),
    rules: z.boolean(),
    skill_approval: z.boolean().optional(),
    request_permissions: z.boolean().optional(),
    mcp_elicitations: z.boolean(),
  })
  .strict();

export const approvalPolicySchema = z.union([
  z.enum(["on-request", "untrusted", "never"]),
  z.object({ granular }).strict(),
]);

export type ApprovalModeSetting = z.input<typeof approvalModeSchema>;
export type ApprovalPolicySetting = z.input<typeof approvalPolicySchema>;

export const approvalModeSettingsSpec: CapabilitySettingsSpec = {
  key: "approval_mode",
  schema: approvalModeSchema,
  merge: "lastWins",
  pluginContributable: false,
};

export const approvalPolicySettingsSpec: CapabilitySettingsSpec = {
  key: "approval_policy",
  schema: approvalPolicySchema,
  merge: "lastWins",
  pluginContributable: false,
};

/** Resolve the global operator preference. */
export function resolveApprovalMode(value: unknown): "manual" | "auto" {
  return approvalModeSchema.parse(value ?? "manual");
}
