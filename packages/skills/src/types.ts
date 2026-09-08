import type { BoundedTextChunk } from "./bounded-read.ts";
import type { SkillFrontmatter } from "./schema.ts";

/**
 * Where a skill root comes from: `user` (the home-level `~/.clarvis` tree) or
 * `workspace` (the project). Carried onto every {@link SkillInfo} so a consumer
 * can tell a personal skill from a project one.
 */
export type SkillScope = "user" | "workspace";

/**
 * Free-form provenance tag naming which plugin/marketplace contributed a root
 * (empty string when unattributed). Preserved verbatim onto {@link SkillInfo}
 * and {@link ShadowedSkill} so a consumer can attribute collisions.
 */
export type SkillSource = string;

/**
 * A fully resolved skill root: an absolute directory scanned for `SKILL.md`
 * files, tagged with its {@link SkillScope} and {@link SkillSource}. Produced by
 * `resolveConfig` from a {@link SkillRootInput}.
 */
export interface SkillRoot {
  /** Absolute path of the directory to scan. */
  path: string;
  scope: SkillScope;
  source: SkillSource;
  /** Exact skill names admitted from this root; absent means discover every skill. */
  include?: readonly string[];
  /** Whether discovery may descend through grouping directories. */
  discovery?: "nested" | "immediate";
  /** Whether the manifest filename must be exactly `SKILL.md`. */
  manifestName?: "case-insensitive" | "exact";
  /** Whether the portable Agent Skills frontmatter contract is enforced without defaults. */
  validation?: "compatible" | "agent-skills";
  /** Filesystem-resolved package boundary that discovered paths may not escape. */
  confinementRoot?: string;
  /** Host approval for skills under this root to expose their own directory for execution. */
  executionRoot?: string;
}

/**
 * A caller-supplied skill root before resolution: `path` may be relative or use
 * `~`, and `scope`/`source` default (to `workspace` / empty string) if omitted.
 * See {@link SkillRoot} for the resolved form.
 */
export interface SkillRootInput {
  /** Directory to scan; resolved against the workspace and `~` at config time. */
  path: string;
  scope?: SkillScope;
  source?: SkillSource;
  /** Exact skill names admitted from this root; absent preserves full discovery. */
  include?: readonly string[];
  /** `immediate` inspects only direct child directories; default `nested` preserves groups. */
  discovery?: "nested" | "immediate";
  /** `exact` requires the canonical uppercase `SKILL.md` filename. */
  manifestName?: "case-insensitive" | "exact";
  /** `agent-skills` enforces portable identity, metadata, compatibility, and tool fields. */
  validation?: "compatible" | "agent-skills";
  /** Optional package boundary; resolved like {@link SkillRootInput.path}. */
  confinementRoot?: string;
  /** Optional host approval for discovered skills to expose their own directory to commands. */
  executionRoot?: string;
}

/**
 * A file bundled alongside a skill's `SKILL.md`, surfaced during the final tier
 * of progressive disclosure. `kind` buckets the resource by its top-level
 * subdirectory (`scripts`/`references`/`assets`/`examples`, else `other`).
 */
export interface SkillResource {
  kind: "scripts" | "references" | "assets" | "examples" | "other";
  /** Skill-directory-relative path (e.g. `scripts/build.sh`). */
  rel: string;
  /** Absolute path on disk. */
  path: string;
}

/**
 * Skill-relative icon paths, keyed by the theme each is drawn for. Both are
 * confined to the skill directory by the reader that produced them.
 */
export interface SkillIcons {
  light?: string;
  dark?: string;
}

/**
 * How a skill wants to be presented in a picker or catalog UI: a display name,
 * a one-line short description, theme icons, a brand colour and a starter
 * prompt.
 *
 * @remarks
 * Every field is optional and purely presentational, and this bucket is never
 * rendered to the model: it is addressed to the harness, so no field of it
 * reaches a skill body, the injected catalog or a `load_skill` result *as
 * presentation*.
 *
 * There is exactly one path by which one of these strings becomes model-visible,
 * and it is deliberate rather than a leak. When a skill authors no
 * `description` — a field Clarvis requires and some dialects do not — the short
 * description is borrowed to fill it rather than letting the skill fall to a
 * placeholder, and the catalog then renders it as that skill's description. It
 * is recorded in {@link SkillInfo.defaulted}, so a supplied value is always
 * distinguishable from an authored one. Nothing else here crosses over.
 *
 * Presentation is likewise never authorization: nothing here gates a tool, a
 * grant or a path.
 */
export interface SkillPresentation {
  displayName?: string;
  shortDescription?: string;
  icons?: SkillIcons;
  color?: string;
  starterPrompt?: string;
}

/** One external tool dependency declared by a skill's harness sidecar. */
export interface SkillToolDependency {
  type: "mcp";
  /** MCP server identity expected by the skill. */
  value: string;
  description?: string;
  transport?: string;
  url?: string;
}

/**
 * A required catalog field Clarvis supplied because the manifest did not carry a
 * usable one. Recorded so a UI can tell a supplied value from an authored one.
 */
