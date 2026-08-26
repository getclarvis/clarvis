import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { executableOnPath, resolveCommand, setPathsLogger } from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";

const PATHEXT = ".COM;.EXE;.BAT;.CMD";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "clarvis-test-"));
}

// Windows refuses to unlink a file another process still holds open, and the
// handles are released a moment after the kill is requested - so a teardown
// running straight after races and throws EBUSY. Retrying briefly is enough;
// `maxRetries` alone is not, because Bun's rmSync does not back off on EBUSY.
function cleanup(root: string): void {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") || Date.now() > deadline) {
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// Windows has no execute bit, and root bypasses it - either makes a
// "permission denied" assertion unprovable rather than merely inapplicable.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const modeBitsEnforced = process.platform !== "win32" && !isRoot;

describe("executableOnPath — Windows", () => {
  let root: string;
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    root = makeWorkspace();
    dirA = join(root, "a");
    dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
  });
  afterEach(() => cleanup(root));

  const find = (command: string, path: string, pathext: string | undefined = PATHEXT) =>
    executableOnPath(command, path, "win32", pathext);

  it("expands a bare name against PATHEXT", () => {
    writeFileSync(join(dirA, "bun.EXE"), "");
    expect(find("bun", dirA)).toBe(join(dirA, "bun.EXE"));
  });

  it("finds nothing for an extension-less file, which Windows will not run", () => {
    writeFileSync(join(dirA, "bun"), "");
    expect(find("bun", dirA)).toBeUndefined();
  });

  it("prefers the earlier PATHEXT entry within one directory", () => {
    writeFileSync(join(dirA, "bun.CMD"), "");
    writeFileSync(join(dirA, "bun.EXE"), "");
    expect(find("bun", dirA)).toBe(join(dirA, "bun.EXE"));
  });

  it("prefers the earlier PATH directory over a better extension later", () => {
    writeFileSync(join(dirA, "bun.CMD"), "");
    writeFileSync(join(dirB, "bun.EXE"), "");
    expect(find("bun", [dirA, dirB].join(delimiter))).toBe(join(dirA, "bun.CMD"));
  });

  it("uses a name that already carries a PATHEXT extension as written", () => {
    writeFileSync(join(dirA, "bun.exe"), "");
    expect(find("bun.exe", dirA)).toBe(join(dirA, "bun.exe"));
  });

  it("falls back to the default extension list when PATHEXT is unset", () => {
    writeFileSync(join(dirA, "bun.CMD"), "");
    expect(find("bun", dirA, undefined)).toBe(join(dirA, "bun.CMD"));
  });

  it("skips a directory that shares the command's name", () => {
    mkdirSync(join(dirA, "bun.EXE"));
    writeFileSync(join(dirB, "bun.EXE"), "");
    expect(find("bun", [dirA, dirB].join(delimiter))).toBe(join(dirB, "bun.EXE"));
  });
});

describe("executableOnPath — POSIX", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("returns an executable named exactly as asked", () => {
    const bin = join(root, "tool");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(executableOnPath("tool", root, "linux")).toBe(bin);
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
      expect(executableOnPath("tool", [shadow, real].join(delimiter), "linux")).toBe(bin);
    },
  );

  it("does not expand against PATHEXT", () => {
    writeFileSync(join(root, "tool.EXE"), "");
    chmodSync(join(root, "tool.EXE"), 0o755);
    expect(executableOnPath("tool", root, "linux", PATHEXT)).toBeUndefined();
  });

  it("returns undefined when no PATH entry holds the command", () => {
    expect(executableOnPath("definitely-not-here", root, "linux")).toBeUndefined();
  });
});

describe("resolveCommand", () => {
  let root: string;
  let previousPath: string | undefined;

  beforeEach(() => {
    root = makeWorkspace();
    previousPath = process.env.PATH;
  });
  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    cleanup(root);
  });

  it.skipIf(process.platform === "win32")("resolves against the ambient PATH", () => {
    const bin = join(root, "clarvis-resolve-hit");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    process.env.PATH = root;
    expect(resolveCommand("clarvis-resolve-hit")).toBe(bin);
  });

  it("falls back to the bare name so the OS still gets its own chance", () => {
    process.env.PATH = root;
    expect(resolveCommand("clarvis-resolve-absent")).toBe("clarvis-resolve-absent");
  });

  it("reuses the first answer, so a probe and its later spawn cannot disagree", () => {
    process.env.PATH = root;
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
    const previous = process.env.PATH;
    process.env.PATH = "";
    try {
      resolveCommand("clarvis-observed-absent");
      resolveCommand("clarvis-observed-absent");
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
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
