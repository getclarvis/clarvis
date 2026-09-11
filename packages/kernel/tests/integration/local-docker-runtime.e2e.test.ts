import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import {
  loadEnv,
  type ExecutionRecord,
  type LLMProvider,
  type SteerMessage,
} from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { createAgentToolsCapability } from "@clarvis/loop/capabilities/tools";
import type { Memory } from "@clarvis/memory";
import {
  MEMORY_READ_TOOL_NAMES,
  MEMORY_TOOL_CONTRACTS,
  MEMORY_WRITE_TOOL_NAMES,
  memoryToolParameters,
  type MemoryFactory,
  type MemoryToolName,
} from "@clarvis/memory/capability";
import { HOME_ENV } from "@clarvis/paths";
import type { SkillContent, SkillInfo } from "@clarvis/skills";
import type { TraceStore } from "@clarvis/trace";
import {
  RUNTIME_PROTOCOL_REVISION,
  runtimeSettingsSchema,
  type DockerControl,
} from "../../src/index.ts";
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
const execFileAsync = promisify(execFile);
const enabled =
  (engine === "podman" || process.env.CLARVIS_DOCKER_RUNTIME_CANARY === "1") &&
  /^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "") &&
  typeof context === "string" &&
  context.length > 0;

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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Docker runtime evidence");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

