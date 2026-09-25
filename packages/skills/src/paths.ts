import path from "node:path";
import { SkillError } from "./errors.ts";

/**
 * Resolve a resource path against a skill directory without constraining the
 * resulting location.
 *
 * @param skillDir - absolute path of the skill's own directory.
 * @param rel - the resource path resolved from `skillDir`.
 * @returns the resolved absolute path.
 * @throws {@link SkillError} `invalid_input` if `rel` is empty.
 */
export function resolveResourcePath(skillDir: string, rel: string): string {
  if (rel.length === 0) {
    throw new SkillError("invalid_input", "resource path must not be empty");
  }
  return path.resolve(skillDir, rel);
}
