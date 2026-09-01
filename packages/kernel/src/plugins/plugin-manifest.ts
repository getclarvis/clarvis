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
import { existsSync, lstatSync, opendirSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
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
const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

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
  if (values.length === 0) return { roots: [], notes: [] };

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

/** Skill-root inputs carrying the discovery policy of the resolved plugin dialect. */
export function pluginSkillScanRoots(
  dir: string,
  declared: unknown,
  manifestLocation: string | undefined,
  format: "native" | "agent-plugin-v1" | undefined,
): Array<{
  path: string;
  discovery?: "immediate";
  manifestName?: "exact";
  validation?: "agent-skills";
  confinementRoot?: string;
}> {
  return pluginSkillRoots(dir, declared, manifestLocation).roots.map((path) =>
    format === "agent-plugin-v1"
      ? {
          path,
          discovery: "immediate",
          manifestName: "exact",
          validation: "agent-skills",
          confinementRoot: dir,
        }
      : { path },
  );
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

/** Whether a root manifest claims any published Agent Plugins schema. */
function claimsAgentPluginFormat(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>)["$schema"] === "string" &&
      ((value as Record<string, unknown>)["$schema"] as string).startsWith(
        "https://agent-plugins.org/schemas/",
      )
    );
  } catch {
    return false;
  }
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
  const rootPath = join(dir, MANIFEST_FILE);
  const rootPathError =
    pathEntryExists(rootPath) && confinedExistingPath(dir, rootPath) === undefined
      ? `plugin manifest '${MANIFEST_FILE}' resolves outside the plugin root`
      : undefined;
  const rootRead =
    rootPathError === undefined
      ? readBoundedPluginText(
          rootPath,
          PLUGIN_RESOURCE_LIMITS.manifestBytes,
          `plugin manifest '${MANIFEST_FILE}'`,
        )
      : undefined;
  if (rootRead?.ok && claimsAgentPluginFormat(rootRead.text)) {
    return { raw: rootRead.text, location: MANIFEST_FILE };
  }
  const rootError =
    rootPathError ??
    (rootRead !== undefined && !rootRead.ok && !rootRead.missing ? rootRead.error : undefined);

  const clarvisLocation = `${CLARVIS_MANIFEST_DIR}/${MANIFEST_FILE}`;
  const clarvisRead = readBoundedPluginText(
    join(dir, clarvisLocation),
    PLUGIN_RESOURCE_LIMITS.manifestBytes,
    `plugin manifest '${clarvisLocation}'`,
  );
  if (clarvisRead.ok) return { raw: clarvisRead.text, location: clarvisLocation };
  if (!clarvisRead.missing) return { error: clarvisRead.error };
  if (rootError !== undefined) return { error: rootError };

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
  /** Longer install-surface copy supplied by the publisher. */
  longDescription?: string;
  /** Publisher name shown on install surfaces. */
  developerName?: string;
  /** Marketplace category supplied by the publisher. */
  category?: string;
  /** Short human-readable capability labels. */
  capabilities?: string[];
  /** Publisher and legal links. */
  websiteURL?: string;
  privacyPolicyURL?: string;
  termsOfServiceURL?: string;
  /** Suggested prompts shown before a plugin is invoked. */
  defaultPrompt?: string[];
  /** Optional visual metadata; none of these paths is executable. */
  brandColor?: string;
  composerIcon?: string;
  logo?: string;
  screenshots?: string[];
}

/** The outcome of {@link resolvePluginManifest}. */
export interface ResolvedPluginManifest {
  /** The validated manifest, absent when `error` is set. */
  manifest?: PluginManifest;
  /** Dialect whose discovery and runtime rules produced the validated manifest. */
  format?: "native" | "agent-plugin-v1";
  /** Whether the author declared the runtime name or the host supplied its stable install identity. */
  nameSource?: "declared" | "derived";
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
  const withRuntime = (hooks: unknown[]): unknown[] =>
    hooks.map((hook) =>
      typeof hook === "object" && hook !== null && !Array.isArray(hook)
        ? {
            ...(hook as Record<string, unknown>),
            plugin_root: dirs.root,
            ...(conversion.pluginDataDir === undefined
              ? {}
              : { plugin_data: conversion.pluginDataDir }),
          }
        : hook,
    );

