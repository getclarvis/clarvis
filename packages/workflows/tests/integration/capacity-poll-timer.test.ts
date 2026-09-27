import { expect, test } from "bun:test";
import { delayOrAbort } from "#src/dispatch.ts";

test("capacity polling settles on its timer or an earlier abort", async () => {
  const normal = new AbortController();
  await expect(delayOrAbort(1, normal.signal)).resolves.toBeUndefined();
  expect(normal.signal.aborted).toBe(false);

  const cancelled = new AbortController();
  const pending = delayOrAbort(60_000, cancelled.signal);
  cancelled.abort();
  await expect(pending).resolves.toBeUndefined();
});
