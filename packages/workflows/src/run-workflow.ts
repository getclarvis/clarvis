/**
 * The `run_workflow` tool: run an available workflow by name.
 *
 * @remarks A workflow definition is a round sequence that was authored and
 * reviewed rather than composed in a turn, so it compiles straight into the
 * {@link RoundCall} `run_round` already executes. Definitions may be built into
 * Clarvis or supplied as operator-authored documents; there is one executor and
 * one set of guarantees behind both.
 *
 * `explain` exists because fan-out multiplies cost quietly: a `fanout: 3` round
 * over twenty findings is sixty leaders. A workflow that runs out of budget
 * halfway is worse than one that declines to start, so the cost has to be
 * inspectable before it is spent.
 */
import type {
  AgentBuildContext,
  AgentRegistryPort,
  ComputeClock,
  Elicit,
  HandlerVerdict,
  NamespacedTool,
  ToolHandler,
} from "@clarvis/capability";
import { elicitWithClockPause } from "@clarvis/capability";
import type { WorkflowDefinition } from "./artifact.ts";
import type { DispatchDeps } from "./dispatch.ts";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";
import { workflowLogger } from "./log.ts";
import {
  startRounds,
  type RoundCall,
  type RoundCoordinator,
  type RoundInput,
} from "./run-round.ts";
import type { WorkflowCtx } from "./types.ts";

/** The `run_workflow` wire/tool name. */
export const RUN_WORKFLOW_TOOL_NAME = "run_workflow";

type WorkflowReviewDecision = "run" | "declined" | "dismissed" | "no_response" | "invalid_response";

const RUN_WORKFLOW_DESCRIPTION =
  "Run an installed round sequence by name. explain:true previews its structure and leader-count " +
  "formula without starting work; data-dependent fan-out is not known yet. Otherwise, human " +
  "preflight is required before the first round starts. Later rounds require workflow_decide.";

/**
 * Build the `run_workflow` tool.
 *
 * @param workflows - the loaded definitions, used to populate the `name` enum and
 *   its catalogue. Returns `null` when the workspace has no workflows, so the
 *   model is never offered a tool whose only argument has no legal value.
 */
export function buildRunWorkflowTool(
  workflows: readonly WorkflowDefinition[],
): NamespacedTool | null {
  if (workflows.length === 0) return null;
  return {
    fullName: RUN_WORKFLOW_TOOL_NAME,
    wireName: RUN_WORKFLOW_TOOL_NAME,
    mcpName: "",
    toolName: RUN_WORKFLOW_TOOL_NAME,
    description: RUN_WORKFLOW_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: WORKFLOW_LIMITS.identifierChars,
          enum: workflows.map((w) => w.name),
          description:
            "The workflow to run. Available — " +
            workflows
              .map((w) => `${w.name} (args: ${w.args.join(", ") || "none"}): ${w.description}`)
              .join("; "),
        },
        args: {
          type: "object",
          maxProperties: WORKFLOW_LIMITS.args,
          propertyNames: { maxLength: WORKFLOW_LIMITS.identifierChars },
          description:
            "Values for every argument declared by the selected workflow in the name catalog.",
        },
        explain: {
          type: "boolean",
          description:
            "OPTIONAL — describe the rounds and the fan-out cost without running anything.",
        },
      },
    },
  };
}

/** Compile a loaded workflow plus its arguments into a runnable round sequence. */
function toRoundCall(
  workflow: WorkflowDefinition,
  args: Record<string, unknown>,
): { call: RoundCall } | { error: string } {
  if (workflow.rounds.length === 0 || workflow.rounds.length > WORKFLOW_LIMITS.rounds) {
    return {
      error: `workflow '${workflow.name}' must contain 1-${String(WORKFLOW_LIMITS.rounds)} rounds`,
    };
  }
  if (
    workflow.args.length > WORKFLOW_LIMITS.args ||
    workflow.args.some((name) => !isBoundedWorkflowString(name, WORKFLOW_LIMITS.identifierChars))
  ) {
    return {
      error: `workflow '${workflow.name}' declares more or larger arguments than the workflow limits allow`,
    };
  }
  if (!isBoundedWorkflowString(workflow.synthesis, WORKFLOW_LIMITS.textChars)) {
    return {
      error:
        `workflow '${workflow.name}' synthesis exceeds the ` +
        `${String(WORKFLOW_LIMITS.textChars)} character limit`,
    };
  }
  const missing = workflow.args.filter((name) => args[name] === undefined);
  if (missing.length > 0) {
    return {
      error: `workflow '${workflow.name}' needs these args, which were not supplied: ${missing.join(", ")}`,
    };
  }
  const rounds: RoundInput[] = workflow.rounds.map((round) => ({
    id: round.id,
    type: round.type,
    over: round.over,
    title: round.title,
    brief: round.brief,
    fanout: round.fanout,
    ...(round.profile === undefined ? {} : { profile: round.profile }),
    ...(round.accept === undefined ? {} : { accept: round.accept }),
    ...(round.when === undefined ? {} : { when: round.when }),
  }));
  return {
    call: { rounds, args, ...(workflow.repeat === undefined ? {} : { repeat: workflow.repeat }) },
  };
}

