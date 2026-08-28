import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  opendirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { PLUGIN_RESOURCE_LIMITS, readPluginAgentFiles } from "@clarvis/loop/host";
import type { PluginRef, PluginSource, Scope } from "@clarvis/protocol";
import { kernelError } from "../../core/errors.ts";
import type {
  InstalledPlugin,
  StagedPlugin,
  PluginRepository,
  PreparedPlugin,
} from "../../ports/plugin-repository.ts";
import { readPluginManifestSource } from "../../plugins/plugin-manifest.ts";
import {
  PLUGIN_INSTALL_RECORD,
  readPluginInstallRecord,
  type PluginInstallRecord,
} from "../../plugins/plugin-install-record.ts";
import { agentsPluginsDirs, globalPaths, workspacePaths } from "@clarvis/paths";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";

function recordInstall(root: string, prepared: PreparedPlugin | undefined): void {
  if (prepared === undefined) return;
  const record: PluginInstallRecord = {
    ...(prepared.origin !== undefined ? { source: prepared.origin } : {}),
    ...(prepared.revision !== undefined ? { revision: prepared.revision } : {}),
    ...(prepared.subdir !== undefined ? { subdir: prepared.subdir } : {}),
  };
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > PLUGIN_RESOURCE_LIMITS.installRecordBytes) {
    throw kernelError(
      "invalid_request",
      `plugin install record exceeds the ${String(PLUGIN_RESOURCE_LIMITS.installRecordBytes)}-byte resource limit`,
    );
  }
  writeFileSync(join(root, PLUGIN_INSTALL_RECORD), contents, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function gitValue(dir: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: withoutGitRepositoryEnvironment(process.env),
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: PLUGIN_RESOURCE_LIMITS.installRecordBytes,
  });
  const value =
    result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  return value.length > 0 ? value : undefined;
}

type DirectoryNamesResult = { ok: true; names: string[] } | { ok: false; error: string };

/**
 * Names of immediate directory entries that resolve to directories, sorted
 * without materializing an unbounded `readdir`.
 *
 * Symbolic links are admitted only when their current target is a directory.
 * Package readers still realpath-confine every contributed path to that target,
 * so a shared-store link changes inventory placement without widening the
 * package boundary.
 */
function directoryNames(root: string, maxEntries: number, label: string): DirectoryNamesResult {
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(root);
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
      ? { ok: true, names: [] }
      : { ok: false, error: `${label} could not be opened: ${(error as Error).message}` };
  }
  const names: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > maxEntries) {
        return {
          ok: false,
          error: `${label} exceeds the ${String(maxEntries)}-entry resource limit`,
        };
      }
      if (entry.isDirectory()) {
        names.push(entry.name);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        if (statSync(join(root, entry.name)).isDirectory()) names.push(entry.name);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (["ENOENT", "ENOTDIR", "ELOOP"].includes(code)) continue;
        throw error;
      }
    }
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
      ? { ok: true, names: [] }
      : { ok: false, error: `${label} changed while it was read: ${(error as Error).message}` };
  } finally {
    try {
      opened.closeSync();
    } catch {
      /* A completed/lazily failed read may already have closed the directory handle. */
    }
  }
  return { ok: true, names: names.sort() };
}

/** Inspect one plugin directory without parsing its manifest, and without
 * claiming a config scope for it. */
