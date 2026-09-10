import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalPaths } from "@clarvis/paths";
import { connectRemoteKernelOverSsh } from "../../src/bootstrap.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
});

describe("remote SSH kernel connection", () => {
  test("owns one hardened process, negotiates hosted stdio and withholds local controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-remote-ssh-"));
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
      "---\ntools: []\ngrants: []\n---\nSSH fixture.\n",
    );
    const fakeSsh = fileURLToPath(new URL("../helpers/fake-ssh.ts", import.meta.url));
    const worker = fileURLToPath(new URL("../helpers/remote-stdio-worker.ts", import.meta.url));
    const connected = await connectRemoteKernelOverSsh({
      destination: "test@example.invalid",
      workspace,
      sshCommand: [process.execPath, fakeSsh],
      remoteCommand: [process.execPath, worker, workspace, globalDir],
    });
    cleanups.push(() => connected.client.close());

    expect(connected.client.workspace.path).toBe(workspace);
    expect(connected.client.capabilities.hosting?.host_generation).toBeDefined();
    expect(connected.client.capabilities.hosting?.default_owner).toMatch(/^ws_[a-f0-9]{64}$/);
    expect(connected.client.capabilities.goals).toBe(true);
    expect(connected.client.localHost).toBeUndefined();
    expect(await connected.client.sessions.list()).toEqual([]);
    expect(connected.stderr()).toContain("fake-ssh-ok");
  });

  test("rejects destination and remote command injection before spawning", async () => {
    await expect(
      connectRemoteKernelOverSsh({
        destination: "-oProxyCommand=bad",
        workspace: "/workspace",
        remoteCommand: ["clarvis", "--remote-kernel", "safe"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      connectRemoteKernelOverSsh({
        destination: "host",
        workspace: "/workspace",
        remoteCommand: ["clarvis", "$(bad)"],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
