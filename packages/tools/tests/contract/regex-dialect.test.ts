import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { makeWorkspace, cleanup, makeConfig, callTool, write } from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

// `grep` runs one of two regex engines and the caller does not choose which:
// `packages/tools/src/lib/rg.ts` sends a confined directory to the in-process
// JavaScript scanner and everything else to ripgrep. The two do not share a
// grammar, so a pattern's meaning depends on the engine that ran.
//
// This file is the BOUNDARY, written down as executable documentation. Every
// row below was measured by running the real `grep` tool through both engines
// (ripgrep 15.2.0, Bun 1.3.11) and records what each one actually answered. It
// asserts today's behaviour and changes none of it: a construct that later
// converges, diverges further, or changes its answer in either engine turns a
// row red, which is the point.
//
// The table is a SAMPLED diff of two grammars, not a proof. A construct absent
// from it is unclassified, never "portable".

/**
 * Sentinel for "the tool refuses this pattern with `invalid_input`". No real
 * grep output can collide with it.
 */
const REFUSED = "\u0000refused" as const;

type Grade =
  /** Both engines accept the pattern and return the same matches. */
  | "shared"
  /** JavaScript accepts it; ripgrep refuses it as a parse error. */
  | "js_only"
  /** ripgrep accepts it; JavaScript refuses it as a syntax error. */
  | "rg_only"
  /** Neither engine accepts it; no configuration of `grep` can run it. */
  | "neither"
  /** Both engines accept it and answer DIFFERENTLY. The silent-wrong-answer class. */
  | "divergent"
  /**
   * Both engines accept it and answer differently only on non-ASCII input:
   * JavaScript's `\d`/`\w`/`\b` and its `i` folding are ASCII, ripgrep's are
   * Unicode. Split out from `divergent` because it is a property of the class
   * escapes themselves, not of a construct one engine misreads.
   */
  | "unicode_class";

interface Row {
  readonly label: string;
  readonly pattern: string;
  readonly subject: string;
  readonly ignoreCase?: boolean;
  readonly grade: Grade;
  /** Exact `content` output from the in-process engine, or {@link REFUSED}. */
  readonly js: string;
  /** Exact `content` output from ripgrep, or {@link REFUSED}. */
  readonly rg: string;
}

