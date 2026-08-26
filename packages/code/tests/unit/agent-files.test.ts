import { expect, test } from "bun:test";
import {
  agentReadiness,
  docToAgentFile,
  normalizeAgentWrite,
  overlayAgentWrite,
  overlayIsEmpty,
  readEnvView,
  type AgentFile,
} from "../../src/adapters/agent-files.ts";
import type { SettingsFile } from "../../src/adapters/settings.ts";

test("docToAgentFile: a valid AgentDoc keeps frontmatter + body", () => {
  const f = docToAgentFile({
    name: "myagent",
    scope: "workspace",
    frontmatter: {
      description: "d",
      grants: ["edit_workspace", "run_commands"],
      iteration_limit: 20,
    },
    body: "Do the thing.",
  });
  expect(f.scope).toBe("workspace");
  expect(f.frontmatter.description).toBe("d");
  expect(f.frontmatter.grants).toEqual(["edit_workspace", "run_commands"]);
  expect(f.body).toBe("Do the thing.");
  expect(f.invalid).toBeUndefined();
});

test("docToAgentFile: an empty body carries base_prompt into the editor body", () => {
  const f = docToAgentFile({
    name: "a",
    scope: "global",
    frontmatter: { description: "d", base_prompt: "Be helpful." },
    body: "",
  });
  expect(f.body).toBe("Be helpful.");
  expect(f.frontmatter.base_prompt).toBeUndefined();
  expect(f.frontmatter.description).toBe("d");
});

test("docToAgentFile: invalid frontmatter → empty frontmatter + invalid marker (still listable)", () => {
  const f = docToAgentFile({
    name: "broken",
    scope: "global",
    frontmatter: { grants: "plan_review" }, // grants must be an array
    body: "body",
  });
  expect(f.invalid).toBeDefined();
  expect(f.frontmatter).toEqual({});
  expect(f.body).toBe("body");
});

test("normalizeAgentWrite: a non-empty body drops base_prompt; returns an AgentWrite", () => {
  const write = normalizeAgentWrite({
    name: "x",
    scope: "global",
    frontmatter: { description: "d", grants: ["read_workspace"], base_prompt: "old" },
    body: "  Fresh body.  ",
  });
  expect(write.body).toBe("Fresh body.");
  expect(write.frontmatter.base_prompt).toBeUndefined();
  expect(write.frontmatter.grants).toEqual(["read_workspace"]);
});

test("normalizeAgentWrite: rejects a draft that fails the frontmatter schema", () => {
  const bad = {
    name: "x",
    scope: "global",
    frontmatter: { grants: "plan_review" },
    body: "b",
  } as unknown as AgentFile;
  expect(() => normalizeAgentWrite(bad)).toThrow("invalid agent frontmatter");
});

test("an unknown frontmatter key survives the editor round-trip unchanged", () => {
  const frontmatter = {
    description: "d",
    grants: ["read_workspace"],
    "x-house-style": "terse",
    presentation: { colour: "amber", tags: ["a", "b"] },
  };
  const file = docToAgentFile({
    name: "foreign",
    scope: "workspace",
    frontmatter,
    body: "Do the thing.",
  });

  expect(file.invalid).toBeUndefined();
  expect(file.frontmatter).toEqual(frontmatter);

  const write = normalizeAgentWrite(file);
  expect(write.frontmatter).toEqual(frontmatter);
  expect(write.body).toBe("Do the thing.");
});

test("an unknown key alongside a base_prompt promotion still round-trips", () => {
  const file = docToAgentFile({
    name: "foreign",
    scope: "global",
    frontmatter: { base_prompt: "Be helpful.", "x-house-style": "terse" },
    body: "",
  });
  expect(file.body).toBe("Be helpful.");
  expect(file.frontmatter["x-house-style"]).toBe("terse");
  expect(normalizeAgentWrite(file).frontmatter).toEqual({ "x-house-style": "terse" });
});

