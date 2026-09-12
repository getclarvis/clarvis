import type { PathCandidate, ShellDialect, Token } from "../dialect.ts";

/**
 * Expansions whose effect cannot be read off the text. Command names are not
 * here: a scan of the whole segment treats `cat source` and `npm run env` as
 * `env`/`source` in command position, which is how parameterized commands became
 * undecidable. Those names are matched against the effective argv head instead.
 */
const EXPANSION_PATTERNS: RegExp[] = [/\$\(/, /`/, /\$\{?[A-Za-z_]/, /<\(/, />\(/];

const UNDECIDABLE_COMMANDS = new Set(["eval", "exec", "source", "env", "xargs", "base64"]);

/**
 * Tokens that introduce a command without being the command: grouping, negation,
 * POSIX `command`/`builtin`, and compound-list keywords. Skipping them is how
 * `(eval rm)` and `{ eval foo; }` stay undecidable after the whole-segment
 * regex is gone, without flagging `echo eval`.
 */
const COMMAND_PREFIX_TOKENS = new Set([
  "{",
  "}",
  "(",
  ")",
  "!",
  "command",
  "builtin",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
]);

/**
 * A starter allow list for a POSIX host: conventional inspection, build, test,
 * lint and type-check commands across common development ecosystems.
 *
 * @remarks
 * This is a seed, not a policy: it is written into the user's settings once so
 * they can see and edit it, rather than compiled into the guard where it would
 * be an invisible default nobody could audit. Every entry still passes through
 * the deny list, the undecidable check and the confinement check first — a
 * match only spares the approval prompt.
 *
 * Multi-operation CLIs name a subcommand rather than the bare binary, because
 * the guard matches a space-boundary prefix: `git` would allow `git push
 * --force`.
 *
 * The list does not grant package installation, publication, deployment,
 * migrations, source-writing formatter modes, generic interpreters, or generic
 * task runners. Those operations retain human/model review. Build and test
 * commands can still execute repository-controlled code and write build output;
 * this allow list is approval policy, not process isolation. Pair it with the
 * native sandbox when host containment is required.
 *
 * These omissions are deliberate, and each was a candidate:
 * - `make` runs whatever the `Makefile` says, which is arbitrary execution
 *   wearing a build command's name.
 * - `find` and `awk` execute code the analyzer cannot see (`find -exec`,
 *   `awk 'BEGIN{system(...)}'`). They are left off this list rather than added
 *   to the undecidable set, so they fall through to `ask` — undecidable would
 *   make them `deny` outright wherever a deny list is configured, and they are
 *   far too common for that.
 * - `sed -n` only looks read-only. The match is over the joined argv, so it
 *   fires solely when `-n` comes first, and a `sed` script can still write files
 *   with its `w` command. The protection was accidental.
 */
export const POSIX_DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
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
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "tree",
  "pwd",
  "echo",
  "which",
  "date",
  "grep",
  "rg",
  "sort",
  "uniq",
  "cut",
  "basename",
  "dirname",
  "realpath",
  "diff",
  "cmp",
  "du",
  "jq",
  "bun test",
  "bun run build",
  "bun run lint",
  "bun run typecheck",
  "bun run check",
  "bun run format:check",
  "npm test",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "npm run check",
  "npm run format:check",
  "pnpm test",
  "pnpm run test",
  "pnpm run build",
  "pnpm run lint",
  "pnpm run typecheck",
  "pnpm run check",
  "pnpm run format:check",
  "yarn test",
  "yarn build",
  "yarn lint",
  "yarn typecheck",
  "yarn check",
  "yarn format:check",
  "deno test",
  "deno check",
  "deno lint",
  "deno fmt --check",
  "python -m pytest",
  "python3 -m pytest",
  "python -m unittest",
  "python3 -m unittest",
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
  "./mvnw test",
  "./mvnw verify",
  "./mvnw package",
  "gradle build",
  "gradle test",
  "gradle check",
  "./gradlew build",
  "./gradlew test",
  "./gradlew check",
  "sbt compile",
  "sbt test",
  "dotnet build",
  "dotnet test",
  "dotnet format --verify-no-changes",
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
  "./vendor/bin/phpunit",
  "./vendor/bin/phpstan analyse",
  "./vendor/bin/psalm",
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
];

const PATH_METACHARS = /[$,*?[\](){}|<>!;=&`]/;
const GLOB_METACHARS = /[*?[\]{}]/;
const DOTDOT = /(^|\/)\.\.(\/|$)/;
const TILDE_USER = /^~[^/]/;
const REDIRECT_PREFIX = /^[0-9&]*(?:>>?|<)/;

/**
 * Commands that run another command without changing what it does, so the guard
 * looks past them to the real head.
 *
 * @remarks Membership is one test — does the wrapper alter the *effect* of what
 * it runs? These five change only scheduling, buffering or a deadline, so
 * `timeout 5 git push` is exactly as dangerous as `git push` and must match the
 * same deny entry. That is also why the list is short and closed: `sudo`,
 * `env` and `xargs` all look like wrappers and are excluded, because each
 * changes the privileges, the environment or the arguments the real command
 * ends up with. Looking past one of those would let a deny list be walked
 * around by prefixing it.
 */
const SAFE_WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TIMEOUT_DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;

/**
 * Heuristic: does a bare token look like a filesystem path worth resolving?
 * True for tokens containing a `/`, starting with `~` or `.`, or shaped like a
 * `name.ext`; false for flags, empty tokens, and anything with shell
 * metacharacters.
 */
function looksLikePath(token: string): boolean {
  if (token === "" || token.startsWith("-")) return false;
  if (PATH_METACHARS.test(token)) return false;
  if (token.includes("/")) return true;
  if (/^[~.]/.test(token)) return true;
  if (/^[\w.-]+\.\w+$/.test(token)) return true;
  return false;
}

/**
 * The literal directory prefix of a glob token: the longest leading path that
 * contains no glob metacharacter, reduced to its parent directory. Returns `.`
 * when the glob has no slash and `/` when it is rooted.
 */
function globLiteralPrefix(token: string): string {
  const idx = token.search(GLOB_METACHARS);
  const head = idx === -1 ? token : token.slice(0, idx);
  const slash = head.lastIndexOf("/");
  if (slash === -1) return ".";
  if (slash === 0) return "/";
  return head.slice(0, slash);
}

/**
 * Drop single-quoted spans and quote characters so the {@link UNDECIDABLE_PATTERNS}
 * scan sees only text that could actually expand at runtime: single-quoted
 * content is removed (it never expands), double-quoted content is kept minus
 * the quotes (it still expands `$`/backticks). Reports `unbalanced` when a quote
 * is left open at end of input.
 */
function scrubExpansions(command: string): { scrubbed: string; unbalanced: boolean } {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      out += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      out += ch;
      continue;
    }
    out += ch;
  }
  return { scrubbed: out, unbalanced: quote !== null };
}