export type SkillDefaultedField = "name" | "description";

/**
 * A skill that was hidden because another skill with the same name won during
 * cross-root merging (last-root-wins). Carries just enough to identify where the
 * shadowed skill came from — consumers use this to report plugin collisions.
 */
export interface ShadowedSkill {
  /** Provenance tag of the root the loser came from; see {@link SkillSource}. */
  source: SkillSource;
  scope: SkillScope;
  /** Absolute path of the root the shadowed skill was scanned from. */
  root: string;
  /** Absolute path of the shadowed skill's own directory. */
  dir: string;
}

/**
 * The catalog-tier metadata for one merged skill — everything a consumer needs
 * to list, filter, and locate a skill without reading its body. Produced from
 * the parsed {@link SkillFrontmatter} plus the root it was scanned from.
 */
export interface SkillInfo {
  /** Skill name from frontmatter; also the lookup key and merge identity. */
  name: string;
  description: string;
  /** The full parsed frontmatter, including passthrough keys. */
  metadata: SkillFrontmatter;
  /**
   * Normalized tool allow-list from frontmatter `allowed-tools` (falling back to
   * `tools`); absent when neither key is present.
   */
  allowedTools?: string[];
  /** Whether a user may invoke the skill directly; defaults to `true`. */
  userInvocable: boolean;
  /**
   * Whether the skill is withheld from the catalog injected into a run's
   * context; absent means it is listed.
   *
   * @remarks
   * A distinct axis from {@link SkillInfo.userInvocable}, not a synonym for it.
   * `userInvocable` filters the slash listing a *user* chooses from; this
   * withholds the entry from the *model*'s catalog while leaving the skill
   * explicitly loadable by name. A skill may carry either, both, or neither.
   */
  catalogSuppressed?: boolean;
  /**
   * How the skill asks to be presented in a picker; absent when neither the
   * manifest nor a sidecar carried any presentation field.
   */
  presentation?: SkillPresentation;
  /** MCP servers the skill needs before it can be offered in the model catalog. */
  dependencies?: SkillToolDependency[];
  /**
   * The required catalog fields Clarvis supplied for this skill because the
   * manifest carried no usable value; absent when everything was authored.
   */
  defaulted?: SkillDefaultedField[];
  scope: SkillScope;
  source: SkillSource;
  /** Absolute discovery root, or a `builtin:` locator for host-embedded instructions. */
  root: string;
  /** Absolute skill directory, or a `builtin:` locator when no filesystem directory exists. */
  dir: string;
  /** Host-approved skill directory for bundled helper execution. */
  executionRoot?: string;
  /** Absolute manifest path, or a `builtin:` locator for a skill with `source: "builtin"`. */
  path: string;
  /**
   * Same-named skills from lower-precedence roots that this one shadowed during
   * the merge. Present only on a winner that actually shadowed something.
   */
  shadowed?: ShadowedSkill[];
}

/**
 * A skill's full disclosure: its {@link SkillInfo} plus the loaded body text and
 * the enumerated bundled {@link SkillResource | resources}. Returned by
 * {@link SkillRegistry.get}.
 */
export interface SkillContent extends SkillInfo {
  /** The `SKILL.md` body (frontmatter stripped, trimmed). */
  body: string;
  resources: SkillResource[];
  /** Files whose bytes produced this effective body, catalog metadata, or resource allow-list. */
  identityFiles?: string[];
}

/**
 * A scanned-but-not-yet-disclosed skill held internally by the registry. The
 * `body` property may be a lazy getter: discovery retains catalog metadata and
 * the manifest locator, then reads instructions only when disclosure accesses it.
 */
export interface ResolvedSkill {
  info: SkillInfo;
  body: string;
  /** Harness sidecar that contributed effective metadata, when one was selected. */
  sidecarPath?: string;
}

/**
 * Lookup surface over the merged skill set, backing the progressive-disclosure
 * tiers: {@link SkillRegistry.list | list} (catalog), {@link SkillRegistry.get |
 * get} (body + resources), {@link SkillRegistry.resource | resource} (one file).
 */
export interface SkillRegistry {
  /** All skills as catalog metadata, sorted by name. */
  list(): SkillInfo[];
  /** Full content for a skill, or `undefined` if no skill has that name. */
  get(name: string): SkillContent | undefined;
  /**
   * Resolve a bundled resource to an absolute path, guarding against escape from
   * the skill directory.
   *
   * @throws {@link SkillError} `not_found` if the skill or file is missing, or
   *   `not_a_file` if the path is not a regular file.
   */
  resource(name: string, rel: string): string;
  /** Read one confined bundled resource as UTF-8 text. */
  readResource(name: string, rel: string): string;
  /** Read one bounded UTF-8 page of a confined bundled resource. */
  readResourceChunk(
    name: string,
    rel: string,
    offset?: number,
    maxChars?: number,
  ): BoundedTextChunk;
  /** Number of distinct merged skills. */
  readonly size: number;
}

export type { SkillFrontmatter } from "./schema.ts";
