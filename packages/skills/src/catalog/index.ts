import type { SkillInfo } from "../types.ts";

export const MAX_SKILL_CATALOG_CHARS = 8_000;

function catalogLine(skill: SkillInfo, compact: boolean): string {
  return compact
    ? `- **${skill.name}** (path: ${skill.path})`
    : `- **${skill.name}** — ${skill.description} (path: ${skill.path})`;
}

/**
 * Render a bounded skill catalog as Markdown bullets containing each skill's
 * name, description, and absolute `SKILL.md` path for prompt injection.
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
 * Only the name, description, and exact manifest path are rendered. A skill's
 * presentation bucket is addressed to the harness and has no place in this
 * block — with one deliberate exception it is worth knowing about before reading
 * {@link SkillInfo.description} as always author-written: a skill that authored
 * no description has one borrowed from its short description, so that string can
 * appear here as the description. {@link SkillInfo.defaulted} records when it
 * did.
 */
export function renderSkillCatalog(skills: SkillInfo[]): string {
  const listed = skills.filter((s) => s.catalogSuppressed !== true);
  if (listed.length === 0) return "";
  const sorted = listed.sort((a, b) => a.name.localeCompare(b.name));
  const heading = "# Available skills\n\n";
  const full = `${heading}${sorted.map((skill) => catalogLine(skill, false)).join("\n")}\n`;
  if (full.length <= MAX_SKILL_CATALOG_CHARS) return full;

  const lines = sorted.map((skill) => catalogLine(skill, true));
  while (lines.length > 0) {
    const omitted = sorted.length - lines.length;
    const notice =
      omitted > 0
        ? `\n- ${String(omitted)} additional skills omitted from this bounded catalog.`
        : "";
    const rendered = `${heading}${lines.join("\n")}${notice}\n`;
    if (rendered.length <= MAX_SKILL_CATALOG_CHARS) return rendered;
    lines.pop();
  }
  return "";
}
