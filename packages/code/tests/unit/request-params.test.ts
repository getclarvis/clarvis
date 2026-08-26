import { expect, test } from "bun:test";
import { FORBIDDEN_PROVIDER_BODY_KEYS } from "@clarvis/kernel/policy";
import {
  bodyFootnote,
  bodyKeyProblem,
  bodySuggestions,
  headerKeyProblem,
  headersFootnote,
  headerValueProblem,
  headerSuggestions,
} from "../../src/features/providers/request-params.ts";

test("the two routing knobs the cache problem turns on are offered inside `provider`, not at the root", () => {
  const root = bodySuggestions([]).map((s) => s.key);
  expect(root).toContain("provider");
  expect(root).not.toContain("order");
  expect(root).not.toContain("allow_fallbacks");

  const nested = bodySuggestions(["provider"]).map((s) => s.key);
  expect(nested).toContain("order");
  expect(nested).toContain("allow_fallbacks");
});

test("picking `provider` stages the routing block already shaped, so the two knobs are one drill away", () => {
  const hit = bodySuggestions([]).find((s) => s.key === "provider");
  expect(hit?.value).toEqual({ order: [], allow_fallbacks: false });
});

test("an undocumented path offers nothing rather than repeating the root's keys", () => {
  expect(bodySuggestions(["max_price"])).toEqual([]);
  expect(bodySuggestions(["provider", "max_price"])).toEqual([]);
  expect(bodySuggestions(["reasoning"]).map((s) => s.key)).toContain("effort");
});

test("no suggested key is one the request assembles for itself", () => {
  const offered = [
    ...bodySuggestions([]),
    ...bodySuggestions(["provider"]),
    ...bodySuggestions(["reasoning"]),
  ];
  for (const s of offered) expect(FORBIDDEN_PROVIDER_BODY_KEYS).not.toContain(s.key);
});

test("every suggestion carries the sentence that explains it", () => {
  const all = [
    ...headerSuggestions("openai-compatible"),
    ...bodySuggestions([]),
    ...bodySuggestions(["provider"]),
  ];
  for (const s of all) expect(s.detail?.length ?? 0).toBeGreaterThan(0);
});

test("bodyKeyProblem guards the root only — a nested `messages` is the provider's own field", () => {
  for (const key of FORBIDDEN_PROVIDER_BODY_KEYS) {
    expect(bodyKeyProblem(key, [])).toContain(key);
    expect(bodyKeyProblem(key, ["provider"])).toBeUndefined();
  }
  expect(bodyKeyProblem("temperature", [])).toBeUndefined();
});

test("a header value may embed and repeat ${VAR}; only an unterminated ${ is refused", () => {
  expect(headerValueProblem("Bearer ${TOKEN}")).toBeUndefined();
  expect(headerValueProblem("${A}-${B}")).toBeUndefined();
  expect(headerValueProblem("clarvis")).toBeUndefined();
  expect(headerValueProblem("Bearer ${TOKEN")).toContain("malformed");
  expect(headerValueProblem("${lower_case}")).toBeUndefined();
  expect(headerValueProblem("${9NOPE}")).toContain("malformed");
  expect(headerValueProblem(7)).toContain("must be text");
});

test("a header name carrying a space or a colon is refused at the moment it is typed", () => {
  expect(headerKeyProblem("X-Title")).toBeUndefined();
  expect(headerKeyProblem("anthropic-beta")).toBeUndefined();
  expect(headerKeyProblem("X Title")).toContain("not a legal header name");
  expect(headerKeyProblem("X-Title:")).toContain("not a legal header name");
  expect(headerKeyProblem("")).toContain("not a legal header name");
});

test("the body footnote warns on a kind with no request-body seam, and stays quiet on the one that has it", () => {
  expect(bodyFootnote("openai-compatible", [])).not.toContain("no request-body seam");
  expect(bodyFootnote("openai-compatible", ["provider"])).toContain("provider");
  for (const kind of ["openai", "anthropic", "google"] as const) {
    expect(bodyFootnote(kind, [])).toContain("no request-body seam");
  }
});

test("the headers footnote says where the values go and that the file is committed", () => {
  expect(headersFootnote("provider")).toContain("never paste a key here");
  expect(headersFootnote("model")).toContain("this model");
});

test("the credential header offered is the one the kind's SDK actually authenticates with", () => {
  const first = (kind: Parameters<typeof headerSuggestions>[0]): string =>
    headerSuggestions(kind)[0]!.key;
  expect(first("openai-compatible")).toBe("Authorization");
  expect(first("openai")).toBe("Authorization");
  expect(first("anthropic")).toBe("x-api-key");
  expect(first("google")).toBe("x-goog-api-key");
});

test("no kind is offered a credential header that would override nothing", () => {
  for (const kind of ["anthropic", "google"] as const) {
    expect(headerSuggestions(kind).map((s) => s.key)).not.toContain("Authorization");
  }
});
