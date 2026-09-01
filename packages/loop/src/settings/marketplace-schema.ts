import { z } from "zod";
import { editDistance, typoBudget } from "./typo-suggestion.ts";
import { pluginNameField } from "./settings-schema.ts";

/**
 * The largest number of listings a marketplace document contributes; anything
 * beyond it is truncated with a note rather than failing the catalog.
 */
const MAX_LISTINGS = 1_000;

/** The largest number of notes a reading reports before summarizing the rest. */
const MAX_NOTES = 40;

/** How many unrecognized key names one note spells out before eliding the rest. */
const MAX_LISTED_KEYS = 20;

/** Display name supplied for a catalog whose document does not author one. */
const DEFAULT_MARKETPLACE_NAME = "unnamed marketplace";

/** Description supplied for a listing whose document does not author one. */
const DEFAULT_ENTRY_DESCRIPTION = "no description provided by this marketplace";

/** A non-empty string, the smallest field shape this document uses. */
const nonEmptyString = z.string().min(1);

/**
 * Whether a path stays inside the tree it is resolved against.
 *
 * @param value - the candidate relative path, in POSIX spelling.
 * @returns `true` when it has no leading `/`, no `..` segment and no backslash.
 */
function isRelativeSubpath(value: string): boolean {
  return !value.startsWith("/") && !value.includes("\\") && !/(^|\/)\.\.(\/|$)/.test(value);
}

/** A path that must resolve inside the tree it is read from; see {@link isRelativeSubpath}. */
const relativeSubpathField = nonEmptyString
  .refine(
    isRelativeSubpath,
    "must be a relative POSIX subdirectory (no leading '/', no '..', no backslashes)",
  )
  .describe(
    "Subdirectory within the source that holds this plugin's manifest. Omit for a plugin at " +
      "the root; set it so one source can ship several plugins.",
  );

/**
 * A source expressed as an object rather than a bare string: a `source`
 * discriminator naming how the plugin is obtained, plus whatever that kind needs.
 *
 * @remarks `.loose()`, and the discriminator is read tolerantly — a kind this
 *   host has no fetcher for degrades the listing with a note instead of failing
 *   the document.
 */
const sourceDescriptorSchema = z
  .object({
    source: nonEmptyString.describe("How the plugin is obtained, e.g. 'local'."),
    path: nonEmptyString.optional().describe("Where the plugin sits, for a kind that has a path."),
    url: nonEmptyString.optional(),
    ref: nonEmptyString.max(512).optional(),
    sha: z
      .string()
      .regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/)
      .optional(),
    package: nonEmptyString.max(214).optional(),
    version: nonEmptyString.max(256).optional(),
    registry: nonEmptyString.max(2_048).optional(),
  })
  .loose();

/** A listing's `source`: a URL string, a relative local path, or a descriptor object. */
const entrySourceField = z.union([nonEmptyString, sourceDescriptorSchema]);

/** A source string carrying an explicit transport, e.g. `https://` or `ssh://`. */
const TRANSPORT_SOURCE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** A source string in scp-like ssh spelling, e.g. `user@host:path`. */
const SSH_SOURCE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/;

/** A source naming a local filesystem path rather than a Git transport. */
const LOCAL_GIT_PATH_RE = /^(?:[.~]{1,2}[/\\]|\/|[A-Za-z]:[/\\])/;

/**
 * Return why a Git source cannot cross the marketplace/install boundary.
 *
 * @remarks Shared by the tolerant marketplace reader and strict kernel
 * installer so the UI never offers an action the kernel will deterministically
 * reject.
 */
