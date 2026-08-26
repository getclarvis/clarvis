import { describe, it, expect } from "bun:test";
import {
  ARGS_MAX,
  ARGS_TOTAL_MAX,
  DETAIL_MAX_DEPTH,
  DETAIL_MAX_ENTRIES,
  DETAIL_TRUNCATED_KEY,
  DIFF_MAX,
  LIVE_CHUNK_MAX,
  MODEL_RESPONSE_MAX,
  RESULT_MAX,
  SUMMARY_MAX,
  TRUNCATED_SUFFIX,
  capDetail,
  truncate,
  truncateTail,
} from "@clarvis/trace";
import type { ToolCallDetail } from "@clarvis/capability";
import { DELEGATE_TASK_MAX_CHARS } from "@clarvis/capability";

const over = (n: number): string => "a".repeat(n + 1);

describe("truncate", () => {
  it("leaves a value at or below the cap alone, and marks one above it", () => {
    expect(truncate("a".repeat(RESULT_MAX), RESULT_MAX)).toHaveLength(RESULT_MAX);
    const cut = truncate(over(RESULT_MAX), RESULT_MAX);
    expect(cut).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
    expect(cut.endsWith(TRUNCATED_SUFFIX)).toBe(true);
    expect(cut.startsWith("a".repeat(RESULT_MAX))).toBe(true);
  });

  it("is idempotent at a fixed cap — below, exactly at, and past the boundary", () => {
    for (const value of ["a".repeat(499), "a".repeat(500), over(500), "a".repeat(5000)]) {
      const once = truncate(value, SUMMARY_MAX);
      expect(truncate(once, SUMMARY_MAX)).toBe(once);
    }
  });

  it("still caps a long value that already ends in the marker", () => {
    const value = "a".repeat(SUMMARY_MAX * 2) + TRUNCATED_SUFFIX;
    const cut = truncate(value, SUMMARY_MAX);
    expect(cut).toHaveLength(SUMMARY_MAX + TRUNCATED_SUFFIX.length);
  });
});

describe("truncateTail", () => {
  it("keeps the tail and adds no marker", () => {
    expect(truncateTail("abcdef", 10)).toBe("abcdef");
    expect(truncateTail("abcdef", 3)).toBe("def");
  });
});

describe("capDetail — reference identity", () => {
  it("returns the very same object when nothing needed capping", () => {
    const detail = {
      agent: "lead",
      iteration_ref: 1,
      started_at: 1,
      ended_at: 2,
      name: "fs.read",
      arguments: { path: "/a" },
      result: "ok",
      error: null,
    } satisfies ToolCallDetail;
    expect(capDetail("tool_call", detail)).toBe(detail);
  });

  it("never mutates the caller's detail or its arguments object", () => {
    const args = { content: over(ARGS_MAX) };
    const detail = {
      agent: "lead",
      iteration_ref: 1,
      started_at: 1,
      ended_at: 2,
      name: "write",
      arguments: args,
      result: over(RESULT_MAX),
      error: null,
    } satisfies ToolCallDetail;

    const capped = capDetail("tool_call", detail);

    expect(capped).not.toBe(detail);
    expect(detail.result).toHaveLength(RESULT_MAX + 1);
    expect(args.content).toHaveLength(ARGS_MAX + 1);
    expect((capped.arguments as typeof args).content).toHaveLength(
      ARGS_MAX + TRUNCATED_SUFFIX.length,
    );
  });

  it("passes a kind with no free-text field straight through", () => {
    const detail = { tokens_used: 10, tokens_remaining: 90 };
    expect(capDetail("budget_check", detail)).toBe(detail);
  });
});

