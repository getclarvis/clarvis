import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  nonUtf8FilenamesSupported,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

const rgAvailable = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!rgAvailable)("ripgrep single-file search", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: true });
  });
  afterEach(() => cleanup(root));

  it("searches a single file at the workspace root and reports its path", async () => {
    write(root, "hello.txt", "needle here\nother\n");
    const r = await callTool(
      "grep",
      { pattern: "needle", path: "hello.txt", output_mode: "content" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("hello.txt:1:needle here");
  });

  it("searches a single nested file, reporting the workspace-relative path", async () => {
    write(root, "sub/deep/note.txt", "needle inside\n");
    const r = await callTool(
      "grep",
      { pattern: "needle", path: "sub/deep/note.txt", output_mode: "content" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("sub/deep/note.txt:1:needle inside");
  });
});

describe.skipIf(!rgAvailable)("ripgrep stream-cap truncation", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, {
      ripgrepAvailable: true,
      confineToWorkspace: false,
      maxOutputBytes: 1,
    });
  });
  afterEach(() => cleanup(root));

  it("kills ripgrep once output exceeds the stream cap and reports an incomplete scan", async () => {
    write(root, "giant.txt", "y".repeat(500000) + "\n");
    const r = await callTool("grep", { pattern: "y", output_mode: "content" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("search incomplete");
  });

  it("reports an incomplete scan after parsing some complete matches", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `hit ${i}`).join("\n");
    write(root, "many.txt", lines + "\n");
    const r = await callTool("grep", { pattern: "hit" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("search incomplete");
  });
});

describe.skipIf(!rgAvailable)("ripgrep non-UTF-8 output", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: true, confineToWorkspace: false });
  });
  afterEach(() => cleanup(root));

  it("matches a line whose bytes are not valid UTF-8", async () => {
    const body = Buffer.concat([
      Buffer.from("needle "),
      Buffer.from([0xff]),
      Buffer.from(" tail\n"),
    ]);
    writeFileSync(`${root}/badline.txt`, body);
    const r = await callTool(
      "grep",
      { pattern: "needle", path: "badline.txt", output_mode: "content" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("badline.txt:1:");
  });

  it.skipIf(!nonUtf8FilenamesSupported)("skips a match whose path is not valid UTF-8", async () => {
    const badName = Buffer.concat([
      Buffer.from(`${root}/bad-`),
      Buffer.from([0xff]),
      Buffer.from(".txt"),
    ]);
    writeFileSync(badName, "needle here\n");
    const r = await callTool("grep", { pattern: "needle", output_mode: "content" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });
});

// NOT skipIf(!rgAvailable): the regex time budget exists precisely for the
// in-process fallback, which is the only grep path a host without `rg` ever
// runs. These force it with ripgrepAvailable: false.
describe("in-process regex time budget", () => {
  // Non-matching text plus nested quantifiers: ~1.96s of backtracking per
  // application on this repo's runtime, against a 100ms budget — a ~19x margin,
  // so which side of the threshold a run lands on is not a machine-speed
  // question.
  const EVIL_LINE = "a".repeat(30) + "!";
  const EVIL_PATTERN = "((a+)+)+$";

  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false, regexScanBudgetMs: 100 });
  });
  afterEach(() => cleanup(root));

  it("stops scanning further files once the pattern exhausts the budget", async () => {
    write(root, "a.txt", `${EVIL_LINE}\n`);
    write(root, "b.txt", `${EVIL_LINE}\n`);
    const r = await callTool("grep", { pattern: EVIL_PATTERN, output_mode: "content" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("search incomplete");
    expect(r.text).toContain("regex time budget");
  });

  it("stops mid-file, leaving later lines of that file unscanned", async () => {
    write(root, "only.txt", `${EVIL_LINE}\n${EVIL_LINE}\n${EVIL_LINE}\n`);
    const r = await callTool("grep", { pattern: EVIL_PATTERN, output_mode: "content" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("regex time budget");
  });

  it("names the pattern rather than the output cap as the cause", async () => {
    write(root, "a.txt", `${EVIL_LINE}\n`);
    write(root, "b.txt", `${EVIL_LINE}\n`);
    const r = await callTool("grep", { pattern: EVIL_PATTERN }, config);
    expect(r.text).toContain("backtrack catastrophically");
    expect(r.text).not.toContain("output cap");
  });

  // The anti-flake witness: a legitimate pattern charges microseconds, so even
  // a 100ms budget is untouchable by it. Without this, a guard that charged
  // wall-clock (or disk) time would pass every test above while silently
  // reporting real searches as incomplete on a loaded machine.
  it("does not affect a normal pattern, even at the same tiny budget", async () => {
    write(root, "a.txt", `${EVIL_LINE}\n`);
    write(root, "b.txt", `${EVIL_LINE}\n`);
    write(root, "c.txt", `${EVIL_LINE}\n`);
    const r = await callTool("grep", { pattern: "a+!" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("search incomplete");
    expect(r.text).not.toContain("regex time budget");
    expect(r.text.split("\n").sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("leaves the multiline path scanning normally under a generous budget", async () => {
    write(root, "m.txt", "alpha\nbeta\n");
    const r = await callTool(
      "grep",
      { pattern: "alpha.beta", multiline: true, output_mode: "content" },
      makeConfig(root, { ripgrepAvailable: false }),
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("m.txt:1:");
  });
});
