import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, on } from "solid-js";
import type { ModelCatalogService, SubscriptionScheme } from "@clarvis/protocol";
import { parseModelRef } from "../../adapters/model-policy.ts";
import type { SettingsAdapter, SettingsFile } from "../../adapters/settings.ts";
import {
  normalizeReasoningEfforts,
  recommendedReasoningEffort,
  supportedReasoningEfforts,
  type EffortLevel,
} from "../../adapters/effort-levels.ts";
import type { ModelsCatalog } from "../../adapters/models-catalog.ts";
import { errorText } from "../../adapters/errors.ts";
import { detachObserved } from "../../core/tasks.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import type { HintTone } from "../hint.ts";
import { configuredModelCapabilities, knownToLackReasoning } from "./catalog-pick.ts";
import {
  bindLevelKeys,
  LevelHost,
  SelectableList,
  SelectableRow,
  StatusRow,
} from "./view-host.tsx";

type Effort = SettingsFile["default_reasoning_effort"];

interface EffortChoice {
  id: string;
  value: Effort;
  label: string;
  detail: string;
}

const EFFORT_COPY: Record<EffortLevel, { label: string; detail: string }> = {
  off: { label: "Off", detail: "Fastest responses with reasoning disabled" },
  minimal: { label: "Minimal", detail: "Fast responses with minimal deliberation" },
  low: { label: "Low", detail: "Fast responses with lighter reasoning" },
  medium: {
    label: "Medium",
    detail: "Balances speed and reasoning depth for everyday tasks",
  },
  high: { label: "High", detail: "Greater reasoning depth for complex problems" },
  xhigh: { label: "Extra high", detail: "Deeper reasoning for demanding, long-horizon work" },
  max: { label: "Max", detail: "Maximum depth; consumes more time and usage" },
};

const PROVIDER_CHOICE: EffortChoice = {
  id: "provider",
  value: undefined,
  label: "Provider default",
  detail: "Let the provider decide",
};

function effortChoices(levels: readonly NonNullable<Effort>[]): EffortChoice[] {
  return [
    PROVIDER_CHOICE,
    ...levels.map((value) => ({
      id: value,
      value,
      label: EFFORT_COPY[value].label,
      detail: EFFORT_COPY[value].detail,
    })),
  ];
}

const UNKNOWN_CHOICES: EffortChoice[] = [PROVIDER_CHOICE];

/** Dependencies for the canonical default-model effort surface. */
export interface EffortViewDeps {
  settings: SettingsAdapter;
  catalog: ModelsCatalog | null;
  modelsService?: Pick<ModelCatalogService, "getEntitled">;
  notify: (message: string, tone?: HintTone) => void;
}

