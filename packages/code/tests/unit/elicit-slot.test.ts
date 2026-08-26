import { expect, test } from "bun:test";
import type { ElicitRequestParams, ElicitResult } from "../../src/adapters/elicit-types.ts";
import { createElicitSlot } from "../../src/adapters/elicit-slot.ts";

const REQ_A = { message: "question A" } as ElicitRequestParams;
const REQ_B = { message: "question B" } as ElicitRequestParams;

test("ask parks the request; resolve settles the promise and clears the slot", async () => {
  const slot = createElicitSlot();
  expect(slot.request()).toBeNull();
  const answered = slot.ask(REQ_A);
  expect(slot.request()).toBe(REQ_A);
  slot.resolve({ action: "accept", content: { x: "1" } });
  expect(slot.request()).toBeNull();
  expect(await answered).toEqual({ action: "accept", content: { x: "1" } });
});

test("a superseding ask answers the previous request cancel — never an abandoned promise", async () => {
  const slot = createElicitSlot();
  const first = slot.ask(REQ_A);
  const second = slot.ask(REQ_B);
  expect(await first).toEqual({ action: "cancel" });
  expect(slot.request()).toBe(REQ_B);
  slot.resolve({ action: "decline" });
  expect(await second).toEqual({ action: "decline" });
});

test("cancelPending answers cancel only when a request is pending", async () => {
  const slot = createElicitSlot();
  slot.cancelPending();
  expect(slot.request()).toBeNull();
  const pending = slot.ask(REQ_A);
  slot.cancelPending();
  expect(await pending).toEqual({ action: "cancel" });
  expect(slot.request()).toBeNull();
});

test("a late resolve after the slot was already settled is a safe no-op", async () => {
  const slot = createElicitSlot();
  const results: ElicitResult[] = [];
  void slot.ask(REQ_A).then((r) => results.push(r));
  slot.resolve({ action: "accept", content: {} });
  slot.resolve({ action: "decline" });
  await Promise.resolve();
  expect(results).toEqual([{ action: "accept", content: {} }]);
});
