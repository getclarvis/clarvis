import { statSync } from "node:fs";
import path from "node:path";
import { readBoundedPrefix, readBoundedText } from "./bounded-read.ts";
import { levelEnabled, type Logger } from "@clarvis/capability";
import { SkillError } from "./errors.ts";
import { causeOf, warn } from "./lib/log.ts";
import {
  normalizeTools,
  parseSkillFrontmatterWithDefaults,
  parseSkillWithDefaults,
  type SkillFrontmatterDefaults,
} from "./parse.ts";
import { resolveResourcePath } from "./paths.ts";
import { composePresentation, readSkillSidecar } from "./sidecar.ts";
import {
  enumerateResources,
  findSkillSidecar,
  isHarnessConfigPath,
  listSkillDirs,
} from "./scan.ts";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FRONTMATTER_BYTES,
  MAX_SKILL_FRONTMATTER_CHARS,
  MAX_SKILL_NAME_CHARS,
  MAX_SKILL_RESOURCE_BYTES,
  MAX_SKILL_RESOURCE_CHARS,
  MAX_SKILL_SHORT_DESCRIPTION_CHARS,
  MAX_SKILLS,
  MAX_SKILLS_PER_ROOT,
} from "./limits.ts";
import type { SkillConfig } from "./config.ts";
import type { SkillFrontmatter } from "./schema.ts";
import type {
  ResolvedSkill,
  ShadowedSkill,
  SkillContent,
  SkillDefaultedField,
  SkillInfo,
  SkillRegistry,
  SkillRoot,
} from "./types.ts";

/**
 * The description carried by a skill whose manifest supplied none and whose
 * presentation metadata offered no short description.
 *
 * @remarks
 * Deliberately says nothing about what the skill does. A description is a claim
 * the author makes, and inventing one from a directory name would put words in
 * their mouth in the one place a model decides whether to load the skill at all.
 * The skill's name is not echoed here either: every surface that renders a
 * description renders the name beside it.
 */
const DEFAULT_SKILL_DESCRIPTION = "(no description supplied)";

/** The name a skill falls back to when even its directory name yields nothing usable. */
const FALLBACK_SKILL_NAME = "skill";

/** Characters a skill name may not carry, collapsed to a single separator. */
const UNSUPPORTED_NAME_CHARS = /[^A-Za-z0-9._-]+/g;

/** Leading or trailing separators left behind by {@link UNSUPPORTED_NAME_CHARS}. */
const EDGE_SEPARATORS = /^-+|-+$/g;

/** Agent Skills v1 bounds applied only to roots that opt into strict portability. */
const MAX_AGENT_SKILL_NAME_CHARS = 64;
const MAX_AGENT_SKILL_COMPATIBILITY_CHARS = 500;

/**
 * Derive a usable skill name from the directory that holds it.
 *
 * @param dir - the skill's directory.
 * @returns the directory's own name where that is already a legal skill name,
 *   else the closest legal form of it, else {@link FALLBACK_SKILL_NAME}.
 * @remarks The directory name is the best evidence available of what the author
 *   calls the skill, and the registry already treats it as the skill's identity
 *   everywhere else: a mismatch against the manifest is warned about, not
 *   corrected.
 */
function fallbackSkillName(dir: string): string {
  const sanitized = path
    .basename(dir)
    .replace(UNSUPPORTED_NAME_CHARS, "-")
    .replace(EDGE_SEPARATORS, "")
    .slice(0, MAX_SKILL_NAME_CHARS);
  return sanitized.length > 0 ? sanitized : FALLBACK_SKILL_NAME;
}

/**
 * Read the short description a manifest carries in its nested `metadata` bucket.
 *
 * @param frontmatter - the parsed frontmatter.
 * @returns the bounded, non-blank value, or `undefined`.
 * @remarks The bucket is where producing tools put presentation data
 * (`metadata.author` is already read from it), and the shape is loose because
 * the schema passes unknown keys through untouched.
 */
