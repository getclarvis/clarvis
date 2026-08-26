import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, on } from "solid-js";
import { resolveContextWindow, type SettingsAdapter } from "../../adapters/settings.ts";
import {
  recommendedReasoningEffort,
  supportedReasoningEfforts,
} from "../../adapters/effort-levels.ts";
import type { ModelsCatalog } from "../../adapters/models-catalog.ts";
import { detachObserved } from "../../core/tasks.ts";
import { errorText } from "../../adapters/errors.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { HintTone } from "../hint.ts";
import { configuredModelRows } from "./catalog-pick.ts";
import type { RunHost } from "../../run-host.ts";
import {
  bindLevelKeys,
  LevelHost,
  SelectableList,
  SelectableRow,
  StatusRow,
} from "./view-host.tsx";

/** Dependencies for the one canonical global-default-model surface. */
export interface ModelViewDeps {
  settings: SettingsAdapter;
  catalog: ModelsCatalog | null;
  notify: (message: string, tone?: HintTone) => void;
  runActive?: () => boolean;
  inspectContext?: RunHost["inspectCurrentContext"];
  fitContext?: RunHost["fitCurrentContext"];
}

/**
 * Selects `default_model` from every model configured across every provider.
 *
 * Selection is applied immediately to the visible scope. Provider editing owns
 * the available-model set; it deliberately cannot mutate this value.
 */
export function ModelView(host: ViewHost, deps: ModelViewDeps): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  host.bindScope({ mode: "retarget" });

  const effective = createMemo(() => {
    deps.settings.version();
    return deps.settings.effective();
  });
  const current = (): string | undefined => effective().default_model;
  const rows = createMemo(() => configuredModelRows(effective().providers ?? [], current()));

  createEffect(
    on(
      () => [host.scope(), current(), rows().length] as const,
      () => {
        const index = rows().findIndex((row) => row.id === current());
        setSel(index >= 0 ? index : 0);
      },
    ),
  );

  function choose(): void {
    const model = rows()[sel()]?.id;
    if (!model || saving()) return;
    if (model !== current() && deps.runActive?.() === true) {
      deps.notify("finish the active run before changing the model", "warn");
      return;
    }
    setSaving(true);
    detachObserved(
      "default_model_select",
      async () => {
        try {
          const targetWindow = resolveContextWindow(effective().providers, model, 0);
          const effort = recommendedReasoningEffort(
            supportedReasoningEfforts(deps.catalog, effective().providers ?? [], model),
          );
          const settingsPatch = {
            default_model: model,
            default_reasoning_effort: effort,
          };
          const contextInfo =
            model !== current() && targetWindow > 0
              ? await deps.inspectContext?.(targetWindow)
              : null;
          if (contextInfo?.requires_compaction === true) {
            const accepted = await host.confirm({
              message: `switch to ${model} with a smaller context window?`,
              detail: [
                `Current context: about ${contextInfo.estimated_tokens.toLocaleString()} tokens`,
                `New safe limit: ${contextInfo.high_water_tokens?.toLocaleString() ?? targetWindow.toLocaleString()} tokens`,
                "Clarvis must permanently evict older context before changing the model.",
              ],
              danger: true,
              confirmLabel: "compact and switch",
              cancelLabel: "keep current model",
            });
            if (!accepted) return;
            const scope = host.scope();
            const priorScope = deps.settings.read(scope);
            await deps.settings.write(scope, settingsPatch);
            let fitted: Awaited<ReturnType<NonNullable<ModelViewDeps["fitContext"]>>> | undefined;
            try {
              fitted = await deps.fitContext?.(targetWindow);
            } catch (error) {
              await deps.settings.write(scope, {
                default_model: priorScope?.default_model,
                default_reasoning_effort: priorScope?.default_reasoning_effort,
              });
              throw error;
            }
            if (fitted?.status !== "compacted") {
              await deps.settings.write(scope, {
                default_model: priorScope?.default_model,
                default_reasoning_effort: priorScope?.default_reasoning_effort,
              });
              deps.notify(
                `model unchanged: context could not fit ${model}${fitted?.status === "skipped" ? ` (${fitted.reason.replaceAll("_", " ")})` : ""}`,
                "error",
              );
              return;
            }
            deps.notify(
              `older context evicted ${glyph("emDash")} ${fitted.freed_chars.toLocaleString()} chars freed for ${model}`,
              "warn",
            );
          } else {
            await deps.settings.write(host.scope(), settingsPatch);
          }
          deps.notify(
            `default model: ${model} ${glyph("separator")} effort: ${effort ?? "provider default"} (${host.scope()}) ${glyph("emDash")} applies to the next run`,
            "success",
          );
        } finally {
          setSaving(false);
        }
      },
      (error) => deps.notify(`could not set default model: ${errorText(error)}`, "error"),
    );
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: () => rows().length,
      index: sel,
      setIndex: setSel,
      activate: {
        label: saving() ? "saving" : "use as default",
        run: choose,
        when: () => !saving(),
      },
    },
  });

  bindLevelKeys({
    host,
    suspend: () => false,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const body = (): JSX.Element => (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <text fg={tokens.muted} selectable={false}>
        {"Model                                             Context / output"}
      </text>
      <SelectableList
        each={rows}
        sel={sel}
        idPrefix="default-model-"
        empty={() => ({
          text: "No configured models",
          hint: "Add providers and models in /settings/providers, then return to /model.",
        })}
        row={(row, index) => {
          const selected = () => sel() === index();
          const active = () => row.id === current();
          return (
            <SelectableRow selected={selected()}>
              <span
                style={{ fg: active() ? tokens.accent : selected() ? tokens.fg : tokens.muted }}
              >
                {(active() ? glyph("radioOn") : glyph("radioOff")) + " " + row.label.padEnd(48)}
              </span>
              <span style={{ fg: tokens.muted }}>{row.columns?.[0]?.text ?? ""}</span>
            </SelectableRow>
          );
        }}
      />
      <StatusRow label="current" text={current() ?? "not configured"} />
      <StatusRow
        label="source"
        text={deps.settings.origin?.("default_model") ?? "not configured"}
      />
    </box>
  );

  return <LevelHost host={host} levels={[{ title: "Default model", body }]} />;
}
