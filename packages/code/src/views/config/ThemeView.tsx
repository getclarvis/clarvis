import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { tokens, type TokenName } from "../../theme/tokens.ts";
import { MINI_WORDMARK } from "../brand.tsx";
import {
  parseColor,
  quantize,
  resolveBackground,
  resolveMode,
  TOKEN_ORDER,
  tokenUsedIn,
  type ColorDepth,
  type PresetName,
  type ThemeBackground,
  type ThemeModeConfig,
} from "../../theme/model.ts";
import {
  auditContrast,
  nudgeToAA,
  type ContrastLevel,
  type ContrastResult,
} from "../../theme/contrast.ts";
import { tone } from "../../theme/tone.ts";
import type { Platform } from "../../adapters/platform.ts";
import type { CodeConfigStore } from "../../adapters/code-config.ts";
import type { ThemePreview } from "../../theme/theme.ts";
import { applyAsciiMode, borderChars, glyph } from "../../theme/glyphs.ts";
import type { ViewHost } from "../../keys/commands.ts";
import { registerLevel, verb, type LevelSpec } from "../../ui/patterns/level-keys.ts";
import {
  bindLevelKeys,
  createFieldEditor,
  FieldRow,
  LevelHost,
  SectionHeader,
  SelectableRow,
  SourceBadge,
  ToggleRow,
} from "./view-host.tsx";

/** Data and actions {@link ThemeView} needs from its host. */
export interface ThemeDeps {
  preview: ThemePreview;
  platform: Platform;
  code: CodeConfigStore;
  notify: (message: string) => void;
}

const MODES: ThemeModeConfig[] = ["dark", "light", "auto"];
const PRESETS: PresetName[] = ["family", "high-contrast", "mono"];
const BACKGROUNDS: ThemeBackground[] = ["themed", "terminal"];
const DEPTHS: ColorDepth[] = ["truecolor", "256", "16", "mono"];

type Sub = "main" | "preview" | "contrast" | "depth";

/**
 * Theme config panel: mode (dark/light/auto), preset, background, color
 * depth, and a per-token contrast audit with an AA-nudge fix.
 */
