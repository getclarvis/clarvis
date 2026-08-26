import { z } from "zod";
import {
  MAX_SKILL_AGENT_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_TOOL_CHARS,
  MAX_SKILL_TOOLS,
} from "./limits.ts";

const toolName = z.string().max(MAX_SKILL_TOOL_CHARS);
const tools = z.union([
  z.array(toolName).max(MAX_SKILL_TOOLS),
  z.string().max(MAX_SKILL_TOOLS * (MAX_SKILL_TOOL_CHARS + 1)),
]);

/**
 * The `name` field on its own, so a reader can ask whether a manifest carries a
 * usable one without inferring the answer from a whole-object failure.
 *
 * @remarks
 * `name` must be a single path segment (no separators or whitespace) since it
 * doubles as the skill's directory name and lookup key.
 */
export const skillNameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(MAX_SKILL_NAME_CHARS, `name must contain at most ${String(MAX_SKILL_NAME_CHARS)} chars`)
  .regex(/^[A-Za-z0-9._-]+$/, "name must not contain path separators or whitespace");

/** The `description` field on its own; see {@link skillNameSchema} for why it is separable. */
export const skillDescriptionSchema = z
  .string()
  .trim()
  .min(1, "description is required")
  .max(
    MAX_SKILL_DESCRIPTION_CHARS,
    `description must contain at most ${String(MAX_SKILL_DESCRIPTION_CHARS)} chars`,
  );

/**
 * The `argument-hint` a skill shows beside its slash command.
 *
 * @remarks
 * Read as a string or as a list of them, and never allowed to fail. The list
 * form is not a dialect choice — it is what YAML does to the placeholder syntax
 * these hints are conventionally written in: `argument-hint: [file, directory]`
 * is a flow sequence, not the bracketed text its author typed. A `z.string()`
 * rejected it, and because a frontmatter failure is not local to the field the
 * whole skill vanished from the catalog, taking its slash command with it. Nine
 * skills in a public catalog of 196 plugins were lost to exactly that.
 *
 * A hint is display text and nothing else, so it earns the same `.catch` the
 * `agent` field beside it already carries: no purely presentational field may
 * decide whether a skill exists.
 */
const argumentHintSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? value : value.join(", ")))
  .optional()
  .catch(undefined);

/**
 * Zod schema for a `SKILL.md`'s YAML frontmatter, tolerant of the dialects the
 * wider ecosystem writes it in.
 *
 * @remarks
 * `name` and `description` are required; `name` must be a single path segment
 * (no separators or whitespace) since it doubles as the skill's directory name
 * and lookup key. `allowed-tools`/`tools` accept either an array or a
 * comma-separated string (normalized later by `normalizeTools`). Unknown keys
 * pass through (`.passthrough()`) and survive onto {@link SkillFrontmatter} so
 * dialect-specific fields are never dropped.
 *
 * A field that only ever *displays* — `version`, `license`, `argument-hint` —
 * carries `.catch(undefined)` for the reason spelled out on
 * {@link argumentHintSchema}: validation here is not local to the field, so a
 * value in a dialect we do not parse would delete the whole skill rather than
 * the one thing it could not read. `allowed-tools`/`tools` deliberately do not:
 * degrading a tool restriction to "declares none" would *widen* what the skill
 * may do, which is the one direction tolerance must never fail in.
 *
 * `agent` names the agent the skill runs on. It admits `:` on top of `name`'s
 * shape, because a plugin-contributed agent is addressed as
 * `<plugin>:<agent>` — copying `name`'s regex would have made a whole class of
 * agent unnameable from a skill while the run request accepts it. It also
 * `.catch`es to `undefined` rather than failing: a malformed value degrades to
 * "names no agent", so the skill still runs in the caller's turn. Validation
 * failure here is not local to the field — `validateFrontmatter` raises
 * `invalid_skill`, which warns-and-skips the manifest by default and hard-fails
 * discovery under `strict`, so a third-party skill carrying a value in a dialect
 * we do not parse would vanish from the catalog entirely, taking its slash
 * command with it. The bounds still hold for every value that is honoured.
 */
export const skillFrontmatterSchema = z
  .object({
    name: skillNameSchema,
    description: skillDescriptionSchema,
    agent: z
      .string()
      .trim()
      .min(1, "agent must not be blank")
      .max(
        MAX_SKILL_AGENT_CHARS,
        `agent must contain at most ${String(MAX_SKILL_AGENT_CHARS)} chars`,
      )
      .regex(/^[A-Za-z0-9._:-]+$/, "agent must not contain path separators or whitespace")
      .optional()
      .catch(undefined),
    version: z.string().optional().catch(undefined),
    "allowed-tools": tools.optional(),
    "user-invocable": z.boolean().optional(),
    tools: tools.optional(),
    "argument-hint": argumentHintSchema,
    license: z.string().optional().catch(undefined),
  })
  .passthrough();

/**
 * The parsed, validated frontmatter of a skill — the inferred type of
 * {@link skillFrontmatterSchema}, including any passthrough keys.
 */
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
