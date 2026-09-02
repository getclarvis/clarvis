/**
 * The `run_round` tool: execute explicitly authorized declared rounds, with the
 * runtime deriving each round's fan-out and internal barriers.
 *
 * @remarks A round declares what it *consumes* (`over`), and the barrier follows
 * from that: `each` flows one leader per item, `all` collapses the set into one
 * leader and therefore has to wait for it. Nothing here takes a `parallel` or a
 * `pipeline` argument, so neither can be chosen wrongly.
 *
 * When a round's items are themselves work items, the batch goes through
 * {@link scheduleWorkItems} first, so the dependency order and the write-conflict
 * rule apply inside a round exactly as they do for `run_work_items`.
 */
import type {
  AgentBuildContext,
  AgentRegistryPort,
  ComputeClock,
  FinalizeGate,
  GateOutcome,
  HandlerVerdict,
  Logger,
  NamespacedTool,
  ToolHandler,
} from "@clarvis/capability";
import {
  levelEnabled,
  NOOP_LOGGER,
  parseTaskTitle,
  sanitizeErrorMessage,
  TASK_TITLE_MAX,
} from "@clarvis/capability";
import {
  beginDispatch,
  describeQueued,
  type DispatchDeps,
  type DispatchOutcome,
  type DispatchSession,
  type DispatchStatus,
  type DispatchUnit,
} from "./dispatch.ts";
import { interpolate } from "./interpolate.ts";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";
import { faultFields, workflowLogger } from "./log.ts";
import { reportScheduleDerived, reportScheduleRefused } from "./schedule-log.ts";
import {
  admitNew,
  applyAccept,
  nextRepeat,
  parseAcceptRule,
  parseSelector,
  resolveSource,
  selectItems,
  whenSatisfied,
  type AcceptRule,
  type RepeatSpec,
  type RoundType,
  type Selector,
  type WorkflowState,
} from "./rounds.ts";
import { scheduleWorkItems } from "./schedule.ts";
import { WORKFLOW_RESULT_SCHEMAS } from "./schemas.ts";
import type { LeaderProfileInfo } from "./tool.ts";
import type { WorkflowCtx, WorkflowSequenceState, WorkflowSequenceStatus } from "./types.ts";
import { toWorkItem, workItemBrief } from "./work-items.ts";

/** The `run_round` wire/tool name. */
export const RUN_ROUND_TOOL_NAME = "run_round";
/** Inspect the manager-owned checkpoint of the active round sequence. */
export const WORKFLOW_STATUS_TOOL_NAME = "workflow_status";
/** Explicitly continue or stop a manager-owned round sequence. */
export const WORKFLOW_DECIDE_TOOL_NAME = "workflow_decide";

const RUN_ROUND_DESCRIPTION =
  "Run a sequence of declared rounds. Each round says what it consumes — 'once', " +
  "'each(<round>.<field>)' or 'all(<round>.<field>)' — and the runtime works out the fan-out and " +
  "the waiting: 'each' starts one leader per item, 'all' hands the whole set to one leader. Later " +
  "rounds read earlier rounds' structured results by name, so routing decisions (which findings " +
  "need verification, which gaps remain) are made by the leader that had the context, not " +
  "re-derived by you. Only the first round starts: after every round the sequence pauses at a " +
  "checkpoint until the Admiral calls workflow_decide. Returns immediately; collect the leaders " +
  "with await_agents or agent_poll.";

/** Build the read-only checkpoint inspection tool. */
export function buildWorkflowStatusTool(): NamespacedTool {
  return {
    fullName: WORKFLOW_STATUS_TOOL_NAME,
    wireName: WORKFLOW_STATUS_TOOL_NAME,
    mcpName: "",
    toolName: WORKFLOW_STATUS_TOOL_NAME,
    description:
      "Inspect the active or named workflow round sequence: its revision, current state, proposed " +
      "next round, and cumulative leader capacity. This tool never starts work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          minLength: 1,
          maxLength: WORKFLOW_LIMITS.identifierChars,
          description: "OPTIONAL — omit to inspect the active or most recent sequence.",
        },
      },
    },
  };
}

/** Build the compare-and-set checkpoint decision tool. */
export function buildWorkflowDecideTool(): NamespacedTool {
  return {
    fullName: WORKFLOW_DECIDE_TOOL_NAME,
    wireName: WORKFLOW_DECIDE_TOOL_NAME,
    mcpName: "",
    toolName: WORKFLOW_DECIDE_TOOL_NAME,
    description:
      "At an awaiting_manager checkpoint, explicitly continue exactly the proposed next round or " +
      "stop the sequence. Supply the revision returned by workflow_status; stale or duplicate " +
      "decisions are refused before any leader is spawned.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session_id", "revision", "decision", "reason"],
      properties: {
        session_id: {
          type: "string",
          minLength: 1,
          maxLength: WORKFLOW_LIMITS.identifierChars,
        },
        revision: { type: "integer", minimum: 1 },
        decision: { enum: ["continue", "stop"] },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: WORKFLOW_LIMITS.textChars,
          description: "Why another round is needed, or why the sequence should stop now.",
        },
      },
    },
  };
}

/** A round as it arrives on the wire, with the compact selector/accept forms. */
export interface RoundInput {
  id: string;
  type: RoundType;
  profile?: string;
  over: Selector;
  title: string;
  brief: string;
  fanout: number;
  accept?: AcceptRule;
  when?: string;
}

/** A parsed `run_round` call, or a workflow document compiled into one. */
export interface RoundCall {
  rounds: readonly RoundInput[];
  repeat?: RepeatSpec;
  args: Record<string, unknown>;
}

/** How one round finished, as reported back through the batch summary. */
interface RoundReport {
  id: string;
  skipped?: string;
  leaders: number;
  accepted?: number;
  rejected?: number;
}

const ROUND_TYPES = new Set<RoundType>(["discovery", "findings", "verdict", "free"]);

/**
 * The shape a round id may take, matching `@clarvis/artifact`'s.
 *
 * @remarks Not cosmetic: a unit's key is `<round id>[<item index>]`, and
 * {@link foldRound} recovers the index by finding the first bracketed number in
 * it. An id like `pass[1]` would fold every outcome of the round onto item 1 —
 * wrong `accept` tallies against the wrong items.
 */
const ROUND_ID = /^[A-Za-z0-9._-]+$/u;

/**
 * Build the `run_round` tool.
 *
 * @param profiles - the registered leader profiles, used for the per-round
 *   `profile` enum.
 */
