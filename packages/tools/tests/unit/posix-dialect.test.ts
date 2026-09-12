import { describe, expect, it } from "bun:test";
import { analyzeShell } from "../../src/guard/analyze-shell.ts";
import { POSIX_DEFAULT_ALLOWED_COMMANDS, posixDialect } from "../../src/guard/dialects/posix.ts";
import type { ShellFacts } from "../../src/guard/types.ts";

// Pins these cases to the POSIX dialect explicitly: they assert `sh` semantics
// and must not follow whatever shell the host running the suite happens to use.
const analyzeBash = (command: string): ShellFacts => analyzeShell(command, posixDialect);

const norm = (command: string): string[] => analyzeBash(command).segments.map((s) => s.normalized);

describe("analyzeBash — undecidable / opaque constructs", () => {
  it("flags command substitution, backticks, encoding-to-shell, eval, env expansion", () => {
    expect(analyzeBash("echo $(whoami)").undecidable).toBe(true);
    expect(analyzeBash("cat `ls`").undecidable).toBe(true);
    expect(analyzeBash("x | base64 -d | sh").undecidable).toBe(true);
    expect(analyzeBash("eval rm").undecidable).toBe(true);
    expect(analyzeBash("rm $HOME/x").undecidable).toBe(true);
    expect(analyzeBash("env FOO=bar ls").undecidable).toBe(true);
    expect(analyzeBash("cat <(echo x)").undecidable).toBe(true);
  });

  it("distinguishes single quotes (safe) from double quotes (expand)", () => {
    expect(analyzeBash("sed -n '/x/,$p'").undecidable).toBe(false);
    expect(analyzeBash("awk '{print $1}' file.txt").undecidable).toBe(false);
    expect(analyzeBash('echo "$HOME"').undecidable).toBe(true);
  });

  it("flags unbalanced quotes / parens and nested substitution", () => {
    expect(analyzeBash("echo 'unterminated").undecidable).toBe(true);
    expect(analyzeBash("echo (").undecidable).toBe(true);
    expect(analyzeBash("echo 'x").undecidable).toBe(true);
    expect(analyzeBash("echo $(echo $(whoami))").undecidable).toBe(true);
  });

  it("does not leak inner paths of an opaque command", () => {
    const a = analyzeBash("echo $(cat /etc/passwd)");
    expect(a.undecidable).toBe(true);
    expect(a.paths).not.toContain("/etc/passwd");
  });
});

describe("analyzeBash — command segmentation", () => {
  it("splits pipelines and and-lists, keeps paths from every segment", () => {
    expect(norm("cat a.txt | grep x")).toEqual(["cat a.txt", "grep x"]);
    const a = analyzeBash("cd src && cat src/a.ts");
    expect(a.segments).toHaveLength(2);
    expect(a.paths).toContain("src/a.ts");
  });

  it("treats redirect ampersands as non-separators, trailing & as a separator", () => {
    expect(norm("echo ok 2>&1 | cat")).toEqual(["echo ok 2>&1", "cat"]);
    const b = analyzeBash("sleep 1 &");
    expect(b.segments.map((s) => s.normalized)).toEqual(["sleep 1"]);
    expect(b.undecidable).toBe(false);
  });

  it("does not split inside quotes or subshells", () => {
    expect(analyzeBash("echo 'a | b'").segments).toHaveLength(1);
    const c = analyzeBash("echo $(a && b)");
    expect(c.segments).toHaveLength(1);
    expect(c.undecidable).toBe(true);
  });

  it("normalizes whitespace", () => {
    expect(norm("ls   -la ")).toEqual(["ls -la"]);
  });
});

describe("analyzeBash — wrapper / env stripping", () => {
  it("strips env assignments and safe wrappers from normalized commands", () => {
    expect(norm("FOO=bar ls -la")).toEqual(["ls -la"]);
    expect(norm("timeout 5 ls -la")).toEqual(["ls -la"]);
    expect(norm("nohup nice node app.js")).toEqual(["node app.js"]);
    expect(norm("timeout -k 5 ls -la")).toEqual(["ls -la"]);
    expect(norm("stdbuf -oL FOO=bar ls")).toEqual(["ls"]);
  });

  it("records the stripped env assignments so approvals can key on them", () => {
    const injected = analyzeBash("LD_PRELOAD=./evil.so bun test").segments[0]!;
    expect(injected.normalized).toBe("bun test");
    expect(injected.envAssignments).toEqual(["LD_PRELOAD=./evil.so"]);
    expect(analyzeBash("stdbuf -oL FOO=bar ls").segments[0]!.envAssignments).toEqual(["FOO=bar"]);
    expect(analyzeBash("bun test").segments[0]!.envAssignments).toEqual([]);
  });
});