test("a typed field is still validated even when an unknown key is present", () => {
  const bad = {
    name: "x",
    scope: "global",
    frontmatter: { grants: "plan_review", "x-house-style": "terse" },
    body: "b",
  } as unknown as AgentFile;
  expect(() => normalizeAgentWrite(bad)).toThrow("invalid agent frontmatter");
});

test("readEnvView: engine defaults when unset; parses CLARVIS_* when set", () => {
  const base = readEnvView({});
  expect(base.budgetOnExceed).toBe("escalate");
  expect(base.iterationDefault).toBe(50);
  expect(base.iterationCeiling).toBe(100);
  expect(base.tokenDefault).toBe(40_000_000);
  expect(base.tokenCeiling).toBe(200_000_000);
  expect(base.maxGrant).toBe("edit");
  const set = readEnvView({
    CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
    CLARVIS_TOKEN_CEILING: "999",
    CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: "500",
    CLARVIS_DEFAULT_ON_EXCEED: "stop",
    CLARVIS_DEFAULT_MODEL: "p/m",
  });
  expect(set.maxGrant).toBe("exec");
  expect(set.tokenDefault).toBe(500);
  expect(set.tokenCeiling).toBe(999);
  expect(set.defaultModel).toBe("p/m");
  expect(set.budgetOnExceed).toBe("stop");
});

test("readEnvView: an invalid env var degrades to pure defaults instead of throwing", () => {
  const view = readEnvView({ CLARVIS_TOKEN_CEILING: "not-a-number" });
  expect(view.tokenCeiling).toBe(200_000_000);
});

test("readEnvView: a token ceiling below the default token limit degrades to defaults", () => {
  const view = readEnvView({ CLARVIS_TOKEN_CEILING: "999" });
  expect(view.tokenCeiling).toBe(200_000_000);
});

test("agentReadiness: model + spawn + budget gates", () => {
  const env = readEnvView({});
  const settings: SettingsFile = {
    providers: [{ name: "compat", kind: "openai-compatible", base_url: "https://x/v1" }],
    default_model: "compat/m",
  };
  const explorer: AgentFile = {
    name: "explorer",
    scope: "global",
    frontmatter: { grants: ["read_workspace"] },
    body: "b",
  };
  const ok: AgentFile = {
    name: "coder",
    scope: "global",
    frontmatter: { grants: ["edit_workspace"] },
    body: "b",
  };
  expect(agentReadiness(ok, [ok, explorer], settings, env).runnable).toBe(true);

  const noModel = agentReadiness(ok, [ok], { providers: [] }, env);
  expect(noModel.runnable).toBe(false);
  expect(noModel.issues.some((i) => i.code === "missing_model")).toBe(true);

  const noSpawn: AgentFile = {
    name: "p",
    scope: "global",
    frontmatter: { grants: ["read_workspace"] },
    body: "b",
  };
  expect(agentReadiness(noSpawn, [noSpawn], settings, env).runnable).toBe(true);

  const badSpawn: AgentFile = {
    name: "lead",
    scope: "global",
    frontmatter: { can_spawn: ["ghost"], default_spawn: "ghost" },
    body: "b",
  };
  const r = agentReadiness(badSpawn, [badSpawn], settings, env);
  expect(r.issues.some((i) => i.code === "unknown_spawn_target")).toBe(true);
});

test("agentReadiness: engine-shared rules — malformed model, orchestration", () => {
  const env = readEnvView({});
  const settings: SettingsFile = {
    providers: [{ name: "compat", kind: "openai-compatible", base_url: "https://x/v1" }],
    default_model: "compat/m",
  };
  const mk = (name: string, frontmatter: AgentFile["frontmatter"]): AgentFile => ({
    name,
    scope: "global",
    frontmatter,
    body: "b",
  });

  const malformed = agentReadiness(mk("m", { model: "claude-sonnet" }), [], settings, env);
  expect(malformed.issues.map((i) => i.code)).toEqual(["invalid_model"]);

  const soloOrch = mk("s", { orchestration: { force_tool_on_nudge: true } });
  expect(
    agentReadiness(soloOrch, [soloOrch], settings, env).issues.some(
      (i) => i.code === "orchestration_needs_can_spawn",
    ),
  ).toBe(true);
});