/**
 * Describe what a workflow would do and what it would cost, without running it.
 *
 * @remarks The leader count for an `each` round is not knowable in advance — it
 *   is one per item the producing round returns. Saying so is the honest answer;
 *   inventing a number would be worse than the uncertainty it hides.
 */
export function explainWorkflow(workflow: WorkflowDefinition): string {
  const lines = workflow.rounds.map((round) => {
    const shape =
      round.over.kind === "once"
        ? "1 leader"
        : round.over.kind === "all"
          ? "1 leader over the whole set"
          : `1 leader per item of ${round.over.source}`;
    const replicas = round.fanout > 1 ? `, ×${String(round.fanout)} replicas each` : "";
    const gate = round.when === undefined ? "" : `, only if ${round.when} is non-empty`;
    const rule = round.accept === undefined ? "" : `, accepted by ${round.accept.kind}`;
    return `  ${round.id} (${round.type}): ${shape}${replicas}${gate}${rule}`;
  });
  const fixed = workflow.rounds
    .filter((r) => r.over.kind !== "each")
    .reduce((n, r) => n + r.fanout, 0);
  const perItem = workflow.rounds
    .filter((r) => r.over.kind === "each")
    .map((r) => `${r.id} ×${String(r.fanout)}`);
  const repeat =
    workflow.repeat === undefined
      ? ""
      : `\nRepeat: [${workflow.repeat.rounds.join(", ")}] up to ${String(
          workflow.repeat.max_rounds,
        )} more pass(es), stopping after ${String(workflow.repeat.dry_rounds ?? 2)} that find nothing new.`;
  const cost =
    perItem.length === 0
      ? `\nCost: ${String(fixed)} leader(s).`
      : `\nCost: ${String(fixed)} fixed leader(s), plus one per item for ${perItem.join(", ")}` +
        ` — so the total scales with what the earlier rounds return.${
          workflow.repeat === undefined ? "" : " Each repeat pass costs that again."
        }`;
  return `${workflow.name}: ${workflow.description}\n${lines.join("\n")}${repeat}${cost}`;
}

/** Parse a `run_workflow` call. */
function parseCall(
  args: unknown,
): { name: string; args: Record<string, unknown>; explain: boolean } | { error: string } {
  if (typeof args !== "object" || args === null) {
    return { error: "expected an object with a 'name'." };
  }
  const record = args as Record<string, unknown>;
  if (
    !isBoundedWorkflowString(record.name, WORKFLOW_LIMITS.identifierChars) ||
    record.name.length === 0
  ) {
    return { error: "'name' is required and must name an available workflow." };
  }
  let workflowArgs: Record<string, unknown> = {};
  if (record.args !== undefined) {
    if (typeof record.args !== "object" || record.args === null || Array.isArray(record.args)) {
      return { error: "'args' must be an object when supplied." };
    }
    workflowArgs = record.args as Record<string, unknown>;
    const entries = Object.entries(workflowArgs);
    if (entries.length > WORKFLOW_LIMITS.args) {
      return {
        error: `'args' must contain no more than ${String(WORKFLOW_LIMITS.args)} properties.`,
      };
    }
    for (const [name, value] of entries) {
      if (name.length === 0 || name.length > WORKFLOW_LIMITS.identifierChars) {
        return { error: "'args' contains an oversized property name." };
      }
      if (typeof value === "string" && value.length > WORKFLOW_LIMITS.textChars) {
        return { error: `'args.${name}' exceeds the workflow string limit.` };
      }
    }
  }
  return {
    name: record.name,
    args: workflowArgs,
    explain: record.explain === true,
  };
}

