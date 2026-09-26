import { randomUUID } from "node:crypto";
import type { ActionAuthorizationPort, LLMToolCall } from "@clarvis/capability";

/** Admit one final, hook-rewritten call through the run's host-owned service. */
export async function authorizeAction(
  port: ActionAuthorizationPort | undefined,
  call: LLMToolCall,
  tool: string,
  actor: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!port) return null;
  if (
    call.malformedArguments !== undefined ||
    typeof call.arguments !== "object" ||
    call.arguments === null ||
    Array.isArray(call.arguments)
  )
    return "invalid tool arguments";
  let request = {
    identity: {
      ...port.identity,
      actor,
      callId: call.id && call.id.length > 0 ? call.id : randomUUID(),
      attempt: 1,
    },
    tool,
    arguments: structuredClone(call.arguments as Record<string, unknown>),
    requestedProfile: "host" as const,
    effectiveProfile: "host" as const,
    reason: "external tool call",
    policyRevision: port.policyRevision,
    authorizationRevision: port.revision(),
  };
  let decision: Awaited<ReturnType<typeof port.authorize>> | undefined;
  for (let review = 0; review < 3; review++) {
    try {
      decision = await port.authorize(request, signal);
    } catch (error) {
      if (signal?.aborted || port.revision() === request.authorizationRevision || review === 2)
        throw error;
      request = {
        ...request,
        policyRevision: port.policyRevision,
        authorizationRevision: port.revision(),
      };
      continue;
    }
    if (port.revision() !== request.authorizationRevision && !signal?.aborted && review < 2) {
      request = {
        ...request,
        policyRevision: port.policyRevision,
        authorizationRevision: port.revision(),
      };
      continue;
    }
    break;
  }
  if (!decision) return "Action denied: review unavailable";
  return decision.granted && port.valid(request, decision) && !signal?.aborted
    ? null
    : `Action denied: ${decision.evidence.reason}`;
}
