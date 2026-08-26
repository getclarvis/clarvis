import type { TraceEvent } from "./trace-events.ts";
import { BUILTIN_TRACE_KINDS, type TraceEntry } from "./trace-kinds.ts";

const BUILTIN_KIND_SET: ReadonlySet<string> = new Set(BUILTIN_TRACE_KINDS);

/** A capability-owned flat event ready for persistence after sanitization. */
export interface PersistedTraceProjection {
  readonly type: string;
  readonly [field: string]: unknown;
}

/** Timestamp conversion supplied by the trace implementation to a projector. */
export interface PersistedTraceProjectorContext {
  /** Rebase one run-relative millisecond offset to absolute Unix time. */
  absoluteTime(offset: number): number;
}

/** Static projection for one trace kind contributed by a capability. */
export interface PersistedTraceProjector {
  readonly kind: string;
  project(
    entry: TraceEntry,
    context: PersistedTraceProjectorContext,
  ): TraceEvent | PersistedTraceProjection | null;
}

/** An immutable projector lookup snapshot, scoped to a host or one run. */
export interface PersistedTraceProjectorRegistry {
  projectorFor(kind: string): PersistedTraceProjector | undefined;
  projectors(): readonly PersistedTraceProjector[];
}

/** Build an immutable projector registry with duplicate-kind protection. */
export function createPersistedTraceProjectorRegistry(
  projectors: readonly PersistedTraceProjector[] = [],
): PersistedTraceProjectorRegistry {
  const byKind = new Map<string, PersistedTraceProjector>();
  for (const projector of projectors) {
    if (projector.kind.trim().length === 0) {
      throw new Error("persisted trace projector kind must be a non-empty string");
    }
    if (BUILTIN_KIND_SET.has(projector.kind)) {
      throw new Error(
        `persisted trace projector '${projector.kind}' cannot replace an engine-owned trace kind`,
      );
    }
    if (byKind.has(projector.kind)) {
      throw new Error(`persisted trace projector '${projector.kind}' is already registered`);
    }
    byKind.set(projector.kind, projector);
  }
  const snapshot = Object.freeze([...byKind.values()]);
  return Object.freeze({
    projectorFor(kind: string): PersistedTraceProjector | undefined {
      return byKind.get(kind);
    },
    projectors(): readonly PersistedTraceProjector[] {
      return snapshot;
    },
  });
}

/** Copy a host registry and append run-scoped projector declarations. */
export function composePersistedTraceProjectors(
  base: PersistedTraceProjectorRegistry | undefined,
  additions: readonly PersistedTraceProjector[],
): PersistedTraceProjectorRegistry {
  return createPersistedTraceProjectorRegistry([...(base?.projectors() ?? []), ...additions]);
}
