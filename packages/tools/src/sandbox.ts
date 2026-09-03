import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath, { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync, type SpawnOptions, type SpawnSyncReturns } from "node:child_process";
import { ToolError } from "./errors.ts";
import { executableOnPath } from "@clarvis/paths";
import { resolveShell, shellArgs, type ShellSpec } from "./shell.ts";
import { NOOP_TOOLS_LOGGER, type ToolsLogger } from "./lib/log.ts";
import { systemExecutableRoots } from "./lib/system-executables.ts";

export { systemExecutableRoots } from "./lib/system-executables.ts";

/**
 * Configuration for running a command inside the host's native sandbox.
 *
 * @remarks
 * Clarvis selects Bubblewrap on Linux and Seatbelt on macOS. `availability:
 * "optional"` lets a command fall back to running unsandboxed when the native
 * backend is unavailable, whereas `"required"` (the default posture in
 * {@link sandboxCommand}) makes that a hard error. `readOnlyPaths` and
 * `runtimePaths` are exposed read-only; `runtimePaths` additionally shape the
 * sandboxed `PATH`. `passEnv` names extra host env vars to carry through the
 * otherwise minimal environment.
 */
export interface NativeSandbox {
  type: "native";
  availability?: "required" | "optional";
  filesystem?: "workspace-write" | "workspace-read-only";
  network?: "host" | "none";
  passEnv?: string[];
  readOnlyPaths?: string[];
  runtimePaths?: string[];
}

/** The supported sandbox configurations. */
export type SandboxConfig = NativeSandbox;

/**
 * A ready-to-spawn command: the executable `file`, its `args`, and the `cwd`/
 * `env` spawn options — bare or wrapped by Bubblewrap/Seatbelt, as decided by
 * {@link sandboxCommand}.
 */
export interface SandboxedCommand {
  file: string;
  args: string[];
  options: Pick<SpawnOptions, "cwd" | "env">;
  /**
   * Whether the command is actually wrapped in the selected native backend.
   *
   * @remarks False both when no sandbox was configured and when one was
   *   configured `optional` and the host cannot provide it — the caller needs
   *   the distinction to report what a spawn really ran under, and it is not
   *   recoverable from `file`/`args` without re-parsing them.
   */
  sandboxed: boolean;
}

/**
 * The outcome of probing Bubblewrap on this host: usable with a fresh `/proc`,
 * usable only by bind-mounting the host `/proc`, or unavailable.
 */
export type BubblewrapProbe =
  | { backend: "bubblewrap"; mode: "fresh-proc" | "host-proc" }
  | { backend: "bubblewrap"; mode: "unavailable"; reason: string };

/** The outcome of probing the macOS Seatbelt command-line backend. */
export type SeatbeltProbe =
  | { backend: "seatbelt"; mode: "seatbelt" }
  | { backend: "seatbelt"; mode: "unavailable"; reason: string };

/** The native sandbox backend usable on this host, or why none is usable. */
export type SandboxProbe =
  BubblewrapProbe | SeatbeltProbe | { backend: "unsupported"; mode: "unavailable"; reason: string };

let cachedBubblewrapProbe: BubblewrapProbe | undefined;
let cachedSeatbeltProbe: SeatbeltProbe | undefined;
let cachedSandboxProbe: SandboxProbe | undefined;

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
      backend: "bubblewrap",
      mode: "unavailable",
      reason: `Bubblewrap is supported only on Linux (host platform: ${platform})`,
    };
  }
  const version = probeSpawnSync("bwrap", ["--version"], { stdio: "ignore" });
  if (version.error || version.status !== 0) {
    return {
      backend: "bubblewrap",
      mode: "unavailable",
      reason: "bwrap executable was not found",
    };
  }
  if (probeSpawnSync("bwrap", probeArgs("fresh-proc"), { stdio: "ignore" }).status === 0) {
    return { backend: "bubblewrap", mode: "fresh-proc" };
  }
  if (probeSpawnSync("bwrap", probeArgs("host-proc"), { stdio: "ignore" }).status === 0) {
    return { backend: "bubblewrap", mode: "host-proc" };
  }
  return {
    backend: "bubblewrap",
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
  if (deps === undefined) return (cachedBubblewrapProbe ??= computeProbe({}));
  return computeProbe(deps);
}

