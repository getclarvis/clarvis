import { splitFrontmatterFence } from "@clarvis/capability";
import { parse as parseYaml } from "yaml";
import { SkillError } from "./errors.ts";
import {
  skillDescriptionSchema,
  skillFrontmatterSchema,
  skillNameSchema,
  type SkillFrontmatter,
} from "./schema.ts";
import type { SkillDefaultedField } from "./types.ts";

/**
 * A `SKILL.md` split and validated: its typed {@link SkillFrontmatter} and the
 * trimmed body text below the fence. Returned by {@link parseSkill}.
 */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

/**
 * Values to stand in for the required catalog fields when a manifest carries no
 * usable one.
 *
 * @remarks
 * Supplied by the caller rather than invented here, because only the caller
 * knows the skill's directory and whatever presentation metadata travels beside
 * it. Nothing in this module decides what a skill *does*.
 */
export interface SkillFrontmatterDefaults {
  name: string;
  description: string;
}

/** A parsed manifest plus the required fields that had to be supplied for it. */
export interface ParsedSkillDocument extends ParsedSkill {
  defaulted: SkillDefaultedField[];
  /** Parsed YAML value before Clarvis supplies required catalog fields. */
  rawFrontmatter: unknown;
}

/** The required catalog fields, in the order a report lists them. */
const REQUIRED_FIELDS: readonly SkillDefaultedField[] = ["name", "description"];

/** Whether one required field's value satisfies the schema on its own. */
function fieldAccepted(field: SkillDefaultedField, value: unknown): boolean {
  const schema = field === "name" ? skillNameSchema : skillDescriptionSchema;
  return schema.safeParse(value).success;
}

/**
 * Fill in the required catalog fields a manifest does not usably carry.
 *
 * @param data - the raw frontmatter mapping.
 * @param defaults - the stand-in values; see {@link SkillFrontmatterDefaults}.
 * @returns the mapping with any missing field supplied, and the list of fields
 *   that were.
 * @remarks
 * A field whose value is present but unusable — a list where a string belongs,
 * a name carrying a path separator — is supplied too. The alternative is that
 * one field written in a dialect Clarvis does not read deletes the whole skill,
 * which is the failure mode the `agent` field was already given a
 * `.catch(undefined)` to avoid. The blast radius of an unreadable value stays
 * the value.
 */
function applyDefaults(
  data: unknown,
  defaults: SkillFrontmatterDefaults,
): { data: unknown; defaulted: SkillDefaultedField[] } {
  const record: Record<string, unknown> =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {};
  const defaulted: SkillDefaultedField[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (fieldAccepted(field, record[field])) continue;
    record[field] = defaults[field];
    defaulted.push(field);
  }
  return { data: record, defaulted };
}

/** The unvalidated result of {@link splitFrontmatter}: raw YAML value plus body. */
interface RawFrontmatter {
  data: unknown;
  body: string;
}

interface ParsedFrontmatterDocument extends RawFrontmatter {
  frontmatterChars: number;
}

/**
 * Split a `SKILL.md` into its raw frontmatter value and body, tolerating a
 * leading BOM/whitespace and both LF and CRLF fences.
 *
 * @param raw - the full file text.
 * @returns the parsed YAML `data` (an empty object when there is no fence or an
 *   empty fence) and the `body` following it. When no fence is present, `body`
 *   is the original `raw` untouched.
 * @throws {@link SkillError} `invalid_skill` if the text opens with `---` but has
 *   no matching closing fence, or if the YAML between the fences fails to parse.
 */
export function splitFrontmatter(raw: string): RawFrontmatter {
  const { data, body } = parseFrontmatterDocument(raw);
  return { data, body };
}