const ROWS: readonly Row[] = [
  // ---------------------------------------------------------------- shared --
  // The portable core. Anything here means the same thing whichever engine ran.
  {
    label: "named group, JavaScript spelling",
    pattern: "(?<w>foo)",
    subject: "foo\nbar\n",
    grade: "shared",
    js: "s.txt:1:foo",
    rg: "s.txt:1:foo",
  },
  {
    label: "inline flags as a scoped group",
    pattern: "(?i:FOO)",
    subject: "foo\nbar\n",
    grade: "shared",
    js: "s.txt:1:foo",
    rg: "s.txt:1:foo",
  },
  {
    label: "non-capturing group with alternation",
    pattern: "(?:fo|ba)o",
    subject: "foo\nbao\nzz\n",
    grade: "shared",
    js: "s.txt:1:foo\ns.txt:2:bao",
    rg: "s.txt:1:foo\ns.txt:2:bao",
  },
  {
    label: "bounded repetition",
    pattern: "o{2,3}",
    subject: "foo\nfo\n",
    grade: "shared",
    js: "s.txt:1:foo",
    rg: "s.txt:1:foo",
  },
  {
    label: "lazy quantifier",
    pattern: "f.*?o",
    subject: "fzzo\nbar\n",
    grade: "shared",
    js: "s.txt:1:fzzo",
    rg: "s.txt:1:fzzo",
  },
  {
    label: "negated class with a range",
    pattern: "[^a-z]",
    subject: "abc\nA9\n",
    grade: "shared",
    js: "s.txt:2:A9",
    rg: "s.txt:2:A9",
  },
  {
    label: "escaped metacharacter",
    pattern: "a\\.b",
    subject: "a.b\naxb\n",
    grade: "shared",
    js: "s.txt:1:a.b",
    rg: "s.txt:1:a.b",
  },
  {
    label: "escaped ] inside a class",
    pattern: "[\\]]",
    subject: "a]b\nplain\n",
    grade: "shared",
    js: "s.txt:1:a]b",
    rg: "s.txt:1:a]b",
  },
  {
    label: "trailing literal dash in a class",
    pattern: "[a-]",
    subject: "a\n-\nz\n",
    grade: "shared",
    js: "s.txt:1:a\ns.txt:2:-",
    rg: "s.txt:1:a\ns.txt:2:-",
  },
  {
    label: "leading literal dash in a class",
    pattern: "[-a]",
    subject: "a\n-\nz\n",
    grade: "shared",
    js: "s.txt:1:a\ns.txt:2:-",
    rg: "s.txt:1:a\ns.txt:2:-",
  },
  {
    label: "anchors around alternation",
    pattern: "^(foo|bar)$",
    subject: "foo\nbarx\n",
    grade: "shared",
    js: "s.txt:1:foo",
    rg: "s.txt:1:foo",
  },
  {
    label: "unescaped } is a literal in both",
    pattern: "a}b",
    subject: "a}b\nazb\n",
    grade: "shared",
    js: "s.txt:1:a}b",
    rg: "s.txt:1:a}b",
  },
  {
    label: "unescaped ] outside a class is a literal in both",
    pattern: "a]b",
    subject: "a]b\nazb\n",
    grade: "shared",
    js: "s.txt:1:a]b",
    rg: "s.txt:1:a]b",
  },
  {
    label: "\\d on ASCII digits",
    pattern: "a\\d",
    subject: "a1\nab\n",
    grade: "shared",
    js: "s.txt:1:a1",
    rg: "s.txt:1:a1",
  },
  {
    label: "\\s on an ASCII space",
    pattern: "a\\sb",
    subject: "a b\nab\n",
    grade: "shared",
    js: "s.txt:1:a b",
    rg: "s.txt:1:a b",
  },
  {
    label: "\\s is Unicode-aware in BOTH: no-break space",
    pattern: "a\\sb",
    subject: "a\u00a0b\nazb\n",
    grade: "shared",
    js: "s.txt:1:a\u00a0b",
    rg: "s.txt:1:a\u00a0b",
  },
  {
    label: "\\s is Unicode-aware in BOTH: ideographic space",
    pattern: "a\\sb",
    subject: "a\u3000b\nazb\n",
    grade: "shared",
    js: "s.txt:1:a\u3000b",
    rg: "s.txt:1:a\u3000b",
  },
  {
    label: "\\S agrees on a non-ASCII letter",
    pattern: "caf\\S",
    subject: "caf\u00e9\ncaf.\n",
    grade: "shared",
    js: "s.txt:1:caf\u00e9\ns.txt:2:caf.",
    rg: "s.txt:1:caf\u00e9\ns.txt:2:caf.",
  },
  {
    label: "\\v is a vertical tab in both",
    pattern: "a\\vb",
    subject: "avb\nazb\n",
    grade: "shared",
    js: "(no matches)",
    rg: "(no matches)",
  },
  {
    label: "\\uXXXX (four hex digits, no braces)",
    pattern: "\\u263A",
    subject: "\u263a\nu263A\n",
    grade: "shared",
    js: "s.txt:1:\u263a",
    rg: "s.txt:1:\u263a",
  },
  {
    label: "ignore_case folds Greek sigma in both",
    pattern: "\u03a3",
    subject: "\u03c3\nq\n",
    ignoreCase: true,
    grade: "shared",
    js: "s.txt:1:\u03c3",
    rg: "s.txt:1:\u03c3",
  },
  {
    label: "ignore_case expands neither sharp s",
    pattern: "ss",
    subject: "\u00df\nqq\n",
    ignoreCase: true,
    grade: "shared",
    js: "(no matches)",
    rg: "(no matches)",
  },
  {
    label: "escaped [ - the portable spelling of [[]",
    pattern: "\\[",
    subject: "arr[0]\nplain\n",
    grade: "shared",
    js: "s.txt:1:arr[0]",
    rg: "s.txt:1:arr[0]",
  },
  {
    label: "escaped [ inside a class - the other portable spelling of [[]",
    pattern: "[\\[]",
    subject: "arr[0]\nplain\n",
    grade: "shared",
    js: "s.txt:1:arr[0]",
    rg: "s.txt:1:arr[0]",
  },
  {
    label: "escaped dollar and digit class",
    pattern: "\\$\\d",
    subject: "$5\nx5\n",
    grade: "shared",
    js: "s.txt:1:$5",
    rg: "s.txt:1:$5",
  },

  // --------------------------------------------------------------- js_only --
  // JavaScript answers; ripgrep refuses the pattern outright. These reach the
  // caller as `invalid_input` whenever the engine happens to be ripgrep - which
  // under production defaults is decided by the `path` argument alone.
  {
    label: "lookahead",
    pattern: "foo(?=bar)",
    subject: "foobar\nfoobaz\n",
    grade: "js_only",
    js: "s.txt:1:foobar",
    rg: REFUSED,
  },
  {
    label: "negative lookahead",
    pattern: "foo(?!bar)",
    subject: "foobar\nfoobaz\n",
    grade: "js_only",
    js: "s.txt:2:foobaz",
    rg: REFUSED,
  },
  {
    label: "lookbehind",
    pattern: "(?<=foo)bar",
    subject: "foobar\nxxbar\n",
    grade: "js_only",
    js: "s.txt:1:foobar",
    rg: REFUSED,
  },
  {
    label: "negative lookbehind",
    pattern: "(?<!foo)bar",
    subject: "foobar\nxxbar\n",
    grade: "js_only",
    js: "s.txt:2:xxbar",
    rg: REFUSED,
  },
  {
    label: "numeric backreference",
    pattern: "(o)\\1",
    subject: "foo\nfox\n",
    grade: "js_only",
    js: "s.txt:1:foo",
    rg: REFUSED,
  },
  {
    label: "named backreference \\k<name>",
    pattern: "(?<w>o)\\k<w>",
    subject: "foo\nfox\n",
    grade: "js_only",
    js: "s.txt:1:foo",
    rg: REFUSED,
  },
  {
    label: "\\Z",
    pattern: "foo\\Z",
    subject: "foo\nfooZ\n",
    grade: "js_only",
    js: "s.txt:2:fooZ",
    rg: REFUSED,
  },
  {
    label: "\\cX control escape",
    pattern: "\\cA",
    subject: "ab\ncA\n",
    grade: "js_only",
    js: "(no matches)",
    rg: REFUSED,
  },
  {
    label: "\\0 NUL escape",
    pattern: "a\\0",
    subject: "a b\na0\n",
    grade: "js_only",
    js: "(no matches)",
    rg: REFUSED,
  },
  {
    label: "\\101 octal escape",
    pattern: "\\101",
    subject: "A\nz\n",
    grade: "js_only",
    js: "s.txt:1:A",
    rg: REFUSED,
  },
  {
    label: "\\Q (identity escape in JavaScript, unknown to Rust)",
    pattern: "\\Qfoo",
    subject: "Qfoo\nfoo\n",
    grade: "js_only",
    js: "s.txt:1:Qfoo",
    rg: REFUSED,
  },
  {
    label: "\\h (identity escape in JavaScript, unknown to Rust)",
    pattern: "a\\hb",
    subject: "ahb\na b\n",
    grade: "js_only",
    js: "s.txt:1:ahb",
    rg: REFUSED,
  },
  {
    label: "\\q - the whole unknown-\\<alpha> family is js_only",
    pattern: "a\\qb",
    subject: "aqb\nab\n",
    grade: "js_only",
    js: "s.txt:1:aqb",
    rg: REFUSED,
  },
  {
    label: "\\e - same family",
    pattern: "a\\eb",
    subject: "aeb\nazb\n",
    grade: "js_only",
    js: "s.txt:1:aeb",
    rg: REFUSED,
  },
  {
    label: "\\N - same family",
    pattern: "a\\Nb",
    subject: "aNb\naxb\n",
    grade: "js_only",
    js: "s.txt:1:aNb",
    rg: REFUSED,
  },
  {
    label: "\\G - same family",
    pattern: "\\Gfoo",
    subject: "foo\nGfoo\n",
    grade: "js_only",
    js: "s.txt:2:Gfoo",
    rg: REFUSED,
  },
  {
    // The ordinary way to match a literal `[`. It is NOT ambiguous and it is
    // NOT a divergence: JavaScript answers correctly and ripgrep refuses to
    // parse it. Refusing this pattern would remove a search that works today.
    label: "[[] - literal [ via an unclosable nested class",
    pattern: "[[]",
    subject: "arr[0]\nplain\n",
    grade: "js_only",
    js: "s.txt:1:arr[0]",
    rg: REFUSED,
  },
  {
    label: "[a[b] - nested [ ripgrep cannot close",
    pattern: "[a[b]",
    subject: "x[y\nzaz\n",
    grade: "js_only",
    js: "s.txt:1:x[y\ns.txt:2:zaz",
    rg: REFUSED,
  },
  {
    label: "a[]b - empty class (JavaScript: matches nothing)",
    pattern: "a[]b",
    subject: "ab\na[]b\n",
    grade: "js_only",
    js: "(no matches)",
    rg: REFUSED,
  },
  {
    label: "a{,3} - not a quantifier, so JavaScript reads a literal brace",
    pattern: "a{,3}",
    subject: "a{,3}\naaa\n",
    grade: "js_only",
    js: "s.txt:1:a{,3}",
    rg: REFUSED,
  },
  {
    label: "a{b - unterminated brace, literal in JavaScript",
    pattern: "a{b",
    subject: "a{b\nazb\n",
    grade: "js_only",
    js: "s.txt:1:a{b",
    rg: REFUSED,
  },
  {
    label: "[a-\\d] - class range ending in a class escape",
    pattern: "[a-\\d]",
    subject: "a\n5\n",
    grade: "js_only",
    js: "s.txt:1:a\ns.txt:2:5",
    rg: REFUSED,
  },

  // --------------------------------------------------------------- rg_only --
  // ripgrep answers; JavaScript refuses. These reach the caller as
  // `invalid_input` on every confined directory search.
  {
    label: "(?P<name>...) Rust-flavoured named group",
    pattern: "(?P<w>foo)",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "(?i) unscoped inline flag",
    pattern: "(?i)FOO",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "(?i)(?s) several unscoped inline flags",
    pattern: "(?i)(?s)FOO",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "(?u) Unicode flag",
    pattern: "(?u)foo",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "(?-i) negated inline flag",
    pattern: "(?-i)foo",
    subject: "foo\nFOO\n",
    ignoreCase: true,
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "(?x) extended/whitespace-insensitive mode",
    pattern: "(?x) f o o",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "possessive *+",
    pattern: "fo*+",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "possessive ++",
    pattern: "fo++",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "possessive {n,m}+",
    pattern: "fo{1,2}+",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },
  {
    label: "doubled repetition fo**",
    pattern: "fo**",
    subject: "foo\nbar\n",
    grade: "rg_only",
    js: REFUSED,
    rg: "s.txt:1:foo",
  },

  // --------------------------------------------------------------- neither --
  // No configuration of `grep` runs these. Recorded so nobody documents them
  // as belonging to one engine.
  {
    // Corrects an earlier claim that `(?P=name)` is ripgrep syntax. The Rust
    // regex crate has no backreferences at all, so it rejects this too.
    label: "(?P=name) backreference - rejected by BOTH",
    pattern: "(?P<w>o)(?P=w)",
    subject: "foo\nfox\n",
    grade: "neither",
    js: REFUSED,
    rg: REFUSED,
  },
  {
    label: "(?#comment) - rejected by BOTH",
    pattern: "(?#c)foo",
    subject: "foo\nbar\n",
    grade: "neither",
    js: REFUSED,
    rg: REFUSED,
  },
  {
    label: "(?>...) atomic group - rejected by BOTH",
    pattern: "(?>foo)",
    subject: "foo\nbar\n",
    grade: "neither",
    js: REFUSED,
    rg: REFUSED,
  },
  {
    label: "(?(1)...) conditional - rejected by BOTH",
    pattern: "(?(1)a|b)",
    subject: "a\nb\n",
    grade: "neither",
    js: REFUSED,
    rg: REFUSED,
  },

  // ------------------------------------------------------------- divergent --
  // Both engines compile the pattern and answer DIFFERENTLY. Nothing reports
  // this to the caller: the answer is simply wrong for one of the two readings.
  {
    label: "\\A - start-of-haystack anchor to ripgrep, literal A to JavaScript",
    pattern: "\\Afoo",
    subject: "foobar\nAfoo\n",
    grade: "divergent",
    js: "s.txt:2:Afoo",
    rg: "s.txt:1:foobar",
  },
  {
    label: "\\A alone",
    pattern: "\\A",
    subject: "abc\n",
    grade: "divergent",
    js: "(no matches)",
    rg: "s.txt:1:abc",
  },
  {
    label: "\\z - end-of-haystack anchor to ripgrep, literal z to JavaScript",
    pattern: "foo\\z",
    subject: "foo\nfooz\n",
    grade: "divergent",
    js: "s.txt:2:fooz",
    rg: "s.txt:1:foo",
  },
  {
    label: "\\p{L} - Unicode property to ripgrep, literal p{L} to JavaScript",
    pattern: "caf\\p{L}",
    subject: "caf\u00e9\ncafp{L}\n",
    grade: "divergent",
    js: "s.txt:2:cafp{L}",
    rg: "s.txt:1:caf\u00e9\ns.txt:2:cafp{L}",
  },
  {
    label: "\\P{L} - negated Unicode property",
    pattern: "a\\P{L}",
    subject: "a1\naP{L}\n",
    grade: "divergent",
    js: "s.txt:2:aP{L}",
    rg: "s.txt:1:a1",
  },
  {
    label: "\\pL - one-letter Unicode property",
    pattern: "caf\\pL",
    subject: "caf\u00e9\ncafpL\n",
    grade: "divergent",
    js: "s.txt:2:cafpL",
    rg: "s.txt:1:caf\u00e9\ns.txt:2:cafpL",
  },
  {
    label: "\\p{...} inside a character class",
    pattern: "[\\p{L}]{3}",
    subject: "abc\np{L}\n",
    grade: "divergent",
    js: "s.txt:2:p{L}",
    rg: "s.txt:1:abc",
  },
  {
    label: "\\x{...} braced codepoint",
    pattern: "\\x{263A}",
    subject: "\u263a\nx{263A}\n",
    grade: "divergent",
    js: "s.txt:2:x{263A}",
    rg: "s.txt:1:\u263a",
  },
  {
    label: "\\u{...} braced codepoint",
    pattern: "\\u{1F600}",
    subject: "\u{1F600}\nu{1F600}\n",
    grade: "divergent",
    js: "s.txt:2:u{1F600}",
    rg: "s.txt:1:\u{1F600}",
  },
  {
    label: "[[:alpha:]] POSIX class",
    pattern: "[[:alpha:]]{4}",
    subject: "abcd\na]a]\n",
    grade: "divergent",
    js: "(no matches)",
    rg: "s.txt:1:abcd",
  },
  {
    // The silent false negative: JavaScript reads an empty class followed by a
    // literal `]`, which can never match; ripgrep reads a class containing `]`.
    label: "[]] - ] as the first class member",
    pattern: "[]]",
    subject: "arr[0]\nplain\n",
    grade: "divergent",
    js: "(no matches)",
    rg: "s.txt:1:arr[0]",
  },
  {
    label: "[^]] - ] as the first member of a negated class",
    pattern: "[^]]",
    subject: "ab\n]]\n",
    grade: "divergent",
    js: "s.txt:2:]]",
    rg: "s.txt:1:ab",
  },
  {
    label: "\\< \\> - word boundaries to ripgrep since 14, literal <> to JavaScript",
    pattern: "\\<foo\\>",
    subject: "a foo b\n<foo>\n",
    grade: "divergent",
    js: "s.txt:2:<foo>",
    rg: "s.txt:1:a foo b\ns.txt:2:<foo>",
  },
  {
    label: "\\b{start} - named boundary assertion to ripgrep",
    pattern: "\\b{start}foo",
    subject: "a foo b\nx{start}foo\n",
    grade: "divergent",
    js: "s.txt:2:x{start}foo",
    rg: "s.txt:1:a foo b\ns.txt:2:x{start}foo",
  },
  {
    label: "[a&&b] class intersection",
    pattern: "[a-z&&[^b-y]]",
    subject: "az\n&[^]\n",
    grade: "divergent",
    js: "s.txt:2:&[^]",
    rg: "s.txt:1:az",
  },
  {
    label: "[+--] class difference vs a JavaScript range",
    pattern: "[+--]",
    subject: "a+b\na,b\na-b\n",
    grade: "divergent",
    js: "s.txt:1:a+b\ns.txt:2:a,b\ns.txt:3:a-b",
    rg: "s.txt:1:a+b",
  },
  {
    label: "[[abc]d] - a nested class BOTH engines compile",
    pattern: "[[abc]d]",
    subject: "ad\nbd\nxd]\n",
    grade: "divergent",
    js: "(no matches)",
    rg: "s.txt:1:ad\ns.txt:2:bd\ns.txt:3:xd]",
  },

  // ---------------------------------------------------------- unicode_class --
  // JavaScript's `\d`, `\D`, `\w`, `\W`, `\b`, `\B`, its `.` and its `i`
  // folding are ASCII; ripgrep's are Unicode. Identical on ASCII input, which
  // is why these are not "broken" - only engine-dependent on the rest.
  // `\s`/`\S` are NOT in this family: both engines agree there (see `shared`).
  {
    label: "\\d and a non-ASCII digit",
    pattern: "\\d",
    subject: "\u0663\n7\n",
    grade: "unicode_class",
    js: "s.txt:2:7",
    rg: "s.txt:1:\u0663\ns.txt:2:7",
  },
  {
    label: "\\D and a non-ASCII digit",
    pattern: "\\D",
    subject: "\u0663\n7\n",
    grade: "unicode_class",
    js: "s.txt:1:\u0663",
    rg: "(no matches)",
  },
  {
    label: "\\w and a non-ASCII letter",
    pattern: "caf\\w",
    subject: "caf\u00e9\ncafe\n",
    grade: "unicode_class",
    js: "s.txt:2:cafe",
    rg: "s.txt:1:caf\u00e9\ns.txt:2:cafe",
  },
  {
    label: "\\W and a non-ASCII letter",
    pattern: "caf\\W",
    subject: "caf\u00e9\ncaf!\n",
    grade: "unicode_class",
    js: "s.txt:1:caf\u00e9\ns.txt:2:caf!",
    rg: "s.txt:2:caf!",
  },
  {
    label: "\\b before a non-ASCII letter",
    pattern: "\\b\u00e9",
    subject: "\u00e9 x\n",
    grade: "unicode_class",
    js: "(no matches)",
    rg: "s.txt:1:\u00e9 x",
  },
  {
    label: "\\B before a non-ASCII letter",
    pattern: "x\\B",
    subject: "x\u00e9\nx y\n",
    grade: "unicode_class",
    js: "(no matches)",
    rg: "s.txt:1:x\u00e9",
  },
  {
    label: ". spans a whole astral codepoint only in ripgrep",
    pattern: "^.$",
    subject: "\u{1F600}\na\n",
    grade: "unicode_class",
    js: "s.txt:2:a",
    rg: "s.txt:1:\u{1F600}\ns.txt:2:a",
  },
  {
    label: "ignore_case folds KELVIN SIGN only in ripgrep",
    pattern: "k",
    subject: "\u212a\nq\n",
    ignoreCase: true,
    grade: "unicode_class",
    js: "(no matches)",
    rg: "s.txt:1:\u212a",
  },
  {
    label: "ignore_case folds LATIN SMALL LETTER LONG S only in ripgrep",
    pattern: "s",
    subject: "\u017f\nq\n",
    ignoreCase: true,
    grade: "unicode_class",
    js: "(no matches)",
    rg: "s.txt:1:\u017f",
  },
];

