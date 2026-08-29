import { describe, it, expect } from "../bun-test.ts";
import { settingsSchema } from "../../src/settings/settings-schema.ts";

const happyInfra = {
  providers: [{ name: "anthropic", kind: "anthropic", api_key_env: "ANTHROPIC_API_KEY" }],
  mcpServers: {
    fs: {
      type: "stdio",
      command: "npx",
      args: ["-y", "srv"],
    },
  },
  default_model: "anthropic/claude-sonnet-4-5",
  budget: { on_exceed: "stop", total_token_limit: 200000 },
};

function infraCode(body: unknown): string | undefined {
  const r = settingsSchema.safeParse(body);
  return r.success ? undefined : r.error.issues[0]!.code;
}

describe("settingsSchema (infra)", () => {
  it("accepts a canonical infra file", () => {
    expect(settingsSchema.safeParse(happyInfra).success).toBe(true);
  });

  it("rejects a profiles key (profiles now live in .clarvis/agents)", () => {
    expect(
      infraCode({
        ...happyInfra,
        profiles: { a: { model: "x/y", tools: [] } },
      }),
    ).toBe("unrecognized_keys");
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(infraCode({ ...happyInfra, nope: 1 })).toBe("unrecognized_keys");
  });

  it("owns no block a host registers, so a registered key is unrecognized here", () => {
    // The bare engine schema admits only its own blocks. A capability shipped in
    // its own package reaches `settingsSchemaFor(registry)` instead, which is
    // what `@clarvis/kernel` composes and validates against.
    expect(infraCode({ ...happyInfra, widgets: {} })).toBe("unrecognized_keys");
  });

  it("accepts a provider models map declaring each model's context window", () => {
    expect(
      settingsSchema.safeParse({
        ...happyInfra,
        providers: [
          {
            name: "anthropic",
            kind: "anthropic",
            api_key_env: "ANTHROPIC_API_KEY",
            models: {
              "claude-sonnet-4-5": { context_window_tokens: 200000 },
              "claude-haiku-4-5": {
                context_window_tokens: 200000,
                max_output_tokens: 64000,
                reasoning_efforts: ["low", "medium", "high"],
              },
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a models entry that omits context_window_tokens", () => {
    expect(
      infraCode({
        ...happyInfra,
        providers: [
          {
            name: "anthropic",
            kind: "anthropic",
            models: { "claude-sonnet-4-5": {} },
          },
        ],
      }),
    ).toBeDefined();
  });

  // @clarvis/mcp-client's transport-builder component owns the stdio/http/sse
  // construction matrix. This is the one root-schema error propagation proof.
  it("runs the mcp-server transport refinement through the record value", () => {
    const r = settingsSchema.safeParse({
      mcpServers: {
        stdio: { type: "stdio", url: "https://example.test", headers: { x: "y" } },
        http: {
          type: "http",
          url: "not-a-url",
          command: "x",
          args: [],
          env: { x: "y" },
          shared: true,
        },
        sse: { type: "sse" },
      },
    });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.every((issue) => issue.path[0] === "mcpServers")).toBe(
      true,
    );
  });

  it("rejects a malformed default_model token", () => {
    expect(settingsSchema.safeParse({ default_model: "BADMODEL" }).success).toBe(false);
  });

  it("accepts a provider-native tagged model id", () => {
    expect(
      settingsSchema.safeParse({
        default_model: "local/qwen2.5-coder:7b",
        providers: [
          {
            name: "local",
            kind: "openai-compatible",
            base_url: "http://127.0.0.1:11434/v1",
            models: { "qwen2.5-coder:7b": { context_window_tokens: 128000 } },
          },
        ],
      }).success,
    ).toBe(true);
  });

  // HookSchema owns every event/match/timeout/refinement row in
  // @clarvis/capability. The root settings schema keeps one successful
  // composition and one representative propagated error only.
  it("accepts a hooks array with pre_tool_use and post_tool_use entries", () => {
    expect(
      settingsSchema.safeParse({
        ...happyInfra,
        hooks: [
          { event: "pre_tool_use", command: "echo hi" },
          {
            event: "post_tool_use",
            match: { tool: "shell" },
            command: "echo bye",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a hook with an invalid event", () => {
    const r = settingsSchema.safeParse({
      ...happyInfra,
      hooks: [{ event: "on_start", command: "echo hi" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toContain("pre_tool_use");
  });

  it("accepts a guard config with type bash", () => {
    expect(
      settingsSchema.safeParse({
        ...happyInfra,
        guard: { type: "shell" },
      }).success,
    ).toBe(true);
  });

  it("accepts a guard config with allowed_commands", () => {
    expect(
      settingsSchema.safeParse({
        ...happyInfra,
        guard: { type: "shell", allowed_commands: ["echo", "ls"] },
      }).success,
    ).toBe(true);
  });

  it("accepts a guard config with denied_commands", () => {
    expect(
      settingsSchema.safeParse({
        ...happyInfra,
        guard: { type: "shell", allowed_commands: ["git"], denied_commands: ["rm -rf"] },
      }).success,
    ).toBe(true);
  });

  it("accepts a guard config with each mode value", () => {
    for (const mode of ["off", "on", "auto"]) {
      expect(
        settingsSchema.safeParse({
          ...happyInfra,
          guard: { type: "shell", mode },
        }).success,
      ).toBe(true);
    }
  });

  it("rejects a guard config with an invalid mode", () => {
    const r = settingsSchema.safeParse({
      ...happyInfra,
      guard: { type: "shell", mode: "yes" },
    });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0]!.message).toBe(
      "guard.mode must be 'off', 'on' or 'auto'",
    );
  });

  it("rejects an empty denied_commands entry", () => {
    expect(
      settingsSchema.safeParse({
        ...happyInfra,
        guard: { type: "shell", denied_commands: [""] },
      }).success,
    ).toBe(false);
  });

  it("rejects a guard config with an unknown type", () => {
    expect(
      infraCode({
        ...happyInfra,
        guard: { type: "network" },
      }),
    ).toBe("invalid_value");
  });

  it("rejects a guard config with unknown keys (strict)", () => {
    expect(
      infraCode({
        ...happyInfra,
        guard: { type: "shell", extra: true },
      }),
    ).toBe("unrecognized_keys");
  });

  it("accepts an opt-in native sandbox", () => {
    expect(
      settingsSchema.safeParse({
        sandbox: {
          type: "native",
          enabled: false,
          availability: "required",
          filesystem: "workspace-read-only",
          network: "none",
          pass_env: ["CI"],
          toolchains: {
            mode: "auto",
            include: ["node", "python3"],
            extra_paths: ["/opt/sdk", "./vendor/sdk"],
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown sandbox options", () => {
    expect(
      settingsSchema.safeParse({
        sandbox: { type: "native", unknown: true },
      }).success,
    ).toBe(false);
  });

  it("rejects adversarial guard, sandbox and MCP collection fanout", () => {
    expect(
      settingsSchema.safeParse({
        guard: { type: "shell", allowed_commands: Array(257).fill("git status") },
      }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        sandbox: { type: "native", pass_env: Array(257).fill("CI") },
      }).success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        mcpServers: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`s${index}`, { command: "server" }]),
        ),
      }).success,
    ).toBe(false);
  });
});

describe("budget as a settings default", () => {
  it("a budget that names only a limit is legal, and does not fail the boot", () => {
    // The run-request schema requires on_exceed because a request is a complete
    // instruction. Settings are defaults; reusing that schema verbatim made this
    // reasonable line a fatal boot failure whose repair discarded the block.
    const r = settingsSchema.safeParse({ budget: { total_token_limit: 200_000 } });
    expect(r.success).toBe(true);
  });

  it("a complete budget still validates", () => {
    expect(
      settingsSchema.safeParse({ budget: { on_exceed: "stop", total_token_limit: 5 } }).success,
    ).toBe(true);
  });

  it("an on_exceed that is present but wrong is still rejected", () => {
    expect(settingsSchema.safeParse({ budget: { on_exceed: "nope" } }).success).toBe(false);
  });

  it("a non-positive limit is still rejected", () => {
    expect(settingsSchema.safeParse({ budget: { total_token_limit: 0 } }).success).toBe(false);
  });
});
