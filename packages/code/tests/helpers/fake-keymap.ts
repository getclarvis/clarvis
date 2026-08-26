import type { KeyEvent, Renderable } from "@opentui/core";
import type { ActiveKey, Binding, Command, Keymap, Layer } from "@opentui/keymap";

type TestCommand = Command<Renderable, KeyEvent>;
type TestBinding = Binding<Renderable, KeyEvent>;
type TestLayer = Layer<Renderable, KeyEvent>;

interface RegisteredTestLayer {
  layer: TestLayer;
  order: number;
}

const commandAttrs = (command: TestCommand): Record<string, unknown> => ({
  uiTitle: command.uiTitle,
  uiDescription: command.uiDescription,
  uiCategory: command.uiCategory,
  uiSurfaces: command.uiSurfaces,
  footerLabel: command.footerLabel,
  hintPriority: command.hintPriority,
  hintGroup: command.hintGroup,
  essential: command.essential,
});

const isEnabled = (value: unknown): boolean => {
  if (value === undefined || value === true) return true;
  if (typeof value === "function") return value();
  if (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function"
  )
    return Boolean(value.get());
  return false;
};

/** The subset of a raw key-interceptor context the views under test actually read. */
type KeyInterceptor = (ctx: { event: KeyEvent; consume: () => void }) => void;

/**
 * Small named-command-aware keymap for focused renderer tests.
 *
 * Product code now binds keys to stable command ids. This fake deliberately models that resolution
 * and the active-key projection instead of teaching each view test about OpenTUI internals.
 */
export function createFakeKeymap(): {
  keymap: Keymap<Renderable, KeyEvent>;
  press: (this: void, key: string) => void;
  layers: TestLayer[];
} {
  const layers: RegisteredTestLayer[] = [];
  const exposedLayers: TestLayer[] = [];
  const stateListeners = new Set<() => void>();
  const interceptors = new Set<KeyInterceptor>();
  const data = new Map<string, unknown>();
  let order = 0;

  const layerActive = (layer: TestLayer): boolean => {
    if (!isEnabled(layer.enabled)) return false;
    if (typeof layer.when !== "string") return true;
    const match = /^([A-Za-z]\w*)==(.+)$/.exec(layer.when);
    return match !== null && data.get(match[1]!) === match[2];
  };

  const sortedLayers = (): RegisteredTestLayer[] =>
    [...layers]
      .filter(({ layer }) => layerActive(layer))
      .sort((a, b) => (b.layer.priority ?? 0) - (a.layer.priority ?? 0) || b.order - a.order);

  const resolve = (name: string): TestCommand | undefined => {
    for (const { layer } of sortedLayers()) {
      const command = (layer.commands ?? []).find(
        (candidate) => candidate.name === name && isEnabled(candidate.enabled),
      );
      if (command) return command;
    }
    return undefined;
  };

  const activeBindings = (): Array<{ binding: TestBinding; command?: TestCommand }> => {
    const seen = new Set<string>();
    const result: Array<{ binding: TestBinding; command?: TestCommand }> = [];
    for (const { layer } of sortedLayers()) {
      for (const binding of layer.bindings ?? []) {
        if (!isEnabled(binding.enabled) || typeof binding.key !== "string" || seen.has(binding.key))
          continue;
        const command = typeof binding.cmd === "string" ? resolve(binding.cmd) : undefined;
        if (typeof binding.cmd === "string" && !command) continue;
        seen.add(binding.key);
        result.push({ binding, command });
      }
    }
    return result;
  };

  const notify = (): void => {
    for (const listener of stateListeners) listener();
  };

  const fake = {
    setData(name: string, value: unknown) {
      data.set(name, value);
      notify();
    },
    getData(name: string) {
      return data.get(name);
    },
    registerLayer(layer: TestLayer) {
      const entry = { layer, order: order++ };
      layers.push(entry);
      exposedLayers.push(layer);
      notify();
      return () => {
        const index = layers.indexOf(entry);
        if (index >= 0) layers.splice(index, 1);
        const exposedIndex = exposedLayers.indexOf(layer);
        if (exposedIndex >= 0) exposedLayers.splice(exposedIndex, 1);
        notify();
      };
    },
    acquireResource(_key: symbol, setup: () => () => void) {
      return setup();
    },
    registerCommandFields() {
      return () => {};
    },
    getActiveKeys(): readonly ActiveKey<Renderable, KeyEvent>[] {
      return activeBindings().map(({ binding, command }) => ({
        stroke: { name: String(binding.key), ctrl: false, shift: false, meta: false, super: false },
        display: String(binding.key),
        command: binding.cmd,
        commandAttrs: command ? commandAttrs(command) : undefined,
        continues: false,
      }));
    },
    getCommands() {
      const seen = new Set<string>();
      const commands: TestCommand[] = [];
      for (const { layer } of sortedLayers()) {
        for (const command of layer.commands ?? []) {
          if (!isEnabled(command.enabled) || seen.has(command.name)) continue;
          seen.add(command.name);
          commands.push(command);
        }
      }
      return commands;
    },
    getCommandBindings(query: { commands: readonly string[] }) {
      const requested = new Set(query.commands);
      const result = new Map<string, Array<{ sequence: Array<{ display: string }> }>>();
      for (const { binding } of activeBindings()) {
        if (typeof binding.cmd !== "string" || !requested.has(binding.cmd)) continue;
        const sequences = result.get(binding.cmd) ?? [];
        sequences.push({
          sequence: String(binding.key)
            .trim()
            .split(/\s+/)
            .map((display) => ({ display })),
        });
        result.set(binding.cmd, sequences);
      }
      return result;
    },
    parseKeySequence(value: string) {
      if (value.trim() === "" || value.includes("++")) throw new Error("invalid key sequence");
      return value
        .trim()
        .split(/\s+/)
        .map((display) => ({ display }));
    },
    on(name: string, listener: () => void) {
      if (name === "state") stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    /**
     * Registers a raw key interceptor.
     *
     * @remarks Interceptors run ahead of binding resolution, so {@link press}
     *   offers each one the event first and stops if it consumes it. A view that
     *   owns raw input while mounted (the keyboard diagnostic) is otherwise
     *   untestable through this double: `intercept` merely being absent threw.
     */
    intercept(name: string, handler: KeyInterceptor) {
      if (name !== "key") return () => {};
      interceptors.add(handler);
      return () => interceptors.delete(handler);
    },
  } as unknown as Keymap<Renderable, KeyEvent>;

  const press: (this: void, key: string) => void = (key) => {
    let consumed = false;
    for (const handler of [...interceptors]) {
      handler({
        event: { name: key } as KeyEvent,
        consume: () => {
          consumed = true;
        },
      });
      if (consumed) return;
    }
    const match = activeBindings().find(({ binding }) => binding.key === key)?.binding;
    if (!match?.cmd) return;
    if (typeof match.cmd === "function") {
      void match.cmd({} as never);
      return;
    }
    void resolve(match.cmd)?.run({} as never);
  };

  return { keymap: fake, press, layers: exposedLayers };
}
