import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CACHE_REPORT_VERSION,
  type CacheScenario,
  type CacheReport,
  type CacheTrial,
  type CacheVerdict,
} from "./types.ts";
import { evaluateCacheAgents, validCacheUsage } from "./evaluation.ts";
import { cacheHash } from "./wire.ts";

const REQUIRED_CHECKPOINTS: Record<CacheScenario, readonly string[]> = {
  C01: [],
  C02: ["plan-completed"],
  C03: ["two-distinct-children", "concurrent-children-and-leader-continuation"],
  C04: [],
  C05: ["cancellation-and-guard-resume"],
  C06: ["durable-memory-indexing"],
  C07: ["process-restart"],
  C08: ["new-result-truncated-before-request"],
  C09: ["actual-compaction", "measured-compaction-input-saving"],
  C10: ["mutation-and-append-control"],
  C11: [
    "tui/FIRST-TURN-VERIFIED",
    "tui/SECOND-TURN-VERIFIED",
    "loaded-installed-bundle",
    "loaded-installed-host",
    "actual-plan-tools",
    "actual-memory-tools",
    "verified-linked-results",
    "ui-session-cache-percentage",
    "process-cleanup",
  ],
};

/** Serialize snapshots in completion order and replace each JSON document atomically. */
export class CacheEvidenceWriter {
  private pending: Promise<void> = Promise.resolve();
  write(path: string, value: unknown): void {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    this.pending = this.pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, path);
    });
    void this.pending.catch(() => undefined);
  }
  async drain(): Promise<void> {
    await this.pending;
  }
}

/** Recompute physical-call verdicts; a runner's exit code or stored aggregate cannot grant approval. */
export function auditCacheTrial(trial: CacheTrial): CacheVerdict {
  trial.agents = evaluateCacheAgents(trial.calls);
  const diagnostic = (value: string) => {
    if (!trial.diagnostics.includes(value)) trial.diagnostics.push(value);
  };
  for (const name of REQUIRED_CHECKPOINTS[trial.scenario])
    if (!trial.checkpoints.some((checkpoint) => checkpoint.name === name))
      diagnostic(`missing_checkpoint:${name}`);
  if (
    trial.scenario !== "C11" &&
    !trial.checkpoints.some((checkpoint) => checkpoint.name.startsWith("cursor/"))
  )
    diagnostic("missing_cursor_checkpoint");
  if (
    !trial.accounting?.length ||
    trial.accounting.some((entry) => !entry.reconciled || entry.unknownUsageCalls > 0)
  )
    diagnostic("missing_or_unreconciled_accounting");
  if (
    trial.calls.some(
      (call) =>
        !call.executionId ||
        !trial.accounting?.some((entry) => entry.executionId === call.executionId),
    )
  )
    diagnostic("unaccounted_physical_call");
  for (const account of trial.accounting ?? []) {
    const physical = trial.calls.filter((call) => call.executionId === account.executionId);
    const totals = physical.reduce(
      (sum, call) => ({
        input: sum.input + (call.usage?.input ?? 0),
        cached: sum.cached + (call.usage?.cached ?? 0),
        output: sum.output + (call.usage?.output ?? 0),
      }),
      { input: 0, cached: 0, output: 0 },
    );
    if (
      physical.length !== account.physicalCalls ||
      physical.some((call) => !validCacheUsage(call.usage)) ||
      !validCacheUsage(account.usage) ||
      totals.input !== account.usage.input ||
      totals.cached !== account.usage.cached ||
      totals.output !== account.usage.output
    )
      diagnostic("physical_trace_usage_mismatch");
  }
  if (trial.scenario === "C04" && !trial.calls.some((call) => call.transition === "new-turn"))
    diagnostic("missing_new_turn_transition");
  for (const call of trial.calls) {
    if (
      call.scenario !== trial.scenario ||
      call.trial !== trial.trial ||
      call.requestedModel !== trial.model
    )
      diagnostic("call_attribution_mismatch");
    if (call.usage !== undefined && !validCacheUsage(call.usage)) diagnostic("invalid_usage");
    const expectedEffort = call.purpose === "compaction" ? undefined : "medium";
    if (call.requestedEffort !== expectedEffort) diagnostic("requested_effort_mismatch");
    if (call.serializedModel !== trial.model) diagnostic("serialized_model_mismatch");
    if (call.serializedEffort !== expectedEffort) diagnostic("serialized_effort_mismatch");
    if (
      call.purpose !== "compaction" &&
      call.effectiveEffort !== undefined &&
      call.effectiveEffort !== "medium"
    )
      diagnostic("effective_effort_mismatch");
    if (call.resolvedModel !== undefined && call.resolvedModel !== trial.model)
      diagnostic("resolved_model_mismatch");
    if (call.endpoint !== "https://chatgpt.com/backend-api/codex/responses")
      diagnostic("required_subscription_endpoint_missing");
    if (call.sessionHeaderHash !== cacheHash(call.keyHash))
      diagnostic("subscription_affinity_mismatch");
    if (call.endedAt < call.startedAt) diagnostic("invalid_call_interval");
  }
  const agents = new Map<string, Set<string>>();
  for (const call of trial.calls) {
    const id = JSON.stringify([call.sessionId, call.agentInstanceId]);
    const keys = agents.get(id) ?? new Set<string>();
    keys.add(call.keyHash);
    agents.set(id, keys);
  }
  if ([...agents.values()].some((keys) => keys.size !== 1))
    diagnostic("regenerated_conversation_identity");
  if (new Set([...agents.values()].flatMap((keys) => [...keys])).size !== agents.size)
    diagnostic("shared_conversation_identity");
  const failed =
    trial.agents.some((agent) => agent.verdict === "fail") ||
    trial.checkpoints.some((checkpoint) => checkpoint.verdict === "fail");
  const diagnostics = trial.diagnostics.filter((item) => !item.startsWith("evidence_directory:"));
  trial.verdict = failed
    ? "fail"
    : trial.agents.length > 0 &&
        trial.agents.every((agent) => agent.verdict === "pass") &&
        trial.checkpoints.length > 0 &&
        trial.checkpoints.every((checkpoint) => checkpoint.verdict === "pass") &&
        diagnostics.length === 0
      ? "pass"
      : "incomplete";
  return trial.verdict;
}