function metadataShortDescription(frontmatter: SkillFrontmatter): string | undefined {
  const bucket = (frontmatter as { metadata?: unknown }).metadata;
  if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket)) return undefined;
  const record = bucket as Record<string, unknown>;
  const value = record["short-description"] ?? record["short_description"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SKILL_SHORT_DESCRIPTION_CHARS) return undefined;
  return trimmed;
}

/**
 * Scan every configured root, merge the results with last-root-wins precedence,
 * and return a {@link SkillRegistry} for lookup and progressive disclosure.
 *
 * Each root is scanned independently (so an intra-root duplicate is resolved
 * before cross-root merging), and the roots are folded in order so a later root
 * shadows an earlier one of the same name through {@link mergeWinner}. The
 * number of distinct names retained is capped at {@link MAX_SKILLS}.
 *
 * @param config - resolved roots plus behavior flags (`strict`,
 *   `followSymlinks`); see {@link SkillConfig}.
 * @returns a registry whose `list`/`get`/`resource`/`size` read the merged set.
 * @throws {@link SkillError} in strict mode on a parse failure or an intra-root
 *   duplicate name; see {@link scanRoot}.
 */
export function buildRegistry(config: SkillConfig): SkillRegistry {
  const started = Date.now();
  const byName = new Map<string, ResolvedSkill>();
  const stats: DiscoveryStats = { dropped: 0 };
  let overflowed = false;
  for (const root of config.roots) {
    for (const skill of scanRoot(root, config, stats)) {
      const existing = byName.get(skill.info.name);
      if (existing !== undefined) {
        byName.set(skill.info.name, mergeWinner(skill, existing, config.logger));
        continue;
      }
      if (byName.size < MAX_SKILLS) {
        byName.set(skill.info.name, skill);
        continue;
      }
      if (config.strict) {
        throw new SkillError(
          "invalid_skill",
          `skill catalog contains more than ${String(MAX_SKILLS)} distinct skills`,
          { maximum: MAX_SKILLS },
        );
      }
      overflowed = true;
      stats.dropped += 1;
      rejected(config.logger, "catalog_overflow", { dir: skill.info.dir, file: skill.info.path });
      const largest = largestSkillName(byName);
      if (skill.info.name.localeCompare(largest) < 0) {
        byName.delete(largest);
        byName.set(skill.info.name, skill);
      }
    }
  }
  if (overflowed) {
    const message =
      `skill catalog contains more than ${String(MAX_SKILLS)} distinct skills; ` +
      `retaining the first ${String(MAX_SKILLS)} by name`;
    warn(`clarvis-skills: ${message}\n`, config.warningSink);
  }
  reportDiscovery(config, byName, stats, started);
  return makeRegistry(byName, config);
}

/** Counters accumulated across one {@link buildRegistry} pass. */
interface DiscoveryStats {
  /** Manifests that were found and then not admitted, for any reason. */
  dropped: number;
}

/**
 * Emit the one summary record a discovery pass produces.
 *
 * @param config - the configuration scanned, read for its roots and logger.
 * @param byName - the merged catalog.
 * @param stats - the counters accumulated during the scan.
 * @param started - the pass's start, from `Date.now()`.
 * @remarks This is the record that answers "why is my skill not loaded": the
 *   gap between `roots` and `skills`, and a non-zero `dropped` or `shadowed`,
 *   are the whole diagnosis at a glance, with the per-skill events below it
 *   naming the individual manifests. `shadowed` counts shadowed *definitions*,
 *   not skills, so two roots losing the same name count twice; `defaulted`
 *   counts skills carrying at least one supplied field.
 *
 *   The two counting loops run only when the record will survive, because
 *   {@link levelEnabled} is the only check that happens before the bindings
 *   object is built.
 */
