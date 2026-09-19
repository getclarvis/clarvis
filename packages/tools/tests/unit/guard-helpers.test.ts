import { describe, expect, it } from "bun:test";
import {
  withinWorkspace,
  touchesOutside,
  isDangerousCommand,
  commandRiskFindings,
} from "../../src/guard/index.ts";
import { analyzeShell } from "../../src/guard/analyze-shell.ts";
import { posixDialect } from "../../src/guard/dialects/posix.ts";
import { powershellDialect } from "../../src/guard/dialects/powershell.ts";
import { makeConfig } from "../helpers/fixtures.ts";
import type { ShellFacts, GuardContext, PathFact } from "../../src/guard/types.ts";

const analyzeBash = (command: string): ShellFacts => analyzeShell(command, posixDialect);
const analyzePwsh = (command: string): ShellFacts => analyzeShell(command, powershellDialect);

const cfg = makeConfig("/ws");
const pf = (withinWorkspace: boolean): PathFact => ({ raw: "x", resolved: "/x", withinWorkspace });
const ctx = (paths: PathFact[], shell?: ShellFacts): GuardContext => ({
  tool: "t",
  args: {},
  config: cfg,
  paths,
  shell,
});

describe("commandRiskFindings", () => {
  it.each(["sudo", "sudo echo hi", "timeout 5 sudo -n true"])(
    "flags privilege elevation for %s",
    (command) => {
      const findings = commandRiskFindings(analyzeBash(command));
      expect(findings.some((finding) => finding.kind === "privilege_elevation")).toBe(true);
      expect(isDangerousCommand(analyzeBash(command))).toBe(true);
    },
  );

  it.each([
    ["rm -f file", false, ["file"]],
    ["rm --force file", false, ["file"]],
    ["rm -rf directory", true, ["directory"]],
    ["rm -fr directory", true, ["directory"]],
    ["rm file -f", false, ["file"]],
    ["echo hi; rm -f file", false, ["file"]],
    ["FOO=1 timeout 5 nice rm -rf directory", true, ["directory"]],
  ] as const)("flags forced removal for %s", (command, recursive, operands) => {
    const findings = commandRiskFindings(analyzeBash(command));
    const removal = findings.find((finding) => finding.kind === "forced_removal");
    expect(removal).toMatchObject({ recursive, operands, operand_uncertainty: "none" });
    expect(isDangerousCommand(analyzeBash(command))).toBe(true);
  });

  it("records dynamic operand uncertainty without treating the binding as attestation", () => {
    const findings = commandRiskFindings(analyzeBash('rm -f "$out"'));
    expect(findings).toEqual([
      {
        segmentIndex: 0,
        kind: "forced_removal",
        recursive: false,
        operands: ["$out"],
        operand_uncertainty: "dynamic",
      },
    ]);
  });

  it("keeps privilege elevation and forced removal as distinct segment findings", () => {
    const findings = commandRiskFindings(analyzeBash("rm -f file; sudo true"));
    expect(findings.map((finding) => finding.kind)).toEqual([
      "forced_removal",
      "privilege_elevation",
    ]);
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
    expect(commandRiskFindings(analyzeBash(command))).toEqual([]);
    expect(isDangerousCommand(analyzeBash(command))).toBe(false);
  });

  it("uses the trusted normalized head without changing absolute executable argv", () => {
    const shell = analyzeBash("/usr/bin/rm -rf directory");
    shell.segments[0]!.normalized = "rm -rf directory";
    expect(commandRiskFindings(shell)).toEqual([
      {
        segmentIndex: 0,
        kind: "forced_removal",
        recursive: true,
        operands: ["directory"],
        operand_uncertainty: "none",
      },
    ]);
    expect(isDangerousCommand(shell)).toBe(true);
    expect(shell.segments[0]!.argv[0]).toBe("/usr/bin/rm");
  });

  it.each(["rm -Force file", "Remove-Item -Recurse -Force directory", "del -F temp.txt"])(
    "flags PowerShell forced removal for %s",
    (command) => {
      const findings = commandRiskFindings(analyzePwsh(command));
      expect(findings.some((finding) => finding.kind === "forced_removal")).toBe(true);
      expect(isDangerousCommand(analyzePwsh(command))).toBe(true);
    },
  );

  it("does not treat PowerShell -Filter as force", () => {
    expect(commandRiskFindings(analyzePwsh("Remove-Item -Filter *.tmp"))).toEqual([]);
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