  const fromManifest = harvestDeclared(dirs, declared, conversion);
  notes.push(...fromManifest.notes);

  if (fromManifest.hooks.length > 0) {
    document.hooks = withRuntime(fromManifest.hooks);
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
    document.hooks = withRuntime(fromConvention.hooks);
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

  const sourceRecord = source as Record<string, unknown>;
  const wrapped = sourceRecord[MCP_SERVERS_KEY] ?? sourceRecord.mcp_servers;
  const directEntries = Object.entries(sourceRecord).filter(([key]) => key !== "$schema");
  const direct =
    directEntries.length > 0 &&
    directEntries.every(([, entry]) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return record.command !== undefined || record.url !== undefined || record.type !== undefined;
    })
      ? Object.fromEntries(directEntries)
      : undefined;
  const servers =
    typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped) ? wrapped : direct;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return note(`declares no '${MCP_SERVERS_KEY}'/'mcp_servers' object or direct server map`);
  }
  if (
    Object.values(servers as Record<string, unknown>).some(
      (entry) => typeof entry !== "object" || entry === null || Array.isArray(entry),
    )
  ) {
    return note(`is neither a direct server map nor a '${MCP_SERVERS_KEY}'/'mcp_servers' wrapper`);
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

/** Detect a borrowed-config reference behind a bounded iterative object walk. */
function containsBorrowedUserConfigReference(value: unknown): boolean {
  const pending: unknown[] = [value];
  let inspected = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (current.includes("${user_config")) return true;
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    const children: unknown[] = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    inspected += children.length;
    if (inspected > 20_000) return true;
    pending.push(...children);
  }
  return false;
}

/**
 * Translate borrowed-host `userConfig` references onto Clarvis's existing env/key lookup.
 *
 * @remarks Only a whole-value `${user_config.key}` inside a stdio server's `env` map is
 * accepted. It becomes `${DESTINATION_ENV_NAME}`; no default or secret from the manifest is
 * consumed, persisted, or logged. A malformed or structurally excessive reference withholds only
 * its server.
 */
function resolveBorrowedUserConfig(
  document: Record<string, unknown>,
  borrowedDialect: boolean,
): string[] {
  const declared = document.userConfig;
  if (borrowedDialect) delete document.userConfig;
  const entries =
    typeof declared === "object" && declared !== null && !Array.isArray(declared)
      ? Object.entries(declared as Record<string, unknown>)
      : [];
  const definitions = new Set(
    entries
      .filter(
        ([, definition]) =>
          typeof definition === "object" &&
          definition !== null &&
          !Array.isArray(definition) &&
          (definition as Record<string, unknown>).type === "string",
      )
      .map(([key]) => key),
  );
  const servers = document[MCP_SERVERS_KEY];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return declared === undefined
      ? []
      : ["userConfig: declared, but no MCP environment references it"];
  }
  const notes: string[] = [];
  if (entries.length > 128) {
    definitions.clear();
    notes.push("userConfig: exceeds the 128-entry compatibility limit");
  }
  const kept: Record<string, unknown> = {};
  for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof rawServer !== "object" || rawServer === null || Array.isArray(rawServer)) {
      kept[serverName] = rawServer;
      continue;
    }
    const server = { ...(rawServer as Record<string, unknown>) };
    let error: string | undefined;
    for (const [field, value] of Object.entries(server)) {
      if (field !== "env" && containsBorrowedUserConfigReference(value)) {
        error = `contains a userConfig reference in unsupported field '${field}'`;
        break;
      }
    }
    if (error !== undefined) {
      notes.push(`${MCP_SERVERS_KEY}: '${serverName}' is not contributed — ${error}`);
      continue;
    }
    const rawEnv = server.env;
    if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) {
      if (error === undefined && containsBorrowedUserConfigReference(rawEnv)) {
        error = "contains a userConfig reference outside a string environment value";
      }
      if (error === undefined) kept[serverName] = server;
      else notes.push(`${MCP_SERVERS_KEY}: '${serverName}' is not contributed — ${error}`);
      continue;
    }
    const env: Record<string, unknown> = { ...(rawEnv as Record<string, unknown>) };
    for (const [destination, value] of Object.entries(env)) {
      if (!containsBorrowedUserConfigReference(value)) continue;
      if (typeof value !== "string") {
        error = "contains a userConfig reference outside a string environment value";
        break;
      }
      const match = /^\$\{user_config\.([A-Za-z0-9_.-]{1,128})\}$/.exec(value);
      if (match === null) {
        error = "contains an embedded or malformed userConfig reference";
        break;
      }
      const key = match[1];
      if (key === undefined) {
        error = "contains a userConfig reference without a key";
        break;
      }
      if (!borrowedDialect) {
        error = "uses userConfig outside a borrowed-host manifest";
        break;
      }
      if (!definitions.has(key)) {
        error = `references undeclared userConfig key '${key}'`;
        break;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(destination)) {
        error = `maps userConfig key '${key}' onto invalid environment name '${destination}'`;
        break;
      }
      if (server.expandVariables === false) {
        error = "disables variable expansion required by its userConfig environment mapping";
        break;
      }
      env[destination] = `\${${destination}}`;
    }
    if (error !== undefined) {
      notes.push(`${MCP_SERVERS_KEY}: '${serverName}' is not contributed — ${error}`);
      continue;
    }
    server.env = env;
    kept[serverName] = server;
  }
  if (Object.keys(kept).length === 0) delete document[MCP_SERVERS_KEY];
  else document[MCP_SERVERS_KEY] = kept;
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
function displayText(value: unknown, max = 4_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}

