import { projected } from "../capability-event.ts";
import { randomUUID } from "node:crypto";
import {
  DELEGATE_TASK_MAX_CHARS,
  parseDelegateTaskText,
  parseTaskTitle,
  type LLMProvider,
  type TaskTrackingPort,
} from "@clarvis/capability";
import type { GateVerdict, ImagePart, LifecycleHook, SteerSource } from "@clarvis/capability";
import type { Logger } from "@clarvis/capability";
import { LIFECYCLE_GATE_HOOK_TIMEOUT_MS, runVerdictHooks } from "../loop/lifecycle-hooks.ts";
import type { SubagentAggregate } from "@clarvis/capability";
import { accumulateSubagentUsage } from "../usage.ts";
import type { NamespacedRegistry } from "@clarvis/capability";
import { buildRegistry, selectTools, type RegistryEntry } from "../tools/mcp-registry.ts";
import type { TokenLedger } from "../budget/budget.ts";
import type { TracePort } from "@clarvis/capability";
import {
  runSubagent,
  type RunSubagentInput,
  type RunSubagentResult,
  type SubagentOutcome,
  type SubagentUsageSnapshot,
} from "./run-subagent.ts";
import {
  resolveIterationCap,
  type ResolvedSubagentProfile,
  type SubagentProfileRegistry,
} from "./subagent-profiles.ts";
import type { EnvConfig } from "@clarvis/capability";
import type { AgentCapability, SubagentCapabilitiesFactory } from "@clarvis/capability";
import { agentToolsActive } from "../tools/builtin/grants.ts";
import type { ComputeClock, ComputeRegion } from "@clarvis/capability";
import { fireObservers } from "../loop/lifecycle-hooks.ts";
import type { CapabilityEventListener } from "@clarvis/capability";
import { DELEGATE_TASK_TOOL_NAME } from "../tools/wire-names.ts";
import type { SPAWN_SUBAGENT_TOOL_NAME } from "../tools/wire-names.ts";

type ChildSpawnToolName = typeof DELEGATE_TASK_TOOL_NAME | typeof SPAWN_SUBAGENT_TOOL_NAME;

/**
 * The result of validating raw child-spawn arguments: either the normalized
 * `{ title, task, profile, task_id?, image_refs? }` on success, or a
 * model-facing error `message` explaining what to fix.
 *
 * @remarks Produced by {@link validateDelegateTaskArgs}; the `profile` is always
 *   resolved to a concrete registered name even when the caller omitted it.
 */
export type DelegateTaskArgsResult =
  | {
      ok: true;
      title: string;
      task: string;
      profile: string;
      task_id?: string;
      image_refs?: number[];
    }
  | { ok: false; message: string };

/**
 * Options for {@link validateDelegateTaskArgs}: whether this is a tracked
 * delegation, the optional task tracker, profile resolution inputs, and the
 * available turn-image count.
 */
export interface ValidateDelegateTaskOptions {
  tasks?: TaskTrackingPort;
  requireTaskId?: boolean;
  profiles?: SubagentProfileRegistry;
  defaultProfile?: string;
  turnImageCount?: number;
}

/**
 * Validates and normalizes raw child-spawn arguments against the run's profiles,
 * tracked tasks, and available images.
 *
 * @param raw - the model-supplied argument object.
 * @param options - validation context; see {@link ValidateDelegateTaskOptions}.
 * @returns a {@link DelegateTaskArgsResult} — the normalized args or an
 *   actionable error message.
 * @remarks `title` and `task` must be non-empty strings. `profile` resolves in
 *   order: an explicit registered name, else `defaultProfile` if registered,
 *   else the sole profile when exactly one exists, otherwise it is required.
 *   A tracked delegation requires an exact `task_id` that is neither `done` nor
 *   `abandoned`; an independent spawn ignores that surplus field. `image_refs` requires the turn to
 *   carry images and the chosen profile's model to declare the `vision`
 *   capability — no grant is consulted, and the model-facing description says
 *   the same; indices must be in-range integers and are de-duplicated while
 *   preserving order.
 */
