import type { BoundedTextChunk } from "./bounded-read.ts";
import { MAX_SKILL_RESOURCE_FILE_BYTES } from "./limits.ts";
import type { SkillContent, SkillInfo } from "./types.ts";
import { renderSkillCatalog } from "./catalog/index.ts";
import type { NamespacedTool } from "@clarvis/capability";

import type { ResolvedBootstrapSkill } from "./bootstrap.ts";
/**
 * Wire name of the `load_skill` tool.
 *
 * @remarks Owned only by this package. The capability derives its reservation
 *   and effect metadata from {@link loadSkillTool}, so the optional feature does
 *   not need a mirror on the engine's eager path.
 */
export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** Default cap on how many characters of a bundled skill resource are returned. */
export const SKILL_RESOURCE_MAX_CHARS = 50_000;

/**
 * The narrow slice of {@link AgentSkills} the `load_skill` handler needs: listing
 * skills, loading a skill body, and reading a bundled resource.
 */
export interface SkillsProvider {
  listSkills(): SkillInfo[];
  loadSkill(name: string): SkillContent | undefined;
  readResource(name: string, rel: string): string;
  readResourceChunk?(
    name: string,
    rel: string,
    offset?: number,
    maxChars?: number,
  ): BoundedTextChunk;
}

/**
 * The built-in `load_skill` tool descriptor: loads a skill's full instructions
 * (or one of its bundled resources) on demand, since the system prompt lists only
 * names and one-line descriptions.
 */
export const loadSkillTool: NamespacedTool = {
  fullName: LOAD_SKILL_TOOL_NAME,
  wireName: LOAD_SKILL_TOOL_NAME,
  mcpName: "",
  toolName: LOAD_SKILL_TOOL_NAME,
  description:
    "Load a skill's full instructions on demand. The system prompt lists the available skills " +
    "(name + one-line description); call this with a skill's `name` to read its complete " +
    "instructions before applying it, and only when the task calls for that skill. Omit `resource` " +
    "to load the skill instructions. Supply `resource` only after the skill lists a bundled file, " +
    "using that file's exact relative path (e.g. 'scripts/extract.py' or 'references/spec.md').",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "The skill's name, exactly as shown in the available-skills list.",
      },
      resource: {
        type: "string",
        minLength: 1,
        description:
          "A bundled file's exact relative path, listed by a previous load_skill response. Omit " +
          "this field to load SKILL.md; do not send SKILL.md, a catalog path, an empty value, '.', " +
          "'./', or '/'.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: MAX_SKILL_RESOURCE_FILE_BYTES,
        description:
          "Byte offset for continuing a large UTF-8 text resource. Use only with resource and " +
          "copy the next offset from the previous response.",
      },
    },
    required: ["name"],
  },
};

/**
 * Render one plugin's bootstrap skill: its full body, attributed and fenced.
 *
 * @param entry - the resolved bootstrap.
 * @returns the formatted block.
 * @remarks The fence bounds an arbitrarily long body so it cannot bleed into the
 *   catalog that follows, and the attribution tells the model whose rule this is
 *   rather than leaving it to read as a stray paste. The closing line heads off the
 *   `load_skill` call the catalog would otherwise invite for a skill already
 *   present in full.
 */
function renderBootstrapSection(entry: ResolvedBootstrapSkill): string {
  return (
    `# Plugin instructions\n\n` +
    `The '${entry.plugin}' plugin requires its '${entry.skill}' skill to be followed for this ` +
    `entire run. Its full text is reproduced below; you do not need to call ` +
    `\`${LOAD_SKILL_TOOL_NAME}\` for it.\n\n` +
    `<plugin_instructions>\n${entry.body}\n</plugin_instructions>`
  );
}

/**
 * Render the system-prompt "skills" section: any plugin bootstrap bodies, then the
 * skill catalog, then the instruction to call `load_skill` to read a skill's full
 * body before using it.
 *
 * @param catalog - the available skills' catalog entries.
 * @param bootstraps - plugin-declared bootstrap skills to inject ahead of the
 *   catalog; omitted or empty, the section is exactly the catalog form.
 * @returns the formatted section text, or the empty string when there is nothing
 *   to say.
 * @remarks Bootstraps come first because they are the framing the catalog is read
 *   through, and they stay inside this section so one capability owns one region of
 *   the prompt.
 *
 *   The catalog can render empty even for a run whose registry is not, because
 *   every skill in it may be withheld from the model's catalog. The instruction
 *   to call `load_skill` goes with it: it invites the model to pick a name out of
 *   a list, and there would be no list.
 */
export function renderSkillsSection(
  catalog: readonly SkillInfo[],
  bootstraps: readonly ResolvedBootstrapSkill[] = [],
): string {
  const list = renderSkillCatalog([...catalog]);
  const head = bootstraps.map(renderBootstrapSection).join("\n\n");
  if (list.length === 0) return head;
  const tail =
    `${list}\n\n` +
    `Call the \`${LOAD_SKILL_TOOL_NAME}\` tool with a skill's \`name\` to load its full ` +
    `instructions before using it. Omit \`resource\` for those instructions; pass it only to read ` +
    `a bundled file listed by a previous response. ` +
    `Load a skill only when the task actually calls for it.`;
  if (head.length === 0) return tail;
  return `${head}\n\n${tail}`;
}
