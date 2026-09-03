import { describe, expect, it } from "bun:test";
import { analyzeShell } from "../../src/guard/analyze-shell.ts";
import { currentDialect, dialectFor } from "../../src/guard/dialects/index.ts";
import { powershellDialect } from "../../src/guard/dialects/powershell.ts";
import { posixDialect } from "../../src/guard/dialects/posix.ts";

const segments = (command: string): string[] => powershellDialect.split(command).segments;
const balanced = (command: string): boolean => powershellDialect.split(command).balanced;
const words = (segment: string): string[] => powershellDialect.tokenize(segment).map((t) => t.text);
const paths = (command: string): string[] => analyzeShell(command, powershellDialect).paths;
const classify = (text: string, glob = false) => powershellDialect.pathCandidate({ text, glob });

describe("dialect selection", () => {
  it("pairs each platform with the syntax it actually runs", () => {
    expect(currentDialect("win32").flavor).toBe("powershell");
    expect(currentDialect("linux").flavor).toBe("posix");
    expect(currentDialect("darwin").flavor).toBe("posix");
  });

  it("maps a flavor to its dialect", () => {
    expect(dialectFor("powershell")).toBe(powershellDialect);
    expect(dialectFor("posix")).toBe(posixDialect);
  });
});

describe("powershellDialect.split", () => {
  it("splits on statement and pipeline separators", () => {
    expect(segments("Get-ChildItem; Get-Date")).toEqual(["Get-ChildItem", "Get-Date"]);
    expect(segments("Get-ChildItem | Measure-Object")).toEqual(["Get-ChildItem", "Measure-Object"]);
    expect(segments("a\nb")).toEqual(["a", "b"]);
  });

  it("splits on && and || without leaving an empty segment behind", () => {
    expect(segments("bun test && bun run lint")).toEqual(["bun test", "bun run lint"]);
    expect(segments("bun test || Write-Output failed")).toEqual([
      "bun test",
      "Write-Output failed",
    ]);
  });

  it("never treats & as a separator", () => {
    // Leading, it is the call operator; trailing, it backgrounds. Splitting on it
    // is right for POSIX and wrong here — `& git status` would become an empty
    // segment plus `git status`, changing what the allow list is shown.
    expect(segments('& "C:\\my app.exe" --flag')).toEqual(['& "C:\\my app.exe" --flag']);
    expect(segments("git status &")).toEqual(["git status &"]);
  });

  it("does not split inside quotes", () => {
    expect(segments("Write-Output 'a; b | c'")).toEqual(["Write-Output 'a; b | c'"]);
    expect(segments('Write-Output "a; b | c"')).toEqual(['Write-Output "a; b | c"']);
  });

  it("does not split inside a script block or parentheses", () => {
    expect(segments("Get-ChildItem | ForEach-Object { $_.Name; $_.Length }")).toEqual([
      "Get-ChildItem",
      "ForEach-Object { $_.Name; $_.Length }",
    ]);
    expect(segments("Write-Output (1; 2)")).toEqual(["Write-Output (1; 2)"]);
  });

  it("does not split inside a here-string", () => {
    expect(segments("$x = @'\na; b | c\n'@\nWrite-Output $x")).toEqual([
      "$x = @'\na; b | c\n'@",
      "Write-Output $x",
    ]);
  });

  it("treats a trailing backtick as a line continuation, not a statement break", () => {
    // Segments keep their source verbatim, as the POSIX splitter does, so the
    // continuation is preserved rather than resolved. What matters is that the
    // newline after it did not split the statement in two.
    expect(segments("Get-ChildItem `\n  -Recurse")).toEqual(["Get-ChildItem `\n  -Recurse"]);
    expect(segments("Get-ChildItem\n  -Recurse")).toEqual(["Get-ChildItem", "-Recurse"]);
  });

  it("drops a line comment rather than yielding a phantom segment from it", () => {
    expect(segments("git status # note; rm -rf x")).toEqual(["git status"]);
    expect(segments("<# note; rm -rf x #> git status")).toEqual(["git status"]);
    expect(segments("git status # note\nGet-Date")).toEqual(["git status", "Get-Date"]);
  });

  it("keeps escaped separators inside double quotes", () => {
    expect(segments('Write-Output "a`;b"; Get-Date')).toEqual(['Write-Output "a`;b"', "Get-Date"]);
  });

  it("keeps # inside a token, where PowerShell does not start a comment", () => {
    expect(segments("Get-Content file#1.txt")).toEqual(["Get-Content file#1.txt"]);
  });

  it("reports an unterminated construct as unbalanced", () => {
    expect(balanced("Write-Output 'x")).toBe(false);
    expect(balanced('Write-Output "x')).toBe(false);
    expect(balanced("ForEach-Object { $_")).toBe(false);
    expect(balanced("Write-Output (1")).toBe(false);
    expect(balanced("$x = @'\nbody")).toBe(false);
    expect(balanced("Get-ChildItem `")).toBe(false);
    expect(balanced("Get-ChildItem")).toBe(true);
  });
});

