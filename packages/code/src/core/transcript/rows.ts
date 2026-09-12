import type { TranscriptProjectionId, TranscriptRecordId, TranscriptRowId } from "./identity.ts";

/** Presentation eligibility is an allowlist, not an inference from unknown tool effects. */
const EXPLORATION_TOOLS = new Set([
  "read_file",
  "read_files",
  "read_image",
  "list_dir",
  "glob",
  "grep",
  "diff",
  "file_stat",
  "tree",
]);

/** Namespaced/unknown MCP tools remain individual even when their leaf is familiar. */
export function isExplorationTool(identity: string, server?: string): boolean {
  return (server === undefined || server === "builtin") && EXPLORATION_TOOLS.has(identity);
}

/** Row membership contains IDs only; content and lifecycle are held in records. */
export type TranscriptRow =
  | {
      readonly id: TranscriptRowId;
      readonly kind: "part" | "notice";
      readonly recordId: TranscriptRecordId;
    }
  | {
      readonly id: TranscriptRowId;
      readonly kind: "exploration";
      readonly members: readonly TranscriptRecordId[];
    };

/** Facts needed for first admission; never includes payload or native geometry. */
export interface TranscriptAdmission {
  readonly id: TranscriptRecordId;
  readonly projection: TranscriptProjectionId;
  readonly scope: string;
  readonly kind: "part" | "notice" | "exploration" | "boundary";
  /** Authoritative insertion point for a previously unknown replay fact. */
  readonly before?: TranscriptRowId;
}

/**
 * Ordered row projection with closed, first-admission exploration membership.
 * Repeated records never move or acquire a second destination. A boundary closes only
 * its own actor's group; late results update the member record without reopening it.
 */
export class TranscriptRows {
  readonly #rows = new Map<TranscriptRowId, TranscriptRow>();
  readonly #destinations = new Map<TranscriptRecordId, TranscriptRowId>();
  readonly #seen = new Set<TranscriptRecordId>();
  readonly #boundaries = new Set<TranscriptRecordId>();
  readonly #projections = new Map<TranscriptProjectionId, TranscriptRowId[]>();
  readonly #open = new Map<TranscriptProjectionId, { scope: string; id: TranscriptRowId }>();

  admit(fact: TranscriptAdmission): boolean {
    if (this.#seen.has(fact.id)) {
      if (fact.kind === "boundary" || !this.#boundaries.delete(fact.id)) return false;
    }
    this.#seen.add(fact.id);
    if (fact.kind === "boundary") {
      this.#boundaries.add(fact.id);
      this.#open.delete(fact.projection);
      return false;
    }
    const open = this.#open.get(fact.projection);
    if (fact.before === undefined && fact.kind === "exploration" && open?.scope === fact.scope) {
      const row = this.#rows.get(open.id);
      if (row?.kind === "exploration") {
        this.#rows.set(
          row.id,
          Object.freeze({ ...row, members: Object.freeze([...row.members, fact.id]) }),
        );
        this.#destinations.set(fact.id, row.id);
        return true;
      }
    }
    this.#open.delete(fact.projection);
    const id = fact.kind === "exploration" ? `exploration:${fact.id}` : fact.id;
    this.#rows.set(
      id,
      Object.freeze(
        fact.kind === "exploration"
          ? { id, kind: "exploration", members: Object.freeze([fact.id]) }
          : { id, kind: fact.kind, recordId: fact.id },
      ),
    );
    this.#destinations.set(fact.id, id);
    const projection = this.#projections.get(fact.projection) ?? [];
    const before = fact.before === undefined ? -1 : projection.indexOf(fact.before);
    if (before < 0) projection.push(id);
    else projection.splice(before, 0, id);
    this.#projections.set(fact.projection, projection);
    if (fact.kind === "exploration" && fact.before === undefined)
      this.#open.set(fact.projection, { scope: fact.scope, id });
    return true;
  }

  select(projection: TranscriptProjectionId): readonly TranscriptRowId[] {
    return this.#projections.get(projection) ?? [];
  }

  row(id: TranscriptRowId): TranscriptRow | undefined {
    return this.#rows.get(id);
  }
  destination(id: TranscriptRecordId): TranscriptRowId | undefined {
    return this.#destinations.get(id);
  }

  /** Prune only facts discarded by host retention, including closed membership and identity maps. */
  retain(ids: ReadonlySet<TranscriptRecordId>): void {
    for (const id of this.#seen) if (!ids.has(id)) this.#seen.delete(id);
    for (const id of this.#boundaries) if (!ids.has(id)) this.#boundaries.delete(id);
    for (const [id] of this.#destinations) if (!ids.has(id)) this.#destinations.delete(id);
    for (const [id, row] of this.#rows) {
      if (row.kind === "exploration") {
        const members = row.members.filter((member) => ids.has(member));
        if (members.length === 0) this.#rows.delete(id);
        else if (members.length !== row.members.length)
          this.#rows.set(id, Object.freeze({ ...row, members: Object.freeze(members) }));
      } else if (!ids.has(row.recordId)) this.#rows.delete(id);
    }
    for (const [projection, rows] of this.#projections) {
      const kept = rows.filter((id) => this.#rows.has(id));
      if (kept.length === 0) {
        this.#projections.delete(projection);
        this.#open.delete(projection);
      } else this.#projections.set(projection, kept);
    }
    for (const [projection, open] of this.#open)
      if (!this.#rows.has(open.id)) this.#open.delete(projection);
  }
}
