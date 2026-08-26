import type { JSX } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import { createSignal, onMount } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import type { ViewHost } from "../../keys/commands.ts";
import {
  sessionTurnCount,
  type SessionId,
  type SessionMeta,
} from "../../adapters/session-store.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, SelectableList, SelectableRow, ViewFrame } from "./view-host.tsx";
import {
  COST_COL_WIDTH,
  costCellText,
  relTime,
  TOKENS_COL_WIDTH,
  tokensCellText,
  TURNS_COL_WIDTH,
} from "../session-row.ts";

/** Data and actions {@link SessionsHub} needs from its host. */
export interface SessionsHubDeps {
  sessions: () => SessionMeta[];
  catalog?: () => Promise<SessionCatalogItem[]>;
  now: () => number;
  statusLine: () => string;
  resume: (id: SessionId) => unknown;
  resumeCatalog?: (item: SessionCatalogItem) => Promise<void> | void;
  delete?: (item: SessionCatalogItem) => Promise<void> | void;
}

export interface SessionCatalogItem {
  meta: SessionMeta;
  workspaceId: string;
  workspaceLabel: string;
  available: boolean;
}

/**
 * Sessions hub: New session and Export live as one keystroke to the
 * already-registered `app.clear`/`session.export` actions (via
 * `host.dispatch`); this screen owns only the resume list — landing here
 * from `/sessions` and picking a row *is* the resume flow.
 */
export function SessionsHub(host: ViewHost, deps: SessionsHubDeps): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const [catalog, setCatalog] = createSignal<SessionCatalogItem[] | null>(null);

  const items = (): SessionCatalogItem[] =>
    catalog() ??
    deps.sessions().map((meta) => ({
      meta,
      workspaceId: meta.workspace,
      workspaceLabel: "",
      available: true,
    }));
  const selected = (): SessionCatalogItem | undefined =>
    items()[clampListIndex(sel(), items().length)];

  onMount(() => {
    if (!deps.catalog) return;
    detachObserved("session_catalog", () =>
      deps.catalog!().then((rows) =>
        setCatalog([...rows].sort((left, right) => right.meta.updatedAt - left.meta.updatedAt)),
      ),
    );
  });

  function resumeSelected(): void {
    const item = selected();
    if (!item?.available) return;
    if (deps.resumeCatalog) {
      detachObserved("session_catalog_resume", () => Promise.resolve(deps.resumeCatalog!(item)));
      return;
    }
    detachObserved("session_resume", () => Promise.resolve(deps.resume(item.meta.id)));
  }

  function requestDelete(): void {
    const item = selected();
    if (!item?.available || !deps.delete) return;
    const m = item.meta;
    detachObserved("session_delete_confirm", () =>
      host
        .confirm({
          message: `delete '${m.title || "(untitled)"}' ${"—"} ${sessionTurnCount(m)} turns?`,
          danger: true,
          confirmLabel: "delete",
          cancelLabel: "keep",
        })
        .then((ok) => {
          if (ok)
            detachObserved("session_delete", async () => {
              await deps.delete!(item);
              setCatalog((rows) => rows?.filter((row) => row !== item) ?? null);
              // The list shrank under the cursor. Without this, deleting a
              // non-first row collapsed onto the sole remaining one and left the
              // selection index past the end, so no row was marked at all.
              setSel((current) => clampListIndex(current, items().length));
            });
        }),
    );
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: () => items().length,
      index: sel,
      setIndex: setSel,
      activate: {
        label: "resume",
        run: resumeSelected,
        when: () => selected()?.available === true,
      },
    },
    verbs: [
      { key: "n", label: "new session", run: () => host.dispatch("app.clear") },
      { key: "x", label: "export", run: () => host.dispatch("session.export") },
      ...(deps.delete ? [{ key: "d", label: "delete", run: requestDelete }] : []),
    ],
  });

  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  return (
    <ViewFrame host={host} title="Sessions" readOnly>
      <text flexShrink={0} fg={tokens.muted} paddingBottom={1}>
        {deps.statusLine()}
      </text>
      <SelectableList<SessionCatalogItem>
        each={items}
        sel={sel}
        idPrefix="session-"
        empty={() => ({
          text: "no sessions yet",
          icon: "info",
          hint: "runs you start show up here to resume",
        })}
        row={(item, i) => (
          <SelectableRow selected={sel() === i()}>
            <span style={{ fg: item.available ? tokens.fg : tokens.muted }}>
              {item.meta.title || "(untitled)"}
            </span>
            <span style={{ fg: tokens.muted }}>
              {"  " +
                `${sessionTurnCount(item.meta)} turns`.padEnd(TURNS_COL_WIDTH) +
                tokensCellText(item.meta).padEnd(TOKENS_COL_WIDTH) +
                costCellText(item.meta).padEnd(COST_COL_WIDTH) +
                relTime(item.meta.updatedAt, deps.now()) +
                (item.workspaceLabel.length > 0 ? `  ${item.workspaceLabel}` : "") +
                (item.available ? "" : " (workspace unavailable)")}
            </span>
          </SelectableRow>
        )}
      />
    </ViewFrame>
  );
}
