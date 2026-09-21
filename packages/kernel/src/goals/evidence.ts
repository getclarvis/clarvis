import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  isBuiltinTraceEvent,
  sanitizeDeep,
  sanitizeText,
  type TraceEvent,
} from "@clarvis/capability";
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

/** Bounded host-observed command receipt; content is evidence, never execution authority. */
export interface GoalCommandEvidence {
  id: string;
  tool: string;
  arguments_excerpt: string;
  exit_code: 0;
  stdout_excerpt: string;
  stderr_excerpt: string;
  truncated: boolean;
}

/** Bounded host-observed receipt for a completed delegated run. */
export interface GoalDelegationEvidence {
  id: string;
  tool: "delegate_task";
  status: "completed";
  result_excerpt: string;
  truncated: boolean;
}

/** Bounded content receipt delivered to the Steward without granting read tools. */
export interface GoalEvidenceDetail {
  id: string;
  kind: "command" | "content";
  status: "succeeded" | "failed" | "incomplete";
  digest: string;
  total_chars: number;
  excerpt: string;
  truncated: boolean;
  command?: {
    exit_code?: number;
    timed_out?: boolean;
    signal?: string;
    stdout_excerpt: string;
    stderr_excerpt: string;
  };
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
  commandEvidence?: Omit<GoalCommandEvidence, "id">;
  delegationEvidence?: Omit<GoalDelegationEvidence, "id">;
  detail?: Omit<GoalEvidenceDetail, "id">;
}

/**
 * Longest host-authored catalog label; the argument summary is presentation, not authority.
 */
const MAX_LABEL_CHARS = 160;

/**
 * Argument keys a catalog label may name, in the order they identify the operation.
 *
 * @remarks These are the observable subject of an operation — the command that ran,
 *   the path a read or write touched, the pattern a search used — rather than its
 *   result. The model already knows the arguments it sent; a successor stage sees a
 *   bounded summary instead of having to correlate an opaque model-chosen call id.
 */
const LABEL_ARGUMENT_KEYS = [
  "command",
  "path",
  "paths",
  "pattern",
  "query",
  "task_id",
  "subagent",
  "monitor_id",
  "name",
  "title",
] as const;

/**
 * Build the short host-authored label of one completed tool call.
 *
 * @param tool - the canonical tool name already resolved from the trace entry.
 * @param args - the call's arguments, which are untrusted observed data.
 * @returns one sanitized, bounded line naming the operation.
 * @remarks The label replaces `<tool>; call <call id>`, which forced manual correlation
 *   with the work and told the model nothing actionable. It names the operation's own
 *   subject instead. This is presentation only: the opaque identifier, its stamped scope
 *   and its digest stay the authority, and a command that exited zero gains no strength
 *   from being described.
 */
