import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./lib/log.ts";
import type { Guard, Elicit } from "./guard/types.ts";
import { discoverLinkedGitMetadataPaths, type SandboxConfig } from "./sandbox.ts";
import { resolveCommand, workspaceStatePaths } from "@clarvis/paths";

/**
 * The fully resolved, validated runtime configuration threaded through every
 * tool handler. Produced by {@link resolveConfig}; all numeric limits are
 * already clamped to their minimums and all
 * capability probes have been run, so handlers may consume it as-is.
 */
export interface RuntimeConfig {
  /** Absolute path of the workspace root; all relative paths resolve under it. */
  workspaceRoot: string;

  /** Maximum bytes of text a non-`bounded` tool result may return before truncation. */
  maxOutputBytes: number;

  /** Maximum bytes of captured stdout/stderr the shell tool may return. */
  maxShellOutputBytes: number;

  /** Maximum size in bytes of a file the read tools will load. */
  maxFileBytes: number;

  /** Maximum size in bytes of an image the image-read tool will load. */
  maxImageBytes: number;

  /** Maximum filesystem entries one discovery call may retain; a scanner may inspect N+1 solely to prove truncation. */
  maxTraversalEntries: number;

  /** Maximum aggregate replacement payload retained before an atomic write. */
  maxMutationBytes: number;

  /** Maximum combined input bytes handed to the in-process diff algorithm. */
  maxDiffInputBytes: number;

  /** Maximum serialized bytes retained in tool metadata. */
  maxToolMetaBytes: number;

  /** Default shell timeout in milliseconds when a call names none. */
  shellTimeoutMs: number;

  /** Hard ceiling in milliseconds a per-call shell timeout may request. */
  shellTimeoutMaxMs: number;

  /** How long, in milliseconds, to wait for a background monitor's ready marker. */
  monitorReadyTimeoutMs: number;

  /** Maximum number of concurrently running background monitors. */
  maxMonitors: number;

  /**
   * Milliseconds of regular-expression time one in-process scan may spend
   * before it stops applying the pattern.
   *
   * @remarks
   * Charged by `grep`'s in-process fallback and by `replace` (which has no
   * ripgrep path in any deployment) through
   * {@link "./lib/scan-budget.js" | createScanBudget}. It bounds a
   * catastrophically backtracking user pattern, which would otherwise freeze
   * the single-threaded host for as long as the scope takes to walk; see that
   * module for the measurements and for why a pattern-length cap does not
   * substitute. Never charged for disk or directory-walk time, so machine load
   * cannot trip it.
   */
  regexScanBudgetMs: number;

  /** Whether `rg` (ripgrep) was found on `PATH`; enables the fast grep path. */
  ripgrepAvailable: boolean;

  /** When true, only the read-only tool surface is exposed (no mutations). */
  readOnly: boolean;

  /** When true, tool paths are confined to {@link RuntimeConfig.workspaceRoot}. */
  confineToWorkspace: boolean;

  /**
   * The per-workspace state root holding monitor sidecars and output spills.
   *
   * @remarks Outside the working tree by design — a repository is not where
   * generated bookkeeping belongs — which is why the read tools must be told
   * about it: a spilled tool result the model is handed a path to would
   * otherwise fail {@link RuntimeConfig.confineToWorkspace} on the way back in.
   * Read-only: nothing that mutates consults it.
   */
  stateRoot: string;

  /** Run-owned scratch roots admitted in addition to the workspace. */
  temporaryRoots: readonly string[];

  /** Immutable linked-worktree metadata roots pinned before the agent can mutate the workspace. */
  gitMetadataPaths: readonly string[];

  /** Admit one verified scratch root discovered after this toolset started. */
  registerTemporaryRoot(root: string): void;

  /**
   * Where this toolset reports what its machinery did.
   *
   * @remarks
   * Required rather than optional: {@link resolveConfig} always fills it (with
   * {@link NOOP_TOOLS_LOGGER} when the host supplied none), so no call site
   * pays an optional-chaining branch. It is per-toolset on purpose — the
   * process-wide {@link "./lib/log.js" | WarnSink} exists only for the three
   * sites that cannot reach a config.
   */
  readonly logger: ToolsLogger;

  /** Optional command-approval hook consulted before a gated tool runs. */
  guard?: Guard;

