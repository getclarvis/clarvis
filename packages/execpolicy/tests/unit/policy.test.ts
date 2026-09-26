import { describe, expect, test } from "bun:test";
import {
  analyzeShell,
  canRequestApproval,
  canSuggestRememberedAllow,
  evaluateCommand,
  isDangerousShell,
  parseApprovalPolicy,
  parseRuleDocument,
  ruleDigest,
  type ApprovalPolicy,
  type RuleSource,
} from "../../src/index.ts";

const source = (rules: RuleSource["rules"]): RuleSource => ({
  layer: "global",
  file: "rules.json",
  digest: ruleDigest(JSON.stringify(rules)),
  rules,
});
const run = (
  command: string,
  rules: RuleSource["rules"] = [],
  extras: Partial<Parameters<typeof evaluateCommand>[0]> = {},
) =>
  evaluateCommand({
    command,
    sources: [source(rules)],
    approval_policy: "on-request",
    backend_available: true,
    restricted: true,
    cwd: "/work",
    path: "/bin",
    ...extras,
  });

describe("literal shell analysis", () => {
  test("keeps quoting, escapes and empty arguments", () => {
    expect(analyzeShell("git status && printf '' 'a b' c\\ d")).toEqual({
      segments: [
        ["git", "status"],
        ["printf", "", "a b", "c d"],
      ],
      limit: "none",
    });
  });
  test("unwraps complete shell wrappers and preserves composed segments", () => {
    expect(analyzeShell("sh -lc 'git status | cat' ").segments).toEqual([
      ["git", "status"],
      ["cat"],
    ]);
    expect(analyzeShell("bash -c 'git status' extra").segments).toEqual([
      ["bash", "-c", "git status", "extra"],
    ]);
  });
  test("incomplete syntax never authorizes a literal prefix", () => {
    for (const command of [
      "echo x > output",
      "echo $(rm -f a)",
      "X=1 git status",
      "echo *.txt",
      "if true; then git status; fi",
    ]) {
      expect(analyzeShell(command).limit).toBe("syntax");
      expect(run(command).all_segments_explicitly_allowed).toBe(false);
    }
    const oversized = `git status ${"x".repeat(17_000)}`;
    expect(analyzeShell(oversized).limit).toBe("bytes");
    expect(
      run(oversized, [{ id: "status", pattern: ["git", "status"], decision: "allow" }])
        .all_segments_explicitly_allowed,
    ).toBe(false);
  });
  test("permissive extraction finds force removal in substitutions", () => {
    expect(isDangerousShell("echo $(rm -f cache)")).toBe(true);
    expect(run("echo $(rm -f cache)").decision).toBe("prompt");
    expect(run("echo hello > file").decision).toBe("allow");
    expect(run("echo okay # rm -f cache").decision).toBe("allow");
  });
});