function reportDiscovery(
  config: SkillConfig,
  byName: ReadonlyMap<string, ResolvedSkill>,
  stats: DiscoveryStats,
  started: number,
): void {
  if (!levelEnabled(config.logger, "info")) return;
  let shadowed = 0;
  let defaulted = 0;
  for (const skill of byName.values()) {
    shadowed += skill.info.shadowed?.length ?? 0;
    if (skill.info.defaulted !== undefined) defaulted += 1;
  }
  config.logger.info(
    {
      event: "skills.discovered",
      roots: config.roots.length,
      skills: byName.size,
      shadowed,
      defaulted,
      dropped: stats.dropped,
      ms: Date.now() - started,
    },
    "skill discovery finished; this catalog is what every agent in the run is offered",
  );
}

/** Why one manifest that was found did not reach the catalog. */
type SkillRejection = "parse" | "duplicate" | "root_overflow" | "catalog_overflow";

/**
 * Record one manifest the catalog did not admit.
 *
 * @param logger - the destination.
 * @param reason - which rule dropped it.
 * @param fields - the manifest's directory and file, plus any cause.
 * @remarks Guarded by {@link levelEnabled} because `parse` and `duplicate`
 *   repeat once per manifest, bounded only by `MAX_SKILLS_PER_ROOT` across four
 *   roots. The bindings object is allocated by this caller, so a backend's own
 *   level check would come too late to save it.
 */
function rejected(logger: Logger, reason: SkillRejection, fields: Record<string, unknown>): void {
  if (!levelEnabled(logger, "debug")) return;
  logger.debug(
    { event: "skill.rejected", reason, ...fields },
    "a skill manifest did not reach the catalog; it is not offered to any agent",
  );
}

/**
 * Record one required field the manifest did not usably carry.
 *
 * @param logger - the destination.
 * @param skill - the skill's resolved name.
 * @param field - the field that was supplied.
 * @param dir - the skill's directory.
 * @param chars - the length of the supplied value.
 * @remarks The value itself is never logged. A description is authored content
 *   even when Clarvis supplied it, because the fallback may be the author's own
 *   presentation text read out of the sidecar.
 */
function fieldDefaulted(
  logger: Logger,
  skill: string,
  field: string,
  dir: string,
  chars: number,
): void {
  if (!levelEnabled(logger, "debug")) return;
  logger.debug(
    { event: "skill.field_defaulted", skill, field, dir, chars },
    "a skill manifest declared no usable value for a required field; a stand-in was " +
      "supplied and the skill still reaches the catalog",
  );
}

function largestSkillName(skills: ReadonlyMap<string, ResolvedSkill>): string {
  let largest = "";
  for (const name of skills.keys()) {
    if (largest.length === 0 || name.localeCompare(largest) > 0) largest = name;
  }
  return largest;
}

/**
 * Apply last-root-wins while retaining the complete lower-precedence origin chain.
 *
 * @param winner - the higher-precedence definition.
 * @param loser - the definition it displaces.
 * @param logger - receives the collision as a `warn`.
 * @returns the winner, carrying the accumulated shadow chain.
 * @remarks This is the only place a cross-root shadow is observable, and until
 *   now it was recorded on the winner and never announced. "Why did the wrong
 *   skill win?" is answerable only from here: the record names the winning
 *   origin and every losing one, which is also how a plugin bootstrap comes to
 *   be refused for a foreign root.
 */
function mergeWinner(winner: ResolvedSkill, loser: ResolvedSkill, logger: Logger): ResolvedSkill {
  const shadowed: ShadowedSkill[] = [
    ...(winner.info.shadowed ?? []),
    toShadowed(loser.info),
    ...(loser.info.shadowed ?? []),
  ];
  logger.warn(
    {
      event: "skill.shadowed",
      skill: winner.info.name,
      winner: origin(winner.info),
      losers: shadowed.map(origin),
    },
    "more than one root defines this skill; the highest-precedence definition wins " +
      "and the others are never loaded",
  );
  return withInfo(winner, { ...winner.info, shadowed });
}

/** Project a skill or a shadowed definition down to the three fields that identify its origin. */
function origin(info: Pick<SkillInfo, "root" | "scope" | "source">): Record<string, string> {
  return { root: info.root, scope: info.scope, source: info.source };
}

