import { createHash } from "node:crypto";
import { lstat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { executableOnPath, withoutGitRepositoryEnvironment } from "@clarvis/paths";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type {
  ListWorkspaceChangesRequest,
  WorkspaceChangeDetail,
  WorkspaceChangeEntry,
  WorkspaceChangeOperation,
  WorkspaceChangesAvailability,
  WorkspaceChangesPage,
  WorkspaceChangesReason,
} from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";
import type { ProcessRunner, ProcessRunResult } from "../ports/process-runner.ts";
import type { WorkspaceChangesContext, WorkspaceChangesProvider } from "./changes-provider.ts";
import {
  numstatKey,
  operationFromRaw,
  parseGitLsFilesZ,
  parseGitNumstatZ,
  parseGitRawZ,
  parseGitUnmergedZ,
  type GitNumstatRecord,
  type GitRawRecord,
} from "./git-raw-parser.ts";

const PROVIDER_ID = "git";
const COMPARISON_ALL = "all";
const COMPARISON_STAGED = "staged";
const COMPARISON_UNSTAGED = "unstaged";

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_PATCH_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 500;

const GIT_PREFIX = [
  "--no-pager",
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=never",
  "-c",
  "core.pager=cat",
  "-c",
  "diff.external=",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.renameLimit=400",
] as const;

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%"] as const;

export interface GitChangesLimits {
  maxEntries: number;
  maxPatchBytes: number;
  timeoutMs: number;
  maxOutputBytes: number;
  defaultPageSize: number;
}

/** Options for the Git-backed workspace-changes adapter. */
export interface GitChangesProviderOptions {
  processRunner: ProcessRunner;
  gitExecutable?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
  limits?: Partial<GitChangesLimits>;
}

interface RepoSnapshot {
  git: string;
  worktreeRoot: string;
  gitDir: string;
  commonDir: string;
  workspaceRoot: string;
  workspacePrefix: string;
  head: string | null;
  emptyTree: string;
  generation: string;
}

function gitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const env = withoutGitRepositoryEnvironment(source);
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  delete env.GIT_PAGER;
  delete env.PAGER;
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

function posixJoin(from: string, to: string): string {
  const rel = relative(from, to);
  if (rel.length === 0) return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "";
  return rel.split(sep).join("/");
}

function admitGitPath(worktreeRoot: string, workspaceRoot: string, gitPath: string): string | null {
  const abs = resolve(worktreeRoot, ...gitPath.split("/").filter((part) => part.length > 0));
  const rel = relative(workspaceRoot, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function displayPath(entry: Pick<WorkspaceChangeEntry, "old_path" | "new_path">): string {
  return entry.new_path ?? entry.old_path ?? "";
}

function entryId(
  comparisonId: string,
  operation: WorkspaceChangeOperation,
  oldPath: string | undefined,
  newPath: string | undefined,
): string {
  return [comparisonId, operation, oldPath ?? "", newPath ?? ""].map(encodeURIComponent).join(":");
}

function parseEntryId(id: string): {
  comparisonId: string;
  operation: WorkspaceChangeOperation;
  oldPath: string | undefined;
  newPath: string | undefined;
} | null {
  const parts = id.split(":").map((part) => decodeURIComponent(part));
  const [comparisonId, operation, oldPath, newPath] = parts;
  if (
    comparisonId === undefined ||
    operation === undefined ||
    oldPath === undefined ||
    newPath === undefined
  ) {
    return null;
  }
  return {
    comparisonId,
    operation: operation as WorkspaceChangeOperation,
    oldPath: oldPath === "" ? undefined : oldPath,
    newPath: newPath === "" ? undefined : newPath,
  };
}

function queryId(generation: string, comparisonId: string, resolvedBase: string): string {
  return [PROVIDER_ID, generation, comparisonId, resolvedBase].join(":");
}

function parseQueryId(
  id: string,
): { generation: string; comparisonId: string; resolvedBase: string } | null {
  const parts = id.split(":");
  const [provider, generation, comparisonId, resolvedBase] = parts;
  if (parts.length !== 4 || provider !== PROVIDER_ID) return null;
  if (generation === undefined || comparisonId === undefined || resolvedBase === undefined)
    return null;
  return { generation, comparisonId, resolvedBase };
}

function digestIdentity(...values: string[]): string {
  return createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16);
}

function classifyGitOutput(stderr: string, stdout: string): WorkspaceChangesReason {
  const text = `${stderr}\n${stdout}`;
  if (/not a git repository/i.test(text)) {
    return { code: "not_a_repository", message: "this workspace is not a Git repository" };
  }
  if (/dubious ownership|safe\.directory/i.test(text)) {
    return {
      code: "safe_directory_refused",
      message: "Git refused this directory (safe.directory)",
    };
  }
  if (/permission denied|eacces/i.test(text)) {
    return { code: "access_denied", message: "Git could not read this workspace" };
  }
  return { code: "probe_failed", message: "Git could not inspect this workspace" };
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}

function throwProcessFailure(error: unknown, signal?: AbortSignal): never {
  if (isCancelled(error, signal))
    throw kernelError("cancelled", "workspace changes request cancelled");
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message) || /exceeded the admitted limit/i.test(message)) {
    throw kernelError("resource_exhausted", "Git output exceeded the admitted limit");
  }
  throw kernelError("unavailable", "Git could not inspect this workspace");
}

