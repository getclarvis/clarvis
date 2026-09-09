import { afterEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type {
  HostedRunRef,
  HostedRunReceipt,
  HostingService,
  MessageContent,
  RunDetail,
  RunResult,
  WorkspaceService,
} from "@clarvis/protocol";
import { createRunHost, type RunHost, type RunHostDeps } from "../../src/run-host.ts";
import { createTranscriptStore, type TranscriptStore } from "../../src/adapters/store.ts";
import { createActivityStore } from "../../src/adapters/activity-store.ts";
import { createElicitSlot } from "../../src/adapters/elicit-slot.ts";
import type { RunHandle, StartRunInput } from "../../src/adapters/run-types.ts";
import type { SessionMeta, SessionStore } from "../../src/adapters/session-store.ts";
import type { LocalBashResult } from "../../src/adapters/local-shell.ts";
import type { SessionId } from "../../src/adapters/session-store.ts";
import type { PromptHistory } from "../../src/core/prompt-history.ts";
import { runEvent } from "../helpers/run-events.ts";
import { MAX_COMPOSER_IMAGE_BYTES } from "../../src/core/attachments.ts";
import type { ScheduledTurnRequest, ScheduledTurnAdmission } from "../../src/core/loop-schedule.ts";
import { hostingFixture } from "../helpers/hosted-run.ts";

const ev = runEvent;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const mountedRoots = new Set<() => void>();

afterEach(() => {
  for (const dispose of mountedRoots) dispose();
  mountedRoots.clear();
});

function fakeHistory(): PromptHistory {
  return {
    push: () => {},
    seed: () => {},
    prev: () => undefined,
    next: () => undefined,
    resetCursor: () => {},
    size: () => 0,
    flush: async () => {},
    persistenceDegraded: () => false,
  };
}

function fakeWorkspaceFiles(): WorkspaceService {
  return {
    listFiles: async () => [],
    readFile: async (path) => ({ path, content: "" }),
    readImage: async (path) => ({ path, mime: "image/png", data: "" }),
  };
}

function fakeSessionStore(): SessionStore {
  const byId = new Map<string, SessionMeta>();
  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    load: async (id) => byId.get(id) ?? null,
    save: (meta) => void byId.set(meta.id, meta),
    delete: (id) => byId.delete(id),
  };
}

interface FakeRun {
  input: StartRunInput;
  handle: RunHandle;
  cancelled: boolean;
  resolve: (envelope: RunResult | undefined) => void;
  reject: (e: unknown) => void;
}

function fakeClient(): {
  client: RunHostDeps["client"];
  runs: FakeRun[];
  steerImpl: { fn: () => Promise<{ status: string }> };
  compactCalls: { executionId: string; request?: string }[];
  compactImpl: { fn: RunHostDeps["client"]["compact"] };
  getRunImpl: { fn: (executionId: string) => Promise<RunDetail | null> };
} {
  const runs: FakeRun[] = [];
  const compactCalls: { executionId: string; request?: string }[] = [];
  const compactImpl: { fn: RunHostDeps["client"]["compact"] } = {
    fn: (input) => Promise.resolve({ status: "queued", execution_id: input.executionId }),
  };
  const steerImpl = { fn: async (): Promise<{ status: string }> => ({ status: "steered" }) };
  const getRunImpl = { fn: async (_executionId: string): Promise<RunDetail | null> => null };
  const start = (input: StartRunInput): RunHandle => {
    let resolve!: FakeRun["resolve"];
    let reject!: FakeRun["reject"];
    const done = new Promise<RunResult | undefined>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const run: FakeRun = {
      input,
      cancelled: false,
      resolve,
      reject,
      handle: {
        executionId: input.executionId ?? "exec_x",
        cancel: () => {
          run.cancelled = true;
          return Promise.resolve();
        },
        done,
        closed: done.then(
          () => undefined,
          () => undefined,
        ),
      },
    };
    runs.push(run);
    return run.handle;
  };
  const client: RunHostDeps["client"] = {
    startRun: (input) => start(input),
    steer: () => steerImpl.fn(),
    compact: (input) => {
      compactCalls.push(input);
      return compactImpl.fn(input);
    },
    getRun: (executionId) => getRunImpl.fn(executionId),
    files: fakeWorkspaceFiles(),
  };
  return { client, runs, steerImpl, compactCalls, compactImpl, getRunImpl };
}

