import { describe, expect, test } from "bun:test";
import type { CapabilityExecutableSessionInput } from "@clarvis/capability";

import { PlanProviderUnavailableError, createPlanFactory } from "../../src/index.ts";
import { executableFactory, executablePort, markdownStore } from "../helpers/provider.ts";

describe("PlanFactory", () => {
  test("defaults to Markdown and memoizes one store per owner", async () => {
    let constructions = 0;
    const factory = createPlanFactory({
      workspaceRoot: "/workspace",
      loadProvider: () => undefined,
      markdownStoreFor: () => {
        constructions += 1;
        return markdownStore();
      },
    });
    const first = await factory.storeFor("alice");
    expect((await factory.storeFor("alice")).store).toBe(first.store);
    expect((await factory.storeFor("bob")).store).not.toBe(first.store);
    expect(constructions).toBe(2);
  });

  test("evicts one inactive owner's provider resolutions without touching peers", async () => {
    let constructions = 0;
    const factory = createPlanFactory({
      workspaceRoot: "/workspace",
      loadProvider: () => undefined,
      markdownStoreFor: () => {
        constructions += 1;
        return markdownStore();
      },
    });
    const alice = await factory.storeFor("alice");
    const bob = await factory.storeFor("bob");

    factory.evictOwner?.("alice");

    expect((await factory.storeFor("alice")).store).not.toBe(alice.store);
    expect((await factory.storeFor("bob")).store).toBe(bob.store);
    expect(constructions).toBe(3);
  });

  test("direct executables run from the workspace with raw argv", async () => {
    const seen: CapabilityExecutableSessionInput[] = [];
    const resolved = await executableFactory(executablePort(seen)).storeFor("alice");
    expect(resolved.providerKind).toBe("fixture-executable");
    expect(seen[0]).toMatchObject({
      capability: "plans",
      workspace: "/workspace",
      cwd: "/workspace",
      owner: "alice",
      declaration: { command: "python3", args: ["-B", "server.py", "plans"] },
    });
  });

  test("plugin selection uses the installed directory and cannot select itself", async () => {
    const seen: CapabilityExecutableSessionInput[] = [];
    const factory = createPlanFactory({
      workspaceRoot: "/workspace",
      loadProvider: () => ({ kind: "plugin", plugin: "speckit" }),
      markdownStoreFor: markdownStore,
      executablePort: executablePort(seen),
      pluginPort: {
        locate: () => ({
          root: "/plugins/speckit",
          declaration: {
            command: "python3",
            args: ["server.py", "plans"],
            env: {},
            timeout_ms: 30_000,
          },
        }),
      },
    });
    await factory.storeFor("alice");
    expect(seen[0]?.cwd).toBe("/plugins/speckit");
  });

  test("a plugin update rebuilds the session adapter while preserving provider identity", async () => {
    const seen: CapabilityExecutableSessionInput[] = [];
    let revision = "v1";
    const factory = createPlanFactory({
      workspaceRoot: "/workspace",
      loadProvider: () => ({ kind: "plugin", plugin: "speckit" }),
      markdownStoreFor: markdownStore,
      executablePort: executablePort(seen),
      pluginPort: {
        locate: () => ({
          root: "/plugins/speckit",
          declaration: {
            command: "python3",
            args: ["server.py", "plans", revision],
            env: {},
            timeout_ms: 30_000,
          },
        }),
      },
    });
    const first = await factory.storeFor("alice");
    revision = "v2";
    const updated = await factory.storeFor("alice");
    expect(updated.store).not.toBe(first.store);
    expect(updated.key).toBe(first.key);
    expect(seen.map((input) => input.declaration.args.at(-1))).toEqual(["v1", "v2"]);
  });

  test("reports unavailable executables without falling back to Markdown", async () => {
    const factory = createPlanFactory({
      workspaceRoot: "/workspace",
      loadProvider: () => ({
        kind: "executable",
        command: "missing",
        args: [],
        env: {},
        timeout_ms: 30_000,
      }),
      markdownStoreFor: markdownStore,
    });
    await expect(factory.storeFor("alice")).rejects.toBeInstanceOf(PlanProviderUnavailableError);
  });
});
