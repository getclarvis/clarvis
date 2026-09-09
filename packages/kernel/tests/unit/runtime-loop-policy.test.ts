import { describe, expect, it } from "bun:test";
import { loadEnv } from "@clarvis/capability";
import {
  guestLoopEnvironment,
  runtimeLoopPolicy,
  validRuntimeLoopPolicy,
} from "../../src/runtime/loop-policy.ts";

describe("isolated loop policy", () => {
  it("round-trips resolved defaults and ceilings without host identity or logging", () => {
    const env = loadEnv({
      CLARVIS_OWNER: "private-owner",
      CLARVIS_LOG: "private.component=debug",
      CLARVIS_DEFAULT_ELICIT_WAIT_MS: "1234",
      CLARVIS_RETRY_CEILING: "0",
      CLARVIS_DEFAULT_MAX_RETRIES: "0",
      CLARVIS_DEFAULT_REASONING_EFFORT: "high",
      CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "2048",
      CLARVIS_DEFAULT_COMPACTION_ENABLED: "false",
    });
    const policy: unknown = JSON.parse(JSON.stringify(runtimeLoopPolicy(env)));
    expect(validRuntimeLoopPolicy(policy)).toBe(true);
    expect(policy).not.toHaveProperty("CLARVIS_OWNER");
    expect(policy).not.toHaveProperty("CLARVIS_LOG");
    expect(policy).not.toHaveProperty("CLARVIS_AGENT_TOOLS_ENABLED");
    if (!validRuntimeLoopPolicy(policy)) throw new Error("expected admitted policy");
    const guest = guestLoopEnvironment(policy, { enabled: false, confine: true, maxGrant: "read" });
    expect(runtimeLoopPolicy(guest)).toEqual(runtimeLoopPolicy(env));
    expect(guest.CLARVIS_AGENT_TOOLS_ENABLED).toBe(false);
    expect(guest.CLARVIS_AGENT_TOOLS_MAX_GRANT).toBe("read");
    expect(guest.CLARVIS_LOG_LEVEL).toBe("silent");
    expect(guest.CLARVIS_OWNER).toBeUndefined();
    expect(guest.CLARVIS_LOG).toBeUndefined();
  });

  it.each(
    [
      undefined,
      null,
      [],
      {},
      { ...runtimeLoopPolicy(loadEnv({})), CLARVIS_DEFAULT_ELICIT_WAIT_MS: undefined },
      { ...runtimeLoopPolicy(loadEnv({})), CLARVIS_RETRY_CEILING: "10" },
      { ...runtimeLoopPolicy(loadEnv({})), CLARVIS_DEFAULT_COMPACTION_ENABLED: "false" },
      { ...runtimeLoopPolicy(loadEnv({})), CLARVIS_RETRY_CEILING: 0 },
      { ...runtimeLoopPolicy(loadEnv({})), CLARVIS_OWNER: "injected" },
      { ...runtimeLoopPolicy(loadEnv({})), CLARVIS_LOG: "injected" },
      { ...runtimeLoopPolicy(loadEnv({})), PROVIDER_API_KEY: "injected" },
    ].map((value) => ({ value })),
  )("rejects missing, coerced, inconsistent or unadmitted policy %#", ({ value }) => {
    expect(validRuntimeLoopPolicy(value)).toBe(false);
  });
});
