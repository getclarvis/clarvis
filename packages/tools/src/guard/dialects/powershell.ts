import type { PathCandidate, ShellDialect, Token } from "../dialect.ts";
import { stripWindowsExecutableSuffix } from "../../lib/system-executables.ts";

/**
 * Automatic variables common enough in idiomatic PowerShell that flagging them
 * would make almost every command undecidable, and harmless enough that not
 * flagging them costs nothing: none of them can name a command or a path the
 * analyzer would otherwise have resolved.
 */
const INERT_VARIABLES = new Set(["$_", "$null", "$true", "$false", "$args", "$psitem"]);

/**
 * Constructs whose effect cannot be decided statically.
 *
 * @remarks
 * Every pattern is case-insensitive, because PowerShell is: cmdlets, aliases and
 * parameters all match regardless of case, so a case-sensitive
 * `/Invoke-Expression/` would be bypassed by writing `invoke-expression`.
 *
 * Deliberately absent: the backtick. In PowerShell it is the escape character,
 * not command substitution - flagging it would make nearly every legitimate
 * command undecidable, which is the failure the POSIX table's own backtick entry
 * is guarding against in the opposite direction.
 *
 * The list is long because PowerShell offers many spellings of one capability,
 * not because many capabilities are covered. Every entry falls into one of four:
 * a substitution or expansion the analyzer cannot resolve (`$(`, `@(`, `${`);
 * a way to evaluate a string as code (`Invoke-Expression`, `Invoke-Command`,
 * `Add-Type`, `New-Object`, `$ExecutionContext`, `.Invoke(`, the `[type]`
 * accelerators); a way to hand the command to another interpreter (`powershell`,
 * `pwsh`, `cmd`, `wsl`, `bash`, `sh`, `zsh`, a `.ps1` script); or a way to run
 * something out of band (`Start-Process`, `Start-Job`, `Invoke-Item`,
 * `Invoke-WebRequest`). The aliases sit beside their cmdlets — `iex`, `icm`,
 * `saps`, `iwr` — because an alias is not a variant spelling to PowerShell, it
 * is the same command, and matching only the long form is not a partial
 * defence but no defence.
 *
 * Being here means `ask` at minimum and `deny` wherever a deny list is
 * configured, so the cost of a wrong entry is a command the agent cannot run.
 * That is why a construct that is merely *powerful* is not listed: only ones
 * whose effect genuinely cannot be read off the text.
 */