/**
 * Split a single command into shell words, tracking which words hold an unquoted
 * glob metacharacter.
 *
 * @remarks
 * Quote-aware and substitution-aware: single/double-quoted spans contribute
 * their unquoted text, backtick spans and `$(...)`/`<(...)`/`>(...)`
 * substitutions are consumed and dropped, and a `glob` flag is set only for
 * metacharacters seen outside quotes. This is a guard heuristic, not a POSIX
 * tokenizer - it exists to surface path-like operands, not to execute anything.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let cur = "";
  let curGlob = false;
  let quote: '"' | "'" | null = null;
  let backtick = false;
  let depth = 0;
  let subst = 0;
  const push = (): void => {
    if (cur) tokens.push({ text: cur, glob: curGlob });
    cur = "";
    curGlob = false;
  };
  for (const ch of command) {
    if (subst > 0) {
      if (ch === "(") subst++;
      else if (ch === ")") subst--;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (backtick) {
      if (ch === "`") backtick = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "`") {
      backtick = true;
      continue;
    }
    if (ch === "(") {
      if (cur.endsWith("$") || cur.endsWith("<") || cur.endsWith(">")) {
        cur = cur.slice(0, -1);
        push();
        subst++;
        continue;
      }
      push();
      depth++;
      continue;
    }
    if (ch === ")") {
      push();
      if (depth > 0) depth--;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (GLOB_METACHARS.test(ch)) curGlob = true;
    cur += ch;
  }
  push();
  return tokens;
}

/**
 * Whether the `&` at index `i` is part of a redirect (`&>` or a trailing `>&`)
 * rather than a background/list operator, so {@link splitByOperators} does not
 * split on it.
 */