function comparisonMeta(head: string | null): {
  id: string;
  label: string;
  description: string;
  bases: Record<string, string>;
}[] {
  const from = head ?? "empty tree";
  return [
    {
      id: COMPARISON_ALL,
      label: "All",
      description: "HEAD versus the working tree, including untracked files",
      bases: { from, to: "working tree" },
    },
    {
      id: COMPARISON_STAGED,
      label: "Staged",
      description: "HEAD versus the index",
      bases: { from, to: "index" },
    },
    {
      id: COMPARISON_UNSTAGED,
      label: "Unstaged",
      description: "Index versus the working tree, including untracked files",
      bases: { from: "index", to: "working tree" },
    },
  ];
}

function pathspecArgs(prefix: string): string[] {
  if (prefix.length === 0) return [];
  return ["--", prefix];
}

function statsFor(record: GitNumstatRecord | undefined): WorkspaceChangeEntry["stats"] {
  if (record === undefined) return undefined;
  if (record.additions === null && record.deletions === null) return undefined;
  return {
    ...(record.additions === null ? {} : { additions: record.additions }),
    ...(record.deletions === null ? {} : { deletions: record.deletions }),
  };
}

function rewriteUntrackedPatch(
  patch: string,
  emptyPath: string,
  fileAbs: string,
  relPath: string,
): string {
  const posixRel = relPath.replaceAll("\\", "/");
  const emptyPosix = emptyPath.replaceAll("\\", "/");
  const filePosix = fileAbs.replaceAll("\\", "/");
  const emptyGit = emptyPosix.replace(/^\/+/, "");
  const fileGit = filePosix.replace(/^\/+/, "");
  let text = patch;
  for (const [from, to] of [
    [emptyPath, "/dev/null"],
    [emptyPosix, "/dev/null"],
    [`a/${emptyGit}`, "/dev/null"],
    [fileAbs, posixRel],
    [filePosix, posixRel],
    [`a/${fileGit}`, `a/${posixRel}`],
    [`b/${fileGit}`, `b/${posixRel}`],
  ] as const) {
    if (from.length > 0) text = text.split(from).join(to);
  }
  const lines = text.split("\n");
  for (let index = 0; index < Math.min(lines.length, 8); index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("diff --git ")) lines[index] = `diff --git a/${posixRel} b/${posixRel}`;
    else if (line.startsWith("--- ")) lines[index] = "--- /dev/null";
    else if (line.startsWith("+++ ")) lines[index] = `+++ b/${posixRel}`;
  }
  return lines.join("\n");
}

