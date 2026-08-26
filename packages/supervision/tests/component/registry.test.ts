import { describe, it, expect } from "bun:test";
import { createAgentRegistry, type AgentRegistry, type AgentsLimits } from "../../src/registry.ts";
import type { AgentHandle, AgentRegistration, Logger, TraceEntry } from "@clarvis/capability";

const LIMITS: AgentsLimits = {
  bufferLines: 200,
  bufferBytes: 65_536,
  maxTotalBufferBytes: 786_432,
  pollMaxBytes: 8192,
  awaitTimeoutMs: 1000,
  maxLiveChildren: 4,
  maxRetainedChildren: 8,
  maxNoticesPerIteration: 3,
  maxConsecutiveFailedChildren: 3,
  finishNudges: 2,
};

interface Spy {
  registration: AgentRegistration;
  stops: string[];
  steers: unknown[];
}

function child(nativeId: string, over: Partial<AgentRegistration> = {}): Spy {
  const stops: string[] = [];
  const steers: unknown[] = [];
  return {
    stops,
    steers,
    registration: {
      kind: "subagent",
      nativeId,
      title: `task ${nativeId}`,
      control: {
        stop: (reason) => stops.push(reason),
        steer: (m) => {
          steers.push(m);
          return true;
        },
      },
      ...over,
    },
  };
}

function make(over: Partial<AgentsLimits> = {}): AgentRegistry {
  return createAgentRegistry({ limits: { ...LIMITS, ...over } });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function manualTimeout(): {
  schedule: NonNullable<Parameters<typeof createAgentRegistry>[0]["scheduleTimeout"]>;
  fire(): void;
  readonly pending: number;
} {
  let task: (() => void) | undefined;
  return {
    schedule(callback) {
      task = callback;
      return () => {
        task = undefined;
      };
    },
    fire(): void {
      const callback = task;
      task = undefined;
      callback?.();
    },
    get pending(): number {
      return task === undefined ? 0 : 1;
    },
  };
}

function debugLogger(lines: string[]): Logger {
  const silent = (): void => {};
  return {
    debug: (...args: unknown[]) =>
      lines.push(typeof args[1] === "string" ? args[1] : String(args[0])),
    info: silent,
    warn: silent,
    error: silent,
  };
}

interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  fields: Record<string, unknown>;
  message: string;
}

