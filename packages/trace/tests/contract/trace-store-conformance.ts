import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConflictError, PersistenceError, type ExecutionRecord } from "@clarvis/capability";
import type { TraceStore } from "@clarvis/trace";
import { createTraceVisibilityView } from "@clarvis/trace";

import { makeExecutionRecord } from "../helpers/execution-record.ts";

export interface TraceStoreHarness {
  store: TraceStore;
  dispose?(): void | Promise<void>;
}

/** Register the complete behavior shared by every TraceStore implementation. */
export function traceStoreConformance(
  implementation: string,
  createHarness: () => TraceStoreHarness,
): void {
  describe(`TraceStore conformance — ${implementation}`, () => {
    let harness: TraceStoreHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    const current = (): TraceStore => harness.store;

    it("filters before offset and total, including cross-owner pages", async () => {
      const physical = current();
      const publicView = createTraceVisibilityView(physical, "public");
      const internalView = createTraceVisibilityView(physical, "internal");
      for (let index = 0; index < 6; index++)
        await physical.insert(
          makeExecutionRecord({
            id: `row-${index}`,
            owner_key_name: "alice",
            started_at: index,
            visibility: index % 2 === 0 ? "public" : "internal",
          }),
        );
      await physical.insert(
        makeExecutionRecord({
          id: "other",
          owner_key_name: "bob",
          started_at: 9,
          visibility: "internal",
        }),
      );
      expect(publicView.list("alice", 1, 1)).toMatchObject({ total: 3, items: [{ id: "row-2" }] });
      expect(internalView.list("alice", 1, 1)).toMatchObject({
        total: 3,
        items: [{ id: "row-3" }],
      });
      expect(publicView.list("alice", 0, 0)).toEqual({ total: 3, items: [] });
      expect(publicView.listAcrossOwners!(1, 1)).toMatchObject({
        total: 3,
        items: [{ id: "row-2" }],
      });
      expect(internalView.listAcrossOwners!(1, 1)).toMatchObject({
        total: 4,
        items: [{ id: "row-5" }],
      });
      expect(internalView.listAcrossOwners!(1, 1, { owner: "alice" })).toMatchObject({
        total: 3,
        items: [{ id: "row-3" }],
      });
      expect(publicView.executionIdNamespace).toBe(internalView.executionIdNamespace);
      expect(createTraceVisibilityView(publicView, "public")).toBe(publicView);
      expect(() => createTraceVisibilityView(publicView, "internal")).toThrow(PersistenceError);
    });

    it("hides internal lookup and mutations while reserving the physical id", async () => {
      const physical = current();
      const publicView = createTraceVisibilityView(physical, "public");
      const internalView = createTraceVisibilityView(physical, "internal");
      const record = makeExecutionRecord({
        id: "private",
        owner_key_name: "alice",
        visibility: "internal",
      });
      await internalView.insert(record);
      expect(publicView.getById("alice", "private")).toBeNull();
      expect(publicView.getById("bob", "private")).toBeNull();
      expect(publicView.deleteById("alice", "private")).toBe(false);
      expect(await publicView.replaceFinalContext("alice", "private", [])).toBe(false);
      expect(internalView.getById("alice", "private")).not.toBeNull();
      expect(publicView.existsForOwner("alice", "private")).toBe(true);
      await expect(publicView.insert({ ...record, visibility: "public" })).rejects.toBeInstanceOf(
        ConflictError,
      );
      await expect(publicView.insert(record)).rejects.toBeInstanceOf(PersistenceError);
      expect(await internalView.replaceFinalContext("alice", "private", [])).toBe(true);
      expect(internalView.deleteById("alice", "private")).toBe(true);
    });

    it("owner deletion and retention cover both visibility classes", async () => {
      const physical = current();
      const publicView = createTraceVisibilityView(physical, "public");
      for (const visibility of ["public", "internal"] as const)
        await physical.insert(
          makeExecutionRecord({
            id: visibility,
            owner_key_name: "alice",
            visibility,
            started_at: 1,
          }),
        );
      expect(publicView.cleanup(2, 10)).toBe(2);
      for (const visibility of ["public", "internal"] as const)
        await physical.insert(
          makeExecutionRecord({
            id: visibility,
            owner_key_name: "alice",
            visibility,
          }),
        );
      expect(publicView.deleteOwner("alice")).toBe(2);
      expect(physical.list("alice", 10, 0)).toEqual({ items: [], total: 0 });
    });

    it.each(["public", "internal"] as const)(
      "materializes %s visibility on records and summaries",
      async (visibility) => {
        const record = makeExecutionRecord({ id: visibility, owner_key_name: "alice", visibility });
        await current().insert(record);
        expect(current().getById("alice", visibility)?.visibility).toBe(visibility);
        expect(current().list("alice", 10, 0).items[0]?.visibility).toBe(visibility);
        if (current().listAcrossOwners)
          expect(current().listAcrossOwners!(10, 0).items[0]?.visibility).toBe(visibility);
      },
    );

    it.each([undefined, null, "unknown", false])(
      "refuses unclassified writes %j without creating a record",
      async (visibility) => {
        const record = {
          ...makeExecutionRecord({ id: "invalid", owner_key_name: "alice" }),
          visibility,
        } as unknown as ExecutionRecord;
        await expect(current().insert(record)).rejects.toBeInstanceOf(PersistenceError);
        expect(current().existsForOwner("alice", "invalid")).toBe(false);
      },
    );

    it("inserts and retrieves the complete record by owner and id", async () => {
      const record = makeExecutionRecord({
        id: "exec_1",
        owner_key_name: "alice",
        started_at: 1_000_000,
      });
      await current().insert(record);

      const got = current().getById("alice", "exec_1");
      expect(got).not.toBeNull();
      expect(got!.status).toBe("completed");
      expect(got!.request.messages[0]!.content).toBe("x");
      expect(got!.response).toEqual(record.response);
      expect(got!.started_at).toBe(1_000_000);
    });

    it("scopes lookup by owner", async () => {
      await current().insert(makeExecutionRecord({ id: "shared", owner_key_name: "alice" }));
      expect(current().getById("bob", "shared")).toBeNull();
      expect(current().getById("alice", "shared")).not.toBeNull();
    });

    it("scopes existence by owner", async () => {
      await current().insert(makeExecutionRecord({ id: "x", owner_key_name: "alice" }));
      expect(current().existsForOwner("alice", "x")).toBe(true);
      expect(current().existsForOwner("bob", "x")).toBe(false);
    });

    it("returns empty results for an owner that has never stored a record", () => {
      expect(current().getById("nobody", "nope")).toBeNull();
      expect(current().existsForOwner("nobody", "nope")).toBe(false);
      expect(current().list("nobody", 10, 0)).toEqual({ items: [], total: 0 });
      expect(current().listAcrossOwners!(10, 0, { owner: "nobody" })).toEqual({
        items: [],
        total: 0,
      });
    });

    it("rejects a duplicate id for the same owner with ConflictError", async () => {
      await current().insert(makeExecutionRecord({ id: "dup", owner_key_name: "alice" }));
      await expect(
        current().insert(makeExecutionRecord({ id: "dup", owner_key_name: "alice" })),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows the same id under a different owner", async () => {
      await current().insert(makeExecutionRecord({ id: "task-1", owner_key_name: "alice" }));
      await current().insert(makeExecutionRecord({ id: "task-1", owner_key_name: "bob" }));
      expect(current().getById("alice", "task-1")).not.toBeNull();
      expect(current().getById("bob", "task-1")).not.toBeNull();
    });

    const seedOwnerLists = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        await current().insert(
          makeExecutionRecord({ id: `a${i}`, owner_key_name: "alice", started_at: 1000 + i }),
        );
      }
      await current().insert(
        makeExecutionRecord({ id: "b0", owner_key_name: "bob", started_at: 9999 }),
      );
    };

    it("lists only the requested owner's records with an owner-scoped total", async () => {
      await seedOwnerLists();
      const { items, total } = current().list("alice", 20, 0);
      expect(total).toBe(5);
      expect(items).toHaveLength(5);
      expect(items.every((item) => item.id.startsWith("a"))).toBe(true);
    });

    it("orders an owner's records newest-first", async () => {
      await seedOwnerLists();
      expect(
        current()
          .list("alice", 20, 0)
          .items.map((item) => item.id),
      ).toEqual(["a4", "a3", "a2", "a1", "a0"]);
    });

    it("applies limit and offset while keeping the total page-independent", async () => {
      await seedOwnerLists();
      const { items, total } = current().list("alice", 2, 1);
      expect(total).toBe(5);
      expect(items.map((item) => item.id)).toEqual(["a3", "a2"]);
    });

    it("returns summaries without request, response, or trace payloads", async () => {
      await seedOwnerLists();
      const item = current().list("alice", 1, 0).items[0]!;
      expect(item).not.toHaveProperty("request");
      expect(item).not.toHaveProperty("response");
      expect(item).not.toHaveProperty("trace");
      expect(item).toHaveProperty("total_input_tokens");
    });

    it("deletes only the requested owner's record and reports whether it existed", async () => {
      await current().insert(makeExecutionRecord({ id: "d1", owner_key_name: "alice" }));
      expect(current().deleteById("bob", "d1")).toBe(false);
      expect(current().getById("alice", "d1")).not.toBeNull();
      expect(current().deleteById("alice", "d1")).toBe(true);
      expect(current().getById("alice", "d1")).toBeNull();
    });

    it("cleans records older than the cutoff across owners and keeps recent records", async () => {
      await current().insert(
        makeExecutionRecord({ id: "old1", owner_key_name: "alice", started_at: 100 }),
      );
      await current().insert(
        makeExecutionRecord({ id: "old2", owner_key_name: "bob", started_at: 200 }),
      );
      await current().insert(
        makeExecutionRecord({ id: "new1", owner_key_name: "alice", started_at: 5000 }),
      );

      expect(current().cleanup(1000, 1000)).toBe(2);
      expect(current().getById("alice", "old1")).toBeNull();
      expect(current().getById("bob", "old2")).toBeNull();
      expect(current().getById("alice", "new1")).not.toBeNull();
    });

    it("honors the cleanup batch and removes the oldest records first", async () => {
      for (let i = 0; i < 5; i++) {
        await current().insert(
          makeExecutionRecord({ id: `o${i}`, owner_key_name: "alice", started_at: 10 + i }),
        );
      }

      expect(current().cleanup(10_000, 2)).toBe(2);
      expect(current().list("alice", 20, 0).total).toBe(3);
      expect(current().getById("alice", "o0")).toBeNull();
      expect(current().getById("alice", "o1")).toBeNull();
      expect(current().getById("alice", "o2")).not.toBeNull();
    });

    it("deletes every record for one owner and reports the count", async () => {
      await current().insert(makeExecutionRecord({ id: "a", owner_key_name: "alice" }));
      await current().insert(makeExecutionRecord({ id: "b", owner_key_name: "alice" }));
      await current().insert(makeExecutionRecord({ id: "c", owner_key_name: "bob" }));

      expect(current().deleteOwner("alice")).toBe(2);
      expect(current().getById("alice", "a")).toBeNull();
      expect(current().getById("bob", "c")).not.toBeNull();
    });

    it("reports zero when deleting an owner that has never stored a record", () => {
      expect(current().deleteOwner("nobody")).toBe(0);
    });

    it("lists across owners newest-first and supports an exact owner filter", async () => {
      await current().insert(
        makeExecutionRecord({ id: "a", owner_key_name: "alice", started_at: 1 }),
      );
      await current().insert(
        makeExecutionRecord({ id: "b", owner_key_name: "bob", started_at: 2 }),
      );

      const all = current().listAcrossOwners!(10, 0);
      expect(all.total).toBe(2);
      expect(all.items.map((item) => item.id)).toEqual(["b", "a"]);

      const mine = current().listAcrossOwners!(10, 0, { owner: "bob" });
      expect(mine.total).toBe(1);
      expect(mine.items[0]).toMatchObject({ id: "b", owner: "bob" });
    });
  });
}
