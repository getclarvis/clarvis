import { describe, expect, it } from "../helpers/bun-test.ts";
import {
  createModelCallAdmissionController,
  ModelCallStuckError,
  ModelCallUnavailableError,
  withModelCallAdmission,
} from "@clarvis/llm";
import type { LLMCallParams, LLMCallResult, LLMProvider } from "@clarvis/capability";
import { modelCallTimeoutBridgeOf } from "../../src/model-call-timeout-bridge.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const result: LLMCallResult = {
  text: "ok",
  usage: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
};

function params(signal?: AbortSignal): LLMCallParams {
  return {
    provider: "test",
    model: "test/model",
    messages: [],
    tools: [],
    ...(signal !== undefined ? { signal } : {}),
  };
}

describe("model-call admission", () => {
  it("defaults to four active calls and eight queued calls", () => {
    expect(createModelCallAdmissionController().snapshot()).toMatchObject({
      state: "open",
      maxActive: 4,
      maxQueued: 8,
    });
  });

  it("contains a throwing diagnostics observer without leaking a permit", async () => {
    const controller = createModelCallAdmissionController({
      maxActive: 1,
      onStateChange: () => {
        throw new Error("metrics unavailable");
      },
    });
    const inner: LLMProvider = { call: async () => result };

    await expect(controller.call(inner, params())).resolves.toEqual(result);
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0, state: "open" });
  });

  it("admits in FIFO order and refuses work beyond the bounded queue", async () => {
    const started: number[] = [];
    const gates = Array.from({ length: 4 }, () => deferred<LLMCallResult>());
    const inner: LLMProvider = {
      call: () => {
        const index = started.length;
        started.push(index);
        return gates[index]!.promise;
      },
    };
    const controller = createModelCallAdmissionController({ maxActive: 1, maxQueued: 2 });
    const subject = withModelCallAdmission(inner, controller);
    const calls = [0, 1, 2].map(() => subject.call(params()));
    await Promise.resolve();
    expect(started).toEqual([0]);
    await expect(subject.call(params())).rejects.toBeInstanceOf(ModelCallUnavailableError);

    gates[0]!.resolve(result);
    await calls[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve(result);
    await calls[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[2]!.resolve(result);
    await calls[2];
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("quarantines a transport that ignores abort and reopens only after it settles", async () => {
    const gate = deferred<LLMCallResult>();
    const started = deferred<void>();
    const inner: LLMProvider = {
      call: () => {
        started.resolve();
        return gate.promise;
      },
    };
    const controller = createModelCallAdmissionController({
      maxActive: 1,
      maxQueued: 1,
      abortSettleMs: 1,
    });
    const abort = new AbortController();
    const call = controller.call(inner, params(abort.signal));
    await started.promise;
    abort.abort();
    await expect(call).rejects.toBeInstanceOf(ModelCallStuckError);
    expect(controller.snapshot()).toMatchObject({
      state: "quarantined",
      active: 1,
      quarantined: 1,
    });
    await expect(controller.call(inner, params())).rejects.toMatchObject({
      code: "model_call_unavailable",
      reason: "quarantined",
    });

    gate.resolve(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({ state: "open", active: 0, quarantined: 0 });
  });

  it("releases a quarantined permit when the ignored transport eventually rejects", async () => {
    const gate = deferred<LLMCallResult>();
    const started = deferred<void>();
    const inner: LLMProvider = {
      call: () => {
        started.resolve();
        return gate.promise;
      },
    };
    const controller = createModelCallAdmissionController({
      maxActive: 1,
      maxQueued: 1,
      abortSettleMs: 1,
    });
    const abort = new AbortController();
    const call = controller.call(inner, params(abort.signal));
    await started.promise;
    abort.abort();
    await expect(call).rejects.toBeInstanceOf(ModelCallStuckError);

    gate.reject(new Error("transport finally exited"));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({ state: "open", active: 0, quarantined: 0 });
    await expect(controller.call({ call: async () => result }, params())).resolves.toEqual(result);
  });

  it("closing rejects everything still queued and refuses anything new", async () => {
    const gate = deferred<LLMCallResult>();
    const inner: LLMProvider = { call: () => gate.promise };
    const controller = createModelCallAdmissionController({ maxActive: 1, maxQueued: 4 });

    const active = controller.call(inner, params());
    await Promise.resolve();
    const queued = controller.call(inner, params());
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 1 });

    controller.close();

    await expect(queued).rejects.toMatchObject({
      code: "model_call_unavailable",
      reason: "closed",
    });
    expect(controller.snapshot()).toMatchObject({ state: "closed" });
    await expect(controller.call(inner, params())).rejects.toBeInstanceOf(
      ModelCallUnavailableError,
    );

    // Closing twice is not a second rejection, and the in-flight call is left
    // to finish on its own rather than being torn out from under the caller.
    controller.close();
    gate.resolve(result);
    await expect(active).resolves.toEqual(result);
  });

  it("drops a queued caller that aborts before it is ever admitted", async () => {
    const gate = deferred<LLMCallResult>();
    const inner: LLMProvider = { call: () => gate.promise };
    const controller = createModelCallAdmissionController({ maxActive: 1, maxQueued: 4 });

    const active = controller.call(inner, params());
    await Promise.resolve();
    const abort = new AbortController();
    const waiting = controller.call(inner, params(abort.signal));
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 1 });

    abort.abort();

    await expect(waiting).rejects.toThrow();
    // The abandoned waiter leaves the queue rather than lingering as a permit
    // the next release would hand to nobody.
    expect(controller.snapshot()).toMatchObject({ active: 1, queued: 0 });
    gate.resolve(result);
    await expect(active).resolves.toEqual(result);
    expect(controller.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("treats a per-call timeout as an interruption and surfaces what the call then did", async () => {
    // The adapter, not the controller, decides a call overran: it marks the
    // bridge admission handed it. Nothing else in this suite reaches that arm,
    // and it is the one that turns a slow provider into a released permit.
    const gate = deferred<LLMCallResult>();
    let seen: LLMCallParams | undefined;
    const inner: LLMProvider = {
      call: (callParams: LLMCallParams) => {
        seen = callParams;
        modelCallTimeoutBridgeOf(callParams)!.markTimedOut(50);
        return gate.promise;
      },
    };
    const controller = createModelCallAdmissionController({ maxActive: 1, abortSettleMs: 1_000 });

    const call = controller.call(inner, params());
    await Promise.resolve();
    expect(modelCallTimeoutBridgeOf(seen!)).toBeDefined();

    // The provider loses the race, then fails on its own: that failure is what
    // the caller should see, not the synthetic timeout.
    gate.reject(new Error("upstream reset"));
    await expect(call).rejects.toThrow("upstream reset");
    expect(controller.snapshot()).toMatchObject({ active: 0, quarantined: 0, state: "open" });
  });

  it("forwards the caller's stream, tool-input and retry callbacks, then detaches them", async () => {
    // Admission re-wraps each callback so it can drop them the moment the call
    // settles: a provider that keeps emitting after a timeout must not still be
    // driving the caller's transcript. Both halves matter — the forwarding and
    // the detaching.
    const deltas: string[] = [];
    const toolDeltas: string[] = [];
    const retries: number[] = [];
    const gate = deferred<LLMCallResult>();
    let captured: LLMCallParams | undefined;
    const inner: LLMProvider = {
      call: (callParams: LLMCallParams) => {
        captured = callParams;
        callParams.onStreamDelta?.({ channel: "text", text: "hello", reset: true });
        callParams.onToolInputDelta?.({ call_id: "call_1", tool_name: "read_file", chars: 5 });
        callParams.onRetry?.({ attempt: 1, delayMs: 5, reason: "transient" } as never);
        return gate.promise;
      },
    };
    const controller = createModelCallAdmissionController({ maxActive: 1 });

    const call = controller.call(inner, {
      ...params(),
      onStreamDelta: (delta) => deltas.push(delta.text),
      onToolInputDelta: (delta) => toolDeltas.push(delta.call_id),
      onRetry: (info) => retries.push(info.attempt),
    } as LLMCallParams);

    gate.resolve(result);
    await expect(call).resolves.toEqual(result);

    expect(deltas).toEqual(["hello"]);
    expect(toolDeltas).toEqual(["call_1"]);
    expect(retries).toEqual([1]);

    // The call has settled, so a late emission from the same provider handle is
    // dropped rather than reaching the caller.
    captured!.onStreamDelta?.({ channel: "text", text: "too late", reset: false });
    expect(deltas).toEqual(["hello"]);
  });
});
