import { describe, expect, test } from "bun:test";

import {
  admitNew,
  applyAccept,
  dedupeKey,
  matchesFilter,
  nextRepeat,
  parseAcceptRule,
  parseSelector,
  resolveSource,
  selectItems,
  UNAVAILABLE,
  whenSatisfied,
  type RepeatSpec,
  type WorkflowState,
} from "../../src/rounds.ts";

function state(rounds: Record<string, unknown>): WorkflowState {
  return { rounds };
}

const REVIEW = state({
  review: {
    findings: [
      { id: "f1", claim: "A", needs_verification: true, confidence: "high" },
      { id: "f2", claim: "B", needs_verification: false, confidence: "low" },
      { id: "f3", claim: "C", needs_verification: true, confidence: "medium" },
    ],
    coverage_gaps: ["the parser"],
  },
});

describe("resolveSource", () => {
  test("reads a dotted path into a round's result", () => {
    expect(resolveSource(REVIEW, "review.findings")).toHaveLength(3);
  });

  test("returns null for a round that has not run", () => {
    expect(resolveSource(REVIEW, "discover.work_items")).toBeNull();
  });

  test("returns null when the path names something that is not an array", () => {
    expect(resolveSource(state({ r: { a: 1 } }), "r.a")).toBeNull();
  });

  test("returns null when a step of the path runs into a non-object", () => {
    expect(resolveSource(state({ r: { a: 1 } }), "r.a.b")).toBeNull();
  });

  test("returns null for an empty source", () => {
    expect(resolveSource(REVIEW, "")).toBeNull();
  });

  test("a round whose whole result is an array resolves without a field", () => {
    expect(resolveSource(state({ r: [1, 2] }), "r")).toEqual([1, 2]);
  });
});

describe("matchesFilter and when", () => {
  test("a bare field is a truth test", () => {
    expect(matchesFilter({ flag: true }, { field: "flag" })).toBe(true);
    expect(matchesFilter({ flag: false }, { field: "flag" })).toBe(false);
    expect(matchesFilter({}, { field: "flag" })).toBe(false);
  });

  test("a field with equals is a literal comparison, not coercion", () => {
    expect(matchesFilter({ c: "high" }, { field: "c", equals: "high" })).toBe(true);
    expect(matchesFilter({ c: "low" }, { field: "c", equals: "high" })).toBe(false);
    expect(matchesFilter({ n: 1 }, { field: "n", equals: true })).toBe(false);
  });

  test("a when guard is satisfied only by a non-empty array", () => {
    expect(whenSatisfied(REVIEW, "review.coverage_gaps")).toBe(true);
    expect(whenSatisfied(state({ r: { gaps: [] } }), "r.gaps")).toBe(false);
    expect(whenSatisfied(REVIEW, "missing.gaps")).toBe(false);
  });
});

describe("selectItems — the barrier is derived, not chosen", () => {
  test("once runs exactly one leader and consumes nothing", () => {
    const picked = selectItems({ kind: "once" }, state({}));
    expect(picked).toEqual({ items: [undefined] });
  });

  test("each yields one leader per member — no barrier", () => {
    const picked = selectItems({ kind: "each", source: "review.findings" }, REVIEW);
    expect("items" in picked && picked.items).toHaveLength(3);
  });

  test("each with a where filters on the producing leader's own judgement", () => {
    const picked = selectItems(
      { kind: "each", source: "review.findings", where: { field: "needs_verification" } },
      REVIEW,
    );
    expect("items" in picked && picked.items.map((i) => (i as { id: string }).id)).toEqual([
      "f1",
      "f3",
    ]);
  });

  test("all collapses the whole set into one leader — that is the barrier", () => {
    const picked = selectItems({ kind: "all", source: "review.coverage_gaps" }, REVIEW);
    expect(picked).toEqual({ items: [["the parser"]] });
  });

  test("an unresolvable source is an error naming the rounds that do exist", () => {
    const picked = selectItems({ kind: "each", source: "ghost.items" }, REVIEW);
    expect("error" in picked && picked.error).toContain("ghost.items");
    expect("error" in picked && picked.error).toContain("review");
  });

  test("an unresolvable source on an empty state says so rather than listing nothing", () => {
    const picked = selectItems({ kind: "each", source: "ghost.items" }, state({}));
    expect("error" in picked && picked.error).toContain("(none)");
  });
});

