/**
 * The two records the scheduler's decisions leave behind.
 *
 * @remarks They live beside {@link import("./schedule.ts").scheduleWorkItems}
 * rather than inside it because the scheduler is a pure function reached from
 * two call sites — `run_work_items` and a `run_round` consuming work items —
 * and only those sites hold a logger. The scheduler stays testable as a pure
 * matrix and gains no port.
 */
import { levelEnabled, type Logger } from "@clarvis/capability";
import { joinIds } from "./log.ts";
import type { ScheduleWave, WorkItem } from "./schedule.ts";

/**
 * Say what the scheduler derived from a batch of work items.
 *
 * @param logger - the scope the batch belongs to.
 * @param items - the batch as the model emitted it.
 * @param waves - the waves packing produced.
 * @remarks `unscoped_writers` is the point of the record. An item that declares
 *   `mutation` with no `files` is treated as writing everything and is packed
 *   into a wave of its own, which is a correctness-relevant decision taken from
 *   model-authored metadata and otherwise auditable from nothing: the resulting
 *   run just looks serial for no stated reason.
 */
export function reportScheduleDerived(
  logger: Logger,
  items: readonly WorkItem[],
  waves: readonly ScheduleWave[],
): void {
  if (!levelEnabled(logger, "debug")) return;
  logger.debug(
    {
      event: "workflow.schedule_derived",
      items: items.length,
      waves: waves.length,
      wave_sizes: waves.map((wave) => wave.items.length).join(","),
      unscoped_writers: items.filter((item) => item.mutation && item.files.length === 0).length,
    },
    "the batch was packed into waves by declared dependencies and file conflicts; an item that writes without naming files runs alone",
  );
}

/**
 * Say why a batch of work items could not be scheduled at all.
 *
 * @param logger - the scope the batch belongs to.
 * @param failure - the scheduler's structural fault and the ids that caused it.
 */
export function reportScheduleRefused(
  logger: Logger,
  failure: { code: string; ids: readonly string[] },
): void {
  logger.warn(
    {
      event: "workflow.schedule_refused",
      code: failure.code,
      ids: joinIds(failure.ids),
    },
    "the work items describe a graph that cannot be executed, so nothing was started and the model is asked to fix the batch",
  );
}
