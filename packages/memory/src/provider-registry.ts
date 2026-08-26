/**
 * Resolving a declared `memory.provider` into a live {@link MemoryProvider}.
 *
 * The mechanism is written neutral — it names no capability and knows nothing
 * about memory beyond the contract it returns — but the only settings block
 * that consumes it is `memory.provider`. That is the scope decision recorded in
 * `specs/capabilities/provider-executables.md`: generic on the inside, one exposed surface.
 *
 * @remarks Built-in implementations are reached through dynamic `import()`.
 * `@clarvis/memory/settings` sits on
 * the eager import path — it is what makes the `memory:` block parse at all — so
 * a registry that *value-imported* its implementations would pull every
 * provider's code, eventually including a plugin's, into every import of the
 * kernel. `provider-eager-boundary.test.ts` walks the static graph and is the
 * only thing that can see a regression here: it breaks with a green typecheck,
 * a green lint and a green suite.
 */
import type { MemoryProviderConfig } from "./schemas.ts";
import type { MemoryProvider } from "./provider.ts";
import type { MemoryServerPort } from "./mcp-provider.ts";
import type { Memory } from "./memory-contract.ts";
import type {
  CapabilityExecutableDeclaration,
  CapabilityExecutablePort,
  Logger,
} from "@clarvis/capability";

/** What a provider implementation may need from the host to construct itself. */
export interface ProviderResolutionContext {
  /** Absolute workspace root; every declared path is confined to it. */
  workspaceRoot: string;
  /**
   * The built-in wiki for this owner, when one is available.
   *
   * @remarks Present only because the `wiki` kind is itself a provider. A
   * non-wiki implementation never receives it and cannot reach the tree.
   */
  wiki?: Memory;
  /** Cap on the entry block, so every provider honours one budget. */
  seedMaxChars: number;
  /**
   * Kernel-owned persistent process sessions.
   */
  executablePort?: CapabilityExecutablePort;
  /** Owner scope sent with every serializable operation. */
  owner: string;
  /**
   * Where a provider reports what it could not do.
   *
   * @remarks Reaches the `mcp` provider only. The built-in wiki logs through
   * its store, and an executable provider's own diagnostics belong to the
   * session the kernel owns.
   */
  logger?: Logger;
  /**
   * The host's tool-server seam, when it has one.
   *
   * @remarks Declared structurally and never named beyond this: `@clarvis/memory`
   * must not acquire a dependency on the MCP client for the sake of one provider
   * kind. Absent, an `mcp` declaration reports itself unavailable rather than
   * resolving to something else.
   */
  serverPort?: MemoryServerPort;
  /**
   * How a plugin-offered memory provider is located, when the host has plugins.
   *
   * @remarks Declared structurally, like {@link serverPort}: this package knows
   * nothing about plugin installation, trust or marketplaces. The host answers
   * with a directory and executable declaration only for a plugin that is
   * installed, enabled and selected by the operator.
   */
  pluginPort?: MemoryPluginPort;
}

/**
 * Why a declared provider could not be built.
 *
 * @remarks Carried rather than thrown: the failure posture is that a run
 * proceeds **without memory** and says so, never that it silently falls back to
 * a different store. A fallback would write a run's learning into a tree nobody
 * will look in.
 */
/** How the host locates a plugin's offered memory provider. */
export interface MemoryPluginPort {
  /**
   * Locate the executable a plugin offers.
   *
   * @param plugin - the plugin name, as the operator wrote it.
   * @returns the process `root` and declaration, or the reason there is nothing
   *   to load — not installed, not enabled, or offering no provider.
   */
  locate(
    plugin: string,
  ): { root: string; declaration: CapabilityExecutableDeclaration } | { error: string };
}

/** Why a declared provider could not be built. */
export interface ProviderResolutionFailure {
  kind: string;
  reason: string;
}

/** Either the live provider, or why there is none. */
export type ProviderResolution =
  | { ok: true; provider: MemoryProvider; key: string; seedMaxChars: number }
  | { ok: false; failure: ProviderResolutionFailure };