function completed(executionId: string): RunResult {
  return {
    execution_id: executionId,
    status: "completed",
    result: "done!",
    usage: {
      iterations: 1,
      elapsed_ms: 5,
      by_agent: [
        {
          role: "lead",
          model: "m",
          input_tokens: 100,
          output_tokens: 10,
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
    },
  };
}

function schedule(host: RunHost, prompt = "scheduled prompt"): ScheduledTurnRequest {
  return {
    binding: host.scheduledBinding(true)!,
    prompt,
    occurrenceId: crypto.randomUUID(),
    valid: () => true,
  };
}

function admitted(
  receipt: ScheduledTurnAdmission,
): Extract<ScheduledTurnAdmission, { status: "admitted" }> {
  expect(receipt.status).toBe("admitted");
  if (receipt.status !== "admitted") throw new Error(receipt.reason);
  return receipt;
}

function persisted(executionId: string, result = completed(executionId)): RunDetail {
  return {
    execution_id: executionId,
    status: result.status,
    created_at: 1,
    ended_at: 2,
    messages: [],
    events: [],
    result,
  };
}

test("scheduledBinding materializes a stable conversation without a turn, transcript or model call", () => {
  const sessions = fakeSessionStore();
  const { host, store, runs } = mount({ sessionStore: sessions });
  expect(host.scheduledBinding()).toBeNull();
  const first = host.scheduledBinding(true)!;
  expect(host.scheduledBinding(true)).toEqual(first);
  expect(host.sessionMeta()?.turns).toEqual([]);
  expect(sessions.list()).toHaveLength(1);
  expect(store.nodes).toEqual([]);
  expect(runs).toEqual([]);
});

test("automatic admission reserves before preparation and never converts a concurrent occurrence to steer", async () => {
  const { host, runs, steerImpl, getRunImpl } = mount();
  getRunImpl.fn = async (id) => persisted(id);
  let steers = 0;
  steerImpl.fn = async () => {
    steers++;
    return { status: "steered" };
  };
  const first = admitted(host.submitScheduledTurn(schedule(host, "/quit !echo literal  ")));
  expect(host.scheduledBusy()).toBe(true);
  expect(host.submitScheduledTurn(schedule(host)).status).toBe("deferred");
  expect(host.runBangCommand("echo busy")).toBe(false);
  await host.compactCurrentRun();
  await flush();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.input.messages).toEqual([{ role: "user", content: "/quit !echo literal  " }]);
  expect(steers).toBe(0);
  runs[0]!.resolve(completed(first.executionId));
  expect(await first.completion).toMatchObject({
    status: "completed",
    usage: { input: 100, output: 10 },
  });
  expect(host.scheduledBusy()).toBe(false);
});

test.each(["reconciliation", "closure"] as const)(
  "scheduled completion waits for both physical closure and reconciliation (last=%s)",
  async (last) => {
    const fake = fakeClient();
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    let reconcile!: (value: RunDetail) => void;
    fake.getRunImpl.fn = () =>
      new Promise((resolve) => {
        reconcile = resolve;
      });
    const { host } = mount({
      client: { ...fake.client, startRun: (input) => ({ ...fake.client.startRun(input), closed }) },
    });
    const receipt = admitted(host.submitScheduledTurn(schedule(host)));
    let settled = false;
    void receipt.completion.then(() => {
      settled = true;
    });
    await flush();
    fake.runs[0]!.resolve(completed(receipt.executionId));
    await flush();
    expect(host.runActive()).toBe(false);
    expect(host.submitScheduledTurn(schedule(host)).status).toBe("deferred");
    if (last === "closure") reconcile(persisted(receipt.executionId));
    else close();
    await flush();
    expect(settled).toBe(false);
    expect(host.scheduledBusy()).toBe(true);
    if (last === "closure") close();
    else reconcile(persisted(receipt.executionId));
    expect((await receipt.completion).status).toBe("completed");
    expect(host.scheduledBusy()).toBe(false);
  },
);

test("a previously received human submission owns asynchronous preparation ahead of an automatic occurrence", async () => {
  const fake = fakeClient();
  let image!: (value: Awaited<ReturnType<WorkspaceService["readImage"]>>) => void;
  fake.client.files.readImage = () =>
    new Promise((resolve) => {
      image = resolve;
    });
  const { host } = mount({ client: fake.client });
  const request = schedule(host);
  const turn = host.submitTurn("human @file.png");
  expect(host.submitScheduledTurn(request).status).toBe("deferred");
  await flush();
  image({ path: "file.png", mime: "image/png", data: "AA==" });
  await flush();
  expect(fake.runs).toHaveLength(1);
  fake.runs[0]!.resolve(completed(fake.runs[0]!.handle.executionId));
  await turn;
});

test("human input after automatic reservation waits for its handle and then follows normal steer semantics", async () => {
  const fake = fakeClient();
  let image!: (value: Awaited<ReturnType<WorkspaceService["readImage"]>>) => void;
  fake.client.files.readImage = () =>
    new Promise((resolve) => {
      image = resolve;
    });
  let steers = 0;
  fake.steerImpl.fn = async () => {
    steers++;
    return { status: "steered" };
  };
  fake.getRunImpl.fn = async (id) => persisted(id);
  const { host } = mount({ client: fake.client });
  const receipt = admitted(host.submitScheduledTurn(schedule(host, "automatic @file.png")));
  const human = host.submitTurn("human follow-up");
  await flush();
  expect(fake.runs).toHaveLength(0);
  expect(steers).toBe(0);
  image({ path: "file.png", mime: "image/png", data: "AA==" });
  await human;
  expect(fake.runs).toHaveLength(1);
  expect(steers).toBe(1);
  fake.runs[0]!.resolve(completed(receipt.executionId));
  await receipt.completion;
});

test.each(["session", "configuration", "permission", "cancel"] as const)(
  "automatic preparation revalidates %s after image I/O without restoring a human draft",
  async (change) => {
    const fake = fakeClient();
    let image!: (value: Awaited<ReturnType<WorkspaceService["readImage"]>>) => void;
    fake.client.files.readImage = () =>
      new Promise((resolve) => {
        image = resolve;
      });
    let fingerprint = "config_a";
    let permission: string | null = null;
    const { host, store } = mount({
      client: fake.client,
      executionConfiguration: () => ({ fingerprint, label: "model" }),
      scheduledBlockedReason: () => permission,
    });
    const restores: string[] = [];
    host.registerDraftRestore((value) => {
      restores.push(value);
    });
    const request = schedule(host, "automatic @file.png");
    const receipt = admitted(host.submitScheduledTurn(request));
    await flush();
    if (change === "session") host.clearSession();
    if (change === "configuration") fingerprint = "config_b";
    if (change === "permission") permission = "revoked";
    if (change === "cancel") await receipt.cancel();
    image({ path: "file.png", mime: "image/png", data: "AA==" });
    expect((await receipt.completion).status).not.toBe("completed");
    expect(fake.runs).toHaveLength(0);
    expect(store.nodes).toHaveLength(0);
    expect(restores).toEqual([]);
    if (change === "session" || change === "configuration")
      expect(host.submitScheduledTurn(request).status).toBe("refused");
  },
);

test("an automatic prompt preparation error is a failed attempt and never overwrites the composer", async () => {
  const fake = fakeClient();
  fake.client.files.readImage = async () => {
    throw new Error("cannot read image");
  };
  const { host } = mount({ client: fake.client });
  let restores = 0;
  host.registerDraftRestore(() => {
    restores++;
  });
  const receipt = admitted(host.submitScheduledTurn(schedule(host, "@file.png")));
  expect((await receipt.completion).status).toBe("failed");
  expect(restores).toBe(0);
  expect(fake.runs).toHaveLength(0);
});

test("scheduled cancellation only targets its own physical handle, even after a newer human turn starts", async () => {
  const fake = fakeClient();
  fake.getRunImpl.fn = async (id) => persisted(id);
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  let starts = 0;
  const { host } = mount({
    client: {
      ...fake.client,
      startRun: (input) => {
        const handle = fake.client.startRun(input);
        return ++starts === 1 ? { ...handle, closed } : handle;
      },
    },
  });
  const receipt = admitted(host.submitScheduledTurn(schedule(host)));
  await flush();
  fake.runs[0]!.resolve(completed(receipt.executionId));
  await flush();
  const human = host.submitTurn("next human turn");
  await flush();
  expect(fake.runs).toHaveLength(2);
  await receipt.cancel();
  expect(fake.runs[0]!.cancelled).toBe(true);
  expect(fake.runs[1]!.cancelled).toBe(false);
  expect(host.scheduledBusy()).toBe(true);
  close();
  await receipt.completion;
  expect(host.scheduledBusy()).toBe(true);
  fake.runs[1]!.resolve(completed(fake.runs[1]!.handle.executionId));
  await human;
  expect(host.scheduledBusy()).toBe(false);
});

test("a failed Ctrl-C request still pauses the recurrence when its run eventually finishes", async () => {
  const { host, runs, getRunImpl } = mount();
  getRunImpl.fn = async (id) => persisted(id);
  const receipt = admitted(host.submitScheduledTurn(schedule(host)));
  await flush();
  runs[0]!.handle.cancel = async () => {
    throw new Error("cancel transport failed");
  };
  expect(host.cancelCurrentRun()).toBe(true);
  await flush();
  expect(host.runActive()).toBe(true);
  runs[0]!.resolve(completed(receipt.executionId));
  expect((await receipt.completion).status).toBe("cancelled");
});

test("late completion from a cleared conversation cannot cancel a new conversation's elicitation", async () => {
  const elicit = createElicitSlot();
  const { host, runs } = mount({ elicit });
  const receipt = admitted(host.submitScheduledTurn(schedule(host)));
  await flush();
  host.clearSession();
  const question = elicit.ask({
    message: "new conversation approval",
    requestedSchema: { type: "object", properties: {} },
  });
  runs[0]!.resolve(completed(receipt.executionId));
  await receipt.completion;
  expect(elicit.request()?.message).toBe("new conversation approval");
  elicit.cancelPending();
  await question;
});

test("late steer failure from a cleared conversation cannot restore its draft or status", async () => {
  const { host, runs, steerImpl } = mount();
  const first = host.submitTurn("first");
  await flush();
  let fail!: (error: Error) => void;
  steerImpl.fn = () =>
    new Promise((_resolve, reject) => {
      fail = reject;
    });
  const steer = host.submitTurn("old human draft");
  await flush();
  let restores = 0;
  host.registerDraftRestore(() => {
    restores++;
  });
  host.clearSession();
  fail(new Error("late transport failure"));
  await steer;
  expect(restores).toBe(0);
  expect(host.runStatus()).toBe("idle");
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await first;
});

test("hosted shell reserves before spawn and shutdown waits for output persistence and release", async () => {
  const trace: string[] = [];
  const admitted = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<LocalBashResult>();
  const persisted = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const byId = new Map<string, SessionMeta>();
  const sessions: SessionStore = {
    list: () => [...byId.values()],
    get: (id) => byId.get(id) ?? null,
    load: async (id) => structuredClone(byId.get(id) ?? null),
    save(meta) {
      byId.set(meta.id, {
        ...structuredClone(meta),
        revision: (byId.get(meta.id)?.revision ?? 0) + 1,
      });
    },
    delete: (id) => byId.delete(id),
    flushPending: async () => {
      if ([...byId.values()].some((meta) => (meta.pending?.length ?? 0) > 0)) {
        trace.push("persist");
        await persisted.promise;
      }
    },
  };
  const { service } = hostingFixture({
    reserveActivity: async (sessionId, kind) => {
      expect(byId.has(sessionId)).toBe(true);
      trace.push("reserve");
      await admitted.promise;
      return { lease_id: "shell-lease", session_id: sessionId, host_generation: "host", kind };
    },
    releaseActivity: async (id) => {
      expect(id).toBe("shell-lease");
      trace.push("release");
      await released.promise;
    },
  });
  const fake = fakeClient();
  const { host } = mount({
    sessionStore: sessions,
    client: { ...fake.client, hosting: service },
    runBash: (_command, options) => {
      trace.push("spawn");
      signal = options.signal;
      return finished.promise;
    },
  });
  expect(host.runBangCommand("local check")).toBe(true);
  await flush();
  expect(trace).toEqual(["reserve"]);
  expect(host.scheduledBusy()).toBe(true);
  admitted.resolve();
  await flush();
  expect(trace).toEqual(["reserve", "spawn"]);
  let stopped = false;
  const stopping = host.stopLocalWork().then(() => {
    stopped = true;
  });
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(false);
  finished.resolve({
    exitCode: null,
    stdout: "local output",
    stderr: "",
    signal: "SIGTERM",
    timedOut: false,
    cancelled: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  });
  await flush();
  expect(trace).toEqual(["reserve", "spawn", "persist"]);
  expect(host.physicalWorkActive()).toBe(true);
  persisted.resolve();
  await flush();
  expect(trace).toEqual(["reserve", "spawn", "persist", "release"]);
  expect(stopped).toBe(false);
  released.resolve();
  await stopping;
  expect(host.scheduledBusy()).toBe(false);
  expect(host.sessionMeta()!.pending?.[0]?.content).toContain("local output");
  expect(fake.runs).toHaveLength(0);
});

test("refused hosted shell admission settles its transcript without starting a process", async () => {
  const sessions = fakeSessionStore();
  const save = sessions.save.bind(sessions);
  sessions.save = (meta) => save({ ...meta, revision: 1 });
  let spawns = 0;
  const { service } = hostingFixture({
    reserveActivity: async () => {
      throw new Error("conversation occupied elsewhere");
    },
  });
  const { host, store } = mount({
    sessionStore: sessions,
    client: { ...fakeClient().client, hosting: service },
    runBash: async () => {
      spawns++;
      throw new Error("must not spawn");
    },
  });
  expect(host.runBangCommand("local check")).toBe(true);
  await flush();
  await host.stopLocalWork();
  await flush();
  expect(spawns).toBe(0);
  expect(host.scheduledBusy()).toBe(false);
  expect(host.runStatus()).toContain("conversation occupied elsewhere");
  expect(store.nodes.some((node) => node.status === "running")).toBe(false);
});

test("bash and unsettled compaction serialize automatic admission", async () => {
  let finishBash!: (result: LocalBashResult) => void;
  const { host, runs, compactImpl } = mount({
    runBash: () =>
      new Promise((resolve) => {
        finishBash = resolve;
      }),
  });
  const request = schedule(host);
  expect(host.runBangCommand("local check")).toBe(true);
  expect(host.submitScheduledTurn(request).status).toBe("deferred");
  finishBash({
    exitCode: 0,
    stdout: "done",
    stderr: "",
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
  });
  await flush();
  const human = host.submitTurn("context");
  await flush();
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await human;
  let finishCompact!: (result: Awaited<ReturnType<RunHostDeps["client"]["compact"]>>) => void;
  compactImpl.fn = () =>
    new Promise((resolve) => {
      finishCompact = resolve;
    });
  const compact = host.compactCurrentRun();
  expect(host.submitScheduledTurn(request).status).toBe("deferred");
  host.onEvent(
    ev({ type: "compaction", operation: "trim", at: 1, agent: "lead", freed_chars: 10 }),
    "live",
  );
  expect(host.scheduledBusy()).toBe(true);
  finishCompact({
    status: "skipped",
    execution_id: runs[0]!.handle.executionId,
    reason: "disabled",
  });
  await compact;
  expect(host.scheduledBusy()).toBe(false);
});

test("unavailable reconciliation or usage pauses without inventing a free run", async () => {
  const { host, runs } = mount();
  const receipt = admitted(host.submitScheduledTurn(schedule(host)));
  await flush();
  runs[0]!.resolve({
    execution_id: receipt.executionId,
    status: "completed",
    usage: { iterations: 1, elapsed_ms: 10, by_agent: [] },
  });
  const result = await receipt.completion;
  expect(result.status).toBe("unknown");
  expect(result.usage).toEqual({});
});

test("a local command detached by clear still blocks automatic admission until its promise settles", async () => {
  let finish!: (result: LocalBashResult) => void;
  const { host } = mount({
    runBash: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  host.runBangCommand("slow local check");
  host.clearSession();
  expect(host.physicalWorkActive()).toBe(true);
  expect(host.submitScheduledTurn(schedule(host)).status).toBe("deferred");
  finish({
    exitCode: 0,
    stdout: "",
    stderr: "",
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    cancelled: true,
  });
  await flush();
  expect(host.physicalWorkActive()).toBe(false);
  expect(host.scheduledBusy()).toBe(false);
  expect(host.runStatus()).toBe("idle");
});

test("a rejected physical closure makes automatic completion unknown and releases its counted lease", async () => {
  const fake = fakeClient();
  fake.getRunImpl.fn = async (id) => persisted(id);
  let rejectClose!: (error: Error) => void;
  const closed = new Promise<void>((_resolve, reject) => {
    rejectClose = reject;
  });
  const { host } = mount({
    client: { ...fake.client, startRun: (input) => ({ ...fake.client.startRun(input), closed }) },
  });
  const receipt = admitted(host.submitScheduledTurn(schedule(host)));
  await flush();
  fake.runs[0]!.resolve(completed(receipt.executionId));
  await flush();
  rejectClose(new Error("stream lost"));
  expect((await receipt.completion).status).toBe("unknown");
  expect(host.scheduledBusy()).toBe(false);
});

test("continuation recovery cannot restart an automatic occurrence after its conversation was cleared", async () => {
  const { host, runs, getRunImpl } = mount();
  getRunImpl.fn = async (id) => persisted(id);
  const human = host.submitTurn("first persisted context");
  await flush();
  const firstId = runs[0]!.handle.executionId;
  runs[0]!.resolve(completed(firstId));
  await human;
  let resolveHistory!: (result: RunDetail) => void;
  getRunImpl.fn = () =>
    new Promise((resolve) => {
      resolveHistory = resolve;
    });
  const receipt = admitted(host.submitScheduledTurn(schedule(host)));
  await flush();
  runs[1]!.resolve({
    execution_id: receipt.executionId,
    status: "failed",
    error: { code: "continuation_unavailable", message: "context pruned" },
  });
  await flush();
  host.clearSession();
  resolveHistory(persisted(firstId));
  await receipt.completion;
  expect(runs).toHaveLength(2);
  expect(host.sessionMeta()).toBeNull();
  expect(host.runStatus()).toBe("idle");
});

function mount(over: Partial<RunHostDeps> = {}): {
  host: RunHost;
  store: TranscriptStore;
  runs: FakeRun[];
  steerImpl: { fn: () => Promise<{ status: string }> };
  compactCalls: { executionId: string; request?: string }[];
  compactImpl: { fn: RunHostDeps["client"]["compact"] };
  getRunImpl: { fn: (executionId: string) => Promise<RunDetail | null> };
  dispose: () => void;
} {
  const { client, runs, steerImpl, compactCalls, compactImpl, getRunImpl } = fakeClient();
  let host!: RunHost;
  let store!: TranscriptStore;
  const dispose = createRoot((d) => {
    store = createTranscriptStore();
    host = createRunHost({
      store,
      activity: createActivityStore(),
      sessionStore: fakeSessionStore(),
      history: fakeHistory(),
      client,
      elicit: createElicitSlot(),
      owner: "test-owner",
      workspace: "/tmp",
      priceFor: () => undefined,
      activeProfile: () => "coder",
      setActiveProfile: () => {},
      guardMode: () => "on",
      judgePayload: () => ({}),
      memoryMode: () => "on",
      ...over,
      project: over.project ?? "prj_test",
      workspaceId: over.workspaceId ?? "ws_test",
    });
    return d;
  });
  let disposed = false;
  const trackedDispose = (): void => {
    if (disposed) return;
    disposed = true;
    mountedRoots.delete(trackedDispose);
    dispose();
  };
  mountedRoots.add(trackedDispose);
  return {
    host,
    store,
    runs,
    steerImpl,
    compactCalls,
    compactImpl,
    getRunImpl,
    dispose: trackedDispose,
  };
}

function mountHosted(policy: HostedRunRef["disconnect_policy"] = "continue") {
  const fake = fakeClient();
  const handle = fake.client.startRun({ executionId: "exec_hosted" });
  const run = fake.runs[0]!;
  const meta: SessionMeta = {
    id: "session-hosted",
    revision: 2,
    title: "Hosted conversation",
    owner: "test-owner",
    projectId: "prj_test",
    workspace: "ws_test",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        kind: "conversation",
        executionId: handle.executionId,
        userPreview: "Existing prompt",
        status: "running",
      },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  const ref: HostedRunRef = {
    execution_id: handle.executionId,
    session_id: meta.id,
    workspace_id: meta.workspace,
    host_generation: "generation",
    title: meta.title,
    config: { agent: "coder" },
    created_at: 1,
    updated_at: 1,
    revision: 1,
    control_epoch: 1,
    control: "available",
    disconnect_policy: policy,
    execution_state: "running",
    attention: "none",
  };
  const calls = { attaches: 0, releases: 0, retired: [] as string[], hostCancels: 0, writes: 0 };
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected hosting call");
  };
  const hosting: HostingService = {
    controlObservation: unexpected,
    resolveRecovery: unexpected,
    list: async () => [ref],
    start: unexpected,
    attach: unexpected,
    detach: unexpected,
    receipt: unexpected,
    readSnapshot: unexpected,
    releaseSnapshot: unexpected,
    releaseObservation: unexpected,
    async closeSession(id) {
      calls.retired.push(id);
      if (policy === "cancel") calls.hostCancels++;
    },
    acknowledge: unexpected,
    reserveActivity: unexpected,
    releaseActivity: unexpected,
  };
  const sessions: SessionStore = {
    list: () => [structuredClone(meta)],
    get: () => structuredClone(meta),
    load: async () => structuredClone(meta),
    save() {
      calls.writes++;
    },
    delete: () => false,
  };
  const mounted = mount({
    sessionStore: sessions,
    client: {
      ...fake.client,
      hosting,
      attachRun() {
        calls.attaches++;
        return {
          ...handle,
          acquireControl: (control) =>
            hosting.controlObservation("existing-observation", control).then(() => undefined),
          async releaseObservation() {
            calls.releases++;
            run.reject(new Error("observation released"));
          },
        };
      },
    },
  });
  return { ...mounted, calls, ref, meta, sessions, run, hosting };
}

test("resume refuses an unknown hosted outcome without treating its trace as an ordinary continuation", async () => {
  const f = mountHosted();
  f.ref.execution_state = "unknown";
  await f.host.resumeSessionById(f.meta.id);
  expect(f.calls.attaches).toBe(0);
  expect(f.host.sessionMeta()).toBeNull();
  expect(f.host.runStatus()).toContain("unknown outcome");
  expect(f.host.runStatus()).toContain("/background list");
  expect(f.host.scheduledBusy()).toBe(false);
  f.run.resolve(completed(f.ref.execution_id));
});

test("an acknowledged recovery archive cannot resume inference through its saved session", async () => {
  const f = mountHosted();
  f.hosting.list = async () => [];
  f.meta.turns[0]!.recoveryResolution = {
    kind: "operator_verified_physical_closure",
    previous_host_generation: "old",
    resolving_host_generation: "new",
    operator_connection_id: "operator",
    resolved_at: 20,
  };
  await f.host.resumeSessionById(f.meta.id);
  expect(f.calls.attaches).toBe(0);
  expect(f.host.sessionMeta()).toBeNull();
  expect(f.host.runStatus()).toContain("archived after recovery");
  expect(f.host.scheduledBusy()).toBe(false);
  f.run.resolve(completed(f.ref.execution_id));
});

test("takes control of an already observed run while retaining its session and stream", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref, "observe");
  await flush();
  const session = f.host.sessionMeta()?.id;
  const modes: string[] = [];
  f.hosting.controlObservation = async (id, control) => {
    expect(id).toBe("existing-observation");
    modes.push(control);
    return { ...f.ref, control: "self", control_epoch: 2 };
  };
  await f.host.attachHostedRun(f.ref, "takeover");
  expect(modes).toEqual(["takeover"]);
  expect(f.calls.attaches).toBe(1);
  expect(f.calls.releases).toBe(0);
  expect(f.calls.retired).toEqual([]);
  expect(f.calls.writes).toBe(0);
  expect(f.host.sessionMeta()?.id).toBe(session);
  expect(f.host.runStatus()).toBe("controlling hosted run");
  f.host.teardownRuns();
  await observing;
});

