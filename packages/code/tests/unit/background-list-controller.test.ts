import { expect, test } from "bun:test";
import type { HostedRunRef } from "@clarvis/protocol";
import {
  createBackgroundListController,
  type BackgroundController,
} from "../../src/features/background/controller.ts";
import { hostedRef } from "../helpers/hosted-run.ts";

function fixture(startup = false) {
  const calls: string[] = [];
  const timers = new Set<() => void>();
  const backgrounds: BackgroundController = {
    offerOnStartup: true,
    list: async () => {
      calls.push("list");
      return [hostedRef()];
    },
    background: async () => {},
    attach: async (id, control) => {
      calls.push(`attach:${id}:${control}`);
    },
    cancel: async (id) => {
      calls.push(`cancel:${id}`);
    },
    newConversation: () => {},
    resolveRecovery: async () => {},
  };
  const controller = createBackgroundListController({
    backgrounds,
    startup,
    emit: (event) => {
      calls.push(event.kind);
    },
    scheduleRefresh(callback) {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  });
  return { backgrounds, controller, calls, timers };
}

test("recovery requires confirmation and drops a late confirmation after disposal", async () => {
  const f = fixture();
  let archived = 0;
  f.backgrounds.resolveRecovery = async () => {
    archived++;
  };
  await f.controller.refresh();
  const ref = hostedRef({ execution_state: "unknown" });
  await f.controller.resolveRecovery(ref, async () => false);
  expect(archived).toBe(0);
  await f.controller.resolveRecovery(ref, async () => true);
  expect(archived).toBe(1);
  const confirmation = Promise.withResolvers<boolean>();
  const waiting = f.controller.resolveRecovery(ref, () => confirmation.promise);
  f.controller.dispose();
  confirmation.resolve(true);
  await waiting;
  expect(archived).toBe(1);
});

test("background discovery coalesces refreshes and drops late results after disposal", async () => {
  const f = fixture();
  const response = Promise.withResolvers<HostedRunRef[]>();
  f.backgrounds.list = () => {
    f.calls.push("list");
    return response.promise;
  };
  const first = f.controller.refresh();
  expect(f.controller.refresh()).toBe(first);
  await Promise.resolve();
  expect(f.calls).toEqual(["list"]);
  f.controller.dispose();
  response.resolve([hostedRef()]);
  await first;
  expect(f.controller.rows()).toEqual([]);
  expect(f.timers.size).toBe(0);
  await f.controller.refresh();
  expect(f.calls).toEqual(["list"]);
});

test("background discovery filters startup work, sorts live before closed and recovers polling errors", async () => {
  const f = fixture(true);
  f.backgrounds.list = async () => {
    throw new Error("offline");
  };
  await f.controller.refresh();
  expect(f.controller.failure()).toBe("offline");
  expect(f.controller.loading()).toBe(false);
  expect(f.timers.size).toBe(1);
  f.backgrounds.list = async () => [
    hostedRef({ execution_id: "closed", execution_state: "closed", created_at: 10 }),
    hostedRef({ execution_id: "foreground", disconnect_policy: "cancel" }),
    hostedRef({ execution_id: "older", created_at: 1 }),
    hostedRef({ execution_id: "newer", created_at: 2 }),
  ];
  [...f.timers][0]!();
  await f.controller.refresh();
  expect(f.controller.rows().map((ref) => ref.execution_id)).toEqual(["newer", "older", "closed"]);
  expect(f.controller.failure()).toBe("");
  expect(f.timers.size).toBe(1);
  f.controller.dispose();
  expect(f.timers.size).toBe(0);
});

test("takeover serializes operations across confirmation and refuses a disposed view", async () => {
  for (const disposed of [false, true]) {
    const f = fixture();
    await f.controller.refresh();
    const confirmation = Promise.withResolvers<boolean>();
    const attaching = f.controller.attach(hostedRef(), {
      confirmTakeover: () => confirmation.promise,
      started: () => {
        f.calls.push("started");
      },
    });
    expect(f.controller.busy()).toBe(true);
    await f.controller.cancel("exec_background");
    await f.controller.attach(hostedRef());
    expect(f.calls).toEqual(["list"]);
    if (disposed) f.controller.dispose();
    confirmation.resolve(true);
    await attaching;
    expect(f.calls).toEqual(
      disposed ? ["list"] : ["list", "attach:exec_background:takeover", "started"],
    );
    if (!disposed) expect(f.controller.busy()).toBe(false);
    f.controller.dispose();
  }
});

test("cancel reports acknowledgement and refreshes without retrying the mutation", async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.cancel("exec_background");
  expect(f.calls).toEqual(["list", "cancel:exec_background", "cancel_requested", "list"]);
  f.backgrounds.cancel = async () => {
    f.calls.push("failed");
    throw new Error("unknown result");
  };
  await expect(f.controller.cancel("exec_background")).rejects.toThrow("unknown result");
  expect(f.controller.busy()).toBe(false);
  expect(f.calls.filter((call) => call === "failed")).toHaveLength(1);
  await expect(f.controller.attach(hostedRef({ execution_state: "unknown" }))).rejects.toThrow(
    "cannot confirm",
  );
  f.controller.dispose();
});
