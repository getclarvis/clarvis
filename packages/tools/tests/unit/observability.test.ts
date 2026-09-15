import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { resolveConfig } from "../../src/config.ts";
import { NOOP_TOOLS_LOGGER, setWarnSink, warn, type ToolsLogger } from "../../src/lib/log.ts";
import { fsError, serializeError, ToolError } from "../../src/errors.ts";
import { killTree } from "../../src/lib/process.ts";
import { resolvePath } from "../../src/lib/paths.ts";
import { boundOrSpill, createCaptureSink } from "../../src/lib/output.ts";
import { sandboxCommand } from "../../src/sandbox.ts";
import { readExitState } from "../../src/lib/monitor.ts";
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
      confineToWorkspace: false,
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
      confined: false,
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

describe("tools.path_refused", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") cleanup(root);
    root = "";
  });

  it("separates a genuine escape from a path that could not be resolved", () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    expect(() => resolvePath("../elsewhere", root, true, undefined, logger)).toThrow(ToolError);
    const [record] = eventsOf(records, "tools.path_refused");
    expect(record?.level).toBe("debug");
    expect(record?.fields).toEqual({
      event: "tools.path_refused",
      input: "../elsewhere",
      reason: "outside_root",
      allow_roots_count: 1,
    });
  });

  it("counts every root a confined target was allowed to sit under", () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    expect(() => resolvePath("/definitely/outside", root, true, ["/also/outside"], logger)).toThrow(
      ToolError,
    );
    expect(eventsOf(records, "tools.path_refused")[0]?.fields).toMatchObject({
      allow_roots_count: 2,
    });
  });

  it("an accepted path says nothing", () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    resolvePath("inside.txt", root, true, undefined, logger);
    expect(records).toEqual([]);
  });
});

describe("tools.spill_failed", () => {
  it("reports a spill file that could not be written", async () => {
    const root = makeWorkspace();
    try {
      write(root, "not-a-directory", "x");
      const { logger, records } = recorder();
      const text = await boundOrSpill(
        "abcdefghijklmnopqrstuvwxyz",
        4,
        { absPath: join(root, "not-a-directory", "out.log"), displayPath: "out.log" },
        logger,
        "stdout",
      );
      expect(text.endsWith("wxyz")).toBe(true);
      expect(text).not.toContain("out.log");
      const [record] = eventsOf(records, "tools.spill_failed");
      expect(record?.level).toBe("warn");
      expect(record?.fields).toMatchObject({
        event: "tools.spill_failed",
        stream: "stdout",
        target: "out.log",
      });
      expect(typeof record?.fields.cause).toBe("string");
    } finally {
      cleanup(root);
    }
  });

  it("a write-through sink reports the stream whose overflow was lost", async () => {
    const root = makeWorkspace();
    try {
      write(root, "not-a-directory", "x");
      const { logger, records } = recorder();
      const sink = createCaptureSink({
        inlineLimit: 4,
        captureCap: 1_000,
        spill: () => ({
          absPath: join(root, "not-a-directory", "out.log"),
          displayPath: "err.log",
        }),
        stream: "stderr",
        logger,
      });
      sink.push("aaaaaaaaaa");
      await sink.finish(4);
      expect(eventsOf(records, "tools.spill_failed")[0]?.fields).toMatchObject({
        stream: "stderr",
        target: "err.log",
      });
    } finally {
      cleanup(root);
    }
  });

  it("a successful spill says nothing", async () => {
    const root = makeWorkspace();
    try {
      const { logger, records } = recorder();
      const text = await boundOrSpill(
        "abcdefghijklmnopqrstuvwxyz",
        4,
        { absPath: `${root}/out.log`, displayPath: "out.log" },
        logger,
        "stdout",
      );
      expect(text).toContain("out.log");
      expect(records).toEqual([]);
    } finally {
      cleanup(root);
    }
  });
});

describe("tools.monitor_exit_unreadable", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") cleanup(root);
    root = "";
  });

  it("an unparsable sentinel is reported, not silently folded into 'killed'", async () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    const { ensureWorkspaceLocalDir, workspaceStatePaths } = await import("@clarvis/paths");
    ensureWorkspaceLocalDir(root);
    const exit = workspaceStatePaths(root).monitorExit("mon_badexit");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(exit), { recursive: true });
    writeFileSync(exit, "not-a-number\n");

    const state = await readExitState(root, "mon_badexit", logger);
    expect(state).toEqual({ exited: true, code: null });
    const [record] = eventsOf(records, "tools.monitor_exit_unreadable");
    expect(record?.level).toBe("warn");
    expect(record?.fields).toMatchObject({
      event: "tools.monitor_exit_unreadable",
      id: "mon_badexit",
      raw: "not-a-number",
      reason: "non_numeric",
    });
  });

  it("a still-running monitor with no sentinel says nothing", async () => {
    root = makeWorkspace();
    const { logger, records } = recorder();
    expect(await readExitState(root, "mon_absent", logger)).toEqual({
      exited: false,
      code: null,
    });
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

/**
 * Which grep engine ran is behaviour, not a performance detail.
 *
 * @remarks Ripgrep and the in-process scanner do not share regex semantics, so
 * the choice decides what a pattern means. A confined directory search must
 * stay in-process — ripgrep would walk the tree itself, outside the confinement
 * check every other path goes through.
 *
 * The parity suite cannot see this: it disables confinement precisely so it can
 * compare the two engines, so a regression that started spawning `rg` for
 * confined directories keeps it green. The engine is published on
 * `tools.grep_path`, which is the only seam that observes the decision without
 * reaching into the module.
 */
describe("tools.grep_path", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") cleanup(root);
    root = "";
  });

  const engineFor = async (over: {
    ripgrepAvailable: boolean;
    confineToWorkspace: boolean;
    target?: string;
  }): Promise<string> => {
    const { logger, records } = recorder();
    await callTool(
      "grep",
      { pattern: "needle", ...(over.target === undefined ? {} : { path: over.target }) },
      makeConfig(root, {
        logger,
        ripgrepAvailable: over.ripgrepAvailable,
        confineToWorkspace: over.confineToWorkspace,
      }),
    );
    return eventsOf(records, "tools.grep_path")[0]?.fields.engine as string;
  };

  it("stays in-process for a confined directory even when ripgrep is available", async () => {
    root = makeWorkspace();
    write(root, "a.txt", "needle here\n");
    expect(await engineFor({ ripgrepAvailable: true, confineToWorkspace: true })).toBe(
      "in_process",
    );
  });

  it("uses ripgrep for the same directory once confinement is off", async () => {
    root = makeWorkspace();
    write(root, "a.txt", "needle here\n");
    expect(await engineFor({ ripgrepAvailable: true, confineToWorkspace: false })).toBe("ripgrep");
  });

  it("uses ripgrep for a single confined file, where no tree walk is involved", async () => {
    root = makeWorkspace();
    const file = write(root, "a.txt", "needle here\n");
    expect(
      await engineFor({ ripgrepAvailable: true, confineToWorkspace: true, target: file }),
    ).toBe("ripgrep");
  });

  it("stays in-process when ripgrep is absent, whatever the confinement", async () => {
    root = makeWorkspace();
    write(root, "a.txt", "needle here\n");
    expect(await engineFor({ ripgrepAvailable: false, confineToWorkspace: false })).toBe(
      "in_process",
    );
  });
});