export function validateDelegateTaskArgs(
  raw: unknown,
  options: ValidateDelegateTaskOptions = {},
): DelegateTaskArgsResult {
  const { tasks, profiles, defaultProfile, turnImageCount } = options;
  const requireTaskId = options.requireTaskId ?? tasks !== undefined;
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "task must be a non-empty string" };
  }
  const obj = raw as Record<string, unknown>;
  const parsedTask = parseDelegateTaskText(obj.task);
  if (!parsedTask.ok) return parsedTask;
  const parsedTitle = parseTaskTitle(obj.title);
  if (!parsedTitle.ok) return parsedTitle;
  const names = profiles ? [...profiles.keys()] : [];
  const namesHint =
    names.length > 0
      ? ` Registered profiles: ${names.join(", ")}.`
      : " No profiles are registered.";
  let profile: string;
  if (obj.profile !== undefined) {
    if (typeof obj.profile !== "string" || obj.profile.length === 0) {
      return { ok: false, message: `profile must be a registered profile name.${namesHint}` };
    }
    if (!profiles?.has(obj.profile)) {
      return { ok: false, message: `unknown profile '${obj.profile}'.${namesHint}` };
    }
    profile = obj.profile;
  } else if (defaultProfile !== undefined && profiles?.has(defaultProfile)) {
    profile = defaultProfile;
  } else if (names.length === 1) {
    profile = names[0]!;
  } else {
    return {
      ok: false,
      message: `profile is required — name the profile this Sub-agent should run as.${namesHint}`,
    };
  }
  let task_id: string | undefined;
  if (requireTaskId) {
    const id = obj.task_id;
    if (typeof id !== "string" || id.length === 0) {
      return {
        ok: false,
        message:
          "task_id is required and must be the exact id of an existing tracked task. " +
          "Use spawn_subagent for independent work.",
      };
    }
    if (tasks === undefined) {
      return {
        ok: false,
        message: "task_id cannot be resolved because this run has no task tracker",
      };
    }
    const spawnable = tasks.openTasks().map((open: { id: string }) => open.id);
    const idsHint =
      spawnable.length > 0
        ? ` Spawnable task ids: ${spawnable.join(", ")}.`
        : " No existing tracked task is currently spawnable.";
    const independentHint = " Use spawn_subagent for independent work.";
    const task = tasks.getTask(id);
    if (!task) {
      return { ok: false, message: `unknown task_id '${id}'.${idsHint}${independentHint}` };
    }
    if (task.status === "done" || task.status === "abandoned") {
      return {
        ok: false,
        message: `task_id '${id}' is already ${task.status} and cannot be re-spawned (only a pending, in-progress, returned, or failed task can be spawned).${idsHint}${independentHint}`,
      };
    }
    task_id = id;
  }
  let image_refs: number[] | undefined;
  if (obj.image_refs !== undefined) {
    const raw_refs = obj.image_refs;
    if (!Array.isArray(raw_refs) || raw_refs.length === 0) {
      return { ok: false, message: "image_refs must be a non-empty array of image indices." };
    }
    const count = turnImageCount ?? 0;
    if (count === 0) {
      return { ok: false, message: "image_refs was provided but this turn carries no images." };
    }
    const selected = profiles?.get(profile);
    const hasVision = selected?.capabilities?.has("vision") ?? false;
    if (!hasVision) {
      return {
        ok: false,
        message: `profile '${profile}' cannot receive images — its model does not declare the 'vision' capability. Route image_refs to a profile whose model does, or omit it.`,
      };
    }
    const seen = new Set<number>();
    const refs: number[] = [];
    for (const r of raw_refs) {
      if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= count) {
        return {
          ok: false,
          message: `image_refs entries must be integers in [0, ${count - 1}]; got ${JSON.stringify(r)}.`,
        };
      }
      if (!seen.has(r)) {
        seen.add(r);
        refs.push(r);
      }
    }
    image_refs = refs;
  }
  return {
    ok: true,
    title: parsedTitle.title,
    task: parsedTask.task,
    profile,
    ...(task_id !== undefined ? { task_id } : {}),
    ...(image_refs !== undefined ? { image_refs } : {}),
  };
}

/** Re-exports {@link SubagentAggregate} so consumers of this module need not reach into `types/usage`. */
export type { SubagentAggregate };