export function pluginGitUrlIssue(raw: string): string | undefined {
  const url = raw.trim();
  if (url.length === 0) return "a git URL is required";
  if (url.startsWith("-")) {
    return `refusing '${url}': a URL starting with '-' would be read by git as a flag`;
  }
  if (/ext::/i.test(url))
    return `refusing '${url}': git's ext:: transport runs an arbitrary command`;
  if (LOCAL_GIT_PATH_RE.test(url)) {
    return (
      `refusing '${url}': that names a local path, and Clarvis installs a plugin from git. ` +
      "Use https://, ssh (user@host:path), or file:// for a local checkout."
    );
  }
  if (/^(?:http|git):\/\//i.test(url)) {
    return (
      `refusing '${url}': ${url.slice(0, url.indexOf(":"))}:// is unauthenticated cleartext, so ` +
      "anyone on the path can swap the code you are about to install. Use https:// or ssh."
    );
  }
  const ssh = /^(?:ssh:\/\/)?[A-Za-z0-9._-]+@[A-Za-z0-9._-]+[:/][A-Za-z0-9._~/-]+$/;
  if (/^(?:https|file):\/\//i.test(url) || ssh.test(url)) return undefined;
  return `refusing '${url}': install from https://, ssh (user@host:path), or file:// for a local checkout`;
}

/** Return why a Git ref/SHA selector cannot be passed to the installer. */
export function pluginGitSelectorIssue(selector: {
  ref?: string;
  sha?: string;
}): string | undefined {
  if (selector.ref !== undefined && selector.sha !== undefined) {
    return "a plugin source cannot declare both ref and sha";
  }
  if (
    selector.ref !== undefined &&
    (selector.ref.length > 512 ||
      selector.ref.startsWith("-") ||
      /[\0-\x20~^:?*\\]/.test(selector.ref) ||
      selector.ref.includes("..") ||
      selector.ref.includes("@{"))
  ) {
    return "invalid plugin git ref";
  }
  if (selector.sha !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(selector.sha)) {
    return "invalid plugin git sha";
  }
  return undefined;
}

/** Return why an npm source cannot be handed to the script-free package fetcher. */
export function pluginNpmSourceIssue(source: {
  package: string;
  version?: string;
  registry?: string;
}): string | undefined {
  if (
    !/^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i.test(
      source.package,
    )
  ) {
    return "invalid npm plugin package name";
  }
  if (
    source.version !== undefined &&
    (source.version.length > 256 ||
      source.version.startsWith("-") ||
      /[\0\r\n/\\]/.test(source.version) ||
      source.version.includes("://"))
  ) {
    return "invalid npm plugin version";
  }
  if (source.registry !== undefined) {
    let registry: URL;
    try {
      registry = new URL(source.registry);
    } catch {
      return "invalid npm registry URL";
    }
    if (
      registry.protocol !== "https:" ||
      registry.username !== "" ||
      registry.password !== "" ||
      registry.search !== "" ||
      registry.hash !== ""
    ) {
      return "npm registries must use HTTPS without embedded credentials";
    }
  }
  return undefined;
}

/** The keys {@link readEntry} gives meaning to. */
const KNOWN_ENTRY_KEYS: ReadonlySet<string> = new Set([
  "name",
  "source",
  "path",
  "description",
  "homepage",
  "displayName",
  "category",
  "policy",
  "interface",
]);

/** The keys {@link readMarketplaceDocument} gives meaning to. */
const KNOWN_ROOT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "displayName",
  "plugins",
]);

/**
 * Keys of `document` that `known` does not recognize, sorted.
 *
 * @param document - a JSON-parsed object, before or after validation.
 * @param known - the keys this reader acts on.
 * @returns the unrecognized key names; empty for a non-object input.
 */
function unknownKeys(document: unknown, known: ReadonlySet<string>): string[] {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return [];
  return Object.keys(document)
    .filter((key) => !known.has(key))
    .sort();
}

/**
 * Notes for the keys of `document` this reader does not act on: one line listing
 * them, and one line per key that looks like a misspelling of a key it does.
 *
 * @param document - a JSON-parsed object.
 * @param known - the keys this reader acts on.
 * @param where - how the note names the document, e.g. `"listing 'docs'"`.
 * @returns zero, one or two note lines.
 * @remarks Both the listed keys and the per-key suggestions are bounded. A note
 *   list is rendered whole by the UI, and the keys come from a document Clarvis
 *   did not write, so an unbounded join is as much a denial of service as an
 *   unbounded count.
 */
function foreignKeyNotes(document: unknown, known: ReadonlySet<string>, where: string): string[] {
  const foreign = unknownKeys(document, known);
  if (foreign.length === 0) return [];
  const listed = foreign.slice(0, MAX_LISTED_KEYS);
  const elided = foreign.length - listed.length;
  const names = listed.join(", ") + (elided > 0 ? ` (+${String(elided)} more)` : "");
  const notes = [`${where}: keys Clarvis does not act on: ${names}`];
  for (const key of listed) {
    const limit = typoBudget(key);
    let best: { suggestion: string; distance: number } | undefined;
    for (const candidate of known) {
      const distance = editDistance(key.toLowerCase(), candidate.toLowerCase(), limit);
      if (distance <= limit && (best === undefined || distance < best.distance)) {
        best = { suggestion: candidate, distance };
      }
    }
    if (best !== undefined) {
      notes.push(`${where}: '${key}' looks like a misspelling of '${best.suggestion}'`);
    }
  }
  return notes;
}

