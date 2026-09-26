import { expect, test } from "bun:test";
import type { ActionAuthorizationPort, LLMToolCall } from "@clarvis/capability";
import { authorizeAction } from "../../src/runtime/tools/authorize-action.ts";

const call: LLMToolCall = { id: "call", name: "external", arguments: { value: 1 } };

test("external actions refresh authority after steering and use the current policy", async () => {
  let revision = 0;
  let policy = "first";
  const seen: Array<[string, number]> = [];
  const port = {
    identity: { owner: "owner", executionId: "run" },
    get policyRevision() {
      return policy;
    },
    revision: () => revision,
    async authorize(request: Parameters<ActionAuthorizationPort["authorize"]>[0]) {
      seen.push([request.policyRevision, request.authorizationRevision]);
      if (seen.length === 1) {
        revision++;
        policy = "second";
      }
      return { granted: true, fingerprint: "ok", evidence: { reason: "approved" } };
    },
    valid: (request: Parameters<ActionAuthorizationPort["authorize"]>[0]) =>
      request.authorizationRevision === revision && request.policyRevision === policy,
  } as unknown as ActionAuthorizationPort;
  expect(await authorizeAction(port, call, "external", "lead")).toBeNull();
  expect(seen).toEqual([
    ["first", 0],
    ["second", 1],
  ]);
});

test("malformed and denied external actions do not execute", async () => {
  let reviews = 0;
  const port = {
    identity: { owner: "owner", executionId: "run" },
    policyRevision: "policy",
    revision: () => 0,
    async authorize() {
      reviews++;
      return { granted: false, fingerprint: "denied", evidence: { reason: "blocked" } };
    },
    valid: () => true,
  } as unknown as ActionAuthorizationPort;
  expect(await authorizeAction(undefined, call, "external", "lead")).toBeNull();
  expect(await authorizeAction(port, { ...call, arguments: [] }, "external", "lead")).toBe(
    "invalid tool arguments",
  );
  expect(await authorizeAction(port, call, "external", "lead")).toBe("Action denied: blocked");
  expect(reviews).toBe(1);
});

test("a steering interruption retries the external action under its new authority", async () => {
  let revision = 0;
  let calls = 0;
  const port = {
    identity: { owner: "owner", executionId: "run" },
    get policyRevision() {
      return String(revision);
    },
    revision: () => revision,
    async authorize(request: Parameters<ActionAuthorizationPort["authorize"]>[0]) {
      calls++;
      if (calls === 1) {
        revision++;
        throw new Error("authority changed");
      }
      expect(request.policyRevision).toBe("1");
      return { granted: true, fingerprint: "ok", evidence: { reason: "approved" } };
    },
    valid: () => true,
  } as unknown as ActionAuthorizationPort;
  expect(await authorizeAction(port, call, "external", "lead")).toBeNull();
  expect(calls).toBe(2);
});
