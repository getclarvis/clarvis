/**
 * The built-in coding toolset (@clarvis/tools) packaged as a capability:
 * per-run enablement via env, per-agent capability ceiling from grants, and
 * the guard/guard-elicit ports wired into each agent's toolset.
 */
import type {
  AgentCapability,
  Capability,
  RunCapability,
  RunCapabilityContext,
} from "@clarvis/capability";
import type { ToolHandler, HandlerVerdict } from "@clarvis/capability";
import { handlerBaseOf, type HandlerBase } from "@clarvis/capability";
export {
  defaultGuardMode,
  guardModeSchema,
  guardJudgeSchema,
  AGENT_TOOLS_SETTINGS_FIELDS,
  AGENT_TOOLS_REQUEST_PARAMS,
  GUARD_PLUGIN_FIELDS,
  agentToolsSettingsSpec,
  sandboxSettingsSpec,
  type GuardConfig,
  type SandboxSettings,
  type ResolvedSandboxSettings,
} from "./tools-settings.ts";
import type { ConvergenceGuards } from "../guards/convergence-guards.ts";
import type { ResolvedSandboxSettings } from "./tools-settings.ts";
import { boundPromise } from "../support/bounded.ts";
import {
  agentToolCaps,
  agentToolsActive,
  createAgentToolset,
  systemTemporaryRoots,
  type AgentToolset,
  type Guard,
  type Elicit as GuardElicit,
  type GuardElicitAnswer,
} from "../tools/builtin/index.ts";

export { agentToolsActive };
import { executeAgentToolCall } from "../tools/builtin/execute-agent-tool-call.ts";
import { mkdirSync, rmSync, rmdirSync } from "node:fs";
import { DIR_MODE, workspaceStatePaths } from "@clarvis/paths";

/** Registry name of the built-in coding-tools capability. */
export const AGENT_TOOLS_CAPABILITY_NAME = "tools";

/** What a host's guard resolver yields for one run: the guard itself and,
 * optionally, the raw ask channel that answers its 'ask' verdicts. */
export interface GuardResolution {
  guard?: Guard;
  elicit?: GuardElicit;
}

/**
 * Host port: resolves the run's guard from the request (guard_mode/guard_judge),
 * the host's settings, and the client's elicit channel — all reachable through
 * the RunCapabilityContext. Return undefined to run unguarded.
 */
export type GuardResolver = (
  ctx: RunCapabilityContext,
) => Promise<GuardResolution | undefined> | GuardResolution | undefined;
/** Host port: resolves the run's sandbox policy from the request/settings.
 * Return undefined to run without a sandbox. */
export type SandboxResolver = (ctx: RunCapabilityContext) => ResolvedSandboxSettings | undefined;

/**
 * Host port: names the environment variables that hold credentials, so spawned
 * commands can be given an environment without them.
 *
 * @remarks Names, never values — the loop has no business reading a secret it
 *   only needs to subtract. A host that cannot enumerate its credentials omits
 *   this and gets the previous behaviour.
 */
export type SecretNamesResolver = (ctx: RunCapabilityContext) => readonly string[];
/** Host port returning package roots required by the run's selected skills. */
export type SkillExecutionRootsResolver = (ctx: RunCapabilityContext) => readonly string[];

/** Host-supplied ports for the tools capability: how it resolves the run's
 * guard, sandbox and credential names. All optional; omitting one runs
 * unguarded / unsandboxed / without scrubbing. */
export interface AgentToolsCapabilityOptions {
  resolveGuard?: GuardResolver;
  resolveSandbox?: SandboxResolver;
  resolveSecretNames?: SecretNamesResolver;
  resolveSkillExecutionRoots?: SkillExecutionRootsResolver;
  /** Isolated container guests set this to false so `require_escalated` fails closed. */
  allowHostEscalation?: boolean;
}

/**
 * Wrap a guard's raw ask channel so each `ask` resolves under the run's elicit
 * wait budget and abort signal.
 *
 * @returns A {@link GuardElicit} that resolves true only on an explicit
 *   approval; a timeout (when `waitMs` is finite), an abort, or a rejection all
 *   resolve to false (fail-closed).
 *
 * @remarks `waitMs: 0` means *never block on a human* — the documented meaning
 *   of the request's `elicit_wait_ms` — and so denies on the next macrotask
 *   rather than waiting forever. Treating `0` as "unbounded" made the guard the
 *   one ask site where blocking has no ceiling, which is the worst place for it:
 *   it holds a command approval. Only a non-finite `waitMs` is unbounded.
 */
export function withGuardElicitWaitBound(
  elicit: GuardElicit,
  waitMs: number,
  signal: AbortSignal | undefined,
): GuardElicit {
  return (req) =>
    boundPromise<boolean | GuardElicitAnswer>(async () => await elicit(req), {
      signal,
      timeoutMs: Number.isFinite(waitMs) ? waitMs : undefined,
      onTimeout: () => false,
      onAbort: () => false,
      mapRejection: () => false,
    });
}

/**
 * Build the built-in coding-tools capability.
 *
 * @param opts - Optional host ports for guard and sandbox resolution.
 * @returns A {@link Capability} whose `forRun` returns null unless
 *   `CLARVIS_AGENT_TOOLS_ENABLED` is set; when active it resolves the guard and
 *   sandbox once per run (a sandbox explicitly `enabled: false` is dropped) and
 *   hands each agent a toolset ceilinged by its grants.
 */