export function buildRunRoundTool(profiles?: readonly LeaderProfileInfo[]): NamespacedTool {
  const round: Record<string, unknown> = {
    id: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.identifierChars,
      description: "Unique within this call; later rounds read it by name.",
    },
    type: {
      enum: [...ROUND_TYPES],
      description:
        "Selects the shipped result schema this round's leaders must return: discovery, findings " +
        "or verdict. Use 'free' only when the result is not going to be aggregated.",
    },
    over: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.pathChars,
      description:
        "What this round consumes: 'once' (one leader), 'each(<round>.<field>)' (one leader per " +
        "item, optionally 'each(<round>.<field> where <field>)' or '… where <field> = <value>'), " +
        "or 'all(<round>.<field>)' (the whole set to one leader). Prefer 'each' with a where over " +
        "filtering the list yourself.",
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: TASK_TITLE_MAX,
      description:
        "Short human-facing title for this round's leader. May interpolate the same fields as " +
        "'brief'; the rendered title must stay on one line and within the title limit.",
    },
    brief: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.textChars,
      description:
        "The leader's brief. May reference {{item}}, {{item.<field>}}, {{args.<key>}} and " +
        "{{state.<round>.<field>}}. A placeholder that does not resolve is an error, not blank.",
    },
    fanout: {
      type: "integer",
      minimum: 1,
      maximum: WORKFLOW_LIMITS.fanout,
      description:
        "OPTIONAL — run this many independent leaders per item, for adversarial verification. " +
        "Pair with 'accept'.",
    },
    accept: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.pathChars,
      description:
        "OPTIONAL — how to fold the replicas: 'all(<field>, <value>)', 'any(…)', 'majority(…)' " +
        "or 'threshold(<field>, <value>, <count>)'. A replica that failed counts against the rule.",
    },
    when: {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.pathChars,
      description:
        "OPTIONAL — a '<round>.<field>' path; the round runs only if it resolves to a non-empty " +
        "array.",
    },
  };
  if (profiles !== undefined && profiles.length > 0) {
    round.profile = {
      type: "string",
      minLength: 1,
      maxLength: WORKFLOW_LIMITS.identifierChars,
      enum: profiles.map((p) => p.name),
      description:
        "OPTIONAL — the profile this round's leaders run as. Available profiles — " +
        profiles.map((p) => `${p.name}: ${p.description ?? "(no description)"}`).join("; "),
    };
  }
  return {
    fullName: RUN_ROUND_TOOL_NAME,
    wireName: RUN_ROUND_TOOL_NAME,
    mcpName: "",
    toolName: RUN_ROUND_TOOL_NAME,
    description: RUN_ROUND_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["rounds"],
      properties: {
        rounds: {
          type: "array",
          minItems: 1,
          maxItems: WORKFLOW_LIMITS.rounds,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "over", "title", "brief"],
            properties: round,
          },
        },
        repeat: {
          type: "object",
          additionalProperties: false,
          required: ["rounds", "dedupe_by", "max_rounds"],
          description:
            "OPTIONAL — re-run these rounds until they stop producing anything new. Deduplication " +
            "is against everything seen so far, not against what survived verification.",
          properties: {
            rounds: {
              type: "array",
              minItems: 1,
              maxItems: WORKFLOW_LIMITS.repeatRounds,
              items: { type: "string", minLength: 1, maxLength: WORKFLOW_LIMITS.identifierChars },
            },
            until: { enum: ["no_new", "budget"] },
            dedupe_by: {
              type: "array",
              minItems: 1,
              maxItems: WORKFLOW_LIMITS.repeatDedupeFields,
              items: { type: "string", minLength: 1, maxLength: WORKFLOW_LIMITS.identifierChars },
            },
            dry_rounds: {
              type: "integer",
              minimum: 1,
              maximum: WORKFLOW_LIMITS.repeatDryRounds,
            },
            max_rounds: {
              type: "integer",
              minimum: 1,
              maximum: WORKFLOW_LIMITS.repeatMaxRounds,
            },
          },
        },
        args: {
          type: "object",
          maxProperties: WORKFLOW_LIMITS.args,
          propertyNames: { maxLength: WORKFLOW_LIMITS.identifierChars },
          description: "OPTIONAL — values the briefs may reference as {{args.<key>}}.",
        },
      },
    },
  };
}

/** Parse one wire round, or say what is wrong with it. */
function parseRound(raw: unknown, index: number): { round: RoundInput } | { error: string } {
  const at = `rounds[${String(index)}]`;
  if (typeof raw !== "object" || raw === null) return { error: `${at} must be an object.` };
  const record = raw as Record<string, unknown>;
  if (
    !isBoundedWorkflowString(record.id, WORKFLOW_LIMITS.identifierChars) ||
    !ROUND_ID.test(record.id)
  ) {
    return {
      error:
        `${at}.id is required and must be a non-empty name of letters, digits, ` +
        `'.', '_' or '-' up to ${String(WORKFLOW_LIMITS.identifierChars)} characters — it is ` +
        "used to key this round's results and its leaders.",
    };
  }
  if (typeof record.type !== "string" || !ROUND_TYPES.has(record.type as RoundType)) {
    return { error: `${at}.type must be one of ${[...ROUND_TYPES].join(", ")}.` };
  }
  if (
    !isBoundedWorkflowString(record.brief, WORKFLOW_LIMITS.textChars) ||
    record.brief.length === 0
  ) {
    return {
      error:
        `${at}.brief is required and must be a non-empty string no longer than ` +
        `${String(WORKFLOW_LIMITS.textChars)} characters.`,
    };
  }
  if (!isBoundedWorkflowString(record.title, TASK_TITLE_MAX * 2) || record.title.length === 0) {
    return { error: `${at}.title is required and must be a bounded non-empty string.` };
  }
  const title = parseTaskTitle(record.title);
  if (!title.ok) return { error: `${at}.${title.message}` };
  if (!isBoundedWorkflowString(record.over, WORKFLOW_LIMITS.pathChars)) {
    return { error: `${at}.over is required and must be a string.` };
  }
  const over = parseSelector(record.over);
  if (over === null) {
    return {
      error:
        `${at}.over is not a selector: expected 'once', 'each(<round>.<field>)' ` +
        `(optionally '… where <field>' or '… where <field> = <value>') or 'all(<round>.<field>)'.`,
    };
  }
  let accept: AcceptRule | undefined;
  if (record.accept !== undefined) {
    if (!isBoundedWorkflowString(record.accept, WORKFLOW_LIMITS.pathChars)) {
      return {
        error: `${at}.accept must be a string no longer than ${String(WORKFLOW_LIMITS.pathChars)} characters.`,
      };
    }
    const parsed = parseAcceptRule(record.accept);
    if (parsed === null) {
      return {
        error:
          `${at}.accept is not a rule: expected 'all(<field>, <value>)', 'any(…)', ` +
          `'majority(…)' or 'threshold(<field>, <value>, <count>)'.`,
      };
    }
    accept = parsed;
  }
  const fanout = record.fanout === undefined ? 1 : Number(record.fanout);
  if (!Number.isInteger(fanout) || fanout < 1 || fanout > WORKFLOW_LIMITS.fanout) {
    return {
      error:
        `${at}.fanout must be a positive integer no greater than ` +
        `${String(WORKFLOW_LIMITS.fanout)}.`,
    };
  }
  if (
    record.profile !== undefined &&
    (!isBoundedWorkflowString(record.profile, WORKFLOW_LIMITS.identifierChars) ||
      record.profile.length === 0)
  ) {
    return {
      error:
        `${at}.profile must be a non-empty string no longer than ` +
        `${String(WORKFLOW_LIMITS.identifierChars)} characters.`,
    };
  }
  if (
    record.when !== undefined &&
    (!isBoundedWorkflowString(record.when, WORKFLOW_LIMITS.pathChars) || record.when.length === 0)
  ) {
    return {
      error:
        `${at}.when must be a non-empty string no longer than ` +
        `${String(WORKFLOW_LIMITS.pathChars)} characters.`,
    };
  }
  return {
    round: {
      id: record.id,
      type: record.type as RoundType,
      over,
      title: title.title,
      brief: record.brief,
      fanout,
      ...(typeof record.profile === "string" ? { profile: record.profile } : {}),
      ...(accept === undefined ? {} : { accept }),
      ...(typeof record.when === "string" ? { when: record.when } : {}),
    },
  };
}

