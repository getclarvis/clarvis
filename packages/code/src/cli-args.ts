/**
 * The CLI surface as pure data: the flag table and everything derived from it.
 *
 * @remarks
 * Split out of `cli-mode.ts` so `cli.ts` can answer `--help` and `--version`
 * without loading the application. Its entire runtime graph is this file plus
 * the root product manifest; the `SessionId` import is type-only and `verbatimModuleSyntax`
 * erases it. **Keep it that way** - one convenience import here puts the whole
 * module graph back on the fast path, which is worth ~2.5 s a call, and
 * `tests/architecture/cli-fast-path.test.ts` is what notices.
 */
import product from "../../../package.json";
import type { SessionId } from "./adapters/session-store.ts";
import type { DiagnosticLevel } from "./core/diagnostic-events.ts";

/** Output shape for `--print`: `"text"` streams the reply as plain text; `"md"` renders the completed run as a markdown transcript. */
export type PrintFormat = "text" | "md";

/** What `--debug` on the command line asked for, before the environment is folded in. */
export interface DebugFlag {
  /** Whether `--debug` was present at all. */
  enabled: boolean;
  /** The level given as `--debug=<level>`, present only when one was written. */
  level?: DiagnosticLevel;
}

/** The diagnostics an invocation resolves to: whether to open a session, and its floor. */
export interface DebugRequest {
  enabled: boolean;
  level: DiagnosticLevel;
}

/** A launch-time request for a dedicated Git worktree. `true` asks Clarvis to name it. */
export type WorktreeRequest = true | string;

/** One SSH destination and canonical workspace selected by the operator. */
export interface RemoteWorkspaceRequest {
  destination: string;
  workspace: string;
}

interface ExtensionProfileMode {
  /** Extension Profile selected for this process, with CLI precedence. */
  extensionProfileSelector?: string;
}

interface WorkspaceMode extends ExtensionProfileMode {
  /** Resolve this invocation into a dedicated worktree before any host service boots. */
  worktree?: WorktreeRequest;
  /** Connect through process-owned SSH stdio instead of local workspace discovery. */
  remote?: RemoteWorkspaceRequest;
}

/** The parsed shape of a CLI invocation, one variant per mode {@link parseMode} can resolve `argv` to. */
export type Mode =
  | ({ kind: "run"; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "resume"; id: SessionId; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "continue"; ascii: boolean; debug: DebugFlag } & WorkspaceMode)
  | ({
      kind: "print";
      prompt: string;
      agent?: string;
      format: PrintFormat;
      debug: DebugFlag;
    } & WorkspaceMode)
  | ({ kind: "list"; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "delete"; id: SessionId; debug: DebugFlag } & WorkspaceMode)
  | ({ kind: "refresh-models"; debug: DebugFlag } & WorkspaceMode)
  | { kind: "update" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "usage-error"; message: string };

interface FlagSpec {
  /** Canonical token, e.g. "--resume". */
  flag: string;
  alias?: string;
  /** Metavar for a value-taking flag, e.g. "<session-id>" — consumes the next token. */
  value?: string;
  /**
   * Metavar for an *optional* value attached with `=`, e.g. `--debug=warn`.
   *
   * @remarks Distinct from {@link FlagSpec.value}, which consumes the next
   * token and is mandatory. A flag with an inline value is still legal bare.
   */
  inlineValue?: string;
  /** Optional value accepted either as the next token or after `=`. */
  optionalValue?: string;
  desc: string;
  /** Selects a whole invocation mode (at most one per invocation). */
  mode?: boolean;
}

/**
 * The single source of truth for the CLI surface: parsing, `--help`, the usage
 * line and the README synopsis all derive from this table.
 */
