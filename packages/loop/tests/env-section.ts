import { buildSystemSections } from "../src/runtime/subagents/build-subagent-input.ts";

/**
 * The `# Environment` system-prompt section a run opens with, for a given
 * workspace root.
 *
 * @remarks Derived from {@link buildSystemSections} rather than written out, so
 *   a test asserting the *composition* of the system head — that the base prompt
 *   follows the environment section, that a profile without one gets the section
 *   alone — does not also pin the section's wording. Spelling it out is what made
 *   eight suites fail on a change that added a line to it, none of which were
 *   about the environment section at all.
 */
export function ENV_SECTION(workspaceRoot: string): string {
  return buildSystemSections({ workspaceRoot })[0]!;
}
