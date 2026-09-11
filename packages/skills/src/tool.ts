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

/** Wire name of the tool that reads one resource declared by a loaded skill. */
export const READ_SKILL_RESOURCE_TOOL_NAME = "read_skill_resource";

/** Default cap on how many characters of a bundled skill resource are returned. */
export const SKILL_RESOURCE_MAX_CHARS = 50_000;

const RESOURCE_PATH_CHARACTER = "[^/\\\\\\u0000-\\u001f\\u007f]";
const RESOURCE_PATH_NON_DOT_CHARACTER = "[^./\\\\\\u0000-\\u001f\\u007f]";
const RESOURCE_PATH_FIRST_NON_DRIVE_CHARACTER = "[^:/\\\\\\u0000-\\u001f\\u007f]";
const RESOURCE_PATH_SEGMENT =
  `(${RESOURCE_PATH_NON_DOT_CHARACTER}${RESOURCE_PATH_CHARACTER}*|` +
  `\\.${RESOURCE_PATH_NON_DOT_CHARACTER}${RESOURCE_PATH_CHARACTER}*|` +
  `\\.\\.${RESOURCE_PATH_CHARACTER}+)`;
const RESOURCE_PATH_FIRST_SEGMENT =
  `([A-Za-z](${RESOURCE_PATH_FIRST_NON_DRIVE_CHARACTER}${RESOURCE_PATH_CHARACTER}*)?|` +
  `[^A-Za-z./\\\\\\u0000-\\u001f\\u007f]${RESOURCE_PATH_CHARACTER}*|` +
  `\\.${RESOURCE_PATH_NON_DOT_CHARACTER}${RESOURCE_PATH_CHARACTER}*|` +
  `\\.\\.${RESOURCE_PATH_CHARACTER}+)`;
const RESOURCE_PATH_PATTERN = `^${RESOURCE_PATH_FIRST_SEGMENT}(/${RESOURCE_PATH_SEGMENT})*$`;

/**
 * The narrow provider slice the body and resource skill handlers need.
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
 * on demand, since the system prompt lists only names and one-line descriptions.
 */
export const loadSkillTool: NamespacedTool = {
  fullName: LOAD_SKILL_TOOL_NAME,
  wireName: LOAD_SKILL_TOOL_NAME,
  mcpName: "",
  toolName: LOAD_SKILL_TOOL_NAME,
  description:
    "Load a skill's full instructions on demand. The system prompt lists the available skills " +
    "(name + one-line description); call this with a skill's `name` to read its complete " +
    "instructions before applying it, and only when the task calls for that skill. This operation " +
    "accepts only `name`; use `read_skill_resource` for a bundled file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "The skill's name, exactly as shown in the available-skills list.",
      },
    },
    required: ["name"],
  },
};

/**
 * The closed resource-reading companion to {@link loadSkillTool}.
 *
 * @remarks Every property is required so strict-schema providers cannot
 *   materialize a placeholder for an omitted operation argument. The first
 *   page always uses `offset: 0`; later pages copy the returned byte offset.
 */
export const readSkillResourceTool: NamespacedTool = {
  fullName: READ_SKILL_RESOURCE_TOOL_NAME,
  wireName: READ_SKILL_RESOURCE_TOOL_NAME,
  mcpName: "",
  toolName: READ_SKILL_RESOURCE_TOOL_NAME,
  description:
    "Read one bundled file listed by a previous load_skill result. Pass the exact relative " +
    "resource path and offset 0 for the first page; for a continuation, keep the same name and " +
    "resource and copy the returned next offset.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        minLength: 1,
        description: "The loaded skill's exact name.",
      },
      resource: {
        type: "string",
        minLength: 1,
        maxLength: 4_096,
        pattern: RESOURCE_PATH_PATTERN,
        description:
          "The bundled file's exact relative path as listed by load_skill; never a SKILL.md or " +
          "absolute path.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: MAX_SKILL_RESOURCE_FILE_BYTES,
        description: "UTF-8 byte offset: 0 initially, then the exact next offset returned.",
      },
    },
    required: ["name", "resource", "offset"],
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
 * skill catalog, then the instructions for loading a body or declared resource.
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
    `instructions before using it. That tool accepts only \`name\`. To read a bundled file listed ` +
    `by its result, call \`${READ_SKILL_RESOURCE_TOOL_NAME}\` with the exact \`name\`, ` +
    `\`resource\`, and \`offset: 0\`, then copy any returned continuation offset. ` +
    `Load a skill only when the task actually calls for it. If the user names a skill, load it ` +
    `before acting on that work. If they did not name one, use judgement: apply a skill only when ` +
    `it would materially improve the outcome, not because of keywords or mere availability. The ` +
    `user's current instructions take precedence over the skill. If a skill is why you must pause, ` +
    `identify the relevant SKILL.md rule.`;
  if (head.length === 0) return tail;
  return `${head}\n\n${tail}`;
}