/** Stable identity of the effective provider declaration, including packaged argv. */
async function providerKey(kind: string, value: unknown): Promise<string> {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (typeof input !== "object" || input === null) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${kind}:${digest}`;
}

/**
 * Build the provider a workspace declared.
 *
 * @param config - the validated declaration; `undefined` means the built-in wiki.
 * @param ctx - what an implementation may need to construct itself.
 * @returns the resolution; never throws for a declaration this build does not
 *   support, so a host can report the reason instead of crashing a run.
 */
export async function resolveMemoryProvider(
  config: MemoryProviderConfig | undefined,
  ctx: ProviderResolutionContext,
): Promise<ProviderResolution> {
  const resolvedConfig: MemoryProviderConfig = config ?? { kind: "wiki" };
  const kind = resolvedConfig.kind;
  try {
    switch (resolvedConfig.kind) {
      case "wiki": {
        if (ctx.wiki === undefined) {
          return { ok: false, failure: { kind, reason: "no wiki is available for this owner" } };
        }
        const { wikiMemoryProvider } = await import("./wiki-provider.ts");
        return {
          ok: true,
          provider: wikiMemoryProvider(ctx.wiki),
          key: await providerKey(kind, {}),
          seedMaxChars: ctx.seedMaxChars,
        };
      }
      case "file": {
        const { createFileMemoryProvider } = await import("./file-provider.ts");
        return {
          ok: true,
          key: await providerKey(kind, resolvedConfig),
          seedMaxChars: ctx.seedMaxChars,
          provider: createFileMemoryProvider({
            workspaceRoot: ctx.workspaceRoot,
            paths: resolvedConfig.paths,
          }),
        };
      }
      case "executable": {
        if (ctx.executablePort === undefined) {
          return { ok: false, failure: { kind, reason: "this host cannot start executables" } };
        }
        const { createExecutableMemoryProvider } = await import("./executable-provider.ts");
        const { kind: _kind, ...declaration } = resolvedConfig;
        return {
          ok: true,
          key: await providerKey(kind, declaration),
          seedMaxChars: ctx.seedMaxChars,
          provider: await createExecutableMemoryProvider({
            declaration,
            cwd: ctx.workspaceRoot,
            workspaceRoot: ctx.workspaceRoot,
            owner: ctx.owner,
            port: ctx.executablePort,
          }),
        };
      }
      case "mcp": {
        if (ctx.serverPort === undefined) {
          return {
            ok: false,
            failure: { kind, reason: "this host cannot reach tool servers for memory" },
          };
        }
        const { createMcpMemoryProvider } = await import("./mcp-provider.ts");
        return {
          ok: true,
          key: await providerKey(kind, resolvedConfig),
          seedMaxChars: ctx.seedMaxChars,
          provider: createMcpMemoryProvider({
            server: resolvedConfig.server,
            tools: resolvedConfig.tools,
            ...(resolvedConfig.seed_tool !== undefined
              ? { seedTool: resolvedConfig.seed_tool }
              : {}),
            port: ctx.serverPort,
            ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
          }),
        };
      }
      case "plugin": {
        if (ctx.pluginPort === undefined) {
          return { ok: false, failure: { kind, reason: "this host has no plugins" } };
        }
        if (ctx.executablePort === undefined) {
          return { ok: false, failure: { kind, reason: "this host cannot start executables" } };
        }
        const located = ctx.pluginPort.locate(resolvedConfig.plugin);
        if ("error" in located) {
          return { ok: false, failure: { kind, reason: located.error } };
        }
        const { createExecutableMemoryProvider } = await import("./executable-provider.ts");
        return {
          ok: true,
          key: await providerKey(kind, {
            plugin: resolvedConfig.plugin,
            declaration: located.declaration,
          }),
          seedMaxChars: ctx.seedMaxChars,
          provider: await createExecutableMemoryProvider({
            declaration: located.declaration,
            cwd: located.root,
            workspaceRoot: ctx.workspaceRoot,
            owner: ctx.owner,
            port: ctx.executablePort,
          }),
        };
      }
      default: {
        /**
         * Unreachable while every declared kind has an arm — the schema is a
         * discriminated union, so `kind` narrows to `never` here. Kept as a
         * runtime arm anyway: the next kinds arrive from a plugin manifest, and
         * a declaration this build does not know must report itself rather than
         * fall through to a different store.
         */
        const unknown: string = kind;
        return {
          ok: false,
          failure: { kind: unknown, reason: `unsupported memory provider '${unknown}'` },
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      failure: { kind, reason: err instanceof Error ? err.message : String(err) },
    };
  }
}