function recordingLogger(records: LogRecord[]): Logger {
  const at =
    (level: LogRecord["level"]) =>
    (...args: unknown[]): void => {
      records.push({
        level,
        fields: (args[0] ?? {}) as Record<string, unknown>,
        message: typeof args[1] === "string" ? args[1] : "",
      });
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

function eventsNamed(records: LogRecord[], event: string): LogRecord[] {
  return records.filter((r) => r.fields.event === event);
}

function iterationEntry(nativeId: string, iteration: number, response: string): TraceEntry {
  return {
    at: 0,
    kind: "subagent_iteration",
    detail: {
      subagent_instance_id: nativeId,
      iteration,
      started_at: 0,
      ended_at: 1,
      model: "m",
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_read_ratio: 0,
      response,
    },
  };
}

describe("agents registry — ids and scoping", () => {
  it("an id from another registry is simply unknown — a plain null, never a throw", () => {
    const a = make();
    const b = make();
    const inB = b.register(child("n1").registration)!;
    expect(a.has(inB.id)).toBe(false);
    expect(a.poll(inB.id, {})).toBeNull();
    expect(a.stop(inB.id, "why")).toBeNull();
    expect(a.steer(inB.id, { content: "hi" })).toBeNull();
  });
});

describe("agents registry — spawn ceiling and sealing", () => {
  it("refuses a spawn past the live-children ceiling instead of queueing it", () => {
    const registry = make({ maxLiveChildren: 2 });
    expect(registry.register(child("a").registration)).not.toBeNull();
    expect(registry.register(child("b").registration)).not.toBeNull();
    expect(registry.register(child("c").registration)).toBeNull();
    expect(registry.liveCount()).toBe(2);
  });

  it("a settled child frees its slot", () => {
    const registry = make({ maxLiveChildren: 1 });
    const first = registry.register(child("a").registration)!;
    expect(registry.register(child("b").registration)).toBeNull();
    first.settled({ status: "completed", result: "done" });
    expect(registry.register(child("b").registration)).not.toBeNull();
  });

  it("a sealed registry refuses every further registration", () => {
    const registry = make();
    registry.seal();
    expect(registry.sealed()).toBe(true);
    expect(registry.register(child("a").registration)).toBeNull();
  });
});

describe("agents registry — stop", () => {
  it("drives the child's own stop port and settles it as stopped", () => {
    const registry = make();
    const spy = child("a");
    const handle = registry.register(spy.registration)!;
    const result = registry.stop(handle.id, "went off the rails");
    expect(spy.stops).toEqual(["went off the rails"]);
    expect(result!.status).toBe("stopped");
    expect(result!.already_settled).toBe(false);
    expect(registry.liveCount()).toBe(0);
  });

  it("stopping an already-settled child reports it rather than stopping twice", () => {
    const registry = make();
    const spy = child("a");
    const handle = registry.register(spy.registration)!;
    handle.settled({ status: "completed", result: "done" });
    const result = registry.stop(handle.id, "too late");
    expect(spy.stops).toEqual([]);
    expect(result!.already_settled).toBe(true);
    expect(result!.status).toBe("completed");
  });

  it("the buffer survives the kill, so a parent can autopsy what it just ended (D9)", () => {
    const registry = make();
    const handle = registry.register(child("a").registration)!;
    registry.ingestTraceEntry(iterationEntry("a", 1, "halfway through"));
    const before = registry.poll(handle.id, {})!;
    registry.stop(handle.id, "enough");
    const after = registry.poll(handle.id, {})!;
    expect(after.output).toBe(before.output);
    expect(after.output).toContain("halfway through");
    expect(after.running).toBe(false);
  });
});

describe("agents registry — steer", () => {
  it("queues onto the child's own port while it is live", () => {
    const registry = make();
    const spy = child("a");
    const handle = registry.register(spy.registration)!;
    expect(registry.steer(handle.id, { content: "try the other file" })).toEqual({
      ok: true,
      status: "running",
    });
    expect(spy.steers).toHaveLength(1);
  });

  it("a steer to a settled child is refused as a plain result, never an error", () => {
    const registry = make();
    const spy = child("a");
    const handle = registry.register(spy.registration)!;
    handle.settled({ status: "completed", result: "done" });
    expect(registry.steer(handle.id, { content: "hello" })).toEqual({
      ok: false,
      status: "completed",
    });
    expect(spy.steers).toHaveLength(0);
  });
});

describe("agents registry — trace ingest", () => {
  it("routes an entry to the child whose native id it carries and ignores the rest", () => {
    const registry = make();
    const a = registry.register(child("native-a").registration)!;
    const b = registry.register(child("native-b").registration)!;
    registry.ingestTraceEntry(iterationEntry("native-a", 1, "only for a"));
    registry.ingestTraceEntry(iterationEntry("unregistered", 1, "nobody's"));
    expect(registry.poll(a.id, {})!.output).toContain("only for a");
    expect(registry.poll(b.id, {})!.output).toBe("");
  });

  it("folds iteration count and tokens off the ingested stream", () => {
    const registry = make();
    const a = registry.register(child("native-a").registration)!;
    registry.ingestTraceEntry(iterationEntry("native-a", 1, "one"));
    registry.ingestTraceEntry(iterationEntry("native-a", 2, "two"));
    const row = registry.list().find((r) => r.id === a.id)!;
    expect(row.iterations).toBe(2);
    expect(row.tokens).toBe(30);
  });

  it("notifies the host on activity so a parent's stall watchdog stays fed", () => {
    let pokes = 0;
    const registry = createAgentRegistry({
      limits: LIMITS,
      onActivity: () => {
        pokes += 1;
      },
    });
    registry.register(child("native-a").registration);
    registry.ingestTraceEntry(iterationEntry("native-a", 1, "work"));
    expect(pokes).toBeGreaterThan(0);
  });
});

describe("agents registry — poll paging", () => {
  it("pages with next_offset and marks the continuation", () => {
    const registry = createAgentRegistry({ limits: { ...LIMITS, pollMaxBytes: 40 } });
    const handle = registry.register(child("a").registration)!;
    for (let i = 0; i < 6; i += 1) {
      registry.ingestTraceEntry(iterationEntry("a", i + 1, `response number ${String(i)}`));
    }
    const first = registry.poll(handle.id, {})!;
    expect(first.output).toContain("continue with offset=");
    const second = registry.poll(handle.id, { offset: first.next_offset })!;
    expect(second.next_offset).toBeGreaterThan(first.next_offset);
  });
});

describe("agents registry — waitAny", () => {
  it("resolves on the first child in scope to settle", async () => {
    const registry = make();
    const a = registry.register(child("a").registration)!;
    const b = registry.register(child("b").registration)!;
    const wait = registry.waitAny([a.id, b.id]);
    b.settled({ status: "completed", result: "b finished" });
    await expect(wait.promise).resolves.toEqual({
      id: b.id,
      status: "completed",
      result: "b finished",
    });
  });

  it("ignores a settle outside the requested scope", async () => {
    const registry = make();
    const a = registry.register(child("a").registration)!;
    const b = registry.register(child("b").registration)!;
    const wait = registry.waitAny([a.id]);
    let settled = false;
    void wait.promise.then(() => {
      settled = true;
    });
    b.settled({ status: "completed", result: "not the one" });
    await Promise.resolve();
    expect(settled).toBe(false);
    a.settled({ status: "failed", result: "boom" });
    await expect(wait.promise).resolves.toMatchObject({ id: a.id, status: "failed" });
  });

  it("dispose removes the waiter so a lost race leaves nothing behind", async () => {
    const registry = make();
    const a = registry.register(child("a").registration)!;
    const wait = registry.waitAny([a.id]);
    let settled = false;
    void wait.promise.then(() => {
      settled = true;
    });
    wait.dispose();
    a.settled({ status: "completed", result: "done" });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("returns an already-settled selected child immediately in input-id order", async () => {
    const registry = make();
    const a = registry.register(child("a").registration)!;
    const b = registry.register(child("b").registration)!;
    a.settled({ status: "completed", result: "first" });
    b.settled({ status: "failed", result: "second" });
    const wait = registry.waitAny([b.id, a.id]);
    await expect(wait.promise).resolves.toEqual({
      id: b.id,
      status: "failed",
      result: "second",
    });
    // An immediately resolved wait still exposes the same disposable contract.
    wait.dispose();
  });

  it("rejects an explicit unknown id immediately", async () => {
    const registry = make();
    const wait = registry.waitAny(["agent_missing"]);
    await expect(wait.promise).rejects.toMatchObject({
      code: "unknown_agent",
    });
    // A rejected wait owns no listener, so disposal is an intentional no-op.
    wait.dispose();
  });
});

describe("agents registry — notices", () => {
  it("a successful settle counts as progress; a failure does not", () => {
    const registry = make();
    const a = registry.register(child("a").registration)!;
    const b = registry.register(child("b").registration)!;
    a.settled({ status: "completed", result: "ok" });
    b.settled({ status: "failed", result: "boom" });
    const notices = registry.takeNotices();
    expect(notices).toHaveLength(2);
    expect(notices[0]!.progress).toBe(true);
    expect(notices[1]!.progress).toBe(false);
    expect(registry.takeNotices()).toHaveLength(0);
  });

  it("caps notices per iteration with a pointer to agent_list", () => {
    const registry = make({ maxLiveChildren: 10, maxNoticesPerIteration: 2 });
    for (let i = 0; i < 5; i += 1) {
      registry.register(child(`n${String(i)}`).registration)!.settled({ status: "completed" });
    }
    const notices = registry.takeNotices();
    expect(notices).toHaveLength(3);
    expect(notices[2]!.text).toContain("+3 more");
    expect(notices[2]!.progress).toBe(false);
  });

  it("tracks a consecutive-failure streak and resets it on a success", () => {
    const registry = make({ maxLiveChildren: 10, maxConsecutiveFailedChildren: 3 });
    const settleWith = (n: string, status: "completed" | "failed"): void => {
      registry.register(child(n).registration)!.settled({ status });
    };
    settleWith("a", "failed");
    settleWith("b", "failed");
    expect(registry.failingStreakExceeded()).toBe(false);
    settleWith("c", "failed");
    expect(registry.failingStreakExceeded()).toBe(true);
    settleWith("d", "completed");
    expect(registry.failingStreakExceeded()).toBe(false);
  });
});

describe("agents registry — retention and teardown", () => {
  it("divides the aggregate buffer budget across live and retained child slots", () => {
    const registry = make({
      bufferBytes: 1000,
      maxTotalBufferBytes: 50,
      maxLiveChildren: 2,
      maxRetainedChildren: 3,
    });
    const handles: AgentHandle[] = [];
    for (let i = 0; i < 3; i += 1) {
      const nativeId = `settled-${String(i)}`;
      const handle = registry.register(child(nativeId).registration)!;
      handles.push(handle);
      registry.ingestTraceEntry(iterationEntry(nativeId, 1, "x".repeat(200)));
      handle.settled({ status: "completed" });
    }
    for (let i = 0; i < 2; i += 1) {
      const nativeId = `live-${String(i)}`;
      const handle = registry.register(child(nativeId).registration)!;
      handles.push(handle);
      registry.ingestTraceEntry(iterationEntry(nativeId, 1, "x".repeat(200)));
    }

    const retainedBytes = handles.reduce((sum, handle) => {
      const page = registry.poll(handle.id, {})!;
      return sum + page.next_offset - page.truncated_head;
    }, 0);
    expect(retainedBytes).toBeLessThanOrEqual(50);
    expect(handles.every((handle) => registry.has(handle.id))).toBe(true);
  });

  it("holds the aggregate invariant at the maximum live and retained combination", () => {
    const registry = make({
      bufferBytes: Number.MAX_SAFE_INTEGER,
      maxTotalBufferBytes: 96,
      maxLiveChildren: 32,
      maxRetainedChildren: 64,
    });
    const handles: AgentHandle[] = [];
    for (let i = 0; i < 64; i += 1) {
      const nativeId = `settled-max-${String(i)}`;
      const handle = registry.register(child(nativeId).registration)!;
      handles.push(handle);
      registry.ingestTraceEntry(iterationEntry(nativeId, 1, "x".repeat(200)));
      handle.settled({ status: "completed" });
    }
    for (let i = 0; i < 32; i += 1) {
      const nativeId = `live-max-${String(i)}`;
      const handle = registry.register(child(nativeId).registration)!;
      handles.push(handle);
      registry.ingestTraceEntry(iterationEntry(nativeId, 1, "x".repeat(200)));
    }

    const retainedBytes = handles.reduce((sum, handle) => {
      const page = registry.poll(handle.id, {})!;
      return sum + page.next_offset - page.truncated_head;
    }, 0);
    expect(handles).toHaveLength(96);
    expect(retainedBytes).toBe(96);
    expect(registry.register(child("one-too-many").registration)).toBeNull();
  });

  it("evicts the oldest settled children past the retention cap, never a live one", () => {
    const registry = make({ maxLiveChildren: 10, maxRetainedChildren: 2 });
    const handles = ["a", "b", "c", "d"].map((n) => registry.register(child(n).registration)!);
    const live = registry.register(child("live").registration)!;
    for (const h of handles) h.settled({ status: "completed", result: "done" });

    expect(registry.has(handles[0]!.id)).toBe(false);
    expect(registry.has(handles[3]!.id)).toBe(true);
    expect(registry.has(live.id)).toBe(true);
  });

  it("teardown stops the survivors, freezes their buffers and reports them abandoned", async () => {
    const registry = make();
    const spy = child("a");
    const handle = registry.register(spy.registration)!;
    registry.ingestTraceEntry(iterationEntry("a", 1, "mid-flight"));
    const report = await registry.teardown(10);

    expect(spy.stops).toHaveLength(1);
    expect(report.abandoned).toEqual([handle.id]);
    expect(registry.poll(handle.id, {})!.status).toBe("cancelled");
    expect(registry.poll(handle.id, {})!.output).toContain("mid-flight");
  });

  it("teardown awaits an adopted task rather than abandoning its accounting", async () => {
    const registry = make();
    const handle = registry.register(child("a").registration)!;
    const task = deferred();
    let finished = false;
    registry.adopt(
      handle.id,
      task.promise.then(() => {
        finished = true;
        handle.settled({ status: "completed", result: "landed" });
      }),
    );
    const teardown = registry.teardown(5000);
    task.resolve();
    const report = await teardown;
    expect(finished).toBe(true);
    expect(report.abandoned).toEqual([]);
    expect(registry.poll(handle.id, {})!.result).toBe("landed");
  });

  it("teardown gives up on a wedged task at the grace bound instead of hanging", async () => {
    const timeout = manualTimeout();
    const registry = createAgentRegistry({ limits: LIMITS, scheduleTimeout: timeout.schedule });
    const handle = registry.register(child("a").registration)!;
    registry.adopt(handle.id, new Promise(() => {}));
    const teardown = registry.teardown(20);
    expect(timeout.pending).toBe(1);
    timeout.fire();
    const report = await teardown;
    expect(report.abandoned).toEqual([handle.id]);
    expect(timeout.pending).toBe(0);
  });

  it("an adopted task that rejects never escapes as an unhandled rejection", async () => {
    const registry = make();
    const handle = registry.register(child("a").registration)!;
    registry.adopt(handle.id, Promise.reject(new Error("child blew up")));
    await expect(registry.teardown(50)).resolves.toBeDefined();
  });

  it("counts steers that never reached their child", async () => {
    const registry = make();
    registry.register({
      ...child("a").registration,
      control: { stop: () => {}, steer: () => true, undrained: () => 2 },
    });
    const report = await registry.teardown(10);
    expect(report.undrainedSteers).toBe(2);
  });
});

/**
 * The paths a *leader* takes rather than a sub-agent, plus the two failures the
 * registry is required to swallow.
 *
 * @remarks A sub-agent's activity arrives off the run's own trace
 * (`ingestTraceEntry`); a leader's arrives through its handle as forwarded wire
 * events. Both must land in the same buffer and the same accounting, or a
 * manager's `agent_poll` reports a healthy leader as silent.
 */
describe("agents registry — the handle a producer holds", () => {
  const leadEvent = (iteration: number, response: string) =>
    ({
      type: "lead_iteration",
      iteration,
      input_tokens: 10,
      output_tokens: 5,
      response,
      started_at: 0,
      ended_at: 1,
      model: "m",
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_read_ratio: 0,
    }) satisfies Parameters<AgentHandle["ingest"]>[0];

  it("accounts a leader's forwarded iterations and shows them in a poll", () => {
    const registry = make();
    const handle = registry.register({ ...child("run_1").registration, kind: "leader" })!;

    handle.ingest(leadEvent(1, "first"));
    handle.ingest(leadEvent(2, "second"));

    const entry = registry.list().find((e) => e.id === handle.id)!;
    expect(entry.iterations).toBe(2);
    expect(entry.tokens).toBe(30);
    expect(registry.poll(handle.id, {})!.output).toContain("second");
  });

  it("never lets a forwarded iteration count rewind", () => {
    const registry = make();
    const handle = registry.register({ ...child("run_2").registration, kind: "leader" })!;
    handle.ingest(leadEvent(5, "late"));
    handle.ingest(leadEvent(2, "early"));
    expect(registry.list()[0]!.iterations).toBe(5);
  });

  it("flips a child between waiting and running, and ignores it once settled", () => {
    const registry = make();
    const handle = registry.register(child("a").registration)!;

    handle.waiting("elicitation");
    expect(registry.list()[0]!.status).toBe("waiting");

    handle.waiting(null);
    expect(registry.list()[0]!.status).toBe("running");

    handle.settled({ status: "completed", result: "done" });
    handle.waiting("elicitation");
    expect(registry.list()[0]!.status).toBe("completed");
  });

  it("logs an adopted task's rejection instead of letting it escape", async () => {
    const lines: string[] = [];
    const registry = createAgentRegistry({
      limits: LIMITS,
      logger: debugLogger(lines),
    });
    const handle = registry.register(child("a").registration)!;

    registry.adopt(handle.id, Promise.reject(new Error("child blew up")));
    await registry.teardown(50);

    expect(lines).toContain("agents: background child task rejected");
  });

  it("still settles a child whose stop port throws", () => {
    const lines: string[] = [];
    const registry = createAgentRegistry({
      limits: LIMITS,
      logger: debugLogger(lines),
    });
    const handle = registry.register({
      ...child("a").registration,
      control: {
        stop: () => {
          throw new Error("port is gone");
        },
        steer: () => true,
      },
    })!;
    expect(registry.liveIds()).toEqual([handle.id]);

    const result = registry.stop(handle.id, "parent asked");

    expect(result).not.toBeNull();
    expect(result!.already_settled).toBe(false);
    expect(registry.list()[0]!.status).toBe("stopped");
    expect(registry.liveIds()).toEqual([]);
    expect(lines).toContain("a child's stop port threw; the child is settled regardless");
  });
});

describe("agents registry — what an operator is told", () => {
  it("names the reason a spawn was refused, sealed or at capacity", () => {
    const records: LogRecord[] = [];
    const registry = createAgentRegistry({
      limits: { ...LIMITS, maxLiveChildren: 1 },
      logger: recordingLogger(records),
    });

    registry.register(child("a").registration);
    expect(registry.register(child("b").registration)).toBeNull();

    registry.seal();
    expect(registry.register(child("c").registration)).toBeNull();

    const refusals = eventsNamed(records, "agents.spawn_refused");
    expect(refusals.map((r) => r.fields.reason)).toEqual(["at_capacity", "sealed"]);
    expect(refusals[0]!.fields).toMatchObject({
      native_id: "b",
      live: 1,
      max_live_children: 1,
    });
    expect(refusals[0]!.level).toBe("debug");
    expect(refusals[1]!.fields.native_id).toBe("c");
  });

  it("logs a steer the child never received, settled or queue-refused", () => {
    const records: LogRecord[] = [];
    const registry = createAgentRegistry({
      limits: LIMITS,
      logger: recordingLogger(records),
    });
    const settled = registry.register(child("a").registration)!;
    const refusing = registry.register({
      ...child("b").registration,
      control: { stop: () => {}, steer: () => false },
    })!;

    settled.settled({ status: "completed" });
    expect(registry.steer(settled.id, { content: "hi" })).toEqual({
      ok: false,
      status: "completed",
    });
    expect(registry.steer(refusing.id, { content: "hi" })).toEqual({
      ok: false,
      status: "running",
    });

    const refused = eventsNamed(records, "agents.steer_refused");
    expect(refused.map((r) => r.fields.status)).toEqual(["completed", "running"]);
    expect(refused[0]!.fields.agent_id).toBe(settled.id);
    expect(refused[1]!.fields.agent_id).toBe(refusing.id);
  });

  it("does not log a steer that reached its child", () => {
    const records: LogRecord[] = [];
    const registry = createAgentRegistry({ limits: LIMITS, logger: recordingLogger(records) });
    const handle = registry.register(child("a").registration)!;

    expect(registry.steer(handle.id, { content: "hi" })).toEqual({ ok: true, status: "running" });
    expect(eventsNamed(records, "agents.steer_refused")).toEqual([]);
  });

  it("warns once when teardown abandons live children, and says what it dropped", async () => {
    const records: LogRecord[] = [];
    const registry = createAgentRegistry({
      limits: LIMITS,
      logger: recordingLogger(records),
    });
    const spy = child("a");
    const handle = registry.register({
      ...spy.registration,
      control: { ...spy.registration.control, undrained: () => 2 },
    })!;
    registry.adopt(handle.id, new Promise<void>(() => {}));

    const report = await registry.teardown(0);

    expect(report.abandoned).toEqual([handle.id]);
    const warned = eventsNamed(records, "agents.teardown_abandoned");
    expect(warned).toHaveLength(1);
    expect(warned[0]!.level).toBe("warn");
    expect(warned[0]!.fields).toMatchObject({
      abandoned: [handle.id],
      undrained_steers: 2,
      grace_ms: 0,
      tasks: 1,
    });
  });

  it("stays silent when teardown had nothing to abandon", async () => {
    const records: LogRecord[] = [];
    const registry = createAgentRegistry({ limits: LIMITS, logger: recordingLogger(records) });
    const handle = registry.register(child("a").registration)!;
    handle.settled({ status: "completed" });

    await registry.teardown(0);

    expect(eventsNamed(records, "agents.teardown_abandoned")).toEqual([]);
  });

  it("separates a stop port that threw during teardown from an explicit stop", async () => {
    const records: LogRecord[] = [];
    const registry = createAgentRegistry({
      limits: LIMITS,
      logger: recordingLogger(records),
    });
    const throwing = {
      stop: (): never => {
        throw new Error("port is gone");
      },
      steer: (): boolean => true,
    };
    const a = registry.register({ ...child("a").registration, control: throwing })!;
    const b = registry.register({ ...child("b").registration, control: throwing })!;

    registry.stop(a.id, "parent asked");
    await registry.teardown(0);

    const threw = eventsNamed(records, "agents.stop_port_threw");
    expect(threw.map((r) => r.fields.phase)).toEqual(["stop", "teardown"]);
    expect(threw[0]!.fields).toMatchObject({ agent_id: a.id, cause: "port is gone" });
    expect(threw[1]!.fields.agent_id).toBe(b.id);
  });
});
