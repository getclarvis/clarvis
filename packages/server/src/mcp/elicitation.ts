import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { ElicitationRequest, ElicitationResponse, RunHandle } from "@clarvis/protocol";
import { observeServerTask } from "../tasks.ts";
import { scheduleSystemTimeout, type ScheduleTimeout } from "../timing.ts";

/**
 * How a run answers questions it raises.
 *
 * `relay` forwards them to a client that declared MCP's `elicitation`
 * capability; `tool` publishes them on the stream for `clarvis_respond`; and
 * `auto_decline` answers every one immediately.
 */
export type ElicitationPosture = "relay" | "tool" | "auto_decline";

/** The constraints a run actually ran under, reported back to the caller. */
export interface AppliedPosture {
  elicitation: ElicitationPosture;
  guard_confirmations: "relayed" | "denied";
  plans_effective?: "off" | "on" | "review";
  /**
   * The prompt-cache lifetime the facade pins for this run.
   *
   * @remarks Set to `"5m"` under `auto_decline`, where no elicitation ever
   *   blocks, so the run cannot pause long enough for the longer lifetime to
   *   repay its higher write price. Left absent otherwise, so the kernel derives
   *   it as usual.
   */
  prompt_cache_ttl?: "5m" | "1h";
  /** Human-readable notes for every request field the facade had to weaken. */
  downgrades: string[];
  /** Questions the facade answered on the caller's behalf. */
  auto_answered: number;
}

/** Inputs {@link resolvePosture} decides from. */
export interface ResolvePostureInput {
  /** Whether the connected client declared MCP's `elicitation` capability. */
  clientDeclaresElicitation: boolean;
  requested: "auto_decline" | "await";
  requestedPlans?: "off" | "on" | "review";
  /** Whether the container permits a remote caller to approve a guarded command. */
  allowRemoteGuardApproval: boolean;
  /**
   * Whether the caller's own role permits it; defaults to `true` for a
   * deployment with no authentication.
   *
   * @remarks Kept separate from {@link ResolvePostureInput.allowRemoteGuardApproval}
   * rather than folded into it, so the two are reported as the distinct reasons
   * they are: the container switch is the operator's ceiling, and the role is
   * this caller's share of it.
   */
  roleAllowsGuardApproval?: boolean;
}

/**
 * Decide how a run will answer questions, before it starts.
 *
 * @param input - client capability, caller preference and plan mode.
 * @returns the posture, with every applied downgrade recorded.
 * @remarks Under `auto_decline`, a requested `plans: "review"` is downgraded to
 *   `"on"`: an unanswered review gate does not merely skip approval, it
 *   *cancels* the run, which is a far worse outcome than not gating. That is the
 *   one request field the facade rewrites, and it says so in `downgrades`.
 *
 *   Guard confirmations default to `denied` regardless of posture. The container's
 *   guard exists to protect the container from the model; letting an
 *   unauthenticated remote caller approve arbitrary commands would remove the
 *   only thing it does.
 */
export function resolvePosture(input: ResolvePostureInput): AppliedPosture {
  const elicitation: ElicitationPosture = input.clientDeclaresElicitation
    ? "relay"
    : input.requested === "await"
      ? "tool"
      : "auto_decline";

  const downgrades: string[] = [];
  if (input.requested === "await" && input.clientDeclaresElicitation) {
    downgrades.push("elicitations:await→relay (client declares the elicitation capability)");
  }

  const roleAllowsGuardApproval = input.roleAllowsGuardApproval ?? true;
  const guard_confirmations =
    input.allowRemoteGuardApproval && roleAllowsGuardApproval && elicitation !== "auto_decline"
      ? "relayed"
      : "denied";
  if (guard_confirmations === "denied" && input.allowRemoteGuardApproval) {
    downgrades.push(
      roleAllowsGuardApproval
        ? "guard approvals denied (no channel to ask on)"
        : "guard approvals denied (this role may not approve guarded commands)",
    );
  }

  let plans_effective = input.requestedPlans;
  if (elicitation === "auto_decline" && plans_effective === "review") {
    plans_effective = "on";
    downgrades.push("plans:review→on (an unanswered review gate cancels the run)");
  }

  if (elicitation === "auto_decline") {
    downgrades.push("prompt_cache_ttl pinned to 5m (no elicitation can pause this run)");
  }

  return {
    elicitation,
    guard_confirmations,
    ...(plans_effective !== undefined ? { plans_effective } : {}),
    ...(elicitation === "auto_decline" ? { prompt_cache_ttl: "5m" as const } : {}),
    downgrades,
    auto_answered: 0,
  };
}

/** Sends a server→client request on the caller's own stream. */
export type SendElicitRequest = (
  request: { message: string; requestedSchema: Record<string, unknown> },
  signal: AbortSignal | undefined,
  timeoutMs: number,
) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;

/** Owns a run's single `onElicit` handler and the pending map behind it. */
export interface ElicitationController {
  /** Install the handler. Called once, before the run can ask anything. */
  attach(handle: RunHandle): void;
  /** Answer a pending question from `clarvis_respond`. */
  respond(response: ElicitationResponse): { accepted: boolean; note?: string };
  /** Clear timers and decline anything still outstanding. */
  dispose(): void;
}

