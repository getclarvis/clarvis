/**
 * The `run_work_items` tool: hand the runtime a discovery round's `work_items[]`
 * and let it derive the execution.
 *
 * @remarks This is where the manager stops scheduling. {@link scheduleWorkItems}
 * turns the batch into waves — ordering by `dependencies`, and separating items
 * whose `files` conflict — and a {@link beginDispatch | dispatch session} walks
 * those waves. Nothing about the order or the parallelism is re-decided by the
 * model, and the write-conflict rule the shipped prompt used to ask for in prose
 * is now an invariant.
 *
 * Each item is still an ordinary leader run: it registers in the same supervision
 * registry, answers to the same `agent_list` / `agent_poll` / `agent_steer` /
 * `agent_stop`, and records the same `workflow_run_*` trace events the kernel
 * projects into `WorkflowRecord.edges`. Supervision and the UI are unchanged.
 */
import type {
  AgentBuildContext,
  AgentRegistryPort,
  ComputeClock,
  HandlerVerdict,
  NamespacedTool,
  ToolHandler,
} from "@clarvis/capability";
import { parseTaskTitle, TASK_TITLE_MAX } from "@clarvis/capability";
import {
  beginDispatch,
  describeQueued,
  type DispatchDeps,
  type DispatchOutcome,
  type DispatchStatus,
  type DispatchUnit,
} from "./dispatch.ts";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";
import { workflowLogger } from "./log.ts";
import { reportScheduleDerived, reportScheduleRefused } from "./schedule-log.ts";
import { scheduleWorkItems, type ScheduleWave, type WorkItem } from "./schedule.ts";
import type { LeaderProfileInfo } from "./tool.ts";
import type { WorkflowCtx } from "./types.ts";

/** The `run_work_items` wire/tool name. */
export const RUN_WORK_ITEMS_TOOL_NAME = "run_work_items";

const RUN_WORK_ITEMS_DESCRIPTION =
  "Run a whole batch of work items as leaders, scheduled for you. Hand it the work_items[] a " +
  "discovery round returned: the runtime orders them by their dependencies and runs everything " +
  "that can safely run at once, keeping apart any two items whose files would collide while one " +
  "of them writes. Prefer this to issuing the run_leader calls yourself — you do not have to " +
  "work out the order, the batching, or the write conflicts. Returns immediately with the wave " +
  "plan; collect the leaders with await_agents or agent_poll.";

/** A parsed `run_work_items` call. */
interface WorkItemsCall {
  items: readonly WorkItem[];
  profile?: string;
  briefPrefix?: string;
  expectSchema?: Record<string, unknown>;
}

/**
 * Build the `run_work_items` tool.
 *
 * @param profiles - the registered leader profiles; when non-empty, adds the same
 *   `profile` selector `run_leader` carries, applied to every item in the batch.
 * @returns the {@link NamespacedTool} describing `run_work_items`.
 */
