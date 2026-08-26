import { describe, it, expect } from "../helpers/bun-test.ts";
import {
  activeLevelOf,
  bindLevelled,
  componentLogger,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  NOOP_LOGGER,
  bind,
  createRateLimiter,
  createSampler,
  isLogLevel,
  levelEnabled,
  levelFor,
  parseLogScopes,
  type LogLevel,
} from "../../src/log.ts";
import type { LogFn, Logger } from "../../src/ports.ts";

function sink(level?: string): { logger: Logger; records: { obj: unknown; msg?: string }[] } {
  const records: { obj: unknown; msg?: string }[] = [];
  const capture: LogFn = (...args: unknown[]) => {
    const [obj, msg] = args;
    records.push({ obj, ...(typeof msg === "string" ? { msg } : {}) });
  };
  return {
    logger: {
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
      ...(level === undefined ? {} : { level }),
    },
    records,
  };
}

describe("LOG_LEVELS", () => {
  it("names the four emittable levels plus silent, and nothing else", () => {
    expect([...LOG_LEVELS]).toEqual(["debug", "info", "warn", "error", "silent"]);
    expect(LOG_LEVELS).not.toContain("trace");
    expect(LOG_LEVELS).not.toContain("fatal");
  });

  it("defaults to info", () => {
    expect(DEFAULT_LOG_LEVEL).toBe("info");
  });
});

describe("isLogLevel", () => {
  it("accepts every declared level", () => {
    for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true);
  });

  it("rejects a level this port cannot emit at", () => {
    expect(isLogLevel("trace")).toBe(false);
    expect(isLogLevel("fatal")).toBe(false);
    expect(isLogLevel("")).toBe(false);
    expect(isLogLevel("toString")).toBe(false);
  });
});

describe("NOOP_LOGGER", () => {
  it("discards every level without throwing", () => {
    expect(() => {
      NOOP_LOGGER.debug({ a: 1 }, "d");
      NOOP_LOGGER.info({ a: 1 }, "i");
      NOOP_LOGGER.warn({ a: 1 }, "w");
      NOOP_LOGGER.error({ a: 1 }, "e");
    }).not.toThrow();
  });

  it("derives itself, so a bound no-op stays a no-op", () => {
    expect(NOOP_LOGGER.child?.({ run_id: "r1" })).toBe(NOOP_LOGGER);
    expect(bind(NOOP_LOGGER, { run_id: "r1" })).toBe(NOOP_LOGGER);
  });

  it("reports silent, so a guarded hot path skips its payload", () => {
    expect(NOOP_LOGGER.level).toBe("silent");
    expect(levelEnabled(NOOP_LOGGER, "error")).toBe(false);
  });
});

describe("levelEnabled", () => {
  it("emits when the logger reports no level", () => {
    const { logger } = sink();
    expect(levelEnabled(logger, "debug")).toBe(true);
  });

  it("emits when the logger reports a level this port does not recognize", () => {
    const { logger } = sink("trace");
    expect(levelEnabled(logger, "debug")).toBe(true);
  });

  it("admits a record at or above the active level", () => {
    const { logger } = sink("warn");
    expect(levelEnabled(logger, "warn")).toBe(true);
    expect(levelEnabled(logger, "error")).toBe(true);
  });

  it("discards a record below the active level", () => {
    const { logger } = sink("warn");
    expect(levelEnabled(logger, "debug")).toBe(false);
    expect(levelEnabled(logger, "info")).toBe(false);
  });

  it("discards everything at silent, including error", () => {
    const { logger } = sink("silent");
    for (const level of ["debug", "info", "warn", "error"] as const) {
      expect(levelEnabled(logger, level)).toBe(false);
    }
  });
});

