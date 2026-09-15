import { describe, expect, it } from "bun:test";
import { withinWorkspace, touchesOutside, isDangerousCommand } from "../../src/guard/index.ts";
import { analyzeShell } from "../../src/guard/analyze-shell.ts";
import { posixDialect } from "../../src/guard/dialects/posix.ts";
import { makeConfig } from "../helpers/fixtures.ts";
import type { ShellFacts, GuardContext, PathFact } from "../../src/guard/types.ts";

const analyzeBash = (command: string): ShellFacts => analyzeShell(command, posixDialect);

const cfg = makeConfig("/ws");
const pf = (withinWorkspace: boolean): PathFact => ({ raw: "x", resolved: "/x", withinWorkspace });
const ctx = (paths: PathFact[], shell?: ShellFacts): GuardContext => ({
  tool: "t",
  args: {},
  config: cfg,
  paths,
  shell,
});

describe("isDangerousCommand", () => {
  it.each([
    "sudo",
    "sudo echo hi",
    "timeout 5 sudo -n true",
    "rm -f file",
    "rm --force file",
    "rm -rf directory",
    "rm -fr directory",
    "rm file -f",
    "echo hi; rm -f file",
    "FOO=1 timeout 5 nice rm -rf directory",
  ])("flags %s", (command) => {
    expect(isDangerousCommand(analyzeBash(command))).toBe(true);
  });

  it.each([
    "git push --force",
    "curl -f https://example.test",
    "npm install",
    "rm file",
    "rm -r directory",
    "rm -- --force",
    "rm -- -rf",
    "rm --foo file",
    "rm --preserve-root file",
    "echo sudo rm -rf",
    "rm --forceful file",
  ])("does not overclassify %s", (command) => {
    expect(isDangerousCommand(analyzeBash(command))).toBe(false);
  });

  it("uses the trusted normalized head without changing absolute executable argv", () => {
    const shell = analyzeBash("/usr/bin/rm -rf directory");
    shell.segments[0]!.normalized = "rm -rf directory";
    expect(isDangerousCommand(shell)).toBe(true);
    expect(shell.segments[0]!.argv[0]).toBe("/usr/bin/rm");
  });
});

describe("withinWorkspace", () => {
  it("is true only when there are paths and all are within", () => {
    expect(withinWorkspace(ctx([pf(true), pf(true)]))).toBe(true);
    expect(withinWorkspace(ctx([pf(true), pf(false)]))).toBe(false);
    expect(withinWorkspace(ctx([]))).toBe(false);
  });

  it("is false when the bash command is undecidable, even if known paths are within", () => {
    expect(withinWorkspace(ctx([pf(true)], analyzeBash("echo $(whoami)")))).toBe(false);
  });
});

describe("touchesOutside", () => {
  it("is true when any known path escapes", () => {
    expect(touchesOutside(ctx([pf(true), pf(false)]))).toBe(true);
    expect(touchesOutside(ctx([pf(true)]))).toBe(false);
    expect(touchesOutside(ctx([]))).toBe(false);
  });
});