export const FLAGS: readonly FlagSpec[] = [
  { flag: "--help", alias: "-h", desc: "print this help and exit", mode: true },
  { flag: "--version", desc: "print the version and exit", mode: true },
  {
    flag: "--print",
    alias: "-p",
    value: "<prompt>",
    desc: "run the prompt headless: stream the reply to stdout, exit 0/1",
    mode: true,
  },
  { flag: "--agent", value: "<name>", desc: "agent to run --print as (default: entry agent)" },
  { flag: "--format", value: "<text|md>", desc: "--print output: text (default) or md transcript" },
  { flag: "--resume", value: "<session-id>", desc: "resume a saved session", mode: true },
  { flag: "--continue", desc: "resume this workspace's most recent session", mode: true },
  { flag: "--list", desc: "list saved sessions and exit", mode: true },
  { flag: "--delete", value: "<session-id>", desc: "delete a session and its runs", mode: true },
  { flag: "--refresh-models", desc: "refresh the models.dev catalog and exit", mode: true },
  { flag: "--update", desc: "install the newest eligible Clarvis release and exit", mode: true },
  { flag: "--ascii", desc: "render glyphs as plain ascii" },
  {
    flag: "--extension-profile",
    value: "<selector>",
    desc: "select an Extension Profile for this process (scope:name or name)",
  },
  {
    flag: "--worktree",
    optionalValue: "name",
    desc: "open a dedicated Git worktree; omit name to generate one",
  },
  {
    flag: "--remote",
    value: "<user@host>",
    desc: "connect to a Clarvis installation over SSH",
  },
  {
    flag: "--remote-workspace",
    value: "<path>",
    desc: "absolute workspace path on the remote host",
  },
  {
    flag: "--debug",
    desc: "write bounded application diagnostics; --debug=<level>",
    inlineValue: "<error|warn|info|debug>",
  },
];

/**
 * The environment equivalents of `--debug`, so a wrapper script or the tmux
 * harness can turn diagnostics on without editing argv.
 *
 * @remarks Named after the existing `CLARVIS_CODE_DEV` and
 * `CLARVIS_TUI_RSS_LIMIT_MB`, and read only here so nothing else in the package
 * has to know the spelling.
 */
export interface DebugEnv {
  readonly CLARVIS_CODE_DEBUG?: string | undefined;
  readonly CLARVIS_CODE_DEBUG_LEVEL?: string | undefined;
  readonly [name: string]: string | undefined;
}

/** The floor a session records at when nothing narrower is asked for. */
const DEFAULT_DEBUG_LEVEL: DiagnosticLevel = "debug";

/** Values of `CLARVIS_CODE_DEBUG` that mean "leave diagnostics off". */
const DEBUG_OFF = new Set(["", "0", "off", "false", "no"]);

/** The four levels a session can be tuned to, in the order `--help` lists them. */
const DEBUG_LEVELS = ["error", "warn", "info", "debug"] as const;

/**
 * Read one level name.
 *
 * @param raw - a candidate level from argv or the environment.
 * @returns the level, or `undefined` when `raw` is absent or names no level.
 */
function debugLevel(raw: string | undefined): DiagnosticLevel | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  return (DEBUG_LEVELS as readonly string[]).includes(value)
    ? (value as DiagnosticLevel)
    : undefined;
}

/**
 * Fold `--debug` together with `CLARVIS_CODE_DEBUG` / `CLARVIS_CODE_DEBUG_LEVEL`.
 *
 * @param mode - the parsed invocation; `--help` and `--version` never debug.
 * @param env - the environment, injected so this stays pure.
 * @returns whether to open a session, and the level it records at.
 * @remarks The flag wins in both directions: `--debug` on a shell carrying
 *   `CLARVIS_CODE_DEBUG=off` still opens a session, and `--debug=warn` still
 *   overrides `CLARVIS_CODE_DEBUG_LEVEL`. `CLARVIS_CODE_DEBUG=warn` both enables
 *   and tunes, so the common case needs one variable. An unrecognized level in
 *   the *environment* is ignored rather than refused — losing diagnostics to a
 *   typo in a wrapper script is worse than recording more than was asked for —
 *   while the same typo on the command line is a usage error, because a person
 *   typed it and is there to read the answer.
 */
