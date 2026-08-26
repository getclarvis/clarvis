import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, opendirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PLUGIN_RESOURCE_LIMITS, readPluginAgentFiles } from "@clarvis/loop/host";
import type { Scope } from "@clarvis/protocol";
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
import { globalPaths } from "@clarvis/paths";
import { withoutGitRepositoryEnvironment } from "@clarvis/paths";

function recordInstall(root: string, prepared: PreparedPlugin | undefined): void {
  if (prepared === undefined) return;
  const record: PluginInstallRecord = {
    ...(prepared.source !== undefined ? { source: prepared.source } : {}),
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

/** Names of immediate subdirectories, sorted without materializing an unbounded `readdir`. */
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
      if (entry.isDirectory()) names.push(entry.name);
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
    ...(origin !== undefined ? { source: origin } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(recorded.subdir !== undefined ? { subdir: recorded.subdir } : {}),
  };
}

/** Stamp a staged snapshot with the config scope that owns it. */
function scoped(staged: StagedPlugin, scope: Scope, shadowsGlobal: boolean): InstalledPlugin {
  return { ...staged, scope, shadowsGlobal };
}

/** Options for the file-backed installed-plugin repository. */
export interface FilePluginRepositoryOptions {
  /** Global Clarvis config directory. */
  globalDir: string;
  /** Optional workspace Clarvis config directory. */
  workspaceConfigDir?: string;
}

/**
 * Create the file-backed installed-plugin repository.
 *
 * @param options - global and optional workspace config roots.
 * @returns a repository preserving existing plugin directory layout and shadowing.
 */
export function createFilePluginRepository(options: FilePluginRepositoryOptions): PluginRepository {
  const installRoot = globalPaths(options.globalDir).pluginsDir;
  const target = (name: string): string => join(installRoot, name);
  const scopes = (): { scope: Scope; root: string }[] => [
    { scope: "global", root: installRoot },
    ...(options.workspaceConfigDir !== undefined
      ? [{ scope: "workspace" as const, root: join(options.workspaceConfigDir, "plugins") }]
      : []),
  ];

  return {
    async list(): Promise<InstalledPlugin[]> {
      const byName = new Map<string, InstalledPlugin>();
      for (const { scope, root } of scopes()) {
        const listed = directoryNames(
          root,
          PLUGIN_RESOURCE_LIMITS.installRootEntries,
          `${scope} plugin install root`,
        );
        if (!listed.ok) throw kernelError("resource_exhausted", listed.error);
        for (const name of listed.names) {
          byName.set(
            name,
            scoped(
              inspectPlugin(join(root, name), name),
              scope,
              scope === "workspace" && byName.has(name),
            ),
          );
        }
      }
      return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
    async inspect(root): Promise<StagedPlugin> {
      return inspectPlugin(root, basename(root));
    },
    async global(name): Promise<InstalledPlugin | null> {
      const dir = target(name);
      return existsSync(dir) ? scoped(inspectPlugin(dir, name), "global", false) : null;
    },
    async install(root, name, prepared): Promise<InstalledPlugin> {
      const dir = target(name);
      if (existsSync(dir)) {
        throw kernelError(
          "invalid_request",
          `'${name}' is already installed — update or uninstall it first`,
        );
      }
      mkdirSync(installRoot, { recursive: true, mode: 0o700 });
      recordInstall(root, prepared);
      renameSync(root, dir);
      return scoped(inspectPlugin(dir, name), "global", false);
    },
    async replace(root, name, prepared): Promise<InstalledPlugin> {
      const dir = target(name);
      if (!existsSync(dir)) {
        throw kernelError("not_found", `'${name}' is not installed globally`);
      }
      recordInstall(root, prepared);
      const backup = join(installRoot, `.plugin-replaced-${name}-${randomUUID()}`);
      renameSync(dir, backup);
      try {
        renameSync(root, dir);
      } catch (error) {
        renameSync(backup, dir);
        throw error;
      }
      rmSync(backup, { recursive: true, force: true });
      return scoped(inspectPlugin(dir, name), "global", false);
    },
    async remove(name): Promise<boolean> {
      const dir = target(name);
      if (!existsSync(dir)) return false;
      rmSync(dir, { recursive: true, force: true });
      return true;
    },
  };
}
