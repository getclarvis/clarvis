import { describe, expect, it } from "bun:test";
import {
  closeSessionLifecycle,
  createSession,
  createSessionStore,
  SessionLimitError,
  type SessionCloseTarget,
  type Session,
} from "../../src/http/sessions.ts";
import { createConcurrencyGate } from "../../src/host/live-runs.ts";
import type { McpServerLimits } from "../../src/mcp/server.ts";
import { createFakeRunHost } from "../helpers/fake-run-host.ts";
import { recordingLoggers } from "../helpers/harness.ts";

const session = (id: string): Session => ({ id }) as Session;

const LIMITS: McpServerLimits = {
  maxRuns: 2,
  maxRunsPerOwner: 1,
  bufferMax: 16,
  bufferMaxBytes: 1024 * 1024,
  sendTimeoutMs: 1_000,
  heartbeatMs: 60_000,
  runMaxMs: 60_000,
  settleGraceMs: 1_000,
  elicitToolWaitMs: 1_000,
  elicitRelayMs: 1_000,
  allowRemoteGuardApproval: false,
};

function closeTarget(
  events: string[],
  overrides: Partial<SessionCloseTarget> = {},
): SessionCloseTarget {
  return {
    drain: (graceMs) => {
      events.push(`drain:${String(graceMs)}`);
      return Promise.resolve(true);
    },
    cancelAll: (reason) => {
      events.push(`cancel:${reason}`);
      return 2;
    },
    remove: () => events.push("remove"),
    releaseOwner: () => events.push("release"),
    closeServer: () => {
      events.push("server-close");
      return Promise.resolve();
    },
    settleGraceMs: 25,
    ...overrides,
  };
}

describe("HTTP session admission", () => {
  it("disposes an initialized session through its stored close lifecycle", async () => {
    const store = createSessionStore();
    let released = 0;
    const created = createSession({
      resolved: {
        owner: "alice",
        host: createFakeRunHost(() => ({})),
        release: () => {
          released += 1;
        },
      },
      limits: LIMITS,
      gate: createConcurrencyGate({ perOwner: 1, global: 2 }),
      store,
    });
    await created.connect();
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "session-unit", version: "0" },
      },
    };

    const response = await created.transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      }),
      { parsedBody: body },
    );
    expect(response.status).toBe(200);
    expect(store.size).toBe(1);
    expect(store.values()[0]?.principal).toBeUndefined();

    await created.dispose();
    await created.dispose();
    expect(store.size).toBe(0);
    expect(released).toBe(1);
  });

  it("reserves capacity before expensive session construction and releases unused slots", () => {
    const store = createSessionStore({ maxSessions: 1 });
    const first = store.reserve();
    expect(first).not.toBeNull();
    expect(store.reserve()).toBeNull();

    first!.release();
    const replacement = store.reserve();
    expect(replacement).not.toBeNull();
    replacement!.adopt(session("s1"));
    expect(store.get("s1")?.id).toBe("s1");
    expect(store.reserve()).toBeNull();

    store.remove("s1");
    expect(store.reserve()).not.toBeNull();
  });

  it("also enforces the cap for direct test/embedding adoption", () => {
    const store = createSessionStore({ maxSessions: 1 });
    store.adopt(session("s1"));
    expect(() => store.adopt(session("s2"))).toThrow(SessionLimitError);
  });

  it("sweeps only idle sessions that have no live runs", async () => {
    const store = createSessionStore();
    const closed: string[] = [];
    const idle = {
      ...session("idle"),
      bundle: { runs: { size: 0 } },
      lastSeenAt: 0,
      close: (reason: string) => {
        closed.push(reason);
        return Promise.resolve();
      },
    } as unknown as Session;
    const active = {
      ...session("active"),
      bundle: { runs: { size: 1 } },
      lastSeenAt: 0,
      close: () => Promise.reject(new Error("active session must not close")),
    } as unknown as Session;
    const recent = {
      ...session("recent"),
      bundle: { runs: { size: 0 } },
      lastSeenAt: Date.now() + 10_000,
      close: () => Promise.reject(new Error("recent session must not close")),
    } as unknown as Session;
    store.adopt(idle);
    store.adopt(active);
    store.adopt(recent);

    const stop = store.startSweeper(1);
    try {
      await Bun.sleep(1_050);
      expect(closed).toEqual(["idle"]);
    } finally {
      stop();
    }
  });
});

