import { describe, it, expect } from "../helpers/bun-test.ts";
import { classifyProviderError, parseRetryAfter } from "../../src/index.ts";

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe("classifyProviderError — kind matrix", () => {
  it("classifies 429 as transient", () => {
    expect(classifyProviderError({ status: 429 })).toMatchObject({
      kind: "transient",
      status: 429,
    });
  });

  it("classifies 503 as transient", () => {
    expect(classifyProviderError({ status: 503 })).toMatchObject({
      kind: "transient",
      status: 503,
    });
  });

  it("classifies 500 as transient", () => {
    expect(classifyProviderError({ status: 500 })).toMatchObject({
      kind: "transient",
      status: 500,
    });
  });

  it("classifies 529 as transient", () => {
    expect(classifyProviderError({ status: 529 })).toMatchObject({
      kind: "transient",
      status: 529,
    });
  });

  it("classifies an errored call with a 2xx status as transient (unusable 200 body)", () => {
    expect(classifyProviderError({ status: 200 })).toMatchObject({
      kind: "transient",
      status: 200,
    });
    expect(classifyProviderError({ status: 204 })).toMatchObject({
      kind: "transient",
      status: 204,
    });
  });

  it("keeps quota and overflow text signals authoritative over a 2xx status", () => {
    expect(
      classifyProviderError({ status: 200, body: "you have exceeded your current quota" }),
    ).toMatchObject({ kind: "quota", status: 200 });
    expect(
      classifyProviderError({ status: 200, body: "maximum context length exceeded" }),
    ).toMatchObject({ kind: "context_overflow", status: 200 });
  });

  it("classifies 401 as auth", () => {
    expect(classifyProviderError({ status: 401 })).toMatchObject({ kind: "auth", status: 401 });
  });

  it("classifies 403 as auth", () => {
    expect(classifyProviderError({ status: 403 })).toMatchObject({ kind: "auth", status: 403 });
  });

  it("classifies 400 as client", () => {
    expect(classifyProviderError({ status: 400 })).toMatchObject({ kind: "client", status: 400 });
  });

  it("classifies 404 as client", () => {
    expect(classifyProviderError({ status: 404 })).toMatchObject({ kind: "client", status: 404 });
  });

  it("classifies a context-length body as context_overflow even with a 4xx status", () => {
    const c = classifyProviderError({
      status: 400,
      body: JSON.stringify({
        error: { message: "This model's maximum context length is 8192 tokens" },
      }),
    });
    expect(c.kind).toBe("context_overflow");
  });

  it("classifies a context-length body as context_overflow with a 200-ish/none status", () => {
    const c = classifyProviderError({ body: "context_length_exceeded: reduce the length" });
    expect(c.kind).toBe("context_overflow");
  });

  it("classifies an overloaded body as transient even with an ambiguous status", () => {
    const c = classifyProviderError({ status: 200, body: '{"type":"overloaded_error"}' });
    expect(c.kind).toBe("transient");
  });

  it("classifies a 429 quota/billing body as quota (permanent, not retried)", () => {
    const c = classifyProviderError({
      status: 429,
      body: JSON.stringify({
        error: {
          type: "insufficient_quota",
          message: "You exceeded your current quota, please check your plan and billing details.",
        },
      }),
      isRetryable: true,
    });
    expect(c.kind).toBe("quota");
    expect(c.status).toBe(429);
  });

  it("classifies a 4xx with overload-ish body text as client (not retried)", () => {
    const c = classifyProviderError({
      status: 400,
      body: "the service is temporarily unavailable, please try again",
    });
    expect(c.kind).toBe("client");
  });

  it("still classifies overload text as transient without a definitive 4xx status", () => {
    expect(classifyProviderError({ body: "temporarily unavailable, try again" }).kind).toBe(
      "transient",
    );
    expect(classifyProviderError({ status: 503, body: "overloaded" }).kind).toBe("transient");
  });

  it("classifies a per-call timeout (no status) as transient with status absent", () => {
    const c = classifyProviderError({ timedOut: true });
    expect(c.kind).toBe("transient");
    expect(c.status).toBeUndefined();
  });

  it("classifies a connection failure (cause, no status) as transient with status absent", () => {
    const c = classifyProviderError({ cause: new Error("ECONNREFUSED") });
    expect(c.kind).toBe("transient");
    expect(c.status).toBeUndefined();
  });

  it("never throws and defaults to client (non-retryable) on an empty/unknown payload", () => {
    expect(() => classifyProviderError({})).not.toThrow();
    expect(classifyProviderError({}).kind).toBe("client");
    expect(classifyProviderError({ body: { weird: Symbol("x") } }).kind).toBe("client");
  });

  it("classifies a statusless deterministic local error (no network signature) as client", () => {
    const c = classifyProviderError({ cause: new TypeError("x is not a function") });
    expect(c.kind).toBe("client");
  });

  it("classifies a statusless 'fetch failed' transport error as transient", () => {
    const c = classifyProviderError({
      cause: Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      }),
    });
    expect(c.kind).toBe("transient");
  });

  it("treats a string cause carrying a network signal as transient", () => {
    expect(classifyProviderError({ cause: "socket hang up" }).kind).toBe("transient");
  });

  it("inspects a nested errors[] array for network signals", () => {
    const agg = Object.assign(new Error("multiple failures"), {
      errors: [Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:443"), { code: "ETIMEDOUT" })],
    });
    expect(classifyProviderError({ cause: agg }).kind).toBe("transient");
  });

  it("reads retry-after from headers onto a transient failure", () => {
    const c = classifyProviderError({ status: 429, headers: headers({ "Retry-After": "2" }) });
    expect(c).toMatchObject({ kind: "transient", status: 429, retryAfterMs: 2000 });
  });

  it("ignores a primitive (non-string, non-object) cause and defaults to client", () => {
    expect(classifyProviderError({ cause: 42 }).kind).toBe("client");
    expect(classifyProviderError({ cause: true }).kind).toBe("client");
  });

  it("still finds a network signal in a plain object cause that lacks name/message", () => {
    const c = classifyProviderError({ cause: { code: "ECONNRESET" } });
    expect(c.kind).toBe("transient");
  });

  it("treats a bare code-only object cause with no network signal as client", () => {
    const c = classifyProviderError({ cause: { code: "EACCES" } });
    expect(c.kind).toBe("client");
  });
});

