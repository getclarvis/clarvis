/**
 * The `agents` capability: the supervision surface over a parent's own children.
 *
 * It contributes four tools (`agent_list`, `agent_poll`, `agent_stop`,
 * `agent_steer`), the inbox that carries a settled child's result
 * back into the model's context without a poll, the progress accounting that
 * keeps a polling parent from looking productive, and the finish gate that stops
 * a run ending silently on top of live children.
 *
 * @remarks It attaches only to an *entry* agent, which is what makes "a parent
 * reaches its direct children only" structural: only an entry agent can spawn,
 * and a leader is a separate run with a registry of its own.
 */
import type { AgentResult } from "../loop/loop-shared.ts";
import type {
  AgentBuildContext,
  FinalizeGate,
  GateOutcome,
  HandlerVerdict,
  ToolHandler,
} from "../loop/loop-contract.ts";
import type { LLMToolCall, NamespacedTool } from "@clarvis/capability";
import type {
  AgentCapability,
  AgentLoopContribution,
  AgentScope,
  RunCapability,
} from "@clarvis/capability";
import type { AgentNotice, AgentRegistry } from "@clarvis/supervision";
import { AGENTS_CAPABILITY_NAME } from "@clarvis/supervision";
import {
  AGENT_LIST_TOOL,
  AGENT_POLL_TOOL,
  AGENT_STEER_TOOL,
  AGENT_STOP_TOOL,
  AGENT_SUPERVISION_WIRE_NAMES,
} from "../tools/wire-names.ts";

/** The four wire names, in the order they are advertised, re-exported from the
 * dep-free wire-name module that now owns them. */
export { AGENT_LIST_TOOL, AGENT_POLL_TOOL, AGENT_STOP_TOOL, AGENT_STEER_TOOL };

const TOOL_NAMES = new Set(AGENT_SUPERVISION_WIRE_NAMES);

/** The error code a run carries when it ended on top of live children. */
export const AGENTS_UNFINISHED_CODE = "agents_unfinished";

function tool(name: string, description: string, schema: Record<string, unknown>): NamespacedTool {
  return {
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    description,
    inputSchema: schema,
  };
}

