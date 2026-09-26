import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CLARVIS_DIR,
  SHORT_SCRATCH_BUDGET_BYTES,
  UNIX_SOCKET_PATH_BUDGET_BYTES,
  allocateShortTemporaryRoot,
  globalPaths,
  shortTemporaryRootCandidates,
  unixSocketPathFits,
  type GlobalPaths,
  type ShortTemporaryRoot,
} from "@clarvis/kernel/paths";

const RESERVED_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "CLARVIS_HOME",
  "CLARVIS_WORKSPACE_ROOT",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PATH",
  "SMOKE_API_KEY",
]);

const ALLOWED_OVERRIDE_KEYS = new Set([
  "CLARVIS_CODE_SOURCE",
  "CLARVIS_INSTALL_ROOT",
  "CLARVIS_RELEASE_DIRECTORY",
  "CLARVIS_BIN_DIR",
  "CLARVIS_SKIP_PATH",
  "CLARVIS_VERSION",
]);

const INHERITED_OPERATIONAL_KEYS = [
  "PATH",
  "BUN_INSTALL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
] as const;

/** Directory inside a fixture root that holds its sockets when the budget allows. */
const SOCKETS_DIR = "sockets";

/**
 * Bytes reserved for the longest socket name a context can create.
 *
 * @remarks The name is `<label>-<pid base36>-<counter base36>.sock`, so the
 *   reservation covers a seven-digit pid, a four-digit counter and the `tmux`
 *   label. {@link SmokeContext.socketPath} validates the real name anyway; the
 *   reservation is what decides *where* the socket directory may live.
 */
const SOCKET_NAME_RESERVE_BYTES = 22;

/** A subprocess environment override admitted by the smoke harness. */
export type SmokeEnvironmentOverride = Partial<
  Record<
    | "CLARVIS_CODE_SOURCE"
    | "CLARVIS_INSTALL_ROOT"
    | "CLARVIS_RELEASE_DIRECTORY"
    | "CLARVIS_BIN_DIR"
    | "CLARVIS_SKIP_PATH"
    | "CLARVIS_VERSION",
    string
  >
>;

/** Minimal process shape registered with a fixture's lifecycle owner. */
export interface SmokeChild {
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number>;
}

/**
 * All filesystem and environment state owned by one smoke execution.
 *
 * @remarks Every path is below {@link root}; callers receive a complete environment
 * from {@link environmentFor} rather than inheriting `process.env`. The context is
 * deliberately internal to tooling: product code must keep resolving production
 * roots through the normal `CLARVIS_HOME > HOME` contract.
 */
export interface SmokeContext {
  /** Exclusive parent removed by {@link cleanup}. */
  root: string;
  /** Synthetic HOME visible to the worker. */
  home: string;
  /** Synthetic Clarvis global root. */
  global: string;
  /** Synthetic workspace opened by the worker. */
  workspace: string;
  /** Synthetic process temporary directory. */
  tmp: string;
  /** Synthetic XDG cache directory. */
  cache: string;
  /** Synthetic diagnostic/log directory. */
  logs: string;
  /**
   * The directory this context's sockets live in.
   *
   * @remarks Inside {@link root} whenever the shortest candidate root leaves the
   *   budget for a socket name, and otherwise a short temporary root of its own,
   *   owned and removed by this context like the fixture itself. A socket path has
   *   a hard operating-system limit, so it is never left to the length of the
   *   developer's `TMPDIR`.
   */
  sockets: string;
  /** Synthetic installation root used by managed-install smoke. */
  install: string;
  /** The global path set derived from {@link global}. */
  paths: GlobalPaths;
  /** Base environment with all root-sensitive values fixed. */
  environment: Readonly<Record<string, string>>;
  /** Add a child to the lifecycle owner before it can outlive cleanup. */
  registerChild(child: SmokeChild): () => void;
  /** Build an explicit child environment after validating allowed overrides. */
  environmentFor(overrides?: SmokeEnvironmentOverride): Record<string, string>;
  /**
   * Every directory in this context a confined child may write in.
   *
   * @remarks More than one exactly when the sockets live outside {@link root},
   *   which is what makes an external socket root a declared mount rather than an
   *   accident.
   */
  writableRoots: readonly string[];
  /**
   * Reserve an exclusive socket address and validate it before any process uses it.
   *
   * @param label - a short label for the endpoint, such as `tmux`.
   * @returns the complete socket path.
   * @throws when the address does not fit the POSIX endpoint budget, so a
   *   too-deep root is reported as itself instead of as a failing backend.
   */
  socketPath(label: string): string;
  /** Terminate registered children and remove only this context's roots. */
  cleanup(): Promise<void>;
}

