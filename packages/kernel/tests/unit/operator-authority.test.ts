import { describe, expect, test } from "bun:test";
import type { OperatorAuthoritySeed, OperatorAuthorityState } from "@clarvis/capability";
import { inheritOperatorAuthority } from "@clarvis/capability";
import {
  createOperatorAuthorityRuntime,
  installAuthorityEnvelope,
} from "../../src/guard/operator-authority.ts";

const seed = (text = "Open a PR"): OperatorAuthoritySeed => ({
  binding: {
    owner_key_name: "owner",
    session_id: "session",
    controller_epoch: "epoch",
    outcome_id: "outcome",
  },
  evidence: [{ id: "input", source: "start", text, execution_id: "first" }],
});
const runtime = (initial = seed(), prior?: OperatorAuthorityState) =>
  createOperatorAuthorityRuntime({ seed: initial, prior, owner: "owner", executionId: "run" });

describe("host operator ledger", () => {
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
  });
  test("detaches snapshots and increments revision once for a steer id", () => {
    const ledger = runtime();
    const before = ledger.reader.snapshot();
    before.evidence[0]!.text = "forged";
    expect(ledger.reader.snapshot().evidence[0]!.text).toBe("Open a PR");
    const steer = { agent: "lead" as const, iteration: 1, id: "steer", message: "Do not push" };
    ledger.onSteer(steer);
    ledger.onSteer(steer);
    expect(ledger.reader.snapshot().revision).toBe(before.revision + 1);
    expect(ledger.reader.snapshot().evidence.at(-1)?.text).toBe("Do not push");
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
  test("revokes instead of losing restrictions at UTF-8 or count bounds", () => {
    expect(runtime(seed("é".repeat(2049))).reader.snapshot().status).toBe("revoked");
    const ledger = runtime();
    for (let index = 0; index < 32; index++) {
      ledger.onSteer({
        agent: "lead",
        iteration: index,
        id: String(index),
        message: "Do not push",
      });
    }
    expect(ledger.reader.snapshot().status).toBe("revoked");
    expect(ledger.reader.snapshot().evidence).toHaveLength(32);
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
