import { createMemo, untrack, type JSX } from "solid-js";
import type { TranscriptProjection } from "../../adapters/transcript-projection.ts";
import type { TranscriptNode, TranscriptStore, TranscriptToolNode } from "../../adapters/store.ts";
import type { TranscriptState } from "../transcript-state.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import { BlockView } from "../blocks.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { ExplorationRow } from "./ExplorationRow.tsx";

/** The native wrapper is keyed by a primitive row ID, independent of record revisions. */
export function TranscriptRowView(props: {
  id: string;
  projection: TranscriptProjection;
  store: TranscriptStore;
  transcript: TranscriptState;
  active: () => boolean;
  page: () => number;
  setPage: (page: number) => void;
  preserve: (change: () => void) => void;
  onLayoutChange: () => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
}): JSX.Element {
  const initial = props.projection.row(props.id)!;
  const content = () => {
    if (initial.kind === "exploration") return <ExplorationRow {...props} />;
    const node = createMemo<TranscriptNode>(
      (previous) => props.projection.record(initial.recordId) ?? previous,
      props.projection.record(initial.recordId)!,
    );
    const toggle = () => {
      const target = node().delegationTarget;
      if (target !== undefined) props.transcript.toggleSubagent(target);
      else props.preserve(() => props.transcript.toggleAt(initial.recordId));
    };
    if (node().kind === "tool_call")
      return (
        <ToolRow
          node={node() as TranscriptToolNode}
          transcript={props.transcript}
          active={props.active}
          defaultFolded={() => props.store.defaultFolded(initial.recordId)}
          onToggle={toggle}
          onOpenDetail={props.onOpenDetail}
        />
      );
    return (
      <BlockView
        node={node()}
        interactive={props.active}
        maxWidth="100%"
        overrideOf={(key) => props.transcript.overrideOf(key)}
        forceExpand={props.transcript.expandAll}
        focused={() => props.transcript.focusedKey() === props.id}
        onToggle={toggle}
        onOpenDetail={props.onOpenDetail}
        fillAvailableWidth={() => true}
      />
    );
  };
  const body = untrack(content);
  return (
    <box
      id={`transcript-row:${props.id}`}
      onSizeChange={props.onLayoutChange}
      onMouseDown={() => {
        if (initial.kind === "exploration") return;
        const target = props.projection.record(initial.recordId)?.delegationTarget;
        if (target !== undefined) props.transcript.toggleSubagent(target);
      }}
      flexDirection="column"
      width="100%"
      minWidth={0}
      flexShrink={0}
    >
      {body}
    </box>
  );
}
