import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath, {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync, type SpawnOptions, type SpawnSyncReturns } from "node:child_process";
import { ToolError } from "./errors.ts";
import { executableOnPath } from "@clarvis/paths";
import { resolveShell, shellArgs, type ShellSpec } from "./shell.ts";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./lib/log.ts";

/**
 * Configuration for running a command inside a bubblewrap (`bwrap`) sandbox.
 *
 * @remarks
 * `availability: "optional"` lets a command fall back to running unsandboxed
 * when bubblewrap is unavailable, whereas `"required"` (the default posture in
 * {@link sandboxCommand}) makes an unavailable sandbox a hard error.
 * `readOnlyPaths` and `runtimePaths` are bound read-only into the sandbox;
 * `runtimePaths` additionally shape the sandboxed `PATH`. `passEnv` names extra
 * host env vars to carry through the otherwise minimal environment.
 */
export interface BubblewrapSandbox {
  type: "bubblewrap";
  availability?: "required" | "optional";
  filesystem?: "workspace-write" | "workspace-read-only";
  network?: "host" | "none";
  passEnv?: string[];
  readOnlyPaths?: string[];
  runtimePaths?: string[];
}

/** The supported sandbox configurations; currently only {@link BubblewrapSandbox}. */
export type SandboxConfig = BubblewrapSandbox;

/**
 * A ready-to-spawn command: the executable `file`, its `args`, and the `cwd`/
 * `env` spawn options - either the bare `sh -c` form or the `bwrap` wrapping,
 * as decided by {@link sandboxCommand}.
 */
export interface SandboxedCommand {
  file: string;
  args: string[];
  options: Pick<SpawnOptions, "cwd" | "env">;
  /**
   * Whether the command is actually wrapped in `bwrap`.
   *
   * @remarks False both when no sandbox was configured and when one was
   *   configured `optional` and the host cannot provide it — the caller needs
   *   the distinction to report what a spawn really ran under, and it is not
   *   recoverable from `file`/`args` without re-parsing them.
   */
  sandboxed: boolean;
}

/**
 * The outcome of probing bubblewrap on this host: usable with a fresh `/proc`
 * (`fresh-proc`), usable only by bind-mounting the host `/proc` (`host-proc`),
 * or `unavailable` with a human-readable `reason`.
 */
export type BubblewrapProbe =
  { mode: "fresh-proc" | "host-proc" } | { mode: "unavailable"; reason: string };

let cachedProbe: BubblewrapProbe | undefined;

/**
 * Injectable seams for {@link probeBubblewrap}, so every branch (missing
 * `bwrap`, a working `fresh-proc`, a `bwrap` that only tolerates a bound
 * `/proc`, and one that tolerates neither) is exercisable without depending on
 * what the host machine actually has installed.
 */
export interface BubblewrapProbeDeps {
  platform?: NodeJS.Platform;
  /** `child_process.spawnSync`; defaults to the real one. */
  spawnSync?: (
    command: string,
    args: string[],
    options: { stdio: "ignore" },
  ) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
}

/**
 * Build the `bwrap` argv for a minimal readiness probe under the given `/proc`
 * strategy: a locked-down namespace that binds core system paths and runs
 * `true`. Used by {@link probeBubblewrap} to see which strategy the host allows.
 */
function probeArgs(procMode: "fresh-proc" | "host-proc"): string[] {
  const args = ["--die-with-parent", "--unshare-user", "--unshare-pid"];
  args.push(
    procMode === "fresh-proc" ? "--proc" : "--ro-bind",
    "/proc",
    ...(procMode === "host-proc" ? ["/proc"] : []),
  );
  args.push("--dev", "/dev", "--ro-bind", "/usr", "/usr");
  for (const path of ["/bin", "/lib", "/lib64"]) mountSystemPath(args, path);
  args.push("--", "/bin/sh", "-c", "true");
  return args;
}

