/**
 * Where a plugin's manifest is found and how it is made sense of, for plugins
 * written against Clarvis and against other agent hosts alike.
 *
 * @remarks
 * Both readers of a manifest — the install view in `plugin-service.ts` and
 * the run-time loader in `plugin-contributions.ts` — go through
 * {@link resolvePluginManifest}, so a manifest cannot mean one thing to the panel
 * that asks the operator to approve it and another to the code that loads it.
 */
import { existsSync, opendirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  PLUGIN_RESOURCE_LIMITS,
  mcpServerPluginSchema,
  parsePluginManifest,
  readBoundedPluginText,
  suspectedManifestTypos,
  unknownManifestKeys,
  type PluginManifest,
} from "@clarvis/loop/host";
import {
  hooksDocumentSchema,
  convertHooksDocument,
  type HooksConversionOptions,
} from "./hook-dialects.ts";

/** The file a manifest is named, wherever in the checkout it sits. */
const MANIFEST_FILE = "plugin.json";

/** The directory a plugin puts the manifest it wrote *for Clarvis* in. */
const CLARVIS_MANIFEST_DIR = ".clarvis-plugin";

/**
 * Dot-directories that hold one agent host's manifest.
 *
 * @remarks
 * A rule rather than a list of names. The convention in this ecosystem is one
 * `.<host>-plugin/` directory per host over a single shared `skills/` tree, so a
 * checkout can carry a manifest for each. Matching the *shape* means a plugin
 * written for a host this code has never heard of is found on the same pass, and
 * that no product name has to appear here to be supported.
 */
const HOST_MANIFEST_DIR = /^\.[A-Za-z0-9_-]+-plugin$/;

/**
 * Borrowed manifest locations for one plugin directory.
 *
 * @param dir - the plugin's install directory.
 * @returns every other host's forward-slash relative manifest path, name-sorted
 *   so scoring ties are deterministic.
 * @remarks The root and Clarvis-specific locations are owned by
 *   {@link readPluginManifestSource}; this directory walk discovers only
 *   borrowed host dialects.
 */
function borrowedManifestLocations(dir: string): { locations: string[] } | { error: string } {
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(dir);
  } catch {
    return { locations: [] };
  }
  const borrowed: string[] = [];
  let entries = 0;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > PLUGIN_RESOURCE_LIMITS.manifestLocationEntries) {
        return {
          error:
            `plugin root exceeds the ${String(PLUGIN_RESOURCE_LIMITS.manifestLocationEntries)}-entry ` +
            "manifest-discovery resource limit",
        };
      }
      if (
        entry.isDirectory() &&
        entry.name !== CLARVIS_MANIFEST_DIR &&
        HOST_MANIFEST_DIR.test(entry.name)
      ) {
        borrowed.push(entry.name);
      }
    }
  } catch (error) {
    return { error: `plugin root changed during manifest discovery: ${(error as Error).message}` };
  } finally {
    try {
      opened.closeSync();
    } catch {
      /* A completed/lazily failed read may already have closed the directory handle. */
    }
  }
  borrowed.sort();
  return { locations: borrowed.map((name) => `${name}/${MANIFEST_FILE}`) };
}

/** The hooks document a plugin is read from when its manifest declares none. */
const HOOKS_CONVENTION_FILE = "hooks/hooks.json";

/** MCP companion documents, in ecosystem precedence order. */
const MCP_CONVENTION_FILES = [".mcp.json", "mcp.json"] as const;

/** Where a plugin's skills live when its manifest names no other place. */
const DEFAULT_SKILLS_DIR = "skills";

/**
 * How many effective skill roots one plugin may contribute.
 *
 * @remarks
 * A budget rather than a layout opinion. Every effective root is a root the
 * whole run scans, and `@clarvis/skills` refuses a scan outright past its own
 * ceiling — a refusal the engine turns into an *empty* skills provider, so one
 * verbose manifest could otherwise delete every skill in the workspace, its own
 * and the operator's alike. Exact sibling lists are compacted before this bound
 * without admitting an undeclared directory; `skillRoots` bounds the sum across
 * plugins for the same reason.
 */
const MAX_PLUGIN_SKILL_ROOTS = 4;

/** What one plugin's `skills` declaration resolved to. */
export interface PluginSkillRoots {
  /** Absolute directories to scan, preserving first represented declaration order. */
  roots: string[];
  /** What was declared and could not be used. */
  notes: string[];
}

