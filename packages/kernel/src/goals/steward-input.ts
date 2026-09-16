import { createHash } from "node:crypto";
import { isBuiltinTraceEvent, sanitizeText, type TraceEvent } from "@clarvis/capability";
import type { GoalRecord } from "@clarvis/goal";
import type { RunDetail, Session } from "@clarvis/protocol";
import { projectGoalTrajectory } from "./trajectory.ts";

/** Reconstruct formulation provenance once, removing all transport identities from its frame. */
export async function projectStewardOrigin(
  goal: GoalRecord,
  session: Session,
  readRun?: (executionId: string) => Promise<RunDetail | null>,
) {
  if (goal.origin.kind === "literal") return { entries: [], partial: false, truncated: false };
  if (!readRun) return { entries: [], partial: true, truncated: false };
  const source = await projectGoalTrajectory(session, readRun, {
    source_execution_ids: goal.origin.source_execution_ids,
    ...(goal.origin.kind === "guided" ? { exclude_user_text: goal.origin.seed } : {}),
    workspace_read_available: false,
  });
  const decoded = JSON.parse(source.projection) as {
    entries: Array<{ kind: string; text: string }>;
  };
  return {
    entries: decoded.entries.map(({ kind, text }) => ({
      actor: kind === "assistant" ? "work_agent" : kind === "user" ? "operator" : kind,
      text,
    })),
    partial: source.partial || source.digest !== goal.origin.trajectory_digest,
    truncated: source.truncated,
  };
}

/** Canonical host digest; opaque revisions and fingerprints never enter model frames. */
export function stewardDigest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "null")
    .digest("hex");
}

export function stewardDefinition(goal: GoalRecord) {
  return {
    objective: sanitizeText(goal.objective),
    criteria: goal.criteria.map((criterion) => ({
      ...criterion,
      description: sanitizeText(criterion.description),
    })),
    constraints: goal.constraints.map(sanitizeText),
    exclusions: goal.exclusions.map(sanitizeText),
    assumptions: goal.assumptions.map(sanitizeText),
    sources: goal.sources.map(({ path }) => ({ path })),
    origin: goal.origin.kind,
    ...(goal.origin.kind === "guided" ? { seed: sanitizeText(goal.origin.seed) } : {}),
  };
}

/** Full host-only definition identity includes provenance and normative byte bindings. */
export function stewardDefinitionDigest(goal: GoalRecord): string {
  return stewardDigest({
    objective: goal.objective,
    criteria: goal.criteria,
    constraints: goal.constraints,
    exclusions: goal.exclusions,
    assumptions: goal.assumptions,
    origin: goal.origin,
    sources: goal.sources,
  });
}

/** Bounded chronological deltas; source-agent responses are data, never Steward assistant roles. */
export function createStewardInput(
  initial: readonly string[],
  sequenceBase = 0,
  digestBase?: string,
  epochBase = 0,
) {
  let sequence = sequenceBase;
  let epoch = epochBase;
  let cumulative = digestBase ?? stewardDigest({ sequenceBase });
  let truncated = false;
  let bytes = 0;
  let events: Array<{
    sequence: number;
    actor: string;
    text: string;
    digest: string;
    epoch: number;
  }> = [];
  const append = (actor: string, raw: string) => {
    const text = sanitizeText(raw).trim();
    if (!text) return;
    sequence++;
    cumulative = stewardDigest({ previous: cumulative, sequence, actor, text });
    const bounded = Buffer.from(text)
      .subarray(0, 32 * 1024)
      .toString("utf8");
    truncated ||= bounded !== text;
    events.push({ sequence, actor, text: bounded, digest: cumulative, epoch });
    bytes += Buffer.byteLength(bounded);
    while (events.length > 128 || bytes > 128 * 1024) {
      bytes -= Buffer.byteLength(events.shift()!.text);
      truncated = true;
    }
  };
  for (const text of initial) append("operator", text);
  return {
    observe(event: TraceEvent) {
      if (!isBuiltinTraceEvent(event)) return;
      if (event.type === "lead_iteration") append("work_agent", event.response);
      else if (
        event.type === "user_steering" &&
        event.agent === "lead" &&
        !event.subagent_instance_id
      ) {
        epoch++;
        append("operator_steering", event.message);
      } else if (
        event.type === "user_question" &&
        event.agent === "lead" &&
        !event.subagent_instance_id &&
        event.outcome === "accept" &&
        event.answer
      ) {
        epoch++;
        append("elicitation", event.answer);
      }
    },
    snapshot(through = sequence) {
      const eligible = events.filter((event) => event.sequence <= through);
      const cut = eligible.at(-1);
      return {
        sequence: Math.min(sequence, through),
        epoch: through === sequence ? epoch : (cut?.epoch ?? epoch),
        digest: through === sequence ? cumulative : (cut?.digest ?? cumulative),
        truncated,
        events: eligible.map(({ actor, text }) => ({ actor, text })),
      };
    },
    consumed(through: number) {
      events = events.filter((event) => event.sequence > through);
      bytes = events.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0);
    },
  };
}