/** Inputs a caller may fix instead of letting the harness choose them. */
export interface SmokeContextOptions {
  /**
   * The fixture parent to allocate under.
   *
   * @remarks Bypasses candidate selection, so a caller - a test or another
   *   harness - can pin the parent. It is validated exactly as a selected
   *   candidate is: a real account-owned directory that does not overlap the
   *   operator's state.
   */
  parentRoot?: string;
  /** Ordered candidate parents; defaults to the host's short temporary roots. */
  parentCandidates?: readonly string[];
  /**
   * Ordered parents for the socket root alone; defaults to the fixture's own
   * validated parents followed by the host's short temporary roots.
   *
   * @remarks A socket address has an operating-system limit, so the socket root
   *   must be able to escape a parent that is too long for one. Every candidate
   *   here is validated exactly like a fixture parent, and when none can hold a
   *   short enough allocation the context fails with
   *   `smoke_socket_root_unavailable` instead of reserving an address that cannot
   *   work.
   */
  socketParentCandidates?: readonly string[];
}

/** Parents a fixture may allocate under, and the candidates that were refused. */
interface ValidatedParents {
  /** Canonical parents that passed validation, in the order they were requested. */
  parents: string[];
  /** One `<candidate>: <reason>` entry per refusal, for the failure message. */
  refused: string[];
}

/** One refusal reason, whether an `Error` or anything else was thrown. */
function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Canonical, deduplicated, validated parents for one requested candidate list. */
async function validateParents(requested: readonly string[]): Promise<ValidatedParents> {
  const parents: string[] = [];
  const refused: string[] = [];
  for (const candidate of requested) {
    try {
      const parent = await assertSafeParent(candidate);
      if (!parents.includes(parent)) parents.push(parent);
    } catch (error) {
      refused.push(`${candidate}: ${refusalReason(error)}`);
    }
  }
  return { parents, refused };
}

/** The parents a fixture may live under when the caller fixes none. */
function fixtureParentRequest(options: SmokeContextOptions): readonly string[] {
  if (options.parentRoot !== undefined) return [options.parentRoot];
  return (
    options.parentCandidates ??
    shortTemporaryRootCandidates({ budgetBytes: SHORT_SCRATCH_BUDGET_BYTES })
  );
}

/**
 * The parents a socket root may be allocated under.
 *
 * @param options - the caller's explicit socket parents, if any.
 * @param fixtureParents - the fixture's own validated parents.
 * @returns the candidate list, unextended when the caller fixed one.
 *
 * @remarks The fixture's validated parents come first, so a caller that pinned a
 *   short parent keeps its sockets there. The host's short temporary roots follow,
 *   because escaping a parent that is too long is the entire point of a separate
 *   socket root: a pinned deep temporary directory must not make the endpoint
 *   unreservable. An explicit list is used exactly as given, which is what lets a
 *   caller prove the failure rather than depend on the host.
 */
function socketParentRequest(
  options: SmokeContextOptions,
  fixtureParents: readonly string[],
): readonly string[] {
  if (options.socketParentCandidates !== undefined) return options.socketParentCandidates;
  return [
    ...fixtureParents,
    ...shortTemporaryRootCandidates({ budgetBytes: SHORT_SCRATCH_BUDGET_BYTES }),
  ];
}

/**
 * Remove a context's allocations, newest first.
 *
 * @param allocations - everything this context allocated, fixture root included.
 * @returns nothing; every `remove()` is idempotent and refuses a path it cannot
 *   still prove is its own allocation.
 */
function releaseAllocations(allocations: readonly ShortTemporaryRoot[]): void {
  for (const allocation of [...allocations].reverse()) allocation.remove();
}