/**
 * Where to scan for one plugin's skills.
 *
 * @param dir - the plugin's install directory.
 * @param declared - the manifest's `skills` value: a path, a list of paths, or
 *   absent.
 * @returns the absolute roots to scan, and a note for anything declared that
 *   this host cannot use.
 * @remarks
 * **The manifest decides, not this host.** `skills` is a directive in the
 * dialect plugins are written in — one plugin keeps its skills under
 * `plugins/<name>/skills/`, another under `plugin/skills/`, a library plugin
 * under `library/` — and reading only a hardcoded `skills/` turned that
 * directive into a decoration. Measured on a public catalog, twenty plugins
 * declared a location other than the default and this host read **none** of the
 * 316 skills they held, while reporting, accurately and uselessly, that it had
 * not.
 *
 * Every path is resolved by {@link companionPath} against the **manifest's own
 * directory** first and the plugin root second, and confined to the root either
 * way. Both readings are needed because both occur: a manifest at the plugin
 * root writes its paths from there, while one at `.<host>-plugin/plugin.json`
 * writes them from beside itself — `"skills": "../skills/"` means the plugin's
 * `skills/`, and resolving it against the root instead sent it out of the plugin
 * and lost every skill it named. A path that escapes is dropped with a note
 * rather than followed; a declaration this host cannot act on at all leaves the
 * default in place, so a plugin is never left with nowhere to look.
 *
 * A location may name one skill directory directly or a collection above it.
 * When a long list exhaustively names direct-skill siblings, the adapter can
 * collapse those siblings to their parent before applying the effective-root
 * budget. Any undeclared directory or symlink prevents that collapse, so
 * compaction cannot widen the manifest's contribution surface.
 */
export function pluginSkillRoots(
  dir: string,
  declared: unknown,
  manifestLocation?: string,
): PluginSkillRoots {
  const dirs = pluginDirsFor(dir, manifestLocation);
  const fallback = [join(dir, DEFAULT_SKILLS_DIR)];
  if (declared === undefined) return { roots: fallback, notes: [] };

  const values = typeof declared === "string" ? [declared] : declared;
  if (!Array.isArray(values)) {
    return {
      roots: fallback,
      notes: [
        `skills: not a path or a list of paths — this plugin's '${DEFAULT_SKILLS_DIR}/' is scanned instead`,
      ],
    };
  }

  const roots: string[] = [];
  const notes: string[] = [];
  for (const value of values as unknown[]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      notes.push(`skills: '${String(value)}' is not a path — not scanned`);
      continue;
    }
    if (/\.md$/i.test(value.trim())) {
      notes.push(
        `skills: '${value}' names a file — this host scans directories, each holding one ` +
          "skill's SKILL.md, so nothing was read from it",
      );
      continue;
    }
    const resolved = companionPath(dirs, value);
    if (resolved === undefined) {
      notes.push(`skills: '${value}' resolves outside the plugin — not scanned`);
      continue;
    }
    if (!roots.includes(resolved)) roots.push(resolved);
  }

  const compacted = compactSkillRoots(roots);
  if (compacted.length > MAX_PLUGIN_SKILL_ROOTS) {
    notes.push(
      `skills: only the first ${String(MAX_PLUGIN_SKILL_ROOTS)} of ${String(compacted.length)} ` +
        "effective locations are scanned",
    );
    compacted.length = MAX_PLUGIN_SKILL_ROOTS;
  }

  if (compacted.length > 0) return { roots: compacted, notes };
  return {
    roots: fallback,
    notes: [
      ...notes,
      `skills: nothing declared could be scanned — this plugin's '${DEFAULT_SKILLS_DIR}/' is scanned instead`,
    ],
  };
}

/** The manifest key holding the MCP servers a plugin contributes. */
const MCP_SERVERS_KEY = "mcpServers";

/** The manifest key another dialect writes its presentation metadata under. */
const PRESENTATION_KEY = "interface";

/** A manifest found on disk: its text and the relative location it came from. */
export interface PluginManifestSource {
  raw: string;
  location: string;
}

/**
 * Directive keys whose presence makes one host manifest more useful to
 * Clarvis than another.
 *
 * @remarks Identity and presentation fields deliberately do not count. A
 * repository commonly repeats those in every host manifest while putting the
 * executable contributions in only one. Counting identity would preserve the
 * old alphabetical accident instead of selecting the document that actually
 * describes what the plugin does here.
 */
const MANIFEST_CONTRIBUTION_KEYS = [
  "skills",
  "mcpServers",
  "hooks",
  "bootstrapSkill",
  "capabilityExecutables",
  "capabilityRunPolicies",
] as const;

