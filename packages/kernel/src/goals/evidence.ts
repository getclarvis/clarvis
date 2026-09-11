import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isBuiltinTraceEvent, type TraceEvent } from "@clarvis/capability";
import {
  GoalError,
  type GoalCheckpoint,
  type GoalEvidenceOption,
  type GoalEvidenceRef,
  type GoalEvidenceVerifier,
  type GoalRecord,
} from "@clarvis/goal";

const MAX_OBSERVATIONS = 512;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const CONTROL_TOOLS = new Set([
  "get_goal",
  "update_goal",
  "await_agents",
  "agent_status",
  "agent_await",
  "monitor_poll",
  "monitor_status",
]);

/** Canonical JSON for evidence digests; arrays retain order and object keys sort lexically. */
export function goalEvidenceDigest(value: unknown): string {
  const canonical = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new GoalError("resource_exhausted", "Evidence nesting exceeds its bound");
    if (Array.isArray(item)) return item.map((child) => canonical(child, depth + 1));
    if (typeof item === "object" && item !== null)
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child, depth + 1)]),
      );
    return item;
  };
  const encoded = JSON.stringify(canonical(value, 0));
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES)
    throw new GoalError("resource_exhausted", "Evidence payload exceeds its bound");
  return createHash("sha256").update(encoded).digest("hex");
}

interface Observation {
  id: string;
  executionId: string;
  tool: string;
  argumentsDigest: string;
  resultDigest: string;
  successful: boolean;
  changeDigest?: string;
  description: string;
}

/** A completed tool envelope is required; native command success additionally requires exit zero. */
function observation(executionId: string, event: TraceEvent): Observation | undefined {
  if (!isBuiltinTraceEvent(event) || event.type !== "tool_call" || !event.call_id) return undefined;
  const tool = event.tool_name ? `${event.mcp_name}.${event.tool_name}` : event.mcp_name;
  if (CONTROL_TOOLS.has(tool)) return undefined;
  if (
    Buffer.byteLength(event.result) > MAX_PAYLOAD_BYTES ||
    Buffer.byteLength(JSON.stringify(event.arguments)) > MAX_PAYLOAD_BYTES
  )
    throw new GoalError("resource_exhausted", "Tool evidence exceeds its payload bound");
  let successful = event.error === null && event.guard?.outcome !== "denied";
  if (event.tool_name === "" && (tool === "shell" || tool === "host_exec")) {
    let command: { exit_code?: unknown; timed_out?: unknown; signal?: unknown } | undefined;
    try {
      command = JSON.parse(event.result) as typeof command;
    } catch {
      successful = false;
    }
    successful =
      successful && command?.exit_code === 0 && command.timed_out !== true && !command.signal;
  }
  return {
    id: `tool-${goalEvidenceDigest([executionId, event.subagent_instance_id ?? "entry", event.call_id])}`,
    executionId,
    tool,
    argumentsDigest: goalEvidenceDigest(event.arguments),
    resultDigest: goalEvidenceDigest(event.result),
    successful,
    ...(event.diff?.trim() ? { changeDigest: goalEvidenceDigest(event.diff) } : {}),
    description: `${tool}; call ${event.call_id}`.slice(0, 512),
  };
}

export interface GoalEvidenceSnapshot extends GoalEvidenceVerifier {
  readonly generation: number;
  readonly catalog: GoalEvidenceOption[];
  resolve(ids: readonly string[]): GoalEvidenceRef[];
  progress(
    ids: readonly string[],
  ): Pick<GoalCheckpoint, "activity_fingerprint" | "progress_accepted" | "reason">;
}

export interface GoalEvidenceSource {
  /** Observe the host's existing trace path, including child events; never accept guest-selected execution scope. */
  observe(event: TraceEvent): void;
  readonly generation: number;
  snapshot(goal: GoalRecord): Promise<GoalEvidenceSnapshot>;
}

/**
 * Derive evidence from existing trace results and confined file snapshots. The live index retains
 * only bounded digests/metadata; it is not another authoritative store. Older stage data comes
 * from the caller's owner-scoped trace reader. Missing/evicted proof is never treated as success.
 */
