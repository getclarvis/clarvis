import { describe, it, expect, afterEach, beforeEach } from "../bun-test.ts";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { createJsonTraceStore } from "@clarvis/trace";
import { parseJournalChunks } from "@clarvis/trace";
import type { JournalingTraceStore } from "@clarvis/trace";

let harness: TestHarness | null = null;
let dir: string;
let store: JournalingTraceStore;

async function* one(value: string): AsyncGenerator<string> {
  yield value;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarvis-journal-e2e-"));
  store = createJsonTraceStore({ dir });
});
afterEach(async () => {
  await harness?.close();
  harness = null;
  rmSync(dir, { recursive: true, force: true });
});

function journalFiles(): string[] {
  const out: string[] = [];
  for (const owner of readdirSync(dir)) {
    const ownerDir = join(dir, owner);
    let names: string[];
    try {
      names = readdirSync(ownerDir);
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith(".jsonl")) out.push(join(ownerDir, n));
  }
  return out;
}

const BODY = {
  messages: [{ role: "user", content: "Read /etc/hostname" }],
  servers: [{ name: "filesystem", transport: "stdio", command: "node", args: ["-e", ""] }],
  profiles: [
    {
      name: "solo",
      model: "anthropic/claude-sonnet-4-5",
      tools: ["filesystem.read"],
      iteration_limit: 10,
    },
  ],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
};

function makeLlm(): MockLLM {
  return new MockLLM({
    script: [
      {
        toolCalls: [{ name: "filesystem.read", arguments: { path: "/etc/hostname" } }],
        usage: { input_tokens: 100, output_tokens: 20, cached_tokens: 5 },
      },
      { text: "The hostname is 'my-host'.", usage: { input_tokens: 50, output_tokens: 30 } },
    ],
  });
}

const mcp = (): ReturnType<typeof mockMCPFactory> =>
  mockMCPFactory({
    filesystem: {
      tools: [
        {
          name: "read",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          call: () => "my-host\n",
        },
      ],
    },
  });

describe("run journal — end to end", () => {
  it("leaves no journal behind after a completed run", async () => {
    harness = await makeHarness({ llm: makeLlm(), mcpFactory: mcp(), traceStore: store });
    const res = await harness.run(BODY);

    expect(res.status).toBe("completed");
    expect(journalFiles()).toHaveLength(0);
  });

  it("journals exactly the events the persisted record ends up with", async () => {
    const captured: string[] = [];
    harness = await makeHarness({
      llm: makeLlm(),
      mcpFactory: mcp(),
      traceStore: {
        ...store,
        openJournal: (opts) => {
          const inner = store.openJournal(opts);
          return {
            append: (e) => inner.append(e),
            close: () => inner.close(),
            discard: () => {
              const path = journalFiles()[0];
              if (path !== undefined) captured.push(readFileSync(path, "utf8"));
              inner.discard();
            },
          };
        },
      },
    });

    const res = await harness.run(BODY);
    expect(res.status).toBe("completed");
    expect(captured).toHaveLength(1);

    const parsed = await parseJournalChunks(one(captured[0]!), {
      maxChars: Number.MAX_SAFE_INTEGER,
      maxLineChars: Number.MAX_SAFE_INTEGER,
      maxEvents: Number.MAX_SAFE_INTEGER,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const persisted = store.getById("test", res.execution_id)?.trace.events ?? [];
    expect(parsed.events).toEqual(persisted);
  });

  it("recovers a run whose journal outlived it, with no final_context", async () => {
    harness = await makeHarness({ llm: makeLlm(), mcpFactory: mcp(), traceStore: store });

    let leaked: string | undefined;
    const original = store.openJournal.bind(store);
    const patched: JournalingTraceStore = {
      ...store,
      openJournal: (opts) => {
        const inner = original(opts);
        return {
          append: (e) => inner.append(e),
          close: () => inner.close(),
          discard: () => {
            leaked = journalFiles()[0];
            inner.close();
          },
        };
      },
    };
    harness = await makeHarness({ llm: makeLlm(), mcpFactory: mcp(), traceStore: patched });
    const res = await harness.run(BODY);

    expect(leaked).toBeDefined();
    expect(existsSync(leaked!)).toBe(true);

    store.deleteById("test", res.execution_id);
    const { utimesSync } = await import("node:fs");
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(leaked!, old, old);

    expect((await store.recoverOrphans()).recovered).toBe(1);
    const restored = store.getById("test", res.execution_id);
    expect(restored?.status).toBe("interrupted");
    expect(restored?.final_context).toBeUndefined();
    expect(restored?.total_input_tokens).toBeGreaterThan(0);
  });
});
