import type { JSX } from "solid-js";
import { For, Show, createSignal, onMount } from "solid-js";
import type { StorageCategorySummary, StorageService, StorageSnapshot } from "@clarvis/protocol";
import { detachObserved } from "../../core/tasks.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { tokens } from "../../theme/tokens.ts";
import type { HintTone } from "../hint.ts";
import { bindLevelKeys, SectionHeader, StatusRow, ViewFrame } from "./view-host.tsx";

export interface StorageViewDeps {
  storage: Pick<StorageService, "inspect" | "cleanup">;
  notify: (message: string, tone?: HintTone) => void;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function categoryLabel(category: StorageCategorySummary["category"]): string {
  return category.replaceAll("_", " ");
}

function credentialText(posture: StorageSnapshot["credentials"]["keys"]): string {
  if (!posture.present) return "absent";
  if (posture.owner_only === null) return "present · permissions unavailable";
  return posture.owner_only ? "present · owner-only" : "present · permissions need repair";
}

/** Metadata-only local-storage inventory with confirmed cleanup of disposable data. */
export function StorageView(host: ViewHost, deps: StorageViewDeps): JSX.Element {
  const [snapshot, setSnapshot] = createSignal<StorageSnapshot | null>(null);
  const [busy, setBusy] = createSignal(false);

  const refresh = (): void => {
    if (busy()) return;
    setBusy(true);
    detachObserved("storage_inspect", async () => {
      try {
        setSnapshot(await deps.storage.inspect());
      } catch (error) {
        deps.notify(error instanceof Error ? error.message : String(error), "warn");
      } finally {
        setBusy(false);
      }
    });
  };

  const requestCleanup = (): void => {
    if (busy()) return;
    setBusy(true);
    detachObserved("storage_cleanup_preview", async () => {
      try {
        const preview = await deps.storage.cleanup({
          categories: ["temporary", "cache"],
          dry_run: true,
        });
        if (preview.before.truncated) {
          deps.notify("Cleanup unavailable: storage inventory is incomplete", "warn");
          return;
        }
        if (preview.reclaimable_bytes === 0) {
          deps.notify("No disposable storage is currently reclaimable", "success");
          return;
        }
        const confirmed = await host.confirm({
          message: `clean ${formatBytes(preview.reclaimable_bytes)} of disposable storage?`,
          detail: ["stale spills and run scratch", "rebuildable cache"],
          danger: false,
          confirmLabel: "clean",
          cancelLabel: "keep",
        });
        if (!confirmed) return;
        const result = await deps.storage.cleanup({
          categories: ["temporary", "cache"],
          dry_run: false,
        });
        setSnapshot(result.after ?? (await deps.storage.inspect()));
        deps.notify(
          `Cleaned ${formatBytes(result.removed_bytes)} of disposable storage`,
          "success",
        );
      } catch (error) {
        deps.notify(error instanceof Error ? error.message : String(error), "warn");
      } finally {
        setBusy(false);
      }
    });
  };

  const spec = (): LevelSpec => ({
    verbs: [
      { key: "ctrl+r", label: "refresh", run: refresh, when: () => !busy() },
      { key: "c", label: "clean disposable", run: requestCleanup, when: () => !busy() },
    ],
  });
  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });
  onMount(refresh);

  return (
    <ViewFrame
      host={host}
      title="Storage"
      unscoped
      purpose="Clarvis-owned local files"
      mutationContract="cleanup is previewed and confirmed"
    >
      <Show when={snapshot()} fallback={<text fg={tokens.muted}>Inspecting local storage…</text>}>
        {(current: () => StorageSnapshot) => (
          <>
            <StatusRow label="Total" text={formatBytes(current().total_bytes)} />
            <StatusRow
              label="Reclaimable"
              text={formatBytes(current().reclaimable_bytes)}
              fg={current().reclaimable_bytes > 0 ? tokens.warn : tokens.add}
            />
            <Show when={current().truncated}>
              <StatusRow label="Inventory" text="bounded scan truncated" fg={tokens.warn} />
            </Show>
            <SectionHeader label="Data" />
            <For each={current().categories.filter((row) => row.files > 0 || row.directories > 0)}>
              {(row) => (
                <StatusRow
                  label={categoryLabel(row.category)}
                  text={`${formatBytes(row.bytes)} · ${row.files} files · ${row.directories} dirs${
                    row.reclaimable_bytes > 0
                      ? ` · ${formatBytes(row.reclaimable_bytes)} reclaimable`
                      : ""
                  }`}
                  fg={row.reclaimable_bytes > 0 ? tokens.warn : tokens.fg}
                />
              )}
            </For>
            <SectionHeader label="Credential posture" />
            <StatusRow
              label="API keys"
              text={credentialText(current().credentials.keys)}
              fg={current().credentials.keys.owner_only === false ? tokens.del : tokens.fg}
            />
            <StatusRow
              label="Subscriptions"
              text={credentialText(current().credentials.subscriptions)}
              fg={current().credentials.subscriptions.owner_only === false ? tokens.del : tokens.fg}
            />
            <text flexShrink={0} fg={tokens.muted} paddingTop={1}>
              Credential contents, paths and sizes are never exposed here.
            </text>
          </>
        )}
      </Show>
    </ViewFrame>
  );
}
