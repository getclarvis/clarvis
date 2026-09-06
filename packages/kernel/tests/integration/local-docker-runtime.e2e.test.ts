import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { loadEnv, type ExecutionRecord, type LLMProvider } from "@clarvis/capability";
import type { ExecuteRunDeps } from "@clarvis/loop";
import { HOME_ENV } from "@clarvis/paths";
import type { TraceStore } from "@clarvis/trace";
import {
  RUNTIME_PROTOCOL_REVISION,
  runtimeSettingsSchema,
  type DockerControl,
} from "../../src/index.ts";
import { createNodeDockerControl } from "../../src/local.ts";
import { createLocalDockerRuntime } from "../../src/runtime/local-docker-runtime.ts";

const imageDigest = process.env.CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST;
const context = process.env.CLARVIS_DOCKER_RUNTIME_CONTEXT;
const enabled =
  process.env.CLARVIS_DOCKER_RUNTIME_CANARY === "1" &&
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

test.skipIf(!enabled)(
  "installs Node through mise, installs an npm package and previews a guest service",
  async () => {
    const docker = Bun.which("docker");
    if (docker === null || imageDigest === undefined || context === undefined) {
      throw new Error("Docker canary inputs disappeared after admission");
    }
    const buildRoot = resolve(import.meta.dir, "../../../../build/runtime-e2e");
    await mkdir(buildRoot, { recursive: true });
    const root = await mkdtemp(join(buildRoot, "docker-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "docker runtime e2e\n");
    const generation = `docker-e2e-${randomUUID()}`;
    const nodeControl = createNodeDockerControl({
      executable: docker,
      context,
      environment: Object.fromEntries(
        ["HOME", "PATH"].flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
      timeoutMs: 120_000,
    });
    let guestStderr = "";
    const control: DockerControl = {
      run: (args, signal) => nodeControl.run(args, signal),
      attach(args) {
        const attached = nodeControl.attach(args);
        attached.stderr.on("data", (chunk: Buffer | string) => {
          guestStderr = (guestStderr + chunk.toString()).slice(-16_384);
        });
        return attached;
      },
    };
    let modelCall = 0;
    let previewEvidence: { url: string; dependency: string } | undefined;
    const llm: LLMProvider = {
      async call(params) {
        modelCall += 1;
        const usage = {
          input_tokens: 5,
          output_tokens: 3,
          cached_tokens: 0,
          cache_write_tokens: 0,
        };
        if (modelCall === 1) {
          return {
            toolCalls: [
              {
                id: "npm-install",
                name: "shell",
                arguments: {
                  command:
                    'mise x node@24.20.0 -- sh -c \'mkdir -p "$TMPDIR/npm-e2e" && cd "$TMPDIR/npm-e2e" && npm init -y >/dev/null && npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0\'',
                  timeout_ms: 120_000,
                },
              },
            ],
            usage,
          };
        }
        if (modelCall === 2) {
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
        if (modelCall === 3) {
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
        const transcript = JSON.stringify(params.messages);
        const previewUrl = transcript.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
        if (previewUrl === undefined) throw new Error("preview tool returned no loopback URL");
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
    const deps = { env: loadEnv({}), llm, traceStore: store } as ExecuteRunDeps;
    let runtime: Awaited<ReturnType<typeof createLocalDockerRuntime>> | undefined;
    try {
      const settings = runtimeSettingsSchema.parse({
        backend: "docker",
        image_digest: imageDigest,
        executable: docker,
        connection: context,
        limits: {
          cpu_count: 1,
          memory_bytes: 1024 * 1024 * 1024,
          process_count: 128,
          output_bytes: 4 * 1024 * 1024,
          storage_bytes: 512 * 1024 * 1024,
        },
      });
      if (settings.backend !== "docker") throw new Error("Docker settings lost their backend");
      runtime = await createLocalDockerRuntime(
        {
          generation,
          ownerId: "owner",
          project: { id: "project" },
          workspace: { id: "workspace", projectId: "project", label: "main", kind: "primary" },
          workspaceRoot,
          configurationRevision: "config",
          extensionRevision: "extensions",
          deps,
          settings,
        },
        { control, roots: { env: { [HOME_ENV]: join(root, "home") } } },
      );
      expect(runtime.info).toMatchObject({
        engine: "docker",
        imageDigest,
        guestPlatform: "linux",
        runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
        network: "outbound",
        lifecycle: "ready",
      });
      const outcome = await runtime.executeRun({
        owner: "owner",
        deps,
        hostElicit: async () => {
          throw new Error("unchanged workspace must not elicit");
        },
        rawBody: {
          execution_id: "exec_docker_e2e",
          messages: [{ role: "user", content: "install a package and preview a service" }],
          servers: [],
          profiles: [
            {
              name: "solo",
              model: "anthropic/test",
              tools: [],
              grants: ["run_commands"],
              iteration_limit: 6,
            },
          ],
          entry: "solo",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          guard_mode: "off",
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
      });
      expect(outcome).toMatchObject({
        executionId: "exec_docker_e2e",
        response: { status: "completed", result: "docker-network-preview-ok" },
      });
      expect(previewEvidence).toEqual({
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
        dependency: "^7.0.0",
      });
      expect(store.existsForOwner("owner", "exec_docker_e2e")).toBe(true);
    } catch (error) {
      if (guestStderr.length > 0) {
        throw new Error(`Docker guest stderr:\n${guestStderr.trimEnd()}`, { cause: error });
      }
      throw error;
    } finally {
      await runtime?.close().catch(() => undefined);
      await control.run(["rm", "--force", `clarvis-runtime-${generation}`]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
