/**
 * One rule for a single redaction: a global pattern and what to put in place of
 * every match.
 */
interface RedactionRule {
  /** The pattern to search for; must carry the `g` flag. */
  re: RegExp;
  /** The replacement, which may reference capture groups. */
  replacement: string;
}

/**
 * The rules every caller applies, ahead of the key/value rules that differ:
 * PEM private-key blocks and `Bearer`/`Basic` authorization headers.
 */
const PRELUDE: readonly RedactionRule[] = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted-private-key]",
  },
  { re: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: "Bearer [redacted]" },
  { re: /Basic\s+[A-Za-z0-9+/]+=*/gi, replacement: "Basic [redacted]" },
];

/**
 * Header-shaped keys whose value is redacted whether or not it is quoted.
 *
 * @remarks A header's value is never ordinary prose, so consuming an unquoted
 *   run of non-space characters is safe here in a way it is not for the generic
 *   secret words below.
 */
const HEADER_KEYS: RedactionRule = {
  re: /(?<![?&])\b(authorization|x-api-key|api[-_]?key)\b\s*[:=]\s*(?!\[redacted\]|Bearer\b|Basic\b)\S+/gi,
  replacement: "$1: [redacted]",
};

/**
 * Generic secret words matched only against a **quoted** value.
 *
 * @remarks This is the difference between config and code. {@link TRACE_RULES}
 *   runs over every persisted tool argument and result, so `const token =
 *   getToken(req)` and `if (secret === x)` are ordinary content that an unquoted
 *   `[:=]` match rewrites into `const token: [redacted]`. Rehydration replays
 *   the persisted trace, so that corruption is what a restored session would
 *   show as the file's contents. A genuinely secret-bearing value in those
 *   positions is still caught by the JSON rule in {@link TAIL}, by the
 *   query-parameter rule, or by the sensitive-key walk in {@link sanitizeDeep}.
 */