/** Read one field with a schema, reporting a note instead of failing the document. */
function readField<T>(
  value: unknown,
  schema: z.ZodType<T>,
  where: string,
  field: string,
  notes: string[],
): T | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  notes.push(`${where}: '${field}' was ignored — ${issueSummary(parsed.error)}`);
  return undefined;
}

/**
 * A one-line summary of a validation failure.
 *
 * @param error - the failure to summarize.
 * @returns the first two issues, with a `(+N more)` suffix when there are more.
 */
function issueSummary(error: z.ZodError): string {
  const issues = error.issues.slice(0, 2).map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - issues.length;
  return issues.join("; ") + (more > 0 ? ` (+${more} more)` : "");
}

/** Presentation keys a foreign dialect may carry a one-line summary under. */
const SUMMARY_KEYS: readonly string[] = [
  "description",
  "shortDescription",
  "short_description",
  "summary",
  "tagline",
];

/** Keys whose value is a nested presentation block worth looking inside. */
const PRESENTATION_KEYS: readonly string[] = [
  "interface",
  "presentation",
  "display",
  "metadata",
  "meta",
];

/** Presentation keys a foreign dialect may carry a longer human-facing name under. */
const DISPLAY_NAME_KEYS: readonly string[] = ["displayName", "display_name", "title"];

/**
 * The first non-empty string a listing carries under any of `keys`, wherever its
 * dialect put it: at the top level, or inside a nested presentation block.
 *
 * Read by shape, never by dialect: any key spelling the field, at either level,
 * is accepted, and nothing is invented when none is found.
 *
 * @param entry - the raw listing or document object.
 * @param keys - the key spellings that mean the same thing.
 * @returns the value, and the key on `entry` it was read out of — the field's own
 *   spelling when it sat at the top level, the block's when it was nested.
 * @remarks The caller needs `via` so it can stop describing that key as one
 *   Clarvis does not act on. Reporting a key as ignored while reading a value out
 *   of it is a note that contradicts the behaviour beside it, and an alternate
 *   spelling is exactly the case where both happen at once.
 */
function authoredTextVia(
  entry: Record<string, unknown>,
  keys: readonly string[],
): { value?: string; via?: string } {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) return { value, via: key };
  }
  for (const key of PRESENTATION_KEYS) {
    const block = entry[key];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    for (const inner of keys) {
      const value = (block as Record<string, unknown>)[inner];
      if (typeof value === "string" && value.trim().length > 0) return { value, via: key };
    }
  }
  return {};
}

/** How a listing's `source` resolves once its dialect has been read. */
interface SourceReading {
  /** The source as one string: the URL to clone, or the local path named. */
  source: string;
  kind: "git" | "local" | "npm";
  path?: string;
  ref?: string;
  sha?: string;
  version?: string;
  registry?: string;
  /** Whether this host can install from it. */
  installable: boolean;
  /** Why it is not installable, when it is not. */
  note?: string;
}

/**
 * Read a listing's `source` in any of the three shapes a catalog writes it in.
 *
 * @param raw - the validated `source` value.
 * @returns the normalized source, and whether this host installs from it.
 * @remarks A bare string carrying a transport or an ssh spelling is a remote
 *   source and is installable. A confined relative spelling is an installable
 *   local source; an absolute or escaping path remains visible but cannot be
 *   installed.
 */
