import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { NOOP_LOGGER, loadEnv } from "@clarvis/capability";
import { parseLocalHostArguments } from "../../src/hosting/launcher.ts";
import { serveLocalFileKernel } from "../../src/hosting/serve-local.ts";

const input = parseLocalHostArguments(process.argv.slice(2))!;
const host = await serveLocalFileKernel({
  kernel: {
    ...input,
    subscriptions: false,
    logger: NOOP_LOGGER,
    builtins: { tools: false, hooks: false, tasks: false },
    env: loadEnv(process.env),
    async executeRun(args) {
      const executionId = (args.rawBody as { execution_id: string }).execution_id;
      await writeFile(
        join(input.workspaceRoot, "entered.json"),
        JSON.stringify({
          executionId,
          pid: process.pid,
          tools: process.env.CLARVIS_AGENT_TOOLS_ENABLED,
          maxGrant: process.env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
        }),
      );
      while (
        !(await access(join(input.workspaceRoot, "continue.flag")).then(
          () => true,
          () => false,
        ))
      ) {
        args.externalSignal?.throwIfAborted();
        await Bun.sleep(5);
      }
      await writeFile(
        join(input.workspaceRoot, "after-exit.json"),
        JSON.stringify({
          executionId,
          pid: process.pid,
          at: Date.now(),
        }),
      );
      return executeRun({
        ...args,
        deps: {
          ...args.deps,
          llm: new MockLLM({ script: [{ text: "Completed in the independent host." }] }),
        },
      });
    },
  },
  artifactId: input.artifactId,
  idleTimeoutMs: 2000,
  checkIntervalMs: 20,
});
if (host !== null) {
  const watchdog = setTimeout(() => {
    void host.close().catch(() => {
      process.exitCode = 1;
    });
  }, 25_000);
  try {
    await host.closed;
  } finally {
    clearTimeout(watchdog);
  }
}
