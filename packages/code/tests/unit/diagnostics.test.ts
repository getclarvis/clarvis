import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticSession } from "../../src/adapters/diagnostic-session.ts";
import { createComponentLoggers } from "@clarvis/kernel";
import { diagnosticAsync, installDiagnosticSession } from "../../src/core/diagnostic-events.ts";

const made: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-diagnostics-"));
  made.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("diagnostics writes versioned JSONL, redacts content and adapts the kernel logger", () => {
  const directory = tempDir();
  let time = Date.UTC(2026, 7, 12, 12);
  const session = createDiagnosticSession({
    directory,
    pid: 42,
    now: () => time++,
  });
  session.event("view.opened", {
    route: "workflows",
    prompt: "do not persist me",
    api_key: "top-secret",
    note: "Bearer abcdef and token=ghp_12345678",
    ansi: "\u001B[31mfailed\u001B[0m",
    privateKey: "private-key-value",
    refreshToken: "refresh-token-value",
    credentialValue: "credential-value",
    requestBody: "request-body-value",
    promptText: "prompt-text-value",
    toolArguments: "tool-arguments-value",
  });
  session.logger.warn(
    {
      cause: "https://alice:hunter2@example.test/path",
      messages: ["message-array-value"],
      err: "Bearer scalar-secret",
      execution_id: "exec_1",
      hook_event: "pre_tool",
      timeout_ms: 500,
    },
    "backend warning",
  );
  session.close();

  const raw = readFileSync(session.path, "utf8");
  expect(raw).not.toContain("do not persist me");
  expect(raw).not.toContain("top-secret");
  expect(raw).not.toContain("abcdef");
  expect(raw).not.toContain("hunter2");
  expect(raw).not.toContain("scalar-secret");
  for (const value of [
    "message-array-value",
    "private-key-value",
    "refresh-token-value",
    "credential-value",
    "request-body-value",
    "prompt-text-value",
    "tool-arguments-value",
  ])
    expect(raw).not.toContain(value);
  expect(raw).not.toContain("\u001b");
  expect(raw).toContain("[redacted]");

  const parsed = records(session.path);
  expect(parsed.map((entry) => entry.event)).toEqual([
    "diagnostics.start",
    "view.opened",
    "kernel.warn",
    "diagnostics.stop",
  ]);
  expect(parsed.map((entry) => entry.source)).toEqual(["code", "code", "kernel", "code"]);
  expect(parsed.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  expect(parsed[2]?.details).toEqual({
    context: {
      cause: "https://[redacted]@example.test/path",
      err: "Bearer [redacted]",
      execution_id: "exec_1",
      hook_event: "pre_tool",
      messages: "[redacted]",
      timeout_ms: 500,
    },
    message: "backend warning",
  });
});

test("a kernel field nobody foresaw is carried, not silently dropped", () => {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-diagnostics-"));
  const session = createDiagnosticSession({ directory, pid: 42, now: () => Date.UTC(2026, 7, 12) });
  session.logger.warn(
    { a_field_no_allowlist_ever_had: "kept", tool: "shell", iteration: 7, nested: { depth: 1 } },
    "novel fields",
  );
  session.close();

  expect(records(session.path)[1]?.details).toEqual({
    context: {
      a_field_no_allowlist_ever_had: "kept",
      tool: "shell",
      iteration: 7,
      nested: { depth: 1 },
    },
    message: "novel fields",
  });
});

test("a kernel line keeps the event name its payload declares", () => {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-diagnostics-"));
  const session = createDiagnosticSession({ directory, pid: 42, now: () => Date.UTC(2026, 7, 12) });
  session.logger.warn({ event: "mcp.connect.failed", mcp: "github" }, "server did not connect");
  session.logger.warn({ event: "NOT A VALID NAME" }, "falls back");
  session.logger.warn({ nothing: "declared" }, "falls back too");
  session.logger.warn("a bare message");
  session.close();

  expect(records(session.path).map((entry) => entry.event)).toEqual([
    "diagnostics.start",
    "mcp.connect.failed",
    "kernel.warn",
    "kernel.warn",
    "kernel.warn",
    "diagnostics.stop",
  ]);
});

test("a diagnostic record states the path of the file it is written to", () => {
  const directory = mkdtempSync(join(tmpdir(), "clarvis-diagnostics-"));
  const session = createDiagnosticSession({ directory, pid: 42, now: () => Date.UTC(2026, 7, 12) });
  session.close();

  const start = records(session.path)[0];
  expect((start?.details as { path?: string } | undefined)?.path).toBe(session.path);
});

test("sanitization is bounded before traversal and never invokes accessors", () => {
  let getterCalls = 0;
  const nested = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(nested, "danger", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "should-not-run";
    },
  });
  const session = createDiagnosticSession({ directory: tempDir() });
  session.event("test.large", {
    note: "x".repeat(2 * 1024 * 1024),
    nested,
    payload: "private tool payload",
  });
  session.close();

  const raw = readFileSync(session.path, "utf8");
  expect(getterCalls).toBe(0);
  expect(raw).not.toContain("should-not-run");
  expect(raw).not.toContain("private tool payload");
  expect(raw).toContain("[accessor]");
  expect(statSync(session.path).size).toBeLessThan(16_000);
});

