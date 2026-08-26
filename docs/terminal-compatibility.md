# Terminal compatibility and accessibility

> Understand Clarvis terminal requirements, compatibility controls, and the current accessibility boundaries.

Clarvis is a full-screen terminal application built with OpenTUI. Terminal emulators differ in
keyboard reporting, Unicode width, color, clipboard integration, and mouse behavior, so the project
documents observed behavior separately from configured release targets.

## Baseline

- Interactive mode requires a real PTY and enough rows and columns to render the interface.
- GNU/glibc Linux, macOS, and Windows x64/arm64 archives are available for `v0.0.1-beta`. All six
  native package and install-smoke jobs passed. Alpine and other musl-only Linux distributions are
  not portable-release targets for this beta.
- The Linux and macOS release jobs assert first paint under a real PTY. Windows release smoke asserts
  the manifest and CLI fast paths; native Windows PTY first paint remains manually unverified.
- `clarvis -p` is the text-oriented alternative for scripts, limited terminals, and assistive
  workflows that cannot use the full-screen interface.

When reporting a rendering or input problem, include the operating system, architecture, terminal
name and version, shell, multiplexer or remote hop, keyboard layout, window size, and whether
`--ascii` changes the result.

## Glyphs and color

Clarvis uses Unicode glyphs by default. Start with `clarvis --ascii` when a font or terminal renders
boxes, misaligns columns, or lacks expected symbols. The ASCII switch changes glyph selection rather
than transliterating model output.

`NO_COLOR` is honored for color-disabled environments. Color is not intended to be the only carrier
of status, but contrast has not yet been certified against a formal accessibility target. Terminal
themes remain user-controlled.

## Keyboard input

The footer and `/help` show the active, context-aware bindings. Prefer those surfaces over a static
online keymap. Modern terminals can report modified keys differently, and Clarvis selects a keyboard
profile from observed terminal capabilities.

If a shortcut fails:

1. close nested menus with `Esc` and try the context's displayed binding;
2. test outside `tmux`, `screen`, SSH, or an IDE terminal to isolate translation;
3. check the terminal's application-key and Alt/Option settings;
4. include the keyboard layout and exact terminal in a sanitized bug report.

## Remote terminals and multiplexers

SSH and terminal multiplexers are valid deployment routes when they preserve a capable PTY, window
resize events, and keyboard sequences. Image or clipboard features may degrade independently. Use
`--ascii` and `NO_COLOR=1` for a conservative presentation, and `-p` when the remote environment is
not suitable for a full-screen UI.

## Screen readers and reduced-motion needs

The first beta has not completed a screen-reader compatibility audit. Full-screen terminal repaint,
focus layers, and dynamic transcript updates may be difficult for some assistive technologies.
Headless `clarvis -p --format text` or `--format md` is the current non-curses alternative, but it is
not presented as equivalent accessibility coverage.

There is no public claim of formal WCAG conformance for the TUI. Accessibility defects and concrete
terminal/assistive-technology combinations are welcome through the bug form.

## Platform limitations

Current Windows gaps include unverified local `!bash` behavior and platform-specific process/monitor
output differences. Consult [Troubleshooting](/operations/troubleshooting) before diagnosing a
cross-platform failure. The release checklist requires native evidence rather than inferring support
from a successful Linux build.
