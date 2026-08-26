import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import type { CatalogModel } from "../../../adapters/models-catalog.ts";
import { cacheModeOf, derivePromptCacheMode } from "../../../adapters/model-policy.ts";
import { tokens } from "../../../theme/tokens.ts";
import { glyph } from "../../../theme/glyphs.ts";
import { clampListIndex } from "../../../ui/patterns/list-navigation.ts";
import { PANEL_VERBS, type LevelSpec } from "../../../ui/patterns/level-keys.ts";
import { FieldRow } from "../view-host.tsx";
import type { ProvidersViewContext } from "./context.ts";

export const MODEL_FIELDS = [
  "context_window_tokens",
  "max_output_tokens",
  "prompt_cache",
  "headers",
  "body",
] as const;
type NumericModelField = Extract<
  (typeof MODEL_FIELDS)[number],
  "context_window_tokens" | "max_output_tokens"
>;
const PROMPT_CACHE_CYCLE = [undefined, "explicit", "implicit", "off"] as const;

/** Owns model limits, catalog metadata, capabilities, and prompt cache (L2). */
export function createProviderModelLevel(ctx: ProvidersViewContext): {
  body: () => JSX.Element;
  spec: () => LevelSpec;
} {
  const fillHit = createMemo<CatalogModel | undefined>(() => {
    const provider = ctx.current();
    return provider ? ctx.ctrl.fillModelFromCatalog(provider, ctx.modelId()) : undefined;
  });
  const catalogHit = createMemo<CatalogModel | undefined>(() => {
    const provider = ctx.current();
    return provider ? ctx.ctrl.catalogModelFor(provider, ctx.modelId()) : undefined;
  });

  const setNumeric = (field: NumericModelField, value: number | undefined): void =>
    ctx.ctrl.setModelField(ctx.drill(), ctx.modelId(), field, value);

  function activate(): void {
    const field = MODEL_FIELDS[clampListIndex(ctx.modelRow(), MODEL_FIELDS.length)]!;
    const entry = ctx.current()?.models?.[ctx.modelId()];
    if (field === "headers" || field === "body") {
      ctx.openMap(field, "model");
      return;
    }
    if (field === "prompt_cache") {
      const at = PROMPT_CACHE_CYCLE.indexOf(entry?.prompt_cache);
      const next = PROMPT_CACHE_CYCLE[(at + 1) % PROMPT_CACHE_CYCLE.length];
      ctx.ctrl.setModelPromptCache(ctx.drill(), ctx.modelId(), next);
      ctx.notify(`Prompt cache: ${next ?? "automatic"} (${ctx.host.scope()} settings, unsaved)`);
      return;
    }
    const current =
      field === "context_window_tokens" ? entry?.context_window_tokens : entry?.max_output_tokens;
    ctx.editor.startNumber(
      field === "context_window_tokens" ? "Context window" : "Maximum output",
      current,
      {
        min: 1,
        commit: (value) => setNumeric(field, value),
        notify: ctx.notify,
      },
    );
  }

  function fillFromCatalog(): void {
    const provider = ctx.current();
    const hit = provider ? ctx.ctrl.fillModelFromCatalog(provider, ctx.modelId()) : undefined;
    if (!hit) return;
    if (hit.context_window_tokens) setNumeric("context_window_tokens", hit.context_window_tokens);
    if (hit.max_output_tokens) setNumeric("max_output_tokens", hit.max_output_tokens);
    if (hit.capabilities?.length)
      ctx.ctrl.setModelCapabilities(ctx.drill(), ctx.modelId(), hit.capabilities);
    if (provider && ctx.current()?.models?.[ctx.modelId()]?.prompt_cache === undefined) {
      const derived = derivePromptCacheMode(catalogHit()?.cost, provider.kind);
      if (derived !== undefined) ctx.ctrl.setModelPromptCache(ctx.drill(), ctx.modelId(), derived);
    }
  }

  function promptCacheNote(): string {
    const mode = cacheModeOf(catalogHit()?.cost);
    const scope = `${ctx.host.scope()} settings`;
    const separator = glyph("separator");
    if (mode === "explicit" && ctx.current()?.kind === "openai-compatible")
      return `catalog: explicit ${separator} not derived on this kind ${separator} ${scope}`;
    if (mode === "explicit")
      return `catalog: explicit ${separator} sends cache markers ${separator} ${scope}`;
    if (mode === "implicit")
      return `catalog: implicit ${separator} the provider caches on its own ${separator} ${scope}`;
    return `catalog: unknown ${separator} no cache pricing published ${separator} ${scope}`;
  }

  function body(): JSX.Element {
    const entry = ctx.current()?.models?.[ctx.modelId()];
    return (
      <box flexDirection="column">
        <FieldRow label="Model ID" value={ctx.modelId()} />
        <FieldRow
          label="Context window"
          value={String(entry?.context_window_tokens ?? ctx.ctrl.defaultWindow)}
          selected={ctx.modelRow() === 0}
          note={"used to size context compaction " + glyph("separator") + " required"}
        />
        <FieldRow
          label="Maximum output"
          value={
            entry?.max_output_tokens != null ? String(entry.max_output_tokens) : glyph("emDash")
          }
          selected={ctx.modelRow() === 1}
          note="optional"
        />
        <FieldRow
          label="Prompt cache"
          value={entry?.prompt_cache ?? "(auto)"}
          kind="enum"
          selected={ctx.modelRow() === 2}
          note={promptCacheNote()}
        />
        <FieldRow
          label="Request headers"
          value={ctx.mapCell(entry?.headers)}
          selected={ctx.modelRow() === 3}
          note="replaces the provider's value for each key it names"
          noteFg={tokens.muted}
        />
        <FieldRow
          label="Request body"
          value={ctx.mapCell(entry?.body)}
          selected={ctx.modelRow() === 4}
          note="replaces the provider's value for each key it names"
          noteFg={tokens.muted}
        />
        <Show when={fillHit()}>
          <text
            flexShrink={0}
            fg={tokens.muted}
          >{`  models.dev: ${ctx.modelId()} · Context ${fillHit()!.context_window_tokens ?? "unknown"} · F fill`}</text>
        </Show>
        <Show when={!fillHit()}>
          <text
            flexShrink={0}
            fg={tokens.muted}
          >{`  not in the models.dev catalog ${glyph("emDash")} [${PANEL_VERBS.add.key}] at the provider level browses it`}</text>
        </Show>
      </box>
    );
  }

  return {
    body,
    spec: () => ({
      nav: {
        count: () => MODEL_FIELDS.length,
        index: ctx.modelRow,
        setIndex: ctx.setModelRow,
        activate: { label: "edit", run: activate },
      },
      verbs: [
        {
          key: "f",
          label: "fill from catalog",
          run: fillFromCatalog,
          when: () => fillHit() !== undefined,
        },
      ],
    }),
  };
}
