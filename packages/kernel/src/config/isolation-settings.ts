import { z } from "zod";
import type { CapabilitySettingsSpec } from "@clarvis/capability";

/** Operator-owned preference; an absent block selects the protected workspace profile. */
export const isolationSettingsSchema = z
  .object({
    mode: z.enum(["host", "sandbox"]).optional(),
    workspace: z.enum(["read-only", "read-write"]).optional(),
    network: z.enum(["enabled", "disabled"]).optional(),
    additional_write_roots: z.array(z.string()).optional(),
  })
  .strict();

export type IsolationSettings = z.input<typeof isolationSettingsSchema>;
export type ResolvedIsolationSettings = Required<
  Omit<IsolationSettings, "additional_write_roots">
> & {
  additional_write_roots: string[];
};

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
    mode: parsed.mode ?? "sandbox",
    workspace: parsed.workspace ?? "read-write",
    network: parsed.network ?? "disabled",
    additional_write_roots: parsed.additional_write_roots ?? [],
  };
}
