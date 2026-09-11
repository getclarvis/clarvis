/**
 * Deciding which build of the TUI the `clarvis` command should run.
 *
 * @remarks
 * The launcher in `cli.ts` is invisible to coverage — Bun instruments only the
 * test process, and `coverage.ts` allowlists the file for that reason —
 * so the decision lives here, as a pure function over already-gathered facts,
 * and the launcher only performs it.
 *
 * Running the bundle rather than the sources is worth roughly 2.5 s a launch:
 * from source Bun transpiles the 847-file graph and applies the Solid JSX
 * transform through Babel on every start, which `tooling/artifact/build.ts` does once.
 */

/** Facts the launcher gathers before {@link resolveEntry} can choose. */
export interface EntryInputs {
  /** Absolute path of the built bundle. */
  distPath: string;
  /** Whether that bundle is present. */
  distExists: boolean;
  /** Whether the operator asked for the sources with `CLARVIS_CODE_SOURCE=1`. */
  forceSource: boolean;
}

/** What the launcher should do. */
export type EntryChoice =
  { kind: "dist" } | { kind: "source" } | { kind: "error"; message: string };

/** Private process entry selected before ordinary user-facing argument parsing. */
export function privateEntry(argv: readonly string[]): "remote-kernel" | undefined {
  return argv[0] === "--remote-kernel" ? "remote-kernel" : undefined;
}

/**
 * Choose between the built bundle, the sources, and refusing with an explanation.
 *
 * @param inputs - the gathered filesystem and environment facts.
 * @returns the choice; `error` carries the complete stderr text, including the
 * commands that fix it, because a missing bundle must never reach the user as a
 * module-resolution failure.
 */
export function resolveEntry(inputs: EntryInputs): EntryChoice {
  if (inputs.forceSource) return { kind: "source" };
  if (inputs.distExists) return { kind: "dist" };
  return {
    kind: "error",
    message: [
      `clarvis: no build found at ${inputs.distPath}`,
      "",
      "  build it:                     bun --filter @clarvis/code build",
      "  or reinstall:                 bun run setup",
      "  or run from source (slower):  CLARVIS_CODE_SOURCE=1 clarvis",
    ].join("\n"),
  };
}
