import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { TranscriptToolNode } from "../../adapters/store.ts";
import { toolLabel } from "../../adapters/tool-identity.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { LAYER } from "../../keys/keyspec.ts";
import { uiCommand } from "../../keys/actions.ts";
import { resolveToolRenderer, splitDiffFiles } from "../tools/registry.tsx";
import {
  clampListIndex,
  followSelection,
  registerListNav,
  registerScrollKeys,
} from "../../ui/patterns/list-navigation.ts";
import { PageFrame } from "../PageFrame.tsx";
import { EmptyHint } from "../config/view-host.tsx";
import { glyph } from "../../theme/glyphs.ts";
import { scrollbarOptions } from "../../theme/surfaces.ts";
import { tokens } from "../../theme/tokens.ts";
import { SelectableRow } from "../../ui/primitives/selectable-row.tsx";

export interface DiffFile {
  path: string;
  changes: TranscriptToolNode[];
}

export type DiffTreeRow =
  | { kind: "folder"; path: string; name: string; depth: number }
  | { kind: "file"; path: string; name: string; depth: number };

function pathArg(node: TranscriptToolNode): string | undefined {
  for (const key of ["path", "file", "to", "from", "source"]) {
    const value = node.args?.[key];
    if (typeof value === "string" && value.length > 0) return value.replaceAll("\\", "/");
  }
  return undefined;
}

