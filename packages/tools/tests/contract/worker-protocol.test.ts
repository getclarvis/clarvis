import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfig } from "../../src/config.ts";
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerConfigDto,
} from "../../src/execution/worker-protocol.ts";

test("worker protocol admits only versioned, schema-valid file operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-worker-contract-"));
  const workspace = join(root, "workspace");
  const scratch = join(root, "scratch");
  mkdirSync(workspace);
  mkdirSync(scratch);
  const runtime = resolveConfig({ workspaceRoot: workspace, temporaryRoots: [scratch] });
  const dto: WorkerConfigDto = {
    workspaceRoot: workspace,
    stateRoot: scratch,
    temporaryRoots: [scratch],
    readOnly: runtime.readOnly,
    maxOutputBytes: runtime.maxOutputBytes,
    maxShellOutputBytes: runtime.maxShellOutputBytes,
    maxFileBytes: runtime.maxFileBytes,
    maxImageBytes: runtime.maxImageBytes,
    maxTraversalEntries: runtime.maxTraversalEntries,
    maxMutationBytes: runtime.maxMutationBytes,
    maxDiffInputBytes: runtime.maxDiffInputBytes,
    maxToolMetaBytes: runtime.maxToolMetaBytes,
    shellTimeoutMs: runtime.shellTimeoutMs,
    shellTimeoutMaxMs: runtime.shellTimeoutMaxMs,
    maxSessions: runtime.maxSessions,
    regexScanBudgetMs: runtime.regexScanBudgetMs,
  };
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dir, "../../src/execution/worker.ts")],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: scratch, CLARVIS_HOME: root },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const frames = createInterface({ input: child.stdout, crlfDelay: Infinity })[
    Symbol.asyncIterator
  ]();
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const send = (frame: unknown) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const next = async () => {
    const item = await frames.next();
    if (item.done) throw new Error(`Worker exited ${await closed}: ${stderr}`);
    return JSON.parse(item.value as string) as Record<string, unknown>;
  };
  try {
    send({ version: WORKER_PROTOCOL_VERSION, type: "init", config: dto });
    expect(await next()).toEqual({ version: WORKER_PROTOCOL_VERSION, type: "ready" });

    const forbidden = join(workspace, "shell-must-not-run");
    send({
      version: WORKER_PROTOCOL_VERSION,
      type: "call",
      id: 1,
      name: "shell",
      args: { command: `touch ${forbidden}` },
    });
    expect(await next()).toMatchObject({
      version: WORKER_PROTOCOL_VERSION,
      type: "result",
      id: 1,
      error: { code: "invalid_input" },
    });
    expect(existsSync(forbidden)).toBe(false);

    send({
      version: WORKER_PROTOCOL_VERSION,
      type: "call",
      id: 2,
      name: "write_file",
      args: { path: "invalid.txt" },
    });
    expect(await next()).toMatchObject({
      type: "result",
      id: 2,
      error: { code: "invalid_input" },
    });
    expect(existsSync(join(workspace, "invalid.txt"))).toBe(false);

    send({
      version: WORKER_PROTOCOL_VERSION,
      type: "call",
      id: 3,
      name: "write_file",
      args: { path: "allowed.txt", content: "worker-result" },
    });
    expect(await next()).toMatchObject({ type: "result", id: 3 });
    expect(readFileSync(join(workspace, "allowed.txt"), "utf8")).toBe("worker-result");

    send({
      version: WORKER_PROTOCOL_VERSION + 1,
      type: "call",
      id: 4,
      name: "read_file",
      args: { path: "allowed.txt" },
    });
    expect(await closed).toBe(64);
    expect((await frames.next()).done).toBe(true);
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
