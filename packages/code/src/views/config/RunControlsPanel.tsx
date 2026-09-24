import type { JSX } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { SandboxInspection } from "@clarvis/protocol";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { ViewHost } from "../../keys/commands.ts";
import {
  patchPlansSettings,
  type PlansSettingsBlock,
  type SettingsAdapter,
  type SettingsFile,
} from "../../adapters/settings.ts";
import {
  resolvedGuardMode,
  type GuardMode,
  type GuardModeStore,
} from "../../adapters/guard-mode.ts";
import type { MemoryModeStore } from "../../adapters/memory-mode.ts";
import {
  deriveIsolation,
  deriveRunControls,
  memoryDescription,
  memoryState,
  planRetentionDescription,
  safetyDescription,
  type PlanRetention,
  type RunControlsState,
} from "../../adapters/execution-safety.ts";
import {
  applyIsolation,
  isolationConfirmation,
  ISOLATION_CHOICES,
  type IsolationChoice,
} from "../../features/run/isolation.ts";
import { applyReviewMode, REVIEW_CHOICES } from "../../features/run/review.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, createFieldEditor, LevelHost } from "./view-host.tsx";
import type { PickItem } from "./field-editor.tsx";
import { errorText } from "../../adapters/errors.ts";
import type { SettingPresentation } from "../../ui/presentation.ts";
import { DetailColumn, DetailSettingRow, SettingDetail } from "../../ui/patterns/detail-view.tsx";

const ISOLATION_PICKER_CHOICES = ISOLATION_CHOICES satisfies readonly PickItem[];
const REVIEW_PICKER_CHOICES = REVIEW_CHOICES satisfies readonly PickItem[];

const MEMORY_CHOICES = [
  { value: "on", label: "on", detail: "read before runs and learn afterward" },
  { value: "off", label: "off", detail: "do not read or update memory" },
] as const satisfies readonly PickItem[];

const PLAN_RETENTION_CHOICES = [
  {
    value: "keep",
    label: "Keep plans",
    detail: "plans remain available in the selected provider",
  },
  {
    value: "discard",
    label: "Delete after success",
    detail: "removed once the run's result is recorded",
  },
] as const satisfies readonly PickItem[];

/**
 * Per-run controls expose isolation and Guard as independent axes.
 * Isolation persists globally because execution placement is host-owned;
 * Guard and completed-plan retention use the selected scope, while memory is
 * session-only.
 */