/** Groups chronological transcript mutations by the file named in their full diff or arguments. */
export function projectDiffFiles(nodes: readonly TranscriptToolNode[]): DiffFile[] {
  const files = new Map<string, TranscriptToolNode[]>();
  let unnamed = 0;
  const append = (path: string, node: TranscriptToolNode): void => {
    const existing = files.get(path);
    if (existing) existing.push(node);
    else files.set(path, [node]);
  };
  for (const node of nodes) {
    const split = node.diff === undefined ? null : splitDiffFiles(node.diff);
    const namedSections = split?.files.filter((file) => file.path !== undefined) ?? [];
    if (namedSections.length > 0) {
      for (const section of namedSections) {
        const path = section.path!.replaceAll("\\", "/");
        append(path, {
          ...node,
          args: { ...(node.args ?? {}), path },
          diff: section.diff,
          result: namedSections.length > 1 ? "" : node.result,
        });
      }
      continue;
    }
    append(pathArg(node) ?? `Change ${++unnamed}`, node);
  }
  return [...files.entries()]
    .map(([path, changes]) => ({ path, changes }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Flattens the visible part of a folder tree while retaining stable path identities. */
function projectDiffTreeRows(
  files: readonly DiffFile[],
  expanded: ReadonlySet<string>,
): DiffTreeRow[] {
  interface Directory {
    dirs: Map<string, Directory>;
    files: string[];
  }
  const root: Directory = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let child = current.dirs.get(part);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        current.dirs.set(part, child);
      }
      current = child;
    }
    current.files.push(parts.at(-1) ?? file.path);
  }
  const rows: DiffTreeRow[] = [];
  const visit = (directory: Directory, parent: string, depth: number): void => {
    for (const [name, child] of [...directory.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = parent.length === 0 ? name : `${parent}/${name}`;
      rows.push({ kind: "folder", path, name, depth });
      if (expanded.has(path)) visit(child, path, depth + 1);
    }
    for (const name of directory.files.sort((a, b) => a.localeCompare(b))) {
      rows.push({
        kind: "file",
        path: parent.length === 0 ? name : `${parent}/${name}`,
        name,
        depth,
      });
    }
  };
  visit(root, "", 0);
  return rows;
}

function renderNode(node: TranscriptToolNode): JSX.Element {
  return resolveToolRenderer(
    node.mcpName ?? "",
    node.toolName ?? "",
  )({
    mcpName: node.mcpName ?? "",
    toolName: node.toolName ?? "",
    arguments: node.args ?? {},
    result: node.result ?? "",
    diff: node.diff,
    error: node.error ?? null,
    status: node.status,
    full: true,
    wrap: true,
  });
}

/** Full-screen file tree and per-file diff reader for every mutation in the active transcript. */
export function DiffViewer(props: {
  interaction: Interaction;
  nodes: Accessor<readonly TranscriptToolNode[]>;
  onClose: () => void;
  active?: Accessor<boolean>;
}): JSX.Element {
  const dimensions = useTerminalDimensions();
  const files = createMemo(() => projectDiffFiles(props.nodes()));
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
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
      for (let index = 1; index < parts.length; index += 1)
        paths.add(parts.slice(0, index).join("/"));
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
    const available = files();
    if (available.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!available.some((file) => file.path === selectedPath()))
      setSelectedPath(available[0]!.path);
  });
  const selectedFile = createMemo(
    () => files().find((file) => file.path === selectedPath()) ?? null,
  );
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
    setSelectedPath(row.path);
    setPane("detail");
  };
  const surfaceActive = (): boolean => props.active?.() ?? true;
  const treeActive = (): boolean => surfaceActive() && pane() === "tree";
  const detailActive = (): boolean => surfaceActive() && pane() === "detail";
  followSelection(() => treeScroll, "diff-tree-row-", treeIndex);
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
      ],
      bindings: [{ key: "escape", cmd: "diff.close" }],
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
  const subtitle = (): string | undefined => {
    if (files().length === 0) return undefined;
    const changes = files().reduce((total, file) => total + file.changes.length, 0);
    return `${files().length} ${files().length === 1 ? "file" : "files"} ${glyph("separator")} ${changes} ${changes === 1 ? "change" : "changes"}`;
  };
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
                  setSelectedPath(row.path);
                  setPane("detail");
                }
              }}
            >
              <SelectableRow selected={treeIndex() === index()}>
                <span>{"  ".repeat(row.depth)}</span>
                <span style={{ fg: row.kind === "folder" ? tokens.accent : tokens.fg }}>
                  {row.kind === "folder"
                    ? `${expanded().has(row.path) ? glyph("collapse") : glyph("expand")} ${row.name}`
                    : `${glyph("file")} ${row.name}`}
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
      <Show when={selectedFile()}>
        {(file: Accessor<DiffFile>) => (
          <>
            <text fg={tokens.accent} flexShrink={0} paddingBottom={1} wrapMode="none" truncate>
              <b>{file().path}</b>
              <span style={{ fg: tokens.muted }}>
                {`  ${glyph("separator")} ${file().changes.length === 1 ? toolLabel(file().changes[0]!.mcpName, file().changes[0]!.toolName) + ` ${glyph("separator")} ` : ""}${file().changes.length} ${file().changes.length === 1 ? "change" : "changes"}`}
              </span>
            </text>
            <scrollbox
              ref={(element: ScrollBoxRenderable) => (detailScroll = element)}
              flexGrow={1}
              minHeight={0}
              verticalScrollbarOptions={scrollbarOptions()}
            >
              <For each={file().changes}>
                {(node, index) => (
                  <box flexDirection="column" marginTop={index() === 0 ? 0 : 1}>
                    <Show when={file().changes.length > 1}>
                      <text fg={tokens.muted} wrapMode="none">
                        {`${toolLabel(node.mcpName, node.toolName)} ${glyph("separator")} change ${index() + 1}/${file().changes.length}`}
                      </text>
                    </Show>
                    {renderNode(node)}
                  </box>
                )}
              </For>
            </scrollbox>
          </>
        )}
      </Show>
    </box>
  );
  return (
    <PageFrame
      title="Diff"
      subtitle={subtitle()}
      interaction={props.interaction}
      actionFilter={(action) => action.id !== "run.cancel"}
    >
      <Show
        when={files().length > 0}
        fallback={
          <EmptyHint
            text="no diff in the transcript yet"
            icon="info"
            hint="run a file-editing tool to populate one"
          />
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
