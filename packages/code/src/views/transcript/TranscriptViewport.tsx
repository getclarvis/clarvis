import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import type { TranscriptStore } from "../../adapters/store.ts";
import { createTranscriptProjection } from "../../adapters/transcript-projection.ts";
import { TranscriptWindow, type ReaderPosition } from "../../core/transcript/window.ts";
import { scrollbarOptions, SCROLLBOX_TABLE_GUTTER } from "../../theme/surfaces.ts";
import { tokens } from "../../theme/tokens.ts";
import type { TranscriptState } from "../transcript-state.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { TranscriptRowView } from "./TranscriptRowView.tsx";

/** Public navigation uses semantic rows; only this viewport writes native scroll offsets. */
export interface TranscriptViewportHandle {
  requestEarlier(): boolean;
  requestLater(): boolean;
  returnToTail(): boolean;
  returnToLeadTail(): void;
  scrollBy(rows: number): "scrolled" | "preparing" | "start" | "end";
  revealKey(key: string): boolean;
  snapshot(): {
    rowIds: readonly string[];
    activeRowIds: readonly string[];
    start: number;
    end: number;
    earlierUnknown: number;
    laterUnknown: number;
    followingTail: boolean;
    reader: ReaderPosition;
  };
  diagnostics(): {
    pendingRevealKey: string | null;
    laterEntries: number;
    tailEntries: number;
    newerEntries: number;
    stickyScroll: boolean;
  };
}

interface ProjectionReader {
  window: TranscriptWindow;
  pages: Map<string, number>;
  seenCount: number;
}