/** Read a bounded array of non-empty presentation strings. */
function displayTextList(value: unknown, maxItems = 32, maxChars = 512): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) return undefined;
  const strings = value.map((entry) => displayText(entry, maxChars));
  return strings.every((entry): entry is string => entry !== undefined) ? strings : undefined;
}

/** Read a safe external HTTP(S) presentation link. */
function displayUrl(value: unknown): string | undefined {
  const text = displayText(value);
  if (text === undefined) return undefined;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/** Read one plugin-relative, non-traversing asset path. */
function displayAssetPath(value: unknown): string | undefined {
  const text = displayText(value, 1_024);
  if (text === undefined || !text.startsWith("./") || text.includes("\\") || text.includes("\0")) {
    return undefined;
  }
  return text.split("/").some((segment) => segment === "..") ? undefined : text;
}

/** Read an array of plugin-relative visual asset paths. */
function displayAssetPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const paths = value.map(displayAssetPath);
  return paths.every((entry): entry is string => entry !== undefined) ? paths : undefined;
}

/**
 * Take the presentation block off a manifest and read what Clarvis can show.
 *
 * @param document - the JSON-parsed manifest, mutated in place.
 * @returns the display metadata, and a note when a block was written but held
 *   nothing readable.
 * @remarks The key is consumed rather than left behind, so it stops being
 *   reported as a key Clarvis does not act on. Every recognized value remains
 *   display-only and cannot widen what the plugin may execute.
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
  const presentation: PluginPresentation = {
    ...(displayText(block.displayName, 128) === undefined
      ? {}
      : { displayName: displayText(block.displayName, 128) }),
    ...(displayText(block.shortDescription, 512) === undefined
      ? {}
      : { shortDescription: displayText(block.shortDescription, 512) }),
    ...(displayText(block.longDescription, 4_000) === undefined
      ? {}
      : { longDescription: displayText(block.longDescription, 4_000) }),
    ...(displayText(block.developerName, 256) === undefined
      ? {}
      : { developerName: displayText(block.developerName, 256) }),
    ...(displayText(block.category, 128) === undefined
      ? {}
      : { category: displayText(block.category, 128) }),
    ...(displayTextList(block.capabilities) === undefined
      ? {}
      : { capabilities: displayTextList(block.capabilities) }),
    ...(displayUrl(block.websiteURL) === undefined
      ? {}
      : { websiteURL: displayUrl(block.websiteURL) }),
    ...(displayUrl(block.privacyPolicyURL) === undefined
      ? {}
      : { privacyPolicyURL: displayUrl(block.privacyPolicyURL) }),
    ...(displayUrl(block.termsOfServiceURL) === undefined
      ? {}
      : { termsOfServiceURL: displayUrl(block.termsOfServiceURL) }),
    ...(displayTextList(block.defaultPrompt, 32, 4_000) === undefined
      ? {}
      : { defaultPrompt: displayTextList(block.defaultPrompt, 32, 4_000) }),
    ...(typeof block.brandColor === "string" && /^#[0-9a-f]{6}$/i.test(block.brandColor)
      ? { brandColor: block.brandColor.toLowerCase() }
      : {}),
    ...(displayAssetPath(block.composerIcon) === undefined
      ? {}
      : { composerIcon: displayAssetPath(block.composerIcon) }),
    ...(displayAssetPath(block.logo) === undefined ? {} : { logo: displayAssetPath(block.logo) }),
    ...(displayAssetPaths(block.screenshots) === undefined
      ? {}
      : { screenshots: displayAssetPaths(block.screenshots) }),
  };
  if (Object.keys(presentation).length === 0) {
    return { notes: [`${PRESENTATION_KEY}: no supported display metadata to read`] };
  }
  return {
    presentation,
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
 * @param effectivePluginName - stable host-owned identity, when already known.
 * @returns one note per field supplied, so a reader can tell what the author
 *   wrote from what this host filled in.
 * @remarks
 * `name` is the one field the normalized manifest cannot do without. For an
 * existing install or marketplace action, the host-owned runtime namespace is
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
  effectivePluginName?: string,
): string[] {
  const notes: string[] = [];

  if (displayText(document.name) === undefined) {
    const derived =
      effectivePluginName !== undefined &&
      parsePluginManifest(JSON.stringify({ name: effectivePluginName })).ok
        ? effectivePluginName
        : derivableName(dir);
    if (derived !== undefined) {
      document.name = derived;
      notes.push(`name: not declared — using the host-owned install identity, '${derived}'`);
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

const AGENT_PLUGIN_NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const AGENT_PLUGIN_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const agentPluginManifestSchema = z
  .object({
    $schema: z.literal(AGENT_PLUGIN_SCHEMA),
    name: z.string().min(1).max(64).regex(AGENT_PLUGIN_NAME_RE),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

const agentStdioServerSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict();
const agentRemoteServerSchema = z
  .object({
    type: z.enum(["streamable-http", "sse"]),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Runtime paths required to normalize portable Agent Plugin MCP declarations. */