test.each(["continue", "cancel"] as const)(
  "hosted teardown leaves the %s disconnect policy to the host and releases only its observation",
  async (policy) => {
    const f = mountHosted(policy);
    const observing = f.host.attachHostedRun(f.ref);
    await flush();
    expect(f.host.runActive()).toBe(true);
    expect(f.host.continuesOnExit()).toBe(policy === "continue");
    expect(f.calls.attaches).toBe(1);
    expect(f.host.sessionMeta()!.turns).toHaveLength(1);
    f.host.teardownRuns();
    await observing;
    expect(f.calls.retired).toEqual([f.meta.id]);
    expect(f.calls.releases).toBe(1);
    expect(f.calls.hostCancels).toBe(policy === "cancel" ? 1 : 0);
    expect(f.run.cancelled).toBe(false);
    expect(f.host.physicalWorkActive()).toBe(false);
    expect(f.host.continuesOnExit()).toBe(false);
    expect(f.calls.writes).toBe(0);
  },
);

test("an explicit cancel still controls an attached background run", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  expect(f.host.cancelCurrentRun()).toBe(true);
  expect(f.run.cancelled).toBe(true);
  f.host.teardownRuns();
  await observing;
  expect(f.calls.writes).toBe(0);
});

test("background handoff waits for its receipt and releases observation without cancelling work", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  const committed = Promise.withResolvers<HostedRunReceipt>();
  let input: Parameters<HostingService["detach"]>[0] | undefined;
  f.hosting.detach = (request) => {
    input = request;
    return committed.promise;
  };
  const handoff = f.host.backgroundCurrentRun();
  expect(f.host.backgroundCurrentRun()).toBe(handoff);
  await flush();
  expect(f.host.runActive()).toBe(true);
  expect(f.calls.releases).toBe(0);
  expect(input).toMatchObject({
    execution_id: f.ref.execution_id,
    host_generation: f.ref.host_generation,
    revision: f.ref.revision,
    control_epoch: f.ref.control_epoch,
  });
  const receipt = { operation_id: input!.operation_id, run: f.ref, committed_at: 10 };
  committed.resolve(receipt);
  expect(await handoff).toEqual(receipt);
  await observing;
  expect(f.calls.releases).toBe(1);
  expect(f.run.cancelled).toBe(false);
  expect(f.host.runStatus()).toBe("run continues in background");
  expect(f.calls.writes).toBe(0);
});

test("a lost handoff reply is reconciled by operation id and never repeats the mutation", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  let receipt: HostedRunReceipt | null = null;
  let detachCalls = 0;
  f.hosting.detach = async (request) => {
    detachCalls++;
    receipt = { operation_id: request.operation_id, run: f.ref, committed_at: 10 };
    throw new Error("connection lost after commit");
  };
  f.hosting.receipt = async () => null;
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow("connection lost after commit");
  expect(f.calls.releases).toBe(0);
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow("handoff is unconfirmed");
  f.hosting.receipt = async (id) => {
    expect(id).toBe(receipt!.operation_id);
    return receipt;
  };
  expect(await f.host.backgroundCurrentRun()).toEqual(receipt!);
  await observing;
  expect(detachCalls).toBe(1);
  expect(f.calls.releases).toBe(1);
  expect(f.run.cancelled).toBe(false);
});

test("a definitive handoff refusal permits a fresh operation after the cause is resolved", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  const operations: string[] = [];
  f.hosting.detach = async (request) => {
    operations.push(request.operation_id);
    if (operations.length === 1)
      throw Object.assign(new Error("refresh before handoff"), {
        code: "conflict",
        details: { handoff: { operation_id: request.operation_id, admission: "refused" } },
      });
    return { operation_id: request.operation_id, run: f.ref, committed_at: 10 };
  };
  f.hosting.receipt = async () => null;
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow("refresh before handoff");
  expect(f.calls.releases).toBe(0);
  const receipt = await f.host.backgroundCurrentRun();
  expect(operations).toHaveLength(2);
  expect(operations[0]).not.toBe(operations[1]);
  expect(receipt.operation_id).toBe(operations[1]!);
  await observing;
  expect(f.calls.releases).toBe(1);
  expect(f.run.cancelled).toBe(false);
});

test("a conflict with uncertain admission retains its identity and never repeats detach", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  let calls = 0;
  f.hosting.detach = async (request) => {
    calls++;
    throw Object.assign(new Error("handoff outcome unknown"), {
      code: "conflict",
      details: { handoff: { operation_id: request.operation_id, admission: "uncertain" } },
    });
  };
  f.hosting.receipt = async () => null;
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow("handoff outcome unknown");
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow("handoff is unconfirmed");
  expect(calls).toBe(1);
  f.host.teardownRuns();
  await observing;
});

test("handoff reconciles an immediately readable receipt after its acknowledgement is lost", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  let receipt: HostedRunReceipt | null = null;
  f.hosting.detach = async (request) => {
    receipt = { operation_id: request.operation_id, run: f.ref, committed_at: 10 };
    throw new Error("lost acknowledgement");
  };
  f.hosting.receipt = async () => receipt;
  expect(await f.host.backgroundCurrentRun()).toEqual(receipt!);
  await observing;
  expect(f.run.cancelled).toBe(false);
});

test("a conversation change during a committed handoff cannot close the new TUI conversation", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  const committed = Promise.withResolvers<HostedRunReceipt>();
  let operationId = "";
  f.hosting.detach = (input) => {
    operationId = input.operation_id;
    return committed.promise;
  };
  const handoff = f.host.backgroundCurrentRun();
  const rejected = handoff.then(
    () => null,
    (error: unknown) => error,
  );
  await flush();
  f.host.clearSession();
  committed.resolve({ operation_id: operationId, run: f.ref, committed_at: 10 });
  expect(await rejected).toMatchObject({
    message: expect.stringContaining("conversation changed, so this TUI remains open"),
  });
  await observing;
  expect(f.host.sessionMeta()).toBeNull();
  expect(f.run.cancelled).toBe(false);
});

test("background refuses a stale workspace binding before requesting a handoff", async () => {
  const f = mountHosted();
  const observing = f.host.attachHostedRun(f.ref);
  await flush();
  f.hosting.list = async () => [{ ...f.ref, workspace_id: "another-workspace" }];
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow(
    "conversation changed before background",
  );
  expect(f.calls.releases).toBe(0);
  f.host.teardownRuns();
  await observing;
  await expect(f.host.backgroundCurrentRun()).rejects.toThrow("there is no hosted run");
});

test("a delayed hosted attach cannot replace a conversation cleared while its metadata loads", async () => {
  const f = mountHosted();
  const loading = Promise.withResolvers<SessionMeta>();
  f.sessions.load = () => loading.promise;
  const observing = f.host.attachHostedRun(f.ref);
  f.host.clearSession();
  loading.resolve(structuredClone(f.meta));
  await observing;
  expect(f.calls.attaches).toBe(0);
  expect(f.host.sessionMeta()).toBeNull();
  expect(f.store.nodes).toEqual([]);
  f.run.resolve(undefined);
});

test("happy path: submitTurn wires begin→startRun→sink→endTurn and settles totals once", async () => {
  const { host, store, runs, dispose } = mount();
  expect(host.runStartedAt()).toBeNull();
  const turn = host.submitTurn("do the thing");
  await flush();
  expect(host.runActive()).toBe(true);
  expect(host.runStartedAt()).not.toBeNull();
  expect(host.continuesOnExit()).toBe(false);
  expect(host.sessionUsageBaseline()).toEqual({ input: 0, output: 0, cached: 0 });
  expect(runs.length).toBe(1);
  expect(runs[0]!.input.profile).toBe("coder");
  Object.defineProperty(runs[0]!.handle, "buffered", {
    value: () => ({ buffered_items: 3, buffered_bytes: 144, dropped: 1 }),
  });
  expect(host.memory()).toMatchObject({
    event_queue_items: 3,
    event_queue_bytes: 144,
    event_queue_dropped: 1,
  });
  const msgs = runs[0]!.input.messages!;
  expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "do the thing" });

  host.onEvent(ev({ type: "run_started", at: 0 }), "live");
  host.onEvent(
    ev({
      type: "tool_call_started",
      agent: "lead",
      call_id: "c1",
      at: 1,
      server: "fs",
      tool: "grep",
      arguments: {},
    }),
    "live",
  );
  expect(store.nodes.some((n) => n.kind === "tool_call")).toBe(true);

  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(host.runActive()).toBe(false);
  expect(host.runStatus()).toBe("completed");
  const meta = host.sessionMeta()!;
  expect(meta.turns.length).toBe(1);
  expect(meta.turns[0]!.status).toBe("done");
  expect(meta.totals).toEqual({ input: 100, output: 10, cached: 0 });

  const second = host.submitTurn("continue");
  await flush();
  expect(host.sessionUsageBaseline()).toEqual({ input: 100, output: 10, cached: 0 });
  runs[1]!.resolve(completed(runs[1]!.handle.executionId));
  await second;
  dispose();
});

