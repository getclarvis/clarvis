/**
 * The ask_user tool packaged as a capability: run-level gating on the entry
 * profile's 'ask_user' grant, entry-agent-only activation (spawned subagents
 * never ask the human directly), and the elicit-backed tool + handler.
 *
 * The elicit relay itself stays core (it is shared with the soft-budget ask and
 * with every capability that reaches the human); this capability receives the
 * already-serialized elicit through AgentScope.
 */
import type { AgentCapability, Capability, RunCapability } from "@clarvis/capability";
import { handlerBaseOf, type HandlerBase } from "@clarvis/capability";
import type { ToolHandler, HandlerVerdict } from "../loop/loop-contract.ts";
import { handleAskUserCall } from "../tools/ask-user-call.ts";
import {
  ASK_USER_TOOL_NAME,
  askUserTool,
  buildAskUser,
  type AskUser,
} from "../tools/ask-user-tool.ts";

/** Registry name of the ask-user capability. */
export const ASK_USER_CAPABILITY_NAME = "ask-user";

/**
 * Build the ask-user capability: gated on the entry profile's `ask_user` grant
 * at run level, and active only for the run's entry agent.
 *
 * @returns A {@link Capability} whose `forRun` returns null unless the entry
 *   profile carries the `ask_user` grant; its `forAgent` returns null for any
 *   non-entry (spawned) agent or when the scope lacks a serialized `elicit` /
 *   `clock`, so only the entry agent ever asks the human directly.
 * @remarks The per-run elicit wait is taken from the request's
 *   `elicit_wait_ms`, falling back to `CLARVIS_DEFAULT_ELICIT_WAIT_MS`.
 */
export function createAskUserCapability(): Capability {
  return {
    name: ASK_USER_CAPABILITY_NAME,
    forRun(ctx): RunCapability | null {
      if (!ctx.entryGrants.includes("ask_user")) return null;
      const elicitWaitMs = ctx.request.elicit_wait_ms ?? ctx.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS;
      return {
        name: ASK_USER_CAPABILITY_NAME,
        forAgent(scope): AgentCapability | null {
          if (!scope.entry) return null;
          if (scope.elicit === undefined || scope.clock === undefined) return null;
          const askUser = buildAskUser(scope.elicit, scope.clock, scope.signal, elicitWaitMs);
          return askUserAgentCapability(askUser);
        },
      };
    },
  };
}

/**
 * The per-agent attachment alone, for callers that already hold an
 * {@link AskUser} (bypassing the run-level grant/entry gate).
 *
 * @param askUser - The bound elicit-backed asker the handler relays to.
 * @returns An {@link AgentCapability} contributing the `ask_user` tool and its
 *   handler; the tool is `advertised: false` (prompt-driven, not registry-listed).
 */
export function askUserAgentCapability(askUser: AskUser): AgentCapability {
  return {
    attach(bc) {
      return {
        tools: [askUserTool],
        handlers: [buildAskUserHandler({ base: handlerBaseOf(bc), askUser })],
        advertised: false,
      };
    },
  };
}

/**
 * The `ask_user` tool handler: relays a call to {@link handleAskUserCall} and
 * maps its outcome onto a {@link HandlerVerdict}.
 *
 * @returns A cancelled verdict when the ask was cancelled; otherwise a result
 *   whose `progress` is true unless the outcome carried an error.
 */
function buildAskUserHandler(deps: { base: HandlerBase; askUser: AskUser }): ToolHandler {
  const { base } = deps;
  return {
    matches: (call) => call.name === ASK_USER_TOOL_NAME,
    async handle(call, iteration): Promise<HandlerVerdict> {
      const oc = await handleAskUserCall({
        call,
        askUser: deps.askUser,
        trace: base.trace,
        agent: base.agent,
        ...(base.subagentInstanceId !== undefined
          ? { subagentInstanceId: base.subagentInstanceId }
          : {}),
        iteration,
        ...(base.signal ? { signal: base.signal } : {}),
        ...(base.validateArgs !== undefined ? { validateArgs: base.validateArgs } : {}),
      });
      if (oc.kind === "cancelled") return { kind: "cancelled" };
      return { kind: "result", text: oc.text, progress: oc.error !== true };
    },
  };
}
