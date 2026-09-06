import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { createSignal, type Accessor } from "solid-js";
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui";
import {
  registerBackspacePopsPendingSequence,
  registerDeadBindingWarnings,
  registerDefaultKeys,
  registerEnabledFields,
  registerEscapeClearsPendingSequence,
  registerMetadataFields,
  registerUnresolvedCommandWarnings,
} from "@opentui/keymap/addons";
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui";
import { Keymap, type Binding, type Command, type KeymapHost } from "@opentui/keymap";
import type { Platform } from "../adapters/platform.ts";
import { compactKey, LAYER } from "./keyspec.ts";
import { registerWhenField, type ContextKey } from "./when-dsl.ts";
import { registerUiActionFields } from "./actions.ts";
import {
  buildKeyboardEnvironment,
  keyboardEnvironmentId,
  resolveCommandBindings,
  type BindingCandidate,
  type KeyboardConfig,
  type KeyboardEnvironment,
  type KeyboardEnvironmentInput,
} from "./keyboard-profile.ts";
import { diagnosticCount } from "../core/diagnostic-events.ts";

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;
type OpenTuiCommand = Command<Renderable, KeyEvent>;
type OpenTuiBinding = Binding<Renderable, KeyEvent>;

/** Resolves every exact-versus-prefix ambiguity in favour of the exact action immediately. */
function registerImmediateExactDisambiguation(keymap: OpenTuiKeymap): () => void {
  return keymap.appendDisambiguationResolver((context) => context.runExact());
}

/** Which overlay (if any) is on top of the overlay stack, driving the keymap's `when` context. */
export type OverlayKind = "none" | "agentPicker" | "diff" | "plan" | (string & {});

/** Callbacks the built-in keymap commands dispatch into. */
export interface InteractionEffects {
  /** Suppresses every key except unmodified Escape while the workspace runtime is replaced. */
  interactionBlocked?(): boolean;
  cancelRun(): boolean;
  clearInputDraft(): void;
  quit(opts: { confirm: boolean }): void;
  dismissTopOverlay(): boolean;
  isRunActive(): boolean;
  isDraftNonEmpty(): boolean;
  hint(message: string): void;
  /**
   * Open the agent picker.
   *
   * @param onClose - run once when it closes; a caller that had to close its own
   *   screen first uses it to put the user back there.
   */
  openAgentPicker(onClose?: () => void): void;
  /** Open the isolation picker without changing command review. */
  openIsolationPicker(): void;
  /** Open the command-review picker without changing isolation. */
  openReviewPicker(): void;
  /** Move to the next focus target without activating it or changing transcript selection. */
  focusNext(): void;
  toggleExpandAll(): void;
  openDiff(): void;
  openPlan(): void;
  focusBlock(delta: number): void;
  clearBlockFocus(): boolean;
  scrollTranscript(rows: number): void;
  /** Reveals the older turns the transcript's render window is holding back. */
  loadEarlier(): void;
}

/** The keymap and overlay-stack handle the rest of `code` drives keybindings through. */
export interface Interaction {
  keymap: OpenTuiKeymap;
  renderer: CliRenderer;
  pushOverlayContext(kind: OverlayKind): void;
  popOverlayContext(): void;
  /** Restricts global bindings while an in-flow modal owns keyboard input. */
  setModalContext(kind: "none" | "elicitation"): void;
  keyboardEnvironment: Accessor<KeyboardEnvironment>;
  keyboardEnvironmentId: Accessor<string>;
  configureKeyboard(config: KeyboardConfig): void;
  dispose(): void;
}

/**
 * Binding candidates retain portable routes while capability-gating richer alternatives.
 *
 * @remarks A command whose every candidate is `minimumProfile: "enhanced"` has
 *   **no key at all** on the default `portable` profile — {@link
 *   resolveCommandBindings} returns an empty list and {@link
 *   resolvedVitalBindings} then omits the command. Such actions must retain an
 *   equivalent mouse, slash, hub, or other portable route.
 *   Modified arrows are portable (`CSI 1;5A` is plain xterm); Alt is the
 *   modifier terminals actually intercept, so `alt+…` is what gets gated.
 */