export function createGoalEvidenceSource(options: {
  executionId: string;
  workspaceRoot: string;
  readTrace(executionId: string): readonly TraceEvent[] | undefined;
  /** Injectable descriptor reader for deterministic mutation races; production uses the shared confined reader. */
  readArtifact?: (path: string) => Promise<Uint8Array>;
}): GoalEvidenceSource {
  const live = new Map<string, Observation>();
  let generation = 0;
  let incomplete = false;
  const readArtifact =
    options.readArtifact ??
    (async (path: string): Promise<Uint8Array> => {
      const { readRawFile } = await import("@clarvis/tools");
      return readRawFile(
        resolve(options.workspaceRoot, path),
        "goal artifact",
        MAX_ARTIFACT_BYTES,
        undefined,
        {
          confinement: { workspaceRoot: options.workspaceRoot },
        },
      );
    });
  const artifactDigest = async (path: string): Promise<string> => {
    const bytes = await readArtifact(path);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new GoalError("resource_exhausted", "Goal artifact exceeds its bound");
    return createHash("sha256").update(bytes).digest("hex");
  };
  return {
    get generation() {
      return generation;
    },
    observe(event) {
      try {
        const item = observation(options.executionId, event);
        if (item === undefined) return;
        const previous = live.get(item.id);
        if (previous !== undefined && goalEvidenceDigest(previous) === goalEvidenceDigest(item))
          return;
        generation++;
        if (previous !== undefined || live.size >= MAX_OBSERVATIONS) {
          incomplete = true;
          return;
        }
        live.set(item.id, item);
      } catch {
        incomplete = true;
        generation++;
      }
    },
    async snapshot(goal) {
      if (incomplete)
        throw new GoalError("resource_exhausted", "Goal evidence observation is incomplete");
      const capturedGeneration = generation;
      const eligible = goal.runs.filter(
        (run) => run.objective_revision === goal.objective_revision,
      );
      if (!eligible.some((run) => run.execution_id === options.executionId))
        throw new GoalError("conflict", "Evidence source does not belong to this objective");
      const observations: Observation[] = [];
      for (const run of [...eligible].reverse()) {
        const entries =
          run.execution_id === options.executionId
            ? [...live.values()]
            : (options.readTrace(run.execution_id) ?? [])
                .filter((event) => isBuiltinTraceEvent(event) && event.type === "tool_call")
                .slice(-MAX_OBSERVATIONS)
                .map((event) => observation(run.execution_id, event))
                .filter((item): item is Observation => item !== undefined);
        observations.unshift(...entries.slice(-(MAX_OBSERVATIONS - observations.length)));
        if (observations.length >= MAX_OBSERVATIONS) break;
      }
      const all = new Map<string, Observation>();
      for (const item of observations) {
        const previous = all.get(item.id);
        if (previous !== undefined && goalEvidenceDigest(previous) !== goalEvidenceDigest(item))
          throw new GoalError("conflict", "Persisted goal evidence is ambiguous");
        if (previous !== undefined) continue;
        all.set(item.id, item);
      }
      const signature = (item: Observation): string => `${item.tool}:${item.argumentsDigest}`;
      const latest = new Map([...all.values()].map((item) => [signature(item), item.id]));
      const references = new Map<string, GoalEvidenceOption>();
      for (const item of all.values())
        if (item.successful && latest.get(signature(item)) === item.id)
          references.set(item.id, {
            id: item.id,
            goal_id: goal.goal_id,
            objective_revision: goal.objective_revision,
            execution_id: item.executionId,
            kind: "tool_result",
            digest: item.resultDigest,
            description: item.description,
          });
      const artifacts = new Map<string, { path: string; digest: string }>();
      for (const criterion of goal.criteria) {
        if (criterion.verification?.kind !== "artifact_digest") continue;
        const path = criterion.verification.path;
        let digest: string;
        try {
          digest = await artifactDigest(path);
        } catch {
          continue;
        }
        const id = `artifact-${goalEvidenceDigest([options.executionId, path, digest])}`;
        artifacts.set(id, { path, digest });
        references.set(id, {
          id,
          goal_id: goal.goal_id,
          objective_revision: goal.objective_revision,
          execution_id: options.executionId,
          kind: "artifact",
          digest,
          description: `Artifact criterion ${criterion.id}`,
        });
      }
      if (generation !== capturedGeneration)
        throw new GoalError("conflict", "Goal activity changed while evidence was read");
      const resolveReferences = (ids: readonly string[]): GoalEvidenceRef[] => {
        if (ids.length > 8 || new Set(ids).size !== ids.length)
          throw new GoalError("invalid_request", "Evidence IDs must be bounded and unique");
        return ids.map((id) => {
          const found = references.get(id);
          if (found === undefined)
            throw new GoalError(
              "invalid_request",
              "Goal evidence is absent, obsolete or unsuccessful",
            );
          const { description: _, ...reference } = found;
          return { ...reference };
        });
      };
      return {
        generation: capturedGeneration,
        catalog: [...references.values()].slice(-32).map((reference) => ({ ...reference })),
        resolve: resolveReferences,
        async verify(reference, criterion) {
          const current = references.get(reference.id);
          if (
            current === undefined ||
            current.goal_id !== reference.goal_id ||
            current.execution_id !== reference.execution_id ||
            current.objective_revision !== reference.objective_revision ||
            current.digest !== reference.digest ||
            current.kind !== reference.kind
          )
            return {
              valid: false,
              reason: "Evidence is absent, obsolete or contradicted by a later result",
            };
          if (generation !== capturedGeneration)
            return { valid: false, reason: "Goal activity changed after evidence capture" };
          const artifact = artifacts.get(reference.id);
          if (artifact !== undefined) {
            try {
              if ((await artifactDigest(artifact.path)) !== artifact.digest)
                return { valid: false, reason: "Artifact changed after evidence capture" };
            } catch {
              return { valid: false, reason: "Current artifact digest is unavailable" };
            }
            if (generation !== capturedGeneration)
              return { valid: false, reason: "Goal activity changed during evidence validation" };
          }
          if (criterion.kind !== "host") return { valid: true };
          const expected = criterion.verification;
          if (expected?.kind === "tool_success") {
            const item = all.get(reference.id);
            return {
              valid:
                item !== undefined &&
                item.successful &&
                item.tool === expected.tool_name &&
                (expected.arguments_digest === undefined ||
                  item.argumentsDigest === expected.arguments_digest),
            };
          }
          if (
            expected?.kind !== "artifact_digest" ||
            artifact?.path !== expected.path ||
            artifact.digest !== expected.digest
          )
            return { valid: false, reason: "Artifact evidence does not satisfy this criterion" };
          return { valid: true };
        },
        progress(ids) {
          const refs = resolveReferences(ids);
          const changes: string[] = [];
          for (const ref of refs) {
            const artifact = artifacts.get(ref.id);
            if (artifact !== undefined) {
              changes.push(goalEvidenceDigest([artifact.path, artifact.digest]));
              continue;
            }
            const item = all.get(ref.id)!;
            const relevantCheck = goal.criteria.some(
              (criterion) =>
                criterion.verification?.kind === "tool_success" &&
                criterion.verification.tool_name === item.tool &&
                (criterion.verification.arguments_digest === undefined ||
                  criterion.verification.arguments_digest === item.argumentsDigest),
            );
            if (item.changeDigest !== undefined || relevantCheck)
              changes.push(
                goalEvidenceDigest([item.tool, item.argumentsDigest, item.changeDigest ?? null]),
              );
          }
          return changes.length === 0
            ? {
                progress_accepted: false,
                reason:
                  "No referenced workspace change or declared verification; prose and polling do not establish progress",
              }
            : {
                activity_fingerprint: goalEvidenceDigest([...new Set(changes)].sort()),
                progress_accepted: true,
                reason:
                  "Entry attributed observed workspace change or declared verification to the goal; semantic usefulness is not independently verified",
              };
        },
      };
    },
  };
}