/** Injectable seams for {@link probeSeatbelt}. */
export interface SeatbeltProbeDeps {
  platform?: NodeJS.Platform;
  /** `child_process.spawnSync`; defaults to the real one. */
  spawnSync?: (
    command: string,
    args: string[],
    options: { stdio: "ignore" },
  ) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
}

const SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";
const SEATBELT_PROBE_PROFILE = `(version 1)\n(allow default)\n(deny file-write*)`;

/** {@link probeSeatbelt}'s uncached implementation. */
function computeSeatbeltProbe(deps: SeatbeltProbeDeps): SeatbeltProbe {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      backend: "seatbelt",
      mode: "unavailable",
      reason: `Seatbelt is supported only on macOS (host platform: ${platform})`,
    };
  }
  const probeSpawnSync = deps.spawnSync ?? spawnSync;
  const result = probeSpawnSync(
    SEATBELT_EXECUTABLE,
    ["-p", SEATBELT_PROBE_PROFILE, "/usr/bin/true"],
    { stdio: "ignore" },
  );
  if (result.error || result.status !== 0) {
    return {
      backend: "seatbelt",
      mode: "unavailable",
      reason: "sandbox-exec could not apply the Clarvis Seatbelt profile",
    };
  }
  return { backend: "seatbelt", mode: "seatbelt" };
}

/**
 * Detect whether macOS Seatbelt can apply a process profile on this host.
 *
 * @param deps - test seams. An injected call is never cached.
 * @returns `seatbelt` after a real profile launch, otherwise `unavailable`.
 */
export function probeSeatbelt(deps?: SeatbeltProbeDeps): SeatbeltProbe {
  if (deps === undefined) return (cachedSeatbeltProbe ??= computeSeatbeltProbe({}));
  return computeSeatbeltProbe(deps);
}

/** Injectable seams for {@link probeSandbox}. */
export interface SandboxProbeDeps {
  platform?: NodeJS.Platform;
  /** Shared process-spawn seam passed to the selected backend probe. */
  spawnSync?: BubblewrapProbeDeps["spawnSync"];
}

/** {@link probeSandbox}'s uncached platform dispatcher. */
function computeSandboxProbe(deps: SandboxProbeDeps): SandboxProbe {
  const platform = deps.platform ?? process.platform;
  if (platform === "linux") return probeBubblewrap({ platform, spawnSync: deps.spawnSync });
  if (platform === "darwin") return probeSeatbelt({ platform, spawnSync: deps.spawnSync });
  return {
    backend: "unsupported",
    mode: "unavailable",
    reason: `Native sandboxing is unsupported on host platform: ${platform}`,
  };
}

/**
 * Detect the native sandbox backend for this host.
 *
 * @param deps - test seams. An injected call is never cached.
 * @returns Bubblewrap on Linux, Seatbelt on macOS, or `unavailable` elsewhere.
 */
