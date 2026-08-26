/**
 * Compiles configured workspace hooks into the loop's own lifecycle contract.
 *
 * @remarks
 * This is the only module that knows both sides. The package's `.` entry
 * executes commands and knows nothing about a {@link LifecycleHook};
 * `@clarvis/capability` declares the contract and the hook schema and knows
 * nothing about spawning. Everything that has to agree lives here.
 *
 * It is a **separate entry** from `.` rather than part of it, and separate from
 * the engine's `capabilities/hooks.ts` settings block, for one reason: that
 * block is imported by `settings-specs.ts` and therefore by the settings,
 * plugin and request schemas - i.e. by everything. Nothing on that eager path
 * may reach this module, which is what makes `builtins.hooks = false` genuinely
 * not load `@clarvis/hooks` at all.
 */
import { filterHookEnv, interpolatedNames } from "./env.ts";
import { hookInvocationFor, type HookEvent } from "./event-serialization.ts";
import { createHookRunner, type HookRunner } from "./runner.ts";
import type { HookSpec } from "./types.ts";
import type { BeforeToolUseContext, HookVerdict, LifecycleHook } from "@clarvis/capability";
import type { Capability, RunCapability, RunCapabilityContext, Logger } from "@clarvis/capability";
import {
  COMPACTION_HOOK_EVENTS,
  CONTEXT_HOOK_EVENTS,
  GATE_HOOK_EVENTS,
  HOOKS_CAPABILITY_NAME,
  NOOP_LOGGER,
  type CompactionContribution,
  type HookConfig,
  type OBSERVER_HOOK_EVENTS,
} from "@clarvis/capability";

/**
 * Open tag of the pinned block a `session_start` hook contributes.
 *
 * @remarks
 * Declared on the {@link Capability} rather than the activation, so a stale
 * block left in a continuation is stripped even on a later run where hooks are
 * configured away entirely.
 */
export const HOOKS_SEED_MARKER = "<workspace-hooks>";

/** Closing tag of the seed block, derived so it cannot drift from its opener. */
const HOOKS_SEED_CLOSE = HOOKS_SEED_MARKER.replace("<", "</");

type GateEvent = (typeof GATE_HOOK_EVENTS)[number];
type ObserverEvent = (typeof OBSERVER_HOOK_EVENTS)[number];
type ContextEvent = (typeof CONTEXT_HOOK_EVENTS)[number];
type CompactionEvent = (typeof COMPACTION_HOOK_EVENTS)[number];

/**
 * Which `LifecycleHook` method each event drives.
 *
 * @remarks
 * Typed as a total record over the gate, observer and compaction events so that
 * adding one to `hooks.ts` without extending this map is a compile error rather
 * than an event that silently never fires. The context events are excluded on
 * purpose: they reach the model through `seedBlock`, not through a hook method.
 *
 * Every entry is the mechanical `snake_case` to `onCamelCase` transform except
 * the two tool events, whose methods predate the schema's naming.
 */
const EVENT_METHOD: Record<GateEvent | ObserverEvent | CompactionEvent, keyof LifecycleHook> = {
  pre_tool_use: "beforeToolUse",
  post_tool_use: "afterToolUse",
  pre_finalize: "preFinalize",
  pre_delegate_task: "preDelegateTask",
  run_start: "onRunStart",
  run_end: "onRunEnd",
  subagent_complete: "onSubagentComplete",
  pre_compact: "onPreCompact",
  model_call_error: "onModelCallError",
  budget_exhausted: "onBudgetExhausted",
  user_steer: "onUserSteer",
};

const GATE_EVENTS = new Set<string>(GATE_HOOK_EVENTS);
const CONTEXT_EVENTS = new Set<string>(CONTEXT_HOOK_EVENTS);
const COMPACTION_EVENTS = new Set<string>(COMPACTION_HOOK_EVENTS);
/** Groups specs by event, preserving the merged operator-then-plugin order. */
function byEvent(hooks: readonly HookConfig[]): Map<HookEvent, HookConfig[]> {
  const out = new Map<HookEvent, HookConfig[]>();
  for (const hook of hooks) {
    const list = out.get(hook.event);
    if (list === undefined) out.set(hook.event, [hook]);
    else list.push(hook);
  }
  return out;
}

