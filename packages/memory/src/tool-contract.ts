import { z } from "zod";

import { memoryLeafPathSchema, memoryWritablePathSchema } from "./schemas.ts";
import { MEMORY_STORAGE_LIMITS } from "./storage-limits.ts";

/** The model-facing declaration of one canonical Memory operation. */
export interface MemoryToolContract<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
}

/**
 * The seven Memory descriptors Clarvis owns, independent of the selected provider.
 * Providers execute or translate this contract; they never advertise a private shape.
 */
export const MEMORY_TOOL_CONTRACTS = {
  list_memories: {
    name: "list_memories",
    description:
      "List the workspace memory documents (the PROFILE index, per-topic TOPIC indexes, " +
      "and MEMORY leaves) as `path · kind · description`. Start here, then read_memory the " +
      "ones that look relevant.",
    schema: z
      .object({
        prefix: z
          .string()
          .optional()
          .describe("Restrict to documents whose path starts with this prefix (e.g. `infra/`)."),
      })
      .strict(),
  },
  read_memory: {
    name: "read_memory",
    description:
      "Read the full markdown of memory documents by their path (relative to the memory root).",
    schema: z
      .object({
        paths: z
          .array(z.string().min(1))
          .min(1)
          .max(5)
          .describe("Document paths, e.g. `infra/bun/MEMORY.md`."),
      })
      .strict(),
  },
  grep_memories: {
    name: "grep_memories",
    description:
      "Find exact text or a regex across all memory documents, returning `path:line` matches. " +
      "For a meaning-based lookup use query_memories instead; reach for this when you need " +
      "literal matches or a regular expression.",
    schema: z
      .object({
        query: z.string().min(1).describe("Keywords, or a regex when regex=true."),
        regex: z
          .boolean()
          .default(false)
          .describe(
            "Treat `query` as a regular expression. Backreferences, lookaround, a quantifier " +
              "applied to a group, and patterns carrying more than three of `* + ? { |` are not " +
              "honoured — those fall back to a keyword search rather than failing.",
          ),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum matches to return."),
      })
      .strict(),
  },
  query_memories: {
    name: "query_memories",
    description:
      "Find the memory documents most relevant to a question, ranked by relevance. " +
      "Handles English and Portuguese, accented or not, and returns a scored list with a " +
      "matching excerpt from each document. Prefer this over grep_memories, which only " +
      "finds literal text.",
    schema: z
      .object({
        query: z.string().min(1).describe("What you want to know, in plain language."),
        limit: z.number().int().min(1).max(20).default(5).describe("Maximum documents to return."),
        prefix: z.string().optional().describe("Restrict to a path prefix, e.g. `infra/`."),
        kinds: z
          .array(z.enum(["profile", "topic", "memory"]))
          .optional()
          .describe("Restrict to these document kinds."),
      })
      .strict(),
  },
  write_memory: {
    name: "write_memory",
    description:
      "Create or fully replace one semantic layer of the memory pyramid: PROFILE.md is the " +
      "workspace-wide compiled overview, <topic>/TOPIC.md is that domain's compiled summary, " +
      "and <topic>/<subtopic>/MEMORY.md holds full detail. Include `---` frontmatter with a " +
      "one-line `description:`. Do not write a `## Contents` section; navigation is regenerated. " +
      "`pinned:` and `authority: confirmed` are the owner's alone — a write that adds either, " +
      "or that drops an existing `pinned:`, is refused.",
    schema: z
      .object({
        path: memoryWritablePathSchema.describe(
          "PROFILE.md, infra/TOPIC.md, or infra/bun/MEMORY.md.",
        ),
        content: z
          .string()
          .min(1)
          .max(MEMORY_STORAGE_LIMITS.documentBytes)
          .describe("Full markdown with frontmatter."),
      })
      .strict(),
  },
  edit_memory: {
    name: "edit_memory",
    description:
      "Edit any PROFILE, TOPIC, or MEMORY document by replacing an exact substring. " +
      "`old_string` must occur exactly once. Keep the pyramid consistent: when detailed " +
      "knowledge changes materially, update its TOPIC and PROFILE summaries too. An edit that " +
      "adds `pinned:` or `authority: confirmed` to the frontmatter, or that removes an " +
      "existing `pinned:`, is refused — those are the owner's to set.",
    schema: z
      .object({
        path: memoryWritablePathSchema.describe("The document to edit."),
        old_string: z
          .string()
          .min(1)
          .max(MEMORY_STORAGE_LIMITS.documentBytes)
          .describe("Exact substring to replace; must occur once."),
        new_string: z
          .string()
          .max(MEMORY_STORAGE_LIMITS.documentBytes)
          .describe("Replacement text; empty to delete the substring."),
      })
      .strict(),
  },
  delete_memory: {
    name: "delete_memory",
    description: "Delete a MEMORY.md leaf. The navigation index is regenerated afterwards.",
    schema: z
      .object({
        path: memoryLeafPathSchema.describe("The `<topic>/<subtopic>/MEMORY.md` to delete."),
      })
      .strict(),
  },
} as const satisfies Record<string, MemoryToolContract>;

export type MemoryToolName = keyof typeof MEMORY_TOOL_CONTRACTS;

/** Convert the validating zod schema into the exact JSON Schema shown to a model. */
export function memoryToolParameters(name: MemoryToolName): Record<string, unknown> {
  const { $schema: _document, ...rest } = z.toJSONSchema(MEMORY_TOOL_CONTRACTS[name].schema, {
    io: "input",
  }) as Record<string, unknown>;
  return { ...rest, additionalProperties: false };
}