/**
 * Everything a delegation needs across its two phases ({@link prepareSpawn} then
 * {@link runPreparedSubagent}): the environment, the open tool registry, the
 * profile registry and default, the shared budget/ledger and trace, per-model
 * usage accumulators, cancellation, the optional task-tracking port and capability
 * factory, workspace root, lifecycle hooks, this turn's images, and the
 * capability event emitter.
 */
export interface DelegateTaskContext {
  env: EnvConfig;
  opened: RegistryEntry[];
  profiles: SubagentProfileRegistry;
  defaultProfile?: string;
  iterationLimitDefault: number;
  llm: LLMProvider;
  ledger: TokenLedger;
  trace: TracePort;
  subagentAggByModel: Map<string, SubagentAggregate>;
  signal?: AbortSignal;
  tasks?: TaskTrackingPort;
  /** Whether this call must resolve an existing tracked task. */
  requireTaskId?: boolean;
  /** The wire name used in model-facing results and denials. */
  toolName?: ChildSpawnToolName;
  capabilitiesFor?: SubagentCapabilitiesFactory;
  clock?: ComputeClock;
  /** This sub-agent's own background compute region, when spawned in the
   * background: its dispatch pauses that instead of the shared clock, so the
   * parent's countdown is neither stopped by the child nor stolen by the parent. */
  computeRegion?: ComputeRegion;
  /** This sub-agent's own steer channel, fed by its parent's `agent_steer`. A
   * run-level steer still reaches only the entry agent. */
  steer?: SteerSource;
  workspaceRoot?: string;
  hooks?: LifecycleHook[];
  turnImages?: ImagePart[];
  logger?: Logger;
  emitCapabilityEvent?: CapabilityEventListener;
  /** Wire names the run's registered capabilities own, reserved against MCP in
   * the spawned sub-agent's own registry. */
  capabilityReserved?: readonly string[];
  /** Fleet-wide shared prompt snapshotted for this run. */
  sharedPrompt?: string;
}

/**
 * The lead-facing result of a child-spawn call: the `text` to return to the
 * lead, whether a sub-agent was actually `spawned`, the tracked `taskId` it was
 * tracked against (if any), and whether it `failed`.
 */
export interface SpawnResult {
  text: string;
  spawned: boolean;
  taskId?: string;
  failed?: boolean;
}

/**
 * The fully prepared spawn produced by {@link prepareSpawn}: the selected
 * profile, a fresh delegation instance id, the scoped tool registry, any
 * activated agent capabilities and their system sections, the built-in-toolset
 * flag, the (possibly exit-condition-augmented) task text, the tracked task id,
 * selected images, and any advisor messages to append to the result.
 */
export interface PreparedSpawn {
  selectedProfile: ResolvedSubagentProfile;
  subagentInstanceId: string;
  registry: NamespacedRegistry;
  agentCapabilities?: AgentCapability[];
  systemSections?: string[];
  hasBuiltinTools: boolean;
  subagentTask: string;
  taskId?: string;
  images?: ImagePart[];
  adviseMessages?: string[];
}

/**
 * The outcome of {@link prepareSpawn}: either the {@link PreparedSpawn} ready to
 * run, or a rejection carrying the lead-facing `text` (a validation error or a
 * hook denial).
 */
export type PrepareSpawnResult =
  { ok: false; text: string } | { ok: true; prepared: PreparedSpawn };

/**
 * Phase one of a delegation: validates the arguments, runs the pre-delegate
 * hooks, claims the tracked task, and assembles everything needed to run the
 * sub-agent — without yet running it.
 *
 * @param rawArgs - the model-supplied child-spawn arguments.
 * @param ctx - the delegation context; see {@link DelegateTaskContext}.
 * @returns a {@link PrepareSpawnResult} — the prepared spawn, or a rejection when
 *   validation fails or a workspace hook denies the spawn.
 * @remarks Reconciles the tracker first so `task_id` validation sees external edits.
 *   A `preDelegateTask` hook that throws fails closed (spawn denied); advisory
 *   hook messages are carried through to be appended to the sub-agent's result.
 *   On success it marks the tracked task spawned, records `delegation_created` on
 *   both the trace and the capability channel, scopes the tool registry to the
 *   profile, activates the profile's capabilities, and appends the tracked task's
 *   exit condition to the task text when present.
 *
 *   **A spawn's brief is not rewritable here, and a hook that tries is refused
 *   rather than ignored.** The sweep runs with `rewritable: false`, so a
 *   `rewrite` verdict denies the spawn instead of passing it through with the
 *   arguments the hook believes it replaced — the one outcome worse than either
 *   honouring or refusing, because the author is never told. The capability is
 *   not lost: both child-spawn tools are dispatched through the ordinary tool loop, so a
 *   `pre_tool_use` hook matching it replaces the brief and profile upstream of
 *   this validation, and the model is told what actually ran.
 */
