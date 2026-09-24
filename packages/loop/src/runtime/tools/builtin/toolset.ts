import {
  dispatch as pkgDispatch,
  contentText,
  listTools,
  resolveConfig,
  type RuntimeConfig,
  type SandboxConfig,
  type ToolsLogger,
  type ExecutionSessionManager,
} from "@clarvis/tools";
import type { NamespacedTool } from "@clarvis/capability";
import type { ToolResultImage } from "@clarvis/capability";
import { EXEC_TOOL_NAMES } from "./names.ts";
import type { WorkspaceStatePaths } from "@clarvis/paths";
import { isOperatorInterruptedTool } from "../tool-interrupt.ts";

/**
 * Options for {@link createAgentToolset}: the `workspaceRoot`, the `canMutate` /
 * `canExec` capability gates and optional `sandbox` wiring passed through to @clarvis/tools.
 */
export interface AgentToolsetOptions {
  /** Trusted resolved machinery namespace, not a model argument. */
  statePaths?: WorkspaceStatePaths;
  workspaceRoot: string;
  canMutate: boolean;
  canExec: boolean;
  temporaryRoots?: readonly string[];
  sessionManager?: ExecutionSessionManager;
  sessionAgent?: object;
  skillExecutionRoots?: readonly string[];
  sandbox?: SandboxConfig;
  /** Host-owned run identity for the resolved filesystem policy. */
  runIdentity?: string;
  /** Physical filesystem placement selected by the host, independently of escalation. */
  filesystemPlacement?: "host" | "sandbox";
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
  /** The shell executor returned its structured aborted outcome, not merely an aborted signal. */
  executionAborted?: boolean;
  /** Abort grace expired without executor settlement; physical termination is unconfirmed. */
  abortUnsettled?: boolean;
  isError: boolean;
  text: string;
  images?: ToolResultImage[];
  diff?: string;
}

/**
 * The assembled coding toolset for an agent: the {@link NamespacedTool} defs to
 * advertise, the `names` set for membership checks, and a `dispatch` that runs a
 * tool by name (streaming output via `onOutput`).
 */
export interface AgentToolset {
  defs: NamespacedTool[];
  names: Set<string>;
  continuation?: (sessionId: string) => { stop(): Promise<boolean>; completed: Promise<unknown> };
  dispatch: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onOutput?: (chunk: string) => void,
    onExecutionStarted?: () => void,
    runSignal?: AbortSignal,
  ) => Promise<AgentToolResult>;
}

/** Package-private seam between loop policy and the real `@clarvis/tools`
 * adapter. Tests inject this narrow contract; the public factory below always
 * binds the real implementation. */
