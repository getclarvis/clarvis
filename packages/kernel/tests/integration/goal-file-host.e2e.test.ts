import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HOME_ENV } from "@clarvis/paths";
import { createNodeDockerControl, createNodePodmanControl } from "../../src/local.ts";
import { createLocalDockerRuntime } from "../../src/runtime/local-docker-runtime.ts";
import { createLocalPodmanRuntime } from "../../src/runtime/local-podman-runtime.ts";
import type { ContainerControl } from "../../src/runtime/types.ts";
import { createGoalFileHostFixture } from "../helpers/goal-file-host.ts";
import { runGoalFileHostJourney } from "../helpers/goal-file-host-journey.ts";

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
  "runs a persistent goal with automatic continuations, a delegated plan and actual container accounting",
  async () => {
    const executable = Bun.which(engine);
    if (executable === null || imageDigest === undefined || context === undefined)
      throw new Error("Goal container canary inputs disappeared");
    const root = await mkdtemp(join(tmpdir(), "clarvis-goal-container-"));
    const environment = Object.fromEntries(
      ["HOME", "PATH", "XDG_RUNTIME_DIR"].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]!]],
      ),
    );
    const nodeControl =
      engine === "podman"
        ? createNodePodmanControl({ executable, connection: context, environment })
        : createNodeDockerControl({ executable, context, environment });
    const containers = new Set<string>();
    const volumes = new Set<string>();
    let stderr = "";
    const control: ContainerControl = {
      async run(args, signal, options) {
        const result = await nodeControl.run(args, signal, options);
        if (result.exitCode === 0 && args[0] === "create") containers.add(result.stdout.trim());
        if (result.exitCode === 0 && args[0] === "volume" && args[1] === "create")
          volumes.add(args.at(-1)!);
        return result;
      },
      attach(args) {
        const attached = nodeControl.attach(args);
        attached.stderr.on("data", (chunk: string | Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-16384);
        });
        return attached;
      },
    };
    const report: Record<string, unknown> = {
      schema_version: 1,
      engine,
      image_digest: imageDigest,
      start: Date.now(),
      platform: process.platform,
      architecture: process.arch,
      bun: Bun.version,
      provider: "actual SDK with controlled HTTP; no live provider",
      limits: { calls: 24, duration_ms: 180000 },
    };
    const evidenceRoot = resolve(import.meta.dir, "../../../../build/goal-file-host-e2e");
    await mkdir(evidenceRoot, { recursive: true });
    let f: Awaited<ReturnType<typeof createGoalFileHostFixture>> | undefined;
    const failures: unknown[] = [];
    try {
      f = await createGoalFileHostFixture({
        timeoutMs: 180000,
        runtime: {
          backend: engine,
          executable,
          connection: context,
          ...(engine === "docker" ? { fallback: "fail" as const } : {}),
          image_digest: imageDigest,
          network: "none",
          limits: {
            cpu_count: 1,
            memory_bytes: 1024 * 1024 * 1024,
            process_count: 128,
            output_bytes: 4 * 1024 * 1024,
            storage_bytes: 512 * 1024 * 1024,
          },
        },
        runtimeFactory: {
          async create(input) {
            const options = {
              control,
              roots: { env: { [HOME_ENV]: join(root, "isolated-home") } },
            };
            return engine === "podman"
              ? createLocalPodmanRuntime(input, options)
              : createLocalDockerRuntime(input, options);
          },
        },
      });
      const journey = await runGoalFileHostJourney(f, { guestProbe: true });
      const first = await f.client.runs.get(journey.goal.runs[0]!.execution_id);
      const shell = first.events.find(
        (event) =>
          event.type === "tool_call" &&
          event.agent === "subagent" &&
          (event.tool === "shell" || event.server === "shell"),
      );
      if (shell?.type !== "tool_call" || shell.result === undefined)
        throw new Error("Missing actual guest probe result");
      const output = JSON.parse(shell.result) as { exit_code: number; stdout: string };
      expect(output.exit_code).toBe(0);
      expect(output.stdout).toMatch(/Linux\n\/workspace\n/u);
      const loadedHash = /([a-f0-9]{64})\s+\/usr\/local\/bin\/clarvis-runtime/u.exec(
        output.stdout,
      )?.[1];
      expect(loadedHash).toBeDefined();
      expect(containers.size).toBeGreaterThan(0);
      report.loaded_guest_binary_sha256 = loadedHash;
      report.journey = journey;
      report.verdict = "passed";
    } catch (error) {
      report.verdict = "failed";
      report.error = String(error);
      report.stderr = stderr;
      failures.push(error);
    } finally {
      try {
        await f?.close();
        for (const id of containers)
          expect(
            (await nodeControl.run(["container", engine === "podman" ? "exists" : "inspect", id]))
              .exitCode,
          ).toBe(1);
        for (const volume of volumes)
          expect((await nodeControl.run(["volume", "rm", volume])).exitCode).toBe(0);
        report.cleanup = { verified: true, containers: [...containers], volumes: [...volumes] };
      } catch (error) {
        report.cleanup = { verified: false, error: String(error) };
        failures.push(error);
      } finally {
        report.end = Date.now();
        report.calls = f?.requests.length;
        report.fixture_sha256 = createHash("sha256")
          .update(await readFile(import.meta.path))
          .digest("hex");
        await Bun.write(
          join(evidenceRoot, `${engine}-${String(report.start)}.json`),
          JSON.stringify(report, null, 2),
        );
        await rm(root, { recursive: true, force: true });
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Goal container qualification failed");
  },
  240000,
);
