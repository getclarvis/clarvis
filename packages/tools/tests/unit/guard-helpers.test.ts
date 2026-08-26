import { describe, expect, it } from "bun:test";
import { withinWorkspace, touchesOutside } from "../../src/guard/helpers.ts";
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
