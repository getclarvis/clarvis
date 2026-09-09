import { afterEach, describe, expect, test } from "bun:test";
import { createLoopController, type LoopController } from "../../src/features/loop/controller.ts";
import { parseLoopCommand } from "../../src/features/loop/parser.ts";
import type {
  LoopBinding,
  LoopTurnCompletion,
  ScheduledTurnRequest,
} from "../../src/core/loop-schedule.ts";

import { TestLoopClock } from "../helpers/loop-clock.ts";

const MINUTE = 60_000;

const hosts: LoopController[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts.length = 0;
});

function fixture() {
  const clock = new TestLoopClock();
  let binding: LoopBinding | null = {
    sessionId: "session_a",
    generation: 1,
    owner: "user",
    workspaceId: "ws",
    agentId: "coder",
    configFingerprint: "config_a",
    configLabel: "model a",
  };
  let health: string | null = null;
  let interaction: string | null = null;
  let busy = false;
  let cancelError = false;
  let cancelCalls = 0;
  let materializations = 0;
  const requests: ScheduledTurnRequest[] = [];
  const completions: { resolve(result: LoopTurnCompletion): void; reject(error: Error): void }[] =
    [];
  const notices: string[] = [];
  const host = createLoopController({
    clock,
    binding: (materialize) => {
      if (materialize) materializations++;
      return binding;
    },
    blockedReason: () => health,
    submit: (request) => {
      if (busy) return { status: "deferred", reason: "busy" };
      requests.push(request);
      const completion = new Promise<LoopTurnCompletion>((resolve, reject) => {
        completions.push({ resolve, reject });
      });
      return {
        status: "admitted",
        executionId: `exec_${requests.length}`,
        completion,
        cancel: async () => {
          cancelCalls++;
          if (cancelError) throw new Error("transport lost");
        },
      };
    },
    notice: (message) => {
      notices.push(message);
    },
  });
  hosts.push(host);
  host.setInteractionGate(() => interaction);
  return {
    host,
    clock,
    requests,
    completions,
    notices,
    create: (line = "5m check the PR") => {
      const input = parseLoopCommand(line, "UTC");
      if (input.kind !== "create") throw new Error("fixture requires a registration");
      return host.create(input);
    },
    binding: () => binding,
    setBinding: (value: LoopBinding | null) => {
      binding = value;
      host.refresh();
    },
    health: (value: string | null) => {
      health = value;
      host.refresh();
    },
    interaction: (value: string | null) => {
      interaction = value;
      host.refresh();
    },
    busy: (value: boolean) => {
      busy = value;
      host.refresh();
    },
    cancelError: () => {
      cancelError = true;
    },
    cancelCalls: () => cancelCalls,
    materializations: () => materializations,
    finish: async (
      index = 0,
      result: LoopTurnCompletion = {
        status: "completed",
        usage: { input: 10, output: 2, costUsd: 0.1 },
      },
    ) => {
      completions[index]!.resolve(result);
      await clock.advance(0);
    },
  };
}

test("registration, list and cancellation use no model and keep one cancellable wakeup", async () => {
  const f = fixture();
  const a = f.create();
  f.create("90m second");
  expect(f.host.list()).toHaveLength(2);
  expect(a).toMatchObject({ admittedRuns: 0, nextDueAt: f.clock.now() + 5 * MINUTE, maxRuns: 20 });
  expect(f.materializations()).toBe(2);
  expect(f.clock.wakes.size).toBe(1);
  await f.clock.advance(4 * MINUTE);
  expect(f.requests).toHaveLength(0);
  f.host.cancel(a.id);
  await f.clock.advance(MINUTE);
  expect(f.requests).toHaveLength(0);
  expect(a.state).toBe("cancelled");
});