describe("applyAccept — a dead verifier is not a vote in favour", () => {
  const verdicts = (...values: string[]): unknown[] => values.map((verdict) => ({ verdict }));

  test("all requires every replica, and an empty panel accepts nothing", () => {
    const rule = { kind: "all", field: "verdict", value: "refuted" } as const;
    expect(applyAccept(rule, verdicts("refuted", "refuted")).accepted).toBe(true);
    expect(applyAccept(rule, verdicts("refuted", "confirmed")).accepted).toBe(false);
    expect(applyAccept(rule, []).accepted).toBe(false);
  });

  test("any accepts on a single hit", () => {
    const rule = { kind: "any", field: "verdict", value: "refuted" } as const;
    expect(applyAccept(rule, verdicts("confirmed", "refuted")).accepted).toBe(true);
    expect(applyAccept(rule, verdicts("confirmed")).accepted).toBe(false);
  });

  test("majority is strictly more than half, so a tie is not a majority", () => {
    const rule = { kind: "majority", field: "verdict", value: "refuted" } as const;
    expect(applyAccept(rule, verdicts("refuted", "confirmed")).accepted).toBe(false);
    expect(applyAccept(rule, verdicts("refuted", "refuted", "confirmed")).accepted).toBe(true);
  });

  test("threshold counts hits against its own bar", () => {
    const rule = { kind: "threshold", field: "verdict", value: "refuted", count: 2 } as const;
    expect(applyAccept(rule, verdicts("refuted", "refuted", "confirmed")).accepted).toBe(true);
    expect(applyAccept(rule, verdicts("refuted", "inconclusive", "confirmed")).accepted).toBe(
      false,
    );
  });

  test("a failed replica stays in the denominator instead of being discarded", () => {
    const rule = { kind: "majority", field: "verdict", value: "refuted" } as const;
    const result = applyAccept(rule, [{ verdict: "refuted" }, null, undefined]);
    // Two of three verifiers died; one refutation is not a majority of three.
    expect(result.accepted).toBe(false);
    expect(result.tally).toEqual({ refuted: 1, [UNAVAILABLE]: 2 });
  });

  test("inconclusive is tallied as itself — neither a refutation nor a confirmation", () => {
    const rule = { kind: "threshold", field: "verdict", value: "refuted", count: 2 } as const;
    const result = applyAccept(rule, verdicts("refuted", "inconclusive", "inconclusive"));
    expect(result.accepted).toBe(false);
    expect(result.tally).toEqual({ refuted: 1, inconclusive: 2 });
  });
});

describe("dedupeKey and admitNew", () => {
  test("is insensitive to case, surrounding space and array order", () => {
    const a = dedupeKey({ claim: " Torn Read ", evidence: ["b.ts:2", "a.ts:1"] }, [
      "claim",
      "evidence",
    ]);
    const b = dedupeKey({ claim: "torn read", evidence: ["a.ts:1", "b.ts:2"] }, [
      "claim",
      "evidence",
    ]);
    expect(a).toBe(b);
  });

  test("distinguishes items that differ in a declared field", () => {
    expect(dedupeKey({ claim: "x" }, ["claim"])).not.toBe(dedupeKey({ claim: "y" }, ["claim"]));
  });

  test("keeps fields in the declared order, so two fields cannot smear into one", () => {
    expect(dedupeKey({ a: "1", b: "2" }, ["a", "b"])).not.toBe(
      dedupeKey({ a: "1", b: "2" }, ["b", "a"]),
    );
  });

  test("a missing field is empty rather than the string 'undefined'", () => {
    expect(dedupeKey({}, ["claim"])).toBe("");
  });

  test("non-string scalars and objects are serialized", () => {
    expect(dedupeKey({ n: 3, o: { z: 1 } }, ["n", "o"])).toBe('3\0{"z":1}');
  });

  test("admitNew returns only unseen items and carries the growing set forward", () => {
    const first = admitNew([{ claim: "a" }, { claim: "b" }], ["claim"], new Set());
    expect(first.fresh).toHaveLength(2);
    const second = admitNew([{ claim: "A" }, { claim: "c" }], ["claim"], first.seen);
    expect(second.fresh).toEqual([{ claim: "c" }]);
    expect(second.seen.size).toBe(3);
  });

  test("a repeat of the same item inside one batch is admitted once", () => {
    const result = admitNew([{ claim: "a" }, { claim: "a" }], ["claim"], new Set());
    expect(result.fresh).toHaveLength(1);
  });
});