/** {@link probeBubblewrap}'s uncached implementation, given resolved deps. */
function computeProbe(deps: BubblewrapProbeDeps): BubblewrapProbe {
  const platform = deps.platform ?? process.platform;
  const probeSpawnSync = deps.spawnSync ?? spawnSync;
  if (platform !== "linux") {
    return {
      mode: "unavailable",
      reason: `Bubblewrap is supported only on Linux (host platform: ${platform})`,
    };
  }
  const version = probeSpawnSync("bwrap", ["--version"], { stdio: "ignore" });
  if (version.error || version.status !== 0) {
    return { mode: "unavailable", reason: "bwrap executable was not found" };
  }
  if (probeSpawnSync("bwrap", probeArgs("fresh-proc"), { stdio: "ignore" }).status === 0) {
    return { mode: "fresh-proc" };
  }
  if (probeSpawnSync("bwrap", probeArgs("host-proc"), { stdio: "ignore" }).status === 0) {
    return { mode: "host-proc" };
  }
  return {
    mode: "unavailable",
    reason: "bwrap cannot create the namespaces or mounts required by Clarvis",
  };
}

/**
 * Detect whether and how bubblewrap can sandbox commands on this host.
 *
 * @param deps - test seams (see {@link BubblewrapProbeDeps}). When omitted the
 *   result is memoized process-wide, exactly as {@link resolveShell} memoizes
 *   its own; an injected call is never cached and never poisons the cache.
 * @returns a {@link BubblewrapProbe}: `fresh-proc` or `host-proc` when a probe
 *   sandbox actually launched, otherwise `unavailable` with the reason.
 * @remarks
 * The memoized result is computed at most once per process (the probe spawns
 * `bwrap`). Non-Linux hosts and a missing/failing `bwrap` short-circuit to
 * `unavailable`; the two `mode`s differ only in how `/proc` is provided (a
 * fresh mount vs a bind of the host's).
 */
export function probeBubblewrap(deps?: BubblewrapProbeDeps): BubblewrapProbe {
  if (deps === undefined) return (cachedProbe ??= computeProbe({}));
  return computeProbe(deps);
}

/**
 * Append `bwrap` args that reproduce `source` inside the sandbox at its own
 * path: a symlink is recreated with `--symlink` (preserving its target), a real
 * path is read-only bound. Missing paths are skipped so a host lacking, say,
 * `/lib64` still builds valid args.
 */
function mountSystemPath(args: string[], source: string): void {
  if (!existsSync(source)) return;
  if (lstatSync(source).isSymbolicLink()) args.push("--symlink", readlinkSync(source), source);
  else args.push("--ro-bind", source, source);
}

/**
 * Whether `path` is `root` itself or nested beneath it, comparing normalized
 * relative paths (no filesystem access, so it works for not-yet-existing paths).
 *
 * @param pathApi - the path flavor to compare with; injectable so Windows-shaped
 *   paths can be reasoned about from a POSIX host, where `node:path` would not
 *   treat `\` as a separator at all.
 */
function isWithin(path: string, root: string, pathApi: PlatformPath = nodePath): boolean {
  const rel = pathApi.relative(root, path);
  return (
    rel === "" || (!rel.startsWith(`..${pathApi.sep}`) && rel !== ".." && !pathApi.isAbsolute(rel))
  );
}

/**
 * The host paths a sandbox with networking needs so that DNS actually resolves.
 *
 * `/etc` is already mounted, which is enough when `/etc/resolv.conf` is a real
 * file. On systemd-resolved hosts it is a symlink into `/run` - a tree the
 * sandbox never mounts - so inside the sandbox the link dangles and every name
 * lookup fails. The failure mode is nasty: `npm`, `curl` and friends do not
 * error out promptly, they retry in silence until something else kills them, so
 * a broken resolver looks exactly like a slow network.
 *
 * Binding the link's real target at its own path is enough - bwrap creates the
 * intermediate directories, and the existing `/etc/resolv.conf` symlink then
 * resolves normally.
 *
 * Exported for tests: the right layout to exercise is the host's, and the two
 * branches (plain file vs symlink out of `/etc`) cannot both exist on one machine.
 *
 * @remarks The containment test canonicalizes both sides. `target` is already a
 * real path, so comparing it against the literal string `/etc` asks whether a
 * resolved path sits under an unresolved one — true on Linux only because `/etc`
 * happens not to be a symlink there. On a host where it is (macOS resolves
 * `/etc` to `/private/etc`), every file genuinely inside `/etc` looked external
 * and earned a redundant bind mount.
 */
