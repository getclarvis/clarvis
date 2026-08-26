import { describe, expect, it } from "bun:test";
import { analyzeShell } from "../../src/guard/analyze-shell.ts";
import type { PathCandidate, ShellDialect } from "../../src/guard/dialect.ts";
import { posixDialect } from "../../src/guard/dialects/posix.ts";

/**
 * A dialect that understands nothing in particular, used to prove the driver's
 * invariants hold for *any* front end rather than incidentally for POSIX.
 */
const stub: ShellDialect = {
  flavor: "posix",
  split: (c) => ({ segments: c ? [c] : [], balanced: true }),
  tokenize: () => [{ text: "X", glob: false }],
  decidable: () => true,
  normalize: (tokens) => ({ argv: tokens, envAssignments: [] }),
  pathCandidate: () => ({ kind: "none" }),
};

const withDialect = (over: Partial<ShellDialect>): ShellDialect => ({ ...stub, ...over });

describe("analyzeShell — the driver carries no dialect syntax", () => {
  it("extracts no paths a dialect did not report", () => {
    const facts = analyzeShell("cat /etc/passwd", stub);
    expect(facts.paths).toEqual([]);
    expect(facts.segments.map((s) => s.normalized)).toEqual(["X"]);
  });

  it("propagates an unbalanced split as undecidable", () => {
    const dialect = withDialect({ split: (c) => ({ segments: [c], balanced: false }) });
    expect(analyzeShell("anything", dialect).undecidable).toBe(true);
  });

  it("treats an opaque token as undecidable and contributes no path", () => {
    const dialect = withDialect({ pathCandidate: (): PathCandidate => ({ kind: "opaque" }) });
    const facts = analyzeShell("anything", dialect);
    expect(facts.undecidable).toBe(true);
    expect(facts.paths).toEqual([]);
  });

  it("deduplicates paths across segments, keeping first-seen order", () => {
    const dialect = withDialect({
      split: (c) => ({ segments: c.split(";"), balanced: true }),
      tokenize: (s) => [{ text: s.trim(), glob: false }],
      pathCandidate: (t): PathCandidate => ({ kind: "path", value: t.text }),
    });
    expect(analyzeShell("b; a; b", dialect).paths).toEqual(["b", "a"]);
  });
});

describe("analyzeShell — a segment that tokenizes to nothing is undecidable", () => {
  // The guard matches its deny list against `Segment.normalized`, and does so
  // BEFORE the undecidable check. A dialect whose tokenizer yields nothing
  // therefore produces an empty `normalized` that no deny entry can match, and
  // the deny list silently stops biting. Degrading `allow` to `ask` is
  // acceptable; degrading `deny` to `ask` hands the user exactly the decisions
  // they configured never to be asked about.
  //
  // The fold below is what makes that unrepresentable for every dialect, present
  // and future. Deleting it turns these red.
  it("catches a tokenizer that returns nothing at all", () => {
    const dialect = withDialect({ ...posixDialect, tokenize: () => [] });
    const facts = analyzeShell("rm -rf /", dialect);
    expect(facts.segments).toHaveLength(1);
    expect(facts.segments[0]!.normalized).toBe("");
    expect(facts.undecidable).toBe(true);
  });

  it.each([["()"], ["''"], ['""'], ["FOO=bar"], ["timeout 5"]])(
    "catches the POSIX source %p, which reduces to no command at all",
    (command) => {
      const facts = analyzeShell(command, posixDialect);
      expect(facts.segments[0]!.normalized).toBe("");
      expect(facts.undecidable).toBe(true);
    },
  );

  it("leaves an ordinary command decidable", () => {
    const facts = analyzeShell("ls -la", posixDialect);
    expect(facts.undecidable).toBe(false);
    expect(facts.segments[0]!.normalized).toBe("ls -la");
  });

  it("marks the whole command undecidable when only one segment is empty", () => {
    const facts = analyzeShell("ls && ''", posixDialect);
    expect(facts.segments.map((s) => s.normalized)).toEqual(["ls", ""]);
    expect(facts.undecidable).toBe(true);
  });
});
