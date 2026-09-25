import type { JSX } from "solid-js";
import { createSignal } from "solid-js";
import type { ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import type { EnvView } from "../../adapters/agent-files.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, createFieldEditor, LevelHost, StatusRow } from "./view-host.tsx";
import type { HintTone } from "../hint.ts";
import type { SettingPresentation } from "../../ui/presentation.ts";
import { DetailColumn, DetailSettingRow, SettingDetail } from "../../ui/patterns/detail-view.tsx";

/** Data and actions {@link DefaultsPanel} needs from its host. */
export interface DefaultsDeps {
  settings: SettingsAdapter;
  env: EnvView;
  notify: (message: string, tone?: HintTone) => void;
}

type BudgetDraft = NonNullable<SettingsFile["budget"]>;

/**
 * Config panel for token-budget defaults.
 * The run model and its effort deliberately live only in `/model` and `/effort`.
 */
export function DefaultsPanel(host: ViewHost, deps: DefaultsDeps): JSX.Element {
  const settings = deps.settings;
  const env = deps.env;
  const fe = createFieldEditor(host.interaction, host.active);

  const [budget, setBudget] = createSignal<BudgetDraft | undefined>(undefined);
  const [sel, setSel] = createSignal(0);
  const clamp = (i: number): number => Math.max(0, Math.min(1, i));

  function load(): void {
    const s = settings.read(host.scope()) ?? {};
    setBudget(s.budget);
    host.markDirty(false);
  }
  host.bindScope({ mode: "reload", load });
  load();

  async function save(): Promise<void> {
    await settings.write(host.scope(), {
      budget: budget(),
    });
    host.markDirty(false);
    deps.notify(`saved ${host.scope()} defaults`);
  }
  host.onSave(save);

  function editSelected(): void {
    const i = clamp(sel());
    if (i === 0) {
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

  function openDetails(): void {
    host.level.push(settingsRows()[clamp(sel())]?.label ?? "Details");
  }

  const spec = (): LevelSpec =>
    host.level.depth() === 1
      ? { verbs: [{ key: "e", label: "edit", run: editSelected }] }
      : {
          nav: {
            count: () => 2,
            index: sel,
            setIndex: setSel,
            activate: { label: "edit", run: editSelected },
          },
          verbs: [{ key: "i", label: "details", run: openDetails }],
        };

  bindLevelKeys({
    host,
    editor: fe,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  function settingsRows(): SettingPresentation[] {
    return [
      {
        label: "When budget is exceeded",
        configured: budget()?.on_exceed ?? "inherit",
        effective:
          budget()?.on_exceed ?? settings.effective().budget?.on_exceed ?? env.budgetOnExceed,
        source: budget() ? host.scope() : (settings.origin?.("budget") ?? "product default"),
        applies: "next run",
        mutation: "staged",
      },
      {
        label: "Total token limit",
        configured: budget()?.total_token_limit?.toString() ?? "inherit",
        effective:
          budget()?.total_token_limit?.toString() ??
          settings.effective().budget?.total_token_limit?.toString() ??
          env.tokenDefault.toString(),
        source: budget() ? host.scope() : (settings.origin?.("budget") ?? "product default"),
        applies: "next run",
        mutation: "staged",
      },
    ];
  }

  function body(): JSX.Element {
    return (
      <DetailColumn>
        {settingsRows().map((setting, index) => (
          <DetailSettingRow setting={setting} selected={sel() === index} />
        ))}
      </DetailColumn>
    );
  }

  function detailBody(): JSX.Element {
    const index = clamp(sel());
    return (
      <SettingDetail setting={settingsRows()[index]}>
        {index === 1 ? (
          <StatusRow label="host ceiling" text={String(env.tokenCeiling)} />
        ) : undefined}
      </SettingDetail>
    );
  }

  return (
    <LevelHost
      host={host}
      editor={fe}
      levels={[
        { title: "Defaults", body },
        { title: "Defaults", body: detailBody },
      ]}
    />
  );
}
