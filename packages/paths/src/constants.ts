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
 * @remarks
 * Applied best-effort. Windows ignores the mode rather than failing, and that is
 * acceptable — a platform that cannot honour it must not turn directory creation
 * into an error.
 */
export const DIR_MODE = 0o700;

/**
 * File mode for everything Clarvis writes: owner read/write only.
 *
 * @remarks
 * The companion of {@link DIR_MODE}, and the reason the atomic-write family
 * lives in this package: the seven hand-rolled copies it replaces each restated
 * the pair, and a copy that forgets it publishes a run's transcript, a signing
 * key or an API secret at the ambient umask. Windows honours only the write bit,
 * which is the same best-effort posture {@link DIR_MODE} takes.
 */
export const FILE_MODE = 0o600;

/** Glob form of {@link TMP_PREFIX}, for ignore files that take patterns rather than names. */
export const TMP_GLOB = `${TMP_PREFIX}*`;

/** Filename prefix shared by a background monitor's sidecar, log, and exit files. */
export const MONITOR_PREFIX = "monitor-";

/** Filename prefix for a shell tool's overflow capture. */
export const SPILL_PREFIX = "shell-";

/** Filename prefix for the untruncated copy of an oversized tool result. */
export const TOOL_OUTPUT_PREFIX = "toolout-";

/** Suffix of a tool-result spill: prose the model reads back, not a log. */
export const TOOL_OUTPUT_SUFFIX = ".txt";

/** Suffix of the JSON sidecar holding a monitor's bookkeeping. */
export const MONITOR_SIDECAR_SUFFIX = ".json";

/** Suffix of a captured output log, shared by monitors and shell spills. */
export const LOG_SUFFIX = ".log";

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
 * Distinct from {@link INTERNAL_IGNORE_PATTERNS}: this bounds a structural scan
 * of the working tree, whereas those are ignore-file patterns applied to
 * `grep`/`glob`. The two lists differ because they answer different questions,
 * not because they drifted.
 */
export const INTERNAL_SKIP_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  CLARVIS_DIR,
  ".next",
  "coverage",
  "build",
];

/**
 * Built-in ignore patterns applied beneath every user-supplied ignore source.
 *
 * @remarks
 * {@link AGENTS_DIR} is deliberately absent: it is the user's own content, and
 * `grep`/`glob` are expected to see it.
 */
export const INTERNAL_IGNORE_PATTERNS: readonly string[] = [".git", CLARVIS_DIR, TMP_GLOB];
