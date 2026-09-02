import type { Accessor, JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { tone } from "../../theme/tone.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { clampListIndex } from "../../ui/patterns/list-navigation.ts";
import { registerLevel, verb, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { renderToolPreview } from "../tools/registry.tsx";
import { bindLevelKeys, LevelHost, SelectableList, SelectableRow } from "./view-host.tsx";
import { errorText } from "../../adapters/errors.ts";
import { padColumn } from "../truncate.ts";
import {
  BACKEND_NAME,
  schemaArgRows,
  synthSampleArgs,
  type ServerNode,
  type ServerStatus,
} from "../../adapters/mcp-capabilities.ts";

/** Data and actions {@link McpBrowser} needs from its host. */
export interface McpBrowserDeps {
  nodes: Accessor<ServerNode[]>;
  refresh: () => Promise<void>;
  editConfig: (server?: string) => void;
  notify: (message: string) => void;
}

function statusTone(status: ServerStatus): "ok" | "warn" | "error" | "pending" {
  return status === "connected"
    ? "ok"
    : status === "lost"
      ? "warn"
      : status === "unavailable"
        ? "error"
        : "pending";
}

/**
 * Read-only, three-level drill-down browser over MCP servers, their tools
 * and prompts: servers list -> a server's tools/prompts -> one item's
 * argument schema and (for prompts) invocation.
 */
export function McpBrowser(host: ViewHost, deps: McpBrowserDeps): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const [drill, setDrill] = createSignal(0);
  const [detailSel, setDetailSel] = createSignal(0);
  const [itemDrill, setItemDrill] = createSignal(0);
  const [itemKind, setItemKind] = createSignal<"tool" | "prompt">("tool");
  const [loading, setLoading] = createSignal(false);
  const [listError, setListError] = createSignal<string | null>(null);

  const refresh = (): void => {
    setLoading(true);
    void deps
      .refresh()
      .then(() => setListError(null))
      .catch((e: unknown) => setListError(`refresh failed: ${errorText(e)}`))
      .finally(() => setLoading(false));
  };

  refresh();

  const node = (): ServerNode | undefined => deps.nodes()[drill()];
  const detailRows = (): number => {
    const n = node();
    return n ? n.tools.length + n.prompts.length : 0;
  };
  const onPromptRow = (): boolean => {
    const n = node();
    // `detailSel() >= n.tools.length` alone is true for `0 >= 0` — an empty
    // server, whose selection sits on no row at all. The action then advertised
    // itself in the footer and did nothing when pressed.
    return !!n && n.prompts.length > 0 && detailSel() >= n.tools.length;
  };

  function openServer(): void {
    const clamp = (i: number): number => clampListIndex(i, deps.nodes().length);
    const n = deps.nodes()[clamp(sel())];
    if (!n) return;
    setDrill(clamp(sel()));
    setDetailSel(0);
    host.level.push(n.name);
  }

  function openItem(): void {
    const n = node();
    if (!n) return;
    const row = clampListIndex(detailSel(), detailRows());
    if (row < n.tools.length) {
      setItemKind("tool");
      setItemDrill(row);
      host.level.push(n.tools[row]!.name);
    } else {
      const pi = row - n.tools.length;
      setItemKind("prompt");
      setItemDrill(pi);
      host.level.push(n.prompts[pi]!.name);
    }
  }

  function invokeListed(): void {
    const n = node();
    if (!n || !onPromptRow()) return;
    const p = n.prompts[clampListIndex(detailSel(), detailRows()) - n.tools.length];
    if (!p) return;
    host.dispatch(`${n.name}:${p.name}`);
    deps.notify(`invoking ${n.name}:${p.name}`);
  }

  function invokeDrilled(): void {
    const n = node();
    if (!n || itemKind() !== "prompt") return;
    const p = n.prompts[itemDrill()];
    if (!p) return;
    host.dispatch(`${n.name}:${p.name}`);
    deps.notify(`invoking ${n.name}:${p.name}`);
  }

  function specFor(depth: number): LevelSpec {
    if (depth === 0)
      return {
        nav: {
          count: () => deps.nodes().length,
          index: sel,
          setIndex: setSel,
          activate: { label: "open", run: openServer },
        },
        verbs: [
          {
            key: "e",
            label: "where to edit",
            run: () => {
              const n = deps.nodes()[clampListIndex(sel(), deps.nodes().length)];
              deps.editConfig(n && n.origin === "downstream" ? n.name : undefined);
            },
          },
          verb("refresh", refresh),
        ],
      };
    if (depth === 1)
      return {
        nav: {
          count: detailRows,
          index: detailSel,
          setIndex: setDetailSel,
          activate: { label: "detail", run: openItem },
        },
        verbs: [
          { key: "i", label: "invoke prompt", run: invokeListed, when: onPromptRow },
          { key: "e", label: "where to edit", run: () => deps.editConfig(node()?.name) },
        ],
      };
    return {
      verbs: [
        { key: "i", label: "invoke", run: invokeDrilled, when: () => itemKind() === "prompt" },
      ],
    };
  }

  bindLevelKeys({
    host,
    register: (enabled) =>
      registerLevel(host.interaction.keymap, { ...specFor(host.level.depth()), enabled }),
  });

  const headerCount = (): number => {
    const nodes = deps.nodes();
    let n = nodes.filter((node) => node.name === BACKEND_NAME).length;
    if (nodes.length > 1 && nodes[1]!.name !== BACKEND_NAME) n += 1;
    return n;
  };

  function serversBody(): JSX.Element {
    return (
      <SelectableList<ServerNode>
        each={deps.nodes}
        sel={sel}
        idPrefix="mcp-"
        loading={loading}
        error={listError}
        empty={() => ({
          text: "no MCP servers " + glyph("emDash") + " edit configuration or refresh",
        })}
        contentRows={() => deps.nodes().length + headerCount()}
        row={(n, i) => {
          const on = (): boolean => sel() === i();
          const isBackend = n.name === BACKEND_NAME;
          const caps = isBackend
            ? "control-plane hidden"
            : `${n.tools.length} tools ${glyph("separator")} ${n.prompts.length} prompts`;
          return (
            <>
              <Show when={isBackend}>
                <text flexShrink={0} fg={tokens.muted}>
                  backend
                </text>
              </Show>
              <Show when={!isBackend && i() === 1}>
                <text flexShrink={0} fg={tokens.muted}>
                  downstream (aggregated by the kernel)
                </text>
              </Show>
              <SelectableRow selected={on()}>
                <span style={{ fg: tone(statusTone(n.status)).fg }}>
                  {tone(statusTone(n.status)).glyph + " "}
                </span>
                <span style={{ fg: on() ? tokens.fg : tokens.muted }}>{padColumn(n.name, 16)}</span>
                <span style={{ fg: tokens.muted }}>
                  {padColumn(n.type ?? (isBackend ? "stdio" : glyph("emDash")), 6)}
                </span>
                <span style={{ fg: tone(statusTone(n.status)).fg }}>{padColumn(n.status, 13)}</span>
                <span style={{ fg: tokens.muted }}>{caps}</span>
                <Show when={n.decl?.shared}>
                  <span style={{ fg: tokens.accent2 }}>{"   shared"}</span>
                </Show>
              </SelectableRow>
            </>
          );
        }}
        trailing={
          <text flexShrink={0} fg={tokens.muted}>
            {glyph("success") +
              " connected   " +
              glyph("warning") +
              " lost   " +
              glyph("error") +
              " unavailable   " +
              glyph("pending") +
              " declared"}
          </text>
        }
      />
    );
  }

  function serverDetailBody(): JSX.Element {
    const n = node();
    if (!n) return <text fg={tokens.muted}>{glyph("emDash")}</text>;
    if (n.name === BACKEND_NAME)
      return (
        <box flexDirection="column">
          <text fg={tokens.muted}>
            {"The control-plane (run " +
              glyph("separator") +
              " steer " +
              glyph("separator") +
              " get_run " +
              glyph("separator") +
              " list_runs " +
              glyph("separator") +
              " delete_run " +
              glyph("separator") +
              " list_profiles)"}
          </text>
          <text fg={tokens.muted}>is transport/backend and is not a browsable capability.</text>
        </box>
      );
    const T = n.tools.length;
    return (
      <box flexDirection="column">
        <text flexShrink={0} fg={tokens.accent2}>{`Tools (${T})`}</text>
        <For each={n.tools}>
          {(t, i) => {
            const on = (): boolean => detailSel() === i();
            return (
              <box paddingLeft={2} flexShrink={0}>
                <SelectableRow selected={on()}>
                  <span style={{ fg: on() ? tokens.fg : tokens.muted }}>
                    {padColumn(t.name, 22)}
                  </span>
                  <span style={{ fg: tokens.muted }}>{t.description ?? ""}</span>
                </SelectableRow>
              </box>
            );
          }}
        </For>
        <text flexShrink={0} fg={tokens.accent2}>{`Prompts (${n.prompts.length})`}</text>
        <For each={n.prompts}>
          {(p, i) => {
            const row = (): number => T + i();
            const on = (): boolean => detailSel() === row();
            const args = (p.arguments ?? []).map((a) => a.name).join(", ");
            return (
              <box paddingLeft={2} flexShrink={0}>
                <SelectableRow selected={on()}>
                  <span style={{ fg: on() ? tokens.fg : tokens.muted }}>
                    {padColumn(p.name, 22)}
                  </span>
                  <span style={{ fg: tokens.muted }}>{p.description ?? ""}</span>
                  <Show when={args}>
                    <span style={{ fg: tokens.muted }}>{"   args: " + args}</span>
                  </Show>
                </SelectableRow>
              </box>
            );
          }}
        </For>
        <Show when={T === 0 && n.prompts.length === 0}>
          <text fg={tokens.muted}>
            {n.status === "declared"
              ? "configured for the current Extension Profile " +
                glyph("emDash") +
                " capabilities appear after connection or first use"
              : "no capabilities exposed"}
          </text>
        </Show>
      </box>
    );
  }

  function itemDetailBody(): JSX.Element {
    const n = node();
    if (!n) return <text fg={tokens.muted}>{glyph("emDash")}</text>;
    if (itemKind() === "tool") {
      const t = n.tools[itemDrill()];
      if (!t) return <text fg={tokens.muted}>{glyph("emDash")}</text>;
      const argRows = schemaArgRows(t.inputSchema);
      return (
        <box flexDirection="column">
          <text
            fg={tokens.fg}
          >{`${t.name}${t.description ? " " + glyph("emDash") + " " + t.description : ""}`}</text>
          <text flexShrink={0} fg={tokens.accent2}>
            arguments
          </text>
          <For each={argRows}>
            {(a) => (
              <text flexShrink={0}>
                <span style={{ fg: tokens.fg }}>{padColumn(a.name, 18)}</span>
                <span style={{ fg: tokens.muted }}>{padColumn(a.type, 9)}</span>
                <span style={{ fg: a.required ? tokens.warn : tokens.muted }}>
                  {a.required ? "required  " : "optional  "}
                </span>
                <span style={{ fg: tokens.muted }}>{a.description}</span>
              </text>
            )}
          </For>
          <Show when={argRows.length === 0}>
            <text fg={tokens.muted}>
              {Object.keys(t.inputSchema.properties ?? {}).length === 0
                ? "no arguments"
                : "input schema  " + JSON.stringify(t.inputSchema.properties ?? {})}
            </text>
          </Show>
          <text flexShrink={0} fg={tokens.accent2}>
            {"render preview " + glyph("caretDown")}
          </text>
          <box flexDirection="column" paddingLeft={2}>
            {renderToolPreview(n.name, t.name, synthSampleArgs(t.inputSchema))}
          </box>
          <text fg={tokens.muted}>
            {glyph("info") +
              " a tool is the agent's capability " +
              glyph("emDash") +
              " browse here; it renders in the transcript when the agent calls it."}
          </text>
        </box>
      );
    }
    const p = n.prompts[itemDrill()];
    if (!p) return <text fg={tokens.muted}>{glyph("emDash")}</text>;
    return (
      <box flexDirection="column">
        <text
          fg={tokens.fg}
        >{`${p.name}${p.description ? " " + glyph("emDash") + " " + p.description : ""}`}</text>
        <text flexShrink={0} fg={tokens.accent2}>
          arguments
        </text>
        <For each={p.arguments ?? []}>
          {(a) => (
            <text flexShrink={0}>
              <span style={{ fg: tokens.fg }}>{padColumn(a.name, 18)}</span>
              <span style={{ fg: a.required ? tokens.warn : tokens.muted }}>
                {a.required ? "required  " : "optional  "}
              </span>
              <span style={{ fg: tokens.muted }}>{a.description ?? ""}</span>
            </text>
          )}
        </For>
        <Show when={(p.arguments ?? []).length === 0}>
          <text fg={tokens.muted}>no arguments</text>
        </Show>
        <text fg={tokens.muted}>{`${glyph("arrowRight")} /${n.name}:${p.name}   [i] invoke`}</text>
      </box>
    );
  }

  return (
    <LevelHost
      host={host}
      levels={[
        { title: "MCP", body: serversBody, readOnly: true },
        { title: "MCP", body: serverDetailBody, readOnly: true },
        { title: "MCP", body: itemDetailBody, readOnly: true },
      ]}
    />
  );
}
