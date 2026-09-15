import type { TracePort } from "./ports.ts";
import type { PortKey } from "./services.ts";

/** Loop-published write access to the current run's trace during capability activation. */
export const RUN_TRACE_PORT: PortKey<TracePort> = { id: "loop.run_trace" };
