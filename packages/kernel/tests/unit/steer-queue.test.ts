import { expect, it } from "bun:test";
import { createSteerQueue } from "../../src/runs/steer-queue.ts";

it("observes admitted steers immediately without acknowledging or duplicating delivery", async () => {
  const queue = createSteerQueue();
  const message = { content: "Do not write settings." };
  let settled = false;
  const delivered = queue.push(message).then((value) => {
    settled = true;
    return value;
  });
  const observed: unknown[] = [];
  const unsubscribe = queue.onPending!((pending) => observed.push(pending));
  expect(observed).toEqual([message]);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(queue.drain()).toEqual([message]);
  expect(await delivered).toBe(true);
  expect(queue.drain()).toEqual([]);
  expect(observed).toEqual([message]);
  unsubscribe();
  const late = queue.push({ content: "Another steer." });
  queue.close();
  expect(await late).toBe(false);
  expect(observed).toEqual([message]);
});