/** Parse the `repeat` block, or say what is wrong with it. */
function parseRepeat(
  raw: unknown,
  ids: ReadonlySet<string>,
): { repeat: RepeatSpec } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "'repeat' must be an object." };
  const record = raw as Record<string, unknown>;
  const rounds = Array.isArray(record.rounds) ? record.rounds : null;
  const dedupeBy = Array.isArray(record.dedupe_by) ? record.dedupe_by : null;
  if (
    rounds === null ||
    rounds.length === 0 ||
    rounds.length > WORKFLOW_LIMITS.repeatRounds ||
    !rounds.every((r) => isBoundedWorkflowString(r, WORKFLOW_LIMITS.identifierChars) && ids.has(r))
  ) {
    return {
      error:
        "'repeat.rounds' must name rounds declared in this call and contain no more than " +
        `${String(WORKFLOW_LIMITS.repeatRounds)} entries.`,
    };
  }
  if (
    dedupeBy === null ||
    dedupeBy.length === 0 ||
    dedupeBy.length > WORKFLOW_LIMITS.repeatDedupeFields ||
    !dedupeBy.every((f) => isBoundedWorkflowString(f, WORKFLOW_LIMITS.identifierChars))
  ) {
    return {
      error:
        "'repeat.dedupe_by' must be a non-empty bounded array of field names with no more than " +
        `${String(WORKFLOW_LIMITS.repeatDedupeFields)} entries.`,
    };
  }
  const maxRounds = Number(record.max_rounds);
  if (
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > WORKFLOW_LIMITS.repeatMaxRounds
  ) {
    return {
      error:
        "'repeat.max_rounds' is required and must be a positive integer no greater than " +
        `${String(WORKFLOW_LIMITS.repeatMaxRounds)} — it is the backstop.`,
    };
  }
  const dryRounds = record.dry_rounds === undefined ? undefined : Number(record.dry_rounds);
  if (
    dryRounds !== undefined &&
    (!Number.isInteger(dryRounds) || dryRounds < 1 || dryRounds > WORKFLOW_LIMITS.repeatDryRounds)
  ) {
    return {
      error:
        "'repeat.dry_rounds' must be a positive integer no greater than " +
        `${String(WORKFLOW_LIMITS.repeatDryRounds)}.`,
    };
  }
  return {
    repeat: {
      rounds: rounds as string[],
      until: record.until === "budget" ? "budget" : "no_new",
      dedupe_by: dedupeBy,
      max_rounds: maxRounds,
      ...(dryRounds === undefined ? {} : { dry_rounds: dryRounds }),
    },
  };
}

/** Bound the flat argument bag briefs can interpolate before retaining it. */
function parseArgs(raw: unknown): { args: Record<string, unknown> } | { error: string } {
  if (raw === undefined) return { args: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "'args' must be an object when supplied." };
  }
  const args = raw as Record<string, unknown>;
  const entries = Object.entries(args);
  if (entries.length > WORKFLOW_LIMITS.args) {
    return {
      error: `'args' must contain no more than ${String(WORKFLOW_LIMITS.args)} properties.`,
    };
  }
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > WORKFLOW_LIMITS.identifierChars) {
      return {
        error:
          "'args' property names must be non-empty and no longer than " +
          `${String(WORKFLOW_LIMITS.identifierChars)} characters.`,
      };
    }
    if (typeof value === "string" && value.length > WORKFLOW_LIMITS.textChars) {
      return {
        error:
          `'args.${name}' must be no longer than ` +
          `${String(WORKFLOW_LIMITS.textChars)} characters.`,
      };
    }
  }
  return { args };
}

/** Parse a whole `run_round` call. */
function parseRoundCall(args: unknown): { call: RoundCall } | { error: string } {
  if (typeof args !== "object" || args === null) {
    return { error: "expected an object with a 'rounds' array." };
  }
  const record = args as Record<string, unknown>;
  if (!Array.isArray(record.rounds) || record.rounds.length === 0) {
    return { error: "'rounds' is required and must be a non-empty array." };
  }
  if (record.rounds.length > WORKFLOW_LIMITS.rounds) {
    return {
      error: `'rounds' must contain no more than ${String(WORKFLOW_LIMITS.rounds)} entries.`,
    };
  }
  const rounds: RoundInput[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of record.rounds.entries()) {
    const parsed = parseRound(raw, index);
    if ("error" in parsed) return parsed;
    if (ids.has(parsed.round.id)) {
      return { error: `two rounds share the id '${parsed.round.id}'; ids must be unique.` };
    }
    ids.add(parsed.round.id);
    rounds.push(parsed.round);
  }
  let repeat: RepeatSpec | undefined;
  if (record.repeat !== undefined) {
    const parsed = parseRepeat(record.repeat, ids);
    if ("error" in parsed) return parsed;
    repeat = parsed.repeat;
  }
  const parsedArgs = parseArgs(record.args);
  if ("error" in parsedArgs) return parsedArgs;
  return {
    call: {
      rounds,
      ...(repeat === undefined ? {} : { repeat }),
      args: parsedArgs.args,
    },
  };
}

/** The shipped result schema a round's `type` binds its leaders to. */
function schemaFor(type: RoundType): Record<string, unknown> | undefined {
  return type === "free" ? undefined : WORKFLOW_RESULT_SCHEMAS[type];
}

/** One leader a round will start, before it is registered. */
interface PlannedUnit extends DispatchUnit {
  itemIndex: number;
}

/** A unit that must complete before another may start, and the item it came from. */
interface Prerequisite {
  key: string;
  id: string;
}

/**
 * A round's dispatch plan: its waves, plus the prerequisites the runtime must
 * hold each unit against.
 *
 * @remarks `prereqs` is empty for every round except one consuming work items —
 * there, wave *ordering* alone is not the contract: an item whose dependency
 * failed must not be dispatched at all, which is what the shipped manager prompt
 * promises and what `run_work_items` already did.
 */
interface PlannedRound {
  waves: PlannedUnit[][];
  prereqs: Map<string, Prerequisite[]>;
}

/**
 * Work out the leaders one round will start.
 *
 * @param logger - reports the scheduling decision this round derived, which is
 *   otherwise auditable from nothing.
 * @remarks When every selected item parses as a work item the batch is scheduled
 *   rather than fanned out flat, so `dependencies` and file conflicts hold inside
 *   a round too. Otherwise the items are independent by construction and go
 *   straight to the semaphore.
 */
function planRound(
  round: RoundInput,
  state: WorkflowState,
  args: Record<string, unknown>,
  pass = 0,
  logger: Logger = NOOP_LOGGER,
): PlannedRound | { error: string } {
  if (round.over.kind !== "once") {
    const source = resolveSource(state, round.over.source);
    if (source !== null && source.length > WORKFLOW_LIMITS.workItems) {
      return {
        error:
          `round '${round.id}': '${round.over.source}' contains ${String(source.length)} items; ` +
          `the hard limit is ${String(WORKFLOW_LIMITS.workItems)}`,
      };
    }
  }
  const picked = selectItems(round.over, state);
  if ("error" in picked) return { error: `round '${round.id}': ${picked.error}` };

  const expectSchema = schemaFor(round.type);
  const unitFor = (item: unknown, itemIndex: number, replica: number): PlannedUnit | string => {
    const workItem = toWorkItem(item);
    const renderedTitle = interpolate(round.title, { args, item, state: state.rounds });
    if ("error" in renderedTitle) return `round '${round.id}' title: ${renderedTitle.error}`;
    if (renderedTitle.text.length > TASK_TITLE_MAX * 2) {
      return `round '${round.id}' title exceeds the bounded display-title size`;
    }
    const title = parseTaskTitle(renderedTitle.text);
    if (!title.ok) return `round '${round.id}' title: ${title.message}`;
    const rendered = interpolate(round.brief, { args, item, state: state.rounds });
    if ("error" in rendered) return `round '${round.id}': ${rendered.error}`;
    const brief = workItem === null ? rendered.text : workItemBrief(workItem, rendered.text);
    if (brief.length > WORKFLOW_LIMITS.textChars) {
      return (
        `round '${round.id}' rendered brief exceeds the ` +
        `${String(WORKFLOW_LIMITS.textChars)} character limit`
      );
    }
    const suffix = round.fanout > 1 ? `#${String(replica + 1)}` : "";
    return {
      itemIndex,
      key: `${round.id}[${String(itemIndex)}]${suffix}`,
      title: title.title,
      brief,
      roundId: round.id,
      pass,
      replica,
      replicaCount: round.fanout,
      ...(round.profile !== undefined ? { profile: round.profile } : {}),
      ...(expectSchema !== undefined ? { expectSchema } : {}),
    };
  };

  const flat: PlannedUnit[] = [];
  for (const [itemIndex, item] of picked.items.entries()) {
    for (let replica = 0; replica < round.fanout; replica += 1) {
      const unit = unitFor(item, itemIndex, replica);
      if (typeof unit === "string") return { error: unit };
      flat.push(unit);
    }
  }

  const workItems = picked.items.map(toWorkItem);
  if (round.over.kind === "each" && workItems.length > 0 && workItems.every((w) => w !== null)) {
    const scoped = workItems.filter((w) => w !== null);
    const schedule = scheduleWorkItems(scoped);
    if (!schedule.ok) {
      reportScheduleRefused(logger, schedule);
      return { error: `round '${round.id}': ${schedule.code} — ${schedule.message}` };
    }
    reportScheduleDerived(logger, scoped, schedule.waves);
    const byIndex = new Map<number, PlannedUnit[]>();
    for (const unit of flat) {
      byIndex.set(unit.itemIndex, [...(byIndex.get(unit.itemIndex) ?? []), unit]);
    }
    const unitsOf = (id: string): PlannedUnit[] =>
      byIndex.get(workItems.findIndex((w) => w?.id === id)) ?? [];
    const prereqs = new Map<string, Prerequisite[]>();
    for (const item of workItems) {
      if (item === null) continue;
      const blockers = item.dependencies.flatMap((id) =>
        unitsOf(id).map((unit): Prerequisite => ({ key: unit.key, id })),
      );
      if (blockers.length === 0) continue;
      for (const unit of unitsOf(item.id)) prereqs.set(unit.key, blockers);
    }
    return {
      waves: schedule.waves.map((wave) => wave.items.flatMap((item) => unitsOf(item.id))),
      prereqs,
    };
  }
  return { waves: flat.length === 0 ? [] : [flat], prereqs: new Map() };
}

