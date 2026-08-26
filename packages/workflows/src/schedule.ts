/**
 * The derived scheduler: turns a discovery round's `work_items[]` into an ordered
 * list of waves the runtime can dispatch, so the order and the parallelism are
 * computed from the data rather than re-decided by the manager LLM every turn.
 *
 * @remarks Pure and I/O-free on purpose. `work_items[].dependencies` is a
 *   dependency graph and `work_items[].files` + `work_items[].mutation` are a
 *   write-conflict declaration; both were already in
 *   {@link import("./schemas.ts").DISCOVERY_SCHEMA | DISCOVERY_SCHEMA} and neither
 *   was read by any code. The `<mutation_policy>` the shipped manager prompt
 *   carried — "never dispatch two mutating leaders whose files overlap" — was
 *   therefore a workspace-integrity invariant enforced by persuasion. It is
 *   enforced here instead.
 */
import { TASK_TITLE_MAX } from "@clarvis/capability";
import { isBoundedWorkflowString, WORKFLOW_LIMITS } from "./limits.ts";

/**
 * One unit of work a discovery round proposed, matching `work_items[]` of
 * {@link import("./schemas.ts").DISCOVERY_SCHEMA | DISCOVERY_SCHEMA}.
 */
export interface WorkItem {
  /** Unique id within the batch; referenced by other items' `dependencies`. */
  id: string;
  /** Short human-facing label for the leader that executes this item. */
  title: string;
  /** What this item is for; becomes the leader's brief. */
  goal: string;
  /** Files this item would read or change, used to detect conflicts. */
  files: readonly string[];
  /** Ids of items that must finish before this one starts. */
  dependencies: readonly string[];
  /** True when the item writes to the workspace. */
  mutation: boolean;
}

/** One dispatchable wave: items with no conflict and no unmet dependency. */
export interface ScheduleWave {
  readonly items: readonly WorkItem[];
}

/** Why a batch of work items could not be scheduled. */
export type ScheduleErrorCode =
  "limits_exceeded" | "duplicate_id" | "unknown_dependency" | "dependency_cycle";

/**
 * The scheduler's answer: the ordered waves, or the first structural fault found
 * together with the ids that caused it.
 */
export type ScheduleResult =
  | { ok: true; waves: readonly ScheduleWave[] }
  | { ok: false; code: ScheduleErrorCode; message: string; ids: readonly string[] };

/** A work item with its file list normalized once, ahead of O(n²) comparison. */
interface PreparedItem {
  readonly item: WorkItem;
  readonly files: readonly string[];
  readonly mutation: boolean;
}

/**
 * Reduce a model-authored path to the form conflict detection compares.
 *
 * @param raw - the path exactly as the discovery round emitted it.
 * @returns the normalized path, or the empty string when nothing is left.
 * @remarks Comparison is **case-insensitive**: macOS and Windows filesystems are
 *   case-insensitive, so `SRC/a.ts` and `src/a.ts` are one file there. A false
 *   positive only serializes two items that could have run together; a false
 *   negative lets two leaders corrupt a shared workspace. The error is taken on
 *   the side of the conflict.
 */
function normalizePath(raw: string): string {
  let path = raw.trim().replaceAll("\\", "/");
  while (path.startsWith("./")) path = path.slice(2);
  path = path.replace(/\/{2,}/gu, "/");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path.toLowerCase();
}

/**
 * True when two normalized paths name the same file, or one contains the other.
 *
 * @remarks Containment is tested per segment, so `packages/loop` covers
 *   `packages/loop/src/x.ts` while `packages/loo` covers neither.
 */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * True when two items may not run in the same wave.
 *
 * @remarks This is the reader-writer rule, deliberately stronger than the prose
 *   policy it replaces: that one forbade only writer/writer overlap, but a reader
 *   running concurrently with a writer on the same file gets a torn read, which
 *   is a real defect. A mutating item that declared no files has unbounded scope:
 *   it is treated as writing everything and therefore conflicts with every other
 *   item in its layer — readers included — so it is packed into a wave of its own.
 *   Both directions are tested because {@link packLayer} only ever asks
 *   `itemsConflict(member, candidate)`: a guard on `a` alone would make an
 *   unscoped writer refuse newcomers while still joining an existing wave.
 */
function itemsConflict(a: PreparedItem, b: PreparedItem): boolean {
  if (!a.mutation && !b.mutation) return false;
  if (a.mutation && a.files.length === 0) return true;
  if (b.mutation && b.files.length === 0) return true;
  return a.files.some((f) => b.files.some((g) => pathsOverlap(f, g)));
}

/** Find ids that appear more than once, in first-seen order. */
function duplicateIds(items: readonly WorkItem[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) repeated.add(item.id);
    seen.add(item.id);
  }
  return [...repeated];
}

