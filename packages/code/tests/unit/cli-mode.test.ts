import { expect, test } from "bun:test";
import type { RunEvent } from "@clarvis/protocol";
import { createPrintStream, drainPrintEvents, resolveResumeMeta } from "../../src/cli-mode.ts";
import type { SessionMeta, SessionStore } from "../../src/adapters/session-store.ts";

function meta(id: string, workspace: string): SessionMeta {
  return {
    id,
    title: id,
    workspace,
    owner: "o",
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
  };
}

function store(list: SessionMeta[]): SessionStore {
  return {
    list: () => list,
    get: (id) => list.find((m) => m.id === id) ?? null,
    load: async (id) => list.find((m) => m.id === id) ?? null,
    save: () => {},
    delete: () => false,
  };
}

test("resolveResumeMeta: a miss is null, so a `!== undefined` preflight is always true", () => {
  // The --continue preflight compared against undefined and so never fired: a
  // workspace with no session booted the whole TUI instead of exiting 1.
  const miss = resolveResumeMeta(store([]), "o", "/ws", { kind: "continue" });
  expect(miss).toBeNull();
  expect(miss !== undefined).toBe(true);
  expect(miss !== null).toBe(false);
});

test("resolveResumeMeta: --continue is strict to this workspace — no global fallback", () => {
  const here = meta("here", "/ws");
  const other = meta("other", "/elsewhere");
  expect(resolveResumeMeta(store([other, here]), "o", "/ws", { kind: "continue" })?.id).toBe(
    "here",
  );
  expect(resolveResumeMeta(store([other]), "o", "/ws", { kind: "continue" })).toBeNull();
  expect(resolveResumeMeta(store([]), "o", "/ws", { kind: "continue" })).toBeNull();
  expect(resolveResumeMeta(store([here]), "o", "/ws", { kind: "resume", id: "here" })?.id).toBe(
    "here",
  );
});

const delta = (
  iteration: number,
  text: string,
  over: Partial<Extract<RunEvent, { type: "text_delta" }>> = {},
): RunEvent => ({
  type: "text_delta",
  at: 0,
  agent: "lead",
  iteration,
  channel: "text",
  text,
  reset: false,
  ...over,
});

const completed = (
  iteration: number,
  response: string,
  over: Partial<Extract<RunEvent, { type: "iteration_completed" }>> = {},
): RunEvent => ({
  type: "iteration_completed",
  at: 0,
  agent: "lead",
  iteration,
  response,
  input_tokens: 0,
  output_tokens: 0,
  ...over,
});

function collect(): { out: string[]; feed: (e: RunEvent) => void } {
  const out: string[] = [];
  return { out, feed: createPrintStream((c) => out.push(c)) };
}

test("print stream: lead text deltas stream through; the completed echo is not re-printed", () => {
  const { out, feed } = collect();
  feed(delta(1, "hel", { reset: true }));
  feed(delta(1, "lo"));
  feed(completed(1, "hello"));
  expect(out.join("")).toBe("hello");
});

test("print stream: sub-agent and reasoning channels never reach stdout", () => {
  const { out, feed } = collect();
  feed(delta(1, "hidden", { agent: "subagent", subagent_id: "s1" }));
  feed(delta(1, "thinking", { channel: "reasoning" }));
  expect(out.join("")).toBe("");
});

test("print stream: an iteration that streamed nothing prints its completed response", () => {
  const { out, feed } = collect();
  feed(completed(1, "no streaming here"));
  expect(out.join("")).toBe("no streaming here");
});

test("print stream: later iterations separate with a blank line", () => {
  const { out, feed } = collect();
  feed(delta(1, "first", { reset: true }));
  feed(completed(1, "first"));
  feed(delta(2, "second", { reset: true }));
  expect(out.join("")).toBe("first\n\nsecond");
});

test("print stream: a mid-iteration reset restarts on a fresh line instead of interleaving", () => {
  const { out, feed } = collect();
  feed(delta(1, "partial", { reset: true }));
  feed(delta(1, "retried", { reset: true }));
  expect(out.join("")).toBe("partial\nretried");
});

function eventStream(): {
  push: (event: RunEvent) => void;
  close: () => void;
  events: AsyncIterable<RunEvent>;
} {
  const buffer: RunEvent[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const signal = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const events: AsyncIterable<RunEvent> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffer.length > 0) {
          yield buffer.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    push: (event) => {
      buffer.push(event);
      signal();
    },
    close: () => {
      closed = true;
      signal();
    },
    events,
  };
}

const runEnded: RunEvent = { type: "run_ended", at: 0, status: "completed", reason: "completed" };

const ingest = (detail: Record<string, unknown>): RunEvent =>
  ({
    type: "memory_ingest",
    at: 0,
    detail: { execution_id: "e1", ...detail },
  }) as RunEvent;

test("print drain: the transcript settles at run_ended while the stream lingers for the ingest", async () => {
  const s = eventStream();
  const seen: string[] = [];
  const notices: string[] = [];
  const { transcriptDone, drained } = drainPrintEvents(s.events, {
    onEvent: (event) => seen.push(event.type),
    onNotice: (text) => notices.push(text),
  });
  s.push(delta(1, "hi", { reset: true }));
  s.push(runEnded);
  s.push(ingest({ phase: "started" }));
  await transcriptDone;
  expect(seen).toEqual(["text_delta", "run_ended"]);
  s.push(ingest({ phase: "done", written: 2, deleted: 1 }));
  s.close();
  await drained;
  expect(seen).toEqual(["text_delta", "run_ended"]);
  expect(notices[0]).toContain("memory: learning");
  expect(notices[1]).toBe("memory +2 -1");
});

test("print drain: a stream that closes without run_ended still settles the transcript", async () => {
  const s = eventStream();
  const seen: string[] = [];
  const { transcriptDone, drained } = drainPrintEvents(s.events, {
    onEvent: (event) => seen.push(event.type),
    onNotice: () => {},
  });
  s.push(delta(1, "partial", { reset: true }));
  s.close();
  await transcriptDone;
  await drained;
  expect(seen).toEqual(["text_delta"]);
});