/** Whether a directive carries anything rather than an empty placeholder. */
function carriesContribution(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/**
 * Rank a readable manifest by the Clarvis contributions it actually declares.
 * Invalid/non-object JSON ranks below every usable document and is still
 * returned when there is no usable alternative, so the ordinary resolver can
 * report its precise error.
 */
function manifestContributionScore(raw: string): number {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return -1;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return -1;
  const record = value as Record<string, unknown>;
  return MANIFEST_CONTRIBUTION_KEYS.reduce(
    (score, key) => score + (carriesContribution(record[key]) ? 1 : 0),
    0,
  );
}

/**
 * Read the plugin manifest that declares the richest Clarvis-compatible
 * contribution surface.
 *
 * @param dir - the plugin's install directory.
 * @returns the source, or `{ error }` naming every location searched and the
 *   first failure that was not a plain absence.
 * @remarks A location that is missing is ordinary and moves on to the next.
 *   A location that exists but cannot be read is not: reporting it is what
 *   distinguishes "this plugin has no manifest" from "its manifest is there and
 *   unreadable".
 *
 *   `.clarvis-plugin/plugin.json` is authoritative whenever present: it is the
 *   only location whose name explicitly says that its author targeted this
 *   host. Otherwise every readable root/borrowed manifest is ranked by the
 *   number of contribution directives Clarvis understands, with the historical
 *   root-then-name order breaking ties. This is what stops a generic identity
 *   manifest at the root, or an alphabetically earlier host manifest, from
 *   hiding the `skills`, `mcpServers`, or `hooks` another manifest declares.
 *   An unreadable candidate remains fatal rather than becoming a way to steer
 *   selection silently.
 */
export function readPluginManifestSource(dir: string): PluginManifestSource | { error: string } {
  const clarvisLocation = `${CLARVIS_MANIFEST_DIR}/${MANIFEST_FILE}`;
  const clarvisRead = readBoundedPluginText(
    join(dir, clarvisLocation),
    PLUGIN_RESOURCE_LIMITS.manifestBytes,
    `plugin manifest '${clarvisLocation}'`,
  );
  if (clarvisRead.ok) return { raw: clarvisRead.text, location: clarvisLocation };
  if (!clarvisRead.missing) return { error: clarvisRead.error };

  const borrowed = borrowedManifestLocations(dir);
  if ("error" in borrowed) return borrowed;
  const locations = [MANIFEST_FILE, clarvisLocation, ...borrowed.locations];
  const candidateLocations = [MANIFEST_FILE, ...borrowed.locations];
  const manifestCandidates: PluginManifestSource[] = [];
  for (const location of candidateLocations) {
    const read = readBoundedPluginText(
      join(dir, location),
      PLUGIN_RESOURCE_LIMITS.manifestBytes,
      `plugin manifest '${location}'`,
    );
    if (read.ok) {
      const source = { raw: read.text, location };
      manifestCandidates.push(source);
      continue;
    }
    if (!read.missing) return { error: read.error };
  }
  let selected = manifestCandidates.at(0);
  if (selected !== undefined) {
    let selectedScore = manifestContributionScore(selected.raw);
    for (const candidate of manifestCandidates.slice(1)) {
      const score = manifestContributionScore(candidate.raw);
      if (score > selectedScore) {
        selected = candidate;
        selectedScore = score;
      }
    }
    return selected;
  }
  return {
    error: `no readable ${MANIFEST_FILE} (looked in ${locations.join(", ")})`,
  };
}

/**
 * Resolve a companion document a manifest names, against the plugin that owns it.
 *
 * @param dir - the plugin's install directory.
 * @param declared - the path the manifest carries.
 * @returns the absolute path, or `undefined` when it would leave the plugin.
 *
 * @remarks
 * A manifest is untrusted input — it arrives from whatever checkout the operator
 * installed — so a path it names is confined to the plugin's own directory rather
 * than joined blindly. The decision is made on the *resolved* path, so `a/../../b`
 * is refused on the same rule as `../b`, and an absolute path does not resolve
 * against `dir` at all.
 *
 * Confinement is lexical. A symlink *inside* the plugin that points outside it is
 * still followed, which is the same open parent-directory weakness recorded for
 * workspace-confined writes; closing it needs descriptor-relative reads rather
 * than a stricter path check.
 */
function companionPath(dirs: PluginDirs, declared: string): string | undefined {
  const root = resolve(dirs.root);
  const confined = (target: string): string | undefined =>
    target === root || target.startsWith(root + sep) ? target : undefined;
  if (dirs.base !== dirs.root) {
    const fromBase = confined(resolve(dirs.base, declared));
    if (fromBase !== undefined && existsSync(fromBase)) return fromBase;
  }
  return confined(resolve(root, declared));
}

/**
 * The two directories a manifest's paths are read against.
 *
 * @remarks
 * `root` is the confinement boundary and never moves. `base` is where a relative
 * path is *written* from, which is the manifest's own directory — a manifest at
 * `.clarvis-plugin/plugin.json` naming `../skills/` means the plugin's `skills/`,
 * exactly as its author reads it. Resolving such a path against the root instead
 * sent it out of the plugin, where confinement refused it; the plugin then lost
 * whatever it declared and was told its own correct path was invalid.
 *
 * The base is tried first and only when it resolves to something that exists, so
 * a plugin whose manifest sits at its root is unaffected, and a path that only
 * makes sense from the root still resolves there.
 */
interface PluginDirs {
  /** The plugin's install directory; nothing may resolve outside it. */
  root: string;
  /** The directory the manifest itself lives in. */
  base: string;
}

/**
 * Pair a plugin directory with the directory its manifest was found in.
 *
 * @param dir - the plugin's install directory.
 * @param manifestLocation - the manifest's path relative to `dir`, as
 *   {@link readPluginManifestSource} reports it. Absent means the root.
 * @returns the resolution bases; `base` equals `root` for a root manifest.
 */
function pluginDirsFor(dir: string, manifestLocation?: string): PluginDirs {
  const root = resolve(dir);
  if (manifestLocation === undefined) return { root, base: root };
  const holder = dirname(resolve(root, manifestLocation));
  const inside = holder === root || holder.startsWith(root + sep);
  return { root, base: inside ? holder : root };
}

/**
 * Where this plugin's conventional hooks document lives.
 *
 * @param dirs - the plugin's root and its manifest's directory.
 * @returns the path beside the manifest when a document is there, else the one
 *   under the plugin root.
 * @remarks
 * A plugin carrying manifests for several hosts keeps each host's hooks beside
 * that host's manifest, because the documents differ — that is the whole reason
 * the manifests are separate. Looking only under the plugin root found nothing
 * and reported nothing, since an absent convention file is the ordinary way a
 * plugin says it has no hooks; the plugin's hooks were simply never contributed.
 */
function conventionHooksPath(dirs: PluginDirs): string {
  if (dirs.base !== dirs.root) {
    const beside = join(dirs.base, HOOKS_CONVENTION_FILE);
    if (existsSync(beside)) return beside;
  }
  return join(dirs.root, HOOKS_CONVENTION_FILE);
}

/**
 * How a plugin asks to be shown in the operator's list.
 *
 * @remarks Display data and nothing else. A manifest cannot widen what a plugin
 *   may do by describing itself well, so nothing here is ever consulted when
 *   deciding what runs; trust stays with the install, the enable list and the
 *   hook reviews.
 */
export interface PluginPresentation {
  /** A name to show in place of the directory name. */
  displayName?: string;
  /** A one-line summary, when the manifest carries no `description`. */
  shortDescription?: string;
}

/** The outcome of {@link resolvePluginManifest}. */
export interface ResolvedPluginManifest {
  /** The validated manifest, absent when `error` is set. */
  manifest?: PluginManifest;
  /** Why the manifest could not be used. */
  error?: string;
  /** What the manifest asks to be shown as; see {@link PluginPresentation}. */
  presentation?: PluginPresentation;
  /**
   * What the manifest declares that Clarvis does not act on: keys that look
   * misspelled, unrecognized keys, hooks that did not translate, and a `skills`
   * location that is not the one scanned. Shown to the operator, never fatal.
   *
   * @remarks Suspected misspellings come first. They are the only entries that
   *   describe a mistake rather than a difference, so they are the ones an
   *   operator should read before the list stops being worth scanning.
   */
  notes: string[];
}

/** What one candidate source of hooks yielded. */
interface HookHarvest {
  /** The value to place on the manifest, empty when the source declared nothing. */
  hooks: unknown[];
  /** What did not translate cleanly. */
  notes: string[];
}

/** Nothing at all, from a source that was absent. */
const NO_HOOKS: HookHarvest = { hooks: [], notes: [] };

/** True when a declared path resolves to the convention file itself. */
function isConventionPath(dirs: PluginDirs, declared: string): boolean {
  const resolved = companionPath(dirs, declared);
  return resolved !== undefined && resolved === conventionHooksPath(dirs);
}

/**
 * Read a hooks document and translate it, given a document already parsed from
 * JSON.
 */
function harvestDocument(
  dirs: PluginDirs,
  source: unknown,
  origin: string,
  conversion: HooksConversionOptions,
): HookHarvest {
  const parsed = hooksDocumentSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "invalid";
    return {
      hooks: [],
      notes: [`hooks: ${origin} does not hold a recognizable hooks document (${detail})`],
    };
  }
  const { hooks, notes } = convertHooksDocument(parsed.data, dirs.root, conversion);
  return { hooks, notes };
}