  /** Optional interactive prompt invoked when the {@link Guard} returns `ask`. */
  elicit?: Elicit;
  /** Optional sandbox settings for isolating spawned commands. */
  sandbox?: SandboxConfig;
  /**
   * Environment variable names holding credentials, withheld from every command
   * this toolset spawns.
   *
   * @remarks
   * The agent controls the text of the commands it runs, so an unscrubbed
   * environment makes every API key on the host one `printenv` away — and a
   * command that exfiltrates one is indistinguishable from a command that
   * legitimately reads its environment. Under a native sandbox this is
   * redundant (the child's environment is built from nothing); it is the bare
   * path on an unsupported host or explicit optional fallback that needs it.
   */
  secretEnvNames?: readonly string[];
}

/** Default {@link RuntimeConfig.maxOutputBytes} (128 KiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 131072;
/** Default {@link RuntimeConfig.maxShellOutputBytes} (16 KiB). */
export const DEFAULT_MAX_SHELL_OUTPUT_BYTES = 16384;
/** Default {@link RuntimeConfig.maxFileBytes} (20 MB). */
export const DEFAULT_MAX_FILE_BYTES = 20_000_000;
/** Default {@link RuntimeConfig.maxImageBytes} (5 MB). */
export const DEFAULT_MAX_IMAGE_BYTES = 5_000_000;
/** Default filesystem traversal ceiling (50,000 entries). */
export const DEFAULT_MAX_TRAVERSAL_ENTRIES = 50_000;
/** Default aggregate atomic mutation ceiling (64 MiB). */
export const DEFAULT_MAX_MUTATION_BYTES = 64 * 1024 * 1024;
/** Default combined diff input ceiling (8 MiB). */
export const DEFAULT_MAX_DIFF_INPUT_BYTES = 8 * 1024 * 1024;
/** Default structured metadata ceiling (256 KiB). */
export const DEFAULT_MAX_TOOL_META_BYTES = 256 * 1024;
/** Default {@link RuntimeConfig.shellTimeoutMs} (120 s). */
export const DEFAULT_SHELL_TIMEOUT_MS = 120000;
/** Default {@link RuntimeConfig.shellTimeoutMaxMs} ceiling (600 s). */
export const DEFAULT_SHELL_TIMEOUT_MAX_MS = 600000;
/** Default {@link RuntimeConfig.monitorReadyTimeoutMs} (30 s). */
export const DEFAULT_MONITOR_READY_TIMEOUT_MS = 30000;
/** Default {@link RuntimeConfig.maxMonitors} (32). */
export const DEFAULT_MAX_MONITORS = 32;
/**
 * Default {@link RuntimeConfig.regexScanBudgetMs} (5 s).
 *
 * @remarks
 * Puts the worst case at the budget plus one in-flight application — roughly
 * seven seconds on a JavaScriptCore host — against the hours an unbounded scan
 * costs, while leaving roughly a thousandfold margin over the regex time a
 * legitimate scan actually spends (a plain pattern over 200,000 lines charges
 * 5-7 ms).
 */
export const DEFAULT_REGEX_SCAN_BUDGET_MS = 5000;
const MIN_OUTPUT_BYTES = 1024;
const MIN_FILE_BYTES = 1024;

/**
 * Thrown when configuration cannot be resolved: a missing/invalid workspace
 * root, an unparseable env var or flag, or a limit below its minimum. Signals
 * that startup must abort rather than continue with a degraded config.
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

function probeRipgrep(): boolean {
  try {
    const res = spawnSync(resolveCommand("rg"), ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

function runProbe(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

function validateWorkspace(rawRoot: string): string {
  const workspaceRoot = path.resolve(rawRoot);
  let stat;
  try {
    stat = statSync(workspaceRoot);
  } catch {
    throw new StartupError(`Workspace root does not exist: ${workspaceRoot}`);
  }
  if (!stat.isDirectory()) {
    throw new StartupError(`Workspace root is not a directory: ${workspaceRoot}`);
  }
  return workspaceRoot;
}

function requireMin(n: number, min: number, name: string): number {
  if (!Number.isSafeInteger(n) || n < min) {
    throw new StartupError(`${name} must be an integer >= ${min}, got: ${String(n)}`);
  }
  return n;
}

function assertTimeoutOrder(min: number, max: number, minLabel: string, maxLabel: string): void {
  if (max < min) {
    throw new StartupError(`${maxLabel} (${max}) must be >= ${minLabel} (${min}).`);
  }
}

/**
 * Caller-facing options for building a {@link RuntimeConfig}. Only
 * `workspaceRoot` is required; every other field falls back to its `DEFAULT_*`
 * constant (limits) or a safe default (`readOnly` false, `confineToWorkspace`
 * true) inside {@link resolveConfig}.
 */