export function resolverMounts(link = "/etc/resolv.conf"): string[] {
  if (!existsSync(link)) return [];
  const target = realpathSync(link);
  if (isWithin(target, canonicalOrSelf("/etc"))) return [];
  return ["--ro-bind", target, target];
}

/** Resolve `p` to its real path, or hand back `p` when it cannot be resolved. */
function canonicalOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function readSmallMetadataFile(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve Git metadata that lives outside a linked worktree.
 *
 * A primary checkout keeps `.git` inside the workspace bind and needs nothing extra. A linked
 * checkout has a small `.git` pointer to `<common>/worktrees/<name>`; mounting the common directory
 * makes ordinary Git commands operate normally without exposing the operator's home or credentials.
 */
export function discoverLinkedGitMetadataPaths(workspaceRoot: string): readonly string[] {
  try {
    const root = realpathSync(resolve(workspaceRoot));
    const pointer = resolve(root, ".git");
    const line = readSmallMetadataFile(pointer);
    if (line === undefined) return [];
    const match = /^gitdir:\s*(.+)$/i.exec(line);
    if (!match?.[1]) return [];
    const gitDir = realpathSync(resolve(root, match[1].trim()));
    if (!lstatSync(gitDir).isDirectory()) return [];
    const relativeCommon = readSmallMetadataFile(resolve(gitDir, "commondir"));
    if (relativeCommon === undefined) return [];
    const commonDir = realpathSync(resolve(gitDir, relativeCommon));
    if (!lstatSync(commonDir).isDirectory()) return [];
    const gitDirParts = relative(commonDir, gitDir).split(sep);
    if (gitDirParts.length !== 2 || gitDirParts[0] !== "worktrees" || !gitDirParts[1]) return [];
    const backlink = readSmallMetadataFile(resolve(gitDir, "gitdir"));
    if (
      backlink === undefined ||
      realpathSync(resolve(gitDir, backlink)) !== realpathSync(pointer)
    ) {
      return [];
    }
    if (
      forbiddenSandboxRoots().includes(commonDir) ||
      isWithin(root, commonDir) ||
      isWithin(commonDir, root)
    ) {
      return [];
    }
    return Object.freeze([commonDir]);
  } catch {
    return [];
  }
}

/**
 * The roots too broad to expose to a sandbox, resolved against this host.
 *
 * @returns `/`, `/home` and the user's home directory, each resolved.
 * @remarks A function rather than a constant because `homedir()` is read at call
 *   time; a module-level array would freeze whatever `HOME` was when the module
 *   first loaded, which a test that moves `HOME` then silently disagrees with.
 *   It is exported because the host-side validator in `@clarvis/loop`
 *   (`runtime/capabilities/sandbox-host-policy.ts`) enforces the same three
 *   roots with a different return convention, and spelling them twice is how
 *   one side gains a root the other does not.
 */
export function forbiddenSandboxRoots(): string[] {
  return [resolve("/"), resolve("/home"), resolve(homedir())];
}

/**
 * Reject a caller-supplied read-only mount that is dangerously broad (`/`,
 * `/home`, the user's home) or that would shadow the workspace by containing it.
 *
 * @throws {@link ToolError} (`invalid_input`) when the path is a forbidden root
 *   or contains `workspaceRoot`.
 */
function validateReadOnlyPath(path: string, workspaceRoot: string): void {
  if (forbiddenSandboxRoots().includes(path)) {
    throw new ToolError("invalid_input", `Sandbox read-only path is too broad: ${path}`);
  }
  if (isWithin(workspaceRoot, path)) {
    throw new ToolError(
      "invalid_input",
      `Sandbox read-only path may not contain the workspace: ${path}`,
    );
  }
}

/**
 * Compute the `PATH` for a sandboxed process: keep only host `PATH` entries that
 * live under a system root (`/usr`, `/bin`, `/sbin`) or one of the
 * `runtimePaths`, and prepend each runtime root's `bin`. Entries are
 * deduplicated while preserving order.
 */
function sandboxPath(runtimePaths: readonly string[]): string {
  const roots = runtimePaths.map((path) => resolve(path));
  const systemRoots = ["/usr", "/bin", "/sbin"];
  const entries = (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
    .split(delimiter)
    .filter((entry) => {
      if (!isAbsolute(entry) || !existsSync(entry)) return false;
      const normalized = resolve(entry);
      return [...systemRoots, ...roots].some((root) => isWithin(normalized, root));
    });
  for (const root of roots) {
    const bin = resolve(root, "bin");
    if (existsSync(bin) && !entries.includes(bin)) entries.unshift(bin);
  }
  return [...new Set(entries)].join(delimiter);
}

/**
 * Build the minimal environment for a sandboxed process: a fixed `HOME`,
 * `TMPDIR`, and a scrubbed `PATH` from {@link sandboxPath}, plus a small
 * allowlist (`LANG`, `TZ`, `TERM`, `NO_COLOR`, all `LC_*`, and any `passEnv`
 * names) carried over from the host when present.
 */
function minimalEnv(
  passEnv: readonly string[] = [],
  runtimePaths: readonly string[] = [],
  temporaryRoot = "/tmp",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: "/home/clarvis",
    PATH: sandboxPath(runtimePaths),
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
  };
  for (const name of ["LANG", "TZ", "TERM", "NO_COLOR", ...passEnv]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LC_") && value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Everything {@link sandboxCommand} needs to build one spawn.
 *
 * @remarks An object rather than a positional list because the two injectable
 *   seams sit at the end: a caller that wants only `shell` had to pass
 *   `undefined` for `probe` to reach it, and every field added past them made
 *   that worse.
 */
export interface SandboxCommandArgs {
  /** The shell string to run (executed via `sh -c`). */
  command: string;
  /** The working directory; also the `--chdir` target inside the sandbox. */
  cwd: string;
  /**
   * The workspace, bound writable (or read-only) as the sandbox's one writable
   * tree.
   */
  workspaceRoot: string;
  /** Git metadata roots discovered and pinned when the toolset was constructed. */
  gitMetadataPaths?: readonly string[] | undefined;
  /**
   * The sandbox policy, or `undefined` to run unsandboxed with the host
   * environment.
   */
  sandbox?: SandboxConfig | undefined;
  /**
   * Where a silently dropped `optional` sandbox is reported; defaults to
   * {@link NOOP_TOOLS_LOGGER}.
   */
  logger?: ToolsLogger | undefined;
  /**
   * Environment variable names holding credentials, subtracted from the
   * inherited environment on the unsandboxed path.
   *
   * @remarks
   * Ignored under bubblewrap, which builds its environment from nothing via
   * {@link minimalEnv} and where `passEnv` is already the only way in. This
   * exists for the bare path, which is what runs on macOS and Windows and on any
   * Linux host without bubblewrap — there, an agent's own shell tool could
   * simply print the host's API keys, and a command that exfiltrates them is
   * indistinguishable from one that legitimately reads the environment.
   */
  secretEnvNames?: readonly string[] | undefined;
  /** Run-owned scratch root mounted writable and exposed through TMPDIR/TEMP/TMP. */
  temporaryRoot?: string | undefined;
  /**
   * Bubblewrap capability probe; defaults to {@link probeBubblewrap} and is
   * injectable for tests.
   */
  probe?: () => BubblewrapProbe;
  /** Host shell resolver; defaults to {@link resolveShell}, injectable for tests. */
  shell?: () => ShellSpec;
}

/**
 * Copy an environment, dropping the named variables.
 *
 * @param env - the environment to copy from.
 * @param names - variable names to omit; `undefined` or empty copies everything.
 * @returns a new environment record. The input is never mutated.
 */
function withoutSecrets(
  env: NodeJS.ProcessEnv,
  names: readonly string[] | undefined,
): NodeJS.ProcessEnv {
  if (names === undefined || names.length === 0) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of names) delete out[name];
  return out;
}

/**
 * Turn a shell command into a {@link SandboxedCommand}, either bare or wrapped
 * in a locked-down `bwrap` invocation per the `sandbox` config.
 *
 * @param args_ - see {@link SandboxCommandArgs}.
 * @returns the executable, args, and spawn options to run.
 * @throws {@link ToolError} (`io_error`) when the sandbox is required but
 *   bubblewrap is unavailable; (`invalid_input`) when a read-only path is
 *   relative or {@link validateReadOnlyPath} rejects it.
 * @remarks
 * When `sandbox` is undefined, or unavailable with `availability: "optional"`,
 * the command runs bare through the host shell with the host environment less
 * {@link SandboxCommandArgs.secretEnvNames | secretEnvNames}. Otherwise it
 * drops all capabilities and unshares user/pid/ipc/uts (and net when
 * `network: "none"`), binds core system paths read-only, binds the workspace per
 * `filesystem`, adds each validated read-only/runtime path, and runs with the
 * scrubbed {@link minimalEnv}. With networking on, {@link resolverMounts} is
 * added so DNS resolves.
 *
 * The bubblewrap branch is reachable only with a POSIX shell - bubblewrap
 * requires Linux, and Linux implies `sh` - so its tail is always `sh -c` in
 * practice even though it is written in terms of the resolved shell.
 */
export function sandboxCommand(args_: SandboxCommandArgs): SandboxedCommand {
  const {
    command,
    cwd,
    workspaceRoot,
    gitMetadataPaths = [],
    sandbox,
    secretEnvNames,
    temporaryRoot,
    probe = probeBubblewrap,
    shell = resolveShell,
    logger = NOOP_TOOLS_LOGGER,
  } = args_;
  const host = shell();
  const bare = (): SandboxedCommand => {
    const env = withoutSecrets(process.env, secretEnvNames);
    const commandEnv = temporaryRoot
      ? { ...env, TMPDIR: temporaryRoot, TEMP: temporaryRoot, TMP: temporaryRoot }
      : env;
    return {
      file: host.file,
      args: shellArgs(host, command),
      options: { cwd, env: commandEnv },
      sandboxed: false,
    };
  };
  if (sandbox === undefined) return bare();
  const support = probe();
  if (support.mode === "unavailable" && sandbox.availability === "optional") {
    logger.warn(
      { event: "tools.sandbox_unavailable", requested: sandbox.type, reason: support.reason },
      "the configured sandbox is unavailable on this host and was declared optional; the command runs unsandboxed",
    );
    return bare();
  }
  if (support.mode === "unavailable") {
    throw new ToolError("io_error", `Bubblewrap sandbox is required: ${support.reason}`);
  }

  const root = resolve(workspaceRoot);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--cap-drop",
    "ALL",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/home",
    "--dir",
    "/home/clarvis",
  ];
  args.push(
    support.mode === "host-proc" ? "--ro-bind" : "--proc",
    "/proc",
    ...(support.mode === "host-proc" ? ["/proc"] : []),
  );
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
    mountSystemPath(args, path);
  }
  args.push(sandbox.filesystem === "workspace-read-only" ? "--ro-bind" : "--bind", root, root);
  for (const path of gitMetadataPaths) {
    args.push(sandbox.filesystem === "workspace-read-only" ? "--ro-bind" : "--bind", path, path);
  }
  if (temporaryRoot !== undefined) {
    const scratch = resolve(temporaryRoot);
    if (existsSync(scratch)) args.push("--bind", scratch, scratch);
  }
  const readOnlyPaths = [...(sandbox.readOnlyPaths ?? []), ...(sandbox.runtimePaths ?? [])];
  for (const extra of new Set(readOnlyPaths)) {
    if (!isAbsolute(extra)) {
      throw new ToolError("invalid_input", `Sandbox read-only path must be absolute: ${extra}`);
    }
    const path = resolve(extra);
    validateReadOnlyPath(path, root);
    if (existsSync(path)) args.push("--ro-bind", path, path);
  }
  if (sandbox.network === "none") args.push("--unshare-net");
  else args.push(...resolverMounts());
  args.push("--chdir", cwd, "--", host.file, ...shellArgs(host, command));
  return {
    file: "bwrap",
    args,
    options: {
      cwd,
      env: minimalEnv(sandbox.passEnv, sandbox.runtimePaths, temporaryRoot),
    },
    sandboxed: true,
  };
}

