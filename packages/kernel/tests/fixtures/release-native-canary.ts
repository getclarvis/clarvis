import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BubblewrapBackend, createExecutionPolicy, SeatbeltBackend } from "@clarvis/sandbox";
import { createAgentTools, SandboxToolExecutor } from "@clarvis/tools";

const productRoot = process.argv[2];
const home = process.env.HOME;
const global = process.env.CLARVIS_HOME;
const workspace = process.env.CLARVIS_WORKSPACE_ROOT;
const scratch = process.env.TMPDIR;
if (!productRoot || !home || !global || !workspace || !scratch) {
  throw new Error("native release canary requires isolated product and fixture roots");
}

const privateFile = join(home, ".ssh", "private.txt");
mkdirSync(dirname(privateFile), { recursive: true });
writeFileSync(privateFile, "private");
const policy = createExecutionPolicy({
  id: "installed-native-canary",
  mode: "sandbox",
  workspaceRoot: workspace,
  homeRoot: home,
  globalRoot: global,
  network: "disabled",
  temporaryWriteRoots: [scratch],
  installationRoots: [dirname(process.execPath), productRoot],
});
const backend = process.platform === "darwin" ? new SeatbeltBackend() : new BubblewrapBackend();
const executor = new SandboxToolExecutor(policy, backend, scratch);
const tools = createAgentTools({
  workspaceRoot: workspace,
  temporaryRoots: [scratch],
  executionPolicy: policy,
  sandboxBackend: backend,
  executionPort: executor,
});

try {
  const written = await tools.callTool("write_file", {
    path: "native-canary.txt",
    content: "sandboxed",
  });
  if (written.isError || written.meta?.execution_mode !== "sandbox") {
    throw new Error(
      `installed write_file did not execute in the native sandbox: ${JSON.stringify({ error: written.isError, meta: written.meta, content: written.content }).slice(0, 1000)}`,
    );
  }
  if (readFileSync(join(workspace, "native-canary.txt"), "utf8") !== "sandboxed") {
    throw new Error("installed sandbox write_file did not write the workspace file");
  }
  const shell = await tools.callTool("shell", { command: "cat native-canary.txt" });
  if (
    shell.isError ||
    shell.meta?.execution_mode !== "sandbox" ||
    shell.meta?.execution_backend !== backend.name ||
    !JSON.stringify(shell.content).includes("sandboxed")
  ) {
    throw new Error("installed shell did not execute in the native sandbox");
  }
  const denied = await tools.callTool("shell", {
    command: 'cat "$HOME/.ssh/private.txt"',
  });
  const output = denied.content.find((part) => part.type === "text");
  const shellResult = JSON.parse(output?.type === "text" ? output.text : "{}") as {
    exit_code?: number;
    stdout?: string;
  };
  if (
    denied.meta?.execution_mode !== "sandbox" ||
    shellResult.exit_code === 0 ||
    shellResult.stdout?.includes("private")
  ) {
    throw new Error("installed native sandbox exposed a private home file");
  }
  process.stdout.write(`native release sandbox ok - ${backend.name}\n`);
} finally {
  await tools.close();
}
