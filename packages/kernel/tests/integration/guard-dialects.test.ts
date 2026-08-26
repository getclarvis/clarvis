import { expect, it } from "bun:test";
import {
  analyzeShell,
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