export interface AgentToolsOptions {
  /** The workspace root; validated to exist and be a directory. */
  workspaceRoot: string;

  /** Expose only the read-only tool surface. Defaults to false. */
  readOnly?: boolean;

  /** Confine tool paths to the workspace. Defaults to true. */
  confineToWorkspace?: boolean;
  /** Existing run-owned scratch roots available to every tool in this toolset. */
  temporaryRoots?: readonly string[];
  /** Host lifecycle hook for a scratch root verified after a shell call. */
  onTemporaryRootRegistered?: (root: string) => void;

  /** Override {@link RuntimeConfig.maxOutputBytes} (min 1024). */
  maxOutputBytes?: number;

  /** Override {@link RuntimeConfig.maxShellOutputBytes} (min 1024). */
  maxShellOutputBytes?: number;

  /** Override {@link RuntimeConfig.maxFileBytes} (min 1024). */
  maxFileBytes?: number;

  /** Override {@link RuntimeConfig.maxImageBytes} (min 1024). */
  maxImageBytes?: number;

  /** Override {@link RuntimeConfig.maxTraversalEntries} (min 1). */
  maxTraversalEntries?: number;

  /** Override {@link RuntimeConfig.maxMutationBytes} (min 1024). */
  maxMutationBytes?: number;

  /** Override {@link RuntimeConfig.maxDiffInputBytes} (min 1024). */
  maxDiffInputBytes?: number;

  /** Override {@link RuntimeConfig.maxToolMetaBytes} (min 1024). */
  maxToolMetaBytes?: number;

  /** Override the default shell timeout (min 1). */
  shellTimeoutMs?: number;

  /** Override the shell timeout ceiling (min 1); must be >= `shellTimeoutMs`. */
  shellTimeoutMaxMs?: number;

  /** Override the monitor ready-marker timeout (min 1). */
  monitorReadyTimeoutMs?: number;

  /** Override the maximum concurrent monitors (min 1). */
  maxMonitors?: number;

  /** Override {@link RuntimeConfig.regexScanBudgetMs} (min 1). */
  regexScanBudgetMs?: number;

  /** Injectable ripgrep probe (for tests); defaults to spawning `rg --version`. */
  probeRipgrep?: () => boolean;

  /**
   * Where the resolved toolset reports what its machinery did; defaults to
   * {@link NOOP_TOOLS_LOGGER}.
   *
   * @remarks Optional here, and only here: `createAgentTools({ workspaceRoot })`
   *   is this package's headline example and must keep working.
   */
  logger?: ToolsLogger;

  /** Command-approval hook passed through to {@link RuntimeConfig.guard}. */
  guard?: Guard;

  /** Interactive approval prompt passed through to {@link RuntimeConfig.elicit}. */
  elicit?: Elicit;
  /** Sandbox settings passed through to {@link RuntimeConfig.sandbox}. */
  sandbox?: SandboxConfig;
  /** Secret names passed through to {@link RuntimeConfig.secretEnvNames}. */
  secretEnvNames?: readonly string[];
}

/**
 * Resolve a caller-supplied {@link AgentToolsOptions} into a validated
 * {@link RuntimeConfig}: validate the workspace, clamp every limit to its
 * minimum, order-check the shell timeouts, and run the ripgrep probe to fill
 * the capability flag.
 *
 * @param options - the caller options; only `workspaceRoot` is required.
 * @returns the fully resolved runtime config.
 * @throws {@link StartupError} when `workspaceRoot` is missing, does not exist,
 *   or is not a directory; when any limit falls below its minimum; or when
 *   `shellTimeoutMaxMs` is less than `shellTimeoutMs`.
 * @remarks Probe failures never throw - a throwing probe is treated as the
 *   capability being absent (see {@link RuntimeConfig.ripgrepAvailable}).
 */
