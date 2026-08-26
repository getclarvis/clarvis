import { describe, it, expect } from "../bun-test.ts";
import { loadEnv } from "@clarvis/capability";

describe("env loader", () => {
  it("applies documented defaults on an empty environment", () => {
    const env = loadEnv({});
    expect(env.CLARVIS_TIMEOUT_CEILING_MS).toBe(600000);
    expect(env.CLARVIS_DEFAULT_TIMEOUT_MS).toBe(300000);
    expect(env.CLARVIS_ITERATION_CEILING).toBe(100);
    expect(env.CLARVIS_TOKEN_CEILING).toBe(200_000_000);
    expect(env.CLARVIS_MCP_CONNECT_TIMEOUT_MS).toBe(10000);
    expect(env.CLARVIS_LOG_LEVEL).toBe("info");
    expect(env.CLARVIS_DEFAULT_MAX_RETRIES).toBe(3);
    expect(env.CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS).toBe(60000);
    expect(env.CLARVIS_DEFAULT_ELICIT_WAIT_MS).toBe(1_800_000);
    expect(env.CLARVIS_RUN_ABORT_SETTLE_MS).toBe(2000);
    expect(env.CLARVIS_MODEL_ABORT_SETTLE_MS).toBe(250);
    expect(env.CLARVIS_COMPACTION_LLM_TIMEOUT_MS).toBe(120000);
  });

  it("defaults trace retention to thirty days", () => {
    const env = loadEnv({});
    expect(env.CLARVIS_TRACE_TTL_DAYS).toBe(30);
    expect(env.CLARVIS_TRACE_CLEANUP_INTERVAL_MS).toBe(3_600_000);
    expect(env.CLARVIS_TRACE_CLEANUP_BATCH_SIZE).toBe(1_000);
    expect(loadEnv({ CLARVIS_TRACE_TTL_DAYS: "30" }).CLARVIS_TRACE_TTL_DAYS).toBe(30);
  });

  it("defaults the fallback budget to the pre-existing escalate/40M pair", () => {
    const env = loadEnv({});
    expect(env.CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT).toBe(40_000_000);
    expect(env.CLARVIS_DEFAULT_ON_EXCEED).toBe("escalate");
    expect(loadEnv({ CLARVIS_DEFAULT_ON_EXCEED: "stop" }).CLARVIS_DEFAULT_ON_EXCEED).toBe("stop");
    expect(() => loadEnv({ CLARVIS_DEFAULT_ON_EXCEED: "ask" })).toThrow(
      /CLARVIS_DEFAULT_ON_EXCEED/,
    );
  });

  it("rejects a default token limit above CLARVIS_TOKEN_CEILING, naming both", () => {
    expect(() => loadEnv({ CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: "300000000" })).toThrow(
      /CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT \(300000000\) must be <= CLARVIS_TOKEN_CEILING/,
    );
    expect(
      loadEnv({
        CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: "300000000",
        CLARVIS_TOKEN_CEILING: "300000000",
      }).CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT,
    ).toBe(300_000_000);
  });

  it("defaults the tools flags on and coerces their booleans", () => {
    const env = loadEnv({});
    expect(env.CLARVIS_AGENT_TOOLS_ENABLED).toBe(true);
    expect(env.CLARVIS_AGENT_TOOLS_CONFINE).toBe(true);
    expect(loadEnv({ CLARVIS_AGENT_TOOLS_ENABLED: "0" }).CLARVIS_AGENT_TOOLS_ENABLED).toBe(false);
    expect(loadEnv({ CLARVIS_AGENT_TOOLS_ENABLED: "false" }).CLARVIS_AGENT_TOOLS_ENABLED).toBe(
      false,
    );
    expect(loadEnv({ CLARVIS_AGENT_TOOLS_CONFINE: "off" }).CLARVIS_AGENT_TOOLS_CONFINE).toBe(false);
  });

  it("coerces numeric strings to numbers", () => {
    const env = loadEnv({
      CLARVIS_MCP_CONNECT_TIMEOUT_MS: "5000",
      CLARVIS_ITERATION_CEILING: "50",
    });
    expect(env.CLARVIS_MCP_CONNECT_TIMEOUT_MS).toBe(5000);
    expect(env.CLARVIS_ITERATION_CEILING).toBe(50);
  });

  it("rejects non-positive integers for numeric env vars", () => {
    expect(() => loadEnv({ CLARVIS_TOKEN_CEILING: "0" })).toThrow();
    expect(() => loadEnv({ CLARVIS_ITERATION_CEILING: "-1" })).toThrow();
  });

  it("rejects a CLARVIS_TIMEOUT_CEILING_MS above the setTimeout ceiling (2^31-1)", () => {
    expect(() => loadEnv({ CLARVIS_TIMEOUT_CEILING_MS: "2147483648" })).toThrow();
    expect(loadEnv({ CLARVIS_TIMEOUT_CEILING_MS: "2147483647" }).CLARVIS_TIMEOUT_CEILING_MS).toBe(
      2147483647,
    );
  });

  it("rejects unknown CLARVIS_LOG_LEVEL", () => {
    expect(() => loadEnv({ CLARVIS_LOG_LEVEL: "verbose" })).toThrow();
  });

  it("returns a frozen object", () => {
    const env = loadEnv({});
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("leaves CLARVIS_OWNER unset by default", () => {
    const env = loadEnv({});
    expect(env.CLARVIS_OWNER).toBeUndefined();
  });
});

describe("env loader coerces booleans and reports invalid values", () => {
  it("treats string falsey values for a bool env var as false", () => {
    for (const v of ["false", "0", "no", "off", "", " FALSE ", "OFF"]) {
      expect(
        loadEnv({ CLARVIS_DEFAULT_COMPACTION_ENABLED: v }).CLARVIS_DEFAULT_COMPACTION_ENABLED,
      ).toBe(false);
    }
  });

  it("treats any other string for a bool env var as true", () => {
    for (const v of ["true", "1", "yes", "on", "anything"]) {
      expect(
        loadEnv({ CLARVIS_DEFAULT_COMPACTION_ENABLED: v }).CLARVIS_DEFAULT_COMPACTION_ENABLED,
      ).toBe(true);
    }
  });

  it("falls back to the default when a bool env var is unset", () => {
    expect(loadEnv({}).CLARVIS_DEFAULT_COMPACTION_ENABLED).toBe(true);
  });

  it("coerces a non-string bool env value through Boolean", () => {
    expect(
      loadEnv({ CLARVIS_DEFAULT_COMPACTION_ENABLED: true as unknown as string })
        .CLARVIS_DEFAULT_COMPACTION_ENABLED,
    ).toBe(true);
    expect(
      loadEnv({ CLARVIS_DEFAULT_COMPACTION_ENABLED: false as unknown as string })
        .CLARVIS_DEFAULT_COMPACTION_ENABLED,
    ).toBe(false);
  });

  it("throws with a field path in the message for an invalid value", () => {
    expect(() => loadEnv({ CLARVIS_ITERATION_CEILING: "-5" })).toThrow(/CLARVIS_ITERATION_CEILING/);
    expect(() => loadEnv({ CLARVIS_ITERATION_CEILING: "abc" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("labels a root-level validation issue as <root>", () => {
    const notAnObject = [] as unknown as NodeJS.ProcessEnv;
    expect(() => loadEnv(notAnObject)).toThrow(/<root>/);
  });
});