function goalEvidenceLabel(tool: string, args: unknown): string {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  for (const key of LABEL_ARGUMENT_KEYS) {
    const value = record[key];
    const subject = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").join(", ")
      : typeof value === "string"
        ? value
        : undefined;
    const trimmed = subject?.replace(/\s+/gu, " ").trim();
    if (trimmed === undefined || trimmed.length === 0) continue;
    const label = `${tool}: ${sanitizeText(trimmed)}`;
    return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS)}…` : label;
  }
  return tool;
}

/** A completed tool envelope is required; native command success additionally requires exit zero. */
function observation(executionId: string, event: TraceEvent): Observation | undefined {
  if (!isBuiltinTraceEvent(event)) return undefined;
  if (event.type === "delegation_completed") {
    const result = sanitizeText(event.result);
    return {
      id: `tool-${goalEvidenceDigest([executionId, "delegate_task", event.delegation_id])}`,
      executionId,
      tool: "delegate_task",
      argumentsDigest: goalEvidenceDigest({
        delegation_id: event.delegation_id,
        ...(event.task_id === undefined ? {} : { task_id: event.task_id }),
      }),
      resultDigest: event.result_digest ?? goalEvidenceDigest(event.result),
      successful: event.status === "completed",
      description: `delegate_task completed; delegation ${event.delegation_id}`.slice(0, 512),
      delegationEvidence: {
        tool: "delegate_task",
        status: "completed",
        result_excerpt: result.slice(0, 4096),
        truncated: result.length > 4096,
      },
    };
  }
  if (event.type !== "tool_call" || !event.call_id) return undefined;
  const tool = event.tool_name ? `${event.mcp_name}.${event.tool_name}` : event.mcp_name;
  if (CONTROL_TOOLS.has(tool)) return undefined;
  if (
    Buffer.byteLength(event.result) > MAX_PAYLOAD_BYTES ||
    Buffer.byteLength(JSON.stringify(event.arguments)) > MAX_PAYLOAD_BYTES
  )
    throw new GoalError("resource_exhausted", "Tool evidence exceeds its payload bound");
  let commandEvidence: Observation["commandEvidence"];
  let successful = event.error === null && event.guard?.outcome !== "denied";
  const receipt = event.tool_evidence;
  if (event.tool_name === "" && (tool === "shell" || tool === "host_exec")) {
    let command:
      | {
          exit_code?: unknown;
          timed_out?: unknown;
          signal?: unknown;
          stdout?: unknown;
          stderr?: unknown;
          stdout_excerpt?: string;
          stderr_excerpt?: string;
        }
      | undefined;
    if (receipt?.kind === "command") {
      successful = successful && receipt.status === "succeeded";
      command = receipt.command;
    } else {
      try {
        command = JSON.parse(event.result) as typeof command;
      } catch {
        successful = false;
      }
      successful =
        successful && command?.exit_code === 0 && command.timed_out !== true && !command.signal;
    }
    if (successful) {
      const args = JSON.stringify(sanitizeDeep(event.arguments, sanitizeText));
      const stdout =
        typeof command?.stdout === "string"
          ? sanitizeText(command.stdout)
          : sanitizeText(command?.stdout_excerpt ?? "");
      const stderr =
        typeof command?.stderr === "string"
          ? sanitizeText(command.stderr)
          : sanitizeText(command?.stderr_excerpt ?? "");
      commandEvidence = {
        tool,
        arguments_excerpt: args.slice(0, 2048),
        exit_code: 0,
        stdout_excerpt: stdout.slice(0, 3072),
        stderr_excerpt: stderr.slice(0, 1024),
        truncated: args.length > 2048 || stdout.length > 3072 || stderr.length > 1024,
      };
    }
  }
  return {
    id: `tool-${goalEvidenceDigest([executionId, event.subagent_instance_id ?? "entry", event.call_id])}`,
    executionId,
    tool,
    argumentsDigest: goalEvidenceDigest(event.arguments),
    resultDigest: event.result_digest ?? goalEvidenceDigest(event.result),
    successful,
    ...(event.diff?.trim() ? { changeDigest: goalEvidenceDigest(event.diff) } : {}),
    description: goalEvidenceLabel(tool, event.arguments).slice(0, 512),
    ...(commandEvidence === undefined ? {} : { commandEvidence }),
    ...(receipt === undefined
      ? {}
      : {
          detail: {
            kind: receipt.kind,
            status: receipt.status,
            digest: event.result_digest ?? goalEvidenceDigest(event.result),
            total_chars: receipt.total_chars,
            excerpt: sanitizeText(receipt.excerpt),
            truncated: receipt.truncated,
            ...(receipt.command === undefined
              ? {}
              : {
                  command: {
                    ...receipt.command,
                    stdout_excerpt: sanitizeText(receipt.command.stdout_excerpt),
                    stderr_excerpt: sanitizeText(receipt.command.stderr_excerpt),
                  },
                }),
          },
        }),
  };
}

export interface GoalEvidenceSnapshot extends GoalEvidenceVerifier {
  readonly generation: number;
  readonly catalog: GoalEvidenceOption[];
  readonly commands: GoalCommandEvidence[];
  readonly delegations: GoalDelegationEvidence[];
  readonly references: GoalEvidenceOption[];
  readonly details: GoalEvidenceDetail[];
  resolve(ids: readonly string[]): GoalEvidenceRef[];
  progress(
    ids: readonly string[],
  ): Pick<GoalCheckpoint, "activity_fingerprint" | "progress_accepted" | "reason">;
  /**
   * Digest of the activity this stage itself observed, or `undefined` when it observed none.
   *
   * @remarks Deliberately restricted to the bound execution's own observations. A
   *   reference recovered from an earlier stage may still support completion, but it
   *   must not be counted again as this stage's progress. The caller compares the
   *   digest with the Goal's whole recorded history, so repeating an earlier stage's
   *   activity — even in a different order or with different wording — is not progress.
   */
  stageActivity(): string | undefined;
}

export interface GoalEvidenceSource {
  /** Observe the host's existing trace path, including child events; never accept guest-selected execution scope. */
  observe(event: TraceEvent): void;
  readonly generation: number;
  snapshot(goal: GoalRecord): Promise<GoalEvidenceSnapshot>;
}

/**
 * Derive evidence from existing trace results and confined file snapshots. The live index retains
 * only bounded digests, metadata and sanitized receipts/details; it is not another authoritative
 * store. Older stage data comes from the caller's owner-scoped trace reader. Missing/evicted proof is
 * never treated as success.
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
                .filter(
                  (event) =>
                    isBuiltinTraceEvent(event) &&
                    (event.type === "tool_call" || event.type === "delegation_completed"),
                )
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
      /**
       * Stable fingerprints of the observable activity these references stand for.
       *
       * @remarks A fingerprint omits call ids, execution ids and output wording, so
       *   repeating the same check — with different prose around it — cannot look like
       *   progress. Artifacts contribute their current path and digest; an observed
       *   workspace change or a criterion's declared verification contributes the tool
       *   and argument digest. Polling and Goal controls never reach this list.
       */
      const activityOf = (ids: readonly string[]): string[] => {
        const changes: string[] = [];
        for (const id of ids) {
          const artifact = artifacts.get(id);
          if (artifact !== undefined) {
            changes.push(goalEvidenceDigest([artifact.path, artifact.digest]));
            continue;
          }
          const item = all.get(id);
          if (item === undefined) continue;
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
        return changes;
      };
      /** One order-independent digest of an activity set, or nothing when it is empty. */
      const fingerprintOf = (changes: readonly string[]): string | undefined => {
        const unique = [...new Set(changes)].sort();
        return unique.length === 0 ? undefined : goalEvidenceDigest(unique);
      };
      const catalog = [...references.values()].slice(-32).map((reference) => ({ ...reference }));
      return {
        generation: capturedGeneration,
        catalog,
        references: [...references.values()].map((reference) => ({ ...reference })),
        details: [...references.values()].flatMap(({ id }) => {
          const detail = all.get(id)?.detail;
          return detail === undefined ? [] : [{ id, ...detail }];
        }),
        commands: [...references.values()].flatMap(({ id }) => {
          const command = all.get(id)?.commandEvidence;
          return command === undefined ? [] : [{ id, ...command }];
        }),
        delegations: [...references.values()].flatMap(({ id }) => {
          const delegation = all.get(id)?.delegationEvidence;
          return delegation === undefined ? [] : [{ id, ...delegation }];
        }),
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
          const changes = activityOf(resolveReferences(ids).map((reference) => reference.id));
          return changes.length === 0
            ? {
                progress_accepted: false,
                reason:
                  "No referenced workspace change or declared verification; prose and polling do not establish progress",
              }
            : {
                activity_fingerprint: fingerprintOf(changes)!,
                progress_accepted: true,
                reason:
                  "Entry attributed observed workspace change or declared verification to the goal; semantic usefulness is not independently verified",
              };
        },
        /** This stage's own activity, never what it merely cited from an earlier stage. */
        stageActivity: () => fingerprintOf(activityOf([...live.keys()])),
      };
    },
  };
}