const UNDECIDABLE_PATTERNS: RegExp[] = [
  /\$\(/,
  /@\(/,
  /\$\{/,
  /\bInvoke-Expression\b/i,
  /\biex\b/i,
  /\bInvoke-Command\b/i,
  /\bicm\b/i,
  /\bAdd-Type\b/i,
  /\bNew-Object\b/i,
  /\$ExecutionContext\b/i,
  /\.\s*Invoke(?:Script)?\s*\(/i,
  /\[\s*(?:System\.)?(?:scriptblock|type|reflection|runtime|diagnostics|convert|activator)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b/i,
  /\b(?:cmd|wsl|bash|sh|zsh)(?:\.exe)?\b/i,
  /\.ps1\b/i,
  /\bStart-Process\b/i,
  /\bsaps\b/i,
  /\bStart-Job\b/i,
  /\bInvoke-Item\b/i,
  /\bInvoke-WebRequest\b/i,
  /\biwr\b/i,
  /\bInvoke-RestMethod\b/i,
  /\birm\b/i,
  /\bDownloadString\b/i,
  /\bDownloadFile\b/i,
  /\bFromBase64String\b/i,
  /\b(?:Set|New)-Alias\b/i,
  /\bfunction\s+[A-Za-z]/i,
  /--%/,
  /<#/,
];

/** A call operator or dot-source in command position. */
const COMMAND_POSITION_OPERATOR = /^\s*[&.](?:\s|["'])/;

/**
 * A starter allow list for a Windows host: conventional inspection, build,
 * test, lint and type-check commands across common development ecosystems.
 *
 * @remarks
 * Entries are written in the canonical form {@link ALIASES} produces, because
 * that is what the guard matches against - an entry spelled `rm` would never
 * fire, since the analyzer will have rewritten it to `Remove-Item`.
 *
 * This is a seed, not a policy: it is written into the user's settings once so
 * they can see and edit it, rather than compiled into the guard where it would
 * be an invisible default nobody could audit. Every entry still passes through
 * the deny list, the undecidable check and the confinement check first - a
 * match only spares the approval prompt.
 *
 * The list does not grant package installation, publication, deployment,
 * migrations, source-writing formatter modes, generic interpreters, or generic
 * task runners. Those operations retain human/model review. Build and test
 * commands can still execute repository-controlled code and write build output;
 * this allow list is approval policy, not process isolation. Pair it with the
 * native sandbox when host containment is required.
 */
export const WINDOWS_DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch --list",
  "git branch --show-current",
  "git remote -v",
  "git rev-parse",
  "git ls-files",
  "git ls-tree",
  "git describe",
  "git grep",
  "bun test",
  "bun run build",
  "bun run lint",
  "bun run typecheck",
  "bun run check",
  "npm test",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run build",
  "pnpm run lint",
  "pnpm run typecheck",
  "pnpm run check",
  "yarn test",
  "yarn build",
  "yarn lint",
  "yarn typecheck",
  "yarn check",
  "deno test",
  "deno check",
  "deno lint",
  "deno fmt --check",
  "python -m pytest",
  "python3 -m pytest",
  "py -m pytest",
  "python -m unittest",
  "python3 -m unittest",
  "py -m unittest",
  "pytest",
  "ruff check",
  "ruff format --check",
  "mypy",
  "pyright",
  "pylint",
  "tox",
  "nox",
  "uv run pytest",
  "uv run ruff check",
  "uv run mypy",
  "uv run pyright",
  "poetry run pytest",
  "poetry run ruff check",
  "poetry run mypy",
  "dotnet build",
  "dotnet test",
  "dotnet format --verify-no-changes",
  "cargo build",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "cargo fmt --check",
  "cargo doc",
  "go build",
  "go test",
  "go vet",
  "gofmt -d",
  "staticcheck",
  "golangci-lint run",
  "mvn test",
  "mvn verify",
  "mvn package",
  "gradle build",
  "gradle test",
  "gradle check",
  ".\\gradlew.bat build",
  ".\\gradlew.bat test",
  ".\\gradlew.bat check",
  "sbt compile",
  "sbt test",
  "cmake --build",
  "ctest",
  "meson compile",
  "meson test",
  "rspec",
  "rubocop",
  "rake test",
  "ruby -c",
  "composer test",
  "phpunit",
  ".\\vendor\\bin\\phpunit",
  ".\\vendor\\bin\\phpstan analyse",
  ".\\vendor\\bin\\psalm",
  "swift build",
  "swift test",
  "swift package describe",
  "mix compile",
  "mix test",
  "mix format --check-formatted",
  "mix credo",
  "rebar3 compile",
  "rebar3 eunit",
  "rebar3 ct",
  "dart analyze",
  "dart test",
  "flutter analyze",
  "flutter test",
  "zig build",
  "zig test",
  "cabal build",
  "cabal test",
  "stack build",
  "stack test",
  "clojure -M:test",
  "lein test",
  "busted",
  "luacheck",
  "prove",
  "shellcheck",
  "shfmt -d",
  "Get-ChildItem",
  "Get-Content",
  "Get-Location",
  "Get-Command",
  "Get-Date",
  "Get-Item",
  "Test-Path",
  "Select-String",
  "Measure-Object",
  "Compare-Object",
  "Sort-Object",
  "Write-Output",
];

/**
 * Aliases PowerShell resolves before running anything, canonicalized so the
 * allow and deny lists have a single spelling to match.
 *
 * @remarks
 * Without this the lists silently half-work: `rm` *is* `Remove-Item`, so a deny
 * entry written either way misses commands written the other. This is the same
 * failure as an empty `normalized`, one layer up - the guard matching a string
 * that is not the thing that will run.
 *
 * Only unambiguous aliases are listed. `curl`, `wget`, `where` and `sort` are
 * omitted on purpose: each is an alias in Windows PowerShell 5.1 but resolves to
 * a real executable of that name in PowerShell 7 or when one is on `PATH`, so
 * canonicalizing them would assert something version-dependent. `%` and `?` are
 * omitted because they collide with wildcard characters.
 *
 * Each cmdlet maps to itself as well as to its aliases, so `remove-item` and
 * `Remove-Item` - both of which PowerShell resolves - reach the lists under
 * one spelling.
 */
const ALIASES = new Map<string, string>(
  Object.entries({
    "Remove-Item": "rm del erase rd rmdir ri",
    "Get-Content": "cat type gc",
    "Get-ChildItem": "ls dir gci",
    "Copy-Item": "cp copy cpi",
    "Move-Item": "mv move mi",
    "Rename-Item": "ren rni",
    "Set-Location": "cd chdir sl",
    "Get-Location": "pwd gl",
    "New-Item": "ni",
    "Get-Item": "gi",
    "Set-Item": "si",
    "Invoke-Expression": "iex",
    "Invoke-Command": "icm",
    "Invoke-Item": "ii",
    "Start-Process": "saps",
    "Invoke-WebRequest": "iwr",
    "Invoke-RestMethod": "irm",
    "Write-Output": "echo write",
    "Get-Command": "gcm",
    "Get-Process": "gps",
    "Stop-Process": "spps",
    "Clear-Host": "cls",
  }).flatMap(([canonical, aliases]) =>
    [canonical, ...aliases.split(" ")].map((name): [string, string] => [
      name.toLowerCase(),
      canonical,
    ]),
  ),
);

/**
 * The canonical cmdlet name for a command word, case-insensitively.
 *
 * @remarks A bare executable loses a suffix Windows resolves through `PATHEXT`,
 *   so `curl.exe` and `curl` share one policy identity. Otherwise a word that
 *   is not a known alias or cmdlet is returned unchanged, case included.
 *   Rewriting the case of arbitrary external commands would assert more than
 *   this table knows.
 */
function canonicalCommand(word: string): string {
  const command = /[\\/]/.test(word) ? word : stripWindowsExecutableSuffix(word);
  return ALIASES.get(command.toLowerCase()) ?? command;
}

/**
 * Drop text that cannot expand at runtime, so the {@link UNDECIDABLE_PATTERNS}
 * scan sees only what will.
 *
 * @returns the scrubbed text, and `unbalanced` when a quote or here-string is
 *   left open at end of input.
 * @remarks A single-quoted span in PowerShell is fully literal, so it is
 *   removed; a double-quoted span still interpolates, so it is kept minus the
 *   quotes. A backtick escapes the character after it in both unquoted and
 *   double-quoted text, so the pair is dropped - `` `$x `` is a literal dollar
 *   sign, not a variable.
 */
function scrubExpansions(command: string): { scrubbed: string; unbalanced: boolean } {
  let out = "";
  let quote: '"' | "'" | null = null;
  let here: '"' | "'" | null = null;
  let atLineStart = true;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (here !== null) {
      if (atLineStart && command.startsWith(`${here}@`, i)) {
        here = null;
        i += 2;
        continue;
      }
      atLineStart = c === "\n";
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "`") {
        i += 2;
        continue;
      }
      if (c === '"') quote = null;
      else out += c;
      i++;
      continue;
    }
    if (c === "`") {
      i += 2;
      continue;
    }
    const opener = hereStringOpener(command, i);
    if (opener !== null) {
      here = opener;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    out += c;
    atLineStart = c === "\n";
    i++;
  }
  return { scrubbed: out, unbalanced: quote !== null || here !== null };
}

/**
 * Whether a segment is free of constructs the analyzer cannot reason about.
 *
 * @remarks
 * The highest-leverage entry is the variable check. `$_`, `$null`, `$true` and
 * friends are pervasive in idiomatic PowerShell, so flagging every `$name` would
 * leave the approval rate almost where the fail-closed dialect started; flagging
 * none of them would let `$cmd` name anything at all. Exempting a fixed list of
 * automatic variables and flagging the rest is what makes the table worth
 * having.
 */
function decidable(segment: string): boolean {
  const { scrubbed, unbalanced } = scrubExpansions(segment);
  if (unbalanced) return false;
  if (COMMAND_POSITION_OPERATOR.test(scrubbed)) return false;
  if (UNDECIDABLE_PATTERNS.some((re) => re.test(scrubbed))) return false;
  for (const match of scrubbed.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*|\$_/g)) {
    if (!INERT_VARIABLES.has(match[0].toLowerCase())) return false;
  }
  return true;
}

/**
 * Wildcards PowerShell actually expands. `{` and `}` are absent on purpose:
 * unlike POSIX they open a script block, not a brace expansion.
 */
const GLOB_METACHARS = /[*?[\]]/;

/**
 * Characters that disqualify a token from being read as a plain path. `:` and
 * `\` are absent because a drive-qualified path needs both.
 */
const PATH_METACHARS = /[$`{}()|;&<>@,]/;

/** An upward traversal through either separator. */
const DOTDOT = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * A redirection prefix. PowerShell numbers more streams than POSIX (`2>` error,
 * `*>` all) and has no `<`, which is a reserved token rather than an operator.
 */
const REDIRECT_PREFIX = /^(?:\d|\*)?>>?(?:&\d)?/;

/** `C:\...` or `C:/...` - a single-letter drive, so a real filesystem path. */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** `C:` or `C:foo` - resolves against that drive's *current* directory. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

/** `\\server\share`. */
const UNC = /^\\\\[^\\]/;

/**
 * A PowerShell provider qualifier - `Env:`, `HKLM:`, `Function:`, `Cert:`. Two
 * or more characters before the colon, which is what separates it from a
 * single-letter filesystem drive.
 */
const PROVIDER_QUALIFIED = /^[A-Za-z][A-Za-z0-9]+:/;

/** Whether the character at `i` opens a here-string, and which kind. */
function hereStringOpener(command: string, i: number): '"' | "'" | null {
  if (command[i] !== "@") return null;
  const quote = command[i + 1];
  if (quote !== '"' && quote !== "'") return null;
  for (let j = i + 2; j < command.length; j++) {
    const c = command[j]!;
    if (c === "\n") return quote;
    if (c !== " " && c !== "\t" && c !== "\r") return null;
  }
  return quote;
}

/**
 * Whether `#` at index `i` begins a line comment.
 *
 * @remarks PowerShell treats `#` as a comment only at the start of a token, so
 *   `file#1` is an ordinary name. Getting this wrong in the permissive direction
 *   would be unsafe in a specific way: `git status # note; rm -rf x` would
 *   otherwise yield a phantom `rm -rf x` segment that never runs, and an
 *   operator reading the approval prompt would see a command the shell ignores.
 */
function startsComment(command: string, i: number): boolean {
  if (command[i] !== "#") return false;
  const prev = command[i - 1];
  return prev === undefined || prev === " " || prev === "\t" || prev === "\n" || prev === "\r";
}

/**
 * Split a PowerShell command line at top-level statement and pipeline
 * separators.
 *
 * @remarks
 * Splits on `;`, newline, `|`, `||` and `&&`. Never splits inside a single- or
 * double-quoted string, a here-string, parentheses, or braces - a script block
 * (`Get-ChildItem | ForEach-Object { $_.Name; $_.Length }`) contains `;`
 * constantly and is one command, not three.
 *
 * `&` is deliberately never a separator. Leading, it is the call operator
 * (`& "C:\my app.exe"`); trailing, it backgrounds. Splitting on it - which is
 * correct for POSIX - would turn `& git status` into an empty segment plus
 * `git status`, changing what the allow list is shown.
 *
 * A trailing backtick continues the line, so the newline after it does not
 * split.
 */
function split(command: string): { segments: string[]; balanced: boolean } {
  const out: string[] = [];
  let cur = "";
  let single = false;
  let double = false;
  let here: '"' | "'" | null = null;
  let lineComment = false;
  let blockComment = 0;
  let parens = 0;
  let braces = 0;
  let continuation = false;
  let atLineStart = true;

  const flush = (): void => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i]!;

    if (here !== null) {
      if (atLineStart && command.startsWith(`${here}@`, i)) {
        cur += command.slice(i, i + 2);
        i += 2;
        here = null;
        atLineStart = false;
        continue;
      }
      cur += c;
      atLineStart = c === "\n";
      i++;
      continue;
    }

    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        flush();
        atLineStart = true;
      }
      i++;
      continue;
    }

    if (blockComment > 0) {
      if (command.startsWith("#>", i)) {
        blockComment--;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (single) {
      cur += c;
      if (c === "'") single = false;
      i++;
      continue;
    }

    if (double) {
      cur += c;
      if (c === "`" && i + 1 < command.length) {
        cur += command[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') double = false;
      i++;
      continue;
    }

    if (c === "`") {
      const next = command[i + 1];
      if (next === undefined) {
        continuation = true;
        i++;
        continue;
      }
      cur += c + next;
      i += 2;
      atLineStart = false;
      continue;
    }

    if (command.startsWith("<#", i)) {
      blockComment++;
      i += 2;
      continue;
    }
    if (startsComment(command, i)) {
      lineComment = true;
      i++;
      continue;
    }

    const opener = hereStringOpener(command, i);
    if (opener !== null) {
      here = opener;
      cur += command.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === "'") {
      single = true;
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      double = true;
      cur += c;
      i++;
      continue;
    }
    if (c === "(") {
      parens++;
      cur += c;
      i++;
      continue;
    }
    if (c === ")") {
      if (parens > 0) parens--;
      cur += c;
      i++;
      continue;
    }
    if (c === "{") {
      braces++;
      cur += c;
      i++;
      continue;
    }
    if (c === "}") {
      if (braces > 0) braces--;
      cur += c;
      i++;
      continue;
    }

    if (parens === 0 && braces === 0) {
      if (command.startsWith("&&", i) || command.startsWith("||", i)) {
        flush();
        i += 2;
        continue;
      }
      if (c === ";" || c === "|") {
        flush();
        i++;
        continue;
      }
      if (c === "\n") {
        flush();
        atLineStart = true;
        i++;
        continue;
      }
    }

    cur += c;
    atLineStart = false;
    i++;
  }
  flush();
  const balanced =
    !single &&
    !double &&
    here === null &&
    blockComment === 0 &&
    parens === 0 &&
    braces === 0 &&
    !continuation;
  return { segments: out, balanced };
}

/**
 * Tokenize one PowerShell segment into words, flagging unquoted wildcards.
 *
 * @remarks
 * The backtick is PowerShell's **escape** character, not command substitution -
 * the single most important difference from the POSIX tokenizer, and the reason
 * the two dialects cannot share one grammar. A single-quoted span is literal
 * (`''` escapes a quote inside it); a double-quoted span resolves backtick
 * escapes and `""`. Subexpressions (`$(...)`, `@(...)`, `${...}`) and
 * here-strings are consumed and contribute nothing, exactly as the POSIX
 * tokenizer drops substitutions.
 *
 * This is a guard heuristic for surfacing operands, not a PowerShell parser.
 */
function tokenize(segment: string): Token[] {
  const tokens: Token[] = [];
  let cur = "";
  let curGlob = false;
  let started = false;

  const push = (): void => {
    if (started) tokens.push({ text: cur, glob: curGlob });
    cur = "";
    curGlob = false;
    started = false;
  };
  const add = (text: string): void => {
    cur += text;
    started = true;
  };

  let i = 0;
  while (i < segment.length) {
    const c = segment[i]!;

    const opener = hereStringOpener(segment, i);
    if (opener !== null) {
      const end = segment.indexOf(`\n${opener}@`, i);
      i = end === -1 ? segment.length : end + 3;
      started = true;
      continue;
    }

    if (c === "'") {
      started = true;
      i++;
      while (i < segment.length) {
        if (segment[i] === "'") {
          if (segment[i + 1] === "'") {
            cur += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cur += segment[i];
        i++;
      }
      continue;
    }

    if (c === '"') {
      started = true;
      i++;
      while (i < segment.length) {
        const d = segment[i]!;
        if (d === "`" && i + 1 < segment.length) {
          cur += segment[i + 1];
          i += 2;
          continue;
        }
        if (d === '"') {
          if (segment[i + 1] === '"') {
            cur += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        cur += d;
        i++;
      }
      continue;
    }

    if (c === "`") {
      if (i + 1 < segment.length) {
        add(segment[i + 1]!);
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if ((c === "$" || c === "@") && segment[i + 1] === "(") {
      push();
      let depth = 0;
      i++;
      while (i < segment.length) {
        if (segment[i] === "(") depth++;
        else if (segment[i] === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      continue;
    }

    if (c === "$" && segment[i + 1] === "{") {
      push();
      while (i < segment.length && segment[i] !== "}") i++;
      i++;
      continue;
    }

    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }

    if (GLOB_METACHARS.test(c)) curGlob = true;
    add(c);
    i++;
  }
  push();
  return tokens;
}

/**
 * The literal directory prefix of a wildcard token, honouring both separators
 * and stopping at a drive root rather than walking past it.
 */
function globLiteralPrefix(token: string): string {
  const idx = token.search(GLOB_METACHARS);
  const head = idx === -1 ? token : token.slice(0, idx);
  const cut = Math.max(head.lastIndexOf("\\"), head.lastIndexOf("/"));
  if (cut === -1) return ".";
  if (DRIVE_ABSOLUTE.test(head) && cut === 2) return head.slice(0, 3);
  if (cut === 0) return head.slice(0, 1);
  return head.slice(0, cut);
}

/** Whether a bare token looks like a filesystem path worth resolving. */
function looksLikePath(token: string): boolean {
  if (token === "" || token.startsWith("-")) return false;
  if (PATH_METACHARS.test(token)) return false;
  if (DRIVE_ABSOLUTE.test(token) || UNC.test(token)) return true;
  if (token.includes("\\") || token.includes("/")) return true;
  if (/^[~.]/.test(token)) return true;
  if (/^[\w.-]+\.\w+$/.test(token)) return true;
  return false;
}

/**
 * Classify one token as a path operand under PowerShell semantics.
 *
 * @remarks
 * Provider-qualified names (`Env:PATH`, `HKLM:\Software`) and drive-relative
 * references (`C:`, `C:notes.txt`) are reported **opaque** rather than "not a
 * path". They address something the analyzer cannot resolve - a provider that is
 * not the filesystem, or a per-drive current directory only the running shell
 * knows - and reporting them as `none` would let them contribute no
 * {@link PathFact} while still looking analyzed, so a future allow-list entry
 * would clear `Get-Content Env:\SECRET` on a command nothing had confined.
 */
function pathCandidate(token: Token): PathCandidate {
  const redirect = REDIRECT_PREFIX.exec(token.text);
  let text = token.text;
  if (redirect !== null) {
    if (redirect[0].length === text.length) return { kind: "none" };
    text = text.slice(redirect[0].length);
  }
  const glob = redirect !== null ? GLOB_METACHARS.test(text) : token.glob;

  if (text.startsWith("~") && text.length > 1 && !/^~[\\/]/.test(text)) return { kind: "opaque" };
  if (!DRIVE_ABSOLUTE.test(text) && (PROVIDER_QUALIFIED.test(text) || DRIVE_RELATIVE.test(text))) {
    return { kind: "opaque" };
  }
  if (glob) {
    if (DOTDOT.test(text)) return { kind: "opaque" };
    return { kind: "prefix", value: globLiteralPrefix(text) };
  }
  return looksLikePath(text) ? { kind: "path", value: text } : { kind: "none" };
}

/**
 * The PowerShell front end.
 *
 * @remarks
 * Fails closed by construction: anything {@link decidable} does not recognize is
 * reported undecidable and routed to the human, so a gap in the pattern table
 * costs an approval prompt rather than a wrong allow.
 *
 * The tokenizer matters independently of that, because the guard evaluates its
 * deny list *before* it consults `undecidable`, matching against
 * `Segment.normalized`. A dialect that tokenized nothing would leave
 * `normalized` empty, no deny entry would match, and a configured `deny` would
 * quietly become an `ask`.
 *
 * `normalize` canonicalizes only `argv[0]`, through {@link ALIASES}, leaving the
 * arguments untouched. There are no env assignments to strip - PowerShell has no
 * `NAME=value` command prefix, since `$env:FOO='x'; cmd` is a separate statement
 * that becomes its own segment - and no `timeout`/`nice`/`nohup` analogue worth
 * unwrapping, because `Start-Process`, `Measure-Command` and `&` are all things
 * to flag rather than peel.
 */
export const powershellDialect: ShellDialect = {
  flavor: "powershell",
  split,
  tokenize,
  decidable,
  normalize: (tokens) => ({
    argv: tokens.length === 0 ? tokens : [canonicalCommand(tokens[0]!), ...tokens.slice(1)],
    envAssignments: [],
  }),
  pathCandidate,
};
