import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { makeWorkspace, cleanup, makeConfig, callTool, write } from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

const rgAvailable = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

describe("grep parity CI guard", () => {
  it("ripgrep must be installed in CI (TEST-01)", () => {
    if (process.env.CI) expect(rgAvailable).toBe(true);
  });
});

describe.skipIf(!rgAvailable)("grep ripgrep/in-process parity", () => {
  let root: string;
  let priorCwd: string;

  beforeEach(() => {
    root = makeWorkspace();
    write(root, "a.txt", "foo\nbar\nfoo baz\n");
    write(root, "sub/c.txt", "another foo here\nno match\n");
    write(root, "sub/deep/d.ts", "foo nested\n");
    write(root, "top.ts", "foo top\n");
    write(root, "b.txt", "nothing\n");

    priorCwd = process.cwd();
    process.chdir(tmpdir());
  });
  afterEach(() => {
    process.chdir(priorCwd);
    cleanup(root);
  });

  const withRg = () => makeConfig(root, { ripgrepAvailable: true, confineToWorkspace: false });
  const withoutRg = () => makeConfig(root, { ripgrepAvailable: false, confineToWorkspace: false });
  const norm = (s: string) => s.split("\n").sort();

  for (const mode of ["files_with_matches", "count", "content"] as const) {
    it(`agrees in ${mode} mode`, async () => {
      const a = await callTool("grep", { pattern: "foo", output_mode: mode }, withRg());
      const b = await callTool("grep", { pattern: "foo", output_mode: mode }, withoutRg());
      expect(norm(a.text)).toEqual(norm(b.text));
    });
  }

  for (const glob of ["*.ts", "sub/*.txt", "sub/**/*.ts"]) {
    it(`agrees for glob "${glob}" regardless of process cwd`, async () => {
      const a = await callTool("grep", { pattern: "foo", glob }, withRg());
      const b = await callTool("grep", { pattern: "foo", glob }, withoutRg());
      expect(norm(a.text)).toEqual(norm(b.text));
    });
  }

  // The shared grammar, sampled. `regex-dialect.test.ts` enumerates the rest of
  // the boundary - what only one engine accepts, and what both accept while
  // answering differently.
  for (const pattern of [
    "f.o",
    "\\bfoo\\b",
    "ba[rz]",
    "^foo",
    "foo|another",
    "fo+",
    "(?<w>foo)",
    "(?i:FOO)",
    "(?:fo|ba)r",
    "o{2,3}",
    "f.*?o",
    "[^a-z]",
    "[-a]",
    "[\\]]",
    "\\$\\d",
    "a\\.b",
  ]) {
    it(`agrees on regex metacharacters: ${pattern}`, async () => {
      const a = await callTool("grep", { pattern, output_mode: "content" }, withRg());
      const b = await callTool("grep", { pattern, output_mode: "content" }, withoutRg());
      expect(a.text).toBe(b.text);
    });
  }

  it("agrees with ignore_case", async () => {
    const a = await callTool("grep", { pattern: "FOO", ignore_case: true }, withRg());
    const b = await callTool("grep", { pattern: "FOO", ignore_case: true }, withoutRg());
    expect(norm(a.text)).toEqual(norm(b.text));
  });

  it("agrees with context lines", async () => {
    const a = await callTool(
      "grep",
      { pattern: "foo", output_mode: "content", context: 1 },
      withRg(),
    );
    const b = await callTool(
      "grep",
      { pattern: "foo", output_mode: "content", context: 1 },
      withoutRg(),
    );
    expect(a.text).toBe(b.text);
  });

  it("produces byte-identical content output (deterministic order)", async () => {
    const a = await callTool("grep", { pattern: "foo", output_mode: "content" }, withRg());
    const b = await callTool("grep", { pattern: "foo", output_mode: "content" }, withoutRg());
    expect(a.text).toBe(b.text);
  });

  for (const mode of ["content", "count", "files_with_matches"] as const) {
    it(`agrees on a multiline match in ${mode} mode`, async () => {
      write(root, "ml.txt", "ALPHA\nBETA\nGAMMA\n");
      const params = { pattern: "ALPHA\\nBETA", output_mode: mode, multiline: true };
      const a = await callTool("grep", params, withRg());
      const b = await callTool("grep", params, withoutRg());
      expect(a.text).toBe(b.text);
    });
  }

  it("agrees on multiline with symmetric context", async () => {
    write(root, "ml.txt", "before\nALPHA\nBETA\nafter\n");
    const params = {
      pattern: "ALPHA\\nBETA",
      output_mode: "content" as const,
      multiline: true,
      context: 1,
    };
    const a = await callTool("grep", params, withRg());
    const b = await callTool("grep", params, withoutRg());
    expect(a.text).toBe(b.text);
  });

  it("agrees on multiline with asymmetric context", async () => {
    write(root, "ml.txt", "b2\nb1\nALPHA\nBETA\na1\na2\na3\n");
    const params = {
      pattern: "ALPHA\\nBETA",
      output_mode: "content" as const,
      multiline: true,
      before_context: 1,
      after_context: 2,
    };
    const a = await callTool("grep", params, withRg());
    const b = await callTool("grep", params, withoutRg());
    expect(a.text).toBe(b.text);
  });

  it("agrees on dotall (. crosses newline)", async () => {
    write(root, "ml.txt", "START here\nmiddle\nthe END\n");
    const params = { pattern: "START.*END", output_mode: "content" as const, multiline: true };
    const a = await callTool("grep", params, withRg());
    const b = await callTool("grep", params, withoutRg());
    expect(a.text).toBe(b.text);
  });

  it("agrees on ^/$ line anchors in multiline mode", async () => {
    write(root, "ml.txt", "ONE\nTWO\nthree\n");
    const params = { pattern: "^ONE$\\n^TWO$", output_mode: "content" as const, multiline: true };
    const a = await callTool("grep", params, withRg());
    const b = await callTool("grep", params, withoutRg());
    expect(a.text).toBe(b.text);
  });

  for (const [name, body, pattern] of [
    [
      "a multiline span absorbing adjacent single-line matches",
      "ALPHA\nBETA\nZED\nZED\n",
      "ALPHA\\nBETA|ZED",
    ],
    ["a run broken by a gap", "ALPHA\nGAP\nphi\npsi\n", "ALPHA|phi\\npsi"],
  ] as const) {
    for (const mode of ["content", "count"] as const) {
      it(`agrees on coalescing (${name}) in ${mode} mode`, async () => {
        write(root, "ml.txt", body);
        const params = { pattern, output_mode: mode, multiline: true };
        const a = await callTool("grep", params, withRg());
        const b = await callTool("grep", params, withoutRg());
        expect(a.text).toBe(b.text);
      });
    }
  }

  it("agrees on multiline pagination (head_limit)", async () => {
    write(root, "ml.txt", "ALPHA\nBETA\nx\nALPHA\nBETA\nx\nALPHA\nBETA\n");
    const params = {
      pattern: "ALPHA\\nBETA",
      output_mode: "content" as const,
      multiline: true,
      head_limit: 2,
    };
    const a = await callTool("grep", params, withRg());
    const b = await callTool("grep", params, withoutRg());
    expect(a.text).toBe(b.text);
  });

  it("agrees on skipping files larger than MAX_FILE_BYTES", async () => {
    write(root, "small.txt", "foo here\n");
    write(root, "big.txt", `foo ${"a".repeat(4096)}`);
    const cfgRg = makeConfig(root, {
      ripgrepAvailable: true,
      confineToWorkspace: false,
      maxFileBytes: 1024,
    });
    const cfgJs = makeConfig(root, {
      ripgrepAvailable: false,
      confineToWorkspace: false,
      maxFileBytes: 1024,
    });

    const dirRg = await callTool("grep", { pattern: "foo" }, cfgRg);
    const dirJs = await callTool("grep", { pattern: "foo" }, cfgJs);
    expect(norm(dirRg.text)).toEqual(norm(dirJs.text));
    expect(dirRg.text).toContain("small.txt");
    expect(dirRg.text).not.toContain("big.txt");

    const fileRg = await callTool("grep", { pattern: "foo", path: "big.txt" }, cfgRg);
    const fileJs = await callTool("grep", { pattern: "foo", path: "big.txt" }, cfgJs);
    expect(fileRg.text).toBe("(no matches)");
    expect(fileJs.text).toBe("(no matches)");
  });

  it("agrees on hidden files, .git, and nested/parent .gitignore", async () => {
    write(root, ".git/HEAD", "ref: refs/heads/main\n");
    write(root, ".gitignore", "ignored-root.txt\n");
    write(root, ".env", "foo secret\n");
    write(root, ".github/workflows/ci.yml", "foo step\n");
    write(root, ".git/config", "foo in git\n");
    write(root, "ignored-root.txt", "foo\n");
    write(root, "sub/.gitignore", "nested-ignored.txt\n");
    write(root, "sub/nested-ignored.txt", "foo\n");
    write(root, "sub/kept.txt", "foo\n");

    const a = await callTool("grep", { pattern: "foo" }, withRg());
    const b = await callTool("grep", { pattern: "foo" }, withoutRg());
    expect(norm(a.text)).toEqual(norm(b.text));
    expect(a.text.split("\n")).toContain(".env");
    expect(a.text).not.toContain("ignored-root.txt");
    expect(a.text).not.toContain("nested-ignored.txt");
    expect(a.text).not.toContain(".git/config");
  });
});

