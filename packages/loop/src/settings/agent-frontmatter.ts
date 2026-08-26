import { splitFrontmatterFence } from "@clarvis/capability";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { agentProfileSchema, budgetSchema, modelField } from "../validation/request-schema.ts";
import { INPUT_LIMITS } from "../validation/input-limits.ts";

/** Split a `tools:` frontmatter value (YAML list or comma-separated string) into
 * trimmed, non-empty tool names. Owned here so the settings contract carries no
 * dependency on any feature package. */
export function normalizeTools(tools: string[] | string | undefined): string[] {
  if (tools === undefined) return [];
  const parts = Array.isArray(tools) ? tools : tools.split(",");
  return parts.map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * The result of splitting an agent markdown file into its YAML frontmatter and
 * body, before the frontmatter is validated against {@link agentFrontmatterSchema}.
 */
export interface RawAgentFrontmatter {
  /** The parsed YAML frontmatter as an untyped value (`{}` when absent). */
  data: unknown;
  /** The markdown body following the closing `---` fence (the raw input when no fence matched). */
  body: string;
}

/**
 * Split an agent markdown file into its YAML frontmatter (`data`) and markdown
 * `body`, stripping a leading BOM and surrounding whitespace first.
 *
 * @param raw - the raw file contents.
 * @param mode - `"strict"` (default) throws on a malformed fence or unparsable
 *   YAML; `"lenient"` swallows both and falls back to an empty `{}` frontmatter.
 * @returns the parsed frontmatter and body; a file with no `---` fence yields
 *   `{ data: {}, body: raw }`.
 * @throws {@link Error} in `"strict"` mode when a leading `---` opens a fence
 *   that never closes, or when the YAML fails to parse.
 */
export function splitAgentFrontmatter(
  raw: string,
  mode: "strict" | "lenient" = "strict",
): RawAgentFrontmatter {
  const fence = splitFrontmatterFence(raw);
  if (fence.kind === "unterminated") {
    if (mode === "strict") {
      throw new Error("malformed YAML frontmatter (missing or misaligned closing '---' fence)");
    }
    return { data: {}, body: fence.body };
  }
  if (fence.kind === "absent") {
    return { data: {}, body: fence.body };
  }
  const yamlText = fence.frontmatter;
  let data: unknown;
  try {
    data = yamlText.trim().length === 0 ? {} : (parseYaml(yamlText) as unknown);
  } catch (err) {
    if (mode === "strict") throw err;
    data = {};
  }
  if (mode === "lenient" && (data === null || typeof data !== "object")) data = {};
  return { data: data ?? {}, body: fence.body };
}

const toolsFrontmatter = z
  .union([
    z.array(z.string().max(INPUT_LIMITS.toolNameChars)).max(INPUT_LIMITS.profileTools),
    z.string().max(INPUT_LIMITS.profileBasePromptChars),
  ])
  .optional()
  .describe("Tool names (server.tool) as a YAML list or a comma-separated string.");

/**
 * The validated shape of an agent file's frontmatter: the shared
 * {@link agentProfileSchema} minus `name`/`model`/`tools`, re-adding an optional
 * inheritable `model`, list-or-CSV `tools`, a `base_prompt` seed message, a
 * per-entry `budget`, and a default `output_schema`.
 *
 * @remarks `.loose()` — an unrecognized key is **carried** into the parsed
 *   result rather than rejected or stripped. Every key this schema names is
 *   still validated exactly as before; only the unknown ones are tolerated.
 *
 *   This follows the `orchestration` precedent in
 *   `validation/request/profile-schemas.ts`: an agent definition is a file a
 *   person wrote by hand and this object reaches the schema verbatim from its
 *   frontmatter, so `.strict()` turned any key the engine does not own into a
 *   hard failure. The asymmetry it produced was worse than a missing check —
 *   the read path is lenient and keeps the raw map, so such a file lists and
 *   runs, and only *saving* it from an editor failed. Carrying rather than
 *   stripping is what makes that round-trip lossless: a write built from the
 *   parsed result would otherwise silently drop the keys it did not recognize.
 *
 *   Nothing downstream is widened by this. A run profile is assembled by
 *   picking named fields out of the frontmatter, never by spreading it, so a
 *   carried key never reaches the strict `agentProfileSchema`.
 */
export const agentFrontmatterSchema = agentProfileSchema
  .omit({ name: true, model: true, tools: true })
  .extend({
    model: modelField
      .optional()
      .describe(
        "Provider/model string used when this profile is spawned as a Sub-agent. For the run's " +
          "Lead, settings.default_model takes precedence when configured.",
      ),
    tools: toolsFrontmatter,
    base_prompt: z
      .string()
      .min(1, "base_prompt must be a non-empty string")
      .max(INPUT_LIMITS.profileBasePromptChars)
      .optional()
      .describe("Seed system message. Usually the markdown body of the agent file."),
    budget: budgetSchema
      .optional()
      .describe(
        "Run budget used when this agent is the entry. Falls back to the top-level budget.",
      ),
    output_schema: z
      .unknown()
      .optional()
      .meta({
        type: "object",
        description:
          "Default structured-output JSON Schema when this agent is the entry; a run's " +
          "output_schema overrides it.",
      }),
  })
  .loose();

/** The inferred type of a validated agent frontmatter; see {@link agentFrontmatterSchema}. */
export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

/**
 * Resolve an agent's system prompt: the markdown body wins when it has content,
 * otherwise the frontmatter `base_prompt` is the fallback.
 *
 * @param basePrompt - the frontmatter `base_prompt`, used only when `body` is blank.
 * @param body - the agent file's markdown body.
 * @returns the trimmed body when non-empty, else `basePrompt` (which may be `undefined`).
 */
export function agentPromptOf(basePrompt: string | undefined, body: string): string | undefined {
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : basePrompt;
}