export function resolveDebugRequest(mode: Mode, env: DebugEnv): DebugRequest {
  if (!("debug" in mode)) return { enabled: false, level: DEFAULT_DEBUG_LEVEL };
  const raw = env.CLARVIS_CODE_DEBUG;
  const fromEnv = raw !== undefined && !DEBUG_OFF.has(raw.trim().toLowerCase());
  const envLevel = debugLevel(env.CLARVIS_CODE_DEBUG_LEVEL) ?? debugLevel(raw);
  return {
    enabled: mode.debug.enabled || fromEnv,
    level: mode.debug.level ?? envLevel ?? DEFAULT_DEBUG_LEVEL,
  };
}

/** The metavar a flag carries in a synopsis, spaced or `=`-attached as it is written. */
function metavar(f: FlagSpec): string {
  if (f.value) return " " + f.value;
  if (f.optionalValue) return ` [${f.optionalValue}]`;
  return f.inlineValue ? "[=" + f.inlineValue + "]" : "";
}

/** Renders the one-line `usage: clarvis [...]` summary from {@link FLAGS}. */
export function usageText(): string {
  const parts = FLAGS.map((f) => `[${f.alias ?? f.flag}${metavar(f)}]`);
  return `usage: clarvis ${parts.join(" ")}`;
}

/** Renders the full `--help` text: banner, usage line and an aligned flag table, all derived from {@link FLAGS}. */
export function helpText(): string {
  const invocation = (f: FlagSpec): string =>
    `  ${f.alias ? f.alias + ", " : ""}${f.flag}${metavar(f)}`;
  const col = Math.max(...FLAGS.map((f) => invocation(f).length)) + 2;
  return [
    `clarvis ${product.version} — the Clarvis terminal UI`,
    "",
    usageText(),
    "",
    "Run without flags to start an interactive session in the current directory.",
    "",
    "flags:",
    ...FLAGS.map((f) => invocation(f).padEnd(col) + f.desc),
  ].join("\n");
}

/** Renders the `--version` output from the root-owned Clarvis product version. */
export function versionText(): string {
  return `clarvis ${productVersion()}`;
}

/** Return the root-owned product version for lazy CLI operations such as update. */
export function productVersion(): string {
  return product.version;
}

function noun(metavar: string): string {
  return metavar.replace(/[<>]/g, "").replace(/-/g, " ");
}

/**
 * Parses `argv` into a single {@link Mode}, validating flag combinations and
 * required values against {@link FLAGS}.
 *
 * @param argv - Arguments after the program name (e.g. `process.argv.slice(2)`).
 * @returns The resolved mode, or a `"usage-error"` mode describing the first
 * violation found (an unknown flag, a missing/invalid value, conflicting
 * modes, or a flag used outside the mode it applies to).
 */
