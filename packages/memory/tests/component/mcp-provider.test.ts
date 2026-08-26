import { describe, expect, it } from "bun:test";

import {
  createMcpMemoryProvider,
  MCP_PROVIDER_KIND,
  type McpToolMapping,
  type MemoryServerPort,
} from "../../src/mcp-provider.ts";
import { MEMORY_READ_TOOL_NAMES, MEMORY_WRITE_TOOL_NAMES } from "../../src/provider.ts";

const READ_ONLY: McpToolMapping = {
  list_memories: "kb_list",
  read_memory: "kb_get",
  grep_memories: "kb_grep",
  query_memories: "kb_search",
};

const FULL: McpToolMapping = {
  ...READ_ONLY,
  write_memory: "kb_put",
  edit_memory: "kb_patch",
  delete_memory: "kb_delete",
};

/** Records every call and answers with a fixed outcome. */
function recorder(
  answer: { text: string; isError: boolean } | Error = { text: "ok", isError: false },
) {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  const port: MemoryServerPort = {
    callTool(server, tool, args) {
      calls.push({ server, tool, args });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  };
  return { calls, port };
}

const providerOf = (
  tools: McpToolMapping,
  port: MemoryServerPort,
  over: { seedTool?: string; seedMaxChars?: number } = {},
) =>
  createMcpMemoryProvider({
    server: "acme-kb",
    tools,
    port,
    ...(over.seedTool !== undefined ? { seedTool: over.seedTool } : {}),
  });

describe("createMcpMemoryProvider", () => {
  it("declares the read half under Clarvis names, whatever the server calls them", () => {
    const { port } = recorder();
    const provider = providerOf(READ_ONLY, port);
    expect(provider.kind).toBe(MCP_PROVIDER_KIND);
    expect(provider.readTools.map((t) => t.name).sort()).toEqual(
      [...MEMORY_READ_TOOL_NAMES].sort(),
    );
    expect(provider.writeTools).toBeUndefined();
  });

  it("adds the write half only when all three are mapped", () => {
    const { port } = recorder();
    const provider = providerOf(FULL, port);
    expect(provider.writeTools!.map((t) => t.name).sort()).toEqual(
      [...MEMORY_WRITE_TOOL_NAMES].sort(),
    );
  });

  it("refuses a partial write half rather than silently narrowing it", () => {
    const { port } = recorder();
    expect(() => providerOf({ ...READ_ONLY, write_memory: "kb_put" }, port)).toThrow(
      /partial write half/,
    );
  });

  it("forwards a call to the mapped server tool, on the declared server", async () => {
    const { calls, port } = recorder({ text: "the body", isError: false });
    const provider = providerOf(READ_ONLY, port);
    const read = provider.readTools.find((t) => t.name === "read_memory")!;
    await expect(read.execute({ path: "a/MEMORY.md" })).resolves.toEqual({
      text: "the body",
      isError: false,
    });
    expect(calls).toEqual([{ server: "acme-kb", tool: "kb_get", args: { path: "a/MEMORY.md" } }]);
  });

  it("maps each write operation to its own server tool", async () => {
    const { calls, port } = recorder();
    const provider = providerOf(FULL, port);
    for (const t of provider.writeTools!) await t.execute({ path: "p" });
    expect(calls.map((c) => c.tool)).toEqual(["kb_put", "kb_patch", "kb_delete"]);
  });

  it("passes a server error through as a failed call", async () => {
    const { port } = recorder({ text: "no such document", isError: true });
    const res = await providerOf(READ_ONLY, port).readTools[0]!.execute({});
    expect(res).toEqual({ text: "no such document", isError: true });
  });

  it("turns a transport throw into a failed call, never into a failed run", async () => {
    const { port } = recorder(new Error("connection reset"));
    const res = await providerOf(READ_ONLY, port).readTools[0]!.execute({});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("connection reset");
  });

  it("forwards the abort signal to the host", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const port: MemoryServerPort = {
      callTool(_server, _tool, _args, signal) {
        seen.push(signal);
        return Promise.resolve({ text: "", isError: false });
      },
    };
    const controller = new AbortController();
    await providerOf(READ_ONLY, port).readTools[0]!.execute({}, controller.signal);
    expect(seen[0]).toBe(controller.signal);
  });

  describe("seed", () => {
    it("is null when no seed tool was declared — a working configuration", async () => {
      const { calls, port } = recorder();
      await expect(providerOf(READ_ONLY, port).seed("task")).resolves.toBeNull();
      expect(calls).toEqual([]);
    });

    it("calls the declared seed tool with the task and returns its raw answer", async () => {
      const { calls, port } = recorder({ text: "standing rules", isError: false });
      const block = await providerOf(READ_ONLY, port, { seedTool: "kb_profile" }).seed("add SSO");
      expect(block).toBe("standing rules");
      expect(calls[0]).toEqual({
        server: "acme-kb",
        tool: "kb_profile",
        args: { task: "add SSO" },
      });
    });

    it("is null when the seed tool reports an error", async () => {
      const { port } = recorder({ text: "unavailable", isError: true });
      await expect(
        providerOf(READ_ONLY, port, { seedTool: "kb_profile" }).seed(),
      ).resolves.toBeNull();
    });

    it("is null when the seed call throws", async () => {
      const { port } = recorder(new Error("down"));
      await expect(
        providerOf(READ_ONLY, port, { seedTool: "kb_profile" }).seed(),
      ).resolves.toBeNull();
    });

    it("is null on an empty answer, so no empty block is injected", async () => {
      const { port } = recorder({ text: "   ", isError: false });
      await expect(
        providerOf(READ_ONLY, port, { seedTool: "kb_profile" }).seed(),
      ).resolves.toBeNull();
    });

    it("leaves clipping and tags to the capability", async () => {
      const { port } = recorder({ text: "y".repeat(400), isError: false });
      const block = await providerOf(READ_ONLY, port, {
        seedTool: "kb_profile",
        seedMaxChars: 50,
      }).seed();
      expect(block).toBe("y".repeat(400));
    });
  });
});
