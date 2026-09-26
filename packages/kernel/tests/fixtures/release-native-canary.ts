import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BubblewrapBackend, createExecutionPolicy, SeatbeltBackend } from "@clarvis/sandbox";
import { createAgentTools, dispatch, SandboxToolExecutor } from "@clarvis/tools";
import { createJudgeService } from "@clarvis/judge";
import { createApprovalService } from "../../src/execution/approval-service.ts";

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
  denies: [privateFile],
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
  let reviews = 0;
  let questions = 0;
  const counts = () => ({ reviews, questions });
  const judge = createJudgeService({
    llm: {
      async call() {
        reviews++;
        return {
          text: '{"outcome":"allow"}',
          usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    },
    model: {
      provider: "smoke",
      model: "local",
      kind: "openai-compatible",
      contextWindowTokens: 8192,
      capabilities: [],
      reasoningEfforts: ["low"],
      promptCache: undefined,
    },
  });
  const executeReviewed = async (mode: "auto" | "manual", target: string) => {
    mkdirSync(join(workspace, target));
    const port = createApprovalService({
      owner: "smoke",
      executionId: `smoke-${mode}`,
      policy: "on-request",
      policyRevision: "smoke-policy",
      sources: [],
      revision: () => 0,
      backendAvailable: true,
      denyRead: false,
      mode,
      judge,
      elicit: async () => {
        questions++;
        return { action: "accept" as const, content: { approved: "yes" } };
      },
    });
    const result = await dispatch(
      "shell",
      { command: `rm -rf ${target}` },
      {
        ...tools.config,
        actionAuthorization: port,
        actionIdentity: { owner: "smoke", executionId: `smoke-${mode}` },
      },
      undefined,
      { actionCallId: `call-${mode}`, actionActor: "lead" },
    );
    if (result.isError || existsSync(join(workspace, target)))
      throw new Error(`${mode} reviewed action did not execute in the release sandbox`);
  };
  await executeReviewed("auto", "approval-auto-cache");
  if (counts().reviews !== 1 || counts().questions !== 0)
    throw new Error("release auto review required human input or skipped judge");
  await executeReviewed("manual", "approval-manual-cache");
  if (counts().reviews !== 1 || counts().questions !== 1)
    throw new Error("release manual review did not ask exactly once");
  process.stdout.write(`native release sandbox ok - ${backend.name}; approval auto/manual ok\n`);
} finally {
  await tools.close();
}
