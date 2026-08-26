import { describe, expect, it } from "bun:test";
import type { McpServerConfig } from "@clarvis/capability";

import {
  createMemoryServerPort,
  type MemoryServerPortDeps,
} from "../../src/memory/memory-server-port.ts";

const SERVER: McpServerConfig = {
  name: "acme",
  transport: "stdio",
  command: "kb",
  args: [],
} as McpServerConfig;

/** A pool whose single connection answers with whatever the test supplies. */
function pool(
  answer:
    { ok: boolean; data?: unknown; error?: { message: string } } | Error | { acquireThrows: Error },
) {
  const calls: { tool: string; args: unknown }[] = [];
  const owners: string[] = [];
  let released = 0;
  const connections: MemoryServerPortDeps["connections"] = {
    acquire: (opts) => {
      if ("acquireThrows" in answer) return Promise.reject(answer.acquireThrows);
      owners.push(opts.owner);
      return Promise.resolve({
        conn: {
          callTool: (tool, args) => {
            calls.push({ tool, args });
            if (answer instanceof Error) return Promise.reject(answer);
            return Promise.resolve(answer);
          },
        },
        release: () => {
          released += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return { connections, calls, owners, released: () => released };
}

const portOf = (
  p: ReturnType<typeof pool>,
  servers: Record<string, McpServerConfig> | undefined = { acme: SERVER },
) => createMemoryServerPort({ servers: () => servers, connections: p.connections }).forOwner("o");

describe("createMemoryServerPort", () => {
  it("calls the named tool and returns its text", async () => {
    const p = pool({ ok: true, data: "the body" });
    await expect(portOf(p).callTool("acme", "kb_get", { path: "a" })).resolves.toEqual({
      text: "the body",
      isError: false,
    });
    expect(p.calls).toEqual([{ tool: "kb_get", args: { path: "a" } }]);
    expect(p.owners).toEqual(["o"]);
  });

  it("binds each provider port to the owner used for its pool lease", async () => {
    const p = pool({ ok: true, data: "body" });
    const resolver = createMemoryServerPort({
      servers: () => ({ acme: SERVER }),
      connections: p.connections,
    });

    await resolver.forOwner("alice").callTool("acme", "kb_get", {});
    await resolver.forOwner("bob").callTool("acme", "kb_get", {});

    expect(p.owners).toEqual(["alice", "bob"]);
  });

  it("reports an unconfigured server rather than throwing", async () => {
    const p = pool({ ok: true });
    const res = await portOf(p, {}).callTool("nope", "t", {});
    expect(res).toEqual({ text: "no MCP server named 'nope' is configured", isError: true });
  });

  it("tolerates a workspace with no mcpServers block at all", async () => {
    const p = pool({ ok: true });
    const res = await portOf(p, undefined).callTool("acme", "t", {});
    expect(res.isError).toBe(true);
  });

  it("passes a tool error through as a failed call", async () => {
    const p = pool({ ok: false, error: { message: "no such document" } });
    await expect(portOf(p).callTool("acme", "kb_get", {})).resolves.toEqual({
      text: "no such document",
      isError: true,
    });
  });

  it("names the tool when the failure carries no message", async () => {
    const p = pool({ ok: false });
    const res = await portOf(p).callTool("acme", "kb_get", {});
    expect(res).toEqual({ text: "'kb_get' failed", isError: true });
  });

  it("turns a transport throw into a failed call", async () => {
    const p = pool(new Error("connection reset"));
    const res = await portOf(p).callTool("acme", "kb_get", {});
    expect(res).toEqual({ text: "connection reset", isError: true });
  });

  it("turns a failed acquire into a failed call, and releases nothing", async () => {
    const p = pool({ acquireThrows: new Error("pool exhausted") });
    const res = await portOf(p).callTool("acme", "kb_get", {});
    expect(res).toEqual({ text: "pool exhausted", isError: true });
    expect(p.released()).toBe(0);
  });

  it("releases the lease on success and on failure alike", async () => {
    const ok = pool({ ok: true, data: "x" });
    await portOf(ok).callTool("acme", "t", {});
    expect(ok.released()).toBe(1);

    const bad = pool(new Error("boom"));
    await portOf(bad).callTool("acme", "t", {});
    expect(bad.released()).toBe(1);
  });

  it("forwards the abort signal to both acquire and the call", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const connections: MemoryServerPortDeps["connections"] = {
      acquire: (opts) => {
        seen.push(opts.signal);
        return Promise.resolve({
          conn: {
            callTool: (_tool, _args, signal) => {
              seen.push(signal);
              return Promise.resolve({ ok: true, data: "" });
            },
          },
          release: () => Promise.resolve(),
        });
      },
    };
    const controller = new AbortController();
    await createMemoryServerPort({
      servers: () => ({ acme: SERVER }),
      connections,
    })
      .forOwner("o")
      .callTool("acme", "t", {}, controller.signal);
    expect(seen).toEqual([controller.signal, controller.signal]);
  });
});
