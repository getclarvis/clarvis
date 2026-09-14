import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSchema, type LLMProvider } from "@clarvis/capability";
import { localHostPaths, writeFileDurableSync } from "@clarvis/paths";
import type { SettingsData, StartRunParams } from "@clarvis/protocol";
import type { AgentRecord } from "../../src/config/config-store.ts";
import { projectContainerConfiguration } from "../../src/config/container-projection.ts";
import { createFileRunHost } from "../../src/hosting/file-host.ts";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { decodeHostedRegistryState } from "../../src/hosting/state.ts";
import { createLoopbackTransport } from "../../src/transport/loopback.ts";
import { connectKernelClient } from "../../src/transport/client.ts";

/** Deterministic native-graph fixture, not proof of physical Container placement. */
export async function containerNativeFixture(options: {
  llm: LLMProvider;
  settings?: SettingsData;
  agents?: AgentRecord[];
}) {
  const settings: SettingsData = {
    default_model: "logical/model",
    plans: { mode: "off" },
    ...options.settings,
  };
  const configuration = projectContainerConfiguration({
    store: {
      readSettings: () => ({
        merged: settings,
        operator_merged: settings,
        scopes: {},
        sources: [],
      }),
      listAgents: () =>
        options.agents ?? [
          {
            name: "fixture",
            scope: "global",
            body: "Execute the fixture request.",
            frontmatter: { model: "logical/model", grants: ["read_workspace", "edit_workspace"] },
          },
        ],
    },
    env: envSchema.parse({ CLARVIS_OWNER: "fixture" }),
    modelCatalog: [
      {
        provider: "logical",
        model: "model",
        kind: "openai-compatible",
        contextWindowTokens: 32768,
        maxOutputTokens: 4096,
        capabilities: ["tool_calling"],
        reasoningEfforts: undefined,
        promptCache: undefined,
      },
    ],
    sharedPrompt: "",
    contexts: [],
    memoryPolicy: "Fixture editorial policy.",
    workflowDefinitions: [],
  });
  const root = await mkdtemp(join(tmpdir(), "clarvis-container-domain-"));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "state");
  await mkdir(workspaceRoot);
  await mkdir(globalDir);
  const disposals: Array<() => Promise<void>> = [];
  const paths = localHostPaths({
    globalDir,
    workspaceRoot,
    owner: "fixture",
    operatorId: "fixture",
  });
  await mkdir(paths.root, { recursive: true });
  async function connect() {
    const generation = randomUUID();
    const persisted = await readFile(paths.registryFile, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    const host = await createFileRunHost({
      composition: {
        kind: "container",
        configuration,
        llm: options.llm,
        runtime: {
          kind: "container",
          engine: "podman",
          host_platform: "linux",
          guest_platform: "linux",
          network: "none",
          lifecycle: "starting",
        },
      },
      kernel: {
        workspaceRoot,
        globalDir,
        defaultOwner: "fixture",
        project: { id: "project" },
        workspace: {
          id: "workspace",
          projectId: "project",
          label: "fixture",
          kind: "primary",
          path: workspaceRoot,
        },
      },
      hostGeneration: generation,
      authenticate: () => "operator",
      exposeDefaultOwner: true,
      storage: {
        ...(persisted === undefined
          ? {}
          : { initialState: decodeHostedRegistryState(JSON.parse(persisted)) }),
        projection: (id) =>
          openHostedProjection(paths.projectionFile(generation, id), {
            host_generation: generation,
            execution_id: id,
          }),
        removeProjection: (id, previousGeneration) =>
          rm(paths.projectionFile(previousGeneration, id)),
        commit: async (state) => writeFileDurableSync(paths.registryFile, JSON.stringify(state)),
      },
    });
    let client: Awaited<ReturnType<typeof connectKernelClient>> | undefined = undefined;
    const close = async () => {
      await client?.close();
      await host.close();
      await host.kernel.close();
    };
    disposals.push(close);
    client = await connectKernelClient(createLoopbackTransport(host.server));
    host.kernel.startMemoryRecovery();
    return { host, client, close };
  }
  const disposeAll = async () => {
    const outcomes = await Promise.allSettled(disposals.map((dispose) => dispose()));
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((outcome) => outcome.reason),
        "fixture cleanup failed",
      );
    await rm(root, { recursive: true, force: true });
  };
  const connection = await connect().catch(async (error: unknown) => {
    try {
      await disposeAll();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture setup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  });
  return {
    root,
    globalDir,
    workspaceRoot,
    configuration,
    connection,
    connect,
    async start(params: Partial<StartRunParams> = {}) {
      const sessionId = randomUUID();
      await connection.client.sessions.save({
        id: sessionId,
        title: "Fixture",
        project_id: "project",
        workspace: "workspace",
        created_at: 1,
        updated_at: 1,
        turns: [],
        totals: { input: 0, output: 0, cached: 0 },
        agent_profile: "fixture",
      });
      const session = await connection.client.sessions.get(sessionId);
      if (session?.revision === undefined) throw new Error("fixture session did not persist");
      const attachment = await connection.client.hosting!.start({
        session_id: sessionId,
        session_revision: session.revision,
        kind: "conversation",
        user_preview: "Fixture",
        params: {
          execution_id: randomUUID(),
          agent: "fixture",
          messages: [{ role: "user", content: "Execute the fixture." }],
          ...params,
        },
      });
      return { sessionId, attachment };
    },
    close: disposeAll,
  };
}