describe("analyzeBash — path extraction", () => {
  it("keeps path-like operands, rejects metachar operands", () => {
    const a = analyzeBash("cat src/a.ts ./b.txt");
    expect(a.undecidable).toBe(false);
    expect(a.paths).toContain("src/a.ts");
    expect(a.paths).toContain("./b.txt");

    const b = analyzeBash("sed -n '/----------/,$p' file.log");
    expect(b.paths).not.toContain("/----------/,$p");
    expect(b.paths).toContain("file.log");

    expect(analyzeBash("cat '/etc/passwd'").paths).toContain("/etc/passwd");
    expect(analyzeBash("cd ..").paths).toContain("..");

    const w = analyzeBash("awk '{print $1}' file.txt");
    expect(w.paths).not.toContain(".");
    expect(w.paths).toContain("file.txt");
  });

  it("reduces globs to their literal directory prefix", () => {
    expect(analyzeBash("cat /etc/pass*").undecidable).toBe(false);
    expect(analyzeBash("cat /etc/pass*").paths).toContain("/etc");
    expect(analyzeBash("cat /etc/{passwd,shadow}").paths).toContain("/etc");
    expect(analyzeBash("cat /etc/passw?").paths).toContain("/etc");
    const g = analyzeBash("cat src/*.ts");
    expect(g.undecidable).toBe(false);
    expect(g.paths).toContain("src");
  });

  it("flags upward-traversing globs and unknown users as undecidable", () => {
    expect(analyzeBash("cat */../../etc/passwd").undecidable).toBe(true);
    expect(analyzeBash("cat ~root/.bashrc").undecidable).toBe(true);
  });

  it("treats literal subshells as transparent for path extraction", () => {
    const s = analyzeBash("(cat /etc/passwd)");
    expect(s.undecidable).toBe(false);
    expect(s.paths).toContain("/etc/passwd");
    expect(analyzeBash("(cd src && cat a.ts)").paths).toContain("a.ts");
  });

  it("does not treat test-builtin brackets as a glob of the working directory", () => {
    const facts = analyzeBash("if [ -r file ]; then echo ok; fi");
    expect(facts.undecidable).toBe(false);
    expect(facts.paths).not.toContain(".");
  });

  it("keeps ~/ as a decidable path token", () => {
    const a = analyzeBash("cat ~/.ssh/id_rsa");
    expect(a.undecidable).toBe(false);
    expect(a.paths).toContain("~/.ssh/id_rsa");
  });

  it("extracts redirect targets whether glued to the operator or spaced", () => {
    expect(analyzeBash("echo pwned >/etc/cron.d/x").paths).toContain("/etc/cron.d/x");
    expect(analyzeBash("echo pwned >>/etc/cron.d/x").paths).toContain("/etc/cron.d/x");
    expect(analyzeBash("echo hi 2>/tmp/err").paths).toContain("/tmp/err");
    expect(analyzeBash("echo hi &>/tmp/out").paths).toContain("/tmp/out");
    expect(analyzeBash("cat </etc/passwd").paths).toContain("/etc/passwd");
    const spaced = analyzeBash("echo pwned > /etc/cron.d/x");
    expect(spaced.paths).toContain("/etc/cron.d/x");
    expect(spaced.paths).not.toContain(">");
    expect(analyzeBash("echo hi >out.txt").paths).toContain("out.txt");
    expect(analyzeBash("echo hi >&2").paths).not.toContain("&2");
  });

  it("does not treat the POSIX null device as an outside-workspace operand", () => {
    expect(analyzeBash("command >/dev/null 2>&1 || true").paths).not.toContain("/dev/null");
    expect(analyzeBash("command > /dev/null 2>&1 || true").paths).not.toContain("/dev/null");
  });
});

describe("analyzeBash — empty input", () => {
  it("returns no segments and is decidable", () => {
    const a = analyzeBash("");
    expect(a.segments).toHaveLength(0);
    expect(a.paths).toHaveLength(0);
    expect(a.undecidable).toBe(false);
  });
});

describe("analyzeBash — sequential literal assignments", () => {
  it("inlines $NAME and ${NAME} after a NAME=value segment", () => {
    const a = analyzeBash('QA=/tmp/foo; sha256sum "$QA/provider.ts"');
    expect(a.undecidable).toBe(false);
    expect(a.segments.map((s) => s.normalized)).toEqual(["", "sha256sum /tmp/foo/provider.ts"]);
    expect(a.paths).toContain("/tmp/foo/provider.ts");

    const b = analyzeBash("A=/tmp; B=$A; echo $B");
    expect(b.undecidable).toBe(false);
    expect(b.segments.at(-1)!.normalized).toBe("echo /tmp");
  });

  it("does not inline across a pipeline and does not expand single-quoted dollars", () => {
    expect(analyzeBash('QA=/tmp/foo | sha256sum "$QA/x"').undecidable).toBe(true);
    expect(analyzeBash("QA=/tmp/foo; echo '$QA'").undecidable).toBe(false);
    expect(analyzeBash("QA=/tmp/foo; echo '$QA'").segments.at(-1)!.normalized).toBe("echo $QA");
    expect(analyzeBash('git commit -m "$MSG"').undecidable).toBe(true);
  });
});

