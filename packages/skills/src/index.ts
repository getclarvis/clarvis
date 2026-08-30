import { resolveConfig } from "./config.ts";
import { discoverSkills } from "./core.ts";
import type { AgentSkillsOptions, SkillConfig } from "./config.ts";
import type { SkillContent, SkillInfo, SkillRegistry } from "./types.ts";

/**
 * The package's high-level facade over a {@link SkillRegistry}: the merged skill
 * set for a set of roots, plus a {@link AgentSkills.refresh | refresh} to re-scan
 * disk. Created by {@link createAgentSkills}; methods mirror the registry's
 * progressive-disclosure tiers.
 */
export interface AgentSkills {
  /** The resolved configuration this instance was built from. */
  readonly config: SkillConfig;

  /** All skills as catalog metadata, sorted by name (registry `list`). */
  listSkills(): SkillInfo[];

  /** Full content for a skill, or `undefined` if none has that name (registry `get`). */
  loadSkill(name: string): SkillContent | undefined;

  /**
   * Resolve a bundled resource to an absolute path (registry `resource`).
   *
   * @throws {@link SkillError} `not_found`/`not_a_file` if the skill or file is
   *   missing or not a regular file.
   */
  resourcePath(name: string, rel: string): string;

  /** Read a bundled resource through the registry's confinement boundary. */
  readResource(name: string, rel: string): string;

  /** Re-scan every root from disk, replacing the in-memory registry. */
  refresh(): void;
}

/**
 * Build an {@link AgentSkills} facade for the given options: resolve the config,
 * scan every root once, and return a handle that reads the merged set and can
 * re-scan on demand.
 *
 * @param options - roots and behavior flags; see {@link AgentSkillsOptions}.
 * @returns the facade over the freshly scanned {@link SkillRegistry}.
 * @throws {@link StartupError} for a misconfiguration (no roots / bad workspace);
 *   {@link SkillError} in strict mode on a scan failure.
 */
export function createAgentSkills(options: AgentSkillsOptions): AgentSkills {
  const config = resolveConfig(options);
  let registry: SkillRegistry = discoverSkills(config);
  return {
    config,
    listSkills: () => registry.list(),
    loadSkill: (name) => registry.get(name),
    resourcePath: (name, rel) => registry.resource(name, rel),
    readResource: (name, rel) => registry.readResource(name, rel),
    refresh: () => {
      registry = discoverSkills(config);
    },
  };
}

export { discoverSkills } from "./core.ts";
export { normalizeTools } from "./parse.ts";
export type { ParsedSkill } from "./parse.ts";

export { resolveWorkspaceDir, resolveAgainst, expandHome } from "@clarvis/paths";

export { clarvisSkillRoots } from "./preset.ts";
export type { ClarvisSkillRootsOptions } from "./preset.ts";

export { enumerateResources } from "./scan.ts";
export { readBoundedBytes } from "./bounded-read.ts";
export type { BoundedReadOptions, DescriptorReader } from "./bounded-read.ts";

export { resolveConfig } from "./config.ts";
export type { SkillConfig, AgentSkillsOptions } from "./config.ts";

export {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_RESOURCE_BYTES,
  MAX_SKILL_RESOURCE_CHARS,
  MAX_SKILL_ROOTS,
} from "./limits.ts";

export type { ErrorCode } from "./errors.ts";

export type { SkillDiagnostics, WarnSink } from "./lib/log.ts";

export type {
  SkillInfo,
  ShadowedSkill,
  SkillContent,
  SkillDefaultedField,
  SkillIcons,
  SkillPresentation,
  SkillResource,
  SkillScope,
  SkillSource,
  SkillRoot,
  SkillRootInput,
  SkillRegistry,
  ResolvedSkill,
  SkillFrontmatter,
} from "./types.ts";

export type { PluginBootstrapSkill, ResolvedBootstrapSkill } from "./bootstrap.ts";
