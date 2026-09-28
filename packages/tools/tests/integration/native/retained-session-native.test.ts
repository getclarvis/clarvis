import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BubblewrapBackend, createExecutionPolicy } from "@clarvis/sandbox";
import { createAgentTools, ExecutionSessionManager, SandboxToolExecutor } from "#src/index.ts";

function text(
  result: Awaited<ReturnType<ReturnType<typeof createAgentTools>["callTool"]>>,
): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function json(
  result: Awaited<ReturnType<ReturnType<typeof createAgentTools>["callTool"]>>,
): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(existsSync(path)).toBe(true);
}

test.skipIf(process.platform !== "linux" || process.env.CLARVIS_NATIVE_SANDBOX_TEST !== "1")(
  "retained Sandbox sessions keep a detached Unix-socket server across separate shell calls",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-retained-session-"));
    const scratch = mkdtempSync(join(tmpdir(), "clarvis-retained-session-scratch-"));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    const global = join(home, ".clarvis");
    mkdirSync(workspace);
    mkdirSync(global, { recursive: true });
    const server = join(workspace, "server.cjs");
    writeFileSync(
      server,
      [
        'const fs = require("node:fs");',
        'const net = require("node:net");',
        'const crypto = require("node:crypto");',
        "const [socket, ready, pid] = process.argv.slice(2);",
        'const id = crypto.randomBytes(12).toString("hex");',
        "fs.writeFileSync(pid, String(process.pid));",
        'const listener = net.createServer((client) => client.end(id + "\\n"));',
        "listener.listen(socket, () => fs.writeFileSync(ready, id));",
        'process.on("SIGTERM", () => listener.close(() => process.exit(0)));',
      ].join("\n"),
    );
    const policy = createExecutionPolicy({
      id: "retained-session-native",
      mode: "sandbox",
      network: "disabled",
      workspaceRoot: workspace,
      homeRoot: home,
      globalRoot: global,
      temporaryWriteRoots: [scratch],
      installationRoots: [dirname(process.execPath), resolve(process.cwd())],
    });
    const backend = new BubblewrapBackend();
    const sessionManager = new ExecutionSessionManager();
    const sessionAgent = {};
    const tools = createAgentTools({
      sessionManager,
      sessionAgent,
      workspaceRoot: workspace,
      temporaryRoots: [scratch],
      executionPolicy: policy,
      sandboxBackend: backend,
      executionPort: new SandboxToolExecutor(policy, backend, scratch),
    });
    const client = (socket: string) =>
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        'const net=require("node:net"); const s=net.createConnection(process.argv[1]); s.on("data", d => process.stdout.write(d));',
      )} ${JSON.stringify(socket)}`;
    try {
      const lostSocket = join(scratch, "lost.sock");
      const lostReady = join(scratch, "lost.ready");
      const lostPid = join(scratch, "lost.pid");
      const normal = await tools.callTool("shell", {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(server)} ${JSON.stringify(lostSocket)} ${JSON.stringify(lostReady)} ${JSON.stringify(lostPid)} >/dev/null 2>&1 & printf READY; sleep 1`,
      });
      expect(normal.isError).toBe(false);
      await waitForFile(lostReady);
      const lostClient = await tools.callTool("shell", { command: client(lostSocket) });
      expect(lostClient.isError).toBe(false);
      expect(json(lostClient).exit_code).not.toBe(0);

      const socket = join(scratch, "retained.sock");
      const ready = join(scratch, "retained.ready");
      const pidFile = join(scratch, "retained.pid");
      const started = await tools.callTool("shell", {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(server)} ${JSON.stringify(socket)} ${JSON.stringify(ready)} ${JSON.stringify(pidFile)} >/dev/null 2>&1 & printf READY; sleep 1`,
        keep_alive: true,
        ready_when: "READY",
        yield_time_ms: 5000,
        timeout_ms: 30000,
      });
      if (started.isError) throw new Error(text(started));
      const sessionId = json(started).session_id as string;
      await waitForFile(ready);
      let observed = started;
      const deadline = Date.now() + 5000;
      while (json(observed).command_status !== "exited" && Date.now() < deadline) {
        observed = await tools.callTool("shell_session", {
          action: "poll",
          session_id: sessionId,
          cursor: json(observed).next_cursor,
          yield_time_ms: 1000,
        });
      }
      expect(json(observed)).toMatchObject({
        keep_alive: true,
        command_status: "exited",
        command_exit_code: 0,
      });
      const retained = sessionManager.getSession(sessionId, sessionAgent);
      expect(retained.commandStatus).toBe("exited");
      expect(retained.commandExitCode).toBe(0);
      expect(retained.commandSignal).toBeNull();
      expect(
        json(await tools.callTool("shell_session", { action: "list" })).sessions,
      ).toContainEqual(
        expect.objectContaining({ session_id: sessionId, keep_alive: true, command_exit_code: 0 }),
      );
      const connected = await tools.callTool("shell", { command: client(socket) });
      expect(connected.isError).toBe(false);
      expect(json(connected).stdout).toBe(`${readFileSync(ready, "utf8").trim()}\n`);
      const stopped = await tools.callTool("shell_session", {
        action: "stop",
        session_id: sessionId,
      });
      expect(json(stopped)).toMatchObject({ stopped: true, termination_confirmed: true });
      const stoppedAgain = await tools.callTool("shell_session", {
        action: "stop",
        session_id: sessionId,
      });
      expect(json(stoppedAgain)).toMatchObject({ stopped: true, termination_confirmed: true });
      const afterStop = await tools.callTool("shell", { command: client(socket) });
      expect(json(afterStop).exit_code).not.toBe(0);
    } finally {
      await tools.close();
      rmSync(scratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
