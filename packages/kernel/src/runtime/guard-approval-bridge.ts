import { randomUUID } from "node:crypto";
import { z } from "zod";
import { analyzeShell, posixDialect } from "@clarvis/tools/guard";
import type { Elicit, GuardElicit } from "@clarvis/loop";
import type { GuardSessionAllowlist } from "../guard/guard-elicit.ts";
import { createGuardHumanApproval, type GuardHumanApproval } from "../guard/human-approval.ts";
import type { HostCapabilityGrant } from "./authority-brokers.ts";
import type { GuestExecutionBridge } from "./execution-worker.ts";

/** Run-bound human consent; the guest never owns or receives a reusable allowlist. */
export const RUNTIME_GUARD_APPROVAL_METHOD = "runtime.guard_approval";
const REVISION = "v1";
const requestSchema = z
  .object({
    operation: z.enum(["covers", "ask"]),
    tool: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()),
    reason: z.string().max(2_048).optional(),
    escalate: z.literal("human").optional(),
  })
  .strict();
const answerSchema = z.object({ allowed: z.boolean(), persisted: z.boolean() }).strict();

/** Recompute POSIX command facts on the host before consulting or extending its consent scope. */
export function createHostGuardApprovalGrant(options: {
  elicit?: Elicit;
  allowlist: () => GuardSessionAllowlist | undefined;
  workspaceRoot: string;
}): HostCapabilityGrant {
  return {
    method: RUNTIME_GUARD_APPROVAL_METHOD,
    revision: REVISION,
    idempotent: false,
    validateArguments: (value) => requestSchema.safeParse(value).success,
    async invoke(value, signal) {
      const input = requestSchema.parse(value);
      const command = input.args.command;
      const request: Parameters<GuardElicit>[0] = {
        tool: input.tool,
        args: input.args,
        reason: input.reason,
        escalate: input.escalate,
        ...((input.tool === "shell" || input.tool === "monitor_start") &&
        typeof command === "string"
          ? { shell: analyzeShell(command, posixDialect) }
          : {}),
      };
      const approval = createGuardHumanApproval({
        elicit: options.elicit ?? (async () => ({ action: "cancel" })),
        allowlist: options.allowlist,
        workspaceRoot: options.workspaceRoot,
        signal,
      });
      signal.throwIfAborted();
      return input.operation === "covers" ? approval.covers(request) : approval.ask(request);
    },
  };
}

/** Proxy every consent decision, including cache hits, through the current host authority. */
export function createGuestGuardApproval(
  bridge: GuestExecutionBridge,
  signal: AbortSignal,
): GuardHumanApproval {
  const call = (operation: "covers" | "ask", request: Parameters<GuardElicit>[0]) =>
    bridge.capability(
      randomUUID(),
      {
        method: RUNTIME_GUARD_APPROVAL_METHOD,
        revision: REVISION,
        arguments: {
          operation,
          tool: request.tool,
          args: request.args,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.escalate === undefined ? {} : { escalate: request.escalate }),
        },
      },
      signal,
    );
  return {
    async covers(request) {
      return z.boolean().parse(await call("covers", request));
    },
    async ask(request) {
      return answerSchema.parse(await call("ask", request));
    },
  };
}
