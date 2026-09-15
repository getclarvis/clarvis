import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createFilePlanRepository, createPlanStore } from "@clarvis/plan";
import { containerDataVolumeNames, workspacePaths, workspaceStatePaths } from "@clarvis/paths";
import { createFileKernel, loadEnv } from "../../src/bootstrap.ts";
import { connectLocalContainerKernel } from "../../src/hosting/connect-local-container.ts";
import { discoverGitWorkspace } from "../../src/git-workspace.ts";
import { parseRuntimeArtifactManifest } from "../../src/runtime/runtime-artifact.ts";
import { resolveContainerVolumeIdentity } from "../../src/runtime/container-volumes.ts";

const engine = process.env.CLARVIS_RUNTIME_QUALIFY_ENGINE;
const base = process.env.CLARVIS_RUNTIME_QUALIFY_BASE;
const archive = process.env.CLARVIS_RUNTIME_QUALIFY_ARTIFACT;
const evidencePath = process.env.CLARVIS_RUNTIME_QUALIFY_EVIDENCE;
const enabled =
  (engine === "docker" || engine === "podman") &&
  typeof base === "string" &&
  typeof archive === "string" &&
  typeof evidencePath === "string";

async function artifactSelection(path: string) {
  const child = Bun.spawn(["tar", "-xOzf", path, "manifest.json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const bytes = await new Response(child.stdout).bytes();
  if ((await child.exited) !== 0) throw new Error("qualification artifact manifest is unreadable");
  const manifest = parseRuntimeArtifactManifest(bytes);
  const data = await readFile(path);
  return {
    manifest,
    selection: {
      productVersion: manifest.productVersion,
      sourceRevision: manifest.sourceRevision,
      target: manifest.target,
      baseAbi: manifest.baseAbi,
      digest: `sha256:${createHash("sha256").update(data).digest("hex")}` as const,
      size: (await stat(path)).size,
    },
  };
}

async function removeVolume(name: string): Promise<void> {
  const inspect = Bun.spawn([engine!, "volume", "inspect", name], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await inspect.exited) !== 0) return;
  const result = Bun.spawn([engine!, "volume", "rm", name], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await result.exited;
  if (code !== 0) {
    const detail = (await new Response(result.stderr).text()).trim();
    throw new Error(
      `qualification could not remove owned volume ${name}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

async function inspectBaseImageId(reference: string): Promise<`sha256:${string}`> {
  const inspect = Bun.spawn([engine!, "image", "inspect", reference], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(inspect.stdout).text();
  if ((await inspect.exited) !== 0)
    throw new Error("qualification base image is not installed in the selected engine");
  const parsed = JSON.parse(stdout) as Array<{ Id?: unknown }>;
  const raw = parsed[0]?.Id;
  const id = typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw) ? `sha256:${raw}` : raw;
  if (typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(id))
    throw new Error("qualification base image id is invalid");
  return id as `sha256:${string}`;
}

test.skipIf(!enabled)(
  "real engine boots the compiled full Kernel, shares the workspace and preserves the namespace",
  async () => {
    if ((process.getuid?.() ?? 1000) === 0)
      throw new Error("Container qualification must run as a nonroot operator");
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-e2e-"));
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "operator");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    await writeFile(join(workspaceRoot, "visible.txt"), "same host workspace\n");
    await writeFile(join(workspaceRoot, ".env"), "CLARVIS_OWNER=autoloaded\n");
    await writeFile(join(workspaceRoot, "bunfig.toml"), 'preload = ["./sentinel.ts"]\n');
    await writeFile(
      join(workspaceRoot, "sentinel.ts"),
      'await Bun.write("autoloaded.txt", "unsafe preload");\n',
    );
    await writeFile(join(workspaceRoot, "tsconfig.json"), '{"compilerOptions":{"plugins":[]}}\n');
    await writeFile(join(workspaceRoot, "package.json"), '{"name":"runtime-sentinel"}\n');
    await Promise.all([
      mkdir(join(workspaceRoot, ".clarvis")),
      mkdir(join(workspaceRoot, ".agents")),
      mkdir(join(workspaceRoot, ".git")),
    ]);
    const workspace = workspacePaths(workspaceRoot);
    await mkdir(join(workspace.memoryRoot, "runtime"), { recursive: true });
    await writeFile(
      workspace.settingsFile,
      `${JSON.stringify({ memory: { enabled: true, provider: { kind: "wiki" } } })}\n`,
    );
    await writeFile(
      join(workspace.memoryRoot, "runtime", "MEMORY.md"),
      "---\ndescription: Cross-placement memory\n---\n# Runtime\n\nPersist this memory.\n",
    );
    await writeFile(join(workspaceRoot, ".agents", "hidden.txt"), "must stay masked\n");
    const artifact = await artifactSelection(archive!);
    const git = await discoverGitWorkspace(workspaceRoot);
    const identity = await resolveContainerVolumeIdentity({
      workspaceRoot: git.worktreeRoot,
      globalDir,
      projectId: git.project.id,
    });
    const data = containerDataVolumeNames(identity.namespace);
    const baseImageId = await inspectBaseImageId(base!);
    const planStore = createPlanStore({
      repository: createFilePlanRepository({
        workspaceRoot,
        lockDir: workspaceStatePaths(workspaceRoot, {
          env: { CLARVIS_HOME: globalDir },
        }).plansLockDir,
      }),
    });
    const seededPlan = await planStore.create({
      title: "Cross-placement plan",
      objective: "Remain visible across Container and Host kernels",
      tasks: [{ title: "Preserve canonical state" }],
      createdByRun: "container-e2e",
    });
    const sessionId = "container-cross-placement";
    const miseDigest = createHash("sha256")
      .update(JSON.stringify({ schema: 3, namespace: identity.namespace, baseImageId }))
      .digest("hex");
    let first: Awaited<ReturnType<typeof connectLocalContainerKernel>> | undefined;
    let second: Awaited<ReturnType<typeof connectLocalContainerKernel>> | undefined;
    let hostKernel: Awaited<ReturnType<typeof createFileKernel>> | undefined;
    const volumes = [data.content, data.state, `clarvis-mise-v3-${miseDigest}`];
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    let stage = "first-connect";
    try {
      const release = {
        base: { reference: base!, pull: false },
        artifact: {
          source: { kind: "local" as const, archivePath: archive! },
          selection: artifact.selection,
        },
      };
      const options = {
        workspaceRoot,
        globalDir,
        owner: userInfo().username,
        runtime: {
          backend: engine as "docker" | "podman",
          network: "none" as const,
          limits: {
            cpu_count: 2,
            memory_bytes: 4 * 1024 * 1024 * 1024,
            process_count: 256,
            output_bytes: 16 * 1024 * 1024,
            storage_bytes: 512 * 1024 * 1024,
          },
        },
        release,
      };
      first = await connectLocalContainerKernel(options);
      stage = "first-identity";
      const runtime = first.client.capabilities.runtime;
      expect(runtime).toMatchObject({
        kind: "container",
        lifecycle: "ready",
        network: "none",
        artifact_digest: artifact.selection.digest,
        base_abi: "clarvis-linux-glibc-v1",
        broker_version: 1,
        channel_version: 1,
      });
      expect((await first.client.files.readFile("visible.txt")).content).toBe(
        "same host workspace\n",
      );
      expect((await first.client.plans.read(seededPlan.id)).retention).toBe("keep");
      await first.client.plans.setRetention(seededPlan.id, "discard");
      await first.client.sessions.save({
        id: sessionId,
        title: "Container continuity",
        project_id: git.project.id,
        workspace: git.workspace.id,
        created_at: 1,
        updated_at: 2,
        turns: [],
        totals: { input: 0, output: 0, cached: 0 },
        pending: [{ role: "user", content: "Persisted Container context" }],
      });
      expect((await first.client.memory.reindex()).reindexed).toContain("PROFILE.md");
      await expect(first.client.files.readFile("autoloaded.txt")).rejects.toBeDefined();
      await expect(first.client.files.readFile(".agents/hidden.txt")).rejects.toBeDefined();
      stage = "concurrent-connect";
      await expect(connectLocalContainerKernel(options)).rejects.toMatchObject({
        code: "conflict",
      });

      const namespace = runtime?.kind === "container" ? runtime.state_namespace : undefined;
      expect(namespace).toMatch(/^[a-f0-9]{64}$/);
      stage = "first-close";
      await first.close();
      first = undefined;
      stage = "host-continuity";
      hostKernel = await createFileKernel({
        workspaceRoot,
        globalDir,
        defaultOwner: userInfo().username,
        memory: true,
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
      });
      expect((await hostKernel.plans.read(seededPlan.id)).retention).toBe("discard");
      expect((await hostKernel.sessions.get(sessionId))?.pending).toEqual([
        { role: "user", content: "Persisted Container context" },
      ]);
      expect((await hostKernel.memory.health()).totals.documents).toBe(2);
      await hostKernel.close();
      hostKernel = undefined;
      stage = "second-connect";
      second = await connectLocalContainerKernel(options);
      stage = "second-identity";
      expect(second.client.capabilities.runtime).toMatchObject({
        state_namespace: namespace,
        artifact_digest: artifact.selection.digest,
      });
    } catch (error) {
      failure = new Error(`Container qualification failed during ${stage}`, { cause: error });
    } finally {
      for (const connection of [second, first]) {
        try {
          await connection?.close();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        await hostKernel?.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      for (const volume of volumes) {
        try {
          await removeVolume(volume);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      const cachedPayload = join(
        globalDir,
        "cache",
        "runtime-artifacts",
        artifact.selection.digest.slice("sha256:".length),
        "payload",
      );
      try {
        await Promise.all(
          [cachedPayload, join(cachedPayload, "bin"), join(cachedPayload, "licenses")].map((path) =>
            chmod(path, 0o700).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            }),
          ),
        );
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const failures = failure === undefined ? cleanupFailures : [failure, ...cleanupFailures];
    if (failures.length > 0)
      throw new AggregateError(failures, "Container qualification or cleanup failed");
    await writeFile(
      evidencePath!,
      `${JSON.stringify({
        scenarios: [
          "compiled-kernel-boot",
          "workspace-bind-and-control-mask",
          "concurrent-writer-refusal",
          "container-to-host-plan-memory-session-context-continuity",
          "same-namespace-reconnect",
          "autoload-sentinel-refusal",
        ],
      })}\n`,
      { flag: "wx" },
    );
  },
  600_000,
);
