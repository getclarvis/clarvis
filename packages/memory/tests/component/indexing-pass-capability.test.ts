/**
 * The capability a pass runs with when it continues the run it is indexing.
 *
 * @remarks Everything asserted here is a property the provider's prefix cache
 * depends on, and none of it is visible to a type-checker. The pass inherits the
 * indexed run's tools, system head and seed blocks untouched; what it adds must
 * therefore be *invisible on the wire* — handlers and a finalize gate — and what
 * it takes away must be nothing at all.
 */
import { describe, expect, it } from "bun:test";

import type { AgentLoopContribution, LLMToolCall, ToolHandler } from "@clarvis/capability";
import { createIndexingPassCapability } from "../../src/indexer/capability.ts";
import { DEFAULT_BUDGETS } from "../../src/config.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { createTouchedLedger } from "../../src/indexer/pyramid.ts";
import { fakeAgentBuildContext, fakeRunCapabilityContext } from "../helpers/capability.ts";
import type { MemoryMutationFence, MemoryStore, MemoryToolDef } from "../../src/types.ts";
import type { MemoryProvider } from "../../src/provider.ts";
import {
  MEMORY_TOOL_CONTRACTS,
  memoryToolParameters,
  type MemoryToolName,
} from "../../src/tool-contract.ts";

function call(name: string, args: unknown = {}, id = "c1"): LLMToolCall {
  return { id, name, arguments: args };
}

const SCOPE = { agent: "lead", entry: true, grants: [] } as const;

/** Build the pass capability and attach it, returning every layer's surface. */
async function attach(
  over: {
    store?: MemoryStore;
    ledger?: ReturnType<typeof createTouchedLedger>;
    provider?: MemoryProvider;
    mutationFence?: MemoryMutationFence;
  } = {},
) {
  const store = over.store ?? createInMemoryMemoryStore();
  const ledger = over.ledger ?? createTouchedLedger();
  const capability = createIndexingPassCapability({
    store,
    runId: "run_subject",
    budgets: DEFAULT_BUDGETS,
    ledger,
    ...(over.provider !== undefined ? { provider: over.provider } : {}),
    ...(over.mutationFence !== undefined ? { mutationFence: over.mutationFence } : {}),
  });
  const run = (await capability.forRun(fakeRunCapabilityContext()))!;
  const contribution = (await run.forAgent!(SCOPE))!.attach(
    fakeAgentBuildContext(),
  ) as AgentLoopContribution;
  return { capability, run, contribution, store, ledger };
}

/** The handler that would take `name`, or undefined when none does. */
function handlerFor(contribution: AgentLoopContribution, name: string): ToolHandler | undefined {
  return (contribution.handlers ?? []).find((h) => h.matches(call(name)));
}

describe("the indexing-pass capability contributes nothing to the wire", () => {
  it("advertises no tools, so the continued run's tool array is untouched", async () => {
    const { contribution } = await attach();
    expect(contribution.tools ?? []).toEqual([]);
  });

  it("declares no seed marker, no seed block and no system section", async () => {
    const { capability, run } = await attach();
    expect(capability.seedMarker).toBeUndefined();
    expect(Object.hasOwn(run, "seedBlock")).toBe(false);
    expect(Object.hasOwn(run, "systemSection")).toBe(false);
  });

  it("has no onRunEnd, so a pass cannot enqueue itself", async () => {
    const { run } = await attach();
    expect(Object.hasOwn(run, "onRunEnd")).toBe(false);
  });

  it("contributes the pyramid finalize gate", async () => {
    const { contribution } = await attach();
    expect(contribution.gates ?? []).toHaveLength(1);
  });
});

describe("the indexing-pass capability permits only its own tools", () => {
  it("refuses a tool inherited from the indexed run", async () => {
    const { contribution } = await attach();
    const handler = handlerFor(contribution, "shell");
    expect(handler).toBeDefined();
    const verdict = await handler!.handle(call("shell", { command: "rm -rf /" }), 1);
    expect(verdict).toMatchObject({ kind: "result", progress: false });
    expect((verdict as { text: string }).text).toContain("not available in this pass");
  });

  it("refuses delegate_task, which a continued coder profile may still carry", async () => {
    const { contribution } = await attach();
    const verdict = await handlerFor(contribution, "delegate_task")!.handle(
      call("delegate_task"),
      1,
    );
    expect(verdict).toMatchObject({ kind: "result", progress: false });
  });

  it("leaves submit_result to the engine, or the pass could never finish", async () => {
    const { contribution } = await attach();
    expect(handlerFor(contribution, "submit_result")).toBeUndefined();
  });

  it("still dispatches the wiki tools, recording the mutation on the ledger", async () => {
    const { contribution, ledger } = await attach();
    const handler = handlerFor(contribution, "write_memory");
    expect(handler).toBeDefined();
    const verdict = await handler!.handle(
      call("write_memory", {
        path: "infra/bun/MEMORY.md",
        content: "---\ndescription: how bun is run here\n---\n\nUse bun test.",
      }),
      1,
    );
    expect(verdict).toMatchObject({ kind: "result", progress: true });
    expect(ledger.all().map((m) => m.tool)).toContain("write_memory");
  });

  it("dispatches through a writable selected provider instead of the local wiki", async () => {
    const calls: string[] = [];
    const tool = (name: string): MemoryToolDef => {
      const canonical = MEMORY_TOOL_CONTRACTS[name as MemoryToolName];
      return {
        name,
        description: canonical.description,
        parameters: memoryToolParameters(name as MemoryToolName),
        execute: async () => {
          calls.push(`provider:${name}`);
          return { text: "external ok", isError: false };
        },
      };
    };
    const provider: MemoryProvider = {
      kind: "external",
      readTools: ["list_memories", "read_memory", "grep_memories", "query_memories"].map(tool),
      writeTools: ["write_memory", "edit_memory", "delete_memory"].map(tool),
      seed: async () => null,
    };
    const mutationFence: MemoryMutationFence = {
      before: async () => {
        calls.push("fence:before");
        return true;
      },
      after: async () => {
        calls.push("fence:after");
        return true;
      },
    };
    const { contribution, ledger, store } = await attach({ provider, mutationFence });
    const verdict = await handlerFor(contribution, "write_memory")!.handle(
      call("write_memory", { path: "external/MEMORY.md", content: "body" }),
      1,
    );
    expect(verdict).toMatchObject({ kind: "result", progress: true });
    expect(calls).toEqual(["fence:before", "provider:write_memory", "fence:after"]);
    expect(ledger.all()).toMatchObject([{ tool: "write_memory", path: "external/MEMORY.md" }]);
    expect(await store.read("external/MEMORY.md")).toBeNull();
  });

  it("refuses a provider mutation when its fence is already lost", async () => {
    const provider: MemoryProvider = {
      kind: "external",
      readTools: [],
      writeTools: [
        {
          name: "write_memory",
          description: MEMORY_TOOL_CONTRACTS.write_memory.description,
          parameters: memoryToolParameters("write_memory"),
          execute: async () => ({ text: "should not run", isError: false }),
        },
      ],
      seed: async () => null,
    };
    const { contribution, ledger } = await attach({
      provider,
      mutationFence: { before: async () => false, after: async () => true },
    });

    const verdict = await handlerFor(contribution, "write_memory")!.handle(
      call("write_memory", { path: "external/MEMORY.md", content: "body" }),
      1,
    );

    expect((verdict as { text: string }).text).toContain("claim");
    expect(ledger.all()).toEqual([]);
  });
});