// Which engine runs is not a caller-visible parameter, but it is caller-
// CONTROLLED: `packages/tools/src/lib/rg.ts` sends a confined directory to the
// in-process JavaScript scanner and everything else to ripgrep. Under the
// production defaults (`ripgrepAvailable: true`, `confineToWorkspace: true`)
// that makes the `path` argument alone decide which regex grammar a pattern is
// read in. These two tests pin that reach; `regex-dialect.test.ts` enumerates
// what the two grammars disagree about.
describe("the engine choice reaches the regex dialect", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
    write(root, "s.txt", "foobar\nAfoo\n");
  });
  afterEach(() => cleanup(root));

  const grep = async (config: ServerConfig, extra: Record<string, unknown> = {}) =>
    callTool("grep", { pattern: "\\Afoo", output_mode: "content", ...extra }, config);

  it("with no ripgrep there is one engine, so `path` cannot change the answer", async () => {
    const config = makeConfig(root, { ripgrepAvailable: false, confineToWorkspace: true });
    const dir = await grep(config);
    const file = await grep(config, { path: "s.txt" });
    expect(dir.text).toBe("s.txt:2:Afoo");
    expect(file.text).toBe(dir.text);
  });

  it.skipIf(!rgAvailable)(
    "under production defaults `path` alone selects the dialect (\\A: literal vs anchor)",
    async () => {
      const config = makeConfig(root, { ripgrepAvailable: true, confineToWorkspace: true });
      const dir = await grep(config);
      const file = await grep(config, { path: "s.txt" });
      expect(dir.text).toBe("s.txt:2:Afoo");
      expect(file.text).toBe("s.txt:1:foobar");
      expect(file.text).not.toBe(dir.text);
    },
  );

  it.skipIf(!rgAvailable)(
    "under production defaults `path` alone decides whether a pattern is refused",
    async () => {
      const config = makeConfig(root, { ripgrepAvailable: true, confineToWorkspace: true });
      const dirOnly = await callTool(
        "grep",
        { pattern: "foo(?=bar)", output_mode: "content" },
        config,
      );
      const fileOnly = await callTool(
        "grep",
        { pattern: "foo(?=bar)", output_mode: "content", path: "s.txt" },
        config,
      );
      expect(dirOnly.isError).toBe(false);
      expect(dirOnly.text).toBe("s.txt:1:foobar");
      expect(fileOnly.isError).toBe(true);
      expect((fileOnly.json as { error?: string }).error).toBe("invalid_input");

      const rgOnly = await callTool(
        "grep",
        { pattern: "(?P<w>foo)", output_mode: "content" },
        config,
      );
      const rgOnlyFile = await callTool(
        "grep",
        { pattern: "(?P<w>foo)", output_mode: "content", path: "s.txt" },
        config,
      );
      expect(rgOnly.isError).toBe(true);
      expect((rgOnly.json as { error?: string }).error).toBe("invalid_input");
      expect(rgOnlyFile.isError).toBe(false);
      expect(rgOnlyFile.text).toBe("s.txt:1:foobar\ns.txt:2:Afoo");
    },
  );
});