export function resolveConfig(options: AgentToolsOptions): RuntimeConfig {
  if (!options.workspaceRoot) {
    throw new StartupError("No workspace root: options.workspaceRoot is required.");
  }
  const workspaceRoot = validateWorkspace(options.workspaceRoot);
  const gitMetadataPaths = discoverLinkedGitMetadataPaths(workspaceRoot);
  const logger = options.logger ?? NOOP_TOOLS_LOGGER;

  const shellTimeoutMs = requireMin(
    options.shellTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
    1,
    "shellTimeoutMs",
  );
  const shellTimeoutMaxMs = requireMin(
    options.shellTimeoutMaxMs ?? DEFAULT_SHELL_TIMEOUT_MAX_MS,
    1,
    "shellTimeoutMaxMs",
  );
  assertTimeoutOrder(shellTimeoutMs, shellTimeoutMaxMs, "shellTimeoutMs", "shellTimeoutMaxMs");

  const ripgrepAvailable = runProbe(options.probeRipgrep ?? probeRipgrep);
  const readOnly = options.readOnly ?? false;
  const confineToWorkspace = options.confineToWorkspace ?? true;
  const temporaryRoots = (options.temporaryRoots ?? []).map((root) => {
    const resolved = path.resolve(root);
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      throw new StartupError(`Temporary root does not exist: ${resolved}`);
    }
    if (!stat.isDirectory())
      throw new StartupError(`Temporary root is not a directory: ${resolved}`);
    return resolved;
  });
  const registerTemporaryRoot = (root: string): void => {
    const resolved = path.resolve(root);
    const linkStat = lstatSync(resolved);
    if (linkStat.isSymbolicLink())
      throw new StartupError(`Temporary root must not be a symbolic link: ${resolved}`);
    const canonical = realpathSync(resolved);
    const stat = statSync(canonical);
    if (!stat.isDirectory())
      throw new StartupError(`Temporary root is not a directory: ${resolved}`);
    if (!temporaryRoots.includes(canonical)) {
      temporaryRoots.push(canonical);
      options.onTemporaryRootRegistered?.(canonical);
    }
  };

  logger.debug(
    {
      event: "tools.config_resolved",
      ripgrep: ripgrepAvailable,
      sandbox_mode: options.sandbox?.type ?? "none",
      sandbox_availability: options.sandbox?.availability ?? null,
      read_only: readOnly,
      confined: confineToWorkspace,
      platform: process.platform,
    },
    "the coding toolset resolved its configuration; these flags decide the surface it advertises",
  );

  return {
    workspaceRoot,
    logger,
    maxOutputBytes: requireMin(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      MIN_OUTPUT_BYTES,
      "maxOutputBytes",
    ),
    maxShellOutputBytes: requireMin(
      options.maxShellOutputBytes ?? DEFAULT_MAX_SHELL_OUTPUT_BYTES,
      MIN_OUTPUT_BYTES,
      "maxShellOutputBytes",
    ),
    maxFileBytes: requireMin(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      MIN_FILE_BYTES,
      "maxFileBytes",
    ),
    maxImageBytes: requireMin(
      options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      MIN_FILE_BYTES,
      "maxImageBytes",
    ),
    maxTraversalEntries: requireMin(
      options.maxTraversalEntries ?? DEFAULT_MAX_TRAVERSAL_ENTRIES,
      1,
      "maxTraversalEntries",
    ),
    maxMutationBytes: requireMin(
      options.maxMutationBytes ?? DEFAULT_MAX_MUTATION_BYTES,
      MIN_FILE_BYTES,
      "maxMutationBytes",
    ),
    maxDiffInputBytes: requireMin(
      options.maxDiffInputBytes ?? DEFAULT_MAX_DIFF_INPUT_BYTES,
      MIN_FILE_BYTES,
      "maxDiffInputBytes",
    ),
    maxToolMetaBytes: requireMin(
      options.maxToolMetaBytes ?? DEFAULT_MAX_TOOL_META_BYTES,
      MIN_OUTPUT_BYTES,
      "maxToolMetaBytes",
    ),
    shellTimeoutMs,
    shellTimeoutMaxMs,
    monitorReadyTimeoutMs: requireMin(
      options.monitorReadyTimeoutMs ?? DEFAULT_MONITOR_READY_TIMEOUT_MS,
      1,
      "monitorReadyTimeoutMs",
    ),
    maxMonitors: requireMin(options.maxMonitors ?? DEFAULT_MAX_MONITORS, 1, "maxMonitors"),
    regexScanBudgetMs: requireMin(
      options.regexScanBudgetMs ?? DEFAULT_REGEX_SCAN_BUDGET_MS,
      1,
      "regexScanBudgetMs",
    ),
    ripgrepAvailable,
    readOnly,
    confineToWorkspace,
    stateRoot: workspaceStatePaths(workspaceRoot).root,
    temporaryRoots,
    gitMetadataPaths,
    registerTemporaryRoot,
    guard: options.guard,
    elicit: options.elicit,
    sandbox: options.sandbox,
    secretEnvNames: options.secretEnvNames,
  };
}

/** Internal compatibility for tests that import this private module directly. */
export type ServerConfig = RuntimeConfig;
