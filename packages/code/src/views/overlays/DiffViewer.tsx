import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type {
  WorkspaceChangeEntry,
  WorkspaceChangeOperation,
  WorkspaceChangesService,
} from "@clarvis/protocol";
import type { Interaction } from "../../keys/interaction.ts";
import { LAYER } from "../../keys/keyspec.ts";
import { uiCommand } from "../../keys/actions.ts";
import {
  clampListIndex,
  followSelection,
  registerListNav,
  registerScrollKeys,
} from "../../ui/patterns/list-navigation.ts";
import { PageFrame } from "../PageFrame.tsx";
import { EmptyHint, LoadingHint } from "../config/view-host.tsx";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { tokens } from "../../theme/tokens.ts";
import { SelectableRow } from "../../ui/primitives/selectable-row.tsx";
import { StableDiff } from "../../ui/patterns/stable-syntax.tsx";
import {
  createWorkspaceChangesController,
  selectedEntry,
  type WorkspaceChangesController,
} from "./workspace-changes-controller.ts";

export interface DiffFile {
  path: string;
  entry: WorkspaceChangeEntry;
}

export type DiffTreeRow =
  | { kind: "folder"; path: string; name: string; depth: number }
  | { kind: "file"; path: string; name: string; depth: number; entry: WorkspaceChangeEntry };

function pathRoot(path: string): string {
  return path.match(/^\/+/)?.[0] ?? "";
}

function appendPath(parent: string, part: string): string {
  if (parent.length === 0) return part;
  return `${parent}${parent.endsWith("/") ? "" : "/"}${part}`;
}

function entryPath(entry: WorkspaceChangeEntry): string {
  return entry.new_path ?? entry.old_path ?? entry.id;
}

function statusLetter(operation: WorkspaceChangeOperation): string {
  if (operation === "added") return "A";
  if (operation === "modified") return "M";
  if (operation === "deleted") return "D";
  if (operation === "renamed") return "R";
  if (operation === "copied") return "C";
  if (operation === "type_changed") return "T";
  if (operation === "conflict") return "U";
  return "S";
}

function statsLabel(entry: WorkspaceChangeEntry): string {
  const additions = entry.stats?.additions;
  const deletions = entry.stats?.deletions;
  if (additions === undefined && deletions === undefined) return "";
  const added = additions === undefined ? "" : `+${String(additions)}`;
  const removed = deletions === undefined ? "" : `-${String(deletions)}`;
  return [added, removed].filter((part) => part.length > 0).join(" ");
}