/** Check matrix completeness and bind full qualification to the actually loaded artifact. */
export function auditCacheReport(report: CacheReport, completeQualification = false): CacheVerdict {
  if (report.schemaVersion !== CACHE_REPORT_VERSION)
    throw new Error("unsupported_cache_report_version");
  const expected = report.expected.flatMap((entry) =>
    Array.from(
      { length: entry.trials },
      (_, trial) => `${entry.model}/${entry.scenario}/${trial + 1}`,
    ),
  );
  const executed = report.trials.map((trial) => `${trial.model}/${trial.scenario}/${trial.trial}`);
  const matrixComplete =
    new Set(expected).size === expected.length &&
    new Set(executed).size === executed.length &&
    expected.length === executed.length &&
    expected.every((key) => executed.includes(key));
  const verdicts = report.trials.map(auditCacheTrial);
  let artifactComplete = true;
  if (completeQualification) {
    const required = [
      "C01",
      "C02",
      "C03",
      "C04",
      "C05",
      "C06",
      "C07",
      "C08",
      "C09",
      "C10",
      "C11",
    ].map((scenario) => `gpt-6-astra/${scenario}`);
    required.push(...["C01", "C02", "C04"].map((scenario) => `gpt-5.6-sol/${scenario}`));
    artifactComplete =
      required.every((key) =>
        report.expected.some(
          (entry) => `${entry.model}/${entry.scenario}` === key && entry.trials === 3,
        ),
      ) &&
      report.artifact !== undefined &&
      report.artifact.bundleHash === report.artifact.loadedBundleHash &&
      /^[a-f0-9]{64}$/.test(report.artifact.archiveHash) &&
      report.trials.every(
        (trial) =>
          trial.artifactHash === report.artifact.archiveHash &&
          (trial.scenario !== "C11" || trial.loadedBundleHash === report.artifact.bundleHash),
      );
  }
  report.verdict = verdicts.includes("fail")
    ? "fail"
    : matrixComplete &&
        artifactComplete &&
        verdicts.length > 0 &&
        verdicts.every((verdict) => verdict === "pass") &&
        report.diagnostics.length === 0
      ? "pass"
      : "incomplete";
  return report.verdict;
}