function isRedirectAmpersand(command: string, i: number): boolean {
  return command.startsWith("&>", i) || (i > 0 && command[i - 1] === ">");
}

/**
 * Split a shell string into command segments at top-level control operators
 * (`&&`, `||`, `;`, `|`, `&`, newline).
 *
 * @param command - the raw shell string.
 * @returns the trimmed non-empty `segments` and `balanced`, which is `false`
 *   when a quote, backtick, or parenthesis is left open at end of input.
 * @remarks
 * Operators inside quotes, backticks, or parentheses are ignored; a `&` that is
 * part of a redirect (see {@link isRedirectAmpersand}) does not split. Unlike
 * {@link tokenize}, quoted text is retained verbatim so each segment stays a
 * runnable command string.
 */
function splitByOperators(command: string): { segments: string[]; balanced: boolean } {
  const out: string[] = [];
  let cur = "";
  let single = false;
  let double = false;
  let backtick = false;
  let depth = 0;
  const flush = (): void => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (single) {
      cur += c;
      if (c === "'") single = false;
      i++;
      continue;
    }
    if (double) {
      cur += c;
      if (c === '"') double = false;
      i++;
      continue;
    }
    if (backtick) {
      cur += c;
      if (c === "`") backtick = false;
      i++;
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
    if (c === "`") {
      backtick = true;
      cur += c;
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      i++;
      continue;
    }
    if (c === ")") {
      if (depth > 0) depth--;
      cur += c;
      i++;
      continue;
    }
    if (depth === 0) {
      if (command.startsWith("&&", i) || command.startsWith("||", i)) {
        flush();
        i += 2;
        continue;
      }
      if (c === "&" && !isRedirectAmpersand(command, i)) {
        flush();
        i++;
        continue;
      }
      if (c === ";" || c === "|" || c === "\n") {
        flush();
        i++;
        continue;
      }
    }
    cur += c;
    i++;
  }
  flush();
  const balanced = !single && !double && !backtick && depth === 0;
  return { segments: out, balanced };
}

/**
 * Peel leading `NAME=value` env assignments and safe wrapper commands
 * (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, with their options and
 * `timeout`'s duration) off a segment's token list.
 *
 * @param tokens - the segment's words in order.
 * @returns the remaining `argv` (the real command and its args) and the
 *   `envAssignments` that were stripped.
 * @remarks
 * Assignments are recorded, not discarded, because a grant keyed on the bare
 * command must still account for a prefix like `LD_PRELOAD=...` (see
 * {@link Segment.envAssignments}). Wrappers are unwound repeatedly, so
 * `timeout 5 nice cmd` reduces to `cmd`. Then peel consecutive `git --no-pager`
 * and `--no-color` global prefixes only; subcommand arguments and `-C` remain.
 */