/**
 * Compiles the configured hooks into at most one {@link LifecycleHook}.
 *
 * @param hooks - the merged configuration, in the order the settings spec
 *   produced (every operator hook before every plugin hook).
 * @param runner - the executor.
 * @param signal - the run's abort signal, wired into every child.
 * @returns a hook object, or `undefined` when nothing gate- or observer-shaped
 *   is configured.
 * @remarks
 * **Only the methods that have a spec are defined**, which is why this iterates
 * the grouped map rather than the event list. Two engine behaviours read the
 * mere presence of a method: `buildPreFinalizeGate`'s `fastAcceptOk` and the
 * fast-accept-submit path, both of which would be switched off for the whole run
 * by an object that carried all eleven keys.
 *
 * No method ever throws - the runner turns every failure into a value - so the
 * engine's blanket fail-closed treatment of a *thrown* host hook is unreachable
 * here by construction. That is deliberate: failure policy belongs to the
 * individual hook's `on_failure`, not to the fire point.
 */
export function compileWorkspaceHooks(
  hooks: readonly HookConfig[],
  runner: HookRunner,
  signal?: AbortSignal,
): LifecycleHook | undefined {
  const grouped = byEvent(hooks);
  /**
   * Which specs fire is decided once, against the arguments the model sent, and
   * a later rewrite does not re-run selection. Re-selecting would let one hook's
   * replacement silence a hook that was about to fire on the original call,
   * which is a policy decision no hook should be able to make implicitly.
   */

  const gate =
    (event: HookEvent, specs: readonly HookSpec[]) =>
    async (context: unknown): Promise<HookVerdict> => {
      const initial = hookInvocationFor(event, context);
      const advice: string[] = [];
      let current = context;
      let replaced: object | undefined;
      for (const spec of runner.select(specs, initial)) {
        const inv = replaced === undefined ? initial : hookInvocationFor(event, current);
        const outcome = runner.resolve(await runner.run(spec, inv, signal), inv);
        if (outcome.kind === "deny") return { kind: "deny", message: outcome.message };
        if (outcome.kind === "advise") advice.push(outcome.message);
        if (outcome.kind === "rewrite") {
          replaced = outcome.arguments;
          current = { ...(context as BeforeToolUseContext), arguments: outcome.arguments };
          if (outcome.message !== undefined) advice.push(outcome.message);
        }
      }
      const message = advice.join("\n");
      if (replaced !== undefined) {
        return { kind: "rewrite", arguments: replaced, ...(message === "" ? {} : { message }) };
      }
      return message === "" ? { kind: "pass" } : { kind: "advise", message };
    };

  const observer =
    (event: HookEvent, specs: readonly HookSpec[]) =>
    async (context: unknown): Promise<void> => {
      const inv = hookInvocationFor(event, context);
      const selected = runner.select(specs, inv);
      await Promise.all(selected.map(async (spec) => runner.run(spec, inv, signal)));
    };

  const contributor =
    (event: HookEvent, specs: readonly HookSpec[]) =>
    async (context: unknown): Promise<CompactionContribution[]> => {
      const inv = hookInvocationFor(event, context);
      const out: CompactionContribution[] = [];
      for (const spec of runner.select(specs, inv)) {
        const result = await runner.run(spec, inv, signal);
        if (result.ok && result.outcome.kind === "context") {
          out.push({ source: "hook", text: result.outcome.text });
        }
      }
      return out;
    };

  const compiled: Partial<Record<keyof LifecycleHook, unknown>> = {};
  for (const [event, specs] of grouped) {
    if (CONTEXT_EVENTS.has(event)) continue;
    const method = EVENT_METHOD[event as GateEvent | ObserverEvent | CompactionEvent] as
      keyof LifecycleHook | undefined;
    if (method === undefined) continue;
    if (GATE_EVENTS.has(event)) compiled[method] = gate(event, specs);
    else if (COMPACTION_EVENTS.has(event)) compiled[method] = contributor(event, specs);
    else compiled[method] = observer(event, specs);
  }

  return Object.keys(compiled).length === 0 ? undefined : (compiled as LifecycleHook);
}