describe("rule evaluation", () => {
  const rules = [
    { id: "status", pattern: ["git", "status"], decision: "allow" as const },
    { id: "push", pattern: ["git", "push"], decision: "prompt" as const },
    { id: "reset", pattern: ["git", "reset", "--hard"], decision: "forbidden" as const },
  ];
  test("matches argv prefixes, alternatives and overlapping restrictive rules", () => {
    expect(run("git status --short", rules).decision).toBe("allow");
    expect(run("git push", rules).decision).toBe("prompt");
    expect(run("git reset --hard", rules).decision).toBe("forbidden");
    expect(run("git status && git push", rules).decision).toBe("prompt");
    expect(
      run("git status", [...rules, { id: "review", pattern: ["git"], decision: "prompt" }])
        .decision,
    ).toBe("prompt");
    expect(
      run("git reset --hard", [{ id: "ban", pattern: ["git", "reset"], decision: "forbidden" }], {
        resolve_executable: () => ({ path: "/tmp/git", trusted: false }),
      }).decision,
    ).toBe("forbidden");
    expect(
      run("git status", [{ id: "alt", pattern: [["git", "hg"], "status"], decision: "allow" }])
        .decision,
    ).toBe("allow");
    expect(run("echo git status", rules).matches).toEqual([]);
  });
  test("requires all literal segments to be explicitly allowed", () => {
    expect(run("git status", rules).all_segments_explicitly_allowed).toBe(true);
    expect(run("git status | cat", rules).all_segments_explicitly_allowed).toBe(false);
    expect(run("git status && rm -rf cache", rules).decision).toBe("prompt");
  });
  test("explicit allow replaces the hazard fallback for its command only", () => {
    expect(
      run("rm -rf cache", [{ id: "cache", pattern: ["rm", "-rf", "cache"], decision: "allow" }])
        .decision,
    ).toBe("allow");
    expect(
      run("rm -rf cache", [
        { id: "cache", pattern: ["rm", "-rf", "cache"], decision: "allow" },
        { id: "block", pattern: ["rm"], decision: "forbidden" },
      ]).decision,
    ).toBe("forbidden");
  });
  test("an opaque shell can match an exact rule without claiming full segment proof", () => {
    const result = run("echo $HOME", [
      { id: "shell", pattern: ["sh", "-c", "echo $HOME"], decision: "allow" },
    ]);
    expect(result.decision).toBe("allow");
    expect(result.all_segments_explicitly_allowed).toBe(false);
  });
  test("resolver matches only trusted full executable identity and receives execution facts", () => {
    const rule = [
      { id: "system-git", pattern: ["/usr/bin/git", "status"], decision: "allow" as const },
    ];
    expect(
      run("git status", rule, {
        resolve_executable: (_command, facts) =>
          facts.cwd === "/work" && facts.path === "/bin"
            ? { path: "/usr/bin/git", trusted: true }
            : undefined,
      }).all_segments_explicitly_allowed,
    ).toBe(true);
    expect(
      run("/tmp/git status", rule, {
        resolve_executable: () => ({ path: "/usr/bin/git", trusted: false }),
      }).all_segments_explicitly_allowed,
    ).toBe(false);
    expect(
      run("git status", [{ id: "git", pattern: ["git", "status"], decision: "allow" }], {
        resolve_executable: () => ({ path: "/tmp/git", trusted: false }),
        approval_policy: "untrusted",
      }).decision,
    ).toBe("prompt");
  });
  test("host may disable allows without discarding restrictions", () => {
    expect(
      run("git status", rules, { host_disables_allows: true, approval_policy: "untrusted" })
        .decision,
    ).toBe("prompt");
    expect(run("git reset --hard", rules, { host_disables_allows: true }).decision).toBe(
      "forbidden",
    );
  });
  test("version, examples and unique IDs are validated", () => {
    expect(
      parseRuleDocument({
        version: 1,
        rules: [
          {
            id: "x",
            pattern: ["git", "status"],
            decision: "allow",
            match: [["git", "status", "--short"]],
            not_match: [["git", "push"]],
          },
        ],
      }).rules,
    ).toHaveLength(1);
    expect(() => parseRuleDocument({ version: 2, rules: [] })).toThrow();
    expect(() =>
      parseRuleDocument({
        version: 1,
        rules: [
          { id: "x", pattern: ["git"], decision: "allow" },
          { id: "x", pattern: ["rm"], decision: "prompt" },
        ],
      }),
    ).toThrow();
    expect(
      parseRuleDocument({
        version: 1,
        rules: [{ id: "empty", pattern: ["printf", ""], decision: "allow" }],
      }).rules,
    ).toHaveLength(1);
    expect(() =>
      parseRuleDocument({
        version: 1,
        rules: [{ id: "x", pattern: ["git"], decision: "allow", not_match: [["git", "status"]] }],
      }),
    ).toThrow();
  });
});

