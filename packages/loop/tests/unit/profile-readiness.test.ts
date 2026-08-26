import { describe, it, expect } from "../bun-test.ts";
import {
  PROFILE_READINESS_RULES,
  profileReadinessIssues,
  type ReadinessCode,
  type ReadinessContext,
} from "../../src/validation/profile-readiness.ts";
import { validateBody } from "../../src/validation/request-schema.ts";
import { BUILTIN_GRANT_NAMES } from "../../src/validation/request/grant-registry.ts";
import { loadEnv } from "@clarvis/capability";

const env = loadEnv({});

function readyCtx(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    profile: { model: "anthropic/claude-sonnet-4-5" },
    registryNames: ["solo"],
    providerNames: ["anthropic"],
    ...overrides,
  };
}

interface RequestProfile {
  name: string;
  model: string;
  tools: string[];
  iteration_limit: number;
  [key: string]: unknown;
}

function requestWith(
  entryOverrides: Record<string, unknown>,
  extraProfiles: RequestProfile[] = [],
): unknown {
  return {
    messages: [{ role: "user", content: "hi" }],
    servers: [],
    profiles: [
      {
        name: "solo",
        model: "anthropic/claude-sonnet-4-5",
        tools: [],
        iteration_limit: 5,
        ...entryOverrides,
      },
      ...extraProfiles,
    ],
    entry: "solo",
    providers: [{ name: "anthropic", kind: "anthropic" }],
    budget: { on_exceed: "stop", total_token_limit: 1000 },
  };
}

function expectEngineRejects(body: unknown): void {
  expect(() => validateBody(body, env)).toThrow();
}

function expectFlags(ctx: ReadinessContext, code: ReadinessCode): void {
  expect(profileReadinessIssues(ctx).map((i) => i.code)).toContain(code);
}

describe("profileReadinessIssues", () => {
  it("returns no issues for a well-formed profile", () => {
    expect(profileReadinessIssues(readyCtx())).toEqual([]);
  });

  it("resolves the model through the defaultModel fallback", () => {
    const ctx = readyCtx({ profile: {} });
    expect(profileReadinessIssues({ ...ctx, defaultModel: "anthropic/claude-sonnet-4-5" })).toEqual(
      [],
    );
    expectFlags(ctx, "missing_model");
  });

  it("says nothing about grants when the host's vocabulary is unknown", () => {
    // A caller that cannot see the capability registry must not report a
    // capability-owned grant as unknown.
    const ctx = readyCtx({
      profile: { model: "anthropic/claude-sonnet-4-5", grants: ["vendor_search"] },
    });
    expect(profileReadinessIssues(ctx)).toEqual([]);
  });

  it("accepts a capability-declared grant the engine does not own", () => {
    const ctx = readyCtx({
      profile: { model: "anthropic/claude-sonnet-4-5", grants: ["vendor_search"] },
      knownGrants: [...BUILTIN_GRANT_NAMES, "vendor_search"],
    });
    expect(profileReadinessIssues(ctx)).toEqual([]);
  });

  it("reports every unknown can_spawn target, not just the first", () => {
    const ctx = readyCtx({
      profile: { model: "anthropic/claude-sonnet-4-5", can_spawn: ["ghost-a", "ghost-b"] },
    });
    const codes = profileReadinessIssues(ctx).map((i) => i.code);
    expect(codes.filter((c) => c === "unknown_spawn_target")).toHaveLength(2);
  });

  it("a malformed model yields invalid_model, not a bogus unknown_provider", () => {
    const issues = profileReadinessIssues(readyCtx({ profile: { model: "claude-sonnet-4-5" } }));
    expect(issues.map((i) => i.code)).toEqual(["invalid_model"]);
  });
});

describe("parity with validateBody", () => {
  const cases: {
    code: ReadinessCode;
    body: unknown;
    ctx: ReadinessContext;
  }[] = [
    {
      code: "missing_model",
      body: (() => {
        const body = requestWith({}) as { profiles: Record<string, unknown>[] };
        delete body.profiles[0]!.model;
        return body;
      })(),
      ctx: readyCtx({ profile: {} }),
    },
    {
      code: "invalid_model",
      body: requestWith({ model: "claude-sonnet-4-5" }),
      ctx: readyCtx({ profile: { model: "claude-sonnet-4-5" } }),
    },
    {
      code: "unknown_provider",
      body: requestWith({ model: "ghost/some-model" }),
      ctx: readyCtx({ profile: { model: "ghost/some-model" } }),
    },
    {
      code: "budget_needs_limit",
      body: {
        ...(requestWith({}) as object),
        budget: { on_exceed: "stop" },
      },
      ctx: readyCtx({
        profile: { model: "anthropic/claude-sonnet-4-5", budget: { on_exceed: "stop" } },
      }),
    },
    {
      code: "unknown_spawn_target",
      body: requestWith({ can_spawn: ["ghost"] }),
      ctx: readyCtx({
        profile: { model: "anthropic/claude-sonnet-4-5", can_spawn: ["ghost"] },
      }),
    },
    {
      code: "default_spawn_not_in_can_spawn",
      body: requestWith({ can_spawn: ["helper"], default_spawn: "other" }, [
        {
          name: "helper",
          model: "anthropic/claude-sonnet-4-5",
          tools: [],
          iteration_limit: 5,
        },
        {
          name: "other",
          model: "anthropic/claude-sonnet-4-5",
          tools: [],
          iteration_limit: 5,
        },
      ]),
      ctx: readyCtx({
        registryNames: ["solo", "helper", "other"],
        profile: {
          model: "anthropic/claude-sonnet-4-5",
          can_spawn: ["helper"],
          default_spawn: "other",
        },
      }),
    },
    {
      code: "orchestration_needs_can_spawn",
      body: requestWith({ orchestration: { force_tool_on_nudge: true } }),
      ctx: readyCtx({
        profile: {
          model: "anthropic/claude-sonnet-4-5",
          orchestration: { force_tool_on_nudge: true },
        },
      }),
    },
    {
      code: "unknown_grant",
      body: requestWith({ grants: ["image"] }),
      ctx: readyCtx({
        profile: { model: "anthropic/claude-sonnet-4-5", grants: ["image"] },
        knownGrants: BUILTIN_GRANT_NAMES,
      }),
    },
  ];

  it("covers every rule in the table exactly once", () => {
    expect(cases.map((c) => c.code).sort()).toEqual(
      PROFILE_READINESS_RULES.map((r) => r.code).sort(),
    );
  });

  for (const { code, body, ctx } of cases) {
    it(`${code}: engine rejects and readiness flags`, () => {
      expectEngineRejects(body);
      expectFlags(ctx, code);
    });
  }

  it("the parity baseline itself passes validateBody", () => {
    expect(() => validateBody(requestWith({}), env)).not.toThrow();
  });
});
