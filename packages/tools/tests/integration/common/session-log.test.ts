import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionLog } from "#src/lib/session-log.ts";
import { NOOP_TOOLS_LOGGER } from "#src/lib/log.ts";
import { callTool, cleanup, makeConfig, makeWorkspace } from "../../helpers/fixtures.ts";

test("session logs are plain text, private, capped at a UTF-8 boundary and removed idempotently", () => {
  const log = createSessionLog(NOOP_TOOLS_LOGGER, 5);
  try {
    log.stdout.push("aé");
    log.stdout.push("界b");
    log.stdout.push("z");
    log.stderr.push("error");
    expect(readFileSync(log.stdoutPath, "utf8")).toBe("aé");
    expect(readFileSync(log.stderrPath, "utf8")).toBe("error");
    expect(log.stdout.read(1, 1)).toMatchObject({ text: "é", nextOffset: 3 });
    expect(log.stdout.read(3, 1).text).toBe("");
    expect(() => log.stdout.read(4, 1)).toThrow("Invalid session output cursor");
    expect(() => log.stdout.read(0, 0)).toThrow("Invalid session output limit");
    if (process.platform !== "win32") expect(statSync(log.stdoutPath).mode & 0o777).toBe(0o600);
  } finally {
    log.dispose();
    log.dispose();
  }
  expect(existsSync(log.stdoutPath)).toBe(false);
});

test("a failed noisy command keeps its first diagnostic and final tail without rerunning", async () => {
  const root = makeWorkspace();
  const config = makeConfig(root);
  let outputPath: string | undefined;
  try {
    const file = join(root, "noisy.cjs");
    writeFileSync(
      file,
      "process.stderr.write('FIRST ERROR\\n' + 'pass\\n'.repeat(90000) + 'FINAL ERROR\\n'); process.exitCode = 7;",
    );
    const run = await callTool("shell", { command: `"${process.execPath}" "${file}"` }, config);
    expect(run.json).toMatchObject({ running: false, exit_code: 7, log_truncated: false });
    const id = run.json.session_id as string;
    outputPath = run.json.stderr_log as string;
    expect(readFileSync(outputPath, "utf8")).toStartWith("FIRST ERROR\n");
    const fileRead = await callTool("read_file", { path: outputPath, offset: 1, limit: 1 }, config);
    expect(fileRead.isError).toBe(false);
    expect(fileRead.text).toContain("FIRST ERROR");
    const status = await callTool("shell_session", { action: "status", session_id: id }, config);
    expect(status.json).toMatchObject({ exit_code: 7, stderr_bytes: 450024 });
    expect(status.json.stdout).toBeUndefined();
    const tail = await callTool("shell_session", { action: "tail", session_id: id }, config);
    expect(tail.json.stderr).toEndWith("FINAL ERROR\n");
    expect((tail.json.stderr as string).length).toBeLessThanOrEqual(8192);
    const first = await callTool("shell_session", { action: "read", session_id: id }, config);
    expect(first.json.stderr).toStartWith("FIRST ERROR\n");
    expect(first.json.stderr_omitted_bytes).toBe(0);
    const next = await callTool(
      "shell_session",
      { action: "read", session_id: id, cursor: first.json.next_cursor },
      config,
    );
    expect(next.json.next_cursor).not.toBe(first.json.next_cursor);
    const foreign = makeConfig(root, { sessionManager: config.sessionManager, sessionAgent: {} });
    expect(
      (await callTool("shell_session", { action: "read", session_id: id }, foreign)).json.error,
    ).toBe("not_found");
  } finally {
    await cleanup(root);
  }
  expect(existsSync(outputPath!)).toBe(false);
});

test("session eviction removes only the completed session's logs", async () => {
  const root = makeWorkspace();
  const config = makeConfig(root, { maxSessions: 1 });
  try {
    const first = await callTool("shell", { command: "echo first" }, config);
    const path = first.json.stdout_log as string;
    expect(existsSync(path)).toBe(true);
    const second = await callTool("shell", { command: "echo second" }, config);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(second.json.stdout_log as string)).toBe(true);
    expect(
      (
        await callTool(
          "shell_session",
          { action: "tail", session_id: first.json.session_id },
          config,
        )
      ).json.error,
    ).toBe("not_found");
  } finally {
    await cleanup(root);
  }
});

test("a capped command log preserves early errors and still exposes the latest tail", async () => {
  const root = makeWorkspace();
  const config = makeConfig(root);
  try {
    const file = join(root, "capped.cjs");
    writeFileSync(
      file,
      "process.stdout.write('FIRST ERROR\\n' + 'x'.repeat(17 * 1024 * 1024) + '\\nFINAL ERROR');",
    );
    const run = await callTool("shell", { command: `"${process.execPath}" "${file}"` }, config);
    expect(run.json).toMatchObject({ exit_code: 0, log_truncated: true });
    expect(statSync(run.json.stdout_log as string).size).toBe(16 * 1024 * 1024);
    const id = run.json.session_id;
    const tail = await callTool("shell_session", { action: "tail", session_id: id }, config);
    expect(tail.json.stdout).toEndWith("FINAL ERROR");
    const head = await callTool("shell_session", { action: "read", session_id: id }, config);
    expect(head.json.stdout).toStartWith("FIRST ERROR\n");
  } finally {
    await cleanup(root);
  }
});