describe("HTTP session close lifecycle", () => {
  it("keeps the owner lease until a normally cancelled run settles", async () => {
    const events: string[] = [];
    let enterDrain!: () => void;
    const draining = new Promise<void>((resolve) => (enterDrain = resolve));
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    let released = false;
    const target = closeTarget(events, {
      cancelAll: (reason) => {
        events.push(`cancel:${reason}`);
        return 2;
      },
      drain: async (graceMs) => {
        events.push(`drain:${String(graceMs)}`);
        enterDrain();
        await settled;
        expect(released).toBeFalse();
        return true;
      },
      releaseOwner: () => {
        released = true;
        events.push("release");
      },
    });

    const closing = closeSessionLifecycle(target, "delete", 0);
    await draining;
    expect(released).toBeFalse();
    expect(events).toEqual(["cancel:session_close", "drain:25"]);

    settle();
    await closing;
    expect(events).toEqual([
      "cancel:session_close",
      "drain:25",
      "remove",
      "release",
      "server-close",
    ]);
  });

  it("releases after the explicit settle timeout instead of waiting again", async () => {
    const events: string[] = [];
    const target = closeTarget(events, {
      drain: (graceMs) => {
        events.push(`timeout:${String(graceMs)}`);
        return Promise.resolve(false);
      },
    });

    await closeSessionLifecycle(target, "idle", 0);

    expect(events).toEqual([
      "cancel:session_close",
      "timeout:25",
      "remove",
      "release",
      "server-close",
    ]);
  });

  it("releases and closes resources before propagating a drain error", async () => {
    const events: string[] = [];
    const failure = new Error("run registry failed");
    const target = closeTarget(events, {
      drain: (graceMs) => {
        events.push(`drain-error:${String(graceMs)}`);
        return Promise.reject(failure);
      },
      closeServer: () => {
        events.push("server-close");
        return Promise.reject(new Error("secondary close failure"));
      },
    });

    let caught: unknown;
    try {
      await closeSessionLifecycle(target, "delete", 0);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(events).toEqual([
      "cancel:session_close",
      "drain-error:25",
      "remove",
      "release",
      "server-close",
    ]);
  });

  it("gives shutdown its graceful window, then cancels and drains before release", async () => {
    const events: string[] = [];
    let attempts = 0;
    const target = closeTarget(events, {
      drain: (graceMs) => {
        attempts += 1;
        events.push(`drain:${String(graceMs)}`);
        return Promise.resolve(attempts > 1);
      },
    });

    await closeSessionLifecycle(target, "shutdown", 100);

    expect(events).toEqual([
      "drain:100",
      "cancel:shutdown",
      "drain:25",
      "remove",
      "release",
      "server-close",
    ]);
  });

  it("does not cancel a shutdown session whose runs settle in the graceful window", async () => {
    const events: string[] = [];

    await closeSessionLifecycle(closeTarget(events), "shutdown", 100);

    expect(events).toEqual(["drain:100", "remove", "release", "server-close"]);
  });

  it("records the teardown, with what it had to cancel and how long it took", async () => {
    const logs = recordingLoggers();
    const events: string[] = [];
    let attempts = 0;

    await closeSessionLifecycle(
      closeTarget(events, {
        logger: logs.loggers.log,
        drain: (graceMs) => {
          attempts += 1;
          events.push(`drain:${String(graceMs)}`);
          return Promise.resolve(attempts > 1);
        },
      }),
      "shutdown",
      100,
    );

    const record = logs.one("session.closed");
    expect(record.fields).toMatchObject({
      reason: "shutdown",
      runs_cancelled: 2,
      drained: false,
    });
    expect(record.fields.dur_ms).toBeGreaterThanOrEqual(0);
  });

  it("records a session that drained inside its window as drained, cancelling nothing", async () => {
    const logs = recordingLoggers();
    await closeSessionLifecycle(closeTarget([], { logger: logs.loggers.log }), "shutdown", 100);
    expect(logs.one("session.closed").fields).toMatchObject({
      drained: true,
      runs_cancelled: 0,
    });
  });

  it("records the close even when the ordering threw, before rethrowing", async () => {
    const logs = recordingLoggers();
    await expect(
      closeSessionLifecycle(
        closeTarget([], {
          logger: logs.loggers.log,
          remove: () => {
            throw new Error("remove blew up");
          },
        }),
        "delete",
        0,
      ),
    ).rejects.toThrow(/remove blew up/);
    expect(logs.find("session.closed")).toHaveLength(1);
  });

  it("records an admission the cap refused, naming what is against it", () => {
    const logs = recordingLoggers();
    const store = createSessionStore({ maxSessions: 1, logger: logs.loggers.log });
    store.adopt(session("a"));
    expect(() => store.adopt(session("b"))).toThrow(SessionLimitError);

    expect(logs.one("session.capacity_exhausted").fields).toMatchObject({
      limit: 1,
      live: 1,
      reserved: 0,
    });
    expect(store.capacity()).toEqual({ limit: 1, live: 1, reserved: 0 });
  });
});
