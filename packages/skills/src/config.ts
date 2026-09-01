import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolveAgainst, resolveWorkspaceDir } from "@clarvis/paths";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { SkillRoot, SkillRootInput } from "./types.ts";
import { causeOf, defaultWarnSink, type SkillDiagnostics, type WarnSink } from "./lib/log.ts";
import { MAX_SKILL_ROOTS } from "./limits.ts";

/** Default for {@link SkillConfig.strict}: skip bad skills with a warning rather than throw. */
export const DEFAULT_STRICT = false;
/** Default for {@link SkillConfig.followSymlinks}: symlinked skill dirs/files are followed. */
export const DEFAULT_FOLLOW_SYMLINKS = true;

/**
 * Thrown by {@link resolveConfig} for a caller misconfiguration detected before
 * any scanning — no roots supplied, or an explicit `workspace` that does not
 * exist or is not a directory.
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/**
 * A fully resolved skills configuration: absolute {@link SkillRoot | roots} plus
 * behavior flags, ready for scanning. Produced by {@link resolveConfig} from
 * {@link AgentSkillsOptions}.
 */
export interface SkillConfig extends SkillDiagnostics {
  /** Absolute home directory used to expand `~` in root paths. */
  home: string;
  /** Absolute workspace directory relative paths are resolved against. */
  workspaceDir: string;
  roots: SkillRoot[];
  /** When true, a parse failure or intra-root duplicate name throws instead of warning. */
  strict: boolean;
  /** When true, symlinked skill directories and files are followed during scanning. */
  followSymlinks: boolean;
}

/**
 * Caller-supplied options for {@link createAgentSkills} / {@link resolveConfig}.
 * Only `roots` is required; the rest default from the environment
 * (`process.cwd()`, `homedir()`) and the module defaults.
 */
export interface AgentSkillsOptions {
  /** Roots to scan; at least one is required. */
  roots: SkillRootInput[];
  /** Workspace directory; when given it must exist. Defaults from `cwd`/`home`. */
  workspace?: string;
  /** Current working directory used to resolve `workspace`; defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory used to expand `~`; defaults to the OS home. */
  home?: string;
  strict?: boolean;
  followSymlinks?: boolean;
  /** Receives non-fatal discovery warnings; defaults to stderr. */
  warningSink?: WarnSink;
  /**
   * Receives this package's structured diagnostic events; defaults to a no-op.
   *
   * @remarks Independent of {@link AgentSkillsOptions.warningSink}: the sink
   *   carries prose a host may show a user, this carries the fields an operator
   *   greps to answer why a skill is missing or why the wrong one won. A host
   *   that supplies neither gets today's behaviour exactly.
   */
  logger?: Logger;
}

/**
 * Resolve raw {@link AgentSkillsOptions} into a validated {@link SkillConfig},
 * expanding each root against the workspace and home directories and filling in
 * defaults.
 *
 * @param options - the caller's options; see {@link AgentSkillsOptions}.
 * @returns the resolved config ready to scan.
 * @throws {@link StartupError} if `roots` is empty, or if an explicit
 *   `workspace` does not exist or is not a directory.
 */
export function resolveConfig(options: AgentSkillsOptions): SkillConfig {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const workspaceDir = resolveWorkspaceDir(options.workspace, cwd, home);

  const logger = options.logger ?? NOOP_LOGGER;

  if (options.workspace !== undefined) {
    validateDir(workspaceDir, logger);
  }

  if (options.roots.length === 0) {
    throw new StartupError("createAgentSkills requires at least one root in options.roots");
  }
  if (options.roots.length > MAX_SKILL_ROOTS) {
    throw new StartupError(
      `createAgentSkills accepts at most ${String(MAX_SKILL_ROOTS)} roots ` +
        `(received ${String(options.roots.length)})`,
    );
  }

  return {
    home,
    workspaceDir,
    roots: options.roots.map((root) => normalizeRoot(root, workspaceDir, home)),
    strict: options.strict ?? DEFAULT_STRICT,
    followSymlinks: options.followSymlinks ?? DEFAULT_FOLLOW_SYMLINKS,
    warningSink: options.warningSink ?? defaultWarnSink,
    logger,
  };
}

/**
 * Expand one {@link SkillRootInput} to an absolute {@link SkillRoot}, resolving
 * its path against the workspace and home and defaulting `scope` to `workspace`
 * and `source` to the empty string.
 */
function normalizeRoot(input: SkillRootInput, workspaceDir: string, home: string): SkillRoot {
  const include = input.include === undefined ? undefined : normalizeInclude(input.include);
  const confinementRoot =
    input.confinementRoot === undefined
      ? undefined
      : resolveAgainst(workspaceDir, input.confinementRoot, home);
  const executionRoot =
    input.executionRoot === undefined
      ? undefined
      : resolveAgainst(workspaceDir, input.executionRoot, home);
  return {
    path: resolveAgainst(workspaceDir, input.path, home),
    scope: input.scope ?? "workspace",
    source: input.source ?? "",
    ...(include === undefined ? {} : { include }),
    ...(input.discovery === undefined ? {} : { discovery: input.discovery }),
    ...(input.manifestName === undefined ? {} : { manifestName: input.manifestName }),
    ...(input.validation === undefined ? {} : { validation: input.validation }),
    ...(confinementRoot === undefined ? {} : { confinementRoot }),
    ...(executionRoot === undefined ? {} : { executionRoot }),
  };
}

/** Validate, de-duplicate and sort one root's exact-name allow-list. */
function normalizeInclude(values: readonly string[]): readonly string[] {
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
      throw new StartupError("skill root include names must be non-empty, trimmed strings");
    }
    names.add(value);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * Assert that `dir` exists and is a directory.
 *
 * @throws {@link StartupError} if the path cannot be stat'd or is not a directory.
 * @remarks The thrown message says the workspace does not exist, which is the
 *   common case but not the only one: a permission denial reads identically. The
 *   underlying errno reaches the logger so the two are distinguishable.
 */
function validateDir(dir: string, logger: Logger): void {
  let stat;
  try {
    stat = statSync(dir);
  } catch (error) {
    logger.debug(
      { event: "skills.workspace.unreadable", path: dir, cause: causeOf(error) },
      "the configured workspace could not be inspected; skill discovery refuses to start",
    );
    throw new StartupError(`Workspace does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new StartupError(`Workspace is not a directory: ${dir}`);
  }
}
