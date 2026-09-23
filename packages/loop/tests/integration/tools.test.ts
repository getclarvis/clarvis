import { afterEach, describe, expect, it } from "../bun-test.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { workspaceStatePaths } from "@clarvis/paths";
import { ExecutionSessionManager } from "@clarvis/tools";
import { isAlive, killTree } from "@clarvis/tools/shell";
import { createAgentToolsCapability } from "../../src/runtime/capabilities/tools.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { GateLLM } from "./_gate-llm.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
const dirs: string[] = [];
const sessionPids: number[] = [];

afterEach(async () => {
  await harness?.close();
  harness = null;
  for (const pid of sessionPids.splice(0)) {
    if (isAlive(pid)) killTree(pid, "SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function sessionMeta(root: string): Promise<{ scratch: string; pid: number }> {
  const path = join(root, "session-meta");
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const [scratch, pidText] = readFileSync(path, "utf8").trim().split("\n");
  const pid = Number(pidText);
  if (!scratch || !Number.isSafeInteger(pid)) throw new Error("invalid session fixture metadata");
  sessionPids.push(pid);
  return { scratch, pid };
}

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-tools-it-"));
  dirs.push(dir);
  return dir;
}

async function releaseRetainedScratch(scratch: string, pid: number): Promise<void> {
  if (basename(dirname(scratch)) !== "r") throw new Error("unexpected scratch path");
  const active = (): boolean => {
    if (process.platform !== "linux") return isAlive(pid);
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
      } catch {
        continue;
      }
    }
    return false;
  };
  const deadline = Date.now() + 3000;
  while (active() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (active()) return;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(dirname(dirname(scratch)), "a", `${basename(scratch)}.json`), { force: true });
}

type ToolEvent = {
  type: string;
  mcp_name?: string;
  result?: string;
  error?: string | null;
  diff?: string;
};

function body(grants?: string[]): unknown {
  return {
    messages: [{ role: "user", content: "do it" }],
    servers: [],
    profiles: [
      {
        name: "solo",
        model: "anthropic/claude-haiku-4-5",
        tools: [],
        ...(grants !== undefined ? { grants } : {}),
        iteration_limit: 5,
      },
    ],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30_000 },
  };
}

async function toolEvents(id: string): Promise<ToolEvent[]> {
  const detail = await harness!.getRun(id);
  return (detail!.trace.events as unknown as ToolEvent[]).filter(
    (event) => event.type === "tool_call",
  );
}

