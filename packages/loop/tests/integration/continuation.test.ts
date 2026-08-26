import { describe, it, expect, afterEach } from "../bun-test.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { makeExecutionRecord } from "./_helpers.ts";
import { createJsonTraceStore } from "@clarvis/trace";
import { ContinuationUnavailableError } from "@clarvis/capability";
import { contentToText } from "@clarvis/capability";

const open: TestHarness[] = [];
const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open.length = 0;
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
  workspaces.length = 0;
});

async function harnessWith(
  llm: MockLLM,
  traceStore = createMemoryTraceStore(),
  workspaceRoot?: string,
) {
  const h = await makeHarness({
    llm,
    mcpFactory: fsFactory(),
    traceStore,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
  open.push(h);
  return h;
}

const FS_TOOLS = [
  {
    name: "filesystem",
    transport: "stdio" as const,
    command: "node",
    args: ["-e", ""],
  },
];

const fsFactory = () =>
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

const soloProfile = (over: Record<string, unknown> = {}) => ({
  name: "solo",
  model: "anthropic/claude-sonnet-4-5",
  tools: ["filesystem.read"],
  iteration_limit: 10,
  ...over,
});

const soloBody = (messages: unknown[], over: Record<string, unknown> = {}) => ({
  messages,
  servers: FS_TOOLS,
  profiles: [soloProfile()],
  entry: "solo",
  budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
  ...over,
});

describe("continue_from — context seeding", () => {
  it("seeds the new run with the prior run's final context, byte-identical, under a fresh system head", async () => {
    const store = createMemoryTraceStore();
    const llm1 = new MockLLM({
      script: [
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "/etc/hostname" } }] },
        { text: "The hostname is 'my-host'." },
      ],
    });
    const h1 = await harnessWith(llm1, store);
    const run1 = await h1.run(soloBody([{ role: "user", content: "Read /etc/hostname" }]));
    expect(run1.status).toBe("completed");
    const stored1 = store.getById("test", run1.execution_id)!;

    const llm2 = new MockLLM({ script: [{ text: "You asked about /etc/hostname." }] });
    const h2 = await harnessWith(llm2, store);
    const run2 = await h2.run(
      soloBody([{ role: "user", content: "What did I ask before?" }], {
        continue_from: run1.execution_id,
      }),
    );
    expect(run2.status).toBe("completed");

    const seeded = llm2.calls[0]!.messages;
    expect(seeded[0]!.role).toBe("system");
    const middle = seeded.slice(1, 1 + stored1.final_context!.length);
    expect(middle).toEqual(stored1.final_context!.map((e) => e.message));
    expect(seeded[1 + stored1.final_context!.length]).toEqual({
      role: "user",
      content: "What did I ask before?",
    });
    expect(seeded.some((m) => contentToText(m.content).includes("my-host"))).toBe(true);
  });

  it("a switched profile only swaps the system head; the snapshot rides along intact", async () => {
    const store = createMemoryTraceStore();
    const llm1 = new MockLLM({
      script: [
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "/etc/hostname" } }] },
        { text: "done reading" },
      ],
    });
    const h1 = await harnessWith(llm1, store);
    const run1 = await h1.run(soloBody([{ role: "user", content: "read it" }]));

    const llm2 = new MockLLM({ script: [{ text: "summarized" }] });
    const h2 = await harnessWith(llm2, store);
    const run2 = await h2.run(
      soloBody([{ role: "user", content: "summarize" }], {
        profiles: [soloProfile({ name: "writer", base_prompt: "You are the writer persona." })],
        entry: "writer",
        continue_from: run1.execution_id,
      }),
    );
    expect(run2.status).toBe("completed");

    const seeded = llm2.calls[0]!.messages;
    expect(seeded[0]!.role).toBe("system");
    expect(contentToText(seeded[0]!.content)).toContain("You are the writer persona.");
    expect(seeded.some((m) => m.role === "tool")).toBe(true);
  });
});

describe("continue_from — persisted context fidelity", () => {
  it("re-feeds tool results with long opaque strings byte-identical through the real store", async () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const dir = mkdtempSync(join(tmpdir(), "clarvis-c1-regression-"));
    try {
      const store = createJsonTraceStore({ dir });
      const llm1 = new MockLLM({
        script: [
          { toolCalls: [{ name: "filesystem.read", arguments: { path: "/repo/lock" } }] },
          { text: "lockfile recorded" },
        ],
      });
      const h1 = await makeHarness({
        llm: llm1,
        mcpFactory: mockMCPFactory({
          filesystem: {
            tools: [
              {
                name: "read",
                inputSchema: { type: "object", properties: { path: { type: "string" } } },
                call: () => `integrity sha256-${sha} header Bearer live.token-1`,
              },
            ],
          },
        }),
        traceStore: store,
      });
      open.push(h1);
      const run1 = await h1.run(soloBody([{ role: "user", content: "read the lockfile" }]));
      expect(run1.status).toBe("completed");

      const llm2 = new MockLLM({ script: [{ text: "still here" }] });
      const h2 = await makeHarness({ llm: llm2, mcpFactory: fsFactory(), traceStore: store });
      open.push(h2);
      const run2 = await h2.run(
        soloBody([{ role: "user", content: "what was the integrity hash?" }], {
          continue_from: run1.execution_id,
        }),
      );
      expect(run2.status).toBe("completed");

      const seededText = llm2.calls[0]!.messages.map((m) => contentToText(m.content)).join("\n");
      expect(seededText).toContain(`sha256-${sha}`);
      expect(seededText).toContain("Bearer live.token-1");
      expect(seededText).not.toContain("[redacted]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("continue_from — unavailability", () => {
  it("throws continuation_unavailable for an unknown id", async () => {
    const h = await harnessWith(new MockLLM({ script: [] }));
    await expect(
      h.run(soloBody([{ role: "user", content: "hi" }], { continue_from: "exec_nope" })),
    ).rejects.toThrow(ContinuationUnavailableError);
  });

  it("is owner-scoped: one owner cannot continue another owner's run", async () => {
    const store = createMemoryTraceStore();
    const llm1 = new MockLLM({ script: [{ text: "alice's run" }] });
    const h1 = await harnessWith(llm1, store);
    const run1 = await h1.run(soloBody([{ role: "user", content: "hi" }]), { owner: "alice" });

    const h2 = await harnessWith(new MockLLM({ script: [] }), store);
    await expect(
      h2.run(soloBody([{ role: "user", content: "again" }], { continue_from: run1.execution_id }), {
        owner: "bob",
      }),
    ).rejects.toThrow(ContinuationUnavailableError);
  });

  it("throws when the stored record has no final_context", async () => {
    const store = createMemoryTraceStore();
    await store.insert(makeExecutionRecord({ id: "exec_bare", owner_key_name: "test" }));
    const h = await harnessWith(new MockLLM({ script: [] }), store);
    await expect(
      h.run(soloBody([{ role: "user", content: "hi" }], { continue_from: "exec_bare" })),
    ).rejects.toThrow(ContinuationUnavailableError);
  });
});
