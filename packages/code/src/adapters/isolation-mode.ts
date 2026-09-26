import { createSignal, type Accessor } from "solid-js";
import type { IsolationSettings } from "@clarvis/protocol";
import type { SettingsAdapter } from "./settings.ts";

export type IsolationChoice = Required<Pick<IsolationSettings, "mode" | "workspace" | "network">>;

export interface IsolationModeStore {
  choice: Accessor<IsolationChoice>;
  setChoice(value: IsolationChoice): void;
}

/** Resolve omitted fields without erasing preferences while Host is selected. */
export function isolationChoice(value?: IsolationSettings): IsolationChoice {
  return {
    mode: value?.mode ?? "sandbox",
    workspace: value?.workspace ?? "read-write",
    network: value?.network ?? "disabled",
  };
}

export function createIsolationModeStore(initial: IsolationChoice): IsolationModeStore {
  const [choice, setChoice] = createSignal(initial);
  return { choice, setChoice };
}

/** Commit one global field through the connected kernel before updating the picker. */
export async function saveIsolationChoice(
  settings: SettingsAdapter,
  store: IsolationModeStore,
  patch: IsolationSettings,
): Promise<void> {
  await settings.write("global", {
    isolation: { ...settings.read("global")?.isolation, ...patch },
  });
  store.setChoice(isolationChoice(settings.read("global")?.isolation));
}