export function ThemeView(host: ViewHost, deps: ThemeDeps): JSX.Element {
  const preview = deps.preview;
  const dimensions = useTerminalDimensions();
  const previewBesideControls = (): boolean => dimensions().width >= 100;
  const fe = createFieldEditor(host.interaction, host.active);
  const [sel, setSel] = createSignal(0);

  host.bindScope({ mode: "retarget" });

  const mode = createMemo(() =>
    resolveMode(preview.source(), deps.platform.capabilities.themeBg()),
  );
  const preset = createMemo<PresetName>(() => preview.source().preset ?? "family");
  const background = createMemo<ThemeBackground>(() => resolveBackground(preview.source()));
  const sub = createMemo<Sub>(() => {
    const top = host.breadcrumb().at(-1);
    return top === "Preview"
      ? "preview"
      : top === "Contrast"
        ? "contrast"
        : top === "Depth"
          ? "depth"
          : "main";
  });

  const TOKEN_BASE = 3;
  const ROW_COUNT = TOKEN_BASE + TOKEN_ORDER.length + 3;
  const clampMain = (i: number): number => Math.max(0, Math.min(ROW_COUNT - 1, i));
  const tokenAt = (row: number): TokenName | null =>
    row >= TOKEN_BASE && row < TOKEN_BASE + TOKEN_ORDER.length
      ? TOKEN_ORDER[row - TOKEN_BASE]!
      : null;

  const resolved = createMemo(() => preview.resolveAll(mode()));
  const audit = createMemo<ContrastResult[]>(() => auditContrast(resolved()));
  const [contrastSel, setContrastSel] = createSignal(0);

  const [pendingAscii, setPendingAscii] = createSignal<{
    scope: ReturnType<typeof host.scope>;
    value: boolean;
  } | null>(null);

  host.onSave(async () => {
    await preview.commit();
    const staged = pendingAscii();
    if (staged) {
      deps.code.writeAscii(staged.scope, staged.value);
      setPendingAscii(null);
    }
    host.markDirty(false);
    deps.notify(`saved theme to ${host.scope()} code.json`);
  });
  host.onCancel(() => {
    preview.reset();
    if (pendingAscii()) {
      applyAsciiMode(deps.code.asciiEnabled());
      setPendingAscii(null);
    }
    host.markDirty(false);
  });

  function editToken(token: TokenName): void {
    const cur = preview.resolveToken(token, mode(), preset()).value;
    fe.start(`${token} (hex / rgb / hsl)`, cur, (v) => {
      const rgba = parseColor(v);
      if (!rgba) {
        deps.notify(`unparseable color: ${v}`);
        return;
      }
      preview.set(host.scope(), { overrides: { [mode()]: { [token]: v.trim() } } });
      host.markDirty(true);
    });
  }

  function resetToken(token: TokenName): void {
    preview.set(host.scope(), { overrides: { [mode()]: { [token]: undefined } } });
    host.markDirty(true);
    deps.notify(`${token} reset to the resolution chain`);
  }

  function activateMain(): void {
    const i = clampMain(sel());
    if (i === 0) {
      fe.startEnum("mode", MODES, preview.source().mode ?? "dark", (v) => {
        preview.set(host.scope(), { mode: v as ThemeModeConfig });
        host.markDirty(true);
      });
    } else if (i === 1) {
      fe.startEnum("preset", PRESETS, preset(), (v) => {
        preview.set(host.scope(), { preset: v as PresetName });
        host.markDirty(true);
      });
    } else if (i === 2) {
      fe.startEnum("background", BACKGROUNDS, background(), (v) => {
        preview.set(host.scope(), { background: v as ThemeBackground });
        host.markDirty(true);
      });
    } else if (i === ROW_COUNT - 3) {
      setContrastSel(0);
      host.level.push("Contrast");
    } else if (i === ROW_COUNT - 2) {
      host.level.push("Depth");
    } else if (i === ROW_COUNT - 1) {
      toggleAscii();
    } else {
      const t = tokenAt(i);
      if (t) editToken(t);
    }
  }

  const asciiValue = (): boolean => pendingAscii()?.value ?? deps.code.asciiEnabled();

  function toggleAscii(): void {
    const next = !asciiValue();
    setPendingAscii({ scope: host.scope(), value: next });
    applyAsciiMode(next);
    host.markDirty(true);
    deps.notify(`ascii glyphs ${next ? "on" : "off"} (previewing ${glyph("emDash")} ^s saves)`);
  }

  function fixContrast(): void {
    const list = audit();
    const r = list[Math.max(0, Math.min(list.length - 1, contrastSel()))];
    if (!r || r.level === "AAA" || r.level === "AA") return;
    const [fgTok, bgTok] = r.pair;
    const res = resolved();
    let nudged = nudgeToAA(res[fgTok], res[bgTok]);
    for (const other of list) {
      if (other.pair[0] === fgTok && other.pair[1] !== bgTok) {
        nudged = nudgeToAA(nudged, res[other.pair[1]]);
      }
    }
    preview.set(host.scope(), { overrides: { [mode()]: { [fgTok]: nudged } } });
    host.markDirty(true);
    deps.notify(`${fgTok} nudged to ${nudged} for AA over ${bgTok}`);
  }

  function specForSub(which: Sub): LevelSpec {
    if (which === "contrast")
      return {
        nav: {
          count: () => audit().length,
          index: contrastSel,
          setIndex: setContrastSel,
          showArrows: true,
          activate: { label: "fix to AA", run: fixContrast },
        },
      };
    if (which === "depth") return {};
    return {
      nav: {
        count: () => ROW_COUNT,
        index: sel,
        setIndex: setSel,
        activate: { label: "edit", run: activateMain },
      },
      verbs: [
        {
          id: "theme.preview.open",
          key: "p",
          label: "preview",
          run: () => host.level.push("Preview"),
          when: () => !previewBesideControls(),
        },
        {
          ...verb(
            "clear",
            () => {
              const t = tokenAt(clampMain(sel()));
              if (t) resetToken(t);
            },
            () => tokenAt(clampMain(sel())) !== null,
          ),
          label: "reset",
        },
      ],
    };
  }

  bindLevelKeys({
    host,
    editor: fe,
    register: (enabled) => {
      const which = sub();
      if (which === "depth") return undefined;
      return registerLevel(host.interaction.keymap, { ...specForSub(which), enabled });
    },
  });

  return (
    <LevelHost
      host={host}
      editor={fe}
      levels={[
        {
          title: "Theme",
          when: () => sub() === "main",
          body: () => (
            <box flexGrow={1} flexDirection="row">
              {ControlsPane()}
              <Show when={previewBesideControls()}>{SpecimenPane()}</Show>
            </box>
          ),
        },
        { title: "Theme", when: () => sub() === "preview", readOnly: true, body: SpecimenPane },
        { title: "Theme", when: () => sub() === "contrast", body: ContrastPane },
        { title: "Theme", when: () => sub() === "depth", readOnly: true, body: DepthPane },
      ]}
    />
  );

  function ControlsPane(): JSX.Element {
    return (
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <FieldRow
          label="mode"
          value={preview.source().mode ?? "dark"}
          kind="enum"
          selected={sel() === 0}
          note={preview.source().mode === "auto" ? glyph("arrowRight") + " " + mode() : undefined}
        />
        <FieldRow label="preset" value={preset()} kind="enum" selected={sel() === 1} />
        <FieldRow
          label="background"
          value={background()}
          kind="enum"
          selected={sel() === 2}
          note={background() === "terminal" ? "paints the terminal's own bg" : undefined}
        />
        <SectionHeader label={"tokens (" + mode() + ")"} />
        <For each={TOKEN_ORDER}>
          {(t, i) => {
            const row = TOKEN_BASE + i();
            const r = createMemo(() => preview.resolveToken(t, mode(), preset()));
            return (
              <SwatchFieldRow
                label={t}
                swatch={r().value}
                value={r().value}
                origin={r().source}
                selected={sel() === row}
              />
            );
          }}
        </For>
        <SelectableRow selected={sel() === ROW_COUNT - 3}>
          <span style={{ fg: tokens.fg }}>{"contrast checker"}</span>
          <span style={{ fg: tokens.muted }}>{" " + glyph("chevronRight")}</span>
        </SelectableRow>
        <SelectableRow selected={sel() === ROW_COUNT - 2}>
          <span style={{ fg: tokens.fg }}>{"depth preview"}</span>
          <span style={{ fg: tokens.muted }}>{" " + glyph("chevronRight")}</span>
        </SelectableRow>
        <ToggleRow
          label="ascii"
          value={asciiValue()}
          selected={sel() === ROW_COUNT - 1}
          note="glyphs render as plain ascii"
        />
        <Show when={tokenAt(clampMain(sel()))}>
          <text flexShrink={0} fg={tokens.muted} paddingTop={1}>
            {"  used in: " + tokenUsedIn(tokenAt(clampMain(sel()))!)}
          </text>
        </Show>
      </box>
    );
  }

  function SpecimenPane(): JSX.Element {
    return (
      <box
        flexDirection="column"
        width={Math.min(48, Math.max(32, dimensions().width - 52))}
        flexShrink={0}
        paddingLeft={2}
        border
        borderStyle="rounded"
        customBorderChars={borderChars()}
        borderColor={tokens.muted}
      >
        <text flexShrink={0}>
          <span style={{ fg: tokens.accent }}>{MINI_WORDMARK}</span>
          <span style={{ fg: tokens.muted }}>{"  " + glyph("separator") + "  specimen"}</span>
        </text>
        <text flexShrink={0} fg={tokens.fg} paddingTop={1}>
          {"Body text sits on bg with a"}
        </text>
        <text flexShrink={0}>
          <span style={{ fg: tokens.fg }}>{"headline in "}</span>
          <span style={{ fg: tokens.accent }}>{"accent"}</span>
          <span style={{ fg: tokens.fg }}>{" and a "}</span>
          <span style={{ fg: tokens.accent2 }}>{"link"}</span>
          <span style={{ fg: tokens.fg }}>{"."}</span>
        </text>
        <box
          flexShrink={0}
          flexDirection="column"
          border
          borderStyle="rounded"
          customBorderChars={borderChars()}
          borderColor={resolved().subagent[0]}
          marginTop={1}
          paddingLeft={1}
          backgroundColor={tokens.bgElev}
        >
          <text>
            <span style={{ fg: resolved().subagent[0] }}>{glyph("dotFull") + " "}</span>
            <span style={{ fg: tokens.fg }}>{"sub-agent card (elevated)"}</span>
          </text>
          <text>
            <For each={resolved().subagent}>
              {(c) => <span style={{ fg: c }}>{glyph("dotFull") + " "}</span>}
            </For>
            <span style={{ fg: tokens.muted }}>{"agent ramp"}</span>
          </text>
        </box>
        <text flexShrink={0} paddingTop={1}>
          <span style={{ fg: tokens.add }}>{"+ added line"}</span>
        </text>
        <text flexShrink={0}>
          <span style={{ fg: tokens.del }}>{"- removed line"}</span>
        </text>
        <text flexShrink={0}>
          <span style={{ fg: tokens.warn }}>{glyph("warning") + " a warning"}</span>
          <span style={{ fg: tokens.muted }}>{"   muted hint"}</span>
        </text>
      </box>
    );
  }

  function ContrastPane(): JSX.Element {
    return (
      <box flexDirection="column" flexGrow={1}>
        <text flexShrink={0} fg={tokens.muted}>
          {"WCAG contrast " +
            glyph("separator") +
            " mode " +
            mode() +
            " " +
            glyph("separator") +
            " AA = 4.5:1 body / 3:1 large" +
            (background() === "terminal"
              ? " " + glyph("separator") + " audit vs themed bg (terminal bg unknown)"
              : "")}
        </text>
        <box flexDirection="column" paddingTop={1}>
          <For each={audit()}>
            {(r, i) => (
              <SelectableRow selected={i() === contrastSel()}>
                <span style={{ fg: tokens.fg }}>{(r.pair[0] + " / " + r.pair[1]).padEnd(20)}</span>
                <span style={{ fg: tone(levelTone(r.level)).fg }}>
                  {r.ratio.toFixed(1).padStart(5) + ":1  " + levelBadge(r.level)}
                </span>
              </SelectableRow>
            )}
          </For>
        </box>
        <text flexShrink={0} fg={tokens.muted} paddingTop={1}>
          Select a flagged pair to auto-adjust it to AA.
        </text>
      </box>
    );
  }

  function DepthPane(): JSX.Element {
    const keyTokens: TokenName[] = ["accent", "fg", "add", "warn", "del"];
    return (
      <box flexDirection="column" flexGrow={1}>
        <text flexShrink={0} fg={tokens.muted}>
          {"depth preview (locked " +
            glyph("separator") +
            " detection is authoritative) " +
            glyph("separator") +
            " current " +
            deps.platform.capabilities.colorDepth()}
        </text>
        <text flexShrink={0} fg={tokens.muted}>
          {"preview only " + glyph("emDash") + " colors are quantized from your current tokens"}
        </text>
        <For each={keyTokens}>
          {(t) => {
            const hex = createMemo(() => preview.resolveToken(t, mode(), preset()).value);
            return (
              <text flexShrink={0} paddingTop={1}>
                <span style={{ fg: tokens.muted }}>{t.padEnd(10)}</span>
                <For each={DEPTHS}>
                  {(d) => {
                    const q = createMemo(() =>
                      quantize(parseColor(hex()) ?? { r: 0, g: 0, b: 0 }, d),
                    );
                    return (
                      <span>
                        <span style={{ fg: q().hex }}>{glyph("block") + glyph("block")}</span>
                        <span style={{ fg: tokens.muted }}>
                          {" " + d + "(" + q().label + ")   "}
                        </span>
                      </span>
                    );
                  }}
                </For>
              </text>
            );
          }}
        </For>
      </box>
    );
  }
}

function SwatchFieldRow(props: {
  label: string;
  swatch: string;
  value: string;
  origin: string;
  selected: boolean;
}): JSX.Element {
  return (
    <SelectableRow selected={props.selected}>
      <span style={{ fg: props.swatch }}>{glyph("block") + glyph("block") + " "}</span>
      <span style={{ fg: tokens.muted }}>{props.label.padEnd(13)}</span>
      <span style={{ fg: tokens.fg }}>{props.value.padEnd(9)}</span>
      <SourceBadge origin={badgeOrigin(props.origin)} />
    </SelectableRow>
  );
}

function badgeOrigin(s: string): string {
  if (s === "override-workspace") return "workspace";
  if (s === "override-global") return "global";
  if (s === "preset") return "preset";
  return "family";
}
function levelTone(l: ContrastLevel): "ok" | "warn" | "error" {
  return l === "fail" ? "error" : l === "AA-large" ? "warn" : "ok";
}
function levelBadge(l: ContrastLevel): string {
  return (l === "AA-large" ? "AA large" : l) + " " + tone(levelTone(l)).glyph;
}