describe("capDetail — per-kind caps", () => {
  it("does not apply the compact tool-result cap to final model responses", () => {
    const response = over(RESULT_MAX);
    const capped = capDetail("lead_iteration", {
      iteration: 1,
      started_at: 0,
      ended_at: 1,
      model: "m",
      input_tokens: 1,
      output_tokens: 1,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cache_read_ratio: 0,
      response,
    });

    expect(capped.response).toBe(response);
  });

  it("caps a tool_call's result, diff and arguments at their own bounds", () => {
    const capped = capDetail("tool_call", {
      agent: "lead",
      iteration_ref: 1,
      started_at: 1,
      ended_at: 2,
      name: "apply_patch",
      arguments: { path: "a.ts", body: over(ARGS_MAX) },
      result: over(RESULT_MAX),
      error: null,
      diff: over(DIFF_MAX),
    });
    expect(capped.result).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
    expect(capped.diff).toHaveLength(DIFF_MAX + TRUNCATED_SUFFIX.length);
    const args = capped.arguments as { path: string; body: string };
    expect(args.path).toBe("a.ts");
    expect(args.body).toHaveLength(ARGS_MAX + TRUNCATED_SUFFIX.length);
  });

  it("keeps a tool_call's absent diff absent rather than making it explicitly undefined", () => {
    const capped = capDetail("tool_call", {
      agent: "lead",
      iteration_ref: 1,
      started_at: 1,
      ended_at: 2,
      name: "fs.read",
      arguments: {},
      result: over(RESULT_MAX),
      error: null,
    });
    expect("diff" in capped).toBe(false);
  });

  it("caps strings nested in arrays and objects inside arguments", () => {
    const capped = capDetail("tool_call_started", {
      agent: "lead",
      call_id: "c1",
      iteration_ref: 1,
      started_at: 1,
      name: "batch",
      arguments: { files: [{ text: over(ARGS_MAX) }, { text: "small" }], n: 3 },
    });
    const args = capped.arguments as { files: { text: string }[]; n: number };
    expect(args.files[0]!.text).toHaveLength(ARGS_MAX + TRUNCATED_SUFFIX.length);
    expect(args.files[1]!.text).toBe("small");
    expect(args.n).toBe(3);
  });

  it("bounds aggregate argument width even when every individual string is small", () => {
    const arguments_ = Object.fromEntries(
      Array.from({ length: DETAIL_MAX_ENTRIES + 100 }, (_, index) => [
        `key_${String(index)}`,
        "x".repeat(64),
      ]),
    );
    const capped = capDetail("tool_call_started", {
      agent: "lead",
      call_id: "wide",
      iteration_ref: 1,
      started_at: 1,
      name: "wide.args",
      arguments: arguments_,
    }).arguments as Record<string, unknown>;

    expect(Object.keys(capped).length).toBeLessThanOrEqual(DETAIL_MAX_ENTRIES + 1);
    expect(capped[DETAIL_TRUNCATED_KEY]).toBe(true);
    expect(JSON.stringify(capped).length).toBeLessThan(ARGS_TOTAL_MAX * 2);
  });

  it("bounds deeply nested and cyclic contributed detail without recursing forever", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < DETAIL_MAX_DEPTH + 20; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.cycle = root;

    const capped = capDetail("contributed.deep", root) as Record<string, unknown>;
    let projected: unknown = capped;
    let depth = 0;
    while (projected !== null && typeof projected === "object" && "next" in projected) {
      projected = (projected as Record<string, unknown>).next;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(DETAIL_MAX_DEPTH);
    expect(JSON.stringify(capped).length).toBeLessThan(ARGS_TOTAL_MAX * 2);
  });

  it("projects sparse arrays without filling holes or retaining an unbounded tail", () => {
    const sparse = new Array<unknown>(DETAIL_MAX_ENTRIES + 4);
    sparse[2] = "kept";
    sparse[sparse.length - 1] = "tail";
    const capped = capDetail("contributed.sparse", sparse) as unknown[];

    expect(Object.hasOwn(capped, 0)).toBe(false);
    expect(capped[2]).toBe("kept");
    expect(capped.at(-1)).toBe(TRUNCATED_SUFFIX);
  });

  it("drops contributed accessors and stops when aggregate object and array budgets expire", () => {
    const withAccessor: Record<string, unknown> = { safe: "value" };
    Object.defineProperty(withAccessor, "computed", {
      enumerable: true,
      get: () => "must not execute",
    });
    const accessorResult = capDetail("contributed.accessor", withAccessor) as Record<
      string,
      unknown
    >;
    expect(accessorResult.safe).toBe("value");
    expect(accessorResult.computed).toBeUndefined();
    expect(accessorResult[DETAIL_TRUNCATED_KEY]).toBe(true);

    const wide = { ["k".repeat(ARGS_TOTAL_MAX + 1)]: 1 };
    expect(
      (capDetail("contributed.wide", wide) as Record<string, unknown>)[DETAIL_TRUNCATED_KEY],
    ).toBe(true);

    const broadArray = Array.from({ length: 20 }, () => "x".repeat(ARGS_TOTAL_MAX));
    const arrayResult = capDetail("contributed.array-budget", broadArray) as unknown[];
    expect(arrayResult.length).toBeLessThan(broadArray.length);
    expect(arrayResult.at(-1)).toBe("");
  });

  it("keeps the tail of a live output delta", () => {
    const capped = capDetail("tool_output_delta", {
      agent: "lead",
      call_id: "c1",
      chunk: "x".repeat(LIVE_CHUNK_MAX) + "END",
    });
    expect(capped.chunk).toHaveLength(LIVE_CHUNK_MAX);
    expect(capped.chunk.endsWith("END")).toBe(true);
  });

  it("caps the free text of iterations, delegations, steering, errors and reasoning", () => {
    expect(
      capDetail("lead_iteration", {
        iteration: 1,
        started_at: 0,
        ended_at: 1,
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_read_ratio: 0,
        response: over(MODEL_RESPONSE_MAX),
      }).response,
    ).toHaveLength(MODEL_RESPONSE_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("subagent_iteration", {
        subagent_instance_id: "w1",
        iteration: 1,
        started_at: 0,
        ended_at: 1,
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_read_ratio: 0,
        response: over(MODEL_RESPONSE_MAX),
      }).response,
    ).toHaveLength(MODEL_RESPONSE_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("delegation_created", {
        delegation_id: "d1",
        title: "inspect",
        task: over(DELEGATE_TASK_MAX_CHARS),
        tools: [],
      }).task,
    ).toHaveLength(DELEGATE_TASK_MAX_CHARS);

    const unicodeTask = "😀".repeat(DELEGATE_TASK_MAX_CHARS);
    expect(
      capDetail("delegation_created", {
        delegation_id: "d1-unicode",
        title: "inspect",
        task: unicodeTask,
        tools: [],
      }).task,
    ).toBe(unicodeTask);

    expect(
      capDetail("delegation_completed", {
        delegation_id: "d1",
        status: "completed",
        result: over(RESULT_MAX),
      }).result,
    ).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("delegation_failed", {
        delegation_id: "d1",
        status: "failed",
        result: over(RESULT_MAX),
      }).result,
    ).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("user_steering", {
        agent: "lead",
        iteration_ref: 1,
        message: over(RESULT_MAX),
      }).message,
    ).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("model_call_error", {
        agent: "lead",
        iteration: 1,
        model: "m",
        kind: "transient",
        message: over(RESULT_MAX),
      }).message,
    ).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("model_reasoning", {
        agent: "lead",
        iteration: 1,
        model: "m",
        text: over(RESULT_MAX),
      }).text,
    ).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("model_stream_delta", {
        agent: "lead",
        iteration: 1,
        model: "m",
        channel: "text",
        text: over(RESULT_MAX),
        reset: false,
      }).text,
    ).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
  });

  it("caps a user_question's question at the summary bound and its answer at the result bound", () => {
    const capped = capDetail("user_question", {
      agent: "lead",
      iteration_ref: 1,
      question: over(SUMMARY_MAX),
      outcome: "accept",
      answer: over(RESULT_MAX),
    });
    expect(capped.question).toHaveLength(SUMMARY_MAX + TRUNCATED_SUFFIX.length);
    expect(capped.answer).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
  });

  it("keeps a user_question's absent answer absent", () => {
    const capped = capDetail("user_question", {
      agent: "lead",
      iteration_ref: 1,
      question: over(SUMMARY_MAX),
      outcome: "decline",
    });
    expect("answer" in capped).toBe(false);
  });

  it("caps convergence warnings and elicitation questions at the summary bound", () => {
    expect(
      capDetail("convergence_warning", {
        agent: "lead",
        code: "tool_failure_loop",
        message: over(SUMMARY_MAX),
      }).message,
    ).toHaveLength(SUMMARY_MAX + TRUNCATED_SUFFIX.length);

    expect(
      capDetail("elicitation_requested", {
        source: "ask_user",
        question: over(SUMMARY_MAX),
      }).question,
    ).toHaveLength(SUMMARY_MAX + TRUNCATED_SUFFIX.length);
  });

  it("caps each degraded server's reason and leaves the untouched ones by reference", () => {
    const ok = { name: "b", transport: "http", reason: "short" } as const;
    const detail = {
      servers: [{ name: "a", transport: "stdio" as const, reason: over(SUMMARY_MAX) }, ok],
    };
    const capped = capDetail("mcp_degraded", detail);
    expect(capped).not.toBe(detail);
    expect(capped.servers[0]!.reason).toHaveLength(SUMMARY_MAX + TRUNCATED_SUFFIX.length);
    expect(capped.servers[1]).toBe(ok);
  });

  it("returns the same mcp_degraded detail when every reason already fits", () => {
    const detail = { servers: [{ name: "a", transport: "sse" as const, reason: "short" }] };
    expect(capDetail("mcp_degraded", detail)).toBe(detail);
  });
});

