import { parse as parseYaml } from "yaml";
import { readBoundedText } from "./bounded-read.ts";
import { causeOf, DEFAULT_DIAGNOSTICS, warn, type SkillDiagnostics } from "./lib/log.ts";
import {
  MAX_SKILL_ICON_PATH_CHARS,
  MAX_SKILL_LABEL_CHARS,
  MAX_SKILL_SHORT_DESCRIPTION_CHARS,
  MAX_SKILL_SIDECAR_BYTES,
  MAX_SKILL_SIDECAR_CHARS,
  MAX_SKILL_STARTER_PROMPT_CHARS,
} from "./limits.ts";
import type { SkillIcons, SkillPresentation, SkillToolDependency } from "./types.ts";

/**
 * What a harness-directed sidecar contributes to a skill: presentation metadata,
 * MCP tool dependencies, and the catalog-suppression axis.
 *
 * @remarks
 * These fields are read by the harness and are never rendered verbatim to the
 * model. The two gating axes stay separate: `catalogSuppressed` withholds the
 * skill from the catalog injected into a run's context while leaving it
 * explicitly loadable, whereas frontmatter's `user-invocable` filters the slash
 * listing a user sees. Dependencies filter implicit availability without
 * changing either axis.
 */
export interface SkillSidecar {
  presentation?: SkillPresentation;
  dependencies?: SkillToolDependency[];
  /** Whether the skill is withheld from the model-facing catalog. */
  catalogSuppressed: boolean;
}

const MAX_SKILL_TOOL_DEPENDENCIES = 64;
const MAX_SKILL_DEPENDENCY_VALUE_CHARS = 256;

function readToolDependencies(root: Record<string, unknown>): SkillToolDependency[] | undefined {
  const dependencies = root.dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    return undefined;
  }
  const tools = (dependencies as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return undefined;
  const parsed = tools.slice(0, MAX_SKILL_TOOL_DEPENDENCIES).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (record.type !== "mcp") return [];
    const value = boundedText(record.value, MAX_SKILL_DEPENDENCY_VALUE_CHARS);
    if (value === undefined) return [];
    const description = boundedText(record.description, MAX_SKILL_SHORT_DESCRIPTION_CHARS);
    const transport = boundedText(record.transport, MAX_SKILL_LABEL_CHARS);
    const url = boundedText(record.url, MAX_SKILL_DEPENDENCY_VALUE_CHARS);
    return [
      {
        type: "mcp" as const,
        value,
        ...(description === undefined ? {} : { description }),
        ...(transport === undefined ? {} : { transport }),
        ...(url === undefined ? {} : { url }),
      },
    ];
  });
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Key spellings accepted for each presentation and policy concept.
 *
 * @remarks
 * The sidecar is a foreign dialect, so every concept is matched by shape rather
 * than by one canonical spelling: the same field is written kebab-cased,
 * snake-cased and camel-cased by different producers, and a reader that admits
 * only one of the three silently drops the value.
 */
const DISPLAY_NAME_KEYS = ["display-name", "display_name", "displayName", "title"] as const;
const SHORT_DESCRIPTION_KEYS = [
  "short-description",
  "short_description",
  "shortDescription",
  "summary",
] as const;
const ICON_KEYS = ["icon", "icons"] as const;
const SIZED_ICON_KEYS = [
  "icon-small",
  "icon_small",
  "iconSmall",
  "icon-large",
  "icon_large",
  "iconLarge",
] as const;
const COLOR_KEYS = ["color", "colour", "brand-color", "brand_color", "brandColor"] as const;
const STARTER_PROMPT_KEYS = [
  "default-prompt",
  "default_prompt",
  "defaultPrompt",
  "starter-prompt",
  "starter_prompt",
  "starterPrompt",
] as const;
const PRESENTATION_KEYS = ["interface", "presentation", "display", "ui"] as const;
const POLICY_KEYS = ["policy", "invocation"] as const;
const IMPLICIT_INVOCATION_KEYS = [
  "allow-implicit-invocation",
  "allow_implicit_invocation",
  "allowImplicitInvocation",
  "implicit-invocation",
  "implicit_invocation",
  "implicitInvocation",
] as const;
const HIDE_FROM_CATALOG_KEYS = [
  "hide-from-catalog",
  "hide_from_catalog",
  "hideFromCatalog",
  "hidden",
] as const;

/** A hex colour, in the three- or six-digit form; anything else is not a colour we can render. */
const COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A Windows drive-letter prefix, which makes an "icon path" absolute rather than skill-relative. */
const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Read the first value present under any accepted spelling of one concept.
 *
 * @param record - the mapping to probe.
 * @param keys - the accepted spellings, in descending preference.
 * @returns the first non-null value found, or `undefined`.
 */
function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Accept a bounded, non-blank string, discarding anything else.
 *
 * @param value - the raw sidecar value.
 * @param maxChars - the cap beyond which the value is discarded rather than
 *   truncated, so a presentation field can never silently become a prefix of
 *   what its author wrote.
 * @returns the trimmed string, or `undefined`.
 */
