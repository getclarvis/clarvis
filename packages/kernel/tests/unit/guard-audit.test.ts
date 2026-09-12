import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { NOOP_LOGGER, type Logger } from "@clarvis/capability";
import type { ShellFacts, GuardContext } from "@clarvis/tools/guard";
import type { Elicit, ElicitRequest, RunCapabilityContext } from "@clarvis/loop";
import { createShellGuard, type ShellGuardDecision } from "../../src/guard/shell-guard.ts";
import { createGuardResolver } from "../../src/guard/resolver.ts";
import { createAuditLogger } from "../../src/component-loggers.ts";
import { recordingLogger, type LogRecord } from "../helpers/logger.ts";

function recorder(): { logger: Logger; records: LogRecord[] } {
  const logger = recordingLogger();
  return { logger, records: logger.records };
}

const ROOT = resolve("/tmp/clarvis-kernel-guard-audit-ws");

function shellFacts(normalized: string, undecidable = false): ShellFacts {
  return {
    paths: [],
    undecidable,
    segments: [
      {
        command: normalized.split(" ")[0] ?? "",
        argv: [],
        normalized,
        envAssignments: [],
        decidable: !undecidable,
      },
    ],
  };
}

function ctx(tool: string, args: Record<string, unknown>, shell?: ShellFacts): GuardContext {
  const sandboxPermissions =
    args.sandbox_permissions === "require_escalated" || args.sandbox_permissions === "use_default"
      ? args.sandbox_permissions
      : undefined;
  const justification = typeof args.justification === "string" ? args.justification : undefined;
  return {
    tool,
    args,
    config: { workspaceRoot: ROOT } as unknown as GuardContext["config"],
    paths: [],
    ...(shell === undefined ? {} : { shell }),
    ...(sandboxPermissions !== undefined ? { sandboxPermissions } : {}),
    ...(justification !== undefined ? { justification } : {}),
  };
}

function runCtx(over: Partial<RunCapabilityContext>): RunCapabilityContext {
  return {
    owner: "owner-1",
    executionId: "run-1",
    request: { guard_mode: "on" },
    entryGrants: [],
    env: {},
    workspaceRoot: ROOT,
    llm: { call: async () => ({}) },
    emit: () => {},
    ...over,
  } as unknown as RunCapabilityContext;
}

function bashReq(command: string, shell: ShellFacts = shellFacts(command)): ElicitRequest {
  return { tool: "shell", args: { command }, shell };
}