/**
 * Re-assert the hard bounds at the exported programmatic executor boundary.
 *
 * @remarks `run_round` already parses untrusted tool arguments, but
 * `run_workflow` and embedders call {@link startRounds} with typed objects. Types
 * are not a runtime admission control: this check must happen before selector
 * filtering, interpolation or the `fanout` allocation loop.
 */
function roundCallBoundsError(call: RoundCall): string | null {
  const rawRounds: unknown = call.rounds;
  if (
    !Array.isArray(rawRounds) ||
    rawRounds.length === 0 ||
    rawRounds.length > WORKFLOW_LIMITS.rounds
  ) {
    return `round sequences must contain 1-${String(WORKFLOW_LIMITS.rounds)} rounds`;
  }
  const rounds = rawRounds as readonly RoundInput[];
  for (const [index, round] of rounds.entries()) {
    const at = `rounds[${String(index)}]`;
    if (!isBoundedWorkflowString(round.id, WORKFLOW_LIMITS.identifierChars)) {
      return `${at}.id exceeds the workflow identifier limit`;
    }
    if (!isBoundedWorkflowString(round.brief, WORKFLOW_LIMITS.textChars)) {
      return `${at}.brief exceeds the workflow text limit`;
    }
    if (!isBoundedWorkflowString(round.title, TASK_TITLE_MAX * 2)) {
      return `${at}.title exceeds the bounded display-title size`;
    }
    const title = parseTaskTitle(round.title);
    if (!title.ok) return `${at}.${title.message}`;
    if (
      !Number.isInteger(round.fanout) ||
      round.fanout < 1 ||
      round.fanout > WORKFLOW_LIMITS.fanout
    ) {
      return `${at}.fanout must be between 1 and ${String(WORKFLOW_LIMITS.fanout)}`;
    }
    if (
      round.profile !== undefined &&
      !isBoundedWorkflowString(round.profile, WORKFLOW_LIMITS.identifierChars)
    ) {
      return `${at}.profile exceeds the workflow identifier limit`;
    }
    if (
      round.when !== undefined &&
      !isBoundedWorkflowString(round.when, WORKFLOW_LIMITS.pathChars)
    ) {
      return `${at}.when exceeds the workflow selector limit`;
    }
    if (round.over.kind !== "once") {
      if (!isBoundedWorkflowString(round.over.source, WORKFLOW_LIMITS.pathChars)) {
        return `${at}.over exceeds the workflow selector limit`;
      }
      if (
        round.over.kind === "each" &&
        round.over.where !== undefined &&
        (!isBoundedWorkflowString(round.over.where.field, WORKFLOW_LIMITS.identifierChars) ||
          (typeof round.over.where.equals === "string" &&
            round.over.where.equals.length > WORKFLOW_LIMITS.textChars))
      ) {
        return `${at}.over filter exceeds the workflow string limit`;
      }
    }
    if (
      round.accept !== undefined &&
      (!isBoundedWorkflowString(round.accept.field, WORKFLOW_LIMITS.identifierChars) ||
        !isBoundedWorkflowString(round.accept.value, WORKFLOW_LIMITS.textChars))
    ) {
      return `${at}.accept exceeds the workflow string limit`;
    }
  }
  if (call.repeat !== undefined) {
    if (
      call.repeat.rounds.length === 0 ||
      call.repeat.rounds.length > WORKFLOW_LIMITS.repeatRounds ||
      call.repeat.rounds.some((id) => !isBoundedWorkflowString(id, WORKFLOW_LIMITS.identifierChars))
    ) {
      return `repeat.rounds must contain 1-${String(WORKFLOW_LIMITS.repeatRounds)} bounded ids`;
    }
    if (
      call.repeat.dedupe_by.length === 0 ||
      call.repeat.dedupe_by.length > WORKFLOW_LIMITS.repeatDedupeFields ||
      call.repeat.dedupe_by.some(
        (field) => !isBoundedWorkflowString(field, WORKFLOW_LIMITS.identifierChars),
      )
    ) {
      return (
        `repeat.dedupe_by must contain 1-${String(WORKFLOW_LIMITS.repeatDedupeFields)} ` +
        "bounded fields"
      );
    }
    if (
      !Number.isInteger(call.repeat.max_rounds) ||
      call.repeat.max_rounds < 1 ||
      call.repeat.max_rounds > WORKFLOW_LIMITS.repeatMaxRounds
    ) {
      return `repeat.max_rounds must be between 1 and ${String(WORKFLOW_LIMITS.repeatMaxRounds)}`;
    }
    if (
      call.repeat.dry_rounds !== undefined &&
      (!Number.isInteger(call.repeat.dry_rounds) ||
        call.repeat.dry_rounds < 1 ||
        call.repeat.dry_rounds > WORKFLOW_LIMITS.repeatDryRounds)
    ) {
      return `repeat.dry_rounds must be between 1 and ${String(WORKFLOW_LIMITS.repeatDryRounds)}`;
    }
  }
  const args = parseArgs(call.args);
  return "error" in args ? args.error : null;
}

/**
 * Fold one round's leader outcomes into the value later rounds read by name.
 *
 * @remarks Results from several leaders are merged field by field: array fields
 *   concatenate, so `each(discover.work_items)` over a findings round makes
 *   `review.findings` the whole list across every lens. A round carrying an
 *   `accept` rule instead stores its decisions, so a later round can consume
 *   `verify.accepted` directly.
 */
function foldRound(
  round: RoundInput,
  items: readonly unknown[],
  outcomes: readonly DispatchOutcome[],
): unknown {
  const byItem = new Map<number, unknown[]>();
  for (const outcome of outcomes) {
    const index = Number(/\[(\d+)\]/u.exec(outcome.key)?.[1] ?? "0");
    byItem.set(index, [...(byItem.get(index) ?? []), outcome.result]);
  }
  if (round.accept !== undefined) {
    const rule = round.accept;
    const decisions = [...byItem.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, replicas]) => ({
        item: items[index],
        ...applyAccept(rule, replicas),
      }));
    return {
      decisions,
      accepted: decisions.filter((d) => d.accepted).map((d) => d.item),
      rejected: decisions.filter((d) => !d.accepted).map((d) => d.item),
    };
  }
  const results = [...byItem.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, r]) => r);
  return mergeResults(results);
}

