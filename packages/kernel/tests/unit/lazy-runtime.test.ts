import { describe, expect, it } from "bun:test";
import type { ExecuteRunOutcome } from "@clarvis/loop";
import { createLazyRuntimeCoordinator, type RuntimeHost } from "../../src/runtime/lazy-runtime.ts";
import { runtimeSettingsSchema, type RuntimeSettingsBlock } from "../../src/runtime/settings.ts";
import { RuntimeLaunchError, type RuntimeInfo } from "../../src/runtime/types.ts";
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
  factory?: () => Promise<RuntimeHost>;
  native?: RunExecutor;
  notices?: Array<{ status: { lifecycle: string }; message?: string }>;
  assertFallbackSandbox?: () => Promise<void>;
}) {
  let settings = options.settings ?? docker();
  let extensionRevision = "extension-1";
  return {
    setSettings(next: RuntimeSettingsBlock) {
      settings = next;
    },
    setExtensionRevision(next: string) {
      extensionRevision = next;
    },
    value: createLazyRuntimeCoordinator({
      selection: () => ({
        settings,
        configurationRevision: JSON.stringify(settings),
        extensionRevision,
      }),
      nativeIsolation: () => "sandbox",
      nativeExecuteRun: options.native ?? (async () => outcome),
      ...(options.factory === undefined ? {} : { runtimeFactory: { create: options.factory } }),
      ownerId: "owner",
      project,
      workspace,
      workspaceRoot: "/workspace",
      deps: {} as never,
      ...(options.assertFallbackSandbox === undefined
        ? {}
        : { assertFallbackSandbox: options.assertFallbackSandbox }),
      onPlacement: (notice) => options.notices?.push(notice),
    }),
  };
}

describe("lazy runtime coordinator", () => {
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

  it("starts a new generation when the extension revision changes", async () => {
    let creates = 0;
    let closes = 0;
    const c = coordinator({
      factory: async () => {
        creates += 1;
        return {
          closed: false,
          info: info(`generation-${String(creates)}`),
          executeRun: async () => outcome,
          close: async () => {
            closes += 1;
          },
        };
      },
    });
    await c.value.executeRun(args);
    c.setExtensionRevision("extension-2");
    await c.value.executeRun(args);
    expect({ creates, closes }).toEqual({ creates: 2, closes: 1 });
    expect(c.value.current()).toMatchObject({ generation: "generation-2" });
    await c.value.close();
    expect(closes).toBe(2);
  });

  it("latches an operational Docker failure to required Sandbox and announces it once", async () => {
    let creates = 0;
    let nativeRuns = 0;
    let sandboxChecks = 0;
    const notices: Array<{ status: { lifecycle: string }; message?: string }> = [];
    const c = coordinator({
      notices,
      factory: async () => {
        creates += 1;
        throw new RuntimeLaunchError("engine_stopped", "Docker Desktop is stopped");
      },
      native: async () => {
        nativeRuns += 1;
        return outcome;
      },
      assertFallbackSandbox: async () => {
        sandboxChecks += 1;
      },
    });
    await c.value.executeRun(args);
    await c.value.executeRun(args);
    expect({ creates, nativeRuns, sandboxChecks }).toEqual({
      creates: 1,
      nativeRuns: 2,
      sandboxChecks: 2,
    });
    expect(notices.filter((notice) => notice.message !== undefined)).toHaveLength(1);
    expect(c.value.current()).toMatchObject({
      kind: "native",
      isolation: "sandbox",
      lifecycle: "fallback",
      fallback_from: "docker",
    });
  });

  it("fails closed on image or handshake integrity errors", async () => {
    let nativeRuns = 0;
    for (const code of ["invalid_launch_spec", "handshake_mismatch"] as const) {
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

  it("does not fall back when the required native sandbox is unavailable", async () => {
    let nativeRuns = 0;
    const c = coordinator({
      factory: async () => {
        throw new RuntimeLaunchError("engine_missing", "Docker is missing");
      },
      native: async () => {
        nativeRuns += 1;
        return outcome;
      },
      assertFallbackSandbox: async () => {
        throw new Error("Seatbelt is unavailable");
      },
    });
    await expect(c.value.executeRun(args)).rejects.toThrow("Seatbelt is unavailable");
    expect(nativeRuns).toBe(0);
  });

  it("retries Docker explicitly after a latched fallback", async () => {
    let creates = 0;
    let nativeRuns = 0;
    const c = coordinator({
      factory: async () => {
        creates += 1;
        if (creates === 1) throw new RuntimeLaunchError("engine_stopped", "stopped");
        return {
          closed: false,
          info: info("generation-2"),
          executeRun: async () => outcome,
          close: async () => {},
        };
      },
      native: async () => {
        nativeRuns += 1;
        return outcome;
      },
      assertFallbackSandbox: async () => {},
    });
    await c.value.executeRun(args);
    c.value.retry();
    expect(c.value.current()).toMatchObject({ kind: "container", lifecycle: "cold" });
    await c.value.executeRun(args);
    expect({ creates, nativeRuns }).toEqual({ creates: 2, nativeRuns: 1 });
    expect(c.value.current()).toMatchObject({ kind: "container", lifecycle: "ready" });
    await c.value.close();
  });
});
