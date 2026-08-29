import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLAGS,
  helpText,
  parseMode,
  resolveDebugRequest,
  usageText,
  versionText,
} from "../../src/cli-args.ts";

const product = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

test("parseMode maps the CLI flags; bare invocation runs", () => {
  expect(parseMode([])).toEqual({ kind: "run", ascii: false, debug: { enabled: false } });
  expect(parseMode(["--refresh-models"])).toEqual({
    kind: "refresh-models",
    debug: { enabled: false },
  });
  expect(parseMode(["--list"])).toEqual({ kind: "list", debug: { enabled: false } });
  expect(parseMode(["--delete", "sid"])).toEqual({
    kind: "delete",
    id: "sid",
    debug: { enabled: false },
  });
  expect(parseMode(["--resume", "sid"])).toEqual({
    kind: "resume",
    id: "sid",
    ascii: false,
    debug: { enabled: false },
  });
  expect(parseMode(["--continue"])).toEqual({
    kind: "continue",
    ascii: false,
    debug: { enabled: false },
  });
  expect(parseMode(["--help"])).toEqual({ kind: "help" });
  expect(parseMode(["-h"])).toEqual({ kind: "help" });
  expect(parseMode(["--version"])).toEqual({ kind: "version" });
  expect(parseMode(["--update"])).toEqual({ kind: "update" });
  expect(parseMode(["--update", "--debug"])).toEqual({
    kind: "usage-error",
    message: "--debug does not apply with --update",
  });
});

test("parseMode: --ascii folds into the interactive modes instead of a side-channel", () => {
  expect(parseMode(["--ascii"])).toEqual({ kind: "run", ascii: true, debug: { enabled: false } });
  expect(parseMode(["--ascii", "--continue"])).toEqual({
    kind: "continue",
    ascii: true,
    debug: { enabled: false },
  });
  expect(parseMode(["--resume", "sid", "--ascii"])).toEqual({
    kind: "resume",
    id: "sid",
    ascii: true,
    debug: { enabled: false },
  });
});

test("parseMode: --worktree selects a launch workspace with an optional name", () => {
  expect(parseMode(["--worktree"])).toEqual({
    kind: "run",
    ascii: false,
    debug: { enabled: false },
    worktree: true,
  });
  expect(parseMode(["--worktree", "review-auth", "--continue"])).toEqual({
    kind: "continue",
    ascii: false,
    debug: { enabled: false },
    worktree: "review-auth",
  });
  expect(parseMode(["--worktree=review-auth", "-p", "check it"])).toEqual({
    kind: "print",
    prompt: "check it",
    format: "text",
    debug: { enabled: false },
    worktree: "review-auth",
  });
});

test("parseMode: --env pins an Environment across interactive and headless kernels", () => {
  expect(parseMode(["--env", "workspace:research"])).toEqual({
    kind: "run",
    ascii: false,
    debug: { enabled: false },
    environmentSelector: "workspace:research",
  });
  expect(parseMode(["--list", "--env", "minimal"])).toEqual({
    kind: "list",
    debug: { enabled: false },
    environmentSelector: "minimal",
  });
  expect(parseMode(["--refresh-models", "--env", "global:research"])).toEqual({
    kind: "refresh-models",
    debug: { enabled: false },
    environmentSelector: "global:research",
  });
  expect(parseMode(["--env"]).kind).toBe("usage-error");
  expect(parseMode(["--update", "--env", "minimal"])).toEqual({
    kind: "usage-error",
    message: "--env does not apply with --update",
  });
});

test("parseMode: --debug folds into normal application modes, headless ones included", () => {
  expect(parseMode(["--debug"])).toEqual({ kind: "run", ascii: false, debug: { enabled: true } });
  expect(parseMode(["--continue", "--debug"])).toEqual({
    kind: "continue",
    ascii: false,
    debug: { enabled: true },
  });
  expect(parseMode(["--resume", "sid", "--debug"])).toEqual({
    kind: "resume",
    id: "sid",
    ascii: false,
    debug: { enabled: true },
  });
  expect(parseMode(["-p", "hi", "--debug"])).toEqual({
    kind: "print",
    prompt: "hi",
    format: "text",
    debug: { enabled: true },
  });
  expect(parseMode(["--list", "--debug"])).toEqual({ kind: "list", debug: { enabled: true } });
});

test("parseMode: --debug=<level> tunes the session, and a bad level is a usage error", () => {
  expect(parseMode(["--debug=warn"])).toEqual({
    kind: "run",
    ascii: false,
    debug: { enabled: true, level: "warn" },
  });
  expect(parseMode(["--list", "--debug=error"])).toEqual({
    kind: "list",
    debug: { enabled: true, level: "error" },
  });
  const bad = parseMode(["--debug=loud"]);
  expect(bad.kind).toBe("usage-error");
  if (bad.kind === "usage-error") {
    expect(bad.message).toContain("--debug");
    expect(bad.message).toContain("loud");
  }
  const unknown = parseMode(["--verbose=1"]);
  expect(unknown.kind).toBe("usage-error");
  if (unknown.kind === "usage-error") expect(unknown.message).toContain("--verbose=1");
});

