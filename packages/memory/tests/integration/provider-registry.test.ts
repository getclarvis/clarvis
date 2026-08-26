import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CapabilityExecutablePort,
  CapabilityExecutableSessionInput,
} from "@clarvis/capability";

import { resolveMemoryProvider } from "../../src/provider-registry.ts";
import { MEMORY_READ_TOOL_NAMES, MEMORY_WRITE_TOOL_NAMES } from "../../src/provider.ts";
import { WIKI_PROVIDER_KIND } from "../../src/wiki-provider.ts";
import { FILE_PROVIDER_KIND } from "../../src/file-provider.ts";
import type { MemoryToolDef } from "../../src/types.ts";
import type { Memory } from "../../src/memory-contract.ts";
import type { MemoryProviderConfig } from "../../src/schemas.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";

const tempWorkspaces: string[] = [];

afterEach(() => {
  for (const workspace of tempWorkspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function memTool(name: string): MemoryToolDef {
  const canonical = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
  return {
    name,
    description: canonical.description,
    parameters: memoryToolParameters(name as MemoryToolName),
    execute: vi.fn().mockResolvedValue({ text: "ok", isError: false }),
  };
}

const wiki = (): Memory =>
  ({
    tools: [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].map(memTool),
    seed: vi.fn().mockResolvedValue(null),
  }) as unknown as Memory;

const ctxOf = (over: Partial<Parameters<typeof resolveMemoryProvider>[1]> = {}) => ({
  workspaceRoot: "/workspace",
  seedMaxChars: 4_000,
  owner: "owner",
  ...over,
});

function executablePort(
  seen: CapabilityExecutableSessionInput[],
  writable = true,
): CapabilityExecutablePort {
  return {
    async session(input) {
      seen.push(input);
      return {
        providerKind: "fixture-memory",
        writable,
        async request(method, params) {
          if (method === "memory/seed") return `seed for ${String(params.task)}`;
          return { text: `${method}:${String(params.owner)}`, isError: false };
        },
        async close() {},
      };
    },
  };
}

describe("resolveMemoryProvider", () => {
  it("defaults to the built-in wiki", async () => {
    const result = await resolveMemoryProvider(undefined, ctxOf({ wiki: wiki() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provider.kind).toBe(WIKI_PROVIDER_KIND);
  });

  it("reports rather than substitutes when the selected wiki is unavailable", async () => {
    const result = await resolveMemoryProvider({ kind: "wiki" }, ctxOf());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("no wiki is available");
  });

  it("builds the read-only file provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "clarvis-memory-provider-"));
    tempWorkspaces.push(workspace);
    writeFileSync(join(workspace, "DOCTRINE.md"), "# rules\n");
    const result = await resolveMemoryProvider(
      { kind: "file", paths: ["DOCTRINE.md"] },
      ctxOf({ workspaceRoot: workspace }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider.kind).toBe(FILE_PROVIDER_KIND);
      expect(result.provider.writeTools).toBeUndefined();
      await expect(result.provider.seed()).resolves.toContain("# rules");
    }
  });

  it("adapts a persistent executable and honours writable", async () => {
    const seen: CapabilityExecutableSessionInput[] = [];
    const result = await resolveMemoryProvider(
      {
        kind: "executable",
        command: "python3",
        args: ["server.py", "memory"],
        env: {},
        timeout_ms: 30_000,
      },
      ctxOf({ executablePort: executablePort(seen, false) }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider.kind).toBe("fixture-memory");
      expect(result.provider.writeTools).toBeUndefined();
      await expect(result.provider.seed("task")).resolves.toContain("seed for task");
      await expect(
        result.provider.readTools[0]!.execute({}, new AbortController().signal),
      ).resolves.toEqual({
        text: "memory/list_memories:owner",
        isError: false,
      });
    }
    expect(seen[0]).toMatchObject({ capability: "memory", cwd: "/workspace", owner: "owner" });
  });

  it("starts a selected plugin executable from the plugin directory", async () => {
    const seen: CapabilityExecutableSessionInput[] = [];
    const result = await resolveMemoryProvider(
      { kind: "plugin", plugin: "speckit" },
      ctxOf({
        executablePort: executablePort(seen),
        pluginPort: {
          locate: () => ({
            root: "/plugins/speckit",
            declaration: {
              command: "python3",
              args: ["server.py", "memory"],
              env: {},
              timeout_ms: 30_000,
            },
          }),
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(seen[0]?.cwd).toBe("/plugins/speckit");
  });

  it("carries plugin lookup failures verbatim", async () => {
    const result = await resolveMemoryProvider(
      { kind: "plugin", plugin: "missing" },
      ctxOf({
        executablePort: executablePort([]),
        pluginPort: { locate: () => ({ error: "plugin 'missing' is not enabled" }) },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("not enabled");
  });

  it("reports each provider when its required host port is absent", async () => {
    for (const [config, reason] of [
      [
        { kind: "executable", command: "memory", args: [], env: {}, timeout_ms: 1000 },
        "cannot start executables",
      ],
      [
        {
          kind: "mcp",
          server: "memory",
          tools: Object.fromEntries(
            [...MEMORY_READ_TOOL_NAMES, ...MEMORY_WRITE_TOOL_NAMES].map((name) => [name, name]),
          ),
        },
        "cannot reach tool servers",
      ],
      [{ kind: "plugin", plugin: "speckit" }, "has no plugins"],
    ] as const) {
      const result = await resolveMemoryProvider(config as MemoryProviderConfig, ctxOf());
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.failure.reason).toContain(reason);
    }
  });

  it("reports a plugin when executables are unavailable after lookup", async () => {
    const result = await resolveMemoryProvider(
      { kind: "plugin", plugin: "speckit" },
      ctxOf({
        pluginPort: {
          locate: () => ({
            root: "/plugins/speckit",
            declaration: { command: "memory", args: [], env: {}, timeout_ms: 1000 },
          }),
        },
      }),
    );
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.failure.reason).toContain("cannot start executables");
  });

  it("turns provider construction throws into an unavailable resolution", async () => {
    const result = await resolveMemoryProvider(
      { kind: "executable", command: "memory", args: [], env: {}, timeout_ms: 1000 },
      ctxOf({
        executablePort: {
          session: async () => {
            throw "session exploded";
          },
        },
      }),
    );
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.failure.reason).toBe("session exploded");
  });

  it("reports unknown kinds without falling through", async () => {
    const result = await resolveMemoryProvider(
      { kind: "acme-kb" } as unknown as MemoryProviderConfig,
      ctxOf({ wiki: wiki() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toContain("unsupported memory provider");
  });
});
