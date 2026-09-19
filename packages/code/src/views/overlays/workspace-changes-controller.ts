import { createSignal, type Accessor } from "solid-js";
import type {
  WorkspaceChangeDetail,
  WorkspaceChangeEntry,
  WorkspaceChangesAvailability,
  WorkspaceChangesPage,
  WorkspaceChangesService,
} from "@clarvis/protocol";

const DEFAULT_POLL_MS = 2500;

/** Reactive loader for the workspace-changes overlay. */
export interface WorkspaceChangesController {
  availability: Accessor<WorkspaceChangesAvailability | null>;
  page: Accessor<WorkspaceChangesPage | null>;
  detail: Accessor<WorkspaceChangeDetail | null>;
  loading: Accessor<boolean>;
  error: Accessor<string | null>;
  comparisonId: Accessor<string>;
  selectedId: Accessor<string | null>;
  setVisible(visible: boolean): void;
  setComparison(id: string): void;
  select(id: string | null): void;
  refresh(): void;
  cycleComparison(delta: number): void;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "could not load workspace changes";
}

function sameAvailability(
  current: WorkspaceChangesAvailability | null,
  next: WorkspaceChangesAvailability,
): boolean {
  if (current === null || current.status !== next.status) return false;
  if (current.status !== "available" || next.status !== "available") {
    return current.status !== "available" && next.status !== "available"
      ? current.reason.code === next.reason.code && current.reason.message === next.reason.message
      : false;
  }
  return (
    current.provider.id === next.provider.id &&
    current.provider.default_comparison_id === next.provider.default_comparison_id &&
    current.provider.workspace_identity === next.provider.workspace_identity &&
    current.provider.comparisons.length === next.provider.comparisons.length &&
    current.provider.comparisons.every(
      (item, index) =>
        item.id === next.provider.comparisons[index]?.id &&
        item.label === next.provider.comparisons[index]?.label,
    )
  );
}

function sameEntry(left: WorkspaceChangeEntry, right: WorkspaceChangeEntry): boolean {
  return (
    left.id === right.id &&
    left.operation === right.operation &&
    left.old_path === right.old_path &&
    left.new_path === right.new_path &&
    left.staged === right.staged &&
    left.unstaged === right.unstaged &&
    left.binary === right.binary &&
    left.stats?.additions === right.stats?.additions &&
    left.stats?.deletions === right.stats?.deletions
  );
}

function samePage(current: WorkspaceChangesPage | null, next: WorkspaceChangesPage): boolean {
  if (current === null) return false;
  return (
    current.query_id === next.query_id &&
    current.comparison_id === next.comparison_id &&
    current.resolved_base === next.resolved_base &&
    current.incomplete === next.incomplete &&
    current.items.length === next.items.length &&
    current.items.every((item, index) => {
      const other = next.items[index];
      return other !== undefined && sameEntry(item, other);
    })
  );
}

function sameDetail(current: WorkspaceChangeDetail | null, next: WorkspaceChangeDetail): boolean {
  if (current === null) return false;
  return (
    current.entry_id === next.entry_id &&
    current.query_id === next.query_id &&
    current.comparison_id === next.comparison_id &&
    current.status === next.status &&
    current.patch === next.patch &&
    current.message === next.message
  );
}

/**
 * Load availability, inventory and on-demand detail with generation fencing,
 * coalesced refresh, and polling only while the overlay is visible.
 */
