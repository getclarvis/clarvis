import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionSessionManager } from "../../src/lib/execution-session.ts";
import { callTool, cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

function command(root: string, source: string): string {
  const file = join(root, "session.cjs");
  writeFileSync(file, source);
  const invocation = `"${process.execPath}" "${file}"`;
  return process.platform === "win32" ? `& ${invocation}` : invocation;
}

describe("shell and shell_session", () => {
  it("validates action-specific arguments", async () => {
    const root = makeWorkspace();
    try {
      const config = makeConfig(root);
      for (const args of [
        { action: "poll" },
        { action: "stop" },
        { action: "stop", session_id: "ses_missing", cursor: "old" },
        { action: "list", session_id: "ses_missing" },
        { action: "list", yield_time_ms: 1 },
      ]) {
        expect((await callTool("shell_session", args, config)).json.error).toBe("invalid_input");
      }
    } finally {
      cleanup(root);
    }
  });
  it("yields a live session, pages each stream and stops only its owner's process", async () => {
    const root = makeWorkspace();
    const manager = new ExecutionSessionManager();
    try {
      const owner = makeConfig(root, { sessionManager: manager, sessionAgent: {} });
      const foreign = makeConfig(root, { sessionManager: manager, sessionAgent: {} });
      const run = await callTool(
        "shell",
        {
          command: command(
            root,
            "process.stdout.write('READY\\n'); process.stderr.write('warning\\n'); setInterval(() => {}, 1000)",
          ),
          ready_when: "READY",
          yield_time_ms: 5000,
        },
        owner,
      );
      expect(run.isError).toBe(false);
      expect(run.json).toMatchObject({ running: true, ready: true, exit_code: null });
      const id = run.json.session_id as string;
      expect(id).toMatch(/^ses_[0-9a-f]{32}$/);
      expect((await callTool("shell_session", { action: "list" }, owner)).json.sessions).toEqual([
        expect.objectContaining({ session_id: id, running: true }),
      ]);
      expect((await callTool("shell_session", { action: "list" }, owner)).text).not.toContain(
        "session.cjs",
      );
      expect((await callTool("shell_session", { action: "list" }, foreign)).json.sessions).toEqual(
        [],
      );
      expect(
        (await callTool("shell_session", { action: "poll", session_id: id }, foreign)).json.error,
      ).toBe("not_found");
      const first = await callTool("shell_session", { action: "poll", session_id: id }, owner);
      expect(first.json.stdout).toContain("READY");
      const stderrPage =
        typeof first.json.stderr === "string" && first.json.stderr.includes("warning")
          ? first
          : await callTool(
              "shell_session",
              {
                action: "poll",
                session_id: id,
                cursor: first.json.next_cursor as string,
                yield_time_ms: 1000,
              },
              owner,
            );
      expect(stderrPage.json.stderr).toContain("warning");
      const cursor = stderrPage.json.next_cursor as string;
      const replay = await callTool("shell_session", { action: "poll", session_id: id }, owner);
      expect(replay.json.next_cursor).toBe(cursor);
      const stopped = await callTool("shell_session", { action: "stop", session_id: id }, owner);
      expect(stopped.json).toMatchObject({ stopped: true, termination_confirmed: true });
      expect(
        (await callTool("shell_session", { action: "stop", session_id: id }, owner)).json.stopped,
      ).toBe(true);
    } finally {
      await manager.close();
      cleanup(root);
    }
  });

  it("reports readiness that arrives after the first yield and times out the process lifetime", async () => {
    const root = makeWorkspace();
    const manager = new ExecutionSessionManager();
    try {
      const config = makeConfig(root, { sessionManager: manager });
      const started = await callTool(
        "shell",
        {
          command: command(
            root,
            "setTimeout(() => process.stdout.write('READY\\n'), 250); setInterval(() => {}, 1000)",
          ),
          ready_when: "READY",
          yield_time_ms: 25,
          timeout_ms: 700,
        },
        config,
      );
      expect(started.json).toMatchObject({ running: true, ready: false });
      const sessionId = started.json.session_id as string;
      const ready = await callTool(
        "shell_session",
        {
          action: "poll",
          session_id: sessionId,
          cursor: started.json.next_cursor,
          yield_time_ms: 1000,
        },
        config,
      );
      expect(ready.json.stdout).toContain("READY");
      expect(ready.json.ready).toBe(true);
      const deadline = Date.now() + 2500;
      let timedOut = ready;
      while (timedOut.json.running === true && Date.now() < deadline) {
        timedOut = await callTool(
          "shell_session",
          {
            action: "poll",
            session_id: sessionId,
            cursor: timedOut.json.next_cursor,
            yield_time_ms: 1000,
          },
          config,
        );
      }
      expect(timedOut.json).toMatchObject({ running: false, timed_out: true });
      await manager.close();
      expect(
        (await callTool("shell_session", { action: "poll", session_id: sessionId }, config)).json
          .error,
      ).toBe("not_found");
    } finally {
      await manager.close();
      cleanup(root);
    }
  });
});