export interface PluginManifestRuntime {
  /** Persistent client-managed data directory dedicated to this installed instance. */
  dataDir: string;
}

interface AgentManifestNormalization {
  document?: Record<string, unknown>;
  error?: string;
  notes: string[];
}

/** First validation issue rendered as one stable operator diagnostic. */
function firstZodIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined
    ? "schema validation failed"
    : `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`;
}

/** Filesystem-resolved containment for a package path that must already exist. */
function confinedExistingPath(root: string, target: string): string | undefined {
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    const comparableRoot = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
    const comparableTarget = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
    return comparableTarget === comparableRoot || comparableTarget.startsWith(comparableRoot + sep)
      ? realTarget
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether one directory entry exists without following a possibly dangling link. */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Single-pass expansion of the two portable Agent Plugin placeholders. */
function expandAgentPluginValue(value: string, root: string, data: string): string {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_match, kind: string) =>
    kind === "ROOT" ? root : data,
  );
}

/** Validate and resolve a portable stdio command token. */
function agentPluginCommand(root: string, command: string): string | undefined {
  if (command.includes("\0")) return undefined;
  if (!command.startsWith("./")) {
    return command.includes("/") || command.includes("\\") ? undefined : command;
  }
  const resolved = confinedExistingPath(root, resolve(root, command));
  if (resolved === undefined) return undefined;
  try {
    return statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a portable stdio working directory and enforce its declared base. */
function agentPluginCwd(root: string, data: string, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return realpathSync(root);
  let base: string;
  if (cwd.startsWith("./")) base = root;
  else if (cwd === "${PLUGIN_ROOT}" || cwd.startsWith("${PLUGIN_ROOT}/")) base = root;
  else if (cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")) base = data;
  else return undefined;
  const expanded = expandAgentPluginValue(cwd, root, data);
  const target = cwd.startsWith("./") ? resolve(root, cwd) : resolve(expanded);
  const lexicalBase = resolve(base);
  const lexicalTarget = resolve(target);
  if (lexicalTarget !== lexicalBase && !lexicalTarget.startsWith(lexicalBase + sep))
    return undefined;
  if (!existsSync(lexicalTarget)) return lexicalTarget;
  return confinedExistingPath(lexicalBase, lexicalTarget);
}

/** Whether a remote Agent Plugin endpoint obeys the portable URL policy. */
function validAgentPluginUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    return false;
  }
  if (url.protocol === "https:") return true;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname === "::1") return true;
  if (isIP(hostname) !== 4) return false;
  return hostname.split(".")[0] === "127";
}

