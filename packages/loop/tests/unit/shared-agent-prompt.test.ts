import { describe, expect, it } from "../bun-test.ts";
import { INPUT_LIMITS } from "../../src/validation/input-limits.ts";
import {
  DEFAULT_SHARED_AGENT_PROMPT,
  SHARED_AGENT_PROMPT_TOKEN_BUDGET,
  estimatedPromptTokens,
} from "../../src/runtime/prompts/shared-agent-prompt.ts";
import {
  parseSharedPromptDocument,
  renderSharedPromptDocument,
  resolveSharedPrompt,
} from "../../src/runtime/prompts/resolve-shared-prompt.ts";

const REPLACE = renderSharedPromptDocument("replace", "Custom fleet policy.");
const DISABLED = renderSharedPromptDocument("disabled");

describe("DEFAULT_SHARED_AGENT_PROMPT", () => {
  it("stays within its own estimated-token ceiling", () => {
    expect(estimatedPromptTokens(DEFAULT_SHARED_AGENT_PROMPT)).toBeLessThanOrEqual(
      SHARED_AGENT_PROMPT_TOKEN_BUDGET,
    );
  });

  it("is a static how-you-work policy without interpolating run state", () => {
    expect(DEFAULT_SHARED_AGENT_PROMPT.startsWith("# How you work")).toBe(true);
    expect(DEFAULT_SHARED_AGENT_PROMPT).not.toMatch(/\$\{/);
    expect(DEFAULT_SHARED_AGENT_PROMPT).not.toContain("process.cwd");
    expect(DEFAULT_SHARED_AGENT_PROMPT).not.toContain("Date.");
  });

  it("does not teach channels, tools, models, or products Clarvis does not ship", () => {
    const text = DEFAULT_SHARED_AGENT_PROMPT.toLowerCase();
    const forbidden = [
      "todowrite",
      "websearch",
      "webfetch",
      "notebookedit",
      "computer_use",
      "gpt-4",
      "claude-3",
      "gemini-1",
      "chatgpt",
      "claude code",
      "cursor",
    ];
    for (const token of forbidden) expect(text).not.toContain(token);
  });
});

describe("parseSharedPromptDocument", () => {
  it("accepts replace with a body and disabled with an empty body", () => {
    expect(parseSharedPromptDocument(REPLACE)).toEqual({
      ok: true,
      mode: "replace",
      body: "Custom fleet policy.",
    });
    expect(parseSharedPromptDocument(DISABLED)).toEqual({ ok: true, mode: "disabled" });
  });

  it("rejects missing frontmatter, empty replace, and disabled with a body", () => {
    expect(parseSharedPromptDocument("")).toEqual({ ok: false, reason: "frontmatter is missing" });
    expect(parseSharedPromptDocument("just a body")).toEqual({
      ok: false,
      reason: "frontmatter is missing",
    });
    expect(parseSharedPromptDocument(renderSharedPromptDocument("replace", ""))).toEqual({
      ok: false,
      reason: "replace requires a non-empty body",
    });
    expect(parseSharedPromptDocument("---\nmode: disabled\n---\n\nleftover\n")).toEqual({
      ok: false,
      reason: "disabled requires an empty body",
    });
  });

  it("rejects unknown modes and extra frontmatter keys without applying a fragment", () => {
    expect(parseSharedPromptDocument("---\nmode: append\n---\n\nbody\n")).toEqual({
      ok: false,
      reason: "mode must be replace or disabled",
    });
    expect(parseSharedPromptDocument("---\nmode: replace\nextra: 1\n---\n\nbody\n")).toEqual({
      ok: false,
      reason: "mode must be replace or disabled",
    });
  });
});

describe("resolveSharedPrompt", () => {
  it("falls back to the embedded default when no override exists", () => {
    expect(resolveSharedPrompt()).toEqual({
      prompt: DEFAULT_SHARED_AGENT_PROMPT,
      source: "builtin",
      diagnostics: [],
    });
  });

  it("prefers a valid workspace document over global and builtin", () => {
    const resolved = resolveSharedPrompt({
      workspace: { path: "/ws/shared-agent.md", raw: REPLACE, trusted: true },
      global: {
        path: "/g/shared-agent.md",
        raw: renderSharedPromptDocument("replace", "Global policy."),
      },
    });
    expect(resolved).toEqual({
      prompt: "Custom fleet policy.",
      source: "workspace",
      from: "workspace",
      diagnostics: [],
    });
  });

  it("honours a valid disabled document and does not inject a shared layer", () => {
    const resolved = resolveSharedPrompt({
      global: { path: "/g/shared-agent.md", raw: DISABLED },
    });
    expect(resolved.source).toBe("disabled");
    expect(resolved.from).toBe("global");
    expect(resolved.prompt).toBeUndefined();
    expect(resolved.diagnostics).toEqual([]);
  });

  it("skips an invalid layer whole and uses the next valid source", () => {
    const resolved = resolveSharedPrompt({
      workspace: { path: "/ws/shared-agent.md", raw: "---\nmode: replace\n---\n\n", trusted: true },
      global: { path: "/g/shared-agent.md", raw: REPLACE },
    });
    expect(resolved.source).toBe("global");
    expect(resolved.from).toBe("global");
    expect(resolved.prompt).toBe("Custom fleet policy.");
    expect(resolved.diagnostics).toEqual([
      {
        scope: "workspace",
        path: "/ws/shared-agent.md",
        reason: "replace requires a non-empty body",
      },
    ]);
  });

  it("withholds an untrusted workspace document instead of injecting it", () => {
    const resolved = resolveSharedPrompt({
      workspace: { path: "/ws/shared-agent.md", raw: REPLACE, trusted: false },
    });
    expect(resolved.source).toBe("builtin");
    expect(resolved.prompt).toBe(DEFAULT_SHARED_AGENT_PROMPT);
    expect(resolved.diagnostics).toEqual([
      { scope: "workspace", path: "/ws/shared-agent.md", reason: "workspace is not trusted" },
    ]);
  });

  it("treats an empty file as invalid rather than a silent disable", () => {
    const resolved = resolveSharedPrompt({
      global: { path: "/g/shared-agent.md", raw: "" },
    });
    expect(resolved.source).toBe("builtin");
    expect(resolved.diagnostics[0]?.reason).toBe("frontmatter is missing");
  });

  it("does not apply an oversized document", () => {
    const resolved = resolveSharedPrompt({
      global: { path: "/g/shared-agent.md", oversized: true },
    });
    expect(resolved.source).toBe("builtin");
    expect(resolved.diagnostics[0]?.reason).toBe("prompt exceeds the character limit");
    expect(INPUT_LIMITS.systemPromptChars).toBe(INPUT_LIMITS.profileBasePromptChars);
  });
});
