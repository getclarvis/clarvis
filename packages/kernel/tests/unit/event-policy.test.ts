import { describe, expect, it } from "bun:test";
import { RUN_EVENT_POLICY } from "../../src/runs/event-policy.ts";

describe("run event policy", () => {
  it("allows dropping only coalescible delta events", () => {
    const droppable = Object.entries(RUN_EVENT_POLICY)
      .filter(([, policy]) => policy.droppable)
      .map(([type]) => type)
      .sort();

    // Each is safe to drop for its own reason: the two content deltas are
    // superseded by an authoritative terminal event, and `tool_input_delta`
    // carries a cumulative count, so the next one restates it in full.
    expect(droppable).toEqual(["text_delta", "tool_input_delta", "tool_output_delta"]);
    for (const policy of Object.values(RUN_EVENT_POLICY)) {
      if (policy.droppable) expect(policy.coalesce).not.toBe(false);
    }
  });

  it("makes replay gaps and derived terminal reporting explicit", () => {
    expect(RUN_EVENT_POLICY.run_started.durability).toBe("persisted");
    expect(RUN_EVENT_POLICY.plan_created).toMatchObject({
      sources: ["capability_channel"],
      durability: "live_only",
      mapper: "capability",
    });
    expect(RUN_EVENT_POLICY.events_dropped).toMatchObject({
      sources: ["kernel_derived"],
      durability: "live_only",
      mapper: "managed_run",
      droppable: false,
    });
    expect(RUN_EVENT_POLICY.workflow_title_updated).toMatchObject({
      sources: ["workflow"],
      durability: "live_only",
      mapper: "workflow",
      droppable: false,
    });
    expect(RUN_EVENT_POLICY.compaction_started).toMatchObject({
      sources: ["engine_trace"],
      durability: "live_only",
      mapper: "engine",
      droppable: false,
    });
  });
});
