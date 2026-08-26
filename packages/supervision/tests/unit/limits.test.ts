import { describe, it, expect } from "bun:test";
import type { EnvConfig, RunRequest } from "@clarvis/capability";

import { resolveAgentsLimits } from "../../src/limits.ts";
import { AGENTS_DEFAULTS } from "../../src/settings.ts";

const ENV = {} as EnvConfig;

function request(agents?: Record<string, number>): RunRequest {
  return { ...(agents === undefined ? {} : { agents }) } as unknown as RunRequest;
}

describe("resolveAgentsLimits", () => {
  it("falls back to every product default when the request carries no block", () => {
    expect(resolveAgentsLimits(request(), ENV)).toEqual({
      bufferLines: AGENTS_DEFAULTS.buffer_lines,
      bufferBytes: AGENTS_DEFAULTS.buffer_bytes,
      maxTotalBufferBytes: AGENTS_DEFAULTS.max_total_buffer_bytes,
      pollMaxBytes: AGENTS_DEFAULTS.poll_max_bytes,
      awaitTimeoutMs: AGENTS_DEFAULTS.await_timeout_ms,
      maxLiveChildren: AGENTS_DEFAULTS.max_live_children,
      maxRetainedChildren: AGENTS_DEFAULTS.max_retained_children,
      maxNoticesPerIteration: AGENTS_DEFAULTS.max_notices_per_iteration,
      maxConsecutiveFailedChildren: AGENTS_DEFAULTS.max_consecutive_failed_children,
      finishNudges: AGENTS_DEFAULTS.finish_nudges,
    });
  });

  it("treats an empty block exactly as an absent one", () => {
    expect(resolveAgentsLimits(request({}), ENV)).toEqual(resolveAgentsLimits(request(), ENV));
  });

  it("merges a partial override over the defaults rather than replacing them", () => {
    const limits = resolveAgentsLimits(request({ max_live_children: 2 }), ENV);
    expect(limits.maxLiveChildren).toBe(2);
    expect(limits.bufferLines).toBe(AGENTS_DEFAULTS.buffer_lines);
    expect(limits.finishNudges).toBe(AGENTS_DEFAULTS.finish_nudges);
  });

  it("carries a zero through instead of reading it as absent", () => {
    const limits = resolveAgentsLimits(
      request({ finish_nudges: 0, max_consecutive_failed_children: 0 }),
      ENV,
    );
    expect(limits.finishNudges).toBe(0);
    expect(limits.maxConsecutiveFailedChildren).toBe(0);
  });

  it("maps every snake_case request field onto its camelCase limit", () => {
    expect(
      resolveAgentsLimits(
        request({
          buffer_lines: 1,
          buffer_bytes: 2,
          max_total_buffer_bytes: 3,
          poll_max_bytes: 4,
          await_timeout_ms: 5,
          max_live_children: 6,
          max_retained_children: 7,
          max_notices_per_iteration: 8,
          max_consecutive_failed_children: 9,
          finish_nudges: 10,
        }),
        ENV,
      ),
    ).toEqual({
      bufferLines: 1,
      bufferBytes: 2,
      maxTotalBufferBytes: 3,
      pollMaxBytes: 4,
      awaitTimeoutMs: 5,
      maxLiveChildren: 6,
      maxRetainedChildren: 7,
      maxNoticesPerIteration: 8,
      maxConsecutiveFailedChildren: 9,
      finishNudges: 10,
    });
  });
});