function stripEnvAndWrappers(tokens: string[]): { argv: string[]; envAssignments: string[] } {
  const envAssignments: string[] = [];
  let i = 0;
  const skipEnv = (): void => {
    let t = tokens[i];
    while (t !== undefined && ENV_ASSIGN.test(t)) {
      envAssignments.push(t);
      i++;
      t = tokens[i];
    }
  };
  skipEnv();
  let head = tokens[i];
  while (head !== undefined && SAFE_WRAPPERS.has(head)) {
    const wrapper = head;
    i++;
    let opt = tokens[i];
    while (opt !== undefined && opt.startsWith("-")) {
      i++;
      opt = tokens[i];
    }
    const duration = tokens[i];
    if (wrapper === "timeout" && duration !== undefined && TIMEOUT_DURATION.test(duration)) i++;
    skipEnv();
    head = tokens[i];
  }
  const argv = tokens.slice(i);
  if (argv[0] === "git") {
    while (argv[1] === "--no-pager" || argv[1] === "--no-color") argv.splice(1, 1);
  }
  return { argv, envAssignments };
}

function posixBasename(command: string): string {
  const slash = command.lastIndexOf("/");
  return slash === -1 ? command : command.slice(slash + 1);
}

function effectiveArgv(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && COMMAND_PREFIX_TOKENS.has(argv[i]!)) {
    i++;
    while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "--") i++;
    if (argv[i] === "--") i++;
  }
  return argv.slice(i);
}

function hasDashC(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "-c" || arg.startsWith("-c")) return true;
  }
  return false;
}

/**
 * Whether the segment's real command is one whose effect cannot be bounded:
 * `eval`/`exec`/`source`/`env`/`xargs`/`base64`, or `sh`/`bash` invoked with `-c`.
 */
function opaqueCommand(argv: string[]): boolean {
  const effective = effectiveArgv(argv);
  const head = effective[0];
  if (head === undefined) return false;
  const name = posixBasename(head);
  if (UNDECIDABLE_COMMANDS.has(name)) return true;
  return (name === "sh" || name === "bash") && hasDashC(effective.slice(1));
}

