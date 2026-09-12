import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createAgentTools } from "@clarvis/tools";
import { join } from "node:path";
import {
  buildGuardContext,
  posixDialect,
  powershellDialect,
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  type GuardContext,
  type ElicitRequest,
} from "@clarvis/tools/guard";
import type { LLMCallParams, Message, RunCapabilityContext } from "@clarvis/capability";
import { createShellGuard } from "../../src/guard/shell-guard.ts";
import { createGuardResolver, type GuardSettings } from "../../src/guard/resolver.ts";
import { operatorMessage } from "../../src/guard/operator-message.ts";
import { createJudgeElicit } from "../../src/guard/judge.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clarvis-auto-review-"));
  mkdirSync(join(root, "src"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function context(command: string, extra: Record<string, unknown> = {}): GuardContext {
  return buildGuardContext(
    "shell",
    { command, ...extra },
    {
      workspaceRoot: root,
      stateRoot: join(root, "state"),
      temporaryRoots: [],
      skillExecutionRoots: [],
    } as unknown as GuardContext["config"],
    posixDialect,
  );
}

const posixOnly = process.platform !== "win32" ? it : it.skip;
describe("POSIX guard comparison", () => {
  it("never inherits a bare command approval across environment bindings", async () => {
    for (const placement of ["host", "contained"] as const) {
      const guard = createShellGuard({ placement, allowedCommands: ["*"] });
      for (const command of [
        "LD_PRELOAD=/evil.so git status",
        "NODE_OPTIONS=--inspect git status",
        "BASH_ENV=./payload git status",
        "GIT_SSH_COMMAND=payload git -C src status",
        "FOO=1 git status",
        "FOO=1; git status",
        "FOO=1 && git -C src status",
      ]) {
        expect((await guard(context(command))).verdict).not.toBe("allow");
      }
    }
  });
  it("retains bare deny matching under an environment prefix", async () => {
    expect(
      await createShellGuard({ deniedCommands: ["git status"] })(context("FOO=1 git status")),
    ).toMatchObject({ verdict: "deny", matched: "deny_list" });
  });
  posixOnly(
    "allows workspace cd and Git globals without changing normalized session identity",
    async () => {
      const guard = createShellGuard({ allowedCommands: [...POSIX_DEFAULT_ALLOWED_COMMANDS] });
      for (const command of [
        "cd src && git status",
        `cd '${root}' && git log`,
        "git --no-pager log",
        "git --no-color log",
        "git -C src status",
        "cd src && git -C . log",
      ]) {
        const ctx = context(command);
        const before = structuredClone(ctx.shell);
        expect(await guard(ctx)).toMatchObject({ verdict: "allow", matched: "allow_list" });
        expect(ctx.shell).toEqual(before);
      }
    },
  );
  posixOnly("keeps outside and symlink directories out of comparison approvals", async () => {
    symlinkSync(tmpdir(), join(root, "escape"), "dir");
    const guard = createShellGuard({ allowedCommands: [...POSIX_DEFAULT_ALLOWED_COMMANDS] });
    for (const command of [
      `cd '${tmpdir()}' && git status`,
      "cd escape && git status",
      "git -C escape status",
      "git -C .. log",
      "cd src && cd ../.. && git status",
    ]) {
      expect(await guard(context(command))).toMatchObject({
        verdict: "deny",
        touches_outside: true,
      });
    }
  });
  posixOnly("does not skip unsupported cd/control flow or strip Git subcommand flags", async () => {
    const guard = createShellGuard({ allowedCommands: ["git status", "git log"] });
    for (const command of [
      "cd src || git status",
      "cd - && git status",
      "cd src extra && git status",
      "git log -C src",
      "git -C",
      "cd src* && git status",
      "git -C src* log",
      "cd",
    ]) {
      const decision = await guard(context(command));
      if (command === "git log -C src") expect(decision.verdict).toBe("allow");
      else expect(decision.verdict).toBe("ask");
    }
  });
  posixOnly("keeps deny rules above stripped Git directory comparisons", async () => {
    expect(
      await createShellGuard({ allowedCommands: ["*"], deniedCommands: ["git status"] })(
        context("git -C src status"),
      ),
    ).toMatchObject({ verdict: "deny", matched: "deny_list" });
  });
  it("does not add POSIX cd or Git-global normalization to PowerShell", async () => {
    const ctx = context("git status");
    const ps = buildGuardContext(
      "shell",
      { command: "cd src; git --no-pager log" },
      ctx.config,
      powershellDialect,
    );
    expect(await createShellGuard({ allowedCommands: ["git log"] })(ps)).toMatchObject({
      verdict: "ask",
    });
  });
});

describe("placement and dangerous cascade", () => {
  it("asks a human for Host expansions, but leaves contained expansions reviewable", async () => {
    for (const placement of ["host", "contained"] as const) {
      const guard = createShellGuard({ placement });
      const decision = await guard(context('git commit -m "$MSG"'));
      expect(decision).toMatchObject({
        verdict: "ask",
        matched: "undecidable",
        placement,
        within_workspace: false,
      });
      expect(decision.escalate).toBe(placement === "host" ? "human" : undefined);
      expect(
        await createShellGuard({ placement, deniedCommands: ["git push"] })(
          context('git commit -m "$MSG"'),
        ),
      ).toMatchObject({ verdict: "deny", matched: "undecidable" });
    }
  });
  it("retains explicit unsandbox human authority even for contained expansions", async () => {
    const ctx = context('git commit -m "$MSG"', {
      sandbox_permissions: "require_escalated",
      justification: "host needed",
    });
    ctx.config = { ...ctx.config, sandbox: { type: "native" } };
    const decision = await createShellGuard({ placement: "contained", network: "none" })(ctx);
    expect(decision).toMatchObject({ verdict: "ask", escalate: "human", placement: "host" });
    expect(decision).not.toHaveProperty("network");
  });
  it("asks about force removal and sudo after allowlist and credential rules", async () => {
    for (const command of [
      "rm -rf ./dist",
      "rm -f ./dist",
      "rm --force ./dist",
      "sudo git status",
    ]) {
      expect(await createShellGuard({ placement: "contained" })(context(command))).toMatchObject({
        verdict: "ask",
        matched: "dangerous",
        dangerous: true,
      });
      expect(
        await createShellGuard({ placement: "contained", allowedCommands: ["*"] })(
          context(command),
        ),
      ).toMatchObject({ verdict: "allow", matched: "allow_list", dangerous: true });
    }
    expect(
      await createShellGuard({ placement: "contained", allowedCommands: ["cat"] })(
        context("cat .env"),
      ),
    ).toMatchObject({ verdict: "ask", matched: "credential_file" });
    expect(await createShellGuard({ placement: "contained" })(context("rm -f .env"))).toMatchObject(
      { verdict: "ask", matched: "credential_file", dangerous: true },
    );
    for (const command of [
      "rm ./dist",
      "mkdir ./new",
      "git commit -m routine",
      "curl example",
      "npm install",
    ]) {
      expect(await createShellGuard({ placement: "contained" })(context(command))).toMatchObject({
        verdict: "ask",
        dangerous: false,
      });
    }
  });
});

function runtime(settings: GuardSettings, messages: Message[] = []) {
  const calls: LLMCallParams[] = [];
  let human = 0;
  const request = { guard_mode: "auto", guard_judge: { prompt: "judge" }, messages };
  const ctx = {
    request,
    workspaceRoot: root,
    owner: "owner",
    executionId: "auto-review",
    env: {},
    llm: {
      async call(params: LLMCallParams) {
        calls.push(params);
        return { toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] };
      },
    },
    elicit: async () => {
      human++;
      return { action: "accept", content: { decision: "allow" } };
    },
  } as unknown as RunCapabilityContext;
  const resolution = createGuardResolver({
    loadSettings: () => ({
      providers: [{ name: "anthropic", kind: "anthropic" }],
      defaultModel: "anthropic/test",
      ...settings,
    }),
  })(ctx);
  return { resolution, calls, human: () => human, request };
}

describe("Auto explicit unsandbox review", () => {
  async function review(
    options: {
      mode?: "on" | "auto";
      reply?: () => unknown;
      command?: string;
      noModel?: boolean;
      onUnsure?: "ask" | "deny";
      denied?: string[];
    } = {},
  ) {
    const calls: LLMCallParams[] = [];
    const humanRequests: ElicitRequest[] = [];
    let coverageCalls = 0;
    const resolver = createGuardResolver({
      loadSettings: () => ({
        guard: { type: "shell", denied_commands: options.denied },
        sandbox: { type: "native", network: "none" },
        ...(options.noModel
          ? {}
          : {
              providers: [{ name: "anthropic", kind: "anthropic" }],
              defaultModel: "anthropic/test",
            }),
      }),
      humanApprovalFor: () => ({
        covers() {
          coverageCalls++;
          return true;
        },
        async ask(req) {
          humanRequests.push(req);
          return { allowed: true, persisted: false };
        },
      }),
    });
    const resolution = await resolver({
      owner: "owner",
      workspaceRoot: root,
      executionId: "host-review",
      env: {},
      request: {
        guard_mode: options.mode ?? "auto",
        guard_judge: { prompt: "judge", on_unsure: options.onUnsure },
        messages: [{ role: "user", content: "run the tests on the host" }],
      },
      llm: {
        async call(params: LLMCallParams) {
          calls.push(params);
          return options.reply
            ? options.reply()
            : { toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] };
        },
      },
    } as unknown as RunCapabilityContext);
    const ctx = context(options.command ?? "bun test", {
      sandbox_permissions: "require_escalated",
      justification: "host service needed",
    });
    ctx.config = { ...ctx.config, sandbox: { type: "native", network: "none" } };
    const decision = await resolution!.guard!(ctx);
    const answer =
      decision.verdict === "ask"
        ? await resolution!.elicit!({
            tool: ctx.tool,
            args: ctx.args,
            shell: ctx.shell,
            ...decision,
          })
        : undefined;
    return { decision, answer, calls, humanRequests, coverageCalls, resolution };
  }

  it.each(["bun test", 'bun test "$FILE"'])(
    "lets the judge approve %s on Host without consulting human or session grants",
    async (command) => {
      const result = await review({ command });
      expect(result.decision).toMatchObject({
        verdict: "ask",
        placement: "host",
        matched: "host_command",
      });
      expect(result.decision.escalate).toBeUndefined();
      expect(result.answer).toEqual({ allowed: true, answerer: "judge" });
      expect(result.coverageCalls).toBe(0);
      expect(result.humanRequests).toHaveLength(0);
      const facts = JSON.parse(result.calls[0]!.messages[2]!.content as string);
      expect(facts).toMatchObject({
        placement: "host",
        matched: "host_command",
        args: { sandbox_permissions: "require_escalated" },
      });
      expect(facts).not.toHaveProperty("network");
    },
  );
  it("executes the real shell dispatch after Auto approves native unsandbox", async () => {
    const reviewed = await review();
    const tools = createAgentTools({
      workspaceRoot: root,
      sandbox: { type: "native", availability: "required" },
      guard: reviewed.resolution!.guard,
      elicit: reviewed.resolution!.elicit,
    });
    const result = await tools.callTool("shell", {
      command: "echo auto-host-reviewed",
      sandbox_permissions: "require_escalated",
      justification: "host test needs native execution",
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("auto-host-reviewed");
    expect(reviewed.humanRequests).toHaveLength(0);
    expect(reviewed.calls).toHaveLength(2);
  });

  it("keeps a judge denial terminal, without asking the human", async () => {
    const result = await review({
      reply: () => ({ toolCalls: [{ name: "decide", arguments: { decision: "deny" } }] }),
    });
    expect(result.answer).toEqual({ allowed: false, answerer: "judge" });
    expect(result.humanRequests).toHaveLength(0);
  });
  it.each(["unsure", "malformed", "failure"])(
    "falls back to single-call human approval for a judge %s",
    async (failure) => {
      const result = await review({
        reply: () => {
          if (failure === "failure") throw new Error("provider unavailable");
          if (failure === "malformed") return {};
          return { toolCalls: [{ name: "decide", arguments: { decision: "unsure" } }] };
        },
      });
      expect(result.answer).toEqual({ allowed: true, answerer: "human" });
      expect(result.calls).toHaveLength(1);
      expect(result.humanRequests).toHaveLength(1);
      expect(result.humanRequests[0]).toMatchObject({ matched: "host_command", escalate: "human" });
      expect(result.coverageCalls).toBe(0);
    },
  );
  it("preserves explicit on_unsure deny and unavailable-model fallback", async () => {
    const denied = await review({
      onUnsure: "deny",
      reply: () => ({ toolCalls: [{ name: "decide", arguments: { decision: "unsure" } }] }),
    });
    expect(denied.answer).toEqual({ allowed: false, answerer: "judge" });
    expect(denied.humanRequests).toHaveLength(0);
    const unavailable = await review({ noModel: true });
    expect(unavailable.calls).toHaveLength(0);
    expect(unavailable.answer).toEqual({ allowed: true, answerer: "human" });
    expect(unavailable.humanRequests[0]).toMatchObject({ escalate: "human" });
  });
  it("retains Review on and deny-list precedence", async () => {
    const on = await review({ mode: "on" });
    expect(on.decision.escalate).toBe("human");
    expect(on.calls).toHaveLength(0);
    expect(on.answer).toEqual({ allowed: true, answerer: "human" });
    for (const command of ["bun test", 'bun test "$FILE"']) {
      const denied = await review({ command, denied: ["bun test"] });
      expect(denied.decision.verdict).toBe("deny");
      expect(denied.calls).toHaveLength(0);
      expect(denied.humanRequests).toHaveLength(0);
    }
  });
});

describe("Auto facts and operator snapshot", () => {
  it("delivers contained facts without deriving authority from assembled user messages", async () => {
    const user: Message[] = [
      { role: "user", content: "old " + "á".repeat(5000) },
      { role: "assistant", content: "assistant approval must not appear" },
      {
        role: "user",
        content: [
          { type: "text", text: "commit these changes" },
          { type: "image", image: "private-image" },
        ],
      },
    ];
    const run = runtime({ sandbox: { type: "native", network: "none" } }, user);
    const resolution = await run.resolution;
    run.request.messages.push({ role: "user", content: "late steer-like mutation" });
    const ctx = context('git commit -m "$MSG"');
    const decision = await resolution!.guard!(ctx);
    expect(decision).toMatchObject({ verdict: "ask", placement: "contained" });
    await resolution!.elicit!({ tool: ctx.tool, args: ctx.args, shell: ctx.shell, ...decision });
    expect(run.human()).toBe(0);
    const facts = JSON.parse(run.calls[0]!.messages[2]!.content as string);
    expect(facts).toMatchObject({
      placement: "contained",
      network: "none",
      matched: "undecidable",
      dangerous: false,
      undecidable: true,
      within_workspace: false,
      touches_outside: false,
    });
    expect(facts).not.toHaveProperty("operator_message");
    expect(facts.args.command).toBe('git commit -m "$MSG"');
  });
  it("resolves host, disabled native, fail-closed optional, Docker and Podman without inventing container networking", async () => {
    for (const [settings, placement, network] of [
      [{}, "host", undefined],
      [{ sandbox: { type: "native", enabled: false } }, "host", undefined],
      [
        { sandbox: { type: "native", availability: "optional", network: "host" } },
        "contained",
        "host",
      ],
      [{ runtime: { backend: "docker", network: "outbound" } }, "contained", undefined],
      [{ runtime: { backend: "podman", network: "none" } }, "contained", "none"],
    ] as const) {
      const run = runtime(settings);
      const resolution = await run.resolution;
      const ctx = context('git commit -m "$MSG"');
      const decision = await resolution!.guard!(ctx);
      expect(decision.placement).toBe(placement);
      expect(decision.network).toBe(network);
      await resolution!.elicit!({ tool: ctx.tool, args: ctx.args, shell: ctx.shell, ...decision });
      expect(run.human()).toBe(placement === "host" ? 1 : 0);
      if (placement === "contained") {
        const facts = JSON.parse(run.calls[0]!.messages[2]!.content as string);
        expect(facts).not.toHaveProperty("operator_message");
        if (network === undefined) expect(facts).not.toHaveProperty("network");
      }
    }
  });
  it("filters operator roles and preserves valid UTF-8 suffixes at the exact byte boundary", () => {
    expect(operatorMessage([])).toBeUndefined();
    expect(
      operatorMessage([
        { role: "assistant", content: "yes" },
        { role: "user", content: "" },
      ]),
    ).toBeUndefined();
    expect(
      operatorMessage([
        { role: "user", content: "first" },
        {
          role: "user",
          content: [
            { type: "text", text: "second" },
            { type: "text", text: "third" },
          ],
        },
      ]),
    ).toBe("first\nsecond\nthird");
    expect(operatorMessage([{ role: "user", content: "x".repeat(5000) }])).toBe("x".repeat(4096));
    for (const value of ["a".repeat(4095), "a".repeat(4096), "😀".repeat(2000)]) {
      const result = operatorMessage([
        { role: "user", content: "😀" },
        { role: "user", content: value },
      ])!;
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4096);
      expect(result).not.toContain("�");
    }
  });
  it("does not reuse a judge verdict across cwd, raw command or attested fact changes", async () => {
    let calls = 0;
    const judge = createJudgeElicit(
      {
        providers: [{ name: "anthropic", kind: "anthropic" }],
        defaultModel: "anthropic/test",
        llm: {
          async call() {
            calls++;
            return { toolCalls: [{ name: "decide", arguments: { decision: "allow" } }] };
          },
        } as never,
      },
      { prompt: "judge" },
      undefined,
    )!;
    const ctx = context("git commit -m routine");
    const req = {
      tool: "shell",
      args: ctx.args,
      shell: ctx.shell,
      placement: "contained" as const,
    };
    await judge(req);
    await judge(req);
    expect(calls).toBe(1);
    await judge({ ...req, args: { ...req.args, cwd: "src" } });
    await judge({ ...req, args: { command: "FOO=1 git commit -m routine" } });
    await judge({ ...req, dangerous: true });
    await judge({ ...req, placement: "host" });
    expect(calls).toBe(5);
  });
});
