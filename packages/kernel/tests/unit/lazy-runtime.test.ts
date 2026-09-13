import { describe, expect, it } from "bun:test";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import {
  createLazyRuntimeCoordinator,
  type RuntimeHost,
  type RuntimeHostInput,
} from "../../src/runtime/lazy-runtime.ts";
import { runtimeSettingsSchema, type RuntimeSettingsBlock } from "../../src/runtime/settings.ts";
import {
  RuntimeLaunchError,
  type RuntimeInfo,
  type RuntimeProtectedMount,
} from "../../src/runtime/types.ts";
import type { RunExecutor } from "../../src/runs/run-service.ts";

const project = { id: "project" };
const workspace = {
  id: "workspace",
  projectId: project.id,
  label: "workspace",
  kind: "primary" as const,
  path: "/workspace",
};
const args = { rawBody: {}, owner: "owner", deps: {} as never };
const outcome = { executionId: "run", response: {} } as ExecuteRunOutcome;

function docker(): RuntimeSettingsBlock {
  return runtimeSettingsSchema.parse({ backend: "docker" });
}

function info(generation: string): RuntimeInfo {
  return {
    kind: "container",
    generation,
    engine: "docker",
    engineVersion: "29",
    hostPlatform: process.platform,
    guestPlatform: "linux",
    imageDigest: `sha256:${"a".repeat(64)}`,
    runtimeProtocolRevision: "2",
    network: "outbound",
    limits: {
      cpuCount: 2,
      memoryBytes: 4_294_967_296,
      processCount: 256,
      outputBytes: 16_777_216,
      storageBytes: 4_294_967_296,
    },
    lifecycle: "ready",
  };
}

function coordinator(options: {
  settings?: RuntimeSettingsBlock;
  factory?: (input: RuntimeHostInput) => Promise<RuntimeHost>;
  native?: RunExecutor;
  notices?: Array<{ status: { lifecycle: string }; message?: string }>;
  gitMetadataMounts?: readonly RuntimeProtectedMount[];
}) {
  let settings = options.settings ?? docker();
  return {
    setSettings(next: RuntimeSettingsBlock) {
      settings = next;
    },
    value: createLazyRuntimeCoordinator({
      selection: () => ({
        settings,
        configurationRevision: JSON.stringify(settings),
      }),
      nativeIsolation: () => "sandbox",
      nativeExecuteRun: options.native ?? (async () => outcome),
      ...(options.factory === undefined ? {} : { runtimeFactory: { create: options.factory } }),
      ownerId: "owner",
      project,
      workspace,
      workspaceRoot: "/workspace",
      gitMetadataMounts: options.gitMetadataMounts ?? [],
      deps: {} as never,
      onPlacement: (notice) => options.notices?.push(notice),
    }),
  };
}