const POSIX_SYSTEM_EXECUTABLE_ROOTS = ["/usr", "/bin", "/sbin", "/usr/local"];

/**
 * The prefixes below which an executable belongs to the platform rather than to
 * a version manager.
 *
 * @param platform - host platform; injectable so the Windows roots are testable
 *   from a POSIX host.
 * @returns the system roots for that platform.
 * @remarks
 * On Windows this is not cosmetic. The `<root>/bin/<command>` layout that
 * {@link installationRoot}'s fallback assumes does not hold there -
 * `dotnet.exe` lives directly in `C:\Program Files\dotnet\`, so the
 * grandparent fallback would report `C:\Program Files` as an install root.
 * Classifying these as system roots returns nothing at all instead, which is
 * honest.
 */
export function systemExecutableRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return POSIX_SYSTEM_EXECUTABLE_ROOTS;
  return [
    process.env.SystemRoot ?? "C:\\Windows",
    process.env.ProgramFiles ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ];
}

/** The subset of `node:path` these helpers need, so `path.win32` can stand in
 * for the host module when reasoning about Windows layouts from a POSIX host. */
type PlatformPath = Pick<typeof nodePath, "sep" | "relative" | "isAbsolute" | "dirname">;

/**
 * Rewrite a native path to forward-slash form so the install-layout patterns
 * need only one separator. Identity on POSIX.
 *
 * @remarks The substitution is one character for one character, so an index into
 *   the rewritten string indexes the native string identically - which is what
 *   lets {@link installationRoot} return a native-separator root from a match
 *   made against the rewritten form.
 */
