# Theme tokens, contrast, surfaces, syntax colors and the ASCII rule

> Implemented at `packages/code/src/theme/**`, `packages/code/src/core/theme-types.ts`,
> `packages/code/src/core/marks.ts`, `packages/code/src/ui/primitives/**`,
> `packages/code/src/views/brand.tsx`, `packages/code/src/views/MemoryPressureBanner.tsx` and
> `packages/code/src/views/config/ThemeView.tsx`. Every claim below is anchored to a file and a named symbol or test.
> Open questions are collected in the final section.

## 1. Purpose

This subsystem is `@clarvis/code`'s design-token layer: a small set of framework-free color/type
definitions (`packages/code/src/core/theme-types.ts`), a resolution chain that turns a user's
`ThemeConfig` into concrete hex colors per token (`packages/code/src/theme/model.ts`), a
Solid-signal-backed live singleton every component reads (`packages/code/src/theme/tokens.ts`), and
a handful of derived "surface" washes (selection, focus, user band, rule, scrollbar,
`packages/code/src/theme/surfaces.ts`) computed from those tokens rather than declared as their own
colors. On top of the color layer sits a **glyph** layer (`packages/code/src/core/marks.ts`,
wrapped reactively by `packages/code/src/theme/glyphs.ts`) that gives every non-ASCII character used
anywhere in the TUI a paired plain-ASCII rendering, switchable at runtime by the `--ascii` flag or a
persisted setting.

The problem this solves is keeping the whole terminal UI themable and degradable from two single
sources of truth: change a token's hex value and every consumer (borders, swatches, syntax
highlighting, diff gutters, the wordmark gradient) re-renders through Solid reactivity
(`packages/code/src/theme/tokens.ts`); change the ascii/unicode mode and every rendered glyph
switches together, because nothing outside `theme/glyphs.ts`/`core/marks.ts` is permitted to spell a
raw Unicode character (enforced for a named 14-file subset by
`packages/code/tests/architecture/ascii-source-boundary.test.ts`). `ThemeView`
(`packages/code/src/views/config/ThemeView.tsx`) is the settings screen that edits this layer live,
including a WCAG contrast auditor and an ANSI-depth preview.

## 2. Surface

### `core/theme-types.ts` — framework-free shapes

| Symbol | Kind | Signature / value | Cite |
| --- | --- | --- | --- |
| `ThemeMode` | type | `"dark" \| "light"` | `packages/code/src/core/theme-types.ts` |
| `ThemeModeConfig` | type | `ThemeMode \| "auto"` | `packages/code/src/core/theme-types.ts` |
| `PresetName` | type | `"family" \| "high-contrast" \| "mono"` | `packages/code/src/core/theme-types.ts` |
| `ColorDepth` | type | `"truecolor" \| "256" \| "16" \| "mono"` | `packages/code/src/core/theme-types.ts` |
| `ThemeBackground` | type | `"themed" \| "terminal"` | `packages/code/src/core/theme-types.ts` |
| `TokenName` | type | `"accent"\|"accent-2"\|"bg"\|"bg-elev"\|"fg"\|"muted"\|"add"\|"warn"\|"del"` | `packages/code/src/core/theme-types.ts` |
| `SUBAGENT_ORDER` | const | `["subagent-0" … "subagent-5"]` (6 slots) | `packages/code/src/core/theme-types.ts` |
| `SubagentName` | type | `(typeof SUBAGENT_ORDER)[number]` | `packages/code/src/core/theme-types.ts` |
| `ThemeConfig` | interface | `{ mode?, preset?, background?, overrides?: Partial<Record<ThemeMode, Partial<Record<TokenName\|SubagentName,string>>>> }` | `packages/code/src/core/theme-types.ts` |
| `ResolvedTokens` | type | `Record<TokenName\|SubagentName,string> & { subagent: readonly string[] }` | `packages/code/src/core/theme-types.ts` |
| `depthFromCapabilities(rgb, ansi256, noColor)` | function | `→ ColorDepth` | `packages/code/src/core/theme-types.ts` |

### `core/marks.ts` — the mark table (Solid-free)

| Symbol | Kind | Cite |
| --- | --- | --- |
| `MarkForms` | type `{ unicode: string; ascii: string }` | `packages/code/src/core/marks.ts` |
| `MARKS` | const, 59 named marks (`success`…`superscriptG`) | `packages/code/src/core/marks.ts` |
| `MarkName` | type `keyof typeof MARKS` | `packages/code/src/core/marks.ts` |
| `GlyphForms`/`GlyphName`/`GLYPHS` | compatibility aliases for `MarkForms`/`MarkName`/`MARKS` | `packages/code/src/core/marks.ts` |
| `applyAsciiMode(on)` | sets module-wide default | `packages/code/src/core/marks.ts` |
| `asciiMode()` | reads the default | `packages/code/src/core/marks.ts` |
| `mark(name, ascii = asciiEnabled)` | resolves one mark | `packages/code/src/core/marks.ts` |
| `glyph(name, ascii = asciiEnabled)` | `@deprecated` alias of `mark`, reads the plain module flag (not a Solid signal) | `packages/code/src/core/marks.ts` |
| `ASCII_BORDER` | const, eleven named border-drawing keys (`topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical, topT, bottomT, leftT, rightT, cross`), every one mapped to `+`, `-` or `\|` | `packages/code/src/core/marks.ts` |
| `borderChars(ascii = asciiEnabled)` | `→ ASCII_BORDER \| undefined` | `packages/code/src/core/marks.ts` |

### `theme/glyphs.ts` — the reactive wrapper terminal UI actually imports

| Symbol | Signature | Cite |
| --- | --- | --- |
| `applyAsciiMode(on: boolean): void` | forwards to `core/marks.ts` and mirrors into a Solid signal | `packages/code/src/theme/glyphs.ts` |
| `asciiMode(): boolean` | reactive read | `packages/code/src/theme/glyphs.ts` |
| `glyph(name: GlyphName): string` | resolves against the reactive signal, not `core`'s bare default | `packages/code/src/theme/glyphs.ts` |
| `glyphColWidth(name: GlyphName): number` | `max(ascii.length, unicode.length)` | `packages/code/src/theme/glyphs.ts` |
| `borderChars(): ReturnType<typeof coreBorderChars> \| undefined` | reactive | `packages/code/src/theme/glyphs.ts` |
| re-exports | `GLYPHS`, `GlyphForms`, `GlyphName` from `core/marks.ts` | `packages/code/src/theme/glyphs.ts` |

### `theme/model.ts` — resolution and color math

| Symbol | Signature | Cite |
| --- | --- | --- |
| `TOKEN_ORDER` | `readonly TokenName[]`, 9 entries, canonical display order | `packages/code/src/theme/model.ts` |
| `tokenUsedIn(token: TokenName): string` | human-readable usage summary, `glyph("separator")`-joined | `packages/code/src/theme/model.ts` |
| `resolveToken(token, mode, preset, overridesGlobal?, overridesWorkspace?)` | `→ { value: string; source: TokenSource }` | `packages/code/src/theme/model.ts` |
| `TokenSource` | `"family" \| "preset" \| "override-global" \| "override-workspace"` | `packages/code/src/theme/model.ts` |
| `resolveMode(config, themeBg): ThemeMode` | `config.mode`, `"auto"` follows `themeBg` | `packages/code/src/theme/model.ts` |
| `resolveBackground(config): ThemeBackground` | defaults `"themed"` | `packages/code/src/theme/model.ts` |
| `TERMINAL_BG` | `"transparent"` sentinel | `packages/code/src/theme/model.ts` |
| `setThemedMixBase(hex: string): void` | sets the `TERMINAL_BG` stand-in for `mixHex` | `packages/code/src/theme/model.ts` |
| `resolveTokens(config, mode): ResolvedTokens` | full map incl. AA-nudged subagent ramp | `packages/code/src/theme/model.ts` |
| `mixHex(base, tint, amount): string` | linear RGB blend; substitutes `themedMixBase()` for `TERMINAL_BG`; returns `base` on parse failure | `packages/code/src/theme/model.ts` |
| `quantize(input: RGBA, depth: ColorDepth): QuantizedSwatch` | `{ hex, label }` | `packages/code/src/theme/model.ts` |
| re-exports | `hslToRgb`, `parseColor`, `rgbaToHex`, `rgbToHsl`, `RGBA` from `theme/color.ts` | `packages/code/src/theme/model.ts` |

