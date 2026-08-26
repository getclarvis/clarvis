import type { JSX } from "solid-js";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type { ViewHost } from "../../keys/commands.ts";
import {
  applyManualBindingEdit,
  type CapabilityState,
  type ClientPlatform,
  type KeyboardEnvironmentConfig,
  type KeyboardProfile,
} from "../../keys/keyboard-profile.ts";
import { uiCommand } from "../../keys/actions.ts";
import { LAYER } from "../../keys/keyspec.ts";
import { tokens } from "../../theme/tokens.ts";
import { glyph } from "../../theme/glyphs.ts";
import { SelectableRow } from "../../ui/primitives/selectable-row.tsx";
import { bindLevelKeys } from "../../ui/patterns/bind-level-keys.ts";
import { registerLevel, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import { ViewFrame } from "../../ui/patterns/view-frame.tsx";
import { createFieldEditor } from "./field-editor.tsx";
import { commandKeyLabel } from "../../keys/keyspec.ts";
import { SelectableList } from "../../ui/patterns/selectable-list.tsx";
import { padColumn } from "../truncate.ts";

const PROFILES: { id: KeyboardProfile; label: string; desc: string }[] = [
  { id: "portable", label: "Portable", desc: "safe defaults for SSH and legacy terminals" },
  {
    id: "enhanced",
    label: "Enhanced",
    desc: "adds verified Alt, Cmd and modified-arrow accelerators",
  },
  { id: "manual", label: "Manual", desc: "uses named-command overrides from this environment" },
];

function normalizedEvent(event: KeyEvent): string {
  const modifiers = [
    event.ctrl ? "Ctrl" : "",
    event.shift ? "Shift" : "",
    event.meta || event.option ? "Alt/Option" : "",
    event.super ? "Super/Cmd" : "",
    event.hyper ? "Hyper" : "",
  ].filter(Boolean);
  return [...modifiers, event.name].join("+");
}

interface Probe {
  label: string;
  verdict: "ctrl" | "meta" | "super" | "baseLayout";
  match(event: KeyEvent): boolean;
}

const PROBES: Probe[] = [
  { label: "Ctrl+K", verdict: "ctrl", match: (event) => event.ctrl && event.name === "k" },
  {
    label: "Alt/Option+K",
    verdict: "meta",
    match: (event) => (event.meta || event.option) && event.name === "k",
  },
  {
    label: "Super/Cmd+K",
    verdict: "super",
    match: (event) => event.super === true && event.name === "k",
  },
  {
    label: "layout-stable K",
    verdict: "baseLayout",
    match: (event) => event.name === "k" && event.baseCode !== undefined,
  },
];

/** Explicit, normalized-event-only diagnostic; raw sequences and typed text are never retained. */
function KeyboardDiagnostic(props: {
  host: ViewHost;
  code: CodeConfigStore;
  onClose(): void;
  notify(message: string): void;
}): JSX.Element {
  const [step, setStep] = createSignal(0);
  const [received, setReceived] = createSignal("");
  const [verdicts, setVerdicts] = createSignal<Partial<Record<Probe["verdict"], CapabilityState>>>(
    {},
  );
  const done = createMemo(() => step() >= PROBES.length);
  const current = (): Probe | undefined => PROBES[step()];

  const record = (state: CapabilityState): void => {
    const probe = current();
    if (!probe) return;
    setVerdicts((value) => ({ ...value, [probe.verdict]: state }));
    setReceived("");
    setStep((value) => value + 1);
  };

  /**
   * Persists the capability verdicts, and the recommended profile only when the
   * user has not chosen `manual`.
   *
   * @remarks `configureKeyboard` activates the `bindings` map **only** while the
   *   stored profile is `manual`, so overwriting an explicit `manual` with a
   *   recommendation switched every override the user authored off while leaving
   *   the now-dead map on disk — and the binding list went on showing them as
   *   active. The verdicts are always worth keeping: they are measurements, not
   *   a preference, and they are what an `enhanced` candidate is checked
   *   against.
   */
  const save = (): void => {
    const environment = props.host.interaction.keyboardEnvironment();
    const recommendation: KeyboardProfile = Object.values(verdicts()).some(
      (state) => state === "unsupported",
    )
      ? "portable"
      : environment.protocol === "kitty"
        ? "enhanced"
        : "portable";
    const currentConfig =
      props.code.keyboardConfig().environments[props.host.interaction.keyboardEnvironmentId()];
    const keepsManual = currentConfig?.profile === "manual";
    props.code.writeKeyboardEnvironment(props.host.interaction.keyboardEnvironmentId(), {
      ...(currentConfig ?? { profile: recommendation }),
      profile: keepsManual ? "manual" : recommendation,
      verdicts: { ...(currentConfig?.verdicts ?? {}), ...verdicts() },
    });
    props.notify(
      keepsManual
        ? `keyboard diagnostic saved ${glyph("emDash")} manual bindings kept (recommended: ${recommendation})`
        : `keyboard diagnostic saved: ${recommendation}`,
    );
    props.onClose();
  };

  let offLayer: (() => void) | undefined;
  let offProbe: (() => void) | undefined;
  onMount(() => {
    offLayer = props.host.interaction.keymap.registerLayer({
      enabled: reactiveMatcherFromSignal(props.host.active),
      priority: LAYER.CONFIRM + 10,
      commands: [
        uiCommand({
          id: "keyboard.diagnostic.unavailable",
          title: "Mark unavailable",
          description: "Mark the requested key as intercepted or unavailable",
          category: "mutation",
          surfaces: ["footer"],
          footerLabel: "not received",
          hintPriority: 70,
          hintGroup: "mutation",
          enabled: () => !done(),
          run: () => record("unsupported"),
        }),
        uiCommand({
          id: "keyboard.diagnostic.save",
          title: "Save diagnostic",
          description: "Save only capability verdicts and the recommended profile",
          category: "primary",
          surfaces: ["footer"],
          footerLabel: "save",
          hintPriority: 90,
          hintGroup: "primary",
          enabled: done,
          run: save,
        }),
        uiCommand({
          id: "keyboard.diagnostic.close",
          title: "Close diagnostic",
          description: "Discard this diagnostic run",
          category: "escape",
          surfaces: ["footer"],
          footerLabel: "close",
          hintPriority: 40,
          hintGroup: "escape",
          run: () => props.onClose(),
        }),
      ],
      bindings: [
        { key: "u", cmd: "keyboard.diagnostic.unavailable" },
        { key: "s", cmd: "keyboard.diagnostic.save" },
        { key: "escape", cmd: "keyboard.diagnostic.close" },
      ],
    });
    offProbe = props.host.interaction.keymap.intercept(
      "key",
      (ctx) => {
        if (!props.host.active()) return;
        const probe = current();
        if (
          !probe ||
          ctx.event.name === "u" ||
          ctx.event.name === "s" ||
          ctx.event.name === "escape"
        )
          return;
        setReceived(normalizedEvent(ctx.event));
        // The diagnostic owns input while mounted. An unexpected normalized
        // event is useful evidence here, but must not also open a destination
        // or mutate the screen underneath it.
        ctx.consume();
        if (probe.match(ctx.event)) {
          record("supported");
        }
      },
      { priority: LAYER.CONFIRM + 20 },
    );
  });
  onCleanup(() => {
    offProbe?.();
    offLayer?.();
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={tokens.accent}>Keyboard diagnostic</text>
      <text fg={tokens.muted} paddingTop={1}>
        Normalized events are shown only here. Raw sequences and typed text are never saved.
      </text>
      <Show
        when={!done()}
        fallback={
          <box flexDirection="column" paddingTop={1}>
            <text fg={tokens.fg}>Diagnostic complete.</text>
            <text fg={tokens.muted}>Save the recommendation, or close to discard it.</text>
          </box>
        }
      >
        <text fg={tokens.fg} paddingTop={1}>{`Press ${current()!.label}`}</text>
        <text fg={tokens.muted}>If the terminal intercepts it, mark this probe unavailable.</text>
        <Show when={received()}>
          <text fg={tokens.warn}>{`Received instead: ${received()}`}</text>
        </Show>
      </Show>
      <box flexDirection="column" paddingTop={1}>
        <For each={PROBES}>
          {(probe, index) => (
            <text fg={index() === step() ? tokens.accent2 : tokens.muted}>
              {`${verdicts()[probe.verdict] === "supported" ? glyph("success") : verdicts()[probe.verdict] === "unsupported" ? glyph("error") : glyph("pending")} ${probe.label}`}
            </text>
          )}
        </For>
      </box>
    </box>
  );
}

/** Global UI-local keyboard profile and diagnostic screen. */
export function KeyboardView(
  host: ViewHost,
  deps: { code: CodeConfigStore; notify(message: string): void; startDiagnostic?: boolean },
): JSX.Element {
  const environment = host.interaction.keyboardEnvironment;
  const recommendedProfile = (): KeyboardProfile =>
    environment().transport === "local" && environment().protocol === "kitty"
      ? "enhanced"
      : "portable";
  const profileState = (profile: KeyboardProfile): string => {
    if (profile === environment().profile) return "Active";
    if (profile === recommendedProfile()) return "Recommended";
    if (profile !== "enhanced") return "Available";
    if (Object.values(environment().modifiers).some((value) => value === "unsupported"))
      return "Unavailable: modified keys are intercepted";
    if (environment().protocol === "legacy") return "Run diagnostic to verify modified keys";
    return "Available";
  };
  const [selected, setSelected] = createSignal(
    Math.max(
      0,
      PROFILES.findIndex((profile) => profile.id === environment().profile),
    ),
  );
  const [diagnostic, setDiagnostic] = createSignal(deps.startDiagnostic ?? false);
  const [bindingMode, setBindingMode] = createSignal(false);
  const [bindingIndex, setBindingIndex] = createSignal(0);
  const editor = createFieldEditor(host.interaction, host.active);
  const stableCommands = createMemo(() =>
    host.interaction.keymap
      .getCommands({ visibility: "registered" })
      .filter((command) => {
        const surfaces = Array.isArray(command.uiSurfaces) ? command.uiSurfaces : [];
        return (
          surfaces.some((surface) => surface === "full-help") &&
          !/^(ui\.|confirm\.|editor\.|autocomplete\.|elicit\.)/.test(command.name)
        );
      })
      .sort((a, b) => {
        const aTitle = typeof a.title === "string" ? a.title : a.name;
        const bTitle = typeof b.title === "string" ? b.title : b.name;
        return aTitle.localeCompare(bTitle);
      }),
  );

  /**
   * Whether stored manual overrides are the ones the keymap is actually running.
   *
   * @remarks `configureKeyboard` applies the `bindings` map only under the
   *   `manual` profile, so a stored override is dead weight under any other one.
   *   The binding list reads this rather than the presence of a stored entry:
   *   colouring a dead override as active is how a user came to believe bindings
   *   were in force that nothing had installed.
   */
  const overridesActive = createMemo(() => environment().profile === "manual");
  const storedOverrideCount = createMemo(() => {
    const id = host.interaction.keyboardEnvironmentId();
    return Object.keys(deps.code.keyboardConfig().environments[id]?.bindings ?? {}).length;
  });

  const saveProfile = (): void => {
    const profile = PROFILES[selected()]!.id;
    const id = host.interaction.keyboardEnvironmentId();
    const current = deps.code.keyboardConfig().environments[id];
    deps.code.writeKeyboardEnvironment(id, { ...(current ?? {}), profile });
    deps.notify(`keyboard profile: ${profile}`);
  };

  const cycleClient = (): void => {
    const choices: (ClientPlatform | undefined)[] = [undefined, "macos", "windows", "linux"];
    const id = host.interaction.keyboardEnvironmentId();
    const current = deps.code.keyboardConfig().environments[id] ?? {
      profile: environment().profile,
    };
    const index = choices.indexOf(current.clientPlatform);
    const next = choices[(index + 1) % choices.length];
    const updated: KeyboardEnvironmentConfig = { ...current };
    if (next) updated.clientPlatform = next;
    else delete updated.clientPlatform;
    deps.code.writeKeyboardEnvironment(id, updated);
  };

  const reset = (): void => {
    deps.code.writeKeyboardEnvironment(host.interaction.keyboardEnvironmentId(), undefined);
    deps.notify("keyboard profile reset to automatic");
  };

  const openBindings = (): void => {
    setBindingMode(true);
    setBindingIndex(0);
    host.level.push("Manual bindings");
  };

  const closeBindings = (): void => {
    setBindingMode(false);
    host.level.pop();
  };

  /** Edits one command's manual override; the fold and its rules are {@link applyManualBindingEdit}'s. */
  const editBinding = (): void => {
    const command =
      stableCommands()[Math.max(0, Math.min(bindingIndex(), stableCommands().length - 1))];
    if (!command) return;
    const id = host.interaction.keyboardEnvironmentId();
    const saved = deps.code.keyboardConfig().environments[id];
    const current = saved?.bindings?.[command.name]?.join(", ") ?? "";
    editor.start("bindings", current, (value) => {
      const keys = value
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);
      const invalidKeys = keys.filter((key) => {
        try {
          host.interaction.keymap.parseKeySequence(key);
          return false;
        } catch {
          return true;
        }
      });
      const result = applyManualBindingEdit({
        saved,
        command: command.name,
        keys,
        knownCommands: new Set(stableCommands().map((item) => item.name)),
        invalidKeys,
        normalizeKey: (key) =>
          host.interaction.keymap
            .parseKeySequence(key)
            .map((part) => part.display)
            .join(" ")
            .toLowerCase(),
      });
      if (result.issues) {
        deps.notify(`${result.issues[0]!.command}: ${result.issues[0]!.message}`);
        return;
      }
      deps.code.writeKeyboardEnvironment(id, result.config);
      deps.notify(`${command.name}: ${keys.length > 0 ? keys.join(" / ") : "default binding"}`);
    });
  };

  const spec = (): LevelSpec =>
    bindingMode()
      ? {
          nav: {
            count: () => stableCommands().length,
            index: bindingIndex,
            setIndex: setBindingIndex,
            showArrows: true,
            activate: { label: "edit binding", run: editBinding },
          },
          escape: { label: "back", run: closeBindings },
        }
      : {
          nav: {
            count: () => PROFILES.length,
            index: selected,
            setIndex: setSelected,
            showArrows: true,
            activate: { label: "use profile", run: saveProfile },
          },
          verbs: [
            {
              id: "keyboard.bindings.open",
              key: "b",
              label: "manual bindings",
              run: openBindings,
            },
            {
              id: "keyboard.diagnostic.start",
              key: "d",
              label: "diagnostic",
              run: () => setDiagnostic(true),
            },
            {
              id: "keyboard.client.cycle",
              key: "c",
              label: "client convention",
              run: cycleClient,
            },
            {
              id: "keyboard.profile.reset",
              key: "x",
              label: "reset automatic",
              run: reset,
            },
          ],
          escape: { label: "close", run: () => host.close() },
        };
  bindLevelKeys({
    register: (enabled) => registerLevel(host.interaction.keymap, { ...spec(), enabled }),
    editor,
    suspend: () => {
      bindingMode();
      return diagnostic();
    },
  });

  return (
    <ViewFrame
      host={host}
      title="Keyboard"
      purpose="UI-local keyboard compatibility"
      mutationContract="Use profile changes this terminal environment immediately"
    >
      <Show
        when={!diagnostic()}
        fallback={
          <KeyboardDiagnostic
            host={host}
            code={deps.code}
            notify={(message) => deps.notify(message)}
            onClose={() => setDiagnostic(false)}
          />
        }
      >
        <box flexDirection="column" flexGrow={1}>
          <Show when={editor.editing()}>{editor.EditInput()}</Show>
          {editor.PickerInput()}
          <Show
            when={!bindingMode()}
            fallback={
              <box flexDirection="column" flexGrow={1}>
                <Show when={!overridesActive() && storedOverrideCount() > 0}>
                  <text fg={tokens.warn}>
                    {`${glyph("warning")} ${storedOverrideCount()} override${storedOverrideCount() === 1 ? "" : "s"} stored but inactive ${glyph("emDash")} they apply only under the Manual profile.`}
                  </text>
                </Show>
                <SelectableList
                  each={stableCommands}
                  sel={bindingIndex}
                  idPrefix="keyboard-command-"
                  row={(command, index) => {
                    const id = host.interaction.keyboardEnvironmentId();
                    const override =
                      deps.code.keyboardConfig().environments[id]?.bindings?.[command.name];
                    const active = override !== undefined && overridesActive();
                    const key =
                      commandKeyLabel(host.interaction.keymap, command.name, {
                        visibility: "registered",
                      }) ?? "no shortcut";
                    return (
                      <SelectableRow selected={index() === bindingIndex()}>
                        <span style={{ fg: tokens.fg }}>
                          {padColumn(
                            typeof command.title === "string" ? command.title : command.name,
                            26,
                          )}
                        </span>
                        <span style={{ fg: active ? tokens.accent2 : tokens.muted }}>{key}</span>
                        <Show when={override !== undefined && !overridesActive()}>
                          <span style={{ fg: tokens.warn }}>
                            {`  ${override!.join(" / ")} (off)`}
                          </span>
                        </Show>
                      </SelectableRow>
                    );
                  }}
                  empty={() => ({ text: "no stable actions registered" })}
                />
              </box>
            }
          >
            <text fg={tokens.muted}>{`Terminal: ${environment().terminal.name}`}</text>
            <text fg={tokens.muted}>{`Protocol: ${environment().protocol}`}</text>
            <text fg={tokens.muted}>{`Transport: ${environment().transport}`}</text>
            <text fg={tokens.muted}>{`Multiplexer: ${environment().multiplexer}`}</text>
            <text fg={tokens.muted}>
              {`Client convention: ${environment().clientPlatform ?? (environment().transport === "ssh" ? "unknown" : environment().runtimePlatform)}`}
            </text>
            <box flexDirection="column" paddingTop={1}>
              <For each={PROFILES}>
                {(profile, index) => (
                  <SelectableRow selected={index() === selected()}>
                    <span style={{ fg: tokens.accent2 }}>
                      {(profile.id === environment().profile
                        ? glyph("radioOn")
                        : glyph("radioOff")) + " "}
                    </span>
                    <span style={{ fg: tokens.fg }}>{profile.label.padEnd(12)}</span>
                    <span style={{ fg: tokens.muted }}>{profile.desc}</span>
                    <span style={{ fg: tokens.accent }}>{`  ${profileState(profile.id)}`}</span>
                  </SelectableRow>
                )}
              </For>
            </box>
            <text fg={tokens.muted} paddingTop={1}>
              Enhanced bindings are additive. Help, commands, back, accept and slash routes remain
              portable.
            </text>
          </Show>
        </box>
      </Show>
    </ViewFrame>
  );
}
