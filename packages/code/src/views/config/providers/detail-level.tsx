import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { detachObserved } from "../../../core/tasks.ts";
import type { EnvKeyStatus, ProviderKind } from "../../../adapters/settings.ts";
import type { KeySource } from "../../../adapters/provider-secrets.ts";
import { PROVIDER_KINDS } from "../../../adapters/models-catalog.ts";
import { KEY_SOURCES, SOURCE_MEANING } from "../../../features/providers/controller.ts";
import { tokens } from "../../../theme/tokens.ts";
import { glyph } from "../../../theme/glyphs.ts";
import { truncateEnd } from "../../truncate.ts";
import { catalogReady, providerRows } from "../catalog-pick.ts";
import { issueSet, mapProviderIssues } from "../validation.ts";
import { Dash, FieldRow, SelectableRow } from "../view-host.tsx";
import { verb, type LevelSpec } from "../../../ui/patterns/level-keys.ts";
import type { ProvidersViewContext } from "./context.ts";

export const PROVIDER_DETAIL_FIELDS = [
  "name",
  "kind",
  "base_url",
  "env var",
  "API key",
  "source",
  "headers",
  "body",
] as const;

/**
 * Which {@link PROVIDER_DETAIL_FIELDS} row a validation issue's `field` belongs
 * to, for the jump a failed save performs.
 *
 * @remarks Only the fields `validateProviders` actually issues appear - `kind`
 *   is never one of them, and a hand-written row table that included it carried
 *   an entry nothing could reach. Keyed by label rather than by index so the
 *   jump derives its row from the pinned array itself; the order is a contract
 *   (INV-265) and a second copy of it would drift silently.
 */
export const PROVIDER_ISSUE_DETAIL_FIELD: Readonly<
  Record<string, (typeof PROVIDER_DETAIL_FIELDS)[number]>
> = {
  name: "name",
  base_url: "base_url",
  api_key_env: "env var",
};

