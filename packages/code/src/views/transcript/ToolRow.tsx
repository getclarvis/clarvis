import type { JSX } from "solid-js";
import type { TranscriptToolNode } from "../../adapters/store.ts";
import { BlockView } from "../blocks.tsx";
import type { ActivityDetail } from "../activity-detail.ts";
import type { TranscriptState } from "../transcript-state.ts";

/** One tool presenter for composing, execution and sealed result; no owner handoff. */
export function ToolRow(props: {
  node: TranscriptToolNode;
  transcript: TranscriptState;
  active: () => boolean;
  defaultFolded: () => boolean;
  onToggle: () => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
}): JSX.Element {
  return (
    <BlockView
      node={props.node}
      interactive={props.active}
      maxWidth="100%"
      forceExpand={props.transcript.expandAll}
      defaultFolded={props.defaultFolded}
      overrideOf={(key) => props.transcript.overrideOf(key)}
      focused={() => props.transcript.focusedKey() === props.node.key}
      onToggle={props.onToggle}
      onOpenDetail={props.onOpenDetail}
      fillAvailableWidth={() => true}
    />
  );
}