/**
 * The seeded allow list is written into a user's settings and then spares every
 * matching command an approval prompt. An entry the analyzer cannot decide, or
 * one that normalizes to something other than itself, would either never fire or
 * — worse — fire for a command the operator never meant to approve.
 */
describe("POSIX_DEFAULT_ALLOWED_COMMANDS", () => {
  it("fits the settings bound and contains no duplicate policy entries", () => {
    expect(POSIX_DEFAULT_ALLOWED_COMMANDS.length).toBeLessThanOrEqual(256);
    expect(new Set(POSIX_DEFAULT_ALLOWED_COMMANDS).size).toBe(
      POSIX_DEFAULT_ALLOWED_COMMANDS.length,
    );
  });

  it("is entirely decidable: every entry analyzes statically", () => {
    for (const entry of POSIX_DEFAULT_ALLOWED_COMMANDS) {
      const facts = analyzeBash(entry);
      expect({ entry, undecidable: facts.undecidable }).toEqual({ entry, undecidable: false });
    }
  });

  it("matches itself: every entry normalizes to exactly the text seeded", () => {
    for (const entry of POSIX_DEFAULT_ALLOWED_COMMANDS) {
      expect({ entry, normalized: norm(entry) }).toEqual({ entry, normalized: [entry] });
    }
  });

  it("names a subcommand wherever the bare binary would over-grant", () => {
    // The guard matches a space-boundary prefix, so a bare `git` entry would
    // allow `git push --force`. Anything multi-word here must stay multi-word.
    for (const entry of POSIX_DEFAULT_ALLOWED_COMMANDS) {
      if (entry.startsWith("git")) expect(entry.split(" ").length).toBeGreaterThan(1);
    }
  });

  it("covers conventional validation commands across common ecosystems", () => {
    for (const command of [
      "bun test",
      "deno check",
      "python -m pytest",
      "cargo clippy",
      "go vet",
      "mvn verify",
      "dotnet test",
      "cmake --build",
      "rspec",
      "composer test",
      "swift test",
      "mix test",
      "dart analyze",
      "zig build",
      "cabal test",
      "shellcheck",
    ]) {
      expect(POSIX_DEFAULT_ALLOWED_COMMANDS).toContain(command);
    }
  });

  it("omits the commands that execute arbitrary code behind a safe-looking name", () => {
    // Each of these was a candidate and was cut on purpose; see the constant's
    // TSDoc. A regression that re-adds one should fail loudly here.
    for (const forbidden of [
      "make",
      "find",
      "awk",
      "sed -n",
      "sed",
      "xargs",
      "env",
      "node",
      "python",
      "npx",
      "bunx",
      "npm install",
      "cargo publish",
      "dotnet publish",
    ]) {
      expect(POSIX_DEFAULT_ALLOWED_COMMANDS).not.toContain(forbidden);
    }
  });
});

/**
 * The command-name patterns name *commands*, and a bare `\bword\b` does not.
 * `\benv\b` matched the `env` inside `.env` because a word boundary sits after
 * the dot, so `cat .env` was undecidable. That was noise while undecidable meant
 * "ask"; it became a wrong refusal once an unanalyzable command with a deny list
 * configured started being denied outright.
 */
describe("analyzeBash — command names are matched in command position only", () => {
  it("does not flag a filename that merely contains a command name", () => {
    for (const command of [
      "cat .env",
      "cat .env.local",
      "cat source.txt",
      "cat exec.log",
      "cat my/env.json",
      "cat base64.py",
      "rm xargs.tmp",
      "cat source",
      "ls env",
      "echo eval",
      "git add source",
      "rm exec",
      "cat foo/env",
      "npm run env",
    ]) {
      expect({ command, undecidable: analyzeBash(command).undecidable }).toEqual({
        command,
        undecidable: false,
      });
    }
  });

  it("still flags the command itself, with or without a directory prefix", () => {
    for (const command of [
      "env FOO=bar ls",
      "/usr/bin/env FOO=1 sh",
      'eval "$X"',
      "sh -c ls",
      "/bin/sh -c ls",
      "x | base64 -d | sh",
      "source ./setup",
      // `splitByOperators` does not split inside parentheses, so a subshell
      // arrives as one segment whose command word is preceded by `(` rather
      // than whitespace. Requiring `\s` made these decidable and let them past
      // the undecidable check entirely.
      '(sh -c "rm -rf /")',
      "(eval foo)",
      "true && (env X=1 sh)",
      "{ eval foo; }",
      "command env FOO=1 ls",
      "command -p env FOO=1 ls",
    ]) {
      expect({ command, undecidable: analyzeBash(command).undecidable }).toEqual({
        command,
        undecidable: true,
      });
    }
  });
});
