import type { LLMToolCall, TracePort } from "@clarvis/capability";
import type { AgentRole, ToolArgValidate } from "@clarvis/capability";
import { openCallEnvelope } from "@clarvis/capability";
import {
  askUserTool,
  mapOutcomeToText,
  ASK_USER_TOOL_NAME,
  type AskUser,
  type AskUserArgs,
} from "./ask-user-tool.ts";

/**
 * The result of dispatching one `ask_user` call: either a `result` carrying the
 * model-facing text (with `error` set when the exchange failed) or `cancelled`
 * when the run was aborted mid-question.
 *
 * @remarks A `cancelled` outcome carries no text because the run is unwinding;
 *   the caller stops rather than feeding a tool result back to the model.
 */
export type AskUserCallOutcome =
  { kind: "result"; text: string; error?: boolean } | { kind: "cancelled" };

/**
 * Execute a single `ask_user` tool call end to end: validate the arguments,
 * record the elicitation/answer trace events, invoke the {@link AskUser} port,
 * and wrap the outcome as a model-facing tool result.
 *
 * @param args.call - the raw tool call whose `arguments` carry `question` and
 *   optional `options`.
 * @param args.askUser - the port that surfaces the question to the human and
 *   resolves with their {@link ElicitationOutcome}.
 * @param args.trace - trace sink for the `tool_call`, `elicitation_requested`
 *   and `user_question` events.
 * @param args.agent - the asking agent's role, stamped on every trace event.
 * @param args.subagentInstanceId - present when a sub-agent asks, so the trace
 *   attributes the question to that instance.
 * @param args.iteration - the loop iteration that issued the call.
 * @param args.signal - abort signal; when it fires during the wait the call
 *   resolves `cancelled` rather than surfacing an error to the model.
 * @returns a `result` outcome (the mapped answer or an error note) or
 *   `cancelled` if the run aborted while waiting.
 * @remarks Invalid arguments and unreachable-user failures both resolve to an
 *   `error` result via {@link openCallEnvelope}'s `fail`, never a throw. The
 *   answer text is produced by {@link mapOutcomeToText}.
 */
export async function handleAskUserCall(args: {
  call: LLMToolCall;
  askUser: AskUser;
  trace: TracePort;
  agent: AgentRole;
  subagentInstanceId?: string;
  iteration: number;
  signal?: AbortSignal;
  validateArgs?: ToolArgValidate;
}): Promise<AskUserCallOutcome> {
  const { call, askUser, trace, agent, subagentInstanceId, iteration, signal } = args;
  const envelope = openCallEnvelope({
    call,
    name: ASK_USER_TOOL_NAME,
    trace,
    agent,
    ...(subagentInstanceId !== undefined ? { subagentInstanceId } : {}),
    iteration,
    schema: askUserTool.inputSchema,
    ...(args.validateArgs !== undefined ? { validate: args.validateArgs } : {}),
  });
  if (envelope.invalid !== null) {
    return { kind: "result", text: envelope.fail(envelope.invalid), error: true };
  }
  const { question, options } = call.arguments as AskUserArgs;
  const askArgs: AskUserArgs = { question, ...(options ? { options } : {}) };
  envelope.start();
  trace.record("elicitation_requested", {
    agent,
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration_ref: iteration,
    source: "ask_user",
    question: askArgs.question,
    ...(options ? { options } : {}),
  });
  let outcome;
  try {
    outcome = await askUser(askArgs);
  } catch (err) {
    if (signal?.aborted) {
      envelope.fail("cancelled");
      return { kind: "cancelled" };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "result",
      text: envelope.fail(`could not reach the user (${reason}).`),
      error: true,
    };
  }
  trace.record("user_question", {
    agent,
    ...(subagentInstanceId !== undefined ? { subagent_instance_id: subagentInstanceId } : {}),
    iteration_ref: iteration,
    question: askArgs.question,
    outcome: outcome.action,
    ...(outcome.answer !== undefined ? { answer: outcome.answer } : {}),
    ...(options ? { options } : {}),
  });
  return { kind: "result", text: envelope.ok(mapOutcomeToText(outcome)) };
}