/** Groups provider inventory entries into a path-sorted file list. */
export function projectChangeFiles(items: readonly WorkspaceChangeEntry[]): DiffFile[] {
  return items
    .map((entry) => ({ path: entryPath(entry), entry }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Flattens the visible part of a folder tree while retaining stable path identities. */
function projectDiffTreeRows(
  files: readonly DiffFile[],
  expanded: ReadonlySet<string>,
): DiffTreeRow[] {
  interface Directory {
    path: string;
    name: string;
    dirs: Map<string, Directory>;
    files: Array<{ path: string; name: string; entry: WorkspaceChangeEntry }>;
  }
  const root: Directory = { path: "", name: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    const rootPrefix = pathRoot(file.path);
    let current = root;
    let parentPath = rootPrefix;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const path = appendPath(parentPath, part);
      let child = current.dirs.get(path);
      if (!child) {
        child = {
          path,
          name: index === 0 && rootPrefix.length > 0 ? `${rootPrefix}${part}` : part,
          dirs: new Map(),
          files: [],
        };
        current.dirs.set(path, child);
      }
      current = child;
      parentPath = path;
    }
    const leaf = parts.at(-1) ?? file.path;
    current.files.push({
      path: file.path,
      name: parts.length === 1 && rootPrefix.length > 0 ? `${rootPrefix}${leaf}` : leaf,
      entry: file.entry,
    });
  }
  const rows: DiffTreeRow[] = [];
  const visit = (directory: Directory, depth: number): void => {
    for (const child of [...directory.dirs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: "folder", path: child.path, name: child.name, depth });
      if (expanded.has(child.path)) visit(child, depth + 1);
    }
    for (const file of directory.files.sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({
        kind: "file",
        path: file.path,
        name: file.name,
        depth,
        entry: file.entry,
      });
    }
  };
  visit(root, 0);
  return rows;
}

function comparisonLabel(controller: WorkspaceChangesController): string {
  const availability = controller.availability();
  if (availability?.status !== "available") return "";
  const current = availability.provider.comparisons.find(
    (item) => item.id === controller.comparisonId(),
  );
  return current?.label ?? controller.comparisonId();
}

function availabilityMessage(controller: WorkspaceChangesController): string {
  const current = controller.availability();
  if (current !== null && current.status !== "available") return current.reason.message;
  if (controller.error() !== null) return controller.error() ?? "could not load workspace changes";
  return "no workspace changes yet";
}

function headerSubtitle(controller: WorkspaceChangesController): string | undefined {
  const availability = controller.availability();
  if (availability?.status === "available") {
    const page = controller.page();
    const files = page?.items.length ?? 0;
    const label = comparisonLabel(controller);
    const incomplete = page?.incomplete === true ? " truncated" : "";
    const identity = availability.provider.workspace_identity;
    const base = page?.resolved_base;
    return [
      identity,
      label,
      `${String(files)} ${files === 1 ? "file" : "files"}${incomplete}`,
      base,
    ]
      .filter((part) => part !== undefined && part.length > 0)
      .join(` ${glyph("separator")} `);
  }
  return undefined;
}

function DiffPatchBody(props: { controller: WorkspaceChangesController }): JSX.Element {
  const patch = createMemo(() => {
    const detail = props.controller.detail();
    if (detail?.status === "ready" && detail.patch !== undefined && detail.patch.length > 0) {
      return detail.patch;
    }
    return undefined;
  });
  return (
    <Show when={patch()} fallback={<DiffPatchFallback controller={props.controller} />}>
      {(text: Accessor<string>) => <StableDiff diff={text()} wrapMode="none" />}
    </Show>
  );
}

function DiffPatchFallback(props: { controller: WorkspaceChangesController }): JSX.Element {
  const detail = (): ReturnType<WorkspaceChangesController["detail"]> => props.controller.detail();
  const entry = (): WorkspaceChangeEntry | null =>
    selectedEntry(props.controller.page(), props.controller.selectedId());
  return (
    <Show
      when={props.controller.loading() && detail() === null}
      fallback={
        <Show
          when={detail() !== null && entry() !== null}
          fallback={<EmptyHint text="select a file" icon="info" />}
        >
          <EmptyHint
            text={(() => {
              const current = detail();
              if (current === null) return "select a file";
              const messages: Record<typeof current.status, string> = {
                ready: "no text hunks",
                empty: current.message ?? "no text hunks",
                binary: current.message ?? "binary file",
                conflict: current.message ?? "unmerged path",
                truncated: current.message ?? "patch exceeds the admitted size",
                stale: current.message ?? "change is stale; refresh",
                unavailable: current.message ?? "change is unavailable",
              };
              return messages[current.status];
            })()}
            icon="info"
            hint={entry() === null ? undefined : entryPath(entry()!)}
          />
        </Show>
      }
    >
      <LoadingHint text="loading change" />
    </Show>
  );
}

/** Full-screen file tree and per-file patch reader for current workspace changes. */
export function DiffViewer(props: {
  interaction: Interaction;
  service?: Accessor<WorkspaceChangesService | undefined>;
  onClose: () => void;
  active?: Accessor<boolean>;
}): JSX.Element {
  const dimensions = useTerminalDimensions();
  const controller = createWorkspaceChangesController({
    service: () => props.service?.() ?? undefined,
  });
  const files = createMemo(() => projectChangeFiles(controller.page()?.items ?? []));
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [treeIndex, setTreeIndexValue] = createSignal(0);
  const [pane, setPane] = createSignal<"tree" | "detail">("tree");
  let treeScroll: ScrollBoxRenderable | undefined;
  let detailScroll: ScrollBoxRenderable | undefined;
  const seenDirectories = new Set<string>();
  const wide = (): boolean => dimensions().width >= 80;
  const directories = createMemo(() => {
    const paths = new Set<string>();
    for (const file of files()) {
      const parts = file.path.split("/").filter(Boolean);
      let parentPath = pathRoot(file.path);
      for (const part of parts.slice(0, -1)) {
        parentPath = appendPath(parentPath, part);
        paths.add(parentPath);
      }
    }
    return paths;
  });
  createEffect(() => {
    const next = new Set(expanded());
    let changed = false;
    for (const path of directories()) {
      if (seenDirectories.has(path)) continue;
      seenDirectories.add(path);
      next.add(path);
      changed = true;
    }
    if (changed) setExpanded(next);
  });
  const rows = createMemo(() => projectDiffTreeRows(files(), expanded()));
  createEffect(() => {
    const selected = controller.selectedId();
    const index = rows().findIndex((row) => row.kind === "file" && row.entry.id === selected);
    if (index >= 0) setTreeIndexValue(index);
  });
  const setTreeIndex = (index: number): void => {
    const next = clampListIndex(index, rows().length);
    setTreeIndexValue(next);
  };
  createEffect(() => {
    const count = rows().length;
    if (count === 0) setTreeIndexValue(0);
    else if (treeIndex() >= count) setTreeIndex(count - 1);
  });
  const toggleFolder = (path: string): void => {
    const next = new Set(expanded());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };
  const activateRow = (): void => {
    const row = rows()[treeIndex()];
    if (!row) return;
    if (row.kind === "folder") {
      toggleFolder(row.path);
      return;
    }
    controller.select(row.entry.id);
    setPane("detail");
  };
  const surfaceActive = (): boolean => props.active?.() ?? true;
  const treeActive = (): boolean => surfaceActive() && pane() === "tree";
  const detailActive = (): boolean => surfaceActive() && pane() === "detail";
  followSelection(() => treeScroll, "diff-tree-row-", treeIndex);
  createEffect(() => {
    controller.setVisible(surfaceActive());
  });
  onCleanup(() => controller.dispose());
  onMount(() => {
    const offTree = registerListNav(props.interaction.keymap, {
      count: () => rows().length,
      index: treeIndex,
      setIndex: setTreeIndex,
      activate: { label: "open", run: activateRow },
      when: props.active ? "overlay==diff" : undefined,
      enabled: reactiveMatcherFromSignal(treeActive),
    });
    const offDetail = registerScrollKeys(
      props.interaction.keymap,
      () => detailScroll,
      LAYER.LIST,
      ["tab", "escape"],
      props.active ? "overlay==diff" : undefined,
      reactiveMatcherFromSignal(detailActive),
    );
    const offClose = props.interaction.keymap.registerLayer({
      ...(props.active ? { when: "overlay==diff" } : {}),
      enabled: reactiveMatcherFromSignal(treeActive),
      priority: LAYER.OVERLAY + 1,
      commands: [
        uiCommand({
          id: "diff.close",
          title: "Close diff",
          description: "Return to the transcript",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "close",
          hintPriority: 100,
          hintGroup: "escape",
          essential: true,
          run: props.onClose,
        }),
        uiCommand({
          id: "diff.refresh",
          title: "Refresh changes",
          description: "Reload the current comparison",
          category: "actions",
          surfaces: ["footer"],
          footerLabel: "refresh",
          run: () => controller.refresh(),
        }),
        uiCommand({
          id: "diff.comparison.next",
          title: "Next comparison",
          description: "Cycle the workspace comparison",
          category: "navigation",
          surfaces: ["footer"],
          footerLabel: "view",
          run: () => controller.cycleComparison(1),
        }),
      ],
      bindings: [
        { key: "escape", cmd: "diff.close" },
        { key: "r", cmd: "diff.refresh" },
        { key: "[", cmd: "diff.comparison.next" },
      ],
    });
    const offReturn = props.interaction.keymap.registerLayer({
      ...(props.active ? { when: "overlay==diff" } : {}),
      enabled: reactiveMatcherFromSignal(detailActive),
      priority: LAYER.OVERLAY + 1,
      commands: [
        uiCommand({
          id: "diff.files.return",
          title: "Return to changed files",
          description: "Return focus to the changed-file tree",
          category: "navigation",
          surfaces: ["footer"],
          footerLabel: "files",
          run: () => {
            setPane("tree");
          },
        }),
      ],
      bindings: [
        { key: "tab", cmd: "diff.files.return" },
        { key: "escape", cmd: "diff.files.return" },
      ],
    });
    onCleanup(() => {
      offReturn();
      offClose();
      offDetail();
      offTree();
    });
  });
  const sidebarWidth = (): number =>
    Math.max(24, Math.min(38, Math.floor(dimensions().width * 0.3)));
  const tree = (): JSX.Element => (
    <box
      flexDirection="column"
      width={wide() ? sidebarWidth() : "100%"}
      flexGrow={wide() ? 0 : 1}
      flexShrink={wide() ? 0 : 1}
      minHeight={0}
      paddingRight={1}
    >
      <text fg={tokens.accent} flexShrink={0} paddingBottom={1}>
        <b>Changed files</b>
      </text>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (treeScroll = element)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={scrollbarOptions()}
      >
        <For each={rows()}>
          {(row, index) => (
            <box
              id={`diff-tree-row-${index()}`}
              onMouseDown={() => {
                setTreeIndex(index());
                if (row.kind === "folder") toggleFolder(row.path);
                else {
                  controller.select(row.entry.id);
                  setPane("detail");
                }
              }}
            >
              <SelectableRow selected={treeIndex() === index()}>
                <span>{"  ".repeat(row.depth)}</span>
                <span style={{ fg: row.kind === "folder" ? tokens.accent : tokens.fg }}>
                  {row.kind === "folder"
                    ? `${expanded().has(row.path) ? glyph("collapse") : glyph("expand")} ${row.name}`
                    : `${statusLetter(row.entry.operation)} ${row.name}${statsLabel(row.entry) ? ` ${statsLabel(row.entry)}` : ""}`}
                </span>
              </SelectableRow>
            </box>
          )}
        </For>
      </scrollbox>
    </box>
  );
  const detail = (): JSX.Element => (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      minHeight={0}
      paddingLeft={wide() ? 1 : 0}
      border={wide() ? ["left"] : undefined}
      borderColor={tokens.muted}
    >
      <Show when={controller.selectedId()}>
        {(id: Accessor<string>) => {
          const entry = (): WorkspaceChangeEntry | null => selectedEntry(controller.page(), id());
          return (
            <>
              <Show when={entry()}>
                {(current: Accessor<WorkspaceChangeEntry>) => (
                  <text
                    fg={tokens.accent}
                    flexShrink={0}
                    paddingBottom={1}
                    wrapMode="none"
                    truncate
                  >
                    <b>{entryPath(current())}</b>
                    <span style={{ fg: tokens.muted }}>
                      {`  ${glyph("separator")} ${statusLetter(current().operation)}${current().old_path !== undefined && current().new_path !== undefined && current().old_path !== current().new_path ? ` ${current().old_path} -> ${current().new_path}` : ""}`}
                    </span>
                  </text>
                )}
              </Show>
              <scrollbox
                ref={(element: ScrollBoxRenderable) => (detailScroll = element)}
                flexGrow={1}
                minHeight={0}
                verticalScrollbarOptions={scrollbarOptions()}
              >
                <DiffPatchBody controller={controller} />
              </scrollbox>
            </>
          );
        }}
      </Show>
    </box>
  );
  const availability = (): WorkspaceChangesAvailabilityState => {
    const current = controller.availability();
    if (controller.loading() && current === null) return "loading";
    if (controller.error() !== null && current === null) return "error";
    if (current?.status === "not_applicable") return "not_applicable";
    if (current?.status === "unavailable") return "unavailable";
    if (current?.status === "available" && (controller.page()?.items.length ?? 0) === 0)
      return "empty";
    return "ready";
  };
  return (
    <PageFrame
      title="Diff"
      subtitle={headerSubtitle(controller)}
      interaction={props.interaction}
      actionFilter={(action) => action.id !== "run.cancel"}
    >
      <Show
        when={availability() === "ready"}
        fallback={
          <Show
            when={availability() === "loading"}
            fallback={
              <EmptyHint
                text={availabilityMessage(controller)}
                icon="info"
                hint={
                  availability() === "empty"
                    ? "working tree matches the selected comparison"
                    : "press r to recheck"
                }
              />
            }
          >
            <LoadingHint text="loading workspace changes" />
          </Show>
        }
      >
        <Show
          when={wide()}
          fallback={
            <Show when={pane() === "tree"} fallback={detail()}>
              {tree()}
            </Show>
          }
        >
          <box flexDirection="row" flexGrow={1} minHeight={0}>
            {tree()}
            {detail()}
          </box>
        </Show>
      </Show>
    </PageFrame>
  );
}

type WorkspaceChangesAvailabilityState =
  "loading" | "error" | "not_applicable" | "unavailable" | "empty" | "ready";