export async function prepareSpawn(
  rawArgs: unknown,
  ctx: DelegateTaskContext,
): Promise<PrepareSpawnResult> {
  await ctx.tasks?.reconcile?.();
  const validated = validateDelegateTaskArgs(rawArgs, {
    ...(ctx.tasks ? { tasks: ctx.tasks } : {}),
    requireTaskId: ctx.requireTaskId ?? ctx.tasks !== undefined,
    profiles: ctx.profiles,
    ...(ctx.defaultProfile !== undefined ? { defaultProfile: ctx.defaultProfile } : {}),
    turnImageCount: ctx.turnImages?.length ?? 0,
  });
  const toolName = ctx.toolName ?? DELEGATE_TASK_TOOL_NAME;
  if (!validated.ok) {
    return { ok: false, text: `${toolName} error: ${validated.message}` };
  }

  const taskId = validated.task_id;
  const tracked = taskId !== undefined ? ctx.tasks?.getTask(taskId) : undefined;
  const exitCondition = tracked?.exit ?? tracked?.exit_condition;
  if (exitCondition && !parseDelegateTaskText(exitCondition).ok) {
    return {
      ok: false,
      text:
        `${toolName} error: task plus its tracked exit condition must fit within ` +
        `the ${String(DELEGATE_TASK_MAX_CHARS)}-character delegated-task limit; ` +
        "shorten the brief or exit condition",
    };
  }
  const subagentTask = exitCondition
    ? `${validated.task}\n\nExit condition: ${exitCondition}`
    : validated.task;
  const parsedSubagentTask = parseDelegateTaskText(subagentTask);
  if (!parsedSubagentTask.ok) {
    return {
      ok: false,
      text:
        `${toolName} error: task plus its tracked exit condition must fit within ` +
        `the ${String(DELEGATE_TASK_MAX_CHARS)}-character delegated-task limit; ` +
        "shorten the brief or exit condition",
    };
  }

  const sweep = await runVerdictHooks(
    ctx.hooks,
    (h) =>
      h.preDelegateTask
        ? (): Promise<GateVerdict> | GateVerdict =>
            h.preDelegateTask!({
              title: validated.title,
              task: validated.task,
              profile: validated.profile,
              ...(validated.task_id !== undefined ? { taskId: validated.task_id } : {}),
            })
        : undefined,
    {
      onThrow: "deny",
      onThrowWarn: "preDelegateTask hook threw; failing closed — spawn denied",
      logger: ctx.logger,
      logFields: { profile: validated.profile },
      timeoutMs: LIFECYCLE_GATE_HOOK_TIMEOUT_MS,
      rewritable: false,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    },
  );
  if (sweep.denied !== null) {
    return {
      ok: false,
      text: `${toolName} DENIED by a workspace hook: ${sweep.denied.message}`,
    };
  }
  const adviseMessages = sweep.advise;

  const selectedProfile = ctx.profiles.get(validated.profile)!;
  if (ctx.tasks && taskId !== undefined) {
    await ctx.tasks.markSpawned(taskId);
  }

  const subagentInstanceId = randomUUID();
  ctx.trace.record("delegation_created", {
    delegation_id: subagentInstanceId,
    title: validated.title,
    task: validated.task,
    tools: selectedProfile.tools,
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    profile: validated.profile,
  });
  ctx.emitCapabilityEvent?.(
    projected({
      capability: "delegation",
      kind: "delegation_created",
      detail: {
        delegation_id: subagentInstanceId,
        ...(taskId === undefined ? {} : { task_id: taskId }),
        title: validated.title,
        task: validated.task,
        profile: validated.profile,
        tools: selectedProfile.tools,
      },
    }),
  );

  const registry = buildRegistry(
    selectTools(ctx.opened, selectedProfile.tools),
    ctx.capabilityReserved ?? [],
  );
  const activation = ctx.capabilitiesFor?.(selectedProfile.grants);

  const images =
    validated.image_refs !== undefined && ctx.turnImages !== undefined
      ? validated.image_refs.map((i) => ctx.turnImages![i]!)
      : undefined;

  return {
    ok: true,
    prepared: {
      selectedProfile,
      subagentInstanceId,
      registry,
      ...(activation !== undefined && activation.capabilities.length > 0
        ? { agentCapabilities: activation.capabilities }
        : {}),
      ...(activation !== undefined && activation.systemSections.length > 0
        ? { systemSections: activation.systemSections }
        : {}),
      hasBuiltinTools: agentToolsActive(ctx.env, selectedProfile.grants),
      subagentTask: parsedSubagentTask.task,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(adviseMessages.length > 0 ? { adviseMessages } : {}),
    },
  };
}

