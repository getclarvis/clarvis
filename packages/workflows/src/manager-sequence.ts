/** Explicit sufficiency control for an authored manager workflow. */
import { parseTaskTitle } from "@clarvis/capability";
import type { ManagerWorkflowDefinition } from "./artifact.ts";
import { beginDispatch, type DispatchDeps } from "./dispatch.ts";
import { interpolate } from "./interpolate.ts";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";
import { WORKFLOW_RESULT_SCHEMAS } from "./schemas.ts";
import type { WorkflowAssessment, WorkflowSequenceState } from "./types.ts";

interface Result {
  text: string;
  progress: boolean;
  error?: true;
}

/** One manager-owned checkpoint; the enclosing round coordinator owns exclusivity. */
export class ManagerSequence {
  readonly id: string;
  status: WorkflowSequenceState["status"] = "awaiting_manager";
  revision = 1;
  dispatches = 0;
  reason?: string;
  assessment?: WorkflowAssessment;
  private stageId?: string;
  private readonly completed = new Set<string>();

  constructor(
    id: string,
    readonly definition: ManagerWorkflowDefinition,
    readonly deps: DispatchDeps,
    readonly args: Record<string, unknown>,
  ) {
    this.id = id;
  }

  state(): WorkflowSequenceState {
    return {
      sessionId: this.id,
      status: this.status,
      revision: this.revision,
      control: "manager",
      objective: this.definition.objective,
      dispatches: this.dispatches,
      maxDispatches: this.definition.maxDispatches,
      leadersStarted: this.deps.ctx.leaderCount.started(),
      maxTotalLeaders: this.deps.ctx.leaderCount.limit,
      ...(this.stageId === undefined ? {} : { roundId: this.stageId }),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.assessment === undefined ? {} : { assessment: this.assessment }),
    };
  }

  private commit(): void {
    this.deps.ctx.onSequenceState?.(this.state());
    this.deps.ctx.flushSequenceState?.();
  }

  open(): Result {
    try {
      this.commit();
    } catch {
      return {
        text: "workflow checkpoint could not be persisted; no sequence opened.",
        progress: false,
        error: true,
      };
    }
    return {
      text: `started manager sequence '${this.id}' at revision 1, awaiting_manager; no leader was started. Inspect workflow_status and decide complete, dispatch or stop.`,
      progress: true,
    };
  }

  statusText(ref?: string): Result {
    const evidence = this.deps.ctx.evidence;
    if (ref !== undefined) {
      const item = evidence?.get(ref);
      if (item === undefined)
        return {
          text: `unknown or inadmissible evidence ref '${ref}'.`,
          progress: false,
          error: true,
        };
      if (item.status === "running")
        return { text: `evidence '${ref}' is still active.`, progress: false, error: true };
      const detail = item.detail;
      const bytes = Buffer.byteLength(detail);
      const bounded = Buffer.from(detail)
        .subarray(0, 32 * 1024)
        .toString("utf8");
      return {
        text: JSON.stringify({ ...item, detail: bounded, truncated: bytes > 32 * 1024 }),
        progress: false,
      };
    }
    const refs =
      evidence
        ?.list()
        .slice(-16)
        .map(({ ref, origin, status, summary, stageId, runId, revision }) => ({
          ref,
          origin,
          status,
          summary: summary.slice(0, 512),
          stageId,
          runId,
          revision,
        })) ?? [];
    return {
      text: JSON.stringify({
        ...this.state(),
        criteria: this.definition.completion.criteria,
        stages: this.definition.stages.map((stage) => stage.id),
        completedStages: [...this.completed],
        evidence: refs,
        moreEvidence: (evidence?.list().length ?? 0) > 16,
      }),
      progress: false,
    };
  }

  decide(raw: Record<string, unknown>): Result {
    if (this.status !== "awaiting_manager")
      return {
        text: `sequence '${this.id}' is ${this.status}, not awaiting_manager.`,
        progress: false,
        error: true,
      };
    if (raw.revision !== this.revision)
      return {
        text: `stale decision: expected revision ${String(this.revision)}; no effect.`,
        progress: false,
        error: true,
      };
    const decision = raw.decision;
    if (decision !== "complete" && decision !== "dispatch" && decision !== "stop")
      return {
        text: "manager decision must be complete, dispatch or stop.",
        progress: false,
        error: true,
      };
    if (!isBoundedWorkflowString(raw.reason, 1_024) || raw.reason.trim().length === 0)
      return {
        text: "manager reason must be non-empty and at most 1024 characters.",
        progress: false,
        error: true,
      };
    if (decision !== "dispatch" && this.deps.agents.liveCount() > 0)
      return {
        text: "active or unknown children must settle before complete or stop.",
        progress: false,
        error: true,
      };
    if (decision === "dispatch" && this.deps.agents.liveCount() > 0)
      return {
        text: "other physical work is active; dispatch would overlap it.",
        progress: false,
        error: true,
      };
    if (decision === "dispatch") return this.dispatch(raw.dispatch);
    if (decision === "stop") {
      if (
        !Array.isArray(raw.remaining_gaps) ||
        raw.remaining_gaps.length > 16 ||
        raw.remaining_gaps.some((gap) => !isBoundedWorkflowString(gap, 1_024))
      )
        return { text: "stop requires bounded remaining_gaps.", progress: false, error: true };
      const prior = this.state();
      this.status = "stopped";
      this.reason = String(raw.reason);
      this.revision++;
      this.assessment = {
        outcome: "insufficient",
        decisionRevision: prior.revision,
        criteria: [],
        remainingGaps: raw.remaining_gaps as string[],
        unresolvedFailures: [],
      };
      try {
        this.commit();
      } catch {
        this.restore(prior);
        return {
          text: "checkpoint save failed; stop not confirmed.",
          progress: false,
          error: true,
        };
      }
      return {
        text: `sequence '${this.id}' stopped without claiming sufficiency.`,
        progress: true,
      };
    }
    return this.complete(raw.assessment);
  }

  private restore(prior: WorkflowSequenceState): void {
    this.status = prior.status;
    this.revision = prior.revision;
    this.reason = prior.reason;
    this.assessment = prior.assessment;
    this.stageId = prior.roundId;
    this.dispatches = prior.dispatches ?? 0;
    this.deps.ctx.onSequenceState?.(this.state());
  }

  private complete(value: unknown): Result {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { text: "complete requires assessment.", progress: false, error: true };
    const assessment = value as Record<string, unknown>;
    const criteria = assessment.criteria;
    if (!Array.isArray(criteria) || criteria.length !== this.definition.completion.criteria.length)
      return {
        text: "assessment requires one record per criterion.",
        progress: false,
        error: true,
      };
    const parsed: WorkflowAssessment["criteria"][number][] = [];
    const used = new Set<string>();
    for (const item of criteria) {
      if (typeof item !== "object" || item === null)
        return { text: "invalid criterion record.", progress: false, error: true };
      const entry = item as Record<string, unknown>;
      const criterion = this.definition.completion.criteria.find((c) => c.id === entry.id);
      if (
        criterion === undefined ||
        used.has(criterion.id) ||
        !Array.isArray(entry.evidence_refs) ||
        entry.evidence_refs.length === 0 ||
        entry.evidence_refs.length > 16 ||
        !isBoundedWorkflowString(entry.explanation, WORKFLOW_LIMITS.textChars) ||
        entry.explanation.trim().length === 0
      )
        return {
          text: "invalid, duplicate or unsupported criterion.",
          progress: false,
          error: true,
        };
      const refs = entry.evidence_refs as unknown[];
      if (
        refs.some(
          (ref) =>
            typeof ref !== "string" ||
            this.deps.ctx.evidence?.get(ref) === undefined ||
            this.deps.ctx.evidence.get(ref)?.status === "running",
        )
      )
        return {
          text: "criterion cites unknown or active evidence.",
          progress: false,
          error: true,
        };
      if (
        criterion.requires_completed_stages?.some(
          (id) =>
            !this.completed.has(id) ||
            !refs.some(
              (ref) =>
                typeof ref === "string" &&
                this.deps.ctx.evidence?.get(ref)?.stageId === id &&
                this.deps.ctx.evidence.get(ref)?.status === "completed",
            ),
        )
      )
        return {
          text: `criterion '${criterion.id}' requires completed stage evidence.`,
          progress: false,
          error: true,
        };
      used.add(criterion.id);
      parsed.push({
        id: criterion.id,
        evidenceRefs: refs as string[],
        explanation: entry.explanation,
      });
    }
    const failures =
      this.deps.ctx.evidence
        ?.list()
        .filter((item) => item.origin === "leader" && item.status !== "completed") ?? [];
    const dispositions = assessment.unresolved_failures;
    if (!Array.isArray(dispositions) || dispositions.length !== failures.length)
      return {
        text: "every known leader failure requires a disposition.",
        progress: false,
        error: true,
      };
    const dispositionIds = dispositions.map((item: unknown) =>
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>).run_id
        : undefined,
    );
    if (new Set(dispositionIds).size !== dispositions.length)
      return {
        text: "failure dispositions must name distinct runs.",
        progress: false,
        error: true,
      };
    const resolved: WorkflowAssessment["unresolvedFailures"][number][] = [];
    for (const failure of failures) {
      const entry = dispositions.find(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).run_id === failure.runId,
      ) as Record<string, unknown> | undefined;
      if (
        entry === undefined ||
        (entry.disposition !== "resolved" && entry.disposition !== "non_blocking") ||
        !isBoundedWorkflowString(entry.explanation, WORKFLOW_LIMITS.textChars) ||
        entry.explanation.trim().length === 0 ||
        !Array.isArray(entry.evidence_refs) ||
        entry.evidence_refs.some(
          (ref) => typeof ref !== "string" || this.deps.ctx.evidence?.get(ref) === undefined,
        )
      )
        return {
          text: `failure '${failure.runId ?? "unknown"}' lacks a valid disposition.`,
          progress: false,
          error: true,
        };
      if (
        entry.disposition === "resolved" &&
        (entry.evidence_refs.length === 0 ||
          entry.evidence_refs.every(
            (ref: string) => this.deps.ctx.evidence?.get(ref)?.status !== "completed",
          ))
      )
        return {
          text: `resolved failure '${failure.runId ?? "unknown"}' needs completed evidence.`,
          progress: false,
          error: true,
        };
      resolved.push({
        runId: failure.runId!,
        disposition: entry.disposition,
        explanation: entry.explanation,
        evidenceRefs: entry.evidence_refs as string[],
      });
    }
    if (
      !Array.isArray(assessment.remaining_gaps) ||
      assessment.remaining_gaps.length > 16 ||
      assessment.remaining_gaps.some(
        (gap) => !isBoundedWorkflowString(gap, WORKFLOW_LIMITS.textChars),
      )
    )
      return { text: "invalid remaining_gaps.", progress: false, error: true };
    const prior = this.state();
    this.assessment = {
      outcome: "sufficient",
      decisionRevision: prior.revision,
      criteria: parsed,
      remainingGaps: assessment.remaining_gaps as string[],
      unresolvedFailures: resolved,
    };
    if (Buffer.byteLength(JSON.stringify(this.assessment)) > 32 * 1024) {
      this.assessment = prior.assessment;
      return {
        text: "assessment exceeds the 32 KiB checkpoint limit.",
        progress: false,
        error: true,
      };
    }
    this.status = "completed";
    this.revision++;
    this.reason = "manager declared objective sufficient";
    try {
      this.commit();
    } catch {
      this.restore(prior);
      return {
        text: "checkpoint save failed; completion not confirmed.",
        progress: false,
        error: true,
      };
    }
    return {
      text: `sequence '${this.id}' completed with explicit sufficiency; operational failures remain recorded.`,
      progress: true,
    };
  }

  private dispatch(value: unknown): Result {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { text: "dispatch requires stage_id and gap.", progress: false, error: true };
    const request = value as Record<string, unknown>;
    const stage = this.definition.stages.find((candidate) => candidate.id === request.stage_id);
    if (
      stage === undefined ||
      !isBoundedWorkflowString(request.gap, 1_024) ||
      request.gap.trim().length === 0
    )
      return { text: "invalid stage_id or gap.", progress: false, error: true };
    if (this.dispatches >= this.definition.maxDispatches)
      return {
        text: "max_dispatches reached; complete or stop remains available.",
        progress: false,
        error: true,
      };
    const scope = { args: this.args, state: {} };
    const title = interpolate(stage.title, scope);
    const brief = interpolate(stage.brief, scope);
    if ("error" in title || "error" in brief)
      return { text: "stage interpolation failed.", progress: false, error: true };
    const parsed = parseTaskTitle(title.text);
    if (!parsed.ok || brief.text.length + request.gap.length + 80 > WORKFLOW_LIMITS.textChars)
      return {
        text: "rendered stage exceeds its title or brief limit.",
        progress: false,
        error: true,
      };
    const prior = this.state();
    this.status = "running_round";
    this.stageId = stage.id;
    this.dispatches++;
    this.revision++;
    this.reason = `dispatch '${stage.id}' reserved for gap: ${request.gap}`;
    try {
      this.commit();
    } catch {
      this.restore(prior);
      return {
        text: "checkpoint save failed; no leader registered.",
        progress: false,
        error: true,
      };
    }
    const unit = {
      key: `${stage.id}[${String(this.dispatches)}]`,
      title: parsed.title,
      brief: `${brief.text}\n\nManager-identified gap (task scope only): ${request.gap}`,
      roundId: stage.id,
      pass: 0,
      ...(stage.profile === undefined ? {} : { profile: stage.profile }),
      ...(stage.type === "free" ? {} : { expectSchema: WORKFLOW_RESULT_SCHEMAS[stage.type] }),
    };
    let session;
    try {
      session = beginDispatch(this.deps, [unit]);
    } catch {
      session = null;
    }
    if (session === null) {
      this.restore(prior);
      try {
        this.commit();
      } catch {
        return {
          text: "dispatch registration and rollback save failed; no leader started.",
          progress: false,
          error: true,
        };
      }
      return {
        text: "leader registration refused; same revision remains available.",
        progress: false,
        error: true,
      };
    }
    const run = (async (): Promise<void> => {
      let summary = "";
      try {
        const [outcome] = await session.run();
        if (outcome !== undefined) {
          const evidence = this.deps.ctx.evidence;
          evidence?.addLeader(
            stage.id,
            outcome.runId ?? unit.key,
            outcome.status,
            outcome.result,
            this.revision,
          );
          if (outcome.status === "completed") this.completed.add(stage.id);
          summary = `stage '${stage.id}' ${outcome.status}`;
        }
        this.status = "awaiting_manager";
        this.reason = summary;
        this.revision++;
        this.commit();
      } catch (error) {
        this.status = "failed";
        this.reason = error instanceof Error ? error.message : String(error);
        this.revision++;
        try {
          this.commit();
        } catch {
          /* terminal flush retries at manager exit */
        }
        summary = this.reason;
      } finally {
        session.end(summary);
      }
    })();
    this.deps.agents.adopt(session.anchorId, run);
    return {
      text: `dispatched stage '${stage.id}' as ${session.anchorId}. Await its result, inspect workflow_status, then decide again.`,
      progress: true,
    };
  }
}