test("an interval waits after completion, including delayed admission, without replaying missed periods", async () => {
  const f = fixture();
  const start = f.clock.now();
  const job = f.create();
  f.busy(true);
  await f.clock.advance(16 * MINUTE);
  expect(job.pending?.scheduledAt).toBe(start + 5 * MINUTE);
  expect(job.admittedRuns).toBe(0);
  f.busy(false);
  await f.clock.advance(0);
  expect(job.active).toMatchObject({
    scheduledAt: start + 5 * MINUTE,
    admittedAt: start + 16 * MINUTE,
  });
  expect(job.nextDueAt).toBeUndefined();
  await f.clock.advance(2 * MINUTE);
  await f.finish();
  expect(job.nextDueAt).toBe(start + 23 * MINUTE);
  await f.clock.advance(4 * MINUTE);
  expect(f.requests).toHaveLength(1);
  await f.clock.advance(MINUTE);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.occurrenceId).not.toBe(f.requests[0]!.occurrenceId);
});

test("cron coalesces suspension to the latest due minute and keeps calendar timing after completion", async () => {
  const f = fixture();
  const start = f.clock.now();
  const job = f.create('cron "*/5 * * * *" check');
  f.interaction("unsent draft and attachments");
  await f.clock.advance(16 * MINUTE);
  expect(job.pending?.scheduledAt).toBe(start + 15 * MINUTE);
  expect(job.nextDueAt).toBe(start + 20 * MINUTE);
  expect(f.requests).toHaveLength(0);
  f.interaction(null);
  await f.clock.advance(0);
  await f.clock.advance(2 * MINUTE);
  await f.finish();
  expect(job.nextDueAt).toBe(start + 20 * MINUTE);
  await f.clock.advance(2 * MINUTE);
  expect(f.requests).toHaveLength(2);
});

test("oldest pending jobs run serially with stable ties despite cron coalescing", async () => {
  const f = fixture();
  const a = f.create('cron "* * * * *" first');
  const b = f.create("2m second");
  const c = f.create("2m third");
  f.interaction("dialog");
  await f.clock.advance(MINUTE);
  await f.clock.advance(MINUTE);
  await f.clock.advance(10 * MINUTE);
  expect(a.pending?.scheduledAt).toBe(f.clock.now());
  f.interaction(null);
  await f.clock.advance(0);
  expect(f.requests.map((request) => request.prompt)).toEqual(["first"]);
  await f.clock.advance(10 * MINUTE);
  expect(f.requests).toHaveLength(1);
  await f.finish();
  expect(f.requests.map((request) => request.prompt)).toEqual(["first", "second"]);
  expect(b.active).toBeDefined();
  await f.finish(1);
  expect(f.requests.at(-1)!.prompt).toBe("third");
  expect(c.active).toBeDefined();
});

test("elapsed interval duration survives wall-clock changes", async () => {
  const f = fixture();
  const job = f.create();
  await f.clock.advance(4 * MINUTE, -60 * MINUTE);
  expect(f.requests).toHaveLength(0);
  expect(job.nextDueAt).toBe(f.clock.now() + MINUTE);
  await f.clock.advance(MINUTE, 0);
  expect(f.requests).toHaveLength(1);
  await f.finish();
  await f.clock.advance(0, 4 * 60 * MINUTE);
  expect(f.requests).toHaveLength(1);
  await f.clock.advance(5 * MINUTE);
  expect(f.requests).toHaveLength(2);
});

test("moving the calendar backwards cannot admit a cron occurrence twice, including explicit resume", async () => {
  const f = fixture();
  const job = f.create('cron "*/5 * * * *" check');
  await f.clock.advance(5 * MINUTE);
  await f.finish();
  const first = f.requests[0]!.occurrenceId;
  await f.clock.advance(0, -10 * MINUTE);
  f.host.pause(job.id);
  f.host.resume(job.id);
  expect(job.nextDueAt).toBe(Date.parse("2026-01-01T10:10:00Z"));
  await f.clock.advance(10 * MINUTE);
  expect(f.requests).toHaveLength(1);
  await f.clock.advance(5 * MINUTE);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.occurrenceId).not.toBe(first);
});

