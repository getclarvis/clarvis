import { describe, expect, it } from "bun:test";
import type { StartHostedTurnParams } from "@clarvis/protocol";
import { fixture, input, until } from "../helpers/hosted-registry.ts";

const checkpoint = {
  disposition: "checkpoint" as const,
  checkpoint: { summary: "Stage complete", next_step: "Continue bounded work" },
};
function next(previous: string, id: string, sessionId = "session-1"): StartHostedTurnParams {
  const value = input(id, sessionId);
  value.params.continue_from = previous;
  return value;
}

describe("host-owned continuation admission", () => {
  it("waits for physical closure after a checkpoint result has already arrived", async () => {
    const released = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    let proposals = 0;
    const f = fixture({
      handle(handle) {
        if (handle.execution_id !== "run-1") return handle;
        return {
          ...handle,
          closed: handle.closed.then(async () => {
            closing.resolve();
            await released.promise;
          }),
        };
      },
      continuation: () => ({
        async prepare() {
          proposals++;
          return next("run-1", "run-2");
        },
        async stopped() {},
      }),
    });
    try {
      const peer = f.registry.connect("operator");
      const first = await peer.service.start(input());
      f.finish("run-1", checkpoint);
      await closing.promise;
      expect((await first.handle.done).disposition).toBe("checkpoint");
      expect(proposals).toBe(0);
      expect(f.results).toEqual([]);
      expect(f.registry.occupied("session-1")).toBe(true);
      released.resolve();
      await first.handle.closed;
      await until(() => f.starts() === 2);
      expect(proposals).toBe(1);
      f.finish("run-2");
    } finally {
      released.resolve();
      await f.registry.close();
    }
  });

  it("automatically admits two successors through the same controller and complete terminal barrier", async () => {
    const prepared: string[] = [];
    const stopped: string[] = [];
    const f = fixture({
      continuation: (id) => ({
        async prepare() {
          prepared.push(id);
          expect(f.registry.occupied("session-1")).toBe(false);
          expect(f.results.some((result) => result.execution_id === id)).toBe(true);
          expect(
            f.commits.at(-1)!.runs.find((item) => item.run.execution_id === id)!.run
              .execution_state,
          ).toBe("closed");
          return next(id, id === "run-1" ? "run-2" : "run-3");
        },
        async stopped(reason) {
          stopped.push(reason);
        },
      }),
    });
    const peer = f.registry.connect("operator");
    try {
      const first = await peer.service.start(input());
      f.finish("run-1", checkpoint);
      await first.handle.closed;
      await until(() => f.starts() === 2);
      f.finish("run-2", checkpoint);
      await until(() => f.starts() === 3);
      f.finish("run-3");
      await until(() => !f.registry.occupied("session-1"));
      expect(prepared).toEqual(["run-1", "run-2"]);
      expect(stopped).toEqual([]);
      expect(new Set(f.scopes).size).toBe(1);
      expect(f.registry.stats()).toMatchObject({ connections: 1, runs: 0 });
      expect(f.results.map((result) => result.execution_id)).toEqual(["run-1", "run-2", "run-3"]);
    } finally {
      await f.registry.close();
    }
  });

  it.each(["reconcile", "terminal"] as const)(
    "does not prepare another stage while %s is pending or failed",
    async (phase) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let proposals = 0;
      let stopped: string | undefined;
      const f = fixture({
        async reconcile() {
          if (phase !== "reconcile") return;
          entered.resolve();
          await release.promise;
          throw new Error("private reconcile failure");
        },
        async commit(state) {
          if (
            phase !== "terminal" ||
            !state.runs.some((item) => item.run.execution_state === "closed")
          )
            return;
          entered.resolve();
          await release.promise;
          throw new Error("private index failure");
        },
        continuation: () => ({
          async prepare() {
            proposals++;
            return next("run-1", "run-2");
          },
          async stopped(reason) {
            stopped = reason;
          },
        }),
      });
      try {
        const peer = f.registry.connect("operator");
        const first = await peer.service.start(input());
        const closed = first.handle.closed.then(
          () => "closed",
          () => "failed",
        );
        f.finish("run-1", checkpoint);
        await entered.promise;
        expect(proposals).toBe(0);
        expect(f.registry.occupied("session-1")).toBe(true);
        release.resolve();
        expect(await closed).toBe("failed");
        await until(() => stopped !== undefined);
        expect(stopped).toBe("failed");
        expect(f.starts()).toBe(1);
        expect(proposals).toBe(0);
        expect(f.registry.occupied("session-1")).toBe(true);
      } finally {
        release.resolve();
        await f.registry.close();
      }
    },
  );

  it.each(["disconnect", "close", "human"] as const)(
    "revokes slow continuation preparation after %s",
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      let stopped: string | undefined;
      const f = fixture({
        continuation: () => ({
          async prepare(boundSignal) {
            signal = boundSignal;
            entered.resolve();
            await release.promise;
            return next("run-1", "automatic");
          },
          async stopped(reason) {
            stopped = reason;
          },
        }),
      });
      const peer = f.registry.connect("operator");
      try {
        const first = await peer.service.start(input());
        f.finish("run-1", checkpoint);
        await first.handle.closed;
        await entered.promise;
        if (action === "disconnect") await peer.close();
        else if (action === "close") await peer.service.closeSession("session-1");
        else await peer.service.start(input("human"));
        expect(signal?.aborted).toBe(true);
        release.resolve();
        await until(() => stopped !== undefined);
        expect(stopped).toBe(action === "human" ? "superseded" : "revoked");
        expect(f.starts()).toBe(action === "human" ? 2 : 1);
        expect(f.contexts.has("automatic")).toBe(false);
      } finally {
        release.resolve();
        await f.registry.close();
      }
    },
  );

  it("does not transfer future continuation through takeover or background handoff", async () => {
    for (const action of ["takeover", "background"] as const) {
      let proposals = 0;
      let stopped: string | undefined;
      const f = fixture({
        continuation: () => ({
          async prepare() {
            proposals++;
            return next("run-1", "automatic");
          },
          async stopped(reason) {
            stopped = reason;
          },
        }),
      });
      const first = f.registry.connect("operator");
      try {
        const view = await first.service.start(input());
        if (action === "takeover") {
          const second = f.registry.connect("operator");
          await second.service.attach({
            execution_id: "run-1",
            host_generation: "host-generation",
            control: "takeover",
          });
        } else await first.service.detach(f.handoff(view));
        f.finish("run-1", checkpoint);
        await view.handle.closed;
        await until(() => stopped !== undefined);
        expect(stopped).toBe("revoked");
        expect(proposals).toBe(0);
        expect(f.starts()).toBe(1);
      } finally {
        await f.registry.close();
      }
    }
  });

  it.each(["session", "predecessor", "kind"] as const)(
    "refuses a continuation that changes its %s",
    async (field) => {
      let stopped: string | undefined;
      const f = fixture({
        continuation: () => ({
          async prepare() {
            const value = next("run-1", "automatic");
            if (field === "session") value.session_id = "foreign";
            else if (field === "predecessor") value.params.continue_from = "foreign";
            else value.kind = "transcript";
            return value;
          },
          async stopped(reason) {
            stopped = reason;
          },
        }),
      });
      try {
        const peer = f.registry.connect("operator");
        const first = await peer.service.start(input());
        f.finish("run-1", checkpoint);
        await first.handle.closed;
        await until(() => stopped !== undefined);
        expect(stopped).toBe("failed");
        expect(f.starts()).toBe(1);
      } finally {
        await f.registry.close();
      }
    },
  );

  it("stops after bounded preparation timeout and ignores a late result", async () => {
    const release = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<string>();
    const f = fixture({
      continuationTimeoutMs: 5,
      continuation: () => ({
        async prepare() {
          await release.promise;
          return next("run-1", "late");
        },
        async stopped(reason) {
          stopped.resolve(reason);
        },
      }),
    });
    try {
      const peer = f.registry.connect("operator");
      const first = await peer.service.start(input());
      f.finish("run-1", checkpoint);
      await first.handle.closed;
      expect(await stopped.promise).toBe("failed");
      release.resolve();
      await f.registry.close();
      expect(f.starts()).toBe(1);
    } finally {
      release.resolve();
      await f.registry.close();
    }
  });
});