/** Replace catalog metadata without touching a possibly lazy body getter. */
function withInfo(skill: ResolvedSkill, info: SkillInfo): ResolvedSkill {
  return {
    info,
    get body(): string {
      return skill.body;
    },
  };
}

/**
 * Project a full {@link SkillInfo} down to the {@link ShadowedSkill} origin
 * fields (source/scope/root/dir) recorded for a shadowed loser.
 */
function toShadowed(info: SkillInfo): ShadowedSkill {
  return {
    source: info.source,
    scope: info.scope,
    root: info.root,
    dir: info.dir,
  };
}

/**
 * Scan one root into its resolved skills, resolving intra-root duplicate names
 * with first-seen-wins.
 *
 * Directories are visited in the deterministic order of {@link listSkillDirs}.
 * A per-skill build failure is fatal under `config.strict`; otherwise it is
 * warned and skipped. A second skill with a name already seen in this root is a
 * hard {@link SkillError} under `strict` and a warned skip otherwise (the first
 * occurrence wins) — cross-root shadowing is handled later by
 * {@link buildRegistry}, not here.
 *
 * @param root - the root to scan (path, scope, source).
 * @param config - behavior flags; `strict` and `followSymlinks` are read.
 * @param stats - accumulates the count of manifests this root did not admit.
 * @returns the root's skills in first-seen insertion order.
 * @throws {@link SkillError} in strict mode on a build failure or duplicate name.
 */
function scanRoot(root: SkillRoot, config: SkillConfig, stats: DiscoveryStats): ResolvedSkill[] {
  if (root.include?.length === 0) return [];
  const included = root.include === undefined ? undefined : new Set(root.include);
  const byName = new Map<string, ResolvedSkill>();
  const candidates = listSkillDirs(
    root.path,
    config.followSymlinks,
    config,
    MAX_SKILLS_PER_ROOT + 1,
    {
      discovery: root.discovery,
      manifestName: root.manifestName,
      confinementRoot: root.confinementRoot,
    },
  );
  if (candidates.length > MAX_SKILLS_PER_ROOT) {
    const message =
      `skill root ${root.path} contains more than ${String(MAX_SKILLS_PER_ROOT)} manifests; ` +
      `only the first ${String(MAX_SKILLS_PER_ROOT)} by directory name are inspected`;
    if (config.strict) {
      throw new SkillError("invalid_skill", message, {
        root: root.path,
        actual: candidates.length,
        maximum: MAX_SKILLS_PER_ROOT,
      });
    }
    warn(`clarvis-skills: ${message}\n`, config.warningSink);
    stats.dropped += candidates.length - MAX_SKILLS_PER_ROOT;
    rejected(config.logger, "root_overflow", {
      dir: root.path,
      found: candidates.length,
      maximum: MAX_SKILLS_PER_ROOT,
    });
  }
  for (const { dir, file } of candidates.slice(0, MAX_SKILLS_PER_ROOT)) {
    let resolved: ResolvedSkill;
    try {
      resolved = buildResolvedSkill(root, dir, file, config);
    } catch (err) {
      if (config.strict) throw err;
      warn(`clarvis-skills: skipping ${file}: ${causeOf(err)}\n`, config.warningSink);
      stats.dropped += 1;
      rejected(config.logger, "parse", { dir, file, cause: causeOf(err) });
      continue;
    }
    if (included !== undefined && !included.has(resolved.info.name)) continue;
    const existing = byName.get(resolved.info.name);
    if (existing !== undefined) {
      if (config.strict) {
        throw new SkillError(
          "duplicate_skill",
          `Duplicate skill name '${resolved.info.name}' in ${existing.info.dir} and ${dir}.`,
          { name: resolved.info.name, paths: [existing.info.dir, dir] },
        );
      }
      warn(
        `clarvis-skills: duplicate skill '${resolved.info.name}' in ${dir} ignored ` +
          `(already defined in ${existing.info.dir})\n`,
        config.warningSink,
      );
      stats.dropped += 1;
      rejected(config.logger, "duplicate", { dir, file, skill: resolved.info.name });
      continue;
    }
    byName.set(resolved.info.name, resolved);
  }
  return [...byName.values()];
}

