import type { SkillContent, SkillInfo } from "@clarvis/skills";
import type { SkillsProvider } from "@clarvis/loop";
import { CLARVIS_CONFIGURE_SKILL } from "./clarvis-configure.ts";

/** Add the product's embedded instructions without granting filesystem or execution access.
 * Builtin names are reserved: installed content cannot replace the shipped configuration guide.
 * Other skills retain their provider's discovery, refresh and resource confinement behavior. */
export function withBuiltinSkills(discovered: SkillsProvider | undefined): SkillsProvider {
  const info: SkillInfo = {
    name: CLARVIS_CONFIGURE_SKILL.name,
    description: CLARVIS_CONFIGURE_SKILL.description,
    metadata: {
      name: CLARVIS_CONFIGURE_SKILL.name,
      description: CLARVIS_CONFIGURE_SKILL.description,
      agent: CLARVIS_CONFIGURE_SKILL.name,
    },
    userInvocable: true,
    scope: "user",
    source: "builtin",
    root: `builtin:${CLARVIS_CONFIGURE_SKILL.name}`,
    dir: `builtin:${CLARVIS_CONFIGURE_SKILL.name}`,
    path: `builtin:${CLARVIS_CONFIGURE_SKILL.name}`,
  };
  const builtin: SkillContent = { ...info, body: CLARVIS_CONFIGURE_SKILL.body, resources: [] };
  const rejectResource = (): never => {
    throw new Error("builtin skills have no filesystem resources");
  };
  return {
    listSkills(): SkillInfo[] {
      return [
        structuredClone(info),
        ...(discovered?.listSkills().filter((skill) => skill.name !== builtin.name) ?? []),
      ].sort((a, b) => a.name.localeCompare(b.name));
    },
    loadSkill: (name) =>
      name === builtin.name ? structuredClone(builtin) : discovered?.loadSkill(name),
    readResource: (name, rel) => {
      if (name === builtin.name || discovered === undefined) return rejectResource();
      return discovered.readResource(name, rel);
    },
    ...(discovered?.readResourceChunk === undefined
      ? {}
      : {
          readResourceChunk: (name: string, rel: string, offset?: number, maxChars?: number) => {
            if (name === builtin.name) return rejectResource();
            return discovered.readResourceChunk!(name, rel, offset, maxChars);
          },
        }),
  };
}
