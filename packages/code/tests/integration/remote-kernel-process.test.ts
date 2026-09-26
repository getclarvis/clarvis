import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectKernelClient, createStdioTransport } from "@clarvis/kernel";
import { globalPaths } from "@clarvis/kernel/paths";
import { encodeRemoteKernelArguments } from "../../src/adapters/remote-kernel-arguments.ts";

async function closeProcess(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await closed;
}

describe("remote kernel application process", () => {
  test("boots the private source entry and closes after its authenticated stdio peer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-code-remote-kernel-"));
    let child: ChildProcessWithoutNullStreams | undefined;
    let closeChild: Promise<void> | undefined;
    let closeTransport: (() => Promise<void>) | undefined;
    let testFailure: unknown;
    try {
      const workspace = join(root, "workspace");
      const globalDir = join(root, "global");
      await mkdir(workspace);
      await mkdir(globalDir);
      const paths = globalPaths(globalDir);
      await writeFile(
        paths.settingsFile,
        JSON.stringify({
          default_model: "fixture/model",
          providers: [
            { name: "fixture", kind: "openai-compatible", base_url: "http://127.0.0.1:1/v1" },
          ],
          budget: { total_token_limit: 1000, on_exceed: "stop" },
          plans: { mode: "off" },
        }),
      );
      await mkdir(paths.agentsDir);
      await writeFile(
        join(paths.agentsDir, "solo.md"),
        "---\ntools: []\ngrants: []\n---\nRemote app.\n",
      );
      const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
      const payload = encodeRemoteKernelArguments({ workspaceRoot: workspace });
      child = spawn(process.execPath, [cli, "--remote-kernel", payload], {
        cwd: workspace,
        env: {
          ...process.env,
          CLARVIS_CODE_SOURCE: "1",
          CLARVIS_HOME: globalDir,
          CLARVIS_AGENT_TOOLS_ENABLED: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      closeChild = new Promise((resolve) => child!.once("close", () => resolve()));
      const stderrDrained = new Promise<void>((resolve) => {
        child!.stderr.resume();
        child!.stderr.once("close", resolve);
      });
      const exited = new Promise<number | null>((resolve) => child!.once("exit", resolve));
      const transport = createStdioTransport({ input: child.stdout, output: child.stdin });
      closeTransport = () => transport.close();
      const client = await connectKernelClient(transport, {
        workspace,
        clientInfo: { name: "clarvis-code-test" },
      });

      expect(client.workspace.path).toBe(workspace);
      expect(client.capabilities.hosting?.default_owner).toMatch(/^ws_[a-f0-9]{64}$/);
      expect(client.capabilities.goals).toBe(true);
      expect(client.localHost).toBeUndefined();
      expect(await client.sessions.list()).toEqual([]);
      await client.close();
      child.stdin.end();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("remote kernel process did not exit")), 5000);
        }),
      ]);
      clearTimeout(timeout);
      expect(code).toBe(0);
      await Promise.all([closeChild, stderrDrained]);
    } catch (error) {
      testFailure = error;
    }
    const failures: unknown[] = [];
    for (const cleanup of [
      closeTransport,
      child && closeChild ? () => closeProcess(child, closeChild) : undefined,
      () => rm(root, { recursive: true, force: true }),
    ]) {
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (testFailure !== undefined) failures.unshift(testFailure);
    if (failures.length > 0)
      throw new AggregateError(failures, "remote kernel test or cleanup failed");
  });
});