describe("createShellGuard onDecision", () => {
  function decisionsFor(
    options: Parameters<typeof createShellGuard>[0],
    context: GuardContext,
  ): ShellGuardDecision[] {
    const seen: ShellGuardDecision[] = [];
    const guard = createShellGuard({ ...options, onDecision: (d) => seen.push(d) });
    void guard(context);
    return seen;
  }

  it("reports the deny list as the matching rule", () => {
    const [decision] = decisionsFor(
      { deniedCommands: ["git push"] },
      ctx("shell", { command: "git push origin main" }, shellFacts("git push origin main")),
    );
    expect(decision).toMatchObject({ verdict: "deny", matched: "deny_list", tool: "shell" });
  });

  it("reports require_escalated sandbox commands as human-escalated host execution", () => {
    const context = ctx("shell", {
      command: "gh pr view 1",
      sandbox_permissions: "require_escalated",
      justification: "need host gh",
    });
    context.config = { ...context.config, sandbox: { type: "native" } } as GuardContext["config"];
    const [decision] = decisionsFor({ allowedCommands: ["*"] }, context);
    expect(decision).toMatchObject({
      verdict: "ask",
      matched: "host_command",
      escalate: "human",
      tool: "shell",
      reason: "need host gh",
    });
  });

  it("reports an undecidable command with no deny list as an escalated ask", () => {
    const [decision] = decisionsFor({}, ctx("shell", { command: "$(x) y" }, shellFacts("y", true)));
    expect(decision).toMatchObject({
      verdict: "ask",
      matched: "undecidable",
      escalate: "human",
    });
  });

  it("reports an undecidable command against a non-empty deny list as a deny", () => {
    const [decision] = decisionsFor(
      { deniedCommands: ["rm"] },
      ctx("shell", { command: "$(x) y" }, shellFacts("y", true)),
    );
    expect(decision).toMatchObject({ verdict: "deny", matched: "undecidable" });
  });

  it("reports a credential file", () => {
    const context = ctx("read_file", { path: ".env" });
    context.paths.push({ raw: ".env", resolved: `${ROOT}/.env`, withinWorkspace: true });
    const [decision] = decisionsFor({}, context);
    expect(decision).toMatchObject({ verdict: "ask", matched: "credential_file" });
  });

  it("reports a path that leaves the workspace", () => {
    const context = ctx("read_file", { path: "../x" });
    context.paths.push({ raw: "../x", resolved: "/etc/x", withinWorkspace: false });
    const [decision] = decisionsFor({}, context);
    expect(decision).toMatchObject({ verdict: "deny", matched: "outside_workspace" });
  });

  it("reports a non-bash call as allowed without a digest", () => {
    const [decision] = decisionsFor({}, ctx("read_file", { path: "a.ts" }));
    expect(decision).toMatchObject({ verdict: "allow", matched: "non_bash" });
    expect(decision?.commandDigest).toBeUndefined();
  });

  it("reports a fully allow-listed command", () => {
    const [decision] = decisionsFor(
      { allowedCommands: ["bun test"] },
      ctx("shell", { command: "bun test" }, shellFacts("bun test")),
    );
    expect(decision).toMatchObject({ verdict: "allow", matched: "allow_list" });
  });

  it("reports an unlisted command whose paths are all local as the default ask", () => {
    const context = ctx("shell", { command: "curl example.com" }, shellFacts("curl example.com"));
    context.paths.push({ raw: "a.ts", resolved: `${ROOT}/a.ts`, withinWorkspace: true });
    const [decision] = decisionsFor({ allowedCommands: ["bun test"] }, context);
    expect(decision).toMatchObject({ verdict: "ask", matched: "default" });
  });

  it("reports a command whose paths cannot be bounded as a possible escape", () => {
    // No paths at all: `withinWorkspace` is false while `touchesOutside` is also
    // false, so the ask arm — not the deny arm — is the one reached.
    const [decision] = decisionsFor({}, ctx("shell", { command: "cat x" }, shellFacts("cat x")));
    expect(decision).toMatchObject({ verdict: "ask", matched: "outside_workspace" });
  });

  it("digests the command instead of carrying it", () => {
    const [decision] = decisionsFor(
      {},
      ctx("shell", { command: "echo secret-token" }, shellFacts("echo secret-token")),
    );
    expect(decision?.commandDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(decision)).not.toContain("secret-token");
  });

  it("stays a pure value when no observer is supplied", async () => {
    const guard = createShellGuard({ deniedCommands: ["rm"] });
    const decision = await guard(ctx("shell", { command: "rm -rf x" }, shellFacts("rm -rf x")));
    expect(decision).toMatchObject({
      verdict: "deny",
      reason: "command matches the denied commands list",
    });
  });
});