/** Merge several structured leader results into one, concatenating array fields. */
function mergeResults(results: readonly unknown[]): unknown {
  const objects = results.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null && !Array.isArray(r),
  );
  if (objects.length !== results.length || objects.length === 0) {
    return results.length === 1 ? results[0] : results;
  }
  if (objects.length === 1) return objects[0];
  const merged: Record<string, unknown> = {};
  for (const key of new Set(objects.flatMap((o) => Object.keys(o)))) {
    const present = objects.filter((o) => o[key] !== undefined).map((o) => o[key]);
    merged[key] = present.every((v) => Array.isArray(v))
      ? (present as unknown[][]).flat()
      : present.length === 1
        ? present[0]
        : present;
  }
  return merged;
}

/**
 * Collect the items a repeat pass produced, for novelty measurement.
 *
 * @remarks Every array-valued field of every round in the block contributes, and
 *   an item carrying none of the `dedupe_by` fields is ignored — which is how a
 *   `coverage_gaps: string[]` sits beside a `findings[]` without being counted as
 *   a finding.
 */
function producedItems(state: WorkflowState, block: RepeatSpec): unknown[] {
  const items: unknown[] = [];
  for (const id of block.rounds) {
    const value = state.rounds[id];
    if (typeof value !== "object" || value === null) continue;
    for (const field of Object.values(value as Record<string, unknown>)) {
      if (!Array.isArray(field)) continue;
      for (const entry of field) {
        const hasKey = block.dedupe_by.some(
          (name) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>)[name] !== undefined,
        );
        if (hasKey) items.push(entry);
      }
    }
  }
  return items;
}

/** Render the plan handed back the moment the rounds start. */
function describePlan(
  call: RoundCall,
  sessionId: string,
  first: RoundInput,
  handles: ReadonlyMap<string, string>,
  queued: number,
) {
  const shape = call.rounds
    .map((r) => `${r.id} (${r.type}, ${describeSelector(r.over)}${fanoutNote(r)})`)
    .join(" → ");
  const repeat =
    call.repeat === undefined
      ? ""
      : ` Repeat passes over [${call.repeat.rounds.join(", ")}] are proposals only, capped at ` +
        `${String(call.repeat.max_rounds)} passes.`;
  return (
    `started sequence '${sessionId}' with ${String(call.rounds.length)} authored round(s): ` +
    `${shape}.${repeat} ` +
    `Round '${first.id}' is running now: ${[...handles.values()].join(", ")}.` +
    `${describeQueued(queued)} ` +
    "Keep working, then collect them with await_agents (to wait) or agent_poll (to look). " +
    "When this round returns, inspect its checkpoint with workflow_status and explicitly use " +
    "workflow_decide. No later round starts automatically."
  );
}

/** Render a selector back into its compact form, for the plan text. */
function describeSelector(selector: Selector): string {
  if (selector.kind === "once") return "once";
  if (selector.kind === "all") return `all(${selector.source})`;
  const where = selector.where;
  if (where === undefined) return `each(${selector.source})`;
  const value = where.equals === undefined ? "" : ` = ${String(where.equals)}`;
  return `each(${selector.source} where ${where.field}${value})`;
}

/** The `×N` note a fan-out round carries in the plan text. */
function fanoutNote(round: RoundInput): string {
  return round.fanout > 1 ? ` ×${String(round.fanout)}` : "";
}

/** Render the cumulative tally the last child of an authorized round carries back. */
function describeSummary(reports: readonly RoundReport[]): string {
  const parts = reports.map((report) => {
    if (report.skipped !== undefined) return `${report.id}: skipped (${report.skipped})`;
    const votes =
      report.accepted === undefined
        ? ""
        : `, ${String(report.accepted)} accepted / ${String(report.rejected ?? 0)} rejected`;
    return `${report.id}: ${String(report.leaders)} leader(s)${votes}`;
  });
  return `rounds finished — ${parts.join("; ")}`;
}

/**
 * Build the `run_round` tool handler.
 *
 * @remarks The first round is planned and registered synchronously so the call
 *   can refuse outright — an unresolvable selector or an unrenderable brief is a
 *   mistake to report, not something to start and abandon halfway. The
 *   coordinator then pauses at every authored or repeat boundary; only an
 *   explicit compare-and-set decision registers the proposed next round.
 */
export function buildRunRoundHandler(
  ctx: WorkflowCtx,
  bc: AgentBuildContext,
  clock: ComputeClock | undefined,
  agents: AgentRegistryPort,
  coordinator: RoundCoordinator,
): ToolHandler {
  const deps: DispatchDeps = { ctx, bc, clock, agents };
  return {
    matches: (call) => call.name === RUN_ROUND_TOOL_NAME,
    handle(call): Promise<HandlerVerdict> {
      const parsed = parseRoundCall(call.arguments);
      if ("error" in parsed) return Promise.resolve(verdict(parsed.error));
      const started = startRounds(deps, parsed.call, coordinator);
      if ("error" in started) return Promise.resolve(verdict(started.error));
      return Promise.resolve({
        kind: "result",
        text: `Tool '${RUN_ROUND_TOOL_NAME}' result: ${started.text}`,
        progress: true,
      });
    },
  };
}

/**
 * Validate a round sequence and register only its first round.
 *
 * @returns the plan text to answer the tool call with, or the reason the sequence
 *   cannot start.
 * @remarks Shared by `run_round` and `run_workflow`: a workflow document is a
 *   round sequence that was authored rather than composed in a turn, so there is
 *   one executor and one set of guarantees behind both. Later rounds remain
 *   proposals until the shared manager coordinator authorizes them.
 */
export function startRounds(
  deps: DispatchDeps,
  call: RoundCall,
  coordinator: RoundCoordinator = createRoundCoordinator(deps.ctx),
): { text: string } | { error: string } {
  return coordinator.start(deps, call);
}

/**
 * State what one round is about to cost, in leaders and in barriers.
 *
 * @param logger - the workflow-scoped logger.
 * @param round - the round as authored or composed.
 * @param pass - zero for the initial sequence, one-based for repeat passes.
 * @param planned - what {@link planRound} derived.
 * @param items - how many items the selector picked.
 * @remarks `info` and once per round: a fan-out's shape is the first thing an
 *   operator needs and the last thing the trace states, because the trace's
 *   leader edges only show what actually started.
 */
function reportRoundPlanned(
  logger: Logger,
  round: RoundInput,
  pass: number,
  planned: PlannedRound,
  items: number,
): void {
  logger.info(
    {
      event: "workflow.round_planned",
      round_id: round.id,
      pass,
      selector: round.over.kind === "once" ? "once" : `${round.over.kind}(${round.over.source})`,
      items,
      fanout: round.fanout,
      units: planned.waves.reduce((total, wave) => total + wave.length, 0),
      waves: planned.waves.length,
      prereq_units: planned.prereqs.size,
    },
    "a round resolved into its leaders and barriers; this is the whole fan-out it is about to pay for",
  );
}

/**
 * Say that a round never ran, and why.
 *
 * @param logger - the workflow-scoped logger.
 * @param roundId - the round, or the synthetic `repeat` / `workflow` scope.
 * @param pass - zero for the initial sequence, one-based for repeat passes.
 * @param reason - the same sentence the summary string carries.
 */
function reportRoundSkipped(logger: Logger, roundId: string, pass: number, reason: string): void {
  logger.warn(
    {
      event: "workflow.round_skipped",
      round_id: roundId,
      pass,
      reason: sanitizeErrorMessage(reason),
    },
    "a round in this sequence never ran; the manager sees this only as one clause of the batch summary",
  );
}

