import { ExecutionSessionManager, type AgentToolsOptions } from "@clarvis/tools";
/**
 * The built-in coding toolset (@clarvis/tools) packaged as a capability:
 * per-run enablement via env, per-agent capability ceiling from grants, and
 * host command execution wired into each agent's toolset.
 */
import type {
  AgentCapability,
  Capability,
  RunCapability,
  RunCapabilityContext,
} from "@clarvis/capability";
import type { ToolHandler, HandlerVerdict } from "@clarvis/capability";
import { handlerBaseOf, type HandlerBase } from "@clarvis/capability";
import type { ConvergenceGuards } from "../guards/convergence-guards.ts";
import {
  agentToolCaps,
  agentToolsActive,
  createAgentToolset,
  systemTemporaryRoots,
  type AgentToolset,
} from "../tools/builtin/index.ts";

export { agentToolsActive };
import { executeAgentToolCall } from "../tools/builtin/execute-agent-tool-call.ts";
import {
  allocateShortTemporaryRoot,
  workspaceStatePaths,
  type ShortTemporaryRoot,
  type WorkspaceStatePaths,
} from "@clarvis/paths";

/** Registry name of the built-in coding-tools capability. */
export const AGENT_TOOLS_CAPABILITY_NAME = "tools";

/**
 * Host port: names the environment variables that hold credentials, so spawned
 * commands can be given an environment without them.
 *
 * @remarks Names, never values — the loop has no business reading a secret it
 *   only needs to subtract. A host that cannot enumerate its credentials omits
 *   this and gets the previous behaviour.
 */
export type SecretNamesResolver = (ctx: RunCapabilityContext) => readonly string[];
/** Host-owned run boundary; absent keeps standalone and embedded callers on Host. */
export type AgentExecutionBinding = Pick<
  AgentToolsOptions,
  | "executionPort"
  | "executionPolicy"
  | "sandboxBackend"
  | "actionAuthorization"
  | "actionIdentity"
  | "selectAuthorizedExecution"
>;
export type AgentExecutionResolver = (
  ctx: RunCapabilityContext,
  scratchRoot: string,
) => AgentExecutionBinding | Promise<AgentExecutionBinding>;

/** Admit only temporary directories mounted by the native Sandbox policy. */
export function temporaryRootsForExecution(
  scratchRoot: string,
  execution: AgentExecutionBinding,
  systemRoots: readonly string[],
): string[] {
  const available = execution.executionPolicy
    ? systemRoots.filter(
        (root) =>
          root === "/tmp" ||
          (root === "/private/tmp" && execution.sandboxBackend?.name === "seatbelt"),
      )
    : systemRoots;
  return [...new Set([scratchRoot, ...available])];
}
/** Host-supplied ports for the tools capability: how it resolves the run's
 * credential names. */
export interface AgentToolsCapabilityOptions {
  /** Host-resolved workspace state paths shared by tools and run cleanup. */
  statePaths?: WorkspaceStatePaths;
  resolveSecretNames?: SecretNamesResolver;
  /** Test seam for a run-local execution manager; called once for each activated run. */
  createSessionManager?: () => ExecutionSessionManager;
  resolveExecution?: AgentExecutionResolver;
}

/**
 * Build the built-in coding-tools capability.
 *
 * @param opts - Optional host ports for state and credential resolution.
 * @returns A {@link Capability} whose `forRun` returns null unless
 *   `CLARVIS_AGENT_TOOLS_ENABLED` is set; when active it resolves the
 *   allocates the run's own short scratch root and hands each agent a toolset
 *   ceilinged by its grants.
 * @remarks The scratch root is allocated by `@clarvis/paths` rather than derived
 *   from the workspace state tree, so a deep `CLARVIS_HOME`, workspace path or run
 *   id cannot consume the socket and path budget of everything the run's commands
 *   place under `TMPDIR`. It is shared by every agent of the run and released
 *   once, after the run has ended. An unusable host fails the run here rather than
 *   handing its commands a scratch nobody can prove is the run's own.
 */
export function createAgentToolsCapability(opts?: AgentToolsCapabilityOptions): Capability {
  return {
    name: AGENT_TOOLS_CAPABILITY_NAME,
    async forRun(ctx): Promise<RunCapability | null> {
      if (!ctx.env.CLARVIS_AGENT_TOOLS_ENABLED) return null;
      const statePaths = opts?.statePaths ?? workspaceStatePaths(ctx.workspaceRoot);
      const scratch = allocateShortTemporaryRoot({
        label: "run",
        identity: ctx.executionId,
        ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
      });
      try {
        const execution = (await opts?.resolveExecution?.(ctx, scratch.path)) ?? {};
        return createAgentToolsRunCapability(
          ctx,
          opts?.resolveSecretNames?.(ctx) ?? [],
          scratch,
          statePaths,
          opts?.createSessionManager?.() ?? new ExecutionSessionManager(),
          execution,
        );
      } catch (error) {
        scratch.remove();
        throw error;
      }
    },
  };
}

/**
 * Per-run tools activation. Each agent's grants set a capability ceiling
 * ({@link agentToolCaps} against `CLARVIS_AGENT_TOOLS_MAX_GRANT`); an agent that
 * cannot even read gets no toolset, otherwise `canMutate`/`canExec` are threaded
 * into a freshly built {@link AgentToolset} along with credential names to
 * withhold from spawned commands.
 */
