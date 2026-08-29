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
  guardAutoResolves,
  resolvedGuardMode,
  type GuardMode,
  type GuardModeStore,
} from "../../adapters/guard-mode.ts";
import type { MemoryModeStore } from "../../adapters/memory-mode.ts";
import {
  deriveSafetyPreset,
  deriveRunControls,
  memoryDescription,
  memoryState,
  planRetentionDescription,
  safetyDescription,
  type CanonicalSafetyPreset,
  type PlanRetention,
} from "../../adapters/execution-safety.ts";
import {
  applySafetyPreset,
  CUSTOM_SAFETY_PRESET_CHOICE,
  safetyPresetConfirmation,
  SAFETY_PRESET_CHOICES,
} from "../../features/run/safety-presets.ts";
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

const SAFETY_CHOICES = [
  ...SAFETY_PRESET_CHOICES,
  CUSTOM_SAFETY_PRESET_CHOICE,
] satisfies readonly PickItem[];

const GUARD_CHOICES = [
  { value: "off", label: "off", detail: "no permission checks" },
  { value: "on", label: "on", detail: "asks before unlisted or risky commands" },
  {
    value: "auto",
    label: "auto",
    detail: "an LLM approves or denies, escalating to you when unsure",
  },
] as const satisfies readonly PickItem[];

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
 * Per-run safety controls: a safety preset (sandbox + guard combination),
 * guard mode and completed-plan retention persist immediately to the selected
 * scope; memory changes only the session store. Each row explains what the
 * resulting policy means for the next run.
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
  async function applyPreset(preset: CanonicalSafetyPreset): Promise<void> {
    const confirmation = safetyPresetConfirmation(preset, deps.settings.effective().sandbox);
    if (confirmation && !(await host.confirm(confirmation))) return;
    try {
      await applySafetyPreset(preset, {
        settings: deps.settings,
        guard: deps.guard,
        scope: host.scope(),
      });
      deps.notify(
        `safety: ${preset} (${host.scope()})${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
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

  /** Allow/deny policy that must survive a mode or named-preset write. */
  function guardPolicyForWrite(): Partial<NonNullable<SettingsFile["guard"]>> {
    const local = scopedGuard();
    const inherited =
      host.scope() === "workspace" ? deps.settings.read("global")?.guard : undefined;
    const allowed = local?.allowed_commands ?? inherited?.allowed_commands;
    const denied = local?.denied_commands ?? inherited?.denied_commands;
    return {
      ...(allowed === undefined ? {} : { allowed_commands: [...allowed] }),
      ...(denied === undefined ? {} : { denied_commands: [...denied] }),
    };
  }

  async function applyGuard(mode: GuardMode): Promise<void> {
    try {
      const degraded = mode === "auto" && !guardAutoResolves(deps.settings);
      const effectiveMode = degraded ? "on" : mode;
      await deps.settings.write(host.scope(), {
        guard: { type: "shell", ...guardPolicyForWrite(), mode: effectiveMode },
      });
      deps.guard.setMode(effectiveMode);
      if (degraded) {
        deps.notify(
          `guard: on (${host.scope()} settings) ${glyph("emDash")} auto needs a usable default_model for the LLM judge; using on until one is configured`,
        );
        return;
      }
      deps.notify(
        `guard: ${mode} (${host.scope()} settings)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
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
        fe.startEnum("Safety preset", SAFETY_CHOICES, state().preset, (value) => {
          if (value !== "custom")
            detachObserved("run_controls_preset", () =>
              applyPreset(value as CanonicalSafetyPreset),
            );
        });
        break;
      case 1:
        fe.startEnum("Command review", GUARD_CHOICES, state().guardMode, (value) =>
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
  // Every write here goes to `host.scope()`, so the toggle retargets rather than
  // reloads. Declaring it is what keeps `[^t] scope` in this panel's footer.
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
  const configuredSafetyPreset = (): string => {
    const scoped = deps.settings.read(host.scope());
    if (scoped?.sandbox === undefined && scoped?.guard === undefined) return "inherit";
    if (scoped?.sandbox === undefined || scoped.guard === undefined) return "partial override";
    return deriveSafetyPreset(scoped, resolvedGuardMode(scoped.guard));
  };
  const safetySource = (): string => {
    const sources = new Set<string>();
    const sandboxSource = settingSource("sandbox");
    const commandSource = guardSource();
    if (sandboxSource !== "product default") sources.add(sandboxSource);
    if (commandSource !== "product default") sources.add(commandSource);
    return sources.size > 0 ? [...sources].join(" + ") : "product default";
  };

  function body(): JSX.Element {
    return (
      <box flexDirection="column">
        <StatusRow
          label="mutation"
          text={`Persistent rows save to ${host.scope()} ${glyph("separator")} memory stays in this session ${glyph("separator")} next run`}
        />
        <SettingRow
          setting={{
            label: "Safety preset",
            configured: configuredSafetyPreset(),
            effective: state().preset,
            source: safetySource(),
            applies: "next run",
            mutation: "immediate",
          }}
          selected={sel() === 0}
          expanded={sel() === 0}
        />
        <Show when={sel() === 0}>
          <For each={safetyDescription(state())}>
            {(line) => <text fg={tokens.muted}>{glyph("bullet") + " " + line}</text>}
          </For>
          <text fg={sandboxLine().fg}>{sandboxLine().text}</text>
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
