import { describe, it, expect } from "bun:test";
import type { ConnectionEvent } from "@clarvis/kernel/bootstrap";
import { createConnectionHealth } from "../../src/health/connection-health.ts";
import { recordingLoggers } from "../helpers/harness.ts";

const SCOPE_A = { workspace: "/ws", owner: "alice" };
const SCOPE_B = { workspace: "/ws", owner: "bob" };

function event(over: Partial<ConnectionEvent> & Pick<ConnectionEvent, "state">): ConnectionEvent {
  return {
    connection_id: "c1",
    scope: SCOPE_A,
    mcp_name: "docs",
    transport: "stdio",
    ...over,
  };
}

describe("createConnectionHealth", () => {
  it("reads a never-observed server as ready, since connections open lazily", () => {
    const health = createConnectionHealth();
    expect(health.ready(["docs", "github"])).toBe(true);
    expect(health.unavailable()).toEqual([]);
  });

  it("marks a server down and clears it on recovery", () => {
    const health = createConnectionHealth();
    health.sink(event({ state: "unavailable", cause: "timeout" }));
    expect(health.ready(["docs"])).toBe(false);
    expect(health.unavailable()).toEqual(["docs"]);

    health.sink(event({ state: "recovered" }));
    expect(health.ready(["docs"])).toBe(true);
    expect(health.unavailable()).toEqual([]);
  });

  // Keyed by name alone, one owner's failing connection marked the server down
  // for the whole container and another owner's recovery cleared it.
  it("keeps one owner's failure from being cleared by another owner's recovery", () => {
    const health = createConnectionHealth();
    health.sink(event({ connection_id: "a", scope: SCOPE_A, state: "unavailable" }));
    health.sink(event({ connection_id: "b", scope: SCOPE_B, state: "unavailable" }));
    expect(health.ready(["docs"])).toBe(false);

    health.sink(event({ connection_id: "b", scope: SCOPE_B, state: "recovered" }));
    expect(health.ready(["docs"])).toBe(false);
    expect(health.unavailable()).toEqual(["docs"]);

    health.sink(event({ connection_id: "a", scope: SCOPE_A, state: "recovered" }));
    expect(health.ready(["docs"])).toBe(true);
  });

  // A connection that goes unavailable and is then closed never emits
  // `recovered` — the pool discards a slot whose connection is no longer
  // connected. Any tally that only cancelled `unavailable` against `recovered`
  // would leave `docs` down until the process restarted.
  it("does not strand a server that was closed while unavailable", () => {
    const health = createConnectionHealth();
    health.sink(event({ connection_id: "a", state: "unavailable", cause: "transport" }));
    health.sink(event({ connection_id: "a", state: "closed" }));
    expect(health.ready(["docs"])).toBe(true);

    health.sink(event({ connection_id: "b", state: "unavailable", cause: "transport" }));
    expect(health.ready(["docs"])).toBe(false);
    health.sink(event({ connection_id: "b", state: "recovered" }));
    expect(health.ready(["docs"])).toBe(true);
    expect(health.unavailable()).toEqual([]);
  });

  it("reports bare server names, never a scope or connection identifier", () => {
    const health = createConnectionHealth();
    health.sink(event({ connection_id: "a", scope: SCOPE_A, state: "unavailable" }));
    health.sink(event({ connection_id: "b", scope: SCOPE_B, state: "unavailable" }));

    expect(health.unavailable()).toEqual(["docs"]);
    for (const name of health.unavailable()) {
      expect(name).not.toContain("alice");
      expect(name).not.toContain("bob");
      expect(name).not.toContain("/ws");
    }
  });

  it("tracks several servers independently", () => {
    const health = createConnectionHealth();
    health.sink(event({ connection_id: "a", mcp_name: "docs", state: "unavailable" }));
    health.sink(event({ connection_id: "b", mcp_name: "github", state: "unavailable" }));
    expect(health.unavailable().sort()).toEqual(["docs", "github"]);
    expect(health.ready(["docs"])).toBe(false);
    expect(health.ready(["slack"])).toBe(true);

    health.sink(event({ connection_id: "a", mcp_name: "docs", state: "closed" }));
    expect(health.unavailable()).toEqual(["github"]);
  });

  it("ignores a close for a connection that was never unavailable", () => {
    const health = createConnectionHealth();
    health.sink(event({ connection_id: "a", state: "closed" }));
    expect(health.ready(["docs"])).toBe(true);
    expect(health.unavailable()).toEqual([]);
  });

  it("reports a connection going down and coming back, with the running down count", () => {
    const logs = recordingLoggers();
    const health = createConnectionHealth(logs.loggers.log);

    health.sink(event({ connection_id: "a", state: "unavailable", cause: "timeout" }));
    health.sink(event({ connection_id: "b", mcp_name: "github", state: "unavailable" }));
    expect(logs.find("mcp.connection.unavailable")).toHaveLength(2);
    expect(logs.find("mcp.connection.unavailable")[0]?.fields).toMatchObject({
      mcp_name: "docs",
      connection_id: "a",
      down_count: 1,
      cause: "timeout",
    });

    health.sink(event({ connection_id: "a", state: "recovered" }));
    expect(logs.one("mcp.connection.recovered").fields).toMatchObject({
      mcp_name: "docs",
      connection_id: "a",
      down_count: 1,
    });
  });

  it("says nothing for a repeat of a state it already holds, nor for an unknown close", () => {
    const logs = recordingLoggers();
    const health = createConnectionHealth(logs.loggers.log);

    health.sink(event({ connection_id: "a", state: "unavailable" }));
    health.sink(event({ connection_id: "a", state: "unavailable" }));
    health.sink(event({ connection_id: "never-seen", state: "closed" }));

    expect(logs.find("mcp.connection.unavailable")).toHaveLength(1);
    expect(logs.find("mcp.connection.recovered")).toHaveLength(0);
  });
});