/** Validate fixed literal HTTP headers, including case-insensitive uniqueness. */
function validAgentPluginHeaders(headers: Record<string, string>): boolean {
  const seen = new Set<string>();
  try {
    for (const [name, value] of Object.entries(headers)) {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      validateHeaderName(name);
      validateHeaderValue(name, value);
    }
    return true;
  } catch {
    return false;
  }
}

/** Normalize one Agent Plugins v1 MCP entry into Clarvis's native server shape. */
function normalizeAgentMcpServer(
  root: string,
  data: string,
  entry: unknown,
): { server?: unknown; error?: string } {
  const stdio = agentStdioServerSchema.safeParse(entry);
  if (stdio.success) {
    const command = agentPluginCommand(root, stdio.data.command);
    if (command === undefined) return { error: "command is not a confined executable token" };
    const cwd = agentPluginCwd(root, data, stdio.data.cwd);
    if (cwd === undefined) return { error: "cwd is not confined to PLUGIN_ROOT or PLUGIN_DATA" };
    const env = stdio.data.env ?? {};
    const reserved = Object.keys(env).some((name) =>
      process.platform === "win32"
        ? ["plugin_root", "plugin_data"].includes(name.toLowerCase())
        : name === "PLUGIN_ROOT" || name === "PLUGIN_DATA",
    );
    if (reserved) return { error: "env may not define PLUGIN_ROOT or PLUGIN_DATA" };
    return {
      server: {
        type: "stdio",
        command,
        ...(stdio.data.args === undefined
          ? {}
          : {
              args: stdio.data.args.map((value) => expandAgentPluginValue(value, root, data)),
            }),
        env: {
          ...Object.fromEntries(
            Object.entries(env).map(([name, value]) => [
              name,
              expandAgentPluginValue(value, root, data),
            ]),
          ),
          PLUGIN_ROOT: root,
          PLUGIN_DATA: data,
        },
        cwd,
        expandVariables: false,
      },
    };
  }

  const remote = agentRemoteServerSchema.safeParse(entry);
  if (!remote.success) {
    return {
      error: firstZodIssue(
        stdio.error.issues.length <= remote.error.issues.length ? stdio.error : remote.error,
      ),
    };
  }
  if (!validAgentPluginUrl(remote.data.url)) return { error: "url violates Agent Plugins policy" };
  if (!validAgentPluginHeaders(remote.data.headers ?? {})) {
    return { error: "headers contain an invalid or duplicate field name/value" };
  }
  return {
    server: {
      type: remote.data.type === "streamable-http" ? "http" : "sse",
      url: remote.data.url,
      ...(remote.data.headers === undefined ? {} : { headers: remote.data.headers }),
      expandVariables: false,
    },
  };
}