/**
 * The per-run fields {@link buildRunSubagentInput} merges with a resolved profile
 * to form a {@link RunSubagentInput} — the task and images, identity, provider
 * handle, shared ledger, iteration cap, tracing, cancellation, capabilities, and
 * the usage sink.
 */
export interface SubagentRunContext {
  task: string;
  images?: ImagePart[];
  /** Fleet-wide shared prompt snapshotted for this run. */
  sharedPrompt?: string;
  subagentInstanceId: string;
  llm: LLMProvider;
  registry: NamespacedRegistry;
  ledger: TokenLedger;
  maxIterations: number;
  trace: TracePort;
  signal?: AbortSignal;
  agentCapabilities?: AgentCapability[];
  systemSections?: string[];
  hasBuiltinTools?: boolean;
  clock?: ComputeClock;
  /** This sub-agent's background compute region, when spawned in the background. */
  computeRegion?: ComputeRegion;
  /** This sub-agent's own steer channel, fed by its parent's `agent_steer`. */
  steer?: SteerSource;
  workspaceRoot?: string;
  hooks?: LifecycleHook[];
  usageSink?: SubagentUsageSnapshot;
}

/**
 * Combines a resolved profile with a {@link SubagentRunContext} into the flat
 * {@link RunSubagentInput} that {@link runSubagent} consumes.
 *
 * @param profile - the resolved profile supplying model, provider, prompt,
 *   compaction, reasoning, and retry settings.
 * @param base - the per-run context supplying task, images, budget, tracing, and
 *   capabilities.
 * @returns the merged run input, with profile-owned optional fields included
 *   only when the profile sets them.
 */
export function buildRunSubagentInput(
  profile: ResolvedSubagentProfile,
  base: SubagentRunContext,
): RunSubagentInput {
  return {
    task: base.task,
    images: base.images,
    ...(base.sharedPrompt !== undefined ? { sharedPrompt: base.sharedPrompt } : {}),
    basePrompt: profile.basePrompt,
    model: profile.model,
    provider: profile.provider,
    providerConfig: profile.providerConfig,
    capabilities: profile.capabilities,
    reasoningSummary: profile.reasoningSummary,
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: profile.reasoningEffort } : {}),
    callTimeoutMs: profile.callTimeoutMs,
    ...(profile.maxOutputTokens !== undefined ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    maxRetries: profile.maxRetries,
    maxRetryAfterMs: profile.maxRetryAfterMs,
    subagentInstanceId: base.subagentInstanceId,
    llm: base.llm,
    registry: base.registry,
    ledger: base.ledger,
    maxIterations: base.maxIterations,
    stagnationThreshold: profile.stagnationThreshold,
    trace: base.trace,
    signal: base.signal,
    compaction: profile.compaction,
    compactionPrompt: profile.compactionPrompt,
    agentCapabilities: base.agentCapabilities,
    systemSections: base.systemSections,
    hasBuiltinTools: base.hasBuiltinTools,
    clock: base.clock,
    ...(base.computeRegion !== undefined ? { computeRegion: base.computeRegion } : {}),
    ...(base.steer !== undefined ? { steer: base.steer } : {}),
    workspaceRoot: base.workspaceRoot,
    hooks: base.hooks,
    usageSink: base.usageSink,
  };
}

