import { describe, it, expect } from "../bun-test.ts";
import { contentToText } from "@clarvis/capability";
import type { CompactionContribution, LifecycleHook, LiveMessage } from "@clarvis/capability";
import {
  applicableContributions,
  buildCompactionMessages,
  CONTRIBUTION_MAX_CHARS,
  CONTRIBUTIONS_BLOCK_MAX_CHARS,
} from "../../src/runtime/context/index.ts";
import { collectCompactionContributions } from "../../src/runtime/loop/lifecycle-hooks.ts";

const BASE = "BASE PROMPT: preserve decisions and file paths.";
const SPAN: LiveMessage[] = [{ role: "user", content: "hello" }];

function systemTurn(contributions: CompactionContribution[], extra: object = {}): string {
  const [system] = buildCompactionMessages({
    prompt: BASE,
    contributions,
    span: SPAN,
    ...extra,
  });
  return contentToText(system!.content);
}

function contribution(text: string, source = "hook"): CompactionContribution {
  return { source, text };
}

describe("the base prompt is never replaced", () => {
  it("survives verbatim with no contributions, one, and many", () => {
    for (const contributions of [
      [],
      [contribution("keep the column mapping")],
      [contribution("a"), contribution("b"), contribution("c")],
    ]) {
      expect(systemTurn(contributions)).toContain(BASE);
    }
  });

  it("emits the base first, ahead of anything a contribution says", () => {
    const turn = systemTurn([contribution("EXTRA")]);
    expect(turn.indexOf(BASE)).toBe(0);
    expect(turn.indexOf("EXTRA")).toBeGreaterThan(BASE.length);
  });

  it("tells the summarizer the contributions are additive", () => {
    expect(systemTurn([contribution("EXTRA")])).toContain("do not replace");
  });

  it("adds nothing at all when every contribution is blank", () => {
    expect(systemTurn([contribution("   "), contribution("")])).toBe(BASE);
  });
});

describe("placement", () => {
  it("puts contributions with the instructions, before the anchor and the prior summary", () => {
    const turn = systemTurn([contribution("EXTRA")], {
      anchor: { label: "Task", body: "ANCHORBODY" },
      priorSummary: "PRIORSUMMARY",
    });
    expect(turn.indexOf("EXTRA")).toBeLessThan(turn.indexOf("ANCHORBODY"));
    expect(turn.indexOf("ANCHORBODY")).toBeLessThan(turn.indexOf("PRIORSUMMARY"));
  });
});

describe("ordering and bounds", () => {
  it("preserves the order it is given, which is operator before plugin before user", () => {
    expect(
      applicableContributions([
        contribution("first", "hook"),
        contribution("second", "hook"),
        contribution("third", "user"),
      ]),
    ).toEqual(["first", "second", "third"]);
  });

  it("clamps one oversized contribution rather than dropping it", () => {
    const [only] = applicableContributions([contribution("x".repeat(CONTRIBUTION_MAX_CHARS * 2))]);
    expect(only).toHaveLength(CONTRIBUTION_MAX_CHARS);
  });

  it("stops at the block budget instead of crowding out the transcript", () => {
    const each = "y".repeat(CONTRIBUTION_MAX_CHARS);
    const many = Array.from({ length: 10 }, () => contribution(each));
    const applied = applicableContributions(many);
    expect(applied.length).toBe(Math.floor(CONTRIBUTIONS_BLOCK_MAX_CHARS / CONTRIBUTION_MAX_CHARS));
    expect(applied.join("").length).toBeLessThanOrEqual(CONTRIBUTIONS_BLOCK_MAX_CHARS);
  });

  it("reserves the bounded block for the user's last, highest-precedence request", () => {
    const block = (label: string) => label + "x".repeat(CONTRIBUTION_MAX_CHARS - label.length);
    const applied = applicableContributions([
      contribution(block("hook-one:")),
      contribution(block("hook-two:")),
      contribution(block("hook-three:")),
      contribution(block("user:"), "user"),
    ]);

    expect(applied).toHaveLength(3);
    expect(applied[0]!.startsWith("hook-two:")).toBe(true);
    expect(applied[1]!.startsWith("hook-three:")).toBe(true);
    expect(applied[2]!.startsWith("user:")).toBe(true);
  });

  it("skips a blank contribution without spending budget on it", () => {
    expect(applicableContributions([contribution(" "), contribution("real")])).toEqual(["real"]);
  });
});

describe("collectCompactionContributions", () => {
  const context = { agent: "lead" as const, estimatedTokens: 1000 };

  function hook(fn: LifecycleHook["onPreCompact"]): LifecycleHook {
    return { onPreCompact: fn };
  }

  it("gathers across hooks, in hook order", async () => {
    const collected = await collectCompactionContributions(
      [
        hook(async () => [contribution("one")]),
        hook(async () => [contribution("two"), contribution("three")]),
      ],
      context,
    );
    expect(collected.map((c) => c.text)).toEqual(["one", "two", "three"]);
  });

  it("lets a hook observe without contributing", async () => {
    expect(await collectCompactionContributions([hook(async () => undefined)], context)).toEqual(
      [],
    );
  });

  it("keeps going when one hook throws, so a failure never blocks compaction", async () => {
    const collected = await collectCompactionContributions(
      [
        hook(async () => {
          throw new Error("boom");
        }),
        hook(async () => [contribution("survivor")]),
      ],
      context,
    );
    expect(collected.map((c) => c.text)).toEqual(["survivor"]);
  });

  it("treats no hooks and no method as nothing offered", async () => {
    expect(await collectCompactionContributions(undefined, context)).toEqual([]);
    expect(await collectCompactionContributions([{}], context)).toEqual([]);
  });
});