/** Owns provider credentials, request maps, and configured models (L1). */
export function createProviderDetailLevel(ctx: ProvidersViewContext): {
  title: () => string;
  body: () => JSX.Element;
  spec: () => LevelSpec;
  modelIds: () => string[];
} {
  const ENV_ROW = 3;
  const API_KEY_ROW = 4;
  const SOURCE_ROW = 5;
  const HEADERS_ROW = 6;
  const BODY_ROW = 7;
  const isSubscription = (): boolean => {
    const kind = ctx.current()?.kind;
    return kind === "openai-codex" || kind === "xai-grok";
  };
  const fieldCount = (): number => (isSubscription() ? 3 : PROVIDER_DETAIL_FIELDS.length);
  const modelIds = (): string[] => Object.keys(ctx.current()?.models ?? {});
  const issues = issueSet(() => mapProviderIssues(ctx.ctrl.validation(), ctx.current()?.name));

  function editSource(): void {
    const p = ctx.current();
    if (!p?.api_key_env) {
      ctx.notify("name the env var first " + glyph("emDash") + " set the key");
      return;
    }
    const envVar = p.api_key_env;
    ctx.editor.startEnum(
      `key source ${glyph("emDash")} ${envVar}`,
      KEY_SOURCES.map((source) => ({
        label: source,
        value: source,
        detail: SOURCE_MEANING[source],
      })),
      ctx.ctrl.sourceOf(envVar),
      (value) => ctx.ctrl.stageSource(envVar, value as KeySource),
    );
  }

  function setKeyValue(): void {
    const p = ctx.current();
    if (!p) return;
    if (p.api_key_env) {
      ctx.enterKey(p.api_key_env);
      return;
    }
    ctx.startEdit("Credential variable", ctx.ctrl.suggestedEnvVar(p), (value) => {
      const name = value.trim();
      if (!name) return;
      ctx.ctrl.setProviderField(ctx.drill(), { api_key_env: name });
      ctx.enterKey(name);
    });
  }

  function renameEnvVar(): void {
    const p = ctx.current();
    if (!p) return;
    ctx.startEdit("Credential variable", p.api_key_env ?? ctx.ctrl.suggestedEnvVar(p), (value) =>
      ctx.ctrl.setProviderField(ctx.drill(), { api_key_env: value.trim() || undefined }),
    );
  }

  function editKind(): void {
    const p = ctx.current();
    if (!p) return;
    if (isSubscription()) {
      ctx.notify("Subscription API type is fixed by its authenticated scheme", "warn");
      return;
    }
    ctx.editor.startEnum("API type", PROVIDER_KINDS, p.kind, (value) =>
      ctx.ctrl.setProviderField(ctx.drill(), { kind: value as ProviderKind }),
    );
  }

  function editProviderField(field: "name" | "base_url"): void {
    const p = ctx.current();
    if (!p) return;
    ctx.startEdit(
      field === "name" ? "Provider name" : "Base URL",
      (p[field] as string) ?? "",
      (input) => {
        const trimmed = input.trim();
        const value = field === "name" ? trimmed : trimmed || undefined;
        ctx.ctrl.setProviderField(ctx.drill(), { [field]: value });
        if (field === "name" && trimmed) ctx.host.level.retitle(trimmed);
      },
    );
  }

  function activate(): void {
    const row = ctx.detailRow();
    if (row === 0) editProviderField("name");
    else if (row === 1) editKind();
    else if (isSubscription() && row === 2) {
      const kind = ctx.current()?.kind;
      if (kind === "openai-codex" || kind === "xai-grok") ctx.manageSubscription?.(kind);
    } else if (!isSubscription() && row === 2) editProviderField("base_url");
    else if (!isSubscription() && row === ENV_ROW) renameEnvVar();
    else if (!isSubscription() && row === API_KEY_ROW) setKeyValue();
    else if (!isSubscription() && row === SOURCE_ROW) editSource();
    else if (!isSubscription() && row === HEADERS_ROW) ctx.openMap("headers", "provider");
    else if (!isSubscription() && row === BODY_ROW) ctx.openMap("body", "provider");
    else {
      const id = modelIds()[row - fieldCount()];
      if (!id) return;
      ctx.setModelId(id);
      ctx.setModelRow(0);
      ctx.host.level.push(id);
    }
  }

  function addModels(): void {
    const p = ctx.current();
    if (!p) return;
    if (isSubscription()) {
      ctx.openSubscription?.(p.kind as "openai-codex" | "xai-grok");
      return;
    }
    // A provider selected through onboarding's manual-entry row has no catalog
    // identity. Send it straight to the model-id editor, which is the second
    // onboarding step and can complete setup when the entry is valid.
    if (ctx.manualBootstrapProvider() && modelIds().length === 0) {
      ctx.manualModelEntry((id) => {
        const selected = ctx.current();
        if (selected) ctx.finishBootstrap(selected, id);
      });
      return;
    }
    if (!catalogReady(ctx.catalog)) {
      ctx.manualModelEntry();
      return;
    }
    const resolved = ctx.ctrl.resolveCatalogProvider(p);
    if (resolved) ctx.openModelPicker(resolved);
    else
      ctx.setPicker({
        title: "No catalog match " + glyph("emDash") + " pick a source provider",
        rows: () => providerRows(ctx.catalog!.providers()),
        onManual: () => {
          ctx.setPicker(null);
          ctx.manualModelEntry();
        },
        onClose: () => ctx.setPicker(null),
        onPick: (id) => {
          const provider = ctx.catalog!.provider(id);
          if (provider) ctx.openModelPicker(provider);
        },
      });
  }

  function removeModel(): void {
    const id = modelIds()[ctx.detailRow() - fieldCount()];
    if (!id || ctx.modelRemovalBlocked(id)) return;
    detachObserved("provider_model_remove_confirm", () =>
      ctx.host
        .confirm({
          message: `remove model '${id}'?`,
          danger: true,
          confirmLabel: "remove",
          cancelLabel: "keep",
        })
        .then((ok) => {
          if (ok) ctx.ctrl.removeModel(ctx.drill(), id);
        }),
    );
  }

  function body(): JSX.Element {
    const p = ctx.current();
    if (!p) return <Dash />;
    const ids = Object.keys(p.models ?? {});
    const staged = (): boolean => !!p.api_key_env && ctx.ctrl.pendingKeys().has(p.api_key_env);
    const keyState = (): EnvKeyStatus | null =>
      p.api_key_env ? ctx.ctrl.envStatusOf(p.api_key_env) : null;
    const keyValue = (): string =>
      staged()
        ? glyph("bullet").repeat(5) + " staged " + glyph("emDash") + " saves with Save changes"
        : keyState() === "set"
          ? glyph("success") + " from shell env"
          : keyState() === "keyfile"
            ? glyph("success") + " saved in keys.json"
            : keyState() === "unset"
              ? glyph("error") + " no value yet"
              : glyph("emDash") + " not configured";
    const keyValueFg = (): string =>
      staged()
        ? tokens.warn
        : keyState() === "set" || keyState() === "keyfile"
          ? tokens.add
          : tokens.warn;
    const keyHint = (): string =>
      keyState() === "set"
        ? "set a keys.json value"
        : keyState() === "keyfile" || staged()
          ? "replace the saved value"
          : "paste your key";
    const source = (): KeySource => (p.api_key_env ? ctx.ctrl.sourceOf(p.api_key_env) : "auto");
    const sourceValue = (): string =>
      p.api_key_env
        ? source() + (ctx.ctrl.pendingSources().has(p.api_key_env) ? "  (staged)" : "")
        : glyph("emDash");
    return (
      <box flexDirection="column">
        <Show when={ctx.manualBootstrapProvider() && ids.length === 0}>
          <box flexDirection="column" marginBottom={1}>
            <text fg={tokens.accent2}>Manual provider setup</text>
            <text fg={tokens.muted}>
              1. Set a provider name, API type, and endpoint. 2. Press A to create its model.
            </text>
            <text fg={tokens.muted}>
              Local endpoints commonly use openai-compatible; credentials are optional when the
              server needs none.
            </text>
          </box>
        </Show>
        <FieldRow
          label="Provider name"
          value={p.name}
          selected={ctx.detailRow() === 0}
          required
          issue={issues.for("name")}
        />
        <FieldRow label="API type" value={p.kind} kind="enum" selected={ctx.detailRow() === 1} />
        <Show when={isSubscription()}>
          <FieldRow
            label="Subscription"
            value={(() => {
              const status = ctx.subscriptionStatus?.(p.kind as "openai-codex" | "xai-grok");
              return status?.state === "connected"
                ? `connected${status.plan ? ` ${glyph("separator")} ${status.plan}` : ""}`
                : status?.state === "expired" || status?.state === "reauthentication_required"
                  ? "reauthentication required"
                  : (status?.state ?? "unavailable");
            })()}
            selected={ctx.detailRow() === 2}
            note={
              ctx.subscriptionStatus?.(p.kind as "openai-codex" | "xai-grok")?.state === "connected"
                ? "disconnect"
                : "connect or reauthenticate"
            }
          />
        </Show>
        <Show when={!isSubscription()}>
          <FieldRow
            label="Base URL"
            value={p.base_url ?? glyph("emDash")}
            selected={ctx.detailRow() === 2}
            required={p.kind === "openai-compatible"}
            issue={issues.for("base_url")}
          />
          <FieldRow
            label="Credential variable"
            value={p.api_key_env ?? "Not set — name it to configure a key"}
            selected={ctx.detailRow() === ENV_ROW}
            issue={issues.for("api_key_env")}
          />
          <FieldRow
            label="Credential value"
            value={keyValue()}
            selected={ctx.detailRow() === API_KEY_ROW}
            note={ctx.detailRow() === API_KEY_ROW ? keyHint() : undefined}
            noteFg={keyValueFg()}
          />
          <FieldRow
            label="Credential source"
            value={sourceValue()}
            kind={p.api_key_env ? "enum" : undefined}
            selected={ctx.detailRow() === SOURCE_ROW}
            note={p.api_key_env ? SOURCE_MEANING[source()] : "(set a key first)"}
            noteFg={tokens.muted}
          />
          <FieldRow
            label="Request headers"
            value={ctx.mapCell(p.headers)}
            selected={ctx.detailRow() === HEADERS_ROW}
            note={"edit " + glyph("separator") + " sent on every request"}
            noteFg={tokens.muted}
          />
          <FieldRow
            label="Request body"
            value={ctx.mapCell(p.body)}
            selected={ctx.detailRow() === BODY_ROW}
            note={"edit " + glyph("separator") + " request-body extras, e.g. provider routing"}
            noteFg={p.kind === "openai-compatible" || !p.body ? tokens.muted : tokens.warn}
          />
        </Show>
        <text flexShrink={0} fg={tokens.accent2}>{`  Models (${ids.length})`}</text>
        <For each={ids}>
          {(id, index) => {
            const row = (): number => fieldCount() + index();
            const model = p.models![id]!;
            return (
              <box paddingLeft={2} flexShrink={0}>
                <SelectableRow selected={ctx.detailRow() === row()}>
                  <span style={{ fg: tokens.fg }}>{truncateEnd(id, 27).padEnd(28)}</span>
                  <span
                    style={{ fg: tokens.muted }}
                  >{`ctx ${String(model.context_window_tokens).padStart(7)}${model.max_output_tokens ? `   out ${String(model.max_output_tokens).padStart(6)}` : ""}`}</span>
                  <Show when={ctx.ctrl.effectiveDefaultModel() === `${p.name}/${id}`}>
                    <span style={{ fg: tokens.accent }}>{"   current default model"}</span>
                  </Show>
                </SelectableRow>
              </box>
            );
          }}
        </For>
        <Show when={ids.length === 0}>
          <text fg={tokens.muted}>
            {"No models configured — unknown models use a 128000-token context fallback"}
          </text>
        </Show>
      </box>
    );
  }

  return {
    title: () =>
      ctx.manualBootstrapProvider() && modelIds().length === 0
        ? `Set up Clarvis ${glyph("separator")} Step 1 of 2 ${glyph("separator")} Manual provider`
        : "Providers",
    body,
    modelIds,
    spec: () => ({
      nav: {
        count: () => fieldCount() + modelIds().length,
        index: ctx.detailRow,
        setIndex: ctx.setDetailRow,
        activate: { label: "edit", run: activate },
      },
      verbs: [
        { ...verb("add", addModels), label: "add models" },
        {
          ...verb("delete", removeModel, () => ctx.detailRow() >= fieldCount()),
          label: "remove model",
        },
      ],
    }),
  };
}
