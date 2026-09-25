import { afterEach, describe, expect, it } from "bun:test";
import { resolveConfig } from "../../src/config.ts";
import { NOOP_TOOLS_LOGGER, setWarnSink, warn, type ToolsLogger } from "../../src/lib/log.ts";
import { fsError, serializeError, ToolError } from "../../src/errors.ts";
import { killTree } from "../../src/lib/process.ts";
import { sandboxCommand } from "../../src/sandbox.ts";
import { bestEffort } from "../../src/lib/tasks.ts";
import { callTool, cleanup, makeConfig, makeWorkspace, write } from "../helpers/fixtures.ts";

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
      probeRipgrep: () => true,
      readOnly: true,
      sandbox: { type: "native", availability: "optional" },
    });
    const [record] = eventsOf(records, "tools.config_resolved");
    expect(record?.level).toBe("debug");
    expect(record?.fields).toEqual({
      event: "tools.config_resolved",
      ripgrep: true,
      sandbox_mode: "native",
      sandbox_availability: "optional",
      read_only: true,
      skill_execution_roots: 0,
      platform: process.platform,
    });
  });

  it("names no sandbox when none is configured", () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    resolveConfig({
      workspaceRoot: root,
      logger,
      probeRipgrep: () => false,
    });
    expect(eventsOf(records, "tools.config_resolved")[0]?.fields).toMatchObject({
      sandbox_mode: "none",
      sandbox_availability: null,
      ripgrep: false,
    });
  });

  it("a toolset built without a logger still resolves", () => {
    root = makeWorkspace();
    const config = resolveConfig({
      workspaceRoot: root,
      probeRipgrep: () => false,
    });
    expect(config.logger).toBe(NOOP_TOOLS_LOGGER);
  });
});

describe("tools.sandbox_unavailable", () => {
  it("fails closed instead of logging a silent optional fallback", () => {
    const { logger, records } = recorder();
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        sandbox: { type: "native", availability: "optional" },
        probe: () => ({
          backend: "unsupported",
          mode: "unavailable",
          reason: "bwrap executable was not found",
        }),
        shell: () => ({ flavor: "posix", file: "sh" }),
        logger,
      }),
    ).toThrow("Native sandbox is required: bwrap executable was not found");
    expect(eventsOf(records, "tools.sandbox_unavailable")).toEqual([]);
  });

  it("says nothing when no sandbox was asked for", () => {
    const { logger, records } = recorder();
    const spec = sandboxCommand({
      command: "true",
      cwd: "/ws",
      workspaceRoot: "/ws",
      shell: () => ({ flavor: "posix", file: "sh" }),
      logger,
    });
    expect(spec.sandboxed).toBe(false);
    expect(records).toEqual([]);
  });

  it("a required sandbox still throws rather than degrading quietly", () => {
    expect(() =>
      sandboxCommand({
        command: "true",
        cwd: "/ws",
        workspaceRoot: "/ws",
        sandbox: { type: "native", availability: "required" },
        probe: () => ({ backend: "unsupported", mode: "unavailable", reason: "no namespaces" }),
        shell: () => ({ flavor: "posix", file: "sh" }),
      }),
    ).toThrow(ToolError);
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

/** Directory searches stay in-process so each candidate receives classified-path admission. */
describe("tools.grep_path", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") cleanup(root);
    root = "";
  });

  const engineFor = async (over: {
    ripgrepAvailable: boolean;
    target?: string;
  }): Promise<string> => {
    const { logger, records } = recorder();
    await callTool(
      "grep",
      { pattern: "needle", ...(over.target === undefined ? {} : { path: over.target }) },
      makeConfig(root, {
        logger,
        ripgrepAvailable: over.ripgrepAvailable,
      }),
    );
    return eventsOf(records, "tools.grep_path")[0]?.fields.engine as string;
  };

  it("stays in-process for a directory even when ripgrep is available", async () => {
    root = makeWorkspace();
    write(root, "a.txt", "needle here\n");
    expect(await engineFor({ ripgrepAvailable: true })).toBe("in_process");
  });

  it("uses ripgrep for a single file, where no tree walk is involved", async () => {
    root = makeWorkspace();
    const file = write(root, "a.txt", "needle here\n");
    expect(await engineFor({ ripgrepAvailable: true, target: file })).toBe("ripgrep");
  });

  it("stays in-process when ripgrep is absent", async () => {
    root = makeWorkspace();
    write(root, "a.txt", "needle here\n");
    expect(await engineFor({ ripgrepAvailable: false })).toBe("in_process");
  });
});