test("a reference repeated across keys is logged twice, and a real cycle still caught", () => {
  // `seen` tracks the current path, so it is unwound on the way back out.
  // Retaining it recorded an ordinary shared reference as "[circular]" and lost
  // the very value the diagnostic was written to capture.
  const shared = { host: "example.test", port: 443 };
  const cyclic: Record<string, unknown> = { label: "loop" };
  cyclic.self = cyclic;
  const session = createDiagnosticSession({ directory: tempDir() });
  session.event("test.shared", { primary: shared, secondary: shared, cyclic });
  session.close();

  const entry = records(session.path).find((row) => row.event === "test.shared")!;
  const details = entry.details as Record<string, Record<string, unknown>>;
  expect(details.primary).toEqual({ host: "example.test", port: 443 });
  expect(details.secondary).toEqual({ host: "example.test", port: 443 });
  expect(details.cyclic!.self).toBe("[circular]");
});

test("diagnostics bound strings, errors, object keys and whole records", () => {
  const directory = tempDir();
  const options = { directory, now: () => 0, pid: 77 };
  const first = createDiagnosticSession(options);
  const second = createDiagnosticSession(options);

  expect(second.path).not.toBe(first.path);
  expect(second.path).toEndWith("-1.jsonl");
  first.logger.info("kernel is ready");
  first.event("sanitize.edges", {
    longNote: "ordinary diagnostic text ".repeat(160),
    failure: new Error("expected failure"),
  });
  first.event("sanitize.keys", {
    many: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`key${index}`, index])),
  });
  first.event("sanitize.record", {
    many: Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `key${index}`,
        "ordinary diagnostic detail ".repeat(24),
      ]),
    ),
  });
  first.close();
  second.close();

  const parsed = records(first.path);
  expect(parsed.find((entry) => entry.event === "kernel.info")?.details).toEqual({
    message: "kernel is ready",
  });
  expect(parsed.find((entry) => entry.event === "sanitize.edges")?.details).toMatchObject({
    longNote: expect.stringContaining("[truncated"),
    failure: { name: "Error", message: "expected failure" },
  });
  expect(parsed.find((entry) => entry.event === "sanitize.keys")?.details).toMatchObject({
    many: { __truncated_keys: true },
  });
  expect(parsed.find((entry) => entry.event === "sanitize.record")?.details).toEqual({
    truncated: true,
    reason: "record exceeded 16 KiB",
  });
});

test("counter sampling exposes a runaway at powers of two without logging every call", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 43 });
  for (let index = 0; index < 1_024; index++) session.count("overlay.view.factory");
  session.close();

  const counts = records(session.path)
    .filter((entry) => entry.event === "overlay.view.factory")
    .map((entry) => (entry.details as { count: number }).count);
  expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 16, 32, 64, 128, 256, 512, 1024]);
  expect(statSync(session.path).size).toBeLessThan(16_000);
});

