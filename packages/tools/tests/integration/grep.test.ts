import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { executableOnPath } from "@clarvis/paths";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  writeBinary,
  chmod,
  modeBitsEnforced,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

const rgAvailable = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();
const mkfifo = process.platform === "win32" ? undefined : executableOnPath("mkfifo");

describe("grep (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false });
    write(root, "a.txt", "foo\nbar\nfoo baz\n");
    write(root, "b.txt", "nothing here\n");
  });
  afterEach(() => cleanup(root));

  it("files_with_matches (default) lists matching files", async () => {
    const r = await callTool("grep", { pattern: "foo" }, config);
    expect(r.text).toBe("a.txt");
  });

  it("content mode formats path:line:text", async () => {
    const r = await callTool("grep", { pattern: "foo", output_mode: "content" }, config);
    expect(r.text).toBe("a.txt:1:foo\na.txt:3:foo baz");
  });

  it("count mode reports path:count", async () => {
    const r = await callTool("grep", { pattern: "foo", output_mode: "count" }, config);
    expect(r.text).toBe("a.txt:2");
  });

  it("ignore_case matches case-insensitively", async () => {
    const r = await callTool(
      "grep",
      { pattern: "FOO", ignore_case: true, output_mode: "count" },
      config,
    );
    expect(r.text).toBe("a.txt:2");
  });

  it("returns (no matches) as success when nothing matches", async () => {
    const r = await callTool("grep", { pattern: "zzz" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });

  it("a slashless glob matches at any depth (ripgrep semantics)", async () => {
    write(root, "top.ts", "foo\n");
    write(root, "src/deep/low.ts", "foo\n");
    write(root, "skip.js", "foo\n");
    const r = await callTool("grep", { pattern: "foo", glob: "*.ts" }, config);
    expect(r.text.split("\n").sort()).toEqual(["src/deep/low.ts", "top.ts"]);
  });

  it("errors not_found for a missing search path", async () => {
    const r = await callTool("grep", { pattern: "x", path: "nope" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it("errors invalid_input for a bad regex", async () => {
    const r = await callTool("grep", { pattern: "(" }, config);
    expect(r.json.error).toBe("invalid_input");
  });

  it.skipIf(!rgAvailable)(
    "ripgrep surfaces a regex invalid in both engines as invalid_input (BUG-06)",
    async () => {
      const r = await callTool(
        "grep",
        { pattern: "(", path: "a.txt" },
        makeConfig(root, { ripgrepAvailable: true }),
      );
      expect(r.json.error).toBe("invalid_input");
    },
  );

  it.skipIf(!rgAvailable)(
    "accepts a ripgrep-valid pattern that the V8 RegExp engine rejects (finding 1.1)",
    async () => {
      const r = await callTool(
        "grep",
        { pattern: "(?P<w>foo)", path: "a.txt", output_mode: "content" },
        makeConfig(root, { ripgrepAvailable: true }),
      );
      expect(r.isError).toBe(false);
      expect(r.text).toBe("a.txt:1:foo\na.txt:3:foo baz");
    },
  );

  it("skips files larger than maxFileBytes in the in-process engine (finding 5.1)", async () => {
    write(root, "huge.txt", "foo\n".repeat(1000));
    const r = await callTool(
      "grep",
      { pattern: "foo" },
      makeConfig(root, { ripgrepAvailable: false, maxFileBytes: 1024 }),
    );
    expect(r.text.split("\n")).not.toContain("huge.txt");
    expect(r.text.split("\n")).toContain("a.txt");
  });

  it("warns the scan was incomplete when matches exceed the byte budget (finding 5.3)", async () => {
    const small = makeConfig(root, { ripgrepAvailable: false, maxOutputBytes: 200 });
    const lines = Array.from({ length: 200 }, (_, i) => `match line ${i}`).join("\n");
    write(root, "big.txt", lines + "\n");
    const r = await callTool("grep", { pattern: "match", output_mode: "content" }, small);
    expect(r.text).toContain("[... search incomplete");
    expect(r.text).not.toContain("call again with offset");
  });

  it("ignores out-of-schema extra fields", async () => {
    const r = await callTool("grep", { pattern: "foo", bogus: 1 }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("a.txt");
  });
});

describe("grep single-file target pre-scan (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false });
  });
  afterEach(() => cleanup(root));

  it("returns no matches for a binary file target", async () => {
    writeBinary(root, "blob.bin");
    const r = await callTool(
      "grep",
      { pattern: "a", path: "blob.bin", output_mode: "content" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });

  it("searches a text file target", async () => {
    write(root, "hello.txt", "needle here\nother\n");
    const r = await callTool(
      "grep",
      { pattern: "needle", path: "hello.txt", output_mode: "content" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("hello.txt:1:needle here");
  });

  it("skips a file target larger than maxFileBytes", async () => {
    write(root, "big.txt", `needle ${"a".repeat(4096)}\n`);
    const small = makeConfig(root, { ripgrepAvailable: false, maxFileBytes: 1024 });
    const r = await callTool(
      "grep",
      { pattern: "needle", path: "big.txt", output_mode: "content" },
      small,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });

  it.skipIf(mkfifo === undefined)("skips a FIFO file target without opening it", async () => {
    const fifo = path.join(root, "input.pipe");
    const created = spawnSync(mkfifo!, [fifo], { stdio: "ignore" });
    expect(created.status).toBe(0);

    const r = await callTool(
      "grep",
      { pattern: "needle", path: "input.pipe", output_mode: "content" },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });

  it.skipIf(!modeBitsEnforced)(
    "swallows a read error on the file target and yields no matches",
    async () => {
      write(root, "locked.txt", "needle here\n");
      chmod(root, "locked.txt", 0o000);
      const r = await callTool(
        "grep",
        { pattern: "needle", path: "locked.txt", output_mode: "content" },
        config,
      );
      expect(r.isError).toBe(false);
      expect(r.text).toBe("(no matches)");
      chmod(root, "locked.txt", 0o600);
    },
  );
});

describe("grep across multiple files (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false });
  });
  afterEach(() => cleanup(root));

  it("tallies matches per file and lists files in sorted order", async () => {
    write(root, "a.txt", "foo\nfoo\n");
    write(root, "b.txt", "foo\n");

    const r = await callTool("grep", { pattern: "foo", output_mode: "count" }, config);

    expect(r.isError).toBe(false);
    expect(r.text).toBe("a.txt:2\nb.txt:1");
    expect(r.text).not.toContain("(no matches)");
  });

  it("paginates per-file counts with head_limit and footers the remainder", async () => {
    write(root, "a.txt", "hit\n");
    write(root, "b.txt", "hit\n");
    write(root, "c.txt", "hit\n");

    const r = await callTool(
      "grep",
      { pattern: "hit", output_mode: "count", head_limit: 2 },
      config,
    );

    expect(r.isError).toBe(false);
    expect(r.text.split("\n").slice(0, 2)).toEqual(["a.txt:1", "b.txt:1"]);
    expect(r.text).toContain("showing 0..2 of 3");
    expect(r.text).toContain("offset=2");
  });

  it("content mode with context inserts a -- separator when the file changes", async () => {
    write(root, "a.txt", "pre\nMATCH\npost\n");
    write(root, "b.txt", "before\nMATCH\nafter\n");

    const r = await callTool(
      "grep",
      { pattern: "MATCH", output_mode: "content", context: 1 },
      config,
    );

    expect(r.isError).toBe(false);
    expect(r.text).toBe(
      [
        "a.txt-1-pre",
        "a.txt:2:MATCH",
        "a.txt-3-post",
        "--",
        "b.txt-1-before",
        "b.txt:2:MATCH",
        "b.txt-3-after",
      ].join("\n"),
    );
    expect(r.text.split("\n").filter((l) => l === "--")).toHaveLength(1);
    expect(r.text.startsWith("--")).toBe(false);
    expect(r.text.endsWith("--")).toBe(false);
  });
});

describe("grep asymmetric context and pagination (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false });
  });
  afterEach(() => cleanup(root));

  it("after_context emits only trailing context (-A)", async () => {
    write(root, "ctx.txt", "L1\nMATCH\nL3\nL4\nL5\n");
    const r = await callTool(
      "grep",
      { pattern: "MATCH", output_mode: "content", after_context: 2 },
      config,
    );
    expect(r.text).toBe("ctx.txt:2:MATCH\nctx.txt-3-L3\nctx.txt-4-L4");
  });

  it("before_context emits only leading context (-B)", async () => {
    write(root, "ctx.txt", "L1\nL2\nMATCH\nL4\n");
    const r = await callTool(
      "grep",
      { pattern: "MATCH", output_mode: "content", before_context: 2 },
      config,
    );
    expect(r.text).toBe("ctx.txt-1-L1\nctx.txt-2-L2\nctx.txt:3:MATCH");
  });

  it("inserts -- separators with asymmetric context (before=0)", async () => {
    write(
      root,
      "gap.txt",
      ["a", "HIT", "c", "d", "e", "f", "g", "h", "HIT", "j"].join("\n") + "\n",
    );
    const r = await callTool(
      "grep",
      { pattern: "HIT", output_mode: "content", after_context: 1 },
      config,
    );
    expect(r.text).toBe("gap.txt:2:HIT\ngap.txt-3-c\n--\ngap.txt:9:HIT\ngap.txt-10-j");
  });

  it("after_context overrides context for the after side (precedence)", async () => {
    write(root, "p.txt", "b2\nb1\nMATCH\na1\na2\na3\n");
    const r = await callTool(
      "grep",
      { pattern: "MATCH", output_mode: "content", context: 2, after_context: 1 },
      config,
    );
    expect(r.text).toBe("p.txt-1-b2\np.txt-2-b1\np.txt:3:MATCH\np.txt-4-a1");
  });

  it.skipIf(!rgAvailable)("rg and JS agree on asymmetric context", async () => {
    write(root, "par.txt", "x1\nx2\nFOO\nx4\nx5\nx6\n");
    const params = {
      pattern: "FOO",
      output_mode: "content" as const,
      before_context: 1,
      after_context: 2,
    };
    const a = await callTool(
      "grep",
      params,
      makeConfig(root, { ripgrepAvailable: true, confineToWorkspace: false }),
    );
    const b = await callTool("grep", params, makeConfig(root, { ripgrepAvailable: false }));
    expect(a.text).toBe(b.text);
  });

  it("emits a bare single-line match when no context is requested", async () => {
    write(root, "p.txt", "one\nneedle\nthree\n");
    const r = await callTool("grep", { pattern: "needle", output_mode: "content" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("p.txt:2:needle");
  });

  it("surrounds a single-line match with symmetric context", async () => {
    write(root, "c.txt", "l1\nl2\nneedle\nl4\nl5\n");
    const r = await callTool(
      "grep",
      { pattern: "needle", output_mode: "content", context: 1 },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("c.txt-2-l2\nc.txt:3:needle\nc.txt-4-l4");
  });

  it("head_limit caps content matches and footers the remainder", async () => {
    write(root, "many.txt", Array.from({ length: 5 }, (_, i) => `hit ${i}`).join("\n") + "\n");
    const r = await callTool(
      "grep",
      { pattern: "hit", output_mode: "content", head_limit: 3 },
      config,
    );
    expect(r.text.split("\n").slice(0, 3)).toEqual([
      "many.txt:1:hit 0",
      "many.txt:2:hit 1",
      "many.txt:3:hit 2",
    ]);
    expect(r.text).toContain("showing 0..3 of 5");
    expect(r.text).toContain("offset=3");
  });

  it("pagination unit is matches, independent of context settings", async () => {
    write(
      root,
      "many.txt",
      Array.from({ length: 5 }, (_, i) => `hit ${i}\nx\nx`).join("\n") + "\n",
    );
    const matchLines = (t: string) => t.split("\n").filter((l) => /^many\.txt:\d+:/.test(l));
    const plain = await callTool(
      "grep",
      { pattern: "hit", output_mode: "content", head_limit: 2 },
      config,
    );
    const ctx = await callTool(
      "grep",
      { pattern: "hit", output_mode: "content", head_limit: 2, context: 1 },
      config,
    );
    expect(matchLines(plain.text)).toEqual(["many.txt:1:hit 0", "many.txt:4:hit 1"]);
    expect(matchLines(ctx.text)).toEqual(["many.txt:1:hit 0", "many.txt:4:hit 1"]);
  });

  it("paginates files_with_matches into disjoint pages", async () => {
    for (const n of ["f1", "f2", "f3", "f4", "f5"]) write(root, `${n}.txt`, "needle\n");
    const page1 = await callTool("grep", { pattern: "needle", head_limit: 2, offset: 0 }, config);
    const page2 = await callTool("grep", { pattern: "needle", head_limit: 2, offset: 2 }, config);
    expect(page1.text.split("\n").slice(0, 2)).toEqual(["f1.txt", "f2.txt"]);
    expect(page1.text).toContain("showing 0..2 of 5");
    expect(page2.text.split("\n").slice(0, 2)).toEqual(["f3.txt", "f4.txt"]);
    expect(page2.text).toContain("showing 2..4 of 5");
  });

  it("reports a void page when offset is past the end (complete scan)", async () => {
    write(root, "one.txt", "foo\n");
    const r = await callTool("grep", { pattern: "foo", output_mode: "count", offset: 50 }, config);
    expect(r.text).toBe("(no results at offset 50; 1 total)");
  });

  it("treats head_limit 0 as unlimited (no rejection)", async () => {
    write(root, "one.txt", "foo\n");
    const r = await callTool("grep", { pattern: "foo", head_limit: 0 }, config);
    expect(r.isError).toBe(false);
  });
});

describe("grep byte-cap page limits (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false, maxOutputBytes: 300 });
  });
  afterEach(() => cleanup(root));

  it("warns the page was cut when the full result set overflows the byte cap without truncating the scan", async () => {
    const lines = Array.from({ length: 120 }, () => "x").join("\n") + "\n";
    write(root, "f.txt", lines);

    const r = await callTool("grep", { pattern: "x", output_mode: "content" }, config);

    expect(r.isError).toBe(false);
    expect(r.text).toContain("[... page exceeded 300 bytes and was cut");
    expect(r.text).toContain("set or reduce head_limit to page in smaller chunks");
    expect(r.text).not.toContain("[... search incomplete");
    expect(r.text).not.toContain("call again with offset");
  });

  it("still warns 'page exceeded' when head_limit is set but the page itself is too big", async () => {
    const lines = Array.from({ length: 120 }, () => "y").join("\n") + "\n";
    write(root, "big.txt", lines);

    const r = await callTool(
      "grep",
      { pattern: "y", output_mode: "content", head_limit: 100 },
      config,
    );

    expect(r.isError).toBe(false);
    expect(r.text).toContain("[... page exceeded 300 bytes and was cut");
    expect(r.text).not.toContain("[... search incomplete");
    expect(r.text).not.toContain("call again with offset");
  });

  it("does NOT warn when the page fits: a byte-bounded page under the cap returns cleanly", async () => {
    write(root, "small.txt", "hit\n");

    const r = await callTool("grep", { pattern: "hit", output_mode: "content" }, config);

    expect(r.isError).toBe(false);
    expect(r.text).toBe("small.txt:1:hit");
    expect(r.text).not.toContain("[... page exceeded");
  });

  it("stops scanning further files once the byte budget is exhausted", async () => {
    const tiny = makeConfig(root, { ripgrepAvailable: false, maxOutputBytes: 1 });
    write(root, "a.txt", "needle here\n");
    write(root, "b.txt", "needle also\n");
    const r = await callTool("grep", { pattern: "needle", output_mode: "content" }, tiny);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("search incomplete");
  });
});

describe("grep multiline (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false });
  });
  afterEach(() => cleanup(root));

  it("matches across a line boundary", async () => {
    write(root, "ml.txt", "a\nb\nc\n");
    const r = await callTool(
      "grep",
      { pattern: "a\\nb", output_mode: "content", multiline: true },
      config,
    );
    expect(r.text).toBe("ml.txt:1:a\nb");
  });

  it("dotall lets . cross newlines (and a per-line search does not)", async () => {
    write(root, "ml.txt", "start\nmid\nend\n");
    const on = await callTool(
      "grep",
      { pattern: "start.*end", output_mode: "content", multiline: true },
      config,
    );
    expect(on.text).toBe("ml.txt:1:start\nmid\nend");
    const off = await callTool("grep", { pattern: "start.*end", output_mode: "content" }, config);
    expect(off.text).toBe("(no matches)");
  });

  it("counts a multi-line match as a single unit", async () => {
    write(root, "ml.txt", "foobar\nbazqux\n");
    const r = await callTool(
      "grep",
      { pattern: "bar\\nbaz", output_mode: "count", multiline: true },
      config,
    );
    expect(r.text).toBe("ml.txt:1");
  });

  it("emits after-context measured from the block end (no spurious --)", async () => {
    write(root, "ml.txt", "A\nx1\nB\nx2\n");
    const r = await callTool(
      "grep",
      { pattern: "A\\nx1\\nB", output_mode: "content", multiline: true, after_context: 1 },
      config,
    );
    expect(r.text).toBe("ml.txt:1:A\nx1\nB\nml.txt-4-x2");
  });

  it("emits before-context for a multi-line match", async () => {
    write(root, "ml.txt", "z\nA\nB\n");
    const r = await callTool(
      "grep",
      { pattern: "A\\nB", output_mode: "content", multiline: true, before_context: 1 },
      config,
    );
    expect(r.text).toBe("ml.txt-1-z\nml.txt:2:A\nB");
  });

  it("honors ^/$ as line anchors in multiline mode", async () => {
    write(root, "ml.txt", "foo\nbar\n");
    const r = await callTool(
      "grep",
      { pattern: "^foo$\\n^bar$", output_mode: "content", multiline: true },
      config,
    );
    expect(r.text).toBe("ml.txt:1:foo\nbar");
  });

  it("coalesces a multi-line span with adjacent single-line matches into one block", async () => {
    write(root, "ml.txt", "a\nb\nZ\nZ\n");
    const content = await callTool(
      "grep",
      { pattern: "a\\nb|Z", output_mode: "content", multiline: true },
      config,
    );
    expect(content.text).toBe("ml.txt:1:a\nb\nZ\nZ");
    const count = await callTool(
      "grep",
      { pattern: "a\\nb|Z", output_mode: "count", multiline: true },
      config,
    );
    expect(count.text).toBe("ml.txt:1");
  });

  it("does not coalesce a run of only single-line matches (count parity with per-line)", async () => {
    write(root, "ml.txt", "X\nX\nX\n");
    const r = await callTool(
      "grep",
      { pattern: "X", output_mode: "count", multiline: true },
      config,
    );
    expect(r.text).toBe("ml.txt:3");
  });

  it("paginates multi-line matches by block", async () => {
    write(root, "ml.txt", "A\nB\nx\nA\nB\n");
    const r = await callTool(
      "grep",
      { pattern: "A\\nB", output_mode: "content", multiline: true, head_limit: 1 },
      config,
    );
    expect(r.text).toContain("ml.txt:1:A\nB");
    expect(r.text).toContain("showing 0..1 of 2");
    expect(r.text).toContain("offset=1");
  });

  it("matches case-insensitively across a line boundary (multiline + ignore_case)", async () => {
    write(root, "ml.txt", "ALPHA\nBETA\ngamma\n");
    const r = await callTool(
      "grep",
      { pattern: "alpha\\nbeta", output_mode: "content", multiline: true, ignore_case: true },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("ml.txt:1:ALPHA\nBETA");
  });

  it("ignores a zero-width multiline match", async () => {
    write(root, "z.txt", "abc\ndef\n");
    const r = await callTool(
      "grep",
      { pattern: "q*", output_mode: "content", multiline: true },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)");
  });

  it("clamps before-context at the first line and still emits after-context for a multi-line match", async () => {
    write(root, "m1.txt", "ALPHA\nBETA\ntail\n");
    const r = await callTool(
      "grep",
      {
        pattern: "ALPHA\\nBETA",
        output_mode: "content",
        multiline: true,
        before_context: 1,
        after_context: 1,
      },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("m1.txt:1:ALPHA\nBETA");
    expect(r.text).toContain("m1.txt-3-tail");
  });

  it("clamps after-context at the last line and still emits before-context for a multi-line match", async () => {
    write(root, "m2.txt", "head\nALPHA\nBETA\n");
    const r = await callTool(
      "grep",
      {
        pattern: "ALPHA\\nBETA",
        output_mode: "content",
        multiline: true,
        before_context: 1,
        after_context: 1,
      },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toContain("m2.txt-1-head");
    expect(r.text).toContain("m2.txt:2:ALPHA\nBETA");
  });

  it("reports a dotall match spanning three lines as a single block", async () => {
    write(root, "span.txt", "START x\nmid\ny END\n");
    const r = await callTool(
      "grep",
      { pattern: "START.*END", output_mode: "content", multiline: true },
      config,
    );
    expect(r.isError).toBe(false);
    expect(r.text).toBe("span.txt:1:START x\nmid\ny END");
  });

  it("rejects a non-boolean multiline with invalid_input", async () => {
    write(root, "ml.txt", "a\nb\n");
    const r = await callTool("grep", { pattern: "a", multiline: "yes" }, config);
    expect(r.json.error).toBe("invalid_input");
  });
});

describe("grep hidden files and .gitignore scope (in-process)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root, { ripgrepAvailable: false });
  });
  afterEach(() => cleanup(root));

  it("searches hidden files but never the .git directory", async () => {
    write(root, ".env", "foo\n");
    write(root, ".git/config", "foo\n");
    write(root, "visible.txt", "foo\n");
    const r = await callTool("grep", { pattern: "foo" }, config);
    expect(r.text.split("\n").sort()).toEqual([".env", "visible.txt"]);
  });

  it("skips files matched by a nested .gitignore", async () => {
    write(root, "sub/.gitignore", "local.txt\n");
    write(root, "sub/local.txt", "foo\n");
    write(root, "sub/keep.txt", "foo\n");
    const r = await callTool("grep", { pattern: "foo" }, config);
    expect(r.text.split("\n").sort()).toEqual(["sub/keep.txt"]);
  });

  it("skips files matched by a .gitignore above the workspace root (monorepo)", async () => {
    write(root, ".git/HEAD", "ref: refs/heads/main\n");
    write(root, ".gitignore", "ignored-by-root.txt\n");
    const wsRoot = path.join(root, "pkg");
    write(wsRoot, "ignored-by-root.txt", "foo\n");
    write(wsRoot, "visible.txt", "foo\n");
    const wsConfig = makeConfig(wsRoot, { ripgrepAvailable: false });
    const r = await callTool("grep", { pattern: "foo" }, wsConfig);
    expect(r.text.split("\n").sort()).toEqual(["visible.txt"]);
  });

  it("names the file-walk cap as the reason, not the output cap", async () => {
    for (let index = 0; index < 8; index += 1) write(root, `f${String(index)}.txt`, "foo\n");
    const capped = makeConfig(root, { ripgrepAvailable: false, maxTraversalEntries: 2 });
    const r = await callTool("grep", { pattern: "foo" }, capped);
    // The remedy for a capped *walk* is a narrower path; telling the model to
    // narrow its pattern sends it after the one thing that cannot help.
    expect(r.text).toContain("the directory walk hit its entry cap");
    expect(r.text).not.toContain("the scan hit its output cap");
  });

  it("still reports an output cap as an output cap", async () => {
    write(root, "big.txt", `${"foo bar baz ".repeat(400)}\n`.repeat(40));
    const tight = makeConfig(root, { ripgrepAvailable: false, maxOutputBytes: 256 });
    const r = await callTool("grep", { pattern: "foo" }, tight);
    expect(r.text).toContain("the scan hit its output cap");
    expect(r.text).not.toContain("the directory walk hit its entry cap");
  });
});