function isWithin(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function pathOverlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

async function assertSafeParent(parent: string): Promise<string> {
  const resolvedParent = await canonical(parent);
  const stat = await lstat(resolvedParent).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("smoke_fixture_parent_must_be_a_real_directory");
  }

  const operatorHome = await canonical(homedir());
  const operatorGlobal = await canonical(
    process.env.CLARVIS_HOME?.trim() || join(operatorHome, CLARVIS_DIR),
  );
  const protectedRoots = [
    operatorGlobal,
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
  ]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((value) => resolve(value));

  for (const protectedRoot of protectedRoots) {
    const resolved = await canonical(protectedRoot);
    if (isWithin(resolvedParent, resolved)) {
      throw new Error("smoke_fixture_parent_overlaps_operator_state");
    }
  }
  return resolvedParent;
}

async function assertSafeFixtureRoot(root: string): Promise<void> {
  const operatorHome = await canonical(homedir());
  const protectedRoots = [
    process.env.CLARVIS_HOME?.trim() || join(operatorHome, CLARVIS_DIR),
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
  ]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((value) => resolve(value));
  for (const protectedRoot of protectedRoots) {
    if (pathOverlaps(root, await canonical(protectedRoot))) {
      throw new Error("smoke_fixture_root_overlaps_operator_state");
    }
  }
}

async function assertOwnedDirectory(path: string, root: string): Promise<void> {
  if (!isWithin(path, root)) throw new Error("smoke_fixture_path_escaped_root");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("smoke_fixture_path_not_directory");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("smoke_fixture_path_has_foreign_owner");
  }
}

async function createDirectories(
  contextRoot: string,
): Promise<
  Pick<
    SmokeContext,
    "home" | "global" | "workspace" | "tmp" | "cache" | "logs" | "sockets" | "install"
  >
> {
  const paths = {
    home: join(contextRoot, "home"),
    global: join(contextRoot, "global"),
    workspace: join(contextRoot, "workspace"),
    tmp: join(contextRoot, "tmp"),
    cache: join(contextRoot, "cache"),
    logs: join(contextRoot, "logs"),
    sockets: join(contextRoot, "sockets"),
    install: join(contextRoot, "install"),
  };
  for (const path of Object.values(paths)) {
    await mkdir(path, { recursive: false, mode: 0o700 });
    await assertOwnedDirectory(path, contextRoot);
  }
  return paths;
}

function validateOverridePath(value: string, key: string, root: string): string {
  if (!isAbsolute(value)) throw new Error(`smoke_override_must_be_absolute:${key}`);
  const resolved = resolve(value);
  if (!isWithin(resolved, root)) throw new Error(`smoke_override_outside_fixture:${key}`);
  return resolved;
}

function validateOverrides(
  overrides: SmokeEnvironmentOverride,
  root: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!ALLOWED_OVERRIDE_KEYS.has(key)) {
      if (RESERVED_ENVIRONMENT_KEYS.has(key)) throw new Error(`smoke_override_reserved:${key}`);
      throw new Error(`smoke_override_not_allowed:${key}`);
    }
    if (
      key === "CLARVIS_INSTALL_ROOT" ||
      key === "CLARVIS_RELEASE_DIRECTORY" ||
      key === "CLARVIS_BIN_DIR"
    ) {
      result[key] = validateOverridePath(value, key, root);
    } else {
      if (value.includes("\u0000")) throw new Error(`smoke_override_invalid:${key}`);
      result[key] = value;
    }
  }
  return result;
}

function baseEnvironment(
  context: Pick<
    SmokeContext,
    "home" | "global" | "workspace" | "tmp" | "cache" | "logs" | "sockets"
  >,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of INHERITED_OPERATIONAL_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value.trim().length > 0) environment[key] = value;
  }
  environment.HOME = context.home;
  environment.CLARVIS_HOME = context.global;
  environment.CLARVIS_WORKSPACE_ROOT = context.workspace;
  environment.TMPDIR = context.tmp;
  environment.TMP = context.tmp;
  environment.TEMP = context.tmp;
  environment.XDG_CONFIG_HOME = join(context.home, ".config");
  environment.XDG_CACHE_HOME = context.cache;
  environment.XDG_DATA_HOME = join(context.home, ".local", "share");
  environment.XDG_STATE_HOME = join(context.home, ".local", "state");
  environment.XDG_RUNTIME_DIR = context.sockets;
  environment.TERM = "xterm-256color";
  environment.LANG = environment.LANG ?? "C.UTF-8";
  environment.LC_ALL = "C.UTF-8";
  environment.SMOKE_API_KEY = "smoke-placeholder-never-sent";
  return environment;
}

