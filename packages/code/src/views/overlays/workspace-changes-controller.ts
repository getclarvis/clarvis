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
    setLoading(true);
    try {
      const nextAvailability = await service.availability({ signal });
      if (token !== generation) return;
      setAvailability(nextAvailability);
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
      setPage(nextPage);
      const stillSelected =
        selectedId() !== null && nextPage.items.some((item) => item.id === selectedId());
      const nextSelected = stillSelected ? selectedId() : (nextPage.items[0]?.id ?? null);
      setSelectedId(nextSelected);
      if (nextSelected === null) {
        setDetail(null);
        return;
      }
      const nextDetail = await service.read(
        { query_id: nextPage.query_id, entry_id: nextSelected, comparison_id: comparison },
        { signal },
      );
      if (token !== generation) return;
      setDetail(nextDetail);
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
          if (token === generation) setDetail(next);
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