function readSource(raw: string | z.infer<typeof sourceDescriptorSchema>): SourceReading {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (TRANSPORT_SOURCE_RE.test(value) || SSH_SOURCE_RE.test(value)) {
      const issue = pluginGitUrlIssue(value);
      return {
        source: value,
        kind: "git",
        installable: issue === undefined,
        ...(issue === undefined ? {} : { note: issue }),
      };
    }
    if (!isRelativeSubpath(value)) {
      return {
        source: value,
        kind: "local",
        installable: false,
        note: "names a local source that would resolve outside the marketplace root",
      };
    }
    return { source: value, kind: "local", path: value, installable: true };
  }
  const kind = raw.source.trim().toLowerCase();
  const path = raw.path?.trim();
  if (kind === "local") {
    if (path === undefined) {
      return {
        source: kind,
        kind: "local",
        installable: false,
        note: "names a local source with no path",
      };
    }
    if (!isRelativeSubpath(path)) {
      return {
        source: path,
        kind: "local",
        installable: false,
        note: "names a local source that would resolve outside the marketplace root",
      };
    }
    return { source: path, kind: "local", path, installable: true };
  }
  if (kind === "url" || kind === "git-subdir") {
    const url = raw.url?.trim();
    if (url === undefined || !(TRANSPORT_SOURCE_RE.test(url) || SSH_SOURCE_RE.test(url))) {
      return {
        source: url ?? kind,
        kind: "git",
        installable: false,
        note: `names source kind '${kind}' without a usable git URL`,
      };
    }
    const urlIssue = pluginGitUrlIssue(url);
    if (urlIssue !== undefined) {
      return {
        source: url,
        kind: "git",
        installable: false,
        note: urlIssue,
      };
    }
    if (kind === "git-subdir" && (path === undefined || !isRelativeSubpath(path))) {
      return {
        source: url,
        kind: "git",
        installable: false,
        note: "names a git-subdir source without a confined relative path",
      };
    }
    const selectorIssue = pluginGitSelectorIssue({
      ...(raw.ref === undefined ? {} : { ref: raw.ref.trim() }),
      ...(raw.sha === undefined ? {} : { sha: raw.sha }),
    });
    return {
      source: url,
      kind: "git",
      ...(path === undefined ? {} : { path }),
      ...(raw.ref === undefined ? {} : { ref: raw.ref.trim() }),
      ...(raw.sha === undefined ? {} : { sha: raw.sha.toLowerCase() }),
      installable: selectorIssue === undefined,
      ...(selectorIssue === undefined ? {} : { note: selectorIssue }),
    };
  }
  if (kind === "npm") {
    const packageName = raw.package?.trim();
    const version = raw.version?.trim();
    const registry = raw.registry?.trim();
    const invalid =
      packageName === undefined
        ? "names an npm source without a usable package name"
        : pluginNpmSourceIssue({
            package: packageName,
            ...(version === undefined ? {} : { version }),
            ...(registry === undefined ? {} : { registry }),
          });
    return {
      source: packageName ?? kind,
      kind: "npm",
      ...(version === undefined ? {} : { version }),
      ...(registry === undefined ? {} : { registry }),
      installable: invalid === undefined,
      ...(invalid === undefined ? {} : { note: invalid }),
    };
  }
  return {
    source: path ?? raw.source.trim(),
    kind: "git",
    installable: false,
    note: `names source kind '${raw.source.trim()}', which Clarvis has no fetcher for`,
  };
}

/**
 * One plugin listing in a marketplace, after a tolerant read.
 *
 * @remarks A listing is a pointer, never a grant of trust: everything on it is
 *   display data, and {@link MarketplaceEntry.installable} is the only field that
 *   gates an action.
 */
export interface MarketplaceEntry {
  /** Plugin id. Must match the plugin's own manifest name. */
  name: string;
  /** The source as one string: a URL to clone, or the local path named. */
  source: string;
  sourceType: "git" | "local" | "npm";
  /** Subdirectory within the source holding this plugin's manifest. */
  path?: string;
  ref?: string;
  sha?: string;
  version?: string;
  registry?: string;
  installation: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE";
  authentication: "ON_INSTALL" | "ON_FIRST_USE";
  /** One line on what this plugin is for; supplied when the document authors none. */
  description: string;
  /** Where to read more about it. */
  homepage?: string;
  /** A longer human-facing name, when the document carries one. */
  displayName?: string;
  /** The catalog's own grouping for this listing. Presentation only. */
  category?: string;
  /** Whether this host can install from {@link MarketplaceEntry.source}. */
  installable: boolean;
  /** What was defaulted, ignored or left unacted-on while reading this listing. */
  notes: string[];
}

/**
 * A marketplace document, after a tolerant read.
 *
 * @remarks {@link Marketplace.notes} carries everything the read had to say about
 *   the document as a whole, including one line per listing it had to drop.
 */
