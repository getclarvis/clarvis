import type { JSX } from "solid-js";
import { createMemo, createSignal, For } from "solid-js";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import type { ViewHost } from "../../keys/commands.ts";
import type { SettingsAdapter } from "../../adapters/settings.ts";
import { deriveIsolation } from "../../adapters/execution-safety.ts";
import { detachObserved } from "../../core/tasks.ts";
import {
  applyIsolation,
  isolationConfirmation,
  isolationPlacementLines,
  isContainerIsolation,
  ISOLATION_CHOICES,
  type IsolationChoice,
} from "../../features/run/isolation.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  LevelHost,
  SettingRow,
  StatusRow,
} from "./view-host.tsx";
import type { PickItem } from "./field-editor.tsx";
import { errorText } from "../../adapters/errors.ts";

const ISOLATION_PICKER_CHOICES = ISOLATION_CHOICES satisfies readonly PickItem[];

/** Data and actions {@link IsolationConfigPanel} needs from its host. */
export interface IsolationConfigDeps {
  settings: SettingsAdapter;
  notify: (message: string) => void;
  runActive: () => boolean;
  openSandbox: () => void;
  retryRuntime?: () => void;
}

/**
 * Global isolation settings: Host, Sandbox, Docker or Podman.
 *
 * @remarks
 * Runtime placement is host-owned, so this panel never writes workspace settings
 * and does not clone native Sandbox fields. Sandbox details stay in
 * {@link SandboxConfigPanel}.
 */
export function IsolationConfigPanel(host: ViewHost, deps: IsolationConfigDeps): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const fe = createFieldEditor(host.interaction, host.active);
  const isolation = createMemo(() => {
    deps.settings.version();
    return deriveIsolation(deps.settings.effective());
  });

  async function applyIsolationChoice(value: IsolationChoice["value"]): Promise<void> {
    const confirmation = isolationConfirmation(value);
    if (confirmation && !(await host.confirm(confirmation))) return;
    try {
      const effective = await applyIsolation(value, deps.settings);
      if (isContainerIsolation(value)) deps.retryRuntime?.();
      deps.notify(
        `isolation: ${effective} (global)${deps.runActive() ? ` ${glyph("emDash")} applies to the next run` : ""}`,
      );
    } catch (error) {
      deps.notify(errorText(error));
    }
  }

  const spec = (): LevelSpec => ({
    nav: {
      count: () => 1,
      index: sel,
      setIndex: setSel,
      activate: {
        label: "change",
        run: () =>
          fe.startEnum("Isolation", ISOLATION_PICKER_CHOICES, isolation(), (value) =>
            detachObserved("isolation_config", () =>
              applyIsolationChoice(value as IsolationChoice["value"]),
            ),
          ),
      },
    },
    verbs: [{ key: "b", label: "sandbox details", run: () => deps.openSandbox() }],
  });
  bindLevelKeys({
    host,
    editor: fe,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const configuredIsolation = (): string => {
    const global = deps.settings.read("global");
    if (global?.runtime === undefined && global?.sandbox === undefined) return "product default";
    return deriveIsolation(global ?? {});
  };

  const body = (): JSX.Element => (
    <box flexDirection="column" width="100%" minWidth={0}>
      <StatusRow
        label="mutation"
        text={`Isolation saves globally ${glyph("separator")} workspace settings cannot choose a runtime`}
      />
      <SettingRow
        setting={{
          label: "Container runtime",
          configured: configuredIsolation(),
          effective: isolation(),
          source: "global",
          applies: "next run",
          mutation: "immediate",
        }}
        selected={sel() === 0}
        expanded
      />
      <For each={isolationPlacementLines(isolation())}>
        {(line) => (
          <text fg={tokens.muted} wrapMode="word">
            {glyph("bullet") + " " + line}
          </text>
        )}
      </For>
    </box>
  );

  return <LevelHost host={host} editor={fe} levels={[{ title: "Isolation", body }]} />;
}