describe("classifyProviderError — unstringifiable body", () => {
  it("swallows a JSON.stringify failure on a circular body and defaults to client", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const c = classifyProviderError({ body: circular });
    expect(c.kind).toBe("client");
  });

  it("reads a structured object cause, so its status words reach the tables", () => {
    const c = classifyProviderError({
      cause: { code: 429, message: "rate limit exceeded, please retry shortly" },
    });
    expect(c.kind).toBe("transient");
  });

  it("swallows a JSON.stringify failure on a circular cause and defaults to client", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const c = classifyProviderError({ cause: circular });
    expect(c.kind).toBe("client");
  });
});

describe("parseRetryAfter", () => {
  it("parses delay-seconds to milliseconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("  30 ")).toBe(30000);
  });

  it("parses an HTTP-date relative to injected now", () => {
    const now = Date.parse("2026-06-13T00:00:00Z");
    const future = "Sat, 13 Jun 2026 00:00:05 GMT";
    const ms = parseRetryAfter(future, now);
    expect(ms).toBeGreaterThanOrEqual(4500);
    expect(ms).toBeLessThanOrEqual(5500);
  });

  it("clamps a past HTTP-date to 0", () => {
    const now = Date.parse("2026-06-13T00:00:10Z");
    const past = "Sat, 13 Jun 2026 00:00:00 GMT";
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it("returns undefined for missing/empty/unparseable/negative", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("abc")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
  });

  it("returns undefined for an all-digit value so large it coerces to a non-finite number", () => {
    expect(parseRetryAfter("9".repeat(400))).toBeUndefined();
  });
});

describe("classifyProviderError — quota and content policy", () => {
  it("classifies content-policy bodies as content_policy", () => {
    for (const body of [
      '{"error":{"code":"content_filter"}}',
      '{"error":{"type":"content_policy_violation"}}',
      '{"error":{"code":"safety_violation"}}',
      "the request was stopped by a safety filter",
    ]) {
      expect(classifyProviderError({ status: 400, body }).kind).toBe("content_policy");
    }
  });

  /**
   * The signal table is tested ahead of the 429/529/5xx rules, so a bare
   * "safety" token turned every rate-limit or overload response whose
   * boilerplate happened to mention it into a permanent refusal. Every entry is
   * therefore multi-word or underscored.
   */
  it("does not treat an incidental mention of safety as a refusal", () => {
    for (const body of [
      "429 rate limited — see our safety and usage policies",
      '{"message":"service overloaded","docs":"https://example.test/trust-and-safety"}',
    ]) {
      expect(classifyProviderError({ status: 429, body }).kind).toBe("transient");
    }
  });

  /**
   * A quota or billing body sometimes mentions "safety" in boilerplate. Quota is
   * tested first so a spend problem is never reported as a policy refusal, which
   * would send the user to rewrite a prompt that was never the issue.
   */
  it("prefers quota over content policy when a body carries both signals", () => {
    const c = classifyProviderError({
      status: 429,
      body: "insufficient_quota — see our safety and billing docs",
    });
    expect(c.kind).toBe("quota");
  });

  it("leaves an ordinary rate-limit body transient", () => {
    expect(classifyProviderError({ status: 429, body: "rate limit exceeded" }).kind).toBe(
      "transient",
    );
  });

  it("still classifies an unremarkable 4xx as client", () => {
    expect(classifyProviderError({ status: 400, body: "bad request" }).kind).toBe("client");
  });
});

describe("parseRetryAfter / readRetryAfter — precision", () => {
  it("accepts decimal seconds", () => {
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0.25")).toBe(250);
  });

  it("reads retry-after-ms ahead of retry-after", () => {
    const headers = new Headers({ "retry-after-ms": "1500", "retry-after": "60" });
    expect(classifyProviderError({ status: 429, headers }).retryAfterMs).toBe(1500);
  });

  it("falls back to retry-after when no millisecond header is present", () => {
    const headers = new Headers({ "retry-after": "2" });
    expect(classifyProviderError({ status: 429, headers }).retryAfterMs).toBe(2000);
  });

  it("ignores a non-numeric retry-after-ms and falls through", () => {
    const headers = new Headers({ "retry-after-ms": "soon", "retry-after": "3" });
    expect(classifyProviderError({ status: 429, headers }).retryAfterMs).toBe(3000);
  });
});