/**
 * Runs the `session_start` hooks and assembles the pinned entry-context block.
 *
 * @returns the block, or `undefined` when no hook contributed text.
 * @remarks
 * Swallows every failure. The contract states that a throw from `seedBlock`
 * fails the run, and a hook whose job is to *offer* context must never be able
 * to do that - which is also why the schema rejects `on_failure` on this event.
 *
 * Exported for the same reason {@link compileWorkspaceHooks} is: `runner` is a
 * structural {@link HookRunner}, so a host may assemble the seed block over one
 * of its own, and the swallowing above is only demonstrable against a runner
 * that actually throws. The runner this package builds never does — a spawn
 * failure is caught into `spawnError` rather than raised.
 */
export async function buildSeedBlock(
  hooks: readonly HookConfig[],
  runner: HookRunner,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
): Promise<string | undefined> {
  const specs = hooks.filter((h) => CONTEXT_EVENTS.has(h.event));
  if (specs.length === 0) return undefined;

  const texts: string[] = [];
  for (const event of CONTEXT_HOOK_EVENTS as readonly ContextEvent[]) {
    const inv = hookInvocationFor(event, undefined);
    for (const spec of runner.select(specs, inv)) {
      try {
        const result = await runner.run(spec, inv, signal);
        if (result.ok && result.outcome.kind === "context") texts.push(result.outcome.text);
      } catch (err) {
        logger?.warn({ hook_event: event, err }, "a context hook failed; it contributes nothing");
      }
    }
  }
  if (texts.length === 0) return undefined;
  return `${HOOKS_SEED_MARKER}\n${texts.join("\n\n")}\n${HOOKS_SEED_CLOSE}`;
}

/**
 * Names of environment variables this run is using to hold credentials.
 *
 * @remarks
 * There is no registry of provider key names in this codebase, by design: a
 * provider *names* its variable in configuration (`api_key_env`), so the only
 * authoritative list is the one the current run resolved. Three other surfaces
 * reach credentials through `${VAR}` interpolation and deserve identical
 * treatment even though their shape says nothing: an MCP server's `env` and
 * `headers`, and a provider's or model's own `headers`. A partner token
 * configured as a provider header is a credential exactly as much as an API key
 * is, and omitting it is invisible — a hook that reads it *succeeds*.
 *
 * The request alone is **not** enough for the MCP half. The kernel narrows a
 * run's `servers` to those whose tools some profile actually grants, while the
 * process environment the hook inherits carries every key the host resolved. A
 * server this run never touches therefore contributes no denied name while its
 * token is still present and, unless it happens to be spelled like a secret,
 * still readable. `extra` closes that gap: the host passes the names from the
 * full registry through {@link WorkspaceHooksOptions.credentialNames}.
 *
 * A provider's `models` is a **record**, so the per-model headers are reached
 * through `Object.values`. A `for…of` written over it directly iterates nothing
 * and throws nothing, which would drop every model-level header in silence.
 */
export function runCredentialNames(ctx: RunCapabilityContext, extra: readonly string[]): string[] {
  const names: string[] = [...extra];
  const fromHeaders = (headers: Record<string, string> | undefined): void => {
    for (const value of Object.values(headers ?? {})) names.push(...interpolatedNames(value));
  };
  for (const provider of ctx.request.providers) {
    if (provider.api_key_env !== undefined) names.push(provider.api_key_env);
    fromHeaders(provider.headers);
    for (const model of Object.values(provider.models ?? {})) fromHeaders(model.headers);
  }
  for (const server of ctx.request.servers) {
    for (const value of Object.values(server.env ?? {})) names.push(...interpolatedNames(value));
    fromHeaders(server.headers);
  }
  return names;
}