describe("built-in tools adapter integrations", () => {
  it("wires edit/read effects and preserves unified diff metadata", async () => {
    const root = workspace();
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "write", name: "write_file", arguments: { path: "out.txt", content: "one" } },
          ],
        },
        {
          toolCalls: [
            {
              id: "edit",
              name: "edit_file",
              arguments: { path: "out.txt", old_string: "one", new_string: "two" },
            },
            { id: "read", name: "read_file", arguments: { path: "out.txt" } },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
    });

    const response = await harness.run(body(["edit_workspace"]));

    expect(response.status).toBe("completed");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("two");
    const calls = await toolEvents(response.execution_id);
    expect(calls.find((event) => event.mcp_name === "write_file")?.error).toBeNull();
    expect(calls.find((event) => event.mcp_name === "read_file")?.result).toContain("two");
    const edit = calls.find((event) => event.mcp_name === "edit_file");
    expect(edit?.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(edit?.diff).toContain("-one");
    expect(edit?.diff).toContain("+two");
    expect(edit?.result).not.toContain("@@");
  });

  it("maps image content while the real read-only surface refuses mutation", async () => {
    const root = workspace();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    writeFileSync(join(root, "pixel.png"), png);
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "image", name: "read_image", arguments: { path: "pixel.png" } },
            {
              id: "write",
              name: "write_file",
              arguments: { path: "forbidden.txt", content: "no" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
    });

    const response = await harness.run(body(["read_workspace"]));

    expect(response.status).toBe("completed");
    expect(existsSync(join(root, "forbidden.txt"))).toBe(false);
    const imageMessage = llm.calls[1]!.messages.find(
      (message) =>
        message.role === "tool" && (message as { tool_call_id?: string }).tool_call_id === "image",
    );
    expect((imageMessage as { images?: unknown }).images).toEqual([
      { data: png.toString("base64"), mediaType: "image/png" },
    ]);
    const calls = await toolEvents(response.execution_id);
    expect(calls.find((event) => event.mcp_name === "write_file")?.error).toContain("Unknown tool");
  });

  it("does not launch detached monitor cleanup from an ordinary run", async () => {
    const root = workspace();
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const id = "mon_stale";
    const sidecar = join(paths.localDir, `${id}.json`);
    writeFileSync(
      sidecar,
      JSON.stringify({
        id,
        command: "done",
        cwd: root,
        pid: 2_147_480_000,
        startedAt: 1,
        readyWhen: null,
      }),
    );
    writeFileSync(join(paths.localDir, `${id}.log`), "old");
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
      env: { CLARVIS_AGENT_TOOLS_ENABLED: "false" },
    });

    await harness.run(body());
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(join(paths.localDir, `${id}.log`))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "drains a session before removing its run scratch on normal completion",
    async () => {
      const root = workspace();
      const llm = new MockLLM({
        script: [
          {
            toolCalls: [
              {
                id: "start",
                name: "shell",
                arguments: {
                  command:
                    'printf \'%s\\n%s\\n\' "$TMPDIR" "$$" > session-meta; printf ready; sleep 30',
                  ready_when: "ready",
                  yield_time_ms: 1000,
                },
              },
            ],
          },
          { text: "done" },
        ],
      });
      harness = await makeHarness({
        llm,
        mcpFactory: mockMCPFactory({}),
        workspaceRoot: root,
        agentTools: true,
        env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      });
      try {
        const response = await harness.run(body(["run_commands"]));
        expect(response.status).toBe("completed");
        expect(
          (await toolEvents(response.execution_id)).find((event) => event.mcp_name === "shell")
            ?.error,
        ).toBeNull();
        const { scratch, pid } = await sessionMeta(root);
        expect(isAlive(pid)).toBe(false);
        expect(scratch).toContain("/r/");
        expect(existsSync(scratch)).toBe(false);
      } finally {
        for (const pid of sessionPids) if (isAlive(pid)) killTree(pid, "SIGKILL");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains run scratch when the run-end budget cannot cover cleanup",
    async () => {
      const root = workspace();
      const llm = new MockLLM({
        script: [
          {
            toolCalls: [
              {
                id: "start",
                name: "shell",
                arguments: {
                  command:
                    "printf '%s\\n%s\\n' \"$TMPDIR\" \"$$\" > session-meta; printf ready; trap '' TERM; while :; do sleep 1; done",
                  ready_when: "ready",
                  yield_time_ms: 1000,
                },
              },
            ],
          },
          { text: "done" },
        ],
      });
      harness = await makeHarness({
        llm,
        mcpFactory: mockMCPFactory({}),
        workspaceRoot: root,
        agentTools: true,
        env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec", CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS: "1" },
      });
      let retained: { scratch: string; pid: number } | undefined;
      try {
        const response = await harness.run(body(["run_commands"]));
        expect(response.status).toBe("completed");
        const { scratch, pid } = await sessionMeta(root);
        retained = { scratch, pid };
        expect(existsSync(scratch)).toBe(true);
      } finally {
        if (retained) {
          if (isAlive(retained.pid)) killTree(retained.pid, "SIGKILL");
          await releaseRetainedScratch(retained.scratch, retained.pid);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "retains run scratch when tracked process exit is unconfirmed",
    async () => {
      const root = workspace();
      const llm = new MockLLM({
        script: [
          {
            toolCalls: [
              {
                id: "start",
                name: "shell",
                arguments: {
                  command:
                    'printf \'%s\\n%s\\n\' "$TMPDIR" "$$" > session-meta; printf ready; sleep 30',
                  ready_when: "ready",
                  yield_time_ms: 1000,
                },
              },
            ],
          },
          { text: "done" },
        ],
      });
      harness = await makeHarness({
        llm,
        mcpFactory: mockMCPFactory({}),
        workspaceRoot: root,
        capabilities: [
          createAgentToolsCapability({
            createSessionManager: () =>
              new (class extends ExecutionSessionManager {
                override async close(): Promise<boolean> {
                  return false;
                }
              })(),
          }),
        ],
        env: { CLARVIS_AGENT_TOOLS_ENABLED: "true", CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      });
      let retained: { scratch: string; pid: number } | undefined;
      try {
        const response = await harness.run(body(["run_commands"]));
        expect(response.status).toBe("completed");
        const { scratch, pid } = await sessionMeta(root);
        retained = { scratch, pid };
        expect(isAlive(pid)).toBe(true);
        expect(existsSync(scratch)).toBe(true);
      } finally {
        if (retained) {
          if (isAlive(retained.pid)) killTree(retained.pid, "SIGKILL");
          await releaseRetainedScratch(retained.scratch, retained.pid);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")("drains a session after run cancellation", async () => {
    const root = workspace();
    const cancel = new AbortController();
    const llm = new GateLLM((index) =>
      index === 0
        ? {
            toolCalls: [
              {
                id: "start",
                name: "shell",
                arguments: {
                  command:
                    'printf \'%s\\n%s\\n\' "$TMPDIR" "$$" > session-meta; printf ready; sleep 30',
                  ready_when: "ready",
                  yield_time_ms: 1000,
                },
              },
            ],
          }
        : { text: "late" },
    );
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
      env: { CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      externalSignal: cancel.signal,
    });
    const run = harness.run(body(["run_commands"]));
    await llm.started(0);
    llm.release(0);
    await llm.started(1);
    const { scratch, pid } = await sessionMeta(root);
    cancel.abort();
    llm.release(1);
    const response = await run;
    expect(response.status).toBe("cancelled");
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("drains a session after provider failure", async () => {
    const root = workspace();
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            {
              id: "start",
              name: "shell",
              arguments: {
                command:
                  'printf \'%s\\n%s\\n\' "$TMPDIR" "$$" > session-meta; printf ready; sleep 30',
                ready_when: "ready",
                yield_time_ms: 1000,
              },
            },
          ],
        },
        { throw: new Error("provider unavailable") },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
      env: {
        CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
        CLARVIS_RETRY_CEILING: "0",
        CLARVIS_DEFAULT_MAX_RETRIES: "0",
      },
    });
    const response = await harness.run(body(["run_commands"]));
    expect(response.status).toBe("error");
    const { scratch, pid } = await sessionMeta(root);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
  });
});