export const DEFAULT_BINDING_CANDIDATES: Readonly<Record<string, readonly BindingCandidate[]>> = {
  "run.cancel": [{ key: "ctrl+c" }],
  "app.escape": [{ key: "escape" }],
  "app.suspend": [{ key: "ctrl+z" }],
  "focus.next": [{ key: "tab" }],
  "agent.picker": [{ key: "shift+tab" }],
  "isolation.picker": [
    { key: "alt+s", minimumProfile: "enhanced", requires: ["meta"] },
    { key: "ctrl+s" },
  ],
  "review.picker": [
    { key: "alt+g", minimumProfile: "enhanced", requires: ["meta"] },
    { key: "ctrl+g" },
  ],
  "controls.open": [{ key: "alt+r", minimumProfile: "enhanced", requires: ["meta"] }],
  "plan.open": [
    { key: "ctrl+p" },
    { key: "alt+p", minimumProfile: "enhanced", requires: ["meta"] },
  ],
  "transcript.toggleCollapse": [{ key: "ctrl+o" }],
  "transcript.focusPrev": [{ key: "ctrl+up" }],
  "transcript.focusNext": [{ key: "ctrl+down" }],
  "transcript.scrollPageUp": [{ key: "pageup" }],
  "transcript.scrollPageDown": [{ key: "pagedown" }],
  "transcript.scrollLineUp": [{ key: "alt+up", minimumProfile: "enhanced", requires: ["meta"] }],
  "transcript.scrollLineDown": [
    { key: "alt+down", minimumProfile: "enhanced", requires: ["meta"] },
  ],
};

/** `when` clauses gating commands that must not fire while an overlay is open. */
export const DEFAULT_WHEN: Record<string, string> = {
  "focus.next": "overlay==none",
  "agent.picker": "overlay==none",
  "isolation.picker": "overlay==none",
  "review.picker": "overlay==none",
  "controls.open": "overlay==none",
  "plan.open": "overlay in (none, plan)",
  "transcript.scrollPageUp": "overlay==none",
  "transcript.scrollPageDown": "overlay==none",
  "transcript.scrollLineUp": "overlay==none",
  "transcript.scrollLineDown": "overlay==none",
  "transcript.toggleCollapse": "overlay==none",
  "transcript.focusPrev": "overlay==none",
  "transcript.focusNext": "overlay==none",
};

/**
 * Vital commands that keep working while an in-flow modal owns the screen.
 *
 * @remarks A pending elicitation sets `modal` to `"elicitation"`, and a binding
 *   carrying `modal: "none"` is then inactive. Withholding *every* vital
 *   binding took away the transcript scrolling a user needs to read what the
 *   agent is asking about, `ctrl+z`, and the only route for cancelling the run.
 *   Everything here is read-only navigation or an escape hatch; the
 *   commands that mutate state or open a destination stay withheld, because the
 *   modal's layer owns those keys and projects its own actions.
 */
const MODAL_LIVE_COMMANDS: ReadonlySet<string> = new Set([
  "run.cancel",
  "app.suspend",
  "transcript.scrollPageUp",
  "transcript.scrollPageDown",
  "transcript.scrollLineUp",
  "transcript.scrollLineDown",
]);

/**
 * Expands a command-to-key(s) table into individual {@link OpenTuiBinding}
 * entries, attaching each command's `when` clause (if any) from `defaultWhen`.
 *
 * @param defaults - command name to one or more key sequences.
 * @param defaultWhen - command name to its `when` clause, where gated.
 * @returns the flattened bindings, one per key sequence.
 * @remarks Commands in {@link MODAL_LIVE_COMMANDS} are left un-stamped, so they
 *   survive a pending modal; every other binding is restricted to `modal:
 *   "none"`.
 */
