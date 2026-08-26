import { delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import type { SandboxInspection, SandboxPathStatus, Scope } from "@clarvis/protocol";
import type { ResolvedSandboxSettings, SandboxSettings } from "@clarvis/loop/host";
import { discoverSandboxToolchains, resolveSandboxPath } from "@clarvis/loop/capabilities/tools";
import { probeBubblewrap, sandboxCommand, type DiscoveredToolchain } from "@clarvis/tools/sandbox";
import type { ConfigStore, SettingsSnapshot } from "../config/config-store.ts";

/**
 * Resolves the user-configured extra read-only paths from settings into absolute
 * paths plus a per-path availability status.
 *
 * @param snapshot - the merged + per-scope settings view.
 * @param workspaceRoot - workspace root used to resolve workspace-scoped relatives.
 * @returns `resolved`, the de-duplicated absolute paths that resolved cleanly, and
 *   `status`, one {@link SandboxPathStatus} per configured entry (marking whether
 *   it resolved and, if not, why).
 * @remarks Walks `global` then `workspace` scope; entries listed in the merged
 *   `toolchains.excluded_paths` are dropped before resolution. A workspace-scoped
 *   entry may be relative; a global one may not.
 */
function configuredPaths(
  snapshot: SettingsSnapshot,
  workspaceRoot: string,
): { resolved: string[]; status: SandboxPathStatus[] } {
  const merged = snapshot.merged.sandbox;
  const excluded = new Set(merged?.toolchains?.excluded_paths ?? []);
  const resolved: string[] = [];
  const status: SandboxPathStatus[] = [];
  for (const scope of ["global", "workspace"] as const satisfies readonly Scope[]) {
    const sandbox = snapshot.scopes[scope]?.sandbox;
    for (const raw of sandbox?.toolchains?.extra_paths ?? []) {
      if (excluded.has(raw)) continue;
      const { path, error } = resolveSandboxPath(raw, workspaceRoot, scope === "workspace");
      status.push({
        path: raw,
        scope,
        available: error === undefined,
        ...(error !== undefined ? { error } : {}),
      });
      if (error === undefined && !resolved.includes(path)) resolved.push(path);
    }
  }
  return { resolved, status };
}

const TOOLCHAIN_ENV_KEYS = [
  "PATH",
  "BUN_INSTALL",
  "MISE_DATA_DIR",
  "ASDF_DATA_DIR",
  "NVM_DIR",
  "PYENV_ROOT",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "GOROOT",
  "GOPATH",
  "JAVA_HOME",
  "SDKMAN_DIR",
  "DOTNET_ROOT",
] as const;

/**
 * Builds a cache key over everything that affects toolchain discovery, so the
 * cached result is reused only while nothing relevant has changed.
 *
 * @param settings - the sandbox settings whose `toolchains` block is discovery input.
 * @returns a stable JSON string of the toolchain settings plus the current values
 *   of the {@link TOOLCHAIN_ENV_KEYS} environment variables.
 */
function discoverySignature(
  settings: SandboxSettings | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return JSON.stringify({
    toolchains: settings?.toolchains,
    env: Object.fromEntries(TOOLCHAIN_ENV_KEYS.map((key) => [key, environment[key]])),
  });
}

/**
 * Resolves the effective sandbox policy for a workspace: the settings a run is
 * launched under, and a richer inspection used by diagnostics/UI.
 */
export interface SandboxPolicyResolver {
  /**
   * The sandbox settings a run should be launched with, or `undefined` when the
   * workspace has no sandbox configured.
   *
   * @returns the merged settings augmented with `resolved_runtime_paths` (discovered
   *   toolchain roots) and `resolved_read_only_paths` (configured extra paths), each
   *   omitted when empty; `undefined` when no sandbox block exists.
   */
  resolve(): ResolvedSandboxSettings | undefined;

  /**
   * Produces a full sandbox inspection - bubblewrap availability, per-toolchain
   * status, configured extra paths, and the effective sandbox `PATH`.
   *
   * @param options - pass `refresh: true` to bypass the discovery cache and
   *   re-probe toolchains.
   * @returns the {@link SandboxInspection}; when bubblewrap is available, each
   *   discovered toolchain is additionally verified by running its `--version`
   *   inside the sandbox and demoted to unavailable on failure.
   */
  inspect(options?: { refresh?: boolean }): Promise<SandboxInspection>;
}

/**
 * Builds a {@link SandboxPolicyResolver} bound to a config store and workspace.
 *
 * @param store - config store the resolver reads settings from on each call.
 * @param workspaceRoot - workspace root used to resolve relative paths and as the
 *   sandbox cwd/root when probing.
 * @param environment - immutable values included in discovery cache identity.
 * @returns a resolver that memoizes toolchain discovery, keyed by a
 *   {@link discoverySignature} over the toolchain settings and toolchain-relevant
 *   environment, and re-discovers when that signature changes or `refresh` is set.
 */
export function createSandboxPolicyResolver(
  store: ConfigStore,
  workspaceRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SandboxPolicyResolver {
  let cachedDiscovery: { signature: string; toolchains: DiscoveredToolchain[] } | undefined;

  const selectedToolchains = (
    settings: SandboxSettings | undefined,
    refresh: boolean,
  ): DiscoveredToolchain[] => {
    const signature = discoverySignature(settings, environment);
    if (!refresh && cachedDiscovery?.signature === signature) return cachedDiscovery.toolchains;
    const toolchains = discoverSandboxToolchains(settings);
    cachedDiscovery = { signature, toolchains };
    return toolchains;
  };

  const build = (
    refresh = false,
  ): {
    settings: SandboxSettings | undefined;
    discovered: DiscoveredToolchain[];
    runtimePaths: string[];
    paths: ReturnType<typeof configuredPaths>;
  } => {
    const snapshot = store.readSettings();
    const settings = snapshot.merged.sandbox;
    const discovered = selectedToolchains(settings, refresh);
    const runtimePaths = [
      ...new Set(discovered.flatMap((item) => (item.available && item.root ? [item.root] : []))),
    ];
    return { settings, discovered, runtimePaths, paths: configuredPaths(snapshot, workspaceRoot) };
  };

  return {
    resolve(): ResolvedSandboxSettings | undefined {
      const { settings, runtimePaths, paths } = build();
      if (settings === undefined) return undefined;
      return {
        ...settings,
        ...(runtimePaths.length > 0 ? { resolved_runtime_paths: runtimePaths } : {}),
        ...(paths.resolved.length > 0 ? { resolved_read_only_paths: paths.resolved } : {}),
      };
    },

    async inspect(options): Promise<SandboxInspection> {
      const { settings, discovered, runtimePaths, paths } = build(options?.refresh === true);
      const bubblewrap = probeBubblewrap();
      const enabled = new Set(
        settings?.toolchains?.mode === "manual" ? [] : discovered.map((item) => item.id),
      );
      const statuses = discovered.map((item) => {
        let available = item.available;
        let error = item.error;
        if (available && bubblewrap.mode !== "unavailable") {
          try {
            const spec = sandboxCommand({
              command: `${item.commands[0]} --version`,
              cwd: workspaceRoot,
              workspaceRoot,
              sandbox: {
                type: "bubblewrap",
                availability: "required",
                filesystem: "workspace-read-only",
                network: settings?.network ?? "host",
                runtimePaths,
                readOnlyPaths: paths.resolved,
              },
              probe: () => bubblewrap,
            });
            const result = spawnSync(spec.file, spec.args, {
              ...spec.options,
              encoding: "utf8",
              timeout: 2_000,
            });
            if (result.status !== 0) {
              available = false;
              error = `${result.stderr || result.stdout || `probe exited ${result.status}`}`.trim();
            }
          } catch (cause) {
            available = false;
            error = String(cause);
          }
        }
        return {
          id: item.id,
          commands: item.commands,
          available,
          enabled: enabled.has(item.id),
          scope: item.manager === "system" ? ("system" as const) : ("auto" as const),
          ...(item.manager !== undefined ? { manager: item.manager } : {}),
          ...(item.version !== undefined ? { version: item.version } : {}),
          ...(item.logicalPath !== undefined ? { logical_path: item.logicalPath } : {}),
          ...(item.resolvedPath !== undefined ? { resolved_path: item.resolvedPath } : {}),
          ...(item.root !== undefined ? { root: item.root } : {}),
          ...(error !== undefined ? { error } : {}),
        };
      });
      const resolved = settings === undefined ? undefined : this.resolve();
      const spec =
        resolved === undefined || bubblewrap.mode === "unavailable"
          ? undefined
          : sandboxCommand({
              command: "true",
              cwd: workspaceRoot,
              workspaceRoot,
              sandbox: {
                type: "bubblewrap",
                runtimePaths: resolved.resolved_runtime_paths,
                readOnlyPaths: resolved.resolved_read_only_paths,
              },
            });
      return {
        bubblewrap:
          bubblewrap.mode === "unavailable"
            ? {
                available: false,
                mode: bubblewrap.mode,
                degraded: false,
                reason: bubblewrap.reason,
              }
            : {
                available: true,
                mode: bubblewrap.mode,
                degraded: bubblewrap.mode === "host-proc",
              },
        toolchains: statuses,
        extra_paths: paths.status,
        effective_path: `${spec?.options.env?.PATH ?? ""}`.split(delimiter).filter(Boolean),
      };
    },
  };
}