function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return undefined;
  return trimmed;
}

/**
 * Accept a skill-relative asset path, discarding any that could address a file
 * outside the skill directory.
 *
 * @param value - the raw sidecar value.
 * @returns a normalized POSIX-style relative path, or `undefined` when the value
 *   is absent, unbounded, absolute, drive-qualified, backslash-separated, or
 *   contains a `..` segment.
 * @remarks Presentation data is still a path a UI will open, so it is bound by
 *   the same confinement rule bundled resources are: this rejects the escape
 *   rather than resolving it, because the reader has no filesystem to check
 *   against and a rejected icon costs only an icon.
 */
function assetPath(value: unknown): string | undefined {
  const raw = boundedText(value, MAX_SKILL_ICON_PATH_CHARS);
  if (raw === undefined) return undefined;
  if (raw.startsWith("/") || raw.includes("\\") || DRIVE_PREFIX.test(raw)) return undefined;
  const segments = raw.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return undefined;
  return segments.join("/");
}

/**
 * Read the icon paths a sidecar declares, in either the single-path or the
 * per-theme form.
 *
 * @param value - the raw `icon`/`icons` value.
 * @returns the theme-keyed paths, or `undefined` when neither theme resolves to
 *   a confined relative path.
 * @remarks A bare string serves both themes: an author who supplied one icon
 *   meant it to be used, and leaving the dark slot empty would make a UI fall
 *   back to no icon at all on half its themes.
 */