test("a late event from another execution cannot enter the current run's sink", async () => {
  const { host, store, runs, dispose } = mount();
  const turn = host.submitTurn("current work");
  await flush();
  const executionId = runs[0]!.handle.executionId;

  host.onEvent(
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
    "live",
    "exec_stale",
  );
  expect(store.nodes.some((node) => node.kind === "thinking")).toBe(false);

  host.onEvent(
    ev({ type: "iteration_started", agent: "lead", iteration: 1, at: 1, model: "m" }),
    "live",
    executionId,
  );
  expect(store.nodes.some((node) => node.kind === "thinking")).toBe(true);

  runs[0]!.resolve(completed(executionId));
  await turn;
  dispose();
});

test("live MCP startup failures emit one session notice per server and reason, never on replay", async () => {
  const { host, store, runs, dispose } = mount();
  const turn = host.submitTurn("use available tools");
  await flush();
  const executionId = runs[0]!.handle.executionId;
  const failure = ev({
    type: "mcp_degraded",
    at: 1,
    servers: [{ name: "docs", reason: "missing DOCS_TOKEN" }],
  });

  host.onEvent(failure, "live", executionId);
  expect(host.mcpStartupNotice()).toEqual({
    sequence: 1,
    servers: [{ name: "docs", reason: "missing DOCS_TOKEN" }],
  });
  expect(store.nodes.some((node) => node.text.includes("missing DOCS_TOKEN"))).toBe(false);

  host.onEvent(failure, "live", executionId);
  host.onEvent(
    ev({
      type: "mcp_degraded",
      at: 2,
      servers: [{ name: "browser", reason: "authorization pending" }],
    }),
    "replay",
    executionId,
  );
  expect(host.mcpStartupNotice()?.sequence).toBe(1);

  host.onEvent(
    ev({
      type: "mcp_degraded",
      at: 3,
      servers: [
        { name: "docs", reason: "missing DOCS_TOKEN" },
        { name: "browser", reason: "authorization pending" },
      ],
    }),
    "live",
    executionId,
  );
  expect(host.mcpStartupNotice()).toEqual({
    sequence: 2,
    servers: [{ name: "browser", reason: "authorization pending" }],
  });

  runs[0]!.resolve(completed(executionId));
  await turn;
  dispose();
});

test("done releases interactive ownership before the post-run event stream closes", async () => {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const fake = fakeClient();
  let resolveStored!: (stored: RunDetail | null) => void;
  const stored = new Promise<RunDetail | null>((resolve) => {
    resolveStored = resolve;
  });
  let getRunCalls = 0;
  fake.getRunImpl.fn = () => (++getRunCalls === 1 ? stored : Promise.resolve(null));
  let starts = 0;
  const { host, dispose } = mount({
    client: {
      ...fake.client,
      startRun: (input) => {
        const handle = fake.client.startRun(input);
        starts += 1;
        return starts === 1 ? { ...handle, closed } : handle;
      },
    },
  });

  const firstTurn = host.submitTurn("wait for stream close");
  await flush();
  const firstId = fake.runs[0]!.handle.executionId;
  fake.runs[0]!.resolve(completed(firstId));
  await flush();
  expect(host.runActive()).toBe(false);
  expect(host.ownsExecution(firstId)).toBe(true);
  expect(host.physicalWorkActive()).toBe(true);
  host.onMemoryIngest({ execution_id: firstId, phase: "started" });
  expect(host.runStatus()).toContain("memory: learning");

  const secondTurn = host.submitTurn("this is a new turn, not steering");
  await flush();
  expect(fake.runs).toHaveLength(1);

  resolveStored(null);
  await firstTurn;
  await flush();
  expect(fake.runs).toHaveLength(2);
  expect(host.runActive()).toBe(true);
  fake.runs[1]!.resolve(completed(fake.runs[1]!.handle.executionId));
  await secondTurn;
  expect(host.runActive()).toBe(false);
  expect(host.physicalWorkActive()).toBe(true);

  resolveClosed();
  await flush();
  expect(host.physicalWorkActive()).toBe(false);
  dispose();
});

test("manager profile: submitTurn starts one run and onEvent folds workflow_run_* into workflowActivity", async () => {
  const { host, runs, dispose } = mount({ isManagerProfile: () => true });
  expect(host.workflowActivity()).toBeNull();

  const turn = host.submitTurn("decompose this");
  await flush();
  expect(runs).toHaveLength(1);
  const managerMsgs = runs[0]!.input.messages!;
  expect(managerMsgs[managerMsgs.length - 1]).toEqual({ role: "user", content: "decompose this" });

  const managerId = runs[0]!.handle.executionId;
  host.onEvent(
    ev({
      type: "workflow_run_started",
      run_id: "leader-1",
      parent_run_id: managerId,
      at: 1,
      title: "Research topic",
      task: "research it",
    }),
    "live",
  );
  const started = host.workflowActivity();
  expect(started?.root).toBe(managerId);
  expect(started?.nodes.get(managerId)?.kind).toBe("manager");
  expect(started?.nodes.get("leader-1")?.status).toBe("running");
  host.onEvent(
    ev({
      type: "workflow_title_updated",
      run_id: managerId,
      at: 1,
      title: "Decompose research",
    }),
    "live",
  );
  expect(host.workflowActivity()?.nodes.get(managerId)?.title).toBe("Decompose research");

  host.onEvent(
    ev({
      type: "workflow_run_completed",
      run_id: "leader-1",
      parent_run_id: managerId,
      at: 2,
      status: "completed",
    }),
    "live",
  );
  expect(host.workflowActivity()?.nodes.get("leader-1")?.status).toBe("ok");

  runs[0]!.resolve(completed(managerId));
  await turn;
  // the last workflow's tree is retained after settling, mirroring runStartedAt's
  // "current or last" convention, so a chip can still show the final state.
  expect(host.workflowActivity()?.nodes.get("leader-1")?.status).toBe("ok");
  dispose();
});

test("manager profile: replayed events (rehydration) do not feed workflowActivity, only live ones do", async () => {
  const { host, runs, dispose } = mount({ isManagerProfile: () => true });
  const turn = host.submitTurn("decompose this");
  await flush();
  const managerId = runs[0]!.handle.executionId;

  host.onEvent(
    ev({
      type: "workflow_run_started",
      run_id: "leader-1",
      parent_run_id: managerId,
      at: 1,
      title: "Research topic",
      task: "t",
    }),
    "replay",
  );
  expect(host.workflowActivity()).toBeNull();

  runs[0]!.resolve(completed(managerId));
  await turn;
  dispose();
});

test("a plain (non-manager) run never populates workflowActivity", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("do the thing");
  await flush();
  expect(runs).toHaveLength(1);
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(host.workflowActivity()).toBeNull();
  dispose();
});

test("memory mode: 'off' rides on the run input; 'on' is omitted (server default)", async () => {
  const off = mount({ memoryMode: () => "off" });
  const turnOff = off.host.submitTurn("hi");
  await flush();
  expect(off.runs[0]!.input.memory).toBe("off");
  off.runs[0]!.resolve(completed("exec_1"));
  await turnOff;
  off.dispose();

  const on = mount(); // default deps: memoryMode 'on'
  const turnOn = on.host.submitTurn("hi");
  await flush();
  expect(on.runs[0]!.input.memory).toBeUndefined();
  on.runs[0]!.resolve(completed("exec_2"));
  await turnOn;
  on.dispose();
});

test("memory ingest notices ride the status line: learning… then +counts on the same base", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("hi");
  await flush();
  const executionId = runs[0]!.handle.executionId;
  runs[0]!.resolve(completed(executionId));
  await turn;
  const base = host.runStatus();

  host.onMemoryIngest({ execution_id: executionId, phase: "started" });
  expect(host.runStatus()).toContain("memory: learning");
  host.onMemoryIngest({
    execution_id: executionId,
    phase: "done",
    written: 6,
    deleted: 2,
    skipped: false,
  });
  expect(host.runStatus()).toContain("memory +6 -2");
  expect(host.runStatus().startsWith(base)).toBe(true);
  expect(host.runStatus()).not.toContain("learning");

  host.onMemoryIngest({ execution_id: executionId, phase: "failed", error: "boom" });
  expect(host.runStatus()).toContain("memory index failed");
  dispose();
});

test("memory ingest: a queued phase preserves the base, so a later terminal notice replaces rather than concatenates", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("hi");
  await flush();
  const executionId = runs[0]!.handle.executionId;
  runs[0]!.resolve(completed(executionId));
  await turn;
  const base = host.runStatus();

  host.onMemoryIngest({ execution_id: executionId, phase: "started" });
  host.onMemoryIngest({ execution_id: executionId, phase: "queued" });
  expect(host.runStatus()).toContain("memory: queued");
  expect(host.runStatus().startsWith(base)).toBe(true);

  host.onMemoryIngest({
    execution_id: executionId,
    phase: "done",
    written: 2,
    deleted: 1,
    skipped: false,
  });
  // The terminal notice replaces the whole memory segment; "queued" must not
  // survive as a leftover fragment concatenated before it.
  expect(host.runStatus()).toContain("memory +2 -1");
  expect(host.runStatus()).not.toContain("queued");
  expect(host.runStatus().startsWith(base)).toBe(true);
  dispose();
});

test("memory ingest: queued then blocked replaces cleanly, same as queued then failed", async () => {
  const blocked = mount();
  const blockedTurn = blocked.host.submitTurn("hi");
  await flush();
  const blockedId = blocked.runs[0]!.handle.executionId;
  blocked.runs[0]!.resolve(completed(blockedId));
  await blockedTurn;
  const blockedBase = blocked.host.runStatus();

  blocked.host.onMemoryIngest({ execution_id: blockedId, phase: "started" });
  blocked.host.onMemoryIngest({ execution_id: blockedId, phase: "queued" });
  blocked.host.onMemoryIngest({ execution_id: blockedId, phase: "blocked", note: "no model" });
  expect(blocked.host.runStatus()).toContain("memory: blocked");
  expect(blocked.host.runStatus()).not.toContain("queued");
  expect(blocked.host.runStatus().startsWith(blockedBase)).toBe(true);
  blocked.dispose();

  const failed = mount();
  const failedTurn = failed.host.submitTurn("hi");
  await flush();
  const failedId = failed.runs[0]!.handle.executionId;
  failed.runs[0]!.resolve(completed(failedId));
  await failedTurn;
  const failedBase = failed.host.runStatus();

  failed.host.onMemoryIngest({ execution_id: failedId, phase: "started" });
  failed.host.onMemoryIngest({ execution_id: failedId, phase: "queued" });
  failed.host.onMemoryIngest({ execution_id: failedId, phase: "failed", error: "boom" });
  expect(failed.host.runStatus()).toContain("memory index failed");
  expect(failed.host.runStatus()).not.toContain("queued");
  expect(failed.host.runStatus().startsWith(failedBase)).toBe(true);
  failed.dispose();
});

test("an ingest notice in the settle window is held, then replayed once its run frees the line", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("hi");
  await flush();
  const executionId = runs[0]!.handle.executionId;
  host.onMemoryIngest({ execution_id: executionId, phase: "started" });
  runs[0]!.resolve(completed(executionId));
  await turn;
  expect(host.runStatus()).toContain("completed");
  expect(host.runStatus()).toContain("memory: learning");

  host.onMemoryIngest({
    execution_id: executionId,
    phase: "done",
    written: 2,
    deleted: 1,
    skipped: false,
  });
  expect(host.runStatus()).toContain("memory +2 -1");
  expect(host.runStatus()).not.toContain("learning");
  dispose();
});

test("memory ingest notices stay quiet while another run owns the status line", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("hi");
  await flush();
  const during = host.runStatus();
  host.onMemoryIngest({ execution_id: "exec_prev", phase: "done", written: 3, skipped: false });
  expect(host.runStatus()).toBe(during);
  runs[0]!.resolve(completed("exec_1"));
  await turn;
  dispose();
});