export function buildRunWorkItemsTool(profiles?: readonly LeaderProfileInfo[]): NamespacedTool {
  const properties: Record<string, unknown> = {
    items: {
      type: "array",
      minItems: 1,
      maxItems: WORKFLOW_LIMITS.workItems,
      description:
        "The work items to run, exactly as a discovery round returned them. Declare 'files' and " +
        "'mutation' honestly: they are what lets the runtime prove two items are safe to run at " +
        "the same time. An item that writes but declares no files is treated as writing " +
        "everything, and will be run alone.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            minLength: 1,
            maxLength: WORKFLOW_LIMITS.identifierChars,
            description: "Unique within this batch.",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: TASK_TITLE_MAX,
            description:
              "Short human-facing label for this leader; keep the full instruction in 'goal'.",
          },
          goal: {
            type: "string",
            minLength: 1,
            maxLength: WORKFLOW_LIMITS.textChars,
            description: "The item's task; becomes the leader's brief.",
          },
          files: {
            type: "array",
            maxItems: WORKFLOW_LIMITS.filesPerWorkItem,
            items: { type: "string", maxLength: WORKFLOW_LIMITS.pathChars },
            description: "Files this item would read or change.",
          },
          dependencies: {
            type: "array",
            maxItems: WORKFLOW_LIMITS.dependenciesPerWorkItem,
            items: { type: "string", maxLength: WORKFLOW_LIMITS.identifierChars },
            description: "Ids of items in this batch that must finish first.",
          },
          mutation: {
            type: "boolean",
            description: "True when the item writes to the workspace.",
          },
        },
        required: ["id", "title", "goal", "files", "dependencies", "mutation"],
      },
    },
  };
  if (profiles !== undefined && profiles.length > 0) {
    properties.profile = {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.identifierChars,
      enum: profiles.map((p) => p.name),
      description:
        "OPTIONAL — the agent profile every leader in this batch runs as. Available profiles — " +
        profiles.map((p) => `${p.name}: ${p.description ?? "(no description)"}`).join("; "),
    };
  }
  properties.brief_prefix = {
    type: "string",
    maxLength: WORKFLOW_LIMITS.textChars,
    description:
      "OPTIONAL — shared context prepended to every item's brief: the overall goal, the " +
      "constraints, and what a successful result looks like.",
  };
  properties.expect_schema = {
    type: "object",
    description:
      "OPTIONAL — a JSON Schema; when set, every leader in the batch must return a structured " +
      "result matching it instead of free text.",
  };
  return {
    fullName: RUN_WORK_ITEMS_TOOL_NAME,
    wireName: RUN_WORK_ITEMS_TOOL_NAME,
    mcpName: "",
    toolName: RUN_WORK_ITEMS_TOOL_NAME,
    description: RUN_WORK_ITEMS_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required: ["items"],
    },
  };
}

/** Read a value as an array of strings, or `null` when it is neither. */
function stringArray(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > maxItems) return null;
  if (!value.every((entry) => isBoundedWorkflowString(entry, maxChars))) return null;
  return value;
}

/** Read one array entry as a {@link WorkItem}, or `null` when it is malformed. */
export function toWorkItem(entry: unknown): WorkItem | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const files = stringArray(
    record.files,
    WORKFLOW_LIMITS.filesPerWorkItem,
    WORKFLOW_LIMITS.pathChars,
  );
  const dependencies = stringArray(
    record.dependencies,
    WORKFLOW_LIMITS.dependenciesPerWorkItem,
    WORKFLOW_LIMITS.identifierChars,
  );
  if (!isBoundedWorkflowString(record.title, TASK_TITLE_MAX * 2)) return null;
  const title = parseTaskTitle(record.title);
  if (
    !isBoundedWorkflowString(record.id, WORKFLOW_LIMITS.identifierChars) ||
    record.id.length === 0 ||
    !title.ok ||
    !isBoundedWorkflowString(record.goal, WORKFLOW_LIMITS.textChars) ||
    record.goal.length === 0 ||
    typeof record.mutation !== "boolean" ||
    files === null ||
    dependencies === null
  ) {
    return null;
  }
  return {
    id: record.id,
    title: title.title,
    goal: record.goal,
    files,
    dependencies,
    mutation: record.mutation,
  };
}