function readIcons(value: unknown): SkillIcons | undefined {
  if (typeof value === "string") {
    const single = assetPath(value);
    return single === undefined ? undefined : { light: single, dark: single };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const light = assetPath(pick(record, ["light", "default"]));
  const dark = assetPath(record["dark"]);
  if (light === undefined && dark === undefined) return undefined;
  return {
    ...(light === undefined ? {} : { light }),
    ...(dark === undefined ? {} : { dark }),
  };
}

/** Accept a hex brand colour, lower-cased, discarding any other notation. */
function readColor(value: unknown): string | undefined {
  const raw = boundedText(value, MAX_SKILL_LABEL_CHARS);
  if (raw === undefined) return undefined;
  return COLOR_PATTERN.test(raw) ? raw.toLowerCase() : undefined;
}

/**
 * A nested mapping under any accepted spelling, or an empty one when absent.
 *
 * @param root - the sidecar's top-level mapping.
 * @param keys - the accepted spellings of the block, in descending preference.
 * @returns the nested mapping, or `{}` when the sidecar declares none.
 */
function nestedBlock(
  root: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const value = pick(root, keys);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Read the first boolean present under any accepted spelling of one concept. */
function readBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  const value = pick(record, keys);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Decide whether the sidecar withholds its skill from the model-facing catalog.
 *
 * @param root - the sidecar's top-level mapping.
 * @returns true when the sidecar opts out of implicit invocation or asks to be
 *   hidden; false when it says nothing about either.
 * @remarks The policy block is consulted first and the top level second, because
 *   producers write the same two flags in both places. The first block that
 *   mentions either concept decides, so a nested `true` is not overturned by an
 *   unrelated top-level key.
 */
function readCatalogSuppressed(root: Record<string, unknown>): boolean {
  for (const block of [nestedBlock(root, POLICY_KEYS), root]) {
    const implicit = readBoolean(block, IMPLICIT_INVOCATION_KEYS);
    if (implicit !== undefined) return !implicit;
    const hidden = readBoolean(block, HIDE_FROM_CATALOG_KEYS);
    if (hidden !== undefined) return hidden;
  }
  return false;
}

/**
 * Read the presentation bucket, or `undefined` when the sidecar carries none of it.
 *
 * @param root - the sidecar's top-level mapping.
 * @returns the presentation parts the sidecar declares.
 * @remarks Producers nest these fields under a presentation block far more often
 *   than they write them at the top level, so the block is consulted first and
 *   the root is the fallback. Each field falls back independently: a sidecar that
 *   nests a display name and writes a colour beside the block yields both.
 *
 *   Sized icon keys are read only as a last resort, and as a *single* icon
 *   serving both themes. Size and theme are different axes, so binding a small
 *   icon to the light slot and a large one to the dark slot would render a
 *   plausible-looking lie; the smaller asset is preferred because the surfaces
 *   that show a skill icon are list rows.
 */
function readPresentation(root: Record<string, unknown>): SkillPresentation | undefined {
  const block = nestedBlock(root, PRESENTATION_KEYS);
  const from = (keys: readonly string[]): unknown => pick(block, keys) ?? pick(root, keys);
  const displayName = boundedText(from(DISPLAY_NAME_KEYS), MAX_SKILL_LABEL_CHARS);
  const shortDescription = boundedText(
    from(SHORT_DESCRIPTION_KEYS),
    MAX_SKILL_SHORT_DESCRIPTION_CHARS,
  );
  const icons = readIcons(from(ICON_KEYS)) ?? readIcons(from(SIZED_ICON_KEYS));
  const color = readColor(from(COLOR_KEYS));
  const starterPrompt = boundedText(from(STARTER_PROMPT_KEYS), MAX_SKILL_STARTER_PROMPT_CHARS);
  return composePresentation({ displayName, shortDescription, icons, color, starterPrompt });
}

/**
 * Assemble a {@link SkillPresentation} from optional parts, collapsing to
 * `undefined` when every part is absent so consumers can test the bucket itself.
 */
export function composePresentation(parts: {
  displayName?: string | undefined;
  shortDescription?: string | undefined;
  icons?: SkillIcons | undefined;
  color?: string | undefined;
  starterPrompt?: string | undefined;
}): SkillPresentation | undefined {
  const presentation: SkillPresentation = {
    ...(parts.displayName === undefined ? {} : { displayName: parts.displayName }),
    ...(parts.shortDescription === undefined ? {} : { shortDescription: parts.shortDescription }),
    ...(parts.icons === undefined ? {} : { icons: parts.icons }),
    ...(parts.color === undefined ? {} : { color: parts.color }),
    ...(parts.starterPrompt === undefined ? {} : { starterPrompt: parts.starterPrompt }),
  };
  return Object.keys(presentation).length > 0 ? presentation : undefined;
}

/**
 * Load and parse one harness-directed sidecar.
 *
 * @param file - the sidecar's absolute path.
 * @param diagnostics - where a degradation notice and a `skill.sidecar_invalid`
 *   record are reported.
 * @returns the sidecar's contribution, or `undefined` when the file cannot be
 *   read, is not valid YAML, or is not a YAML mapping.
 * @remarks Nothing here throws. An unreadable or malformed sidecar degrades to
 *   "no sidecar" and must never remove the skill that carries it — the same rule
 *   the frontmatter `agent` field follows, and for the same reason: the blast
 *   radius of a value written in a dialect we do not parse has to stay the value,
 *   never the artifact.
 */
export function readSkillSidecar(
  file: string,
  diagnostics: SkillDiagnostics = DEFAULT_DIAGNOSTICS,
): SkillSidecar | undefined {
  const root = loadSidecarDocument(file, diagnostics);
  if (root === undefined) return undefined;
  const presentation = readPresentation(root);
  const dependencies = readToolDependencies(root);
  return {
    ...(presentation === undefined ? {} : { presentation }),
    ...(dependencies === undefined ? {} : { dependencies }),
    catalogSuppressed: readCatalogSuppressed(root),
  };
}

/**
 * Read the sidecar file into its top-level mapping, warning and yielding
 * `undefined` otherwise.
 *
 * @remarks The read and the parse are caught separately so the emitted `reason`
 *   distinguishes a file the harness could not get at from one whose author
 *   wrote invalid YAML — the two need different fixes, and the shared prose
 *   warning calls both "unreadable".
 */
function loadSidecarDocument(
  file: string,
  diagnostics: SkillDiagnostics,
): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readBoundedText(file, {
      maxBytes: MAX_SKILL_SIDECAR_BYTES,
      maxChars: MAX_SKILL_SIDECAR_CHARS,
      code: "invalid_input",
      label: "skill sidecar",
      logger: diagnostics.logger,
    });
  } catch (error) {
    return rejectSidecar(file, "unreadable", error, diagnostics);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, { maxAliasCount: 32 });
  } catch (error) {
    return rejectSidecar(file, "unparseable", error, diagnostics);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(
      `clarvis-skills: ignoring skill sidecar ${file}: expected a mapping of fields\n`,
      diagnostics.warningSink,
    );
    diagnostics.logger.warn(
      { event: "skill.sidecar_invalid", file, reason: "not_a_mapping" },
      "a skill's harness sidecar is not a mapping; the skill loads without its " +
        "presentation metadata and without catalog suppression",
    );
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** Why a sidecar contributed nothing. */
type SidecarRejection = "unreadable" | "unparseable" | "not_a_mapping";

/**
 * Report a sidecar that could not be turned into a mapping and yield "no sidecar".
 *
 * @param file - the sidecar's path.
 * @param reason - which step failed.
 * @param error - the caught failure, reduced to its message.
 * @param diagnostics - the two destinations.
 * @returns always `undefined`, so a caller can `return` this directly.
 */
function rejectSidecar(
  file: string,
  reason: Exclude<SidecarRejection, "not_a_mapping">,
  error: unknown,
  diagnostics: SkillDiagnostics,
): undefined {
  warn(
    `clarvis-skills: ignoring unreadable skill sidecar ${file}: ${causeOf(error)}\n`,
    diagnostics.warningSink,
  );
  diagnostics.logger.warn(
    { event: "skill.sidecar_invalid", file, reason, cause: causeOf(error) },
    "a skill's harness sidecar could not be read; the skill loads without its " +
      "presentation metadata and without catalog suppression",
  );
  return undefined;
}