### `theme/color.ts` — pure color parsing/conversion

`RGBA` (`r,g,b` bytes, no alpha despite the name — `packages/code/src/theme/color.ts`), `rgbaToHex` (`packages/code/src/theme/color.ts`),
`parseColor` (accepts 3/6-digit hex, `rgb()`, `hsl()`; rejects everything else — `packages/code/src/theme/color.ts`),
`hslToRgb` (`packages/code/src/theme/color.ts`), `rgbToHsl` (`packages/code/src/theme/color.ts`).

### `theme/contrast.ts` — WCAG auditing

| Symbol | Signature | Cite |
| --- | --- | --- |
| `relativeLuminance(c: RGBA): number` | WCAG 2 formula, `[0,1]` | `packages/code/src/theme/contrast.ts` |
| `contrastRatio(fg, bg): number` | `[1,21]`, order-independent | `packages/code/src/theme/contrast.ts` |
| `ContrastLevel` | `"AAA" \| "AA" \| "AA-large" \| "fail"` | `packages/code/src/theme/contrast.ts` |
| `contrastLevel(ratio): ContrastLevel` | thresholds 7 / 4.5 / 3 | `packages/code/src/theme/contrast.ts` |
| `ContrastFgName` | `TokenName \| SubagentName` | `packages/code/src/theme/contrast.ts` |
| `auditContrast(resolved: ResolvedTokens): ContrastResult[]` | runs `CONTRAST_PAIRS` (11 fixed pairs + 6 subagent-vs-`bg` pairs) | `packages/code/src/theme/contrast.ts` |
| `nudgeToAA(fgHex, bgHex, target = 4.5): string` | up to 100 lightness steps toward `bg`, hue/sat fixed | `packages/code/src/theme/contrast.ts` |

### `theme/tokens.ts` — the live singleton

| Symbol | Signature | Cite |
| --- | --- | --- |
| `Tokens` | interface: `accent, accent2, bg, bgElev, fg, muted, add, warn, del: string; subagent(i: number): string` | `packages/code/src/theme/tokens.ts` |
| `tokens` | the process-wide singleton object of getters | `packages/code/src/theme/tokens.ts` |
| `tokens.subagent(i)` implementation | wraps out-of-range/negative `i` via `((i % ramp.length) + ramp.length) % ramp.length` rather than returning `undefined` or throwing | `packages/code/src/theme/tokens.ts` |
| `applyResolvedTokens(map: ResolvedTokens): void` | pushes a resolved map into the signals, only on real change, `untrack`+`batch` | `packages/code/src/theme/tokens.ts` |
| re-exports | `SUBAGENT_ORDER`, `SubagentName`, `TokenName` from `core/theme-types.ts` | `packages/code/src/theme/tokens.ts` |

### `theme/surfaces.ts` — derived washes

| Symbol | Signature | Cite |
| --- | --- | --- |
| `scrimColor(): string` | `mixHex(tokens.bg, "#000000", 0.5)` | `packages/code/src/theme/surfaces.ts` |
| `overlayBg(): string` | `tokens.bgElev` | `packages/code/src/theme/surfaces.ts` |
| `selectionBg(base = tokens.bg): string` | `mixHex(base, tokens.accent, 0.16)` | `packages/code/src/theme/surfaces.ts` |
| `focusBg(): string` | `mixHex(tokens.bg, tokens.accent, 0.16)` | `packages/code/src/theme/surfaces.ts` |
| `userBandBg(): string` | `mixHex(tokens.bg, tokens.accent, 0.18)` | `packages/code/src/theme/surfaces.ts` |
| `ruleColor(): string` | `mixHex(tokens.bg, tokens.muted, 0.55)` | `packages/code/src/theme/surfaces.ts` |
| `SCROLLBOX_TABLE_GUTTER` | const `2` | `packages/code/src/theme/surfaces.ts` |
| `scrollbarOptions(base = tokens.bg)` | `→ { trackOptions: { backgroundColor, foregroundColor } }` | `packages/code/src/theme/surfaces.ts` |

### `theme/tone.ts` — semantic status styling

`Tone = "ok"\|"warn"\|"error"\|"pending"\|"muted"\|"running"` (`packages/code/src/theme/tone.ts`); `ToneStyle = { glyph,
fg }` (`packages/code/src/theme/tone.ts`); `tone(t, spinnerChar?)` overloaded so `"running"` requires a caller-supplied
spinner character (`packages/code/src/theme/tone.ts`).

### `theme/syntax.ts` — syntax/diff colors and native-style lifecycle

| Symbol | Signature | Cite |
| --- | --- | --- |
| `syntaxStyle: Accessor<SyntaxStyle>` | rebuilt whenever tokens change | `packages/code/src/theme/syntax.ts` |
| `bindSyntaxStyleRenderer(renderer: CliRenderer): () => void` | attaches retirement to a renderer's `"frame"` event; returns a disposer | `packages/code/src/theme/syntax.ts` |
| `pendingSyntaxStyleRetirements(): number` | test/diagnostic visibility | `packages/code/src/theme/syntax.ts` |
| `diffColorProps` | `Accessor` of themed diff-view color props | `packages/code/src/theme/syntax.ts` |
| `filetypeFor(path: string \| undefined): string` | extension → highlighter filetype id, `"text"` fallback | `packages/code/src/theme/syntax.ts` |

### `theme/theme.ts` — the reactive `Theme`/`ThemePreview` façade

| Symbol | Signature | Cite |
| --- | --- | --- |
| `ThemeCapabilities` | `{ themeBg(): ThemeMode }` | `packages/code/src/theme/theme.ts` |
| `Theme` | `{ mode, preset, background, resolved: Accessor<ResolvedTokens>; resolvedFor(mode) }` | `packages/code/src/theme/theme.ts` |
| `createTheme(caps, source: Accessor<ThemeConfig>): Theme` | derives + applies as a Solid effect | `packages/code/src/theme/theme.ts` |
| `ThemePreview` | `{ source, draft, set(scope,patch), reset(), commit(): Promise<void>, overridesAt, resolveToken, resolveAll }` | `packages/code/src/theme/theme.ts` |
| `createThemePreview(code: CodeConfigStore, signals: DraftSignals): ThemePreview` | staged per-scope edits, merged before commit | `packages/code/src/theme/theme.ts` |

### `ui/primitives/**` — themed row/badge/banner components

