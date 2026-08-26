import { describe, expect, test } from "bun:test";

import {
  createGrepScanner,
  isBoundedPattern,
  GREP_AMBIGUITY_MAX,
  GREP_LINE_MAX,
  GREP_QUERY_MAX_CHARS,
  GREP_SCAN_MAX_LINES,
  GREP_SCAN_MAX_MS,
  GREP_WINDOW_OVERLAP,
  matchWindowed,
} from "../../src/text/grep.ts";
import {
  DEFAULT_MIN_LENGTH,
  DEFAULT_STOPWORDS,
  DOC_MAX_CHARS,
  DOC_MAX_TOKENS,
  QUERY_MAX_CHARS,
  QUERY_MAX_TOKENS,
  overlapScore,
  tokenCounts,
  tokenList,
  tokenize,
  tokenizeQuery,
} from "../../src/text/tokenize.ts";

describe("tokenList", () => {
  test("keeps accented Portuguese words whole", () => {
    // The old tokenizer split on [^a-z0-9_], so `configuração` became
    // `configura` + `o` and `não` vanished entirely.
    expect(tokenList("configuração")).toEqual(["configuracao"]);
    expect(tokenList("cobrança recorrente")).toEqual(["cobranca", "recorrente"]);
    expect(tokenList("São Paulo")).toEqual(["paulo"]);
  });

  test("folds Latin diacritics so unaccented typing matches accented text", () => {
    expect(tokenList("configuração de cobrança")).toEqual(tokenList("configuracao de cobranca"));
    expect(tokenList("memória")).toEqual(tokenList("memoria"));
    expect(tokenList("índice")).toEqual(tokenList("indice"));
  });

  test("keeps combining marks attached when their base is not ASCII", () => {
    // Devanagari matras are phonemic — folding them would merge distinct words.
    expect(tokenList("का काम")).toEqual(["का", "काम"]);
  });

  test("keeps a decomposed dotted i as one token", () => {
    // "İ".toLowerCase() is `i` + U+0307, which NFKC does not recompose.
    expect(tokenList("İstanbul")).toEqual(["istanbul"]);
    expect(tokenList("i̇stanbul")).toEqual(["istanbul"]);
  });

  test("applies NFKC compatibility folding", () => {
    expect(tokenList("ﬁle")).toEqual(["file"]);
    expect(tokenList("①②")).toEqual(["12"]);
  });

  test("keeps identifiers whole and splits on punctuation", () => {
    expect(tokenList("bun_test")).toEqual(["bun_test"]);
    expect(tokenList("v1.3.14")).toEqual(["v1", "14"]);
    expect(tokenList("@clarvis/memory")).toEqual(["clarvis", "memory"]);
  });

  test("drops function words in both languages", () => {
    expect(tokenList("the build is in the workspace")).toEqual(["build", "workspace"]);
    expect(tokenList("o comando de build está no workspace")).toEqual([
      "comando",
      "build",
      "workspace",
    ]);
  });

  test("folds an accented function word onto its stopword form", () => {
    // `está` folds to `esta`; both are Portuguese function words, so the fold
    // costs no meaning and the stopword list only has to carry one spelling.
    expect(tokenList("está")).toEqual([]);
    expect(tokenList("não")).toEqual([]);
  });

  test("admits two-character technical terms", () => {
    // The old minLength of 3 dropped all of these.
    expect(tokenList("ci db ui go qa s3")).toEqual(["ci", "db", "ui", "go", "qa", "s3"]);
  });

  test("preserves duplicates in order, unlike tokenize", () => {
    expect(tokenList("build build test")).toEqual(["build", "build", "test"]);
    expect([...tokenize("build build test")]).toEqual(["build", "test"]);
  });

  test("stops at the token cap without reading the whole input", () => {
    const huge = "alpha beta gamma ".repeat(20_000);
    expect(tokenList(huge).length).toBe(DOC_MAX_TOKENS);
    expect(tokenList(huge, { maxTokens: 5 })).toEqual(["alpha", "beta", "gamma", "alpha", "beta"]);
  });

  test("reads no more than the character cap", () => {
    const buried = `${"padding ".repeat(DOC_MAX_CHARS)}needle`;
    expect(tokenList(buried)).not.toContain("needle");
    expect(tokenList(`${"x".repeat(DOC_MAX_CHARS - 3)} needle`, { maxTokens: 10 })).not.toContain(
      "needle",
    );
  });

  test("drops tokens below the default minimum length", () => {
    expect(DEFAULT_MIN_LENGTH).toBe(2);
    expect(tokenList("x y z build")).toEqual(["build"]);
    expect(tokenList("x y z build", { minLength: 1 })).toEqual(["x", "y", "z", "build"]);
  });

  test("honours a caller-supplied stopword set", () => {
    expect(tokenList("build the widget", { stopwords: new Set(["build"]) })).toEqual([
      "the",
      "widget",
    ]);
  });

  test("does not leak regex state between calls", () => {
    // The token pattern is a shared module-level /g regex; a refactor to
    // `exec` without resetting lastIndex would make the second call differ.
    const first = tokenList("alpha beta gamma");
    expect(tokenList("alpha beta gamma")).toEqual(first);
    expect(tokenList("alpha beta gamma")).toEqual(first);
  });
});

