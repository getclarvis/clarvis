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
} from "../../adapters/execution-safety.ts";
import {
  applyIsolation,
  isolationConfirmation,
  ISOLATION_CHOICES,
  type IsolationChoice,
} from "../../features/run/isolation.ts";
import { applyReviewMode, REVIEW_CHOICES } from "../../features/run/review.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  LevelHost,
  SettingRow,
  StatusRow,
} from "./view-host.tsx";
import type { PickItem } from "./field-editor.tsx";
import { errorText } from "../../adapters/errors.ts";

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
 * Per-run controls expose isolation and command review as independent axes.
 * Isolation persists globally because container placement is host-owned;
 * review and completed-plan retention use the selected scope, while memory is
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
    openSandbox: () => void;
    retryRuntime?: () => void;
  },
): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const fe = createFieldEditor(host.interaction, host.active);
  const [availability, setAvailability] = createSignal<SandboxInspection["backend"] | null>(null);
  onMount(() => {
    void deps.settings
      .inspectSandbox()
      .then((inspection) => setAvailability(inspection.backend))
      .catch(() => setAvailability(null));
  });
  const state = createMemo(() => {
    deps.settings.version();
    return deriveRunControls(deps.settings.effective(), deps.guard.mode(), deps.memory.mode());
  });

  function sandboxLine(): { text: string; fg: string } {
    const s = state();
    if (s.isolation === "docker")
      return {
        text: "Docker stays cold until the first run; an operational startup failure requires Sandbox.",
        fg: tokens.muted,
      };
    if (s.isolation === "podman")
      return {
        text: "Podman is configured through advanced settings and starts on the first run.",
        fg: tokens.muted,
      };
    if (!s.sandboxEnabled) return { text: "Native sandbox is off.", fg: tokens.warn };
    const avail = availability();
    if (!avail)
      return {
        text: "Checking native sandbox on the kernel host" + glyph("ellipsis"),
        fg: tokens.muted,
      };
    if (!avail.available) {
      return s.sandboxRequired
        ? {
            text: `${glyph("warning")} Native sandbox unavailable here (${avail.reason}); required sandbox fails every run.`,
            fg: tokens.del,
          }
        : {
            text: `Native sandbox unavailable here (${avail.reason}); optional sandbox runs directly on the host.`,
            fg: tokens.warn,
          };
    }
    if (avail.degraded)
      return {
        text: `${avail.type === "bubblewrap" ? "Bubblewrap" : "Native sandbox"} runs in degraded mode (${avail.reason ?? "reduced isolation"}).`,
        fg: tokens.warn,
      };
    if (!s.sandboxRequired)
      return {
        text: "Optional sandbox may execute directly on an incompatible host.",
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
      if (isolation === "docker") deps.retryRuntime?.();
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
          `review: approval (${host.scope()} settings) ${glyph("emDash")} Auto needs a usable default_model for the LLM judge`,
        );
        return;
      }
      deps.notify(
        `review: ${mode === "on" ? "approval" : mode} (${host.scope()} settings)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
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
        fe.startEnum("Command review", REVIEW_PICKER_CHOICES, state().guardMode, (value) =>
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

  const spec = (): LevelSpec => ({
    nav: {
      count: () => 4,
      index: sel,
      setIndex: setSel,
      activate: { label: "change", run: activate },
    },
    verbs:
      sel() === 0 ? [{ key: "b", label: "sandbox details", run: () => deps.openSandbox() }] : [],
  });
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
    if (global?.runtime === undefined && global?.sandbox === undefined) return "product default";
    return deriveIsolation(global ?? {});
  };

  function body(): JSX.Element {
    return (
      <box flexDirection="column" width="100%" minWidth={0}>
        <StatusRow
          label="mutation"
          text={`Isolation saves globally ${glyph("separator")} review/plans save to ${host.scope()} ${glyph("separator")} memory stays in this session`}
        />
        <SettingRow
          setting={{
            label: "Isolation",
            configured: configuredIsolation(),
            effective: state().isolation,
            source: "global",
            applies: "next run",
            mutation: "immediate",
          }}
          selected={sel() === 0}
          expanded={sel() === 0}
        />
        <Show when={sel() === 0}>
          <For each={safetyDescription(state())}>
            {(line) => (
              <text fg={tokens.muted} wrapMode="word">
                {glyph("bullet") + " " + line}
              </text>
            )}
          </For>
          <text fg={sandboxLine().fg} wrapMode="word">
            {sandboxLine().text}
          </text>
        </Show>
        <SettingRow
          setting={{
            label: "Command review",
            configured: scopedGuard()?.mode ?? "inherit",
            effective: state().guardMode,
            source: guardSource(),
            applies: "next run",
            mutation: "immediate",
          }}
          selected={sel() === 1}
          expanded={sel() === 1}
        />
        <SettingRow
          setting={{
            label: "Memory for this session",
            configured: deps.memory.mode(),
            effective: state().memory === "off" ? "off" : "on",
            source: "session",
            applies: "next run",
            mutation: "immediate",
          }}
          selected={sel() === 2}
          expanded={sel() === 2}
        />
        <Show when={sel() === 2}>
          <text fg={tokens.muted}>{glyph("bullet") + " " + memoryDescription(state())}</text>
        </Show>
        <SettingRow
          setting={{
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
          }}
          selected={sel() === 3}
          expanded={sel() === 3}
        />
        <Show when={sel() === 3}>
          <For each={planRetentionDescription(state().plans.retention)}>
            {(line) => <text fg={tokens.muted}>{glyph("bullet") + " " + line}</text>}
          </For>
          <text fg={tokens.muted}>{glyph("bullet") + " " + planRetentionScopeLine()}</text>
        </Show>
      </box>
    );
  }

  return <LevelHost host={host} editor={fe} levels={[{ title: "Run controls", body }]} />;
}