/**
 * Harvest one hooks document the manifest names by path.
 *
 * @param dirs - the plugin root and the selected manifest's path base.
 * @param declared - the path as the manifest writes it.
 * @param conversion - effective plugin identity used by external MCP matchers.
 * @returns the hooks it yielded, or a note saying why it yielded none.
 * @remarks
 * A named file that cannot be used is a note rather than a failure, on the same
 * reasoning {@link resolveMcpServers} already records for a named servers
 * document: what this key declares is one part of a plugin, so withholding it
 * costs the operator that part, while refusing the manifest costs them the
 * plugin entire — its skills and agents included, which have nothing to do with
 * hooks.
 *
 * This reverses the earlier rule that naming a file was "a positive act" and so
 * fatal. The argument did not survive measurement: on a public catalog a plugin
 * shipping sixteen working skills contributed **none** of them because the
 * hooks file its manifest named was absent from the bundle. Nothing runs either
 * way; the difference is only whether the rest of the plugin runs with it.
 */
function harvestFile(
  dirs: PluginDirs,
  declared: string,
  conversion: HooksConversionOptions,
): HookHarvest {
  const withheld = "no hooks are contributed from it";
  const note = (reason: string): HookHarvest => ({
    hooks: [],
    notes: [`hooks: '${declared}' ${reason} — ${withheld}`],
  });

  const path = companionPath(dirs, declared);
  if (path === undefined) return note("resolves outside the plugin");

  const read = readBoundedPluginText(
    path,
    PLUGIN_RESOURCE_LIMITS.hookDocumentBytes,
    `hooks file '${declared}'`,
  );
  if (!read.ok) return { hooks: [], notes: [`hooks: ${read.error} — ${withheld}`] };

  let source: unknown;
  try {
    source = JSON.parse(read.text);
  } catch (error) {
    return note(`is not valid JSON (${(error as Error).message})`);
  }
  return harvestDocument(dirs, source, `hooks file '${declared}'`, conversion);
}