describe("nextRepeat", () => {
  const spec: RepeatSpec = {
    rounds: ["review", "verify"],
    until: "no_new",
    dedupe_by: ["claim"],
    max_rounds: 4,
  };

  test("continues while there is headroom, new findings and passes left", () => {
    expect(nextRepeat(spec, { roundsRun: 1, dryRounds: 0, budgetExhausted: false })).toEqual({
      done: false,
    });
  });

  test("a refused ledger outranks every other reason", () => {
    expect(nextRepeat(spec, { roundsRun: 0, dryRounds: 0, budgetExhausted: true })).toEqual({
      done: true,
      reason: "budget",
    });
  });

  test("max_rounds is the backstop and stops the block outright", () => {
    expect(nextRepeat(spec, { roundsRun: 4, dryRounds: 0, budgetExhausted: false })).toEqual({
      done: true,
      reason: "max_rounds",
    });
  });

  test("two dry passes end the block by default", () => {
    expect(nextRepeat(spec, { roundsRun: 2, dryRounds: 2, budgetExhausted: false })).toEqual({
      done: true,
      reason: "dry_rounds",
    });
    expect(nextRepeat(spec, { roundsRun: 2, dryRounds: 1, budgetExhausted: false })).toEqual({
      done: false,
    });
  });

  test("a declared dry_rounds overrides the default", () => {
    expect(
      nextRepeat(
        { ...spec, dry_rounds: 1 },
        { roundsRun: 1, dryRounds: 1, budgetExhausted: false },
      ),
    ).toEqual({ done: true, reason: "dry_rounds" });
  });
});

describe("parseSelector — a fixed set of shapes, not an expression language", () => {
  test.each([
    ["once", { kind: "once" }],
    ["each(discover.work_items)", { kind: "each", source: "discover.work_items" }],
    [
      "each(review.findings where needs_verification)",
      { kind: "each", source: "review.findings", where: { field: "needs_verification" } },
    ],
    [
      "each(review.findings where confidence = high)",
      {
        kind: "each",
        source: "review.findings",
        where: { field: "confidence", equals: "high" },
      },
    ],
    [
      "each(r.items where flag = true)",
      { kind: "each", source: "r.items", where: { field: "flag", equals: true } },
    ],
    [
      "each(r.items where flag = false)",
      { kind: "each", source: "r.items", where: { field: "flag", equals: false } },
    ],
    [
      "each(r.items where n = 3)",
      { kind: "each", source: "r.items", where: { field: "n", equals: 3 } },
    ],
    [
      'each(r.items where s = "a b")',
      { kind: "each", source: "r.items", where: { field: "s", equals: "a b" } },
    ],
    ["all(review.coverage_gaps)", { kind: "all", source: "review.coverage_gaps" }],
  ])("parses %s", (text, expected) => {
    expect(parseSelector(text)).toEqual(expected as never);
  });

  test.each([
    ["all with a filter, which would make the barrier conditional", "all(r.items where flag)"],
    ["an unknown head", "some(r.items)"],
    ["free-form text", "each r.items"],
    ["an expression", "each(r.items where a + b)"],
  ])("refuses %s", (_label, text) => {
    expect(parseSelector(text)).toBeNull();
  });
});

describe("parseAcceptRule", () => {
  test.each([
    ["all(verdict, refuted)", { kind: "all", field: "verdict", value: "refuted" }],
    ["any(verdict, refuted)", { kind: "any", field: "verdict", value: "refuted" }],
    ["majority(verdict, refuted)", { kind: "majority", field: "verdict", value: "refuted" }],
    [
      "threshold(verdict, refuted, 2)",
      { kind: "threshold", field: "verdict", value: "refuted", count: 2 },
    ],
  ])("parses %s", (text, expected) => {
    expect(parseAcceptRule(text)).toEqual(expected as never);
  });

  test.each([
    ["threshold without its count, which has no sensible default", "threshold(verdict, refuted)"],
    ["a count on a rule that does not take one", "majority(verdict, refuted, 2)"],
    ["an unknown rule", "most(verdict, refuted)"],
    ["free-form text", "refute it twice"],
  ])("refuses %s", (_label, text) => {
    expect(parseAcceptRule(text)).toBeNull();
  });
});

describe("nextRepeat — until selects the stopping rule", () => {
  const base: RepeatSpec = {
    rounds: ["review"],
    until: "no_new",
    dedupe_by: ["claim"],
    max_rounds: 9,
  };

  test("until: budget keeps going past dry passes, stopping only on the ledger or max_rounds", () => {
    const budget = { ...base, until: "budget" as const };
    // A field that is parsed and then ignored is worse than one that does not
    // exist: the caller believes it asked for something.
    expect(nextRepeat(budget, { roundsRun: 3, dryRounds: 5, budgetExhausted: false })).toEqual({
      done: false,
    });
    expect(nextRepeat(budget, { roundsRun: 3, dryRounds: 5, budgetExhausted: true })).toEqual({
      done: true,
      reason: "budget",
    });
    expect(nextRepeat(budget, { roundsRun: 9, dryRounds: 0, budgetExhausted: false })).toEqual({
      done: true,
      reason: "max_rounds",
    });
  });

  test("until: no_new still gives up after the declared dry passes", () => {
    expect(nextRepeat(base, { roundsRun: 3, dryRounds: 2, budgetExhausted: false })).toEqual({
      done: true,
      reason: "dry_rounds",
    });
  });
});
