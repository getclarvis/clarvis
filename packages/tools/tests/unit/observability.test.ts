import { afterEach, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../src/config.ts";
import { NOOP_TOOLS_LOGGER, setWarnSink, warn, type ToolsLogger } from "../../src/lib/log.ts";
import { fsError, serializeError } from "../../src/errors.ts";
import { killTree } from "../../src/lib/process.ts";
import { bestEffort } from "../../src/lib/tasks.ts";
import { cleanup, makeWorkspace } from "../helpers/fixtures.ts";

interface Record_ {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}

function recorder(): { logger: ToolsLogger; records: Record_[] } {
  const records: Record_[] = [];
  const at =
    (level: Record_["level"]) =>
    (fields: Record<string, unknown>, msg: string): void => {
      records.push({ level, fields, msg });
    };
  return {
    records,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

function eventsOf(records: Record_[], name: string): Record_[] {
  return records.filter((r) => r.fields.event === name);
}

describe("the logger contract", () => {
  it("the no-op logger discards every level", () => {
    expect(NOOP_TOOLS_LOGGER.debug({}, "m")).toBeUndefined();
    expect(NOOP_TOOLS_LOGGER.info({}, "m")).toBeUndefined();
    expect(NOOP_TOOLS_LOGGER.warn({}, "m")).toBeUndefined();
    expect(NOOP_TOOLS_LOGGER.error({}, "m")).toBeUndefined();
  });
});

describe("tools.config_resolved", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") cleanup(root);
    root = "";
  });

  it("reports the flags that decide the advertised surface", () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    resolveConfig({
      workspaceRoot: root,
      logger,
      readOnly: true,
    });
    const [record] = eventsOf(records, "tools.config_resolved");
    expect(record?.level).toBe("debug");
    expect(record?.fields).toEqual({
      event: "tools.config_resolved",
      read_only: true,
      platform: process.platform,
    });
  });

  it("a toolset built without a logger still resolves", () => {
    root = makeWorkspace();
    const config = resolveConfig({
      workspaceRoot: root,
    });
    expect(config.logger).toBe(NOOP_TOOLS_LOGGER);
  });
});

describe("tools.kill_tree_failed", () => {
  it("reports a tree nothing could be signalled for", () => {
    const { logger, records } = recorder();
    const unusedPid = 2_147_483_600;
    expect(killTree(unusedPid, "SIGTERM", { platform: "linux", logger })).toBe(false);
    expect(eventsOf(records, "tools.kill_tree_failed")[0]).toMatchObject({
      level: "warn",
      fields: {
        event: "tools.kill_tree_failed",
        pid: unusedPid,
        signal: "SIGTERM",
        platform: "linux",
      },
    });
  });

  it("reports the Windows path too, where the signal is not the mechanism", () => {
    const { logger, records } = recorder();
    const unusedPid = 2_147_483_601;
    expect(
      killTree(unusedPid, "SIGTERM", {
        platform: "win32",
        taskkill: () => ({ status: 1 }),
        logger,
      }),
    ).toBe(false);
    expect(eventsOf(records, "tools.kill_tree_failed")[0]?.fields).toMatchObject({
      platform: "win32",
    });
  });

  it("a successful kill says nothing", () => {
    const { logger, records } = recorder();
    expect(
      killTree(1, "SIGTERM", { platform: "win32", taskkill: () => ({ status: 0 }), logger }),
    ).toBe(true);
    expect(records).toEqual([]);
  });
});

describe("the process-wide warn sink", () => {
  afterEach(() => {
    setWarnSink(null);
  });

  it("carries a stable event name beside the message", () => {
    const seen: { message: string; event?: string; fields?: Record<string, unknown> }[] = [];
    setWarnSink((message, warning) => {
      seen.push({ message, event: warning?.event, fields: warning?.fields });
    });
    serializeError(new Error("boom"));
    expect(seen[0]?.event).toBe("tools.internal_error");
    expect(typeof seen[0]?.fields?.err).toBe("string");
  });

  it("marks the internal error as error-level, not warn", () => {
    let level: string | undefined;
    setWarnSink((_message, warning) => {
      level = warning?.level;
    });
    serializeError("a bare string");
    expect(level).toBe("error");
  });

  it("names the errno behind an unmapped filesystem failure", () => {
    const seen: { event?: string; level?: string; fields?: Record<string, unknown> }[] = [];
    setWarnSink((_message, warning) => {
      seen.push({ event: warning?.event, level: warning?.level, fields: warning?.fields });
    });
    const err = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
      syscall: "open",
    });
    expect(fsError(err, "/ws/a.txt").code).toBe("io_error");
    expect(seen).toEqual([
      {
        event: "tools.fs_error_unmapped",
        level: "debug",
        fields: {
          errno_code: "EPERM",
          syscall: "open",
          path: "/ws/a.txt",
          platform: process.platform,
        },
      },
    ]);
  });

  it("reports a null errno rather than inventing one", () => {
    const seen: Record<string, unknown>[] = [];
    setWarnSink((_message, warning) => {
      if (warning?.fields) seen.push(warning.fields);
    });
    fsError(new Error("bare"), "/ws/a.txt");
    expect(seen[0]).toMatchObject({ errno_code: null, syscall: null });
  });

  it.each(["ENOENT", "EISDIR", "ENOTDIR"])("says nothing for a mapped %s", (code) => {
    const seen: unknown[] = [];
    setWarnSink((message) => seen.push(message));
    fsError(Object.assign(new Error("x"), { code }), "/ws/a.txt");
    expect(seen).toEqual([]);
  });

  it("a message with no structured half still reaches the sink", () => {
    const seen: (string | undefined)[] = [];
    setWarnSink((message, warning) => seen.push(warning?.event ?? message));
    warn("bare\n");
    expect(seen).toEqual(["bare\n"]);
  });

  it("reports a failed best-effort cleanup without rejecting its caller", async () => {
    const seen: { message: string; event?: string; fields?: Record<string, unknown> }[] = [];
    setWarnSink((message, warning) => {
      seen.push({ message, event: warning?.event, fields: warning?.fields });
    });

    await expect(
      bestEffort("test_cleanup", () => Promise.reject(new Error("cleanup failed"))),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([
      {
        message: "best-effort operation failed (test_cleanup)\n",
        event: "tools.best_effort_failed",
        fields: { operation: "test_cleanup" },
      },
    ]);
  });
});
