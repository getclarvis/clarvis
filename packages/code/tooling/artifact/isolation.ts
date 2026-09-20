import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENTS_DIR, CLARVIS_DIR, globalPaths, type GlobalPaths } from "@clarvis/paths";

const RESERVED_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "USERPROFILE",
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
  "CLARVIS_RUNTIME_CANDIDATE",
  "CLARVIS_RUNTIME_CANDIDATE_REVISION",
]);

const INHERITED_OPERATIONAL_KEYS = [
  "PATH",
  "BUN_INSTALL",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TERM",
] as const;

/** A subprocess environment override admitted by the smoke harness. */
export type SmokeEnvironmentOverride = Partial<
  Record<
    | "CLARVIS_CODE_SOURCE"
    | "CLARVIS_INSTALL_ROOT"
    | "CLARVIS_RELEASE_DIRECTORY"
    | "CLARVIS_BIN_DIR"
    | "CLARVIS_SKIP_PATH"
    | "CLARVIS_VERSION"
    | "CLARVIS_RUNTIME_CANDIDATE"
    | "CLARVIS_RUNTIME_CANDIDATE_REVISION",
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
  /** Synthetic PTY/tmux socket directory. */
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
  /** Terminate registered children and remove only this context's root. */
  cleanup(): Promise<void>;
}

/** Whether the PTY child must use a real native filesystem/process boundary. */
export type SmokeConfinement = "environment" | "required";

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
  environment.USERPROFILE = context.home;
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
 * @param prefix - unique prefix for the exclusive root directory.
 * @returns a context whose root is safe to remove only after child shutdown.
 */
export async function createSmokeContext(prefix = "clarvis-smoke-"): Promise<SmokeContext> {
  const parent = await assertSafeParent(tmpdir());
  const root = await mkdtemp(join(parent, prefix));
  const children = new Set<SmokeChild>();
  let cleaned = false;
  try {
    await assertSafeFixtureRoot(root);
    await assertOwnedDirectory(root, parent);
    const directories = await createDirectories(root);
    const paths = globalPaths(directories.global);
    const environment = baseEnvironment({ ...directories, sockets: directories.sockets });
    const context: SmokeContext = {
      root,
      ...directories,
      paths,
      environment,
      registerChild(child) {
        if (cleaned) throw new Error("smoke_fixture_already_cleaned");
        children.add(child);
        return () => children.delete(child);
      },
      environmentFor(overrides = {}) {
        if (cleaned) throw new Error("smoke_fixture_already_cleaned");
        return { ...environment, ...validateOverrides(overrides, root) };
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
        await rm(root, { recursive: true, force: true });
      },
    };
    await mkdir(join(directories.home, ".config"), { recursive: true, mode: 0o700 });
    await mkdir(join(directories.home, ".local", "share"), { recursive: true, mode: 0o700 });
    await mkdir(join(directories.home, ".local", "state"), { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(directories.global, root);
    return context;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function existingSystemRoot(path: string): boolean {
  return existsSync(path);
}

function parentDirectories(path: string): string[] {
  const result: string[] = [];
  let current = dirname(path);
  while (current !== "/") {
    result.unshift(current);
    current = dirname(current);
  }
  return result;
}

/**
 * Wrap a PTY command in Bubblewrap without providing an unsandboxed fallback.
 *
 * @remarks This is intentionally a small harness boundary rather than the product
 * command sandbox. It grants read-only access to the selected runtime/checkout,
 * masks operator configuration trees, binds the fixture read-write, and denies
 * network access. A real probe runs before the command is returned so an absent or
 * unusable backend is reported as unavailable instead of as a passing smoke.
 */
export async function requireNativeSmokeConfinement(
  context: SmokeContext,
  command: string[],
  readOnlyRoots: string[],
): Promise<string[]> {
  if (process.platform !== "linux") {
    throw new Error(`smoke_native_confinement_unavailable:${process.platform}`);
  }
  const bwrap =
    ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].find((path) => existsSync(path)) ??
    Bun.which("bwrap");
  if (bwrap === null) throw new Error("smoke_native_confinement_unavailable:bwrap");

  const roots = [...new Set(readOnlyRoots.map((path) => resolve(path)))];
  for (const root of roots) {
    const info = await lstat(root).catch(() => undefined);
    if (info === undefined || info.isSymbolicLink()) {
      throw new Error(`smoke_native_confinement_invalid_read_root:${root}`);
    }
  }

  const args = [
    bwrap,
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--tmpfs",
    "/root",
    "--tmpfs",
    "/var",
    "--tmpfs",
    "/run",
  ];
  for (const system of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
    if (existingSystemRoot(system)) args.push("--ro-bind", system, system);
  }
  const hostRoots = roots.filter((root) => !pathOverlaps(root, context.root));
  for (const directory of [...new Set(hostRoots.flatMap(parentDirectories))]) {
    if (!new Set(["/", "/tmp", "/home", "/root", "/var", "/run"]).has(directory)) {
      args.push("--dir", directory);
    }
  }
  for (const root of roots) {
    if (!pathOverlaps(root, context.root)) args.push("--ro-bind", root, root);
  }
  for (const root of hostRoots) {
    for (const hidden of [CLARVIS_DIR, AGENTS_DIR, ".git"]) {
      const path = join(root, hidden);
      if (existsSync(path)) args.push("--tmpfs", path);
    }
  }
  args.push("--bind", context.root, context.root, "--chdir", context.workspace, "--", ...command);

  const boundary = args.indexOf("--bind");
  const probe = Bun.spawnSync([...args.slice(0, boundary), "--", "/bin/sh", "-c", ":"]);
  if (probe.exitCode !== 0) {
    throw new Error(
      `smoke_native_confinement_unavailable:${probe.stderr.toString().trim().slice(0, 240)}`,
    );
  }
  return args;
}

/**
 * Seed the one provider needed by offline artifact/PTY smoke in a new context.
 *
 * @returns the complete context, not a path that can be mixed with another run.
 */
export async function createSmokeFixture(prefix = "clarvis-smoke-"): Promise<SmokeContext> {
  const context = await createSmokeContext(prefix);
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
