import { isIngestPending } from "@clarvis/kernel/policy";

export {
  deriveRunEventSpan as deriveEventSpan,
  type RunEventSpan as EventSpan,
} from "@clarvis/kernel/policy";

/** Whether a memory-ingest notice still represents work in flight. */
export function memoryIngestIsPending(phase: string | undefined): boolean {
  return isIngestPending(phase);
}

/** Whether a `RunEvent` arrived from a live run or was replayed from a rehydrated session. */
export type EventSource = "live" | "replay";