/**
 * Phase two of a delegation: runs the prepared sub-agent to completion and
 * reconciles its outcome with the tracker, usage accounting, hooks, and event
 * channels.
 *
 * @param prepared - the {@link PreparedSpawn} from {@link prepareSpawn}.
 * @param ctx - the delegation context; see {@link DelegateTaskContext}.
 * @returns the lead-facing {@link SpawnResult} (`spawned` is always true here),
 *   its `text` rendered by {@link mapOutcomeToText} and suffixed with any advisor
 *   messages.
 * @remarks Accumulates the sub-agent's usage by model on both the success and
 *   throw paths (a throw draws from the pre-seeded `usageSink`). When a tracked task
 *   is attached and the run was not cancelled, an `error` or `budget_exhausted`
 *   outcome — or a thrown error — marks the task failed; a cancellation never
 *   touches the tracker. Emits `delegation_started` before the run and
 *   `delegation_completed`/`delegation_failed` after, mirroring the trace.
 *
 *   **Every delegation event is published on both channels, and that is
 *   deliberate rather than an oversight.** The trace record is the durable one:
 *   it is what a rehydrated session replays, and what
 *   `engineEventToProto` turns into a typed `delegation_*` protocol event. The
 *   capability emission is live-only and reaches a client as a generic
 *   `capability_event`, because the kernel's `capabilityRunEventSchemas` has no
 *   delegation entry — deliberately, since giving it one would put the *same
 *   typed event* on the wire twice instead of once typed and once generic.
 *
 *   The pairing has to be maintained by hand, and it was incomplete: the
 *   `catch` path below emitted the capability event and recorded no trace
 *   event, so a sub-agent whose run threw left `delegation_created` and
 *   `delegation_started` in the persisted trace with nothing closing them —
 *   an unterminated span, and a restored session that showed the delegation
 *   still in flight forever. A trace record was added there; when adding a
 *   delegation outcome path, add both or the persisted record is the half that
 *   silently goes missing.
 */