test("docToAgentFile: malformed frontmatter is carried as invalid, not as an empty agent", () => {
  const f = docToAgentFile({
    name: "broken",
    scope: "global",
    // What the lenient parse leaves behind: an empty object that satisfies
    // every optional field of the schema.
    frontmatter: {},
    body: "Do the thing.",
    malformed: "malformed YAML frontmatter (missing or misaligned closing '---' fence)",
  });
  expect(f.invalid).toContain("malformed YAML frontmatter");
  expect(f.frontmatter).toEqual({});
});

test("agentReadiness: a malformed profile is never sealed runnable", () => {
  const settings: SettingsFile = {
    providers: [{ name: "p", kind: "openai-compatible" }],
    default_model: "p/m",
  };
  const broken: AgentFile = {
    name: "broken",
    scope: "global",
    frontmatter: {},
    body: "b",
    invalid: "malformed YAML frontmatter",
  };
  const seal = agentReadiness(broken, [broken], settings, readEnvView({}), ["read_workspace"]);
  // Without the invalid check every rule passes on the empty fallback and the
  // file reads as a healthy agent that simply declares nothing.
  expect(seal.runnable).toBe(false);
  expect(seal.issues.map((i) => i.code)).toContain("malformed_frontmatter");
  expect(seal.issues[0]!.message).toContain("malformed YAML");
});

/** A shipped agent as the panel receives it, and an edited copy of it. */
const SHIPPED: AgentFile = {
  name: "marshall",
  scope: "builtin",
  frontmatter: {
    description: "Coding Lead",
    model: "anthropic/x",
    grants: ["edit_workspace", "read_workspace"],
    can_spawn: ["coder"],
    iteration_limit: 50,
  },
  body: "You are marshall.",
};

test("overlayAgentWrite: only the fields that changed, and no body when the prompt did not", () => {
  const write = overlayAgentWrite(
    { ...SHIPPED, frontmatter: { ...SHIPPED.frontmatter, iteration_limit: 80 } },
    SHIPPED,
  );
  expect(write.frontmatter).toEqual({ iteration_limit: 80 });
  expect(write.body).toBe("");
  expect(overlayIsEmpty(write)).toBe(false);
});

test("overlayAgentWrite: a changed prompt is carried, an unchanged one is not", () => {
  expect(overlayAgentWrite({ ...SHIPPED, body: "Seja breve." }, SHIPPED).body).toBe("Seja breve.");
  expect(overlayAgentWrite({ ...SHIPPED, body: "  You are marshall.  " }, SHIPPED).body).toBe("");
});

test("overlayAgentWrite: dropping a shipped field records the removal explicitly", () => {
  const { grants: _grants, ...withoutGrants } = SHIPPED.frontmatter;
  const write = overlayAgentWrite({ ...SHIPPED, frontmatter: withoutGrants }, SHIPPED);
  expect(write.frontmatter).toEqual({ grants: undefined });
  expect(overlayIsEmpty(write)).toBe(false);
});

test("overlayAgentWrite: an untouched draft produces nothing to write", () => {
  const write = overlayAgentWrite({ ...SHIPPED }, SHIPPED);
  expect(write.frontmatter).toEqual({});
  expect(write.body).toBe("");
  expect(overlayIsEmpty(write)).toBe(true);
});

test("overlayAgentWrite: a body wins over base_prompt, which is dropped from the overlay", () => {
  const write = overlayAgentWrite(
    { ...SHIPPED, frontmatter: { ...SHIPPED.frontmatter, base_prompt: "ignored" }, body: "Mine." },
    SHIPPED,
  );
  expect(write.frontmatter).toEqual({});
  expect(write.body).toBe("Mine.");
});

test("overlayAgentWrite: invalid frontmatter is refused rather than half-written", () => {
  expect(() =>
    overlayAgentWrite({ ...SHIPPED, frontmatter: { iteration_limit: "soon" } as never }, SHIPPED),
  ).toThrow(/invalid agent frontmatter/);
});