/**
 * Report what a round's leaders actually folded into.
 *
 * @param logger - the workflow-scoped logger.
 * @param round - the round being folded.
 * @param folded - what {@link foldRound} produced.
 * @param outcomes - the round's dispatch outcomes.
 * @param decisions - the accept/reject split, when the round declared a rule.
 * @remarks `result_shape` and `non_object_replicas` together catch the silent
 *   degradation: {@link mergeResults} falls back to an array the moment one
 *   leader answers with prose instead of the object its `expectSchema` asked
 *   for, and every later round reading that field by name then sees something
 *   of a different shape for a reason nothing states.
 */
function reportRoundFolded(
  logger: Logger,
  round: RoundInput,
  folded: unknown,
  outcomes: readonly DispatchOutcome[],
  decisions: { accepted: unknown[]; rejected: unknown[] } | undefined,
): void {
  if (!levelEnabled(logger, "debug")) return;
  logger.debug(
    {
      event: "workflow.round_folded",
      round_id: round.id,
      leaders: outcomes.length,
      ...(decisions === undefined
        ? {}
        : { accepted: decisions.accepted.length, rejected: decisions.rejected.length }),
      result_shape: shapeOf(folded),
      non_object_replicas: outcomes.filter((outcome) => shapeOf(outcome.result) !== "object")
        .length,
    },
    "a round's leaders were folded into one value; a shape other than 'object' means at least one replica did not answer the schema",
  );
}

/** Classify a folded value without ever recording it. */
function shapeOf(value: unknown): "object" | "array" | "scalar" {
  if (Array.isArray(value)) return "array";
  return typeof value === "object" && value !== null ? "object" : "scalar";
}

/** Re-resolve a round's items, for folding its outcomes back into the state. */
function selectedItems(round: RoundInput, state: WorkflowState): readonly unknown[] {
  const picked = selectItems(round.over, state);
  return "items" in picked ? picked.items : [];
}

/** A position in the authored initial sequence or one candidate repeat pass. */
interface RoundPointer {
  kind: "initial" | "repeat";
  index: number;
  pass: number;
}

/** Mutable state owned by the Admiral for one explicitly controlled sequence. */
interface RoundSequence {
  id: string;
  deps: DispatchDeps;
  call: RoundCall;
  state: WorkflowState;
  reports: RoundReport[];
  status: WorkflowSequenceStatus;
  revision: number;
  current?: RoundPointer;
  next?: RoundPointer;
  seen?: ReadonlySet<string>;
  dryRounds: number;
  budgetExhausted: boolean;
  reason?: string;
}

/** Result shared by start/status/decision handlers. */
interface CoordinatorResult {
  text: string;
  progress: boolean;
  error?: true;
}

/** Arguments accepted by the compare-and-set decision operation. */
interface WorkflowDecision {
  sessionId: string;
  revision: number;
  decision: "continue" | "stop";
  reason: string;
}

/** Per-manager authority over authored round boundaries. */
export interface RoundCoordinator {
  start(deps: DispatchDeps, call: RoundCall): { text: string } | { error: string };
  status(sessionId?: string): CoordinatorResult;
  decide(decision: WorkflowDecision): CoordinatorResult;
  finalizeGate(): FinalizeGate;
}

/** Resolve a pointer to its authored round. */
function pointedRound(sequence: RoundSequence, pointer: RoundPointer): RoundInput | undefined {
  if (pointer.kind === "initial") return sequence.call.rounds[pointer.index];
  const id = sequence.call.repeat?.rounds[pointer.index];
  return id === undefined ? undefined : sequence.call.rounds.find((round) => round.id === id);
}

/** Drain every wave inside one already-authorized semantic round. */
async function drainRound(
  session: DispatchSession,
  waves: readonly PlannedUnit[][],
  prereqs: ReadonlyMap<string, Prerequisite[]>,
): Promise<{ outcomes: DispatchOutcome[]; cancelled: boolean }> {
  const outcomes: DispatchOutcome[] = [];
  const done = new Map<string, DispatchStatus>();
  let cancelled = false;
  const gate = (unit: DispatchUnit): { blocked: string } | null => {
    const blocker = (prereqs.get(unit.key) ?? []).find((p) => done.get(p.key) !== "completed");
    return blocker === undefined ? null : { blocked: `'${blocker.id}' did not finish` };
  };
  const take = (batch: readonly DispatchOutcome[]): void => {
    for (const outcome of batch) {
      outcomes.push(outcome);
      done.set(outcome.key, outcome.status);
      if (outcome.status === "cancelled") cancelled = true;
    }
  };
  for (const wave of waves) {
    take(await session.run(gate));
    if (cancelled) break;
    session.advance(wave);
  }
  if (!cancelled) take(await session.run(gate));
  return { outcomes, cancelled };
}

