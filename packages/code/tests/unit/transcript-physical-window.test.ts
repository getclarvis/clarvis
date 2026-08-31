import { describe, expect, test } from "bun:test";
import {
  PhysicalTranscriptWindowController,
  TRANSCRIPT_GEOMETRY_MEASUREMENT_OWNER_LIMIT,
  TRANSCRIPT_LAYOUT_EPOCH_STRIDE,
  TRANSCRIPT_MEASURE_CONCURRENCY,
  TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS,
  TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS,
} from "../../src/views/history/physical-window.ts";

function sync(
  controller: PhysicalTranscriptWindowController,
  ids: readonly string[],
  options: {
    columns?: number;
    viewportRows?: number;
    glyphMode?: "ascii" | "unicode";
    revisions?: Readonly<Record<string, number>>;
  } = {},
): void {
  controller.sync({
    batchIds: ids,
    columns: options.columns ?? 80,
    viewportRows: options.viewportRows ?? 10,
    glyphMode: options.glyphMode ?? "unicode",
    foldRevisionOf: (id) => options.revisions?.[id] ?? 0,
  });
}

function commit(controller: PhysicalTranscriptWindowController, rows: number, foldRevision = 0) {
  const snapshot = controller.snapshot();
  const candidate = snapshot.candidate;
  if (candidate === null) throw new Error("expected a measurement candidate");
  return controller.commitMeasurement({
    batchId: candidate.batchId,
    columns: snapshot.columns,
    rows,
    foldRevision,
    measurementRevision: snapshot.layoutEpoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE + foldRevision,
  });
}