describe("powershellDialect.tokenize", () => {
  it("splits on whitespace and unquotes", () => {
    expect(words("Remove-Item -Recurse -Force build")).toEqual([
      "Remove-Item",
      "-Recurse",
      "-Force",
      "build",
    ]);
  });

  it("treats a single-quoted span as literal, with '' as an escaped quote", () => {
    expect(words("Write-Output 'it''s'")).toEqual(["Write-Output", "it's"]);
    expect(words("Write-Output 'a b'")).toEqual(["Write-Output", "a b"]);
  });

  it("resolves backtick and doubled escapes inside a double-quoted span", () => {
    expect(words('Write-Output "a`"b"')).toEqual(["Write-Output", 'a"b']);
    expect(words('Write-Output "a""b"')).toEqual(["Write-Output", 'a"b']);
  });

  it("treats the backtick as an escape, not as substitution", () => {
    // This is the asymmetry the whole two-dialect design rests on: in POSIX a
    // backtick opens command substitution, here it escapes the next character.
    // An escaped space joins the words; a second, unescaped one still separates.
    expect(words("Write-Output a` b")).toEqual(["Write-Output", "a b"]);
    expect(words("Write-Output a`  b")).toEqual(["Write-Output", "a ", "b"]);
    // The same source under POSIX: the backtick opens a substitution, which is
    // consumed and dropped entirely.
    expect(posixDialect.tokenize("echo `whoami`").map((t) => t.text)).toEqual(["echo"]);
  });

  it("consumes subexpressions without contributing their text", () => {
    expect(words("Write-Output $(Get-Date)")).toEqual(["Write-Output"]);
    expect(words("Write-Output @(1,2)")).toEqual(["Write-Output"]);
    expect(words("Write-Output ${x}")).toEqual(["Write-Output"]);
  });

  it("consumes here-strings and a dangling escape as opaque token content", () => {
    expect(words("Write-Output @'\nbody\n'@")).toEqual(["Write-Output", ""]);
    expect(words("Write-Output @'   ")).toEqual(["Write-Output", ""]);
    expect(words("Write-Output tail`")).toEqual(["Write-Output", "tail"]);
  });

  it("flags wildcards but not braces, which open a script block here", () => {
    const flags = (s: string) => powershellDialect.tokenize(s).map((t) => t.glob);
    expect(flags("Get-ChildItem src\\*.ps1")).toEqual([false, true]);
    expect(flags("Get-ChildItem {a,b}")).toEqual([false, false]);
  });

  it("keeps an empty quoted argument as a real token", () => {
    expect(words("Write-Output ''")).toEqual(["Write-Output", ""]);
  });
});

