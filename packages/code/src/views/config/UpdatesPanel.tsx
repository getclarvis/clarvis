import type { JSX } from "solid-js";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { bindLevelKeys, LevelHost, ToggleRow } from "./view-host.tsx";

export interface UpdatesPanelDeps {
  code: Pick<CodeConfigStore, "updateCheckEnabled" | "writeUpdateCheckEnabled">;
  notify(message: string): void;
}

/** Global Code-owned preferences for release-version discovery. */
export function UpdatesPanel(host: ViewHost, deps: UpdatesPanelDeps): JSX.Element {
  const toggle = (): void => {
    const enabled = !deps.code.updateCheckEnabled();
    deps.code.writeUpdateCheckEnabled(enabled);
    deps.notify(`automatic version checks ${enabled ? "on" : "off"}`);
  };
  const spec = (): LevelSpec => ({
    nav: {
      count: () => 1,
      index: () => 0,
      setIndex: () => undefined,
      activate: { label: "toggle", run: toggle },
    },
  });

  bindLevelKeys({
    host,
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
  });

  const body = (): JSX.Element => (
    <box flexDirection="column">
      <ToggleRow
        label="Automatic checks"
        value={deps.code.updateCheckEnabled()}
        selected
        note="global across every workspace"
      />
      <text paddingTop={1}>Checks for a newer Clarvis version without installing it.</text>
    </box>
  );

  return <LevelHost host={host} levels={[{ title: "Updates", body }]} />;
}
