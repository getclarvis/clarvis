import { fuzzyScore } from "../../core/fuzzy.ts";
export interface CompleteItem {
  label: string;
  detail?: string;
  value: string;
  insert?: string;
  /** Human-readable section label rendered as a header above this row when it starts a new group. */
  group?: string;
}

export interface CompleteProvider {
  id: string;
  trigger: string;
  label: string;
  /**
   * "hint" providers are display-only: the popup shows their items but claims
   * no keys, so Enter still submits the line and Up/Down still walk history.
   */
  kind?: "completion" | "hint";
  query: (term: string) => CompleteItem[];
  onAccept?: (item: CompleteItem) => void;
}

/** A recognized trigger prefix at the end of the input, plus the term typed after it. */
export interface TriggerHit {
  trigger: string;
  term: string;
}

function scanLastToken(text: string, triggers: readonly string[]): TriggerHit | null {
  const lastToken = text.split(/\s/).pop() ?? "";
  const trigger = triggers.find(
    (t) => !t.startsWith("/") && t.length > 0 && lastToken.startsWith(t),
  );
  if (!trigger) return null;
  return { trigger, term: lastToken.slice(trigger.length) };
}

/**
 * Finds the active completion trigger at the end of `text`, if any.
 *
 * @remarks
 * `/` is special-cased: a bare leading slash with no following whitespace is
 * always a slash-command trigger, while `/name arg…` first checks whether the
 * argument tail itself starts a non-slash trigger (e.g. a mention inside a
 * slash command's arguments) before falling back to treating `/name` as the
 * trigger for the whole remainder.
 */
export function detectTrigger(text: string, triggers: readonly string[]): TriggerHit | null {
  if (text.length === 0) return null;
  if (triggers.includes("/") && text.startsWith("/")) {
    const rest = text.slice(1);
    const compound = /^(\S+)\s+([\s\S]*)$/.exec(rest);
    if (compound) {
      const scanned = scanLastToken(text, triggers);
      if (scanned) return scanned;
      const head = "/" + compound[1]!;
      if (triggers.includes(head)) return { trigger: head, term: compound[2]! };
      return null;
    }
    if (/\s/.test(rest)) return null;
    return { trigger: "/", term: rest };
  }
  return scanLastToken(text, triggers);
}

/**
 * Positional mapping of a slash line's argument tail onto `count` declared
 * arguments: each argument takes one whitespace-separated token, the last one
 * takes the whole remainder (so a final free-text argument keeps its spaces).
 */
export function splitSlashArgs(raw: string, count: number): string[] {
  const text = raw.trim();
  if (text.length === 0 || count <= 0) return [];
  if (count === 1) return [text];
  const parts: string[] = [];
  let rest = text;
  while (parts.length < count - 1 && rest.length > 0) {
    const token = /^\S+/.exec(rest)![0];
    parts.push(token);
    rest = rest.slice(token.length).trimStart();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/** Splits a `/name args…` line into its command name and trimmed argument tail. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}

/** The text to insert into the prompt when a slash-command completion is accepted. */
export function slashCompletion(label: string): string {
  return label.trimEnd();
}

/** How a submitted `/name` line should be dispatched. */
export type SlashSubmit =
  | { kind: "skill"; agent: string }
  | { kind: "command"; command: string }
  | { kind: "unknown" }
  | { kind: "chat" };

/**
 * Classifies a slash line's command name against the registered command and
 * skill catalogs, in that order, falling back to plain chat when the name
 * doesn't even look like a command.
 *
 * @remarks
 * Registered commands own their slash tokens. This keeps an agent-backed skill
 * with the same name from shadowing a built-in that the completion popup
 * advertised. A skill fallback is dispatched as a run only when it names an
 * agent, so `skillAgent` both decides that branch and supplies its payload.
 * Returning the name here rather than a boolean spares the caller a second
 * lookup it could get a different answer from.
 */
export function classifySlashSubmit(
  name: string,
  opts: {
    skillAgent: (name: string) => string | undefined;
    findCommand: (slash: string) => string | undefined;
  },
): SlashSubmit {
  if (!/^[A-Za-z][\w:.-]*$/.test(name)) return { kind: "chat" };
  const command = opts.findCommand("/" + name);
  if (command !== undefined) return { kind: "command", command };
  const agent = opts.skillAgent(name);
  if (agent !== undefined) return { kind: "skill", agent };
  return { kind: "unknown" };
}

/** Extracts the shell command from a `!command` line, or `null` if the line isn't one. */
export function parseBangCommand(text: string): string | null {
  const m = /^\s*!([\s\S]*)$/.exec(text);
  return m ? m[1]!.trim() : null;
}

/** Replaces the in-progress mention token at the end of `text` with `trigger + insert`, plus a trailing space. */
export function acceptMention(text: string, trigger: string, insert: string): string {
  const token = /\S*$/.exec(text);
  const cut = token?.index ?? text.length;
  return text.slice(0, cut) + trigger + insert + " ";
}

/** Clamps `index` into `[0, length - 1]`, or `0` when `length` is non-positive. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}

/**
 * Whether a typed `/`-token names this command, for the composer's popup.
 *
 * @param slashes - the command's own slash tokens, each including its leading `/`.
 * @param term - what the user has typed after the `/`, untrimmed.
 * @returns `true` while browsing (an empty term), and otherwise only when the
 *   term fuzzy-matches one of the tokens.
 * @remarks The command registry may rank over title and name as well as the slash
 *   token on browsing surfaces. In the composer the typed token *is* the identifier and Enter
 *   commits the top row unseen, so a title-only subsequence hit means a typo
 *   stages a command the user never named: `/hlep`, a transposition of the
 *   most-typed command in the product, staged `/plan-review`, which writes
 *   `<ws>/.clarvis/settings.json` and changes the workspace's planning policy
 *   with no confirmation.
 *
 *   Scoping the composer to the tokens closes the class. Fixing collisions one
 *   at a time does not: the `/mcp` → `/compact` instance was fixed on its own
 *   and this mechanism promptly produced the same defect twice more.
 */
export function slashTokenMatches(slashes: readonly string[], term: string): boolean {
  const typed = term.trim().toLowerCase().replace(/^\/+/, "");
  if (typed.length === 0) return true;
  return slashes.some((slash) => fuzzyScore(slash.replace(/^\/+/, ""), typed) !== null);
}
