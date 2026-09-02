import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { detachObserved } from "../../../core/tasks.ts";
import { tokens } from "../../../theme/tokens.ts";
import { glyph } from "../../../theme/glyphs.ts";
import { truncateEnd } from "../../truncate.ts";
import { catalogReady, providerRows, recommendedProviderRows } from "../catalog-pick.ts";
import { SelectableList, SelectableRow } from "../view-host.tsx";
import { verb, type LevelSpec } from "../../../ui/patterns/level-keys.ts";
import type { ProviderKeyStatus } from "../../../features/providers/controller.ts";
import type { ProviderConfig } from "../../../adapters/settings.ts";
import type { ProvidersViewContext } from "./context.ts";

/** Owns the provider list/default-model screen (L0). */
export function createProviderListLevel(ctx: ProvidersViewContext): {
  title: () => string;
  body: () => JSX.Element;
  spec: () => LevelSpec;
  openAdd: () => void;
} {
  const { ctrl, providers, sel, setSel } = ctx;
  const closePicker = (): void => {
    ctx.setPicker(null);
    if (ctx.bootstrap) ctx.host.close();
  };

  const defaultProviderName = (): string | undefined => {
    const dm = ctrl.effectiveDefaultModel();
    if (!dm) return undefined;
    const i = dm.indexOf("/");
    return i > 0 ? dm.slice(0, i) : undefined;
  };
  const presentKeyStatus = (status: ProviderKeyStatus): { text: string; fg: string } => {
    switch (status) {
      case "not-required":
        return { text: glyph("emDash"), fg: tokens.muted };
      case "staged":
        return { text: "Unsaved key", fg: tokens.warn };
      case "environment":
        return { text: "Shell environment", fg: tokens.add };
      case "keyfile":
        return { text: "Saved key", fg: tokens.add };
      case "missing":
        return { text: "Missing key", fg: tokens.del };
    }
  };
  const issueMessage = (): string | undefined => {
    const check = ctrl.validation();
    if (check.ok) return undefined;
    const name = providers()[sel()]?.name;
    const hit = name ? check.issues.find((i) => i.provider === name) : undefined;
    return hit ? `${name}: ${hit.message}` : undefined;
  };
  function addBlank(): void {
    if (ctx.bootstrap) ctx.setManualBootstrapProvider(true);
    const created = ctrl.addBlankProvider();
    ctx.setDrill(providers().length - 1);
    ctx.setDetailRow(0);
    ctx.host.level.push(created.name);
  }
  function openPicker(): void {
    if (!catalogReady(ctx.catalog)) {
      ctx.setPicker({
        title:
          ctx.bootstrap && providers().length === 0
            ? `Set up Clarvis ${glyph("separator")} Step 1 of 2 ${glyph("separator")} Provider`
            : "Add provider",
        rows: () => ctx.subscriptionRows?.() ?? [],
        onManual: () => {
          ctx.setPicker(null);
          addBlank();
        },
        onClose: closePicker,
        onPick: (id) => {
          if (id === "openai-codex" || id === "xai-grok") {
            ctx.setPicker(null);
            ctx.openSubscription?.(id);
          }
        },
      });
      return;
    }
    const [showAll, setShowAll] = createSignal(!ctx.bootstrap);
    const allProviders = ctx.catalog!.providers();
    ctx.setPicker({
      title:
        ctx.bootstrap && providers().length === 0
          ? `Set up Clarvis ${glyph("separator")} Step 1 of 2 ${glyph("separator")} Provider`
          : "Add provider " + glyph("emDash") + " models.dev catalog",
      rows: () =>
        showAll()
          ? [...(ctx.subscriptionRows?.() ?? []), ...providerRows(allProviders)]
          : [
              ...(ctx.subscriptionRows?.() ?? []),
              ...recommendedProviderRows(allProviders),
              {
                id: "__all_providers__",
                label: `Browse all ${allProviders.length} providers${glyph("ellipsis")}`,
                haystack: "browse all providers",
                detail: "Search the complete models.dev catalog",
              },
            ],
      onManual: () => {
        ctx.setPicker(null);
        addBlank();
      },
      onClose: closePicker,
      onPick: (id) => {
        if (id === "openai-codex" || id === "xai-grok") {
          ctx.setPicker(null);
          ctx.openSubscription?.(id);
          return;
        }
        if (id === "__all_providers__") {
          setShowAll(true);
          return;
        }
        const cp = ctx.catalog!.provider(id);
        if (!cp) return;
        const config = ctrl.seedProviderFromCatalog(cp.id);
        if (!config) return;
        ctx.setManualBootstrapProvider(false);
        ctx.setDrill(providers().length - 1);
        ctx.setDetailRow(0);
        ctx.host.level.push(config.name);
        ctx.openModelPicker(cp, config);
      },
    });
  }
  function activate(): void {
    if (providers()[sel()]) {
      ctx.setDrill(sel());
      ctx.setDetailRow(0);
      ctx.host.level.push(providers()[sel()]!.name);
    }
  }
  function remove(): void {
    const index = sel();
    const p = providers()[index];
    if (!p) return;
    const refs = ctrl.providerRefs(p.name);
    const detail: string[] = [];
    if (refs.agents.length) detail.push(`cited by agents: ${refs.agents.join(", ")}`);
    if (refs.defaultModel) detail.push("owns the default_model");
    detachObserved("provider_delete_confirm", () =>
      ctx.host
        .confirm({
          message: `delete provider '${p.name}'?`,
          danger: true,
          detail,
          confirmLabel: "delete",
          cancelLabel: "keep",
        })
        .then((ok) => {
          if (!ok) return;
          ctrl.deleteProviderAt(index);
          setSel((s) => Math.max(0, s - 1));
        }),
    );
  }
  function body(): JSX.Element {
    return (
      <box flexDirection="column">
        <text fg={tokens.muted} selectable={false}>
          {"Provider       API type            Models    Credentials          Source"}
        </text>
        <SelectableList<ProviderConfig>
          each={providers}
          sel={sel}
          idPrefix="prov-"
          empty={() => ({
            text: "No providers — use Add to open the models.dev catalog",
          })}
          row={(p, i) => {
            const on = () => sel() === i();
            const models = Object.keys(p.models ?? {}).length;
            const subscription = p.kind === "openai-codex" || p.kind === "xai-grok";
            const cell = subscription
              ? { text: "Subscription", fg: tokens.add }
              : presentKeyStatus(ctrl.keyStatus(p));
            return (
              <SelectableRow selected={on()}>
                <span style={{ fg: on() ? tokens.fg : tokens.muted }}>
                  {truncateEnd(p.name, 13).padEnd(14)}
                </span>
                <span style={{ fg: tokens.muted }}>{truncateEnd(p.kind, 17).padEnd(20)}</span>
                <span style={{ fg: tokens.muted }}>
                  {(models ? String(models) : glyph("emDash")).padEnd(10)}
                </span>
                <span style={{ fg: cell.fg }}>{cell.text.padEnd(21)}</span>
                <span style={{ fg: tokens.muted }}>{ctrl.origins().get(p.name) ?? "global"}</span>
                <Show when={defaultProviderName() === p.name}>
                  <span style={{ fg: tokens.accent }}>{"  default model"}</span>
                </Show>
              </SelectableRow>
            );
          }}
          trailing={
            <Show when={issueMessage()}>
              <text flexShrink={0} fg={tokens.del}>
                {glyph("error") + " " + issueMessage()}
              </text>
            </Show>
          }
        />
      </box>
    );
  }
  return {
    title: () =>
      providers().length === 0
        ? "Providers"
        : `Providers ${glyph("separator")} ${ctrl.keyedCount()} of ${providers().length} ready`,
    body,
    openAdd: openPicker,
    spec: () => ({
      nav: {
        count: () => providers().length,
        index: sel,
        setIndex: setSel,
        activate: { label: "open", run: activate },
      },
      verbs: [verb("add", openPicker), verb("delete", remove, () => sel() < providers().length)],
    }),
  };
}
