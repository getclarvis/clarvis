import type { TraceStore } from "@clarvis/trace";
import { createMemoryTraceStore } from "@clarvis/trace/testing";

export function makeTestTraceStore(): TraceStore {
  return createMemoryTraceStore();
}