function toPosix(p: string, separator = sep): string {
  return p.split(separator).join("/");
}

/** Install layouts that pin a version, in the order they are tried. */
const INSTALL_ROOT_PATTERNS = [
  /^(.*\/(?:mise|asdf)\/installs\/[^/]+\/[^/]+)(?:\/|$)/,
  /^(.*\/\.nvm\/versions\/node\/[^/]+)(?:\/|$)/,
  /^(.*\/\.pyenv\/versions\/[^/]+)(?:\/|$)/,
  /^(.*\/\.rustup\/toolchains\/[^/]+)(?:\/|$)/,
  /^(.*\/\.sdkman\/candidates\/[^/]+\/[^/]+)(?:\/|$)/,
  /^(.*\/\.volta\/tools\/image\/[^/]+\/[^/]+)(?:\/|$)/,
  /^(.*\/(?:Cellar|homebrew\/Cellar)\/[^/]+\/[^/]+)(?:\/|$)/,
];

/**
 * The known language toolchains, each mapping a stable id to the CLI commands
 * that belong to it. The first command in each list is the probe used to decide
 * whether the toolchain is present on the host.
 */
export const TOOLCHAIN_COMMANDS = {
  bun: ["bun", "bunx"],
  node: ["node", "npm", "npx", "corepack"],
  python3: ["python3", "pip3"],
  python: ["python", "pip"],
  rust: ["rustc", "cargo", "rustup"],
  go: ["go", "gofmt"],
  java: ["java", "javac", "mvn", "gradle"],
  dotnet: ["dotnet"],
  ruby: ["ruby", "gem", "bundle"],
  deno: ["deno"],
  php: ["php", "composer"],
  zig: ["zig"],
  "c-cpp": ["cc", "c++", "gcc", "g++", "clang", "clang++"],
  kotlin: ["kotlin", "kotlinc"],
  swift: ["swift", "swiftc"],
} as const;