export function buildVitalBindings(
  defaults: Record<string, string | string[]>,
  defaultWhen: Record<string, string>,
): OpenTuiBinding[] {
  const out: OpenTuiBinding[] = [];
  for (const [cmd, value] of Object.entries(defaults)) {
    const keys = Array.isArray(value) ? value : [value];
    for (const key of keys) {
      const binding: OpenTuiBinding = { key, cmd };
      const when = defaultWhen[cmd];
      if (when) binding.when = when;
      if (!MODAL_LIVE_COMMANDS.has(cmd)) binding.modal = "none";
      out.push(binding);
    }
  }
  return out;
}

function keyboardInput(platform: Platform, keymap: OpenTuiKeymap): KeyboardEnvironmentInput {
  const capabilities = platform.capabilities;
  const runtimePlatform = capabilities?.runtimePlatform?.() ?? keymap.getHostMetadata().platform;
  return {
    remote: capabilities?.remote?.() ?? false,
    runtimePlatform,
    terminal: capabilities?.terminal?.() ?? { name: "unknown" },
    kittyKeyboard: capabilities?.keyboard?.() === "kitty",
    multiplexer: capabilities?.multiplexer?.() ?? "unknown",
    host: keymap.getHostMetadata(),
  };
}

/**
 * Resolves every vital command's key(s) for one environment.
 *
 * @param platformName - host platform; `app.suspend` is withheld on `win32`
 *   (no `SIGTSTP`, no job control to return from). The binding has to go with
 *   the command, or the keymap's own unresolved-command warning flags a binding
 *   to a command that was never registered and ctrl+z silently does nothing.
 * @param environment - the effective keyboard environment.
 * @param overrides - validated manual overrides, which win outright.
 * @returns command name to the key(s) it should be bound to; a command whose
 *   candidates all resolve away is absent.
 */
export function resolvedVitalBindings(
  platformName: NodeJS.Platform,
  environment: KeyboardEnvironment,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [commandName, candidates] of Object.entries(DEFAULT_BINDING_CANDIDATES)) {
    if (commandName === "app.suspend" && platformName === "win32") continue;
    const keys = resolveCommandBindings(commandName, candidates, environment, overrides);
    if (keys.length === 1) out[commandName] = keys[0]!;
    else if (keys.length > 1) out[commandName] = keys;
  }
  for (const [commandName, keys] of Object.entries(overrides)) {
    if (commandName in DEFAULT_BINDING_CANDIDATES || keys.length === 0) continue;
    out[commandName] = keys.length === 1 ? keys[0]! : [...keys];
  }
  return out;
}

const ACTION_PROJECTION: Readonly<Record<string, Record<string, unknown>>> = {
  "run.cancel": {
    uiSurfaces: ["footer", "full-help"],
    footerLabel: "cancel / quit",
    hintPriority: 90,
    hintGroup: "escape",
    essential: true,
  },
  "app.escape": {
    uiSurfaces: ["full-help"],
    footerLabel: "back / close",
    hintPriority: 80,
    hintGroup: "escape",
    essential: true,
  },
  "app.suspend": { uiSurfaces: ["full-help"] },
  "transcript.toggleCollapse": {
    uiSurfaces: ["footer", "full-help"],
    footerLabel: "expand",
    hintPriority: 50,
    hintGroup: "primary",
  },
  "transcript.focusPrev": {
    uiSurfaces: ["footer", "full-help"],
    footerLabel: "previous block",
    hintPriority: 35,
    hintGroup: "navigation",
  },
  "transcript.focusNext": {
    uiSurfaces: ["footer", "full-help"],
    footerLabel: "next block",
    hintPriority: 34,
    hintGroup: "navigation",
  },
  "transcript.scrollPageUp": {
    uiSurfaces: ["full-help"],
    hintGroup: "navigation",
  },
  "transcript.scrollPageDown": {
    uiSurfaces: ["full-help"],
    hintGroup: "navigation",
  },
  "transcript.scrollLineUp": {
    uiSurfaces: ["full-help"],
    hintGroup: "navigation",
  },
  "transcript.scrollLineDown": {
    uiSurfaces: ["full-help"],
    hintGroup: "navigation",
  },
};