/**
 * Create a fresh, self-owned smoke execution context.
 *
 * @param prefix - the allocation's label. It names the fixture in diagnostics and
 *   in its recovery metadata; the directory name carries only a random id, which
 *   is what keeps a deep workspace or developer `TMPDIR` out of the fixture's
 *   path length.
 * @param options - an explicit parent, candidate list or socket parent list, for
 *   tests and for a harness that must pin where its fixture lands.
 * @returns a context whose roots are all safe to remove only after child shutdown.
 *
 * @remarks Nothing here is inherited from the environment that merely happens to
 *   be set: not the parent, not the socket directory. The root comes from the
 *   host's short temporary roots filtered by an account-owned ancestor chain,
 *   because the kernel re-checks that chain for the private state it publishes
 *   under `CLARVIS_HOME` - a fixture in a foreign-owned `/tmp` used to boot to
 *   `local host state has an unsafe parent directory`.
 */
export async function createSmokeContext(
  prefix = "clarvis-smoke-",
  options: SmokeContextOptions = {},
): Promise<SmokeContext> {
  const allocations: ShortTemporaryRoot[] = [];
  const children = new Set<SmokeChild>();
  const socketCounter = { value: 0 };
  let cleaned = false;
  let root = "";
  try {
    const fixtureParents = await validateParents(fixtureParentRequest(options));
    root = allocateFixtureRoot(prefix, fixtureParents, allocations).path;
    await assertSafeFixtureRoot(root);
    await assertOwnedDirectory(root, dirname(root));
    const directories = await createDirectories(root);
    const sockets = allocateSocketRoot(
      root,
      await validateParents(socketParentRequest(options, fixtureParents.parents)),
      allocations,
    );
    const paths = globalPaths(directories.global);
    const environment = baseEnvironment({ ...directories, sockets });
    const context: SmokeContext = {
      root,
      ...directories,
      sockets,
      paths,
      environment,
      writableRoots: [...new Set([root, ...allocations.map((entry) => entry.path)])],
      registerChild(child) {
        if (cleaned) throw new Error("smoke_fixture_already_cleaned");
        children.add(child);
        return () => children.delete(child);
      },
      environmentFor(overrides = {}) {
        if (cleaned) throw new Error("smoke_fixture_already_cleaned");
        return { ...environment, ...validateOverrides(overrides, root) };
      },
      socketPath(label) {
        socketCounter.value += 1;
        const path = join(
          sockets,
          `${label}-${process.pid.toString(36)}-${socketCounter.value.toString(36)}.sock`,
        );
        if (!unixSocketPathFits(path))
          throw new Error(
            `smoke_socket_path_exceeds_budget:${Buffer.byteLength(path, "utf8")}>${UNIX_SOCKET_PATH_BUDGET_BYTES}:${path}`,
          );
        return path;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        const owned = [...children];
        for (const child of owned) {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
        await Promise.all(
          owned.map(async (child) => {
            try {
              await Promise.race([
                child.exited,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("smoke_child_shutdown_timeout")), 3000),
                ),
              ]);
            } catch {
              try {
                child.kill("SIGKILL");
              } catch {}
              await child.exited.catch(() => undefined);
            }
          }),
        );
        children.clear();
        releaseAllocations(allocations);
      },
    };
    await mkdir(join(directories.home, ".config"), { recursive: true, mode: 0o700 });
    await mkdir(join(directories.home, ".local", "share"), { recursive: true, mode: 0o700 });
    await mkdir(join(directories.home, ".local", "state"), { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(directories.global, root);
    return context;
  } catch (error) {
    releaseAllocations(allocations);
    throw error;
  }
}

