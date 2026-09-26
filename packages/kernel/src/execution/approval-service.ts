import { createHash } from "node:crypto";
import type {
  ActionAuthorizationDecision,
  ActionAuthorizationPort,
  ActionAuthorizationRequest,
} from "@clarvis/capability";
import type { Elicit } from "@clarvis/capability";
import type { TracePort } from "@clarvis/capability";
import {
  analyzeShell,
  canSuggestRememberedAllow,
  evaluateCommand,
  type ApprovalPolicy,
  type RuleSource,
} from "@clarvis/execpolicy";
import { canRequestApproval } from "@clarvis/execpolicy";
import {
  DenialCircuitBreaker,
  type AuthorizationEvidence,
  type ReviewResult,
} from "@clarvis/judge";

/** Host-owned manual decision service for one execution snapshot. */
export function createApprovalService(options: {
  readonly owner: string;
  readonly executionId: string;
  readonly policy: ApprovalPolicy;
  readonly sources: readonly RuleSource[];
  readonly elicit?: Elicit;
  readonly revision: () => number;
  readonly backendAvailable: boolean;
  readonly policyRevision: string | (() => string);
  readonly denyRead: boolean;
  readonly trace?: TracePort;
  readonly mode?: "manual" | "auto" | (() => "manual" | "auto");
  readonly judge?: {
    review(
      input: {
        action: ActionAuthorizationRequest;
        evidence: readonly AuthorizationEvidence[];
        profile: string;
      },
      signal?: AbortSignal,
    ): Promise<ReviewResult>;
  };
  readonly authorizationEvidence?: (
    request: ActionAuthorizationRequest,
  ) => readonly AuthorizationEvidence[];
  readonly onJudgeDenied?: (request: ActionAuthorizationRequest, reason: string) => void;
  readonly onJudgeReviewed?: (request: ActionAuthorizationRequest) => void;
  readonly fallback?: "manual_on_context_overflow" | "disabled";
  readonly judgeRequired?: boolean;
  readonly strictReview?: boolean;
  readonly rememberPrefix?: (
    request: ActionAuthorizationRequest,
    prefix: readonly string[],
  ) => Promise<boolean>;
}): ActionAuthorizationPort {
  const breaker = new DenialCircuitBreaker();
  const currentPolicyRevision = () =>
    typeof options.policyRevision === "function"
      ? options.policyRevision()
      : options.policyRevision;
  const currentMode = () => (typeof options.mode === "function" ? options.mode() : options.mode);
  const fingerprint = (request: ActionAuthorizationRequest): string =>
    createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const identityValid = (request: ActionAuthorizationRequest): boolean =>
    request.identity.owner === options.owner &&
    request.identity.executionId === options.executionId &&
    request.policyRevision === currentPolicyRevision() &&
    request.authorizationRevision === options.revision();
  return {
    identity: { owner: options.owner, executionId: options.executionId },
    mayRelayMcpElicitation: canRequestApproval(options.policy, "mcp_elicitations"),
    get policyRevision() {
      return currentPolicyRevision();
    },
    revision: options.revision,
    stopReason: () => (breaker.open ? "execution review denial limit reached" : undefined),
    valid(request, decision) {
      return identityValid(request) && decision.fingerprint === fingerprint(request);
    },
    recordAttempt(request, phase, backend, effectiveProfile) {
      options.trace?.record("execution_attempt", {
        owner: request.identity.owner,
        execution_id: request.identity.executionId,
        actor: request.identity.actor,
        call_id: request.identity.callId,
        attempt: request.identity.attempt,
        tool: request.tool,
        reason: request.reason,
        requested_mode: request.requestedProfile,
        effective_mode: effectiveProfile ?? request.effectiveProfile,
        phase,
        ...(backend ? { backend } : {}),
      });
    },
    async authorize(request, signal): Promise<ActionAuthorizationDecision> {
      if (!identityValid(request)) throw new Error("action authority changed before review");
      if (breaker.open)
        return {
          granted: false,
          fingerprint: fingerprint(request),
          evidence: {
            decision: "prompt",
            source: "host",
            reason: "review_circuit_open",
            requestedProfile: request.requestedProfile,
            effectiveProfile: request.effectiveProfile,
            executionStarted: false,
          },
        };
      const evaluation =
        request.command === undefined
          ? { decision: "allow" as const, reason: "ordinary_tool", matches: [] }
          : evaluateCommand({
              command: request.command,
              sources: options.sources,
              approval_policy: options.policy,
              backend_available: options.backendAvailable,
              restricted: request.effectiveProfile === "sandbox",
              override_requested: false,
              cwd: request.cwd ?? ".",
              path: request.environment?.PATH,
            });
      const requestedProfile = request.requestedProfile;
      let effectiveProfile = request.effectiveProfile;
      let granted = evaluation.decision === "allow";
      let reason = evaluation.reason;
      let source: "rule" | "fallback" | "heuristic" | "host" | "reviewer" =
        "segments" in evaluation ? (evaluation.segments[0]?.origin ?? "fallback") : "host";
      let judgeAssessment: "allow" | "deny" | undefined;
      let route: "judge" | "manual" | undefined;
      const base = {
        owner: request.identity.owner,
        execution_id: request.identity.executionId,
        actor: request.identity.actor,
        call_id: request.identity.callId,
        attempt: request.identity.attempt,
        tool: request.tool,
        requested_mode: requestedProfile,
        effective_mode: effectiveProfile,
      };
      const permissionDelta =
        request.permissions?.host === true ||
        request.permissions?.network === "enabled" ||
        !!request.permissions?.writeRoots?.length ||
        !!request.permissions?.readRoots?.length;
      let needsReview =
        evaluation.decision === "prompt" ||
        (evaluation.decision !== "forbidden" &&
          permissionDelta &&
          request.effectiveProfile === "sandbox");
      if (options.strictReview && evaluation.decision !== "forbidden") needsReview = true;
      if (
        currentMode() === "auto" &&
        request.effectiveProfile === "host" &&
        !options.strictReview &&
        !options.judgeRequired &&
        evaluation.decision !== "forbidden" &&
        source !== "rule" &&
        !options.denyRead
      ) {
        needsReview = false;
        granted = true;
      }
      if (
        permissionDelta &&
        evaluation.decision !== "forbidden" &&
        request.effectiveProfile === "sandbox"
      ) {
        if (!canRequestApproval(options.policy, "request_permissions")) {
          granted = false;
          needsReview = false;
          reason = "approval_disabled_request_permissions";
        } else {
          granted = false;
          reason = "permission_delta";
        }
      }
      if (request.permissions?.host && options.denyRead) {
        granted = false;
        needsReview = false;
        reason = "deny_read_requires_sandbox";
      }
      options.trace?.record("execution_policy_result", {
        ...base,
        decision: evaluation.decision,
        source,
        reason,
      });
      if (needsReview) {
        if (breaker.open) {
          granted = false;
          reason = "review_circuit_open";
          needsReview = false;
        } else if (
          (currentMode() === "auto" && options.policy !== "untrusted") ||
          options.judgeRequired
        ) {
          route = "judge";
          if (!options.judge) {
            granted = false;
            reason = "judge_unavailable";
            needsReview = false;
          } else if (signal?.aborted) {
            granted = false;
            reason = "authority_changed";
            needsReview = false;
          } else {
            options.trace?.record("approval_requested", { ...base, reason, route });
            let result: ReviewResult;
            try {
              result = await options.judge.review(
                {
                  action: request,
                  evidence: options.authorizationEvidence?.(request) ?? [],
                  profile: request.effectiveProfile,
                },
                signal,
              );
            } catch {
              result = { kind: "technical_failure", reason: "review_failed" };
            }
            if (result.kind === "assessment") {
              granted = result.assessment.outcome === "allow";
              judgeAssessment = result.assessment.outcome;
              reason = granted ? "judge_allowed" : `judge_denied: ${result.assessment.rationale}`;
              source = "reviewer";
            } else if (
              result.kind === "context_overflow" &&
              options.fallback !== "disabled" &&
              !options.judgeRequired
            ) {
              reason = "judge_context_overflow";
            } else {
              granted = false;
              reason = result.kind === "cancelled" ? "authority_changed" : `judge_${result.kind}`;
            }
            if (
              result.kind !== "context_overflow" ||
              options.fallback === "disabled" ||
              options.judgeRequired
            ) {
              needsReview = false;
            }
          }
        }
        if (needsReview && (!options.elicit || signal?.aborted)) {
          granted = false;
          reason = "review_unavailable";
        } else if (needsReview && options.elicit) {
          route = "manual";
          options.trace?.record("approval_requested", { ...base, reason, route });
          try {
            const analyzed = request.command ? analyzeShell(request.command) : undefined;
            const prefix =
              analyzed?.limit === "none" && analyzed.segments.length === 1
                ? analyzed.segments[0]
                : undefined;
            const canRemember =
              prefix !== undefined &&
              canSuggestRememberedAllow(prefix) &&
              evaluation.decision !== "forbidden" &&
              options.rememberPrefix !== undefined;
            const action = request.command ?? JSON.stringify(request.arguments);
            const scope = canRemember
              ? `\nRemembered allow: global rules, argv prefix ${JSON.stringify(prefix)}. A matching explicit allow can bypass sandbox when every segment is allowed and no deny-read applies.`
              : "";
            const response = await options.elicit(
              {
                kind: "execution_approval",
                origin: "external",
                message: `Approve ${request.tool}: ${action}\nCwd: ${request.cwd ?? "(not applicable)"}\nEffects: ${request.reason}\nAdditional permissions: ${JSON.stringify(request.permissions ?? {})}${scope}`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    approved: {
                      type: "string",
                      enum: canRemember ? ["yes", "no", "remember"] : ["yes", "no"],
                    },
                  },
                  required: ["approved"],
                },
              },
              { signal },
            );
            granted =
              response.action === "accept" &&
              (response.content?.approved === "yes" ||
                (canRemember && response.content?.approved === "remember")) &&
              !signal?.aborted;
            reason = granted ? "review_approved" : "review_declined";
            source = "reviewer";
            if (
              granted &&
              response.content?.approved === "remember" &&
              prefix &&
              options.rememberPrefix
            ) {
              try {
                reason = (await options.rememberPrefix(request, prefix))
                  ? "review_approved_remembered"
                  : "review_approved_remember_failed";
              } catch {
                reason = "review_approved_remember_failed";
              }
            }
          } catch {
            granted = false;
            reason = "review_unavailable";
          }
        }
      }
      if (!identityValid(request) || signal?.aborted) {
        granted = false;
        reason = "authority_changed";
        source = "host";
      }
      if (judgeAssessment && identityValid(request) && !signal?.aborted) {
        breaker.record(judgeAssessment === "deny");
        options.onJudgeReviewed?.(request);
        if (judgeAssessment === "deny") options.onJudgeDenied?.(request, reason);
      }
      if (evaluation.decision === "prompt" || permissionDelta || options.strictReview)
        options.trace?.record("approval_resolved", {
          ...base,
          reason,
          ...(route ? { route } : {}),
          outcome: granted
            ? "approved"
            : reason === "authority_changed"
              ? "invalidated"
              : reason === "review_unavailable" ||
                  (reason.startsWith("judge_") && !reason.startsWith("judge_denied"))
                ? "unavailable"
                : "declined",
        });
      const permissions =
        granted && request.permissions
          ? request.permissions
          : granted &&
              request.command !== undefined &&
              "all_segments_explicitly_allowed" in evaluation &&
              evaluation.all_segments_explicitly_allowed &&
              !options.denyRead &&
              request.effectiveProfile === "sandbox"
            ? { host: true }
            : undefined;
      if (permissions?.host) effectiveProfile = "host";
      return {
        granted,
        fingerprint: fingerprint(request),
        evidence: {
          decision: evaluation.decision,
          source,
          reason,
          requestedProfile,
          effectiveProfile,
          executionStarted: false,
        },
        ...(permissions ? { permissions } : {}),
      };
    },
  };
}