test("a stale terminal notice from an earlier run never clobbers a later run's status", async () => {
  const { host, runs, dispose } = mount();

  // First run finishes and starts learning, but its terminal notice hasn't
  // arrived yet.
  const firstTurn = host.submitTurn("first");
  await flush();
  const firstId = runs[0]!.handle.executionId;
  runs[0]!.resolve(completed(firstId));
  await firstTurn;
  host.onMemoryIngest({ execution_id: firstId, phase: "started" });
  expect(host.runStatus()).toContain("memory: learning");

  // A second run starts before the first run's job ever settles.
  const secondTurn = host.submitTurn("second");
  await flush();
  const secondId = runs[1]!.handle.executionId;
  expect(secondId).not.toBe(firstId);

  // The first run's terminal notice finally arrives late, while the second
  // run is active — it must not touch the status line at all.
  const duringSecond = host.runStatus();
  host.onMemoryIngest({ execution_id: firstId, phase: "done", written: 9, skipped: false });
  expect(host.runStatus()).toBe(duringSecond);

  runs[1]!.resolve(completed(secondId));
  await secondTurn;
  const afterSecond = host.runStatus();
  expect(afterSecond).not.toContain("memory +9");

  // And even once the second run is idle and shows its own memory progress,
  // the first run's stale notice must still never appear.
  host.onMemoryIngest({ execution_id: secondId, phase: "started" });
  expect(host.runStatus()).toContain("memory: learning");
  host.onMemoryIngest({ execution_id: firstId, phase: "done", written: 9, skipped: false });
  expect(host.runStatus()).not.toContain("memory +9");
  expect(host.runStatus()).toContain("memory: learning");
  dispose();
});

test("run error: endTurn still runs (turn marked error, totals untouched), spinners settle", async () => {
  const { host, store, runs, dispose } = mount();
  const turn = host.submitTurn("boom");
  await flush();
  host.onEvent(ev({ type: "run_started", at: 0 }), "live");
  host.onEvent(
    ev({
      type: "tool_call_started",
      agent: "lead",
      call_id: "c1",
      at: 1,
      server: "fs",
      tool: "grep",
      arguments: {},
    }),
    "live",
  );
  runs[0]!.reject(new Error("transport exploded"));
  await turn;
  expect(host.runActive()).toBe(false);
  expect(host.runStatus()).toContain("run error");
  expect(host.runStatus()).toContain("transport exploded");
  const meta = host.sessionMeta()!;
  expect(meta.turns[0]!.status).toBe("error");
  expect(meta.totals).toEqual({ input: 0, output: 0, cached: 0 });
  const tool = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(tool.status).toBe("error");
  dispose();
});

test("esc-cancel: the request acks as 'cancelling…' and only the settle says 'cancelled'", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("long task");
  await flush();
  expect(host.cancelCurrentRun()).toBe(true);
  expect(runs[0]!.cancelled).toBe(true);
  expect(host.runStatus()).toBe("cancelling…");
  expect(host.cancelCurrentRun()).toBe(false);
  expect(host.runStatus()).toBe("cancelling…");
  runs[0]!.reject(new Error("aborted"));
  await turn;
  expect(host.runStatus()).toBe("cancelled");
  expect(host.runActive()).toBe(false);
  dispose();
});

test("esc-cancel: a cancel that lands after the run settles does not relabel it", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("a task that finishes first");
  await flush();
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(host.runActive()).toBe(false);
  const settled = host.runStatus();

  // The race: ^c pressed in the instant the run finished. It used to set
  // `cancelling…` and mark the run cancelled for the rest of the session, with
  // the correct answer already on screen under a completed node.
  expect(host.cancelCurrentRun()).toBe(false);
  expect(host.runStatus()).toBe(settled);
  expect(host.runStatus()).not.toContain("cancel");
  dispose();
});

test("esc-cancel: a transport failure keeps the run active and reports that cancellation failed", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("long task");
  await flush();
  let attempts = 0;
  runs[0]!.handle.cancel = () => {
    attempts += 1;
    return Promise.reject(new Error("cancel endpoint unavailable"));
  };

  expect(host.cancelCurrentRun()).toBe(true);
  expect(host.runStatus()).toBe("cancelling…");
  await flush();
  expect(host.runActive()).toBe(true);
  expect(host.runStatus()).toContain("cancel request failed");
  expect(host.runStatus()).toContain("cancel endpoint unavailable");
  expect(host.cancelCurrentRun()).toBe(true);
  expect(attempts).toBe(2);

  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  dispose();
});

test("compactCurrentRun queues on a live run and compacts the latest settled context", async () => {
  const { host, runs, compactCalls, compactImpl, dispose } = mount();
  await host.compactCurrentRun("ignored while idle");
  expect(compactCalls).toEqual([]);
  expect(host.runStatus()).toBe("no session context to compact");

  const turn = host.submitTurn("long task");
  await flush();
  await host.compactCurrentRun("  keep auth context  ");
  expect(compactCalls).toEqual([
    { executionId: runs[0]!.handle.executionId, request: "keep auth context" },
  ]);
  expect(host.runStatus()).toContain("compaction queued");
  expect(host.runStatus()).toContain("before the next model call");
  expect(host.compactionActive()).toBe(false);

  host.onEvent(
    ev({
      type: "compaction_started",
      at: 1,
      agent: "lead",
      mode: "forced",
    }),
    "live",
    runs[0]!.handle.executionId,
  );
  expect(host.compactionActive()).toBe(true);
  host.onEvent(
    ev({
      type: "compaction",
      at: 2,
      agent: "lead",
      operation: "summarization",
      requested: true,
    }),
    "live",
    runs[0]!.handle.executionId,
  );
  expect(host.compactionActive()).toBe(false);

  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  let resolveCompact!: (result: Awaited<ReturnType<RunHostDeps["client"]["compact"]>>) => void;
  compactImpl.fn = () => new Promise((resolve) => void (resolveCompact = resolve));
  const compact = host.compactCurrentRun("  keep decisions  ");
  expect(host.compactionActive()).toBe(true);
  resolveCompact({
    status: "compacted",
    execution_id: runs[0]!.handle.executionId,
    freed_chars: 1234,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cached_tokens: 0,
      cache_write_tokens: 0,
    },
  });
  await compact;
  expect(host.compactionActive()).toBe(false);
  expect(compactCalls.at(-1)).toEqual({
    executionId: runs[0]!.handle.executionId,
    request: "keep decisions",
  });
  expect(host.runStatus()).toContain("context compacted");
  expect(host.runStatus()).toContain("1,234 chars freed for the next run");
  dispose();
});

test("context inspection and mechanical fitting target the current conversation", async () => {
  const external = fakeClient();
  const contextCalls: Array<[string, number | undefined]> = [];
  const { host, dispose } = mount({ client: external.client });

  expect(host.inspectCurrentContext(4096)).toBeNull();
  expect(await host.fitCurrentContext(4096)).toBeNull();

  const turn = host.submitTurn("large context");
  await flush();
  const executionId = external.runs[0]!.handle.executionId;
  expect(host.inspectCurrentContext(4096)).toBeNull();

  Object.defineProperty(external.client, "context", {
    value: (id: string, target: number | undefined) => {
      contextCalls.push([id, target]);
      return Promise.resolve({
        execution_id: id,
        estimated_tokens: 5000,
        has_context: true,
        requires_compaction: true,
      });
    },
  });
  await expect(host.inspectCurrentContext(4096)).resolves.toMatchObject({
    execution_id: executionId,
    requires_compaction: true,
  });
  expect(contextCalls).toEqual([[executionId, 4096]]);

  await expect(host.fitCurrentContext(4096)).resolves.toMatchObject({ status: "queued" });
  expect(external.compactCalls.at(-1) as unknown).toEqual({
    executionId,
    mechanicalTargetTokens: 4096,
  });

  external.runs[0]!.resolve(completed(executionId));
  await turn;
  dispose();
});

test("cancelling a ! job acks the request and settles as '! cancelled'", async () => {
  const hangingBash: RunHostDeps["runBash"] = (_cmd, opts) =>
    new Promise<LocalBashResult>((resolve) => {
      opts.signal?.addEventListener("abort", () =>
        resolve({
          exitCode: null,
          stdout: "",
          stderr: "",
          signal: "SIGTERM",
          timedOut: false,
          cancelled: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
        }),
      );
    });
  const { host, dispose } = mount({ runBash: hangingBash });
  expect(host.runBangCommand("sleep 999")).toBe(true);
  expect(host.cancelCurrentRun()).toBe(true);
  expect(host.runStatus()).toBe("! cancelling…");
  expect(host.cancelCurrentRun()).toBe(false);
  await flush();
  expect(host.runStatus()).toBe("! cancelled");
  expect(host.bashActive()).toBe(false);
  dispose();
});

test("clearSession during an active run: cancels it, runActive false, no orphan nodes from late events", async () => {
  const { host, store, runs, dispose } = mount();
  const turn = host.submitTurn("stream a lot");
  await flush();
  host.onEvent(ev({ type: "run_started", at: 0 }), "live");
  expect(store.nodes.length).toBeGreaterThan(0);

  host.clearSession();
  expect(runs[0]!.cancelled).toBe(true);
  expect(host.runActive()).toBe(false);
  expect(store.nodes.length).toBe(0);
  expect(host.sessionMeta()).toBeNull();

  host.onEvent(
    ev({
      type: "tool_call_started",
      agent: "lead",
      call_id: "late",
      at: 2,
      server: "fs",
      tool: "grep",
      arguments: {},
    }),
    "live",
  );
  expect(store.nodes.length).toBe(0);

  runs[0]!.reject(new Error("aborted"));
  await turn;
  expect(store.nodes.length).toBe(0);
  expect(host.runActive()).toBe(false);
  dispose();
});

test("forced teardown releases its physical lease when the detached handle close rejects", async () => {
  let resolveDone!: (result: RunResult) => void;
  let rejectClosed!: (error: Error) => void;
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve;
  });
  const closed = new Promise<void>((_resolve, reject) => {
    rejectClosed = reject;
  });
  const base = fakeClient().client;
  const client: RunHostDeps["client"] = {
    ...base,
    startRun: (input) => ({
      executionId: input.executionId ?? "exec_physical",
      cancel: async () => {},
      done,
      closed,
    }),
  };
  const { host, dispose } = mount({ client });

  const turn = host.submitTurn("detach me");
  await flush();
  expect(host.physicalWorkActive()).toBe(true);
  host.teardownRuns();
  expect(host.runActive()).toBe(false);
  expect(host.physicalWorkActive()).toBe(true);

  resolveDone(completed("exec_physical"));
  await flush();
  expect(host.physicalWorkActive()).toBe(true);
  expect(host.memory()).toMatchObject({ physical_run_handles: 1 });
  rejectClosed(new Error("post-run stream close failed"));
  await turn;
  await flush();
  expect(host.physicalWorkActive()).toBe(false);
  expect(host.memory()).toMatchObject({ physical_run_handles: 0 });
  dispose();
});

test("clearSession also aborts a running ! job", async () => {
  let aborted = false;
  const hangingBash: RunHostDeps["runBash"] = (_cmd, opts) =>
    new Promise<LocalBashResult>((resolve) => {
      opts.signal?.addEventListener("abort", () => {
        aborted = true;
        resolve({
          exitCode: null,
          stdout: "",
          stderr: "",
          signal: "SIGTERM",
          timedOut: false,
          cancelled: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
        });
      });
    });
  const { host, store, dispose } = mount({ runBash: hangingBash });
  expect(host.runBangCommand("sleep 999")).toBe(true);
  expect(host.bashActive()).toBe(true);
  host.clearSession();
  expect(aborted).toBe(true);
  await flush();
  expect(host.bashActive()).toBe(false);
  expect(store.nodes.length).toBe(0);
  dispose();
});

test("steer failure restores the draft and says so in the status", async () => {
  const { host, store, runs, steerImpl, dispose } = mount();
  const turn = host.submitTurn("first");
  await flush();
  expect(host.runActive()).toBe(true);

  steerImpl.fn = () => Promise.reject(new Error("nope"));
  const restored: string[] = [];
  host.registerDraftRestore((text) => restored.push(text));
  await host.submitTurn("steer me somewhere");
  expect(restored).toEqual(["steer me somewhere"]);
  expect(host.runStatus()).toContain("steer failed");
  expect(host.runStatus()).toContain("restored");
  expect(
    store.nodes.some(
      (node) =>
        node.kind === "annotation" &&
        node.text.includes("Steer not delivered") &&
        node.text.includes("steer me somewhere"),
    ),
  ).toBe(true);

  steerImpl.fn = async () => ({ status: "steered" });
  await host.submitTurn("second steer");
  expect(restored.length).toBe(1);
  expect(
    store.nodes.some(
      (node) =>
        node.kind === "annotation" &&
        node.tone === "accent" &&
        node.text.includes("Steer queued") &&
        node.text.includes("second steer"),
    ),
  ).toBe(true);

  host.onEvent(
    ev({
      type: "steering_applied",
      agent: "lead",
      at: 3,
      message: "second steer",
    }),
    "live",
  );
  const secondSteer = store.nodes.filter(
    (node) => node.kind === "annotation" && node.text.includes("second steer"),
  );
  expect(secondSteer).toHaveLength(1);
  expect(secondSteer[0]!.text).toContain("Steer delivered");
  expect(store.nodes.some((node) => node.text.includes("Steer queued"))).toBe(false);

  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  dispose();
});