describe("tokenCounts", () => {
  test("reports term frequency in first-occurrence order", () => {
    expect([...tokenCounts("build test build build")]).toEqual([
      ["build", 3],
      ["test", 1],
    ]);
  });
});

describe("tokenizeQuery", () => {
  test("deduplicates terms so a repeated word does not count twice", () => {
    expect(tokenizeQuery("build build test").terms).toEqual(["build", "test"]);
  });

  test("reports a query that carried no signal", () => {
    expect(tokenizeQuery("the of and de para").terms).toEqual([]);
    expect(tokenizeQuery("").terms).toEqual([]);
  });

  test("flags truncation by characters and by token count", () => {
    expect(tokenizeQuery("build").truncated).toBe(false);
    expect(tokenizeQuery("x".repeat(QUERY_MAX_CHARS + 1)).truncated).toBe(true);
    const many = Array.from({ length: QUERY_MAX_TOKENS + 10 }, (_, i) => `term${i}`).join(" ");
    const result = tokenizeQuery(many);
    expect(result.truncated).toBe(true);
    expect(result.terms.length).toBe(QUERY_MAX_TOKENS);
  });
});

describe("overlapScore", () => {
  test("counts shared tokens only", () => {
    expect(overlapScore(tokenize("build workspace"), tokenize("workspace layout"))).toBe(1);
    expect(overlapScore(tokenize("build"), tokenize("deploy"))).toBe(0);
  });
});

describe("matchWindowed", () => {
  const never = (): boolean => false;

  test("tests a short line whole, without paying for windowing", () => {
    expect(matchWindowed(/needle/i, "a needle here", never)).toBe(true);
    expect(matchWindowed(/needle/i, "nothing here", never)).toBe(false);
  });

  test("walks a long line in windows instead of truncating it", () => {
    const line = `${"x".repeat(GREP_LINE_MAX * 4)}needle`;
    expect(matchWindowed(/needle/i, line, never)).toBe(true);
  });

  test("stops as soon as the budget predicate says the call is over", () => {
    let calls = 0;
    const spent = (): boolean => {
      calls += 1;
      return true;
    };
    expect(matchWindowed(/needle/i, `${"x".repeat(GREP_LINE_MAX * 9)}needle`, spent)).toBe(false);
    // One window tested, one budget check, then out -- not nine.
    expect(calls).toBe(1);
  });

  test("advances by less than a full window, so a boundary cannot hide a match", () => {
    expect(GREP_WINDOW_OVERLAP).toBeLessThan(GREP_LINE_MAX);
  });
});

