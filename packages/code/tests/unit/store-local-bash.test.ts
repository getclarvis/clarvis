import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  createTranscriptStore,
  type LocalBashDisplay,
  type TranscriptNode,
  type TranscriptToolNode,
} from "../../src/adapters/store.ts";
import { applyRunEvent, runEvent } from "../helpers/run-events.ts";
import { parseBash } from "../../src/adapters/tool-parsers.ts";

const ev = runEvent;

/**
 * Narrow a store node to the tool call these tests are about.
 *
 * @remarks `store.nodes` is the whole {@link TranscriptNode} union, and every
 * field asserted below — `mcpName`, `args`, `result`, `warn` — exists only on
 * the `tool_call` member. Asserting the kind here states the assumption the test
 * already makes and fails with a useful message if a future change appends some
 * other node first.
 */
function toolNode(node: TranscriptNode | undefined): TranscriptToolNode {
  if (node?.kind !== "tool_call") {
    throw new Error(`expected a tool_call node, got ${String(node?.kind)}`);
  }
  return node;
}

function display(over: Partial<LocalBashDisplay>): LocalBashDisplay {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    signal: null,
    timedOut: false,
    cancelled: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...over,
  };
}

test("beginLocalBash appends a running local:bash tool_call node", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    store.beginLocalBash("ls -la");
    store.beginLocalBash("pwd");
    const [a, b] = [toolNode(store.nodes[0]), toolNode(store.nodes[1])];
    expect(a?.kind).toBe("tool_call");
    expect(a?.status).toBe("running");
    expect(a?.mcpName).toBe("local");
    expect(a?.toolName).toBe("shell");
    expect(a?.args).toEqual({ command: "ls -la" });
    expect(a?.startedAt).toBeDefined();
    expect(a?.key.startsWith("local:")).toBe(true);
    expect(b?.key).not.toBe(a?.key);
  });
});

test("success resolves to ok, auto-collapsed, parseable by parseBash", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const finish = store.beginLocalBash("echo hi");
    finish(display({ stdout: "hi\n" }));
    const n = toolNode(store.nodes[0]);
    expect(n.status).toBe("ok");
    expect(n.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(n.warn).toBe(false);
    expect(store.defaultFolded(n.key)).toBe(true);
    const parsed = parseBash(n.result ?? "", null);
    expect(parsed.parsed).toBe(true);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("hi\n");
  });
});

test("nonzero exit stays expanded with the warn flag", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const finish = store.beginLocalBash("false");
    finish(display({ exitCode: 2, stderr: "nope" }));
    const n = toolNode(store.nodes[0]);
    expect(n.status).toBe("ok");
    expect(n.warn).toBe(true);
    expect(store.defaultFolded(n.key)).toBe(false);
    expect(parseBash(n.result ?? "", null).stderr).toBe("nope");
  });
});

test("timeout and cancellation surface signal/timed_out and warn", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const finish = store.beginLocalBash("sleep 99");
    finish(display({ exitCode: null, signal: "SIGTERM", timedOut: true }));
    const n = toolNode(store.nodes[0]);
    expect(n.warn).toBe(true);
    expect(store.defaultFolded(n.key)).toBe(false);
    const parsed = parseBash(n.result ?? "", null);
    expect(parsed.timedOut).toBe(true);
    expect(parsed.signal).toBe("SIGTERM");
    expect(parsed.exitCode).toBe(null);

    const finish2 = store.beginLocalBash("sleep 99");
    finish2(display({ exitCode: null, signal: "SIGTERM", cancelled: true }));
    expect(toolNode(store.nodes[1]).warn).toBe(true);
  });
});

test("the finish callback resolves its node by key, surviving index shifts", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const sink = store.openRun("exec_1");
    applyRunEvent(
      sink,
      ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
      "live",
    );
    const finish = store.beginLocalBash("echo hi");
    applyRunEvent(
      sink,
      ev({
        type: "reasoning",
        agent: "lead",
        iteration: 1,
        at: 2,
        model: "m",
        text: "t",
      }),
      "live",
    );
    finish(display({ stdout: "hi" }));
    const bash = toolNode(store.nodes.find((n) => n.key.startsWith("local:")));
    expect(bash.status).toBe("ok");
    expect(parseBash(bash.result ?? "", null).stdout).toBe("hi");
    const reasoning = store.nodes.find((n) => n.kind === "reasoning")!;
    expect((reasoning as { result?: unknown }).result).toBeUndefined();
  });
});

test("the finish callback is a no-op after clear()", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const finish = store.beginLocalBash("echo hi");
    store.clear();
    expect(() => finish(display({ stdout: "hi" }))).not.toThrow();
    expect(store.nodes).toHaveLength(0);
  });
});

test("truncated streams carry a note in the stored result", () => {
  createRoot(() => {
    const store = createTranscriptStore();
    const finish = store.beginLocalBash("yes");
    finish(display({ stdout: "aaa", stdoutTruncated: true }));
    expect(parseBash(toolNode(store.nodes[0]).result ?? "", null).stdout).toBe(
      "aaa\n[stdout truncated]",
    );
  });
});