describe("powershellDialect.pathCandidate", () => {
  it("recognizes Windows path shapes", () => {
    expect(classify("C:\\Users\\me\\f.txt")).toEqual({
      kind: "path",
      value: "C:\\Users\\me\\f.txt",
    });
    expect(classify("\\\\server\\share\\f")).toEqual({
      kind: "path",
      value: "\\\\server\\share\\f",
    });
    expect(classify(".\\build.ps1")).toEqual({ kind: "path", value: ".\\build.ps1" });
    expect(classify("..\\sibling\\x")).toEqual({ kind: "path", value: "..\\sibling\\x" });
    expect(classify("~\\.ssh\\id_rsa")).toEqual({ kind: "path", value: "~\\.ssh\\id_rsa" });
  });

  it("reports a provider-qualified name as opaque, not as no path at all", () => {
    // `none` would mean "not a filesystem operand", which is how a token nobody
    // confined would come to look analyzed.
    expect(classify("Env:PATH")).toEqual({ kind: "opaque" });
    expect(classify("HKLM:\\Software")).toEqual({ kind: "opaque" });
    expect(classify("Function:prompt")).toEqual({ kind: "opaque" });
  });

  it("reports a drive-relative reference as opaque", () => {
    expect(classify("C:")).toEqual({ kind: "opaque" });
    expect(classify("C:notes.txt")).toEqual({ kind: "opaque" });
  });

  it("reduces a wildcard to its literal prefix, stopping at a drive root", () => {
    expect(classify("src\\*.ps1", true)).toEqual({ kind: "prefix", value: "src" });
    expect(classify("C:\\*.txt", true)).toEqual({ kind: "prefix", value: "C:\\" });
    expect(classify("*.txt", true)).toEqual({ kind: "prefix", value: "." });
  });

  it("reports an upward-traversing wildcard as opaque", () => {
    expect(classify("*\\..\\..\\Windows", true)).toEqual({ kind: "opaque" });
  });

  it("strips a redirection prefix and ignores a bare operator", () => {
    expect(classify("2>err.log")).toEqual({ kind: "path", value: "err.log" });
    expect(classify("*>all.log")).toEqual({ kind: "path", value: "all.log" });
    expect(classify("2>")).toEqual({ kind: "none" });
    expect(classify(">>out.log")).toEqual({ kind: "path", value: "out.log" });
  });

  it("does not mistake a parameter for a path", () => {
    expect(classify("-Recurse")).toEqual({ kind: "none" });
    expect(classify("Remove-Item")).toEqual({ kind: "none" });
  });
});

describe("powershellDialect — fail-closed posture", () => {
  it("populates normalized, so a deny-list entry still has something to match", () => {
    // The guard checks its deny list BEFORE it consults `undecidable`, matching
    // on `Segment.normalized`. A dialect that tokenized nothing would leave that
    // empty, no deny entry would match, and a configured `deny` would quietly
    // become an `ask`. Shipping without a full analyzer is slow, not unsafe —
    // shipping without a real tokenizer would be unsafe.
    const facts = analyzeShell("Remove-Item -Recurse -Force build", powershellDialect);
    expect(facts.segments.map((s) => s.normalized)).toEqual(["Remove-Item -Recurse -Force build"]);
    expect(facts.segments.every((s) => s.argv.length > 0)).toBe(true);
  });

  it("lets the ordinary development loop through without a prompt", () => {
    for (const command of [
      "git status",
      "git diff --stat",
      "bun test",
      "npm run build",
      "dotnet build",
      "Get-ChildItem",
      "Write-Output hi",
      "Remove-Item -Recurse -Force build",
    ]) {
      expect(analyzeShell(command, powershellDialect).undecidable).toBe(false);
    }
  });
});

