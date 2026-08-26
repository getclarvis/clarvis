import { describe, it, expect } from "bun:test";
import type {
  AgentHandle,
  AgentRegistration,
  AgentRegistryPort,
  TraceDetailFor,
  TraceKind,
  TracePort,
} from "@clarvis/capability";

import { registerBackgroundChild } from "../../src/spawn-child.ts";

interface Recorded {
  kind: TraceKind;
  detail: unknown;
}

interface RecordedTrace extends TracePort {
  entries: Recorded[];
}

function trace(): RecordedTrace {
  const entries: Recorded[] = [];
  return {
    entries,
    record<K extends TraceKind>(kind: K, detail: TraceDetailFor<K>): void {
      entries.push({ kind, detail });
    },
    signal() {},
    now: () => 0,
  };
}

function handleFor(id: string): AgentHandle {
  return {
    id,
    ingest() {},
    waiting() {},
    settled() {},
  };
}

/** A registry that records what it was handed and answers with `next`. */
function registry(next: AgentHandle | null): AgentRegistryPort & { seen: AgentRegistration[] } {
  const seen: AgentRegistration[] = [];
  return {
    seen,
    register(registration: AgentRegistration): AgentHandle | null {
      seen.push(registration);
      return next;
    },
    adopt(): void {},
    liveCount(): number {
      return 0;
    },
  };
}

describe("registerBackgroundChild", () => {
  it("registers the child, records it, and returns the three control handles", () => {
    const agents = registry(handleFor("ag_0000beef"));
    const tr = trace();

    const spawn = registerBackgroundChild(agents, tr, {
      kind: "subagent",
      nativeId: "sub_1",
      title: "review the diff",
      profile: "reviewer",
    });

    expect(spawn).not.toBeNull();
    expect(spawn!.handle.id).toBe("ag_0000beef");
    expect(spawn!.controller.signal.aborted).toBe(false);
    expect(spawn!.steerQueue.undrained()).toEqual([]);

    expect(agents.seen).toHaveLength(1);
    expect(agents.seen[0]).toMatchObject({
      kind: "subagent",
      nativeId: "sub_1",
      title: "review the diff",
      profile: "reviewer",
    });

    expect(tr.entries).toEqual([
      {
        kind: "agent_registered",
        detail: {
          agent_id: "ag_0000beef",
          kind: "subagent",
          native_id: "sub_1",
          title: "review the diff",
          profile: "reviewer",
          background: true,
        },
      },
    ]);
  });

  it("omits `profile` entirely rather than registering it as undefined", () => {
    const agents = registry(handleFor("ag_00000001"));
    const tr = trace();

    registerBackgroundChild(agents, tr, { kind: "leader", nativeId: "run_1", title: "wave 1" });

    expect("profile" in agents.seen[0]!).toBe(false);
    expect("profile" in (tr.entries[0]!.detail as object)).toBe(false);
  });

  it("returns null and records nothing when the registry declines", () => {
    const agents = registry(null);
    const tr = trace();

    const spawn = registerBackgroundChild(agents, tr, {
      kind: "subagent",
      nativeId: "sub_2",
      title: "too late",
    });

    expect(spawn).toBeNull();
    expect(tr.entries).toEqual([]);
  });

  it("aborts with the stop reason and reports undrained steers through the control port", () => {
    const agents = registry(handleFor("ag_00000004"));
    const spawn = registerBackgroundChild(agents, trace(), {
      kind: "leader",
      nativeId: "run_2",
      title: "t",
    })!;
    const control = agents.seen[0]!.control;

    control.steer({ content: "focus on the parser" });
    expect(control.undrained?.()).toBe(1);
    expect(spawn.steerQueue.undrained()).toHaveLength(1);

    control.stop("parent asked");
    expect(spawn.controller.signal.aborted).toBe(true);
    expect((spawn.controller.signal.reason as Error).message).toBe("parent asked");
  });
});
