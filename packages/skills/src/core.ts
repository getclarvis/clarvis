import { buildRegistry } from "./registry.ts";
import type { SkillConfig } from "./config.ts";
import type { SkillRegistry } from "./types.ts";

/**
 * Scan the configured roots and merge them into a {@link SkillRegistry}.
 *
 * A thin entry point over {@link buildRegistry}: it performs one full scan and
 * returns the immutable registry (re-scan by calling again).
 *
 * @param config - the resolved roots and behavior flags; see {@link SkillConfig}.
 * @returns the merged registry for lookup and progressive disclosure.
 * @throws {@link SkillError} in strict mode on a parse failure or duplicate name.
 */
export function discoverSkills(config: SkillConfig): SkillRegistry {
  return buildRegistry(config);
}