/**
 * A kind a capability declared carries a `detail` this package cannot know the
 * shape of, so it cannot be capped field by field like every builtin above. It
 * still has to be capped: the branch that carries a contributed detail through
 * verbatim is exactly the one that skips every bound in this file, and what it
 * writes goes to disk and back out over rehydration.
 */
describe("capDetail on a contributed kind", () => {
  it("caps every string it can reach at the free-text bound", () => {
    const capped = capDetail("plan_review", {
      document: over(RESULT_MAX),
      nested: { diff: over(RESULT_MAX), fine: "short" },
      list: [over(RESULT_MAX)],
    }) as Record<string, never>;
    const detail = capped as unknown as {
      document: string;
      nested: { diff: string; fine: string };
      list: string[];
    };
    expect(detail.document).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
    expect(detail.nested.diff).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
    expect(detail.list[0]).toHaveLength(RESULT_MAX + TRUNCATED_SUFFIX.length);
    expect(detail.nested.fine).toBe("short");
  });

  it("returns the detail by reference when nothing needed shortening", () => {
    const detail = { id: "p1", tasks: [{ title: "a" }], count: 3 };
    expect(capDetail("plan_review", detail)).toBe(detail);
  });

  it("leaves a non-object detail alone rather than assuming a shape", () => {
    expect(capDetail("plan_review", 7)).toBe(7);
    expect(capDetail("plan_review", null)).toBe(null);
    expect(capDetail("plan_review", undefined)).toBe(undefined);
  });
});