describe("bind", () => {
  it("derives through child when the backend implements one", () => {
    const derived = sink().logger;
    const seen: Record<string, unknown>[] = [];
    const base: Logger = {
      ...sink().logger,
      child: (bindings) => {
        seen.push(bindings);
        return derived;
      },
    };
    expect(bind(base, { execution_id: "ex_1" })).toBe(derived);
    expect(seen).toEqual([{ execution_id: "ex_1" }]);
  });

  it("returns the logger unchanged when it implements no child", () => {
    const { logger } = sink();
    expect(bind(logger, { execution_id: "ex_1" })).toBe(logger);
  });
});

describe("parseLogScopes", () => {
  it("is empty when nothing is specified", () => {
    expect(parseLogScopes(undefined).size).toBe(0);
    expect(parseLogScopes("").size).toBe(0);
  });

  it("parses a comma-separated list and trims each side", () => {
    const scopes = parseLogScopes(" paths.lease = debug , mcp=warn ");
    expect(scopes.get("paths.lease")).toBe("debug");
    expect(scopes.get("mcp")).toBe("warn");
    expect(scopes.size).toBe(2);
  });

  it("skips an entry with no separator", () => {
    expect(parseLogScopes("mcp,llm=debug").size).toBe(1);
  });

  it("skips an entry naming no component", () => {
    expect(parseLogScopes("=debug").size).toBe(0);
  });

  it("skips an entry naming a level this port cannot emit at", () => {
    expect(parseLogScopes("mcp=trace,llm=fatal,trace=debug").size).toBe(1);
  });

  it("lets a later entry win over an earlier one for the same component", () => {
    expect(parseLogScopes("mcp=warn,mcp=debug").get("mcp")).toBe("debug");
  });
});

describe("levelFor", () => {
  const fallback: LogLevel = "info";

  it("falls back when nothing is configured", () => {
    expect(levelFor(new Map(), "mcp.connect", fallback)).toBe("info");
  });

  it("prefers an exact match", () => {
    const scopes = parseLogScopes("mcp.connect=error");
    expect(levelFor(scopes, "mcp.connect", fallback)).toBe("error");
  });

  it("matches a prefix on a dot boundary", () => {
    const scopes = parseLogScopes("mcp=debug");
    expect(levelFor(scopes, "mcp.connect.retry", fallback)).toBe("debug");
  });

  it("lets the longest matching prefix win", () => {
    const scopes = parseLogScopes("mcp=debug,mcp.connect=error");
    expect(levelFor(scopes, "mcp.connect.retry", fallback)).toBe("error");
    expect(levelFor(scopes, "mcp.pool", fallback)).toBe("debug");
  });

  it("does not match a prefix that is not on a dot boundary", () => {
    const scopes = parseLogScopes("mcp=debug");
    expect(levelFor(scopes, "mcpclient", fallback)).toBe("info");
  });

  it("falls back for a component no scope covers", () => {
    const scopes = parseLogScopes("mcp=debug");
    expect(levelFor(scopes, "llm.cache", fallback)).toBe("info");
  });
});

describe("createSampler", () => {
  it("admits the first eight occurrences, then powers of two", () => {
    const sampled = createSampler();
    const admitted: number[] = [];
    for (let n = 1; n <= 40; n += 1) if (sampled("k")) admitted.push(n);
    expect(admitted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 16, 32]);
  });

  it("counts each key independently", () => {
    const sampled = createSampler();
    for (let n = 0; n < 9; n += 1) sampled("a");
    expect(sampled("a")).toBe(false);
    expect(sampled("b")).toBe(true);
  });

  it("is an instance, so two samplers never share a count", () => {
    const first = createSampler();
    const second = createSampler();
    for (let n = 0; n < 9; n += 1) first("k");
    expect(first("k")).toBe(false);
    expect(second("k")).toBe(true);
  });

  it("evicts the oldest key past its ceiling rather than growing", () => {
    const sampled = createSampler(2);
    sampled("a");
    sampled("a");
    sampled("b");
    sampled("c");
    expect(sampled("a")).toBe(true);
  });

  it("tolerates a zero ceiling", () => {
    const sampled = createSampler(0);
    expect(sampled("a")).toBe(true);
    expect(sampled("b")).toBe(true);
  });
});