function parseFrontmatterDocument(raw: string): ParsedFrontmatterDocument {
  const fence = splitFrontmatterFence(raw);
  if (fence.kind === "unterminated") {
    throw new SkillError(
      "invalid_skill",
      "malformed YAML frontmatter (missing or misaligned closing '---' fence)",
    );
  }
  if (fence.kind === "absent") {
    return { data: {}, body: fence.body, frontmatterChars: 0 };
  }
  const yamlText = fence.frontmatter;
  let data: unknown;
  try {
    data = yamlText.trim().length === 0 ? {} : parseYaml(yamlText, { maxAliasCount: 32 });
  } catch (err) {
    const repaired = reparseFlatMapping(yamlText);
    if (repaired !== undefined) {
      return { data: repaired, body: fence.body, frontmatterChars: yamlText.length };
    }
    throw new SkillError(
      "invalid_skill",
      `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { data: data ?? {}, body: fence.body, frontmatterChars: yamlText.length };
}

/** One `key: value` line of a flat mapping, with nothing nested under it. */
const FLAT_ENTRY = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;

/**
 * A value YAML already reads as something other than a plain scalar, which must
 * be left exactly as written.
 */
const NON_PLAIN_VALUE = /^["'[{|>&*!]/;

/**
 * Re-read frontmatter that strict YAML rejected, treating each line's value as
 * the literal text its author typed.
 *
 * @param yamlText - the frontmatter that failed to parse.
 * @returns the recovered mapping, or `undefined` when the document is not a flat
 *   `key: value` list and so cannot be repaired this way.
 *
 * @remarks
 * A `description:` whose prose contains a colon — *"Five phases: detect, contain
 * …"* — is a plain scalar to its author and a nested mapping to a YAML parser,
 * which rejects it. The whole document then fails, and the skill disappears from
 * the catalog: total loss, from punctuation, with the author's own host reading
 * the file happily. Measured on a public catalog, seven of 1,822 skills were lost
 * to exactly this and nothing else.
 *
 * The repair is deliberately narrow. It runs **only** after a strict parse has
 * already failed, so it can never change how a valid document is read, and it
 * gives up unless every line is a simple `key: value` — the shape skill
 * frontmatter actually has. Anything YAML would treat as structure (a quoted or
 * flow value, a block scalar, an anchor, a list, an indented child) is either
 * preserved verbatim or disqualifies the document. Widening a tool restriction
 * is impossible here: the repair recovers the author's literal text, so
 * `allowed-tools` reads as written rather than as absent.
 */
function reparseFlatMapping(yamlText: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const line of yamlText.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const entry = FLAT_ENTRY.exec(line);
    if (entry === null) return undefined;
    const [, key, raw] = entry as unknown as [string, string, string];
    const value = raw.trim();
    if (value.length === 0) return undefined;
    if (NON_PLAIN_VALUE.test(value)) {
      let reparsed: unknown;
      try {
        reparsed = parseYaml(`v: ${value}`, { maxAliasCount: 32 }) as { v?: unknown };
      } catch {
        return undefined;
      }
      out[key] = (reparsed as { v?: unknown }).v;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateFrontmatter(data: unknown): SkillFrontmatter {
  const parsed = skillFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new SkillError("invalid_skill", issue.message, { at: issue.path.join(".") });
  }
  return parsed.data;
}

function assertFrontmatterChars(parsed: ParsedFrontmatterDocument, maxChars: number): void {
  if (parsed.frontmatterChars <= maxChars) return;
  throw new SkillError(
    "invalid_skill",
    `skill frontmatter exceeds the maximum characters (${String(maxChars)})`,
    { dimension: "characters", actual: parsed.frontmatterChars, maximum: maxChars },
  );
}

/**
 * Parse catalog metadata from a bounded manifest prefix, supplying any required
 * field the manifest does not usably carry.
 *
 * @param raw - the manifest prefix.
 * @param maxChars - the frontmatter character cap.
 * @param defaults - stand-ins for `name` and `description`.
 * @returns the validated frontmatter and the fields that were supplied.
 * @throws {@link SkillError} `invalid_skill` for a failure the defaults cannot
 *   repair — a malformed fence, unparseable YAML, an over-long frontmatter, or
 *   another field that fails validation.
 */
export function parseSkillFrontmatterWithDefaults(
  raw: string,
  maxChars: number,
  defaults: SkillFrontmatterDefaults,
): {
  frontmatter: SkillFrontmatter;
  defaulted: SkillDefaultedField[];
  rawFrontmatter: unknown;
} {
  const parsed = parseFrontmatterDocument(raw);
  assertFrontmatterChars(parsed, maxChars);
  const filled = applyDefaults(parsed.data, defaults);
  return {
    frontmatter: validateFrontmatter(filled.data),
    defaulted: filled.defaulted,
    rawFrontmatter: parsed.data,
  };
}

/**
 * Parse a complete manifest under the filesystem frontmatter cap, supplying any
 * required field it does not usably carry.
 *
 * @param raw - the complete manifest text.
 * @param maxChars - the frontmatter character cap.
 * @param defaults - stand-ins for `name` and `description`.
 * @returns the validated frontmatter, the trimmed body, and the supplied fields.
 */
export function parseSkillWithDefaults(
  raw: string,
  maxChars: number,
  defaults: SkillFrontmatterDefaults,
): ParsedSkillDocument {
  const parsed = parseFrontmatterDocument(raw);
  assertFrontmatterChars(parsed, maxChars);
  const filled = applyDefaults(parsed.data, defaults);
  return {
    frontmatter: validateFrontmatter(filled.data),
    body: parsed.body.trim(),
    defaulted: filled.defaulted,
    rawFrontmatter: parsed.data,
  };
}

/**
 * Parse and validate a full `SKILL.md` into a {@link ParsedSkill}.
 *
 * @param raw - the full file text.
 * @returns the validated {@link SkillFrontmatter} and the trimmed body.
 * @throws {@link SkillError} `invalid_skill` on a malformed fence, unparseable
 *   YAML, or frontmatter that fails {@link skillFrontmatterSchema} — the first
 *   schema issue's message is used, with its field path in `fields.at`.
 */
export function parseSkill(raw: string): ParsedSkill {
  const { data, body } = parseFrontmatterDocument(raw);
  return { frontmatter: validateFrontmatter(data), body: body.trim() };
}

/**
 * Normalize a frontmatter tool list into a clean string array.
 *
 * @param tools - an array, a comma-separated string, or `undefined`.
 * @returns the trimmed, non-empty entries; `[]` when `tools` is `undefined`. A
 *   string is split on commas; an array is taken as-is before trimming.
 */
export function normalizeTools(tools: string[] | string | undefined): string[] {
  if (tools === undefined) return [];
  const parts = Array.isArray(tools) ? tools : tools.split(",");
  return parts.map((t) => t.trim()).filter((t) => t.length > 0);
}
