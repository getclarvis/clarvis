import type { RuntimeConfig } from "../config.ts";
import { isAbsolute, posix, win32 } from "node:path";
import { analyzeShell } from "./analyze-shell.ts";
import type { ShellDialect } from "./dialect.ts";
import { currentDialect } from "./dialects/index.ts";
import { resolveCandidate, patchPaths } from "./paths.ts";
import type { ShellFacts, GuardContext, PathFact } from "./types.ts";
import { readableStateArtifactPath } from "../lib/state-artifacts.ts";
import { stripWindowsExecutableSuffix, systemExecutableRoots } from "../lib/system-executables.ts";

const COMMAND_TOOLS = new Set(["shell", "monitor_start"]);
const PATH_ARG_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "read_image",
  "list_dir",
  "glob",
  "grep",
  "file_stat",
  "tree",
  "mkdir",
  "remove",
]);
const SRC_DEST_TOOLS = new Set(["move", "copy"]);
const READ_ONLY_PATH_TOOLS = new Set(["read_file"]);

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

function resolveReadOnlyPath(
  raw: string,
  root: string,
  config: RuntimeConfig,
  shell = false,
): PathFact {
  const resolved = resolveCandidate(raw, root, { shell }).resolved;
  const artifact = readableStateArtifactPath(resolved, config.stateRoot);
  const alsoAllow =
    artifact === undefined ? config.temporaryRoots : [...config.temporaryRoots, artifact];
  return resolveCandidate(raw, root, { shell, alsoAllow });
}

/**
 * One path occurrence in one analyzed command segment.
 *
 * @remarks `commandHead` is occurrence-local. The same raw path can therefore
 * be an admitted executable in one segment and an external operand in another.
 */
interface CommandPathOccurrence {
  raw: string;
  segmentIndex: number;
  commandHead: boolean;
}

/** Rebuild the analyzer's path facts without discarding duplicate occurrences. */
function commandPathOccurrences(shell: ShellFacts, dialect: ShellDialect): CommandPathOccurrence[] {
  const occurrences: CommandPathOccurrence[] = [];
  shell.segments.forEach((segment, segmentIndex) => {
    let headClaimed = false;
    for (const token of dialect.tokenize(segment.command)) {
      const candidate = dialect.pathCandidate(token);
      if (candidate.kind !== "path" && candidate.kind !== "prefix") continue;
      const commandHead =
        !headClaimed && candidate.kind === "path" && candidate.value === segment.argv[0];
      if (commandHead) headClaimed = true;
      occurrences.push({ raw: candidate.value, segmentIndex, commandHead });
    }
  });
  return occurrences;
}

/**
 * Find the absolute command head in each segment that the sandbox exposes
 * through a platform/runtime root.
 *
 * @remarks The map is keyed by segment, never by raw path. An identical path in
 * an operand position receives no exemption. The first resolution deliberately
 * excludes executable roots, so an absolute workspace script remains an
 * ordinary workspace path.
 */
function externalExecutableHeads(
  shell: ShellFacts,
  config: RuntimeConfig,
): ReadonlyMap<number, string> {
  const executableRoots = [...systemExecutableRoots(), ...(config.sandbox?.runtimePaths ?? [])];
  const heads = new Map<number, string>();
  shell.segments.forEach((segment, segmentIndex) => {
    const executable = segment.argv[0];
    if (executable === undefined || !isAbsolute(executable)) return;
    const workspace = resolveCandidate(executable, config.workspaceRoot, { shell: true });
    if (workspace.withinWorkspace) return;
    const admitted = resolveCandidate(executable, config.workspaceRoot, {
      shell: true,
      alsoAllow: executableRoots,
    });
    if (admitted.withinWorkspace) heads.set(segmentIndex, executable);
  });
  return heads;
}

/** The command name used by allow/deny policy for one absolute executable. */
function executablePolicyName(executable: string, dialect: ShellDialect): string {
  if (dialect.flavor === "powershell") {
    return stripWindowsExecutableSuffix(win32.basename(executable));
  }
  return posix.basename(executable);
}

/**
 * Preserve exact argv for review while matching allow/deny entries against the
 * executable's command name, just as a PATH-resolved spelling would.
 */
function normalizeExternalExecutables(
  shell: ShellFacts,
  executables: ReadonlyMap<number, string>,
  dialect: ShellDialect,
): ShellFacts {
  if (executables.size === 0) return shell;
  return {
    ...shell,
    segments: shell.segments.map((segment, segmentIndex) => {
      const executable = segment.argv[0];
      if (executable === undefined || executables.get(segmentIndex) !== executable) return segment;
      return {
        ...segment,
        normalized: [executablePolicyName(executable, dialect), ...segment.argv.slice(1)].join(" "),
      };
    }),
  };
}

