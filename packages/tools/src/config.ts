import { ExecutionSessionManager } from "./lib/execution-session.ts";
import { statSync } from "node:fs";
import path from "node:path";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./lib/log.ts";
import { workspaceStatePaths, type WorkspaceStatePaths } from "@clarvis/paths";
import type { ToolIsolationBackend, ToolIsolationPolicy } from "./execution/isolation-port.ts";
import type { ToolExecutionPort } from "./execution/port.ts";
import type { ToolAction } from "./execution/action.ts";

/** Structural host port; tools never imports a reviewer or policy package. */
export interface ToolActionAuthorization {
  authorize(
    request: {
      identity: {
        owner: string;
        executionId: string;
        actor: string;
        callId: string;
        attempt: number;
      };
      tool: string;
      arguments: Readonly<Record<string, unknown>>;
      command?: string;
      shell?: string;
      cwd?: string;
      environment?: Readonly<Record<string, string>>;
      paths?: readonly string[];
      requestedProfile: "host" | "sandbox";
      effectiveProfile: "host" | "sandbox";
      permissions?: ToolAction["permissions"];
      reason: string;
      policyRevision: string;
      authorizationRevision: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    granted: boolean;
    fingerprint: string;
    evidence: {
      reason: string;
      decision: string;
      source: string;
      requestedProfile: "host" | "sandbox";
      effectiveProfile: "host" | "sandbox";
      executionStarted: boolean;
    };
    permissions?: ToolAction["permissions"];
  }>;
  valid(
    request: Parameters<ToolActionAuthorization["authorize"]>[0],
    decision: Awaited<ReturnType<ToolActionAuthorization["authorize"]>>,
  ): boolean;
  recordAttempt?(
    request: Parameters<ToolActionAuthorization["authorize"]>[0],
    phase: "admitted" | "started" | "settled" | "uncertain",
    backend?: "host" | "bubblewrap" | "seatbelt",
    effectiveProfile?: "host" | "sandbox",
  ): void;
  revision(): number;
  policyRevision: string;
}

/**
 * The fully resolved, validated runtime configuration threaded through every
 * tool handler. Produced by {@link resolveConfig}; all numeric limits are
 * already clamped to their minimums and all
 * capability probes have been run, so handlers may consume it as-is.
 */
export interface RuntimeConfig {
  readonly actionValid?: () => boolean;
  readonly actionStarted?: (backend: "host" | "bubblewrap" | "seatbelt") => void;
  readonly actionAuthorization?: ToolActionAuthorization;
  readonly actionIdentity?: { readonly owner: string; readonly executionId: string };
  readonly selectAuthorizedExecution?: (permissions: ToolAction["permissions"] | undefined) => {
    executionPort: ToolExecutionPort;
    executionPolicy?: ToolIsolationPolicy;
    sandboxBackend?: ToolIsolationBackend;
  };
  /** Optional trusted execution port; absent preserves the in-process Host handler. */
  readonly executionPort?: ToolExecutionPort;
  /** Host-built process boundary applied to new shell sessions. */
  readonly executionPolicy?: ToolIsolationPolicy;
  /** Platform implementation for a sandbox policy; never selected by tool arguments. */
  readonly sandboxBackend?: ToolIsolationBackend;
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

  /** Maximum number of command sessions retained by this run. */
  maxSessions: number;

  /**
   * Milliseconds of regular-expression time one in-process scan may spend
   * before it stops applying the pattern.
   *
   * @remarks
   * Charged by shell readiness matching through
   * {@link "./lib/scan-budget.js" | createScanBudget}. It bounds a
   * catastrophically backtracking user pattern, which would otherwise freeze
   * the single-threaded host for as long as the scope takes to walk; see that
   * module for the measurements and for why a pattern-length cap does not
   * substitute. Never charged for disk or directory-walk time; scheduler time
   * spent while a regex application is in flight remains part of that
   * application's elapsed cost.
   */
  regexScanBudgetMs: number;

  /** When true, only the read-only tool surface is exposed (no mutations). */
  readOnly: boolean;

  /**
   * The per-workspace state root holding bounded output spills and other tool state.
   *
   * @remarks Outside the working tree by design — a repository is not where
   * generated bookkeeping belongs. Tool reads use ordinary host filesystem
   * permissions for this tree.
   */
  stateRoot: string;

  /** Host-resolved machinery paths, shared by writes, reads and housekeeping. */
  statePaths: WorkspaceStatePaths;

  /** Ordered writable temporary roots admitted in addition to the workspace; first is primary. */
  temporaryRoots: readonly string[];
  /** Unforgeable identity of this toolset's agent within its session manager. */
  sessionAgent: object;
  /** Run-owned authority for shell command processes. */
  sessionManager: ExecutionSessionManager;

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

