import { batch, createRoot, createSignal } from "solid-js";
import type { RunDetail, RunEvent } from "@clarvis/protocol";
import {
  applyEvent,
  createTranscriptStore,
  type TranscriptRunSink,
  type TranscriptStore,
  type TranscriptStoreDeps,
  type TranscriptMemoryCounters,
} from "./store.ts";
import type { EventSource } from "./event-span.ts";

const TAIL_EVENTS_PER_CHILD = 96;
const TAIL_BYTES_PER_CHILD = 128 * 1024;
const TAIL_BYTES_TOTAL = 1024 * 1024;
const TAIL_EVENT_MAX_BYTES = 16 * 1024;

interface ChildEntry {
  executionId: string;
  id: string;
  created?: RunEvent;
  tail: { event: RunEvent; bytes: number }[];
  tailBytes: number;
  settled: boolean;
  store?: TranscriptStore;
  sink?: TranscriptRunSink;
  dispose?: () => void;
}

export interface ChildTranscriptStore extends TranscriptStore {
  /** Selects the only detailed child projection allowed to remain resident. */
  selectSubagent(id: string | null): void;
}

/** Keeps hidden child activity bounded while preserving the existing Lead store. */
export function createChildTranscriptStore(
  deps: TranscriptStoreDeps & { fetchRun: (executionId: string) => Promise<RunDetail | null> },
): ChildTranscriptStore {
  const lead = createTranscriptStore(deps);
  const children = new Map<string, ChildEntry>();
  const [selected, setSelected] = createSignal<string | null>(null);
  const [loadStatus, setLoadStatus] = createSignal<"idle" | "loading" | "ready" | "unavailable">(
    "idle",
  );
  const [residenceRevision, setResidenceRevision] = createSignal(0);
  let tailBytesTotal = 0;
  let generation = 0;

  const selectedEntry = (): ChildEntry | undefined => {
    const id = selected();
    return id === null ? undefined : children.get(id);
  };

  const evict = (entry: ChildEntry): void => {
    const wasSelected = selectedEntry() === entry && entry.store !== undefined;
    entry.dispose?.();
    entry.store = undefined;
    entry.sink = undefined;
    entry.dispose = undefined;
    if (wasSelected) setResidenceRevision((revision) => revision + 1);
  };

  const forgetTail = (entry: ChildEntry): void => {
    tailBytesTotal -= entry.tailBytes;
    entry.tail = [];
    entry.tailBytes = 0;
  };

  const entryFor = (executionId: string, id: string): ChildEntry => {
    const key = JSON.stringify([executionId, id]);
    let entry = children.get(key);
    if (entry === undefined) {
      entry = { executionId, id, tail: [], tailBytes: 0, settled: false };
      children.set(key, entry);
    }
    return entry;
  };

  const entryById = (id: string): ChildEntry | undefined =>
    [...children.values()].findLast((entry) => entry.id === id);

  const pruneFolded = (): void => {
    const retained = new Set<string>();
    for (const node of lead.nodes)
      if (node.kind === "user" && node.sourceExecutionId !== undefined)
        retained.add(node.sourceExecutionId);
    for (const [key, entry] of children) {
      if (retained.has(entry.executionId)) continue;
      if (selectedEntry() === entry) setSelected(null);
      forgetTail(entry);
      evict(entry);
      children.delete(key);
    }
  };

  const makeResident = (entry: ChildEntry, created = entry.created, withTail = true): void => {
    if (entry.store !== undefined) return;
    entry.dispose = createRoot((dispose) => {
      entry.store = createTranscriptStore(deps);
      entry.sink = entry.store.openRun(entry.executionId);
      if (created) applyEvent(entry.sink, created, "replay");
      return dispose;
    });
    if (withTail)
      batch(() => {
        for (const item of entry.tail) applyEvent(entry.sink!, item.event, "replay");
      });
    if (selectedEntry() === entry) setResidenceRevision((revision) => revision + 1);
  };

  const load = async (entry: ChildEntry, token: number): Promise<void> => {
    let detail: RunDetail | null;
    try {
      detail = await deps.fetchRun(entry.executionId);
    } catch {
      if (token === generation) setLoadStatus("unavailable");
      return;
    }
    if (token !== generation || selected() !== JSON.stringify([entry.executionId, entry.id]))
      return;
    if (detail === null) {
      setLoadStatus("unavailable");
      return;
    }
    const created =
      detail.events.find(
        (event) => event.type === "delegation_created" && event.delegation_id === entry.id,
      ) ?? entry.created;
    const persistedChild = detail.events.filter(
      (event) => "agent" in event && event.agent === "subagent" && event.subagent_id === entry.id,
    );
    const persistedTail = persistedChild
      .slice(-entry.tail.length)
      .map((event) => JSON.stringify(event));
    const liveTail = entry.tail.map((item) => JSON.stringify(item.event));
    let overlap = 0;
    for (let count = Math.min(persistedTail.length, liveTail.length); count > 0; count--) {
      if (
        liveTail
          .slice(0, count)
          .every((event, index) => event === persistedTail[persistedTail.length - count + index])
      ) {
        overlap = count;
        break;
      }
    }
    batch(() => {
      evict(entry);
      makeResident(entry, created, false);
      entry.sink!.beginReconcile();
      if (created) applyEvent(entry.sink!, created, "replay");
      for (const event of detail.events)
        if (
          ("agent" in event && event.agent === "subagent" && event.subagent_id === entry.id) ||
          ((event.type === "delegation_started" ||
            event.type === "delegation_completed" ||
            event.type === "delegation_failed") &&
            event.delegation_id === entry.id)
        )
          applyEvent(entry.sink!, event, "replay");
      for (const item of entry.tail.slice(overlap)) applyEvent(entry.sink!, item.event, "live");
      entry.sink!.endReconcile();
      if (entry.settled) entry.sink!.complete();
    });
    setLoadStatus("ready");
  };

  const remember = (entry: ChildEntry, event: RunEvent): void => {
    if (entry.settled) return;
    const bytes = JSON.stringify(event).length * 2;
    if (bytes > TAIL_EVENT_MAX_BYTES) {
      forgetTail(entry);
      return;
    }
    entry.tail.push({ event, bytes });
    entry.tailBytes += bytes;
    tailBytesTotal += bytes;
    while (entry.tail.length > TAIL_EVENTS_PER_CHILD || entry.tailBytes > TAIL_BYTES_PER_CHILD) {
      const oldest = entry.tail.shift()!;
      entry.tailBytes -= oldest.bytes;
      tailBytesTotal -= oldest.bytes;
    }
    while (tailBytesTotal > TAIL_BYTES_TOTAL) {
      const victim = [...children.values()].find(
        (candidate) => candidate.tail.length > 0 && candidate !== selectedEntry(),
      );
      if (victim === undefined) break;
      const oldest = victim.tail.shift()!;
      victim.tailBytes -= oldest.bytes;
      tailBytesTotal -= oldest.bytes;
    }
  };

  const route = (
    executionId: string,
    leadSink: TranscriptRunSink,
    event: RunEvent,
    source: EventSource,
  ): void => {
    if (event.type === "delegation_created") {
      const entry = entryFor(executionId, event.delegation_id);
      entry.created = {
        ...event,
        task:
          event.task.length <= 4096
            ? event.task
            : `${event.task.slice(0, 4096)}\n[Earlier task text omitted from live TUI; stored run retains it.]`,
      };
      applyEvent(leadSink, entry.created, source);
      if (entry.sink) applyEvent(entry.sink, event, source);
      return;
    }
    if (
      event.type === "delegation_started" ||
      event.type === "delegation_completed" ||
      event.type === "delegation_failed"
    ) {
      applyEvent(leadSink, event, source);
      const entry = entryFor(executionId, event.delegation_id);
      if (entry.sink) applyEvent(entry.sink, event, source);
      if (event.type === "delegation_completed" || event.type === "delegation_failed") {
        entry.settled = true;
        if (selectedEntry() !== entry) evict(entry);
      }
      return;
    }
    if ("agent" in event && event.agent === "subagent") {
      const entry = entryFor(executionId, event.subagent_id ?? `unattributed:${executionId}`);
      if (entry.sink) applyEvent(entry.sink, event, source);
      if (source === "live") remember(entry, event);
      return;
    }
    applyEvent(leadSink, event, source);
  };

  const openRun = (executionId: string): TranscriptRunSink => {
    const leadSink = lead.openRun(executionId);
    const dispatch = (_span: unknown, event: RunEvent, source: EventSource): void =>
      route(executionId, leadSink, event, source);
    return {
      open: dispatch,
      point: dispatch,
      close: dispatch,
      queueSteer: (message) => leadSink.queueSteer?.(message) ?? { discard() {}, fail() {} },
      beginReconcile: () => {
        leadSink.beginReconcile();
        for (const entry of children.values())
          if (entry.executionId === executionId) entry.sink?.beginReconcile();
      },
      endReconcile: () => {
        leadSink.endReconcile();
        for (const entry of children.values())
          if (entry.executionId === executionId) entry.sink?.endReconcile();
      },
      complete: (completion) => {
        leadSink.complete(completion);
        for (const entry of children.values())
          if (entry.executionId === executionId) {
            entry.sink?.complete(completion);
            entry.settled = true;
            if (completion?.degraded === undefined) forgetTail(entry);
            if (selectedEntry() !== entry) evict(entry);
          }
      },
    };
  };

  const memory = (): TranscriptMemoryCounters => {
    const leadMemory = lead.memory!();
    const childMemory = selectedEntry()?.store?.memory?.();
    return {
      ...leadMemory,
      active_rehydrates: leadMemory.active_rehydrates + (childMemory?.active_rehydrates ?? 0),
      queued_rehydrates: leadMemory.queued_rehydrates + (childMemory?.queued_rehydrates ?? 0),
      child_hidden_nodes: 0,
      child_tail_bytes: tailBytesTotal,
      child_resident_nodes: childMemory?.transcript_nodes ?? 0,
      child_resident_projections: childMemory === undefined ? 0 : 1,
      child_active_hydrations: childMemory?.active_rehydrates ?? 0,
      child_queued_hydrations: childMemory?.queued_rehydrates ?? 0,
    };
  };

  return {
    get nodes() {
      residenceRevision();
      return selectedEntry()?.store?.nodes ?? lead.nodes;
    },
    childLoadStatus: loadStatus,
    exportLeadNodes: () => lead.nodes,
    frontierNodes: () => lead.frontierNodes(),
    committedNodes: () => {
      residenceRevision();
      return selectedEntry()?.store?.committedNodes() ?? lead.committedNodes();
    },
    memory,
    releaseReconstructible: () => {
      const before = memory();
      const leadRelease = lead.releaseReconstructible!();
      const childRelease = selectedEntry()?.store?.releaseReconstructible?.();
      for (const entry of children.values())
        if (entry.settled && selectedEntry() !== entry) evict(entry);
      return {
        attempted: [...leadRelease.attempted, ...(childRelease?.attempted ?? [])],
        completed: leadRelease.completed && (childRelease?.completed ?? true),
        pending: leadRelease.pending || (childRelease?.pending ?? false),
        before,
        after: memory(),
      };
    },
    defaultFolded: (key) => selectedEntry()?.store?.defaultFolded(key) ?? lead.defaultFolded(key),
    appendUserMessage: (...args) => lead.appendUserMessage(...args),
    foldPrefixBefore: (...args) => {
      const changed = lead.foldPrefixBefore(...args);
      if (changed) pruneFolded();
      return changed;
    },
    truncateFrom: (...args) => {
      const changed = lead.truncateFrom(...args);
      if (changed) pruneFolded();
      return changed;
    },
    appendNotice: (...args) => lead.appendNotice(...args),
    beginLocalBash: (...args) => lead.beginLocalBash(...args),
    appendRunFailure: (...args) => lead.appendRunFailure(...args),
    settleRun: (...args) => {
      lead.settleRun(...args);
      for (const entry of children.values())
        if (entry.executionId === args[0]) entry.store?.settleRun(...args);
    },
    openRun,
    clear: () => {
      generation++;
      setSelected(null);
      setLoadStatus("idle");
      for (const entry of children.values()) evict(entry);
      children.clear();
      tailBytesTotal = 0;
      lead.clear();
    },
    rehydrate: (key) => selectedEntry()?.store?.rehydrate(key) ?? lead.rehydrate(key),
    setToolInterruptRequest: (id, pending) =>
      (selectedEntry()?.store?.setToolInterruptRequest(id, pending) ?? false) ||
      lead.setToolInterruptRequest(id, pending),
    selectSubagent: (id) => {
      const entry = id === null ? undefined : entryById(id);
      const key = entry === undefined ? null : JSON.stringify([entry.executionId, entry.id]);
      if (selected() === key) return;
      generation++;
      batch(() => {
        const previous = selectedEntry();
        if (previous) evict(previous);
        if (entry) makeResident(entry);
        setSelected(key);
        setLoadStatus(entry === undefined ? "idle" : "loading");
      });
      if (entry)
        void load(entry, generation).catch(() => {
          if (selected() === key) setLoadStatus("unavailable");
        });
    },
  };
}