/**
 * Read and parse one `SKILL.md` into a {@link ResolvedSkill} tagged with its
 * origin root.
 *
 * The frontmatter `name` is authoritative when it carries a usable one; a
 * mismatch with the containing directory name is only warned, never corrected.
 * `allowed-tools` takes precedence over the legacy `tools` key, and
 * `user-invocable` defaults to `true` when absent.
 *
 * A required field the manifest does not usably carry is **supplied** rather
 * than fatal — the name from the directory, the description from the skill's
 * presentation metadata or a neutral placeholder — so a manifest written in a
 * dialect that leaves one out still reaches the catalog. Every supplied field is
 * warned about and recorded on {@link SkillInfo.defaulted}.
 *
 * @param root - the origin root, whose scope/source/path stamp the result.
 * @param dir - the skill's directory.
 * @param file - the absolute path to its `SKILL.md`.
 * @param config - behaviour flags; `followSymlinks` and `warningSink` are read.
 * @returns parsed catalog metadata plus a body getter that reads only on disclosure.
 * @throws {@link SkillError} on a bounded read or frontmatter parse failure the
 *   defaults cannot repair.
 * @remarks The body getter re-validates the frontmatter it reads, because the
 *   file may have changed since discovery and a stale catalog identity must
 *   never pair with a new body. A mismatch is reported as `skill.name_changed`
 *   and then thrown: the caller has to refresh, and the operator has to be able
 *   to see why an established skill suddenly stopped loading.
 */
function buildResolvedSkill(
  root: SkillRoot,
  dir: string,
  file: string,
  config: SkillConfig,
): ResolvedSkill {
  const warningSink = config.warningSink;
  const logger = config.logger;
  const prefix = readBoundedPrefix(file, {
    maxBytes: MAX_SKILL_FRONTMATTER_BYTES,
    maxFileBytes: MAX_SKILL_FILE_BYTES,
    code: "invalid_skill",
    label: "skill manifest",
    logger,
  });

  const sidecarFile = findSkillSidecar(dir, config.followSymlinks, config);
  const sidecar = sidecarFile === undefined ? undefined : readSkillSidecar(sidecarFile, config);
  const defaults: SkillFrontmatterDefaults = {
    name: fallbackSkillName(dir),
    description: sidecar?.presentation?.shortDescription ?? DEFAULT_SKILL_DESCRIPTION,
  };
  const parsed = parseSkillFrontmatterWithDefaults(prefix, MAX_SKILL_FRONTMATTER_CHARS, defaults);
  const frontmatter = parsed.frontmatter;
  assertRootValidation(root, frontmatter, parsed.defaulted, parsed.rawFrontmatter, dir, file);
  const suppliedName = parsed.defaulted.includes("name");

  const dirName = path.basename(dir);
  if (!suppliedName && frontmatter.name !== dirName) {
    warn(
      `clarvis-skills: skill name '${frontmatter.name}' does not match directory ` +
        `'${dirName}' (${file})\n`,
      warningSink,
    );
  }
  for (const field of parsed.defaulted) {
    warn(
      `clarvis-skills: skill in ${dir} declares no usable '${field}'; ` +
        `using '${String(frontmatter[field])}' (${file})\n`,
      warningSink,
    );
    fieldDefaulted(logger, frontmatter.name, field, dir, String(frontmatter[field]).length);
  }

  const shortDescription =
    sidecar?.presentation?.shortDescription ?? metadataShortDescription(frontmatter);
  const description =
    parsed.defaulted.includes("description") && shortDescription !== undefined
      ? shortDescription
      : frontmatter.description;
  const presentation = composePresentation({
    ...sidecar?.presentation,
    ...(shortDescription === undefined ? {} : { shortDescription }),
  });

  const rawTools = frontmatter["allowed-tools"] ?? frontmatter.tools;
  const allowedTools =
    root.validation === "agent-skills" && typeof rawTools === "string"
      ? rawTools.split(/\s+/).filter((tool) => tool.length > 0)
      : normalizeTools(rawTools);
  const info: SkillInfo = {
    name: frontmatter.name,
    description,
    metadata: { ...frontmatter, description },
    ...(rawTools === undefined ? {} : { allowedTools }),
    userInvocable: frontmatter["user-invocable"] ?? true,
    ...(sidecar?.catalogSuppressed === true ? { catalogSuppressed: true } : {}),
    ...(presentation === undefined ? {} : { presentation }),
    ...(parsed.defaulted.length > 0 ? { defaulted: parsed.defaulted } : {}),
    scope: root.scope,
    source: root.source,
    root: root.path,
    dir,
    path: file,
  };
  let loaded = false;
  let cachedBody = "";
  return {
    info,
    get body(): string {
      if (!loaded) {
        const raw = readBoundedText(file, {
          maxBytes: MAX_SKILL_FILE_BYTES,
          maxChars: MAX_SKILL_FILE_CHARS,
          code: "invalid_skill",
          label: "skill manifest",
          logger,
        });
        const current = parseSkillWithDefaults(raw, MAX_SKILL_FRONTMATTER_CHARS, defaults);
        assertRootValidation(
          root,
          current.frontmatter,
          current.defaulted,
          current.rawFrontmatter,
          dir,
          file,
        );
        if (current.frontmatter.name !== info.name) {
          logger.warn(
            {
              event: "skill.name_changed",
              skill: info.name,
              actual: current.frontmatter.name,
              path: file,
            },
            "a skill manifest was renamed after it was catalogued; its body is refused " +
              "until the catalog is refreshed",
          );
          throw new SkillError(
            "invalid_skill",
            `skill name changed from '${info.name}' to '${current.frontmatter.name}'; refresh required`,
            { path: file, expected: info.name, actual: current.frontmatter.name },
          );
        }
        cachedBody = current.body;
        loaded = true;
      }
      return cachedBody;
    },
  };
}

