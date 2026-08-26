import {
  CREATE_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  TRANSITION_PLAN_TASK_TOOL_NAME,
  planToolDefinitions,
  revisePlanInputSchema,
} from "../tools.ts";
import {
  MAX_PLAN_ASSIGNEE_CHARS,
  MAX_PLAN_BATCH_OPERATIONS,
  MAX_PLAN_LOCATOR_CHARS,
  MAX_PLAN_SECTION_CHARS,
  MAX_PLAN_TASK_FIELD_CHARS,
  MAX_PLAN_TASKS,
  MAX_PLAN_TITLE_CHARS,
  MAX_PLAN_VALIDATION_ITEMS,
} from "../limits.ts";
import {
  planTaskStatusSchema,
  singleLineSchema,
  taskTitleSchema,
  type PlanDocument,
} from "../schemas.ts";
import { z } from "zod";
import {
  NOOP_LOGGER,
  sanitizeErrorMessage,
  type Logger,
  type NamespacedTool,
} from "@clarvis/capability";
import type { MissingPlanState, PlanSession } from "./session.ts";

export {
  CREATE_PLAN_TOOL_NAME,
  LIST_PLANS_TOOL_NAME,
  READ_PLAN_TOOL_NAME,
  REVISE_PLAN_TOOL_NAME,
  TRANSITION_PLAN_TASK_TOOL_NAME,
};

/**
 * The sentence appended to `create_plan`'s description when the run requires
 * human plan review.
 *
 * @remarks Until this existed, the review contract was stated in exactly one
 *   place a model might read — `delegate_task`'s description — so a Lead that
 *   never delegated never learned it. Two failures were measured against the
 *   same prompt and profile: one model wrote three files before the finalize
 *   gate told it a plan was required, and the other planned first but, not
 *   knowing the runtime would present the plan, asked the human for approval
 *   itself with `ask_user` — so the human was asked twice, seconds apart, about
 *   the same plan.
 *
 *   It therefore says both halves: the runtime does the asking, and nothing may
 *   change before the answer.
 */
const CREATE_PLAN_REVIEW_NOTE =
  " This run requires human plan review. The runtime presents the plan for approval on its own as " +
  "soon as you have authored it — do not ask for approval yourself, and do not treat your own " +
  "ask_user as the approval. Until the human approves, nothing that could change the workspace will " +
  "run: investigate with the read-only tools, then author the plan here.";

/**
 * The plan tool definitions from `@clarvis/plan` adapted to the loop's
 * {@link NamespacedTool} shape (identity wire/mcp/tool names, no MCP namespace)
 * for advertisement to the model.
 *
 * @param planReview - whether this run gates execution on a human's approval;
 *   when true, `create_plan` carries {@link CREATE_PLAN_REVIEW_NOTE}.
 * @returns the tools, in the order `@clarvis/plan` declares them.
 * @remarks Built per run rather than shared, because the description depends on
 *   run configuration. It is still fixed for the *life* of a run — the tool
 *   array is bound once in `run-agent.ts` — which is what keeps the request head
 *   byte-stable for a provider's prompt cache.
 */
export function buildPlanRuntimeTools(planReview: boolean): NamespacedTool[] {
  return planToolDefinitions.map((definition) => ({
    fullName: definition.name,
    wireName: definition.name,
    mcpName: "",
    toolName: definition.name,
    description:
      planReview && definition.name === CREATE_PLAN_TOOL_NAME
        ? definition.description + CREATE_PLAN_REVIEW_NOTE
        : definition.description,
    inputSchema: definition.inputSchema,
  }));
}

/** The plan tools for a run with no review gate. */
export const planRuntimeTools: NamespacedTool[] = buildPlanRuntimeTools(false);

const createInputSchema = z.object({
  title: z.string().min(1).max(MAX_PLAN_TITLE_CHARS),
  objective: z.string().max(MAX_PLAN_SECTION_CHARS),
  context: z.string().max(MAX_PLAN_SECTION_CHARS).optional(),
  tasks: z
    .array(
      z.object({
        title: taskTitleSchema,
        detail: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
        exit: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
      }),
    )
    .min(1)
    .max(MAX_PLAN_TASKS),
  validation: z.array(singleLineSchema).max(MAX_PLAN_VALIDATION_ITEMS),
  retention: z.enum(["discard", "keep"]).optional(),
});

