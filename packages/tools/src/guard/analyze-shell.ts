import type { ShellDialect } from "./dialect.ts";
import { currentDialect } from "./dialects/index.ts";
import type { ShellFacts, Segment, ShellAnalysisIssue } from "./types.ts";

/**
 * Statically analyze a shell command into the {@link ShellFacts} a guard reasons
 * over: the filesystem paths it appears to touch, its per-command
 * {@link Segment}s, and whether the whole thing is safe to decide on.
 *
 * @param command - the raw shell string to analyze.
 * @param dialect - the shell syntax to parse it as. Must be the dialect the
 *   executor will actually run the command through; passing one that does not
 *   match the host is how a guard comes to analyze a language nobody runs.
 * @returns {@link ShellFacts} with deduplicated `paths` (glob operands reduced to
 *   their literal directory prefix), the parsed `segments`, and an
 *   `undecidable` flag.
 * @remarks
 * This is the shared driver: it owns path deduplication, `Segment` assembly and
 * the `undecidable` fold, so those invariants cannot be reimplemented per
 * dialect. Everything syntactic - splitting, tokenizing, expansions, opaque
 * commands, path shapes - comes from the {@link ShellDialect}.
 *
 * `undecidable` is `true` when the string is unbalanced, any segment is not
 * decidable, or a token is {@link PathCandidate} `opaque` - a `~user`
 * reference, an upward-traversing glob, or another operand the dialect
 * recognizes as addressing something it cannot pin down. Callers must treat an
 * undecidable result as "unknown", never as workspace-confined. This is a
 * best-effort heuristic for approval decisions, not a shell parser.
 *
 * It is also `true` when a segment reduces to an empty `argv` *and* recorded no
 * env assignments. Since {@link ShellDialect.split} drops whitespace-only
 * segments, that means exactly "the source said something and the front end
 * produced no command" — a tokenizer failure. A `NAME=value` assignment-only
 * segment is not a failure: `normalize` recorded the bindings. This matters
 * because a guard matches its deny list against `Segment.normalized`, and does
 * so before consulting `undecidable`: an empty `normalized` matches no deny
 * entry, so without this the deny list would silently stop biting wherever a
 * dialect's tokenizer came up empty. Degrading `allow` to `ask` is acceptable;
 * degrading `deny` to `ask` is not.
 */
export function analyzeShell(
  command: string,
  dialect: ShellDialect = currentDialect(),
): ShellFacts {
  const { segments: sources, balanced } = dialect.split(command);
  if (!balanced && sources.length === 0) sources.push(command);
  const rewritten = dialect.analyzeSources?.(command, sources);
  const views =
    rewritten !== undefined && rewritten.length === sources.length ? rewritten : sources;

  const segments: Segment[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const [index, source] of sources.entries()) {
    const view = views[index] ?? source;
    const tokens = dialect.tokenize(view);
    const { argv, envAssignments } = dialect.normalize(tokens.map((t) => t.text));
    const analysisIssues: ShellAnalysisIssue[] = (dialect.analysisIssues?.(view) ?? []).map(
      (issue) => ({ ...issue, segmentIndex: index }),
    );
    if (!dialect.decidable(view) && analysisIssues.length === 0) {
      analysisIssues.push({ segmentIndex: index, kind: "tokenizer_gap", impact: "control_flow" });
    }
    if (argv.length === 0 && envAssignments.length === 0) {
      analysisIssues.push({ segmentIndex: index, kind: "tokenizer_gap", impact: "executable" });
    }
    if (!balanced && index === sources.length - 1) {
      analysisIssues.push({
        segmentIndex: index,
        kind: "unbalanced_syntax",
        impact: "control_flow",
      });
    }
    segments.push({
      command: source,
      argv,
      normalized: argv.join(" "),
      envAssignments,
      decidable: analysisIssues.length === 0,
      analysisIssues,
    });
    for (const token of tokens) {
      const candidate = dialect.pathCandidate(token);
      if (candidate.kind === "opaque") {
        analysisIssues.push({ segmentIndex: index, kind: "opaque_path", impact: "path" });
        segments[index]!.decidable = false;
        continue;
      }
      if (candidate.kind === "none") continue;
      if (seen.has(candidate.value)) continue;
      seen.add(candidate.value);
      paths.push(candidate.value);
    }
  }

  const analysisIssues = segments.flatMap((segment) => segment.analysisIssues);
  return { paths, undecidable: analysisIssues.length > 0, segments, analysisIssues };
}
