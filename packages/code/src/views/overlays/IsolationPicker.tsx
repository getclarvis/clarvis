import { createEffect, createSignal, on, Show, type Accessor, type JSX } from "solid-js";
import type { IsolationStatus } from "@clarvis/protocol";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import {
  saveIsolationChoice,
  type IsolationChoice,
  type IsolationModeStore,
} from "../../adapters/isolation-mode.ts";
import type { Interaction } from "../../keys/interaction.ts";
import { glyph, glyphColWidth } from "../../theme/glyphs.ts";
import { tokens } from "../../theme/tokens.ts";
import { ListPicker } from "./ListPicker.tsx";

type Pane = "mode" | "workspace" | "network";
type Choice<T extends string> = { value: T; label: string; detail: string };

const MODES: Choice<IsolationChoice["mode"]>[] = [
  { value: "host", label: "Host", detail: "Run tools with host access" },
  { value: "sandbox", label: "Sandbox", detail: "Limit file access; recover on host when needed" },
];
const WORKSPACE: Choice<IsolationChoice["workspace"]>[] = [
  {
    value: "read-only",
    label: "Read only",
    detail: "Read workspace; write allowed temporary roots",
  },
  { value: "read-write", label: "Read + write", detail: "Read and write workspace" },
];
const NETWORK: Choice<IsolationChoice["network"]>[] = [
  { value: "enabled", label: "Enabled", detail: "Allow built-in tools to use network" },
  { value: "disabled", label: "Disabled", detail: "Block network for sandboxed built-in tools" },
];

/** Global isolation picker, with one active ListPicker key layer at a time. */
export function IsolationPicker(props: {
  interaction: Interaction;
  settings: SettingsAdapter;
  isolation: IsolationModeStore;
  status: () => Promise<IsolationStatus>;
  active: Accessor<boolean>;
  notify: (message: string, tone?: "info" | "success" | "warn" | "error") => void;
  onClose: () => void;
  onApplied: () => void;
}): JSX.Element {
  const [pane, setPane] = createSignal<Pane>("mode");
  const [saving, setSaving] = createSignal(false);
  const [status, setStatus] = createSignal<IsolationStatus>();
  const [sandboxSelected, setSandboxSelected] = createSignal(false);
  const [highlightedMode, setHighlightedMode] = createSignal<IsolationChoice["mode"]>(
    props.isolation.choice().mode,
  );
  createEffect(
    on(props.active, (active) => {
      if (!active) return;
      setPane("mode");
      setHighlightedMode(props.isolation.choice().mode);
      void props
        .status()
        .then(setStatus)
        .catch(() => setStatus(undefined));
    }),
  );

  const save = async (
    patch: Partial<IsolationChoice>,
    label: string,
    close: boolean,
  ): Promise<void> => {
    if (saving()) return;
    setSaving(true);
    try {
      await saveIsolationChoice(props.settings, props.isolation, patch);
      props.notify(`${label} saved globally for subsequent runs`, "success");
      if (close) props.onApplied();
      else setPane("mode");
    } catch {
      props.notify(`Could not save global ${label.toLowerCase()}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const mode = (): IsolationChoice => props.isolation.choice();
  const radio = <T extends string>(choice: Choice<T>, selected: Accessor<boolean>, current: T) => [
    {
      width: glyphColWidth("radioOn"),
      fg: choice.value === current ? tokens.accent : tokens.muted,
      text: choice.value === current ? glyph("radioOn") : glyph("radioOff"),
    },
    { width: 13, fg: selected() ? tokens.fg : tokens.muted, text: choice.label },
    { grow: true, marginLeft: 1, fg: tokens.muted, text: choice.detail },
  ];

  return (
    <>
      <Show when={pane() === "mode"}>
        <ListPicker
          keymap={props.interaction.keymap}
          active={() => props.active() && pane() === "mode"}
          locked={saving}
          resetKey={() => `${String(props.active())}:${mode().mode}`}
          title="Select isolation"
          items={() => MODES}
          initialIndex={highlightedMode() === "sandbox" ? 1 : 0}
          idPrefix="isolation-mode-"
          confirmLabel="use"
          size="lg"
          responsiveNavigation
          onConfirm={(choice) =>
            void save({ mode: choice.value }, `Isolation: ${choice.label}`, true)
          }
          onClose={props.onClose}
          onSelect={(choice) => {
            setSandboxSelected(choice?.value === "sandbox");
            if (choice) setHighlightedMode(choice.value);
          }}
          verbs={[
            {
              key: "w",
              label: "work",
              when: () => sandboxSelected() && !saving(),
              run: (choice) => {
                if (choice.value === "sandbox") setPane("workspace");
              },
            },
            {
              key: "n",
              label: "net",
              when: () => sandboxSelected() && !saving(),
              run: (choice) => {
                if (choice.value === "sandbox") setPane("network");
              },
            },
          ]}
          cells={(choice, selected) => radio(choice, selected, mode().mode)}
          preview={(choice) =>
            choice.value === "sandbox" ? (
              <box flexDirection="column">
                <box flexDirection="row">
                  <text fg={tokens.fg} onMouseDown={() => !saving() && setPane("workspace")}>
                    {`Workspace: ${mode().workspace === "read-only" ? "Read only" : "Read + write"}  `}
                  </text>
                  <text fg={tokens.fg} onMouseDown={() => !saving() && setPane("network")}>
                    {`Network: ${mode().network === "enabled" ? "Enabled" : "Disabled"}`}
                  </text>
                </box>
                <text fg={tokens.muted}>
                  {status()?.availability === "unavailable"
                    ? "Unavailable — host fallback"
                    : `Backend: ${status()?.backend ?? "checking"}; host fallback is automatic`}
                </text>
              </box>
            ) : (
              <box flexDirection="column">
                <text fg={tokens.fg}>Host access for built-in tools</text>
                <text fg={tokens.muted}>Sandbox preferences remain saved for later use</text>
              </box>
            )
          }
        />
      </Show>
      <Show when={pane() === "workspace"}>
        <ListPicker
          keymap={props.interaction.keymap}
          active={() => props.active() && pane() === "workspace"}
          locked={saving}
          title="Sandbox workspace"
          items={() => WORKSPACE}
          initialIndex={mode().workspace === "read-only" ? 0 : 1}
          idPrefix="isolation-workspace-"
          confirmLabel="save workspace"
          size="sm"
          onConfirm={(choice) =>
            void save({ workspace: choice.value }, `Workspace: ${choice.label}`, false)
          }
          onClose={() => setPane("mode")}
          cells={(choice, selected) => radio(choice, selected, mode().workspace)}
          preview={() => (
            <text fg={tokens.muted}>
              Temporary roots and global agent/workflow/settings exceptions stay writable.
            </text>
          )}
        />
      </Show>
      <Show when={pane() === "network"}>
        <ListPicker
          keymap={props.interaction.keymap}
          active={() => props.active() && pane() === "network"}
          locked={saving}
          title="Sandbox network"
          items={() => NETWORK}
          initialIndex={mode().network === "enabled" ? 0 : 1}
          idPrefix="isolation-network-"
          confirmLabel="save network"
          size="sm"
          onConfirm={(choice) =>
            void save({ network: choice.value }, `Network: ${choice.label}`, false)
          }
          onClose={() => setPane("mode")}
          cells={(choice, selected) => radio(choice, selected, mode().network)}
          preview={() => (
            <text fg={tokens.muted}>
              Provider, hooks and MCP connections have separate network policy.
            </text>
          )}
        />
      </Show>
    </>
  );
}