/** The id of a known toolchain; a key of {@link TOOLCHAIN_COMMANDS}. */
export type ToolchainId = keyof typeof TOOLCHAIN_COMMANDS;

/**
 * The result of probing one toolchain on the host: whether it is `available`
 * and, when so, where it lives and how it is managed.
 *
 * @remarks
 * `logicalPath` is the executable as found on `PATH`; `resolvedPath` is that
 * path with symlinks resolved; `root` is the inferred install prefix; `manager`
 * names the version manager it belongs to (see the `managerOf` heuristic);
 * `version` is the first line of `--version`. `commands` lists the subset of the
 * toolchain's commands actually found on `PATH`. When `available` is `false`,
 * `error` explains why and the location fields may be absent.
 */
export interface DiscoveredToolchain {
  id: ToolchainId;
  commands: string[];
  available: boolean;
  logicalPath?: string;
  resolvedPath?: string;
  root?: string;
  manager?: string;
  version?: string;
  error?: string;
}

/**
 * Classify which version manager an executable path belongs to (`mise`, `asdf`,
 * `nvm`, `pyenv`, `rustup`, `sdkman`, `volta`, `homebrew`), returning `system`
 * for paths under a {@link systemExecutableRoots} prefix and `custom` otherwise,
 * by matching well-known install-directory substrings.
 *
 * @param path - the resolved executable path, in native separators.
 * @param pathApi - the path flavor to reason with; injectable so Windows
 *   layouts are testable from a POSIX host.
 * @param systemRoots - the platform's own executable roots.
 * @remarks Matching happens against a forward-slash rewrite so each layout needs
 *   only one spelling, while {@link isWithin} keeps the native path because it
 *   compares through `node:path`.
 */
