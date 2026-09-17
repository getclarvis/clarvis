import { describe, expect, test } from "bun:test";
import type { OperatorAuthoritySeed, OperatorAuthorityState } from "@clarvis/capability";
import { inheritOperatorAuthority } from "@clarvis/capability";
import { MESSAGES_MAX_ENTRIES } from "@clarvis/loop/host";
import {
  createOperatorAuthorityRuntime,
  installAuthorityEnvelope,
  denyAuthorityEffect,
} from "../../src/guard/operator-authority.ts";

const seed = (text = "Open a PR"): OperatorAuthoritySeed => ({
  binding: {
    owner_key_name: "owner",
    session_id: "session",
    controller_epoch: "epoch",
    outcome_id: "outcome",
  },
  evidence: [{ id: "input", source: "start", text, execution_id: "first" }],
  review_context: {
    kind: "goal",
    content: JSON.stringify({ objective: "Prepare the bounded change" }),
  },
});
const runtime = (initial = seed(), prior?: OperatorAuthorityState) =>
  createOperatorAuthorityRuntime({ seed: initial, prior, owner: "owner", executionId: "run" });

describe("host operator ledger", () => {
  test("keeps compile context with its envelope across continuation and clears it on replacement", () => {
    const ledger = runtime();
    const envelope = {
      version: 1 as const,
      revision: ledger.reader.snapshot().revision,
      objectives: [],
      grants: [],
      exclusions: [],
    };
    expect(installAuthorityEnvelope(ledger.reader, envelope, "plan-1")).toBe(true);
    const prior = ledger.finalize({ status: "completed", disposition: "checkpoint" });
    const continued = runtime(seed(), prior);
    expect(continued.reader.snapshot().envelope_context_revision).toBe("plan-1");
    expect(installAuthorityEnvelope(continued.reader, envelope, "")).toBe(false);
    expect(continued.reader.snapshot().envelope_context_revision).toBe("plan-1");
    expect(installAuthorityEnvelope(continued.reader, envelope)).toBe(true);
    expect(continued.reader.snapshot().envelope_context_revision).toBeUndefined();
    expect(installAuthorityEnvelope(continued.reader, envelope, `${"p".repeat(1_024)}:123`)).toBe(
      true,
    );
    expect(installAuthorityEnvelope(continued.reader, envelope, "p".repeat(2_049))).toBe(false);
    expect(continued.finalize({ status: "cancelled" }).envelope_context_revision).toBeUndefined();
    expect(runtime(seed(), { ...prior, envelope: undefined }).reader.snapshot().status).toBe(
      "revoked",
    );
    expect(
      runtime(seed(), { ...prior, envelope_context_revision: "" }).reader.snapshot().status,
    ).toBe("revoked");
  });
  test("mints a new outcome only for a fresh-evidence transition and replaces the old envelope", () => {
    const ledger = runtime();
    const initial = {
      version: 1 as const,
      revision: ledger.reader.snapshot().revision,
      objectives: [
        {
          id: "old",
          summary: "Old objective",
          target_digests: ["target"],
          evidence_ids: ["input"],
        },
      ],
      grants: [],
      exclusions: [],
    };
    expect(installAuthorityEnvelope(ledger.reader, initial)).toBe(true);
    const next = structuredClone(initial);
    next.objectives[0]!.id = "new";
    expect(installAuthorityEnvelope(ledger.reader, next)).toBe(false);
    ledger.onSteer({ agent: "lead", iteration: 1, message: "Start a different outcome" });
    const before = ledger.reader.snapshot();
    next.revision = before.revision;
    expect(installAuthorityEnvelope(ledger.reader, next)).toBe(false);
    next.objectives[0]!.evidence_ids = [before.evidence.at(-1)!.id];
    expect(installAuthorityEnvelope(ledger.reader, next)).toBe(true);
    const after = ledger.reader.snapshot();
    expect(after.binding.outcome_id).not.toBe(before.binding.outcome_id);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.envelope?.revision).toBe(after.revision);
    expect(after.envelope?.objectives.map((objective) => objective.id)).toEqual(["new"]);
  });
  test("rejects inherited authority when a steer precedes child admission", () => {
    const parent = runtime();
    installAuthorityEnvelope(parent.reader, {
      version: 1,
      revision: parent.reader.snapshot().revision,
      objectives: [],
      grants: [],
      exclusions: [],
    });
    const inherited = inheritOperatorAuthority(parent.reader, "parent");
    expect(inherited).toBeDefined();
    expect(inherited?.review_context).toEqual(parent.reader.snapshot().review_context);
    parent.onSteer({ agent: "lead", iteration: 1, message: "Do not commit" });
    const child = createOperatorAuthorityRuntime({
      seed: inherited,
      parent: parent.reader,
      owner: "owner",
      executionId: "child",
    });
    expect(child.reader.snapshot().status).toBe("revoked");
  });
  test("missing or forged host seed never falls back to transcript evidence", () => {
    expect(
      createOperatorAuthorityRuntime({ owner: "owner", executionId: "run" }).reader.snapshot()
        .status,
    ).toBe("revoked");
    const forged = seed();
    forged.binding.owner_key_name = "other";
    expect(runtime(forged).reader.snapshot().status).toBe("revoked");
    const malformedContext = seed();
    malformedContext.review_context = { kind: "goal", content: "not-json" };
    expect(runtime(malformedContext).reader.snapshot().status).toBe("revoked");
  });
  test("detaches snapshots and increments revision once for a steer id", () => {
    const ledger = runtime();
    const before = ledger.reader.snapshot();
    before.evidence[0]!.text = "forged";
    expect(ledger.reader.snapshot().evidence[0]!.text).toBe("Open a PR");
    before.review_context!.content = "{}";
    expect(ledger.reader.snapshot().review_context).toEqual(seed().review_context);
    const steer = { agent: "lead" as const, iteration: 1, id: "steer", message: "Do not push" };
    ledger.onSteer(steer);
    ledger.onSteer(steer);
    expect(ledger.reader.snapshot().revision).toBe(before.revision + 1);
    expect(ledger.reader.snapshot().evidence.at(-1)?.text).toBe("Do not push");
  });
  test("admits an accepted ask_user answer with its untrusted question context", () => {
    const ledger = runtime();
    const before = ledger.reader.snapshot();
    const elicitation = {
      question: "May I update SAFE-09 through SAFE-11?",
      answer: "Authorize the three lines",
    };
    ledger.onElicitation(elicitation);
    const after = ledger.reader.snapshot();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.evidence.at(-1)).toMatchObject({
      source: "ask_user",
      prompt: elicitation.question,
      text: elicitation.answer,
      agent: "lead",
      execution_id: "run",
    });
  });
  test("invalidates in-flight compilation and installed grants on steer", () => {
    const ledger = runtime();
    const envelope = {
      version: 1 as const,
      revision: ledger.reader.snapshot().revision,
      objectives: [],
      grants: [],
      exclusions: [],
    };
    expect(installAuthorityEnvelope(ledger.reader, envelope)).toBe(true);
    ledger.onSteer({ agent: "lead", iteration: 1, message: "Do not push" });
    expect(ledger.reader.snapshot().envelope?.revision).not.toBe(ledger.reader.snapshot().revision);
    expect(installAuthorityEnvelope(ledger.reader, envelope)).toBe(false);
  });
  test("restores active evidence only under the complete unchanged binding", () => {
    const prior = runtime().finalize({ status: "completed", disposition: "checkpoint" });
    const next = seed("Continue");
    next.evidence = [{ ...next.evidence[0]!, id: "next", source: "continue" }];
    expect(runtime(next, prior).reader.snapshot().evidence).toHaveLength(2);
    for (const key of ["owner_key_name", "session_id", "controller_epoch", "outcome_id"] as const) {
      const changed = structuredClone(prior);
      changed.binding[key] = "different";
      expect(runtime(next, changed).reader.snapshot().evidence).toHaveLength(1);
    }
    for (const status of ["settled", "revoked"] as const) {
      expect(runtime(next, { ...prior, status }).reader.snapshot().evidence).toHaveLength(1);
    }
  });
  test("accepts long user input and applies the request message-count ceiling", () => {
    const long = seed("é".repeat(20_000));
    const accepted = runtime(long).reader.snapshot();
    expect(accepted.status).toBe("active");
    expect(accepted.evidence[0]?.text).toBe(long.evidence[0]?.text);

    const overflow = seed();
    overflow.evidence = Array.from({ length: MESSAGES_MAX_ENTRIES + 1 }, (_, index) => ({
      id: `input-${index}`,
      source: "start" as const,
      text: "Inspect",
      execution_id: "first",
    }));
    expect(runtime(overflow).reader.snapshot().status).toBe("revoked");
  });
  test("cancellation revokes and successful finalization settles", () => {
    const signal = new AbortController();
    const ledger = createOperatorAuthorityRuntime({
      seed: seed(),
      owner: "owner",
      executionId: "run",
      signal: signal.signal,
    });
    signal.abort();
    expect(ledger.finalize({ status: "cancelled" }).status).toBe("revoked");
    expect(runtime().finalize({ status: "completed" }).status).toBe("settled");
  });
});

test("refusal storage is bounded, revision-fenced and cannot be supplied as seed evidence", () => {
  const ledger = runtime();
  const revision = ledger.reader.snapshot().revision;
  expect(denyAuthorityEffect(ledger.reader, revision - 1, "a".repeat(64))).toBe(false);
  for (let i = 0; i < 32; i++)
    expect(denyAuthorityEffect(ledger.reader, revision, i.toString(16).padStart(64, "0"))).toBe(
      true,
    );
  expect(denyAuthorityEffect(ledger.reader, revision, "f".repeat(64))).toBe(false);
  expect(ledger.reader.snapshot().status).toBe("revoked");
  const invalid = runtime(seed(), { ...runtime().reader.snapshot(), denied_effects: ["invalid"] });
  expect(invalid.reader.snapshot().status).toBe("revoked");
  const forged = { ...seed(), denied_effects: ["a".repeat(64)] };
  expect(runtime(forged).reader.snapshot().status).toBe("revoked");
});