/** Parse a `run_work_items` call, or explain to the manager what was wrong with it. */
function parseWorkItemsCall(args: unknown): { call: WorkItemsCall } | { error: string } {
  if (typeof args !== "object" || args === null) {
    return { error: "expected an object with an 'items' array." };
  }
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record.items)) {
    return { error: "'items' is required and must be an array of work items." };
  }
  if (record.items.length > WORKFLOW_LIMITS.workItems) {
    return {
      error: `'items' must contain no more than ${String(WORKFLOW_LIMITS.workItems)} work items.`,
    };
  }
  const items: WorkItem[] = [];
  for (const [index, entry] of record.items.entries()) {
    const item = toWorkItem(entry);
    if (item === null) {
      return {
        error:
          `items[${String(index)}] is malformed: each item needs a short single-line 'title', ` +
          "non-empty 'id' and 'goal', string arrays 'files' and 'dependencies', and a boolean " +
          "'mutation'.",
      };
    }
    items.push(item);
  }
  const call: WorkItemsCall = { items };
  if (record.profile !== undefined) {
    if (
      !isBoundedWorkflowString(record.profile, WORKFLOW_LIMITS.identifierChars) ||
      record.profile.length === 0
    ) {
      return {
        error:
          "'profile' must be a non-empty string no longer than " +
          `${String(WORKFLOW_LIMITS.identifierChars)} characters.`,
      };
    }
    call.profile = record.profile;
  }
  if (record.brief_prefix !== undefined) {
    if (!isBoundedWorkflowString(record.brief_prefix, WORKFLOW_LIMITS.textChars)) {
      return {
        error:
          "'brief_prefix' must be a string no longer than " +
          `${String(WORKFLOW_LIMITS.textChars)} characters.`,
      };
    }
    if (record.brief_prefix.length > 0) call.briefPrefix = record.brief_prefix;
  }
  if (typeof record.expect_schema === "object" && record.expect_schema !== null) {
    call.expectSchema = record.expect_schema as Record<string, unknown>;
  }
  const oversized = items.findIndex(
    (item) => workItemBrief(item, call.briefPrefix).length > WORKFLOW_LIMITS.textChars,
  );
  if (oversized !== -1) {
    return {
      error:
        `items[${String(oversized)}] renders a brief longer than ` +
        `${String(WORKFLOW_LIMITS.textChars)} characters.`,
    };
  }
  return { call };
}

/**
 * Build one item's leader brief.
 *
 * @remarks The file scope and the read/write posture are appended from the item's
 *   own declaration, so the brief states the ownership boundary the scheduler
 *   just enforced rather than leaving the leader to guess it.
 */
export function workItemBrief(item: WorkItem, prefix?: string): string {
  const scope =
    item.files.length === 0
      ? "No files were declared in scope for this item."
      : `Files in scope for this item: ${item.files.join(", ")}.`;
  const posture = item.mutation
    ? "This item may modify the workspace; stay within the files above."
    : "This item is read-only: do not modify the workspace.";
  const parts = [prefix, item.goal, `${scope} ${posture}`];
  return parts.filter((part): part is string => part !== undefined).join("\n\n");
}

/** Project one scheduled wave into the units the dispatch session runs. */
function unitsForWave(wave: ScheduleWave, call: WorkItemsCall): DispatchUnit[] {
  return wave.items.map((item) => ({
    key: item.id,
    title: item.title,
    brief: workItemBrief(item, call.briefPrefix),
    ...(call.profile !== undefined ? { profile: call.profile } : {}),
    ...(call.expectSchema !== undefined ? { expectSchema: call.expectSchema } : {}),
  }));
}

/** Render the wave plan handed back to the manager the moment the batch starts. */
function describePlan(
  waves: readonly ScheduleWave[],
  handles: ReadonlyMap<string, string>,
  queued: number,
): string {
  const shape = waves
    .map((wave, index) => `wave ${String(index + 1)}: ${wave.items.map((i) => i.id).join(", ")}`)
    .join("; ");
  const started = [...handles].map(([id, agentId]) => `${id}=${agentId}`).join(", ");
  const total = waves.reduce((n, wave) => n + wave.items.length, 0);
  return (
    `scheduled ${String(total)} work item(s) into ${String(waves.length)} wave(s) — ${shape}. ` +
    `Wave 1 is running now: ${started}.${describeQueued(queued)} ` +
    "Later waves start as their dependencies clear. " +
    "Keep working, then collect them with await_agents (to wait) or agent_poll (to look). " +
    "Do not finish until they have returned."
  );
}

/** Render the one-line tally the last child of the batch carries back. */
function describeSummary(outcomes: readonly DispatchOutcome[]): string {
  const tally = new Map<DispatchStatus, string[]>();
  for (const outcome of outcomes) {
    tally.set(outcome.status, [...(tally.get(outcome.status) ?? []), outcome.key]);
  }
  const parts = [...tally].map(([status, ids]) => `${status}: ${ids.join(", ")}`);
  return `work item batch finished — ${parts.join("; ")}`;
}