/**
 * Assemble the {@link GuardContext} for a tool call by extracting the paths it
 * touches (and, for command tools, the {@link ShellFacts}) from its raw args.
 *
 * @param tool - the tool name, which selects how args are interpreted.
 * @param args - the raw tool arguments.
 * @param config - the active server config, whose `workspaceRoot` anchors path
 *   resolution.
 * @param dialect - the shell syntax command tools are analyzed as. Must match
 *   the shell the host actually runs them through.
 * @returns a {@link GuardContext} carrying the resolved {@link PathFact}s and,
 *   when applicable, the analyzed shell facts.
 * @remarks
 * Each tool family reads its own arg shape: command tools (`shell`,
 * `monitor_start`) analyze `command` and add `cwd`; `apply_patch` mines the
 * patch text; `move`/`copy` take `source`/`destination`; `read_files` a `paths`
 * array; `diff` a `from`/`to` pair; `replace` a `path` scope (defaulting to
 * `.`); and the remaining path tools a single `path`. Command paths are
 * resolved with shell semantics (tilde expansion). An unrecognized tool yields
 * a context with no paths and no shell facts.
 */
export function buildGuardContext(
  tool: string,
  args: Record<string, unknown>,
  config: RuntimeConfig,
  dialect: ShellDialect = currentDialect(),
): GuardContext {
  const paths: PathFact[] = [];
  let shell: ShellFacts | undefined;
  const root = config.workspaceRoot;
  const pathOptions = { alsoAllow: config.temporaryRoots };

  if (tool === "host_vcs") {
    const program = args.program;
    const argv = args.args;
    if (typeof program === "string" && program.length > 0 && Array.isArray(argv)) {
      const command = [
        program,
        ...argv.filter((value): value is string => typeof value === "string"),
      ]
        .map(quoteArg)
        .join(" ");
      args = { ...args, command };
      shell = analyzeShell(command, dialect);
    }
    if (typeof args.cwd === "string") paths.push(resolveCandidate(args.cwd, root, pathOptions));
  } else if (COMMAND_TOOLS.has(tool)) {
    const commandRoots = [...config.temporaryRoots, ...config.skillExecutionRoots];
    if (typeof args.command === "string") {
      shell = analyzeShell(args.command, dialect);
      const occurrences = commandPathOccurrences(shell, dialect);
      const executables = externalExecutableHeads(shell, config);
      shell = normalizeExternalExecutables(shell, executables, dialect);
      for (const occurrence of occurrences) {
        const p = occurrence.raw;
        const resolved = resolveCandidate(p, root, { shell: true }).resolved;
        const artifact = readableStateArtifactPath(resolved, config.stateRoot);
        const readableRoots =
          artifact === undefined || config.sandbox === undefined
            ? commandRoots
            : [...commandRoots, artifact];
        const executable = occurrence.commandHead && executables.get(occurrence.segmentIndex) === p;
        const alsoAllow = executable ? [...readableRoots, p] : readableRoots;
        paths.push(resolveCandidate(p, root, { shell: true, alsoAllow }));
      }
    }
    if (typeof args.cwd === "string") {
      paths.push(resolveCandidate(args.cwd, root, { alsoAllow: commandRoots }));
    }
  } else if (tool === "apply_patch") {
    if (typeof args.patch === "string") {
      for (const p of patchPaths(args.patch)) paths.push(resolveCandidate(p, root, pathOptions));
    }
  } else if (SRC_DEST_TOOLS.has(tool)) {
    if (typeof args.source === "string")
      paths.push(resolveCandidate(args.source, root, pathOptions));
    if (typeof args.destination === "string")
      paths.push(resolveCandidate(args.destination, root, pathOptions));
  } else if (tool === "read_files") {
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) {
        if (typeof p === "string") paths.push(resolveReadOnlyPath(p, root, config));
      }
    }
  } else if (tool === "diff") {
    if (typeof args.from === "string") paths.push(resolveCandidate(args.from, root, pathOptions));
    if (typeof args.to === "string") paths.push(resolveCandidate(args.to, root, pathOptions));
  } else if (tool === "replace") {
    const scope = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
    paths.push(resolveCandidate(scope, root, pathOptions));
  } else if (PATH_ARG_TOOLS.has(tool)) {
    if (typeof args.path === "string") {
      paths.push(
        READ_ONLY_PATH_TOOLS.has(tool)
          ? resolveReadOnlyPath(args.path, root, config)
          : resolveCandidate(args.path, root, pathOptions),
      );
    }
  }

  return { tool, args, config, paths, shell };
}
