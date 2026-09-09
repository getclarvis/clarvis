import type { SkillsProvider } from "@clarvis/loop";
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

/** Host-only admission result; start is single-use and preserves the prepared execution identity. */
export interface PreparedKernelRun {
  executionId: string;
  agent: string;
  model?: string;
  detachable: boolean;
  start(): Promise<RunHandle>;
}

/** Existing kernel services and assembly policy supplied by the owning owner generation. */
export interface PrepareKernelRunOptions {
  configStore: ConfigStore;
  assemblerOptions?: SettingsAssemblerOptions;
  assembleRunRequest?: RunRequestAssembler;
  skills?: SkillsProvider;
  nativeConfigurationRequested(params: StartRunParams): boolean;
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
): PreparedKernelRun {
  const request = structuredClone({
    ...params,
    execution_id: params.execution_id ?? generateExecutionId(),
  });
  const configuration = options.nativeConfigurationRequested(request);
  let agent: string;
  let model: string | undefined;
  let execution: PreparedRunExecution | undefined;
  if (configuration) {
    agent = request.skill!.name;
  } else {
    const snapshot = snapshotRunConfiguration(options.configStore);
    const pluginNames = [...(options.assemblerOptions?.pluginMcpServerNames?.() ?? [])];
    const assemble =
      options.assembleRunRequest ??
      createSettingsRunAssembler(snapshot, {
        ...options.assemblerOptions,
        ...(options.skills === undefined ? {} : { skills: options.skills }),
        pluginMcpServerNames: () => pluginNames,
      });
    const rawBody = structuredClone(assemble(request));
    if (rawBody === null || typeof rawBody !== "object")
      throw kernelError("invalid_request", "prepared run assembler returned no request object");
    const body = rawBody as {
      entry?: unknown;
      profiles?: Array<{ name?: unknown; model?: unknown; grants?: unknown }>;
    };
    if (typeof body.entry !== "string" || !Array.isArray(body.profiles))
      throw kernelError("invalid_request", "prepared run has no entry profile");
    agent = body.entry;
    const profile = body.profiles.find((item) => item.name === agent);
    if (typeof profile?.model !== "string")
      throw kernelError("invalid_request", "prepared run has no entry model");
    model = profile.model;
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
        start: () => options.startWorkflow({ ...request, agent }, prepared),
      };
    } else {
      execution = { kind: "ordinary", rawBody };
    }
  }
  let started = false;
  return {
    executionId: request.execution_id,
    agent,
    ...(model === undefined ? {} : { model }),
    detachable: !configuration,
    async start() {
      if (started) throw kernelError("conflict", "prepared run start was already attempted");
      started = true;
      return options.start(request, execution);
    },
  };
}