/**
 * Build the `run_workflow` tool handler.
 *
 * @param workflows - the available loaded definitions.
 */
export function buildRunWorkflowHandler(
  ctx: WorkflowCtx,
  bc: AgentBuildContext,
  clock: ComputeClock | undefined,
  agents: AgentRegistryPort,
  workflows: readonly WorkflowDefinition[],
  elicit?: Elicit,
  signal?: AbortSignal,
  coordinator?: RoundCoordinator,
): ToolHandler {
  const deps: DispatchDeps = { ctx, bc, clock, agents };
  const byName = new Map(workflows.map((w) => [w.name, w]));
  return {
    matches: (call) => call.name === RUN_WORKFLOW_TOOL_NAME,
    async handle(call): Promise<HandlerVerdict> {
      const parsed = parseCall(call.arguments);
      if ("error" in parsed) return verdict(parsed.error, false);

      const workflow = byName.get(parsed.name);
      if (workflow === undefined) {
        return verdict(
          `no workflow named '${parsed.name}'; available workflows: ` +
            `${[...byName.keys()].join(", ")}`,
          false,
        );
      }
      if (parsed.explain) return verdict(explainWorkflow(workflow), false);

      const compiled = toRoundCall(workflow, parsed.args);
      if ("error" in compiled) return verdict(compiled.error, false);
      if (elicit === undefined || clock === undefined) {
        return verdict(
          `workflow '${workflow.name}' was not started because no interactive approval channel is available. Use explain: true to inspect it.`,
          false,
        );
      }
      const reviewStartedAt = Date.now();
      const decision = await elicitWithClockPause(
        clock,
        signal ?? ctx.signal,
        () =>
          elicit(
            {
              kind: "workflow_review",
              message:
                `Review this workflow before it starts. No leader has been launched yet.\n\n` +
                explainWorkflow(workflow),
              requestedSchema: {
                type: "object",
                properties: {
                  decision: {
                    type: "string",
                    enum: ["cancel", "run"],
                    description: "Run this workflow or leave the run unchanged.",
                  },
                },
                required: ["decision"],
              },
            },
            { signal: signal ?? ctx.signal, timeoutMs: ctx.elicitWaitMs },
          ),
        {
          onResult: (raw): WorkflowReviewDecision => {
            if (raw.action === "decline") return "declined";
            if (raw.action === "cancel") return "dismissed";
            if (raw.content?.decision === "run") return "run";
            if (raw.content?.decision === "cancel") return "declined";
            return "invalid_response";
          },
          onNoResponse: (): WorkflowReviewDecision => "no_response",
        },
        { logger: workflowLogger(ctx) },
      );
      workflowLogger(ctx).info(
        {
          event: "workflow.review_resolved",
          workflow: workflow.name,
          decision,
          waited_ms: Date.now() - reviewStartedAt,
        },
        "the workflow preflight settled; its explicit outcome is also returned to the manager",
      );
      if (decision !== "run") {
        return verdict(describeReviewRefusal(workflow.name, decision), false);
      }
      const started = startRounds(deps, compiled.call, coordinator);
      if ("error" in started) return verdict(started.error, false);
      return verdict(
        `running workflow '${workflow.name}'. ${started.text}\n\n` +
          "At every checkpoint, decide whether the evidence justifies the proposed next round; " +
          "the runtime will not continue it for you. When the sequence is completed or stopped, " +
          `synthesize the result as this workflow asks:\n` +
          workflow.synthesis,
        true,
      );
    },
  };
}

/** Describe why a reviewed workflow did not start without collapsing distinct operator outcomes. */
function describeReviewRefusal(
  workflowName: string,
  decision: Exclude<WorkflowReviewDecision, "run">,
): string {
  switch (decision) {
    case "declined":
      return `workflow '${workflowName}' was not started because its approval review was declined.`;
    case "dismissed":
      return `workflow '${workflowName}' was not started because its approval review was dismissed.`;
    case "no_response":
      return `workflow '${workflowName}' was not started because its approval review timed out without a response.`;
    case "invalid_response":
      return `workflow '${workflowName}' was not started because its approval review returned an invalid response.`;
  }
}

/** An immediate textual verdict prefixed as a `run_workflow` result. */
function verdict(text: string, progress: boolean): HandlerVerdict {
  return {
    kind: "result",
    text: `Tool '${RUN_WORKFLOW_TOOL_NAME}' result: ${text}`,
    progress,
  };
}
