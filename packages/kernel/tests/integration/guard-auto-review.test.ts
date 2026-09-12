import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGuardContext,
  posixDialect,
  powershellDialect,
  POSIX_DEFAULT_ALLOWED_COMMANDS,
  type GuardContext,
} from "@clarvis/tools/guard";
import { createShellGuard } from "../../src/guard/shell-guard.ts";

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