export function managerOf(
  path: string,
  pathApi: PlatformPath = nodePath,
  systemRoots = systemExecutableRoots(),
): string {
  const posix = toPosix(path, pathApi.sep);
  if (posix.includes("/mise/installs/")) return "mise";
  if (posix.includes("/asdf/installs/")) return "asdf";
  if (posix.includes("/.nvm/versions/")) return "nvm";
  if (posix.includes("/.pyenv/versions/")) return "pyenv";
  if (posix.includes("/.rustup/toolchains/")) return "rustup";
  if (posix.includes("/.sdkman/candidates/")) return "sdkman";
  if (posix.includes("/.volta/tools/")) return "volta";
  if (posix.includes("/Cellar/") || posix.includes("/homebrew/")) return "homebrew";
  if (systemRoots.some((root) => isWithin(path, root, pathApi))) return "system";
  return "custom";
}

/**
 * Infer the install prefix of an executable path: `undefined` for system paths,
 * the version-pinned root for a recognized manager layout (mise/asdf/nvm/pyenv/
 * rustup/sdkman/volta/homebrew), or the grandparent directory (`.../bin/x` ->
 * `...`) as a fallback.
 *
 * @param path - the resolved executable path, in native separators.
 * @param pathApi - the path flavor to reason with; injectable for tests.
 * @param systemRoots - the platform's own executable roots.
 * @returns the install root in *native* separators, or `undefined`.
 * @remarks The match is made against a forward-slash rewrite, but the result is
 *   sliced out of the original: {@link toPosix} preserves length, so the matched
 *   prefix has the same extent in both spellings.
 */
export function installationRoot(
  path: string,
  pathApi: PlatformPath = nodePath,
  systemRoots = systemExecutableRoots(),
): string | undefined {
  if (systemRoots.some((root) => isWithin(path, root, pathApi))) return undefined;
  const posix = toPosix(path, pathApi.sep);
  const marker = INSTALL_ROOT_PATTERNS.map((re) => re.exec(posix)?.[1]).find(
    (value): value is string => value !== undefined,
  );
  if (marker !== undefined) return path.slice(0, marker.length);
  return pathApi.dirname(pathApi.dirname(path));
}

