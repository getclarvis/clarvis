/**
 * Zod schemas: the per-run indexer's output validation and the config schema
 * the loop embeds into its settings (`memory:` section).
 */
import { z } from "zod";

import { MEMORY_DEFAULTS } from "./config.ts";

/** A path relative to the memory root: POSIX-separated `.md` segments, no
 * traversal, no absolute paths. The store re-validates on write; this is the
 * first gate so a malformed op is dropped before any disk touch. */
const relPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "") &&
      p.endsWith(".md"),
    "must be a relative POSIX .md path with no traversal",
  );

/** Detailed knowledge leaves. PROFILE.md and TOPIC.md are compilation layers
 * and must never be deleted by the model. */
export const memoryLeafPathSchema = relPath.refine(
  (p) => p.split("/").length >= 3 && p.endsWith("/MEMORY.md"),
  "must be a leaf path like <topic>/<subtopic>/MEMORY.md",
);

/** Every semantic layer the model may compile. PROFILE and TOPIC contain
 * progressively denser summaries; MEMORY contains the detailed knowledge. */
export const memoryWritablePathSchema = relPath.refine(
  (p) =>
    p === "PROFILE.md" ||
    (p.split("/").length >= 2 && p.endsWith("/TOPIC.md")) ||
    memoryLeafPathSchema.safeParse(p).success,
  "must be PROFILE.md, <topic>/TOPIC.md, or <topic>/<subtopic>/MEMORY.md",
);

/**
 * Size caps the host tunes for the memory subsystem, all validated with floors
 * so a misconfiguration cannot starve a stage.
 *
 * @remarks
 * `seed_chars` bounds the injected `PROFILE.md` seed block; `digest_tokens`
 * bounds the run summary handed to the indexer; `max_index_ops` caps how many
 * documents one indexer pass may change (1–50).
 */
export const budgetsSchema = z.object({
  seed_chars: z.number().int().min(500),
  digest_tokens: z.number().int().min(500),
  max_index_ops: z.number().int().min(1).max(50),
});

/**
 * Where a workspace's memory actually comes from.
 *
 * @remarks Absent means the built-in Markdown wiki. Its content is exposed
 * through Clarvis's fixed memory tool vocabulary. Unknown kinds are rejected
 * during settings validation instead of silently disabling memory.
 */
export const memoryProviderSchema = z.object({ kind: z.literal("wiki") }).strict();

/** A validated `memory.provider` declaration. @see {@link memoryProviderSchema} */
export type MemoryProviderConfig = z.infer<typeof memoryProviderSchema>;

/**
 * The `memory:` settings block the loop embeds: whether memory is on, where it
 * comes from, which model drives the per-run indexer, and optional
 * {@link budgetsSchema} overrides.
 *
 * @remarks
 * `.strict()` rejects unknown keys. `enabled` defaults to `true`; `model` is
 * optional and hosts should default it to a cheap model; `budgets` is a partial
 * override so only the caps a host cares about need be set; `provider` defaults
 * to the built-in wiki.
 */
export const memoryConfigSchema = z
  .object({
    enabled: z.boolean().default(MEMORY_DEFAULTS.enabled),
    /** Model id for the indexer; hosts should default to a cheap model. */
    model: z.string().optional(),
    budgets: budgetsSchema.partial().optional(),
    provider: memoryProviderSchema.optional(),
  })
  .strict();

/** The parsed `memory:` settings block. @see {@link memoryConfigSchema} */
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
