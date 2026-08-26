import type { Accessor, JSX } from "solid-js";
import { detachObserved } from "../../core/tasks.ts";
import { createSignal, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  DetailLines,
  SelectableList,
  SelectableRow,
  ViewFrame,
  type DetailRow,
} from "./view-host.tsx";
import type { PluginView } from "../../adapters/plugins.ts";

/** Data and actions {@link PluginBrowser} needs from its host. */
export interface PluginBrowserDeps {
  plugins: Accessor<PluginView[]>;
  toggleEnabled: (p: PluginView) => void;
  install: (url: string) => void;
  update: (p: PluginView) => void;
  uninstall: (p: PluginView) => void;
  notify: (message: string) => void;
}

function stateTone(p: PluginView): "ok" | "warn" | "error" | "pending" {
  if (p.error !== undefined) return "error";
  return p.enabled ? "ok" : "pending";
}

function stateLabel(p: PluginView): string {
  if (p.error !== undefined) return "broken";
  return p.enabled ? "enabled" : "disabled";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function summary(p: PluginView): string {
  const c = p.contributions;
  const parts: string[] = [];
  if (c.agents.length > 0) parts.push(count(c.agents.length, "agent"));
  if (c.skills.length > 0) parts.push(count(c.skills.length, "skill"));
  if (c.servers.length > 0) parts.push(count(c.servers.length, "server"));
  if (c.hooks > 0) parts.push(count(c.hooks, "hook"));
  if (c.capabilityExecutables.length > 0)
    parts.push(count(c.capabilityExecutables.length, "capability service"));
  return parts.length > 0 ? parts.join(", ") : "contributes nothing";
}

/**
 * Installed-plugin browser: enable/disable, inspect executable services, install
 * from a git URL, update, and uninstall (non-workspace plugins only). Exact hook
 * definitions are reviewed separately in `/extensions/hooks`.
 */
export function PluginBrowser(host: ViewHost, deps: PluginBrowserDeps): JSX.Element {
  const keymap = host.interaction.keymap;
  const editor = createFieldEditor(host.interaction, host.active);
  const [sel, setSel] = createSignal(0);

  const items = (): PluginView[] => deps.plugins();
  const selected = (): PluginView | undefined => items()[clampListIndex(sel(), items().length)];

  const detailRows = (): DetailRow[] => {
    const p = selected();
    if (!p) return [];
    const rows: DetailRow[] = [{ text: p.dir, fg: tokens.muted }];
    if (p.error !== undefined) {
      rows.push({ text: `${tone("error").glyph} ${p.error}`, fg: tone("error").fg });
      return rows;
    }
    if (p.displayName) rows.push({ text: `display  ${p.displayName}`, fg: tokens.muted });
    if (p.description) rows.push({ text: p.description, fg: tokens.fg });
    if (p.shortDescription && p.shortDescription !== p.description) {
      rows.push({ text: `summary  ${p.shortDescription}`, fg: tokens.muted });
    }
    if (p.source) rows.push({ text: `source   ${p.source}`, fg: tokens.muted });
    if (p.revision) rows.push({ text: `revision ${p.revision}`, fg: tokens.muted });
    rows.push({ text: summary(p), fg: tokens.muted });
    const c = p.contributions;
    if (c.agents.length > 0) {
      rows.push({
        text: `agents   ${c.agents.map((a) => `${p.name}:${a}`).join("  ")}  (executable, spawnable with their own grants)`,
        fg: tokens.warn,
      });
    }
    if (c.brokenAgents.length > 0) {
      rows.push({
        text: `broken   ${c.brokenAgents.map((a) => `${p.name}:${a}`).join("  ")}  (skipped at load)`,
        fg: tokens.del,
      });
    }
    if (c.skills.length > 0) {
      rows.push({ text: `skills   ${c.skills.join("  ")}`, fg: tokens.muted });
    }
    if (c.servers.length > 0) {
      rows.push({
        text: `servers  ${c.servers.map((s) => `${p.name}:${s}`).join("  ")}  (executable)`,
        fg: tokens.warn,
      });
    }
    if (c.hooks > 0) {
      rows.push({
        text: `hooks    ${c.hooks}  (executable, runs after every operator hook)`,
        fg: tokens.warn,
      });
    }
    for (const executable of c.capabilityExecutables) {
      rows.push({
        text:
          `service  ${executable.capability} ${glyph("arrowRight")} ` +
          `${[executable.command, ...executable.args].join(" ")}` +
          (executable.platformOverride ? `  (${process.platform} override)` : ""),
        fg: tokens.warn,
      });
    }
    for (const policy of c.skillPlanPolicies ?? []) {
      rows.push({
        text: `policy   /${policy.skill} ${glyph("arrowRight")} plans:${policy.mode}`,
        fg: policy.mode === "review" ? tokens.warn : tokens.muted,
      });
    }
    for (const e of c.executables) {
      rows.push({ text: `         ${e}`, fg: tokens.warn });
    }
    for (const note of p.notes ?? []) {
      rows.push({ text: `${tone("warn").glyph} ${note}`, fg: tokens.muted });
    }
    return rows;
  };

  const spec = (): LevelSpec => ({
    nav: { count: () => items().length, index: sel, setIndex: setSel },
    verbs: [
      {
        key: "e",
        label: selected()?.enabled ? "disable" : "enable",
        when: () => selected() !== undefined,
        run: () => {
          const p = selected();
          if (p) deps.toggleEnabled(p);
        },
      },
      {
        key: "a",
        label: "install",
        run: () =>
          editor.start("git URL", "", (url) => {
            if (url.trim().length > 0) deps.install(url);
          }),
      },
      {
        key: "u",
        label: "update",
        when: () => selected() !== undefined,
        run: () => {
          const p = selected();
          if (!p) return;
          deps.update(p);
        },
      },
      {
        key: "d",
        label: "uninstall",
        when: () => selected() !== undefined,
        run: () => {
          const p = selected();
          if (!p) return;
          if (p.scope === "workspace") {
            deps.notify(
              `${p.name} lives in this workspace ${glyph("emDash")} remove it from the repo instead`,
            );
            return;
          }
          detachObserved("plugin_uninstall_confirm", () =>
            host
              .confirm({
                message: `Uninstall ${p.name}?`,
                danger: true,
                detail: [`deletes ${p.dir}`],
                confirmLabel: "uninstall",
                cancelLabel: "keep",
              })
              .then((ok) => {
                if (ok) deps.uninstall(p);
              }),
          );
        },
      },
    ],
  });

  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(keymap, { ...spec(), enabled }),
    editor,
  });

  return (
    <ViewFrame host={host} title="Plugins" unscoped>
      <SelectableList<PluginView>
        each={items}
        sel={sel}
        idPrefix="plugin-"
        empty={() => ({ text: "no plugins installed" })}
        row={(p, i) => (
          <SelectableRow selected={sel() === i()}>
            <span style={{ fg: tone(stateTone(p)).fg }}>{tone(stateTone(p)).glyph} </span>
            <span style={{ fg: tokens.fg }}>{p.name}</span>
            <span style={{ fg: tokens.muted }}>
              {p.version ? `  v${p.version}` : ""}
              {`  ${stateLabel(p)}  ${p.scope}`}
              {p.shadowsGlobal ? "  shadows global" : ""}
            </span>
          </SelectableRow>
        )}
        trailing={
          <Show when={items().length > 0}>
            <box flexDirection="column" flexShrink={0} paddingTop={1}>
              <DetailLines rows={detailRows()} />
            </box>
          </Show>
        }
      />
      <Show when={editor.editing()}>{editor.EditInput()}</Show>
      {editor.PickerInput()}
    </ViewFrame>
  );
}