/** Selects the default reasoning effort used with the current default model. */
export function EffortView(host: ViewHost, deps: EffortViewDeps): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  const [entitled, setEntitled] = createSignal<EffortLevel[] | undefined>();
  const [entitledLoading, setEntitledLoading] = createSignal(false);
  let entitledRequest = 0;
  host.bindScope({ mode: "retarget" });

  const effective = createMemo(() => {
    deps.settings.version();
    return deps.settings.effective();
  });
  const current = (): Effort => effective().default_reasoning_effort;
  const model = (): string | undefined => effective().default_model;
  const subscriptionTarget = (): { scheme: SubscriptionScheme; modelId: string } | undefined => {
    const ref = model();
    if (!ref) return undefined;
    const { provider: providerName, modelId } = parseModelRef(ref);
    const kind = effective().providers?.find((provider) => provider.name === providerName)?.kind;
    return kind === "openai-codex" || kind === "xai-grok" ? { scheme: kind, modelId } : undefined;
  };
  const available = createMemo(
    () =>
      supportedReasoningEfforts(deps.catalog, effective().providers ?? [], model()) ?? entitled(),
  );
  const choices = createMemo(() => {
    const levels = available();
    return levels === undefined ? UNKNOWN_CHOICES : effortChoices(levels);
  });
  const recommended = createMemo(() => recommendedReasoningEffort(available()));
  const modelLabel = (): string => {
    const ref = model();
    return ref ? parseModelRef(ref).modelId : "default model";
  };
  const source = (): string => {
    deps.settings.version();
    return deps.settings.origin?.("default_reasoning_effort") ?? "provider";
  };
  const lacksReasoning = (): boolean =>
    (available()?.length ?? 0) === 0 &&
    knownToLackReasoning(configuredModelCapabilities(effective().providers ?? [], model()));

  createEffect(
    on(
      () => {
        const target = subscriptionTarget();
        return target ? `${target.scheme}/${target.modelId}` : "";
      },
      () => {
        const request = ++entitledRequest;
        setEntitled(undefined);
        const target = subscriptionTarget();
        if (!target || deps.modelsService === undefined) {
          setEntitledLoading(false);
          return;
        }
        setEntitledLoading(true);
        detachObserved(
          "subscription_effort_catalog",
          async () => {
            try {
              const provider = await deps.modelsService!.getEntitled(target.scheme);
              if (request !== entitledRequest) return;
              const efforts = provider.models.find(
                (item) => item.id === target.modelId,
              )?.reasoning_efforts;
              setEntitled(efforts === undefined ? undefined : normalizeReasoningEfforts(efforts));
            } finally {
              if (request === entitledRequest) setEntitledLoading(false);
            }
          },
          (error) => {
            if (request === entitledRequest)
              deps.notify(`could not load subscription effort levels: ${errorText(error)}`, "warn");
          },
        );
      },
    ),
  );

  createEffect(
    on(
      () =>
        [
          host.scope(),
          current(),
          choices()
            .map((choice) => choice.id)
            .join(","),
        ] as const,
      () => {
        const index = choices().findIndex((choice) => choice.value === current());
        setSel(index >= 0 ? index : 0);
      },
    ),
  );

  function choose(): void {
    const choice = choices()[sel()];
    if (!choice || saving()) return;
    setSaving(true);
    detachObserved(
      "default_effort_select",
      async () => {
        try {
          await deps.settings.write(host.scope(), { default_reasoning_effort: choice.value });
          deps.notify(
            `default effort: ${choice.label} (${host.scope()}) ${glyph("emDash")} applies to the next run`,
            "success",
          );
        } finally {
          setSaving(false);
        }
      },
      (error) => deps.notify(`could not set default effort: ${errorText(error)}`, "error"),
    );
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: () => choices().length,
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
      <SelectableList
        each={choices}
        sel={sel}
        idPrefix="default-effort-"
        row={(choice, index) => {
          const selected = () => sel() === index();
          const active = () => choice.value === current();
          const qualifiers = () => [
            ...(choice.value === recommended() ? ["recommended"] : []),
            ...(active() ? ["current"] : []),
          ];
          const detail = () =>
            `${choice.detail}${qualifiers().length > 0 ? ` ${glyph("separator")} ${qualifiers().join(` ${glyph("separator")} `)}` : ""}`;
          return (
            <SelectableRow selected={selected()}>
              <span
                style={{ fg: active() ? tokens.accent : selected() ? tokens.fg : tokens.muted }}
              >
                {(active() ? glyph("radioOn") : glyph("radioOff")) + " " + choice.label.padEnd(20)}
              </span>
              <span style={{ fg: tokens.muted }}>{detail()}</span>
            </SelectableRow>
          );
        }}
      />
      <StatusRow label="model" text={model() ?? "not configured — choose one in /model"} />
      <StatusRow
        label="current"
        text={
          current() !== undefined && !choices().some((choice) => choice.value === current())
            ? `${current()} (not available for this model)`
            : (current() ?? "provider default")
        }
      />
      <StatusRow label="source" text={source()} />
      {entitledLoading() && available() === undefined ? (
        <StatusRow label="support" text="Loading subscription effort levels…" />
      ) : lacksReasoning() ? (
        <StatusRow label="support" text="Default model does not declare reasoning support" />
      ) : available() === undefined ? (
        <StatusRow label="support" text="Effort levels are not published for this model" />
      ) : available()!.length === 0 ? (
        <StatusRow label="support" text="This model offers no configurable effort levels" />
      ) : (
        <StatusRow label="support" text={`${available()!.length} model-supported levels`} />
      )}
    </box>
  );

  return (
    <LevelHost
      host={host}
      levels={[{ title: `Select reasoning level for ${modelLabel()}`, body }]}
    />
  );
}