describe("guard audit records", () => {
  it("records guard.resolved once per run, naming the mode's source", () => {
    const { logger, records } = recorder();
    const resolver = createGuardResolver({ loadSettings: () => ({}), audit: logger });
    void resolver(runCtx({ request: { guard_mode: "on" } as never }));
    const resolved = records.find((r) => r.fields.event === "guard.resolved");
    expect(resolved?.level).toBe("info");
    expect(resolved?.fields).toMatchObject({
      mode: "on",
      source: "request",
      judge_configured: false,
      human_channel: false,
      run_id: "run-1",
      owner: "owner-1",
    });
  });

  it("names settings as the source when the request carries no mode", () => {
    const { logger, records } = recorder();
    const resolver = createGuardResolver({
      loadSettings: () => ({ guard: { type: "shell", mode: "on" } }),
      audit: logger,
    });
    void resolver(runCtx({ request: {} as never }));
    expect(records.find((r) => r.fields.event === "guard.resolved")?.fields.source).toBe(
      "settings",
    );
  });

  it("records guard.decision per guarded call, with a digest and never the command", async () => {
    const { logger, records } = recorder();
    const resolver = createGuardResolver({
      loadSettings: () => ({ guard: { type: "shell", denied_commands: ["rm"] } }),
      audit: logger,
    });
    const resolution = await resolver(runCtx({ request: { guard_mode: "on" } as never }));
    await resolution!.guard!(
      ctx("shell", { command: "rm -rf /tmp/x" }, shellFacts("rm -rf /tmp/x")),
    );
    const decision = records.find((r) => r.fields.event === "guard.decision");
    expect(decision?.fields).toMatchObject({
      verdict: "deny",
      matched: "deny_list",
      mode: "on",
      run_id: "run-1",
      owner: "owner-1",
    });
    expect(decision?.fields.command_digest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(decision)).not.toContain("/tmp/x");
  });

  it("records a human allow, an allow_session and a deny distinctly", async () => {
    const answers = ["allow", "allow_session", "deny"];
    let index = 0;
    const elicit: Elicit = async () => ({
      action: "accept",
      content: { decision: answers[index++] },
    });
    const { logger, records } = recorder();
    const resolver = createGuardResolver({ loadSettings: () => ({}), audit: logger });
    const resolution = await resolver(runCtx({ request: { guard_mode: "on" } as never, elicit }));
    await resolution!.elicit!(bashReq("bun test"));
    await resolution!.elicit!(bashReq("bun lint"));
    await resolution!.elicit!(bashReq("bun build"));
    const answered = records
      .filter((r) => r.fields.event === "guard.elicit.answered")
      .map((r) => [r.fields.answer, r.fields.answerer]);
    expect(answered).toEqual([
      ["allow", "human"],
      ["allow_session", "human"],
      ["deny", "human"],
    ]);
  });

  it("attributes a command the session allowlist already covers to the allowlist", async () => {
    const elicit: Elicit = async () => ({
      action: "accept",
      content: { decision: "allow_session" },
    });
    const { logger, records } = recorder();
    const resolver = createGuardResolver({ loadSettings: () => ({}), audit: logger });
    const resolution = await resolver(runCtx({ request: { guard_mode: "on" } as never, elicit }));
    await resolution!.elicit!(bashReq("bun test"));
    await resolution!.elicit!(bashReq("bun test"));
    const answerers = records
      .filter((r) => r.fields.event === "guard.elicit.answered")
      .map((r) => r.fields.answerer);
    expect(answerers).toEqual(["human", "session_allowlist"]);
  });

  it("attributes an auto-mode answer to the judge", async () => {
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] }),
    } as unknown as RunCapabilityContext["llm"];
    const { logger, records } = recorder();
    const resolver = createGuardResolver({
      loadSettings: () => ({
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      }),
      audit: logger,
    });
    const resolution = await resolver(
      runCtx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        llm,
      }),
    );
    expect(await resolution!.elicit!(bashReq("echo hi"))).toEqual({
      allowed: true,
      answerer: "judge",
    });
    expect(records.find((r) => r.fields.event === "guard.elicit.answered")?.fields.answerer).toBe(
      "judge",
    );
  });

  it("attributes a judge failure fallback to the human who answered it", async () => {
    const llm = {
      call: async () => {
        throw new Error("provider unavailable");
      },
    } as unknown as RunCapabilityContext["llm"];
    const elicit: Elicit = async () => ({
      action: "accept",
      content: { decision: "allow_session" },
    });
    const { logger, records } = recorder();
    const resolver = createGuardResolver({
      loadSettings: () => ({
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      }),
      audit: logger,
    });
    const resolution = await resolver(
      runCtx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        llm,
        elicit,
      }),
    );

    expect(await resolution!.elicit!(bashReq("bun run test"))).toEqual({
      allowed: true,
      answerer: "human",
    });
    expect(records.find((r) => r.fields.event === "guard.elicit.answered")?.fields).toMatchObject({
      answerer: "human",
      answer: "allow_session",
    });
  });

  it("warns when an escalated ask has no human channel, and still denies", async () => {
    const llm = {
      call: async () => ({ toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] }),
    } as unknown as RunCapabilityContext["llm"];
    const { logger, records } = recorder();
    const resolver = createGuardResolver({
      loadSettings: () => ({
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/claude-x",
      }),
      audit: logger,
    });
    const resolution = await resolver(
      runCtx({
        request: { guard_mode: "auto", guard_judge: { prompt: "judge" } } as never,
        llm,
      }),
    );
    const denied = await resolution!.elicit!({
      ...bashReq("$(x) y", shellFacts("y", true)),
      escalate: "human",
    });
    expect(denied).toEqual({ allowed: false, answerer: "unavailable" });
    const escalation = records.find((r) => r.fields.event === "guard.escalation.no_channel");
    expect(escalation?.level).toBe("warn");
    expect(escalation?.fields).toMatchObject({ run_id: "run-1" });
  });

  it("routes an escalated ask to the human when one exists", async () => {
    const elicit: Elicit = async () => ({ action: "accept", content: { decision: "allow" } });
    const { logger, records } = recorder();
    const resolver = createGuardResolver({ loadSettings: () => ({}), audit: logger });
    const resolution = await resolver(runCtx({ request: { guard_mode: "on" } as never, elicit }));
    expect(
      await resolution!.elicit!({
        ...bashReq("$(x) y", shellFacts("y", true)),
        escalate: "human",
      }),
    ).toEqual({ allowed: true, answerer: "human" });
    expect(records.some((r) => r.fields.event === "guard.escalation.no_channel")).toBe(false);
    expect(records.find((r) => r.fields.event === "guard.elicit.answered")?.fields.answerer).toBe(
      "human",
    );
  });

  it("writes nothing when no audit logger is supplied", async () => {
    const resolver = createGuardResolver({ loadSettings: () => ({}) });
    const resolution = await resolver(runCtx({ request: { guard_mode: "on" } as never }));
    expect(await resolution!.guard!(ctx("read_file", { path: "a.ts" }))).toMatchObject({
      verdict: "allow",
      mode: "on",
    });
  });
});

describe("createAuditLogger", () => {
  it("is silent when the host supplies no logger", () => {
    expect(createAuditLogger(undefined, true)).toBe(NOOP_LOGGER);
  });

  it("is silent when CLARVIS_LOG_AUDIT is off", () => {
    const { logger } = recorder();
    expect(createAuditLogger(logger, false)).toBe(NOOP_LOGGER);
  });

  it("stamps audit: true on every record", () => {
    const { logger, records } = recorder();
    createAuditLogger(logger, true).info({ event: "x" }, "m");
    expect(records[0]?.fields).toMatchObject({ component: "audit", audit: true, event: "x" });
  });

  it("falls back to the root logger when the backend has no child", () => {
    // Not `NOOP_LOGGER`'s own level: that is `silent`, which createAuditLogger
    // now declines to override.
    const flat: Logger = { ...NOOP_LOGGER, level: "info" };
    delete (flat as { child?: unknown }).child;
    expect(createAuditLogger(flat, true)).toBe(flat);
  });

  it("is silent when the host's own logger is silent", () => {
    const silenced: Logger = { ...recorder().logger, level: "silent" };
    expect(createAuditLogger(silenced, true)).toBe(NOOP_LOGGER);
  });
});