/** Build the one coordinator shared by every workflow tool on a manager run. */
export function createRoundCoordinator(ctx: WorkflowCtx): RoundCoordinator {
  const sequences = new Map<string, RoundSequence>();
  let activeId: string | undefined;
  let latestId: string | undefined;
  let nextId = 0;
  let finalizeNudge = "";

  const snapshot = (sequence: RoundSequence): WorkflowSequenceState => {
    const current =
      sequence.current === undefined ? undefined : pointedRound(sequence, sequence.current);
    const next = sequence.next === undefined ? undefined : pointedRound(sequence, sequence.next);
    return {
      sessionId: sequence.id,
      status: sequence.status,
      revision: sequence.revision,
      ...(current === undefined ? {} : { roundId: current.id, pass: sequence.current?.pass }),
      ...(next === undefined ? {} : { nextRoundId: next.id, nextPass: sequence.next?.pass }),
      leadersStarted: ctx.leaderCount.started(),
      maxTotalLeaders: ctx.leaderCount.limit,
      ...(sequence.reason === undefined ? {} : { reason: sequence.reason }),
    };
  };

  const publish = (sequence: RoundSequence): void => {
    ctx.onSequenceState?.(snapshot(sequence));
  };

  const terminal = (
    sequence: RoundSequence,
    status: Extract<WorkflowSequenceStatus, "completed" | "stopped" | "failed" | "cancelled">,
    reason: string,
  ): string => {
    sequence.status = status;
    sequence.reason = reason;
    sequence.next = undefined;
    sequence.revision += 1;
    if (activeId === sequence.id) activeId = undefined;
    publish(sequence);
    return `sequence '${sequence.id}' ${status}: ${reason}`;
  };

  const nextAfter = (sequence: RoundSequence, pointer: RoundPointer): RoundPointer | null => {
    if (pointer.kind === "initial") {
      if (pointer.index + 1 < sequence.call.rounds.length) {
        return { kind: "initial", index: pointer.index + 1, pass: 0 };
      }
      const block = sequence.call.repeat;
      if (block === undefined) return null;
      sequence.seen = admitNew(
        producedItems(sequence.state, block),
        block.dedupe_by,
        new Set(),
      ).seen;
      const stop = nextRepeat(block, {
        roundsRun: 0,
        dryRounds: sequence.dryRounds,
        budgetExhausted: sequence.budgetExhausted,
      });
      return stop.done ? null : { kind: "repeat", index: 0, pass: 1 };
    }

    const block = sequence.call.repeat;
    if (block === undefined) return null;
    if (pointer.index + 1 < block.rounds.length) {
      return { kind: "repeat", index: pointer.index + 1, pass: pointer.pass };
    }
    const admitted = admitNew(
      producedItems(sequence.state, block),
      block.dedupe_by,
      sequence.seen ?? new Set(),
    );
    sequence.seen = admitted.seen;
    sequence.dryRounds = admitted.fresh.length === 0 ? sequence.dryRounds + 1 : 0;
    const stop = nextRepeat(block, {
      roundsRun: pointer.pass,
      dryRounds: sequence.dryRounds,
      budgetExhausted: sequence.budgetExhausted,
    });
    if (stop.done) {
      sequence.reason = `repeat stopped: ${stop.reason}`;
      return null;
    }
    return { kind: "repeat", index: 0, pass: pointer.pass + 1 };
  };

  const advance = (sequence: RoundSequence, pointer: RoundPointer): string => {
    if (sequence.budgetExhausted) {
      return terminal(sequence, "failed", "the workflow token budget was exhausted");
    }
    const next = nextAfter(sequence, pointer);
    if (next === null) {
      return terminal(sequence, "completed", sequence.reason ?? "all authorized rounds finished");
    }
    sequence.status = "awaiting_manager";
    sequence.next = next;
    sequence.reason = undefined;
    sequence.revision += 1;
    publish(sequence);
    const proposed = pointedRound(sequence, next);
    return (
      `sequence '${sequence.id}' is awaiting the Admiral at revision ` +
      `${String(sequence.revision)}; proposed next round '${proposed?.id ?? "unknown"}' ` +
      `(pass ${String(next.pass)}). Use workflow_status, then workflow_decide. ` +
      "No leader will start automatically."
    );
  };

  const fold = (
    sequence: RoundSequence,
    round: RoundInput,
    items: readonly unknown[],
    outcomes: readonly DispatchOutcome[],
  ): void => {
    if (outcomes.some((outcome) => outcome.status === "budget_exhausted")) {
      sequence.budgetExhausted = true;
    }
    const folded = foldRound(round, items, outcomes);
    sequence.state.rounds[round.id] = folded;
    const decisions =
      round.accept === undefined
        ? undefined
        : (folded as { accepted: unknown[]; rejected: unknown[] });
    reportRoundFolded(workflowLogger(sequence.deps.ctx), round, folded, outcomes, decisions);
    sequence.reports.push({
      id: round.id,
      leaders: outcomes.length,
      ...(decisions === undefined
        ? {}
        : { accepted: decisions.accepted.length, rejected: decisions.rejected.length }),
    });
  };

  const skip = (
    sequence: RoundSequence,
    pointer: RoundPointer,
    reason: string,
  ): CoordinatorResult => {
    const round = pointedRound(sequence, pointer);
    if (round === undefined)
      return { text: terminal(sequence, "failed", "round not found"), progress: true };
    reportRoundSkipped(workflowLogger(sequence.deps.ctx), round.id, pointer.pass, reason);
    sequence.reports.push({ id: round.id, leaders: 0, skipped: reason });
    sequence.current = pointer;
    sequence.next = undefined;
    sequence.reason = undefined;
    const transition = advance(sequence, pointer);
    return {
      text: `authorized round '${round.id}' was skipped (${reason}). ${transition}`,
      progress: true,
    };
  };

  const reportDriverFault = (
    sequence: RoundSequence,
    round: RoundInput,
    pointer: RoundPointer,
    error: unknown,
  ): void => {
    workflowLogger(sequence.deps.ctx).error(
      {
        event: "workflow.driver_faulted",
        round_id: round.id,
        pass: pointer.pass,
        rounds_done: sequence.reports.length,
        reports: sequence.reports
          .map((report) => `${report.id}:${String(report.leaders)}`)
          .join(","),
        ...faultFields(error),
      },
      "the authorized round driver faulted; the sequence is failed and cannot spawn another round",
    );
  };

  const launch = (
    sequence: RoundSequence,
    pointer: RoundPointer,
    first: boolean,
  ): CoordinatorResult => {
    const logger = workflowLogger(sequence.deps.ctx);
    const round = pointedRound(sequence, pointer);
    if (round === undefined) {
      return {
        text: terminal(sequence, "failed", "the proposed round no longer exists"),
        progress: true,
        error: true,
      };
    }
    if (round.when !== undefined && !whenSatisfied(sequence.state, round.when)) {
      const reason = `'${round.when}' is empty`;
      if (first) {
        reportRoundSkipped(logger, round.id, pointer.pass, reason);
        return {
          text: `the first round '${round.id}' is guarded on ${reason}.`,
          progress: false,
          error: true,
        };
      }
      return skip(sequence, pointer, reason);
    }
    const planned = planRound(round, sequence.state, sequence.call.args, pointer.pass, logger);
    if ("error" in planned) {
      reportRoundSkipped(logger, round.id, pointer.pass, planned.error);
      if (first) return { text: planned.error, progress: false, error: true };
      return skip(sequence, pointer, planned.error);
    }
    const items = selectedItems(round, sequence.state);
    const [head, ...laterWaves] = planned.waves;
    if (head === undefined) {
      if (first)
        return {
          text: `the first round '${round.id}' selected no items.`,
          progress: false,
          error: true,
        };
      return skip(sequence, pointer, "it selected no items");
    }
    const units = planned.waves.reduce((total, wave) => total + wave.length, 0);
    const remaining = sequence.deps.ctx.leaderCount.remaining();
    reportRoundPlanned(logger, round, pointer.pass, planned, items.length);
    let session: DispatchSession | null;
    try {
      session = beginDispatch(sequence.deps, head, units);
    } catch (error) {
      reportDriverFault(sequence, round, pointer, error);
      return {
        text: terminal(sequence, "failed", error instanceof Error ? error.message : String(error)),
        progress: true,
        error: true,
      };
    }
    if (session === null) {
      const text =
        units > remaining
          ? `not starting round '${round.id}' — its ${String(units)} leaders exceed the ` +
            `${String(remaining)} cumulative slot(s) remaining (max_total_leaders=` +
            `${String(sequence.deps.ctx.leaderCount.limit)}). The checkpoint is unchanged.`
          : `not starting round '${round.id}' — too many child agents are already running. ` +
            "Wait with await_agents or end one with agent_stop, then retry the same revision.";
      return { text, progress: false, error: true };
    }

    const handles = session.pendingHandles();
    const queued = session.queuedCount();
    sequence.status = "running_round";
    sequence.current = pointer;
    sequence.next = undefined;
    try {
      publish(sequence);
    } catch (error) {
      reportDriverFault(sequence, round, pointer, error);
      const reason = error instanceof Error ? error.message : String(error);
      let summary = `sequence '${sequence.id}' failed: ${reason}`;
      try {
        summary = terminal(sequence, "failed", reason);
      } finally {
        session.end(summary);
      }
      return { text: summary, progress: true, error: true };
    }

    const driver = (async (): Promise<void> => {
      let summary = "";
      try {
        const drained = await drainRound(session, laterWaves, planned.prereqs);
        fold(sequence, round, items, drained.outcomes);
        sequence.reason = undefined;
        const transition = drained.cancelled
          ? terminal(
              sequence,
              "cancelled",
              "stopped after cancellation; no later round was proposed",
            )
          : advance(sequence, pointer);
        summary = `${describeSummary(sequence.reports)}. ` + transition;
      } catch (err) {
        reportDriverFault(sequence, round, pointer, err);
        summary = terminal(sequence, "failed", err instanceof Error ? err.message : String(err));
      } finally {
        session.end(summary);
      }
    })();
    sequence.deps.agents.adopt(session.anchorId, driver);

    return {
      text: first
        ? describePlan(sequence.call, sequence.id, round, handles, queued)
        : `continued sequence '${sequence.id}' at revision ${String(sequence.revision)}. ` +
          `Round '${round.id}' (pass ${String(pointer.pass)}) is running now: ` +
          `${[...handles.values()].join(", ")}.${describeQueued(queued)} No later round will ` +
          "start without another workflow_decide call.",
      progress: true,
    };
  };

  const find = (sessionId?: string): RoundSequence | undefined => {
    const id = sessionId ?? activeId ?? latestId;
    return id === undefined ? undefined : sequences.get(id);
  };

  const coordinator: RoundCoordinator = {
    start(deps, call) {
      const boundsError = roundCallBoundsError(call);
      if (boundsError !== null) return { error: boundsError };
      const active = activeId === undefined ? undefined : sequences.get(activeId);
      if (active !== undefined) {
        return {
          error:
            `sequence '${active.id}' is ${active.status}; inspect it with workflow_status and ` +
            "continue or stop it before starting another round sequence.",
        };
      }
      const first = call.rounds[0]!;
      if (first.over.kind !== "once") {
        return {
          error:
            `the first round '${first.id}' must be 'once': there is no earlier round for it to ` +
            "consume. Scout with a discovery round, then have later rounds read it by name.",
        };
      }
      const sequence: RoundSequence = {
        id: `wfseq-${String(++nextId)}`,
        deps,
        call,
        state: { rounds: {} },
        reports: [],
        status: "running_round",
        revision: 0,
        dryRounds: 0,
        budgetExhausted: false,
      };
      const result = launch(sequence, { kind: "initial", index: 0, pass: 0 }, true);
      if (result.error === true) return { error: result.text };
      sequences.set(sequence.id, sequence);
      activeId = sequence.id;
      latestId = sequence.id;
      return { text: result.text };
    },
    status(sessionId) {
      const sequence = find(sessionId);
      if (sequence === undefined) {
        return {
          text: "no workflow round sequence exists for this manager run.",
          progress: false,
          error: true,
        };
      }
      const state = snapshot(sequence);
      const next =
        state.nextRoundId === undefined
          ? "none"
          : `'${state.nextRoundId}' (pass ${String(state.nextPass ?? 0)})`;
      return {
        text:
          `sequence '${state.sessionId}': status=${state.status}, revision=${String(state.revision)}, ` +
          `current=${state.roundId ?? "none"}, proposed_next=${next}, leaders_started=` +
          `${String(state.leadersStarted)}/${String(state.maxTotalLeaders)}, remaining=` +
          `${String(ctx.leaderCount.remaining())}${state.reason === undefined ? "" : `, reason=${state.reason}`}.`,
        progress: false,
      };
    },
    decide(decision) {
      const sequence = sequences.get(decision.sessionId);
      if (sequence === undefined) {
        return { text: `unknown sequence '${decision.sessionId}'.`, progress: false, error: true };
      }
      if (sequence.status !== "awaiting_manager" || sequence.next === undefined) {
        return {
          text: `sequence '${sequence.id}' is ${sequence.status}, not awaiting_manager; no leader was spawned.`,
          progress: false,
          error: true,
        };
      }
      if (decision.revision !== sequence.revision) {
        return {
          text:
            `stale decision for sequence '${sequence.id}': expected revision ` +
            `${String(sequence.revision)}, got ${String(decision.revision)}. No leader was spawned.`,
          progress: false,
          error: true,
        };
      }
      if (decision.decision === "stop") {
        return {
          text: terminal(sequence, "stopped", `Admiral stopped it: ${decision.reason}`),
          progress: true,
        };
      }
      const priorReason = sequence.reason;
      sequence.reason = `Admiral continued it: ${decision.reason}`;
      const launched = launch(sequence, sequence.next, false);
      if (launched.error === true && sequence.status === "awaiting_manager") {
        sequence.reason = priorReason;
      }
      return launched;
    },
    finalizeGate(): FinalizeGate {
      return {
        fastAcceptOk: () => {
          const sequence = activeId === undefined ? undefined : sequences.get(activeId);
          return sequence?.status !== "awaiting_manager";
        },
        check(): Promise<GateOutcome> {
          const sequence = activeId === undefined ? undefined : sequences.get(activeId);
          if (sequence === undefined || sequence.status !== "awaiting_manager") {
            return Promise.resolve({ kind: "pass" });
          }
          const key = `${sequence.id}:${String(sequence.revision)}`;
          if (finalizeNudge !== key) {
            finalizeNudge = key;
            return Promise.resolve({
              kind: "nudge",
              note:
                `Workflow sequence '${sequence.id}' is awaiting your decision at revision ` +
                `${String(sequence.revision)}. Inspect it with workflow_status, then call ` +
                "workflow_decide with continue or stop. If you finalize again without deciding, " +
                "Clarvis treats that finalization as stop and spawns nothing.",
            });
          }
          terminal(
            sequence,
            "stopped",
            "the Admiral finalized after one checkpoint nudge, so the pending continuation was declined",
          );
          return Promise.resolve({ kind: "pass" });
        },
      };
    },
  };
  return coordinator;
}

