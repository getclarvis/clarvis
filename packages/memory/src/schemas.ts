/**
 * Zod schemas: the per-run indexer's output validation and the config schema
 * the loop embeds into its settings (`memory:` section).
 */
import { z } from "zod";
import { capabilityExecutableDeclarationSchema } from "@clarvis/capability";

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
 * @remarks Absent means the built-in markdown wiki, which is what every
 * workspace has unless it says otherwise. A provider supplies the *content* of
 * memory behind Clarvis's fixed tool vocabulary — it never renames a tool, and
 * it never rewrites what the agent is told about memory. See
 * `specs/capabilities/provider-executables.md`.
 *
 * `kind` is the discriminator and the union is deliberately open at the schema
 * level only in the sense that each kind carries its own fields; an unknown
 * kind is rejected here rather than at first use, because a typo in a provider
 * name would otherwise present as "memory answered nothing".
 */
export const memoryProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("wiki"),
    })
    .strict()
    .describe("The built-in markdown wiki (the default)."),
  z
    .object({
      kind: z.literal("file"),
      /**
       * Workspace-relative paths, concatenated into the entry block in order.
       *
       * @remarks Relative and confined on purpose: a provider declared by a
       * plugin must not be able to read outside the working tree, and applying
       * one rule to every declarer is what keeps that guarantee from depending
       * on who wrote the settings file.
       */
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict()
    .describe("One or more workspace files, read-only: doctrine, not a wiki."),
  capabilityExecutableDeclarationSchema
    .extend({ kind: z.literal("executable") })
    .describe("A persistent language-neutral JSON-RPC provider process."),
  z
    .object({
      kind: z.literal("mcp"),
      /** Server name as the host knows it, from `mcpServers`. */
      server: z.string().min(1),
      /**
       * Which server tool answers each Clarvis operation.
       *
       * @remarks A mapping rather than a convention: a knowledge base that
       * predates this tool will not spell its operations the way we do, and
       * renaming our side to match theirs is what the invariant forbids. The
       * four read operations are required; the three write ones are optional
       * **as a set**.
       */
      tools: z
        .object({
          list_memories: z.string().min(1),
          read_memory: z.string().min(1),
          grep_memories: z.string().min(1),
          query_memories: z.string().min(1),
          write_memory: z.string().min(1).optional(),
          edit_memory: z.string().min(1).optional(),
          delete_memory: z.string().min(1).optional(),
        })
        .strict(),
      /** Server tool producing the entry block; omit for a provider with none. */
      seed_tool: z.string().min(1).optional(),
    })
    .strict()
    .describe("A tool server the host already reaches; nothing is loaded in-process."),
  z
    .object({
      kind: z.literal("plugin"),
      /** Name of an installed and enabled plugin offering a selected provider. */
      plugin: z.string().min(1),
    })
    .strict()
    .describe(
      "A memory provider offered by an installed plugin. The plugin offers; the operator " +
        "chooses — a plugin can never point memory at itself.",
    ),
]);

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