export function createWorkspaceChangesController(options: {
  service: Accessor<WorkspaceChangesService | undefined>;
  pollMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): WorkspaceChangesController {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const [availability, setAvailability] = createSignal<WorkspaceChangesAvailability | null>(null);
  const [page, setPage] = createSignal<WorkspaceChangesPage | null>(null);
  const [detail, setDetail] = createSignal<WorkspaceChangeDetail | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [comparisonId, setComparisonId] = createSignal("");
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  let generation = 0;
  let visible = false;
  let inFlight = false;
  let queued = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let abort: AbortController | undefined;

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  const cancel = (): void => {
    abort?.abort();
    abort = undefined;
  };

  const load = async (): Promise<void> => {
    if (inFlight) {
      queued = true;
      return;
    }
    const service = options.service();
    if (service === undefined) {
      setAvailability(null);
      setPage(null);
      setDetail(null);
      setError("workspace changes are unavailable");
      return;
    }
    inFlight = true;
    queued = false;
    const token = ++generation;
    cancel();
    abort = new AbortController();
    const signal = abort.signal;
    if (page() === null && detail() === null) setLoading(true);
    try {
      const nextAvailability = await service.availability({ signal });
      if (token !== generation) return;
      if (!sameAvailability(availability(), nextAvailability)) setAvailability(nextAvailability);
      setError(null);
      if (nextAvailability.status !== "available") {
        setPage(null);
        setDetail(null);
        return;
      }
      const comparisons = nextAvailability.provider.comparisons;
      let comparison = comparisonId();
      if (comparison.length === 0 || !comparisons.some((item) => item.id === comparison)) {
        comparison = nextAvailability.provider.default_comparison_id;
        setComparisonId(comparison);
      }
      const nextPage = await service.list({ comparison_id: comparison }, { signal });
      if (token !== generation) return;
      if (!samePage(page(), nextPage)) setPage(nextPage);
      const stillSelected =
        selectedId() !== null && nextPage.items.some((item) => item.id === selectedId());
      const nextSelected = stillSelected ? selectedId() : (nextPage.items[0]?.id ?? null);
      if (nextSelected !== selectedId()) setSelectedId(nextSelected);
      if (nextSelected === null) {
        if (detail() !== null) setDetail(null);
        return;
      }
      const nextDetail = await service.read(
        { query_id: nextPage.query_id, entry_id: nextSelected, comparison_id: comparison },
        { signal },
      );
      if (token !== generation) return;
      if (!sameDetail(detail(), nextDetail)) setDetail(nextDetail);
    } catch (caught) {
      if (token !== generation || signal.aborted) return;
      setError(errorMessage(caught));
    } finally {
      if (token === generation) setLoading(false);
      inFlight = false;
      if (queued && visible) requestLoad();
    }
  };

  const requestLoad = (): void => {
    void load().catch(() => undefined);
  };

  const startTimer = (): void => {
    stopTimer();
    timer = setIntervalFn(() => {
      if (visible) requestLoad();
    }, pollMs);
  };

  return {
    availability,
    page,
    detail,
    loading,
    error,
    comparisonId,
    selectedId,
    setVisible(next) {
      visible = next;
      if (!next) {
        stopTimer();
        cancel();
        return;
      }
      requestLoad();
      startTimer();
    },
    setComparison(id) {
      if (id === comparisonId()) return;
      setComparisonId(id);
      setSelectedId(null);
      setDetail(null);
      requestLoad();
    },
    select(id) {
      setSelectedId(id);
      const current = page();
      const service = options.service();
      if (id === null || current === null || service === undefined) {
        setDetail(null);
        return;
      }
      const token = ++generation;
      void service
        .read(
          { query_id: current.query_id, entry_id: id, comparison_id: comparisonId() },
          abort === undefined ? undefined : { signal: abort.signal },
        )
        .then((next) => {
          if (token === generation && !sameDetail(detail(), next)) setDetail(next);
        })
        .catch((caught: unknown) => {
          if (token === generation) setError(errorMessage(caught));
        });
    },
    refresh() {
      requestLoad();
    },
    cycleComparison(delta) {
      const current = availability();
      if (current?.status !== "available") return;
      const ids = current.provider.comparisons.map((item) => item.id);
      if (ids.length === 0) return;
      const index = Math.max(0, ids.indexOf(comparisonId()));
      const next = ids[(index + delta + ids.length * 8) % ids.length]!;
      if (next === comparisonId()) return;
      setComparisonId(next);
      setSelectedId(null);
      setDetail(null);
      requestLoad();
    },
    dispose() {
      visible = false;
      generation += 1;
      stopTimer();
      cancel();
    },
  };
}

export function selectedEntry(
  page: WorkspaceChangesPage | null,
  selectedId: string | null,
): WorkspaceChangeEntry | null {
  if (page === null || selectedId === null) return null;
  return page.items.find((item) => item.id === selectedId) ?? null;
}