test("resolveDebugRequest folds the environment in, with the flag winning both ways", () => {
  const run = parseMode([]);
  const flagged = parseMode(["--debug"]);
  const tuned = parseMode(["--debug=warn"]);

  expect(resolveDebugRequest(run, {})).toEqual({ enabled: false, level: "debug" });
  expect(resolveDebugRequest(flagged, {})).toEqual({ enabled: true, level: "debug" });
  expect(resolveDebugRequest(run, { CLARVIS_CODE_DEBUG: "1" })).toEqual({
    enabled: true,
    level: "debug",
  });
  expect(resolveDebugRequest(run, { CLARVIS_CODE_DEBUG: "info" })).toEqual({
    enabled: true,
    level: "info",
  });
  expect(
    resolveDebugRequest(run, { CLARVIS_CODE_DEBUG: "1", CLARVIS_CODE_DEBUG_LEVEL: "error" }),
  ).toEqual({ enabled: true, level: "error" });
  expect(resolveDebugRequest(run, { CLARVIS_CODE_DEBUG: "off" })).toEqual({
    enabled: false,
    level: "debug",
  });
  expect(resolveDebugRequest(flagged, { CLARVIS_CODE_DEBUG: "off" })).toEqual({
    enabled: true,
    level: "debug",
  });
  expect(resolveDebugRequest(tuned, { CLARVIS_CODE_DEBUG_LEVEL: "error" })).toEqual({
    enabled: true,
    level: "warn",
  });
  expect(resolveDebugRequest(run, { CLARVIS_CODE_DEBUG_LEVEL: "shout" })).toEqual({
    enabled: false,
    level: "debug",
  });
  expect(resolveDebugRequest(parseMode(["--help"]), { CLARVIS_CODE_DEBUG: "1" })).toEqual({
    enabled: false,
    level: "debug",
  });
});

test("parseMode: -p/--print builds the headless mode with agent and format", () => {
  expect(parseMode(["-p", "say hi"])).toEqual({
    kind: "print",
    prompt: "say hi",
    format: "text",
    debug: { enabled: false },
  });
  expect(parseMode(["--print", "say hi", "--format", "md", "--agent", "coder"])).toEqual({
    kind: "print",
    prompt: "say hi",
    agent: "coder",
    format: "md",
    debug: { enabled: false },
  });
});

test("parseMode: print usage errors — empty prompt, bad format, orphan --agent/--format", () => {
  expect(parseMode(["-p", "  "]).kind).toBe("usage-error");
  const badFormat = parseMode(["-p", "hi", "--format", "html"]);
  expect(badFormat.kind).toBe("usage-error");
  if (badFormat.kind === "usage-error") expect(badFormat.message).toContain("--format");
  expect(parseMode(["--agent", "coder"]).kind).toBe("usage-error");
  expect(parseMode(["--list", "--format", "md"]).kind).toBe("usage-error");
});

test("parseMode: an unknown flag is a usage error naming the token", () => {
  const mode = parseMode(["--hlep"]);
  expect(mode.kind).toBe("usage-error");
  if (mode.kind === "usage-error") expect(mode.message).toContain("--hlep");
});

test("parseMode: two mode flags cannot be combined", () => {
  const mode = parseMode(["--list", "--continue"]);
  expect(mode.kind).toBe("usage-error");
  if (mode.kind === "usage-error") {
    expect(mode.message).toContain("--continue");
    expect(mode.message).toContain("--list");
  }
});

test("parseMode: --delete/--resume without a value (or with a flag as value) is a usage error", () => {
  for (const argv of [
    ["--delete"],
    ["--delete", "--list"],
    ["--resume"],
    ["--resume", "--ascii"],
    ["--ascii", "--resume"],
  ]) {
    const mode = parseMode(argv);
    expect(mode.kind).toBe("usage-error");
    if (mode.kind === "usage-error") {
      expect(mode.message).toContain("session id");
      expect(mode.message).toContain(argv.includes("--delete") ? "--delete" : "--resume");
    }
  }
});

test("parseMode: a value that merely looks unusual still parses (not a flag)", () => {
  expect(parseMode(["--resume", "0198c0ff"])).toEqual({
    kind: "resume",
    id: "0198c0ff",
    ascii: false,
    debug: { enabled: false },
  });
});

test("helpText and usageText derive from the flags table; version reports the product", () => {
  const help = helpText();
  const usage = usageText();
  for (const f of FLAGS) {
    expect(help).toContain(f.flag);
    expect(help).toContain(f.desc);
    expect(usage).toContain(f.alias ?? f.flag);
  }
  expect(versionText()).toBe(`clarvis ${product.version}`);
});

test("the README CLI section stays in sync with the flags table", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "..", "README.md"), "utf8");
  for (const f of FLAGS) {
    expect(readme).toContain(f.flag);
    expect(readme).toContain(f.desc);
  }
});
