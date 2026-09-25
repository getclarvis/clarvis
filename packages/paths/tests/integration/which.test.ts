import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { executableOnPath, resolveCommand, setPathsLogger } from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";
import { environmentFixture, spyOnProcessEnv } from "../helpers/process-fixtures.ts";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "clarvis-test-"));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const modeBitsEnforced = !isRoot;

describe("executableOnPath", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("returns an executable named exactly as asked", () => {
    const bin = join(root, "tool");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(executableOnPath("tool", root)).toBe(bin);
  });

  it.skipIf(!modeBitsEnforced)(
    "keeps searching past a same-named file that is not executable",
    () => {
      const shadow = join(root, "shadow");
      const real = join(root, "real");
      mkdirSync(shadow);
      mkdirSync(real);
      writeFileSync(join(shadow, "tool"), "not executable");
      chmodSync(join(shadow, "tool"), 0o644);
      const bin = join(real, "tool");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      expect(executableOnPath("tool", [shadow, real].join(delimiter))).toBe(bin);
    },
  );

  it("returns undefined when no PATH entry holds the command", () => {
    expect(executableOnPath("definitely-not-here", root)).toBeUndefined();
  });
});

describe("resolveCommand", () => {
  let root: string;
  let ambient: NodeJS.ProcessEnv;
  let envSpy: ReturnType<typeof spyOnProcessEnv>;

  beforeEach(() => {
    root = makeWorkspace();
    ambient = environmentFixture();
    envSpy = spyOnProcessEnv(ambient);
  });
  afterEach(() => {
    envSpy.mockRestore();
    cleanup(root);
  });

  it("resolves against the ambient PATH", () => {
    const bin = join(root, "clarvis-resolve-hit");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    envSpy.mockReturnValue(environmentFixture({ ...ambient, PATH: root }));
    expect(resolveCommand("clarvis-resolve-hit")).toBe(bin);
  });

  it("falls back to the bare name so the OS still gets its own chance", () => {
    envSpy.mockReturnValue(environmentFixture({ ...ambient, PATH: root }));
    expect(resolveCommand("clarvis-resolve-absent")).toBe("clarvis-resolve-absent");
  });

  it("reuses the first answer, so a probe and its later spawn cannot disagree", () => {
    envSpy.mockReturnValue(environmentFixture({ ...ambient, PATH: root }));
    const first = resolveCommand("clarvis-resolve-memo");
    const bin = join(root, "clarvis-resolve-memo");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(resolveCommand("clarvis-resolve-memo")).toBe(first);
  });
});

describe("command resolution diagnostics", () => {
  afterEach(() => {
    setPathsLogger(null);
  });

  it("reports each command once, because the answer is memoized", () => {
    const sink = recorder();
    setPathsLogger(sink.logger);
    const envSpy = spyOnProcessEnv(environmentFixture({ ...process.env, PATH: "" }));
    try {
      resolveCommand("clarvis-observed-absent");
      resolveCommand("clarvis-observed-absent");
    } finally {
      envSpy.mockRestore();
    }
    expect(sink.events("paths.command_resolved")).toEqual([
      {
        event: "paths.command_resolved",
        command: "clarvis-observed-absent",
        resolved: "clarvis-observed-absent",
        found: false,
      },
    ]);
  });
});
