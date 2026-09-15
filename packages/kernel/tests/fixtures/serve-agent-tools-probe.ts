import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { loadEnv } from "@clarvis/capability";
import { connectKernelClient, createStdioTransport } from "../../src/index.ts";
import { serveFileKernelOverStdio } from "../../src/bootstrap.ts";

export const SERVE_AGENT_TOOLS_PROBE_PATH = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-serve-env-probe-"));
  try {
    mkdirSync(join(workspaceRoot, ".clarvis"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".clarvis", "settings.json"),
      JSON.stringify({
        default_model: "anthropic/x",
        providers: [{ name: "anthropic", kind: "anthropic" }],
      }),
    );
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const handle = await serveFileKernelOverStdio({
      workspaceRoot,
      env: loadEnv({ ...process.env, CLARVIS_LOG_LEVEL: "silent" }),
      traceDir: join(workspaceRoot, "traces"),
      globalDir: join(workspaceRoot, "global"),
      input: toServer,
      output: toClient,
    });
    const client = await connectKernelClient(
      createStdioTransport({ input: toClient, output: toServer }),
    );
    process.stdout.write(`${String(client.capabilities.agent_tools)}\n`);
    await client.close();
    await handle.close();
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
