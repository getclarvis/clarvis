import { createSignal, type Accessor } from "solid-js";

/** The user-facing memory toggle: on (the default when configured) or off. */
export type MemoryMode = "on" | "off";

/** The memory on/off toggle exposed to the UI, independent of the settings source. */
export interface MemoryModeStore {
  /** Whether settings configure memory at all (block present, not disabled).
   * When false the toggle is inert: runs have no memory either way. */
  configured: Accessor<boolean>;
  mode: Accessor<MemoryMode>;
  setMode(mode: MemoryMode): void;
  cycle(): MemoryMode;
  /** Settings files are not reactive; call after a write that may have
   * created/removed the memory block so configured() consumers re-render. */
  refresh(): void;
}

/** Dependencies for {@link createMemoryModeStore}. */
export interface MemoryModeDeps {
  /** The settings `memory:` block (structural: only `enabled` matters here). */
  settingsMemory: () => { enabled?: boolean } | undefined;
}

/**
 * Build the {@link MemoryModeStore} the UI toggles: its `configured()` reads
 * the settings block reactively (via {@link MemoryModeStore.refresh}), while
 * `mode` is a local signal seeded from it and cycled independently by the user.
 *
 * @param deps - accessor for the current settings `memory:` block.
 */
export function createMemoryModeStore(deps: MemoryModeDeps): MemoryModeStore {
  const [version, setVersion] = createSignal(0);
  const configured = (): boolean => {
    version();
    const m = deps.settingsMemory();
    return m !== undefined && m.enabled !== false;
  };
  const initial = (): MemoryMode => (configured() ? "on" : "off");
  const [mode, setMode] = createSignal<MemoryMode>(initial());
  return {
    configured,
    mode,
    setMode,
    cycle: () => {
      const next: MemoryMode = mode() === "on" ? "off" : "on";
      setMode(next);
      return next;
    },
    refresh: () => setVersion((v) => v + 1),
  };
}