| Component | File | Cite |
| --- | --- | --- |
| `ScopeBadge`, `SourceBadge` | `badges.tsx` | `packages/code/src/ui/primitives/badges.tsx` |
| `ErrorBanner` | `banners.tsx` | `packages/code/src/ui/primitives/banners.tsx` |
| `EntityRow` | `entity-row.tsx` | `packages/code/src/ui/primitives/entity-row.tsx` (`EntityRow`) |
| `FieldRow`, `LABEL_WIDTH`, `FieldIssueBadge`, `ToggleRow` | `field-row.tsx` | `packages/code/src/ui/primitives/field-row.tsx` |
| `EmptyHint`, `LoadingHint` | `hints.tsx` | `packages/code/src/ui/primitives/hints.tsx` |
| `SectionHeader`, `StatusRow`, `DetailRow`, `DetailLines`, `Dash` | `section-status.tsx` | `packages/code/src/ui/primitives/section-status.tsx` |
| `SelectableRow` | `selectable-row.tsx` | `packages/code/src/ui/primitives/selectable-row.tsx` |
| `SettingRow` | `setting-row.tsx` | `packages/code/src/ui/primitives/setting-row.tsx` |

`ui/primitives/index.ts` re-exports the public subset above except `EntityRow`, which remains an
explicit-import primitive with a focused render contract
(`packages/code/tests/integration/view-host-kit-render.test.tsx`).

### `views/brand.tsx`

`gradientStops(n, from, to, bg): string[]` — `n` colors linearly interpolated then AA-nudged against
`bg` (`packages/code/src/views/brand.tsx`); `WORDMARK = " Clarvis"` (`packages/code/src/views/brand.tsx`); `MINI_WORDMARK = "Clarvis"`
(`packages/code/src/views/brand.tsx`); `SPLASH_WORDMARK = "  C L A R V I S"` (`packages/code/src/views/brand.tsx`); `BrandWordmark()` — renders
`glyph("diamond") + WORDMARK` with each character colored by a gradient stop (`packages/code/src/views/brand.tsx`).

### `views/MemoryPressureBanner.tsx`

`MemoryPressureBanner(props: { state: Accessor<MemoryPressureSnapshot>; onRecover: () => void
}): JSX.Element` (`packages/code/src/views/MemoryPressureBanner.tsx`). `gib(bytes: number): string` formats bytes as
one-decimal GiB (`packages/code/src/views/MemoryPressureBanner.tsx`). `MemoryPressureSnapshot`/its `phase` field are
defined in `adapters/memory-pressure.ts` and are outside this document's scope — only the banner's own
phase→visual mapping is described here (§4).

### `views/config/ThemeView.tsx`

`ThemeDeps` (`{ preview: ThemePreview; platform: Platform; code: CodeConfigStore; notify: (m:
string) => void }`, `packages/code/src/views/config/ThemeView.tsx`); `ThemeView(host: ViewHost, deps: ThemeDeps): JSX.Element`
(`packages/code/src/views/config/ThemeView.tsx`) — a four-level `LevelHost` view (`main`/`preview`/`contrast`/`depth`,
`packages/code/src/views/config/ThemeView.tsx`).

Module-private helpers behind that view (described in §4):

| Symbol | Signature | Cite |
| --- | --- | --- |
| `SwatchFieldRow` | one main-level token row: swatch + label + value + `SourceBadge` | `packages/code/src/views/config/ThemeView.tsx` |
| `badgeOrigin(s)` | `TokenSource` string → `SourceBadge`'s `origin` prop | `packages/code/src/views/config/ThemeView.tsx` |
| `levelTone(l: ContrastLevel)` | `→ "ok" \| "warn" \| "error"` | `packages/code/src/views/config/ThemeView.tsx` |
| `levelBadge(l: ContrastLevel)` | tone-glyphed label, `"AA-large"` relabeled `"AA large"` | `packages/code/src/views/config/ThemeView.tsx` |

### CLI flag

| Flag | Effect | Cite |
| --- | --- | --- |
| `--ascii` | boolean flag, no value; carried as `Mode.ascii` on `run`/`resume`/`continue` modes | `packages/code/src/cli-args.ts` |

### Settings keys (persistence surface, owned by a sibling document's adapter but read here for shape)

| Key path (in `code.json`) | Type | Cite |
| --- | --- | --- |
| `theme` | `ThemeConfig` | `packages/code/src/adapters/code-config.ts` |
| `ui.ascii` | `boolean` | `packages/code/src/adapters/code-config.ts` |

## 3. Data and formats

**`ThemeConfig`** (the on-disk/settings shape, `packages/code/src/core/theme-types.ts`):

```ts
interface ThemeConfig {
  mode?: "dark" | "light" | "auto";
  preset?: "family" | "high-contrast" | "mono";
  background?: "themed" | "terminal";
  overrides?: Partial<Record<"dark" | "light", Partial<Record<TokenName | SubagentName, string>>>>;
}
```

Two independent copies exist per host at any time — a **global** `code.json` and a **workspace**
`code.json`, each holding its own `theme` block (`packages/code/src/adapters/code-config.ts`) — merged by
`mergeEffectiveTheme(g, w)`: `mode`/`preset`/`background` take the workspace value whole only if set
(else fall back to global), while `overrides` merge **per-token**, workspace winning per key
(`packages/code/src/adapters/code-config.ts`). Editing merges the same way one scope at a time via
`mergeThemeBlock`, where an override value of `undefined` in a patch **deletes** that token from the
merged overrides rather than being treated as "unset, keep base"
(`packages/code/src/adapters/code-config.ts`).

**Resolution example.** For `TOKEN_ORDER` (9 tokens: `bg`, `bg-elev`, `fg`, `muted`, `accent`,
`accent-2`, `add`, `warn`, `del` — `packages/code/src/theme/model.ts`), `resolveTokens` layers, most to least
specific: per-mode `overrides` → the active `preset`'s partial layer (`HIGH_CONTRAST`/`MONO`, empty
for `"family"`) → the mode's base `FAMILY_DARK`/`FAMILY_LIGHT` table (`packages/code/src/theme/model.ts`,
tables at `packages/code/src/theme/model.ts`). Six additional `subagent-N` tokens come from a **per-preset,
per-mode ramp** (`SUBAGENT_RAMP`, `packages/code/src/theme/model.ts`) and are individually nudged to at least
AA contrast (4.5-to-1) against the resolved `bg` via `nudgeToAA` before being written into
`ResolvedTokens` (`packages/code/src/theme/model.ts`).

**`resolveToken` (singular) and `resolveTokens` (plural) see the two config scopes differently.**
`resolveToken` takes `overridesGlobal`/`overridesWorkspace` as two separate parameters and checks
workspace before global itself (`packages/code/src/theme/model.ts`) — this is the form `ThemePreview.resolveToken`
calls, passing each scope's own `effectiveOf(scope).overrides?.[mode]` (`packages/code/src/theme/theme.ts`), so
`ThemeView`'s per-token editor and `DepthPane` genuinely see the two-scope precedence inside
`theme/model.ts`. `resolveTokens` (plural) instead reads `config.overrides[mode]` as a single,
already-merged layer (`packages/code/src/theme/model.ts`) — the global-vs-workspace merge for that layer has already
happened one level up, in `adapters/code-config.ts`'s `mergeEffectiveTheme` (called by
`ThemePreview.resolveAll`/`source`, `packages/code/src/theme/theme.ts`) or in `createTheme`'s own `source` accessor
— so reading `theme/model.ts` alone does not show the two scopes ever being resolved separately for
the whole-map path; only `resolveToken`'s four-parameter form does that inside this file.

**`ResolvedTokens`** (`packages/code/src/core/theme-types.ts`) is `Record<TokenName | SubagentName, string> & {
subagent: readonly string[] }` — every flat key plus an ordered array duplicate of the six subagent
colors (verified equal by `resolveTokens: the subagent ramp is a per-mode family — array and flat
entries agree`, `packages/code/tests/unit/theme-model.test.ts`).