test.each(["paused", "cancelled"] as const)(
  "%s drops unadmitted work without cancelling an active run",
  async (state) => {
    const f = fixture();
    const job = f.create('cron "* * * * *" check');
    await f.clock.advance(MINUTE);
    await f.clock.advance(MINUTE);
    expect(job.pending).toBeDefined();
    if (state === "paused") f.host.pause(job.id);
    else f.host.cancel(job.id);
    expect(job.state).toBe(state);
    expect(job.active).toBeDefined();
    expect(job.pending).toBeUndefined();
    expect(f.cancelCalls()).toBe(0);
    if (state === "paused") expect(() => f.host.resume(job.id)).toThrow("active execution");
    await f.finish();
    await f.clock.advance(10 * MINUTE);
    expect(f.requests).toHaveLength(1);
    if (state === "paused") {
      f.host.resume(job.id);
      expect(job.nextDueAt).toBe(f.clock.now() + MINUTE);
      await f.clock.advance(MINUTE);
      expect(f.requests).toHaveLength(2);
    }
  },
);

test.each([false, true])(
  "cancel --running retains host ownership after acknowledgement or failure (failure=%s)",
  async (failure) => {
    const f = fixture();
    const a = f.create("1m first");
    f.create("1m second");
    await f.clock.advance(MINUTE);
    if (failure) f.cancelError();
    f.host.cancel(a.id, true);
    await f.clock.advance(0);
    expect(f.cancelCalls()).toBe(1);
    expect(a.active?.cancellation).toBe(failure ? "failed" : "acknowledged");
    expect(f.requests).toHaveLength(1);
    await f.clock.advance(10 * MINUTE);
    expect(f.requests).toHaveLength(1);
    await f.finish();
    expect(a.state).toBe("cancelled");
    expect(a.active).toBeUndefined();
    expect(f.requests[1]!.prompt).toBe("second");
  },
);

test.each(["failed", "cancelled", "unknown"] as const)(
  "a %s run pauses without retry and counts the admitted attempt",
  async (status) => {
    const f = fixture();
    const job = f.create("1m --max-runs 2 -- check");
    await f.clock.advance(MINUTE);
    await f.finish(0, { status, reason: "inspect partial effects", usage: {} });
    expect(job).toMatchObject({
      state: "paused",
      admittedRuns: 1,
      pauseReason: "inspect partial effects",
    });
    expect(job.usage).toEqual({});
    await f.clock.advance(60 * MINUTE);
    expect(f.requests).toHaveLength(1);
    f.host.resume(job.id);
    await f.clock.advance(MINUTE);
    await f.finish(1);
    expect(job).toMatchObject({ state: "completed", admittedRuns: 2 });
    expect(job.usage).toEqual({});
    expect(f.clock.wakes.size).toBe(0);
  },
);

test("a rejected completion remains unknown and cannot silently retry at its limit", async () => {
  const f = fixture();
  const job = f.create("1m --max-runs 1 -- check");
  await f.clock.advance(MINUTE);
  f.completions[0]!.reject(new Error("connection lost"));
  await f.clock.advance(0);
  expect(job).toMatchObject({
    state: "paused",
    admittedRuns: 1,
    lastResult: { status: "unknown" },
  });
  expect(() => f.host.resume(job.id)).toThrow("--max-runs");
});

test("max-runs includes successful attempts and aggregates only measured cost", async () => {
  const f = fixture();
  const job = f.create('cron "* * * * *" --max-runs 2 -- check');
  await f.clock.advance(MINUTE);
  await f.finish();
  await f.clock.advance(MINUTE);
  await f.finish(1, { status: "completed", usage: { input: 5, output: 3 } });
  expect(job.state).toBe("completed");
  expect(job.usage).toEqual({ input: 15, output: 5 });
  expect(job.pending).toBeUndefined();
  await f.clock.advance(10 * MINUTE);
  expect(f.requests).toHaveLength(2);
});

