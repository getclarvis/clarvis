import { createSignal, type Accessor } from "solid-js";
import type { SettingsAdapter } from "./settings.ts";

/** The global memory choice, off until the user enables it. */
export type MemoryMode = "on" | "off";

/** The memory on/off choice exposed to the UI. */
export interface MemoryModeStore {
  mode: Accessor<MemoryMode>;
  setMode(mode: MemoryMode): void;
  cycle(): MemoryMode;
}

/** Build the global choice used by the Memory picker. */
export function createMemoryModeStore(initialMode: MemoryMode = "off"): MemoryModeStore {
  const [mode, setMode] = createSignal<MemoryMode>(initialMode);
  return {
    mode,
    setMode,
    cycle: () => {
      const next: MemoryMode = mode() === "on" ? "off" : "on";
      setMode(next);
      return next;
    },
  };
}

/** Save the global choice before applying it to subsequent runs. */
export async function saveMemoryMode(
  settings: SettingsAdapter,
  memory: MemoryModeStore,
  mode: MemoryMode,
): Promise<void> {
  await settings.write("global", {
    memory: {
      ...settings.read("global")?.memory,
      enabled: mode === "on",
    },
  });
  memory.setMode(mode);
}