describe("lazy runtime coordinator", () => {
  it("fails closed when container support is absent", async () => {
    const absent = coordinator({});
    await expect(absent.value.executeRun(args)).rejects.toMatchObject({
      code: "operational_failure",
    });
    await absent.value.close();
  });

  it("closes a generation that becomes ready after coordinator shutdown", async () => {
    const entered = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<RuntimeHost>();
    let closes = 0;
    const c = coordinator({
      factory: async () => {
        entered.resolve();
        return ready.promise;
      },
    });
    const run = c.value.executeRun(args);
    await entered.promise;
    const closing = c.value.close();
    ready.resolve({
      closed: false,
      info: info("late"),
      executeRun: async () => outcome,
      close: async () => {
        closes += 1;
      },
    });
    await expect(run).rejects.toThrow("runtime coordinator is closed");
    await closing;
    expect(closes).toBe(1);
  });

  it("cancels one waiter while another retains the shared initializing generation", async () => {
    const entered = Promise.withResolvers<RuntimeHostInput>();
    const ready = Promise.withResolvers<RuntimeHost>();
    let creates = 0;
    let executions = 0;
    let native = 0;
    const c = coordinator({
      factory: async (input) => {
        creates++;
        entered.resolve(input);
        return ready.promise;
      },
      native: async () => {
        native++;
        return outcome;
      },
    });
    const cancelled = new AbortController();
    const first = c.value.executeRun({ ...args, externalSignal: cancelled.signal });
    const refusal = first.catch((error: unknown) => error);
    const input = await entered.promise;
    const second = c.value.executeRun(args);
    cancelled.abort(new Error("caller cancelled"));
    expect(await refusal).toMatchObject({ message: "caller cancelled" });
    expect(input.signal?.aborted).toBe(false);
    expect(executions).toBe(0);
    ready.resolve({
      closed: false,
      info: info(input.generation),
      executeRun: async () => {
        executions++;
        return outcome;
      },
      close: async () => {},
    });
    expect(await second).toBe(outcome);
    expect(creates).toBe(1);
    expect(executions).toBe(1);
    expect(native).toBe(0);
    await c.value.close();
  });

  it("aborts generation creation on shutdown and waits for its physical cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleaned = Promise.withResolvers<void>();
    let shutdownFinished = false;
    let native = 0;
    const c = coordinator({
      factory: async (input) => {
        const signal = input.signal!;
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        await cleaned.promise;
        throw signal.reason;
      },
      native: async () => {
        native++;
        return outcome;
      },
    });
    const run = c.value.executeRun(args);
    const refusal = run.catch((error: unknown) => error);
    await entered.promise;
    const closing = c.value.close().then(() => {
      shutdownFinished = true;
    });
    await aborted.promise;
    expect(await refusal).toMatchObject({ message: "runtime coordinator is closed" });
    expect(shutdownFinished).toBe(false);
    cleaned.resolve();
    await closing;
    expect(native).toBe(0);
    expect(c.value.current().lifecycle).not.toBe("ready");
  });

  it("surfaces failed shutdown and retries retained cleanup without reopening admission", async () => {
    let attempts = 0;
    const c = coordinator({
      factory: async () => ({
        closed: false,
        info: info("retry-cleanup"),
        executeRun: async () => outcome,
        async close() {
          attempts += 1;
          if (attempts === 1) throw new Error("engine remove temporarily failed");
        },
      }),
    });
    await c.value.executeRun(args);
    const first = await Promise.allSettled([c.value.close(), c.value.close()]);
    expect(first.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(attempts).toBe(1);
    await expect(c.value.executeRun(args)).rejects.toThrow("coordinator is closed");
    await c.value.close();
    await c.value.close();
    expect(attempts).toBe(2);
  });

  it("retains a failed retired generation while replacing the same selection", async () => {
    let creates = 0;
    let retiredCloses = 0;
    let replacementCloses = 0;
    let dead = false;
    const c = coordinator({
      factory: async () => {
        creates += 1;
        if (creates > 1)
          return {
            closed: false,
            info: info("replacement"),
            executeRun: async () => outcome,
            async close() {
              replacementCloses += 1;
            },
          };
        return {
          get closed() {
            return dead;
          },
          info: info("retired"),
          async executeRun() {
            dead = true;
            throw new Error("channel closed");
          },
          async close() {
            retiredCloses += 1;
            if (retiredCloses === 1) throw new Error("remove failed");
          },
        };
      },
    });
    await expect(c.value.executeRun(args)).rejects.toThrow("channel closed");
    await expect(c.value.executeRun(args)).resolves.toBe(outcome);
    expect(c.value.current()).toMatchObject({ generation: "replacement" });
    await c.value.close();
    expect({ retiredCloses, replacementCloses }).toEqual({
      retiredCloses: 2,
      replacementCloses: 1,
    });
  });

  it("forwards only the host-discovered Git metadata projection", async () => {
    const mounts: readonly RuntimeProtectedMount[] = [
      {
        source: "/workspace/.git",
        target: "/workspace/.git",
        type: "file",
        readOnly: true,
      },
      {
        source: "/repository/.git/worktrees/feature",
        target: "/repository/.git/worktrees/feature",
        type: "directory",
        readOnly: true,
      },
      {
        source: "/repository/.git",
        target: "/repository/.git",
        type: "directory",
        readOnly: true,
      },
    ];
    let received: readonly RuntimeProtectedMount[] = [];
    const c = coordinator({
      gitMetadataMounts: mounts,
      factory: async (input) => {
        received = input.gitMetadataMounts;
        return {
          closed: false,
          info: info("generation-worktree"),
          executeRun: async () => outcome,
          close: async () => undefined,
        };
      },
    });
    await c.value.executeRun(args);
    expect(received).toEqual(mounts);
    await c.value.close();
  });

  it("does no Docker work at boot, coalesces first launch and reuses the generation", async () => {
    let creates = 0;
    let runs = 0;
    let closes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = coordinator({
      factory: async () => {
        creates += 1;
        await gate;
        const host: RuntimeHost = {
          closed: false,
          info: info("generation-1"),
          executeRun: async () => {
            runs += 1;
            return outcome;
          },
          close: async () => {
            closes += 1;
          },
        };
        return host;
      },
    });
    expect(c.value.current()).toMatchObject({ kind: "container", lifecycle: "cold" });
    expect(creates).toBe(0);
    const first = c.value.executeRun(args);
    const second = c.value.executeRun(args);
    await Promise.resolve();
    expect(creates).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(runs).toBe(2);
    expect(c.value.current()).toMatchObject({ lifecycle: "ready", generation: "generation-1" });
    await c.value.close();
    expect(closes).toBe(1);
  });

  it("fails closed on every container acquisition error without native execution", async () => {
    let nativeRuns = 0;
    for (const code of [
      "engine_missing",
      "engine_stopped",
      "operational_failure",
      "invalid_launch_spec",
      "runtime_recipe_invalid",
      "runtime_recipe_failed",
      "handshake_mismatch",
    ] as const) {
      const c = coordinator({
        factory: async () => {
          throw new RuntimeLaunchError(code, "identity mismatch");
        },
        native: async () => {
          nativeRuns += 1;
          return outcome;
        },
      });
      await expect(c.value.executeRun(args)).rejects.toMatchObject({ code });
      await c.value.close();
    }
    expect(nativeRuns).toBe(0);
  });

  it("never replays a run natively after guest execution begins", async () => {
    let nativeRuns = 0;
    const c = coordinator({
      factory: async () => ({
        closed: false,
        info: info("generation-1"),
        executeRun: async () => {
          throw new Error("guest disconnected after an effect");
        },
        close: async () => {},
      }),
      native: async () => {
        nativeRuns += 1;
        return outcome;
      },
    });
    await expect(c.value.executeRun(args)).rejects.toThrow("guest disconnected after an effect");
    expect(nativeRuns).toBe(0);
    await c.value.close();
  });

  it("retires a closed generation and launches a fresh one for the next run", async () => {
    let creates = 0;
    let closes = 0;
    let nativeRuns = 0;
    const c = coordinator({
      factory: async () => {
        creates += 1;
        if (creates === 1) {
          let dead = false;
          return {
            get closed() {
              return dead;
            },
            info: info("generation-dead"),
            executeRun: async () => {
              dead = true;
              throw new Error("execution channel closed");
            },
            close: async () => {
              closes += 1;
            },
          };
        }
        return {
          closed: false,
          info: info("generation-recovered"),
          executeRun: async () => outcome,
          close: async () => {
            closes += 1;
          },
        };
      },
      native: async () => {
        nativeRuns += 1;
        return outcome;
      },
    });

    await expect(c.value.executeRun(args)).rejects.toThrow("execution channel closed");
    expect(c.value.current()).toMatchObject({ kind: "container", lifecycle: "cold" });
    await expect(c.value.executeRun(args)).resolves.toBe(outcome);
    expect({ creates, closes, nativeRuns }).toEqual({ creates: 2, closes: 1, nativeRuns: 0 });
    expect(c.value.current()).toMatchObject({
      kind: "container",
      generation: "generation-recovered",
      lifecycle: "ready",
    });
    await c.value.close();
    expect(closes).toBe(2);
  });

  it("does not let a retiring generation overwrite a ready replacement status", async () => {
    let creates = 0;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const c = coordinator({
      factory: async () => {
        creates += 1;
        if (creates === 1) {
          let dead = false;
          return {
            get closed() {
              return dead;
            },
            info: info("generation-retiring"),
            executeRun: async () => {
              dead = true;
              firstStarted();
              await firstGate;
              throw new Error("old channel closed");
            },
            close: async () => undefined,
          };
        }
        return {
          closed: false,
          info: info("generation-ready"),
          executeRun: async () => outcome,
          close: async () => undefined,
        };
      },
    });

    const first = c.value.executeRun(args);
    await started;
    await expect(c.value.executeRun(args)).resolves.toBe(outcome);
    expect(c.value.current()).toMatchObject({
      lifecycle: "ready",
      generation: "generation-ready",
    });
    releaseFirst();
    await expect(first).rejects.toThrow("old channel closed");
    expect(c.value.current()).toMatchObject({
      lifecycle: "ready",
      generation: "generation-ready",
    });
    await c.value.close();
  });
});