/** Apply the strict identity subset required by an Agent Skills-conformant root. */
function assertRootValidation(
  root: SkillRoot,
  frontmatter: SkillFrontmatter,
  defaulted: readonly SkillDefaultedField[],
  rawFrontmatter: unknown,
  dir: string,
  file: string,
): void {
  if (root.validation !== "agent-skills") return;
  if (defaulted.length > 0) {
    throw new SkillError(
      "invalid_skill",
      `Agent Skills frontmatter requires ${defaulted.join(" and ")}`,
      { path: file, fields: [...defaulted] },
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name)) {
    throw new SkillError(
      "invalid_skill",
      "Agent Skills name must contain lowercase alphanumeric segments separated by single hyphens",
      { path: file, name: frontmatter.name },
    );
  }
  if (frontmatter.name.length > MAX_AGENT_SKILL_NAME_CHARS) {
    throw new SkillError(
      "invalid_skill",
      `Agent Skills name must contain at most ${String(MAX_AGENT_SKILL_NAME_CHARS)} characters`,
      { path: file, name: frontmatter.name, maximum: MAX_AGENT_SKILL_NAME_CHARS },
    );
  }
  const directory = path.basename(dir);
  if (frontmatter.name !== directory) {
    throw new SkillError(
      "invalid_skill",
      `Agent Skills name '${frontmatter.name}' must match directory '${directory}'`,
      { path: file, name: frontmatter.name, directory },
    );
  }

  const raw =
    typeof rawFrontmatter === "object" && rawFrontmatter !== null && !Array.isArray(rawFrontmatter)
      ? (rawFrontmatter as Record<string, unknown>)
      : {};
  const license = raw.license;
  if (license !== undefined && typeof license !== "string") {
    throw new SkillError("invalid_skill", "Agent Skills license must be a string", {
      path: file,
    });
  }
  const compatibility = raw.compatibility;
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" ||
      compatibility.length === 0 ||
      compatibility.length > MAX_AGENT_SKILL_COMPATIBILITY_CHARS)
  ) {
    throw new SkillError(
      "invalid_skill",
      `Agent Skills compatibility must contain 1-${String(MAX_AGENT_SKILL_COMPATIBILITY_CHARS)} characters`,
      { path: file, maximum: MAX_AGENT_SKILL_COMPATIBILITY_CHARS },
    );
  }
  const metadata = raw.metadata;
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      Object.values(metadata as Record<string, unknown>).some((value) => typeof value !== "string"))
  ) {
    throw new SkillError(
      "invalid_skill",
      "Agent Skills metadata must map string keys to string values",
      { path: file },
    );
  }
  if (raw["allowed-tools"] !== undefined && typeof raw["allowed-tools"] !== "string") {
    throw new SkillError(
      "invalid_skill",
      "Agent Skills allowed-tools must be a space-separated string",
      { path: file },
    );
  }
}

