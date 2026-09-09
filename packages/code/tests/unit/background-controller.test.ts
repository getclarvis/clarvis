import { expect, test } from "bun:test";
import type { HostedRunReceipt } from "@clarvis/protocol";
import { createBackgroundController } from "../../src/features/background/controller.ts";
import { hostedAttachment, hostedRef, hostingFixture } from "../helpers/hosted-run.ts";

function fixture() {
  const f = hostingFixture();
  const receipt = Promise.withResolvers<HostedRunReceipt>();
  let handoffs = 0;
  let exits = 0;
  const attached: string[] = [];
  const controller = createBackgroundController({
    hosting: () => f.service,
    workspaceId: "ws_test",
    offerOnStartup: true,
    handoff: () => {
      handoffs++;
      return receipt.promise;
    },
    exit: async () => {
      exits++;
    },
    newConversation: () => {},
    attach: async (ref, control) => {
      attached.push(`${ref.execution_id}:${control}`);
    },
  });
  return { ...f, receipt, controller, attached, handoffs: () => handoffs, exits: () => exits };
}

test("coalesces handoff and exits only after its confirmed receipt", async () => {
  const f = fixture();
  const pending = f.controller.background();
  expect(f.controller.background()).toBe(pending);
  expect(f.handoffs()).toBe(1);
  expect(f.exits()).toBe(0);
  f.receipt.resolve({ operation_id: "op", run: hostedRef(), committed_at: 2000 });
  await pending;
  expect(f.exits()).toBe(1);
});

test("a failed handoff neither closes the TUI nor retries the mutation", async () => {
  const f = fixture();
  const pending = f.controller.background();
  f.receipt.reject(new Error("receipt unavailable"));
  await expect(pending).rejects.toThrow("receipt unavailable");
  expect(f.handoffs()).toBe(1);
  expect(f.exits()).toBe(0);
});

test("input received during handoff keeps the TUI open after a successful receipt", async () => {
  const f = fixture();
  let draft = false;
  const pending = f.controller.background(() => !draft);
  draft = true;
  f.receipt.resolve({ operation_id: "op", run: hostedRef(), committed_at: 2000 });
  await expect(pending).rejects.toThrow("preserve your input");
  expect(f.exits()).toBe(0);
});

test("attach preserves the selected id and defaults to observation of another controller", async () => {
  const f = fixture();
  f.service.list = async () => [
    hostedRef({ control: "other" }),
    hostedRef({ workspace_id: "foreign", execution_id: "wrong" }),
  ];
  expect(await f.controller.list()).toHaveLength(1);
  await f.controller.attach("exec_background");
  await f.controller.attach("exec_background", "takeover");
  await expect(f.controller.attach("exec_back")).rejects.toThrow("not found");
  await expect(f.controller.attach("wrong")).rejects.toThrow("not found");
  expect(f.attached).toEqual(["exec_background:observe", "exec_background:takeover"]);
});

for (const failure of [false, true])
  test(`targeted cancel releases temporary observation and control after ${failure ? "failure" : "ACK"}`, async () => {
    const f = fixture();
    const attachment = hostedAttachment();
    f.service.attach = async (input) => {
      expect(input).toEqual({
        execution_id: "exec_background",
        host_generation: "host_test",
        control: "acquire",
      });
      return attachment;
    };
    attachment.handle.cancel = async () => {
      f.calls.push("cancel");
      if (failure) throw new Error("cancel delivery unknown");
    };
    const pending = f.controller.cancel("exec_background");
    if (failure) await expect(pending).rejects.toThrow("delivery unknown");
    else await pending;
    expect(f.calls).toEqual([
      "cancel",
      "snapshot.release",
      "observation.release",
      "control.release",
    ]);
  });

test("cancel cannot silently take another TUI's control or cancel an unknown result", async () => {
  const f = fixture();
  f.service.attach = async () => {
    throw new Error("must not attach");
  };
  f.service.list = async () => [hostedRef({ control: "other" })];
  await expect(f.controller.cancel("exec_background")).rejects.toThrow("Take control explicitly");
  f.service.list = async () => [hostedRef({ execution_state: "unknown" })];
  await expect(f.controller.cancel("exec_background")).rejects.toThrow("no known live");
  expect(f.calls).toEqual([]);
});

test("cancelling an already controlled run preserves the live conversation's control", async () => {
  const f = fixture();
  f.service.list = async () => [hostedRef({ control: "self" })];
  await f.controller.cancel("exec_background");
  expect(f.calls).toEqual(["snapshot.release", "observation.release"]);
});