/**
 * Create the Git workspace-changes adapter.
 *
 * @remarks Every subprocess uses argv, a host-resolved executable, and a filtered
 *   environment. Queries never write to the index, configuration, or object store
 *   (`hash-object` is invoked without `-w`).
 */
export function createGitChangesProvider(
  options: GitChangesProviderOptions,
): WorkspaceChangesProvider {
  const logger = options.logger ?? NOOP_LOGGER;
  const limits: GitChangesLimits = {
    maxEntries: options.limits?.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxPatchBytes: options.limits?.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
    timeoutMs: options.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    defaultPageSize: options.limits?.defaultPageSize ?? DEFAULT_PAGE_SIZE,
  };
  const environment = gitEnvironment(options.environment ?? process.env);
  let emptyFile: string | undefined;

  const ensureEmptyFile = async (): Promise<string> => {
    if (emptyFile !== undefined) return emptyFile;
    const emptyDir = await mkdtemp(join(tmpdir(), "clarvis-git-changes-"));
    emptyFile = join(emptyDir, "empty");
    await writeFile(emptyFile, "", { mode: 0o600 });
    return emptyFile;
  };

  const run = async (
    git: string,
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    allow: ReadonlySet<number>,
  ): Promise<ProcessRunResult> => {
    let result: ProcessRunResult;
    try {
      result = await options.processRunner.run({
        command: git,
        args: [...GIT_PREFIX, ...args],
        cwd,
        environment,
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throwProcessFailure(error, signal);
    }
    const code = result.exitCode ?? 1;
    if (allow.has(code)) return result;
    const reason = classifyGitOutput(result.stderr, result.stdout);
    throw kernelError(
      reason.code === "not_a_repository" ? "unsupported" : "unavailable",
      reason.message,
    );
  };

  const resolveGit = (): string | undefined => {
    if (options.gitExecutable !== undefined && options.gitExecutable.length > 0) {
      return options.gitExecutable;
    }
    return executableOnPath("git", environment.PATH);
  };

  const discover = async (
    context: WorkspaceChangesContext,
  ): Promise<{ snapshot: RepoSnapshot } | { availability: WorkspaceChangesAvailability }> => {
    const git = resolveGit();
    if (git === undefined) {
      return {
        availability: {
          status: "unavailable",
          reason: { code: "executable_missing", message: "Git is not installed" },
        },
      };
    }
    const workspaceRoot = resolve(context.workspaceRoot);
    const version = await (async () => {
      try {
        return await options.processRunner.run({
          command: git,
          args: [...GIT_PREFIX, "--version"],
          cwd: workspaceRoot,
          environment,
          timeoutMs: Math.min(5_000, limits.timeoutMs),
          maxOutputBytes: 64 * 1024,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
      } catch (error) {
        if (isCancelled(error, context.signal)) {
          throw kernelError("cancelled", "workspace changes request cancelled");
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    if (version.exitCode !== 0) {
      return {
        availability: {
          status: "unavailable",
          reason: { code: "executable_missing", message: "Git is not usable" },
        },
      };
    }
    let inside: ProcessRunResult;
    try {
      inside = await options.processRunner.run({
        command: git,
        args: [...GIT_PREFIX, "rev-parse", "--is-inside-work-tree"],
        cwd: workspaceRoot,
        environment,
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: 64 * 1024,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
    } catch (error) {
      throwProcessFailure(error, context.signal);
    }
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      const reason = classifyGitOutput(inside.stderr, inside.stdout);
      if (reason.code === "not_a_repository") {
        return { availability: { status: "not_applicable", reason } };
      }
      return { availability: { status: "unavailable", reason } };
    }
    const allowZero = new Set([0]);
    const worktreeRoot = resolve(
      (
        await run(
          git,
          workspaceRoot,
          ["rev-parse", "--path-format=absolute", "--show-toplevel"],
          context.signal,
          allowZero,
        )
      ).stdout.trim(),
    );
    const gitDir = resolve(
      (
        await run(
          git,
          workspaceRoot,
          ["rev-parse", "--path-format=absolute", "--git-dir"],
          context.signal,
          allowZero,
        )
      ).stdout.trim(),
    );
    const commonDir = resolve(
      (
        await run(
          git,
          workspaceRoot,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          context.signal,
          allowZero,
        )
      ).stdout.trim(),
    );
    const workspaceRel = posixJoin(worktreeRoot, workspaceRoot);
    const workspaceInside = relative(worktreeRoot, workspaceRoot);
    if (
      workspaceInside === ".." ||
      workspaceInside.startsWith(`..${sep}`) ||
      isAbsolute(workspaceInside)
    ) {
      return {
        availability: {
          status: "not_applicable",
          reason: {
            code: "not_a_repository",
            message: "this workspace is outside the Git worktree",
          },
        },
      };
    }
    const empty = await ensureEmptyFile();
    const emptyTree = (
      await run(
        git,
        worktreeRoot,
        ["hash-object", "-t", "tree", "--", empty],
        context.signal,
        allowZero,
      )
    ).stdout.trim();
    const headResult = await options.processRunner.run({
      command: git,
      args: [...GIT_PREFIX, "rev-parse", "--verify", "--quiet", "HEAD"],
      cwd: worktreeRoot,
      environment,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: 64 * 1024,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const generation = digestIdentity(workspaceRoot, gitDir, commonDir);
    return {
      snapshot: {
        git,
        worktreeRoot,
        gitDir,
        commonDir,
        workspaceRoot,
        workspacePrefix: workspaceRel,
        head,
        emptyTree,
        generation,
      },
    };
  };

  const availableFrom = (snapshot: RepoSnapshot): WorkspaceChangesAvailability => ({
    status: "available",
    provider: {
      id: PROVIDER_ID,
      name: "Git",
      workspace_identity: snapshot.workspaceRoot,
      repository_identity: digestIdentity(snapshot.commonDir),
      default_comparison_id: COMPARISON_ALL,
      comparisons: comparisonMeta(snapshot.head),
      capabilities: { staging: true, renames: true, conflicts: true },
    },
  });

  const diffBase = (snapshot: RepoSnapshot): string => snapshot.head ?? snapshot.emptyTree;

  const collectRaw = async (
    snapshot: RepoSnapshot,
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ raw: GitRawRecord[]; numstat: GitNumstatRecord[] }> => {
    const allow = new Set([0, 1]);
    const rawOut = await run(
      snapshot.git,
      snapshot.worktreeRoot,
      ["diff", ...DIFF_FLAGS, "--raw", "-z", ...args, ...pathspecArgs(snapshot.workspacePrefix)],
      signal,
      allow,
    );
    const numOut = await run(
      snapshot.git,
      snapshot.worktreeRoot,
      [
        "diff",
        ...DIFF_FLAGS,
        "--numstat",
        "-z",
        ...args,
        ...pathspecArgs(snapshot.workspacePrefix),
      ],
      signal,
      allow,
    );
    return { raw: parseGitRawZ(rawOut.stdout), numstat: parseGitNumstatZ(numOut.stdout) };
  };

  const untrackedPaths = async (
    snapshot: RepoSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<string[]> => {
    const result = await run(
      snapshot.git,
      snapshot.worktreeRoot,
      [
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        ...pathspecArgs(snapshot.workspacePrefix),
      ],
      signal,
      new Set([0]),
    );
    return parseGitLsFilesZ(result.stdout);
  };

  const unmergedPaths = async (
    snapshot: RepoSnapshot,
    signal: AbortSignal | undefined,
  ): Promise<Set<string>> => {
    const result = await run(
      snapshot.git,
      snapshot.worktreeRoot,
      ["ls-files", "-z", "--unmerged", ...pathspecArgs(snapshot.workspacePrefix)],
      signal,
      new Set([0]),
    );
    return new Set(parseGitUnmergedZ(result.stdout));
  };

  const toEntry = (
    comparisonId: string,
    record: GitRawRecord,
    numstat: Map<string, GitNumstatRecord>,
    conflicts: Set<string>,
    workspaceRoot: string,
    worktreeRoot: string,
    staged?: boolean,
    unstaged?: boolean,
  ): WorkspaceChangeEntry | null => {
    const oldAdmitted = admitGitPath(worktreeRoot, workspaceRoot, record.oldPath);
    const newAdmitted = admitGitPath(worktreeRoot, workspaceRoot, record.newPath);
    if (oldAdmitted === null && newAdmitted === null) return null;
    const conflicted = conflicts.has(record.oldPath) || conflicts.has(record.newPath);
    const operation: WorkspaceChangeOperation = conflicted ? "conflict" : operationFromRaw(record);
    const oldPath = operation === "added" ? undefined : (oldAdmitted ?? undefined);
    const newPath = operation === "deleted" ? undefined : (newAdmitted ?? oldAdmitted ?? undefined);
    const stats = statsFor(numstat.get(numstatKey(record.oldPath, record.newPath)));
    const binary =
      stats === undefined && numstat.get(numstatKey(record.oldPath, record.newPath)) !== undefined;
    return {
      id: entryId(comparisonId, operation, oldPath, newPath),
      ...(oldPath === undefined ? {} : { old_path: oldPath }),
      ...(newPath === undefined ? {} : { new_path: newPath }),
      operation,
      ...(staged === undefined ? {} : { staged }),
      ...(unstaged === undefined ? {} : { unstaged }),
      ...(binary ? { binary: true } : {}),
      ...(stats === undefined ? {} : { stats }),
    };
  };

  const untrackedEntry = (comparisonId: string, admitted: string): WorkspaceChangeEntry => ({
    id: entryId(comparisonId, "added", undefined, admitted),
    new_path: admitted,
    operation: "added",
    staged: false,
    unstaged: true,
  });

  const pathSet = (
    records: GitRawRecord[],
    worktreeRoot: string,
    workspaceRoot: string,
  ): Set<string> => {
    const paths = new Set<string>();
    for (const record of records) {
      const admitted =
        admitGitPath(worktreeRoot, workspaceRoot, record.newPath) ??
        admitGitPath(worktreeRoot, workspaceRoot, record.oldPath);
      if (admitted !== null) paths.add(admitted);
    }
    return paths;
  };

  const buildPage = (
    snapshot: RepoSnapshot,
    comparisonId: string,
    items: WorkspaceChangeEntry[],
    incomplete: boolean,
    request: ListWorkspaceChangesRequest,
  ): WorkspaceChangesPage => {
    const sorted = [...items].sort((left, right) =>
      displayPath(left).localeCompare(displayPath(right)),
    );
    const limit = Math.min(Math.max(1, request.limit ?? limits.defaultPageSize), limits.maxEntries);
    const offset =
      request.cursor === undefined || request.cursor === "" ? 0 : Number(request.cursor);
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const sliced = sorted.slice(start, start + limit);
    const more = start + sliced.length < sorted.length;
    return {
      query_id: queryId(snapshot.generation, comparisonId, diffBase(snapshot)),
      comparison_id: comparisonId,
      resolved_base: snapshot.head ?? "empty tree",
      incomplete: incomplete || more || sorted.length >= limits.maxEntries,
      items: sliced,
      ...(more ? { next_cursor: String(start + sliced.length) } : {}),
    };
  };

  const listComparison = async (
    snapshot: RepoSnapshot,
    comparisonId: string,
    request: ListWorkspaceChangesRequest,
    signal: AbortSignal | undefined,
  ): Promise<WorkspaceChangesPage> => {
    const conflicts = await unmergedPaths(snapshot, signal);
    const includeUntracked =
      comparisonId === COMPARISON_ALL || comparisonId === COMPARISON_UNSTAGED;
    const base = diffBase(snapshot);
    let raw: GitRawRecord[];
    let numstat: GitNumstatRecord[];
    let stagedPaths = new Set<string>();
    let unstagedPaths = new Set<string>();
    if (comparisonId === COMPARISON_ALL) {
      const all = await collectRaw(snapshot, [base], signal);
      raw = all.raw;
      numstat = all.numstat;
      const staged = await collectRaw(snapshot, ["--cached", base], signal);
      const unstaged = await collectRaw(snapshot, [], signal);
      stagedPaths = pathSet(staged.raw, snapshot.worktreeRoot, snapshot.workspaceRoot);
      unstagedPaths = pathSet(unstaged.raw, snapshot.worktreeRoot, snapshot.workspaceRoot);
    } else if (comparisonId === COMPARISON_STAGED) {
      const staged = await collectRaw(snapshot, ["--cached", base], signal);
      raw = staged.raw;
      numstat = staged.numstat;
    } else {
      const unstaged = await collectRaw(snapshot, [], signal);
      raw = unstaged.raw;
      numstat = unstaged.numstat;
    }
    const numstatMap = new Map(
      numstat.map((record) => [numstatKey(record.oldPath, record.newPath), record]),
    );
    const items: WorkspaceChangeEntry[] = [];
    let truncated = raw.length > limits.maxEntries;
    for (const record of raw.slice(0, limits.maxEntries)) {
      const admittedNew = admitGitPath(
        snapshot.worktreeRoot,
        snapshot.workspaceRoot,
        record.newPath,
      );
      const admittedOld = admitGitPath(
        snapshot.worktreeRoot,
        snapshot.workspaceRoot,
        record.oldPath,
      );
      const key = admittedNew ?? admittedOld;
      const staged =
        comparisonId === COMPARISON_STAGED
          ? true
          : comparisonId === COMPARISON_ALL && key !== null
            ? stagedPaths.has(key)
            : comparisonId === COMPARISON_UNSTAGED
              ? false
              : undefined;
      const unstaged =
        comparisonId === COMPARISON_UNSTAGED
          ? true
          : comparisonId === COMPARISON_ALL && key !== null
            ? unstagedPaths.has(key)
            : comparisonId === COMPARISON_STAGED
              ? false
              : undefined;
      const entry = toEntry(
        comparisonId,
        record,
        numstatMap,
        conflicts,
        snapshot.workspaceRoot,
        snapshot.worktreeRoot,
        staged,
        unstaged,
      );
      if (entry !== null) items.push(entry);
    }
    if (includeUntracked) {
      const extras = await untrackedPaths(snapshot, signal);
      for (const gitPath of extras) {
        if (items.length >= limits.maxEntries) {
          truncated = true;
          break;
        }
        const admitted = admitGitPath(snapshot.worktreeRoot, snapshot.workspaceRoot, gitPath);
        if (admitted === null) continue;
        const abs = resolve(snapshot.worktreeRoot, ...gitPath.split("/"));
        try {
          const info = await lstat(abs);
          if (info.isSymbolicLink() || info.isDirectory()) {
            items.push(untrackedEntry(comparisonId, admitted));
            continue;
          }
          if (!info.isFile()) continue;
        } catch {
          continue;
        }
        items.push(untrackedEntry(comparisonId, admitted));
      }
    }
    return buildPage(snapshot, comparisonId, items, truncated, request);
  };

  const readTrackedPatch = async (
    snapshot: RepoSnapshot,
    comparisonId: string,
    oldPath: string | undefined,
    newPath: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const paths = [oldPath, newPath].filter((path, index, all): path is string => {
      return path !== undefined && all.indexOf(path) === index;
    });
    const gitPaths = paths.map((path) =>
      snapshot.workspacePrefix.length === 0 ? path : `${snapshot.workspacePrefix}/${path}`,
    );
    const args =
      comparisonId === COMPARISON_STAGED
        ? (["diff", ...DIFF_FLAGS, "--cached", diffBase(snapshot), "--", ...gitPaths] as const)
        : comparisonId === COMPARISON_UNSTAGED
          ? (["diff", ...DIFF_FLAGS, "--", ...gitPaths] as const)
          : (["diff", ...DIFF_FLAGS, diffBase(snapshot), "--", ...gitPaths] as const);
    const result = await run(snapshot.git, snapshot.worktreeRoot, args, signal, new Set([0, 1]));
    return result.stdout;
  };

  const readUntrackedPatch = async (
    snapshot: RepoSnapshot,
    relPath: string,
    signal: AbortSignal | undefined,
  ): Promise<WorkspaceChangeDetail> => {
    const abs = resolve(snapshot.workspaceRoot, ...relPath.split("/"));
    const admitted = admitGitPath(snapshot.workspaceRoot, snapshot.workspaceRoot, relPath);
    if (admitted === null) {
      return {
        entry_id: entryId(COMPARISON_ALL, "added", undefined, relPath),
        query_id: "",
        comparison_id: COMPARISON_ALL,
        resolved_base: snapshot.head ?? "empty tree",
        status: "unavailable",
        message: "path is outside the workspace",
      };
    }
    try {
      const info = await lstat(abs);
      if (info.isSymbolicLink()) {
        return {
          entry_id: entryId(COMPARISON_UNSTAGED, "added", undefined, relPath),
          query_id: "",
          comparison_id: COMPARISON_UNSTAGED,
          resolved_base: snapshot.head ?? "empty tree",
          status: "empty",
          message: "untracked symlink",
        };
      }
      if (!info.isFile()) {
        return {
          entry_id: entryId(COMPARISON_UNSTAGED, "added", undefined, relPath),
          query_id: "",
          comparison_id: COMPARISON_UNSTAGED,
          resolved_base: snapshot.head ?? "empty tree",
          status: "unavailable",
          message: "untracked path is not a regular file",
        };
      }
    } catch {
      return {
        entry_id: entryId(COMPARISON_UNSTAGED, "added", undefined, relPath),
        query_id: "",
        comparison_id: COMPARISON_UNSTAGED,
        resolved_base: snapshot.head ?? "empty tree",
        status: "stale",
        message: "file is no longer present",
      };
    }
    const empty = await ensureEmptyFile();
    const result = await run(
      snapshot.git,
      snapshot.worktreeRoot,
      ["diff", ...DIFF_FLAGS, "--no-index", "--", empty, abs],
      signal,
      new Set([0, 1]),
    );
    if (/^Binary files /m.test(result.stdout) || result.stdout.includes("Binary files ")) {
      return {
        entry_id: entryId(COMPARISON_UNSTAGED, "added", undefined, relPath),
        query_id: "",
        comparison_id: COMPARISON_UNSTAGED,
        resolved_base: snapshot.head ?? "empty tree",
        status: "binary",
        message: "binary file",
      };
    }
    const patch = rewriteUntrackedPatch(result.stdout, empty, abs, relPath);
    if (Buffer.byteLength(patch, "utf8") > limits.maxPatchBytes) {
      return {
        entry_id: entryId(COMPARISON_UNSTAGED, "added", undefined, relPath),
        query_id: "",
        comparison_id: COMPARISON_UNSTAGED,
        resolved_base: snapshot.head ?? "empty tree",
        status: "truncated",
        message: "patch exceeds the admitted size",
      };
    }
    return {
      entry_id: entryId(COMPARISON_UNSTAGED, "added", undefined, relPath),
      query_id: "",
      comparison_id: COMPARISON_UNSTAGED,
      resolved_base: snapshot.head ?? "empty tree",
      status: patch.trim().length === 0 ? "empty" : "ready",
      ...(patch.trim().length === 0 ? {} : { patch }),
    };
  };

  return {
    id: PROVIDER_ID,
    async probe(context) {
      const discovered = await discover(context);
      if ("availability" in discovered) return discovered.availability;
      logger.debug(
        {
          event: "workspace.changes.probe",
          provider: PROVIDER_ID,
          workspace_id: context.workspaceId,
        },
        "Git changes provider is available",
      );
      return availableFrom(discovered.snapshot);
    },
    async listChanges(context, request) {
      const discovered = await discover(context);
      if ("availability" in discovered) {
        const availability = discovered.availability;
        throw kernelError(
          availability.status === "not_applicable" ? "unsupported" : "unavailable",
          availability.status === "available"
            ? "Git is unexpectedly available"
            : availability.reason.message,
        );
      }
      const comparisonId = request.comparison_id ?? COMPARISON_ALL;
      if (
        comparisonId !== COMPARISON_ALL &&
        comparisonId !== COMPARISON_STAGED &&
        comparisonId !== COMPARISON_UNSTAGED
      ) {
        throw kernelError("invalid_request", "unknown comparison");
      }
      return listComparison(discovered.snapshot, comparisonId, request, context.signal);
    },
    async readChange(context, request) {
      const discovered = await discover(context);
      if ("availability" in discovered) {
        const availability = discovered.availability;
        throw kernelError(
          availability.status === "not_applicable" ? "unsupported" : "unavailable",
          availability.status === "available"
            ? "Git is unexpectedly available"
            : availability.reason.message,
        );
      }
      const snapshot = discovered.snapshot;
      const parsedQuery = parseQueryId(request.query_id);
      const parsedEntry = parseEntryId(request.entry_id);
      if (parsedQuery === null || parsedEntry === null) {
        throw kernelError("invalid_request", "invalid change identity");
      }
      const comparisonId = request.comparison_id ?? parsedEntry.comparisonId;
      const resolved = snapshot.head ?? "empty tree";
      const base = {
        entry_id: request.entry_id,
        query_id: request.query_id,
        comparison_id: comparisonId,
        resolved_base: resolved,
      };
      if (parsedQuery.generation !== snapshot.generation) {
        return { ...base, status: "stale", message: "workspace generation changed" };
      }
      if (parsedQuery.resolvedBase !== diffBase(snapshot)) {
        return { ...base, status: "stale", message: "comparison base changed" };
      }
      if (parsedEntry.operation === "conflict") {
        return {
          ...base,
          status: "conflict",
          message: "unmerged path; resolve the conflict to review a patch",
        };
      }
      if (parsedEntry.operation === "submodule") {
        return { ...base, status: "empty", message: "submodule gitlink change" };
      }
      const untracked =
        parsedEntry.operation === "added" &&
        parsedEntry.oldPath === undefined &&
        (comparisonId === COMPARISON_ALL || comparisonId === COMPARISON_UNSTAGED);
      if (untracked && parsedEntry.newPath !== undefined) {
        const detail = await readUntrackedPatch(snapshot, parsedEntry.newPath, context.signal);
        return { ...detail, ...base, entry_id: request.entry_id, query_id: request.query_id };
      }
      const patch = await readTrackedPatch(
        snapshot,
        comparisonId,
        parsedEntry.oldPath,
        parsedEntry.newPath,
        context.signal,
      );
      if (/^Binary files /m.test(patch) || patch.includes("Binary files ")) {
        return { ...base, status: "binary", message: "binary file" };
      }
      if (Buffer.byteLength(patch, "utf8") > limits.maxPatchBytes) {
        return { ...base, status: "truncated", message: "patch exceeds the admitted size" };
      }
      if (patch.trim().length === 0) {
        return { ...base, status: "empty", message: "no text hunks" };
      }
      return { ...base, status: "ready", patch };
    },
  };
}