export interface AgentToolsAdapter {
  resolve(opts: AgentToolsetOptions): {
    defs: NamespacedTool[];
    continuation?: (sessionId: string) => { stop(): Promise<boolean>; completed: Promise<unknown> };
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
  return { isError: true, text: "Tool call aborted." };
}

/**
 * Race a tool-dispatch promise against the abort `signal`, resolving to
 * {@link abortedResult} immediately for run cancellation. A selective interrupt
 * allows two seconds for captured output to settle, without claiming termination
 * if that grace expires. The separate run signal can preempt that grace.
 */
function raceAbort(
  p: Promise<AgentToolResult>,
  signal: AbortSignal | undefined,
  runSignal?: AbortSignal,
): Promise<AgentToolResult> {
  if (signal === undefined && runSignal === undefined) return p;
  let resolveAborted!: (value: AgentToolResult) => void;
  const aborted = new Promise<AgentToolResult>((resolve) => {
    resolveAborted = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    if (isOperatorInterruptedTool(signal?.reason) && !runSignal?.aborted) {
      timer = setTimeout(
        () =>
          resolveAborted({
            isError: true,
            text: "Tool abort requested, but execution did not settle; process termination is unconfirmed.",
            abortUnsettled: true,
          }),
        2000,
      );
    } else resolveAborted(abortedResult());
  };
  const onRunAbort = (): void => resolveAborted(abortedResult());
  signal?.addEventListener("abort", onAbort, { once: true });
  runSignal?.addEventListener("abort", onRunAbort, { once: true });
  if (signal?.aborted) onAbort();
  if (runSignal?.aborted) onRunAbort();
  return Promise.race([p, aborted]).finally(() => {
    signal?.removeEventListener("abort", onAbort);
    runSignal?.removeEventListener("abort", onRunAbort);
    if (timer !== undefined) clearTimeout(timer);
  });
}

const REAL_AGENT_TOOLS_ADAPTER: AgentToolsAdapter = {
  resolve(opts) {
    const config = resolveConfig({
      workspaceRoot: opts.workspaceRoot,
      ...(opts.statePaths === undefined ? {} : { statePaths: opts.statePaths }),
      readOnly: !opts.canMutate,
      ...(opts.temporaryRoots !== undefined ? { temporaryRoots: opts.temporaryRoots } : {}),
      ...(opts.sessionManager !== undefined ? { sessionManager: opts.sessionManager } : {}),
      ...(opts.sessionAgent !== undefined ? { sessionAgent: opts.sessionAgent } : {}),
      ...(opts.skillExecutionRoots !== undefined
        ? { skillExecutionRoots: opts.skillExecutionRoots }
        : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.runIdentity !== undefined ? { runIdentity: opts.runIdentity } : {}),
      ...(opts.filesystemPlacement !== undefined
        ? { filesystemPlacement: opts.filesystemPlacement }
        : {}),
      ...(opts.secretEnvNames !== undefined ? { secretEnvNames: opts.secretEnvNames } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
    return {
      defs: buildAgentToolDefs(config),
      continuation: (sessionId) => {
        const session = config.sessionManager.getSession(sessionId, config.sessionAgent);
        return { stop: () => session.stop(), completed: session.completed };
      },
      dispatch: (name, args, signal, onOutput, onExecutionStarted) =>
        pkgDispatch(name, args, config, signal, {
          ...(onOutput ? { onOutput } : {}),
          ...(onExecutionStarted ? { onExecutionStarted } : {}),
        }).then((r) => {
          const images = r.content
            .filter((p) => p.type === "image")
            .map((p) => ({ data: p.data, mediaType: p.mimeType }));
          const diff = typeof r.meta?.diff === "string" ? r.meta.diff : undefined;
          const text = contentText(r.content);
          return {
            isError: r.isError,
            text,
            ...(name === "shell" && r.isError && isAbortedShellResult(text)
              ? { executionAborted: true }
              : {}),
            ...(images.length > 0 ? { images } : {}),
            ...(diff ? { diff } : {}),
          };
        }),
    };
  },
};

/** Read the trusted builtin's serialized ToolError code, never infer abort from human prose. */
function isAbortedShellResult(text: string): boolean {
  try {
    const result: unknown = JSON.parse(text);
    return (
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      result.error === "aborted"
    );
  } catch {
    return false;
  }
}

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
    ...(resolved.continuation === undefined ? {} : { continuation: resolved.continuation }),
    dispatch: (name, args, signal, onOutput, onExecutionStarted, runSignal) => {
      if (!names.has(name)) {
        return Promise.resolve({
          isError: true,
          text: `Tool '${name}' is not available to this agent.`,
        });
      }
      if (signal?.aborted || runSignal?.aborted) return Promise.resolve(abortedResult());
      let active = true;
      const output =
        onOutput === undefined
          ? undefined
          : (chunk: string): void => {
              if (active && !runSignal?.aborted) onOutput(chunk);
            };
      const started =
        onExecutionStarted === undefined
          ? undefined
          : (): void => {
              if (active && !signal?.aborted && !runSignal?.aborted) onExecutionStarted();
            };
      return raceAbort(
        resolved.dispatch(name, args, signal, output, started),
        signal,
        runSignal,
      ).finally(() => {
        active = false;
      });
    },
  };
}

/**
 * Build an {@link AgentToolset} over a workspace: resolve the @clarvis/tools
 * config from the options, drop the exec tools when `canExec` is false, and
 * expose an abort-aware `dispatch`.
 *
 * @param opts - workspace root, capability gates and optional sandbox wiring;
 *   see {@link AgentToolsetOptions}.
 * @returns the toolset; `dispatch` returns an error result for a tool not in the
 *   agent's set and resolves to {@link abortedResult} when the signal fires.
 * @remarks Read-only mode is derived from `!canMutate`. Image content is surfaced
 *   as `images` and a tool's `meta.diff` as `diff`.
 */
export function createAgentToolset(opts: AgentToolsetOptions): AgentToolset {
  return createAgentToolsetWithAdapter(opts, REAL_AGENT_TOOLS_ADAPTER);
}