export function parseMode(argv: string[]): Mode {
  const usageError = (message: string): Mode => ({ kind: "usage-error", message });
  const specOf = new Map<string, FlagSpec>();
  for (const s of FLAGS) {
    specOf.set(s.flag, s);
    if (s.alias) specOf.set(s.alias, s);
  }
  const seen = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("-")) continue;
    const split = tok.indexOf("=");
    if (split > 0) {
      const inline = specOf.get(tok.slice(0, split));
      if (inline?.inlineValue === undefined && inline?.optionalValue === undefined)
        return usageError(`unknown flag: ${tok}`);
      seen.set(inline.flag, tok.slice(split + 1));
      continue;
    }
    const spec = specOf.get(tok);
    if (!spec) return usageError(`unknown flag: ${tok}`);
    if (spec.value) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-"))
        return usageError(
          `${tok} requires a ${noun(spec.value)} (usage: clarvis ${spec.flag} ${spec.value})`,
        );
      seen.set(spec.flag, v);
      i++;
    } else if (spec.optionalValue) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("-")) {
        seen.set(spec.flag, value);
        i++;
      } else {
        seen.set(spec.flag, "");
      }
    } else {
      seen.set(spec.flag, "");
    }
  }

  if (seen.has("--help")) return { kind: "help" };
  if (seen.has("--version")) return { kind: "version" };

  const modes = FLAGS.filter((f) => f.mode && seen.has(f.flag)).map((f) => f.flag);
  if (modes.length > 1)
    return usageError(`${modes[0]} cannot be combined with ${modes.slice(1).join(", ")}`);
  const mode = modes[0];

  if (mode !== "--print" && (seen.has("--agent") || seen.has("--format")))
    return usageError(
      `${seen.has("--agent") ? "--agent" : "--format"} applies only with -p/--print`,
    );
  if (mode === "--update") {
    const incompatible = [
      "--ascii",
      "--worktree",
      "--remote",
      "--remote-workspace",
      "--extension-profile",
      "--debug",
    ].find((flag) => seen.has(flag));
    if (incompatible !== undefined) {
      return usageError(`${incompatible} does not apply with --update`);
    }
  }

  const ascii = seen.has("--ascii");
  const rawDebugLevel = seen.get("--debug");
  const debugFlagLevel = debugLevel(rawDebugLevel);
  if (rawDebugLevel !== undefined && rawDebugLevel !== "" && debugFlagLevel === undefined)
    return usageError(`--debug must be one of ${DEBUG_LEVELS.join(", ")}, got: ${rawDebugLevel}`);
  const debug: DebugFlag = {
    enabled: seen.has("--debug"),
    ...(debugFlagLevel === undefined ? {} : { level: debugFlagLevel }),
  };
  const rawWorktree = seen.get("--worktree");
  const remoteDestination = seen.get("--remote");
  const remoteWorkspace = seen.get("--remote-workspace");
  if ((remoteDestination === undefined) !== (remoteWorkspace === undefined))
    return usageError("--remote and --remote-workspace must be provided together");
  if (rawWorktree !== undefined && remoteDestination !== undefined)
    return usageError("--worktree cannot be combined with --remote");
  const extensionProfileSelector = seen.get("--extension-profile");
  const selectedWorkspace: WorkspaceMode =
    rawWorktree === undefined &&
    remoteDestination === undefined &&
    extensionProfileSelector === undefined
      ? {}
      : {
          ...(rawWorktree === undefined
            ? {}
            : { worktree: rawWorktree === "" ? true : rawWorktree }),
          ...(extensionProfileSelector === undefined ? {} : { extensionProfileSelector }),
          ...(remoteDestination === undefined
            ? {}
            : { remote: { destination: remoteDestination, workspace: remoteWorkspace! } }),
        };
  switch (mode) {
    case "--print": {
      const prompt = seen.get("--print")!;
      if (prompt.trim() === "") return usageError("-p/--print requires a non-empty prompt");
      const format = seen.get("--format") ?? "text";
      if (format !== "text" && format !== "md")
        return usageError(`--format must be text or md, got: ${format}`);
      const agent = seen.get("--agent");
      return {
        kind: "print",
        prompt,
        ...(agent !== undefined ? { agent } : {}),
        format,
        debug,
        ...selectedWorkspace,
      };
    }
    case "--resume":
      return { kind: "resume", id: seen.get("--resume")!, ascii, debug, ...selectedWorkspace };
    case "--continue":
      return { kind: "continue", ascii, debug, ...selectedWorkspace };
    case "--list":
      return { kind: "list", debug, ...selectedWorkspace };
    case "--delete":
      return { kind: "delete", id: seen.get("--delete")!, debug, ...selectedWorkspace };
    case "--refresh-models":
      return {
        kind: "refresh-models",
        debug,
        ...selectedWorkspace,
      };
    case "--update":
      return { kind: "update" };
    default:
      return { kind: "run", ascii, debug, ...selectedWorkspace };
  }
}
