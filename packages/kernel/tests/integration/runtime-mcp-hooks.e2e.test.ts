import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { loadEnv, NOOP_LOGGER, type HookConfig } from "@clarvis/capability";
import { buildExecuteRunDeps } from "@clarvis/loop/host";
import { HOME_ENV } from "@clarvis/paths";
import { runtimeSettingsSchema, type DockerControl } from "../../src/index.ts";
import { createNodeDockerControl, createNodePodmanControl } from "../../src/local.ts";
import { createLocalDockerRuntime } from "../../src/runtime/local-docker-runtime.ts";
import { createLocalPodmanRuntime } from "../../src/runtime/local-podman-runtime.ts";

const engine = process.env.CLARVIS_PODMAN_RUNTIME_CANARY === "1" ? "podman" : "docker";
const imageDigest =
  engine === "podman"
    ? process.env.CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST
    : process.env.CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST;
const context =
  engine === "podman"
    ? process.env.CLARVIS_PODMAN_RUNTIME_CONNECTION
    : process.env.CLARVIS_DOCKER_RUNTIME_CONTEXT;
const enabled =
  (engine === "podman" || process.env.CLARVIS_DOCKER_RUNTIME_CANARY === "1") &&
  /^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "") &&
  typeof context === "string" &&
  context.length > 0;