/**
 * Allocate the fixture's own short root, or explain why none is usable.
 *
 * @param prefix - the allocation's label.
 * @param candidates - the already validated parents, with the refusals that
 *   produced them.
 * @param allocations - the list this context is building, newest last.
 * @returns the fixture's allocation.
 *
 * @throws `smoke_fixture_no_usable_parent` listing every candidate and its
 *   refusal, which is what a container whose temporary roots are foreign-owned
 *   needs to be diagnosed from.
 *
 * @remarks The root is deliberately *not* derived from the inherited `TMPDIR`: a
 *   developer's deep run scope used to decide where a fixture landed, and a
 *   socket beneath it then exceeded the operating system's address limit. Only a
 *   parent that already passed {@link assertSafeParent} is tried, so the
 *   ownership chain the kernel re-checks for its own private state is validated
 *   once for both roots.
 */
function allocateFixtureRoot(
  prefix: string,
  candidates: ValidatedParents,
  allocations: ShortTemporaryRoot[],
): ShortTemporaryRoot {
  const refused = [...candidates.refused];
  for (const parent of candidates.parents) {
    try {
      const allocation = allocateShortTemporaryRoot({
        label: prefix,
        identity: `${process.pid}`,
        candidates: [parent],
        requireBudget: false,
      });
      allocations.push(allocation);
      return allocation;
    } catch (error) {
      refused.push(`${parent}: ${refusalReason(error)}`);
    }
  }
  throw new Error(`smoke_fixture_no_usable_parent:${refused.join(";")}`);
}

/**
 * The socket directory for a fixture: its own when the budget allows, otherwise a
 * short temporary root of its own, which is returned to `writableRoots` and cleanup.
 *
 * @param root - the fixture root.
 * @param candidates - the validated socket parents.
 * @param allocations - the list this context is building, newest last.
 * @returns the directory every socket of this context is named under.
 *
 * @throws `smoke_socket_root_unavailable` when no validated parent can hold an
 *   allocation short enough for a socket name, so an unusable host is reported as
 *   itself instead of as a failing PTY backend.
 */
function allocateSocketRoot(
  root: string,
  candidates: ValidatedParents,
  allocations: ShortTemporaryRoot[],
): string {
  const internal = join(root, SOCKETS_DIR);
  const reserve = 1 + Buffer.byteLength(SOCKETS_DIR, "utf8") + SOCKET_NAME_RESERVE_BYTES;
  if (unixSocketPathFits(join(internal, "x".repeat(SOCKET_NAME_RESERVE_BYTES)))) return internal;
  const refused = [...candidates.refused];
  for (const parent of candidates.parents) {
    try {
      const allocation = allocateShortTemporaryRoot({
        label: "socks",
        identity: `${process.pid}`,
        candidates: [parent],
        budgetBytes: UNIX_SOCKET_PATH_BUDGET_BYTES - reserve,
        requireBudget: true,
        requireTrustedAncestors: true,
      });
      allocations.push(allocation);
      return allocation.path;
    } catch (error) {
      refused.push(`${parent}: ${refusalReason(error)}`);
    }
  }
  throw new Error(`smoke_socket_root_unavailable:${refused.join(";")}`);
}

/**
 * Seed the one provider needed by offline artifact/PTY smoke in a new context.
 *
 * @returns the complete context, not a path that can be mixed with another run.
 */
export async function createSmokeFixture(
  prefix = "clarvis-smoke-",
  options: SmokeContextOptions = {},
): Promise<SmokeContext> {
  const context = await createSmokeContext(prefix, options);
  try {
    await mkdir(context.paths.root, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const settings = JSON.stringify(
      {
        providers: [
          {
            name: "smoke",
            kind: "openai-compatible",
            base_url: "https://example.invalid/v1",
            api_key_env: "SMOKE_API_KEY",
            models: { "smoke/model": { context_window_tokens: 8192, max_output_tokens: 1024 } },
          },
        ],
        default_model: "smoke/smoke/model",
      },
      null,
      2,
    );
    await writeFile(context.paths.settingsFile, settings, { flag: "wx", mode: 0o600 });
    return context;
  } catch (error) {
    await context.cleanup();
    throw error;
  }
}

/** Validate that a generated path remains below the fixture before a write. */
export function assertSmokePath(path: string, context: SmokeContext): string {
  const resolved = resolve(path);
  if (!isWithin(resolved, context.root)) throw new Error("smoke_fixture_path_escaped_root");
  return resolved;
}

/** Return the parent directory used for a context, for platform-specific tests. */
export function smokeContextParent(context: SmokeContext): string {
  return dirname(context.root);
}