/**
 * Build the `run_work_items` tool handler.
 *
 * @remarks Like `run_leader` this answers with an immediate `kind: "result"` and
 *   never a `deferred` one: `runDispatch` joins deferred verdicts in its own
 *   `finally`, which would take the manager dark for the length of the batch.
 *   The wave-boundary invariant that keeps the manager from finishing on top of a
 *   half-run graph lives in {@link beginDispatch}.
 */
export function buildRunWorkItemsHandler(
  ctx: WorkflowCtx,
  bc: AgentBuildContext,
  clock: ComputeClock | undefined,
  agents: AgentRegistryPort,
): ToolHandler {
  const deps: DispatchDeps = { ctx, bc, clock, agents };
  const logger = workflowLogger(ctx);
  return {
    matches: (call) => call.name === RUN_WORK_ITEMS_TOOL_NAME,
    handle(call): Promise<HandlerVerdict> {
      const parsed = parseWorkItemsCall(call.arguments);
      if ("error" in parsed) return Promise.resolve(verdict(parsed.error));

      const schedule = scheduleWorkItems(parsed.call.items);
      if (!schedule.ok) {
        reportScheduleRefused(logger, schedule);
        return Promise.resolve(
          verdict(`cannot schedule this batch (${schedule.code}) — ${schedule.message}`),
        );
      }
      reportScheduleDerived(logger, parsed.call.items, schedule.waves);
      const [firstWave, ...laterWaves] = schedule.waves;
      if (firstWave === undefined) {
        return Promise.resolve(verdict("'items' was empty; there is nothing to run."));
      }

      const session = beginDispatch(deps, unitsForWave(firstWave, parsed.call));
      if (session === null) {
        return Promise.resolve(
          verdict(
            "not starting this batch — too many child agents are already running. Wait with " +
              "await_agents or end one with agent_stop, then try again.",
          ),
        );
      }
      /**
       * The wave-1 handles and the queued tail, read before the driver starts.
       *
       * @remarks Both reads must happen here: the driver's first `run` takes the
       * pending batch, so a later read reports an empty queue.
       */
      const handles = session.pendingHandles();
      const queued = session.queuedCount();

      const driver = (async (): Promise<void> => {
        const outcomes: DispatchOutcome[] = [];
        const done = new Map<string, DispatchStatus>();
        const dependencies = new Map(parsed.call.items.map((i) => [i.id, i.dependencies]));
        const gate = (unit: DispatchUnit): { blocked: string } | null => {
          const blocker = (dependencies.get(unit.key) ?? []).find(
            (id) => done.get(id) !== "completed",
          );
          return blocker === undefined ? null : { blocked: `'${blocker}' did not finish` };
        };

        for (const wave of laterWaves) {
          for (const outcome of await session.run(gate)) {
            outcomes.push(outcome);
            done.set(outcome.key, outcome.status);
          }
          if (session.cancelled()) break;
          session.advance(unitsForWave(wave, parsed.call));
        }
        if (!session.cancelled()) {
          for (const outcome of await session.run(gate)) {
            outcomes.push(outcome);
            done.set(outcome.key, outcome.status);
          }
        }
        session.end(describeSummary(outcomes));
      })();
      agents.adopt(session.anchorId, driver);

      return Promise.resolve({
        kind: "result",
        text:
          `Tool '${RUN_WORK_ITEMS_TOOL_NAME}' result: ` +
          describePlan(schedule.waves, handles, queued),
        progress: true,
      });
    },
  };
}

/** A non-terminal, immediate textual verdict prefixed as a `run_work_items` result. */
function verdict(text: string): HandlerVerdict {
  return {
    kind: "result",
    text: `Tool '${RUN_WORK_ITEMS_TOOL_NAME}' result: ${text}`,
    progress: false,
  };
}
