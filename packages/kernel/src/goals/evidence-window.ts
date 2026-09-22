import type { Observation } from "./evidence.ts";
import { goalEvidenceDigest } from "./evidence-digest.ts";

/**
 * Select bounded receipts from a replayable host journal without a second persistent store.
 * Two passes retain only the window, pinned proofs and activity candidates. The second pass
 * fences every selected subject against later failures and ignores identical selected replays.
 */
export function selectGoalEvidence(options: {
  replay(): Iterable<Observation>;
  pinned: readonly string[];
  limit: number;
  activity: { execution: string; fingerprint(item: Observation): string | undefined };
}): { observations: Observation[]; activityUnavailable: boolean; activityConflict: boolean } {
  const window = new Map<string, Observation>();
  const pins = new Set(options.pinned);
  const pinned = new Map<string, Observation>();
  const activity = new Map<string, Observation>();
  let activityUnavailable = false;
  let activityConflict = false;
  let activityTruncated = false;
  for (const item of options.replay()) {
    if (!window.has(item.id)) window.set(item.id, item);
    if (window.size > options.limit) window.delete(window.keys().next().value!);
    if (pins.has(item.id) && !pinned.has(item.id)) pinned.set(item.id, item);
    if (item.executionId !== options.activity.execution) continue;
    if (item.unavailable !== undefined) activityUnavailable = true;
    const fingerprint = options.activity.fingerprint(item);
    if (fingerprint === undefined) continue;
    activity.set(fingerprint, item);
    if (activity.size > 32) {
      activity.delete(activity.keys().next().value!);
      activityTruncated = true;
    }
  }
  const selected = new Map([
    ...window,
    ...pinned,
    ...[...activity.values()].map((item) => [item.id, item] as const),
  ]);
  const signature = (item: Observation): string => `${item.tool}:${item.argumentsDigest}`;
  const latest = new Map([...selected.values()].map((item) => [signature(item), ""]));
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const item of options.replay()) {
    if (selected.has(item.id)) {
      const digest = goalEvidenceDigest(item);
      const previous = seen.get(item.id);
      if (previous !== undefined) {
        if (previous === digest) continue;
        ambiguous.add(item.id);
        if (item.executionId === options.activity.execution) {
          activityUnavailable = true;
          activityConflict = true;
        }
      }
      seen.set(item.id, digest);
      if (goalEvidenceDigest(selected.get(item.id)!) !== digest) {
        ambiguous.add(item.id);
        if (item.executionId === options.activity.execution) {
          activityUnavailable = true;
          activityConflict = true;
        }
      }
    }
    const subject = signature(item);
    if (latest.has(subject)) latest.set(subject, item.id);
  }
  const observations = [...selected.values()].filter(
    (item) => !ambiguous.has(item.id) && latest.get(signature(item)) === item.id,
  );
  if (
    activityTruncated &&
    !observations.some(
      (item) =>
        item.executionId === options.activity.execution &&
        options.activity.fingerprint(item) !== undefined,
    )
  )
    activityUnavailable = true;
  return { observations, activityUnavailable, activityConflict };
}