test.skipIf(!enabled)(
  "confines stdio MCP hooks to the guest, including early hooks and gate rewrites",
  async () => {
    const executable = Bun.which(engine);
    if (executable === null || imageDigest === undefined || context === undefined)
      throw new Error(`${engine} MCP hook canary inputs disappeared after admission`);
    const buildRoot = resolve(import.meta.dir, "../../../../build/runtime-mcp-hooks-e2e");
    await mkdir(buildRoot, { recursive: true });
    const root = await mkdtemp(join(buildRoot, `${engine}-`));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    await copyFile(
      new URL("../fixtures/runtime-hook-mcp.sh", import.meta.url),
      join(workspaceRoot, "probe.sh"),
    );
    const sentinel = join(root, "host-sentinel.txt");
    const marker = join(root, "host-marker.txt");
    await writeFile(sentinel, "synthetic host-only file\n");
    const generation = `mcp-hooks-${randomUUID()}`;
    const controlOptions = {
      executable,
      context,
      environment: Object.fromEntries(
        ["HOME", "PATH", "XDG_RUNTIME_DIR"].flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    };
    const nodeControl =
      engine === "podman"
        ? createNodePodmanControl({ ...controlOptions, connection: context })
        : createNodeDockerControl(controlOptions);
    const caches = new Set<string>();
    let guestStderr = "";
    const control: DockerControl = {
      async run(args, signal) {
        const result = await nodeControl.run(args, signal);
        if (result.exitCode === 0 && args[0] === "volume" && args[1] === "create")
          caches.add(args.at(-1)!);
        return result;
      },
      attach(args) {
        const attached = nodeControl.attach(args);
        attached.stderr.on("data", (chunk: Buffer | string) => {
          guestStderr = (guestStderr + chunk.toString()).slice(-16_384);
        });
        return attached;
      },
    };
    const hooks: HookConfig[] = (
      ["session_start", "run_start", "pre_tool_use", "run_end"] as const
    ).map((event) => ({
      event,
      type: "mcp_tool",
      command: "",
      server: "probe",
      tool: "hook_probe",
      input: { phase: event },
      timeout_ms: 10_000,
      ...(event === "pre_tool_use" ? { match: { tool: "boundary_probe" } } : {}),
    }));
    const built = await buildExecuteRunDeps({
      workspaceRoot,
      traceDir: join(root, "traces"),
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      logger: NOOP_LOGGER,
      environment: { PATH: process.env.PATH },
      builtins: { tools: false, skills: false, hooks: true },
      resolveHooks: () => hooks,
    });
    let hostAcquisitions = 0;
    const acquire = built.deps.connections.acquire.bind(built.deps.connections);
    built.deps.connections.acquire = async (options) => {
      hostAcquisitions++;
      return acquire(options);
    };
    let modelCalls = 0;
    let transcript = "";
    const usage = { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 };
    built.deps.llm = {
      async call(params) {
        modelCalls++;
        transcript = JSON.stringify(params.messages);
        expect(transcript).toContain("GUEST_HOOK_CONTEXT");
        if (modelCalls === 1) {
          expect(params.tools.some((tool) => tool.wireName === "boundary_probe")).toBe(true);
          return {
            toolCalls: [{ id: "probe-call", name: "boundary_probe", arguments: {} }],
            usage,
          };
        }
        return { text: "guest-hooks-completed", usage };
      },
    };
    let runtime: Awaited<ReturnType<typeof createLocalPodmanRuntime>> | undefined;
    try {
      const settings = runtimeSettingsSchema.parse({
        backend: engine,
        executable,
        connection: context,
        image_digest: imageDigest,
        network: "none",
        limits: {
          cpu_count: 1,
          memory_bytes: 1024 * 1024 * 1024,
          process_count: 128,
          output_bytes: 4 * 1024 * 1024,
          storage_bytes: 512 * 1024 * 1024,
        },
      });
      if (settings.backend === "native") throw new Error("canary requires a container runtime");
      runtime = await (engine === "podman" ? createLocalPodmanRuntime : createLocalDockerRuntime)(
        {
          generation,
          ownerId: generation,
          project: { id: generation },
          workspace: { id: generation, projectId: generation, label: "MCP hooks", kind: "primary" },
          workspaceRoot,
          configurationRevision: "fixture",
          extensionRevision: "fixture",
          deps: built.deps,
          settings,
        },
        { control, roots: { env: { [HOME_ENV]: join(root, "state") } } },
      );
      const outcome = await runtime.executeRun({
        owner: generation,
        deps: built.deps,
        externalSignal: AbortSignal.timeout(30_000),
        rawBody: {
          execution_id: "exec_mcp_hooks",
          messages: [{ role: "user", content: "Probe only the synthetic boundary fixture." }],
          providers: [{ name: "test", kind: "anthropic" }],
          servers: [
            {
              name: "probe",
              transport: "stdio",
              command: "/bin/sh",
              args: ["probe.sh"],
              resources: false,
              auto_tools: true,
              startup_timeout_ms: 5_000,
              tool_timeout_ms: 5_000,
              env: { MCP_HOST_SENTINEL: sentinel, MCP_HOST_MARKER: marker },
            },
          ],
          profiles: [
            { name: "solo", model: "test/model", tools: [], grants: [], iteration_limit: 3 },
          ],
          entry: "solo",
          memory: "off",
          guard_mode: "off",
          budget: { on_exceed: "stop", total_token_limit: 10_000 },
        },
      });
      expect(outcome.response).toMatchObject({
        status: "completed",
        result: "guest-hooks-completed",
      });
      expect(modelCalls).toBe(2);
      expect(transcript).toContain("DIRECT_NOTE=rewritten-in-guest");
      expect(hostAcquisitions).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(await readFile(sentinel, "utf8")).toBe("synthetic host-only file\n");
      expect(
        (await readFile(join(workspaceRoot, "boundary.log"), "utf8")).trim().split("\n"),
      ).toEqual(
        ["session_start", "run_start", "pre_tool_use", "direct", "run_end"].map(
          (phase) => `${phase} cwd=/workspace host_read=false host_write=false`,
        ),
      );
    } catch (cause) {
      throw new Error(`${engine} MCP hook boundary canary failed; guest stderr: ${guestStderr}`, {
        cause,
      });
    } finally {
      try {
        await runtime?.close();
      } finally {
        await built.dispose();
        for (const cache of caches) {
          expect((await nodeControl.run(["volume", "rm", cache])).exitCode).toBe(0);
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