test("pathological event identities are normalized before the counter map retains them", () => {
  const session = createDiagnosticSession({ directory: tempDir() });
  const hostile = `plugin.${"x".repeat(10_000)}`;
  session.count(hostile, {}, hostile);
  session.close();

  const raw = readFileSync(session.path, "utf8");
  expect(raw).not.toContain(hostile);
  const parsed = records(session.path);
  expect(parsed[1]?.event).toBe("diagnostics.invalid-event");
  expect(parsed.at(-1)?.details).toMatchObject({
    topCounters: [{ name: "diagnostics.invalid-counter", count: 1 }],
  });
});

test("physical async work uses one standard start, pending and settled vocabulary", async () => {
  const session = createDiagnosticSession({ directory: tempDir() });
  const uninstall = installDiagnosticSession(session);
  let resolve!: () => void;
  let slowCalls = 0;
  try {
    const pending = diagnosticAsync(
      "test.operation",
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      { slowMs: 1, onSlow: () => (slowCalls += 1) },
    );
    await new Promise((done) => setTimeout(done, 5));
    resolve();
    await pending;
  } finally {
    uninstall();
    session.close();
  }

  expect(slowCalls).toBe(1);
  expect(records(session.path).map((entry) => entry.event)).toEqual([
    "diagnostics.start",
    "async.started",
    "async.pending",
    "async.settled",
    "diagnostics.stop",
  ]);
});

test("file size and retention remain bounded", () => {
  const directory = tempDir();
  let time = Date.UTC(2026, 7, 12, 12);
  for (let index = 0; index < 4; index++) {
    const session = createDiagnosticSession({
      directory,
      pid: index,
      keepFiles: 2,
      maxBytes: 4_096,
      now: () => time++,
    });
    for (let event = 0; event < 100; event++)
      session.event("test.payload", { value: "x".repeat(500), event });
    session.close();
    expect(statSync(session.path).size).toBeLessThanOrEqual(4_096);
    for (const record of records(session.path)) expect(record.v).toBe(1);
    const events = records(session.path).map((record) => record.event);
    expect(events).toContain("diagnostics.saturated");
    expect(events.at(-1)).toBe("diagnostics.stop");
  }
  expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl")).length).toBe(2);
});

test("non-finite limit seams fall back to production bounds", () => {
  const directory = tempDir();
  for (let index = 0; index < 7; index++) {
    const session = createDiagnosticSession({
      directory,
      pid: index,
      maxBytes: Number.POSITIVE_INFINITY,
      keepFiles: Number.NaN,
    });
    session.event("test.payload", { value: "x".repeat(20_000) });
    session.close();
  }
  expect(readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toHaveLength(5);
  for (const name of readdirSync(directory))
    expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("a level floor drops quieter records but never the session's own lifecycle", () => {
  const directory = tempDir();
  const session = createDiagnosticSession({ directory, pid: 44, level: "warn" });
  expect(session.level).toBe("warn");
  session.event("noise.debug", {}, "debug");
  session.event("noise.info", {}, "info");
  session.event("real.warning", {}, "warn");
  session.event("real.failure", {}, "error");
  session.logger.debug({ event: "kernel.quiet" }, "quiet");
  session.logger.error({ event: "kernel.loud" }, "loud");
  session.close();

  expect(records(session.path).map((entry) => entry.event)).toEqual([
    "diagnostics.start",
    "real.warning",
    "real.failure",
    "kernel.loud",
    "diagnostics.stop",
  ]);
});

test("the default level records everything, so --debug without a level is unchanged", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 45 });
  expect(session.level).toBe("debug");
  session.event("noise.debug", {}, "debug");
  session.close();

  expect(records(session.path).map((entry) => entry.event)).toContain("noise.debug");
});

test("bound fields stamp the envelope, are removable, and cannot rewrite it", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 46 });
  session.bind({ workspace: "/home/user/project", executionId: "exec_7" });
  session.bind({ event: "hijacked", seq: 9999, apiKey: "top-secret" });
  session.event("first.record");
  session.bind({ execution_id: undefined });
  session.event("second.record");
  session.close();

  const parsed = records(session.path);
  const first = parsed.find((entry) => entry.event === "first.record")!;
  const second = parsed.find((entry) => entry.event === "second.record")!;
  expect(first.workspace).toBe("/home/user/project");
  expect(first.execution_id).toBe("exec_7");
  expect(first.event).toBe("first.record");
  expect(first.seq).toBe(2);
  expect(first.api_key).toBe("[redacted]");
  expect(second.execution_id).toBeUndefined();
  expect(second.workspace).toBe("/home/user/project");
});