export function RunControlsPanel(
  host: ViewHost,
  deps: {
    settings: SettingsAdapter;
    guard: GuardModeStore;
    memory: MemoryModeStore;
    notify: (message: string) => void;
    runActive: () => boolean;
    reload: () => Promise<{ ok: boolean; message: string }>;
    openSandbox: () => void;
  },
): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const fe = createFieldEditor(host.interaction, host.active);
  const [inspection, setInspection] = createSignal<SandboxInspection | null>(null);
  async function refreshInspection(): Promise<void> {
    try {
      setInspection(await deps.settings.inspectSandbox());
    } catch {
      setInspection(null);
    }
  }
  onMount(() => void refreshInspection());
  const state = createMemo((): RunControlsState => {
    deps.settings.version();
    const configured = deriveRunControls(
      deps.settings.effective(),
      deps.guard.mode(),
      deps.memory.mode(),
    );
    const observed = inspection();
    if (observed === null) return configured;
    const sandboxEnabled = observed.filesystem.placement === "sandbox";
    return {
      ...configured,
      isolation: observed.filesystem.placement,
      sandboxEnabled,
      sandboxRequired: sandboxEnabled,
      filesystem:
        observed.filesystem.workspace === "read-only" ? "workspace-read-only" : "workspace-write",
      network: observed.effective_network,
    };
  });

  function sandboxLine(): { text: string; fg: string } {
    const s = state();
    const observed = inspection();
    if (observed ? observed.filesystem.placement === "host" : !s.sandboxEnabled)
      return { text: "Native sandbox is off.", fg: tokens.warn };
    const avail = observed?.backend;
    if (!avail)
      return {
        text: "Checking native sandbox on the kernel host" + glyph("ellipsis"),
        fg: tokens.muted,
      };
    if (!avail.available) {
      return {
        text: `${glyph("warning")} Native sandbox unavailable here (${avail.reason}); sandbox fails every run.`,
        fg: tokens.del,
      };
    }
    if (avail.degraded)
      return {
        text: `${avail.type === "bubblewrap" ? "Bubblewrap" : "Native sandbox"} runs in degraded mode (${avail.reason ?? "reduced isolation"}).`,
        fg: tokens.warn,
      };
    return {
      text: `${avail.type === "seatbelt" ? "Seatbelt" : "Bubblewrap"} is available; an incompatible host fails closed.`,
      fg: tokens.muted,
    };
  }
  async function applyIsolationChoice(isolation: IsolationChoice["value"]): Promise<void> {
    const confirmation = isolationConfirmation(isolation);
    if (confirmation && !(await host.confirm(confirmation))) return;
    try {
      const effective = await applyIsolation(isolation, deps.settings);
      if (!deps.runActive()) {
        const reloaded = await deps.reload();
        if (!reloaded.ok) {
          deps.notify(`isolation saved, pending reconnect: ${reloaded.message}`);
          return;
        }
        await refreshInspection();
      }
      deps.notify(
        `isolation: ${effective} (global)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
      );
    } catch (error) {
      deps.notify(errorText(error));
    }
  }

  /**
   * The `guard` block this scope's file already carries, if any.
   *
   * @remarks
   * Deliberately the raw per-scope file, not the merged view — the same
   * reason {@link scopedMemory} exists.
   */
  function scopedGuard(): NonNullable<SettingsFile["guard"]> | undefined {
    return deps.settings.read(host.scope())?.guard;
  }

  async function applyGuard(mode: GuardMode): Promise<void> {
    try {
      const result = await applyReviewMode(mode, {
        settings: deps.settings,
        guard: deps.guard,
        scope: host.scope(),
      });
      if (result.degraded) {
        deps.notify(
          `Guard: approval (${host.scope()} settings) ${glyph("emDash")} Auto needs a usable default_model for the LLM judge`,
        );
        return;
      }
      deps.notify(
        `Guard: ${mode === "on" ? "approval" : mode} (${host.scope()} settings)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
      );
    } catch (error) {
      deps.notify(errorText(error));
    }
  }

  function applyMemory(mode: "on" | "off"): void {
    deps.memory.setMode(mode);
    const effective = memoryState(deps.settings.effective(), mode);
    if (mode === "on" && effective === "inert") {
      deps.notify(
        `memory: on (this session) ${glyph("emDash")} applies to the next run; memory model not resolved, so memory will not learn ${glyph("emDash")} configure it in Memory settings`,
      );
      return;
    }
    if (mode === "on" && effective === "off") {
      deps.notify(
        `memory remains off ${glyph("emDash")} enable it in Settings > Memory before the next run`,
      );
      return;
    }
    deps.notify(`memory: ${mode} (this session) ${glyph("emDash")} applies to the next run`);
  }

  /**
   * The `plans` block this scope's file already carries, if any.
   *
   * @remarks
   * Deliberately the raw per-scope file, not the merged view, so the row can
   * distinguish an inherited value from an explicit override. The write path
   * separately materializes a complete block through `patchPlansSettings`.
   */
  function scopedPlans(): Partial<PlansSettingsBlock> | undefined {
    return deps.settings.read(host.scope())?.plans;
  }

  async function applyPlanRetention(retention: PlanRetention): Promise<void> {
    try {
      await patchPlansSettings(deps.settings, host.scope(), { retention });
      deps.notify(
        `completed plans: ${retention === "keep" ? "keep plans" : "delete after a successful run"} (${host.scope()} settings)`,
      );
    } catch (error) {
      deps.notify(errorText(error));
    }
  }

  function activate(): void {
    switch (sel()) {
      case 0:
        fe.startEnum("Isolation", ISOLATION_PICKER_CHOICES, state().isolation, (value) =>
          detachObserved("run_controls_isolation", () =>
            applyIsolationChoice(value as IsolationChoice["value"]),
          ),
        );
        break;
      case 1:
        fe.startEnum("Guard", REVIEW_PICKER_CHOICES, state().guardMode, (value) =>
          detachObserved("run_controls_guard", () => applyGuard(value as GuardMode)),
        );
        break;
      case 2:
        fe.startEnum(
          "Memory for this session",
          MEMORY_CHOICES,
          state().memory === "off" ? "off" : "on",
          (value) => applyMemory(value as "on" | "off"),
        );
        break;
      case 3:
        fe.startEnum("Completed plans", PLAN_RETENTION_CHOICES, state().plans.retention, (value) =>
          detachObserved("run_controls_plan_retention", () =>
            applyPlanRetention(value as PlanRetention),
          ),
        );
        break;
    }
  }

  /** Where the effective `plans` block comes from, and what that means for
   * future runs — the panel's answer to "did this just change everything?". */
  function planRetentionScopeLine(): string {
    if (!state().plans.configured)
      return "Retention not configured " + glyph("emDash") + " using the default";
    const origin = deps.settings.origin?.("plans");
    return origin === "workspace"
      ? "Workspace override " + glyph("emDash") + " overrides the global default in this workspace"
      : "Global default " +
          glyph("emDash") +
          " applies to future runs in every workspace unless overridden";
  }

  function openDetails(): void {
    host.level.push(settingsRows()[Math.max(0, Math.min(3, sel()))]?.label ?? "Details");
  }

  const spec = (): LevelSpec =>
    host.level.depth() === 1
      ? {
          verbs: [
            { key: "e", label: "change", run: activate },
            ...(sel() === 0
              ? [{ key: "b", label: "sandbox details", run: () => deps.openSandbox() }]
              : []),
          ],
        }
      : {
          nav: {
            count: () => 4,
            index: sel,
            setIndex: setSel,
            activate: { label: "change", run: activate },
          },
          verbs: [
            { key: "i", label: "details", run: openDetails },
            ...(sel() === 0
              ? [{ key: "b", label: "sandbox details", run: () => deps.openSandbox() }]
              : []),
          ],
        };
  host.bindScope({ mode: "retarget" });
  bindLevelKeys({
    host,
    editor: fe,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const settingSource = (key: keyof SettingsFile) =>
    deps.settings.origin?.(key) ?? "product default";
  const persistedGuardMode = (): GuardMode => resolvedGuardMode(deps.settings.effective().guard);
  const guardSource = (): string =>
    deps.guard.mode() === persistedGuardMode() ? settingSource("guard") : "session";
  const configuredIsolation = (): string => {
    const global = deps.settings.read("global");
    if (global?.sandbox === undefined) return "product default";
    return deriveIsolation(global ?? {});
  };

  function settingsRows(): SettingPresentation[] {
    return [
      {
        label: "Isolation",
        configured: configuredIsolation(),
        effective: state().isolation,
        source: "global",
        applies: "next run",
        mutation: "immediate",
      },
      {
        label: "Guard",
        configured: scopedGuard()?.mode ?? "inherit",
        effective: state().guardMode,
        source: guardSource(),
        applies: "next run",
        mutation: "immediate",
      },
      {
        label: "Memory for this session",
        configured: deps.memory.mode(),
        effective: state().memory === "off" ? "off" : "on",
        source: "session",
        applies: "next run",
        mutation: "immediate",
      },
      {
        label: "Completed plans",
        configured:
          scopedPlans()?.retention === undefined
            ? "inherit"
            : scopedPlans()!.retention === "keep"
              ? "keep plans"
              : "delete after success",
        effective: state().plans.retention === "keep" ? "keep plans" : "delete after success",
        source: settingSource("plans"),
        applies: "next run",
        mutation: "immediate",
      },
    ];
  }

  function body(): JSX.Element {
    return (
      <box flexDirection="column" width="100%" minWidth={0}>
        <DetailColumn>
          <For each={settingsRows()}>
            {(setting, index) => (
              <DetailSettingRow setting={setting} selected={sel() === index()} />
            )}
          </For>
        </DetailColumn>
      </box>
    );
  }

  function detailBody(): JSX.Element {
    const index = Math.max(0, Math.min(3, sel()));
    return (
      <SettingDetail setting={settingsRows()[index]}>
        <Show when={index === 0}>
          <For each={safetyDescription(state())}>
            {(line) => (
              <text fg={tokens.muted} wrapMode="word">
                {line}
              </text>
            )}
          </For>
          <text fg={sandboxLine().fg} wrapMode="word">
            {sandboxLine().text}
          </text>
        </Show>
        <Show when={index === 1}>
          <text fg={tokens.muted}>Guard saves to {host.scope()} settings.</text>
        </Show>
        <Show when={index === 2}>
          <text fg={tokens.muted} wrapMode="word">
            {memoryDescription(state())}
          </text>
        </Show>
        <Show when={index === 3}>
          <For each={planRetentionDescription(state().plans.retention)}>
            {(line) => <text fg={tokens.muted}>{line}</text>}
          </For>
          <text fg={tokens.muted}>{planRetentionScopeLine()}</text>
        </Show>
      </SettingDetail>
    );
  }

  return (
    <LevelHost
      host={host}
      editor={fe}
      levels={[
        { title: "Run controls", body },
        { title: "Run controls", body: detailBody },
      ]}
    />
  );
}
