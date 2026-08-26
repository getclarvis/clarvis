import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import type { MemoryModeStore } from "../../adapters/memory-mode.ts";
import { memoryState, modelResolves } from "../../adapters/execution-safety.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  DetailLines,
  LevelHost,
  SectionHeader,
  SettingRow,
  StatusRow,
} from "./view-host.tsx";
import type { CatalogPickerSpec } from "./CatalogPicker.tsx";
import { modelPickerSpec } from "./pick-model.ts";

/** Data and actions {@link MemoryConfigPanel} needs from its host. */
export interface MemoryConfigDeps {
  settings: SettingsAdapter;
  memoryMode: MemoryModeStore;
  notify: (message: string) => void;
}

type MemoryDraft = NonNullable<SettingsFile["memory"]>;

/**
 * Config panel for the per-scope `memory` block (enabled, extraction model)
 * plus the this-client session on/off toggle.
 *
 * @remarks
 * Memory has no per-agent grant: once a `memory` block is configured and
 * enabled, it applies to every run. The session toggle only has effect once
 * a block is saved and its extraction model resolves; both states are
 * surfaced in `statusLine` rather than left for the user to infer.
 */
export function MemoryConfigPanel(host: ViewHost, deps: MemoryConfigDeps): JSX.Element {
  const settings = deps.settings;
  const fe = createFieldEditor(host.interaction, host.active);

  const [draft, setDraft] = createSignal<MemoryDraft | null>(null);
  const [saved, setSaved] = createSignal<MemoryDraft | null>(null);
  const [sel, setSel] = createSignal(0);
  const [picker, setPicker] = createSignal<CatalogPickerSpec | null>(null);

  function load(): void {
    const s = settings.read(host.scope()) ?? {};
    const block = s.memory ? { ...s.memory } : null;
    setSaved(block);
    setDraft(block ? { ...block } : null);
    setSel(0);
    host.markDirty(false);
  }
  host.bindScope({ mode: "reload", load });
  load();

  function patch(p: Partial<MemoryDraft>): void {
    const d = draft();
    if (!d) return;
    setDraft({ ...d, ...p });
    host.markDirty(true);
  }

  const effectiveModel = (): string | undefined =>
    settings.effective().memory?.model ?? settings.effective().default_model;
  const effectiveResolves = (): boolean => modelResolves(effectiveModel(), settings.effective());
  const draftChanged = (): boolean => JSON.stringify(draft()) !== JSON.stringify(saved());
  const memoryLabel = (block: MemoryDraft | null): string =>
    block === null ? "inherit" : block.enabled === false ? "off" : "on";
  const effectiveMemoryLabel = (): string =>
    settings.effective().memory?.enabled === false
      ? "off"
      : settings.effective().memory
        ? "on"
        : "off";
  /** The merged memory block — what a run will actually use, whatever scope is on screen. */
  const effectiveMemoryBlock = (): MemoryDraft | undefined => settings.effective().memory;
  /**
   * Which scope the *effective* memory setting comes from.
   *
   * @remarks It used to report the scope being **viewed** whenever that scope
   * declared a memory block at all — so with a workspace override in force,
   * opening the global panel said the value came from `global` while a run used
   * the workspace's. `settings.origin` is the merge's own answer (workspace
   * wins, else global), and naming anything else makes the badge a statement
   * about the screen rather than about the product.
   */
  const memorySource = (): string => settings.origin?.("memory") ?? "product default";

  async function save(): Promise<void> {
    const d = draft();
    await settings.write(host.scope(), { memory: d ?? undefined });
    setSaved(d ? { ...d } : null);
    host.markDirty(false);
    deps.memoryMode.refresh();
    if (d && d.enabled !== false) {
      deps.memoryMode.setMode("on");
      if (memoryState(settings.effective()) === "inert") {
        deps.notify(
          `saved ${host.scope()} memory config ${glyph("emDash")} memory model not resolved; memory will not learn`,
        );
      } else {
        deps.notify(`saved ${host.scope()} memory config ${glyph("emDash")} session memory on`);
      }
    } else {
      deps.notify(`saved ${host.scope()} memory config`);
    }
  }
  host.onSave(save);

  function createBlock(): void {
    setDraft({ ...(settings.effective().memory ?? {}), enabled: true });
    host.markDirty(true);
    if (!modelResolves(settings.effective().default_model, settings.effective())) {
      deps.notify(
        `no usable default_model ${glyph("emDash")} pick an extraction model before saving`,
      );
    }
  }

  function removeBlock(): void {
    if (draft() === null) return;
    setDraft(null);
    host.markDirty(true);
    deps.notify(
      `memory block removed from the ${host.scope()} draft ${glyph("emDash")} save to apply`,
    );
  }

  function editModel(): void {
    const spec = modelPickerSpec({
      fe,
      settings,
      current: draft()?.model ?? "",
      commit: (v) => patch({ model: v || undefined }),
      close: () => setPicker(null),
    });
    if (spec) setPicker(spec);
  }

  function toggleSessionMode(): void {
    if (!deps.memoryMode.configured()) {
      deps.notify("memory is not configured in settings" + glyph("emDash") + " save a block first");
      return;
    }
    const next = deps.memoryMode.cycle();
    if (next === "on" && memoryState(settings.effective()) === "inert") {
      deps.notify(
        `memory: on (session) ${glyph("emDash")} memory model not resolved; memory will not learn`,
      );
      return;
    }
    deps.notify(`memory: ${next} (session)`);
  }

  const rowCount = (): number => (draft() ? 3 : 2);
  const sessionBase = (): number => (draft() ? 2 : 1);

  function editSelected(): void {
    const i = Math.max(0, Math.min(rowCount() - 1, sel()));
    const d = draft();
    if (!d) {
      if (i === 0) createBlock();
      else toggleSessionMode();
      return;
    }
    if (i === 0) patch({ enabled: !(d.enabled !== false) });
    else if (i === 1) editModel();
    else toggleSessionMode();
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: rowCount,
      index: sel,
      setIndex: setSel,
      activate: { label: draft() === null && sel() === 0 ? "create" : "edit", run: editSelected },
    },
    verbs: [...(draft() !== null ? [{ key: "x", label: "remove block", run: removeBlock }] : [])],
  });

  bindLevelKeys({
    host,
    editor: fe,
    suspend: () => picker() !== null,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  function statusLine(): { text: string; fg: string } {
    const cfg = deps.memoryMode.configured();
    void cfg;
    const eff = settings.effective();
    if (eff.memory === undefined)
      return { text: "Off — no memory configuration is effective", fg: tokens.warn };
    if (eff.memory.enabled === false)
      return { text: "Off — disabled by settings", fg: tokens.warn };
    if (!effectiveResolves())
      return {
        text: "Unavailable — no extraction model resolves",
        fg: tokens.warn,
      };
    if (deps.memoryMode.mode() === "off")
      return {
        text: "Off for this session — configured default remains unchanged",
        fg: tokens.warn,
      };
    return { text: "On — runs can read and update workspace memory", fg: tokens.add };
  }

  function body(): JSX.Element {
    return (
      <box flexDirection="column">
        <StatusRow label="effective" text={statusLine().text} fg={statusLine().fg} />
        <DetailLines
          indent
          rows={[
            {
              text: "active for every run when configured (no per-agent grant)",
              fg: tokens.muted,
            },
          ]}
        />
        <SectionHeader label={`settings (${host.scope()})`} />
        <SettingRow
          setting={{
            label: "Memory",
            summary: draftChanged()
              ? `current ${effectiveMemoryLabel()} ${glyph("arrowRight")} after save ${memoryLabel(draft())} ${glyph("separator")} next run`
              : `${effectiveMemoryLabel()} ${glyph("separator")} from ${memorySource()} ${glyph("separator")} next run`,
            configured: memoryLabel(saved()),
            effective: effectiveMemoryLabel(),
            source: memorySource(),
            applies: "next run",
            mutation: "staged",
            ...(draftChanged() ? { pending: memoryLabel(draft()) } : {}),
          }}
          selected={sel() === 0}
          expanded={sel() === 0}
        />
        <Show when={draft() !== null}>
          <SettingRow
            setting={{
              label: "Extraction model",
              configured: saved()?.model ?? "inherit",
              effective: effectiveModel() ?? "not configured",
              source: effectiveMemoryBlock()?.model
                ? memorySource()
                : (settings.origin?.("default_model") ?? "product default"),
              applies: "next run",
              mutation: "staged",
              ...(draft()!.model !== saved()?.model
                ? { pending: draft()!.model ?? "inherit" }
                : {}),
            }}
            selected={sel() === 1}
            expanded={sel() === 1}
          />
          <StatusRow
            label="model"
            text={effectiveResolves() ? "resolves" : "unresolved — choose a configured model"}
          />
        </Show>
        <SectionHeader label="session (this client)" />
        <SettingRow
          setting={{
            label: "Session memory",
            configured: deps.memoryMode.mode(),
            effective: deps.memoryMode.mode(),
            source: "session",
            applies: "now",
            mutation: "immediate",
          }}
          selected={sel() === sessionBase()}
          expanded={sel() === sessionBase()}
        />
      </box>
    );
  }

  return (
    <LevelHost
      host={host}
      editor={fe}
      picker={picker}
      levels={[{ title: "Memory settings", body }]}
    />
  );
}
