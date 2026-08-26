import type { SkillInfo } from "../types.ts";

/**
 * Render a skill catalog as a Markdown bullet list (`- **name** — description`)
 * for injection into a prompt.
 *
 * @param skills - the skills to list; sorted by name and rendered without
 *   mutating the input.
 * @returns the `# Available skills` heading followed by one bullet per listed
 *   skill, or the empty string when nothing is left to list (so nothing is
 *   injected for an empty catalog).
 * @remarks
 * A skill carrying {@link SkillInfo.catalogSuppressed} is withheld here and
 * nowhere else: it stays in the registry, stays loadable by name through
 * `load_skill`, and stays in the slash listing unless its frontmatter separately
 * says otherwise. This is the single point where that axis takes effect, so a
 * consumer that renders the catalog cannot forget to apply it.
 *
 * Only the name and the description are rendered. A skill's presentation bucket
 * is addressed to the harness and has no place in this block — with one
 * deliberate exception it is worth knowing about before reading
 * {@link SkillInfo.description} as always author-written: a skill that authored
 * no description has one borrowed from its short description, so that string can
 * appear here as the description. {@link SkillInfo.defaulted} records when it
 * did.
 */
export function renderSkillCatalog(skills: SkillInfo[]): string {
  const listed = skills.filter((s) => s.catalogSuppressed !== true);
  if (listed.length === 0) return "";
  const lines = listed
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `- **${s.name}** — ${s.description}`);
  return `# Available skills\n\n${lines.join("\n")}\n`;
}