export interface Marketplace {
  /** Display name of this marketplace; supplied when the document authors none. */
  name: string;
  /** What this marketplace is for. */
  description?: string;
  /**
   * A longer human-facing title for the catalog, when it authors one.
   *
   * @remarks Distinct from {@link Marketplace.name}, which is the identifier a
   * listing is addressed through. Display data only, never authorization.
   */
  displayName?: string;
  /** The listings it offers. A listing is a pointer, never a grant of trust. */
  plugins: MarketplaceEntry[];
  /** What was defaulted, ignored, dropped or left unacted-on while reading it. */
  notes: string[];
}

/** The outcome of reading one listing: the listing, or why it was dropped. */
type EntryReading = { entry: MarketplaceEntry } | { dropped: string };

/**
 * Read one listing from a marketplace document.
 *
 * @param raw - the listing as it appears in the document.
 * @param position - its 1-based position, used to name it when it has no usable
 *   `name`.
 * @returns the listing, or the reason it could not be read at all.
 * @remarks Only two things make a listing unusable — no name, and a source that
 *   cannot be resolved. Every other field this schema requires is *supplied* when
 *   the document omits it, and the substitution is recorded in the listing's
 *   notes, because dropping a whole listing over a missing one-line summary would
 *   empty a catalog that is otherwise perfectly readable.
 */