function command(
  name: string,
  run: OpenTuiCommand["run"],
  meta: Record<string, unknown> = {},
): OpenTuiCommand {
  const merged = { ...(ACTION_PROJECTION[name] ?? {}), ...meta };
  return {
    name,
    run,
    ...merged,
    uiTitle: typeof merged.title === "string" ? merged.title : name,
    uiDescription:
      typeof merged.desc === "string"
        ? merged.desc
        : typeof merged.title === "string"
          ? merged.title
          : name,
    uiCategory: typeof merged.category === "string" ? merged.category : "Other",
  };
}

/**
 * Build the default OpenTUI keymap with input delivery bounded by the renderer lifecycle.
 *
 * @remarks OpenTUI removes its global listeners when the renderer emits `destroy`, but the
 *   key handler can already hold a snapshot of those listeners while native input is draining.
 *   Such a callback observes `host.isDestroyed` and the keymap rejects it. Guarding at the host
 *   boundary keeps residual press, release, and raw-input callbacks from entering a dead keymap.
 */
function createLifecycleSafeKeymap(renderer: CliRenderer): OpenTuiKeymap {
  const base = createOpenTuiKeymapHost(renderer);
  const host: KeymapHost<Renderable, KeyEvent> = {
    get metadata() {
      return base.metadata;
    },
    rootTarget: base.rootTarget,
    get isDestroyed() {
      return base.isDestroyed;
    },
    getFocusedTarget: () => base.getFocusedTarget(),
    getParentTarget: (target) => base.getParentTarget(target),
    isTargetDestroyed: (target) => base.isTargetDestroyed(target),
    onKeyPress: (listener) =>
      base.onKeyPress((event) => {
        if (!base.isDestroyed) listener(event);
      }),
    onKeyRelease: (listener) =>
      base.onKeyRelease((event) => {
        if (!base.isDestroyed) listener(event);
      }),
    onFocusChange: (listener) => base.onFocusChange(listener),
    onTargetDestroy: (target, listener) => base.onTargetDestroy(target, listener),
    createCommandEvent: () => base.createCommandEvent(),
    ...(base.onDestroy === undefined
      ? {}
      : { onDestroy: (listener: () => void) => base.onDestroy!(listener) }),
    ...(base.onRawInput === undefined
      ? {}
      : {
          onRawInput: (listener: (sequence: string) => boolean) =>
            base.onRawInput!((sequence) => !base.isDestroyed && listener(sequence)),
        }),
  };
  const keymap = new Keymap(host);
  registerDefaultKeys(keymap);
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  return keymap;
}

/**
 * Wire the OpenTUI keymap, register its command set, and return the
 * {@link Interaction} handle the rest of `code` drives it through.
 *
 * @param renderer - the active OpenTUI renderer.
 * @param platform - the platform adapter (suspend/resume, shutdown).
 * @param effects - the command callbacks this wiring dispatches into.
 * @returns the {@link Interaction} handle.
 * @remarks `app.suspend` is registered only off Windows, which has no
 *   `SIGTSTP` and no job control to return from - offering it there would be a
 *   menu entry that silently does nothing.
 */