const rgAvailable = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

/**
 * The grade a row's two measured answers imply, so a hand-written `grade` can
 * never disagree with the outcomes recorded beside it. `unicode_class` is a
 * named subset of `divergent`.
 */
function impliedGrade(js: string, rg: string): Grade {
  if (js === REFUSED && rg === REFUSED) return "neither";
  if (js === REFUSED) return "rg_only";
  if (rg === REFUSED) return "js_only";
  return js === rg ? "shared" : "divergent";
}

async function runRow(row: Row, config: ServerConfig): Promise<string> {
  const result = await callTool(
    "grep",
    {
      pattern: row.pattern,
      output_mode: "content",
      ...(row.ignoreCase ? { ignore_case: true } : {}),
    },
    config,
  );
  if (result.isError) {
    expect((result.json as { error?: string }).error).toBe("invalid_input");
    return REFUSED;
  }
  return result.text;
}

describe("regex dialect boundary", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  /** In-process JavaScript engine: no ripgrep, so this runs on every host. */
  const jsConfig = () => makeConfig(root, { ripgrepAvailable: false, confineToWorkspace: false });
  /** ripgrep over an unconfined directory. */
  const rgConfig = () => makeConfig(root, { ripgrepAvailable: true, confineToWorkspace: false });

  describe("the table describes itself", () => {
    it("every row's grade matches the outcomes recorded beside it", () => {
      for (const row of ROWS) {
        const expected = row.grade === "unicode_class" ? "divergent" : row.grade;
        expect(`${row.label}: ${impliedGrade(row.js, row.rg)}`).toBe(`${row.label}: ${expected}`);
      }
    });

    it("no grade is empty, so the enumeration cannot decay into one class", () => {
      const counts = new Map<Grade, number>();
      for (const row of ROWS) counts.set(row.grade, (counts.get(row.grade) ?? 0) + 1);
      for (const grade of [
        "shared",
        "js_only",
        "rg_only",
        "neither",
        "divergent",
        "unicode_class",
      ] as const) {
        expect(`${grade}=${(counts.get(grade) ?? 0) > 0}`).toBe(`${grade}=true`);
      }
    });

    it("no case is enumerated twice", () => {
      const keys = ROWS.map((r) => [r.pattern, r.subject, r.ignoreCase ? "i" : ""].join("\u0000"));
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("no label is used twice", () => {
      expect(new Set(ROWS.map((r) => r.label)).size).toBe(ROWS.length);
    });
  });

  describe("the two configurations really select different engines", () => {
    it("the JavaScript configuration refuses ripgrep-only syntax", async () => {
      write(root, "s.txt", "foo\n");
      expect(await runRow({ ...ROWS[0]!, pattern: "(?P<w>foo)" }, jsConfig())).toBe(REFUSED);
    });

    it.skipIf(!rgAvailable)(
      "the ripgrep configuration refuses JavaScript-only syntax",
      async () => {
        write(root, "s.txt", "foobar\n");
        expect(await runRow({ ...ROWS[0]!, pattern: "foo(?=bar)" }, rgConfig())).toBe(REFUSED);
      },
    );
  });

  describe("what the in-process JavaScript engine does", () => {
    for (const row of ROWS) {
      it(`${row.grade}: ${row.label}`, async () => {
        write(root, "s.txt", row.subject);
        expect(await runRow(row, jsConfig())).toBe(row.js);
      });
    }
  });

  describe.skipIf(!rgAvailable)("what ripgrep does", () => {
    for (const row of ROWS) {
      it(`${row.grade}: ${row.label}`, async () => {
        write(root, "s.txt", row.subject);
        expect(await runRow(row, rgConfig())).toBe(row.rg);
      });
    }
  });
});
