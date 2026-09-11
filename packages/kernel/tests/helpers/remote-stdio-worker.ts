import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { serveRemoteFileKernelOverStdio } from "../../src/bootstrap.ts";

const [workspaceRoot, globalDir] = process.argv.slice(2);
if (workspaceRoot === undefined || globalDir === undefined) process.exit(64);
const host = await serveRemoteFileKernelOverStdio({
  artifactId: "clarvis:test:ssh-worker",
  kernel: {
    workspaceRoot,
    globalDir,
    subscriptions: false,
    logger: NOOP_LOGGER,
    env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
    builtins: { tools: false, hooks: false, tasks: false },
  },
});
await host.closed;
