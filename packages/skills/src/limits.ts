/** Maximum configured roots accepted by one registry. */
export const MAX_SKILL_ROOTS = 32;
/** Maximum immediate directory entries inspected in one skills root or skill directory. */
export const MAX_SKILL_DIRECTORY_ENTRIES = 2_048;
/** Maximum candidate manifests parsed from one root. */
export const MAX_SKILLS_PER_ROOT = 256;

/**
 * How many levels of grouping directories a root may put between itself and a
 * skill.
 *
 * @remarks
 * A root is commonly flat, and just as commonly grouped one or two levels deep
 * (`roles/architect/`, `skills/architect/architecture-design/`). The bound
 * exists so an accidental root — a repository checkout, a home directory —
 * cannot turn discovery into a full-tree walk; it is not a layout opinion.
 */
export const MAX_SKILL_NESTING = 4;

/**
 * How many child directories one root's scan may probe before it gives up.
 *
 * @remarks Bounds the traversal independently of {@link MAX_SKILL_NESTING}: a
 *   shallow tree can still be enormously wide, and the depth cap says nothing
 *   about width. Counted per *probe* rather than per directory descended into,
 *   because the probe is what costs a `readdir` — and one descent probes as many
 *   children as {@link MAX_SKILL_DIRECTORY_ENTRIES} allows.
 */
export const MAX_SKILL_GROUP_DIRECTORIES = 1_024;
/** Maximum distinct skills retained in the merged catalog. */
export const MAX_SKILLS = 512;

/** Maximum on-disk size of one complete `SKILL.md`. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** Maximum decoded characters in one complete `SKILL.md`. */
export const MAX_SKILL_FILE_CHARS = 100_000;
/** Maximum prefix read while locating and parsing YAML frontmatter. */
export const MAX_SKILL_FRONTMATTER_BYTES = 64 * 1024;
/** Maximum decoded characters inside YAML frontmatter. */
export const MAX_SKILL_FRONTMATTER_CHARS = 50_000;

/** Maximum nesting below a skill directory while enumerating bundled resources. */
export const MAX_SKILL_RESOURCE_DEPTH = 16;
/** Maximum directory entries inspected across one skill's resource tree. */
export const MAX_SKILL_RESOURCE_ENTRIES = 4_096;
/** Maximum resource directories entered for one skill. */
export const MAX_SKILL_RESOURCE_DIRECTORIES = 512;
/** Maximum resource files returned for one skill. */
export const MAX_SKILL_RESOURCES = 1_024;
/** Maximum on-disk size read through `readResource`. */
export const MAX_SKILL_RESOURCE_BYTES = 256 * 1024;
/** Maximum decoded characters read through `readResource`. */
export const MAX_SKILL_RESOURCE_CHARS = 50_000;
/** Maximum complete size of a resource retained for chunked disclosure or exact snapshots. */
export const MAX_SKILL_RESOURCE_FILE_BYTES = 8 * 1024 * 1024;
/** Maximum aggregate resource bytes retained in one skill snapshot. */
export const MAX_SKILL_RESOURCE_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/** Maximum on-disk size of one harness-directed sidecar. */
export const MAX_SKILL_SIDECAR_BYTES = 16 * 1024;
/** Maximum decoded characters in one harness-directed sidecar. */
export const MAX_SKILL_SIDECAR_CHARS = 8_000;
/** Maximum characters retained from a presentation label (display name, brand colour). */
export const MAX_SKILL_LABEL_CHARS = 128;
/** Maximum characters retained from a presentation short description. */
export const MAX_SKILL_SHORT_DESCRIPTION_CHARS = 512;
/** Maximum characters retained from a presentation starter prompt. */
export const MAX_SKILL_STARTER_PROMPT_CHARS = 4_000;
/** Maximum characters retained from a presentation icon path. */
export const MAX_SKILL_ICON_PATH_CHARS = 512;

/** Catalog-field bounds keep a bounded skill count from expanding into an unbounded prompt. */
export const MAX_SKILL_NAME_CHARS = 128;
export const MAX_SKILL_AGENT_CHARS = 128;
export const MAX_SKILL_DESCRIPTION_CHARS = 1_024;
export const MAX_SKILL_TOOLS = 128;
export const MAX_SKILL_TOOL_CHARS = 256;