/** Load only root `mcp.json` using Agent Plugins v1 component failure boundaries. */
function normalizeAgentMcp(
  root: string,
  data: string,
): { servers: Record<string, unknown>; notes: string[] } {
  const path = join(root, "mcp.json");
  if (pathEntryExists(path) && confinedExistingPath(root, path) === undefined) {
    return {
      servers: {},
      notes: ["mcp.json: path resolves outside the plugin root — MCP is disabled for this plugin"],
    };
  }
  const read = readBoundedPluginText(
    path,
    PLUGIN_RESOURCE_LIMITS.manifestBytes,
    "Agent Plugin MCP configuration 'mcp.json'",
  );
  if (!read.ok) {
    return read.missing
      ? { servers: {}, notes: [] }
      : { servers: {}, notes: [`mcp.json: ${read.error} — MCP is disabled for this plugin`] };
  }
  let source: unknown;
  try {
    source = JSON.parse(read.text);
  } catch (error) {
    return {
      servers: {},
      notes: [
        `mcp.json: invalid JSON (${(error as Error).message}) — MCP is disabled for this plugin`,
      ],
    };
  }
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return {
      servers: {},
      notes: ["mcp.json: root is not an object — MCP is disabled for this plugin"],
    };
  }
  const document = source as Record<string, unknown>;
  const keys = Object.keys(document);
  if (
    document["$schema"] !== AGENT_MCP_SCHEMA ||
    keys.some((key) => key !== "$schema" && key !== "mcpServers") ||
    typeof document.mcpServers !== "object" ||
    document.mcpServers === null ||
    Array.isArray(document.mcpServers)
  ) {
    return {
      servers: {},
      notes: [
        "mcp.json: unsupported schema or invalid top-level shape — MCP is disabled for this plugin",
      ],
    };
  }
  const servers: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [name, entry] of Object.entries(document.mcpServers as Record<string, unknown>)) {
    if (name.length === 0) {
      notes.push("mcp.json: an empty server name is not contributed");
      continue;
    }
    const normalized = normalizeAgentMcpServer(root, data, entry);
    if (normalized.server === undefined) {
      notes.push(`mcp.json: '${name}' is not contributed — ${normalized.error ?? "invalid entry"}`);
    } else {
      const parsed = mcpServerPluginSchema.safeParse(normalized.server);
      if (!parsed.success) {
        notes.push(`mcp.json: '${name}' is not contributed — ${firstZodIssue(parsed.error)}`);
      } else {
        servers[name] = parsed.data;
      }
    }
  }
  return { servers, notes };
}