describe("createRateLimiter", () => {
  it("admits the first occurrence and suppresses the rest of the window", () => {
    let now = 1_000;
    const allowed = createRateLimiter({ windowMs: 500, clock: () => now });
    expect(allowed("k")).toBe(true);
    now = 1_400;
    expect(allowed("k")).toBe(false);
  });

  it("admits again once the window has passed", () => {
    let now = 1_000;
    const allowed = createRateLimiter({ windowMs: 500, clock: () => now });
    expect(allowed("k")).toBe(true);
    now = 1_500;
    expect(allowed("k")).toBe(true);
  });

  it("keys independently, so one identity never masks another", () => {
    const allowed = createRateLimiter({ windowMs: 500, clock: () => 0 });
    expect(allowed("mcp=a")).toBe(true);
    expect(allowed("mcp=b")).toBe(true);
    expect(allowed("mcp=a")).toBe(false);
  });

  it("evicts the oldest key past its ceiling", () => {
    let now = 0;
    const allowed = createRateLimiter({ windowMs: 10_000, maxKeys: 2, clock: () => now });
    allowed("a");
    now = 1;
    allowed("b");
    now = 2;
    allowed("c");
    now = 3;
    expect(allowed("a")).toBe(true);
  });

  it("tolerates a zero ceiling", () => {
    const allowed = createRateLimiter({ maxKeys: 0, clock: () => 0 });
    expect(allowed("a")).toBe(true);
  });

  it("defaults its window and clock", () => {
    const allowed = createRateLimiter();
    expect(allowed("defaults")).toBe(true);
    expect(allowed("defaults")).toBe(false);
  });
});

function levelled(): {
  logger: Logger;
  derived: { bindings: Record<string, unknown>; level: string | undefined }[];
} {
  const derived: { bindings: Record<string, unknown>; level: string | undefined }[] = [];
  const leaf: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const logger = {
    ...leaf,
    level: "info",
    child(bindings: Record<string, unknown>, options?: { level?: string }) {
      derived.push({ bindings, level: options?.level });
      return leaf;
    },
  } satisfies Logger;
  return { logger, derived };
}

describe("activeLevelOf", () => {
  it("reports a level the port recognizes", () => {
    expect(activeLevelOf(sink("warn").logger)).toBe("warn");
  });

  it("reports nothing when the logger declares no level", () => {
    expect(activeLevelOf(sink().logger)).toBeUndefined();
  });

  it("reports nothing for a level this port cannot emit at", () => {
    expect(activeLevelOf(sink("trace").logger)).toBeUndefined();
  });
});

describe("bindLevelled", () => {
  it("asks the backend for a level when one is given", () => {
    const { logger, derived } = levelled();
    bindLevelled(logger, { component: "audit", audit: true }, "info");
    expect(derived).toEqual([{ bindings: { component: "audit", audit: true }, level: "info" }]);
  });

  it("omits the level when none is given, so the child inherits", () => {
    const { logger, derived } = levelled();
    bindLevelled(logger, { run_id: "r1" });
    expect(derived).toEqual([{ bindings: { run_id: "r1" }, level: undefined }]);
  });

  it("returns the logger unchanged when the backend implements no child", () => {
    const { logger } = sink();
    expect(bindLevelled(logger, { component: "x" }, "debug")).toBe(logger);
  });
});

describe("componentLogger", () => {
  it("stamps the component and requests the level", () => {
    const { logger, derived } = levelled();
    componentLogger(logger, "mcp", "debug");
    expect(derived).toEqual([{ bindings: { component: "mcp" }, level: "debug" }]);
  });

  it("inherits when no level is given", () => {
    const { logger, derived } = levelled();
    componentLogger(logger, "trace");
    expect(derived).toEqual([{ bindings: { component: "trace" }, level: undefined }]);
  });

  it("degrades to the logger itself rather than refusing to log", () => {
    const { logger } = sink();
    expect(componentLogger(logger, "paths", "debug")).toBe(logger);
  });
});
