import type { RunRequest, SkillsProvider } from "@clarvis/loop";
import type { RunHandle, StartRunParams } from "@clarvis/protocol";
import { generateExecutionId } from "@clarvis/trace";
import { createAgentWorkflowPolicy } from "../application/workflow-policy.ts";
import type { ConfigStore } from "../config/config-store.ts";
import { kernelError } from "../core/errors.ts";
import type {
  KernelWorkflowsService,
  WorkflowsRuntimeSettings,
} from "../workflows/workflows-service.ts";
import { snapshotRunConfiguration, type RunConfigurationSource } from "./configuration-snapshot.ts";
import type { KernelRunService, RunRequestAssembler, PreparedRunExecution } from "./run-service.ts";
import { createSettingsRunAssembler, type SettingsAssemblerOptions } from "./settings-assembler.ts";
import type { GoalExecutionPolicy } from "../goals/hosted-turn.ts";
import {
  admitContainerCoreRun,
  assertContainerCoreExplicitRequest,
} from "../runtime/container-core-policy.ts";
import { dollarSkillSeeds, userMessagesText } from "../skills/dollar-mentions.ts";

/** Host-only admission result; start is single-use and preserves the prepared execution identity. */
export interface PreparedKernelRun {
  executionId: string;
  agent: string;
  model?: string;
  /** Effective total retained by this prepared request, without starting inference. */
  tokenLimit?: number;
  detachable: boolean;
  start(): Promise<RunHandle>;
}

/** Existing kernel services and assembly policy supplied by the owning owner generation. */
export interface PrepareKernelRunOptions {
  configStore: ConfigStore;
  assemblerOptions?: SettingsAssemblerOptions;
  assembleRunRequest?: RunRequestAssembler;
  skills?: SkillsProvider;
  workflowSettings(source: Pick<RunConfigurationSource, "readSettings">): WorkflowsRuntimeSettings;
  start: KernelRunService["start"];
  startWorkflow: KernelWorkflowsService["runManagerWorkflow"];
}

/**
 * Resolve the actual entry, model, skill seed and profile graph before persisting a hosted intent.
 * Deferred workflow leaders use the same read-only snapshot, including default-spawn policy and
 * plugin MCP provenance. Nothing starts inference or consumes a stream during preparation. The
 * eventual launch still goes through ordinary kernel id, owner and extension-lease admission.
 */
export function prepareKernelRun(
  params: StartRunParams,
  options: PrepareKernelRunOptions,
  goal?: GoalExecutionPolicy,
): PreparedKernelRun {
  const request = structuredClone({
    ...params,
    execution_id: params.execution_id ?? generateExecutionId(),
  });
  let execution: PreparedRunExecution | undefined;
  const snapshot = snapshotRunConfiguration(options.configStore);
  const settings = snapshot.readSettings();
  const backend = settings.merged.runtime?.backend;
  const container = backend === "docker" || backend === "podman";
  if (container) {
    assertContainerCoreExplicitRequest(request, {
      goalRequested: goal !== undefined,
      resolvedSkillMention:
        dollarSkillSeeds(userMessagesText(request.messages), options.skills).length > 0,
    });
  }
  const assemblySource: RunConfigurationSource = container
    ? {
        ...snapshot,
        readSettings: () => {
          if (settings.operator_merged === undefined && (settings.active_plugins?.length ?? 0) > 0)
            throw kernelError(
              "unsupported",
              "Plugin settings provenance is unavailable in Isolation Container. Use Isolation Sandbox or Host.",
              { placement: "container", capability: "Plugins" },
            );
          const merged = structuredClone(settings.operator_merged ?? settings.merged);
          return {
            ...structuredClone(settings),
            merged,
            operator_merged: structuredClone(merged),
            active_plugins: [],
            mcpServerOrigins: Object.fromEntries(
              Object.entries(settings.mcpServerOrigins ?? {}).filter(
                ([, origin]) => origin !== "plugin",
              ),
            ),
          };
        },
      }
    : snapshot;
  const pluginNames = container
    ? []
    : [...(options.assemblerOptions?.pluginMcpServerNames?.() ?? [])];
  const assemble =
    options.assembleRunRequest ??
    createSettingsRunAssembler(assemblySource, {
      ...options.assemblerOptions,
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      pluginMcpServerNames: () => pluginNames,
    });
  const assembled = structuredClone(assemble(request));
  const admitted = container
    ? admitContainerCoreRun({
        params: request,
        assembled,
        source: assemblySource,
        customAssembler: options.assembleRunRequest !== undefined,
        goalRequested: goal !== undefined,
      })
    : assembled;
  const rawBody = goal === undefined ? admitted : goal.constrain(admitted as RunRequest);
  if (rawBody === null || typeof rawBody !== "object")
    throw kernelError("invalid_request", "prepared run assembler returned no request object");
  const body = rawBody as {
    entry?: unknown;
    profiles?: Array<{ name?: unknown; model?: unknown; grants?: unknown }>;
    budget?: { total_token_limit?: number };
  };
  const tokenLimit = body.budget?.total_token_limit;
  if (typeof body.entry !== "string" || !Array.isArray(body.profiles))
    throw kernelError("invalid_request", "prepared run has no entry profile");
  const agent = body.entry;
  const profile = body.profiles.find((item) => item.name === agent);
  if (typeof profile?.model !== "string")
    throw kernelError("invalid_request", "prepared run has no entry model");
  const model = profile.model;
  if (Array.isArray(profile.grants) && profile.grants.includes("workflow")) {
    const policy = createAgentWorkflowPolicy(snapshot);
    const defaultLeader = policy.resolveLeaderDefault(agent);
    const prepared = {
      managerBody: rawBody,
      assembleRunRequest: assemble,
      settings: options.workflowSettings(snapshot),
      leaderProfiles: policy.leaderProfiles(),
      ...(defaultLeader === undefined ? {} : { defaultLeader }),
    };
    execution = {
      kind: "workflow",
      start: (seed, signal) => options.startWorkflow({ ...request, agent }, prepared, seed, signal),
    };
  } else {
    execution = { kind: "ordinary", rawBody, ...(goal === undefined ? {} : { goal }) };
  }
  let started = false;
  return {
    executionId: request.execution_id,
    agent,
    ...(model === undefined ? {} : { model }),
    ...(tokenLimit === undefined ? {} : { tokenLimit }),
    detachable: true,
    async start() {
      if (started) throw kernelError("conflict", "prepared run start was already attempted");
      started = true;
      return options.start(request, execution);
    },
  };
}
