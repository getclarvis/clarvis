import { describe, it, expect } from "../bun-test.ts";
import { deriveRunShape } from "../../src/validation/request-schema.ts";
import type { RunRequest } from "@clarvis/capability";

/**
 * A capability's own gate can park a run on a human without the entry profile
 * holding `ask_user`. Two run-level decisions are derived from whether that
 * happens — the elicitation relay/serializer, and the prompt-cache TTL — and
 * neither can be recovered later, so the shape has to be told.
 *
 * These pin the fold itself. Both flags read `false` for the same request when
 * the capability term is dropped, which is how a review-gated run came to have
 * no relay and a five-minute cache entry while blocking on an approval prompt.
 */
const body = (over: Partial<RunRequest> = {}): RunRequest =>
  ({
    messages: [{ role: "user", content: "hi" }],
    servers: [],
    profiles: [{ name: "solo", model: "anthropic/claude-sonnet-4-5", tools: [] }],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { on_exceed: "stop", total_token_limit: 1000 },
    ...over,
  }) as unknown as RunRequest;

describe("deriveRunShape with a capability that must reach the human", () => {
  it("leaves both flags false when nothing needs a human", () => {
    const shape = deriveRunShape(body(), false)!;
    expect(shape.askUserGranted).toBe(false);
    expect(shape.userInputEnabled).toBe(false);
    expect(shape.humanParkLikely).toBe(false);
  });

  it("enables user input for a profile with no ask_user grant", () => {
    const shape = deriveRunShape(body(), true)!;
    expect(shape.askUserGranted).toBe(false);
    // The relay and the FIFO prompt serializer are gated on this. Without it an
    // MCP server's elicitation during the run gets no handler at all, and a
    // capability's prompt can overlap a guard escalation.
    expect(shape.userInputEnabled).toBe(true);
  });

  it("selects the long prompt-cache TTL, because that run parks on a person", () => {
    // `humanParkLikely` is the whole input to `prompt_cache_ttl`'s default. A
    // run that blocks on an approval taking longer than five minutes expires a
    // 5m entry and re-charges its entire prefix on the next call.
    expect(deriveRunShape(body(), true)!.humanParkLikely).toBe(true);
  });

  it("still honours elicit_wait_ms: 0, the host declaring it never blocks", () => {
    const shape = deriveRunShape(body({ elicit_wait_ms: 0 } as Partial<RunRequest>), true)!;
    expect(shape.humanParkLikely).toBe(false);
    // …but the channel itself is still enabled: a capability that needs a human
    // and cannot wait must still be able to reach one and be declined.
    expect(shape.userInputEnabled).toBe(true);
  });

  it("defaults to false, so a caller that knows of no capability is unchanged", () => {
    expect(deriveRunShape(body())!.userInputEnabled).toBe(false);
  });
});