test("runBangCommand while busy returns not-handled so the caller keeps the draft", async () => {
  let calls = 0;
  const slowBash: RunHostDeps["runBash"] = () => {
    calls++;
    return new Promise<LocalBashResult>(() => {});
  };
  const { host, dispose } = mount({ runBash: slowBash });
  expect(host.runBangCommand("sleep 5")).toBe(true);
  expect(host.runBangCommand("echo hi")).toBe(false);
  expect(calls).toBe(1);
  expect(host.runStatus()).toContain("already running");
  dispose();
});

test("deleting the live session: clearSession({flush:false}) detaches it and later flushes cannot resurrect it", async () => {
  const sessions = fakeSessionStore();
  const { host, store, runs, dispose } = mount({ sessionStore: sessions });
  const turn = host.submitTurn("hello");
  await flush();
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  const id = host.sessionMeta()!.id;
  expect(sessions.list().length).toBe(1);

  sessions.delete(id);
  host.clearSession({ flush: false });
  expect(host.sessionMeta()).toBeNull();
  expect(store.nodes.length).toBe(0);
  expect(sessions.get(id)).toBeNull();

  host.flushSession();
  expect(sessions.list().length).toBe(0);
  dispose();
});

test("clearSession default still flushes the outgoing session before detaching", async () => {
  const sessions = fakeSessionStore();
  const { host, runs, dispose } = mount({ sessionStore: sessions });
  const turn = host.submitTurn("hello");
  await flush();
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  host.clearSession();
  expect(host.sessionMeta()).toBeNull();
  expect(sessions.list().length).toBe(1);
  dispose();
});

test("resume seeds prompt history from the rehydrated user content, not userPreview", async () => {
  const fullPrompt = "deploy with token sk-abcdefghijklmnop1234\nsecond line survives too";
  const client = fakeClient();
  client.getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_old",
      status: "completed",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: fullPrompt }],
      events: [],
      result: {
        execution_id: "exec_old",
        status: "completed",
        result: "done",
        usage: {
          iterations: 1,
          elapsed_ms: 1,
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
        },
      },
    });
  const seeded: string[][] = [];
  const { host, dispose } = mount({
    client: client.client,
    history: {
      ...fakeHistory(),
      seed: (texts: string[]) => seeded.push(texts),
    },
  });
  const meta: SessionMeta = {
    id: "session-1",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        kind: "conversation",
        userPreview: "deploy with token [redacted]",
        executionId: "exec_old",
        status: "done",
      },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };

  await host.loadSessionMeta(meta);

  expect(seeded).toEqual([[fullPrompt]]);
  expect(seeded[0]![0]).not.toContain("[redacted]");
  dispose();
});

test("clearSession invalidates a session resume that is still loading traces", async () => {
  let resolveStored!: (value: RunDetail | null) => void;
  const stored = new Promise<RunDetail | null>((resolve) => {
    resolveStored = resolve;
  });
  const client = fakeClient();
  client.getRunImpl.fn = () => stored;
  const { host, store, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-loading",
    title: "loading",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [{ kind: "conversation", userPreview: "old", executionId: "exec_old", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };

  const loading = host.loadSessionMeta(meta);
  host.clearSession();
  resolveStored(null);
  await loading;

  expect(host.sessionMeta()).toBeNull();
  expect(store.nodes).toEqual([]);
  expect(host.runStatus()).toBe("idle");
  dispose();
});

test("a cancelled bash from an outgoing session cannot overwrite the new session status", async () => {
  let resolveBash!: (value: LocalBashResult) => void;
  const bash = new Promise<LocalBashResult>((resolve) => {
    resolveBash = resolve;
  });
  const { host, dispose } = mount({ runBash: () => bash });

  host.runBangCommand("sleep 10");
  host.clearSession();
  resolveBash({
    exitCode: null,
    stdout: "",
    stderr: "",
    signal: "SIGTERM",
    timedOut: false,
    cancelled: true,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  });
  await flush();

  expect(host.runStatus()).toBe("idle");
  expect(host.bashActive()).toBe(false);
  dispose();
});

test("a getRun that returns the stored trace replays its events into the transcript", async () => {
  const { host, store, runs, getRunImpl, dispose } = mount();
  const turn = host.submitTurn("do the thing");
  await flush();
  const executionId = runs[0]!.handle.executionId;
  getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: executionId,
      status: "completed",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: "do the thing" }],
      events: [
        ev({ type: "run_started", at: 0 }),
        ev({
          type: "tool_call_started",
          agent: "lead",
          call_id: "c1",
          at: 1,
          server: "fs",
          tool: "grep",
          arguments: {},
        }),
      ],
      result: completed(executionId),
    });
  runs[0]!.resolve(completed(executionId));
  await turn;
  expect(host.runStatus()).toBe("completed");
  expect(store.nodes.some((n) => n.kind === "tool_call")).toBe(true);
  dispose();
});

test("getRun failure after a completed run keeps the turn done and settles spinners ok", async () => {
  const { host, store, runs, getRunImpl, dispose } = mount();
  getRunImpl.fn = () => Promise.reject(new Error("connection lost"));
  const turn = host.submitTurn("finish then lose the wire");
  await flush();
  host.onEvent(ev({ type: "run_started", at: 0 }), "live");
  host.onEvent(
    ev({
      type: "tool_call_started",
      agent: "lead",
      call_id: "c1",
      at: 1,
      server: "fs",
      tool: "grep",
      arguments: {},
    }),
    "live",
  );
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(host.runActive()).toBe(false);
  expect(host.runStatus()).toBe("completed");
  const meta = host.sessionMeta()!;
  expect(meta.turns[0]!.status).toBe("done");
  expect(meta.totals).toEqual({ input: 100, output: 10, cached: 0 });
  const tool = store.nodes.find((n) => n.kind === "tool_call")!;
  expect(tool.status).toBe("ok");
  dispose();
});

function fakeAttention(away: () => boolean): {
  attention: NonNullable<RunHostDeps["attention"]>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    attention: {
      notify: (message) => void calls.push(`notify:${message}`),
      setTitle: (state) => void calls.push(`title:${state ?? "base"}`),
      away,
    },
  };
}

test("attention cues: the title mirrors the run and a settle away from the terminal notifies", async () => {
  const { attention, calls } = fakeAttention(() => true);
  const { host, runs, dispose } = mount({ attention });
  const turn = host.submitTurn("long think");
  await flush();
  expect(calls).toEqual(["title:running"]);
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(calls).toEqual(["title:running", "title:base", "notify:run completed"]);
  dispose();
});

test("attention cues: a settle under the user's eyes stays silent (title still restores)", async () => {
  const { attention, calls } = fakeAttention(() => false);
  const { host, runs, dispose } = mount({ attention });
  const turn = host.submitTurn("quick one");
  await flush();
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(calls).toEqual(["title:running", "title:base"]);
  dispose();
});

test("attention cues: a user-requested cancel never notifies, even away", async () => {
  const { attention, calls } = fakeAttention(() => true);
  const { host, runs, dispose } = mount({ attention });
  const turn = host.submitTurn("abort me");
  await flush();
  host.cancelCurrentRun();
  runs[0]!.reject(new Error("aborted"));
  await turn;
  expect(calls).toEqual(["title:running", "title:base"]);
  dispose();
});

test("attention cues: session teardown mid-run resets the title itself (the run's finally no longer owns the sink)", async () => {
  const { attention, calls } = fakeAttention(() => true);
  const { host, runs, dispose } = mount({ attention });
  const turn = host.submitTurn("switch away mid-run");
  await flush();
  expect(calls).toEqual(["title:running"]);
  host.clearSession();
  expect(calls).toEqual(["title:running", "title:base"]);
  runs[0]!.reject(new Error("cancelled"));
  await turn;
  expect(calls).toEqual(["title:running", "title:base"]);
  dispose();
});

test("submitTurn with no active Agent Profile: says so and starts no run", async () => {
  const { host, runs, dispose } = mount({ activeProfile: () => "" });
  await host.submitTurn("hello");
  expect(runs).toHaveLength(0);
  expect(host.runStatus()).toBe("no backend yet");
  dispose();
});

test("submitTurn rejects an oversized @image before creating session or run state", async () => {
  const external = fakeClient();
  const padding = (3 - ((MAX_COMPOSER_IMAGE_BYTES + 1) % 3)) % 3;
  const data =
    "A".repeat(Math.ceil((MAX_COMPOSER_IMAGE_BYTES + 1) / 3) * 4 - padding) + "=".repeat(padding);
  const files: WorkspaceService = {
    ...fakeWorkspaceFiles(),
    readImage: async (path) => ({ path, mime: "image/png", data }),
  };
  const { host, store, dispose } = mount({
    client: { ...external.client, files },
  });
  const restored: string[] = [];
  host.registerDraftRestore((text) => restored.push(text));

  await host.submitTurn("inspect @large.png");

  expect(external.runs).toHaveLength(0);
  expect(host.sessionMeta()).toBeNull();
  expect(store.nodes).toHaveLength(0);
  expect(restored).toEqual(["inspect @large.png"]);
  expect(host.runStatus()).toContain("@large.png");
  expect(host.runStatus()).toContain("per-image limit");
  dispose();
});

test("a late @image load failure restores staged attachments with the draft", async () => {
  const external = fakeClient();
  const files: WorkspaceService = {
    ...fakeWorkspaceFiles(),
    readImage: async () => {
      throw Object.assign(new Error("backend image limit exceeded"), {
        code: "resource_exhausted",
      });
    },
  };
  const { host, store, dispose } = mount({
    client: { ...external.client, files },
  });
  const content = [
    { type: "text" as const, text: "inspect @blocked.png" },
    { type: "image" as const, mime: "image/png", data: "AA==" },
  ];
  let restored: { text: string; content?: MessageContent } | undefined;
  host.registerDraftRestore((text, original) => {
    restored = { text, content: original };
  });

  await host.submitTurn(content);

  expect(external.runs).toHaveLength(0);
  expect(host.sessionMeta()).toBeNull();
  expect(store.nodes).toHaveLength(0);
  expect(restored).toEqual({ text: "inspect @blocked.png", content });
  expect(host.runStatus()).toContain("could not load @blocked.png");
  dispose();
});

test("submitTurn under a review plans mode appends a plan-approval notice to the transcript", async () => {
  const { host, store, runs, dispose } = mount({ plansMode: () => "review" });
  const turn = host.submitTurn("do the risky thing");
  await flush();
  expect(
    store.nodes.some(
      (n) => n.kind === "annotation" && n.text.includes("this run requires plan approval"),
    ),
  ).toBe(true);
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  dispose();
});

test("submitTurn under an off/on plans mode never appends the approval notice", async () => {
  const { host, store, runs, dispose } = mount({ plansMode: () => "on" });
  const turn = host.submitTurn("do the normal thing");
  await flush();
  expect(store.nodes.some((n) => n.kind === "annotation")).toBe(false);
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  dispose();
});

test("steering with a non-'steered' ack surfaces the raw status", async () => {
  const { host, runs, steerImpl, dispose } = mount();
  const turn = host.submitTurn("first");
  await flush();
  steerImpl.fn = async () => ({ status: "rejected" });
  await host.submitTurn("try to steer");
  expect(host.runStatus()).toBe("steer: rejected");
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  dispose();
});

test("a continuation-unavailable envelope retries as a full run and succeeds on the retry", async () => {
  const { host, runs, dispose } = mount();
  const first = host.submitTurn("first turn, establishes a session");
  await flush();
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await first;

  const second = host.submitTurn("second turn, continuation unavailable");
  await flush();
  expect(runs).toHaveLength(2);
  expect(runs[1]!.input.continueFrom).toBeDefined();
  runs[1]!.resolve({
    execution_id: "exec_2",
    status: "failed",
    error: { code: "continuation_unavailable", message: "trace pruned" },
  });
  await flush();
  expect(host.runStatus()).toContain("context expired");
  expect(runs).toHaveLength(3);
  expect(runs[2]!.input.continueFrom).toBeUndefined();
  expect(runs[2]!.input.messages).toEqual([
    { role: "user", content: "first turn, establishes a session" },
    { role: "assistant", content: "done!" },
    { role: "user", content: "second turn, continuation unavailable" },
  ]);
  runs[2]!.resolve(completed(runs[2]!.handle.executionId));
  await second;
  expect(host.runStatus()).toBe("completed");
  dispose();
});