/**
 * Wrap the merged name-to-skill map in the {@link SkillRegistry} surface.
 *
 * `list` returns infos sorted by name; `get` performs progressive disclosure by
 * attaching the body and lazily enumerating on-disk resources; `resource`
 * resolves and validates a relative resource path; `size` is the live count.
 *
 * @param byName - the resolved, merged skills keyed by name.
 * @param config - read for `followSymlinks` during resource enumeration.
 * @returns the registry facade over {@link byName}.
 * @remarks `get` returns `undefined` for an unknown name, whereas `resource`
 *   throws {@link SkillError} `not_found`; `resource` also throws `not_found` for
 *   a missing resource and `not_a_file` when the path is not a regular file. A
 *   path inside the harness configuration directory is reported `not_found` as
 *   well: it is not a bundled resource, and answering anything more specific
 *   would confirm the file exists to a caller that must not read it.
 */
function makeRegistry(byName: Map<string, ResolvedSkill>, config: SkillConfig): SkillRegistry {
  const resourcePath = (name: string, rel: string): string => {
    const skill = byName.get(name);
    if (skill === undefined) {
      throw new SkillError("not_found", `No such skill: ${name}`, { name });
    }
    const abs = resolveResourcePath(skill.info.dir, rel, config.logger);
    if (isHarnessConfigPath(skill.info.dir, rel, abs, config)) {
      throw new SkillError("not_found", `No such resource '${rel}' in skill '${name}'`, {
        name,
        rel,
      });
    }
    let stat;
    try {
      stat = statSync(abs);
    } catch (error) {
      config.logger.debug(
        { event: "skill.resource_missing", skill: name, rel, cause: causeOf(error) },
        "a skill resource could not be inspected; the read is refused as not found",
      );
      throw new SkillError("not_found", `No such resource '${rel}' in skill '${name}'`, {
        name,
        rel,
      });
    }
    if (!stat.isFile()) {
      throw new SkillError("not_a_file", `Resource '${rel}' in skill '${name}' is not a file`, {
        name,
        rel,
      });
    }
    return abs;
  };
  return {
    list(): SkillInfo[] {
      return [...byName.values()].map((s) => s.info).sort((a, b) => a.name.localeCompare(b.name));
    },
    get(name: string): SkillContent | undefined {
      const skill = byName.get(name);
      if (skill === undefined) return undefined;
      const body = skill.body;
      const resources = enumerateResources(skill.info.dir, config.followSymlinks, config);
      config.logger.debug(
        {
          event: "skill.body_disclosed",
          skill: skill.info.name,
          chars: body.length,
          resources: resources.length,
        },
        "a skill's body and resource listing were disclosed to the caller",
      );
      return { ...skill.info, body, resources };
    },
    resource(name: string, rel: string): string {
      return resourcePath(name, rel);
    },
    readResource(name: string, rel: string): string {
      const abs = resourcePath(name, rel);
      return readBoundedText(abs, {
        maxBytes: MAX_SKILL_RESOURCE_BYTES,
        maxChars: MAX_SKILL_RESOURCE_CHARS,
        code: "invalid_input",
        label: "skill resource",
        logger: config.logger,
      });
    },
    get size(): number {
      return byName.size;
    },
  };
}