/**
 * Harvest the hooks the manifest declares in its own body — Clarvis's native
 * array, or the event map an external manifest carries inline — or from one or
 * several files it names.
 *
 * @param dirs - the plugin root and the selected manifest's path base.
 * @param declared - whatever the manifest's `hooks` key holds.
 * @param conversion - effective plugin identity used by external MCP matchers.
 * @returns the hooks harvested, and a note for every source that yielded none.
 * @remarks
 * An array is read two ways, decided by what is in it. An array of **strings**
 * is a list of documents to read and concatenate, which is how a plugin splits
 * its rules one file per event; anything else is Clarvis's own array of hook
 * definitions, left for the schema to validate. The two cannot be confused: a
 * hook definition is an object, and a path is not.
 */
function harvestDeclared(
  dirs: PluginDirs,
  declared: unknown,
  conversion: HooksConversionOptions,
): HookHarvest {
  if (Array.isArray(declared)) {
    if (declared.length > 0 && declared.every((entry) => typeof entry === "string")) {
      const harvested = declared.map((file) => harvestFile(dirs, file, conversion));
      return {
        hooks: harvested.flatMap((h) => h.hooks),
        notes: harvested.flatMap((h) => h.notes),
      };
    }
    return { hooks: declared, notes: [] };
  }

  if (typeof declared === "string") return harvestFile(dirs, declared, conversion);

  if (typeof declared === "object" && declared !== null) {
    return harvestDocument(dirs, declared, "the manifest", conversion);
  }
  return NO_HOOKS;
}

/** Harvest the hooks of the `hooks/hooks.json` a plugin ships by convention. */
function harvestConvention(dirs: PluginDirs, conversion: HooksConversionOptions): HookHarvest {
  const read = readBoundedPluginText(
    conventionHooksPath(dirs),
    PLUGIN_RESOURCE_LIMITS.hookDocumentBytes,
    `hooks convention '${HOOKS_CONVENTION_FILE}'`,
  );
  if (!read.ok) {
    if (read.missing) return NO_HOOKS;
    return { hooks: [], notes: [`hooks: ${read.error} — no hooks are contributed from it`] };
  }
  let source: unknown;
  try {
    source = JSON.parse(read.text);
  } catch (error) {
    return {
      hooks: [],
      notes: [`hooks: ${HOOKS_CONVENTION_FILE} is not valid JSON (${(error as Error).message})`],
    };
  }
  return harvestDocument(dirs, source, HOOKS_CONVENTION_FILE, conversion);
}

/**
 * Resolve a plugin's hooks from exactly one source and rewrite the manifest's
 * `hooks` key with the result.
 *
 * @param dirs - the plugin root and the selected manifest's path base.
 * @param document - the JSON-parsed manifest, mutated in place.
 * @param conversion - effective plugin identity used by external MCP matchers.
 * @returns notes for whatever did not translate, and for a source that lost.
 * @remarks
 * **No hooks source can cost a plugin anything but its hooks.** Every way of
 * failing to read one — a path outside the plugin, a missing file, text that is
 * not JSON, a document in no shape this host recognizes — resolves to a note and
 * an empty harvest. See {@link harvestFile} for why that replaced a failure.
 *
 * **One source wins outright; two are never merged.** What the manifest declares
 * in its own body takes precedence over the `hooks/hooks.json` convention,
 * because declaring in the manifest is both the common external form and Clarvis's
 * own — a plugin that says something here has said it in the place this host
 * reads first.
 *
 * A declaration only counts when it yields at least one hook. An empty map or
 * array names nothing, and a real plugin was found carrying exactly that
 * (`"hooks": {}`) while its commands lived in the convention file — so treating
 * emptiness as "no hooks anywhere" silently dropped them. Whichever
 * source loses is named in a note, so the choice is never invisible.
 */
function resolveHooks(
  dirs: PluginDirs,
  document: Record<string, unknown>,
  conversion: HooksConversionOptions,
): string[] {
  const declared = document.hooks;
  const notes: string[] = [];

  const fromManifest = harvestDeclared(dirs, declared, conversion);
  notes.push(...fromManifest.notes);

  if (fromManifest.hooks.length > 0) {
    document.hooks = fromManifest.hooks;
    const shadowed =
      existsSync(conventionHooksPath(dirs)) &&
      !(typeof declared === "string" && isConventionPath(dirs, declared));
    if (shadowed) {
      notes.push(
        `hooks: ${HOOKS_CONVENTION_FILE} not read — the manifest declares its own hooks, ` +
          "which take precedence",
      );
    }
    return notes;
  }

  const fromConvention = harvestConvention(dirs, conversion);
  notes.push(...fromConvention.notes);
  if (fromConvention.hooks.length > 0) {
    document.hooks = fromConvention.hooks;
    if (declared !== undefined) {
      notes.push(`hooks: the manifest declares none, so ${HOOKS_CONVENTION_FILE} was read instead`);
    }
    return notes;
  }

  delete document.hooks;
  return notes;
}