test("persisted non-manager turns release history and rebuild it lazily for a full retry", async () => {
  const { host, runs, getRunImpl, dispose } = mount();
  const details = new Map<string, RunDetail>();
  getRunImpl.fn = async (executionId) => details.get(executionId) ?? null;

  const first = host.submitTurn("first persisted prompt");
  await flush();
  const firstId = runs[0]!.handle.executionId;
  details.set(firstId, {
    execution_id: firstId,
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: "first persisted prompt" }],
    events: [],
    result: completed(firstId),
  });
  runs[0]!.resolve(completed(firstId));
  await first;

  const second = host.submitTurn("second delta only");
  await flush();
  expect(runs[1]!.input.continueFrom).toBe(firstId);
  expect(runs[1]!.input.messages).toEqual([{ role: "user", content: "second delta only" }]);

  const secondId = runs[1]!.handle.executionId;
  runs[1]!.resolve({
    execution_id: secondId,
    status: "failed",
    error: { code: "continuation_unavailable", message: "provider context gone" },
  });
  await flush();

  expect(runs).toHaveLength(3);
  expect(runs[2]!.input.continueFrom).toBeUndefined();
  expect(runs[2]!.input.messages).toEqual([
    { role: "user", content: "first persisted prompt" },
    { role: "assistant", content: "done!" },
    { role: "user", content: "second delta only" },
  ]);

  details.set(secondId, {
    execution_id: secondId,
    continue_from: firstId,
    status: "completed",
    created_at: 3,
    ended_at: 4,
    messages: [{ role: "user", content: "second delta only" }],
    events: [],
    result: completed(secondId),
  });
  runs[2]!.resolve(completed(secondId));
  await second;

  const third = host.submitTurn("third delta only");
  await flush();
  expect(runs[3]!.input.continueFrom).toBe(secondId);
  expect(runs[3]!.input.messages).toEqual([{ role: "user", content: "third delta only" }]);
  runs[3]!.resolve(completed(runs[3]!.handle.executionId));
  await third;
  dispose();
});

test("a released history is never retried as a silently incomplete full request", async () => {
  const { host, runs, getRunImpl, dispose } = mount();
  let persisted: RunDetail | null = null;
  getRunImpl.fn = async () => persisted;

  const first = host.submitTurn("persist me first");
  await flush();
  const firstId = runs[0]!.handle.executionId;
  persisted = {
    execution_id: firstId,
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: "persist me first" }],
    events: [],
    result: completed(firstId),
  };
  runs[0]!.resolve(completed(firstId));
  await first;

  persisted = null;
  const second = host.submitTurn("must not lose prior context");
  await flush();
  runs[1]!.resolve({
    execution_id: runs[1]!.handle.executionId,
    status: "failed",
    error: { code: "continuation_unavailable", message: "provider context gone" },
  });
  await second;

  expect(runs).toHaveLength(2);
  expect(host.runStatus()).toContain("cannot rebuild full history");
  expect(host.runStatus()).toContain("persisted run trace is unavailable");
  dispose();
});

test("manager runs release persisted history and rebuild the complete chain for the next turn", async () => {
  const { host, runs, getRunImpl, dispose } = mount({ isManagerProfile: () => true });
  const lookups: string[] = [];
  const details = new Map<string, RunDetail>();
  getRunImpl.fn = async (executionId) => {
    lookups.push(executionId);
    return details.get(executionId) ?? null;
  };

  const first = host.submitTurn("manager one");
  await flush();
  const firstId = runs[0]!.handle.executionId;
  details.set(firstId, {
    execution_id: firstId,
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: "manager one" }],
    events: [],
    result: completed(firstId),
  });
  runs[0]!.resolve(completed(firstId));
  await first;

  const second = host.submitTurn("manager two");
  await flush();
  expect(lookups.filter((id) => id === runs[0]!.handle.executionId)).toHaveLength(2);
  expect(runs[1]!.input.continueFrom).toBeUndefined();
  expect(runs[1]!.input.messages).toEqual([
    { role: "user", content: "manager one" },
    { role: "assistant", content: "done!" },
    { role: "user", content: "manager two" },
  ]);
  runs[1]!.resolve(completed(runs[1]!.handle.executionId));
  await second;
  dispose();
});

test("switching to a manager rebuilds history that an earlier non-manager released", async () => {
  let manager = false;
  const { host, runs, getRunImpl, dispose } = mount({ isManagerProfile: () => manager });
  const details = new Map<string, RunDetail>();
  getRunImpl.fn = async (executionId) => details.get(executionId) ?? null;

  const first = host.submitTurn("ordinary persisted turn");
  await flush();
  const firstId = runs[0]!.handle.executionId;
  details.set(firstId, {
    execution_id: firstId,
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: "ordinary persisted turn" }],
    events: [],
    result: completed(firstId),
  });
  runs[0]!.resolve(completed(firstId));
  await first;

  manager = true;
  const second = host.submitTurn("manager needs full context");
  await flush();
  expect(runs).toHaveLength(2);
  expect(runs[1]!.input.continueFrom).toBeUndefined();
  expect(runs[1]!.input.messages).toEqual([
    { role: "user", content: "ordinary persisted turn" },
    { role: "assistant", content: "done!" },
    { role: "user", content: "manager needs full context" },
  ]);
  runs[1]!.resolve(completed(runs[1]!.handle.executionId));
  await second;
  dispose();
});

test("Work on task starts a fresh current-workspace run with only task identity and provider key", async () => {
  const profiles: string[] = [];
  const { host, runs, dispose } = mount({ setActiveProfile: (name) => profiles.push(name) });
  const working = host.workOnTask(
    { provider_key: "tasks:mcp:v1:sha256:abc", id: "CLAR-42" },
    "task-coder",
  );
  await flush();

  expect(runs).toHaveLength(1);
  expect(runs[0]!.input.task).toEqual({
    provider_key: "tasks:mcp:v1:sha256:abc",
    id: "CLAR-42",
    mode: "work",
  });
  expect(runs[0]!.input).not.toHaveProperty("continueFrom");
  expect(runs[0]!.input.task).not.toHaveProperty("workspace");
  expect(runs[0]!.input.task).not.toHaveProperty("repository");
  expect(runs[0]!.input.messages?.at(-1)?.content).toContain(
    "call start_task explicitly when that tool is available",
  );
  expect(profiles).toEqual(["task-coder"]);

  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await working;
  dispose();
});

test("resumed task binding survives continuation fallback without session-side persistence", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_task_old",
      status: "completed",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: "work on it" }],
      events: [],
      active_task: {
        provider_key: "tasks:mcp:v1:sha256:abc",
        id: "CLAR-42",
        mode: "work",
      },
      result: completed("exec_task_old"),
    });
  const { host, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-task",
    title: "task",
    workspace: "ws_test",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        kind: "conversation",
        userPreview: "work on it",
        executionId: "exec_task_old",
        status: "done",
      },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  await host.loadSessionMeta(meta);

  const turn = host.submitTurn("continue");
  await flush();
  expect(client.runs).toHaveLength(1);
  expect(client.runs[0]!.input.continueFrom).toBe("exec_task_old");
  expect(client.runs[0]!.input.task).toEqual({
    provider_key: "tasks:mcp:v1:sha256:abc",
    id: "CLAR-42",
    mode: "work",
  });
  client.runs[0]!.resolve({
    execution_id: client.runs[0]!.handle.executionId,
    status: "failed",
    error: { code: "continuation_unavailable", message: "trace pruned" },
  });
  await flush();
  expect(client.runs).toHaveLength(2);
  expect(client.runs[1]!.input.continueFrom).toBeUndefined();
  expect(client.runs[1]!.input.task).toEqual(client.runs[0]!.input.task);
  client.runs[1]!.resolve(completed(client.runs[1]!.handle.executionId));
  await turn;
  dispose();
});

test("submitPromptTurn: an empty rendered prompt starts no run", () => {
  const { host, runs, dispose } = mount();
  host.submitPromptTurn([]);
  expect(runs).toHaveLength(0);
  dispose();
});

test("submitPromptTurn: a non-empty prompt renders to content and starts a run", async () => {
  const { host, runs, dispose } = mount();
  host.submitPromptTurn([{ role: "user", content: "search the docs" }], "search the docs");
  await flush();
  expect(runs).toHaveLength(1);
  const msgs = runs[0]!.input.messages!;
  expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "search the docs" });
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await runs[0]!.handle.done;
  dispose();
});

test("submitPromptTurn: a kernel skill carries its identity without duplicating its body", async () => {
  const { host, runs, dispose } = mount({ plansMode: () => "review" });
  host.submitPromptTurn(
    [{ role: "user", content: "the rendered skill body" }],
    "/speckit-plan auth",
    { name: "speckit-plan", task: "auth", plansMode: "off" },
  );
  await flush();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.input.skill).toEqual({ name: "speckit-plan", task: "auth" });
  expect(runs[0]!.input.messages).toEqual([]);
  expect(host.runStatus()).not.toContain("requires plan approval");
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await runs[0]!.handle.done;
  dispose();
});

test("submitPromptTurn: a continued kernel skill sends only identity and continuation delta", async () => {
  const { host, runs, dispose } = mount();
  const first = host.submitTurn("establish context");
  await flush();
  const firstExecutionId = runs[0]!.handle.executionId;
  runs[0]!.resolve(completed(firstExecutionId));
  await first;

  host.submitPromptTurn(
    [{ role: "user", content: "internal rendered body" }],
    "/speckit-plan auth",
    { name: "speckit-plan", task: "auth" },
  );
  await flush();

  expect(runs).toHaveLength(2);
  expect(runs[1]!.input.continueFrom).toBe(firstExecutionId);
  expect(runs[1]!.input.messages).toEqual([]);
  expect(runs[1]!.input.skill).toEqual({ name: "speckit-plan", task: "auth" });
  runs[1]!.resolve(completed(runs[1]!.handle.executionId));
  await runs[1]!.handle.done;
  dispose();
});

test("submitSkillRun: refuses to start while a run is already active", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitTurn("busy first");
  await flush();
  await host.submitSkillRun("explorer", "look around", "explorer");
  expect(runs).toHaveLength(1);
  expect(host.runStatus()).toContain("busy");
  expect(host.runStatus()).toContain("finish the current run first");
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  dispose();
});

test("submitSkillRun: starts a run on the skill's agent, appends its digest, and settles", async () => {
  const { host, store, runs, getRunImpl, dispose } = mount();
  getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_skill",
      status: "completed",
      created_at: 1,
      ended_at: 2,
      messages: [],
      events: [],
      result: {
        execution_id: "exec_skill",
        status: "completed",
        result: "found 3 matches",
        usage: {
          iterations: 1,
          elapsed_ms: 1,
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
        },
      },
    });
  const turn = host.submitSkillRun("explorer", "find the config loader", "explorer");
  await flush();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.input.skill).toEqual({ name: "explorer", task: "find the config loader" });
  expect(runs[0]!.input.profile).toBe("coder");
  expect(host.runStatus()).toContain("running /explorer on explorer");
  expect(store.nodes.some((n) => n.kind === "user" && n.text.includes("/explorer"))).toBe(true);
  runs[0]!.resolve(completed(runs[0]!.handle.executionId));
  await turn;
  expect(host.runStatus()).toBe("completed");
  expect(host.sessionMeta()?.turns).toMatchObject([
    {
      kind: "transcript",
      executionId: runs[0]!.handle.executionId,
      userPreview: "/explorer find the config loader",
      status: "done",
    },
  ]);
  expect(host.memory()).toMatchObject({
    transcript_resident_turns: 1,
    transcript_folded_turns: 0,
    session_turn_refs: 1,
  });
  dispose();
});

