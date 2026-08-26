/**
 * Test support for {@link PlanRepository} and {@link PlanStore} implementations:
 * an in-memory repository plus the backend-agnostic contracts every adapter must satisfy.
 *
 * The contract is exposed as **data** rather than as `describe`/`test` calls, and
 * asserts through `node:assert/strict`, so this module carries no test-runner
 * dependency and an adapter living in another package (or another runner) can
 * drive the same cases. See `tests/contract/` for the Bun drivers.
 */
import assert from "node:assert/strict";

import {
  PLAN_CURSOR_TAGS,
  PlanCursorError,
  decodePlanCursor,
  encodePlanCursor,
  type PlanCursorTag,
} from "./cursor.ts";
import { digestText, newPlan, parsePlan, planFilename, projectPlan, renderPlan } from "./format.ts";
import type { PlanRetention, PlanStatus } from "./schemas.ts";
import {
  InvalidPlanError,
  PlanConflictError,
  PlanNotFoundError,
  PlanSealedError,
  type PlanRecord,
  type PlanRepository,
} from "./repository.ts";
import type { CreatePlanInput, PlanStore } from "./store.ts";

/**
 * Build a process-local {@link PlanRepository} backed by a `Map`.
 *
 * @returns a repository with the same observable contract as the file-backed
 *   adapter, for tests and for hosts that want ephemeral plans.
 * @remarks Ordering is by `index.created_at` descending, then by insertion, so
 *   plans created within the same second still page deterministically.
 */
export function createInMemoryPlanRepository(): PlanRepository {
  const sources = new Map<string, { source: string; path: string }>();
  const order: string[] = [];

  /** Derive the outward record from the stored bytes, exactly as a backend that
   * cannot keep a projection in sync with a hand edit must. */
  function toRecord(id: string, entry: { source: string; path: string }): PlanRecord {
    let document;
    try {
      document = parsePlan(entry.source, entry.path);
    } catch (error) {
      throw new InvalidPlanError(error instanceof Error ? error.message : String(error));
    }
    return {
      id,
      source: entry.source,
      digest: digestText(entry.source),
      index: { ...projectPlan(document), path: entry.path },
    };
  }

  const ranked = (): PlanRecord[] => {
    const out: { record: PlanRecord; seq: number }[] = [];
    for (const [id, entry] of sources) {
      try {
        out.push({ record: toRecord(id, entry), seq: order.indexOf(id) });
      } catch {
        continue;
      }
    }
    out.sort((a, b) => {
      if (a.record.index.created_at !== b.record.index.created_at)
        return a.record.index.created_at < b.record.index.created_at ? 1 : -1;
      return b.seq - a.seq;
    });
    return out.map((entry) => entry.record);
  };

  /* eslint-disable @typescript-eslint/require-await -- the port is async by
     contract (a conflict must surface as a rejected promise, not a synchronous
     throw); these bodies are simply synchronous. */
  return {
    async create(record) {
      if (sources.has(record.id))
        throw new PlanConflictError(`Plan already exists: ${record.id}`, "cas");
      const taken = new Set([...sources.values()].map((entry) => entry.path));
      const stem = record.index.path.replace(/\.md$/, "");
      let path = `${stem}.md`;
      let suffix = 1;
      while (taken.has(path)) {
        suffix += 1;
        path = `${stem}-${suffix}.md`;
      }
      sources.set(record.id, { source: record.source, path });
      order.push(record.id);
      return toRecord(record.id, { source: record.source, path });
    },

    async read(id) {
      const entry = sources.get(id);
      return entry === undefined ? null : toRecord(id, entry);
    },

    async list(query = {}) {
      const limit = Math.min(100, Math.max(1, query.limit ?? 20));
      const all = ranked().filter(
        (record) =>
          (query.status === undefined || record.index.status === query.status) &&
          (query.retention === undefined || record.index.retention === query.retention),
      );
      const after =
        query.cursor === undefined
          ? undefined
          : decodePlanCursor(PLAN_CURSOR_TAGS.memory, query.cursor);
      const start = after === undefined ? 0 : all.findIndex((r) => r.id === after) + 1;
      const page = all.slice(start, start + limit);
      const end = start + page.length;
      const last = page[page.length - 1]?.id;
      return {
        records: page,
        ...(end < all.length && last !== undefined
          ? { next_cursor: encodePlanCursor(PLAN_CURSOR_TAGS.memory, last) }
          : {}),
      };
    },

    async write(input) {
      const entry = sources.get(input.id);
      if (entry === undefined) throw new PlanNotFoundError(input.id);
      if (digestText(entry.source) !== input.expectedDigest)
        throw new PlanConflictError("Plan changed since it was read", "cas");
      const next = { source: input.source, path: entry.path };
      sources.set(input.id, next);
      return toRecord(input.id, next);
    },

    async delete(id, expectedDigest) {
      const entry = sources.get(id);
      if (entry === undefined) return false;
      if (expectedDigest !== undefined && digestText(entry.source) !== expectedDigest)
        throw new PlanConflictError("Plan changed since it was read", "cas");
      sources.delete(id);
      return true;
    },

    /** Test seam: replace the stored bytes behind the repository's back. */
    poke(id: string, source: string): void {
      const entry = sources.get(id);
      if (entry !== undefined) sources.set(id, { ...entry, source });
    },
  } as PlanRepository & { poke: (id: string, source: string) => void };
  /* eslint-enable @typescript-eslint/require-await */
}