function inspectPlugin(dir: string, name: string): StagedPlugin {
  const source = readPluginManifestSource(dir);
  const manifestRaw = "raw" in source ? source.raw : undefined;
  const manifestLocation = "location" in source ? source.location : undefined;
  let manifestError = "error" in source ? source.error : undefined;
  const agents = readPluginAgentFiles(join(dir, "agents"));
  if (!agents.ok && manifestError === undefined) manifestError = agents.error;
  const installed = readPluginInstallRecord(dir);
  if (!installed.ok && manifestError === undefined) manifestError = installed.error;
  const recorded: PluginInstallRecord = installed.ok ? installed.record : {};
  const gitCheckout = existsSync(join(dir, ".git"));
  const origin =
    (gitCheckout ? gitValue(dir, ["config", "--get", "remote.origin.url"]) : undefined) ??
    recorded.source;
  const revision =
    (gitCheckout ? gitValue(dir, ["rev-parse", "HEAD"]) : undefined) ?? recorded.revision;
  return {
    name,
    dir,
    ...(manifestRaw !== undefined ? { manifestRaw } : {}),
    ...(manifestLocation !== undefined ? { manifestLocation } : {}),
    ...(manifestError !== undefined ? { manifestError } : {}),
    agentFiles: agents.ok ? agents.files : [],
    gitCheckout,
    ...(origin !== undefined ? { origin } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(recorded.subdir !== undefined ? { subdir: recorded.subdir } : {}),
  };
}

/** Stamp a staged snapshot with the exact inventory identity that owns it. */
function installed(staged: StagedPlugin, ref: PluginRef): InstalledPlugin {
  return { ...staged, ref };
}

/** Options for the file-backed installed-plugin repository. */
export interface FilePluginRepositoryOptions {
  /** Global Clarvis config directory. */
  globalDir: string;
  /** Home directory that owns the user-level `.agents/plugins` inventory. */
  home?: string;
  /** Optional workspace root whose two plugin inventories are listed. */
  workspaceRoot?: string;
}

/**
 * Read every installed plugin with its exact owning scope.
 *
 * Every snapshot remains present even when another scope or convention carries
 * the same name. Selection is always by exact qualified reference.
 */
export function listInstalledPlugins(options: FilePluginRepositoryOptions): InstalledPlugin[] {
  const agents = agentsPluginsDirs({
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.workspaceRoot === undefined ? {} : { cwd: options.workspaceRoot }),
  });
  const roots: { scope: Scope; source: PluginSource; root: string }[] = [
    { scope: "global", source: "clarvis", root: globalPaths(options.globalDir).pluginsDir },
    { scope: "global", source: "agents", root: agents.user },
    ...(options.workspaceRoot === undefined
      ? []
      : [
          {
            scope: "workspace" as const,
            source: "clarvis" as const,
            root: workspacePaths(options.workspaceRoot).pluginsDir,
          },
          { scope: "workspace" as const, source: "agents" as const, root: agents.workspace },
        ]),
  ];
  const snapshots: InstalledPlugin[] = [];
  for (const { scope, source, root } of roots) {
    const listed = directoryNames(
      root,
      PLUGIN_RESOURCE_LIMITS.installRootEntries,
      `${scope}/${source} plugin install root`,
    );
    if (!listed.ok) throw kernelError("resource_exhausted", listed.error);
    for (const name of listed.names) {
      snapshots.push(installed(inspectPlugin(join(root, name), name), { scope, source, name }));
    }
  }
  return snapshots.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.ref.scope.localeCompare(right.ref.scope) ||
      left.ref.source.localeCompare(right.ref.source),
  );
}

/**
 * Create the file-backed installed-plugin repository.
 *
 * @param options - global and optional workspace config roots.
 * @returns a repository preserving every exact scope/source inventory identity.
 */
export function createFilePluginRepository(options: FilePluginRepositoryOptions): PluginRepository {
  const agents = agentsPluginsDirs({
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.workspaceRoot === undefined ? {} : { cwd: options.workspaceRoot }),
  });
  const installRoot = (source: PluginSource): string =>
    source === "agents" ? agents.user : globalPaths(options.globalDir).pluginsDir;
  const rootFor = (ref: PluginRef): string | undefined => {
    if (ref.scope === "global") return installRoot(ref.source);
    if (options.workspaceRoot === undefined) return undefined;
    return ref.source === "agents"
      ? agents.workspace
      : workspacePaths(options.workspaceRoot).pluginsDir;
  };
  const target = (ref: PluginRef): string | undefined => {
    const root = rootFor(ref);
    return root === undefined ? undefined : join(root, ref.name);
  };
  return {
    async list(): Promise<InstalledPlugin[]> {
      return listInstalledPlugins(options);
    },
    async inspect(root): Promise<StagedPlugin> {
      return inspectPlugin(root, basename(root));
    },
    async get(ref): Promise<InstalledPlugin | null> {
      const dir = target(ref);
      return dir !== undefined && existsSync(dir)
        ? installed(inspectPlugin(dir, ref.name), ref)
        : null;
    },
    async install(root, name, source, prepared): Promise<InstalledPlugin> {
      const ref: PluginRef = { scope: "global", source, name };
      const rootDir = installRoot(source);
      const dir = join(rootDir, name);
      if (existsSync(dir)) {
        throw kernelError(
          "invalid_request",
          `'${name}' is already installed — update or uninstall it first`,
        );
      }
      mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      recordInstall(root, prepared);
      renameSync(root, dir);
      return installed(inspectPlugin(dir, name), ref);
    },
    async replace(root, ref, prepared): Promise<InstalledPlugin> {
      if (ref.scope !== "global") {
        throw kernelError("invalid_request", "managed plugin updates are global-only");
      }
      const rootDir = installRoot(ref.source);
      const dir = join(rootDir, ref.name);
      if (!existsSync(dir)) {
        throw kernelError("not_found", `'${ref.name}' is not installed at global/${ref.source}`);
      }
      recordInstall(root, prepared);
      const backup = join(rootDir, `.plugin-replaced-${ref.name}-${randomUUID()}`);
      renameSync(dir, backup);
      try {
        renameSync(root, dir);
      } catch (error) {
        renameSync(backup, dir);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
      return installed(inspectPlugin(dir, ref.name), ref);
    },
    async remove(ref): Promise<boolean> {
      if (ref.scope !== "global") {
        throw kernelError("invalid_request", "managed plugin uninstalls are global-only");
      }
      const dir = target(ref);
      if (dir === undefined || !existsSync(dir)) return false;
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
  };
}