function createAgentToolsRunCapability(
  ctx: RunCapabilityContext,
  secretEnvNames: readonly string[],
  scratch: ShortTemporaryRoot,
  statePaths: WorkspaceStatePaths,
  sessionManager: ExecutionSessionManager,
  execution: AgentExecutionBinding,
): RunCapability {
  const temporaryRoot = scratch.path;
  const accessibleTemporaryRoots = temporaryRootsForExecution(
    temporaryRoot,
    execution,
    systemTemporaryRoots(),
  );
  return {
    name: AGENT_TOOLS_CAPABILITY_NAME,
    systemSection(id) {
      const caps = agentToolCaps(id.grants, ctx.env.CLARVIS_AGENT_TOOLS_MAX_GRANT);
      if (!caps.canRead) return undefined;
      const temporary =
        "## Temporary work\n\n" +
        "`TMPDIR` names scratch space owned by this run. Shell commands and native coding tools " +
        "can also reuse paths created by host-native temporary-file APIs.";
      if (!caps.canExec) return temporary;
      return (
        temporary +
        "\n\n## Commands\n\n" +
        "Commands use the operating system's filesystem permissions. `shell_session` only inspects or stops a session that this run already owns."
      );
    },
    async onRunEnd() {
      const budgetMs = ctx.env.CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS;
      const cleanupDeadline = Date.now() + budgetMs;
      const drained = await sessionManager.close(Math.max(0, budgetMs - 250));
      if (!drained) {
        await execution.executionPort?.close?.();
        ctx.logger?.warn(
          { event: "tools.session_drain_unconfirmed", execution_id: ctx.executionId },
          "command termination was not confirmed; run temporary roots were retained",
        );
        return;
      }
      await execution.executionPort?.close?.();
      if (budgetMs <= 250 || Date.now() >= cleanupDeadline) {
        ctx.logger?.warn(
          { event: "tools.session_cleanup_budget_exhausted", execution_id: ctx.executionId },
          "run temporary roots were retained after the cleanup budget expired",
        );
        return;
      }
      if (Date.now() < cleanupDeadline) scratch.remove();
      else
        ctx.logger?.warn(
          { event: "tools.session_cleanup_budget_exhausted", execution_id: ctx.executionId },
          "run temporary roots were retained after the cleanup budget expired",
        );
    },
    forAgent(scope): AgentCapability | null {
      const caps = agentToolCaps(scope.grants, ctx.env.CLARVIS_AGENT_TOOLS_MAX_GRANT);
      if (!caps.canRead) return null;
      const toolset = createAgentToolset({
        statePaths,
        workspaceRoot: ctx.workspaceRoot,
        canMutate: caps.canMutate,
        canExec: caps.canExec,
        temporaryRoots: accessibleTemporaryRoots,
        sessionManager,
        sessionAgent: {},
        ...execution,
        ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
        ...(secretEnvNames.length > 0 ? { secretEnvNames } : {}),
      });
      return {
        attach(bc) {
          return {
            tools: toolset.defs,
            handlers: [
              buildAgentToolsHandler({
                base: handlerBaseOf(bc),
                toolset,
                guards: bc.guards,
                progress: bc.toolProgress,
              }),
            ],
            advertised: true,
          };
        },
      };
    },
  };
}

/**
 * Handler for the built-in coding toolset: executes a matching call through
 * {@link executeAgentToolCall} (convergence guards and tracing) and
 * wraps the outcome as a `Tool '<name>' result[ (error)]: …` verdict.
 *
 * @returns A {@link HandlerVerdict} whose `progress` is decided by `deps.progress`
 *   from the call's error/productivity, carrying any returned `images`.
 */
export function buildAgentToolsHandler(deps: {
  base: HandlerBase;
  toolset: AgentToolset;
  guards: ConvergenceGuards;
  progress: (r: { errText: string | null; productive: boolean }) => boolean;
}): ToolHandler {
  const { base, toolset } = deps;
  return {
    authorizationHandled: true,
    matches: (call) => toolset.names.has(call.name),
    canonicalName: (call) => (toolset.names.has(call.name) ? call.name : undefined),
    interruptible: (call) => call.name === "shell",
    async handle(call, iteration, context): Promise<HandlerVerdict> {
      const { resultText, errText, productive, images, sessionId } = await executeAgentToolCall({
        call,
        toolset,
        guards: deps.guards,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
        signal: context?.signal ?? base.signal,
        ...(base.signal !== undefined ? { runSignal: base.signal } : {}),
        ...(context?.control !== undefined ? { control: context.control } : {}),
      });
      const text =
        errText === null
          ? `Tool '${call.name}' result: ${resultText}`
          : `Tool '${call.name}' result (error): ${errText}`;
      return {
        kind: "result",
        text,
        progress: deps.progress({ errText, productive }),
        ...(images ? { images } : {}),
        ...(sessionId !== undefined && toolset.continuation !== undefined
          ? { interruptContinuation: toolset.continuation(sessionId) }
          : {}),
      };
    },
  };
}