describe("powershellDialect.decidable", () => {
  const decidable = (command: string): boolean => powershellDialect.decidable(command);

  it.each([
    ["$(Get-Date)", "subexpression"],
    ["@(Get-Process)", "array subexpression"],
    ["${x}", "braced variable"],
    ["Invoke-Expression $payload", "explicit evaluation"],
    ["iex $payload", "aliased evaluation"],
    ["invoke-expression $payload", "evaluation written in lower case"],
    ["Add-Type -TypeDefinition $src", "inline compilation"],
    ["New-Object System.Net.WebClient", "reflection over an arbitrary type"],
    ["& $tool --flag", "call operator in command position"],
    [". .\\setup.ps1", "dot-sourcing into the current scope"],
    ["powershell -enc SQBFAFgA", "a nested interpreter"],
    ["pwsh.exe -Command x", "a nested interpreter by full name"],
    ["cmd /c dir", "a foreign interpreter"],
    [".\\build.ps1", "a script file"],
    ["Start-Process notepad", "a detached process"],
    ["Invoke-WebRequest https://x | iex", "fetch-and-run"],
    ["Set-Alias ls Remove-Item", "rebinding a name"],
    ["function Get-ChildItem { Remove-Item @args }", "redefining a command"],
    ["Get-ChildItem --% $weird", "the stop-parsing token"],
    ["<# hidden #> Get-ChildItem", "a block comment"],
    ["$cmd arg", "a variable in command position"],
    ["[scriptblock]::Create($x)", "a constructed script block"],
    ["$x.Invoke()", "a dynamic invocation"],
  ])("reports %p undecidable — %s", (command) => {
    expect(decidable(command)).toBe(false);
  });

  it.each([["$_"], ["$null"], ["$true"], ["$false"], ["$args"], ["$PSItem"]])(
    "does not flag the automatic variable %s",
    (variable) => {
      expect(decidable(`Where-Object { ${variable} -ne 0 }`)).toBe(true);
    },
  );

  it("treats a single-quoted span as literal, since it never expands", () => {
    expect(decidable("Write-Output '$(Get-Date)'")).toBe(true);
    expect(decidable('Write-Output "$(Get-Date)"')).toBe(false);
  });

  it("treats a backtick-escaped dollar as a literal character", () => {
    expect(decidable("Write-Output `$notAVariable")).toBe(true);
    expect(decidable('Write-Output "`$notAVariable"')).toBe(true);
  });

  it("ignores expansion syntax inside a closed literal here-string", () => {
    expect(decidable("Write-Output @'\n$(Get-Date)\n'@")).toBe(true);
  });

  it("reports an unterminated quote or here-string as undecidable", () => {
    expect(decidable("Write-Output 'x")).toBe(false);
    expect(decidable("$x = @'\nbody")).toBe(false);
  });
});

describe("powershellDialect.normalize — alias canonicalization", () => {
  const normalized = (command: string): string[] =>
    analyzeShell(command, powershellDialect).segments.map((s) => s.normalized);

  it("gives an alias and its cmdlet the same spelling for the lists to match", () => {
    // `rm` *is* `Remove-Item`. Without canonicalizing, a deny entry written
    // either way silently misses commands written the other.
    expect(normalized("rm -Recurse build")).toEqual(["Remove-Item -Recurse build"]);
    expect(normalized("Remove-Item -Recurse build")).toEqual(["Remove-Item -Recurse build"]);
  });

  it("canonicalizes case-insensitively, as PowerShell resolves aliases", () => {
    expect(normalized("RM build")).toEqual(["Remove-Item build"]);
    expect(normalized("Ls")).toEqual(["Get-ChildItem"]);
  });

  it("rewrites only the command word, never the arguments", () => {
    expect(normalized("Get-Content ls")).toEqual(["Get-Content ls"]);
    expect(normalized("Copy-Item rm.txt cat.txt")).toEqual(["Copy-Item rm.txt cat.txt"]);
  });

  it("leaves a command that is not an alias alone", () => {
    expect(normalized("git status")).toEqual(["git status"]);
    expect(normalized("bun test")).toEqual(["bun test"]);
  });

  it("does not canonicalize names that are version-dependent aliases", () => {
    // `curl`, `wget`, `where` and `sort` are aliases in Windows PowerShell 5.1
    // but real executables in PowerShell 7 or whenever one is on PATH, so
    // asserting either meaning would be wrong somewhere.
    expect(normalized("curl https://example.com")).toEqual(["curl https://example.com"]);
    expect(normalized("where git")).toEqual(["where git"]);
  });

  it("normalizes PATHEXT suffixes on bare executable command names", () => {
    for (const suffix of ["EXE", "com", "BaT", "CmD"]) {
      expect(normalized(`tool.${suffix} arg`)).toEqual(["tool arg"]);
    }
  });

  it("still extracts the paths a command touches", () => {
    // Asserting the extracted strings, never `PathFact.withinWorkspace`: on a
    // POSIX host `node:path` does not treat `\` as a separator, so a confinement
    // assertion here would pass for the wrong reason. That belongs to the
    // Windows job.
    expect(paths("Get-Content C:\\Users\\me\\.ssh\\id_rsa")).toEqual([
      "C:\\Users\\me\\.ssh\\id_rsa",
    ]);
    expect(paths("Remove-Item .\\build -Recurse")).toEqual([".\\build"]);
  });
});