/** Validate and project a root Agent Plugins v1 manifest into host-native fields. */
function normalizeAgentManifest(
  dir: string,
  location: string | undefined,
  document: Record<string, unknown>,
  runtime: PluginManifestRuntime | undefined,
): AgentManifestNormalization | undefined {
  const schema = document["$schema"];
  if (typeof schema !== "string" || !schema.startsWith("https://agent-plugins.org/schemas/")) {
    return undefined;
  }
  if (location !== MANIFEST_FILE) {
    return { error: "Agent Plugins manifests must be root plugin.json", notes: [] };
  }
  if (schema !== AGENT_PLUGIN_SCHEMA) {
    return { error: `unsupported Agent Plugins manifest schema '${schema}'`, notes: [] };
  }
  const notes = Object.keys(document)
    .filter((key) => !AGENT_PLUGIN_KEYS.has(key))
    .sort()
    .map((key) => `Agent Plugins manifest field '${key}' is unknown and was ignored`);
  const candidate = Object.fromEntries(
    Object.entries(document).filter(([key]) => AGENT_PLUGIN_KEYS.has(key)),
  ) as Record<string, unknown>;
  if (
    candidate.extensions !== undefined &&
    (typeof candidate.extensions !== "object" ||
      candidate.extensions === null ||
      Array.isArray(candidate.extensions))
  ) {
    delete candidate.extensions;
    notes.push("Agent Plugins manifest field 'extensions' is not an object and was ignored");
  }
  const parsed = agentPluginManifestSchema.safeParse(candidate);
  if (!parsed.success) return { error: firstZodIssue(parsed.error), notes };

  const root = confinedExistingPath(dir, dir);
  if (root === undefined) return { error: "plugin root could not be filesystem-resolved", notes };
  const skillsPath = join(root, DEFAULT_SKILLS_DIR);
  let skills: string[] = [];
  if (existsSync(skillsPath)) {
    const resolvedSkills = confinedExistingPath(root, skillsPath);
    try {
      if (resolvedSkills === undefined || !statSync(resolvedSkills).isDirectory()) {
        notes.push("skills: fixed 'skills/' location is invalid — no skills are contributed");
      } else {
        skills = [resolvedSkills];
      }
    } catch {
      notes.push("skills: fixed 'skills/' location is invalid — no skills are contributed");
    }
  }
  const runtimeData =
    runtime === undefined
      ? undefined
      : (() => {
          try {
            return realpathSync(runtime.dataDir);
          } catch {
            return resolve(runtime.dataDir);
          }
        })();
  const mcp =
    runtimeData === undefined
      ? {
          servers: {},
          notes: existsSync(join(root, "mcp.json"))
            ? ["mcp.json: plugin runtime data path is unavailable — MCP is disabled for this view"]
            : [],
        }
      : normalizeAgentMcp(root, runtimeData);
  notes.push(...mcp.notes);
  const normalized: Record<string, unknown> = {
    name: parsed.data.name,
    ...(parsed.data.version === undefined || parsed.data.version.length === 0
      ? {}
      : { version: parsed.data.version }),
    ...(parsed.data.description === undefined || parsed.data.description.length === 0
      ? {}
      : { description: parsed.data.description }),
    ...(parsed.data.author?.name === undefined || parsed.data.author.name.length === 0
      ? {}
      : { author: parsed.data.author }),
    ...(parsed.data.homepage === undefined ? {} : { homepage: parsed.data.homepage }),
    ...(parsed.data.repository === undefined ? {} : { repository: parsed.data.repository }),
    ...(parsed.data.license === undefined ? {} : { license: parsed.data.license }),
    ...(parsed.data.keywords === undefined ? {} : { keywords: parsed.data.keywords }),
    skills,
    ...(Object.keys(mcp.servers).length === 0 ? {} : { mcpServers: mcp.servers }),
  };
  return { document: normalized, notes };
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
  runtime?: PluginManifestRuntime,
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

  let record = document as Record<string, unknown>;
  const dirs = pluginDirsFor(dir, manifestLocation);
  const notes: string[] = [];
  let presentation: PluginPresentation | undefined;
  let nameSource: "declared" | "derived" = "declared";
  const agentPlugin = normalizeAgentManifest(dir, manifestLocation, record, runtime);
  if (agentPlugin !== undefined) {
    notes.push(...agentPlugin.notes);
    if (agentPlugin.document === undefined) {
      return { error: agentPlugin.error ?? "invalid Agent Plugins manifest", notes };
    }
    record = agentPlugin.document;
  } else {
    notes.push(...resolveMcpServers(dirs, record));
    const manifestHolder = manifestLocation === undefined ? "" : dirname(manifestLocation);
    const borrowedDialect =
      manifestHolder !== "" &&
      manifestHolder !== CLARVIS_MANIFEST_DIR &&
      HOST_MANIFEST_DIR.test(manifestHolder);
    notes.push(...resolveBorrowedUserConfig(record, borrowedDialect));
    notes.push(...sanitizeMcpServers(record));
    const pluginMcpServers =
      typeof record[MCP_SERVERS_KEY] === "object" &&
      record[MCP_SERVERS_KEY] !== null &&
      !Array.isArray(record[MCP_SERVERS_KEY])
        ? Object.keys(record[MCP_SERVERS_KEY])
        : [];
    const declaredPluginName = displayText(record.name);
    nameSource = declaredPluginName === undefined ? "derived" : "declared";
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
        ...(runtime?.dataDir === undefined ? {} : { pluginDataDir: runtime.dataDir }),
      }),
    );
    const resolvedPresentation = resolvePresentation(record);
    presentation = resolvedPresentation.presentation;
    notes.push(...resolvedPresentation.notes);
    notes.push(...supplyDefaults(dir, record, presentation, effectivePluginName));
  }
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
  return {
    manifest: parsed.manifest,
    format: agentPlugin === undefined ? "native" : "agent-plugin-v1",
    nameSource,
    notes,
    ...shown,
  };
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
