import { expect, test } from "bun:test";
import { createTaskObservationScope, type Logger } from "@clarvis/capability";
import { bestEffortFileStore } from "#src/file-store/tasks.ts";

test("file-store cleanup observes each owner and suppresses repeats within one scope", async () => {
  const records: object[] = [];
  const logger = {
    warn: (fields: object) => {
      records.push(fields);
    },
  } as Logger;
  const first = createTaskObservationScope({ clock: () => 1 });
  const second = createTaskObservationScope({ clock: () => 1 });
  const fail = (scope: typeof first) =>
    bestEffortFileStore(
      scope,
      "memory_lock_release",
      () => Promise.reject(new Error("failed")),
      logger,
    );
  await fail(first);
  await fail(first);
  await fail(second);
  expect(records).toHaveLength(2);
});