export async function runPreparedSubagent(
  prepared: PreparedSpawn,
  ctx: DelegateTaskContext,
): Promise<SpawnResult> {
  const {
    selectedProfile,
    subagentInstanceId,
    registry,
    agentCapabilities,
    systemSections,
    hasBuiltinTools,
    subagentTask,
    taskId,
    images,
  } = prepared;
  const effectiveModelRef = selectedProfile.modelRef;
  const effectiveMaxIterations = resolveIterationCap(selectedProfile, ctx.iterationLimitDefault);
  const withAdvise = (text: string): string => {
    let t = text;
    for (const m of prepared.adviseMessages ?? []) t = `${t}\n\n[advisor] ${m}`;
    return t;
  };

  const usageSink: RunSubagentResult["usage"] = {
    input: 0,
    output: 0,
    cached: 0,
    cache_write: 0,
    iterations: 0,
  };
  let outcome: SubagentOutcome;
  let usage: RunSubagentResult["usage"];
  ctx.emitCapabilityEvent?.(
    projected({
      capability: "delegation",
      kind: "delegation_started",
      detail: {
        delegation_id: subagentInstanceId,
        ...(taskId === undefined ? {} : { task_id: taskId }),
        model: selectedProfile.modelRef,
      },
    }),
  );
  await fireObservers(
    ctx.hooks,
    "onSubagentStart",
    {
      subagentInstanceId,
      profile: selectedProfile.name,
      model: selectedProfile.modelRef,
      task: subagentTask,
    },
    ctx.logger,
  );
  try {
    ({ outcome, usage } = await runSubagent(
      buildRunSubagentInput(selectedProfile, {
        task: subagentTask,
        images,
        ...(ctx.sharedPrompt !== undefined ? { sharedPrompt: ctx.sharedPrompt } : {}),
        subagentInstanceId,
        llm: ctx.llm,
        registry,
        ledger: ctx.ledger,
        maxIterations: effectiveMaxIterations,
        trace: ctx.trace,
        signal: ctx.signal,
        agentCapabilities,
        systemSections,
        hasBuiltinTools,
        clock: ctx.clock,
        ...(ctx.computeRegion !== undefined ? { computeRegion: ctx.computeRegion } : {}),
        ...(ctx.steer !== undefined ? { steer: ctx.steer } : {}),
        workspaceRoot: ctx.workspaceRoot,
        hooks: ctx.hooks,
        usageSink,
      }),
    ));
  } catch (err) {
    accumulateSubagentUsage(ctx.subagentAggByModel, effectiveModelRef, usageSink);
    const aborted = ctx.signal?.aborted === true;
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.tasks && taskId !== undefined && !aborted) {
      await ctx.tasks.markFailed(taskId, `Sub-agent error: ${msg}`);
    }
    const text = aborted ? "Sub-agent cancelled." : `Sub-agent error: ${msg}`;
    await fireObservers(
      ctx.hooks,
      "onSubagentComplete",
      { subagentInstanceId, status: aborted ? "cancelled" : "error", result: text },
      ctx.logger,
    );
    ctx.trace.record("delegation_failed", {
      delegation_id: subagentInstanceId,
      ...(taskId === undefined ? {} : { task_id: taskId }),
      status: aborted ? "cancelled" : "error",
      result: text,
    });
    ctx.emitCapabilityEvent?.(
      projected({
        capability: "delegation",
        kind: "delegation_failed",
        detail: {
          delegation_id: subagentInstanceId,
          ...(taskId === undefined ? {} : { task_id: taskId }),
          status: aborted ? "cancelled" : "error",
        },
      }),
    );
    return {
      text: withAdvise(text),
      spawned: true,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(aborted ? {} : { failed: true }),
    };
  }

  accumulateSubagentUsage(ctx.subagentAggByModel, effectiveModelRef, usage);

  const resultText = mapOutcomeToText(outcome);
  ctx.trace.record(outcome.status === "completed" ? "delegation_completed" : "delegation_failed", {
    delegation_id: subagentInstanceId,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    status: outcome.status,
    result: resultText,
  });
  await fireObservers(
    ctx.hooks,
    "onSubagentComplete",
    { subagentInstanceId, status: outcome.status, result: resultText },
    ctx.logger,
  );

  const aborted = ctx.signal?.aborted === true;
  const outcomeFailed =
    !aborted && (outcome.status === "error" || outcome.status === "budget_exhausted");
  if (ctx.tasks && taskId !== undefined && !aborted) {
    const incompleteReason =
      outcome.status === "error"
        ? "failed"
        : outcome.status === "budget_exhausted"
          ? "budget_exhausted"
          : undefined;
    if (incompleteReason !== undefined) {
      await ctx.tasks.markFailed(taskId, resultText);
      ctx.emitCapabilityEvent?.(
        projected({
          capability: "delegation",
          kind: "delegation_failed",
          detail: {
            delegation_id: subagentInstanceId,
            task_id: taskId,
            status: outcome.status,
          },
        }),
      );
      return { text: withAdvise(resultText), spawned: true, taskId, failed: true };
    }
    // A completed child has handed work back but nothing has judged it yet.
    // Recording that hand-back is the tracker's job; closing the task is not —
    // only the parent may close it, through its own transition tool. Without
    // this the task went straight from `in_progress` to whatever the parent
    // decided next, and the documented intermediate state was never written.
    if (outcome.status === "completed") await ctx.tasks.markReturned?.(taskId, resultText);
  }

  ctx.emitCapabilityEvent?.(
    projected({
      capability: "delegation",
      kind:
        outcome.status === "completed" && !aborted ? "delegation_completed" : "delegation_failed",
      detail: {
        delegation_id: subagentInstanceId,
        ...(taskId === undefined ? {} : { task_id: taskId }),
        status: aborted ? "cancelled" : outcome.status,
      },
    }),
  );

  return {
    text: withAdvise(resultText),
    spawned: true,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(outcomeFailed ? { failed: true } : {}),
  };
}

/**
 * Renders a {@link SubagentOutcome} into the text returned to the lead — the
 * completed result verbatim, or a labelled partial/error summary for the
 * non-completed statuses.
 */
function mapOutcomeToText(outcome: SubagentOutcome): string {
  switch (outcome.status) {
    case "completed":
      return outcome.text;
    case "budget_exhausted":
      return `Sub-agent stopped early (budget_exhausted). Partial result: ${outcome.partialText}`;
    case "cancelled":
      return `Sub-agent cancelled. Partial result: ${outcome.partialText}`;
    case "error":
      return `Sub-agent error: code=${outcome.code}, message=${outcome.message}`;
  }
}