test("configuration consent identity lives only in the open TUI session, never in resume", async () => {
  const { host, runs } = mount();
  const runSkill = async (): Promise<StartRunInput> => {
    const turn = host.submitSkillRun(
      "clarvis-configure",
      "Configure a reviewer",
      "clarvis-configure",
    );
    await flush();
    const run = runs.at(-1)!;
    run.resolve(completed(run.handle.executionId));
    await turn;
    return run.input;
  };
  const first = await runSkill();
  const second = await runSkill();
  expect(first.configurationSessionId).toBeString();
  expect(second.configurationSessionId).toBe(first.configurationSessionId);
  const saved = host.sessionMeta()!;
  expect(first.configurationSessionId).not.toBe(saved.id);
  expect(JSON.stringify(saved)).not.toContain(first.configurationSessionId!);
  host.clearSession();
  await host.loadSessionMeta(saved);
  const resumed = await runSkill();
  expect(host.sessionMeta()?.id).toBe(saved.id);
  expect(resumed.configurationSessionId).toBeString();
  expect(resumed.configurationSessionId).not.toBe(first.configurationSessionId);
  const repeated = await runSkill();
  expect(repeated.configurationSessionId).toBe(resumed.configurationSessionId);
});

test("submitSkillRun: a failed skill run reports the skill name in the error status", async () => {
  const { host, runs, dispose } = mount();
  const turn = host.submitSkillRun("reviewer", "review the diff", "coder");
  await flush();
  runs[0]!.reject(new Error("the run crashed"));
  await turn;
  expect(host.runStatus()).toContain("/reviewer failed");
  expect(host.runStatus()).toContain("the run crashed");
  dispose();
});

test("runBangCommand: a plain successful exit reports its code", async () => {
  const okBash: RunHostDeps["runBash"] = () =>
    Promise.resolve<LocalBashResult>({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      signal: null,
      timedOut: false,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 4,
    });
  const { host, dispose } = mount({ runBash: okBash });
  expect(host.runBangCommand("echo ok")).toBe(true);
  await flush();
  expect(host.runStatus()).toBe("! exit 0");
  expect(host.bashActive()).toBe(false);
  dispose();
});

test("runBangCommand: a timed-out command reports '! timed out'", async () => {
  const slowBash: RunHostDeps["runBash"] = () =>
    Promise.resolve<LocalBashResult>({
      exitCode: null,
      stdout: "",
      stderr: "",
      signal: "SIGTERM",
      timedOut: true,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 30_000,
    });
  const { host, dispose } = mount({ runBash: slowBash });
  expect(host.runBangCommand("sleep 999")).toBe(true);
  await flush();
  expect(host.runStatus()).toBe("! timed out");
  dispose();
});

test("loadSessionMeta: a turn whose trace is gone rehydrates as degraded, and the count shows in the status", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () => Promise.resolve(null);
  const { host, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-degraded",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [{ kind: "conversation", userPreview: "old", executionId: "exec_gone", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
  await host.loadSessionMeta(meta);
  expect(host.runStatus()).toContain("resumed 1 turns");
  expect(host.runStatus()).toContain("1 degraded");
  dispose();
});

test("loadSessionMeta: a turn recovered from a damaged journal is marked partial, with both counts", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_torn",
      status: "cancelled",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: "do it" }],
      events: [],
      recovery: { skipped_lines: 3, synthesized_tool_calls: 1 },
    });
  const { host, store, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-torn",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "do it", executionId: "exec_torn", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };

  await host.loadSessionMeta(meta);

  const notice = store.nodes.find(
    (node) => node.kind === "annotation" && node.text.includes("partial record"),
  );
  expect(notice).toBeDefined();
  expect(notice!.kind === "annotation" && notice!.tone).toBe("warn");
  expect(notice!.text).toContain("3 journal lines lost");
  expect(notice!.text).toContain("1 tool result synthesized");
  expect(host.runStatus()).not.toContain("degraded");
  dispose();
});

test("loadSessionMeta: the partial-record notice names only the damage that happened", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_one_line",
      status: "cancelled",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: "do it" }],
      events: [],
      recovery: { skipped_lines: 1, synthesized_tool_calls: 0 },
    });
  const { host, store, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-one-line",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "do it", executionId: "exec_one_line", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };

  await host.loadSessionMeta(meta);

  const notice = store.nodes.find(
    (node) => node.kind === "annotation" && node.text.includes("partial record"),
  );
  expect(notice!.text).toContain("1 journal line lost");
  expect(notice!.text).not.toContain("synthesized");
  dispose();
});

test("loadSessionMeta: an intact turn gets no partial-record notice", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_intact",
      status: "completed",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: "do it" }],
      events: [],
      result: completed("exec_intact"),
    });
  const { host, store, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-intact",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "do it", executionId: "exec_intact", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };

  await host.loadSessionMeta(meta);

  expect(store.nodes.some((node) => node.text.includes("partial record"))).toBe(false);
  dispose();
});

test("loadSessionMeta warns when the active Extension Profile differs from the persisted turn", async () => {
  const client = fakeClient();
  client.client.currentExtensionProfile = () => ({
    id: "global:research",
    fingerprint: `sha256:${"b".repeat(64)}`,
  });
  client.getRunImpl.fn = () => Promise.resolve(null);
  const { host, store, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-extensionProfile-change",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        kind: "conversation",
        userPreview: "old",
        executionId: "exec_old",
        extensionProfile: { id: "workspace:project", fingerprint: `sha256:${"a".repeat(64)}` },
        status: "done",
      },
    ],
    lastExtensionProfile: { id: "workspace:project", fingerprint: `sha256:${"a".repeat(64)}` },
    totals: { input: 0, output: 0, cached: 0 },
  };

  await host.loadSessionMeta(meta);

  expect(host.runStatus()).toContain("Extension Profile changed");
  const notice = store.nodes.find(
    (node) => node.kind === "annotation" && node.text.includes("Extension Profile changed"),
  );
  expect(notice).toBeDefined();
  expect(notice!.text).toContain("workspace:project (aaaaaaaa)");
  expect(notice!.text).toContain("global:research (bbbbbbbb)");
  expect(host.sessionMeta()?.lastExtensionProfile).toEqual(meta.lastExtensionProfile);
  dispose();
});

test("a degraded resume never falls back to a silently partial full request", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () => Promise.resolve(null);
  const { host, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-degraded-retry",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [{ kind: "conversation", userPreview: "old", executionId: "exec_gone", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
  await host.loadSessionMeta(meta);

  const turn = host.submitTurn("new delta");
  await flush();
  expect(client.runs).toHaveLength(1);
  expect(client.runs[0]!.input.continueFrom).toBe("exec_gone");
  client.runs[0]!.resolve({
    execution_id: client.runs[0]!.handle.executionId,
    status: "failed",
    error: { code: "continuation_unavailable", message: "provider context gone" },
  });
  await turn;

  expect(client.runs).toHaveLength(1);
  expect(host.runStatus()).toContain("cannot rebuild full history");
  expect(host.runStatus()).toContain("persisted run trace is unavailable");
  dispose();
});

test("loadSessionMeta: a getRun failure mid-resume propagates to the caller", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () => Promise.reject(new Error("network down"));
  const { host, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-broken",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [{ kind: "conversation", userPreview: "old", executionId: "exec_x", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
  await expect(host.loadSessionMeta(meta)).rejects.toThrow("network down");
  dispose();
});

test("resumeSessionById: an unknown session id reports 'session not found'", async () => {
  const { host, dispose } = mount();
  await host.resumeSessionById("does-not-exist" as SessionId);
  expect(host.runStatus()).toBe("session not found");
  dispose();
});

test("resumeSessionById reports a session catalog read failure", async () => {
  const sessions = fakeSessionStore();
  sessions.load = () => Promise.reject(new Error("session catalog offline"));
  const { host, dispose } = mount({ sessionStore: sessions });

  await host.resumeSessionById("unreadable" as SessionId);
  expect(host.runStatus()).toContain("resume failed");
  expect(host.runStatus()).toContain("session catalog offline");
  dispose();
});

test("resumeSessionById: a resume failure (e.g. a dropped connection) is caught and reported", async () => {
  const sessions = fakeSessionStore();
  const meta: SessionMeta = {
    id: "session-y",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [{ kind: "conversation", userPreview: "old", executionId: "exec_y", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
  sessions.save(meta);
  const client = fakeClient();
  client.getRunImpl.fn = () => Promise.reject(new Error("connection lost"));
  const { host, dispose } = mount({ client: client.client, sessionStore: sessions });
  await host.resumeSessionById(meta.id);
  expect(host.runStatus()).toContain("resume failed");
  expect(host.runStatus()).toContain("connection lost");
  dispose();
});

test("resumeSessionById: a valid id resumes the session, syncing the active Agent Profile", async () => {
  const sessions = fakeSessionStore();
  const meta: SessionMeta = {
    id: "session-z",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    agentProfile: "reviewer",
    turns: [{ kind: "conversation", userPreview: "old", executionId: "exec_z", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
  sessions.save(meta);
  const client = fakeClient();
  client.getRunImpl.fn = () => Promise.resolve(null);
  const setProfiles: string[] = [];
  const { host, dispose } = mount({
    client: client.client,
    sessionStore: sessions,
    setActiveProfile: (name) => setProfiles.push(name),
  });
  await host.resumeSessionById(meta.id);
  expect(setProfiles).toEqual(["reviewer"]);
  expect(host.sessionMeta()?.id).toBe("session-z");
  dispose();
});

test("clearSession invalidates a resume whose stored run resolves after teardown", async () => {
  const sessions = fakeSessionStore();
  const meta: SessionMeta = {
    id: "session-late",
    title: "old workspace",
    workspace: "ws_old",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      { kind: "conversation", userPreview: "old prompt", executionId: "exec_late", status: "done" },
    ],
    totals: { input: 0, output: 0, cached: 0 },
  };
  sessions.save(meta);
  let resolveRun!: (detail: RunDetail | null) => void;
  const pendingRun = new Promise<RunDetail | null>((resolve) => {
    resolveRun = resolve;
  });
  const client = fakeClient();
  client.getRunImpl.fn = () => pendingRun;
  const { host, store, dispose } = mount({ client: client.client, sessionStore: sessions });
  void host.resumeSessionById(meta.id);
  await Promise.resolve();
  host.clearSession({ flush: false });
  resolveRun({
    execution_id: "exec_late",
    status: "completed",
    created_at: 1,
    ended_at: 2,
    messages: [{ role: "user", content: "old prompt" }],
    events: [],
  });
  await flush();
  expect(store.nodes).toEqual([]);
  expect(host.sessionMeta()).toBeNull();
  expect(host.runStatus()).toBe("idle");
  dispose();
});

test("attention cues: a torn-down run settling after the next run started stays silent", async () => {
  const { attention, calls } = fakeAttention(() => true);
  const { host, runs, dispose } = mount({ attention });
  const turnA = host.submitTurn("tear me down");
  await flush();
  host.clearSession();
  const turnB = host.submitTurn("fresh session run");
  await flush();
  expect(calls).toEqual(["title:running", "title:base", "title:running"]);
  runs[0]!.reject(new Error("cancelled"));
  await turnA;
  expect(calls).toEqual(["title:running", "title:base", "title:running"]);
  runs[1]!.resolve(completed(runs[1]!.handle.executionId));
  await turnB;
  expect(calls).toEqual([
    "title:running",
    "title:base",
    "title:running",
    "title:base",
    "notify:run completed",
  ]);
  dispose();
});

test("loadSessionMeta: the folded prefix gets one visible marker and only 20 resident turns", async () => {
  const client = fakeClient();
  client.getRunImpl.fn = () =>
    Promise.resolve<RunDetail>({
      execution_id: "exec_any",
      status: "completed",
      created_at: 1,
      ended_at: 2,
      messages: [{ role: "user", content: "a question" }],
      events: [],
      result: {
        execution_id: "exec_any",
        status: "completed",
        result: "an answer",
        usage: {
          iterations: 1,
          elapsed_ms: 1,
          input_tokens: 1,
          output_tokens: 1,
          cached_tokens: 0,
        },
      },
    });
  const { host, store, dispose } = mount({ client: client.client });
  const meta: SessionMeta = {
    id: "session-folded",
    title: "t",
    workspace: "/tmp",
    owner: "test-owner",
    createdAt: 1,
    updatedAt: 1,
    turns: Array.from({ length: 25 }, (_, i) => ({
      kind: "conversation",
      userPreview: `q${i}`,
      executionId: `exec_${i}`,
      status: "done" as const,
    })),
    totals: { input: 0, output: 0, cached: 0 },
  };

  await host.loadSessionMeta(meta);

  expect(host.runStatus()).toContain("5 folded");
  const notices = store.nodes.filter((n) => n.kind === "annotation" && n.text.includes("folded"));
  expect(notices).toHaveLength(1);
  expect(notices[0]!.text).toContain("5 earlier turns");
  expect(notices[0]!.text).toContain("/export");
  expect(store.nodes.filter((node) => node.kind === "user")).toHaveLength(20);
  dispose();
});