/** What a {@link PlanConformanceCase} needs from the adapter under test. */
export interface PlanRepositoryHarness {
  /** The adapter instance, freshly constructed and empty. */
  repository: PlanRepository;
  /**
   * Replace a stored plan's source behind the repository's back, as a human
   * editing the Markdown would. Adapters that cannot be edited out of band omit
   * it, and the cases that need it skip.
   */
  poke?: (id: string, source: string) => Promise<void>;
  /** Release whatever the harness allocated. */
  cleanup: () => Promise<void>;
}

/** One backend-agnostic contract case. */
export interface PlanConformanceCase {
  /** Test name, unique within the suite. */
  name: string;
  /** Runs the case, throwing on failure. */
  run: (harness: PlanRepositoryHarness) => Promise<void>;
}

/** Build a valid, storable record. Overrides are baked into the *source*, since
 * an adapter derives the projection from the bytes. */
function record(
  title: string,
  over: { createdAt?: Date; status?: PlanStatus; retention?: PlanRetention } = {},
): Omit<PlanRecord, "digest"> {
  const now = over.createdAt ?? new Date("2026-07-27T10:00:00.000Z");
  const base = newPlan({
    title,
    objective: `Do ${title}`,
    tasks: [{ title: `Step for ${title}` }],
    createdByRun: "run-1",
    ...(over.retention === undefined ? {} : { retention: over.retention }),
    now,
  });
  const document = over.status === undefined ? base : { ...base, status: over.status };
  const source = renderPlan(document);
  return {
    id: document.id,
    source,
    index: { ...projectPlan(document), path: planFilename(now, title) },
  };
}

/**
 * Mangle a plan's body while leaving its frontmatter — and therefore its `id` —
 * intact. A plan whose identity has been destroyed is no longer addressable as a
 * plan at all, so that is not what "corrupt" means for this contract.
 */
function mangleBody(source: string): string {
  const end = source.indexOf("\n---\n");
  return `${source.slice(0, end + 5)}\nthe body is mangled\n`;
}

/**
 * The cursors that are foreign to whichever backend minted `minted`: the other
 * two dialects, and a bare untagged locator.
 *
 * @remarks The native dialect is read off a real cursor rather than declared per
 * harness, so a backend added later is covered without touching the case. It
 * asserts on the way past that the cursor was tagged at all, which is what pins
 * a mint site that forgot to stamp.
 */
function foreignCursors(minted: string): string[] {
  const native = minted.slice(0, minted.indexOf(":")) as PlanCursorTag;
  assert.ok(
    (Object.values(PLAN_CURSOR_TAGS) as string[]).includes(native),
    `a backend minted an untagged cursor (tag ${JSON.stringify(native)})`,
  );
  assert.equal(decodePlanCursor(native, minted).length > 0, true);
  const foreign = Object.values(PLAN_CURSOR_TAGS)
    .filter((tag) => tag !== native)
    .map((tag) => encodePlanCursor(tag, "2026-07-27T10-02-00-second.md"));
  foreign.push("2026-07-27T10-02-00-second.md");
  return foreign;
}