/**
 * Resolve an `mcpServers` written as a path into the map that document holds,
 * and rewrite the manifest's `mcpServers` key with it.
 *
 * @param dir - the plugin's install directory, the base for a relative path.
 * @param document - the JSON-parsed manifest, mutated in place.
 * @returns a note when the named document could not be used, empty otherwise.
 * @remarks
 * The key carries either the map itself or the name of a companion document
 * whose own `mcpServers` key holds it — one source or the other, never both,
 * the shape {@link resolveHooks} already reads `hooks` in. Only the path form is
 * resolved here; a map is left exactly as written and validated by the schema.
 *
 * A named servers document that cannot be used is a note rather than a failure:
 * what this key declares is one part of a plugin, so withholding it costs the
 * operator that part, while refusing the manifest costs them all of it — and
 * every other thing the plugin contributes with it. The plugin loads,
 * contributes no MCP servers, and says so. {@link harvestFile} reads a named
 * hooks document on the same rule.
 *
 * The size guard before inlining is what keeps this resolver's promise.
 * The manifest is re-serialized and re-checked against the same ceiling after
 * every resolver has run, so a companion small enough to read can still push the
 * document past it — and that failure refuses the *whole plugin*, which is the one
 * outcome naming a servers document must never produce.
 */
function inlineMcpServersDocument(
  dirs: PluginDirs,
  document: Record<string, unknown>,
  declared: string,
  conventional: boolean,
): { found: boolean; notes: string[] } {
  const withheld = "no MCP servers are contributed";
  const note = (reason: string): { found: false; notes: string[] } => ({
    found: false,
    notes: [`${MCP_SERVERS_KEY}: '${declared}' ${reason} — ${withheld}`],
  });
  if (declared.trim().length === 0) return note("names no document");

  const path = companionPath(dirs, declared);
  if (path === undefined) return note("resolves outside the plugin");

  const read = readBoundedPluginText(
    path,
    PLUGIN_RESOURCE_LIMITS.manifestBytes,
    `${MCP_SERVERS_KEY} document '${declared}'`,
  );
  if (!read.ok) {
    if (conventional && read.missing) return { found: false, notes: [] };
    return { found: false, notes: [`${MCP_SERVERS_KEY}: ${read.error} — ${withheld}`] };
  }

  let source: unknown;
  try {
    source = JSON.parse(read.text);
  } catch (error) {
    return note(`is not valid JSON (${(error as Error).message})`);
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return note("does not hold a JSON object");
  }

  const servers = (source as Record<string, unknown>)[MCP_SERVERS_KEY];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return note(`declares no '${MCP_SERVERS_KEY}' object`);
  }
  const projected = { ...document, [MCP_SERVERS_KEY]: servers };
  if (Buffer.byteLength(JSON.stringify(projected), "utf8") > PLUGIN_RESOURCE_LIMITS.manifestBytes) {
    return note("would not fit in the manifest once inlined");
  }
  document[MCP_SERVERS_KEY] = servers;
  return { found: true, notes: [] };
}

function resolveMcpServers(dirs: PluginDirs, document: Record<string, unknown>): string[] {
  const declared = document[MCP_SERVERS_KEY];
  if (typeof declared === "string") {
    delete document[MCP_SERVERS_KEY];
    return inlineMcpServersDocument(dirs, document, declared, false).notes;
  }
  if (declared !== undefined) return [];

  const notes: string[] = [];
  for (const conventional of MCP_CONVENTION_FILES) {
    const result = inlineMcpServersDocument(dirs, document, conventional, true);
    notes.push(...result.notes);
    if (result.found) return notes;
  }
  return notes;
}

/**
 * Drop the MCP server entries this host cannot use, keeping the rest.
 *
 * @param document - the JSON-parsed manifest, mutated in place.
 * @returns one note per entry dropped, empty when every entry is usable.
 * @remarks
 * The last step of reading `mcpServers`, and the one that keeps the key's
 * failures proportional. An entry can still be unusable after
 * {@link mcpServerPluginSchema} has ignored the keys this host gives no meaning
 * to — a stdio server that names no command, a remote one whose URL is not a
 * URL — and the schema reports that per *record*, so one such entry used to fail
 * the whole manifest and take the plugin's agents, hooks and skills with it.
 *
 * Validating each entry here, against the same schema the manifest will apply
 * to whatever survives, is what makes the outcome "this server is not
 * contributed" rather than "this plugin does not exist". The rule the manifest
 * enforces is unchanged; only the blast radius is.
 */
function sanitizeMcpServers(document: Record<string, unknown>): string[] {
  const declared = document[MCP_SERVERS_KEY];
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return [];

  const notes: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(declared as Record<string, unknown>)) {
    const parsed = mcpServerPluginSchema.safeParse(entry);
    if (parsed.success) {
      kept[name] = parsed.data;
      continue;
    }
    const issue = parsed.error.issues[0];
    const reason =
      issue === undefined
        ? "is not a usable server entry"
        : `${issue.path.map(String).join(".") || "(entry)"}: ${issue.message}`;
    notes.push(`${MCP_SERVERS_KEY}: '${name}' is not contributed — ${reason}`);
  }
  if (notes.length === 0) return notes;
  if (Object.keys(kept).length === 0) delete document[MCP_SERVERS_KEY];
  else document[MCP_SERVERS_KEY] = kept;
  return notes;
}

/** A manifest string worth showing, or undefined when it says nothing. */
function displayText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Take the presentation block off a manifest and read what Clarvis can show.
 *
 * @param document - the JSON-parsed manifest, mutated in place.
 * @returns the display metadata, and a note when a block was written but held
 *   nothing readable.
 * @remarks The key is consumed rather than left behind, so it stops being
 *   reported as a key Clarvis does not act on — which it no longer is. What the
 *   block carries beyond these two fields (icons, colours, categories) is
 *   dropped silently: it is not a directive, so losing it changes nothing about
 *   what the plugin does.
 */