/** Build the checkpoint inspection handler. */
export function buildWorkflowStatusHandler(coordinator: RoundCoordinator): ToolHandler {
  return {
    matches: (call) => call.name === WORKFLOW_STATUS_TOOL_NAME,
    handle(call): Promise<HandlerVerdict> {
      const raw = call.arguments;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return Promise.resolve(
          controlVerdict(WORKFLOW_STATUS_TOOL_NAME, "expected an object.", false),
        );
      }
      const sessionId = (raw as Record<string, unknown>).session_id;
      if (
        sessionId !== undefined &&
        (!isBoundedWorkflowString(sessionId, WORKFLOW_LIMITS.identifierChars) ||
          sessionId.length === 0)
      ) {
        return Promise.resolve(
          controlVerdict(
            WORKFLOW_STATUS_TOOL_NAME,
            "'session_id' must be a bounded non-empty string.",
            false,
          ),
        );
      }
      const result = coordinator.status(typeof sessionId === "string" ? sessionId : undefined);
      return Promise.resolve(
        controlVerdict(WORKFLOW_STATUS_TOOL_NAME, result.text, result.progress),
      );
    },
  };
}

/** Build the explicit compare-and-set decision handler. */
export function buildWorkflowDecideHandler(coordinator: RoundCoordinator): ToolHandler {
  return {
    matches: (call) => call.name === WORKFLOW_DECIDE_TOOL_NAME,
    handle(call): Promise<HandlerVerdict> {
      const raw = call.arguments;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return Promise.resolve(
          controlVerdict(WORKFLOW_DECIDE_TOOL_NAME, "expected an object.", false),
        );
      }
      const record = raw as Record<string, unknown>;
      if (
        !isBoundedWorkflowString(record.session_id, WORKFLOW_LIMITS.identifierChars) ||
        record.session_id.length === 0
      ) {
        return Promise.resolve(
          controlVerdict(WORKFLOW_DECIDE_TOOL_NAME, "'session_id' is required.", false),
        );
      }
      if (!Number.isInteger(record.revision) || Number(record.revision) < 1) {
        return Promise.resolve(
          controlVerdict(
            WORKFLOW_DECIDE_TOOL_NAME,
            "'revision' must be a positive integer.",
            false,
          ),
        );
      }
      if (record.decision !== "continue" && record.decision !== "stop") {
        return Promise.resolve(
          controlVerdict(WORKFLOW_DECIDE_TOOL_NAME, "'decision' must be continue or stop.", false),
        );
      }
      if (
        !isBoundedWorkflowString(record.reason, WORKFLOW_LIMITS.textChars) ||
        record.reason.trim().length === 0
      ) {
        return Promise.resolve(
          controlVerdict(WORKFLOW_DECIDE_TOOL_NAME, "'reason' is required.", false),
        );
      }
      const result = coordinator.decide({
        sessionId: record.session_id,
        revision: Number(record.revision),
        decision: record.decision,
        reason: record.reason,
      });
      return Promise.resolve(
        controlVerdict(WORKFLOW_DECIDE_TOOL_NAME, result.text, result.progress),
      );
    },
  };
}

/** Prefix a workflow control result without claiming model progress on inspection/refusal. */
function controlVerdict(tool: string, text: string, progress: boolean): HandlerVerdict {
  return { kind: "result", text: `Tool '${tool}' result: ${text}`, progress };
}

/** A non-terminal, immediate textual verdict prefixed as a `run_round` result. */
function verdict(text: string): HandlerVerdict {
  return {
    kind: "result",
    text: `Tool '${RUN_ROUND_TOOL_NAME}' result: ${text}`,
    progress: false,
  };
}