describe("binding and lifetime fences", () => {
  test.each(["generation", "agentId", "configFingerprint", "workspaceId", "owner"] as const)(
    "changing %s pauses and invalidates a reserved callback",
    async (field) => {
      const f = fixture();
      const job = f.create("1m check");
      await f.clock.advance(MINUTE);
      expect(f.requests[0]!.valid()).toBe(true);
      f.setBinding({ ...f.binding()!, [field]: field === "generation" ? 2 : "changed" });
      expect(job.state).toBe("paused");
      expect(f.requests[0]!.valid()).toBe(false);
      await f.finish();
      f.host.resume(job.id);
      expect(job.binding).toEqual(f.binding()!);
      expect(job.nextDueAt).toBe(f.clock.now() + MINUTE);
    },
  );

  test("switching conversations retains paused registrations and requires explicit resume on return", async () => {
    const f = fixture();
    const old = f.binding()!;
    const job = f.create();
    f.busy(true);
    await f.clock.advance(5 * MINUTE);
    f.host.invalidateSession(old.sessionId, "switch");
    f.setBinding({ ...old, sessionId: "session_b", generation: 2 });
    expect(f.host.list()).toEqual([]);
    expect(() => f.host.get(job.id)).toThrow("conversation");
    expect(job.pending).toBeUndefined();
    f.setBinding({ ...old, generation: 3 });
    expect(f.host.list()).toHaveLength(1);
    expect(job.state).toBe("paused");
    await f.clock.advance(100 * MINUTE);
    f.busy(false);
    f.host.resume(job.id);
    await f.clock.advance(0);
    expect(f.requests).toHaveLength(0);
    await f.clock.advance(5 * MINUTE);
    expect(f.requests).toHaveLength(1);
  });

  test("disconnect and a runtime safety block pause, while a human dialog only defers", async () => {
    const f = fixture();
    const job = f.create("1m check");
    f.interaction("elicitation");
    await f.clock.advance(MINUTE);
    expect(job.state).toBe("scheduled");
    expect(job.pending).toBeDefined();
    f.health("disconnected");
    expect(job.state).toBe("paused");
    expect(job.pending).toBeUndefined();
    expect(() => f.host.resume(job.id)).toThrow("disconnected");
    f.health(null);
    f.interaction(null);
    await f.clock.advance(MINUTE);
    expect(f.requests).toHaveLength(0);
    f.host.resume(job.id);
    f.host.setInteractionGate(
      () => null,
      () => "memory admission blocked",
    );
    await f.clock.advance(0);
    expect(job.pauseReason).toContain("memory admission blocked");
  });

  test("clear invalidates registrations and disposal drops timers without pretending a run has closed", async () => {
    const f = fixture();
    const job = f.create("1m check");
    await f.clock.advance(MINUTE);
    f.host.invalidateSession(job.binding.sessionId, "clear");
    expect(job.state).toBe("cancelled");
    expect(f.requests[0]!.valid()).toBe(false);
    expect(() => f.host.resume(job.id)).toThrow("paused");
    f.host.dispose();
    expect(f.clock.wakes.size).toBe(0);
    expect(job.active).toBeDefined();
    await f.finish();
    expect(job.active).toBeUndefined();
    expect(f.clock.wakes.size).toBe(0);
    expect(f.host.list()).toEqual([]);
    expect(() => f.create()).toThrow("closed");
  });
});

test("registration and retained history remain bounded across conversations", () => {
  const f = fixture();
  const jobs = Array.from({ length: 10 }, () => f.create());
  expect(() => f.create()).toThrow("10 live loops");
  f.host.cancel(jobs[0]!.id);
  f.create();
  for (let index = 1; index < 10; index++) {
    f.setBinding({ ...f.binding()!, sessionId: `session_${index}`, generation: index + 1 });
    for (let count = 0; count < 10; count++) f.create();
  }
  f.setBinding({ ...f.binding()!, sessionId: "session_last", generation: 100 });
  expect(() => f.create()).toThrow("100 loops");
  expect(f.requests).toHaveLength(0);
});

test("the controller enforces bounded attempts and prompts even for typed callers", () => {
  const f = fixture();
  const input = {
    kind: "create" as const,
    schedule: { kind: "interval" as const, everyMs: MINUTE, basis: "after-completion" as const },
    prompt: "check",
    maxRuns: 2,
  };
  expect(() => f.host.create({ ...input, maxRuns: 0 })).toThrow("positive");
  expect(() => f.host.create({ ...input, prompt: " " })).toThrow("prompt");
  expect(() => f.host.create({ ...input, prompt: "a".repeat(65_537) })).toThrow("64 KiB");
  expect(() =>
    f.host.create({ ...input, schedule: { ...input.schedule, everyMs: 60_001 } }),
  ).toThrow("duration");
});
