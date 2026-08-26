import { describe, expect, test } from "bun:test";
import { HOOK_MESSAGE_MAX_CHARS, parseHookStdout } from "../../src/parse.ts";

const GATE = { truncated: false, allowContext: false, allowRewrite: false } as const;
const CONTEXTUAL = { truncated: false, allowContext: true, allowRewrite: false } as const;
const REWRITABLE = { truncated: false, allowContext: false, allowRewrite: true } as const;

describe("parseHookStdout", () => {
  test("truncated output is a failure and is never parsed", () => {
    const valid = JSON.stringify({ kind: "deny", message: "no" });
    expect(parseHookStdout(valid, { ...GATE, truncated: true })).toEqual({
      ok: false,
      reason: "stdout exceeded the capture limit",
    });
  });

  test.each(["", "   ", "\n\t\n"])("empty stdout %p passes", (stdout) => {
    expect(parseHookStdout(stdout, GATE)).toEqual({ ok: true, outcome: { kind: "pass" } });
  });

  test.each(["{}", '{"other":1}'])("an object with no kind %p passes", (stdout) => {
    expect(parseHookStdout(stdout, GATE)).toEqual({ ok: true, outcome: { kind: "pass" } });
  });

  describe("the external dialect, which carries no kind", () => {
    test.each([
      ['{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"nope"}}'],
      ['{"decision":"block","reason":"nope"}'],
      ['{"continue":false,"stopReason":"nope"}'],
    ])("a blocking verdict %p denies rather than silently passing", (stdout) => {
      expect(parseHookStdout(stdout, GATE)).toEqual({
        ok: true,
        outcome: { kind: "deny", message: "nope" },
      });
    });

    test("a blocking verdict with no reason still denies", () => {
      expect(parseHookStdout('{"decision":"block"}', GATE)).toEqual({
        ok: true,
        outcome: { kind: "deny", message: "denied by hook (no reason given)" },
      });
    });

    test("an allow passes", () => {
      expect(parseHookStdout('{"decision":"approve"}', GATE)).toEqual({
        ok: true,
        outcome: { kind: "pass" },
      });
    });

    test("an allow that also offers context contributes it through either channel", () => {
      const stdout =
        '{"hookSpecificOutput":{"permissionDecision":"allow","additionalContext":"seed"}}';
      expect(parseHookStdout(stdout, CONTEXTUAL)).toEqual({
        ok: true,
        outcome: { kind: "context", text: "seed" },
      });
      expect(parseHookStdout(stdout, GATE)).toEqual({
        ok: true,
        outcome: { kind: "advise", message: "seed" },
      });
    });

    test("an ask degrades to advise, keeping its reason", () => {
      expect(
        parseHookStdout(
          '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"why"}}',
          GATE,
        ),
      ).toEqual({ ok: true, outcome: { kind: "advise", message: "why" } });
    });

    test.each([
      ['{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"seed"}}'],
      ['{"additionalContext":"seed"}'],
      ['{"additional_context":"seed"}'],
    ])("every context spelling %p becomes a context outcome", (stdout) => {
      expect(parseHookStdout(stdout, CONTEXTUAL)).toEqual({
        ok: true,
        outcome: { kind: "context", text: "seed" },
      });
    });

    test("context offered at a gate becomes advice rather than being dropped", () => {
      expect(parseHookStdout('{"additionalContext":"seed"}', GATE)).toEqual({
        ok: true,
        outcome: { kind: "advise", message: "seed" },
      });
    });

    test("an allow carrying replacement arguments becomes a rewrite", () => {
      const stdout =
        '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"echo hi"}}}';
      expect(parseHookStdout(stdout, REWRITABLE)).toEqual({
        ok: true,
        outcome: { kind: "rewrite", arguments: { command: "echo hi" } },
      });
    });

    test("a rewrite carries any context offered alongside it", () => {
      const stdout =
        '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"x"},"additionalContext":"added --dry-run"}}';
      expect(parseHookStdout(stdout, REWRITABLE)).toEqual({
        ok: true,
        outcome: { kind: "rewrite", arguments: { command: "x" }, message: "added --dry-run" },
      });
    });

    test("a replacement offered with no decision at all is honoured, not silently dropped", () => {
      expect(parseHookStdout('{"updatedInput":{"command":"x"}}', REWRITABLE)).toEqual({
        ok: true,
        outcome: { kind: "rewrite", arguments: { command: "x" } },
      });
    });

    test.each([
      [
        '{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{"command":"x"}}}',
        REWRITABLE,
        "replacement arguments cannot accompany a 'ask' decision",
      ],
      [
        '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"x"}}}',
        GATE,
        "arguments cannot be replaced at this event",
      ],
      [
        '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":"echo hi"}}',
        REWRITABLE,
        "replacement arguments are not an object",
      ],
      [
        '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":[1,2]}}',
        REWRITABLE,
        "replacement arguments are not an object",
      ],
    ])(
      "a replacement that cannot be honoured is reported rather than dropped %#",
      (stdout, opts, reason) => {
        expect(parseHookStdout(stdout, opts)).toEqual({ ok: false, reason });
      },
    );

    test("a deny that also carries replacement arguments still denies", () => {
      const stdout =
        '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no","updatedInput":{"command":"x"}}}';
      expect(parseHookStdout(stdout, REWRITABLE)).toEqual({
        ok: true,
        outcome: { kind: "deny", message: "no" },
      });
    });

    test("our own context outcome at a gate stays bad output", () => {
      expect(parseHookStdout('{"kind":"context","text":"seed"}', GATE)).toEqual({
        ok: false,
        reason: "a 'context' outcome is not valid at this event",
      });
    });
  });

  describe("our own rewrite outcome", () => {
    test("replaces the arguments, keeping an optional message", () => {
      expect(
        parseHookStdout('{"kind":"rewrite","arguments":{"a":1},"message":"why"}', REWRITABLE),
      ).toEqual({
        ok: true,
        outcome: { kind: "rewrite", arguments: { a: 1 }, message: "why" },
      });
    });

    test("drops an empty message rather than carrying a blank one", () => {
      expect(parseHookStdout('{"kind":"rewrite","arguments":{"a":1}}', REWRITABLE)).toEqual({
        ok: true,
        outcome: { kind: "rewrite", arguments: { a: 1 } },
      });
    });

    test.each([
      [
        '{"kind":"rewrite","arguments":{"a":1}}',
        GATE,
        "arguments cannot be replaced at this event",
      ],
      [
        '{"kind":"rewrite","arguments":"nope"}',
        REWRITABLE,
        "replacement arguments are not an object",
      ],
      ['{"kind":"rewrite"}', REWRITABLE, "replacement arguments are not an object"],
    ])("is bad output when it cannot be honoured %#", (stdout, opts, reason) => {
      expect(parseHookStdout(stdout, opts)).toEqual({ ok: false, reason });
    });
  });

  test.each([
    ["not json at all", "stdout is not JSON"],
    ["hello\n{}", "stdout is not JSON"],
    ['{"kind":"pass"} trailing', "stdout is not JSON"],
    ["[]", "stdout JSON is not an object"],
    ["null", "stdout JSON is not an object"],
    ['"a string"', "stdout JSON is not an object"],
    ["42", "stdout JSON is not an object"],
    ['{"kind":7}', "stdout 'kind' is not a string"],
    ['{"kind":"nope"}', "unknown kind 'nope'"],
  ])("%p is bad output", (stdout, reason) => {
    expect(parseHookStdout(stdout, GATE)).toEqual({ ok: false, reason });
  });

  test("an explicit pass parses", () => {
    expect(parseHookStdout('{"kind":"pass"}', GATE)).toEqual({
      ok: true,
      outcome: { kind: "pass" },
    });
  });

  test("a deny carries its message", () => {
    expect(parseHookStdout('{"kind":"deny","message":"edit dist/ is forbidden"}', GATE)).toEqual({
      ok: true,
      outcome: { kind: "deny", message: "edit dist/ is forbidden" },
    });
  });

  test.each(['{"kind":"deny"}', '{"kind":"deny","message":""}', '{"kind":"deny","message":7}'])(
    "a deny with no usable message still denies: %p",
    (stdout) => {
      expect(parseHookStdout(stdout, GATE)).toEqual({
        ok: true,
        outcome: { kind: "deny", message: "denied by hook (no reason given)" },
      });
    },
  );

  test("an advise carries its message", () => {
    expect(parseHookStdout('{"kind":"advise","message":"prefer bun"}', GATE)).toEqual({
      ok: true,
      outcome: { kind: "advise", message: "prefer bun" },
    });
  });

  test("an advise with nothing to say degrades to a pass", () => {
    expect(parseHookStdout('{"kind":"advise"}', GATE)).toEqual({
      ok: true,
      outcome: { kind: "pass" },
    });
  });

  test("context is rejected where it cannot be represented", () => {
    expect(parseHookStdout('{"kind":"context","text":"hi"}', GATE)).toEqual({
      ok: false,
      reason: "a 'context' outcome is not valid at this event",
    });
  });

  test("context parses where it is meaningful", () => {
    expect(parseHookStdout('{"kind":"context","text":"never edit dist/"}', CONTEXTUAL)).toEqual({
      ok: true,
      outcome: { kind: "context", text: "never edit dist/" },
    });
  });

  test("an empty context degrades to a pass", () => {
    expect(parseHookStdout('{"kind":"context","text":"  "}', CONTEXTUAL)).toEqual({
      ok: true,
      outcome: { kind: "pass" },
    });
  });

  test("a message is clamped", () => {
    const long = "x".repeat(HOOK_MESSAGE_MAX_CHARS * 2);
    const parsed = parseHookStdout(JSON.stringify({ kind: "deny", message: long }), GATE);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.outcome.kind === "deny") {
      expect(parsed.outcome.message).toHaveLength(HOOK_MESSAGE_MAX_CHARS);
    }
  });

  test("control characters are stripped but newlines and tabs survive", () => {
    const ctl = (code: number): string => String.fromCharCode(code);
    const message = `a${ctl(7)}b${ctl(0)}c${ctl(127)}\nd\te`;
    const parsed = parseHookStdout(JSON.stringify({ kind: "advise", message }), GATE);
    expect(parsed).toEqual({ ok: true, outcome: { kind: "advise", message: "abc\nd\te" } });
  });

  test("a leading or trailing blank is trimmed away", () => {
    expect(parseHookStdout('{"kind":"advise","message":"  spaced  "}', GATE)).toEqual({
      ok: true,
      outcome: { kind: "advise", message: "spaced" },
    });
  });
});

describe("parseHookStdout — the failure reason is bounded too", () => {
  test("an oversized kind is clamped instead of reaching the model whole", () => {
    const res = parseHookStdout(JSON.stringify({ kind: "A".repeat(60_000) }), GATE);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a failure");
    expect(res.reason.length).toBeLessThan(HOOK_MESSAGE_MAX_CHARS);
    expect(res.reason.length).toBeLessThan(200);
    expect(res.reason.startsWith("unknown kind 'AAA")).toBe(true);
  });

  test("control characters in a kind are stripped from the reason", () => {
    const ctl = (code: number): string => String.fromCharCode(code);
    const res = parseHookStdout(JSON.stringify({ kind: `no${ctl(27)}pe${ctl(0)}` }), GATE);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a failure");
    expect(res.reason).toBe("unknown kind 'nope'");
  });
});