function readEntry(raw: unknown, position: number): EntryReading {
  const where = `listing ${String(position)}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { dropped: `${where} was dropped: a listing must be an object` };
  }
  const source = raw as Record<string, unknown>;

  const name = pluginNameField.safeParse(source.name);
  if (!name.success) {
    return { dropped: `${where} was dropped: 'name' ${issueSummary(name.error)}` };
  }
  const named = `listing '${name.data}'`;

  const sourceValue = entrySourceField.safeParse(source.source);
  if (!sourceValue.success) {
    return { dropped: `${named} was dropped: 'source' ${issueSummary(sourceValue.error)}` };
  }
  const notes: string[] = [];
  const resolved = readSource(sourceValue.data);
  if (resolved.note !== undefined) notes.push(`${named} ${resolved.note}`);

  const path = resolved.path ?? readField(source.path, relativeSubpathField, named, "path", notes);
  let installable = resolved.installable;
  if (source.path !== undefined && path === undefined) {
    installable = false;
    notes.push(
      `${named}: its 'path' could not be read, so this listing is shown but cannot be ` +
        `installed from here`,
    );
  }
  const homepage = readField(source.homepage, nonEmptyString, named, "homepage", notes);
  const category = readField(source.category, nonEmptyString, named, "category", notes);
  const policy =
    typeof source.policy === "object" && source.policy !== null && !Array.isArray(source.policy)
      ? (source.policy as Record<string, unknown>)
      : {};
  const installation =
    readField(
      policy.installation,
      z.enum(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"]),
      named,
      "policy.installation",
      notes,
    ) ?? "AVAILABLE";
  const authentication =
    readField(
      policy.authentication,
      z.enum(["ON_INSTALL", "ON_FIRST_USE"]),
      named,
      "policy.authentication",
      notes,
    ) ?? "ON_FIRST_USE";
  if (installation === "NOT_AVAILABLE") installable = false;
  const titled = authoredTextVia(source, DISPLAY_NAME_KEYS);
  const displayName =
    readField(source.displayName, nonEmptyString, named, "displayName", notes) ?? titled.value;

  let description = readField(source.description, nonEmptyString, named, "description", notes);
  let borrowedVia: string | undefined;
  if (description === undefined) {
    const borrowed = authoredTextVia(source, SUMMARY_KEYS);
    borrowedVia = borrowed.via;
    description =
      borrowed.value ??
      (category === undefined
        ? DEFAULT_ENTRY_DESCRIPTION
        : `${DEFAULT_ENTRY_DESCRIPTION} (category: ${category})`);
    notes.push(
      borrowed.value === undefined
        ? `${named}: no description was authored; Clarvis supplied one`
        : `${named}: no description was authored; Clarvis read its summary instead`,
    );
  }

  notes.push(
    ...foreignKeyNotes(source, actedKeys(KNOWN_ENTRY_KEYS, titled.via, borrowedVia), named),
  );

  return {
    entry: {
      name: name.data,
      source: resolved.source,
      sourceType: resolved.kind,
      ...(path !== undefined ? { path } : {}),
      ...(resolved.ref === undefined ? {} : { ref: resolved.ref }),
      ...(resolved.sha === undefined ? {} : { sha: resolved.sha }),
      ...(resolved.version === undefined ? {} : { version: resolved.version }),
      ...(resolved.registry === undefined ? {} : { registry: resolved.registry }),
      installation,
      authentication,
      description,
      ...(homepage !== undefined ? { homepage } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(category !== undefined ? { category } : {}),
      installable,
      notes: boundNotes(notes),
    },
  };
}

/**
 * The known keys, widened by whichever alternate spellings a reader consumed.
 *
 * @param known - the keys this reader always gives meaning to.
 * @param consumed - keys a value was actually read out of, if any.
 * @returns the set to report unrecognized keys against.
 */
function actedKeys(
  known: ReadonlySet<string>,
  ...consumed: (string | undefined)[]
): ReadonlySet<string> {
  const extra = consumed.filter((key): key is string => key !== undefined);
  return extra.length === 0 ? known : new Set([...known, ...extra]);
}

/** Bound a note list, summarizing whatever is past {@link MAX_NOTES}. */
function boundNotes(notes: string[]): string[] {
  if (notes.length <= MAX_NOTES) return notes;
  const kept = notes.slice(0, MAX_NOTES);
  kept.push(`(+${String(notes.length - MAX_NOTES)} more)`);
  return kept;
}

/**
 * Read a whole marketplace document.
 *
 * @param document - the JSON-parsed document; any object is accepted.
 * @returns the catalog, with every substitution and omission recorded in
 *   {@link Marketplace.notes}.
 * @remarks Tolerance degrades one listing, never the collection. A listing this
 *   reader cannot use is dropped and named; the rest of the catalog is returned
 *   exactly as it would have been had the broken one never been written.
 */
function readMarketplaceDocument(document: Record<string, unknown>): Marketplace {
  const notes: string[] = [];
  const where = "marketplace";

  let name = readField(document.name, nonEmptyString, where, "name", notes);
  if (name === undefined) {
    name = DEFAULT_MARKETPLACE_NAME;
    if (document.name === undefined) {
      notes.push(`${where}: no name was authored; Clarvis supplied one`);
    }
  }
  const description = readField(document.description, nonEmptyString, where, "description", notes);
  const named = authoredTextVia(document, DISPLAY_NAME_KEYS);
  const displayName =
    readField(document.displayName, nonEmptyString, where, "displayName", notes) ?? named.value;

  const listings: unknown[] = Array.isArray(document.plugins) ? document.plugins : [];
  if (document.plugins !== undefined && !Array.isArray(document.plugins)) {
    notes.push(`${where}: 'plugins' was ignored — it must be an array of listings`);
  }
  if (listings.length > MAX_LISTINGS) {
    notes.push(
      `${where}: only the first ${String(MAX_LISTINGS)} of ${String(listings.length)} listings ` +
        `were read`,
    );
  }

  const plugins: MarketplaceEntry[] = [];
  for (const [index, raw] of listings.slice(0, MAX_LISTINGS).entries()) {
    const reading = readEntry(raw, index + 1);
    if ("dropped" in reading) notes.push(reading.dropped);
    else plugins.push(reading.entry);
  }

  notes.push(...foreignKeyNotes(document, actedKeys(KNOWN_ROOT_KEYS, named.via), where));

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    plugins,
    notes: boundNotes(notes),
  };
}

/**
 * The `marketplace.json` schema: a display `name`, an optional `description`, and
 * the plugin listings it offers.
 *
 * @remarks
 * Tolerant and reporting, exactly as the plugin manifest beside it already is. A
 * document is accepted as long as it is an object; every key this reader has no
 * meaning for is carried into a note rather than rejected, and every field it
 * requires is supplied — and recorded — when the document omits it. That is what
 * lets a catalog written in another agent host's dialect be read here without a
 * single vendor name appearing in this file, and without a Clarvis-authored
 * catalog gaining a required field.
 *
 * The one thing it refuses outright is a document that is not an object, because
 * there is nothing there to read. Listing a plugin still grants it nothing: it
 * has to be installed, enabled, and approved.
 */
export const marketplaceSchema = z.object({}).loose().transform(readMarketplaceDocument);
