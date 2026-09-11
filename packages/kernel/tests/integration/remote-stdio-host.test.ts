import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import {
  serveRemoteFileKernelOverStdio,
  type ServeRemoteStdioOptions,
} from "../../src/bootstrap.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import { createStdioTransport } from "../../src/transport/stdio.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(failures, "remote stdio cleanup failed");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-remote-stdio-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  await mkdir(workspaceRoot);
  await mkdir(globalDir);
  const global = globalPaths(globalDir);
  await writeFile(
    global.settingsFile,
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
  await mkdir(global.agentsDir);
  await writeFile(
    join(global.agentsDir, "solo.md"),
    "---\ntools: []\ngrants: []\n---\nRemote fixture.\n",
  );
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const options: ServeRemoteStdioOptions = {
    artifactId: "clarvis:test:remote-stdio",
    input: toServer,
    output: toClient,
    kernel: {
      workspaceRoot,
      globalDir,
      defaultOwner: "operator",
      subscriptions: false,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
      builtins: { tools: false, hooks: false, tasks: false },
    },
  };
  const host = await serveRemoteFileKernelOverStdio(options);
  cleanups.push(() => host.close());
  const transport = createStdioTransport({ input: toClient, output: toServer });
  cleanups.push(() => transport.close());
  const client = await connectKernelClient(transport, {
    workspace: workspaceRoot,
    clientInfo: { name: "clarvis-ssh" },
  });
  return { host, client, options, toServer };
}

describe("remote hosted stdio", () => {
  test("binds one operator to hosted goals without publishing machine-local controls", async () => {
    const f = await fixture();

    expect(f.client.capabilities.hosting?.host_generation).toBeDefined();
    expect(f.client.capabilities.hosting?.default_owner).toBe("operator");
    expect(f.client.capabilities.goals).toBe(true);
    expect(f.client.capabilities.local_host).toBeUndefined();
    expect(f.client.localHost).toBeUndefined();
    expect(await f.client.goals.availability()).toEqual({ available: true });
    await expect(serveRemoteFileKernelOverStdio(f.options)).rejects.toMatchObject({
      code: "conflict",
    });

    f.toServer.end();
    await f.host.closed;
  });
});