  /**
   * Environment variable names holding credentials, withheld from every command
   * this toolset spawns.
   *
   * @remarks
   * The agent controls the text of the commands it runs, so an unscrubbed
   * environment makes every API key on the host one `printenv` away — and a
   * command that exfiltrates one is indistinguishable from a command that
   * legitimately reads its environment. Host commands subtract these names
   * from their inherited environment.
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
/** Default {@link RuntimeConfig.maxSessions} (32). */
export const DEFAULT_MAX_SESSIONS = 32;
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
 * constant (limits) or a safe default (`readOnly` false) inside {@link resolveConfig}.
 */
export interface AgentToolsOptions {
  actionAuthorization?: ToolActionAuthorization;
  actionIdentity?: RuntimeConfig["actionIdentity"];
  selectAuthorizedExecution?: RuntimeConfig["selectAuthorizedExecution"];
  /** Trusted port for validated native tool operations. */
  executionPort?: ToolExecutionPort;
  /** Trusted process policy for commands. Defaults to existing Host behavior. */
  executionPolicy?: ToolIsolationPolicy;
  /** Native backend for sandboxed commands. */
  sandboxBackend?: ToolIsolationBackend;
  /** The workspace root; validated to exist and be a directory. */
  workspaceRoot: string;
  /** Trusted composition port; omitted paths use the ordinary process roots. */
  statePaths?: WorkspaceStatePaths;

  /** Expose only the read-only tool surface. Defaults to false. */
  readOnly?: boolean;

  /** Existing writable temporary roots available to every tool; first supplies the command env. */
  temporaryRoots?: readonly string[];
  /** Agent identity for sessions; standalone toolsets get a private token. */
  sessionAgent?: object;
  /** Host-owned command sessions; standalone configs receive a private closable manager. */
  sessionManager?: ExecutionSessionManager;

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

  /** Override the maximum retained command sessions (min 1). */
  maxSessions?: number;

  /** Override {@link RuntimeConfig.regexScanBudgetMs} (min 1). */
  regexScanBudgetMs?: number;

  /**
   * Where the resolved toolset reports what its machinery did; defaults to
   * {@link NOOP_TOOLS_LOGGER}.
   *
   * @remarks Optional here, and only here: `createAgentTools({ workspaceRoot })`
   *   is this package's headline example and must keep working.
   */
  logger?: ToolsLogger;

  /** Secret names passed through to {@link RuntimeConfig.secretEnvNames}. */
  secretEnvNames?: readonly string[];
}

/**
 * Resolve a caller-supplied {@link AgentToolsOptions} into a validated
 * {@link RuntimeConfig}: validate the workspace, clamp every limit to its
 * minimum and order-check the shell timeouts.
 *
 * @param options - the caller options; only `workspaceRoot` is required.
 * @returns the fully resolved runtime config.
 * @throws {@link StartupError} when `workspaceRoot` is missing, does not exist,
 *   or is not a directory; when any limit falls below its minimum; or when
 *   `shellTimeoutMaxMs` is less than `shellTimeoutMs`.
 */
export function resolveConfig(options: AgentToolsOptions): RuntimeConfig {
  if (!options.workspaceRoot) {
    throw new StartupError("No workspace root: options.workspaceRoot is required.");
  }
  if (
    options.executionPolicy?.mode === "sandbox" &&
    (!options.executionPort || !options.sandboxBackend)
  ) {
    throw new StartupError("Sandbox execution requires both a native tool port and backend.");
  }
  const workspaceRoot = validateWorkspace(options.workspaceRoot);
  const statePaths = Object.freeze({
    ...(options.statePaths ?? workspaceStatePaths(workspaceRoot)),
  });
  if (path.resolve(statePaths.workspaceRoot) !== workspaceRoot)
    throw new StartupError("Tool state paths belong to another workspace.");
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

  const readOnly = options.readOnly ?? false;
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
  logger.debug(
    {
      event: "tools.config_resolved",
      read_only: readOnly,
      platform: process.platform,
    },
    "the coding toolset resolved its configuration; these flags decide the surface it advertises",
  );

  return {
    workspaceRoot,
    actionAuthorization: options.actionAuthorization,
    actionIdentity: options.actionIdentity,
    selectAuthorizedExecution: options.selectAuthorizedExecution,
    executionPort: options.executionPort,
    executionPolicy: options.executionPolicy,
    sandboxBackend: options.sandboxBackend,
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
    maxSessions: requireMin(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 1, "maxSessions"),
    regexScanBudgetMs: requireMin(
      options.regexScanBudgetMs ?? DEFAULT_REGEX_SCAN_BUDGET_MS,
      1,
      "regexScanBudgetMs",
    ),
    readOnly,
    stateRoot: statePaths.root,
    statePaths,
    temporaryRoots,
    sessionAgent: options.sessionAgent ?? {},
    sessionManager: options.sessionManager ?? new ExecutionSessionManager(),
    secretEnvNames: options.secretEnvNames,
  };
}

/** Internal compatibility for tests that import this private module directly. */
export type ServerConfig = RuntimeConfig;