describe("fallback and approval policy", () => {
  const granular = (sandbox_approval: boolean, rules: boolean): ApprovalPolicy => ({
    granular: { sandbox_approval, rules, mcp_elicitations: true },
  });
  for (const policy of [
    "on-request",
    "untrusted",
    "never",
    granular(true, true),
    granular(false, false),
  ] as const) {
    test(`classifies ordinary, dangerous, explicit prompt and override under ${JSON.stringify(policy)}`, () => {
      const ordinary = run("echo okay", [], { approval_policy: policy });
      expect(ordinary.decision).toBe(policy === "untrusted" ? "prompt" : "allow");
      const danger = run("rm -f cache", [], { approval_policy: policy });
      expect(danger.decision).toBe(
        policy === "never" || (typeof policy !== "string" && !policy.granular.sandbox_approval)
          ? "forbidden"
          : "prompt",
      );
      const explicit = run(
        "git push",
        [{ id: "push", pattern: ["git", "push"], decision: "prompt" }],
        { approval_policy: policy },
      );
      expect(explicit.decision).toBe(
        policy === "never" || (typeof policy !== "string" && !policy.granular.rules)
          ? "forbidden"
          : "prompt",
      );
      expect(
        run("git status", [{ id: "status", pattern: ["git", "status"], decision: "allow" }], {
          approval_policy: policy,
        }).decision,
      ).toBe("allow");
      expect(
        run(
          "git reset --hard",
          [{ id: "reset", pattern: ["git", "reset"], decision: "forbidden" }],
          { approval_policy: policy },
        ).decision,
      ).toBe("forbidden");
      const override = run("echo okay", [], { approval_policy: policy, override_requested: true });
      expect(override.decision).toBe(
        policy === "never" || (typeof policy !== "string" && !policy.granular.sandbox_approval)
          ? "forbidden"
          : "prompt",
      );
    });
  }
  test("an unrestricted override creates no prompt", () => {
    expect(run("echo okay", [], { override_requested: true, restricted: false }).decision).toBe(
      "allow",
    );
  });
  test("force removal respects -- and wrappers", () => {
    expect(run("rm -f -- cache").decision).toBe("prompt");
    expect(run("rm -- -f").decision).toBe("allow");
    expect(run("env X=1 rm -rf cache").decision).toBe("prompt");
    expect(run("env -u TOKEN rm -rf cache").decision).toBe("prompt");
    expect(run("sudo rm -f cache").decision).toBe("prompt");
    expect(run("sudo -u root rm -f cache").decision).toBe("prompt");
    expect(run("sh -c 'echo $(rm -f cache)'").decision).toBe("prompt");
    expect(run("trap 'rm -f cache' EXIT").decision).toBe("prompt");
  });
  test("granular fields are closed and optional fields default false", () => {
    const policy = parseApprovalPolicy({
      granular: { sandbox_approval: true, rules: true, mcp_elicitations: true },
    });
    expect(canRequestApproval(policy, "skill_approval")).toBe(false);
    expect(canRequestApproval(policy, "request_permissions")).toBe(false);
    expect(canRequestApproval(policy, "mcp_elicitations")).toBe(true);
    expect(canRequestApproval(policy, "sandbox_approval")).toBe(true);
    expect(canRequestApproval(policy, "rules")).toBe(true);
    expect(() => parseApprovalPolicy({ granular: { rules: true } })).toThrow();
    expect(() =>
      parseApprovalPolicy({
        granular: { sandbox_approval: true, rules: true, mcp_elicitations: true, unknown: true },
      }),
    ).toThrow();
  });
  test("broad remembered allow suggestions are refused", () => {
    expect(canSuggestRememberedAllow(["git"])).toBe(false);
    expect(canSuggestRememberedAllow(["bash", "-c"])).toBe(false);
    expect(canSuggestRememberedAllow(["git", "status"])).toBe(true);
    expect(canSuggestRememberedAllow(["rm", "-rf", "/tmp/cache"])).toBe(false);
  });
});
