import { describe, expect, it } from "../bun-test.ts";
import { getEventListeners } from "node:events";
import { OPERATOR_INTERRUPTED_TOOL } from "../../src/runtime/tools/tool-interrupt.ts";
import type { NamespacedTool } from "@clarvis/capability";
import {
  createAgentToolsetWithAdapter,
  type AgentToolsAdapter,
  type AgentToolset,
  type AgentToolsetOptions,
  type AgentToolResult,
} from "../../src/runtime/tools/builtin/toolset.ts";

const TOOL_NAMES = ["read_file", "write_file", "shell", "shell_session"] as const;

function definition(name: string): NamespacedTool {
  return {
    fullName: name,
    wireName: name,
    mcpName: "",
    toolName: name,
    inputSchema: { type: "object" },
  };
}

interface FakeAdapter extends AgentToolsAdapter {
  options: AgentToolsetOptions[];
  calls: Array<{
    name: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  }>;
}

function fakeAdapter(
  dispatch: AgentToolset["dispatch"] = async () => ({ isError: false, text: "ok" }),
): FakeAdapter {
  const options: AgentToolsetOptions[] = [];
  const calls: FakeAdapter["calls"] = [];
  return {
    options,
    calls,
    resolve(opts) {
      options.push(opts);
      return {
        defs: TOOL_NAMES.map(definition),
        dispatch: (name, args, signal, onOutput, onExecutionStarted) => {
          calls.push({
            name,
            args,
            ...(signal !== undefined ? { signal } : {}),
            ...(onOutput !== undefined ? { onOutput } : {}),
          });
          return dispatch(name, args, signal, onOutput, onExecutionStarted);
        },
      };
    },
  };
}

function toolset(
  adapter: AgentToolsAdapter,
  over: Partial<AgentToolsetOptions> = {},
): AgentToolset {
  return createAgentToolsetWithAdapter(
    { workspaceRoot: "/workspace", canMutate: true, canExec: true, ...over },
    adapter,
  );
}

describe("createAgentToolset policy", () => {
  it("publishes the adapter definitions and forwards the complete options once", () => {
    const adapter = fakeAdapter();
    const guard = async () => ({ verdict: "allow" as const });
    const options = {
      workspaceRoot: "/workspace",
      canMutate: false,
      canExec: true,
      guard,
      secretEnvNames: ["TOKEN"],
    } satisfies AgentToolsetOptions;

    const created = createAgentToolsetWithAdapter(options, adapter);

    expect(adapter.options).toEqual([options]);
    expect(created.defs.map((entry) => entry.wireName)).toEqual([...TOOL_NAMES]);
    expect([...created.names]).toEqual([...TOOL_NAMES]);
  });

  it("removes every exec tool when execution is outside the agent ceiling", () => {
    const created = toolset(fakeAdapter(), { canExec: false });

    expect([...created.names]).toEqual(["read_file", "write_file"]);
    expect(created.defs.map((entry) => entry.wireName)).toEqual(["read_file", "write_file"]);
  });

  it.each(["shell", "shell_session", "unknown"])(
    "refuses unavailable tool %s without dispatching",
    async (name) => {
      const adapter = fakeAdapter();
      const created = toolset(adapter, { canExec: false });

      await expect(created.dispatch(name, {})).resolves.toEqual({
        isError: true,
        text: `Tool '${name}' is not available to this agent.`,
      });
      expect(adapter.calls).toEqual([]);
    },
  );

  it("forwards call inputs and preserves the adapter result", async () => {
    const expected: AgentToolResult = {
      isError: false,
      text: "written",
      images: [{ data: "AAAA", mediaType: "image/png" }],
      diff: "@@ diff",
    };
    const adapter = fakeAdapter(async (_name, _args, _signal, onOutput) => {
      onOutput?.("live");
      return expected;
    });
    const created = toolset(adapter);
    const signal = new AbortController().signal;
    const chunks: string[] = [];

    await expect(
      created.dispatch("write_file", { path: "a" }, signal, (chunk) => chunks.push(chunk)),
    ).resolves.toBe(expected);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({
      name: "write_file",
      args: { path: "a" },
      signal,
    });
    expect(chunks).toEqual(["live"]);
  });

  it("an already-aborted signal resolves as cancelled", async () => {
    const adapter = fakeAdapter();
    const created = toolset(adapter);

    await expect(created.dispatch("read_file", {}, AbortSignal.abort())).resolves.toEqual({
      isError: true,
      text: "Tool call aborted.",
    });
  });

  it("an abort wins an in-flight dispatch and removes its listener", async () => {
    let settle!: (result: AgentToolResult) => void;
    const pending = new Promise<AgentToolResult>((resolve) => {
      settle = resolve;
    });
    const created = toolset(fakeAdapter(() => pending));
    const controller = new AbortController();

    const result = created.dispatch("read_file", {}, controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({
      isError: true,
      text: "Tool call aborted.",
    });
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    settle({ isError: false, text: "late" });
  });

  it("does not retain a listener after a normal dispatch", async () => {
    const created = toolset(fakeAdapter());
    const controller = new AbortController();

    await created.dispatch("read_file", {}, controller.signal);

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("selective abort waits for executor output, and cleans both signal listeners", async () => {
    const tool = new AbortController();
    const run = new AbortController();
    let settle!: (result: AgentToolResult) => void;
    const created = toolset(
      fakeAdapter(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      ),
    );
    const pending = created.dispatch("shell", {}, tool.signal, undefined, undefined, run.signal);
    tool.abort(OPERATOR_INTERRUPTED_TOOL);
    const expected = { isError: true, text: "partial", executionAborted: true };
    settle(expected);
    expect(await pending).toEqual(expected);
    expect(getEventListeners(tool.signal, "abort")).toEqual([]);
    expect(getEventListeners(run.signal, "abort")).toEqual([]);
  });

  it("global cancel preempts selective grace even when the combined signal cannot fire again", async () => {
    const tool = new AbortController();
    const run = new AbortController();
    const created = toolset(fakeAdapter(() => new Promise(() => {})));
    const pending = created.dispatch("shell", {}, tool.signal, undefined, undefined, run.signal);
    tool.abort(OPERATOR_INTERRUPTED_TOOL);
    const start = performance.now();
    run.abort();
    expect(await pending).toEqual({ isError: true, text: "Tool call aborted." });
    expect(performance.now() - start).toBeLessThan(500);
    expect(getEventListeners(tool.signal, "abort")).toEqual([]);
    expect(getEventListeners(run.signal, "abort")).toEqual([]);
  });

  it("bounds noncooperative selective abort and silences late output/start", async () => {
    const tool = new AbortController();
    let output!: (chunk: string) => void;
    let started!: () => void;
    let settle!: (result: AgentToolResult) => void;
    const created = toolset(
      fakeAdapter((_name, _args, _signal, onOutput, onStarted) => {
        output = onOutput!;
        started = onStarted!;
        return new Promise((resolve) => {
          settle = resolve;
        });
      }),
    );
    const events: string[] = [];
    const pending = created.dispatch(
      "shell",
      {},
      tool.signal,
      (s) => events.push(s),
      () => events.push("start"),
    );
    tool.abort(OPERATOR_INTERRUPTED_TOOL);
    expect(await pending).toMatchObject({ isError: true, abortUnsettled: true });
    output("late");
    started();
    settle({ isError: false, text: "late" });
    expect(events).toEqual([]);
    expect(getEventListeners(tool.signal, "abort")).toEqual([]);
  });
});
