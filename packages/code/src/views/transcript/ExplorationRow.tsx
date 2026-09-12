import { For, Show, createMemo, type JSX } from "solid-js";
import type { TranscriptProjection } from "../../adapters/transcript-projection.ts";
import type { TranscriptStore, TranscriptToolNode } from "../../adapters/store.ts";
import { EXPLORATION_PAGE_MEMBERS } from "../../core/transcript/window.ts";
import { tokens } from "../../theme/tokens.ts";
import type { ActivityDetail } from "../activity-detail.ts";
import type { TranscriptState } from "../transcript-state.ts";
import { ToolRow } from "./ToolRow.tsx";

/** An exploration entity exists from its first member; expansion mounts one bounded page. */
export function ExplorationRow(props: {
  id: string;
  projection: TranscriptProjection;
  store: TranscriptStore;
  transcript: TranscriptState;
  active: () => boolean;
  page: () => number;
  setPage: (page: number) => void;
  preserve: (change: () => void) => void;
  onOpenDetail?: (detail: ActivityDetail) => void;
}): JSX.Element {
  const members = createMemo(() => {
    const row = props.projection.row(props.id);
    return row?.kind === "exploration" ? row.members : [];
  });
  const expanded = () =>
    props.transcript.overrideOf(props.id) === "expanded" ||
    (props.transcript.overrideOf(props.id) !== "collapsed" && props.transcript.expandAll());
  const counts = createMemo(() => {
    let active = 0;
    let failed = 0;
    for (const id of members()) {
      const node = props.projection.record(id);
      if (node?.status === "running" || node?.status === "pending") active++;
      if (node?.status === "error") failed++;
    }
    return { active, failed };
  });
  const start = () =>
    Math.min(
      props.page(),
      Math.max(0, Math.floor((members().length - 1) / EXPLORATION_PAGE_MEMBERS)),
    ) * EXPLORATION_PAGE_MEMBERS;
  const visible = createMemo(() => members().slice(start(), start() + EXPLORATION_PAGE_MEMBERS));
  const toggle = () => {
    if (props.active()) props.preserve(() => props.transcript.toggleAt(props.id));
  };
  const showIssue = () => {
    if (!props.active()) return;
    const index = members().findIndex((id) => props.projection.record(id)?.status === "error");
    if (index < 0) return;
    props.preserve(() => {
      if (!expanded()) props.transcript.toggleAt(props.id);
      props.setPage(Math.floor(index / EXPLORATION_PAGE_MEMBERS));
      const member = members()[index]!;
      const override = props.transcript.overrideOf(member);
      if (override === "collapsed" || (override === undefined && props.store.defaultFolded(member)))
        props.transcript.toggleAt(member);
    });
  };
  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <box paddingTop={1} paddingLeft={1} height={2} flexShrink={0}>
        <text
          selectable={false}
          wrapMode="none"
          truncate
          onMouseDown={toggle}
          fg={counts().failed > 0 ? tokens.del : tokens.accent}
        >
          {`${expanded() ? "v" : ">"} Exploring · ${members().length} tools · ${counts().active} active${counts().failed ? ` · ${counts().failed} failed/interrupted` : ""}`}
        </text>
      </box>
      <Show when={counts().failed > 0}>
        <text selectable={false} fg={tokens.del} onMouseDown={showIssue}>
          Open first issue
        </text>
      </Show>
      <Show when={expanded()}>
        <For each={visible()}>
          {(id) => {
            const node = createMemo<TranscriptToolNode>(
              (previous) =>
                (props.projection.record(id) as TranscriptToolNode | undefined) ?? previous,
              props.projection.record(id) as TranscriptToolNode,
            );
            return (
              <box
                id={`transcript-member:${id}`}
                flexDirection="column"
                width="100%"
                flexShrink={0}
              >
                <ToolRow
                  node={node()}
                  transcript={props.transcript}
                  active={props.active}
                  defaultFolded={() => props.store.defaultFolded(id)}
                  onToggle={() => props.preserve(() => props.transcript.toggleAt(id))}
                  onOpenDetail={props.onOpenDetail}
                />
              </box>
            );
          }}
        </For>
        <Show when={members().length > EXPLORATION_PAGE_MEMBERS}>
          <box height={1} paddingLeft={2} flexShrink={0} flexDirection="row">
            <text
              selectable={false}
              fg={tokens.accent}
              onMouseDown={() => {
                if (props.active())
                  props.preserve(() => props.setPage(Math.max(0, props.page() - 1)));
              }}
            >
              Previous{" "}
            </text>
            <text
              selectable={false}
              fg={tokens.muted}
            >{`${start() + 1}–${Math.min(start() + EXPLORATION_PAGE_MEMBERS, members().length)} / ${members().length}  `}</text>
            <text
              selectable={false}
              fg={tokens.accent}
              onMouseDown={() => {
                if (props.active())
                  props.preserve(() =>
                    props.setPage(
                      Math.min(
                        Math.floor((members().length - 1) / EXPLORATION_PAGE_MEMBERS),
                        props.page() + 1,
                      ),
                    ),
                  );
              }}
            >
              Next
            </text>
          </box>
        </Show>
      </Show>
    </box>
  );
}