/** One native ScrollBox, a bounded row window and cancellable post-layout anchor transactions. */
export function TranscriptViewport(props: {
  store: TranscriptStore;
  transcript: TranscriptState;
  active: Accessor<boolean>;
  width: Accessor<number>;
  onScrollbox: (value: ScrollBoxRenderable) => void;
  onHandle: (value: TranscriptViewportHandle | undefined) => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
  notify: (message: string) => void;
  children?: JSX.Element;
}): JSX.Element {
  const renderer = useRenderer();
  const projection = createTranscriptProjection(props.store, props.transcript.selectedSubagent);
  const readers = new Map<string, ProjectionReader>();
  let selected = "";
  let requestedLeadTail = false;
  let current: ProjectionReader = {
    window: new TranscriptWindow(),
    pages: new Map(),
    seenCount: 0,
  };
  let element: ScrollBoxRenderable | undefined;
  let transaction = 0;
  let pending:
    | {
        token: number;
        projection: string;
        reader: ReaderPosition;
        attempts: number;
        focusKey?: string;
      }
    | undefined;
  let correcting = false;
  let lastTop = 0;
  let lastWidth = 0;
  const [revision, setRevision] = createSignal(0);
  const [resident, setResident] = createSignal<readonly string[]>([], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  let desiredResidence: readonly string[] = [];
  const publish = (immediate = false) => {
    const next = current.window.resident();
    const selection = renderer.getSelection();
    if (selection?.isActive && resident().some((id) => !next.includes(id))) {
      const combined = current.window.ids.filter(
        (id) => next.includes(id) || resident().includes(id),
      );
      if (combined.length > 80) {
        props.notify("Selection retained: clear it before loading more history.");
        const retained = resident().filter((id) => current.window.ids.includes(id));
        if (retained.length > 0) {
          current.window.start = current.window.ids.indexOf(retained[0]!);
          current.window.end = current.window.ids.indexOf(retained.at(-1)!) + 1;
        }
        desiredResidence = retained;
        setRevision((value) => value + 1);
        return false;
      }
      desiredResidence = combined;
    } else desiredResidence = next;
    if (immediate)
      queueMicrotask(() => {
        if (!renderer.isDestroyed) setResident(desiredResidence);
      });
    setRevision((value) => value + 1);
    renderer.requestRender();
    return true;
  };
  const maximum = () =>
    element === undefined ? 0 : Math.max(0, element.scrollHeight - element.viewport.height);
  const atBottom = () => element !== undefined && element.scrollTop >= maximum() - 1;
  const capture = (): ReaderPosition => {
    if (!element || current.window.reader.mode === "tail") return { mode: "tail" };
    const row = element.content
      .getChildren()
      .find(
        (child) =>
          child.id.startsWith("transcript-row:") && child.y + child.height > element!.viewport.y,
      );
    return row === undefined
      ? current.window.reader
      : {
          mode: "anchor",
          rowId: row.id.slice("transcript-row:".length),
          screenY: row.y - element.viewport.y,
        };
  };
  const prepare = (reader: ReaderPosition) => {
    current.window.reader = reader;
    pending = { token: ++transaction, projection: selected, reader, attempts: 0 };
    if (element) element.stickyScroll = false;
  };
  const preserve = (change: () => void) => {
    prepare(pending?.reader ?? current.window.reader);
    change();
    publish();
  };
  const pause = () => {
    pending = undefined;
    transaction++;
    if (current.window.reader.mode === "tail") {
      const first = current.window.ids[current.window.start];
      if (first !== undefined) current.window.reader = { mode: "anchor", rowId: first, screenY: 0 };
    }
    if (element) element.stickyScroll = false;
    current.window.reader = capture();
    current.seenCount = current.window.ids.length;
  };
  const page = (direction: -1 | 1): boolean => {
    if (current.window.reader.mode === "tail") pause();
    const anchor = pending?.reader ?? current.window.reader;
    if (!current.window.page(direction)) return false;
    prepare(anchor);
    return publish();
  };
  const returnToTail = (): boolean => {
    current.window.tail();
    current.seenCount = current.window.ids.length;
    prepare({ mode: "tail" });
    return publish();
  };
  const handle: TranscriptViewportHandle = {
    requestEarlier: () => page(-1),
    requestLater: () => page(1),
    returnToTail,
    returnToLeadTail() {
      requestedLeadTail = true;
      const child = props.transcript.selectedSubagent();
      if (child !== null) props.transcript.toggleSubagent(child);
      if (selected === "lead") {
        requestedLeadTail = false;
        returnToTail();
      }
    },
    scrollBy(rows) {
      if (!element || !rows) return "scrolled";
      if (rows === Infinity) {
        returnToTail();
        return "end";
      }
      pause();
      if (rows < 0 && element.scrollTop <= 1 && page(-1)) return "preparing";
      if (rows > 0 && atBottom()) {
        if (current.window.end < current.window.ids.length && page(1)) return "preparing";
        returnToTail();
        return "end";
      }
      element.scrollTo({ x: 0, y: Math.max(0, Math.min(maximum(), element.scrollTop + rows)) });
      setRevision((value) => value + 1);
      renderer.requestRender();
      return rows < 0 && element.scrollTop === 0 ? "start" : "scrolled";
    },
    revealKey(key) {
      const row = projection.destination(key) ?? key;
      if (!current.window.reveal(row)) return false;
      prepare(current.window.reader);
      if (key !== row && pending) pending.focusKey = key;
      publish();
      return true;
    },
    snapshot: () => ({
      rowIds: current.window.ids,
      activeRowIds: current.window.resident(),
      start: current.window.start,
      end: current.window.end,
      earlierUnknown: current.window.start,
      laterUnknown: current.window.ids.length - current.window.end,
      followingTail: current.window.reader.mode === "tail",
      reader: current.window.reader,
    }),
    diagnostics: () => ({
      pendingRevealKey: pending?.reader.mode === "anchor" ? pending.reader.rowId : null,
      laterEntries: current.window.ids.length - current.window.end,
      tailEntries: 0,
      newerEntries: Math.max(
        current.window.ids.length - current.seenCount,
        current.window.ids.length - current.window.end,
      ),
      stickyScroll: current.window.reader.mode === "tail" && pending === undefined,
    }),
  };

  createEffect(() => {
    const ids = projection.ids();
    const next = projection.projectionId();
    props.width();
    if (!props.active()) return;
    untrack(() => {
      const switched = selected !== next;
      if (selected !== next) {
        if (selected) {
          readers.set(selected, current);
        }
        selected = next;
        current = readers.get(next) ?? {
          window: new TranscriptWindow(),
          pages: new Map(),
          seenCount: ids.length,
        };
        current.window.sync(ids);
        prepare(current.window.reader);
        readers.delete(next);
        while (readers.size > 63) readers.delete(readers.keys().next().value!);
      } else {
        const anchor = pending?.reader ?? current.window.reader;
        current.window.reader = anchor;
        current.window.sync(ids);
        prepare(current.window.reader);
      }
      if (props.store.nodes.length === 0) {
        readers.clear();
        current.pages.clear();
        current.window.tail();
      }
      if (requestedLeadTail && next === "lead") {
        requestedLeadTail = false;
        current.window.tail();
        current.seenCount = ids.length;
        prepare({ mode: "tail" });
      }
      for (const key of current.pages.keys()) if (!projection.row(key)) current.pages.delete(key);
      publish(switched);
    });
  });

  const onFrame = () => {
    if (!element || renderer.isDestroyed || !props.active()) return;
    if (
      desiredResidence.length !== resident().length ||
      desiredResidence.some((id, index) => id !== resident()[index])
    ) {
      setResident(desiredResidence);
      renderer.requestRender();
      return;
    }
    element.verticalScrollBar.opacity = maximum() > 0 ? 1 : 0;
    const active = pending;
    if (active && active.token === transaction && active.projection === selected) {
      active.attempts++;
      if (active.reader.mode === "tail") {
        element.scrollTo({ x: 0, y: maximum() });
        element.stickyScroll = true;
        current.window.reader = { mode: "tail" };
        if (atBottom() || active.attempts >= 3) pending = undefined;
      } else {
        const row = element.content.findDescendantById(`transcript-row:${active.reader.rowId}`);
        if (row && row.height > 0) {
          const member = active.focusKey ? row.findDescendantById(active.focusKey) : undefined;
          if (member) active.reader = { ...active.reader, screenY: row.y - member.y };
          const delta = row.y - element.viewport.y - active.reader.screenY;
          if (delta !== 0) element.scrollTo({ x: 0, y: element.scrollTop + delta });
          current.window.reader = active.reader;
          pending = undefined;
        } else if (active.attempts >= 3) {
          const fallback = current.window.ids[current.window.start];
          current.window.reader = fallback
            ? { mode: "anchor", rowId: fallback, screenY: 0 }
            : { mode: "tail" };
          element.scrollTo({ x: 0, y: 0 });
          pending = undefined;
        }
      }
      lastTop = element.scrollTop;
      lastWidth = element.content.width;
      correcting = true;
      setRevision((value) => value + 1);
      renderer.requestRender();
      return;
    }
    if (correcting) {
      correcting = false;
    } else if (element.scrollTop !== lastTop) {
      const previous = lastTop;
      if (current.window.reader.mode !== "tail" || !atBottom()) pause();
      if (element.scrollTop <= 1 && previous > 1 && current.window.start > 0) page(-1);
      else if (atBottom() && element.scrollTop > previous) {
        if (current.window.end < current.window.ids.length) page(1);
        else {
          current.window.reader = { mode: "tail" };
          element.stickyScroll = true;
        }
      }
    } else if (lastWidth !== element.content.width && current.window.reader.mode === "anchor") {
      prepare(current.window.reader);
      renderer.requestRender();
    }
    if (lastTop !== element.scrollTop) setRevision((value) => value + 1);
    lastTop = element.scrollTop;
    lastWidth = element.content.width;
  };
  const onLayoutChange = () => {
    if (!pending && current.window.reader.mode === "anchor") {
      prepare(current.window.reader);
      renderer.requestRender();
    }
  };
  renderer.on("frame", onFrame);
  props.onHandle(handle);
  props.transcript.bindRows({
    ids: () => {
      revision();
      return projection.ids().flatMap((id) => {
        const row = projection.row(id);
        const explicit = props.transcript.overrideOf(id);
        if (
          row?.kind !== "exploration" ||
          (explicit !== "expanded" && (explicit === "collapsed" || !props.transcript.expandAll()))
        )
          return [id];
        const start = (current.pages.get(id) ?? 0) * 20;
        return [id, ...row.members.slice(start, start + 20)];
      });
    },
    destination: projection.destination,
    defaultFolded: (id) =>
      projection.row(id)?.kind === "exploration" || props.store.defaultFolded(id),
  });
  onCleanup(() => {
    transaction++;
    pending = undefined;
    renderer.off("frame", onFrame);
    props.onHandle(undefined);
  });
  const newer = () => {
    revision();
    return handle.diagnostics().newerEntries;
  };
  return (
    <scrollbox
      id="transcript-viewport"
      ref={(value: ScrollBoxRenderable) => {
        element = value;
        value.verticalScrollBar.visible = true;
        props.onScrollbox(value);
      }}
      stickyScroll={(revision(), current.window.reader.mode === "tail")}
      stickyStart="bottom"
      viewportCulling
      flexGrow={1}
      minHeight={0}
      paddingLeft={1}
      paddingRight={SCROLLBOX_TABLE_GUTTER}
      contentOptions={{ alignItems: "flex-start" }}
      verticalScrollbarOptions={{ ...scrollbarOptions(), width: 1 }}
      onMouse={(event: MouseEvent) => {
        if (event.type === "drag") {
          pause();
          publish();
          return;
        }
        if (event.type !== "scroll" || event.modifiers.shift) return;
        const direction = event.scroll?.direction;
        if (direction === "up") {
          pause();
          if ((element?.scrollTop ?? 0) <= 1) page(-1);
        } else if (direction === "down" && atBottom()) {
          if (current.window.end < current.window.ids.length) page(1);
          else returnToTail();
        }
        publish();
      }}
    >
      <Show when={(revision(), current.window.start > 0)}>
        <box height={1} flexShrink={0}>
          <text
            selectable={false}
            fg={tokens.muted}
          >{`${current.window.start} earlier entries · scroll to load`}</text>
        </box>
      </Show>
      <For each={resident()}>
        {(id) => (
          <TranscriptRowView
            id={id}
            projection={projection}
            store={props.store}
            transcript={props.transcript}
            active={props.active}
            preserve={preserve}
            onLayoutChange={onLayoutChange}
            onOpenDetail={props.onOpenDetail}
            page={() => {
              revision();
              return current.pages.get(id) ?? 0;
            }}
            setPage={(page) => {
              current.pages.set(id, page);
              publish();
            }}
          />
        )}
      </For>
      <Show when={(revision(), current.window.end < current.window.ids.length)}>
        <box height={1} flexShrink={0}>
          <text
            selectable={false}
            fg={tokens.muted}
          >{`${current.window.ids.length - current.window.end} newer entries · scroll to load`}</text>
        </box>
      </Show>
      {props.children}
      <Show when={(revision(), current.window.reader.mode === "anchor")}>
        <box
          id="transcript-reader-indicator"
          position="absolute"
          left={1}
          right={0}
          top={(revision(), element?.scrollTop ?? 0)}
          height={1}
          zIndex={3}
          backgroundColor={tokens.bgElev}
          onMouseDown={() => returnToTail()}
        >
          <text selectable={false} fg={tokens.accent2} wrapMode="none" truncate>
            {newer() ? `${newer()} newer entries` : "End: follow the tail"}
          </text>
        </box>
      </Show>
    </scrollbox>
  );
}