test.skipIf(!enabled)(
  "bridges host reads and steer, installs through mise, previews, and survives cancellation",
  async () => {
    const executable = Bun.which(engine);
    if (executable === null || imageDigest === undefined || context === undefined) {
      throw new Error(`${engine} canary inputs disappeared after admission`);
    }
    const buildRoot = resolve(import.meta.dir, "../../../../build/runtime-e2e");
    await mkdir(buildRoot, { recursive: true });
    const root = await mkdtemp(join(buildRoot, "docker-"));
    const hostOnlyProgram = join(root, "host-vcs-fixture");
    await writeFile(hostOnlyProgram, '#!/bin/sh\nprintf "HOST_VCS_EXECUTED_ON_HOST:%s\\n" "$1"\n');
    await chmod(hostOnlyProgram, 0o700);
    const repositoryRoot = join(root, "repository");
    const workspaceRoot = join(root, "workspace");
    await mkdir(repositoryRoot);
    await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Clarvis E2E"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "e2e@clarvis.invalid"], {
      cwd: repositoryRoot,
    });
    await writeFile(join(repositoryRoot, "README.md"), "docker runtime e2e\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot });
    await execFileAsync("git", ["worktree", "add", "-b", "docker-e2e", workspaceRoot], {
      cwd: repositoryRoot,
    });
    const gitCommonDir = await realpath(join(repositoryRoot, ".git"));
    const memoryRoot = join(workspaceRoot, ".clarvis", "memory");
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(memoryRoot, "PROFILE.md"), "HOST_MEMORY\n");
    const generation = `${engine}-e2e-${randomUUID()}`;
    const controlOptions = {
      executable,
      context,
      environment: Object.fromEntries(
        ["HOME", "PATH", "XDG_RUNTIME_DIR"].flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
      timeoutMs: 120_000,
    };
    const nodeControl =
      engine === "podman"
        ? createNodePodmanControl({ ...controlOptions, connection: context })
        : createNodeDockerControl(controlOptions);
    let guestStderr = "";
    const caches = new Set<string>();
    const control: DockerControl = {
      async run(args, signal) {
        const result = await nodeControl.run(args, signal);
        if (result.exitCode === 0 && args[0] === "volume" && args[1] === "create")
          caches.add(args.at(-1)!);
        if (result.exitCode !== 0 && !(args[0] === "volume" && args[1] === "inspect")) {
          guestStderr = `${args[0]}: ${result.stderr}`.slice(-16_384);
        }
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
    const skillRoot = join(root, "host-plugin-skills");
    const bootstrapSkill: SkillInfo = {
      name: "runtime-bootstrap",
      description: "Docker runtime bootstrap",
      metadata: { name: "runtime-bootstrap", description: "Docker runtime bootstrap" },
      userInvocable: true,
      scope: "user",
      source: "plugin:runtime-tools",
      root: skillRoot,
      dir: join(skillRoot, "runtime-bootstrap"),
      path: join(skillRoot, "runtime-bootstrap", "SKILL.md"),
    };
    const methodSkill: SkillInfo = {
      name: "runtime-method",
      description: "Docker runtime method",
      metadata: { name: "runtime-method", description: "Docker runtime method" },
      userInvocable: true,
      scope: "user",
      source: "plugin:runtime-tools",
      root: skillRoot,
      dir: join(skillRoot, "runtime-method"),
      path: join(skillRoot, "runtime-method", "SKILL.md"),
    };
    const helperResources = new Map([
      [
        "scripts/main.sh",
        '. "$(dirname "$0")/lib/value.sh"\nemit_value > /workspace/skill-helper.txt\n',
      ],
      ["scripts/lib/value.sh", 'emit_value() { printf "SKILL_HELPER_PREPARED\\n"; }\n'],
    ]);
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const prepareHelper = [
      `test ! -e ${shellQuote(hostOnlyProgram)}`,
      "mkdir -p /workspace/prepared-skill/scripts/lib",
      ...[...helperResources].map(
        ([resource, content]) =>
          `printf %s ${shellQuote(content)} > /workspace/prepared-skill/${resource}`,
      ),
      "sh /workspace/prepared-skill/scripts/main.sh",
    ].join("; ");
    const skillContents = new Map<string, SkillContent>([
      [bootstrapSkill.name, { ...bootstrapSkill, body: "DOCKER_RUNTIME_BOOTSTRAP", resources: [] }],
      [
        methodSkill.name,
        {
          ...methodSkill,
          body: "DOCKER_RUNTIME_SKILL_BODY\nRun scripts/main.sh after preparing its relative library.",
          resources: [...helperResources.keys()].map((rel) => ({
            kind: "scripts" as const,
            rel,
            path: join(methodSkill.dir, rel),
          })),
        },
      ],
    ]);
    const memory = {} as Memory;
    const memoryFactory: MemoryFactory = {
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      providerFor: async () => ({
        ok: true,
        provider: {
          kind: "read-only-docker-e2e",
          readTools: MEMORY_READ_TOOL_NAMES.map((name) => ({
            name,
            description: MEMORY_TOOL_CONTRACTS[name as MemoryToolName].description,
            parameters: memoryToolParameters(name as MemoryToolName),
            async execute(args) {
              if (name === "read_memory") {
                expect(args).toEqual({ paths: ["PROFILE.md"] });
                return { text: "DOCKER_RUNTIME_MEMORY_DOCUMENT", isError: false };
              }
              return { text: "unused", isError: false };
            },
          })),
          seed: async () => "DOCKER_RUNTIME_MEMORY_SEED",
        },
        key: `docker-e2e:${"b".repeat(64)}`,
        seedMaxChars: 6_000,
      }),
      start() {},
      poke() {},
      async stop() {},
      subscribeToRun: () => () => undefined,
    };
    let workloadModelCall = 0;
    let markWorkloadModelStarted!: () => void;
    const workloadModelStarted = new Promise<void>((resolveStarted) => {
      markWorkloadModelStarted = resolveStarted;
    });
    let releaseWorkloadModel!: () => void;
    const workloadModelGate = new Promise<void>((resolveModel) => {
      releaseWorkloadModel = resolveModel;
    });
    let markCancelModelStarted: (() => void) | undefined;
    const cancelModelStarted = new Promise<void>((resolveStarted) => {
      markCancelModelStarted = resolveStarted;
    });
    let previewEvidence: { url: string; dependency: string } | undefined;
    const llm: LLMProvider = {
      async call(params) {
        const transcript = JSON.stringify(params.messages);
        const usage = {
          input_tokens: 5,
          output_tokens: 3,
          cached_tokens: 0,
          cache_write_tokens: 0,
        };
        if (transcript.includes("DOCKER_CANCEL_E2E")) {
          markCancelModelStarted?.();
          return await new Promise((_, reject) => {
            const abort = () => reject(new DOMException("Docker canary cancelled", "AbortError"));
            if (params.signal?.aborted === true) abort();
            else params.signal?.addEventListener("abort", abort, { once: true });
          });
        }
        if (transcript.includes("DOCKER_RECOVER_E2E")) {
          return { text: "docker-runtime-recovered", usage };
        }
        workloadModelCall += 1;
        if (workloadModelCall === 1) {
          markWorkloadModelStarted();
          expect(transcript).toContain("DOCKER_RUNTIME_BOOTSTRAP");
          expect(transcript).toContain("DOCKER_RUNTIME_MEMORY_SEED");
          expect(transcript).not.toContain(skillRoot);
          const toolNames = params.tools.map((tool) => tool.wireName);
          for (const name of MEMORY_READ_TOOL_NAMES) expect(toolNames).toContain(name);
          for (const name of MEMORY_WRITE_TOOL_NAMES) expect(toolNames).not.toContain(name);
          expect(toolNames).toContain("read_skill_resource");
          const loadSchema = params.tools.find((tool) => tool.wireName === "load_skill")
            ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
          expect(Object.keys(loadSchema?.properties ?? {})).toEqual(["name"]);
          await workloadModelGate;
          return {
            toolCalls: [
              {
                id: "load-runtime-skill",
                name: "load_skill",
                arguments: { name: methodSkill.name },
              },
              {
                id: "read-runtime-memory",
                name: "read_memory",
                arguments: { paths: ["PROFILE.md"] },
              },
            ],
            usage,
          };
        }
        if (workloadModelCall === 2) {
          expect(transcript).toContain("read_skill_resource");
          expect(transcript).not.toContain("/runtime/skills/");
          return {
            toolCalls: [...helperResources.keys()].map((resource, index) => ({
              id: `read-helper-${index}`,
              name: "read_skill_resource",
              arguments: { name: methodSkill.name, resource, offset: 0 },
            })),
            usage,
          };
        }
        if (workloadModelCall === 3) {
          const resourceText = params.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.content)
            .join("\n");
          for (const content of helperResources.values())
            expect(resourceText).toContain(content.trim());
          expect(transcript).toContain("DOCKER_RUNTIME_STEER");
          expect(transcript).toContain("DOCKER_RUNTIME_SKILL_BODY");
          expect(transcript).toContain("DOCKER_RUNTIME_MEMORY_DOCUMENT");
          return {
            toolCalls: [
              {
                id: "host-vcs-review-off",
                name: "host_vcs",
                arguments: { program: hostOnlyProgram, args: ["deterministic-fixture"] },
              },
              { id: "prepare-skill-helpers", name: "shell", arguments: { command: prepareHelper } },
              {
                id: "npm-install",
                name: "shell",
                arguments: {
                  command:
                    'sh -euc \'if printf poisoned > /workspace/.clarvis/memory/PROFILE.md 2>/tmp/memory-write-error; then exit 1; fi; printf "guest write\\n" > /workspace/guest-created.txt; git -C /workspace status --short >/tmp/git-status; mise x node@24.20.0 -- sh -c "mkdir -p \\"$TMPDIR/npm-e2e\\" && cd \\"$TMPDIR/npm-e2e\\" && npm init -y >/dev/null && npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0"\'',
                  timeout_ms: 120_000,
                },
              },
            ],
            usage,
          };
        }
        if (workloadModelCall === 4) {
          expect(transcript).toContain("HOST_VCS_EXECUTED_ON_HOST:deterministic-fixture");
          expect(transcript).not.toContain("host_vcs requires command review");
          expect(await readFile(join(workspaceRoot, "skill-helper.txt"), "utf8")).toBe(
            "SKILL_HELPER_PREPARED\n",
          );
          expect(await readFile(join(workspaceRoot, "guest-created.txt"), "utf8")).toBe(
            "guest write\n",
          );
          return {
            toolCalls: [
              {
                id: "start-http",
                name: "monitor_start",
                arguments: {
                  command:
                    'mise x node@24.20.0 -- node -e \'const http=require("node:http");const fs=require("node:fs");const root=process.env.TMPDIR+"/npm-e2e";http.createServer((req,res)=>{if(req.url!=="/package.json"){res.statusCode=404;res.end();return;}res.end(fs.readFileSync(root+"/package.json"));}).listen(9090,"127.0.0.1",()=>console.log("Serving HTTP"))\'',
                  ready_when: "Serving HTTP",
                  ready_timeout_ms: 30_000,
                },
              },
            ],
            usage,
          };
        }
        if (workloadModelCall === 5) {
          return {
            toolCalls: [
              {
                id: "expose-http",
                name: "expose_port",
                arguments: { port: 9090, protocol: "http" },
              },
            ],
            usage,
          };
        }
        const previewUrl = transcript.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
        if (previewUrl === undefined) {
          throw new Error(
            `preview tool returned no loopback URL: ${JSON.stringify(
              params.messages.filter((message) => message.role === "tool"),
            )}`,
          );
        }
        const response = await fetch(`${previewUrl}package.json`, { signal: params.signal });
        if (!response.ok) throw new Error(`preview returned HTTP ${String(response.status)}`);
        const manifest = (await response.json()) as { dependencies?: Record<string, string> };
        const dependency = manifest.dependencies?.["is-number"];
        if (dependency === undefined) throw new Error("npm dependency was absent from preview");
        previewEvidence = { url: previewUrl, dependency };
        params.onStreamDelta?.({ channel: "text", text: "docker-network-preview-ok", reset: true });
        return {
          text: "docker-network-preview-ok",
          usage,
        };
      },
    };
    const store = traceStore();
    const deps = {
      env: loadEnv({ CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" }),
      capabilities: [createAgentToolsCapability()],
      llm,
      traceStore: store,
    } as ExecuteRunDeps;
    let runtime: Awaited<ReturnType<typeof createLocalDockerRuntime>> | undefined;
    try {
      const settings = runtimeSettingsSchema.parse({
        backend: engine,
        image_digest: imageDigest,
        executable,
        connection: context,
        limits: {
          cpu_count: 1,
          memory_bytes: 1024 * 1024 * 1024,
          process_count: 128,
          output_bytes: 4 * 1024 * 1024,
          storage_bytes: 512 * 1024 * 1024,
        },
      });
      if (settings.backend === "native") throw new Error("Canary settings lost their backend");
      runtime = await (engine === "podman" ? createLocalPodmanRuntime : createLocalDockerRuntime)(
        {
          generation,
          ownerId: generation,
          project: { id: "project" },
          workspace: {
            id: "workspace",
            projectId: "project",
            label: "docker-e2e",
            kind: "external_worktree",
          },
          workspaceRoot,
          gitCommonDir,
          configurationRevision: "config",
          extensionRevision: "extensions",
          deps,
          skillsProvider: {
            listSkills: () => [bootstrapSkill, methodSkill],
            loadSkill: (name) => skillContents.get(name),
            readResource: (name, resource) => {
              const content = name === methodSkill.name ? helperResources.get(resource) : undefined;
              if (content === undefined) throw new Error("unknown helper resource");
              return content;
            },
          },
          skillBootstraps: () => [
            { plugin: "runtime-tools", skill: bootstrapSkill.name, roots: [skillRoot] },
          ],
          memoryFactory,
          settings,
        },
        { control, roots: { env: { [HOME_ENV]: join(root, "home") } } },
      );
      expect(runtime.info).toMatchObject({
        engine,
        imageDigest,
        guestPlatform: "linux",
        runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
        network: "outbound",
        lifecycle: "ready",
      });
      const capabilityEvents: unknown[] = [];
      const pendingSteers: SteerMessage[] = [];
      const outcomeTask = runtime.executeRun({
        owner: "owner",
        deps,
        rawBody: {
          execution_id: "exec_docker_e2e",
          messages: [{ role: "user", content: "install a package and preview a service" }],
          servers: [],
          profiles: [
            {
              name: "solo",
              model: "anthropic/test",
              tools: [],
              grants: ["run_commands", "use_skills"],
              iteration_limit: 6,
            },
          ],
          entry: "solo",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          guard_mode: "off",
          memory: "on",
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
        onCapabilityEvent: (event) => capabilityEvents.push(event),
        steer: { drain: () => pendingSteers.splice(0) },
      });
      await workloadModelStarted;
      pendingSteers.push({ content: "DOCKER_RUNTIME_STEER" });
      await waitFor(() => pendingSteers.length === 0);
      releaseWorkloadModel();
      const outcome = await outcomeTask;
      expect(outcome).toMatchObject({
        executionId: "exec_docker_e2e",
        response: { status: "completed", result: "docker-network-preview-ok" },
      });
      expect(previewEvidence).toEqual({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
        dependency: "^7.0.0",
      });
      expect(await readFile(join(workspaceRoot, "guest-created.txt"), "utf8")).toBe(
        "guest write\n",
      );
      expect(await readFile(join(memoryRoot, "PROFILE.md"), "utf8")).toBe("HOST_MEMORY\n");
      expect(store.existsForOwner("owner", "exec_docker_e2e")).toBe(true);
      expect(capabilityEvents).toContainEqual({
        capability: "memory",
        kind: "ingest",
        detail: {
          execution_id: "exec_docker_e2e",
          phase: "done",
          skipped: true,
          note: "provider-read-only",
        },
      });

      const cancel = new AbortController();
      const cancelledRun = runtime.executeRun({
        owner: "owner",
        deps,
        externalSignal: cancel.signal,
        rawBody: {
          execution_id: "exec_docker_cancel",
          messages: [{ role: "user", content: "DOCKER_CANCEL_E2E" }],
          servers: [],
          profiles: [
            {
              name: "solo",
              model: "anthropic/test",
              tools: [],
              grants: [],
              iteration_limit: 3,
            },
          ],
          entry: "solo",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          memory: "off",
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
      });
      await cancelModelStarted;
      cancel.abort({ source: "docker-e2e" });
      await expect(cancelledRun).resolves.toMatchObject({
        executionId: "exec_docker_cancel",
        response: { status: "cancelled" },
      });
      expect(runtime.closed).toBe(false);

      await expect(
        runtime.executeRun({
          owner: "owner",
          deps,
          rawBody: {
            execution_id: "exec_docker_recover",
            messages: [{ role: "user", content: "DOCKER_RECOVER_E2E" }],
            servers: [],
            profiles: [
              {
                name: "solo",
                model: "anthropic/test",
                tools: [],
                grants: [],
                iteration_limit: 3,
              },
            ],
            entry: "solo",
            providers: [{ name: "anthropic", kind: "anthropic" }],
            memory: "off",
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
          },
        }),
      ).resolves.toMatchObject({
        executionId: "exec_docker_recover",
        response: { status: "completed", result: "docker-runtime-recovered" },
      });
      expect(runtime.closed).toBe(false);
    } catch (error) {
      if (guestStderr.length > 0) {
        throw new Error(`${engine} guest stderr:\n${guestStderr.trimEnd()}`, { cause: error });
      }
      throw error;
    } finally {
      releaseWorkloadModel();
      await runtime?.close().catch(() => undefined);
      await control.run(["rm", "--force", `clarvis-runtime-${generation}`]).catch(() => undefined);
      for (const cache of caches) {
        const removed = await control.run(["volume", "rm", cache]);
        expect(removed.exitCode).toBe(0);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  300_000,
);