**Example dark-mode family palette** (`FAMILY_DARK`, `packages/code/src/theme/model.ts`):
`bg=#0f1020`, `bg-elev=#171433`, `fg=#c7c9d9`, `muted=#9195ad`, `accent=#a5a0f5`,
`accent-2=#c4b5fd`, `add=#3fb950`, `warn=#d29922`, `del=#f85149` — these are also `theme/tokens.ts`'s
signal initial values (`packages/code/src/theme/tokens.ts`).

**`ContrastResult`** (`packages/code/src/theme/contrast.ts`): `{ pair: [ContrastFgName, TokenName]; ratio: number;
level: ContrastLevel }`. `auditContrast` runs 11 fixed pairs plus one `[subagent-N, "bg"]` pair per
subagent slot — 17 pairs total for 6 subagents (`packages/code/src/theme/contrast.ts`).

**`QuantizedSwatch`** (`packages/code/src/theme/model.ts`): `{ hex: string; label: string }` — `label` is
`"truecolor"`, `"on"`/`"off"` (mono), an ANSI-16 color name, or `"idx <n>"` (256-color cube/greyscale
index) depending on `ColorDepth` (`packages/code/src/theme/model.ts`).

**`MarkForms`** table entries (`packages/code/src/core/marks.ts`) are pairs like `success: { unicode: "✓", ascii:
"[ok]" }`; every entry's `ascii` string is asserted pure-ASCII (codepoint `<= 0x7f`) by
`packages/code/tests/unit/glyphs.test.ts`.

**`Tone` → `{glyph, fg}` mapping** (`packages/code/src/theme/tone.ts`), the single semantic-status vocabulary most
`ui/primitives/**` components and views color/glyph a status through rather than switching on
`Tone` themselves:

| `Tone` | glyph | `fg` |
| --- | --- | --- |
| `"ok"` | `glyph("success")` | `tokens.add` |
| `"warn"` | `glyph("warning")` | `tokens.warn` |
| `"error"` | `glyph("error")` | `tokens.del` |
| `"pending"` | `glyph("pending")` | `tokens.muted` |
| `"muted"` | `glyph("info")` | `tokens.muted` |
| `"running"` | caller-supplied `spinnerChar` | `tokens.accent` |

**`buildSyntaxStyle()`'s 16 style keys** (`packages/code/src/theme/syntax.ts`) — the actual syntax color model
`syntaxStyle` produces, each bound to a token (bold/italic flags in parens): `default` (`fg`),
`markup.heading`/`markup.heading.1`/`markup.heading.2` (`accent`, bold), `markup.bold`/`markup.strong`
(`fg`, bold), `markup.italic` (`fg`, italic), `markup.list`/`markup.quote` (`muted`), `markup.raw`
(`add`), `markup.link`/`markup.link.url` (`accent2`), `comment` (`muted`, italic), `keyword` (`accent`,
bold), `string` (`add`), `number` (`warn`).

**`diffColorProps`'s 13-key shape** (`packages/code/src/theme/syntax.ts`): `fg` (`tokens.fg`), `addedSignColor`/
`removedSignColor` (`tokens.add`/`tokens.del`), `lineNumberFg` (`tokens.muted`), `lineNumberBg`/
`contextBg`/`contextContentBg` (`tokens.bgElev`), `addedContentBg`/`removedContentBg` (a 0.16 mix of
`tokens.add`/`tokens.del` into `tokens.bg`), `addedBg`/`addedLineNumberBg` and `removedBg`/
`removedLineNumberBg` (a 0.28 mix of the same pair into `tokens.bg` — the stronger gutter tint sits
on the same two mix amounts §8 discusses for `surfaces.ts`).

## 4. Behavior

### Theme resolution and application (`packages/code/src/theme/theme.ts`)

1. `createTheme(caps, source)` builds three memos: `mode = resolveMode(source(), caps.themeBg())`
   (`packages/code/src/theme/theme.ts`), `resolved = resolveTokens(source(), mode())` (`packages/code/src/theme/theme.ts`), `background =
   resolveBackground(source())` (`packages/code/src/theme/theme.ts`).
2. A Solid effect re-runs on every change to `resolved()`/`background()`: it calls
   `setThemedMixBase(map.bg)` first, then `applyResolvedTokens` with `map.bg` replaced by
   `TERMINAL_BG` when `background() === "terminal"` (`packages/code/src/theme/theme.ts`). Order matters here: the mix
   base must be set to the *real* resolved `bg` **before** the tokens signal itself is set to the
   `TERMINAL_BG` sentinel, or `mixHex` would have no real color to substitute for it.
3. `applyResolvedTokens` (`packages/code/src/theme/tokens.ts`) runs `untrack`+`batch` and only calls a signal setter
   when the new value differs from the current one, so applying an unchanged theme produces zero
   Solid re-renders.

### `mixHex` and the `TERMINAL_BG` sentinel (`packages/code/src/theme/model.ts`)

`TERMINAL_BG = "transparent"` is not a parseable color. Any `mixHex(base, tint, amount)` call whose
`base === TERMINAL_BG` substitutes the module-level `themedMixBase()` signal instead
(`packages/code/src/theme/model.ts`), which is kept in sync by `theme.ts`'s effect calling `setThemedMixBase(map.bg)`
every resolution (step 2 above). `mixHex` returns `base` unchanged if either color fails to parse
(`packages/code/src/theme/model.ts`).

### Surface washes track live theme swaps (INV-266)

`focusBg()` and `selectionBg()` are literally the same expression (`mixHex(tokens.bg, tokens.accent,
0.16)`), and `userBandBg()` is one step further on the same accent wash
(`mixHex(tokens.bg, tokens.accent, 0.18)`) — `packages/code/src/theme/surfaces.ts`, pinned equal/distinct by
`packages/code/tests/unit/theme-surfaces.test.ts`. None of the surface functions memoize: they read
`tokens.*` getters on every call, so swapping the active theme (dark → light) changes every wash's
next-computed value without any explicit re-subscription (`packages/code/tests/unit/theme-surfaces.test.ts`).
Under a `"terminal"` background, `tokens.bg` itself reads as the literal string `"transparent"`, yet
every wash still parses to a real color because they mix off `themedMixBase()`, not off
`tokens.bg` directly (`packages/code/tests/unit/theme-surfaces.test.ts`).

### `SourceBadge`'s origin mapping (`packages/code/src/ui/primitives/badges.tsx`)

| `origin` prop | Rendered label | `fg` |
| --- | --- | --- |
| `"shadow"` | `glyph("superscriptW") + glyph("prime") + glyph("superscriptG")` (a composite `W'G`) | `tokens.warn` |
| `"workspace"` | `glyph("superscriptW")` | `tokens.muted` |
| `"global"` | `glyph("superscriptG")` | `tokens.muted` |
| anything else | the string verbatim | `tokens.muted` |

`ThemeView`'s only consumer, `SwatchFieldRow` (`packages/code/src/views/config/ThemeView.tsx`), never passes `"shadow"`
directly — it first runs a `TokenSource`/precedence string through its own `badgeOrigin`
(`packages/code/src/views/config/ThemeView.tsx`), which maps `"override-workspace"` → `"workspace"`, `"override-global"` →
`"global"`, `"preset"` → `"preset"`, and `"family"` → `"family"`. The last two fall through
`SourceBadge`'s "anything else" branch and render as the literal text `"preset"`/`"family"` rather
than a superscript glyph, since `SourceBadge` only special-cases `"shadow"`/`"workspace"`/`"global"`.

### `SyntaxStyle` lifecycle (`theme/syntax.ts`)

1. `syntaxStyle` is a `createRoot`-scoped `Accessor` (`packages/code/src/theme/syntax.ts`): a Solid effect rebuilds a
   fresh `SyntaxStyle.fromStyles(...)` (`buildSyntaxStyle`, `packages/code/src/theme/syntax.ts`) whenever the tokens it
   reads change, and calls `retireStyle` on the **previous** instance rather than destroying it
   immediately.
