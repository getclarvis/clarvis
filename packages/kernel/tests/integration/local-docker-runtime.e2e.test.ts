import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { loadEnv, type ExecutionRecord, type LLMProvider } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { HOME_ENV } from "@clarvis/paths";
import type { TraceStore } from "@clarvis/trace";
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
const execFileAsync = promisify(execFile);

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

test.skipIf(!enabled)(
  "runs a core-only linked worktree with opaque controls and read-only Git metadata",
  async () => {
    const executable = Bun.which(engine);
    if (executable === null || imageDigest === undefined || context === undefined) {
      throw new Error(`${engine} canary inputs disappeared after admission`);
    }
    const buildRoot = resolve(import.meta.dir, "../../../../build/runtime-e2e");
    await mkdir(buildRoot, { recursive: true });
    const root = await mkdtemp(join(buildRoot, `${engine}-core-`));
    const repositoryRoot = join(root, "repository");
    const workspaceRoot = join(root, "workspace");
    await mkdir(repositoryRoot);
    await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "Clarvis E2E"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "e2e@clarvis.invalid"], {
      cwd: repositoryRoot,
    });
    await writeFile(join(repositoryRoot, "README.md"), "container core e2e\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot });
    await execFileAsync("git", ["worktree", "add", "-b", "container-core", workspaceRoot], {
      cwd: repositoryRoot,
    });
    await mkdir(join(workspaceRoot, ".clarvis", "future"), { recursive: true });
    await mkdir(join(workspaceRoot, ".agents", "future"), { recursive: true });
    await writeFile(join(workspaceRoot, ".clarvis", "future", "sentinel"), "CLARVIS_SECRET");
    await writeFile(join(workspaceRoot, ".agents", "future", "sentinel"), "AGENTS_SECRET");
    const gitCommonDir = await realpath(join(repositoryRoot, ".git"));
    const gitDir = await realpath(
      String(
        (
          await execFileAsync("git", ["rev-parse", "--absolute-git-dir"], {
            cwd: workspaceRoot,
          })
        ).stdout,
      ).trim(),
    );
    const indexBefore = await readFile(join(gitDir, "index"));
    const headBefore = String(
      (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout,
    ).trim();
    const generation = `${engine}-core-${randomUUID()}`;
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
    const control: DockerControl =
      engine === "podman"
        ? createNodePodmanControl({
            executable,
            connection: context,
            environment: controlOptions.environment,
          })
        : createNodeDockerControl(controlOptions);
    const settings = runtimeSettingsSchema.parse({
      backend: engine,
      image_digest: imageDigest,
      network: "outbound",
      ...(engine === "podman" ? { executable, connection: context } : { executable, context }),
      limits: {
        cpu_count: 1,
        memory_bytes: 1024 * 1024 * 1024,
        process_count: 128,
        output_bytes: 4 * 1024 * 1024,
        storage_bytes: 512 * 1024 * 1024,
      },
    });
    if (settings.backend === "native") throw new Error("canary settings lost Container placement");
    let modelCalls = 0;
    const llm: LLMProvider = {
      async call(params) {
        modelCalls += 1;
        const transcript = JSON.stringify(params.messages);
        if (modelCalls === 1) {
          expect(transcript).not.toContain("CLARVIS_SECRET");
          expect(transcript).not.toContain("AGENTS_SECRET");
          return {
            toolCalls: [
              {
                id: "host-escalation-denied",
                name: "shell",
                arguments: {
                  command: "printf host-execution-must-not-run > /workspace/escalated-ran",
                  sandbox_permissions: "require_escalated",
                  justification: "core-only negative canary",
                },
              },
            ],
            usage: {
              input_tokens: 8,
              output_tokens: 2,
              cached_tokens: 0,
              cache_write_tokens: 0,
            },
          };
        }
        if (modelCalls === 2) {
          expect(transcript.toLowerCase()).toContain("denied");
          return {
            toolCalls: [
              {
                id: "core-workload",
                name: "shell",
                arguments: {
                  command: [
                    "set -eu",
                    "test ! -e .clarvis/future/sentinel",
                    "test ! -e .agents/future/sentinel",
                    "git status --short >/tmp/status",
                    "git diff -- README.md >/tmp/diff",
                    "git log -1 --oneline >/tmp/log",
                    "git show HEAD:README.md >/tmp/show",
                    "printf 'guest change\\n' >> README.md",
                    "if git add README.md 2>/tmp/git-add-error; then exit 41; fi",
                    "printf 'workspace write\\n' > core-created.txt",
                    "mise x node@24.20.0 -- node -e \"fetch('https://registry.npmjs.org/is-number').then(r=>{if(!r.ok)process.exit(1)})\"",
                  ].join("\n"),
                  timeout_ms: 120_000,
                },
              },
            ],
            usage: {
              input_tokens: 8,
              output_tokens: 2,
              cached_tokens: 0,
              cache_write_tokens: 0,
            },
          };
        }
        return {
          text: "core-only complete",
          usage: { input_tokens: 8, output_tokens: 2, cached_tokens: 0, cache_write_tokens: 0 },
        };
      },
    };
    const store = traceStore();
    const deps = {
      env: loadEnv({
        CLARVIS_LOG_LEVEL: "silent",
        CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
      }),
      llm,
      traceStore: store,
    } as ExecuteRunDeps;
    let runtime: Awaited<ReturnType<typeof createLocalDockerRuntime>> | undefined;
    let elicitations = 0;
    try {
      runtime = await (engine === "podman" ? createLocalPodmanRuntime : createLocalDockerRuntime)(
        {
          generation,
          ownerId: generation,
          project: { id: "project" },
          workspace: {
            id: "workspace",
            projectId: "project",
            label: "container-core",
            kind: "external_worktree",
          },
          workspaceRoot,
          gitMetadataMounts: [
            {
              source: join(workspaceRoot, ".git"),
              target: "/workspace/.git",
              type: "file",
              readOnly: true,
            },
            { source: gitDir, target: gitDir, type: "directory", readOnly: true },
            {
              source: gitCommonDir,
              target: gitCommonDir,
              type: "directory",
              readOnly: true,
            },
          ],
          deps,
          settings,
        },
        { control, roots: { env: { [HOME_ENV]: join(root, "home") } } },
      );
      const outcome = await runtime.executeRun({
        owner: generation,
        deps,
        rawBody: {
          execution_id: "container_core_e2e",
          messages: [{ role: "user", content: "Run the core-only canary." }],
          servers: [],
          profiles: [
            {
              name: "solo",
              model: "fixture/test",
              tools: [],
              grants: ["read_workspace", "edit_workspace", "run_commands"],
              iteration_limit: 3,
            },
          ],
          entry: "solo",
          providers: [
            {
              name: "fixture",
              kind: "openai-compatible",
              base_url: "https://models.invalid/v1",
            },
          ],
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
        elicit: async () => {
          elicitations += 1;
          return { action: "cancel" };
        },
      });
      expect(outcome.response).toMatchObject({ status: "completed", result: "core-only complete" });
      expect(store.existsForOwner(generation, "container_core_e2e")).toBe(true);
      expect(elicitations).toBe(0);
      expect(await readFile(join(workspaceRoot, "core-created.txt"), "utf8")).toBe(
        "workspace write\n",
      );
      await expect(readFile(join(workspaceRoot, "escalated-ran"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(workspaceRoot, ".clarvis", "future", "sentinel"), "utf8")).toBe(
        "CLARVIS_SECRET",
      );
      expect(await readFile(join(workspaceRoot, ".agents", "future", "sentinel"), "utf8")).toBe(
        "AGENTS_SECRET",
      );
      expect(await readFile(join(gitDir, "index"))).toEqual(indexBefore);
      expect(
        String(
          (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout,
        ).trim(),
      ).toBe(headBefore);
      await expect(readFile(join(gitDir, "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);
