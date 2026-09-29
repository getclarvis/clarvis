/** Explicit sufficiency control for an authored manager workflow. */
import { parseTaskTitle } from "@clarvis/capability";
import { createHash } from "node:crypto";
import type { ManagerWorkflowDefinition } from "./artifact.ts";
import {
  beginDispatch,
  type DispatchDeps,
  type DispatchOutcome,
  type DispatchUnit,
} from "./dispatch.ts";
import { interpolate } from "./interpolate.ts";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";
import { applyAccept, matchesFilter, readPath } from "./rounds.ts";
import { scheduleWorkItems } from "./schedule.ts";
import { WORKFLOW_RESULT_SCHEMAS } from "./schemas.ts";
import type { WorkflowAssessment, WorkflowInvocation, WorkflowSequenceState } from "./types.ts";
import { toWorkItem, workItemBrief } from "./work-items.ts";

interface Result {
  text: string;
  progress: boolean;
  error?: true;
}

interface Candidate {
  ref: string;
  item: unknown;
  index: number;
}
interface Materialized {
  invocation: WorkflowInvocation;
  value: unknown;
}

/** Scope discovery graphs and disambiguate only duplicate ids that no dependency references. */
function mergedResults(results: readonly unknown[], discovery: boolean): unknown {
  if (results.length === 1 && !discovery) return results[0];
  if (results.some((item) => typeof item !== "object" || item === null || Array.isArray(item)))
    return results.length === 1 ? results[0] : results;
  const entries = (results as Record<string, unknown>[]).map((result, index) => {
    if (!discovery || !Array.isArray(result.work_items)) return result;
    const works = result.work_items.map((item: unknown) => toWorkItem(item));
    const ids = works.flatMap((work) => (work === null ? [] : [work.id]));
    const duplicated = new Set(ids.filter((id, at) => ids.indexOf(id) !== at));
    if (results.length === 1 && duplicated.size === 0) return result;
    const referenced = new Set(works.flatMap((work) => work?.dependencies ?? []));
    const scopedId = (id: string): string =>
      `result-${String(index + 1)}-${createHash("sha256").update(id).digest("hex")}`;
    return {
      ...result,
      work_items: result.work_items.map((item: unknown, at: number) => {
        const work = works[at]!;
        if (work === null) return item;
        return {
          ...(item as Record<string, unknown>),
          id:
            duplicated.has(work.id) && !referenced.has(work.id)
              ? `${scopedId(work.id)}-item-${String(at + 1)}`
              : scopedId(work.id),
          dependencies: work.dependencies.map(scopedId),
        };
      }),
    };
  });
  if (entries.length === 1) return entries[0];
  return Object.fromEntries(
    [...new Set(entries.flatMap(Object.keys))].map((key) => {
      const values = entries.map((item) => item[key]).filter((value) => value !== undefined);
      return [
        key,
        values.every(Array.isArray) ? values.flat() : values.length === 1 ? values[0] : values,
      ];
    }),
  );
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
  private readonly invocations: Materialized[] = [];
  private readonly checkpointWaiters = new Set<() => void>();

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
      invocations: this.invocations.map(({ invocation }) => invocation),
    };
  }

  private commit(): void {
    this.deps.ctx.onSequenceState?.(this.state());
    this.deps.ctx.flushSequenceState?.();
    for (const wake of [...this.checkpointWaiters]) wake();
  }

  /** Wait for a running stage's checkpoint, bounded by timeout and run cancellation. */
  async waitForCheckpoint(timeoutMs: number): Promise<boolean> {
    const signal = this.deps.ctx.signal;
    if (this.status !== "running_round" || timeoutMs <= 0 || signal.aborted) return false;
    const revision = this.revision;
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", wake);
        this.checkpointWaiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(timeoutMs, 30_000));
      this.checkpointWaiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
    });
    return this.revision !== revision;
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
      text: `started manager sequence '${this.id}' at revision 1, awaiting_manager; no leader was started. Decide complete, dispatch or stop using this checkpoint:\n${this.statusText().text}`,
      progress: true,
    };
  }

  private candidates(
    stageId: string,
  ): { items: Candidate[]; source?: Materialized; failedSource: boolean } | null {
    const stage = this.definition.stages.find((entry) => entry.id === stageId);
    if (stage === undefined) return null;
    let source: Materialized | undefined;
    let failedSource = false;
    let values: unknown[] = [undefined];
    if (stage.over.kind !== "once") {
      const sourceId = stage.over.source.split(".")[0]!;
      const history = this.invocations.filter(({ invocation }) => invocation.stageId === sourceId);
      source = history.findLast(({ invocation }) => invocation.status === "completed");
      if (source === undefined) return null;
      failedSource = history.at(-1) !== source;
      const resolved = readPath(source.value, stage.over.source.split(".").slice(1));
      if (!Array.isArray(resolved) || resolved.length > WORKFLOW_LIMITS.workItems) return null;
      values =
        stage.over.kind === "each"
          ? resolved.filter(
              (item) =>
                stage.over.kind === "each" &&
                (stage.over.where === undefined || matchesFilter(item, stage.over.where)),
            )
          : [resolved];
    }
    return {
      items: values.map((item, index) => ({
        ref: `${this.id}:${String(this.revision)}:${stage.id}:${source?.invocation.id ?? "root"}:${String(index)}`,
        item,
        index,
      })),
      source,
      failedSource,
    };
  }

  statusText(ref?: string, page = 0, itemRef?: string): Result {
    const evidence = this.deps.ctx.evidence;
    if (!Number.isInteger(page) || page < 0 || page > 255)
      return { text: "invalid candidate page.", progress: false, error: true };
    if (itemRef !== undefined) {
      for (const stage of this.definition.stages) {
        const candidate = this.candidates(stage.id)?.items.find((item) => item.ref === itemRef);
        if (candidate !== undefined) {
          const detail = JSON.stringify(candidate);
          return {
            text: detail.length > 32 * 1024 ? `${detail.slice(0, 32 * 1024)} [truncated]` : detail,
            progress: false,
          };
        }
      }
      return {
        text: `unknown or stale item_ref. Omit item_ref/evidence_ref for overview; copy refs from the current checkpoint below. No work started.\n${this.statusText(undefined, page).text}`,
        progress: false,
        error: true,
      };
    }
    if (ref !== undefined) {
      const item = evidence?.get(ref);
      if (item === undefined)
        return {
          text: `unknown or inadmissible evidence ref '${ref}'. Omit evidence_ref for overview; use only admitted refs below.\n${this.statusText(undefined, page).text}`,
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
    const eligible = this.definition.stages.flatMap((stage) => {
      const proposal = this.candidates(stage.id);
      if (proposal === null) return [];
      return [
        {
          stageId: stage.id,
          selector: stage.over.kind,
          replicas: stage.replicas ?? { min: 1, max: 1 },
          mutation: stage.mutation ?? false,
          accept: stage.accept,
          sourceInvocationId: proposal.source?.invocation.id,
          failedSource: proposal.failedSource,
          total: proposal.items.length,
          page,
          candidates: proposal.items.slice(page * 16, (page + 1) * 16).map(({ ref, item }) => ({
            ref,
            summary: JSON.stringify(item)?.slice(0, 512) ?? "once",
            origin: proposal.source?.invocation.id ?? "once",
          })),
        },
      ];
    });
    return {
      text: JSON.stringify({
        ...this.state(),
        criteria: this.definition.completion.criteria,
        eligible: this.status === "awaiting_manager" ? eligible : [],
        completedStages: [...this.completed],
        evidence: refs,
        moreEvidence: (evidence?.list().length ?? 0) > 16,
        decisionHelp: {
          session_id: this.id,
          revision: this.revision,
          wait: "While running, workflow_status waits up to 30 seconds for a checkpoint; wait_ms:0 returns immediately. Invocation started/completed counts finalize at settlement; leadersStarted and evidence show live activity. Use agent_list and agent_poll for individual leader activity.",
          dispatch:
            "Choose eligible stageId and a gap. Copy candidate refs to dispatch.items with chosen replicas; account for other candidates with skipped/deferred/covered. Omitted replicas use the stage minimum. Source is inferred at this revision unless supplied.",
          complete:
            "Provide assessment.criteria with each criterion id, evidence_refs from evidence, and explanation. Inspect actual results; text claims alone do not prove edits or tests. Disclose remaining_gaps and resolve or qualify every failed leader in unresolved_failures.",
          stop: "Provide reason and optional remaining_gaps. Stop does not claim completion.",
        },
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
      const remainingGaps = raw.remaining_gaps ?? [raw.reason];
      if (
        !Array.isArray(remainingGaps) ||
        remainingGaps.length > 16 ||
        remainingGaps.some((gap) => !isBoundedWorkflowString(gap, 1_024))
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
        remainingGaps: remainingGaps as string[],
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
    const dispositions = assessment.unresolved_failures ?? [];
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
    const remainingGaps = assessment.remaining_gaps ?? [];
    if (
      !Array.isArray(remainingGaps) ||
      remainingGaps.length > 16 ||
      remainingGaps.some((gap) => !isBoundedWorkflowString(gap, WORKFLOW_LIMITS.textChars))
    )
      return { text: "invalid remaining_gaps.", progress: false, error: true };
    const prior = this.state();
    this.assessment = {
      outcome: "sufficient",
      decisionRevision: prior.revision,
      criteria: parsed,
      remainingGaps: remainingGaps as string[],
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
    const proposal = this.candidates(stage.id);
    if (proposal === null || proposal.items.length === 0)
      return {
        text: "stage source is unavailable or has no candidates.",
        progress: false,
        error: true,
      };
    if (
      request.source_invocation_id != null &&
      proposal.source?.invocation.id !== request.source_invocation_id &&
      stage.over.kind !== "once"
    )
      return {
        text: "source_invocation_id does not match the checkpoint.",
        progress: false,
        error: true,
      };
    if (proposal.failedSource && request.acknowledge_failed_source !== true)
      return {
        text: "a later source invocation failed; acknowledge_failed_source is required.",
        progress: false,
        error: true,
      };
    const selections = request.items;
    const skipped = request.skipped ?? [];
    const deferred = request.deferred ?? [];
    const covered = request.covered ?? [];
    if (
      !Array.isArray(selections) ||
      !Array.isArray(skipped) ||
      !Array.isArray(deferred) ||
      !Array.isArray(covered) ||
      selections.length === 0 ||
      selections.length > WORKFLOW_LIMITS.workItems ||
      skipped.length > WORKFLOW_LIMITS.workItems ||
      deferred.length > WORKFLOW_LIMITS.workItems ||
      covered.length > WORKFLOW_LIMITS.workItems
    )
      return {
        text: "dispatch requires bounded selected, skipped and deferred items.",
        progress: false,
        error: true,
      };
    const entries: { entry: unknown; kind: "selected" | "skipped" | "deferred" | "covered" }[] = [
      ...selections.map((entry: unknown) => ({ entry, kind: "selected" as const })),
      ...skipped.map((entry: unknown) => ({ entry, kind: "skipped" as const })),
      ...deferred.map((entry: unknown) => ({ entry, kind: "deferred" as const })),
      ...covered.map((entry: unknown) => ({ entry, kind: "covered" as const })),
    ];
    const dispositions = new Map<string, WorkflowInvocation["coverage"][number]>();
    for (const { entry, kind } of entries) {
      if (typeof entry !== "object" || entry === null)
        return { text: "invalid disposition.", progress: false, error: true };
      const record = entry as Record<string, unknown>;
      const ref = record.item_ref;
      if (
        typeof ref !== "string" ||
        dispositions.has(ref) ||
        !proposal.items.some((item) => item.ref === ref)
      )
        return { text: "duplicate, unknown or stale item_ref.", progress: false, error: true };
      if (kind === "selected") {
        const range = stage.replicas ?? { min: 1, max: 1 };
        const replicas = record.replicas === undefined ? range.min : record.replicas;
        if (
          !Number.isInteger(replicas) ||
          Number(replicas) < range.min ||
          Number(replicas) > range.max
        )
          return {
            text: `replicas outside the approved range ${String(range.min)}–${String(range.max)} for '${stage.id}'.`,
            progress: false,
            error: true,
          };
        const candidate = proposal.items.find((item) => item.ref === ref)!;
        if (
          Number(replicas) > 1 &&
          (stage.mutation === true || toWorkItem(candidate.item)?.mutation === true)
        )
          return { text: "mutating items cannot have replicas.", progress: false, error: true };
        if (stage.accept?.kind === "threshold" && stage.accept.count > Number(replicas))
          return { text: "accept threshold cannot be reached.", progress: false, error: true };
        dispositions.set(ref, { ref, disposition: kind, replicas: Number(replicas) });
      } else if (kind === "covered") {
        const previous = this.invocations.find(
          ({ invocation }) =>
            invocation.id === record.invocation_id &&
            invocation.stageId === stage.id &&
            invocation.sourceInvocationId === proposal.source?.invocation.id,
        );
        if (
          previous === undefined ||
          !previous.invocation.coverage.some(
            (entry) =>
              entry.disposition === "selected" &&
              entry.status === "completed" &&
              entry.ref.split(":").slice(-2).join(":") === ref.split(":").slice(-2).join(":"),
          )
        )
          return {
            text: "covered item needs a completed prior invocation for the same source.",
            progress: false,
            error: true,
          };
        dispositions.set(ref, {
          ref,
          disposition: kind,
          reason: previous.invocation.id,
          status: "completed",
        });
      } else {
        const reason = kind === "skipped" ? record.reason : record.gap;
        if (!isBoundedWorkflowString(reason, 1_024) || reason.trim().length === 0)
          return { text: "skip reason or deferred gap is required.", progress: false, error: true };
        dispositions.set(ref, { ref, disposition: kind, reason });
      }
    }
    if (dispositions.size !== proposal.items.length)
      return {
        text: "every current candidate needs a disposition; inspect all pages.",
        progress: false,
        error: true,
      };
    const selected = proposal.items.filter(
      (item) => dispositions.get(item.ref)?.disposition === "selected",
    );
    const repeated = selected.some((item) =>
      this.invocations.some(
        ({ invocation }) =>
          invocation.stageId === stage.id &&
          invocation.gap === request.gap &&
          invocation.coverage.some(
            (entry) =>
              entry.disposition === "selected" &&
              entry.status === "completed" &&
              entry.ref.split(":").slice(-2).join(":") === item.ref.split(":").slice(-2).join(":"),
          ),
      ),
    );
    if (repeated)
      return { text: "completed items need a new gap to repeat.", progress: false, error: true };
    const works = selected.map((item) => {
      const work = toWorkItem(item.item);
      return work === null ? null : { ...work, mutation: stage.mutation === true || work.mutation };
    });
    const priorCovered = this.invocations.flatMap(({ invocation }) =>
      invocation.coverage.filter(
        (entry) =>
          entry.disposition === "selected" &&
          entry.status === "completed" &&
          invocation.sourceInvocationId === proposal.source?.invocation.id,
      ),
    );
    const sourceWorks = proposal.items.map((item) => toWorkItem(item.item));
    const ids = sourceWorks.filter((item) => item !== null).map((item) => item.id);
    if (new Set(ids).size !== ids.length)
      return {
        text: "source has duplicate work item ids. Dependencies cannot identify one item safely; rerun discovery with distinct ids for referenced items.",
        progress: false,
        error: true,
      };
    if (works.some((item) => item !== null) && works.some((item) => item === null))
      return { text: "mixed work item shapes are not schedulable.", progress: false, error: true };
    const scheduled = works.every((item) => item !== null) && stage.over.kind === "each";
    const byId = new Map(selected.map((item, index) => [works[index]?.id, item]));
    const completedId = (id: string): boolean =>
      sourceWorks.some(
        (item, index) =>
          item?.id === id &&
          priorCovered.some(
            (entry) =>
              entry.ref.split(":").slice(-2).join(":") ===
              proposal.items[index]!.ref.split(":").slice(-2).join(":"),
          ),
      );
    if (
      scheduled &&
      works.some((item) => item?.dependencies.some((id) => !byId.has(id) && !completedId(id)))
    )
      return {
        text: "selected work item skips an unmet dependency.",
        progress: false,
        error: true,
      };
    const schedule = scheduled
      ? scheduleWorkItems(
          works
            .filter((item) => item !== null)
            .map((item) => ({
              ...item,
              dependencies: item.dependencies.filter((id) => byId.has(id)),
            })),
        )
      : null;
    if (schedule !== null && !schedule.ok)
      return { text: schedule.message, progress: false, error: true };
    const invocationId = `${this.id}-inv-${String(this.dispatches + 1)}`;
    const state = Object.fromEntries(
      this.invocations
        .filter(({ invocation }) => invocation.status === "completed")
        .map(({ invocation, value }) => [invocation.stageId, value]),
    );
    const units = new Map<string, DispatchUnit[]>();
    for (const item of selected) {
      const scope = { args: this.args, item: item.item, state };
      const title = interpolate(stage.title, scope);
      const brief = interpolate(stage.brief, scope);
      if ("error" in title || "error" in brief)
        return { text: "stage interpolation failed.", progress: false, error: true };
      const parsed = parseTaskTitle(title.text);
      const work = works[selected.indexOf(item)] ?? null;
      const rendered = work === null ? brief.text : workItemBrief(work, brief.text);
      if (
        !parsed.ok ||
        rendered.length + String(request.gap).length + 80 > WORKFLOW_LIMITS.textChars
      )
        return {
          text: "rendered stage exceeds title or brief limit.",
          progress: false,
          error: true,
        };
      const replicas = dispositions.get(item.ref)!.replicas!;
      units.set(
        item.ref,
        Array.from({ length: replicas }, (_, replica) => ({
          key: `${invocationId}[${String(item.index)}]#${String(replica + 1)}`,
          title: parsed.title,
          brief: `${rendered}\n\nManager-identified gap (task scope only): ${String(request.gap)}`,
          roundId: stage.id,
          pass: this.dispatches,
          itemIndex: item.index,
          replica,
          replicaCount: replicas,
          ...(stage.profile === undefined ? {} : { profile: stage.profile }),
          ...(stage.type === "free" ? {} : { expectSchema: WORKFLOW_RESULT_SCHEMAS[stage.type] }),
        })),
      );
    }
    const waves =
      schedule !== null && schedule.ok
        ? schedule.waves.map((wave) =>
            wave.items.flatMap((work) => units.get(byId.get(work.id)!.ref)!),
          )
        : [selected.flatMap((item) => units.get(item.ref)!)];
    const total = [...units.values()].reduce((count, group) => count + group.length, 0);
    const [head] = waves;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          invocationId,
          sourceInvocationId: proposal.source?.invocation.id,
          coverage: [...dispositions.values()],
          waves,
        }),
      )
      .digest("hex");
    let session;
    try {
      session = beginDispatch(this.deps, head!, total);
    } catch {
      session = null;
    }
    if (session === null)
      return {
        text: "batch admission refused; checkpoint unchanged and no leader started.",
        progress: false,
        error: true,
      };
    const prior = this.state();
    const invocation: WorkflowInvocation = {
      id: invocationId,
      stageId: stage.id,
      gap: request.gap,
      fingerprint,
      ...(proposal.source === undefined
        ? {}
        : { sourceInvocationId: proposal.source.invocation.id }),
      status: "running",
      requested: total,
      started: 0,
      completed: 0,
      coverage: proposal.items.map((item) => dispositions.get(item.ref)!),
    };
    this.invocations.push({ invocation, value: undefined });
    this.status = "running_round";
    this.stageId = stage.id;
    this.dispatches++;
    this.revision++;
    this.reason = `dispatch '${stage.id}' reserved for gap: ${request.gap}`;
    try {
      this.commit();
    } catch {
      this.invocations.pop();
      this.restore(prior);
      session.end("checkpoint save failed");
      return { text: "checkpoint save failed; no leader started.", progress: false, error: true };
    }
    const run = (async (): Promise<void> => {
      let summary = "";
      try {
        const outcomes: DispatchOutcome[] = [];
        const statuses = new Map<string, string>();
        for (const [index, wave] of waves.entries()) {
          if (index > 0) session.advance(wave);
          const batch = await session.run((unit) => {
            const work = works.find((candidate, at) => selected[at]?.index === unit.itemIndex);
            const blocked = work?.dependencies.find(
              (id) => byId.has(id) && statuses.get(id) !== "completed",
            );
            return blocked === undefined
              ? null
              : { blocked: `dependency '${blocked}' did not complete` };
          });
          outcomes.push(...batch);
          for (const item of selected) {
            const work = toWorkItem(item.item);
            if (work === null || !wave.some((unit) => unit.itemIndex === item.index)) continue;
            const group = batch.filter((outcome) =>
              units.get(item.ref)?.some((unit) => unit.key === outcome.key),
            );
            statuses.set(
              work.id,
              group.length > 0 && group.every((outcome) => outcome.status === "completed")
                ? "completed"
                : "failed",
            );
          }
          if (session.cancelled() || this.deps.ctx.signal.aborted) break;
        }
        for (const outcome of outcomes)
          this.deps.ctx.evidence?.addLeader(
            stage.id,
            outcome.runId ?? outcome.key,
            outcome.status,
            outcome.result,
            this.revision,
          );
        const coverage = invocation.coverage.map((entry) => {
          if (entry.disposition !== "selected") return entry;
          const item = selected.find((candidate) => candidate.ref === entry.ref)!;
          const group = outcomes.filter((outcome) =>
            units.get(item.ref)?.some((unit) => unit.key === outcome.key),
          );
          const complete =
            group.length === entry.replicas &&
            group.every((outcome) => outcome.status === "completed");
          const accepted =
            stage.accept === undefined ||
            applyAccept(
              stage.accept,
              group.map((outcome) => (outcome.status === "completed" ? outcome.result : undefined)),
            ).accepted;
          return { ...entry, status: !complete ? "failed" : accepted ? "completed" : "rejected" };
        });
        const results = selected.flatMap((item) =>
          outcomes
            .filter((outcome) => units.get(item.ref)?.some((unit) => unit.key === outcome.key))
            .filter((outcome) => outcome.status === "completed")
            .map((outcome) => outcome.result),
        );
        const value =
          stage.accept === undefined
            ? mergedResults(results, stage.type === "discovery")
            : {
                accepted: selected
                  .filter(
                    (item) =>
                      coverage.find((entry) => entry.ref === item.ref)?.status === "completed",
                  )
                  .map((item) => item.item),
                rejected: selected
                  .filter(
                    (item) =>
                      coverage.find((entry) => entry.ref === item.ref)?.status !== "completed",
                  )
                  .map((item) => item.item),
              };
        this.invocations[this.invocations.length - 1] = {
          invocation: {
            ...invocation,
            coverage,
            status:
              session.cancelled() || this.deps.ctx.signal.aborted
                ? "cancelled"
                : outcomes.length !== total ||
                    coverage.some(
                      (entry) => entry.disposition === "selected" && entry.status !== "completed",
                    )
                  ? "failed"
                  : "completed",
            started: outcomes.filter((outcome) => outcome.runId !== undefined).length,
            completed: outcomes.filter((outcome) => outcome.status === "completed").length,
          },
          value: structuredClone(value),
        };
        if (this.invocations.at(-1)?.invocation.status === "completed")
          this.completed.add(stage.id);
        this.status = "awaiting_manager";
        summary = `stage '${stage.id}' finished: ${String(outcomes.length)}/${String(total)} outcomes`;
        this.reason = summary;
        this.revision++;
        this.commit();
      } catch (error) {
        const current = this.invocations.at(-1);
        if (current?.invocation.id === invocationId && current.invocation.status === "running") {
          this.invocations[this.invocations.length - 1] = {
            ...current,
            invocation: { ...current.invocation, status: "failed" },
          };
        }
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
      text: `dispatched ${String(total)} leaders for stage '${stage.id}' as ${session.anchorId}. Inspect workflow_status after settlement.`,
      progress: true,
    };
  }
}