2. `retireStyle` (`packages/code/src/theme/syntax.ts`): if no renderer is bound yet (`rendererBindings.size === 0`,
   true for a direct component test that never mounted the `App` renderer binding), the style is
   pushed to `unboundRetired` and the queue is trimmed to at most 2 by immediately destroying the
   oldest (`packages/code/src/theme/syntax.ts`) — this avoids both leaking every preview generation and destroying a
   style a still-unbound test renderer may hold this very frame. Otherwise, it is retired against
   **every currently bound renderer's** `lastFrame + 2` (`packages/code/src/theme/syntax.ts`).
3. `bindSyntaxStyleRenderer(renderer)` (`packages/code/src/theme/syntax.ts`) registers a `"frame"` listener that
   updates `lastFrame` and calls `flushRetiredStyles` each frame; `flushRetiredStyles`
   (`packages/code/src/theme/syntax.ts`) destroys a retired style only once **every** target renderer bound to it has
   reached its recorded target frame. Returns a disposer that must run before/during renderer
   teardown (per the function's own doc comment, `packages/code/src/theme/syntax.ts`).
4. `destroyStyle` is idempotent via a `WeakSet` guard (`packages/code/src/theme/syntax.ts`).
5. Verified end-to-end: a superseded style still answers `.ptr` after one rendered frame, and throws
   after a second (`packages/code/tests/integration/syntax-style-lifecycle.test.tsx`) — i.e. destruction is
   deferred exactly two frames past supersession, not zero and not indefinitely.

### `ThemeView`'s edit/preview/commit cycle (`views/config/ThemeView.tsx`)

1. On mount, `host.bindScope({ mode: "retarget" })` (`packages/code/src/views/config/ThemeView.tsx`) and three memos derive
   `mode`, `preset`, `background` from `preview.source()` (`packages/code/src/views/config/ThemeView.tsx`). `ThemeView` is a
   four-level `LevelHost` (`main`/`preview`/`contrast`/`depth`, `Sub`, `packages/code/src/views/config/ThemeView.tsx`).
2. The **main level** has `ROW_COUNT = 3 + TOKEN_ORDER.length + 3` rows (`packages/code/src/views/config/ThemeView.tsx`, 15
   rows for the 9-token `TOKEN_ORDER`), and `activateMain` (`packages/code/src/views/config/ThemeView.tsx`) dispatches by row
   index: row 0 opens an enum editor for `mode`, row 1 for `preset`, row 2 for `background`
   (`packages/code/src/views/config/ThemeView.tsx`); the middle `TOKEN_ORDER.length` rows call `editToken` on the
   corresponding token; and the last three rows push the `"Contrast"` level, push the
   `"Depth"` level, and call `toggleAscii()`, in that order.
3. **`previewBesideControls()`** (`dimensions().width >= 100`, `packages/code/src/views/config/ThemeView.tsx`) gates whether the
   `main` level renders `SpecimenPane` inline beside the controls pane or leaves it reachable only by
   pushing the `"Preview"` level; it also hides the `p`/"preview" verb entirely once true, since the
   pane is already visible (`when: () => !previewBesideControls()`, `packages/code/src/views/config/ThemeView.tsx`).
4. **`SpecimenPane`** (`packages/code/src/views/config/ThemeView.tsx`) is the live style mockup shown by both the `main`
   level's side pane and the pushed `"preview"` level (`readOnly: true`, `packages/code/src/views/config/ThemeView.tsx`): a
   bordered box with the mini wordmark, a body/headline/accent/link text sample, a sub-agent card
   whose border and dot use `resolved().subagent[0]` and whose second line renders every
   `resolved().subagent` ramp color, and added/removed/warning/muted sample lines — every color drawn
   straight from `tokens`/`resolved()`, so it re-renders on any token change.
5. Editing a token (`editToken`, `packages/code/src/views/config/ThemeView.tsx`) opens a text field editor seeded with the
   current resolved value; on submit, `parseColor` validates the input — an unparseable value is
   rejected with a notify and **no** state change (`packages/code/src/views/config/ThemeView.tsx`) — and calls
   `preview.set(host.scope(), { overrides: { [mode()]: { [token]: v.trim() } } })`, marking the host
   dirty (`packages/code/src/views/config/ThemeView.tsx`).
6. `resetToken` (`packages/code/src/views/config/ThemeView.tsx`) sets that token's override to `undefined` in the patch,
   which (per `mergeThemeBlock`, §3) deletes it from the merged result rather than leaving it
   "unset, keep base" as a no-op would.
7. The ASCII toggle (`toggleAscii`, `packages/code/src/views/config/ThemeView.tsx`) stages a **pending** `{ scope, value }`
   pair, calls `applyAsciiMode(next)` immediately for a live preview, marks dirty, and notifies —
   the persisted write happens only on save (`host.onSave`, `packages/code/src/views/config/ThemeView.tsx`) via
   `deps.code.writeAscii(staged.scope, staged.value)`. `host.onCancel`
   (`packages/code/src/views/config/ThemeView.tsx`) reverts the live ascii preview back to
   `deps.code.asciiEnabled()` (the persisted value) if a toggle was staged but not saved. Verified:
   `packages/code/tests/integration/theme-view-render.test.tsx` — writes are `[]` until `runSave()`,
   `[true]` after.
8. `fixContrast` (`packages/code/src/views/config/ThemeView.tsx`) reads the currently selected `ContrastResult`, does
   nothing if it is already `"AA"`/`"AAA"`, else nudges the failing foreground token against its
   audited background — and then **also** re-nudges the result against every *other* background the
   same foreground token is audited on, so a single "fix" does not silently regress a different pair
   sharing that foreground (`packages/code/src/views/config/ThemeView.tsx`, exercised end to end at
   `packages/code/tests/integration/theme-view-render.test.tsx`, which asserts the nudged `warn` value
   clears AA against **both** `bg` and `bg-elev`). `ContrastPane` (`packages/code/src/views/config/ThemeView.tsx`) colors and
   labels each audited pair via `levelTone`/`levelBadge` (`packages/code/src/views/config/ThemeView.tsx`): `"fail"` → tone
   `"error"`, `"AA-large"` → tone `"warn"` and relabeled `"AA large"` (a space, not the hyphenated
   `ContrastLevel` spelling), `"AA"`/`"AAA"` → tone `"ok"`. Its header appends
   `" · audit vs themed bg (terminal bg unknown)"` when `background() === "terminal"`
   (`packages/code/src/views/config/ThemeView.tsx`) — the one user-facing statement that a contrast audit under a
   `"terminal"` background never actually measures the real terminal background, only the themed
   stand-in `mixHex` substitutes for it (§4 "`mixHex` and the `TERMINAL_BG` sentinel").
9. Each token row in the main level is rendered by `SwatchFieldRow` (`packages/code/src/views/config/ThemeView.tsx`), which
   derives its `SourceBadge` origin from the token's `TokenSource` via `badgeOrigin`
   (`packages/code/src/views/config/ThemeView.tsx`; mapping in §4 "`SourceBadge`'s origin mapping" above).
10. Depth preview (`DepthPane`, `packages/code/src/views/config/ThemeView.tsx`) is explicitly read-only
    (`{ readOnly: true }`, `packages/code/src/views/config/ThemeView.tsx`) and is captioned "preview only" — it quantizes the
    *current* tokens through `quantize` at each of the four `ColorDepth`s for a fixed set of key
    tokens (`accent, fg, add, warn, del`, `packages/code/src/views/config/ThemeView.tsx`); it never mutates the live detected
    depth, which the pane's own text calls "authoritative" (`packages/code/src/views/config/ThemeView.tsx`).

### `--ascii` flag → runtime effect

`--ascii` is parsed as a bare boolean flag into `Mode.ascii` for `run`/`resume`/`continue`
(`packages/code/src/cli-args.ts`). Outside this document's primary scope but load-bearing for its
effect: `src/index.tsx` applies `mode.ascii` before the startup frame, then `src/runtime.tsx` retains
it as `asciiFlag` and, in an effect keyed
on `appearanceRevision`, calls `applyAsciiMode(asciiFlag || input.code.asciiEnabled())`
(`packages/code/src/runtime.tsx`, `createWorkspaceAdapters`) — i.e. the CLI flag and the persisted
`ui.ascii` setting OR together, so passing
`--ascii` once does not have to also flip the persisted setting to take effect for that run.

### `MemoryPressureBanner`'s phase → visual mapping (`packages/code/src/views/MemoryPressureBanner.tsx`)

| `state().phase` | `visible()` | `blocked()` | `detail()` text |
| --- | --- | --- | --- |
| `"armed"` | false (hidden) | — | — |
| `"disabled"` | false (hidden) | — | — |
| `"warning"` | true | false | "High memory use; finish or cancel expensive work if it keeps rising." |
| `"aborting"` | true | true | "Memory limit reached; aborting active work while the TUI stays alive." |
| `"tripped"` | true | true | "Work is blocked. Recover memory to rebuild the backend." |
| `"recovering"` | true | true | "Rebuilding the backend and releasing runtime resources." |
| `"cooling"` | true | true | "Backend rebuilt; waiting for three safe RSS samples. /clear can clear the transcript." |

(`visible`: `packages/code/src/views/MemoryPressureBanner.tsx`; `blocked`: `detail`:.) The banner's
foreground color is `tokens.del` when `blocked()`, else `tokens.warn` (`packages/code/src/views/MemoryPressureBanner.tsx`);
its glyph is `glyph("error")` when blocked, else `glyph("warning")` (`packages/code/src/views/MemoryPressureBanner.tsx`).
The full rendered header line is not just `detail()`: it also live-renders current RSS against the
limit — `` `${glyph} Memory ${gib(rss)} / ${gib(limitBytes)} · ${detail()}` `` — via `gib()`
(`packages/code/src/views/MemoryPressureBanner.tsx`). Only in the `"tripped"` phase is a "Recover memory (/recover-memory)"
affordance rendered, and it is wired only as `onMouseDown={props.onRecover}`
(`packages/code/src/views/MemoryPressureBanner.tsx`) — nothing in this file gives it a keybinding; the `/recover-memory`
text names a slash-command path, but whether that command is wired to the same handler elsewhere is
not determined from this file (see §8). `MemoryPressureSnapshot`'s phase enum itself and what drives
its transitions are defined in `adapters/memory-pressure.ts`, outside this document's scope.

## 5. Invariants

1. **INV-247 (owned).** Thirteen specifically named source files
   (`src/adapters/code-config.ts`, `src/adapters/guard-mode.ts`, `src/adapters/session-store.ts`,
   `src/adapters/settings.ts`, and ten config-view `.tsx` files —
   `AgentsPanel.tsx`, `DoctorView.tsx`, `MarketplaceBrowser.tsx`, `McpBrowser.tsx`,
   `RunControlsPanel.tsx`, `SandboxConfigPanel.tsx`, `ThemeView.tsx`,
   `WorkflowsHub.tsx`, `view-host.tsx`) contain **zero** non-ASCII characters (codepoint `> 0x7f`)
   outside comments. Production files: `views/config/ThemeView.tsx` (in this document's scope) plus the
   twelve listed above (mostly owned by sibling documents, listed here because the rule spans all
   thirteen as one set). Test: `packages/code/tests/architecture/ascii-source-boundary.test.ts`, list. The practical consequence for this document: `ThemeView.tsx` may render a glyph only by
   calling `glyph(name)`/`borderChars()` from `theme/glyphs.ts` — never a literal Unicode character —
   confirmed against the source (§2/§4 above): every glyph reference in `ThemeView.tsx` goes
   through `glyph(...)` (e.g. `packages/code/src/views/config/ThemeView.tsx...`).

2. **INV-266 (owned).** The terminal theme's surface-intent colors sit on one accent-wash mixing
   scale: `focusBg() === selectionBg()` and `userBandBg()` is a distinct, one-step-further wash on
   the same base (`packages/code/src/theme/surfaces.ts`), and every one of those derived colors re-tracks a live theme
   swap rather than freezing at its first computed value (no memoization in `surfaces.ts` — every
   function reads `tokens.*` fresh on each call). Test:
   `packages/code/tests/unit/theme-surfaces.test.ts` (equality/distinctness),
   `packages/code/tests/unit/theme-surfaces.test.ts` (tracks a dark→light swap).

3. **(Derived) Subagent colors are always nudged to at least AA-large (3-to-1) contrast against the
   resolved `bg`, for every preset and mode.** Production: `resolveTokens`'s subagent loop calls
   `nudgeToAA(ov?.[name] ?? ramp[i], out.bg)` unconditionally (`packages/code/src/theme/model.ts`). Test:
   `packages/code/tests/unit/theme-contrast.test.ts` ("every subagent ramp entry clears AA-large against its
   resolved bg, per preset and mode").

4. **(Derived) `applyResolvedTokens` is a no-op write when the value is unchanged.** Production:
   each signal setter is guarded by `if (cur !== next) sig(next)` (`packages/code/src/theme/tokens.ts`). Unpinned by a
   direct "zero re-renders" assertion in the read tests, but the mechanism is unambiguous from the
   code; `theme-surfaces.test.ts` and `theme-reactive.test.ts` both rely on (without directly
   asserting) repeated `applyResolvedTokens` calls being safe to issue on every theme resolution.

5. **(Derived) A superseded native `SyntaxStyle` is destroyed exactly two rendered frames after
   being retired, never zero and never left to leak.** Production:
   `retireStyle`/`flushRetiredStyles` (`packages/code/src/theme/syntax.ts`). Test:
   `packages/code/tests/integration/syntax-style-lifecycle.test.tsx` (`.ptr` survives one frame, throws
   after a second).

6. **(Derived) Every `MARKS` entry's `ascii` form is itself pure ASCII, and both forms are
   non-empty.** Production: `MARKS` table (`packages/code/src/core/marks.ts`). Test:
   `packages/code/tests/unit/glyphs.test.ts` ("every registry entry has a unicode form and a pure-ascii
   form").

7. **(Derived) `glyphColWidth` returns the wider of a glyph's two forms regardless of the current
   ascii mode**, so layout code that must line up in both modes can reserve a fixed column width.
   Production: `packages/code/src/theme/glyphs.ts` (`Math.max(g.ascii.length, g.unicode.length)`, no dependency on the
   `ascii` signal). Test: `packages/code/tests/unit/glyphs.test.ts`.

8. **(Derived) An unparseable color submitted through `ThemeView`'s token editor is rejected with a
   notification and produces no state mutation** — the preview is never called with an invalid
   value. Production: `editToken`'s `if (!rgba) { deps.notify(...); return; }` guard
   (`packages/code/src/views/config/ThemeView.tsx`). Unpinned: no test in this document's scope asserts the "no mutation" half
   directly (only that valid colors do mutate); the guard is visible in the source alone.

9. **INV-297 (owned). `createTheme` wires a live `"terminal"`-background config end to end, and
   washes track a preset change under it exactly as they do under `"themed"`.** Production: the
   `createTheme` effect (`packages/code/src/theme/theme.ts`) and `surfaces.ts`'s live `mixHex` reads. Test:
   `packages/code/tests/unit/theme-surfaces.test.ts` ("createTheme wires terminal mode end to end and washes
   track the themed preset") — asserts `tokens.bg === TERMINAL_BG` throughout, that `userBandBg()`
   changes when the config's `preset` changes to `"mono"` under `background: "terminal"` and matches
   `mixHex` against the *mono* family's `bg` (not the sentinel), and that switching `background` back
   off `"terminal"` restores `tokens.bg` to the resolved family value.

10. **INV-295 (owned).** The surface-intent washes are pinned to *exact* mixing constants, not merely
    to relative ordering: `selectionBg()` and `focusBg()` are both `mixHex(bg, accent, 0.16)`,
    `userBandBg()` is `mixHex(bg, accent, 0.18)`, `ruleColor()` is `mixHex(bg, muted, 0.55)` and
    `scrimColor()` is `mixHex(bg, "#000000", 0.5)`. Production:
    `packages/code/src/theme/surfaces.ts`. Test:
    `packages/code/tests/unit/theme-surfaces.test.ts`, restated against the themed base. A change to any constant is therefore a visible diff to this test, not a silent shift
    in how the UI reads.

11. **INV-296 (owned).** Under a `"terminal"` background the `bg` token *is* the sentinel
    `TERMINAL_BG` (`"transparent"`) while every derived wash still mixes off the **themed** base:
    `mixHex` substitutes `setThemedMixBase`'s value whenever its `base` is the sentinel, so
    `selectionBg`, `focusBg`, `userBandBg`, `ruleColor`, `scrimColor` and both scrollbar colors stay
    parseable colors instead of degrading to the literal string `"transparent"`. Production:
    `packages/code/src/theme/model.ts`. Test:
    `packages/code/tests/unit/theme-surfaces.test.ts` — the closing loop asserts
    `parseColor(wash)` is non-null for all seven, which is the assertion that would catch a wash
    silently returning the sentinel.

## 6. Failure modes and degradation

- **Unparseable color input** (`parseColor` returns `null`): `editToken` notifies
  `` `unparseable color: ${v}` `` and returns without touching `preview` or `host.markDirty`
  (`packages/code/src/views/config/ThemeView.tsx`) — no throw, no partial write.
- **`mixHex` given an unparseable `base` or `tint`**: returns `base` unchanged rather than throwing
  or producing `NaN`-laced output (`packages/code/src/theme/model.ts`); pinned by
  `packages/code/tests/unit/theme-model.test.ts` (`mixHex("nope", "#ffffff", 0.5)` → `"nope"`).
- **`nudgeToAA` unable to reach `target` within 100 lightness steps**: returns the *best* candidate
  found so far rather than the original or a failure value — never worse than the input contrast
  (`packages/code/src/theme/contrast.ts`).
- **`retireStyle` called before any renderer has bound** (`rendererBindings.size === 0`, the
  documented case of a direct component test that never mounted the `App`): styles are queued in
  `unboundRetired` and trimmed to at most 2 by eagerly destroying the oldest, rather than either
  leaking unboundedly or destroying a style a test renderer might still be holding this frame
  (`packages/code/src/theme/syntax.ts`, comment states the reasoning explicitly).
- **`destroyStyle` called twice on the same style** (e.g. once from a delayed retirement flush and
  once from teardown): guarded idempotent by a `WeakSet`, so a double-destroy is silently absorbed
  rather than throwing (`packages/code/src/theme/syntax.ts`).
- **`filetypeFor` given a path with no recognized extension, or `undefined`**: falls back to
  `"text"` rather than throwing or guessing (`packages/code/src/theme/syntax.ts`).
- **`quantize` given an out-of-range `ColorDepth`**: the function is exhaustive over the four
  literal `ColorDepth` values with no `default`/`else` branch beyond the final `nearest256` fallthrough,
  so an invalid depth outside the `ColorDepth` union is a type-level impossibility rather than a
  handled runtime case — not determinable whether a widened/`any` caller could reach an unhandled
  path (see §8).
- **A staged ASCII toggle is cancelled** (`host.onCancel`, `packages/code/src/views/config/ThemeView.tsx`): the live preview
  is reverted to the persisted `deps.code.asciiEnabled()` value and the pending stage is cleared —
  nothing is ever written to disk for a cancelled edit.

## 7. Coupling

**Depends on** (runtime imports, this document's own files):

| From | To | Nature | Cite |
| --- | --- | --- | --- |
| `theme/model.ts` | `core/theme-types.ts` | type + value (`SUBAGENT_ORDER`, `depthFromCapabilities`) | `packages/code/src/theme/model.ts` |
| `theme/model.ts` | `theme/glyphs.ts` (`glyph`) | value, for `tokenUsedIn`'s separator | `packages/code/src/theme/model.ts` |
| `theme/model.ts` | `theme/contrast.ts` (`nudgeToAA`) | value | `packages/code/src/theme/model.ts` |
| `theme/model.ts` | `theme/color.ts` | value (parse/convert) | `packages/code/src/theme/model.ts` |
| `theme/glyphs.ts` | `core/marks.ts` | value + type, wraps in a Solid signal | `packages/code/src/theme/glyphs.ts` |
| `theme/tokens.ts` | `core/theme-types.ts` | type + value (`SUBAGENT_ORDER`) | `packages/code/src/theme/tokens.ts` |
| `theme/contrast.ts` | `theme/tokens.ts` (`SUBAGENT_ORDER`), `theme/color.ts` | value | `packages/code/src/theme/contrast.ts` |
| `theme/surfaces.ts` | `theme/tokens.ts` (`tokens`), `theme/model.ts` (`mixHex`) | value | `packages/code/src/theme/surfaces.ts` |
| `theme/tone.ts` | `theme/glyphs.ts`, `theme/tokens.ts` | value | `packages/code/src/theme/tone.ts` |
| `theme/syntax.ts` | `@opentui/core` (`SyntaxStyle`, `CliRenderer`), `theme/tokens.ts`, `theme/model.ts` (`mixHex`) | value, external package | `packages/code/src/theme/syntax.ts` |
| `theme/theme.ts` | `../adapters/code-config.ts` (`mergeEffectiveTheme`, `mergeThemeBlock`, `CodeConfigStore`) | value + type — **theme reaches into `adapters/`**, permitted because no architecture-boundary rule restricts `theme/`'s own outbound imports (only what may import *into* `core`/`ui`/`adapters` is restricted; see INV-243–245 in [hosts/code-bootstrap.md](code-bootstrap.md)) | `packages/code/src/theme/theme.ts` |
| `theme/theme.ts` | `../keys/commands.ts` (`Scope` type) | type-only | `packages/code/src/theme/theme.ts` |
| `ui/primitives/*` | `theme/tokens.ts`, `theme/glyphs.ts`, `theme/surfaces.ts`, `theme/tone.ts` | value | e.g. `packages/code/src/ui/primitives/selectable-row.tsx` |
| `views/brand.tsx` | `theme/tokens.ts`, `theme/model.ts` (`mixHex`), `theme/contrast.ts` (`nudgeToAA`), `theme/glyphs.ts` | value | `packages/code/src/views/brand.tsx` |
| `views/MemoryPressureBanner.tsx` | `theme/tokens.ts`, `theme/glyphs.ts`, `adapters/memory-pressure.ts` (type only, out of scope) | value + type | `packages/code/src/views/MemoryPressureBanner.tsx` |
| `views/config/ThemeView.tsx` | almost the entire `theme/` surface, plus `views/brand.tsx` (`MINI_WORDMARK`), `views/config/view-host.tsx` (out of scope, delegated) | value | `packages/code/src/views/config/ThemeView.tsx` |

**What is FORCED, not just observed:**

- `core/**` is architecturally **forbidden** from importing `theme/**` (or `ui/`, `views/`,
  `adapters/`, `infrastructure/`) — enforced by
  `packages/code/tests/architecture/architecture-boundary.test.ts`, which walks every static/dynamic/type-only
  import under `src/core` and fails if any resolves into those layers. This is why `core/marks.ts`
  (this document's mark table) is written with zero Solid/OpenTUI/adapter imports (verified against the
  source: `packages/code/src/core/marks.ts` imports nothing) — `theme/glyphs.ts` exists specifically to be the
  Solid-aware wrapper `core/**` itself is barred from being.
- `features/**/controller.ts` files are architecturally **forbidden** from importing `theme/**` (or
  `ui/`, `views/`, any `.tsx`) — `packages/code/tests/architecture/architecture-boundary.test.ts`
  (INV-246, owned by **code-bootstrap-and-app-shell**). Feature controllers therefore cannot reach into this document's color/glyph API directly;
  any themed rendering they need must happen in a `.tsx` view layered above them.
- The `ascii-source-boundary` test (`ascii-source-boundary.test.ts`) forces `ThemeView.tsx` to route
  every rendered glyph through `theme/glyphs.ts`'s `glyph()`/`borderChars()` — a hard-coded Unicode
  literal anywhere in that file (outside a comment) fails the suite (INV-247).
- `theme/theme.ts` importing `adapters/code-config.ts` is a real, unresisted dependency (nothing in
  the architecture-boundary suite constrains `theme/`'s own outbound edges) — so this document's
  `ThemePreview` type is intimately coupled to `CodeConfigStore`'s shape (`ThemeConfig`, `Scope`,
  `themeAt`/`writeTheme`) even though that adapter's persistence mechanics belong to a sibling document.

**Depended on by** (consumers outside this document's file set):

- `views/tools/registry.tsx` imports `diffColorProps`, `filetypeFor`, `syntaxStyle` from
  `theme/syntax.ts` (`packages/code/src/views/tools/registry.tsx`, delegated to [hosts/code-transcript.md](code-transcript.md)).
- `views/App.tsx` imports and invokes `bindSyntaxStyleRenderer`, and separately owns the memory-pressure
  controller that it passes into `TranscriptRegion`; `App.tsx` does not import or mount
  `MemoryPressureBanner` directly
  (`packages/code/src/views/App.tsx`; delegated to
  [hosts/code-bootstrap.md](code-bootstrap.md)).
- `src/runtime.tsx` calls `createTheme`, reads/writes `tokens.bg`, and drives `applyAsciiMode` from the
  combined CLI-flag/persisted-setting value (`packages/code/src/runtime.tsx`,
  `createWorkspaceAdapters`; delegated to
  [hosts/code-bootstrap.md](code-bootstrap.md)).
- `ui/patterns/**` (delegated to [hosts/code-keyboard.md](code-keyboard.md)) supplies the layout/keybinding
  scaffolding `ThemeView.tsx` builds on (`registerLevel`, `LevelHost`, `bindLevelKeys` — imported at
  `packages/code/src/views/config/ThemeView.tsx`), the reverse direction of the coupling table above.
- `adapters/code-config.ts` (delegated to a sibling document) imports `glyph` from `core/marks.ts`
  directly rather than from `theme/glyphs.ts` (`packages/code/src/adapters/code-config.ts`) — the one place in this document's scope
  that resolves a mark through the non-reactive module flag instead of the reactive Solid signal;
  since `core/marks.ts` also exports its own `glyph` as a `@deprecated` alias for `mark` (§2), the two
  identically-named functions genuinely differ in reactivity, and which one a file gets depends on
  which module it imports from.

## 8. Open questions

- **Why these exact mixing amounts** (0.16 for selection/focus and for the diff add/remove content
  tint, 0.18 for the user band, 0.22/0.35 for scrollbar track/thumb, 0.28 for the diff gutters, 0.5
  for the scrim) were chosen is not stated anywhere in the source or tests — they are simply the
  constants in `surfaces.ts`/`syntax.ts` (§3 "`diffColorProps`'s 13-key shape"). The tests pin that
  focus/selection are the *same* constant and that the user band is a *different, larger* one, but
  never explain the specific numbers.
- **Why `nudgeToAA`'s default `target` is 4.5 (WCAG AA) while the subagent ramp is only checked
  against 3 (AA-large)** in `packages/code/tests/unit/theme-contrast.test.ts` is visible as two different call sites
  using two different targets, but no comment or test name states the rationale for accepting a
  lower bar specifically for the subagent ramp.
- **Whether any caller can actually reach `quantize` with a `ColorDepth` value outside the closed
  union** (e.g. via an `any`-typed boundary from JSON settings) is not settled by the source —
  the function has no `default`/exhaustiveness-guard branch, relying entirely on the type system.
- **The full settings/schema validation path for `ThemeConfig`** (whether a malformed `code.json`
  `theme` block is rejected, coerced, or passed through as-is) lives in `adapters/code-config.ts` and
  whatever schema layer sits above it — that file is read here only far enough to establish the
  `ThemeConfig`/`ui.ascii` data shape (§3); its validation behavior is a sibling document's concern
  (likely [hosts/code-settings-panels.md](code-settings-panels.md), though no file in this document's scope explicitly assigns
  `code-config.ts` to that document).
- **`MemoryPressureSnapshot`'s phase state machine** (what drives `"armed"` → `"warning"` →
  `"aborting"` → `"tripped"` → `"recovering"` → `"cooling"` → back to `"armed"`/`"disabled"`, and the
  `rearmBytes`/`warningBytes`/`limitBytes` thresholds referenced in the banner's own `gib()`
  formatting) lives in `adapters/memory-pressure.ts`, outside this document's scope; only
  the banner component's own phase→visual mapping (§4) is specified here.
- **Layout/keybinding mechanics `ThemeView.tsx` depends on** (`registerLevel`, `LevelHost`,
  `bindLevelKeys`, `createFieldEditor`, the `Sub`-level push/pop navigation, `useTerminalDimensions`)
  are `ui/patterns/**` and `views/config/view-host.tsx` concerns, explicitly delegated to
  [hosts/code-keyboard.md](code-keyboard.md) per this document's scope statement — described here only as call sites,
  not as mechanisms.
- **Tree-sitter grammar loading** behind `filetypeFor`'s filetype ids (which grammars are bundled,
  how `getTreeSitterClient`/`preloadParser` resolve a filetype id to an actual parser) is explicitly
  delegated to [cross-cutting/build-and-ci.md](../cross-cutting/build-and-ci.md) and is not described beyond the extension→id mapping
  table itself (`packages/code/src/theme/syntax.ts`).
- No test in this document's scope directly exercises `theme/color.ts`'s `parseColor`/`hslToRgb`/`rgbToHsl`
  round-trip **failure modes** beyond the one "garbage input" case in
  `packages/code/tests/unit/theme-model.test.ts` (`parseColor` on `"not a color"`/`""`) — malformed but
  partially-matching inputs (e.g. `rgb(999,999,999)`, `hsl(0,150%,50%)`) are clamped by `clampByte`
  where the regex matches at all, but no test asserts this for the HSL percentage path specifically.
- **Whether the "Recover memory" affordance has any keyboard-triggerable equivalent.**
  `MemoryPressureBanner.tsx` itself wires it only as `onMouseDown={props.onRecover}`
  (`packages/code/src/views/MemoryPressureBanner.tsx`) — the component has no visible key handler for it, and whether
  `onRecover` (or the `/recover-memory` command its label names) is also reachable from a keybinding
  is decided by this component's caller, outside this document's scope.
