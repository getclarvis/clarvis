import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import type { Session, SessionSummary } from "@clarvis/protocol";
import { globalPaths } from "@clarvis/paths";
import {
  createSessionService,
  referencedSessionExecutionIds,
  retainSessionSummary,
} from "../../src/sessions/session-service.ts";
import { recordingLogger } from "../helpers/logger.ts";

function session(id: string, updatedAt: number): Session {
  return {
    id,
    title: `session ${id}`,
    project_id: "prj_test",
    workspace: "ws_test",
    created_at: 1,
    updated_at: updatedAt,
    turns: [{ user_preview: "hi", status: "done" }],
    totals: { input: 0, output: 0, cached: 0 },
  };
}

function summary(value: Session): SessionSummary {
  return {
    id: value.id,
    title: value.title,
    project_id: value.project_id,
    workspace: value.workspace,
    created_at: value.created_at,
    updated_at: value.updated_at,
    turn_count: value.turns.length,
    ...(value.turns.at(-1) === undefined ? {} : { last_status: value.turns.at(-1)!.status }),
    totals: value.totals,
  };
}

describe("SessionService (file-backed)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-sessions-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("save/get/list round-trip, newest-updated first", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await svc.save(session("s1", 100));
    await svc.save(session("s2", 300));
    await svc.save(session("s3", 200));

    expect((await svc.get("s2"))?.title).toBe("session s2");
    expect((await svc.list()).map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
    expect((await svc.listPage()).items.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
  });

  it("indexes only execution ids from valid full session records across owners", async () => {
    const first = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const second = createSessionService({
      dir,
      owner: "owner-b",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await first.save({
      ...session("a", 1),
      turns: [{ user_preview: "a", status: "done", execution_id: "exec_a" }],
    });
    await second.save({
      ...session("b", 2),
      turns: [{ user_preview: "b", status: "done", execution_id: "exec_b" }],
    });
    writeFileSync(join(globalPaths(dir).sessionsDir, "owner-a", "broken.json"), "{bad");

    const references = referencedSessionExecutionIds(dir);
    expect(references.complete).toBe(true);
    expect([...references.ids].sort()).toEqual(["exec_a", "exec_b"]);
  });

  it("marks a bounded reference scan incomplete instead of authorizing deletion", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await svc.save({
      ...session("a", 1),
      turns: [{ user_preview: "a", status: "done", execution_id: "exec_a" }],
    });

    const references = referencedSessionExecutionIds(dir, { maxFiles: 0 });
    expect(references.complete).toBe(false);
    expect(references.ids.size).toBe(0);
  });

  it("pages summaries with a stable timestamp/id cursor", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await svc.save(session("a", 300));
    await svc.save(session("b", 300));
    await svc.save(session("c", 200));

    const first = await svc.listPage({ limit: 2 });
    expect(first.items.map((item) => [item.id, item.turn_count, item.last_status])).toEqual([
      ["b", 1, "done"],
      ["a", 1, "done"],
    ]);
    expect(first.next_cursor).toBeDefined();
    const second = await svc.listPage({ limit: 2, cursor: first.next_cursor });
    expect(second.items.map((item) => item.id)).toEqual(["c"]);
    expect(second.next_cursor).toBeUndefined();
  });

  it("retains exact newest top-K summaries in bounded heap space", () => {
    const values = [5, 1, 9, 3, 8, 2, 10, 4, 7, 6].map((updatedAt) =>
      summary(session(`heap-${updatedAt}`, updatedAt)),
    );
    const heap: SessionSummary[] = [];

    for (const value of values) retainSessionSummary(heap, value, 4);

    expect(heap).toHaveLength(4);
    expect(heap.map((value) => value.updated_at).sort((a, b) => b - a)).toEqual([10, 9, 8, 7]);
  });

  it("scans a large catalog in bounded event-loop slices while keeping exact top-K order", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const ownerDir = join(globalPaths(dir).sessionsDir, "owner-a");
    mkdirSync(ownerDir, { recursive: true });
    const ids: string[] = [];
    for (let index = 0; index < 513; index += 1) {
      const id = `s-${String(index).padStart(4, "0")}`;
      const value = session(id, index);
      ids.push(id);
      writeFileSync(join(ownerDir, `${id}.json`), JSON.stringify(value));
      writeFileSync(join(ownerDir, `${id}.summary.json`), JSON.stringify(summary(value)));
    }

    let settled = false;
    const listing = svc.listPage({ limit: 25 }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    const first = await listing;
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(-25).reverse());
    const second = await svc.listPage({ limit: 25, cursor: first.next_cursor });
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(-50, -25).reverse());
  });

  it("stops a cooperative catalog scan when its transport signal aborts", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    for (let index = 0; index < 129; index += 1) {
      await svc.save(session(`cancel-${String(index).padStart(3, "0")}`, index));
    }
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(svc.listPage({}, { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("builds a bounded summary sidecar for a legacy record on first page read", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const ownerDir = join(globalPaths(dir).sessionsDir, "owner-a");
    mkdirSync(ownerDir, { recursive: true });
    writeFileSync(join(ownerDir, "legacy.json"), JSON.stringify(session("legacy", 10)));

    expect((await svc.listPage()).items.map((item) => item.id)).toEqual(["legacy"]);
    expect(existsSync(join(ownerDir, "legacy.summary.json"))).toBe(true);
  });

  it("skips legacy records whose title or totals cannot fit a bounded summary", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const ownerDir = join(globalPaths(dir).sessionsDir, "owner-a");
    mkdirSync(ownerDir, { recursive: true });
    writeFileSync(
      join(ownerDir, "large-title.json"),
      JSON.stringify({ ...session("large-title", 10), title: "x".repeat(9 * 1024) }),
    );
    writeFileSync(
      join(ownerDir, "large-totals.json"),
      JSON.stringify({
        ...session("large-totals", 11),
        totals: { input: 0, output: 0, cached: 0, legacy_detail: "x".repeat(9 * 1024) },
      }),
    );

    await expect(svc.listPage()).resolves.toEqual({ items: [] });
    expect(existsSync(join(ownerDir, "large-title.summary.json"))).toBe(false);
    expect(existsSync(join(ownerDir, "large-totals.summary.json"))).toBe(false);
  });

  it("repairs a corrupt or stale-looking sidecar from the authoritative session", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const authoritative = { ...session("repair", 12), title: "authoritative" };
    await svc.save(authoritative);
    const ownerDir = join(globalPaths(dir).sessionsDir, "owner-a");
    writeFileSync(join(ownerDir, "repair.summary.json"), "{broken");

    const page = await svc.listPage();

    expect(page.items).toEqual([
      expect.objectContaining({ id: authoritative.id, title: "authoritative", updated_at: 12 }),
    ]);
  });

  it("rejects invalid pagination and summaries that cannot fit their sidecar", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await expect(svc.listPage({ limit: 201 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      svc.save({ ...session("large", 1), title: "x".repeat(9 * 1024) }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("rejects malformed and excessive cursors before scanning the catalog", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const cursor = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

    await expect(svc.listPage({ cursor: "x".repeat(257) })).rejects.toMatchObject({
      code: "invalid_request",
    });
    for (const invalid of [
      "not-json",
      cursor(null),
      cursor([]),
      cursor(["not-a-number", "id"]),
      Buffer.from('[1e999,"id"]', "utf8").toString("base64url"),
      cursor([1, 2]),
      cursor([1, ""]),
    ]) {
      await expect(svc.listPage({ cursor: invalid })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  });

  it("preflights the complete JSON value without invoking custom serialization", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const unusual = session("unusual", 1) as Session & { extra: unknown };
    const inherited = Object.create({ ignored: "prototype value" }) as Record<string, unknown>;
    inherited.own = 'quotes " slash \\ controls \b\t\n\f\r\u0001 unicode é € 😀 \ud800x\udc00';
    unusual.extra = {
      inherited,
      array: [undefined, () => undefined, Symbol("omitted"), null, false, Number.NaN],
    };

    await svc.save(unusual);
    expect((await svc.get("unusual")) as Session & { extra: unknown }).toMatchObject({
      extra: { inherited: { own: expect.stringContaining("unicode") } },
    });

    const custom = session("custom-json", 2) as Session & { extra: unknown };
    custom.extra = { toJSON: () => ({ silently: "expanded" }) };
    await expect(svc.save(custom)).rejects.toMatchObject({ code: "resource_exhausted" });

    const bigint = session("bigint", 3) as Session & { extra: unknown };
    bigint.extra = 1n;
    await expect(svc.save(bigint)).rejects.toMatchObject({ code: "resource_exhausted" });

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 130; depth += 1) nested = [nested];
    const deep = session("deep", 4) as Session & { extra: unknown };
    deep.extra = nested;
    await expect(svc.save(deep)).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("rejects sessions for another workspace before writing either document", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });

    await expect(
      svc.save({ ...session("foreign", 1), workspace: "ws_other" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await svc.get("foreign")).toBeNull();
  });

  it("repairs an oversized sidecar from its bounded authoritative record", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await svc.save(session("oversized-sidecar", 10));
    const sidecar = join(globalPaths(dir).sessionsDir, "owner-a", "oversized-sidecar.summary.json");
    truncateSync(sidecar, 8 * 1024 + 1);

    expect((await svc.listPage()).items.map((item) => item.id)).toEqual(["oversized-sidecar"]);
    expect(JSON.parse(await Bun.file(sidecar).text())).toMatchObject({ id: "oversized-sidecar" });
  });

  it("bounds legacy full-document listing and yields during a large scan", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const ownerDir = join(globalPaths(dir).sessionsDir, "owner-a");
    mkdirSync(ownerDir, { recursive: true });
    for (let index = 0; index < 201; index += 1) {
      const id = `legacy-${String(index).padStart(3, "0")}`;
      writeFileSync(join(ownerDir, `${id}.json`), JSON.stringify(session(id, index)));
    }

    expect((await svc.listPage({ limit: 1 })).items[0]?.id).toBe("legacy-200");
    await expect(svc.list()).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("get returns null for a missing id; delete reports found/not-found", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    expect(await svc.get("ghost")).toBeNull();
    await svc.save(session("s1", 1));
    expect(await svc.delete("s1")).toBe(true);
    expect(await svc.delete("s1")).toBe(false);
    expect(await svc.get("s1")).toBeNull();
  });

  it("owners are isolated", async () => {
    const a = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    const b = createSessionService({
      dir,
      owner: "owner-b",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await a.save(session("s1", 1));
    expect((await a.list()).length).toBe(1);
    expect((await b.list()).length).toBe(0);
  });

  it("a corrupt file in the owner dir is skipped, not thrown", async () => {
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
    });
    await svc.save(session("good", 1));
    mkdirSync(join(globalPaths(dir).sessionsDir, "owner-a"), { recursive: true });
    writeFileSync(join(globalPaths(dir).sessionsDir, "owner-a", "junk.json"), "{ not json");
    expect((await svc.list()).map((s) => s.id)).toEqual(["good"]);
  });
});

describe("sessions.rehydrate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-sessions-log-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports how much of a restored session was found", async () => {
    const logger = recordingLogger();
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
      logger,
    });
    await svc.save(session("s1", 100));
    await svc.get("s1");
    expect(logger.events("sessions.rehydrate")[0]).toMatchObject({
      session_id: "s1",
      found: true,
    });
  });

  it("distinguishes a session that could not be read from one with no turns", async () => {
    const logger = recordingLogger();
    const svc = createSessionService({
      dir,
      owner: "owner-a",
      projectId: "prj_test",
      workspaceId: "ws_test",
      logger,
    });
    expect(await svc.get("missing")).toBeNull();
    expect(logger.events("sessions.rehydrate")[0]).toMatchObject({
      session_id: "missing",
      found: false,
      turns: 0,
    });
  });
});
