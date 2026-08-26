import {
  dispatch as pkgDispatch,
  contentText,
  listTools,
  resolveConfig,
  type RuntimeConfig,
  type Guard,
  type GuardReview,
  type Elicit,
  type SandboxConfig,
  type ToolsLogger,
} from "@clarvis/tools";
import type { NamespacedTool } from "@clarvis/capability";
import type { ToolResultImage } from "@clarvis/capability";
import { EXEC_TOOL_NAMES } from "./names.ts";

/**
 * Options for {@link createAgentToolset}: the `workspaceRoot`, the `canMutate` /
 * `canExec` capability gates, and optional workspace confinement, `guard`,
 * `elicit` and `sandbox` wiring passed through to @clarvis/tools.
 */
export interface AgentToolsetOptions {
  workspaceRoot: string;
  canMutate: boolean;
  canExec: boolean;
  confineToWorkspace?: boolean;
  temporaryRoots?: readonly string[];
  onTemporaryRootRegistered?: (root: string) => void;
  guard?: Guard;
  elicit?: Elicit;
  sandbox?: SandboxConfig;
  /** Credential env-var names withheld from every spawned command. */
  secretEnvNames?: readonly string[];
  /**
   * Where the resolved toolset reports what its machinery did.
   *
   * @remarks One per agent, resolved once with the config, which is why it
   *   rides here rather than on each `dispatch` call: a per-call sink would let
   *   two calls on the same toolset disagree about where their diagnostics go.
   */
  logger?: ToolsLogger;
}

/**
 * The result of one coding-tool dispatch: whether it `isError`, the `text`
 * output, any `images`, and a unified `diff` when the tool produced one.
 */
export interface AgentToolResult {
  isError: boolean;
  text: string;
  images?: ToolResultImage[];
  diff?: string;
  /** Final command-review outcome for guarded shell-family calls. */
  guard?: GuardReview;
}

/**
 * The assembled coding toolset for an agent: the {@link NamespacedTool} defs to
 * advertise, the `names` set for membership checks, and a `dispatch` that runs a
 * tool by name (streaming output via `onOutput`).
 */
export interface AgentToolset {
  defs: NamespacedTool[];
  names: Set<string>;
  dispatch: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onOutput?: (chunk: string) => void,
  ) => Promise<AgentToolResult>;
}

/** Package-private seam between loop policy and the real `@clarvis/tools`
 * adapter. Tests inject this narrow contract; the public factory below always
 * binds the real implementation. */
export interface AgentToolsAdapter {
  resolve(opts: AgentToolsetOptions): {
    defs: NamespacedTool[];
    dispatch: AgentToolset["dispatch"];
  };
}

/** Map @clarvis/tools' listed tools onto bare-wire-named {@link NamespacedTool}s. */
function buildAgentToolDefs(config: RuntimeConfig): NamespacedTool[] {
  return listTools(config).map((t) => ({
    fullName: t.name,
    wireName: t.name,
    mcpName: "",
    toolName: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** The error result substituted for a tool call that the abort signal preempts. */
function abortedResult(): AgentToolResult {
  return { isError: true, text: "Tool call aborted (run cancelled)." };
}

/**
 * Race a tool-dispatch promise against the abort `signal`, resolving to
 * {@link abortedResult} the instant the signal fires so a cancelled run never
 * blocks on an in-flight tool. The abort listener is always removed afterward.
 */
function raceAbort(
  p: Promise<AgentToolResult>,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.resolve(abortedResult());
  let resolveAborted!: (value: AgentToolResult) => void;
  const aborted = new Promise<AgentToolResult>((resolve) => {
    resolveAborted = resolve;
  });
  const onAbort = (): void => resolveAborted(abortedResult());
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([p, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

const REAL_AGENT_TOOLS_ADAPTER: AgentToolsAdapter = {
  resolve(opts) {
    const config = resolveConfig({
      workspaceRoot: opts.workspaceRoot,
      readOnly: !opts.canMutate,
      ...(opts.confineToWorkspace !== undefined
        ? { confineToWorkspace: opts.confineToWorkspace }
        : {}),
      ...(opts.temporaryRoots !== undefined ? { temporaryRoots: opts.temporaryRoots } : {}),
      ...(opts.onTemporaryRootRegistered !== undefined
        ? { onTemporaryRootRegistered: opts.onTemporaryRootRegistered }
        : {}),
      ...(opts.guard !== undefined ? { guard: opts.guard } : {}),
      ...(opts.elicit !== undefined ? { elicit: opts.elicit } : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.secretEnvNames !== undefined ? { secretEnvNames: opts.secretEnvNames } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    return {
      defs: buildAgentToolDefs(config),
      dispatch: (name, args, signal, onOutput) =>
        pkgDispatch(name, args, config, signal, onOutput ? { onOutput } : undefined).then((r) => {
          const images = r.content
            .filter((p) => p.type === "image")
            .map((p) => ({ data: p.data, mediaType: p.mimeType }));
          const diff = typeof r.meta?.diff === "string" ? r.meta.diff : undefined;
          return {
            isError: r.isError,
            text: contentText(r.content),
            ...(images.length > 0 ? { images } : {}),
            ...(diff ? { diff } : {}),
            ...(r.guard ? { guard: r.guard } : {}),
          };
        }),
    };
  },
};

/** Build the loop-owned access/abort policy over an injected coding-tools
 * adapter. Kept out of the package barrel: it exists so policy units do not
 * execute filesystem or subprocess adapters. */
export function createAgentToolsetWithAdapter(
  opts: AgentToolsetOptions,
  adapter: AgentToolsAdapter,
): AgentToolset {
  const resolved = adapter.resolve(opts);
  const defs = opts.canExec
    ? resolved.defs
    : resolved.defs.filter((definition) => !EXEC_TOOL_NAMES.includes(definition.wireName));
  const names = new Set(defs.map((definition) => definition.wireName));
  return {
    defs,
    names,
    dispatch: (name, args, signal, onOutput) => {
      if (!names.has(name)) {
        return Promise.resolve({
          isError: true,
          text: `Tool '${name}' is not available to this agent.`,
        });
      }
      return raceAbort(resolved.dispatch(name, args, signal, onOutput), signal);
    },
  };
}

/**
 * Build an {@link AgentToolset} over a workspace: resolve the @clarvis/tools
 * config from the options, drop the exec tools when `canExec` is false, and
 * expose an abort-aware `dispatch`.
 *
 * @param opts - workspace root, capability gates and optional guard/elicit/
 *   sandbox wiring; see {@link AgentToolsetOptions}.
 * @returns the toolset; `dispatch` returns an error result for a tool not in the
 *   agent's set and resolves to {@link abortedResult} when the signal fires.
 * @remarks Read-only mode is derived from `!canMutate`. Image content is surfaced
 *   as `images` and a tool's `meta.diff` as `diff`.
 */
export function createAgentToolset(opts: AgentToolsetOptions): AgentToolset {
  return createAgentToolsetWithAdapter(opts, REAL_AGENT_TOOLS_ADAPTER);
}