/** Find items depending on an id no item in the batch declares. */
function danglingDependents(items: readonly WorkItem[]): string[] {
  const known = new Set(items.map((i) => i.id));
  return items.filter((i) => i.dependencies.some((d) => !known.has(d))).map((i) => i.id);
}

/**
 * Group items into topological layers: layer 0 depends on nothing, layer *k* only
 * on layers below it.
 *
 * @returns the layers that could be placed, plus the ids of the items that could
 *   not — a non-empty `unplaced` is exactly a dependency cycle, and naming only
 *   its members keeps the diagnostic off the items that were fine.
 */
function topologicalLayers(items: readonly WorkItem[]): {
  layers: WorkItem[][];
  unplaced: string[];
} {
  const layers: WorkItem[][] = [];
  const placed = new Set<string>();
  let pending = [...items];
  while (pending.length > 0) {
    const layer = pending.filter((i) => i.dependencies.every((d) => placed.has(d)));
    if (layer.length === 0) break;
    for (const item of layer) placed.add(item.id);
    pending = pending.filter((i) => !placed.has(i.id));
    layers.push(layer);
  }
  return { layers, unplaced: pending.map((i) => i.id) };
}

/**
 * Pack one topological layer into as few conflict-free waves as possible.
 *
 * @remarks First-fit over the items **in input order**. The greedy pass is
 *   order-sensitive, so the order is pinned to the array the discovery round
 *   produced: the same `work_items[]` therefore always yields the same waves.
 */
function packLayer(layer: readonly PreparedItem[]): PreparedItem[][] {
  const waves: PreparedItem[][] = [];
  for (const candidate of layer) {
    const slot = waves.find((wave) => wave.every((member) => !itemsConflict(member, candidate)));
    if (slot === undefined) waves.push([candidate]);
    else slot.push(candidate);
  }
  return waves;
}

/**
 * Derive the dispatch schedule for one batch of work items.
 *
 * @param items - the batch, in the order the discovery round emitted it.
 * @returns the ordered waves, or the first structural fault with its ids.
 * @remarks Complexity is O(n²·f²) in items and files per item. For the dozens of
 *   items a discovery round realistically returns that is irrelevant; do not
 *   optimize it into something harder to prove correct.
 */
export function scheduleWorkItems(items: readonly WorkItem[]): ScheduleResult {
  if (items.length > WORKFLOW_LIMITS.workItems) {
    return {
      ok: false,
      code: "limits_exceeded",
      message: `a batch may contain at most ${String(WORKFLOW_LIMITS.workItems)} work items`,
      ids: [],
    };
  }
  for (const item of items) {
    if (
      !isBoundedWorkflowString(item.id, WORKFLOW_LIMITS.identifierChars) ||
      !isBoundedWorkflowString(item.title, TASK_TITLE_MAX * 2) ||
      !isBoundedWorkflowString(item.goal, WORKFLOW_LIMITS.textChars) ||
      item.files.length > WORKFLOW_LIMITS.filesPerWorkItem ||
      item.dependencies.length > WORKFLOW_LIMITS.dependenciesPerWorkItem ||
      item.files.some((path) => !isBoundedWorkflowString(path, WORKFLOW_LIMITS.pathChars)) ||
      item.dependencies.some(
        (dependency) => !isBoundedWorkflowString(dependency, WORKFLOW_LIMITS.identifierChars),
      )
    ) {
      return {
        ok: false,
        code: "limits_exceeded",
        message: `work item '${item.id.slice(0, WORKFLOW_LIMITS.identifierChars)}' exceeds a workflow shape limit`,
        ids: [item.id.slice(0, WORKFLOW_LIMITS.identifierChars)],
      };
    }
  }
  const duplicates = duplicateIds(items);
  if (duplicates.length > 0) {
    return {
      ok: false,
      code: "duplicate_id",
      message: `work item ids must be unique; repeated: ${duplicates.join(", ")}`,
      ids: duplicates,
    };
  }

  const dangling = danglingDependents(items);
  if (dangling.length > 0) {
    return {
      ok: false,
      code: "unknown_dependency",
      message:
        "these work items depend on ids that are not in the batch: " +
        `${dangling.join(", ")}; every dependency must name another item's id`,
      ids: dangling,
    };
  }

  const { layers, unplaced } = topologicalLayers(items);
  if (unplaced.length > 0) {
    return {
      ok: false,
      code: "dependency_cycle",
      message: `these work items form a dependency cycle: ${unplaced.join(", ")}`,
      ids: unplaced,
    };
  }

  const waves: ScheduleWave[] = [];
  for (const layer of layers) {
    const prepared = layer.map((item): PreparedItem => ({
      item,
      files: item.files.map(normalizePath).filter((f) => f.length > 0),
      mutation: item.mutation,
    }));
    for (const wave of packLayer(prepared)) waves.push({ items: wave.map((p) => p.item) });
  }
  return { ok: true, waves };
}