test("memory is sampled, never written on every record, and always present at warn", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 47 });
  for (let index = 0; index < 40; index++) session.event(`sample.${index}`);
  session.event("pressure.tripped", {}, "warn");
  session.close();

  const parsed = records(session.path);
  const sampled = parsed.filter((entry) => entry.memory !== undefined);
  expect(sampled.length).toBeLessThan(parsed.length / 4);
  expect(sampled.map((entry) => entry.seq)).toContain(1);
  expect(parsed.find((entry) => entry.event === "pressure.tripped")?.memory).toBeDefined();
  expect(parsed.find((entry) => entry.event === "sample.5")?.memory).toBeUndefined();
});

test("CLARVIS_LOG scopes reach this sink: a component's records carry it and honour its level", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 48 });
  const componentLogger = createComponentLoggers(
    session.logger,
    "worktrees=error,mcp=debug",
    "info",
  );

  componentLogger("worktrees").debug({ event: "worktree.git.started" }, "scoped away");
  componentLogger("worktrees").error({ event: "worktree.git.failed" }, "kept");
  componentLogger("mcp").debug({ event: "mcp.connect.attempt" }, "kept");
  componentLogger("trace").debug({ event: "trace.swept" }, "below the fallback level");
  componentLogger("trace").info({ event: "trace.recovery_completed" }, "kept");
  session.close();

  const parsed = records(session.path);
  expect(parsed.map((entry) => entry.event)).toEqual([
    "diagnostics.start",
    "worktree.git.failed",
    "mcp.connect.attempt",
    "trace.recovery_completed",
    "diagnostics.stop",
  ]);
  // Without `child` the kernel falls back to the root logger, which carries no
  // `component` at all — so nothing could be grouped by subsystem and
  // `CLARVIS_LOG` matched against a field that was never written.
  expect(
    parsed
      .filter((entry) => entry.source === "kernel")
      .map((entry) => (entry.details as { context?: { component?: string } }).context?.component),
  ).toEqual(["worktrees", "mcp", "trace"]);
});

test("a component scope composes with the session floor, and a silent scope writes nothing", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 49, level: "warn" });
  const componentLogger = createComponentLoggers(session.logger, "mcp=silent", "debug");

  // The session's own floor still applies over a component asking for `debug`.
  componentLogger("trace").info({ event: "trace.swept" }, "below the session floor");
  componentLogger("trace").warn({ event: "trace.retention_swept" }, "kept");
  componentLogger("mcp").error({ event: "mcp.connect.failed" }, "silenced by its scope");
  session.close();

  expect(records(session.path).map((entry) => entry.event)).toEqual([
    "diagnostics.start",
    "trace.retention_swept",
    "diagnostics.stop",
  ]);
});

test("a derived logger reports its own effective level and keeps its parent's bindings", () => {
  const session = createDiagnosticSession({ directory: tempDir(), pid: 50, level: "info" });
  const component = session.logger.child!({ component: "mcp" }, { level: "warn" });
  const connection = component.child!({ connectionId: "cx_01" });

  expect(session.logger.level).toBe("info");
  expect(component.level).toBe("warn");
  expect(connection.level).toBe("warn");
  connection.warn({ event: "mcp.connect.failed", transport: "stdio" }, "did not connect");
  session.close();

  expect(records(session.path)[1]?.details).toEqual({
    context: {
      component: "mcp",
      connection_id: "cx_01",
      event: "mcp.connect.failed",
      transport: "stdio",
    },
    message: "did not connect",
  });
});

test.if(process.platform !== "win32" && process.getuid?.() !== 0)(
  "diagnostic files are owner-only",
  () => {
    const session = createDiagnosticSession({ directory: tempDir() });
    session.close();
    expect(statSync(session.path).mode & 0o777).toBe(0o600);
  },
);
