import { fuzzyFilter } from "../../core/fuzzy.ts";
import type { CompleteItem, CompleteProvider } from "./autocomplete.ts";

/** One user-invocable skill as the `$` composer popup should present it. */
export interface SkillMentionCandidate {
  name: string;
  description?: string;
  shortDescription?: string;
}

/** Dependencies for {@link createSkillMentionProvider}. */
export interface SkillMentionProviderDeps {
  /** Live skill catalog; read on each query so async registrations appear. */
  skills: () => readonly SkillMentionCandidate[];
}

/**
 * Builds the `$` skill-mention provider.
 *
 * @remarks Accepting a row inserts `$name ` through `acceptMention` and does
 *   not submit. Skills that name an `agent` still appear; the kernel leaves
 *   those tokens unexpanded so `/name` remains the privileged run path.
 */
export function createSkillMentionProvider(deps: SkillMentionProviderDeps): CompleteProvider {
  return {
    id: "skill",
    trigger: "$",
    label: "skills",
    query: (term): CompleteItem[] =>
      fuzzyFilter(deps.skills(), term, (skill) => skill.name).map((skill) => ({
        label: skill.name,
        detail: skill.shortDescription ?? skill.description,
        value: skill.name,
        insert: skill.name,
      })),
  };
}
