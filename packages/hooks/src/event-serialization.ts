/** Model-facing hook contexts projected onto the stable shell-hook payload. */
import type {
  AfterToolUseContext,
  BeforeToolUseContext,
  BudgetExhaustedContext,
  HookConfig,
  ModelCallErrorContext,
  PreCompactContext,
  PreDelegateTaskContext,
  PreFinalizeContext,
  RunEndContext,
  RunStartContext,
  SubagentCompleteContext,
  UserSteerContext,
} from "@clarvis/capability";
import {
  CONTEXT_HOOK_EVENTS,
  GATE_HOOK_EVENTS,
  HOOK_DEFAULT_TIMEOUT_MS,
  EXTERNAL_HOOK_EVENT_NAMES,
} from "@clarvis/capability";
import type { HookInvocation } from "./types.ts";

export type HookEvent = HookConfig["event"];

const GATE_EVENTS = new Set<string>(GATE_HOOK_EVENTS);
const CONTEXT_EVENTS = new Set<string>(CONTEXT_HOOK_EVENTS);
const TOOL_EVENTS = new Set<string>(["pre_tool_use", "post_tool_use"]);

/**
 * The one fire point whose arguments a hook may replace.
 *
 * @remarks Narrower than {@link TOOL_EVENTS} on purpose: `post_tool_use` fires
 * after the call has already run, so replacement arguments there would name a
 * decision nothing can still act on.
 */
const REWRITABLE_EVENTS = new Set<string>(["pre_tool_use"]);

function defaultTimeoutFor(event: HookEvent): number {
  if (TOOL_EVENTS.has(event)) return HOOK_DEFAULT_TIMEOUT_MS.tool;
  if (GATE_EVENTS.has(event)) return HOOK_DEFAULT_TIMEOUT_MS.gate;
  if (event === "run_end") return HOOK_DEFAULT_TIMEOUT_MS.run_end;
  if (CONTEXT_EVENTS.has(event)) return HOOK_DEFAULT_TIMEOUT_MS.context;
  return HOOK_DEFAULT_TIMEOUT_MS.observer;
}

/** Longest free text sent to a hook for one field. */
const TEXT_CLAMP = 8_000;
/** Longest JSON-serialized structured value sent to a hook for one field. */
const VALUE_CLAMP = 32_000;

function clampText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= TEXT_CLAMP ? value : value.slice(0, TEXT_CLAMP);
}

/** Bound an arbitrary structured argument before it is sent to a hook. */
function clampValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return { truncated: true };
  }
  return text.length <= VALUE_CLAMP ? value : { truncated: true, bytes: text.length };
}

type HookContextByEvent = {
  pre_tool_use: BeforeToolUseContext;
  post_tool_use: AfterToolUseContext;
  pre_finalize: PreFinalizeContext;
  pre_delegate_task: PreDelegateTaskContext;
  run_start: RunStartContext;
  run_end: RunEndContext;
  subagent_complete: SubagentCompleteContext;
  pre_compact: PreCompactContext;
  model_call_error: ModelCallErrorContext;
  budget_exhausted: BudgetExhaustedContext;
  user_steer: UserSteerContext;
  session_start: undefined;
};

/**
 * Total serializer table over `HookConfig["event"]`: a new schema event cannot
 * compile until its shell payload is deliberately defined here.
 *
 * @remarks
 * Each entry returns the event's fields **flat**, exactly as they appear on the
 * hook's stdin — there is no envelope key they nest under. Where the hooks
 * dialect written outside Clarvis names the same thing, that name is used:
 * `tool_name`, `tool_input` and `tool_response` are the triple it documents
 * identically for the two tool events, so a hook authored elsewhere reads them
 * without translation. Every other field keeps its Clarvis name, because
 * renaming one onto a foreign field that merely resembles it would publish a
 * guess as a contract. The dialect labels its own extra fields as extensions;
 * ours are the same thing seen from this side.
 */
const SERIALIZE = {
  pre_tool_use: (c: BeforeToolUseContext) => ({
    tool_name: c.tool,
    tool_input: clampValue(c.arguments),
  }),
  post_tool_use: (c: AfterToolUseContext) => ({
    tool_name: c.tool,
    tool_input: clampValue(c.arguments),
    tool_response: {
      text: clampText(c.result.text),
      progress: c.result.progress,
      task_id: c.result.taskId,
      image_count: c.result.images?.length ?? 0,
    },
  }),
  pre_finalize: (c: PreFinalizeContext) => ({
    agent: c.agent,
    subagent_instance_id: c.subagentInstanceId,
    mode: c.mode,
    text: clampText(c.text),
    value: clampValue(c.value),
  }),
  pre_delegate_task: (c: PreDelegateTaskContext) => ({
    title: c.title,
    task: clampText(c.task),
    profile: c.profile,
    task_id: c.taskId,
  }),
  run_start: (c: RunStartContext) => ({
    mode: c.mode,
    entry: c.entry,
    lead_model: c.leadModel,
    subagent_model: c.subagentModel,
  }),
  run_end: (c: RunEndContext) => ({
    status: c.status,
    error_code: c.errorCode,
    iterations_used: c.iterationsUsed,
    elapsed_ms: c.elapsedMs,
  }),
  subagent_complete: (c: SubagentCompleteContext) => ({
    subagent_instance_id: c.subagentInstanceId,
    status: c.status,
    result: clampText(c.result),
  }),
  pre_compact: (c: PreCompactContext) => ({
    agent: c.agent,
    subagent_instance_id: c.subagentInstanceId,
    estimated_tokens: c.estimatedTokens,
  }),
  model_call_error: (c: ModelCallErrorContext) => ({
    agent: c.agent,
    subagent_instance_id: c.subagentInstanceId,
    iteration: c.iteration,
    model: c.model,
    message: clampText(c.message),
  }),
  budget_exhausted: (c: BudgetExhaustedContext) => ({
    agent: c.agent,
    reason: c.reason,
    tokens_used: c.tokensUsed,
    iterations_used: c.iterationsUsed,
  }),
  user_steer: (c: UserSteerContext) => ({
    agent: c.agent,
    subagent_instance_id: c.subagentInstanceId,
    iteration: c.iteration,
    message: clampText(c.message),
    id: c.id,
  }),
  session_start: () => ({}),
} satisfies { [Event in HookEvent]: (context: HookContextByEvent[Event]) => unknown };

function toolCandidate(event: HookEvent, context: unknown): HookInvocation["candidate"] {
  if (!TOOL_EVENTS.has(event)) return undefined;
  const candidate = context as BeforeToolUseContext;
  return { tool: candidate.tool, arguments: candidate.arguments };
}

/** Project one lifecycle fire point into the bounded hook subprocess envelope. */
export function hookInvocationFor(event: HookEvent, context: unknown): HookInvocation {
  const candidate = toolCandidate(event, context);
  return {
    event,
    data: SERIALIZE[event](context as never),
    ...(candidate !== undefined ? { candidate } : {}),
    defaultTimeoutMs: defaultTimeoutFor(event),
    gate: GATE_EVENTS.has(event),
    rewritable: REWRITABLE_EVENTS.has(event),
    ...(EXTERNAL_HOOK_EVENT_NAMES[event] !== undefined
      ? { externalEvent: EXTERNAL_HOOK_EVENT_NAMES[event] }
      : {}),
  };
}
