import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, type ExecutionRecord, type LLMProvider } from "@clarvis/capability";
import { HOME_ENV } from "@clarvis/paths";
import type { Memory } from "@clarvis/memory";
import {
  MEMORY_READ_TOOL_NAMES,
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryFactory,
  type MemoryToolName,
} from "@clarvis/memory/capability";
import type { SkillContent, SkillInfo } from "@clarvis/skills";
import type { TraceStore } from "@clarvis/trace";
import type { ExecuteRunDeps } from "@clarvis/loop";
import {
  createGuestLoopExecutor,
  RUNTIME_PROTOCOL_REVISION,
  serveExecutionWorker,
  type PodmanAttachedProcess,
  type PodmanControl,
} from "../../src/index.ts";
import { createLocalPodmanRuntime } from "../../src/local.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function traceStore(): TraceStore {
  const records = new Map<string, ExecutionRecord>();
  return {
    async insert(record) {
      records.set(`${record.owner_key_name}\0${record.id}`, record);
    },
    getById(owner, id) {
      return records.get(`${owner}\0${id}`) ?? null;
    },
    async replaceFinalContext() {
      return false;
    },
    list() {
      return { items: [], total: 0 };
    },
    deleteById() {
      return false;
    },
    deleteOwner() {
      return 0;
    },
    existsForOwner(owner, id) {
      return records.has(`${owner}\0${id}`);
    },
    cleanup() {
      return 0;
    },
  };
}