const readInputSchema = z.object({ id: z.string().max(MAX_PLAN_LOCATOR_CHARS).optional() });
const listInputSchema = z.object({
  cursor: z.string().max(MAX_PLAN_LOCATOR_CHARS).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  status: z.enum(["awaiting_approval", "active", "completed", "cancelled", "failed"]).optional(),
  retention: z.enum(["discard", "keep"]).optional(),
});
const casSchema = z.object({
  expected_revision: z.number().int().positive(),
  expected_digest: z.string().min(1).max(256),
  expected_spec_digest: z.string().min(1).max(256),
});
const transitionItemSchema = z.object({
  task_id: z.string().min(1).max(32),
  status: planTaskStatusSchema,
  result: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  error: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  reason: z.string().max(MAX_PLAN_TASK_FIELD_CHARS).optional(),
  assignee: z.string().max(MAX_PLAN_ASSIGNEE_CHARS).optional(),
});

/**
 * `transition_plan_task` arguments: the compare-and-swap triple plus the batch
 * of transitions, normalised to `transitions` from either accepted shape.
 *
 * @remarks The advertised shape is the batch, for the reason
 *   {@link PlanSession.transition} documents — one CAS triple means a second
 *   call from the same decision is dead on arrival. The flat singular form is
 *   still accepted because it is what a model reaches for out of habit, and
 *   refusing it teaches nothing at the price of a full round trip.
 */
const transitionInputSchema = casSchema
  .extend({
    transitions: z.array(transitionItemSchema).min(1).max(MAX_PLAN_BATCH_OPERATIONS).optional(),
  })
  .and(transitionItemSchema.partial())
  .superRefine((value, ctx) => {
    if (value.transitions === undefined && value.task_id === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pass `transitions` (preferred, a batch) or a single `task_id` + `status`",
      });
  })
  .transform((value) => ({
    expected_revision: value.expected_revision,
    expected_digest: value.expected_digest,
    expected_spec_digest: value.expected_spec_digest,
    transitions: value.transitions ?? [transitionItemSchema.parse(value)],
  }));

/**
 * The outcome of dispatching a plan tool call: the wire `result` string handed
 * back to the model, whether the call `changed` the plan, and the resulting
 * `document` when it did (so the caller can refresh canonical state without a
 * re-read).
 */
export interface PlanRuntimeCallResult {
  result: string;
  changed: boolean;
  document?: PlanDocument;
  /** Error text projected onto the trace/UI separately from the model-facing result. */
  error?: string;
  /** One-shot tombstone when this call discovered an externally removed plan. */
  removed?: MissingPlanState;
}

/**
 * Every mutating plan tool demands the compare-and-swap triple, so every
 * mutating result hands back the NEXT one. Without this the model would have to
 * call read_plan between consecutive writes just to learn the digests, which no
 * amount of prompting makes reliable.
 */
function cas(document: PlanDocument): {
  id: string;
  path?: string;
  revision: number;
  spec_revision: number;
  digest: string;
  spec_digest: string;
} {
  return {
    id: document.id,
    ...(document.path === undefined ? {} : { path: document.path }),
    revision: document.revision,
    spec_revision: document.spec_revision,
    digest: document.digest,
    spec_digest: document.spec_digest,
  };
}

function success(name: string, payload: unknown, document?: PlanDocument): PlanRuntimeCallResult {
  return {
    result: `Tool '${name}' result: ${JSON.stringify(payload)}`,
    changed: document !== undefined,
    ...(document === undefined ? {} : { document }),
  };
}

function failure(name: string, error: unknown): PlanRuntimeCallResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: `Tool '${name}' result (error): ${message}`,
    changed: false,
    error: message,
  };
}

/**
 * The error names this dispatcher exists to translate into a model-facing
 * refusal.
 *
 * @remarks Anything outside this set reaching the catch-all is a defect in
 * Clarvis, not a refusal the model can act on — and the model is handed the two
 * in identical shapes. Naming the expected ones is what lets the unexpected
 * ones be reported to an operator.
 */
const EXPECTED_PLAN_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "ActivePlanExistsError",
  "InvalidPlanError",
  "MissingActivePlanError",
  "PlanConflictError",
  "PlanCursorError",
  "PlanNotFoundError",
  "PlanNotTerminalError",
  "PlanProviderMismatchError",
  "PlanProviderUnavailableError",
  "PlanSealedError",
  "RangeError",
  "ZodError",
]);

