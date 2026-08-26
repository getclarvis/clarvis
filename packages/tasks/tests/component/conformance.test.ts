import { describe, expect, it } from "bun:test";
import { assertTaskProviderConformance } from "../../src/testing/provider-conformance.ts";
import { fullCapabilities, makeProvider, PROVIDER_KEY } from "../helpers/provider.ts";

describe("provider conformance harness", () => {
  it("validates a full provider without a kernel or TUI", async () => {
    const provider = makeProvider();
    const ref = { providerKey: PROVIDER_KEY, id: "CLAR-42" };
    const actor = { id: "agent", label: "Agent", kind: "agent" as const };
    const report = await assertTaskProviderConformance({
      provider,
      readableRef: ref,
      containerId: "CLAR",
      actorQuery: "Ana",
      mutations: {
        create: {
          input: { containerId: "CLAR", title: "Created" },
          changedInput: { containerId: "CLAR", title: "Created differently" },
        },
        assign: {
          input: { ref, assigneeId: "ana" },
          changedInput: { ref, assigneeId: "bob" },
        },
        comment: {
          input: { ref, body: "Evidence" },
          changedInput: { ref, body: "Different evidence" },
        },
        attachArtifact: {
          input: {
            ref,
            artifact: { kind: "url", label: "Build", url: "https://example.test/build" },
          },
          changedInput: {
            ref,
            artifact: {
              kind: "url",
              label: "Other build",
              url: "https://example.test/build",
            },
          },
        },
        transitions: [
          {
            input: { ref, intent: "start", claimant: actor, reason: "begin" },
            changedInput: { ref, intent: "start", claimant: actor, reason: "begin differently" },
          },
          {
            input: { ref, intent: "block", reason: "waiting" },
            changedInput: { ref, intent: "block", reason: "still waiting" },
          },
          {
            input: { ref, intent: "submit_review", reason: "ready" },
            changedInput: { ref, intent: "submit_review", reason: "ready differently" },
          },
          {
            input: { ref, intent: "complete", reason: "accepted" },
            changedInput: { ref, intent: "complete", reason: "accepted differently" },
          },
          {
            input: { ref, intent: "reopen", reason: "regression" },
            changedInput: { ref, intent: "reopen", reason: "another regression" },
          },
        ],
      },
      mutationContext: (operation) => ({
        owner: "owner",
        actor,
        executionId: "exec",
        idempotencyKey: `conformance:${operation}`,
      }),
    });
    expect(report.capabilities).toEqual(fullCapabilities);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        "capabilities",
        "read",
        "actors",
        "create-idempotency",
        "assign-idempotency",
        "comment-idempotency",
        "artifact-idempotency",
        "transition-start-idempotency",
        "transition-block-idempotency",
        "transition-submit_review-idempotency",
        "transition-complete-idempotency",
        "transition-reopen-idempotency",
      ]),
    );
    for (const operation of ["create", "assign", "comment", "attachArtifact"]) {
      expect(provider.calls.filter((call) => call.operation === operation)).toHaveLength(3);
    }
    expect(provider.calls.filter((call) => call.operation === "transition")).toHaveLength(15);
  });

  it("rejects capability/method drift and missing mutation fixtures", async () => {
    const readOnly = makeProvider({
      capabilities: {
        ...fullCapabilities,
        read: { ...fullCapabilities.read, actors: false },
        write: {
          create: false,
          assign: false,
          comment: false,
          attachArtifact: false,
          intents: [],
        },
      },
    });
    (readOnly as unknown as { searchActors: () => Promise<{ items: [] }> }).searchActors =
      async () => ({
        items: [],
      });
    await expect(
      assertTaskProviderConformance({
        provider: readOnly,
        readableRef: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        mutationContext: () => ({
          owner: "owner",
          actor: { id: "agent", label: "Agent", kind: "agent" },
          idempotencyKey: "key",
        }),
      }),
    ).rejects.toThrow("read.actors and searchActors presence disagree");

    await expect(
      assertTaskProviderConformance({
        provider: makeProvider(),
        readableRef: { providerKey: PROVIDER_KEY, id: "CLAR-42" },
        mutationContext: () => ({
          owner: "owner",
          actor: { id: "agent", label: "Agent", kind: "agent" },
          idempotencyKey: "key",
        }),
      }),
    ).rejects.toThrow("advertised create has no conformance fixture input");
  });
});
