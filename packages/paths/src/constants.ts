/**
 * The directory Clarvis writes into, under both a workspace and the user's home.
 *
 * @remarks
 * This is the only place the literal exists. Every other package reaches it
 * through {@link globalPaths} or {@link workspacePaths}.
 */
export const CLARVIS_DIR = ".clarvis";

/**
 * The cross-runtime agent directory shared by compatible agent hosts.
 *
 * @remarks
 * Standalone skills remain operator-authored input. The `plugins/` subtree is
 * also a first-class install and marketplace surface, so the plugin lifecycle
 * may create, replace, or remove exact plugin directories there.
 */
export const AGENTS_DIR = ".agents";

/** Git metadata entry used when classifying a workspace or linked worktree. */
export const GIT_DIR = ".git";

/**
 * The directory a plugin marketplace's listings live under, inside
 * {@link AGENTS_DIR}.
 */
export const AGENTS_PLUGINS_DIR = "plugins";

/** The document a plugin marketplace publishes its listings in. */
export const MARKETPLACE_FILE = "marketplace.json";

/** Filename prefix for the sibling temp file an atomic write renames over its target. */
export const TMP_PREFIX = ".clarvis-tmp-";

/**
 * Directory mode for everything Clarvis creates: owner-only.
 *
 */
export const DIR_MODE = 0o700;

/**
 * File mode for everything Clarvis writes: owner read/write only.
 *
 * @remarks
 * The companion of {@link DIR_MODE}, and the reason the atomic-write family
 * lives in this package: the seven hand-rolled copies it replaces each restated
 * the pair, and a copy that forgets it publishes a run's transcript, a signing
 * key or an API secret at the ambient umask.
 */
export const FILE_MODE = 0o600;

/** Glob form of {@link TMP_PREFIX}, for ignore files that take patterns rather than names. */
export const TMP_GLOB = `${TMP_PREFIX}*`;

/** Filename prefix for the untruncated copy of an oversized tool result. */
export const TOOL_OUTPUT_PREFIX = "toolout-";

/** Suffix of a tool-result spill: prose the model reads back, not a log. */
export const TOOL_OUTPUT_SUFFIX = ".txt";

/**
 * Agent-context filenames, in the order a scope is searched.
 *
 * @remarks
 * The first that exists wins; `AGENTS.md` is the cross-runtime spelling and is
 * therefore the fallback, not the primary.
 */
export const CONTEXT_FILENAMES: readonly string[] = ["CLARVIS.md", "AGENTS.md"];

/**
 * Directory names a workspace tree walk never descends into.
 *
 * @remarks
 * This list bounds structural scans of the working tree.
 */
export const INTERNAL_SKIP_DIRS: readonly string[] = [
  GIT_DIR,
  "node_modules",
  "dist",
  CLARVIS_DIR,
  ".next",
  "coverage",
  "build",
];