/** Construction inputs for {@link createWorkspaceHooksCapability}. */
export interface WorkspaceHooksOptions {
  /**
   * Reads the merged `hooks` block for this run.
   *
   * @remarks
   * Called per run rather than captured once, so editing `settings.json` takes
   * effect on the next run without restarting the host - the same shape the
   * guard and the memory factory already use.
   */
  resolveHooks: (ctx: RunCapabilityContext) => readonly HookConfig[] | undefined;
  /**
   * The host environment the child inherits from, before filtering.
   *
   * @remarks
   * Supplied at construction because {@link RunCapabilityContext} carries no
   * process environment: its `env` is the parsed `CLARVIS_*` configuration.
   */
  environment: Readonly<Record<string, string | undefined>>;
  /**
   * Every environment variable name the host holds a credential in, beyond what
   * this run's request reveals.
   *
   * @remarks Read per run, like {@link WorkspaceHooksOptions.resolveHooks}. The
   * request only names the servers a run was narrowed to, so without this the
   * denylist misses the credentials of every configured-but-unused MCP server —
   * which are nonetheless present in the environment the hook inherits.
   */
  credentialNames?: () => readonly string[];
}

/**
 * Registers workspace hooks - shell commands from settings and plugin manifests
 * - as a capability.
 *
 * @param opts - how to read the configuration and what environment to start from.
 * @returns a {@link Capability} that activates only for a run with hooks
 *   configured, but always declares its seed marker.
 * @remarks
 * Distinct from `createHooksCapability`, which carries already-built
 * {@link LifecycleHook}s an embedder supplies directly. Both may be registered
 * at once; nothing in the engine keys on a capability's name.
 */
export function createWorkspaceHooksCapability(opts: WorkspaceHooksOptions): Capability {
  return {
    name: HOOKS_CAPABILITY_NAME,
    seedMarker: HOOKS_SEED_MARKER,
    forRun(ctx: RunCapabilityContext): RunCapability | null {
      const hooks = opts.resolveHooks(ctx) ?? [];
      if (hooks.length === 0) return null;

      const filtered = filterHookEnv(opts.environment, {
        denyExact: runCredentialNames(ctx, opts.credentialNames?.() ?? []),
      });
      const logger = ctx.logger ?? NOOP_LOGGER;
      logger.debug(
        {
          event: "hooks.env_filtered",
          denied_count: filtered.denied.exact + filtered.denied.shape,
          denied_by_exact: filtered.denied.exact,
          denied_by_shape: filtered.denied.shape,
        },
        "the hook environment was filtered for this run; the withheld variables are counted and never named, because the denylist is derived from exactly this run's credentials",
      );
      const runner = createHookRunner({
        workspaceRoot: ctx.workspaceRoot,
        baseEnv: filtered.env,
        logger,
        sessionId: ctx.executionId,
      });

      const lifecycle = compileWorkspaceHooks(hooks, runner, ctx.signal);
      return {
        name: HOOKS_CAPABILITY_NAME,
        ...(lifecycle !== undefined ? { lifecycle: [lifecycle] } : {}),
        seedBlock: async () => buildSeedBlock(hooks, runner, ctx.signal, ctx.logger),
        forAgent: () => null,
      };
    },
  };
}

/**
 * Wrap a fixed set of {@link LifecycleHook}s as a capability that carries them
 * into the run's hook chain.
 *
 * @param hooks - The already-built hook implementations (fire points, ordering
 *   and fail-closed semantics live with them and the loop's fire sites).
 * @param name - Capability name; defaults to {@link HOOKS_CAPABILITY_NAME}.
 * @returns A {@link Capability} whose `forRun` returns null when `hooks` is
 *   empty, otherwise exposes them as `lifecycle` and contributes nothing
 *   per-agent (`forAgent` always returns null).
 */
export function createHooksCapability(
  hooks: readonly LifecycleHook[],
  name: string = HOOKS_CAPABILITY_NAME,
): Capability {
  return {
    name,
    forRun(): RunCapability | null {
      if (hooks.length === 0) return null;
      return {
        name,
        lifecycle: hooks,
        forAgent: () => null,
      };
    },
  };
}