/** The ascending timestamps a paging case creates its plans at. */
function pageMinute(index: number): Date {
  return new Date(Date.UTC(2026, 6, 27, 10, index));
}

/**
 * The contract every {@link PlanRepository} adapter must satisfy.
 *
 * @returns the cases, in a stable order. A driver runs each against a freshly
 *   built {@link PlanRepositoryHarness}; cases needing a capability the harness
 *   lacks (`poke`) return early rather than failing.
 */
export function planRepositoryConformance(): readonly PlanConformanceCase[] {
  return [
    {
      name: "creates a plan and reads it back by id",
      async run({ repository }) {
        const input = record("Ship the thing");
        const created = await repository.create(input);
        assert.equal(created.id, input.id);
        assert.equal(created.source, input.source);
        assert.equal(created.digest, digestText(input.source));
        const read = await repository.read(input.id);
        assert.equal(read?.id, input.id);
        assert.equal(read?.digest, created.digest);
      },
    },
    {
      name: "reports an unknown id as null",
      async run({ repository }) {
        assert.equal(await repository.read("nope"), null);
      },
    },
    {
      name: "reports a locator for every stored plan",
      async run({ repository }) {
        const created = await repository.create(record("Locator check"));
        assert.ok(created.index.path.length > 0);
        assert.equal((await repository.read(created.id))?.index.path, created.index.path);
      },
    },
    {
      name: "allocates a distinct locator for same-titled plans",
      async run({ repository }) {
        const a = await repository.create(record("Same title"));
        const b = await repository.create(record("Same title"));
        assert.notEqual(a.id, b.id);
        assert.notEqual(a.index.path, b.index.path);
      },
    },
    {
      name: "rejects creating a plan whose id already exists",
      async run({ repository }) {
        const input = record("Duplicate");
        await repository.create(input);
        await assert.rejects(
          () => repository.create(input),
          (err: unknown) => err instanceof PlanConflictError && err.code === "plan_conflict",
        );
      },
    },
    {
      name: "writes under compare-and-swap and moves the digest forward",
      async run({ repository }) {
        const created = await repository.create(record("CAS"));
        const document = parsePlan(created.source, created.index.path);
        const next = { ...document, revision: 2, notes: "progress" };
        const source = renderPlan(next);
        const written = await repository.write({
          id: created.id,
          expectedDigest: created.digest,
          source,
          index: projectPlan(next),
        });
        assert.equal(written.digest, digestText(source));
        assert.notEqual(written.digest, created.digest);
        assert.equal((await repository.read(created.id))?.source, source);
      },
    },
    {
      name: "rejects a write whose expected digest is stale",
      async run({ repository }) {
        const created = await repository.create(record("Stale"));
        await assert.rejects(
          () =>
            repository.write({
              id: created.id,
              expectedDigest: "stale",
              source: created.source,
              index: created.index,
            }),
          (err: unknown) =>
            err instanceof PlanConflictError &&
            err.code === "plan_conflict" &&
            err.reason === "cas",
        );
      },
    },
    {
      name: "lets exactly one of two racing writers win",
      async run({ repository }) {
        const created = await repository.create(record("Race"));
        const document = parsePlan(created.source, created.index.path);
        const attempt = (notes: string): Promise<PlanRecord> =>
          repository.write({
            id: created.id,
            expectedDigest: created.digest,
            source: renderPlan({ ...document, notes }),
            index: projectPlan(document),
          });
        const results = await Promise.allSettled([attempt("a"), attempt("b")]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(results.filter((r) => r.status === "rejected").length, 1);
      },
    },
    {
      name: "rejects a write to an unknown id",
      async run({ repository }) {
        const input = record("Ghost");
        await assert.rejects(
          () =>
            repository.write({
              id: input.id,
              expectedDigest: digestText(input.source),
              source: input.source,
              index: input.index,
            }),
          (err: unknown) => err instanceof PlanNotFoundError && err.code === "plan_not_found",
        );
      },
    },
    {
      name: "deletes idempotently and honours an expected digest",
      async run({ repository }) {
        const created = await repository.create(record("Delete me"));
        await assert.rejects(
          () => repository.delete(created.id, "stale"),
          (err: unknown) => err instanceof PlanConflictError,
        );
        assert.equal(await repository.delete(created.id, created.digest), true);
        assert.equal(await repository.delete(created.id), false);
        assert.equal(await repository.read(created.id), null);
      },
    },
    {
      name: "lists newest first and pages with a stable cursor",
      async run({ repository }) {
        const titles = ["First", "Second", "Third"];
        for (const [index, title] of titles.entries()) {
          await repository.create(
            record(title, { createdAt: new Date(Date.UTC(2026, 6, 27, 10, index)) }),
          );
        }
        const page = await repository.list({ limit: 2 });
        assert.deepEqual(
          page.records.map((r) => r.index.title),
          ["Third", "Second"],
        );
        assert.ok(page.next_cursor !== undefined);
        const rest = await repository.list({ limit: 2, cursor: page.next_cursor });
        assert.deepEqual(
          rest.records.map((r) => r.index.title),
          ["First"],
        );
        assert.equal(rest.next_cursor, undefined);
      },
    },
    {
      name: "rejects a cursor another backend minted",
      async run({ repository }) {
        for (const [index, title] of ["First", "Second", "Third"].entries()) {
          await repository.create(record(title, { createdAt: pageMinute(index) }));
        }
        const page = await repository.list({ limit: 2 });
        assert.ok(page.next_cursor !== undefined);
        const foreign = foreignCursors(page.next_cursor);
        for (const cursor of foreign) {
          await assert.rejects(
            () => repository.list({ limit: 2, cursor }),
            (error: unknown) =>
              error instanceof PlanCursorError && error.code === "plan_cursor_invalid",
          );
        }
      },
    },
    {
      name: "still pages when the plan a cursor names was deleted",
      async run({ repository }) {
        const created: PlanRecord[] = [];
        for (const [index, title] of ["First", "Second", "Third", "Fourth"].entries()) {
          created.push(await repository.create(record(title, { createdAt: pageMinute(index) })));
        }
        const page = await repository.list({ limit: 2 });
        assert.deepEqual(
          page.records.map((r) => r.index.title),
          ["Fourth", "Third"],
        );
        assert.ok(page.next_cursor !== undefined);
        assert.equal(await repository.delete(created[2]!.id), true);
        const rest = await repository.list({ limit: 2, cursor: page.next_cursor });
        assert.ok(rest.records.length > 0);
      },
    },
    {
      name: "filters before paging, so a filtered page is never short early",
      async run({ repository }) {
        for (let i = 0; i < 4; i += 1) {
          await repository.create(
            record(`Plan ${i}`, {
              createdAt: new Date(Date.UTC(2026, 6, 27, 10, i)),
              retention: i % 2 === 0 ? "keep" : "discard",
            }),
          );
        }
        const page = await repository.list({ limit: 2, retention: "keep" });
        assert.equal(page.records.length, 2);
        assert.ok(page.records.every((r) => r.index.retention === "keep"));
      },
    },
    {
      name: "filters by status",
      async run({ repository }) {
        await repository.create(record("Active one"));
        await repository.create(record("Completed one", { status: "completed" }));
        const page = await repository.list({ status: "completed" });
        assert.deepEqual(
          page.records.map((r) => r.index.title),
          ["Completed one"],
        );
      },
    },
    {
      name: "surfaces a hand edit as a new digest without losing the plan",
      async run({ repository, poke }) {
        if (poke === undefined) return;
        const created = await repository.create(record("Hand edited"));
        const document = parsePlan(created.source, created.index.path);
        const edited = renderPlan({ ...document, notes: "edited by a human" });
        await poke(created.id, edited);
        const reread = await repository.read(created.id);
        assert.equal(reread?.source, edited);
        assert.equal(reread?.digest, digestText(edited));
        assert.notEqual(reread?.digest, created.digest);
      },
    },
    {
      name: "reports an unparseable plan rather than destroying it",
      async run({ repository, poke }) {
        if (poke === undefined) return;
        const created = await repository.create(record("Corrupt"));
        await poke(created.id, mangleBody(created.source));
        await assert.rejects(
          () => repository.read(created.id),
          (err: unknown) => err instanceof InvalidPlanError && err.code === "plan_invalid",
        );
      },
    },
    {
      name: "skips an unparseable plan instead of failing the whole listing",
      async run({ repository, poke }) {
        if (poke === undefined) return;
        const good = await repository.create(
          record("Readable", { createdAt: new Date(Date.UTC(2026, 6, 27, 10, 0)) }),
        );
        const bad = await repository.create(
          record("Broken", { createdAt: new Date(Date.UTC(2026, 6, 27, 10, 1)) }),
        );
        await poke(bad.id, mangleBody(bad.source));
        const page = await repository.list();
        assert.deepEqual(
          page.records.map((r) => r.id),
          [good.id],
        );
      },
    },
  ];
}

/** A fresh provider-facing store and its cleanup hook. */
export interface PlanStoreHarness {
  store: PlanStore;
  cleanup: () => Promise<void>;
}

/** One backend-neutral semantic case for a provider's complete data plane. */
export interface PlanStoreConformanceCase {
  name: string;
  run: (harness: PlanStoreHarness) => Promise<void>;
}

const STORE_INPUT: CreatePlanInput = {
  title: "Provider conformance",
  objective: "exercise the complete PlanStore contract",
  tasks: [{ title: "run every operation" }],
  validation: ["the store remains internally consistent"],
  createdByRun: "conformance-run",
  review: true,
  now: new Date("2026-08-06T12:00:00.000Z"),
};

/** The semantic contract every built-in or external {@link PlanStore} satisfies. */
export function planStoreConformance(): readonly PlanStoreConformanceCase[] {
  return [
    {
      name: "creates, reads, lists and deletes by stable id without requiring a path",
      async run({ store }) {
        const created = await store.create(STORE_INPUT);
        assert.equal(created.retention, "keep");
        assert.equal((await store.read(created.id)).id, created.id);
        assert.ok((await store.list()).plans.some((plan) => plan.id === created.id));
        assert.equal(await store.delete(created.id), true);
        assert.equal(await store.delete(created.id), false);
      },
    },
    {
      name: "reports an unknown id as a typed not-found error",
      async run({ store }) {
        await assert.rejects(
          () => store.read("no-such-plan"),
          (error: unknown) => error instanceof PlanNotFoundError && error.code === "plan_not_found",
        );
      },
    },
    {
      name: "enforces compare-and-swap on update",
      async run({ store }) {
        const created = await store.create(STORE_INPUT);
        const updated = await store.update(created.id, created, (plan) => {
          plan.retention = "discard";
        });
        assert.equal(updated.revision, created.revision + 1);
        assert.equal(updated.retention, "discard");
        await assert.rejects(
          () => store.update(created.id, created, () => undefined),
          (error: unknown) => error instanceof PlanConflictError,
        );
      },
    },
    {
      name: "invalidates approval only for structural revisions",
      async run({ store }) {
        const created = await store.create(STORE_INPUT);
        const approved = await store.update(created.id, created, (plan) => {
          plan.approved_spec_revision = plan.spec_revision;
          plan.status = "active";
        });
        const metadata = await store.revise(approved.id, approved, {
          type: "set_title",
          title: "Renamed",
        });
        assert.equal(metadata.approved_spec_revision, approved.spec_revision);
        assert.equal(metadata.spec_revision, approved.spec_revision);
        const structural = await store.revise(metadata.id, metadata, {
          type: "edit_task",
          task_id: "t1",
          task: { title: "Changed" },
        });
        assert.equal(structural.approved_spec_revision, undefined);
        assert.equal(structural.spec_revision, metadata.spec_revision + 1);
        assert.equal(structural.status, "awaiting_approval");

        const ungated = await store.create({ ...STORE_INPUT, title: "No review", review: false });
        const revised = await store.revise(ungated.id, ungated, {
          type: "add_task",
          task: { title: "Another" },
        });
        assert.equal(revised.approved_spec_revision, undefined);
        assert.equal(revised.status, "active");
      },
    },
    {
      name: "reconciles an unchanged baseline without inventing a revision",
      async run({ store }) {
        const created = await store.create(STORE_INPUT);
        const reconciled = await store.reconcile(created.id, created);
        assert.equal(reconciled.revision, created.revision);
        assert.equal(reconciled.digest, created.digest);
      },
    },
    {
      name: "applies a revision batch atomically under one structural revision",
      async run({ store }) {
        const created = await store.create(STORE_INPUT);
        const revised = await store.revise(created.id, created, [
          { type: "set_objective", objective: "revised through the provider" },
          { type: "add_task", task: { title: "Second" } },
          { type: "add_task", task: { title: "Third" } },
          { type: "set_validation", validation: ["all adapters agree"] },
        ]);
        assert.equal(revised.objective, "revised through the provider");
        assert.equal(revised.tasks.length, 3);
        assert.deepEqual(revised.validation, ["all adapters agree"]);
        assert.equal(revised.revision, created.revision + 1);
        assert.equal(revised.spec_revision, created.spec_revision + 1);

        await assert.rejects(() =>
          store.revise(revised.id, revised, [
            { type: "set_objective", objective: "must not land" },
            { type: "remove_task", task_id: "t99" },
          ]),
        );
        const unchanged = await store.read(revised.id);
        assert.equal(unchanged.objective, revised.objective);
        assert.equal(unchanged.revision, revised.revision);
      },
    },
    {
      name: "filters before paging and returns a stable cursor",
      async run({ store }) {
        const retentions: readonly PlanRetention[] = ["keep", "discard", "keep"];
        for (const [index, retention] of retentions.entries()) {
          await store.create({
            ...STORE_INPUT,
            title: `Filtered ${index}`,
            retention,
            now: new Date(Date.UTC(2026, 7, 6, 12, index)),
          });
        }
        const first = await store.list({ retention: "keep", limit: 1 });
        assert.equal(first.plans.length, 1);
        assert.equal(first.plans[0]?.title, "Filtered 2");
        assert.ok(first.next_cursor !== undefined);
        const second = await store.list({ retention: "keep", limit: 1, cursor: first.next_cursor });
        assert.deepEqual(
          second.plans.map((plan) => plan.title),
          ["Filtered 0"],
        );
        assert.equal(second.next_cursor, undefined);
      },
    },
    {
      name: "rejects a cursor another store minted",
      async run({ store }) {
        for (let index = 0; index < 3; index += 1) {
          await store.create({ ...STORE_INPUT, title: `Foreign ${index}`, now: pageMinute(index) });
        }
        const page = await store.list({ limit: 2 });
        assert.ok(page.next_cursor !== undefined);
        const foreign = foreignCursors(page.next_cursor);
        for (const cursor of foreign) {
          await assert.rejects(
            () => store.list({ limit: 2, cursor }),
            (error: unknown) =>
              error instanceof PlanCursorError && error.code === "plan_cursor_invalid",
          );
        }
      },
    },
    {
      name: "still pages when the plan a cursor names was deleted",
      async run({ store }) {
        for (let index = 0; index < 4; index += 1) {
          await store.create({ ...STORE_INPUT, title: `Paged ${index}`, now: pageMinute(index) });
        }
        const page = await store.list({ limit: 2 });
        assert.equal(page.plans.length, 2);
        assert.ok(page.next_cursor !== undefined);
        assert.equal(await store.delete(page.plans[page.plans.length - 1]!.id), true);
        const rest = await store.list({ limit: 2, cursor: page.next_cursor });
        assert.ok(rest.plans.length > 0);
      },
    },
    {
      name: "seals a completed plan against later revision",
      async run({ store }) {
        const created = await store.create(STORE_INPUT);
        const completed = await store.update(created.id, created, (plan) => {
          plan.status = "completed";
          plan.tasks[0]!.status = "done";
          plan.tasks[0]!.result = "complete";
        });
        await assert.rejects(
          () =>
            store.revise(completed.id, completed, {
              type: "set_objective",
              objective: "too late",
            }),
          (error: unknown) => error instanceof PlanSealedError,
        );
      },
    },
  ];
}
