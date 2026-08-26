import type { CompactionRequest, CompactionSource } from "@clarvis/loop";

/** In-memory control queue for explicit entry-agent compaction requests. */
export interface CompactionQueue extends CompactionSource {
  /** Enqueue while open, returning whether the request was accepted. */
  push(request: CompactionRequest): boolean;
  /** Reject later pushes; already queued requests remain drainable. */
  close(): void;
  /** Inspect pending requests without consuming them. */
  undrained(): CompactionRequest[];
}

/** Create an empty run-scoped compaction request queue. */
export function createCompactionQueue(): CompactionQueue {
  let queue: CompactionRequest[] = [];
  let closed = false;
  return {
    push(request): boolean {
      if (closed) return false;
      queue.push(request);
      return true;
    },
    drain(): CompactionRequest[] {
      const out = queue;
      queue = [];
      return out;
    },
    close(): void {
      closed = true;
    },
    undrained(): CompactionRequest[] {
      return queue;
    },
  };
}