const QUOTED_SECRET_WORDS: RedactionRule = {
  re: /(?<![?&])\b(password|passwd|pwd|token|secret)\b\s*[:=]\s*(?!\[redacted\])(["'])(?:(?!\2)[^\\]|\\.)*\2/gi,
  replacement: "$1: [redacted]",
};

/**
 * The header keys and the generic secret words folded into one alternation, all
 * matched against an unquoted value.
 *
 * @remarks Used by {@link TEXT_RULES} and deliberately **not** by
 *   {@link TRACE_RULES}. `@clarvis/memory` persists text no upstream sanitizer
 *   ever saw and is not replayed as a file's contents, so it trades the false
 *   positives {@link QUOTED_SECRET_WORDS} exists to avoid for reach over a short
 *   unquoted `token=abc`. Kept as the single combined rule rather than split in
 *   two, because two sequential rules redact overlapping matches differently
 *   from one alternation scanned in a single pass.
 */
const UNQUOTED_KEYS_AND_SECRET_WORDS: RedactionRule = {
  re: /(?<![?&])\b(authorization|x-api-key|api[-_]?key|password|passwd|pwd|token|secret)\b\s*[:=]\s*(?!\[redacted\]|Bearer\b|Basic\b)\S+/gi,
  replacement: "$1: [redacted]",
};

/**
 * The rules every caller applies after the key/value rules: sensitive JSON
 * keys, URL userinfo and query parameters, JWTs, and vendor key prefixes
 * (OpenAI `sk-`, Google `AIza`, AWS, GitHub, Slack).
 *
 * @remarks The URL-credential pattern's scheme group is length-bounded on
 *   purpose: an unbounded `*` before the required `://` backtracks from every
 *   start position, which makes it quadratic on a long unbroken token (a base64
 *   blob, a minified bundle) and stalls every path through the sanitizer. Real
 *   schemes are only a few characters.
 */
const TAIL: readonly RedactionRule[] = [
  {
    re: /"([^"]*(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|authorization|credential|access[_-]?key|refresh[_-]?token|private[_-]?key)[^"]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
    replacement: '"$1": "[redacted]"',
  },
  { re: /([a-z][a-z0-9+.-]{0,30}:\/\/)[^/\s@]+@/gi, replacement: "$1[redacted]@" },
  {
    re: /([?&][^&=\s#]*(?:password|pwd|secret|token|key|sig|auth|credential)[^&=\s#]*=)[^&\s#]+/gi,
    replacement: "$1[redacted]",
  },
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "[redacted-jwt]" },
  { re: /\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, replacement: "$1-[redacted]" },
  { re: /\bAIza[A-Za-z0-9_-]{16,}/g, replacement: "[redacted-google-key]" },
  { re: /\bA[KS]IA[0-9A-Z]{16}\b/g, replacement: "[redacted-aws-key]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[redacted-github-token]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted-github-token]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted-slack-token]" },
];

/**
 * Catch-all rule redacting any remaining unbroken token of 48+ base64url
 * characters, run last to blunt high-entropy secrets the named rules miss.
 *
 * @remarks Deliberately *not* applied by {@link sanitizeToolPayload}. It cannot
 *   tell a secret from any other long unbroken token, and a tool payload is full
 *   of them — a base64-encoded image, a line of minified JavaScript in a diff, a
 *   lockfile integrity hash. Redacting those does not protect anything and makes
 *   the trace useless for the debugging it exists for.
 */
const COARSE_FALLBACK: RedactionRule = {
  re: /\b[A-Za-z0-9_-]{48,}={0,2}\b/g,
  replacement: "[redacted]",
};

/**
 * The rule set for content that is replayed verbatim — a trace's tool arguments
 * and results, a run's request and response.
 */
const TRACE_RULES: readonly RedactionRule[] = [
  ...PRELUDE,
  HEADER_KEYS,
  QUOTED_SECRET_WORDS,
  ...TAIL,
];

/** {@link TRACE_RULES} plus the catch-all, for content that is only ever read. */
const TRACE_RULES_COARSE: readonly RedactionRule[] = [...TRACE_RULES, COARSE_FALLBACK];

/**
 * The rule set for free text bound for the LLM or the disk, which trades false
 * positives for reach. See {@link UNQUOTED_KEYS_AND_SECRET_WORDS}.
 */
const TEXT_RULES: readonly RedactionRule[] = [
  ...PRELUDE,
  UNQUOTED_KEYS_AND_SECRET_WORDS,
  ...TAIL,
  COARSE_FALLBACK,
];

/**
 * Applies each rule to `message` in order, threading the result of one
 * substitution into the next.
 *
 * @param message - the input string.
 * @param rules - the redaction rules to apply, in order.
 * @returns the string with every rule applied.
 * @remarks The rule arrays are built once at module load rather than per call.
 *   These entry points run on every string of every mapped trace event and on a
 *   run's whole request and response at insert — the hottest allocation in a
 *   path that already rewrites each string a dozen times.
 */
function apply(message: string, rules: readonly RedactionRule[]): string {
  let out = message;
  for (const { re, replacement } of rules) out = out.replace(re, replacement);
  return out;
}

/**
 * Redacts secrets from an error message before it is traced or logged.
 *
 * @param message - the raw error text.
 * @returns the text with {@link TRACE_RULES} and {@link COARSE_FALLBACK}
 *   applied.
 * @remarks An error message is short and its long tokens are overwhelmingly
 *   secrets, so the coarse rule earns its false positives here in a way it does
 *   not in {@link sanitizeToolPayload}.
 */
export function sanitizeErrorMessage(message: string): string {
  return apply(message, TRACE_RULES_COARSE);
}

/**
 * Redacts secrets from a tool call's arguments or result before it is persisted
 * to the trace.
 *
 * @param message - the raw payload text.
 * @returns the text with {@link TRACE_RULES} applied, and deliberately without
 *   {@link COARSE_FALLBACK}.
 */
export function sanitizeToolPayload(message: string): string {
  return apply(message, TRACE_RULES);
}

/**
 * Redacts secrets from free text bound for the LLM or the disk.
 *
 * @param text - arbitrary text.
 * @returns the text with {@link TEXT_RULES} applied.
 * @remarks The last line of defense for a store that persists text no upstream
 *   sanitizer saw (model outputs, owner notes), so it runs even when the host
 *   already sanitizes its traces.
 */
export function sanitizeText(text: string): string {
  return apply(text, TEXT_RULES);
}

/**
 * Case-insensitive test for object keys whose associated string value is a
 * secret, used by {@link sanitizeDeep} to redact by key name.
 */
const SENSITIVE_KEY =
  /authorization|api[_-]?key|apikey|secret|token|password|passwd|pwd|credential|private[_-]?key|access[_-]?key/i;

/**
 * Recursively redacts secrets from an arbitrary JSON-like value, walking arrays
 * and plain objects.
 *
 * @param value - any value; strings are redacted, arrays and plain objects are
 *   traversed, and everything else is returned unchanged.
 * @param redact - the string redactor to apply, defaulting to
 *   {@link sanitizeToolPayload}. Pass {@link sanitizeText} for content that is
 *   read rather than replayed.
 * @returns a structurally identical value with secrets redacted. A non-empty
 *   string held under a {@link SENSITIVE_KEY | sensitive} key is fully replaced
 *   with `"[redacted]"` when `redact` leaves it unchanged, otherwise the
 *   redacted form is kept.
 * @remarks The sensitive-key branch is what still catches a secret whose *shape*
 *   no rule recognizes.
 */
export function sanitizeDeep<T>(
  value: T,
  redact: (text: string) => string = sanitizeToolPayload,
): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((entry: unknown) => sanitizeDeep(entry, redact)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0 && SENSITIVE_KEY.test(k)) {
        const named = redact(v);
        out[k] = named === v ? "[redacted]" : named;
      } else {
        out[k] = sanitizeDeep(v, redact);
      }
    }
    return out as T;
  }
  return value;
}