function resolvePresentation(document: Record<string, unknown>): {
  presentation?: PluginPresentation;
  notes: string[];
} {
  const declared = document[PRESENTATION_KEY];
  if (declared === undefined) return { notes: [] };
  delete document[PRESENTATION_KEY];

  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    return { notes: [`${PRESENTATION_KEY}: not an object, so nothing was read from it`] };
  }
  const block = declared as Record<string, unknown>;
  const displayName = displayText(block.displayName);
  const shortDescription = displayText(block.shortDescription);
  if (displayName === undefined && shortDescription === undefined) {
    return { notes: [`${PRESENTATION_KEY}: no display name or short description to read`] };
  }
  return {
    presentation: {
      ...(displayName === undefined ? {} : { displayName }),
      ...(shortDescription === undefined ? {} : { shortDescription }),
    },
    notes: [],
  };
}

/**
 * The install directory's own name, when it is one this host would accept as a
 * plugin name.
 *
 * @param dir - the plugin's install directory.
 * @returns the directory name, or undefined when it is not a legal plugin name.
 * @remarks Validated by running the manifest schema over a document carrying
 *   nothing but the candidate, so the rule stays in the one place that owns it
 *   and cannot drift into a second copy here.
 */
function derivableName(dir: string): string | undefined {
  const candidate = basename(dir);
  return parsePluginManifest(JSON.stringify({ name: candidate })).ok ? candidate : undefined;
}

/**
 * Supply what a manifest leaves out, so a plugin written in another dialect is
 * never refused over a field this host happens to require.
 *
 * @param dir - the plugin's install directory.
 * @param document - the JSON-parsed manifest, mutated in place.
 * @param presentation - display metadata already taken off the manifest.
 * @returns one note per field supplied, so a reader can tell what the author
 *   wrote from what this host filled in.
 * @remarks
 * `name` is the one field the normalized manifest cannot do without. For an
 * existing install, the directory is the host-owned runtime namespace and is
 * therefore a safe source when a foreign manifest omits the field. A description
 * is only ever *moved*, never invented: the
 * presentation block's own summary is the plugin author's sentence about their
 * own plugin, whereas a placeholder would be this host putting words in their
 * mouth. Nothing else is supplied, because nothing else is required.
 */
function supplyDefaults(
  dir: string,
  document: Record<string, unknown>,
  presentation: PluginPresentation | undefined,
): string[] {
  const notes: string[] = [];

  if (displayText(document.name) === undefined) {
    const derived = derivableName(dir);
    if (derived !== undefined) {
      document.name = derived;
      notes.push(`name: not declared — using the install directory's name, '${derived}'`);
    }
  }

  if (displayText(document.description) === undefined) {
    const summary = presentation?.shortDescription;
    if (summary !== undefined) {
      document.description = summary;
      notes.push("description: not declared — using the short description shown with the plugin");
    }
  }

  return notes;
}

/**
 * Validate a manifest document, resolving whatever it expresses in another
 * host's dialect first.
 *
 * @param dir - the plugin's install directory.
 * @param raw - the manifest text, as read by {@link readPluginManifestSource}.
 * @param effectivePluginName - host-owned install identity used to namespace
 *   contributions; omitted only by standalone readers that have no install
 *   record.
 * @returns the validated manifest, or `error` when the text is not JSON or fails
 *   the manifest schema; `notes` carries unusable individual contributions,
 *   what was accepted but is not acted on, and what this host supplied for
 *   itself.
 */
