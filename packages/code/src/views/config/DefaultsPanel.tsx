import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import { glyph } from "../../theme/glyphs.ts";
import type { ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import type { EnvView } from "../../adapters/agent-files.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  LevelHost,
  SettingRow,
  StatusRow,
} from "./view-host.tsx";
import type { CatalogPickerSpec } from "./CatalogPicker.tsx";
import { modelPickerSpec } from "./pick-model.ts";
import type { HintTone } from "../hint.ts";

/** Data and actions {@link DefaultsPanel} needs from its host. */
export interface DefaultsDeps {
  settings: SettingsAdapter;
  env: EnvView;
  notify: (message: string, tone?: HintTone) => void;
}

type BudgetDraft = NonNullable<SettingsFile["budget"]>;

/**
 * Config panel for vision-model and token-budget defaults.
 * The run model and its effort deliberately live only in `/model` and `/effort`.
 */
export function DefaultsPanel(host: ViewHost, deps: DefaultsDeps): JSX.Element {
  const settings = deps.settings;
  const env = deps.env;
  const fe = createFieldEditor(host.interaction, host.active);

  const [visionModel, setVisionModel] = createSignal<string | undefined>(undefined);
  const [budget, setBudget] = createSignal<BudgetDraft | undefined>(undefined);
  const [sel, setSel] = createSignal(0);
  const [picker, setPicker] = createSignal<CatalogPickerSpec | null>(null);
  const clamp = (i: number): number => Math.max(0, Math.min(2, i));

  function load(): void {
    const s = settings.read(host.scope()) ?? {};
    setVisionModel(s.default_vision_model);
    setBudget(s.budget);
    host.markDirty(false);
  }
  host.bindScope({ mode: "reload", load });
  load();

  async function save(): Promise<void> {
    await settings.write(host.scope(), {
      default_vision_model: visionModel(),
      budget: budget(),
    });
    host.markDirty(false);
    deps.notify(`saved ${host.scope()} defaults`);
  }
  host.onSave(save);

  function editSelected(): void {
    const i = clamp(sel());
    if (i === 0) {
      const spec = modelPickerSpec({
        fe,
        settings,
        current: visionModel() ?? "",
        requireCapability: "vision",
        title: `Pick a vision model ${glyph("emDash")} configured providers`,
        commit: (v) => {
          setVisionModel(v || undefined);
          host.markDirty(true);
        },
        close: () => setPicker(null),
      });
      if (spec) setPicker(spec);
    } else if (i === 1) {
      fe.startEnum(
        "budget.on_exceed",
        ["stop", "escalate"],
        budget()?.on_exceed ?? env.budgetOnExceed,
        (v) => {
          setBudget((b) => ({ ...(b ?? {}), on_exceed: v as BudgetDraft["on_exceed"] }));
          host.markDirty(true);
        },
      );
    } else {
      fe.startNumber("total_token_limit", budget()?.total_token_limit, {
        min: 1,
        max: env.tokenCeiling,
        commit: (v) => {
          // Write back only the field the user changed. `on_exceed` used to be
          // co-written from the env default because the settings schema
          // required it; it does not any more, and inventing a value the user
          // never chose turns an edit of one field into a second, silent
          // decision about what happens at the wall.
          setBudget((b) => ({ ...(b ?? {}), total_token_limit: v }));
          host.markDirty(true);
        },
        notify: deps.notify,
      });
    }
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: () => 3,
      index: sel,
      setIndex: setSel,
      activate: { label: "edit", run: editSelected },
    },
  });

  bindLevelKeys({
    host,
    editor: fe,
    suspend: () => picker() !== null,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  function body(): JSX.Element {
    return (
      <box flexDirection="column">
        <SettingRow
          setting={{
            label: "Vision model",
            configured: visionModel() ?? "inherit",
            effective:
              visionModel() ?? settings.effective().default_vision_model ?? "not configured",
            source: visionModel()
              ? host.scope()
              : (settings.origin?.("default_vision_model") ?? "product default"),
            applies: "next run",
            mutation: "staged",
          }}
          selected={sel() === 0}
          expanded={sel() === 0}
        />
        <StatusRow
          label="vision"
          text={
            visionModel()
              ? "reads images for an agent whose own model cannot see them"
              : "images become numbered placeholders for a model without vision"
          }
        />
        <SettingRow
          setting={{
            label: "When budget is exceeded",
            configured: budget()?.on_exceed ?? "inherit",
            effective:
              budget()?.on_exceed ?? settings.effective().budget?.on_exceed ?? env.budgetOnExceed,
            source: budget() ? host.scope() : (settings.origin?.("budget") ?? "product default"),
            applies: "next run",
            mutation: "staged",
          }}
          selected={sel() === 1}
          expanded={sel() === 1}
        />
        <SettingRow
          setting={{
            label: "Total token limit",
            configured: budget()?.total_token_limit?.toString() ?? "inherit",
            effective:
              budget()?.total_token_limit?.toString() ??
              settings.effective().budget?.total_token_limit?.toString() ??
              env.tokenDefault.toString(),
            source: budget() ? host.scope() : (settings.origin?.("budget") ?? "product default"),
            applies: "next run",
            mutation: "staged",
          }}
          selected={sel() === 2}
          expanded={sel() === 2}
        />
        <StatusRow label="host ceiling" text={String(env.tokenCeiling)} />
      </box>
    );
  }

  return (
    <LevelHost host={host} editor={fe} picker={picker} levels={[{ title: "Defaults", body }]} />
  );
}
