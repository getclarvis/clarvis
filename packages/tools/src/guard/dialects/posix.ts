import type { PathCandidate, ShellDialect, Token } from "../dialect.ts";

/**
 * Build a pattern matching `name` only where a command word can appear: at the
 * start of a segment or after whitespace, optionally with a directory prefix.
 *
 * @param name - the command name, as a regex-safe literal.
 * @returns a {@link RegExp} that ignores the name inside a longer token.
 * @remarks
 * A bare `\benv\b` reads as "the `env` command" and in fact matches the `env` in
 * `.env` — a word boundary sits after the dot. That made `cat .env` undecidable,
 * which was merely noisy while undecidable meant `ask`, and becomes a wrong
 * refusal now that an unanalyzable command with a deny list configured is
 * denied. `source.txt`, `base64.py` and `my-app/exec.log` had the same problem.
 * A directory prefix is still honoured, so `/usr/bin/env FOO=1 sh` remains
 * undecidable.
 *
 * The leading boundary must accept shell punctuation, not only whitespace:
 * `splitByOperators` does not split inside parentheses, so `(sh -c "rm -rf /")`
 * arrives as one segment whose `sh` is preceded by `(`. Requiring `\s` there
 * made that subshell decidable and let it past the undecidable check entirely.
 */
const COMMAND_BOUNDARY = String.raw`(?:^|[\s(){};&|])`;

function commandWord(name: string): RegExp {
  return new RegExp(String.raw`${COMMAND_BOUNDARY}(?:\S*/)?${name}(?:\s|$)`);
}

const UNDECIDABLE_PATTERNS: RegExp[] = [
  /\$\(/,
  /`/,
  /\$\{?[A-Za-z_]/,
  commandWord("eval"),
  commandWord("exec"),
  commandWord("source"),
  commandWord("env"),
  commandWord("xargs"),
  commandWord("base64"),
  new RegExp(String.raw`${COMMAND_BOUNDARY}(?:\S*/)?sh\s+-c`),
  new RegExp(String.raw`${COMMAND_BOUNDARY}(?:\S*/)?bash\s+-c`),
  /<\(/,
  />\(/,
];

/**
 * A starter allow list for a POSIX host: the read-only and build commands of an
 * ordinary development loop.
 *
 * @remarks
 * This is a seed, not a policy: it is written into the user's settings once so
 * they can see and edit it, rather than compiled into the guard where it would
 * be an invisible default nobody could audit. Nothing here mutates the
 * workspace, and every entry still passes through the deny list, the undecidable
 * check and the confinement check first — a match only spares the approval
 * prompt.
 *
 * Entries name a subcommand, never a bare binary, because the guard matches a
 * space-boundary prefix: `git` would allow `git push --force`.
 *
 * Four omissions are deliberate, and each was a candidate:
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
  "git branch",
  "git remote -v",
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
  "bun test",
  "bun run build",
  "bun run lint",
  "bun run typecheck",
  "npm test",
  "npm run build",
  "cargo build",
  "cargo test",
  "go build",
  "go test",
  "dotnet build",
  "dotnet test",
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
 * `timeout 5 nice cmd` reduces to `cmd`.
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
  return { argv: tokens.slice(i), envAssignments };
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
 * `decidable` is `true` only when quotes are balanced and none of the
 * substitution / `eval` / `exec` / `source` / `sh -c` patterns survive
 * {@link scrubExpansions}.
 */
export const posixDialect: ShellDialect = {
  flavor: "posix",
  split: splitByOperators,
  tokenize,
  decidable(segment: string): boolean {
    const { scrubbed, unbalanced } = scrubExpansions(segment);
    return !unbalanced && !UNDECIDABLE_PATTERNS.some((re) => re.test(scrubbed));
  },
  normalize: stripEnvAndWrappers,
  pathCandidate,
};
