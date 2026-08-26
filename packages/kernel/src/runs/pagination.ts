import { MAX_TRACE_LIST_LIMIT, MAX_TRACE_LIST_OFFSET } from "@clarvis/trace";
import type { Pagination } from "@clarvis/protocol";
import { kernelError } from "../core/errors.ts";

const DEFAULT_RUN_LIST_LIMIT = 20;

/** Normalize and defend the trace-store page window at the kernel boundary. */
export function normalizeRunPagination(page?: Pagination): Required<Pagination> {
  const limit = page?.limit ?? DEFAULT_RUN_LIST_LIMIT;
  const offset = page?.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_TRACE_LIST_LIMIT) {
    throw kernelError(
      "invalid_request",
      `run list limit must be an integer between 0 and ${MAX_TRACE_LIST_LIMIT}`,
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_TRACE_LIST_OFFSET) {
    throw kernelError(
      "invalid_request",
      `run list offset must be an integer between 0 and ${MAX_TRACE_LIST_OFFSET}`,
    );
  }
  return { limit, offset };
}