describe("physical transcript markers", () => {
  test("measures newest-first and preserves the old cells by exact prepend deltas", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b", "c"]);
    expect(controller.snapshot().candidate).toMatchObject({
      batchId: "c",
      reason: "initial",
      resident: false,
    });
    expect(commit(controller, 5)).toEqual({
      accepted: true,
      anchorDelta: 0,
      navigationDelta: 0,
    });

    controller.observe({ scrollTop: 0, scrollHeight: 6, viewportRows: 10 });
    expect(controller.snapshot().candidate?.batchId).toBe("b");
    expect(commit(controller, 7).anchorDelta).toBe(7);
    expect(controller.snapshot()).toMatchObject({
      scrollTop: 7,
      prefetchDirection: "earlier",
    });

    controller.observe({ scrollTop: 7, scrollHeight: 13, viewportRows: 10 });
    expect(controller.snapshot().prefetchDirection).toBe("earlier");
    expect(controller.snapshot().candidate?.batchId).toBe("a");
    expect(commit(controller, 4).anchorDelta).toBe(3);
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: ["a", "b", "c"],
      scrollTop: 10,
      earlierUnknown: 0,
      laterUnknown: 0,
      beforeRows: 0,
      afterRows: 0,
    });
  });

  test("uses exact marker spacers and remounts a known spacer without moving the anchor", () => {
    const controller = new PhysicalTranscriptWindowController();
    const ids = Array.from({ length: 8 }, (_, index) => `b${index}`);
    sync(controller, ids, { viewportRows: 5 });
    let scrollTop = 0;
    for (let count = 0; count < ids.length; count += 1) {
      const result = commit(controller, 4);
      scrollTop += result.anchorDelta;
      if (count + 1 < ids.length) {
        expect(controller.requestEarlier()).toBe(true);
      }
    }
    expect(scrollTop).toBe(27);

    controller.observe({ scrollTop: 27, scrollHeight: 32, viewportRows: 5 });
    const trimmed = controller.snapshot();
    expect(trimmed.start).toBeGreaterThan(0);
    expect(trimmed.beforeRows).toBe(trimmed.start * 4);
    expect(trimmed.earlierUnknown).toBe(0);
    expect(controller.rowOf(trimmed.activeBatchIds[0]!)).toBe(trimmed.beforeRows);
    expect(controller.requestEarlier()).toBe(true);
    expect(commit(controller, 4)).toMatchObject({ accepted: true, anchorDelta: 0 });
  });

  test("publishes a pure native scroll observation without changing the physical range", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a"], { viewportRows: 5 });
    commit(controller, 20);
    expect(controller.observe({ scrollTop: 0, scrollHeight: 20, viewportRows: 5 })).toBeFalse();
    const range = controller.snapshot().activeBatchIds;

    expect(controller.observe({ scrollTop: 3, scrollHeight: 20, viewportRows: 5 })).toBeTrue();
    expect(controller.snapshot()).toMatchObject({ scrollTop: 3, activeBatchIds: range });
    expect(controller.observe({ scrollTop: 3, scrollHeight: 20, viewportRows: 5 })).toBeFalse();
  });

  test("reaches a fixed point when a measured spacer only touches the runway edge", () => {
    const controller = new PhysicalTranscriptWindowController();
    const ids = Array.from({ length: 8 }, (_, index) => `b${index}`);
    sync(controller, ids, { viewportRows: 5 });
    let scrollTop = 0;
    for (let count = 0; count < ids.length; count += 1) {
      const result = commit(controller, 4);
      scrollTop += result.anchorDelta;
      if (count + 1 < ids.length) expect(controller.requestEarlier()).toBe(true);
    }

    controller.observe({ scrollTop, scrollHeight: 32, viewportRows: 5 });
    const settled = controller.snapshot();
    expect(settled.start).toBeGreaterThan(0);
    expect(settled.candidate).toBeNull();
    for (let pass = 0; pass < 20; pass += 1) {
      expect(controller.observe({ scrollTop, scrollHeight: 32, viewportRows: 5 })).toBeFalse();
      expect(controller.snapshot()).toEqual(settled);
    }
  });

  test("coalesces an append-only initial replay to the newest tail", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a"], { viewportRows: 5 });
    expect(controller.snapshot().candidate?.batchId).toBe("a");

    sync(controller, ["a", "b"], { viewportRows: 5 });
    expect(controller.snapshot().candidate).toMatchObject({ batchId: "b", reason: "initial" });
    sync(controller, ["a", "b", "c"], { viewportRows: 5 });
    expect(controller.snapshot().candidate).toMatchObject({ batchId: "c", reason: "initial" });
    expect(commit(controller, 3).accepted).toBeTrue();
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: ["c"],
      earlierUnknown: 2,
      laterUnknown: 0,
    });

    const explicit = new PhysicalTranscriptWindowController();
    sync(explicit, ["a", "b"], { viewportRows: 5 });
    expect(explicit.requestEarlier()).toBeTrue();
    sync(explicit, ["a", "b", "c"], { viewportRows: 5 });
    expect(explicit.snapshot().candidate?.batchId).toBe("b");
  });

  test("drains every append while following the tail without a bottom-layout sample", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a"], { viewportRows: 5 });
    commit(controller, 3);

    sync(controller, ["a", "b", "c", "d"], { viewportRows: 5 });
    expect(controller.snapshot()).toMatchObject({
      followingTail: true,
      laterUnknown: 3,
      candidate: { batchId: "b", reason: "prefetch-later" },
    });
    commit(controller, 4);
    expect(controller.snapshot().candidate).toMatchObject({ batchId: "c" });
    commit(controller, 5);
    expect(controller.snapshot().candidate).toMatchObject({ batchId: "d" });
    commit(controller, 6);
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: ["a", "b", "c", "d"],
      laterUnknown: 0,
      followingTail: true,
      candidate: null,
    });
  });

  test("holds reader intent while appends accumulate and restores tail following at the end", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b"], { viewportRows: 5 });
    commit(controller, 3);
    controller.requestEarlier();
    commit(controller, 3);
    expect(controller.snapshot().followingTail).toBeFalse();

    sync(controller, ["a", "b", "c", "d"], { viewportRows: 5 });
    expect(controller.snapshot()).toMatchObject({ laterUnknown: 2, candidate: null });
    expect(controller.requestLater()).toBeTrue();
    commit(controller, 4);
    expect(controller.requestLater()).toBeTrue();
    commit(controller, 4);
    expect(controller.snapshot().laterUnknown).toBe(0);
    expect(controller.requestLater()).toBeFalse();
    expect(controller.snapshot().followingTail).toBeTrue();
  });

  test("explicit tail return skips an unknown middle and rejects the discarded reader candidate", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b"], { viewportRows: 5 });
    commit(controller, 3);
    expect(controller.requestEarlier()).toBeTrue();
    commit(controller, 4);
    const markerA = controller.marker("a");
    const markerB = controller.marker("b");

    sync(controller, ["a", "b", "c", "d", "e", "f"], { viewportRows: 5 });
    expect(controller.requestLater()).toBeTrue();
    const discarded = controller.snapshot().candidate!;
    expect(discarded.batchId).toBe("c");

    expect(controller.returnToTail()).toBeTrue();
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: ["a", "b"],
      followingTail: true,
      laterUnknown: 4,
      candidate: { batchId: "f", index: 5, reason: "return-tail", resident: false },
    });
    expect(controller.marker("a")).toBe(markerA);
    expect(controller.marker("b")).toBe(markerB);
    expect(
      controller.commitMeasurement({
        batchId: discarded.batchId,
        columns: controller.snapshot().columns,
        rows: 99,
        foldRevision: 0,
        measurementRevision: controller.snapshot().layoutEpoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE,
      }),
    ).toEqual({ accepted: false, anchorDelta: 0, navigationDelta: 0 });
    expect(controller.snapshot().candidate?.batchId).toBe("f");

    expect(commit(controller, 6)).toEqual({
      accepted: true,
      anchorDelta: 0,
      navigationDelta: 2,
    });
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: ["f"],
      earlierUnknown: 5,
      laterUnknown: 0,
      followingTail: true,
      candidate: null,
    });
  });

  test("explicit tail return prepares a measured tail owner without discarding its marker ledger", () => {
    const controller = new PhysicalTranscriptWindowController();
    const ids = Array.from({ length: 8 }, (_, index) => `b${index}`);
    sync(controller, ids, { viewportRows: 5 });
    for (let measured = 0; measured < ids.length; measured += 1) {
      commit(controller, 3);
      if (measured + 1 < ids.length) expect(controller.requestEarlier()).toBeTrue();
    }
    controller.observe({ scrollTop: 0, scrollHeight: 24, viewportRows: 5 });
    expect(controller.snapshot().end).toBeLessThan(ids.length);
    const firstMarker = controller.marker(ids[0]!);
    const tailMarker = controller.marker(ids.at(-1)!);

    expect(controller.returnToTail()).toBeTrue();
    const returned = controller.snapshot();
    expect(returned).toMatchObject({
      followingTail: true,
      candidate: {
        batchId: ids.at(-1),
        index: ids.length - 1,
        reason: "return-tail",
        resident: false,
      },
    });
    expect(controller.marker(ids[0]!)).toBe(firstMarker);
    expect(controller.marker(ids.at(-1)!)).toBe(tailMarker);

    expect(commit(controller, 3)).toEqual({
      accepted: true,
      anchorDelta: 0,
      navigationDelta: 19,
    });
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: [ids.at(-1)],
      end: ids.length,
      followingTail: true,
      laterUnknown: 0,
      candidate: null,
      scrollTop: 19,
    });
    expect(controller.marker(ids[0]!)).toBe(firstMarker);
    expect(controller.returnToTail()).toBeFalse();
  });

  test("repeated retention folds preserve a surviving reader anchor and exact scroll delta", () => {
    const controller = new PhysicalTranscriptWindowController();
    let resident = Array.from({ length: 20 }, (_, index) => `turn:${index}`);
    sync(controller, resident, { viewportRows: 20 });
    for (let measured = 0; measured < resident.length; measured += 1) {
      commit(controller, 3);
      if (measured + 1 < resident.length) expect(controller.requestEarlier()).toBeTrue();
    }

    const anchor = "turn:6";
    const anchorOffset = 1;
    const anchorDeltas: number[] = [];
    let scrollTop = controller.rowOf(anchor)! + anchorOffset;
    controller.observe({ scrollTop, scrollHeight: resident.length * 3, viewportRows: 20 });
    expect(controller.snapshot().followingTail).toBeFalse();

    for (let foldedTurns = 1; foldedTurns <= 6; foldedTurns += 1) {
      resident = [...resident.slice(1), `turn:${19 + foldedTurns}`];
      sync(controller, [`folded:${foldedTurns}`, ...resident], { viewportRows: 20 });

      expect(controller.snapshot()).toMatchObject({
        followingTail: false,
        candidate: { batchId: anchor, reason: "remeasure", resident: true },
      });
      expect(controller.snapshot().activeBatchIds).toContain(anchor);
      expect(controller.snapshot().activeBatchIds).not.toEqual([resident.at(-1)]);

      const before = scrollTop;
      const result = commit(controller, 3);
      const expected = controller.rowOf(anchor)! + anchorOffset - before;
      expect(result).toEqual({ accepted: true, anchorDelta: expected, navigationDelta: 0 });
      anchorDeltas.push(result.anchorDelta);
      scrollTop += result.anchorDelta;
      expect(scrollTop - controller.rowOf(anchor)!).toBe(anchorOffset);

      controller.observe({ scrollTop, scrollHeight: resident.length * 3 + 1, viewportRows: 20 });
    }
    expect(anchorDeltas).toEqual([-2, -3, -3, -3, -3, -3]);
  });

  test("never guesses rows for unknown history and admits only one candidate", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b", "c", "d"]);
    expect(TRANSCRIPT_MEASURE_CONCURRENCY).toBe(1);
    expect(controller.snapshot()).toMatchObject({
      beforeRows: 0,
      afterRows: 0,
      earlierUnknown: 4,
    });
    const candidate = controller.snapshot().candidate;
    expect(controller.ensureBatch("a")).toBe(true);
    expect(controller.snapshot().candidate).toBe(candidate);
    expect(
      controller.commitMeasurement({
        batchId: "a",
        columns: 80,
        rows: 999,
        foldRevision: 0,
        measurementRevision: controller.snapshot().layoutEpoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE,
      }),
    ).toEqual({ accepted: false, anchorDelta: 0, navigationDelta: 0 });
  });

  test("coalesces rapid navigation and promotes an adjacent prefetch atomically", () => {
    const queued = new PhysicalTranscriptWindowController();
    sync(queued, ["a", "b", "c", "d"], { viewportRows: 5 });
    expect(queued.requestEarlier()).toBe(true);
    expect(commit(queued, 4).navigationDelta).toBe(0);
    expect(queued.snapshot().candidate).toMatchObject({
      batchId: "c",
      reason: "navigate-earlier",
    });
    expect(commit(queued, 4).navigationDelta).toBe(-5);

    const promoted = new PhysicalTranscriptWindowController();
    sync(promoted, ["a", "b", "c", "d"], { viewportRows: 5 });
    commit(promoted, 4);
    promoted.observe({ scrollTop: 0, scrollHeight: 5, viewportRows: 5 });
    expect(promoted.snapshot().candidate).toMatchObject({
      batchId: "c",
      reason: "prefetch-earlier",
    });
    expect(promoted.requestEarlier()).toBe(true);
    expect(promoted.snapshot().candidate?.reason).toBe("navigate-earlier");
    expect(commit(promoted, 4).navigationDelta).toBe(-5);
  });

  test("native edge prefetch preserves wheel distance instead of adding a page jump", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b"], { viewportRows: 5 });
    commit(controller, 4);
    controller.observe({ scrollTop: 0, scrollHeight: 5, viewportRows: 5 });
    expect(controller.snapshot().candidate).toMatchObject({
      batchId: "a",
      reason: "prefetch-earlier",
    });
    expect(controller.prefetchEarlier()).toBeTrue();
    expect(controller.snapshot().candidate?.reason).toBe("prefetch-earlier");
    expect(commit(controller, 4).navigationDelta).toBe(0);

    sync(controller, ["a", "b", "c"], { viewportRows: 5 });
    expect(controller.snapshot().candidate).toBeNull();
    expect(controller.prefetchLater()).toBeTrue();
    expect(controller.snapshot().candidate?.reason).toBe("prefetch-later");
    expect(commit(controller, 4).navigationDelta).toBe(0);
  });

  test("keeps two directional viewports ahead, one behind and reverses before the edge", () => {
    const controller = new PhysicalTranscriptWindowController();
    const ids = Array.from({ length: 20 }, (_, index) => `b${index}`);
    sync(controller, ids, { viewportRows: 5 });
    for (let measured = 0; measured < ids.length; measured += 1) {
      commit(controller, 2);
      if (measured + 1 < ids.length) expect(controller.requestEarlier()).toBeTrue();
    }

    const scrollTop = 20;
    const settle = (): void => {
      for (let pass = 0; pass < 100; pass += 1) {
        if (controller.snapshot().candidate !== null) commit(controller, 2);
        const changed = controller.observe({ scrollTop, scrollHeight: 40, viewportRows: 5 });
        if (!changed && controller.snapshot().candidate === null) return;
      }
      throw new Error("directional runway did not settle");
    };

    controller.observe({ scrollTop, scrollHeight: 40, viewportRows: 5 });
    expect(controller.prefetchEarlier()).toBeTrue();
    settle();
    let snapshot = controller.snapshot();
    let activeStart = controller.rowOf(snapshot.activeBatchIds[0]!)!;
    let activeEnd = activeStart + snapshot.activeRows;
    expect(snapshot.prefetchDirection).toBe("earlier");
    expect(scrollTop - activeStart).toBeGreaterThanOrEqual(
      snapshot.viewportRows * TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS,
    );
    expect(activeEnd - (scrollTop + snapshot.viewportRows)).toBeGreaterThanOrEqual(
      snapshot.viewportRows * TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS,
    );

    expect(controller.prefetchLater()).toBeTrue();
    settle();
    snapshot = controller.snapshot();
    activeStart = controller.rowOf(snapshot.activeBatchIds[0]!)!;
    activeEnd = activeStart + snapshot.activeRows;
    expect(snapshot.prefetchDirection).toBe("later");
    expect(scrollTop - activeStart).toBeGreaterThanOrEqual(
      snapshot.viewportRows * TRANSCRIPT_RETAIN_BEHIND_VIEWPORTS,
    );
    expect(activeEnd - (scrollTop + snapshot.viewportRows)).toBeGreaterThanOrEqual(
      snapshot.viewportRows * TRANSCRIPT_PREFETCH_AHEAD_VIEWPORTS,
    );

    expect(controller.prefetchEarlier()).toBeTrue();
    expect(controller.snapshot()).toMatchObject({
      prefetchDirection: "earlier",
      candidate: { reason: "prefetch-earlier" },
    });
  });

  test("pausing measurement retains the settled window and restarts only its candidate", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b", "c"], { viewportRows: 5 });
    commit(controller, 4);
    controller.observe({ scrollTop: 0, scrollHeight: 5, viewportRows: 5 });
    const before = controller.snapshot();
    const marker = controller.marker("c");
    expect(before.candidate).not.toBeNull();

    expect(controller.cancelMeasurement()).toBeTrue();
    expect(controller.snapshot()).toMatchObject({
      activeBatchIds: before.activeBatchIds,
      activeRows: before.activeRows,
      scrollTop: before.scrollTop,
      candidate: null,
    });
    expect(controller.marker("c")).toBe(marker);
    expect(controller.cancelMeasurement()).toBeFalse();

    expect(
      controller.observe({ scrollTop: before.scrollTop, scrollHeight: 5, viewportRows: 5 }),
    ).toBeTrue();
    expect(controller.snapshot().candidate).toMatchObject({ reason: "prefetch-earlier" });
  });

  test("height retains markers while width, glyphs and one fold invalidate the right scope", () => {
    const controller = new PhysicalTranscriptWindowController();
    sync(controller, ["a", "b"], { viewportRows: 8 });
    commit(controller, 3);
    controller.observe({ scrollTop: 0, scrollHeight: 4, viewportRows: 8 });
    commit(controller, 5);
    const epoch = controller.snapshot().layoutEpoch;
    const a = controller.marker("a");
    const b = controller.marker("b");

    sync(controller, ["a", "b"], { viewportRows: 40 });
    expect(controller.snapshot().layoutEpoch).toBe(epoch);
    expect(controller.marker("a")).toBe(a);
    expect(controller.marker("b")).toBe(b);

    sync(controller, ["a", "b"], { columns: 81, viewportRows: 40 });
    expect(controller.snapshot()).toMatchObject({
      layoutEpoch: epoch + 1,
      displayColumns: 80,
      geometryTransition: true,
      activeRows: 8,
      candidate: { batchId: "a", reason: "remeasure", resident: true },
    });
    expect(controller.marker("a")).toBe(a);
    expect(controller.marker("b")).toBe(b);
    const staleCandidate = controller.snapshot().candidate!;
    expect(
      controller.commitMeasurement({
        batchId: staleCandidate.batchId,
        columns: 80,
        rows: 99,
        foldRevision: 0,
        measurementRevision: epoch * TRANSCRIPT_LAYOUT_EPOCH_STRIDE,
      }),
    ).toEqual({ accepted: false, anchorDelta: 0, navigationDelta: 0 });
    expect(controller.snapshot().candidate).toBe(staleCandidate);
    expect(controller.snapshot().activeRows).toBe(8);
    expect(controller.marker(staleCandidate.batchId)).toBe(a);
    commit(controller, 4);
    expect(controller.snapshot()).toMatchObject({
      displayColumns: 80,
      geometryTransition: true,
      candidate: { batchId: "b", reason: "remeasure" },
    });
    expect(controller.marker("a")).toBe(a);
    expect(controller.marker("b")).toBe(b);
    commit(controller, 6);
    expect(controller.snapshot()).toMatchObject({
      displayColumns: 81,
      geometryTransition: false,
      activeRows: 10,
      candidate: null,
    });
    expect(controller.marker("a")).toMatchObject({ columns: 81, layoutEpoch: epoch + 1 });
    expect(controller.marker("b")).toMatchObject({ columns: 81, layoutEpoch: epoch + 1 });

    sync(controller, ["a", "b"], {
      columns: 81,
      viewportRows: 40,
      revisions: { a: 1, b: 0 },
    });
    expect(controller.marker("a")).toBeUndefined();
    expect(controller.marker("b")).toBeDefined();
    expect(controller.snapshot().candidate).toMatchObject({ batchId: "a", reason: "remeasure" });

    sync(controller, ["a", "b"], {
      columns: 81,
      viewportRows: 40,
      glyphMode: "ascii",
      revisions: { a: 1, b: 0 },
    });
    expect(controller.snapshot().layoutEpoch).toBe(epoch + 2);
    expect(controller.marker("b")).toBeUndefined();
  });

  test("publishes an 80 to 81 column reflow once while preserving the reader cells", () => {
    const controller = new PhysicalTranscriptWindowController();
    const ids = ["a", "b", "c", "d"] as const;
    sync(controller, ids, { columns: 80, viewportRows: 10 });
    for (let measured = 0; measured < ids.length; measured += 1) {
      commit(controller, 5);
      if (measured + 1 < ids.length) expect(controller.requestEarlier()).toBeTrue();
    }
    controller.observe({ scrollTop: 8, scrollHeight: 20, viewportRows: 10 });
    const oldMarkers = new Map(ids.map((id) => [id, controller.marker(id)] as const));
    expect(controller.rowOf("b")).toBe(5);
    expect(TRANSCRIPT_GEOMETRY_MEASUREMENT_OWNER_LIMIT).toBe(1);

    sync(controller, ids, { columns: 81, viewportRows: 10 });
    expect(controller.snapshot()).toMatchObject({
      displayColumns: 80,
      columns: 81,
      geometryTransition: true,
      scrollTop: 8,
      activeRows: 20,
    });

    const replacementRows: Readonly<Record<string, number>> = { a: 6, b: 4, c: 8, d: 3 };
    for (let measured = 0; measured < ids.length; measured += 1) {
      const candidate = controller.snapshot().candidate;
      expect(candidate).not.toBeNull();
      const result = commit(controller, replacementRows[candidate!.batchId]!);
      if (measured + 1 < ids.length) {
        expect(result).toEqual({ accepted: true, anchorDelta: 0, navigationDelta: 0 });
        expect(controller.snapshot()).toMatchObject({
          displayColumns: 80,
          geometryTransition: true,
          scrollTop: 8,
          activeRows: 20,
        });
        expect(controller.rowOf("b")).toBe(5);
        for (const id of ids) expect(controller.marker(id)).toBe(oldMarkers.get(id));
      } else {
        expect(result).toEqual({ accepted: true, anchorDelta: 1, navigationDelta: 0 });
      }
    }

    expect(controller.snapshot()).toMatchObject({
      displayColumns: 81,
      columns: 81,
      geometryTransition: false,
      scrollTop: 9,
      activeRows: 21,
      candidate: null,
    });
    expect(controller.rowOf("b")).toBe(6);
    for (const id of ids) {
      expect(controller.marker(id)).toMatchObject({ columns: 81, rows: replacementRows[id] });
      expect(controller.marker(id)).not.toBe(oldMarkers.get(id));
    }
  });

  test("selection depends only on equal physical markers, not semantic size estimates", () => {
    const run = (ids: readonly string[]) => {
      const controller = new PhysicalTranscriptWindowController();
      sync(controller, ids, { viewportRows: 6 });
      for (let index = 0; index < ids.length; index += 1) {
        commit(controller, index % 2 === 0 ? 3 : 5);
        if (index + 1 < ids.length) expect(controller.requestEarlier()).toBeTrue();
      }
      controller.observe({ scrollTop: 70, scrollHeight: 80, viewportRows: 6 });
      return controller.snapshot();
    };
    const ids = ["tiny", "huge-source", "many-nodes", "one-node", "tail"];
    expect(run(ids)).toEqual(run(ids));
  });
});
