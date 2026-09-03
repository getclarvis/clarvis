import { expect, it } from "bun:test";
import path from "node:path";
import {
  analyzeShell,
  buildGuardContext,
  posixDialect,
  powershellDialect,
  type GuardContext,
  type ShellDialect,
} from "@clarvis/tools/guard";
import { createShellGuard } from "../../src/guard/shell-guard.ts";

function analyzedContext(command: string, dialect: ShellDialect): GuardContext {
  return {
    tool: "shell",
    args: { command },
    config: { workspaceRoot: "/workspace" } as GuardContext["config"],
    paths: [],
    shell: analyzeShell(command, dialect),
  };
}

const WORKSPACE_ROOT = process.platform === "win32" ? "C:\\clarvis-workspace" : "/workspace";

function runtimeConfig(): GuardContext["config"] {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    temporaryRoots: [],
    skillExecutionRoots: [],
    stateRoot: path.join(WORKSPACE_ROOT, ".clarvis"),
  } as unknown as GuardContext["config"];
}

it("integrates POSIX analyzer segments with kernel deny policy", async () => {
  const guard = createShellGuard({ deniedCommands: ["rm"] });
  expect(await guard(analyzedContext("printf ok | rm -rf build", posixDialect))).toMatchObject({
    verdict: "deny",
  });
});

it("integrates PowerShell alias canonicalization with kernel deny policy", async () => {
  const guard = createShellGuard({ deniedCommands: ["Remove-Item"] });
  expect(await guard(analyzedContext("rm -Recurse build", powershellDialect))).toMatchObject({
    verdict: "deny",
  });
});

it("keeps an absolute executable exemption local to its command-head occurrence", async () => {
  const executable =
    process.platform === "win32"
      ? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
      : "/usr/local/bin/echo";
  const context = buildGuardContext(
    "shell",
    { command: `${executable} ok; echo hacked > ${executable}` },
    runtimeConfig(),
    process.platform === "win32" ? powershellDialect : posixDialect,
  );
  const allowedCommands = process.platform === "win32" ? ["where", "Write-Output"] : ["echo"];
  expect(await createShellGuard({ allowedCommands })(context)).toMatchObject({
    verdict: "deny",
    reason: "command touches paths outside the workspace",
  });
});

it("matches an absolute Windows executable suffix against an extensionless deny entry", async () => {
  const executable =
    process.platform === "win32"
      ? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "curl.exe")
      : "/usr/bin/curl.exe";
  const context = buildGuardContext(
    "shell",
    { command: `${executable} --version` },
    runtimeConfig(),
    powershellDialect,
  );
  expect(await createShellGuard({ deniedCommands: ["curl"] })(context)).toMatchObject({
    verdict: "deny",
    reason: "command matches the denied commands list",
  });
});