/** Extensions Windows will not spawn directly, and must route through `cmd`. */
const WINDOWS_SHELL_SCRIPTS = new Set([".cmd", ".bat"]);

/**
 * Run `command --version` and return its first line (capped at 160 chars), or
 * `undefined` if the process fails to exit cleanly. Bounded by a 2s timeout.
 *
 * @remarks
 * A `.cmd` or `.bat` cannot be spawned directly - Node refuses to, as the
 * mitigation for a command-injection vulnerability in how the arguments were
 * passed. On Windows most toolchain entry points are exactly that (`npm`,
 * `npx`, `bunx`, `gradle`, `mvn`, `composer`, `kotlinc`), so without the `cmd`
 * route this reports nearly every toolchain as unavailable.
 *
 * `/d` skips `AutoRun`, `/s` fixes the quote handling so a path containing
 * spaces survives, and `windowsVerbatimArguments` stops the runtime re-quoting
 * a line that `cmd` will parse itself. `command` is a path this module resolved
 * from `PATH` and the only argument is the literal `--version`, so nothing
 * caller-supplied reaches the command line.
 */
function versionOf(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const options = { env, encoding: "utf8" as const, timeout: 2_000, windowsHide: true };
  const result =
    process.platform === "win32" && WINDOWS_SHELL_SCRIPTS.has(extname(command).toLowerCase())
      ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${command}" --version`], {
          ...options,
          windowsVerbatimArguments: true,
        })
      : spawnSync(command, ["--version"], options);
  if (result.status !== 0) return undefined;
  return `${result.stdout}${result.stderr}`.trim().split(/\r?\n/, 1)[0]?.slice(0, 160);
}

/**
 * Probe the host for installed language toolchains.
 *
 * @param include - ids to probe; defaults to every {@link TOOLCHAIN_COMMANDS}
 *   entry. Ids not in this set are skipped.
 * @returns one {@link DiscoveredToolchain} per included, known id, in
 *   {@link TOOLCHAIN_COMMANDS} order.
 * @remarks
 * A toolchain is reported unavailable (with an `error`) when its probe command
 * is absent from `PATH` or when resolving its real path throws; otherwise its
 * location, `manager`, `version`, and the subset of present `commands` are
 * filled in. Purely read-only host inspection - it spawns each present
 * toolchain's `--version` but changes nothing.
 */
export function discoverToolchains(
  include: readonly string[] = Object.keys(TOOLCHAIN_COMMANDS),
): DiscoveredToolchain[] {
  const wanted = new Set(include);
  const out: DiscoveredToolchain[] = [];
  for (const [rawId, allCommands] of Object.entries(TOOLCHAIN_COMMANDS)) {
    const id = rawId as ToolchainId;
    if (!wanted.has(id)) continue;
    const logicalPath = executableOnPath(allCommands[0]);
    if (!logicalPath) {
      out.push({
        id,
        commands: [...allCommands],
        available: false,
        error: `${allCommands[0]} was not found on the host PATH`,
      });
      continue;
    }
    try {
      const resolvedPath = realpathSync(logicalPath);
      const logicalRoot = installationRoot(logicalPath);
      const resolvedRoot = installationRoot(resolvedPath);
      const root =
        logicalRoot && resolvedRoot && logicalRoot !== resolvedRoot
          ? dirname(logicalRoot) === dirname(resolvedRoot)
            ? dirname(logicalRoot)
            : resolvedRoot
          : (resolvedRoot ?? logicalRoot);
      const version = versionOf(logicalPath, process.env);
      out.push({
        id,
        commands: allCommands.filter((command) => executableOnPath(command) !== undefined),
        available: true,
        logicalPath,
        resolvedPath,
        ...(root !== undefined ? { root } : {}),
        manager: managerOf(resolvedPath),
        ...(version !== undefined ? { version } : {}),
      });
    } catch (error) {
      out.push({
        id,
        commands: [...allCommands],
        available: false,
        logicalPath,
        error: String(error),
      });
    }
  }
  return out;
}
