import { afterEach, describe, expect, it, vi } from "bun:test";
import { writeFileSync } from "node:fs";
import { spawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { ExecutionSessionManager } from "../../src/lib/execution-session.ts";
import { shellSessionView } from "../../src/tools/shell-session.ts";
import { NOOP_TOOLS_LOGGER } from "../../src/lib/log.ts";
import { createAgentTools } from "../../src/index.ts";
import { callTool, cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

const roots: string[] = [];
const managers: ExecutionSessionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const root of roots.splice(0)) cleanup(root);
});
function fixture(source: string): { root: string; command: string } {
  const root = makeWorkspace();
  roots.push(root);
  const file = join(root, "command.cjs");
  writeFileSync(file, source);
  const invocation = `"${process.execPath}" "${file}"`;
  return { root, command: invocation };
}

describe("ExecutionSessionManager", () => {
  it("spawns once and settles both streams with physical exit status", async () => {
    const { root, command } = fixture(
      "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exitCode = 4;",
    );
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    let spawnCalls = 0;
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
      spawnChild: ((file: string, args: readonly string[], options: SpawnOptions) => {
        spawnCalls++;
        return spawn(file, args, options);
      }) as typeof spawn,
    });
    const result = await session.completed;
    expect(spawnCalls).toBe(1);
    expect(result).toMatchObject({ code: 4, stdout: "out\n", stderr: "err\n" });
    const page = session.readStreams(undefined, 32);
    expect(page.stdout.text).toBe("out\n");
    expect(page.stderr.text).toBe("err\n");
    expect(session.readStreams(page.nextCursor, 32)).toMatchObject({
      stdout: { text: "" },
      stderr: { text: "" },
    });
    expect(session.running).toBe(false);
    expect(session.terminationConfirmed).toBe(true);
    expect(session.exitCode).toBe(4);
    expect(session.signal).toBeNull();
    expect(session.ready).toBe(false);
  });

  it("projects physical exit awaiting status as a nonrunning session", async () => {
    const { root, command } = fixture("setInterval(() => {}, 1000)");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
    });
    if (session.snapshot().phase === "starting")
      await new Promise<void>((resolve) => session.child.once("spawn", resolve));
    const live = session as typeof session & { treeRunning(): boolean };
    const tree = vi.spyOn(live, "treeRunning").mockReturnValue(false);
    try {
      expect(shellSessionView(session, undefined, 1024)).toMatchObject({
        phase: "exited_pending_status",
        running: false,
        termination_confirmed: true,
        exit_code: null,
      });
    } finally {
      tree.mockRestore();
      await session.stop();
    }
  });

  it("stops a child when launch fails after spawn", async () => {
    const { root, command } = fixture("setInterval(() => {}, 1000)");
    let childPid: number | undefined;
    const manager = new ExecutionSessionManager((child) => {
      childPid = child.pid;
      throw new Error("post-spawn failure");
    });
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    await expect(
      manager.launch({
        config,
        agent: config.sessionAgent,
        command,
        cwd: root,
      }),
    ).rejects.toThrow("post-spawn failure");
    expect(childPid).toBeDefined();
    expect(manager.listSessions(config.sessionAgent)).toEqual([]);
  });

  it("reports an asynchronous child error and still owns the spawned process", async () => {
    const { root, command } = fixture("setInterval(() => {}, 1000)");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
      spawnChild: ((file: string, args: readonly string[], options: SpawnOptions) => {
        const child = spawn(file, args, options);
        queueMicrotask(() => child.emit("error", new Error("asynchronous child error")));
        return child;
      }) as typeof spawn,
    });
    await expect(session.completed).rejects.toMatchObject({ code: "io_error" });
    expect(await manager.close()).toBe(true);
  });

  it.each(["abort", "timeout"] as const)(
    "reports a failed %s stop and retains the process for run cleanup",
    async (trigger) => {
      const { root, command } = fixture("setInterval(() => {}, 1000)");
      const manager = new ExecutionSessionManager();
      managers.push(manager);
      const controller = new AbortController();
      let warn!: (fields: Record<string, unknown>) => void;
      const warning = new Promise<Record<string, unknown>>((resolve) => {
        warn = resolve;
      });
      const config = makeConfig(root, {
        sessionManager: manager,
        logger: {
          ...NOOP_TOOLS_LOGGER,
          warn(fields) {
            if (fields.event === "tools.session_stop_failed") warn(fields);
          },
        },
      });
      const session = await manager.launch({
        config,
        agent: config.sessionAgent,
        command,
        cwd: root,
        ...(trigger === "abort" ? { signal: controller.signal } : { timeoutMs: 25 }),
      });
      const stop = vi.spyOn(session, "stop").mockRejectedValueOnce(new Error("stop failed"));
      try {
        if (trigger === "abort") controller.abort();
        expect(await warning).toMatchObject({
          event: "tools.session_stop_failed",
          cause: "Error",
        });
        expect(trigger === "abort" ? session.aborted : session.timedOut).toBe(true);
      } finally {
        stop.mockRestore();
        expect(await manager.close()).toBe(true);
      }
    },
  );

  it("isolates sessions by agent and run", async () => {
    const { root, command } = fixture(
      "process.stdout.write('out\\n'); process.stderr.write('err\\n'); setInterval(() => {}, 1000);",
    );
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const a = makeConfig(root, { sessionManager: manager, sessionAgent: {} });
    const b = makeConfig(root, { sessionManager: manager, sessionAgent: {} });
    const shell = await callTool("shell", { command, yield_time_ms: 0 }, a);
    expect(shell.isError).toBe(false);
    expect(shell.json.running).toBe(true);
    const started = await callTool("shell", { command, yield_time_ms: 0 }, a);
    expect(started.isError).toBe(false);
    const id = started.json.session_id as string;
    expect((await callTool("shell_session", { action: "poll", session_id: id }, a)).isError).toBe(
      false,
    );
    const foreign = await callTool("shell_session", { action: "poll", session_id: id }, b);
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("No such session");
    const otherRun = new ExecutionSessionManager();
    managers.push(otherRun);
    const sameAgentOtherRun = makeConfig(root, {
      sessionManager: otherRun,
      sessionAgent: a.sessionAgent,
    });
    expect(
      (await callTool("shell_session", { action: "poll", session_id: id }, sameAgentOtherRun))
        .isError,
    ).toBe(true);
    expect(await manager.close()).toBe(true);
    expect(await manager.close()).toBe(true);
    expect((await callTool("shell", { command }, a)).isError).toBe(true);
  });

  it("accepts an empty cursor as the initial shell session page", async () => {
    const { root, command } = fixture("process.stdout.write('first-page');");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
    });
    await session.completed;
    const first = await callTool(
      "shell_session",
      { action: "poll", session_id: session.id, cursor: "" },
      config,
    );
    expect(first.isError).toBe(false);
    expect(first.json.stdout).toBe("first-page");
  });

  it("reports an expired byte cursor over bounded captured streams", async () => {
    const { root, command } = fixture(
      "process.stdout.write('x'.repeat(300000)); process.stderr.write('tail\\n');",
    );
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
    });
    await session.completed;
    const first = session.readStreams(undefined, 4096);
    expect(first.stdout.omittedBefore).toBeGreaterThan(0);
    expect(first.stdout.text.length).toBeGreaterThan(0);
  });

  it("applies the configured cap to live sessions", async () => {
    const { root, command } = fixture("setInterval(() => {}, 1000)");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager, maxSessions: 1 });
    const first = await callTool("shell", { command, yield_time_ms: 0 }, config);
    expect(first.isError).toBe(false);
    const shell = await callTool("shell", { command, yield_time_ms: 0 }, config);
    expect(shell.isError).toBe(true);
    expect(shell.text).toContain("Too many live command sessions");
    expect(
      (
        await callTool(
          "shell_session",
          { action: "stop", session_id: first.json.session_id },
          config,
        )
      ).isError,
    ).toBe(false);
  });

  it("finds readiness after a large prefix and keeps the exit code", async () => {
    const { root, command } = fixture(
      "process.stdout.write('x'.repeat(140000)); process.stdout.write('READY\\n'); process.exitCode = 7;",
    );
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
      readyWhen: /READY/,
    });
    expect(await session.waitReady(3000)).toBe(true);
    expect((await session.completed).code).toBe(7);
    expect(session.running).toBe(false);
  });

  it("rejects readiness when the regex scan budget is exhausted", async () => {
    const { root, command } = fixture(
      "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);",
    );
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager, regexScanBudgetMs: 0 });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
      readyWhen: /READY/,
    });
    await expect(session.waitReady(3000)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await session.stop()).toBe(true);
  });

  it("ends a quiet output poll at its requested wait bound", async () => {
    const { root, command } = fixture("setInterval(() => {}, 1000);");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
    });
    await session.waitForChange(undefined, 20);
    expect(session.readStreams(undefined, 16).stdout.text).toBe("");
    expect(session.running).toBe(true);
    expect(await session.stop()).toBe(true);
  });

  it("advances a short page across one UTF-8 codepoint", async () => {
    const { root, command } = fixture("process.stdout.write('é');");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
    });
    await session.completed;
    expect(session.readStreams(undefined, 1).stdout).toMatchObject({ text: "é", nextOffset: 2 });
  });

  it("standalone close stops a live session and seals admission", async () => {
    const { root, command } = fixture(
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
    );
    const tools = createAgentTools({ workspaceRoot: root });
    try {
      expect(
        (await tools.callTool("shell", { command, ready_when: "ready", yield_time_ms: 1000 }))
          .isError,
      ).toBe(false);
      await tools.close();
      await tools.close();
      expect((await tools.callTool("shell", { command })).isError).toBe(true);
    } finally {
      await tools.close();
    }
  });

  it("closes a live blocking shell before it can outlive its manager", async () => {
    const { root, command } = fixture("setInterval(() => {}, 1000)");
    const manager = new ExecutionSessionManager();
    managers.push(manager);
    const config = makeConfig(root, { sessionManager: manager });
    const session = await manager.launch({
      config,
      agent: config.sessionAgent,
      command,
      cwd: root,
    });
    expect(await manager.close()).toBe(true);
    expect(session.running).toBe(false);
    expect(session.terminationConfirmed).toBe(true);
    await session.completed;
  });
});