export function createInteraction(
  renderer: CliRenderer,
  platform: Platform,
  effects: InteractionEffects,
  initialKeyboardConfig: KeyboardConfig = { version: 1, environments: {} },
): Interaction {
  const keymap = createLifecycleSafeKeymap(renderer);
  /**
   * A terminal may deliver repeat packets while Ctrl+C is held. When a window
   * is open, keep repeats from turning one cancellation gesture into a later
   * quit after the run settles. Escape is deliberately excluded: every press
   * must clear input or navigate back immediately, with no repeat grace.
   */
  const CLOSE_REPEAT_GRACE_MS = 1_000;
  let closingGesture: { signature: string; until: number } | null = null;
  const keySignature = (event: KeyEvent): string =>
    `${event.ctrl ? "c" : ""}${event.meta ? "m" : ""}${event.shift ? "s" : ""}:${event.name ?? ""}`;
  const keyLabel = (event: KeyEvent): string =>
    compactKey(
      [
        event.ctrl ? "ctrl" : "",
        event.meta ? "alt" : "",
        event.shift ? "shift" : "",
        event.name ?? "",
      ]
        .filter(Boolean)
        .join("+"),
    );
  const isRunCancelKey = (event: KeyEvent): boolean => {
    const label = keyLabel(event);
    const bindings = keymap
      .getCommandBindings({ commands: ["run.cancel"], visibility: "registered" })
      .get("run.cancel");
    return (
      bindings?.some(
        (binding) =>
          binding.sequence.length === 1 && compactKey(binding.sequence[0]!.display) === label,
      ) ?? false
    );
  };
  const trackWindowPress = (ctx: {
    event: KeyEvent;
    consume(options?: { preventDefault?: boolean; stopPropagation?: boolean }): void;
  }): void => {
    const now = performance.now();
    const signature = keySignature(ctx.event);
    const isCloseKey = isRunCancelKey(ctx.event);
    const windowOwnsKey = overlayStack.length > 0 || keymap.getData("modal") !== "none";
    if (closingGesture) {
      const sameGesture = signature === closingGesture.signature;
      if (sameGesture && ctx.event.repeated === true && now <= closingGesture.until) {
        closingGesture.until = now + CLOSE_REPEAT_GRACE_MS;
        ctx.consume({ preventDefault: true, stopPropagation: true });
        return;
      }
      closingGesture = null;
    }
    if (isCloseKey && windowOwnsKey)
      closingGesture = { signature, until: now + CLOSE_REPEAT_GRACE_MS };
  };
  const releaseWindowGesture = (ctx: { event: KeyEvent }): void => {
    if (closingGesture?.signature === keySignature(ctx.event)) closingGesture = null;
  };
  const offWindowPress = keymap.intercept("key", trackWindowPress, {
    priority: Number.MAX_SAFE_INTEGER - 1,
  });
  const offWindowRelease = keymap.intercept("key", releaseWindowGesture, {
    priority: Number.MAX_SAFE_INTEGER - 1,
    release: true,
  });
  /**
   * Keep parser edge cases out of OpenTUI's strict event matcher.
   *
   * Some terminal paths emit a key-release record with an empty `name` after
   * Escape has already closed a view (observed after returning from a workflow
   * agent result). OpenTUI accepts the event from its parser, then its default
   * keymap resolver throws while normalizing that empty name. A literal Escape
   * press is recoverable from its wire value; every other unnamed event is
   * non-actionable and must be consumed before binding resolution. Register for
   * both phases because the observed residue is a release, not a press.
   */
  const guardUnnamedKey = (ctx: {
    event: KeyEvent;
    consume(options?: { preventDefault?: boolean; stopPropagation?: boolean }): void;
  }): void => {
    if (typeof ctx.event.name === "string" && ctx.event.name.trim().length > 0) return;
    const wire = ctx.event.raw || ctx.event.sequence;
    const recovered = wire === "\u001b" || wire === "\u001b\u001b";
    diagnosticCount("keyboard.event.unnamed", {
      source: ctx.event.source ?? "unknown",
      eventType: ctx.event.eventType ?? "unknown",
      recovered: recovered ? "escape" : "discarded",
    });
    if (recovered) {
      ctx.event.name = "escape";
      return;
    }
    ctx.consume({ preventDefault: true, stopPropagation: true });
  };
  const offUnnamedKeyPress = keymap.intercept("key", guardUnnamedKey, {
    priority: Number.MAX_SAFE_INTEGER,
  });
  const offUnnamedKeyRelease = keymap.intercept("key", guardUnnamedKey, {
    priority: Number.MAX_SAFE_INTEGER,
    release: true,
  });
  const offDispatchDiagnostic = keymap.on("dispatch", (event) => {
    if (event.phase !== "binding-execute" && event.phase !== "binding-reject") return;
    const name = typeof event.command === "string" ? event.command : "inline-handler";
    diagnosticCount(
      "command.dispatch",
      { name, outcome: event.phase === "binding-execute" ? "execute" : "reject" },
      `command.dispatch.${name}.${event.phase}`,
    );
  });
  const addonDisposers = [
    registerImmediateExactDisambiguation(keymap),
    // Clarvis does not expose pending key sequences as a visible mode. Let one
    // Escape clear a half-entered sequence and continue to the active Back /
    // Close command; consuming it here made the UI appear to ignore the first
    // keypress (and a quick second press could clear another deferred event).
    registerEscapeClearsPendingSequence(keymap, { preventDefault: false }),
    registerBackspacePopsPendingSequence(keymap),
    registerBaseLayoutFallback(keymap),
    registerDeadBindingWarnings(keymap),
  ];
  const offInteractionBlocker = keymap.intercept(
    "key",
    (ctx) => {
      const event = ctx.event;
      const plainEscape =
        event.name === "escape" &&
        !event.ctrl &&
        !event.shift &&
        !event.meta &&
        !event.option &&
        !event.super &&
        !event.hyper;
      if (effects.interactionBlocked?.() === true && !plainEscape) {
        ctx.consume({ preventDefault: true, stopPropagation: true });
      }
    },
    { priority: Number.MAX_SAFE_INTEGER },
  );
  const offWhenField = registerWhenField(keymap);
  const offUiFields = registerUiActionFields(keymap);
  const offModalField = keymap.registerBindingFields({
    modal(value, ctx) {
      if (value !== "none") throw new Error('modal must be the string "none"');
      ctx.require("modal", value);
    },
  });

  const firstInput = keyboardInput(platform, keymap);
  const firstEnvironmentId = keyboardEnvironmentId(firstInput);
  const [environmentId, setEnvironmentId] = createSignal(firstEnvironmentId);
  const [keyboardEnvironment, setKeyboardEnvironment] = createSignal(
    buildKeyboardEnvironment(firstInput, initialKeyboardConfig.environments[firstEnvironmentId]),
  );

  const defaults: Record<ContextKey, unknown> = {
    overlay: "none",
    autocomplete: false,
  };
  for (const [k, v] of Object.entries(defaults)) keymap.setData(k, v);
  keymap.setData("modal", "none");

  const overlayStack: OverlayKind[] = [];
  function setOverlayData(): void {
    keymap.setData("overlay", overlayStack[overlayStack.length - 1] ?? "none");
  }

  const commands: OpenTuiCommand[] = [
    command(
      "run.cancel",
      () => {
        if (effects.cancelRun()) return;
        effects.quit({ confirm: true });
      },
      {
        title: "Cancel run",
        desc: "Cancel the active run or quit",
        category: "run",
        protected: true,
      },
    ),
    command(
      "app.escape",
      () => {
        if (effects.dismissTopOverlay()) return;
        if (effects.clearBlockFocus()) return;
        if (effects.isDraftNonEmpty()) {
          effects.clearInputDraft();
          effects.hint("Draft cleared");
        }
      },
      {
        title: "Escape",
        desc: "Return to the previous screen or clear the current draft",
        category: "app",
        protected: true,
      },
    ),
    ...(process.platform === "win32"
      ? []
      : [
          command(
            "app.suspend",
            () => {
              platform.suspend();
              try {
                process.kill(process.pid, "SIGTSTP");
              } catch {}
            },
            { title: "Suspend", desc: "Suspend to the shell (fg to return)", category: "app" },
          ),
        ]),
    command("focus.next", () => effects.focusNext(), {
      title: "Next focus target",
      desc: "Move focus without activating content or changing transcript selection",
      category: "navigation",
    }),
    command("transcript.toggleCollapse", () => effects.toggleExpandAll(), {
      title: "Expand / collapse blocks",
      desc: "Toggle the focused block, else all collapsible blocks",
      category: "view",
    }),
    command("transcript.focusPrev", () => effects.focusBlock(-1), {
      title: "Focus previous block",
      desc: "Move the block cursor to the previous block",
      category: "view",
    }),
    command("transcript.focusNext", () => effects.focusBlock(1), {
      title: "Focus next block",
      desc: "Move the block cursor to the next block",
      category: "view",
    }),
    command("transcript.scrollPageUp", () => effects.scrollTranscript(-12), {
      title: "Scroll up a page",
      desc: "Scroll the transcript up one page",
      category: "view",
    }),
    command("transcript.scrollPageDown", () => effects.scrollTranscript(12), {
      title: "Scroll down a page",
      desc: "Scroll the transcript down one page",
      category: "view",
    }),
    command("transcript.scrollLineUp", () => effects.scrollTranscript(-3), {
      title: "Scroll up",
      desc: "Scroll the transcript up a few lines",
      category: "view",
    }),
    command("transcript.scrollLineDown", () => effects.scrollTranscript(3), {
      title: "Scroll down",
      desc: "Scroll the transcript down a few lines",
      category: "view",
    }),
    command("transcript.loadEarlier", () => effects.loadEarlier(), {
      title: "Load earlier turns",
      desc: "Reveal the older turns the transcript window is holding back",
      category: "view",
    }),
  ];
  const offCommands = keymap.registerLayer({ commands });

  let offVital: (() => void) | undefined;
  function configureKeyboard(config: KeyboardConfig): void {
    const input = keyboardInput(platform, keymap);
    const id = keyboardEnvironmentId(input);
    const saved = config.environments[id];
    const environment = buildKeyboardEnvironment(input, saved);
    const validOverrides: Record<string, string[]> = {};
    const registeredCommands = new Set(
      keymap.getCommands({ visibility: "registered" }).map((registered) => registered.name),
    );
    for (const [commandName, keys] of Object.entries(
      environment.profile === "manual" ? (saved?.bindings ?? {}) : {},
    )) {
      if (
        (!(commandName in DEFAULT_BINDING_CANDIDATES) && !registeredCommands.has(commandName)) ||
        keys.length === 0
      )
        continue;
      try {
        for (const key of keys) keymap.parseKeySequence(key);
        validOverrides[commandName] = keys;
      } catch {
        // Invalid manual data stays visible in Keyboard settings, but never activates.
      }
    }
    const vital = buildVitalBindings(
      resolvedVitalBindings(process.platform, environment, validOverrides),
      DEFAULT_WHEN,
    );
    offVital?.();
    offVital = keymap.registerLayer({ priority: LAYER.VITAL, bindings: vital });
    setEnvironmentId(id);
    setKeyboardEnvironment(environment);
    keymap.setData("keyboard.profile", environment.profile);
    keymap.setData("keyboard.environment", id);
  }
  configureKeyboard(initialKeyboardConfig);

  const onContinue = (): void => platform.resume();
  process.on("SIGCONT", onContinue);
  let disposed = false;
  let offUnresolvedWarnings: (() => void) | undefined;
  // The app composes feature commands immediately after this base interaction
  // is returned. Defer the analyzer by one microtask so valid cross-feature
  // bindings are assessed against the complete command registry.
  queueMicrotask(() => {
    if (!disposed) offUnresolvedWarnings = registerUnresolvedCommandWarnings(keymap);
  });
  /** Release interaction registrations, tolerating a renderer-owned keymap teardown. */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      renderer.off("destroy", dispose);
    } catch {}
    process.off("SIGCONT", onContinue);
    const disposers = [
      offVital,
      offCommands,
      offWindowRelease,
      offWindowPress,
      offInteractionBlocker,
      offUnnamedKeyRelease,
      offUnnamedKeyPress,
      offModalField,
      offUiFields,
      offWhenField,
      offUnresolvedWarnings,
      offDispatchDiagnostic,
      ...addonDisposers.reverse(),
    ];
    for (const off of disposers) {
      try {
        off?.();
      } catch {
        /* The keymap host may already have been destroyed by the renderer. */
      }
    }
  }
  renderer.once("destroy", dispose);

  function pushOverlayContext(kind: OverlayKind): void {
    overlayStack.push(kind);
    setOverlayData();
  }
  function popOverlayContext(): void {
    overlayStack.pop();
    setOverlayData();
  }

  const interaction: Interaction = {
    keymap,
    renderer,
    pushOverlayContext,
    popOverlayContext,
    setModalContext: (kind) => keymap.setData("modal", kind),
    keyboardEnvironment,
    keyboardEnvironmentId: environmentId,
    configureKeyboard,
    dispose,
  };
  return interaction;
}