export function createAgentToolsCapability(opts?: AgentToolsCapabilityOptions): Capability {
  return {
    name: AGENT_TOOLS_CAPABILITY_NAME,
    async forRun(ctx): Promise<RunCapability | null> {
      if (!ctx.env.CLARVIS_AGENT_TOOLS_ENABLED) return null;
      const resolution = await opts?.resolveGuard?.(ctx);
      const sandbox = opts?.resolveSandbox?.(ctx);
      const statePaths = workspaceStatePaths(ctx.workspaceRoot);
      const temporaryRoot = statePaths.runTempDir(ctx.executionId);
      mkdirSync(temporaryRoot, { recursive: true, mode: DIR_MODE });
      const skillExecutionRoots = opts?.resolveSkillExecutionRoots?.(ctx) ?? [];
      return createAgentToolsRunCapability(
        ctx,
        resolution,
        sandbox?.enabled === false ? undefined : sandbox,
        opts?.resolveSecretNames?.(ctx) ?? [],
        skillExecutionRoots,
        opts?.allowHostEscalation,
        temporaryRoot,
        () => {
          for (const dir of [statePaths.runDir(ctx.executionId), statePaths.runsDir]) {
            try {
              rmdirSync(dir);
            } catch {}
          }
        },
      );
    },
  };
}

/**
 * Per-run tools activation. Each agent's grants set a capability ceiling
 * ({@link agentToolCaps} against `CLARVIS_AGENT_TOOLS_MAX_GRANT`); an agent that
 * cannot even read gets no toolset, otherwise `canMutate`/`canExec` are threaded
 * into a freshly built {@link AgentToolset} along with the guard, the
 * wait-bounded guard elicit, the resolved sandbox, and the credential names to
 * withhold from spawned commands.
 */
function createAgentToolsRunCapability(
  ctx: RunCapabilityContext,
  resolution: GuardResolution | undefined,
  sandbox: ResolvedSandboxSettings | undefined,
  secretEnvNames: readonly string[],
  skillExecutionRoots: readonly string[],
  allowHostEscalation: boolean | undefined,
  temporaryRoot: string,
  removeEmptyRunDirs: () => void,
): RunCapability {
  const elicitWaitMs = ctx.request.elicit_wait_ms ?? ctx.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS;
  const ownedTemporaryRoots = new Set([temporaryRoot]);
  const accessibleTemporaryRoots = [...new Set([temporaryRoot, ...systemTemporaryRoots()])];
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
        "\n\n## Commands and Isolation\n\n" +
        "Commands follow the run Isolation. When Isolation is Sandbox, `shell` and `monitor_start` run inside the native sandbox.\n\n" +
        "If a command that is required to finish the user's request fails because the sandbox blocked filesystem, network, or host services, call the same tool again with `sandbox_permissions` set to `require_escalated` and a short `justification` asking the user to allow that one command on the host. Do not switch tools and do not rewrite the command as argv.\n\n" +
        "Do not request escalation for routine workspace builds, tests, or git queries that work inside the sandbox. Isolated container runs cannot reach the host this way."
      );
    },
    onRunEnd() {
      for (const root of ownedTemporaryRoots) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          ctx.logger?.warn(
            {
              event: "tools.temporary_root_cleanup_failed",
              execution_id: ctx.executionId,
              cause: error instanceof Error ? error.message : String(error),
            },
            "a run-owned temporary root could not be removed",
          );
        }
      }
      removeEmptyRunDirs();
    },
    forAgent(scope): AgentCapability | null {
      const caps = agentToolCaps(scope.grants, ctx.env.CLARVIS_AGENT_TOOLS_MAX_GRANT);
      if (!caps.canRead) return null;
      const guardElicit =
        resolution?.elicit !== undefined
          ? withGuardElicitWaitBound(resolution.elicit, elicitWaitMs, scope.signal)
          : undefined;
      const toolset = createAgentToolset({
        workspaceRoot: ctx.workspaceRoot,
        canMutate: caps.canMutate,
        canExec: caps.canExec,
        confineToWorkspace: ctx.env.CLARVIS_AGENT_TOOLS_CONFINE,
        temporaryRoots: accessibleTemporaryRoots,
        skillExecutionRoots,
        onTemporaryRootRegistered: (root) => ownedTemporaryRoots.add(root),
        ...(ctx.logger !== undefined ? { logger: ctx.logger } : {}),
        ...(secretEnvNames.length > 0 ? { secretEnvNames } : {}),
        ...(resolution?.guard !== undefined ? { guard: resolution.guard } : {}),
        ...(guardElicit !== undefined ? { elicit: guardElicit } : {}),
        ...(allowHostEscalation !== undefined ? { allowHostEscalation } : {}),
        ...(sandbox !== undefined
          ? {
              sandbox: {
                type: sandbox.type,
                ...(sandbox.availability !== undefined
                  ? { availability: sandbox.availability }
                  : {}),
                ...(sandbox.filesystem !== undefined ? { filesystem: sandbox.filesystem } : {}),
                ...(sandbox.network !== undefined ? { network: sandbox.network } : {}),
                ...(sandbox.pass_env !== undefined ? { passEnv: sandbox.pass_env } : {}),
                ...(sandbox.resolved_read_only_paths !== undefined
                  ? { readOnlyPaths: sandbox.resolved_read_only_paths }
                  : {}),
                ...(sandbox.resolved_runtime_paths !== undefined
                  ? { runtimePaths: sandbox.resolved_runtime_paths }
                  : {}),
              },
            }
          : {}),
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
 * {@link executeAgentToolCall} (guard checks, convergence guards, tracing) and
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
    matches: (call) => toolset.names.has(call.name),
    async handle(call, iteration): Promise<HandlerVerdict> {
      const { resultText, errText, productive, images } = await executeAgentToolCall({
        call,
        toolset,
        guards: deps.guards,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
        ...(base.signal ? { signal: base.signal } : {}),
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
      };
    },
  };
}