describe("local Podman runtime composition", () => {
  it("runs the real guest loop and settles host trace/checkpoint state", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-local-runtime-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "fixture\n");
    const digest = `sha256:${"d".repeat(64)}`;
    const generation = "generation-local-1";
    let retainedRoot = "";
    let guest: ReturnType<typeof serveExecutionWorker> | undefined;
    const control: PodmanControl = {
      async run(args) {
        if (args[0] === "info") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: { Version: "5.4.0" },
              host: { security: { rootless: true } },
            }),
            stderr: "",
          };
        }
        if (args[0] === "image") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Digest: digest,
                Config: {
                  Labels: { "io.clarvis.runtime.protocol": RUNTIME_PROTOCOL_REVISION },
                },
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "create") {
          const mount = args[args.indexOf("--mount") + 1]!;
          retainedRoot = mount.match(/source=([^,]+)/u)?.[1] ?? "";
          return { exitCode: 0, stdout: "container-id", stderr: "" };
        }
        if (args[0] === "container") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                HostConfig: { Privileged: false, NetworkMode: "none" },
                Config: { Labels: { "io.clarvis.generation": generation } },
                Mounts: [{ Source: retainedRoot, Destination: "/workspace", RW: true }],
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "stop") guest?.close();
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      attach(): PodmanAttachedProcess {
        const hostToGuest = new PassThrough();
        const guestToHost = new PassThrough();
        const stderr = new PassThrough();
        guest = serveExecutionWorker({
          generation,
          imageDigest: digest,
          input: hostToGuest,
          output: guestToHost,
          executor: createGuestLoopExecutor({
            workspaceRoot: retainedRoot,
            scratchRoot: join(root, "guest-scratch"),
          }),
        });
        return {
          stdin: hostToGuest,
          stdout: guestToHost,
          stderr,
          exited: new Promise(() => undefined),
          kill: () => guest?.close(),
        };
      },
    };
    const llm: LLMProvider = {
      async call(params) {
        const prompt = JSON.stringify(params.messages);
        expect(prompt).toContain("LOCAL_RUNTIME_MEMORY_SEED");
        expect(prompt).toContain("LOCAL_RUNTIME_BOOTSTRAP");
        params.onStreamDelta?.({ channel: "text", text: "done", reset: true });
        return {
          text: "done",
          usage: { input_tokens: 8, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const skillRoot = join(root, "host-plugin-skills");
    const skillInfo: SkillInfo = {
      name: "runtime-method",
      description: "Runtime method",
      metadata: { name: "runtime-method", description: "Runtime method" },
      userInvocable: true,
      scope: "user",
      source: "plugin:runtime-tools",
      root: skillRoot,
      dir: join(skillRoot, "runtime-method"),
      path: join(skillRoot, "runtime-method", "SKILL.md"),
    };
    const skillContent: SkillContent = {
      ...skillInfo,
      body: "LOCAL_RUNTIME_BOOTSTRAP",
      resources: [],
    };
    const memory = {} as Memory;
    const memoryFactory: MemoryFactory = {
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      providerFor: async () => ({
        ok: true,
        provider: {
          kind: "read-only-fixture",
          readTools: MEMORY_READ_TOOL_NAMES.map((name) => ({
            name,
            description: MEMORY_TOOL_CONTRACTS[name as MemoryToolName].description,
            parameters: memoryToolParameters(name as MemoryToolName),
            execute: async () => ({ text: "unused", isError: false }),
          })),
          seed: async () => "LOCAL_RUNTIME_MEMORY_SEED",
        },
        key: `fixture:${"b".repeat(64)}`,
        seedMaxChars: 6_000,
      }),
      start() {},
      poke() {},
      async stop() {},
      subscribeToRun: () => () => undefined,
    };
    const store = traceStore();
    const deps = { env: loadEnv({}), llm, traceStore: store } as ExecuteRunDeps;
    const runtime = await createLocalPodmanRuntime(
      {
        generation,
        ownerId: "owner",
        project: { id: "project" },
        workspace: { id: "workspace", projectId: "project", label: "main", kind: "primary" },
        workspaceRoot,
        configurationRevision: "config",
        extensionRevision: "extensions",
        deps,
        skillsProvider: {
          listSkills: () => [skillInfo],
          loadSkill: (name) => (name === skillInfo.name ? skillContent : undefined),
          readResource: () => {
            throw new Error("no resource");
          },
        },
        skillBootstraps: () => [
          { plugin: "runtime-tools", skill: skillInfo.name, roots: [skillRoot] },
        ],
        memoryFactory,
        settings: {
          backend: "podman",
          image_digest: digest,
          network: "none",
          executable: "/usr/bin/podman",
          connection: "local",
          limits: {
            cpu_count: 1,
            memory_bytes: 64 * 1024 * 1024,
            process_count: 32,
            output_bytes: 1024 * 1024,
            storage_bytes: 128 * 1024 * 1024,
          },
        },
      },
      { control, roots: { env: { [HOME_ENV]: join(root, "home") } } },
    );

    try {
      const capabilityEvents: unknown[] = [];
      const outcome = await runtime.executeRun({
        owner: "owner",
        deps,
        hostElicit: async () => {
          throw new Error("unchanged workspace must not elicit");
        },
        rawBody: {
          execution_id: "exec_local_1",
          messages: [{ role: "user", content: "hi" }],
          servers: [],
          profiles: [
            {
              name: "solo",
              model: "anthropic/x",
              tools: [],
              grants: ["use_skills"],
              iteration_limit: 3,
            },
          ],
          entry: "solo",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          memory: "on",
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
        onCapabilityEvent: (event) => capabilityEvents.push(event),
      });
      expect(outcome).toMatchObject({
        executionId: "exec_local_1",
        response: { status: "completed" },
      });
      expect(store.existsForOwner("owner", "exec_local_1")).toBe(true);
      expect(capabilityEvents).toContainEqual({
        capability: "memory",
        kind: "ingest",
        detail: {
          execution_id: "exec_local_1",
          phase: "done",
          skipped: true,
          note: "provider-read-only",
        },
      });
      await expect(
        runtime.executeRun({
          owner: "owner",
          deps,
          hostElicit: async () => {
            throw new Error("unchanged workspace must not elicit");
          },
          rawBody: {
            execution_id: "exec_local_custom",
            messages: [{ role: "user", content: "hi" }],
            servers: [],
            profiles: [
              {
                name: "solo",
                model: "custom/x",
                tools: [],
                grants: ["use_skills"],
                iteration_limit: 3,
              },
            ],
            entry: "solo",
            providers: [
              {
                name: "custom",
                kind: "openai-compatible",
                base_url: "https://models.example.test/v1",
              },
            ],
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
          },
        }),
      ).resolves.toMatchObject({ executionId: "exec_local_custom" });
    } finally {
      await runtime.close();
    }
  });
});
