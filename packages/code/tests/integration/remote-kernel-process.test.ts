import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectKernelClient, createStdioTransport } from "@clarvis/kernel";
import { globalPaths } from "@clarvis/paths";
import { encodeRemoteKernelArguments } from "../../src/adapters/remote-kernel-arguments.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const settled = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
});

function closeProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("remote kernel application process", () => {
  test("boots the private source entry and closes after its authenticated stdio peer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-code-remote-kernel-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
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
        runtime: { backend: "native" },
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
    const child = spawn(process.execPath, [cli, "--remote-kernel", payload], {
      cwd: workspace,
      env: {
        ...process.env,
        CLARVIS_CODE_SOURCE: "1",
        CLARVIS_HOME: globalDir,
        CLARVIS_AGENT_TOOLS_ENABLED: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => closeProcess(child));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const transport = createStdioTransport({ input: child.stdout, output: child.stdin });
    cleanups.push(() => transport.close());
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
  });
});