/** Build the four tool declarations. */
function buildTools(): NamespacedTool[] {
  return [
    tool(
      AGENT_LIST_TOOL,
      "List the children you spawned that are still tracked: their handle, kind, status, " +
        "iterations, tokens, and whether one is parked on a question.",
      { type: "object", properties: {}, additionalProperties: false },
    ),
    tool(
      AGENT_POLL_TOOL,
      "Read a child's activity log: one line per iteration, tool call, result and assistant " +
        "turn. Page forward by passing back the previous next_offset. Use this to inspect " +
        "before deciding; settled children also report results through the inbox.",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "Child handle returned by spawning or agent_list." },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Resume point; pass the next_offset from your previous poll.",
          },
          match: {
            type: "string",
            description: "Optional regex; only matching lines are returned.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    ),
    tool(
      AGENT_STOP_TOOL,
      "Cancel one child you spawned and read back the tail of its log, so you can see what " +
        "you just ended. Its log stays readable afterwards.",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "Child handle returned by spawning or agent_list." },
          reason: { type: "string", description: "Why you are stopping it." },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    ),
    tool(
      AGENT_STEER_TOOL,
      "Send a mid-flight instruction to one child you spawned; it arrives at the top of that " +
        "child's next iteration. Use it to redirect a child rather than stopping and respawning.",
      {
        type: "object",
        properties: {
          id: { type: "string", description: "Child handle returned by spawning or agent_list." },
          message: { type: "string", description: "The instruction for that child." },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
    ),
  ];
}

/** A tool's successful textual answer, in the loop's standard result envelope. */
function result(name: string, body: unknown, progress: boolean): HandlerVerdict {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { kind: "result", text: `Tool '${name}' result: ${text}`, progress };
}

/**
 * A tool's failed textual answer, carrying the `(error)` marker that
 * distinguishes a refusal from {@link result} in the model-facing transcript —
 * the same `Tool '<name>' result (error): …` convention `@clarvis/capability`'s
 * `openCallEnvelope` uses for its `fail()`. A refusal never counts as progress.
 */
function errorResult(name: string, message: string): HandlerVerdict {
  return { kind: "result", text: `Tool '${name}' result (error): ${message}`, progress: false };
}

function argOf(call: { arguments: unknown }): Record<string, unknown> {
  return typeof call.arguments === "object" && call.arguments !== null
    ? (call.arguments as Record<string, unknown>)
    : {};
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Compile a caller-supplied `match`, refusing a bad pattern as a plain result. */
function compileMatch(
  raw: string | undefined,
): { ok: true; re?: RegExp } | { ok: false; why: string } {
  if (raw === undefined) return { ok: true };
  try {
    return { ok: true, re: new RegExp(raw) };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}

const unknownId = (name: string, id: string): HandlerVerdict =>
  errorResult(
    name,
    `unknown agent_id ${JSON.stringify(id)}; call agent_list for the ones you own.`,
  );

/**
 * Build the handler for all four tools.
 *
 * @remarks One handler rather than five: they share the id-resolution and
 * refusal shapes, and `foldContributions` would reject five handlers claiming
 * overlapping names anyway. Every verdict is a `result` — never `deferred` —
 * because a supervision call that deferred would be joined by the very dispatch
 * whose blocking this capability exists to remove.
 *
 * A refusal is {@link errorResult} (the `(error)` marker) exactly when the
 * call itself was malformed or targeted an id the caller never owned — a
 * missing argument, an invalid `match` regex, or an `unknown agent_id`.
 * `agent_steer`'s "already settled" refusal is deliberately **not** an error:
 * the id was valid and the call executed correctly, the target simply settled
 * before the steer arrived. That mirrors `agent_stop`'s own already-settled
 * outcome, which is a plain `result` two cases above, and a child-spawn tool's
 * capacity refusal in `delegation.ts`, which is likewise a plain result — a
 * state-driven decline is informational, not a failure, in both.
 */
function buildHandler(registry: AgentRegistry, bc: AgentBuildContext): ToolHandler {
  const handleCall = (call: LLMToolCall): HandlerVerdict => {
    const args = argOf(call);
    switch (call.name) {
      case AGENT_LIST_TOOL:
        return result(AGENT_LIST_TOOL, { agents: registry.list() }, false);

      case AGENT_POLL_TOOL: {
        const id = strArg(args, "id");
        if (id === undefined) return errorResult(AGENT_POLL_TOOL, "'id' is required.");
        const match = compileMatch(strArg(args, "match"));
        if (!match.ok) return errorResult(AGENT_POLL_TOOL, `invalid 'match' regex: ${match.why}`);
        const offset = typeof args.offset === "number" ? args.offset : undefined;
        const poll = registry.poll(id, {
          ...(offset !== undefined ? { offset } : {}),
          ...(match.re !== undefined ? { match: match.re } : {}),
        });
        if (poll === null) return unknownId(AGENT_POLL_TOOL, id);
        return result(AGENT_POLL_TOOL, poll, false);
      }

      case AGENT_STOP_TOOL: {
        const id = strArg(args, "id");
        const reason = strArg(args, "reason") ?? "no reason given";
        if (id === undefined) return errorResult(AGENT_STOP_TOOL, "'id' is required.");
        const stopped = registry.stop(id, reason);
        if (stopped === null) return unknownId(AGENT_STOP_TOOL, id);
        bc.trace.record("agent_stopped", {
          agent_id: id,
          reason,
          already_settled: stopped.already_settled,
        });
        return result(AGENT_STOP_TOOL, stopped, true);
      }

      case AGENT_STEER_TOOL: {
        const id = strArg(args, "id");
        const message = strArg(args, "message");
        if (id === undefined || message === undefined) {
          return errorResult(AGENT_STEER_TOOL, "'id' and 'message' are both required.");
        }
        const steered = registry.steer(id, { content: message });
        if (steered === null) return unknownId(AGENT_STEER_TOOL, id);
        bc.trace.record("agent_steered", { agent_id: id, message, delivered: steered.ok });
        if (!steered.ok) {
          return result(
            AGENT_STEER_TOOL,
            `${id} has already settled (${steered.status}); the steer was not delivered.`,
            false,
          );
        }
        return result(
          AGENT_STEER_TOOL,
          `delivered to ${id}; it arrives at the top of that child's next iteration.`,
          true,
        );
      }

      default:
        return errorResult(call.name, "unknown supervision tool.");
    }
  };
  return {
    matches: (call) => TOOL_NAMES.has(call.name),
    handle: (call) => Promise.resolve(handleCall(call)),
  };
}

/** The note the finish gate sends a model back with. */
function liveChildrenNote(rows: { id: string; title: string; status: string }[]): string {
  const listed = rows.map((r) => `${r.id} (${r.status}) — ${r.title}`).join("; ");
  return (
    `You still have ${String(rows.length)} child agent(s) running: ${listed}. ` +
    `Inspect outcomes with agent_poll. Use agent_stop only for work ` +
    `you intend to cancel, not to bypass this gate. Repeated finalization cancels live children; ` +
    `their existing workspace edits are not rolled back.`
  );
}

/**
 * Build the finish gate for D10.
 *
 * @remarks `fastAcceptOk` is not an optimization here, it is the gate's reach:
 * the loop accepts a lone `submit_result` without running any `check` when every
 * gate reports it would trivially pass, so a gate without it is dead code on the
 * most common finishing path of all.
 */
function buildFinishGate(
  registry: AgentRegistry,
  bc: AgentBuildContext,
  nudgeCap: number,
): FinalizeGate {
  let stall = 0;
  let lastLiveCount = Number.POSITIVE_INFINITY;
  return {
    fastAcceptOk: () => registry.liveCount() === 0,
    check(): Promise<GateOutcome> {
      const live = registry.list().filter((r) => r.status === "running" || r.status === "waiting");
      if (live.length === 0) return Promise.resolve({ kind: "pass" });
      const progressed = live.length < lastLiveCount;
      if (progressed) stall = 0;
      lastLiveCount = live.length;

      if (stall < nudgeCap) {
        stall += 1;
        bc.trace.record("agent_finish_nudge", {
          outcome: "nudged",
          live_agent_ids: live.map((r) => r.id),
          nudge_index: stall,
          progressed: progressed,
        });
        return Promise.resolve({ kind: "nudge", note: liveChildrenNote(live) });
      }

      registry.seal();
      const survivors = registry
        .list()
        .filter((r) => r.status === "running" || r.status === "waiting");
      for (const row of survivors) registry.stop(row.id, "the run finished without them");
      bc.trace.record("agent_finish_nudge", {
        outcome: "terminated",
        live_agent_ids: survivors.map((r) => r.id),
        nudge_index: stall,
        progressed: false,
      });
      bc.trace.record("terminate", { reason: AGENTS_UNFINISHED_CODE });
      const terminal: AgentResult = {
        status: "error",
        partialText: bc.state.lastAssistantText,
        error: {
          code: AGENTS_UNFINISHED_CODE,
          message:
            `Finished with ${String(survivors.length)} child agent(s) still running ` +
            `(${survivors.map((r) => r.id).join(", ")}); they were cancelled.`,
        },
      };
      return Promise.resolve({ kind: "terminal", result: terminal });
    },
  };
}

/**
 * Build the run-level `agents` capability over a live registry.
 *
 * @param registry - the run's registry, created alongside the run's semaphore.
 * @param nudgeCap - how many times finishing with live children is nudged.
 * @returns a {@link RunCapability} that attaches to the entry agent only.
 */
export function createAgentsRunCapability(
  registry: AgentRegistry,
  nudgeCap: number,
): RunCapability {
  const tools = buildTools();
  return {
    name: AGENTS_CAPABILITY_NAME,
    forAgent(scope: AgentScope): AgentCapability | null {
      if (!scope.entry) return null;
      return {
        attach(bc: AgentBuildContext): AgentLoopContribution {
          let drained: AgentNotice[] = [];
          return {
            tools,
            handlers: [buildHandler(registry, bc)],
            gates: [buildFinishGate(registry, bc, nudgeCap)],
            advertised: true,
            hooks: {
              beforeIteration: (): void => {
                drained = registry.takeNotices();
                for (const notice of drained) bc.ctx.appendNote(notice.text);
              },
              contributesProgress: (): boolean => drained.some((n) => n.progress),
              onTeardown: async (): Promise<void> => {
                const report = await registry.teardown(TEARDOWN_GRACE_MS);
                if (report.abandoned.length > 0) {
                  bc.warnings?.push(
                    `${String(report.abandoned.length)} child agent(s) abandoned when the run ` +
                      `finished: ${report.abandoned.join(", ")}`,
                  );
                }
                if (report.undrainedSteers > 0) {
                  bc.warnings?.push(
                    `${String(report.undrainedSteers)} steer message(s) to child agent(s) were ` +
                      `never delivered before the run finished.`,
                  );
                }
              },
            },
          };
        },
      };
    },
  };
}

/** How long teardown waits for a background child to unwind before abandoning it. */
const TEARDOWN_GRACE_MS = 5000;