export function resolvePluginManifest(
  dir: string,
  raw: string,
  manifestLocation?: string,
  effectivePluginName?: string,
): ResolvedPluginManifest {
  if (Buffer.byteLength(raw, "utf8") > PLUGIN_RESOURCE_LIMITS.manifestBytes) {
    return {
      error: `plugin manifest exceeds the ${String(PLUGIN_RESOURCE_LIMITS.manifestBytes)}-byte resource limit`,
      notes: [],
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { error: `invalid JSON: ${(error as Error).message}`, notes: [] };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { error: "a plugin manifest must be a JSON object", notes: [] };
  }

  const record = document as Record<string, unknown>;
  const dirs = pluginDirsFor(dir, manifestLocation);
  const notes: string[] = [];
  notes.push(...resolveMcpServers(dirs, record));
  notes.push(...sanitizeMcpServers(record));
  const pluginMcpServers =
    typeof record[MCP_SERVERS_KEY] === "object" &&
    record[MCP_SERVERS_KEY] !== null &&
    !Array.isArray(record[MCP_SERVERS_KEY])
      ? Object.keys(record[MCP_SERVERS_KEY])
      : [];
  const declaredPluginName = displayText(record.name);
  const pluginName =
    effectivePluginName ??
    (declaredPluginName !== undefined &&
    parsePluginManifest(JSON.stringify({ name: declaredPluginName })).ok
      ? declaredPluginName
      : derivableName(dir));
  notes.push(
    ...resolveHooks(dirs, record, {
      ...(pluginName === undefined ? {} : { pluginName }),
      pluginMcpServers,
    }),
  );
  const { presentation, notes: presentationNotes } = resolvePresentation(record);
  notes.push(...presentationNotes);
  notes.push(...supplyDefaults(dir, record, presentation));
  const shown = presentation === undefined ? {} : { presentation };

  const typos = suspectedManifestTypos(record);
  for (const { key, suggestion } of typos) {
    notes.push(`manifest key '${key}' is not recognized — did you mean '${suggestion}'?`);
  }

  notes.push(...pluginSkillRoots(dir, record.skills, manifestLocation).notes);

  const misspelled = new Set(typos.map((t) => t.key));
  const unknown = unknownManifestKeys(record).filter(
    (key) => key !== "skills" && !misspelled.has(key),
  );
  if (unknown.length > 0) {
    notes.push(`manifest keys Clarvis does not act on: ${unknown.join(", ")}`);
  }

  const parsed = parsePluginManifest(JSON.stringify(record));
  if (!parsed.ok) {
    const issue = parsed.kind === "schema" ? parsed.error.issues[0] : undefined;
    return {
      error:
        parsed.kind === "resource"
          ? parsed.error.message
          : issue !== undefined
            ? `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`
            : `invalid JSON: ${(parsed.error as Error).message}`,
      notes,
      ...shown,
    };
  }
  return { manifest: parsed.manifest, notes, ...shown };
}

/** Filename that turns a directory into one directly declared skill. */
const SKILL_MANIFEST_FILE = "skill.md";

/** Whether filesystem path identity follows Windows's case-insensitive convention. */
const CASE_INSENSITIVE_PLUGIN_PATHS = process.platform === "win32";

/** A stable comparison key for a resolved plugin path. */
function pluginPathKey(path: string): string {
  return CASE_INSENSITIVE_PLUGIN_PATHS ? path.toLowerCase() : path;
}

/**
 * Whether a directory directly holds a regular `SKILL.md` under the same
 * case-insensitive filename convention as `@clarvis/skills`.
 */
function isDirectSkillDirectory(dir: string): boolean {
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(dir);
  } catch {
    return false;
  }
  let entries = 0;
  let found = false;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) return found;
      entries += 1;
      if (entries > PLUGIN_RESOURCE_LIMITS.skillDirectoryEntries) return false;
      if (entry.isFile() && entry.name.toLowerCase() === SKILL_MANIFEST_FILE) found = true;
    }
  } catch {
    return false;
  } finally {
    try {
      opened.closeSync();
    } catch {
      /* A completed/lazily failed read may already have closed the directory handle. */
    }
  }
}

/**
 * Whether scanning `parent` is exactly equivalent to scanning its declared
 * direct-skill children separately.
 *
 * @remarks Any undeclared directory or symlink refuses compaction. This is
 * deliberately stricter than discovery: replacing many declarations with one
 * root must not make another contribution visible merely because it is nearby.
 */
function isExactSiblingSkillGroup(parent: string, members: ReadonlySet<string>): boolean {
  if (isDirectSkillDirectory(parent)) return false;
  let opened: ReturnType<typeof opendirSync>;
  try {
    opened = opendirSync(parent);
  } catch {
    return false;
  }
  let entries = 0;
  let directories = 0;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) return directories === members.size;
      entries += 1;
      if (entries > PLUGIN_RESOURCE_LIMITS.skillDirectoryEntries) return false;
      if (entry.isSymbolicLink()) return false;
      if (!entry.isDirectory()) continue;
      const child = join(parent, entry.name);
      directories += 1;
      if (!members.has(pluginPathKey(child)) || !isDirectSkillDirectory(child)) return false;
    }
  } catch {
    return false;
  } finally {
    try {
      opened.closeSync();
    } catch {
      /* A completed/lazily failed read may already have closed the directory handle. */
    }
  }
}

/**
 * Collapse exhaustive sibling lists into their parent scan root before applying
 * the per-plugin root budget.
 */
function compactSkillRoots(roots: string[]): string[] {
  if (
    roots.length <= MAX_PLUGIN_SKILL_ROOTS ||
    roots.length > PLUGIN_RESOURCE_LIMITS.skillDirectoryEntries
  ) {
    return roots;
  }

  const direct = new Map<string, boolean>();
  const groups = new Map<string, { parent: string; roots: string[]; members: Set<string> }>();
  for (const root of roots) {
    const key = pluginPathKey(root);
    const holdsSkill = direct.get(key) ?? isDirectSkillDirectory(root);
    direct.set(key, holdsSkill);
    if (!holdsSkill) continue;
    const parent = dirname(root);
    const parentKey = pluginPathKey(parent);
    const group = groups.get(parentKey) ?? { parent, roots: [], members: new Set<string>() };
    group.roots.push(root);
    group.members.add(key);
    groups.set(parentKey, group);
  }

  const replacements = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.roots.length < 2 || !isExactSiblingSkillGroup(group.parent, group.members)) continue;
    for (const root of group.roots) replacements.set(pluginPathKey(root), group.parent);
  }

  const compacted: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const effective = replacements.get(pluginPathKey(root)) ?? root;
    const key = pluginPathKey(effective);
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(effective);
  }
  return compacted;
}
