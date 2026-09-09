import { isAbsolute } from "node:path";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { z } from "zod";

const limits = z
  .object({
    cpu_count: z.number().int().positive(),
    memory_bytes: z.number().int().positive(),
    process_count: z.number().int().positive(),
    output_bytes: z.number().int().positive(),
    storage_bytes: z.number().int().positive(),
  })
  .strict();

/** Product-owned resource defaults used by the simple Docker selector. */
export const DEFAULT_RUNTIME_LIMITS = {
  cpu_count: 2,
  memory_bytes: 4 * 1024 * 1024 * 1024,
  process_count: 256,
  output_bytes: 16 * 1024 * 1024,
  storage_bytes: 4 * 1024 * 1024 * 1024,
} as const;

const defaultedLimits = limits
  .partial()
  .default({})
  .transform((value) => ({
    ...DEFAULT_RUNTIME_LIMITS,
    ...value,
  }));

const runtimeRecipe = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
    script: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => isAbsolute(value) && !value.includes("\0")),
    network: z.enum(["none", "outbound"]).default("outbound"),
  })
  .strict();

/** Strict host-owned runtime selection persisted in settings.json. */
export const runtimeSettingsSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("native") }).strict(),
  z
    .object({
      backend: z.literal("docker"),
      image_digest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/u)
        .optional(),
      network: z.enum(["none", "internet", "outbound"]).default("outbound"),
      limits: defaultedLimits,
      executable: z.string().min(1).optional(),
      connection: z.string().min(1).optional(),
      fallback: z.enum(["sandbox", "fail"]).default("sandbox"),
      recipe: runtimeRecipe.optional(),
    })
    .strict(),
  z
    .object({
      backend: z.literal("podman"),
      image_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      network: z.enum(["none", "internet", "outbound"]).default("outbound"),
      limits,
      executable: z.string().min(1),
      connection: z.string().min(1),
    })
    .strict(),
]);

export type RuntimeSettingsInput = z.input<typeof runtimeSettingsSchema>;
export type RuntimeSettingsBlock = z.output<typeof runtimeSettingsSchema>;

/** A container block after host-local executable, context and image resolution. */
export type ResolvedContainerRuntimeSettings =
  | Extract<RuntimeSettingsBlock, { backend: "podman" }>
  | (Omit<
      Extract<RuntimeSettingsBlock, { backend: "docker" }>,
      "image_digest" | "executable" | "connection"
    > & {
      image_digest: string;
      executable: string;
      connection: string;
    });

/** Kernel-owned last-wins runtime placement block; plugins cannot contribute it. */
export const runtimeSettingsSpec: CapabilitySettingsSpec = {
  key: "runtime",
  schema: runtimeSettingsSchema,
  merge: "lastWins",
  pluginContributable: false,
};