describe("createGrepScanner", () => {
  test("matches a line sharing any significant token", () => {
    const scanner = createGrepScanner("mise pinned");
    expect(scanner.match("Bun is pinned to 1.3.14 via mise")).toBe(true);
    expect(scanner.match("unrelated prose")).toBe(false);
  });

  test("never matches when the query tokenizes to nothing", () => {
    const scanner = createGrepScanner("the of and");
    expect(scanner.match("the of and")).toBe(false);
  });

  test("matches accented text from an unaccented query", () => {
    const scanner = createGrepScanner("configuracao");
    expect(scanner.match("a configuração fica no settings.json")).toBe(true);
  });

  test("applies a regex when asked", () => {
    const scanner = createGrepScanner("E\\d+", { regex: true });
    expect(scanner.match("error code E2345 here")).toBe(true);
    expect(scanner.match("no code here")).toBe(false);
  });

  test("degrades an uncompilable pattern to a keyword scan", () => {
    const scanner = createGrepScanner("(unclosed", { regex: true });
    expect(scanner.match("error code E2345 here")).toBe(false);
    expect(scanner.match("an unclosed bracket")).toBe(true);
  });

  test("degrades an over-long pattern rather than compiling it", () => {
    // A catastrophically backtracking pattern must never reach the engine.
    const evil = `${"(a+)+".repeat(GREP_QUERY_MAX_CHARS)}$`;
    const scanner = createGrepScanner(evil, { regex: true });
    expect(scanner.match("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBe(false);
  });

  test("finds a regex hit far past one window's width", () => {
    // The whole point of windowing: a memory document is prose markdown whose
    // paragraphs routinely run past GREP_LINE_MAX, and truncating to the first
    // window made every hit beyond it stop matching at all.
    const scanner = createGrepScanner("E\\d+", { regex: true });
    expect(scanner.match(`${"filler prose ".repeat(80)}error code E2345 here`)).toBe(true);
    expect(scanner.match(`${"filler prose ".repeat(80)}no code here`)).toBe(false);
  });

  test("finds a hit straddling a window boundary", () => {
    const scanner = createGrepScanner("needle-token", { regex: true });
    const step = GREP_LINE_MAX - GREP_WINDOW_OVERLAP;
    // Place the match so it spans the first window's edge exactly.
    const at = step + GREP_LINE_MAX - "needle".length;
    expect(scanner.match(`${"x".repeat(at)}needle-token${"y".repeat(50)}`)).toBe(true);
  });

  test("abandons a long line once the wall-clock budget is spent", () => {
    // One RegExp.test cannot be interrupted, so the achievable granularity is
    // one window -- without the between-window check a single pathological
    // line would spend the whole call's budget and then some.
    let clock = 0;
    const scanner = createGrepScanner("zzz", {
      regex: true,
      now: () => {
        clock += GREP_SCAN_MAX_MS;
        return clock;
      },
    });
    expect(scanner.match("q".repeat(GREP_LINE_MAX * 20))).toBe(false);
  });

  test("stops reporting budget once the scan cap is spent", () => {
    const scanner = createGrepScanner("build");
    expect(scanner.ok()).toBe(true);
    for (let i = 0; i < GREP_SCAN_MAX_LINES; i++) scanner.match("nothing here");
    expect(scanner.ok()).toBe(false);
  });

  test("never hands a catastrophically backtracking pattern to the engine", () => {
    // `(build+)+$` is the `(a+)+$` family — a quantifier applied to a group,
    // ~0.5s per line on Bun 1.3.11 no matter how short the line is, which over
    // GREP_SCAN_MAX_LINES is a day of wall clock in a process that serves every
    // concurrent run. It must never compile, and the proof is behavioural: a
    // refused pattern comes back as a keyword search for `build`, where the
    // compiled regex would not have matched this line at all.
    const scanner = createGrepScanner("(build+)+$", { regex: true });
    expect(scanner.match("the build is broken")).toBe(true);
    expect(scanner.match("unrelated prose")).toBe(false);
  });

  test("reports a hit past the excerpt cap instead of discarding the line", () => {
    // The excerpt still stops at GREP_LINE_MAX, but `path` + `line` are what let
    // a caller open the document — so a match beyond it must still be a match.
    const scanner = createGrepScanner("needle", { regex: true });
    expect(scanner.match("x".repeat(GREP_LINE_MAX + 50) + "needle")).toBe(true);
    expect(scanner.match("needle at the front")).toBe(true);
    expect(scanner.match("x".repeat(GREP_LINE_MAX + 50) + "haystack")).toBe(false);
  });

  test("stops reporting budget once the wall clock is spent", () => {
    // An injected clock: the deadline is asserted without spending it.
    let t = 0;
    const scanner = createGrepScanner("build", { now: () => t });
    expect(scanner.ok()).toBe(true);
    t = GREP_SCAN_MAX_MS - 1;
    expect(scanner.ok()).toBe(true);
    t = GREP_SCAN_MAX_MS + 1;
    expect(scanner.ok()).toBe(false);
  });
});

describe("isBoundedPattern", () => {
  test("admits the patterns an agent actually writes", () => {
    for (const pattern of [
      "E\\d+",
      "TODO|FIXME",
      "^## ",
      "\\d{4}-\\d{2}-\\d{2}",
      "foo.*bar",
      "(TODO|FIXME):\\s*",
      "[a-z]+[0-9]+",
      "",
    ]) {
      expect(isBoundedPattern(pattern)).toBe(true);
    }
  });

  test("reads `(?<name>` as a named group, not as lookbehind", () => {
    expect(isBoundedPattern("(?<year>\\d+)")).toBe(true);
    expect(isBoundedPattern("(?:foo|bar)")).toBe(true);
  });

  test("does not count metacharacters that are literals", () => {
    // Inside a character class and behind a backslash they quantify nothing.
    expect(isBoundedPattern("[*+?{|]")).toBe(true);
    expect(isBoundedPattern("\\(a\\)\\+\\*\\?\\{")).toBe(true);
    expect(isBoundedPattern("[\\]*+?{|]")).toBe(true);
  });

  test("refuses every quantifier applied to a group", () => {
    for (const pattern of ["(a+)+$", "(a|a)*$", "(\\w+)+$", "(?:a*)*b", "([a-z]+)*", "(a){2,}"]) {
      expect(isBoundedPattern(pattern)).toBe(false);
    }
  });

  test("refuses backreferences", () => {
    expect(isBoundedPattern("(a)\\1")).toBe(false);
    expect(isBoundedPattern("(?<x>a)\\k<x>")).toBe(false);
  });

  test("refuses lookaround in all four forms", () => {
    for (const pattern of ["(?=foo)bar", "(?!foo)bar", "(?<=foo)bar", "(?<!foo)bar"]) {
      expect(isBoundedPattern(pattern)).toBe(false);
    }
  });

  test("refuses a pattern with more ambiguity than the budget", () => {
    // Exactly at the budget is admitted; one past it is not. The measured cost
    // over a GREP_LINE_MAX-length line is 100ms at the budget and 2.8s one past.
    expect(isBoundedPattern(`${"a*".repeat(GREP_AMBIGUITY_MAX)}b`)).toBe(true);
    expect(isBoundedPattern(`${"a*".repeat(GREP_AMBIGUITY_MAX + 1)}b`)).toBe(false);
    expect(isBoundedPattern("a|b|c|d|e")).toBe(false);
  });
});

describe("DEFAULT_STOPWORDS", () => {
  test("covers function words in both supported languages", () => {
    for (const word of ["the", "is", "with", "would"])
      expect(DEFAULT_STOPWORDS.has(word)).toBe(true);
    for (const word of ["de", "para", "que", "com"]) expect(DEFAULT_STOPWORDS.has(word)).toBe(true);
  });

  test("stores entries already folded, matching what the tokenizer looks up", () => {
    // `não`/`são`/`já` never reach the set in their accented spelling.
    for (const word of ["nao", "sao", "ja", "ha", "esta"]) {
      expect(DEFAULT_STOPWORDS.has(word)).toBe(true);
    }
    for (const word of ["não", "são", "já"]) expect(DEFAULT_STOPWORDS.has(word)).toBe(false);
  });

  test("does not swallow technical terms", () => {
    for (const word of ["build", "bun", "ci", "db", "deploy", "test"]) {
      expect(DEFAULT_STOPWORDS.has(word)).toBe(false);
    }
  });
});