/** Reject huge raw arrays before Zod visits every element. */
function assertRawArrayLimit(args: unknown, key: string, limit: number, label: string): void {
  if (args === null || typeof args !== "object") return;
  const value = (args as Record<string, unknown>)[key];
  if (Array.isArray(value) && value.length > limit)
    throw new RangeError(`${label} exceeds ${limit} items`);
}

/** Attach a removal discovered while producing `result`, exactly once. */
function withRemoval(session: PlanSession, result: PlanRuntimeCallResult): PlanRuntimeCallResult {
  const removed = session.takeRemoval();
  return removed === undefined ? result : { ...result, removed };
}

/**
 * Validate and dispatch one plan tool call against a {@link PlanSession}.
 *
 * @param name - the tool wire name (one of the `*_PLAN_*` constants); an unknown
 *   name yields a failure result.
 * @param args - the raw tool arguments, validated per tool with zod.
 * @param session - the plan session that performs the mutation/read.
 * @param logger - operator diagnostics for an error this dispatcher does not
 *   model; a refusal the model can act on is reported to the model alone.
 * @returns the {@link PlanRuntimeCallResult}; a mutating tool's payload always
 *   carries the NEXT compare-and-swap triple ({@link cas}) so consecutive writes
 *   never need an intervening `read_plan`. Any thrown/validation error is caught
 *   and returned as a failure result rather than propagated.
 */
export async function handlePlanRuntimeCall(
  name: string,
  args: unknown,
  session: PlanSession,
  logger: Logger = NOOP_LOGGER,
): Promise<PlanRuntimeCallResult> {
  try {
    let result: PlanRuntimeCallResult;
    switch (name) {
      case CREATE_PLAN_TOOL_NAME: {
        assertRawArrayLimit(args, "tasks", MAX_PLAN_TASKS, "Plan task list");
        assertRawArrayLimit(args, "validation", MAX_PLAN_VALIDATION_ITEMS, "Plan validation list");
        const input = createInputSchema.parse(args);
        const document = await session.create(input);
        result = success(
          name,
          { ...cas(document), task_ids: document.tasks.map((task) => task.id) },
          document,
        );
        break;
      }
      case READ_PLAN_TOOL_NAME: {
        const input = readInputSchema.parse(args);
        const document = await session.read(input.id);
        result = success(name, document ?? null);
        break;
      }
      case LIST_PLANS_TOOL_NAME:
        result = success(name, await session.list(listInputSchema.parse(args)));
        break;
      case REVISE_PLAN_TOOL_NAME: {
        assertRawArrayLimit(args, "operations", MAX_PLAN_BATCH_OPERATIONS, "Plan revision batch");
        const input = revisePlanInputSchema.parse(args);
        const document = await session.revise(
          {
            revision: input.expected_revision,
            digest: input.expected_digest,
            specDigest: input.expected_spec_digest,
          },
          input.operations,
        );
        result = success(name, cas(document), document);
        break;
      }
      case TRANSITION_PLAN_TASK_TOOL_NAME: {
        assertRawArrayLimit(
          args,
          "transitions",
          MAX_PLAN_BATCH_OPERATIONS,
          "Plan transition batch",
        );
        const input = transitionInputSchema.parse(args);
        const document = await session.transition({
          expected: {
            revision: input.expected_revision,
            digest: input.expected_digest,
            specDigest: input.expected_spec_digest,
          },
          transitions: input.transitions.map((t) => ({
            taskId: t.task_id,
            status: t.status,
            ...(t.result === undefined ? {} : { result: t.result }),
            ...(t.error === undefined ? {} : { error: t.error }),
            ...(t.reason === undefined ? {} : { reason: t.reason }),
            ...(t.assignee === undefined ? {} : { assignee: t.assignee }),
          })),
        });
        const moved = new Set(input.transitions.map((t) => t.task_id));
        result = success(
          name,
          { ...cas(document), tasks: document.tasks.filter((task) => moved.has(task.id)) },
          document,
        );
        break;
      }
      default:
        result = failure(name, new Error(`Unknown plan tool: ${name}`));
    }
    return withRemoval(session, result);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    if (!EXPECTED_PLAN_TOOL_ERRORS.has(kind)) {
      logger.error(
        {
          event: "plan.tool.unexpected_error",
          tool: name,
          error_name: kind,
          cause: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
          ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
        },
        "a plan tool threw an error this dispatcher does not model; the model is told the call failed, which reads as a refusal rather than as the defect it is",
      );
    }
    return withRemoval(session, failure(name, error));
  }
}