export function probeSandbox(deps?: SandboxProbeDeps): SandboxProbe {
  if (deps === undefined) return (cachedSandboxProbe ??= computeSandboxProbe({}));
  return computeSandboxProbe(deps);
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
 * @returns `/`, `/home`, the user's home parent, and the user's home directory,
 *   including their canonical spellings when they differ.
 * @remarks A function rather than a constant because `homedir()` is read at call
 *   time; a module-level array would freeze whatever `HOME` was when the module
 *   first loaded, which a test that moves `HOME` then silently disagrees with.
 *   It is exported because the host-side validator in `@clarvis/loop`
 *   (`runtime/capabilities/sandbox-host-policy.ts`) enforces the same roots with
 *   a different return convention, and spelling them twice is how
 *   one side gains a root the other does not.
 */
export function forbiddenSandboxRoots(): string[] {
  const home = resolve(homedir());
  return [
    ...new Set(
      [resolve("/"), resolve("/home"), dirname(home), home].flatMap((path) => [
        path,
        canonicalOrSelf(path),
      ]),
    ),
  ];
}

/**
 * Discover the host temporary roots that workspace-confined coding tools may
 * use for compatibility with native CLIs.
 *
 * @param platform - Host platform; injectable for cross-platform tests.
 * @param environmentTemporaryRoot - The host's resolved temporary directory;
 *   defaults to {@link tmpdir}.
 * @returns Existing, non-forbidden roots in precedence order. POSIX hosts add
 *   `/tmp` beside the environment-selected root, matching common CLI sandbox
 *   policy; Windows uses only its environment-selected root.
 * @remarks These paths are access policy, not lifecycle ownership. A caller
 *   must never infer that returning a root authorizes deleting it.
 */
export function systemTemporaryRoots(
  platform: NodeJS.Platform = process.platform,
  environmentTemporaryRoot: string = tmpdir(),
): string[] {
  const forbidden = new Set(forbiddenSandboxRoots());
  const roots: string[] = [];
  for (const candidate of platform === "win32"
    ? [environmentTemporaryRoot]
    : [environmentTemporaryRoot, "/tmp"]) {
    const resolved = resolve(candidate);
    if (forbidden.has(resolved) || forbidden.has(canonicalOrSelf(resolved))) continue;
    try {
      if (!statSync(resolved).isDirectory() || roots.includes(resolved)) continue;
    } catch {
      continue;
    }
    roots.push(resolved);
  }
  return roots;
}

/**
 * Reject a caller-supplied read-only mount that is dangerously broad (`/`,
 * `/home`, the user's home parent, or the user's home) or that would shadow the
 * workspace by containing it.
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
 * `runtimePaths`, ensure the standard system executable directories remain
 * available even when the host `PATH` was reduced, and prepend each runtime
 * root's `bin`. Entries are deduplicated while preserving order.
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
  for (const path of ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    if (existsSync(path) && !entries.includes(path)) entries.push(path);
  }
  for (const root of roots) {
    const bin = resolve(root, "bin");
    if (existsSync(bin) && !entries.includes(bin)) entries.unshift(bin);
  }
  return [...new Set(entries)].join(delimiter);
}

/**
 * Build the minimal environment for a sandboxed process: a fixed `HOME`,
 * `TMPDIR`, a scrubbed `PATH` from {@link sandboxPath}, and an absolute POSIX
 * npm script shell, plus a small allowlist (`LANG`, `TZ`, `TERM`, `NO_COLOR`,
 * all `LC_*`, and any `passEnv` names) carried over from the host when present.
 *
 * @remarks npm otherwise resolves bare `sh` through synthetic ancestor
 * `node_modules/.bin` entries. A deliberately hidden Seatbelt path can make
 * that lookup return `EPERM` before the admitted system shell is reached.
 */
function minimalEnv(
  passEnv: readonly string[] = [],
  runtimePaths: readonly string[] = [],
  temporaryRoot = "/tmp",
  home = "/home/clarvis",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: sandboxPath(runtimePaths),
    TMPDIR: temporaryRoot,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    ...(process.platform === "win32" ? {} : { npm_config_script_shell: "/bin/sh" }),
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
  /** The workspace, bound writable or read-only according to the sandbox policy. */
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
   * Ignored under a native backend, which builds its environment from nothing
   * via {@link minimalEnv} and where `passEnv` is already the only way in. This
   * exists for the bare path on an unsupported host or an explicitly optional
   * fallback — there, an agent's own shell tool could simply print the host's
   * API keys, and a command that exfiltrates them is indistinguishable from one
   * that legitimately reads the environment.
   */
  secretEnvNames?: readonly string[] | undefined;
  /**
   * Writable temporary roots. The first is exposed through TMPDIR/TEMP/TMP;
   * remaining entries are compatibility roots for host-native temporary paths.
   */
  temporaryRoots?: readonly string[] | undefined;
  /**
   * Native capability probe; defaults to {@link probeSandbox} and is injectable
   * for tests.
   */
  probe?: () => SandboxProbe;
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

/** Validate and de-duplicate every caller-supplied read-only root. */
function validatedReadOnlyPaths(sandbox: SandboxConfig, workspaceRoot: string): string[] {
  const paths = [...(sandbox.readOnlyPaths ?? []), ...(sandbox.runtimePaths ?? [])];
  const validated: string[] = [];
  const workspacePaths = pathVariants(workspaceRoot);
  for (const extra of new Set(paths)) {
    if (!isAbsolute(extra)) {
      throw new ToolError("invalid_input", `Sandbox read-only path must be absolute: ${extra}`);
    }
    const path = resolve(extra);
    for (const candidate of pathVariants(path)) {
      for (const workspace of workspacePaths) validateReadOnlyPath(candidate, workspace);
    }
    if (existsSync(path)) validated.push(path);
  }
  return validated;
}

/** Return the normalized authored path and its filesystem-canonical target. */
function pathVariants(path: string): string[] {
  const normalized = resolve(path);
  return [...new Set([normalized, canonicalOrSelf(normalized)])];
}

const SEATBELT_SYSTEM_READ_FILTERS = [
  '(literal "/")',
  '(subpath "/System")',
  '(subpath "/usr")',
  '(subpath "/bin")',
  '(subpath "/sbin")',
  '(subpath "/Library/Apple")',
  '(subpath "/Library/Preferences")',
  '(subpath "/Library/Developer")',
  '(subpath "/Applications/Xcode.app")',
  '(literal "/etc")',
  '(subpath "/etc")',
  '(subpath "/private/etc")',
  '(subpath "/var/db")',
  '(subpath "/private/var/db")',
  '(literal "/var")',
  '(subpath "/var/select")',
  '(subpath "/private/var/select")',
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/random")',
  '(literal "/dev/urandom")',
] as const;

const SEATBELT_HOST_NETWORK_READ_FILTERS = [
  '(literal "/var/run/mDNSResponder")',
  '(literal "/private/var/run/mDNSResponder")',
] as const;

interface SeatbeltPolicy {
  profile: string;
  definitions: string[];
}

/**
 * Compile the filesystem and network policy shared with Bubblewrap into SBPL.
 *
 * @remarks
 * Dynamic paths are passed through `sandbox-exec -D` parameters rather than
 * interpolated into the profile. The profile starts from the host's normal
 * non-file behavior, removes all filesystem access, then admits only system
 * runtime reads, declared roots, and the configured writable trees. A final
 * deny makes a read-only path nested inside a writable workspace stay
 * read-only, matching Bubblewrap's later read-only bind.
 */
function seatbeltPolicy(args: {
  sandbox: SandboxConfig;
  workspaceRoot: string;
  gitMetadataPaths: readonly string[];
  temporaryRoots: readonly string[];
  readOnlyPaths: readonly string[];
}): SeatbeltPolicy {
  const definitions: string[] = [];
  const keys = new Map<string, string>();
  const keyFor = (path: string): string => {
    const prior = keys.get(path);
    if (prior !== undefined) return prior;
    const key = `ROOT_${keys.size}`;
    keys.set(path, key);
    definitions.push("-D", `${key}=${path}`);
    return key;
  };
  const dynamicFilter = (path: string): string => `(subpath (param "${keyFor(path)}"))`;
  const workspacePaths = pathVariants(args.workspaceRoot);
  const gitMetadataPaths = args.gitMetadataPaths.flatMap(pathVariants);
  const [primaryTemporaryRoot, ...compatibleTemporaryRoots] = args.temporaryRoots;
  const primaryTemporaryPaths =
    primaryTemporaryRoot === undefined ? [] : pathVariants(primaryTemporaryRoot);
  const compatibleTemporaryPaths = compatibleTemporaryRoots.flatMap(pathVariants);
  const temporaryPaths = [...primaryTemporaryPaths, ...compatibleTemporaryPaths];
  const readOnlyPaths = args.readOnlyPaths.flatMap(pathVariants);
  const readablePaths = [
    ...workspacePaths,
    ...gitMetadataPaths,
    ...temporaryPaths,
    ...readOnlyPaths,
  ];
  const readable = [...new Set(readablePaths.filter((path) => existsSync(path)))];
  const workspaceProtectedPaths =
    args.sandbox.filesystem === "workspace-read-only"
      ? [...workspacePaths, ...gitMetadataPaths]
      : [];
  const writableFilters = [
    ...(args.sandbox.filesystem === "workspace-read-only"
      ? []
      : [...workspacePaths, ...gitMetadataPaths]
          .filter((path) => existsSync(path))
          .map(dynamicFilter)),
    ...primaryTemporaryPaths.filter((path) => existsSync(path)).map(dynamicFilter),
    ...compatibleTemporaryPaths
      .filter((path) => existsSync(path))
      .map((path) => {
        const exclusions = workspaceProtectedPaths.map(
          (protectedPath) => `(require-not ${dynamicFilter(protectedPath)})`,
        );
        return exclusions.length === 0
          ? dynamicFilter(path)
          : `(require-all ${dynamicFilter(path)} ${exclusions.join(" ")})`;
      }),
  ];
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    "(deny process-info*)",
    "(allow process-info* (target same-sandbox))",
    "(deny file-read* file-test-existence file-map-executable file-write*)",
    `(allow file-read* file-test-existence file-map-executable ${[
      ...SEATBELT_SYSTEM_READ_FILTERS,
      ...(args.sandbox.network === "none" ? [] : SEATBELT_HOST_NETWORK_READ_FILTERS),
      ...readable.map(dynamicFilter),
    ].join(" ")})`,
    `(allow file-read-metadata file-test-existence ${readable
      .map((path) => `(path-ancestors (param "${keyFor(path)}"))`)
      .join(" ")})`,
    ...(writableFilters.length === 0
      ? []
      : [`(allow file-write* ${[...new Set(writableFilters)].join(" ")})`]),
    '(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero"))',
    ...(readOnlyPaths.length === 0
      ? []
      : [`(deny file-write* ${readOnlyPaths.map(dynamicFilter).join(" ")})`]),
    ...(args.sandbox.network === "none" ? ["(deny network*)"] : []),
  ].join("\n");
  return { profile, definitions };
}

interface BubblewrapMount {
  path: string;
  mode: "--bind" | "--ro-bind";
  precedence: number;
}

/**
 * Append bind mounts from broadest to narrowest so a nested path's more
 * specific policy wins. Equal paths order writable compatibility roots before
 * the workspace, run scratch, and final read-only declarations.
 */
function appendBubblewrapMounts(args: string[], mounts: readonly BubblewrapMount[]): void {
  const depth = (path: string): number => resolve(path).split(sep).filter(Boolean).length;
  for (const mount of [...mounts]
    .filter(({ path }) => existsSync(path))
    .sort((a, b) => depth(a.path) - depth(b.path) || a.precedence - b.precedence)) {
    args.push(mount.mode, mount.path, mount.path);
  }
}

/**
 * Turn a shell command into a {@link SandboxedCommand}, either bare or wrapped
 * in the locked-down native backend selected for this host.
 *
 * @param args_ - see {@link SandboxCommandArgs}.
 * @returns the executable, args, and spawn options to run.
 * @throws {@link ToolError} (`io_error`) when the sandbox is required but
 *   the native sandbox is unavailable; (`invalid_input`) when a read-only path is
 *   relative or {@link validateReadOnlyPath} rejects it.
 * @remarks
 * When `sandbox` is undefined, or unavailable with `availability: "optional"`,
 * the command runs bare through the host shell with the host environment less
 * {@link SandboxCommandArgs.secretEnvNames | secretEnvNames}. Otherwise,
 * Bubblewrap drops capabilities and unshares user/pid/ipc/uts, while Seatbelt
 * applies an SBPL profile to the spawned process. Both expose the same declared
 * filesystem roots, honor `network`, and run with the scrubbed
 * {@link minimalEnv}.
 */
export function sandboxCommand(args_: SandboxCommandArgs): SandboxedCommand {
  const {
    command,
    cwd,
    workspaceRoot,
    gitMetadataPaths = [],
    sandbox,
    secretEnvNames,
    temporaryRoots = [],
    probe = probeSandbox,
    shell = resolveShell,
    logger = NOOP_TOOLS_LOGGER,
  } = args_;
  const resolvedTemporaryRoots = [...new Set(temporaryRoots.map((path) => resolve(path)))];
  const primaryTemporaryRoot = resolvedTemporaryRoots[0];
  const host = shell();
  const bare = (): SandboxedCommand => {
    const env = withoutSecrets(process.env, secretEnvNames);
    const commandEnv = primaryTemporaryRoot
      ? {
          ...env,
          TMPDIR: primaryTemporaryRoot,
          TEMP: primaryTemporaryRoot,
          TMP: primaryTemporaryRoot,
        }
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
    throw new ToolError("io_error", `Native sandbox is required: ${support.reason}`);
  }

  const root = resolve(workspaceRoot);
  const readOnlyPaths = validatedReadOnlyPaths(sandbox, root);
  if (support.backend === "seatbelt") {
    const gitPaths = gitMetadataPaths.map((path) => resolve(path));
    const policy = seatbeltPolicy({
      sandbox,
      workspaceRoot: root,
      gitMetadataPaths: gitPaths,
      temporaryRoots: resolvedTemporaryRoots,
      readOnlyPaths,
    });
    const home = canonicalOrSelf(primaryTemporaryRoot ?? root);
    return {
      file: SEATBELT_EXECUTABLE,
      args: [...policy.definitions, "-p", policy.profile, host.file, ...shellArgs(host, command)],
      options: {
        cwd,
        env: minimalEnv(
          sandbox.passEnv,
          sandbox.runtimePaths,
          canonicalOrSelf(primaryTemporaryRoot ?? root),
          home,
        ),
      },
      sandboxed: true,
    };
  }

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
  appendBubblewrapMounts(args, [
    ...resolvedTemporaryRoots.map((path, index) => ({
      path,
      mode: "--bind" as const,
      precedence: index === 0 ? 2 : 0,
    })),
    {
      path: root,
      mode:
        sandbox.filesystem === "workspace-read-only" ? ("--ro-bind" as const) : ("--bind" as const),
      precedence: 1,
    },
    ...gitMetadataPaths.map((path) => ({
      path,
      mode:
        sandbox.filesystem === "workspace-read-only" ? ("--ro-bind" as const) : ("--bind" as const),
      precedence: 1,
    })),
    ...readOnlyPaths.map((path) => ({ path, mode: "--ro-bind" as const, precedence: 3 })),
  ]);
  if (sandbox.network === "none") args.push("--unshare-net");
  else args.push(...resolverMounts());
  args.push("--chdir", cwd, "--", host.file, ...shellArgs(host, command));
  return {
    file: "bwrap",
    args,
    options: {
      cwd,
      env: minimalEnv(sandbox.passEnv, sandbox.runtimePaths, primaryTemporaryRoot),
    },
    sandboxed: true,
  };
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
 * that belong to it. The first command in each list is the path-resolution
 * anchor used to decide whether the toolchain is present on the host.
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
 * names the version manager it belongs to (see the `managerOf` heuristic).
 * There is deliberately no version field: inspecting a host must not execute
 * an arbitrary discovered binary. `commands` lists the subset of the
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

/**
 * Inspect the host for installed language toolchains without executing them.
 *
 * @param include - ids to probe; defaults to every {@link TOOLCHAIN_COMMANDS}
 *   entry. Ids not in this set are skipped.
 * @returns one {@link DiscoveredToolchain} per included, known id, in
 *   {@link TOOLCHAIN_COMMANDS} order.
 * @remarks
 * A toolchain is reported unavailable (with an `error`) when its anchor command
 * is absent from `PATH` or when resolving its real path throws; otherwise its
 * location, `manager`, and the subset of present `commands` are filled in.
 * Discovery performs filesystem/path inspection only and never spawns a
 * discovered entrypoint. This is a product-safety boundary: platform shims such
 * as macOS `/usr/bin/cc` can open installers merely by being executed.
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
      out.push({
        id,
        commands: allCommands.filter((command) => executableOnPath(command) !== undefined),
        available: true,
        logicalPath,
        resolvedPath,
        ...(root !== undefined ? { root } : {}),
        manager: managerOf(resolvedPath),
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