/** Configuration for {@link createElicitationController}. */
export interface ElicitationControllerOptions {
  posture: AppliedPosture;
  /** Publishes the question on the run's stream so a caller can see it. */
  publish: (request: ElicitationRequest) => void;
  /** Present only in `relay` posture. */
  sendRequest?: SendElicitRequest;
  signal?: AbortSignal;
  /** How long `tool` posture holds a question before declining it. */
  toolWaitMs: number;
  /** How long `relay` posture waits on the client. */
  relayWaitMs: number;
  /** Internal deterministic-test seam; production uses the host timer API. */
  scheduleTimeout?: ScheduleTimeout;
  /** The run-bound diagnostic channel; already carries `execution_id`. */
  logger?: Logger;
}

/**
 * Record how one question a run raised was answered.
 *
 * @param logger - the run-bound diagnostic channel.
 * @param posture - the resolved posture, which decided who could answer.
 * @param action - the answer the run received.
 * @param auto - whether the facade answered on the caller's behalf.
 * @remarks The question's own text is model- and engine-authored prose and is
 * never a field; the trace already carries it for the user.
 */
function reportAnswered(
  logger: Logger,
  posture: ElicitationPosture,
  action: string,
  auto: boolean,
): void {
  logger.debug(
    { event: "elicit.answered", posture, action, auto },
    "a question the run raised was answered; an auto answer is a decline, which the run continues past",
  );
}

/**
 * Build the controller that answers everything a run asks.
 *
 * @param opts - posture, publication channel and wait bounds.
 * @returns the controller; `attach` it before the run's first iteration.
 * @remarks This is what keeps a headless run from stalling. Answering through
 *   `RunHandle.respond` short-circuits *every* ask site at once — `ask_user`
 *   continues with a declined answer, a guard confirmation resolves to denied, a
 *   soft budget breach stops with the partial result (exactly what
 *   `on_exceed: "stop"` would have done), and a relayed MCP-server question
 *   declines. Without it, a client that cannot answer does not fail fast: the run
 *   parks on each question for the engine's elicit wait bound.
 *
 *   Registration is race-free because the kernel's bridge replays every
 *   still-pending question to a handler that attaches late.
 */
export function createElicitationController(
  opts: ElicitationControllerOptions,
): ElicitationController {
  const pending = new Map<string, { cancelTimeout: () => void }>();
  const logger = opts.logger ?? NOOP_LOGGER;
  let handle: RunHandle | undefined;
  let disposed = false;

  const answer = (id: string, action: "decline" | "cancel"): void => {
    const entry = pending.get(id);
    if (entry !== undefined) {
      entry.cancelTimeout();
      pending.delete(id);
    }
    observeServerTask("server_automatic_elicitation_response", () =>
      handle?.respond({ id, action }),
    );
  };

  const autoDecline = (id: string): void => {
    opts.posture.auto_answered += 1;
    reportAnswered(logger, opts.posture.elicitation, "decline", true);
    answer(id, "decline");
  };

  return {
    attach(runHandle): void {
      handle = runHandle;
      runHandle.onElicit((request) => {
        if (disposed) {
          autoDecline(request.id);
          return;
        }
        opts.publish(request);

        if (request.kind === "guard_confirm" && opts.posture.guard_confirmations === "denied") {
          autoDecline(request.id);
          return;
        }

        if (opts.posture.elicitation === "auto_decline") {
          autoDecline(request.id);
          return;
        }

        if (opts.posture.elicitation === "relay" && opts.sendRequest !== undefined) {
          const sendRequest = opts.sendRequest;
          observeServerTask("server_relayed_elicitation_response", async () => {
            try {
              const answered = await sendRequest(
                {
                  message: request.prompt,
                  requestedSchema: request.schema ?? { type: "object", properties: {} },
                },
                opts.signal,
                opts.relayWaitMs,
              );
              reportAnswered(logger, opts.posture.elicitation, answered.action, false);
              await runHandle.respond({
                id: request.id,
                action: answered.action,
                ...(answered.content !== undefined ? { content: answered.content } : {}),
              });
            } catch {
              autoDecline(request.id);
            }
          });
          return;
        }

        const cancelTimeout = (opts.scheduleTimeout ?? scheduleSystemTimeout)(
          () => autoDecline(request.id),
          opts.toolWaitMs,
        );
        pending.set(request.id, { cancelTimeout });
      });
    },

    respond(response): { accepted: boolean; note?: string } {
      if (opts.posture.elicitation !== "tool") {
        return {
          accepted: false,
          note: `this run answers questions itself (posture=${opts.posture.elicitation})`,
        };
      }
      const entry = pending.get(response.id);
      if (entry === undefined) {
        return { accepted: false, note: "no pending question with that id" };
      }
      entry.cancelTimeout();
      pending.delete(response.id);
      reportAnswered(logger, opts.posture.elicitation, response.action, false);
      observeServerTask("server_tool_elicitation_response", () => handle?.respond(response));
      return { accepted: true };
    },

    dispose(): void {
      disposed = true;
      for (const id of [...pending.keys()]) autoDecline(id);
    },
  };
}
