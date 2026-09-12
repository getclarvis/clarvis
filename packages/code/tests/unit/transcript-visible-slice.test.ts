import { describe, expect, test } from "bun:test";
import {
  TRANSCRIPT_FULL_MOUNT_CEILING,
  TRANSCRIPT_HIDDEN_HINT_ROWS,
  TRANSCRIPT_MOUNTED_BATCH_COUNT,
  TranscriptVisibleSliceController,
} from "../../src/views/history/visible-slice.ts";

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `b${index}`);
}

describe("transcript visible slice", () => {
  test("mounts every batch below the full-mount ceiling", () => {
    const controller = new TranscriptVisibleSliceController();
    const batchIds = ids(TRANSCRIPT_FULL_MOUNT_CEILING);
    expect(controller.sync({ batchIds })).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      start: 0,
      end: batchIds.length,
      earlierUnknown: 0,
      laterUnknown: 0,
      beforeRows: 0,
      afterRows: 0,
      followingTail: true,
      navigating: false,
    });
    expect(controller.revealOlder()).toBe(false);
    expect(controller.revealNewer()).toBe(false);
  });

  test("slides an index window once the ceiling is exceeded", () => {
    const controller = new TranscriptVisibleSliceController();
    const batchIds = ids(TRANSCRIPT_FULL_MOUNT_CEILING + 40);
    controller.sync({ batchIds });
    expect(controller.snapshot()).toMatchObject({
      start: batchIds.length - TRANSCRIPT_MOUNTED_BATCH_COUNT,
      end: batchIds.length,
      earlierUnknown: batchIds.length - TRANSCRIPT_MOUNTED_BATCH_COUNT,
      laterUnknown: 0,
      beforeRows: TRANSCRIPT_HIDDEN_HINT_ROWS,
      afterRows: 0,
      followingTail: true,
    });
    expect(controller.snapshot().activeBatchIds).toHaveLength(TRANSCRIPT_MOUNTED_BATCH_COUNT);

    expect(controller.revealOlder()).toBe(true);
    const older = controller.snapshot();
    expect(older.followingTail).toBe(false);
    expect(older.start).toBeLessThan(batchIds.length - TRANSCRIPT_MOUNTED_BATCH_COUNT);
    expect(older.laterUnknown).toBeGreaterThan(0);
    expect(older.afterRows).toBe(TRANSCRIPT_HIDDEN_HINT_ROWS);

    expect(controller.returnToTail()).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      end: batchIds.length,
      laterUnknown: 0,
      followingTail: true,
      navigating: false,
    });
  });

  test("ensureBatch pauses native stick until the window includes the tail", () => {
    const controller = new TranscriptVisibleSliceController();
    controller.sync({ batchIds: ids(120) });
    expect(controller.ensureBatch("b0")).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      followingTail: false,
      navigating: true,
    });
    expect(controller.snapshot().activeBatchIds).toContain("b0");
    expect(controller.snapshot().activeBatchIds).not.toContain("b119");

    expect(controller.pauseFollowing()).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      followingTail: false,
      navigating: true,
    });

    expect(controller.ensureBatch("b119")).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      followingTail: true,
      navigating: false,
    });
    expect(controller.snapshot().activeBatchIds).toContain("b119");
  });

  test("observing the bottom resumes follow without a one-shot delta", () => {
    const controller = new TranscriptVisibleSliceController();
    controller.sync({ batchIds: ids(100), viewportRows: 10, scrollTop: 40 });
    controller.pauseFollowing();
    expect(controller.snapshot().followingTail).toBe(false);
    expect(
      controller.observe({
        scrollTop: 90,
        viewportRows: 10,
        atBottom: true,
      }),
    ).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      followingTail: true,
      navigating: false,
      end: 100,
      laterUnknown: 0,
    });
  });

  test("new batches while paused stay later-hidden", () => {
    const controller = new TranscriptVisibleSliceController();
    controller.sync({ batchIds: ids(100) });
    controller.revealOlder();
    const paused = controller.snapshot();
    controller.sync({ batchIds: ids(130) });
    expect(controller.snapshot().start).toBe(paused.start);
    expect(controller.snapshot().laterUnknown).toBeGreaterThan(paused.laterUnknown);
    expect(controller.snapshot().followingTail).toBe(false);
  });
});
