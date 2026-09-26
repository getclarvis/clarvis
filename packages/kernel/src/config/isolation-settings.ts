import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

/** Operator-owned preference; an absent block keeps the existing Host behavior. */
export const isolationSettingsSchema = z
  .object({
    mode: z.enum(["host", "sandbox"]).optional(),
    workspace: z.enum(["read-only", "read-write"]).optional(),
    network: z.enum(["enabled", "disabled"]).optional(),
  })
  .strict();

export type IsolationSettings = z.input<typeof isolationSettingsSchema>;
export type ResolvedIsolationSettings = Required<IsolationSettings>;

export const isolationSettingsSpec: CapabilitySettingsSpec = {
  key: "isolation",
  schema: isolationSettingsSchema,
  merge: "lastWins",
  pluginContributable: false,
};

/** Resolve omitted fields without changing the stored Sandbox preferences. */
export function resolveIsolationSettings(value: unknown): ResolvedIsolationSettings {
  const parsed = isolationSettingsSchema.parse(value ?? {});
  return {
    mode: parsed.mode ?? "host",
    workspace: parsed.workspace ?? "read-write",
    network: parsed.network ?? "enabled",
  };
}
