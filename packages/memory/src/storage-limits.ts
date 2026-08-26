/**
 * One authority for every filesystem working-set and persistence bound.
 *
 * Keep these limits independent of model-facing budgets: they protect the
 * process even when the wiki or its machinery was edited outside Clarvis.
 */
export const MEMORY_STORAGE_LIMITS = {
  /** One wiki document, and one revision pre-image. */
  documentBytes: 2 * 1024 * 1024,
  revisionBodyBytes: 2 * 1024 * 1024,
  /** JSON machinery: journal records, jobs and revision metadata. */
  metadataBytes: 1024 * 1024,
  /** Prefix sufficient for frontmatter and authored recording policy. */
  prefixBytes: 64 * 1024,
  /** Filesystem entries visited by one repository scan. */
  scanEntries: 10_000,
  /** Documents/operations one atomic batch may retain. */
  batchOperations: 256,
  /** Aggregate decoded/file corpus admitted by one read-oriented operation. */
  corpusBytes: 32 * 1024 * 1024,
} as const;

export type MemoryStorageKind =
  "document" | "revision body" | "metadata" | "corpus" | "entries" | "batch operations";

/** Explicit failure returned when persisted or caller-supplied data exceeds its contract. */
export class MemoryStorageLimitError extends Error {
  readonly code = "memory_storage_limit";
  readonly kind: MemoryStorageKind;
  readonly identifier: string;
  readonly actual: number;
  readonly maximum: number;

  constructor(args: {
    kind: MemoryStorageKind;
    identifier: string;
    actual: number;
    maximum: number;
  }) {
    super(
      `memory: ${args.kind} '${args.identifier}' is ${String(args.actual)} bytes/entries; ` +
        `maximum is ${String(args.maximum)}`,
    );
    this.name = "MemoryStorageLimitError";
    this.kind = args.kind;
    this.identifier = args.identifier;
    this.actual = args.actual;
    this.maximum = args.maximum;
  }
}

/** Refuse an already-materialized UTF-8 payload before it reaches persistence or staging. */
export function assertMemoryPayloadBytes(
  kind: Extract<MemoryStorageKind, "document" | "revision body" | "metadata">,
  identifier: string,
  payload: string,
  maximum: number,
): number {
  const actual = Buffer.byteLength(payload, "utf8");
  if (actual > maximum) {
    throw new MemoryStorageLimitError({ kind, identifier, actual, maximum });
  }
  return actual;
}

/** Refuse a count/aggregate before retaining more values. */
export function assertMemoryStorageCount(
  kind: Extract<MemoryStorageKind, "corpus" | "entries" | "batch operations">,
  identifier: string,
  actual: number,
  maximum: number,
): void {
  if (actual > maximum) {
    throw new MemoryStorageLimitError({ kind, identifier, actual, maximum });
  }
}
