/**
 * A continuation is assembled from a trace that has already been redacted.
 *
 * @remarks The trace store persists `sanitizeDeep(record.request)`, and the
 * redaction rule matches any JSON key *containing* `api_key`. `api_key_env`
 * contains it — while holding an environment variable *name*, never a secret —
 * so a provider block read back from disk arrives as
 * `api_key_env: "[redacted]"`, which the request schema rejects against
 * `^[A-Za-z_][A-Za-z0-9_]*$`. The pass then fails in `generate`, before any
 * model call, deterministically, for every run in a workspace configured that
 * way.
 *
 * It shipped because the other suites build their `StoredExecution` by hand and
 * so never meet the sanitizer. This one runs the real rule over a realistic
 * record and then validates with the real schema, which is the only arrangement
 * that could have caught it.
 *
 * The fix is not to loosen the redaction — it is correct to be conservative
 * about a key that looks like a credential. It is to stop sourcing *providers*
 * from the trace at all: they are host routing configuration, contribute nothing
 * to the prompt the provider hashes, and the factory already resolves them live.
 * `profiles`, `entry` and `prompt_cache_key` keep coming from the record, and
 * must, because those have to match what the indexed run actually used or the
 * prefix cache misses.
 */
import { describe, expect, it } from "bun:test";

import { sanitizeDeep } from "@clarvis/capability";
import type { ProviderConfig } from "@clarvis/capability";
import type { StoredExecution } from "@clarvis/loop";
import { providerConfigSchema } from "@clarvis/loop/host";
import { buildIndexerContinuationRequest } from "../../src/indexer/request.ts";

const MODEL = "openrouter/deepseek-v4-pro";

/** Providers as an operator really configures them, with a key *name*. */
const CONFIGURED: ProviderConfig[] = [
  {
    name: "openrouter",
    kind: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
  } as ProviderConfig,
];

/** A run as the store holds it: its request already through `sanitizeDeep`. */
function storedSubject(): StoredExecution {
  const request = {
    messages: [{ role: "user", content: "fix the build" }],
    prompt_cache_key: "session_abc123",
    servers: [],
    entry: "coder",
    profiles: [{ name: "coder", model: MODEL, tools: ["shell"], iteration_limit: 200 }],
    providers: CONFIGURED,
    budget: { on_exceed: "stop", total_token_limit: 900_000 },
  };
  return {
    id: "run_subject",
    owner_key_name: "o",
    status: "completed",
    request: sanitizeDeep(request),
    final_context: [{ message: { role: "user", content: "fix the build" } }],
  } as unknown as StoredExecution;
}

describe("the redaction that broke the pass", () => {
  it("really does redact api_key_env, which holds a name and not a secret", () => {
    const stored = storedSubject();
    expect(stored.request.providers[0]).toMatchObject({ api_key_env: "[redacted]" });
  });

  it("would produce a request the schema rejects, if it were copied from the trace", () => {
    const fromTrace = storedSubject().request.providers[0];
    expect(providerConfigSchema.safeParse(fromTrace).success).toBe(false);
  });
});

describe("assembling a continuation over a redacted trace", () => {
  it("takes providers from live settings, so every one of them validates", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: storedSubject(),
      providers: CONFIGURED,
    });
    for (const provider of request.providers) {
      expect(providerConfigSchema.safeParse(provider).success).toBe(true);
    }
  });

  it("carries no redaction marker anywhere in the assembled request", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: storedSubject(),
      providers: CONFIGURED,
    });
    expect(JSON.stringify(request)).not.toContain("[redacted]");
  });

  it("derives the Memory cache branch from the unredacted session key", () => {
    // Load-bearing that the fixture *sets* it: with the field absent the builder
    // falls back to the run id and the assertion would hold for the wrong reason,
    // proving nothing about whether redaction touches it. `prompt_cache_key`
    // contains "key" but matches no rule — the JSON-key rule wants an
    // api/access/private prefix, and the bare-`key` rule only fires inside a
    // query string.
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: storedSubject(),
      providers: CONFIGURED,
    });
    expect(storedSubject().request.prompt_cache_key).toBe("session_abc123");
    expect(request.prompt_cache_key).toBe("session_abc123_memory");
  });

  it("still takes the other cache-bearing fields from the run", () => {
    const request = buildIndexerContinuationRequest({
      executionId: "run_pass",
      subject: storedSubject(),
      providers: CONFIGURED,
    });
    expect(request.entry).toBe("coder");
    expect(request.profiles[0]!.model).toBe(MODEL);
    expect(request.profiles[0]!.tools).toEqual(["shell"]);
    expect(request.prompt_cache_key).toBe("session_abc123_memory");
  });
});