const UNSAFE_LITERAL = /[`$\\*?[\](){}|<>!;&\s]/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSafeLiteral(value: string): boolean {
  return value.length > 0 && !UNSAFE_LITERAL.test(value);
}

function updateBindings(bindings: Map<string, string>, envAssignments: string[]): void {
  for (const assignment of envAssignments) {
    const eq = assignment.indexOf("=");
    if (eq <= 0) continue;
    const name = assignment.slice(0, eq);
    const value = assignment.slice(eq + 1);
    if (VAR_NAME.test(name) && isSafeLiteral(value)) bindings.set(name, value);
    else bindings.delete(name);
  }
}

/**
 * Replace `$NAME` / `${NAME}` in unquoted and double-quoted text when `NAME` is
 * a bound literal. Single-quoted spans stay literal, matching
 * {@link scrubExpansions}.
 */
function applyBindings(source: string, bindings: Map<string, string>): string {
  if (bindings.size === 0) return source;
  let out = "";
  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      out += ch;
      i++;
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "$") {
      let name: string | undefined;
      let consumed = 1;
      if (source[i + 1] === "{") {
        const end = source.indexOf("}", i + 2);
        if (end !== -1) {
          const inner = source.slice(i + 2, end);
          if (VAR_NAME.test(inner)) {
            name = inner;
            consumed = end - i + 1;
          }
        }
      } else {
        const rest = source.slice(i + 1);
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
        if (match !== null) {
          name = match[0];
          consumed = 1 + name.length;
        }
      }
      if (name !== undefined && bindings.has(name)) {
        out += bindings.get(name)!;
        i += consumed;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * True when every top-level separator is `;`, `&&`, or a newline, so a
 * `NAME=value` assignment in an earlier segment is in the same shell as later
 * ones. Pipelines, `||`, and `&` keep their expansions opaque.
 */
function isSequentialChain(command: string, sources: string[]): boolean {
  let rest = command.trim();
  for (const [index, source] of sources.entries()) {
    if (index > 0) {
      if (rest.startsWith("&&")) rest = rest.slice(2).trimStart();
      else if (rest.startsWith(";")) rest = rest.slice(1).trimStart();
      else if (rest.startsWith("\n")) rest = rest.slice(1).trimStart();
      else return false;
    }
    if (!rest.startsWith(source)) return false;
    rest = rest.slice(source.length).trimStart();
  }
  return rest.length === 0;
}

/**
 * Inline sequential literal assignments so `QA=/tmp/foo; cat "$QA/x"` is the
 * same analysis as `QA=/tmp/foo; cat /tmp/foo/x`. Bindings do not leak across
 * `|` / `||` / `&`.
 */
function analyzeSources(command: string, sources: string[]): string[] {
  if (!isSequentialChain(command, sources)) return sources;
  const bindings = new Map<string, string>();
  return sources.map((source) => {
    const expanded = applyBindings(source, bindings);
    const tokens = tokenize(expanded);
    const { argv, envAssignments } = stripEnvAndWrappers(tokens.map((t) => t.text));
    const effective = effectiveArgv(argv);
    if (effective.length === 0) {
      updateBindings(bindings, envAssignments);
      return expanded;
    }
    if (posixBasename(effective[0]!) === "unset") {
      for (const name of effective.slice(1)) bindings.delete(name);
    }
    return expanded;
  });
}

/**
 * Classify one token as a path operand under POSIX shell semantics.
 *
 * @remarks
 * Redirect prefixes (`>`, `>>`, `2>`, `<`) are stripped before the shape test;
 * a bare redirect operator with no target contributes nothing. `/dev/null` is
 * the POSIX null device rather than a host data path and likewise contributes
 * nothing, including when a spaced redirection leaves it as its own token. A
 * `~user` reference is opaque because only the running shell knows that user's
 * home.
 *
 * A glob that traverses upward through `..` is reported opaque and therefore
 * contributes **no** prefix, where the pre-dialect analyzer forced the command
 * undecidable *and* still pushed the literal prefix. The verdict is unchanged
 * either way: an undecidable command can never be workspace-confined, so the
 * dropped prefix is never the fact a decision rests on.
 */
function pathCandidate(token: Token): PathCandidate {
  const redirect = REDIRECT_PREFIX.exec(token.text);
  let text = token.text;
  if (redirect !== null) {
    if (redirect[0].length === text.length) return { kind: "none" };
    text = text.slice(redirect[0].length);
  }
  if (text === "/dev/null") return { kind: "none" };
  if (text === "[" || text === "]" || text === "[[" || text === "]]") return { kind: "none" };
  const glob = redirect !== null ? GLOB_METACHARS.test(text) : token.glob;

  if (TILDE_USER.test(text)) return { kind: "opaque" };
  if (glob) {
    if (DOTDOT.test(text)) return { kind: "opaque" };
    return { kind: "prefix", value: globLiteralPrefix(text) };
  }
  return looksLikePath(text) ? { kind: "path", value: text } : { kind: "none" };
}

/**
 * The POSIX `sh` front end: the syntax every non-Windows host runs commands
 * through.
 *
 * @remarks
 * `decidable` is `true` only when quotes are balanced, no expansion pattern
 * survives {@link scrubExpansions}, and the effective command is not `eval` /
 * `exec` / `source` / `env` / `xargs` / `base64` / `sh -c` / `bash -c`.
 */
export const posixDialect: ShellDialect = {
  flavor: "posix",
  split: splitByOperators,
  tokenize,
  decidable(segment: string): boolean {
    const { scrubbed, unbalanced } = scrubExpansions(segment);
    if (unbalanced || EXPANSION_PATTERNS.some((re) => re.test(scrubbed))) return false;
    const tokens = tokenize(segment);
    const { argv } = stripEnvAndWrappers(tokens.map((t) => t.text));
    return !opaqueCommand(argv);
  },
  normalize: stripEnvAndWrappers,
  analyzeSources,
  pathCandidate,
};
