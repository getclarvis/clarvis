# Skill discovery, parsing, precedence and progressive disclosure

> Implemented at `packages/...`. Every claim below is anchored to a file and line. Open questions
> are collected in the final section.

## 1. Purpose

`@clarvis/skills` turns directories of `SKILL.md` files into a merged, in-memory catalog and serves
that catalog in three tiers: **list** (name + description metadata), **get** (body + enumerated
bundled resources), **resource/readResource** (one confined file)
(`packages/skills/src/types.ts:194`). The tiering is the point — the run's system prompt receives
only names and one-line descriptions (`packages/skills/src/catalog/index.ts:32`), and the model pulls
a body on demand through the `load_skill` tool (`packages/skills/src/tool.ts:33`).

The package also ships the second half of the feature: the loop **capability** that gates the catalog
on an env flag and a per-agent grant, renders the system-prompt section, and dispatches `load_skill`
(`packages/skills/src/capability.ts:86`). Its `SkillsProvider` port
(`packages/skills/src/tool.ts:22`) is the only surface hosts consume, which is what lets the kernel
adapt a scanned catalog into the protocol `SkillsService` for slash-commands
(`packages/kernel/src/skills/skills-service.ts:30`) without either side knowing the other's
internals.

Everything the reader does is bounded and degrading. Roots, per-root manifests, distinct skills,
directory entries, nesting depth, file bytes, decoded characters, resource counts and sidecar size
each carry a hard cap (`packages/skills/src/limits.ts:2`–`:73`), and a manifest written in a dialect
Clarvis cannot fully read is repaired or partially defaulted rather than deleted
(`packages/skills/src/parse.ts:64`, `packages/skills/src/parse.ts:169`,
`packages/skills/src/schema.ts:57`).

---

## 2. Surface

### 2.1 Package entrypoints

| Subpath | File | Contents |
| --- | --- | --- |
| `.` | `packages/skills/src/index.ts` | discovery facade, config resolution, `discoverSkills`, `normalizeTools`, preset roots, the root cap, the error-code union, diagnostics and types |
| `./catalog` | `packages/skills/src/catalog/index.ts` | `renderSkillCatalog` only — one function, one parameter |
| `./capability` | `packages/skills/src/capability.ts` | loop capability, `load_skill` tool + handler, bootstrap resolution, `SkillsProvider` |

Declared in `packages/skills/package.json:25`–`:42`; every entry resolves to `src/*.ts` under the
`bun` condition and `dist/*.js` otherwise.

### 2.2 Root entry (`@clarvis/skills`)

| Export | Signature / shape | Source |
| --- | --- | --- |
| `createAgentSkills(options)` | `(AgentSkillsOptions) => AgentSkills` | `packages/skills/src/index.ts:47` |
| `AgentSkills` | `{ config; listSkills(); loadSkill(name); resourcePath(name, rel); readResource(name, rel); refresh() }` | `packages/skills/src/index.ts:12` |
| `discoverSkills(config)` | `(SkillConfig) => SkillRegistry` | `packages/skills/src/core.ts:15` |
| `resolveConfig(options)` | `(AgentSkillsOptions) => SkillConfig` | `packages/skills/src/config.ts:82` |
| `normalizeTools(tools)` | `(string[] \| string \| undefined) => string[]` | `packages/skills/src/parse.ts:279` |
| `ParsedSkill` | type only | `packages/skills/src/parse.ts:16` |
| `clarvisSkillRoots(opts?)` | `(ClarvisSkillRootsOptions) => SkillRootInput[]` | `packages/skills/src/preset.ts:32` |
| `MAX_SKILL_ROOTS` | `32` | `packages/skills/src/limits.ts:2` |
| `ErrorCode` | type only — the closed union of error codes | `packages/skills/src/errors.ts:6` |
| re-exports from `@clarvis/paths` | `resolveWorkspaceDir`, `resolveAgainst`, `expandHome` | `packages/skills/src/index.ts:66` |

The parser, the sidecar reader, the path guard, the frontmatter schema and both error values are
**not** on this entry. They exist and are used throughout the package, but reaching them requires
importing a module rather than the entrypoint: `parseSkill` (`packages/skills/src/parse.ts:267`),
`readSkillSidecar` / `SkillSidecar` (`packages/skills/src/sidecar.ts:286`, `:25`),
`findSkillSidecar` (`packages/skills/src/scan.ts:161`), `resolveResourcePath`
(`packages/skills/src/paths.ts:25`), `skillFrontmatterSchema` (`packages/skills/src/schema.ts:95`),
`SkillError` / `fsError` (`packages/skills/src/errors.ts:20`, `:48`), `StartupError`
(`packages/skills/src/config.ts:19`) and the two defaults `DEFAULT_STRICT` / `DEFAULT_FOLLOW_SYMLINKS`
(`packages/skills/src/config.ts:10`, `:12`). `HARNESS_CONFIG_DIR` (`packages/skills/src/scan.ts:43`)
goes one step further: it is a file-local `const` with no `export` at all, read four times inside
`scan.ts`. Consequently a host observes a startup misconfiguration only as an `Error` whose `name` is
`"StartupError"`, and a skill failure only as an error carrying one of the public `ErrorCode` values
— the classes themselves are not importable from `@clarvis/skills`. (`@clarvis/tools` publishes its
own, unrelated `StartupError` and `fsError`; those are on *its* public surface.)

`AgentSkillsOptions` (and every `SkillConfig`, which extends it) carries two independent
diagnostic channels bundled as `SkillDiagnostics`
(`packages/skills/src/lib/log.ts:38`–`:49`, `packages/skills/src/config.ts:31`):
`warningSink` (a `WarnSink`, prose, defaulting to `defaultWarnSink` which writes to
`process.stderr`) and `logger` (a structured `Logger`, defaulting to `NOOP_LOGGER`). They are
deliberately not redundant — "the sink carries a formatted sentence a host may surface to a
user; the logger carries fields an operator greps... a message is free to change; a field name
is a contract" (`packages/skills/src/lib/log.ts:34`–`:36`).

### 2.3 Capability entry (`@clarvis/skills/capability`)

| Export | Value / signature | Source |
| --- | --- | --- |
| `SKILLS_CAPABILITY_NAME` | `"skills"` | `packages/skills/src/capability.ts:52` |
| `USE_SKILLS_GRANT` | `"use_skills"` | `packages/skills/src/capability.ts:55` |
| `createSkillsCapability(provider?, options?)` | `=> Capability` | `packages/skills/src/capability.ts:86` |
| `SkillsCapabilityOptions.bootstraps` | `() => readonly PluginBootstrapSkill[]` | `packages/skills/src/capability.ts:72` |
| `LOAD_SKILL_TOOL_NAME` | `"load_skill"` | `packages/skills/src/tool.ts:13` |
| `SKILL_RESOURCE_MAX_CHARS` | `50_000` | `packages/skills/src/tool.ts:16` |
| `loadSkillTool` | `NamespacedTool` (see schema below) | `packages/skills/src/tool.ts:33` |
| `renderSkillsSection(catalog, bootstraps?)` | `=> string` | `packages/skills/src/tool.ts:106` |
| `handleLoadSkillCall(args)` | `=> LoadSkillCallResult` (synchronous) | `packages/skills/src/call.ts:65` |
| `SkillsProvider` | `{ listSkills; loadSkill; readResource }` | `packages/skills/src/tool.ts:22` |
| `resolveBootstrapSkills(args)` | `=> ResolvedBootstrapSkill[]` | `packages/skills/src/bootstrap.ts:104` |
| `BOOTSTRAP_SKILL_MAX_CHARS` | `20_000` | `packages/skills/src/bootstrap.ts:19` |
| `BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS` | `40_000` | `packages/skills/src/bootstrap.ts:29` |

Capability metadata is derived from the tool descriptor rather than spelled twice:
`reservedWireNames` is `SKILLS_TOOLS.map(t => t.wireName)` and `toolEffects` maps each to `"control"`
(`packages/skills/src/capability.ts:58`–`:62`, asserted at
`packages/skills/tests/component/capability.test.ts:99`).

### 2.4 `load_skill` input schema

```
{ type: "object", additionalProperties: false,
  properties: { name: { type: "string", minLength: 1 },
                resource: { type: "string", minLength: 1 } },
  required: ["name"] }
```

`packages/skills/src/tool.ts:44`–`:63`; pinned at `packages/skills/tests/unit/tool.test.ts:18`–`:20`.

### 2.5 Settings / plugin-manifest key (owned by the engine, not this package)

| Key | Type | Source |
| --- | --- | --- |
| `bootstrapSkill` (plugin manifest) | `z.string().min(1).optional()` | `packages/loop/src/runtime/capabilities/skills-settings.ts:40` |

There is no `skills:` **settings.json** block: `SKILLS_PLUGIN_FIELDS` is the only thing
`skills-settings.ts` exports besides a type re-export
(`packages/loop/src/runtime/capabilities/skills-settings.ts:39`, `:50`).

Two facts about `bootstrapSkill` are load-bearing and stated in its TSDoc
(`packages/loop/src/runtime/capabilities/skills-settings.ts:20`–`:38`): it "deliberately carries
no `CapabilitySettingsSpec` and is not `pluginContributable`", so it never travels the
`settingsScopes`/trusted-plugin-filter path — which is what lets a skills-only plugin stay
`inert` and need no approval dialog; and it is "not regex-constrained on purpose, even though
skill names are" — a manifest field that failed validation would fail the whole manifest and
drop the plugin's skills along with it, so a bad value is instead "reported at resolution time
and skipped" (the `foreign_root`/`not_found`/etc. gates of §4.13).

### 2.6 Environment gate

| Variable | Parser | Default | Source |
| --- | --- | --- | --- |
| `CLARVIS_SKILLS_ENABLED` | `boolFromEnv(true)` — `"false" \| "0" \| "no" \| "off" \| ""` are false, anything else true | `true` | `packages/capability/src/env.ts:114`, `packages/capability/src/env.ts:42` |

### 2.7 Protocol surface (`@clarvis/protocol`)

| Type | Fields | Source |
| --- | --- | --- |
| `SkillsService` | `list(): Promise<SkillSummary[]>`, `getPrompt(name, args?): Promise<Message[]>` | `packages/protocol/src/skills.ts:91` |
| `SkillSummary` | `name`, `description`, `agent?`, `arguments?`, `provenance?`, `presentation?`, `plansMode?` | `packages/protocol/src/skills.ts:69` |
| `SkillArgument` | `name`, `description?`, `required?` | `packages/protocol/src/skills.ts:13` |
| `SkillProvenance` | `scope: "user" \| "workspace"`, `source?`, `author?` | `packages/protocol/src/skills.ts:29` |
| `SkillPresentation` | `displayName?`, `shortDescription?`, `icons?`, `color?`, `starterPrompt?` | `packages/protocol/src/skills.ts:55` |
| `SkillIconSet` | `light?`, `dark?` | `packages/protocol/src/skills.ts:40` |

`KernelClient.skills` is one of the aggregated services (`packages/protocol/src/client.ts:80`).

---

## 3. Data and formats

### 3.1 On-disk layout

A skill is a **directory** containing a file whose lowercased name is `skill.md`
(`packages/skills/src/scan.ts:23`, matched case-insensitively at
`packages/skills/src/scan.ts:139`; pinned at `packages/skills/tests/integration/scan.test.ts:82`).
Everything else under that directory is resources, except the top-level `agents/` directory
(`packages/skills/src/scan.ts:297`).

```
<root>/
  <skill-name>/
    SKILL.md                 # manifest: YAML frontmatter + markdown body
    agents/<any>.yaml|.yml   # harness sidecar — never enumerated, never readable
    scripts/…                # resource kind "scripts"
    references/…             # "references"
    assets/…                 # "assets"
    examples/…               # "examples"
    <anything else>          # "other"
  <group-dir>/<skill-name>/SKILL.md   # grouping directories are descended through
```

Resource `kind` comes from the first path segment only (`packages/skills/src/scan.ts:404`); `rel` is
always POSIX-separated (`packages/skills/src/scan.ts:416`).

### 3.2 `SKILL.md` frontmatter

The fence is found by `splitFrontmatterFence` in `@clarvis/capability`
(`packages/capability/src/frontmatter-fence.ts:81`): a leading BOM and leading whitespace are
stripped, LF and CRLF are both accepted, and the outcome is `fenced` / `absent` / `unterminated`
(`packages/capability/src/frontmatter-fence.ts:48`).

Validated fields (`packages/skills/src/schema.ts:95`):

| Field | Rule | Cap | Failure behaviour |
| --- | --- | --- | --- |
| `name` | trimmed, `/^[A-Za-z0-9._-]+$/` | 128 chars | required; **supplied** from the directory name if unusable |
| `description` | trimmed, non-empty | 1024 chars | required; **supplied** from short-description/placeholder |
| `agent` | trimmed, `/^[A-Za-z0-9._:-]+$/` (admits `:` for `<plugin>:<agent>`) | 128 chars | `.catch(undefined)` — degrades to "names no agent" |
| `version` | string | — | `.catch(undefined)` |
| `license` | string | — | `.catch(undefined)` |
| `argument-hint` | string **or** `string[]`, joined with `", "` | — | `.catch(undefined)` |
| `user-invocable` | boolean | — | defaults to `true` at `packages/skills/src/registry.ts:493` |
| `allowed-tools` / `tools` | `string[]` (≤128 entries, ≤256 chars each) **or** comma-separated string | `packages/skills/src/schema.ts:10` | **no `.catch`** — an unreadable value fails the manifest |
| any other key | passthrough, retained on `SkillInfo.metadata` | — | — |

The asymmetry is explicit in the source: display-only fields degrade, a tool restriction does not,
because degrading it "would *widen* what the skill may do"
(`packages/skills/src/schema.ts:79`–`:81`); pinned at
`packages/skills/tests/unit/schema.test.ts:115`.

The `argument-hint` `.catch` carries its own measured justification: `argument-hint: [file,
directory]` is a YAML flow sequence, not the bracketed text its author typed, and a bare
`z.string()` rejected it — since a frontmatter failure is not local to one field, the whole skill
vanished from the catalog along with its slash command. "Nine skills in a public catalog of 196
plugins were lost to exactly that." (`packages/skills/src/schema.ts:41`–`:56`.)

Example the fixtures exercise (`packages/skills/tests/fixtures/foreign-skills/metadata-short/SKILL.md:1`):

```markdown
---
name: metadata-short
description: Compare two dependency lockfiles and report the drift.
metadata:
  short-description: Lockfile drift, at a glance.
---

Diff the two lockfiles and report what moved.
```

### 3.3 Harness sidecar (`agents/*.yaml`)

Matched by shape, not filename: the first `.yaml`/`.yml` file by sorted name directly inside
`agents/` (`packages/skills/src/scan.ts:46`, `:161`–`:183`). It is a YAML **mapping**; anything else
degrades to "no sidecar" (`packages/skills/src/sidecar.ts:330`).

Accepted key spellings per concept (`packages/skills/src/sidecar.ts:40`–`:80`):

| Concept | Keys | Result |
| --- | --- | --- |
| display name | `display-name`, `display_name`, `displayName`, `title` | ≤128 chars |
| short description | `short-description`, `short_description`, `shortDescription`, `summary` | ≤512 chars |
| icons | `icon`, `icons` (string ⇒ both themes; mapping ⇒ `light`/`default` + `dark`) | ≤512 chars, relative only |
| sized icons (last resort) | `icon-small`/`icon_small`/`iconSmall`, `icon-large`/… | one icon for **both** themes |
| colour | `color`, `colour`, `brand-color`, `brand_color`, `brandColor` | `/^#([0-9a-f]{3}\|[0-9a-f]{6})$/i`, lower-cased |
| starter prompt | `default-prompt`, `default_prompt`, `defaultPrompt`, `starter-prompt`, `starter_prompt`, `starterPrompt` | ≤4000 chars |
| presentation block | `interface`, `presentation`, `display`, `ui` | block first, root as per-field fallback |
| policy block | `policy`, `invocation` | consulted before the root |
| catalog suppression | `allow-implicit-invocation`/… (inverted) or `hide-from-catalog`/`hidden` | boolean |

`readCatalogSuppressed` (`packages/skills/src/sidecar.ts:211`–`:219`) has a real precedence order
the table above does not show: it tries the **policy block first, then the root** mapping, and
*within* each block it checks `implicit-invocation` (in any spelling) before `hide-from-catalog` —
whichever concept is found first in a given block decides outright, and the other concept in that
same block is never consulted. Only when the policy block mentions neither concept does the root
block get a turn. So a policy-level `implicit-invocation: false` wins over a root-level
`hidden: false` even though both are present; the two concepts are never merged.

Fixture (`packages/skills/tests/fixtures/foreign-skills/presented/agents/harness.yaml:1`):

```yaml
display-name: Release Notes
short-description: Turns a commit range into publishable notes.
icon:
  light: assets/icon-light.svg
  dark: assets/icon-dark.svg
color: "#3B82F6"
default-prompt: Draft the notes for everything since the last tag.
policy:
  implicit-invocation: true
```

### 3.4 In-memory shapes

`SkillInfo` (`packages/skills/src/types.ts:119`): `name`, `description`, `metadata`,
`allowedTools?`, `userInvocable`, `catalogSuppressed?`, `presentation?`, `defaulted?`, `scope`,
`source`, `root`, `dir`, `path`, `shadowed?`. `SkillContent` extends it with `body` and `resources`
(`packages/skills/src/types.ts:173`). `ResolvedSkill` is `{ info, body }` where `body` may be a lazy
getter (`packages/skills/src/types.ts:184`, implemented at `packages/skills/src/registry.ts:505`).

`ShadowedSkill` records only `source`, `scope`, `root`, `dir`
(`packages/skills/src/types.ts:104`, projected at `packages/skills/src/registry.ts:323`).

### 3.5 Identifiers

The skill **name** is the lookup key, the merge identity and the slash-command name
(`packages/skills/src/types.ts:120`, `packages/protocol/src/skills.ts:71`). There is no generated id
anywhere in this subsystem. When a name has to be supplied it comes from the directory basename with
unsupported characters collapsed to `-`, edge separators stripped, truncated to 128 chars, falling
back to the literal `"skill"` (`packages/skills/src/registry.ts:58`–`:84`; pinned at
`packages/skills/tests/integration/sidecar.test.ts:296`).

### 3.6 Limits table

| Constant | Value | Source |
| --- | --- | --- |
| `MAX_SKILL_ROOTS` | 32 | `packages/skills/src/limits.ts:2` |
| `MAX_SKILL_DIRECTORY_ENTRIES` | 2 048 | `:4` |
| `MAX_SKILLS_PER_ROOT` | 256 | `:6` |
| `MAX_SKILL_NESTING` | 4 | `:18` |
| `MAX_SKILL_GROUP_DIRECTORIES` | 1 024 | `:29` |
| `MAX_SKILLS` | 512 | `:31` |
| `MAX_SKILL_FILE_BYTES` | 262 144 | `:34` |
| `MAX_SKILL_FILE_CHARS` | 100 000 | `:36` |
| `MAX_SKILL_FRONTMATTER_BYTES` | 65 536 | `:38` |
| `MAX_SKILL_FRONTMATTER_CHARS` | 50 000 | `:40` |
| `MAX_SKILL_RESOURCE_DEPTH` | 16 | `:43` |
| `MAX_SKILL_RESOURCE_ENTRIES` | 4 096 | `:45` |
| `MAX_SKILL_RESOURCE_DIRECTORIES` | 512 | `:47` |
| `MAX_SKILL_RESOURCES` | 1 024 | `:49` |
| `MAX_SKILL_RESOURCE_BYTES` | 262 144 | `:51` |
| `MAX_SKILL_RESOURCE_CHARS` | 50 000 | `:53` |
| `MAX_SKILL_SIDECAR_BYTES` | 16 384 | `:56` |
| `MAX_SKILL_SIDECAR_CHARS` | 8 000 | `:58` |
| `MAX_SKILL_LABEL_CHARS` | 128 | `:60` |
| `MAX_SKILL_SHORT_DESCRIPTION_CHARS` | 512 | `:62` |
| `MAX_SKILL_STARTER_PROMPT_CHARS` | 4 000 | `:64` |
| `MAX_SKILL_ICON_PATH_CHARS` | 512 | `:66` |
| `MAX_SKILL_NAME_CHARS` / `MAX_SKILL_AGENT_CHARS` | 128 | `:69`, `:70` |
| `MAX_SKILL_DESCRIPTION_CHARS` | 1 024 | `:71` |
| `MAX_SKILL_TOOLS` / `MAX_SKILL_TOOL_CHARS` | 128 / 256 | `:72`, `:73` |
| `SKILL_RESOURCE_MAX_CHARS` (tool-side truncation) | 50 000 | `packages/skills/src/tool.ts:16` |
| `BOOTSTRAP_SKILL_MAX_CHARS` / run budget | 20 000 / 40 000 | `packages/skills/src/bootstrap.ts:19`, `:29` |

---

## 4. Behavior

### 4.1 Configuration (`resolveConfig`)

1. `home` ← option or `os.homedir()`; `cwd` ← option or `process.cwd()`; `workspaceDir` ←
   `resolveWorkspaceDir(workspace, cwd, home)` (`packages/skills/src/config.ts:83`–`:85`).
2. If `workspace` was given explicitly, `validateDir` stats it and throws `StartupError` when it is
   missing or not a directory, emitting `skills.workspace.unreadable` at `debug` first
   (`packages/skills/src/config.ts:135`–`:148`).
3. Empty `roots` ⇒ `StartupError` (`:94`); more than `MAX_SKILL_ROOTS` ⇒ `StartupError` naming both
   counts (`:96`–`:101`; pinned at `packages/skills/tests/unit/config.test.ts:56`).
4. Each root is normalized: path resolved against workspace + `~`, `scope` defaults to `"workspace"`,
   `source` to `""` (`packages/skills/src/config.ts:119`–`:125`).

`createAgentSkills` scans once at construction; `AgentSkills.refresh()` re-scans every configured
root from disk and **replaces** the in-memory registry wholesale, so additions, content
modifications and removals are all reflected on the next call — nothing is diffed or merged
against the previous scan (`packages/skills/src/index.ts:56`–`:58`). Pinned:
`packages/skills/tests/integration/api.test.ts:63`–`:80` ("refreshes additions, modifications and
removals from disk").

### 4.2 Root order

`clarvisSkillRoots` returns four roots in **ascending precedence**
(`packages/skills/src/preset.ts:40`–`:45`):

| # | Path | scope | source |
| --- | --- | --- | --- |
| 1 | `<home>/.agents/skills` | `user` | `agents` |
| 2 | `<workspace>/.agents/skills` | `workspace` | `agents` |
| 3 | `<global>/skills` (`globalPaths`) | `user` | `clarvis` |
| 4 | `<workspace>/.clarvis/skills` | `workspace` | `clarvis` |

The `.agents` half of this ordering is an interop rule — see
[`specs/cross-cutting/agent-interop.md`](../cross-cutting/agent-interop.md).
The engine prepends any host-supplied extra roots **before** these four, so plugin roots sit at the
lowest precedence of all (`packages/loop/src/runtime/build-run-deps.ts:450-454`). Plugin root
construction belongs to [`specs/hosts/plugins.md`](../hosts/plugins.md); what
matters here is only that they arrive as `SkillRootInput[]` with `source: "plugin:<name>"`
(`packages/kernel/src/plugins/plugin-contributions.ts:352`–`:355`).

### 4.3 Scanning one root (`listSkillDirs`)

A breadth-first walk with an explicit queue (`packages/skills/src/scan.ts:85`–`:117`):

| Step | Rule | Line |
| --- | --- | --- |
| list a directory | streamed, at most `MAX_SKILL_DIRECTORY_ENTRIES`; on overflow the **whole directory** yields nothing | `:87`, `:430`–`:452` |
| entry is a directory? | real dir always; symlink only when `followSymlinks` and its target is a dir | `:520`–`:529` |
| probe budget | every probed child increments; past `MAX_SKILL_GROUP_DIRECTORIES` the scan warns and returns what it has | `:92`–`:101` |
| directory holds a `SKILL.md`? | it is a skill; **never descended into** | `:102`–`:107` |
| otherwise | queued at `depth+1`, only while `depth+1 < MAX_SKILL_NESTING` | `:108` |
| early stop | returns as soon as `out.length >= maximumSkills` | `:105` |
| ordering | final `sort` by `dir` path (a **path** sort, not a basename sort) | `:81` |

Pinned: grouping descent (`packages/skills/tests/integration/scan.test.ts:29`), multi-level
(`:41`), the nesting bound (`:46`), "a bundled example is not a second skill" (`:51`), the width
bound (`:57`), the `maximumSkills` early stop (`:66`).

### 4.4 Building one skill (`buildResolvedSkill`)

Order matters and is fixed (`packages/skills/src/registry.ts:433`–`:539`):

1. **Bounded prefix read** of `SKILL.md`: at most `MAX_SKILL_FRONTMATTER_BYTES`, refusing the file
   outright if its complete size exceeds `MAX_SKILL_FILE_BYTES` (`:441`–`:447`, implemented at
   `packages/skills/src/bounded-read.ts:53`–`:56`).
2. **Sidecar** located and read (`:449`–`:450`).
3. **Defaults computed** — name from the directory, description from the sidecar's short description
   or `"(no description supplied)"` (`:451`–`:454`).
4. **Frontmatter parsed with defaults**: split fence → YAML parse (with flat-mapping repair) →
   character cap → fill unusable required fields → zod validate
   (`packages/skills/src/parse.ts:223`–`:232`).
5. **Warnings**: a declared name that differs from the directory name warns but is *not* corrected,
   and is skipped when the name was supplied by Clarvis (`:460`–`:466`; pinned at
   `packages/skills/tests/integration/malformed.test.ts:88` and
   `packages/skills/tests/integration/sidecar.test.ts:285`). Every supplied field warns and emits
   `skill.field_defaulted` recording only its **length** (`:467`–`:474`; pinned at
   `packages/skills/tests/integration/diagnostics.test.ts:97`).
6. **Description resolution**: the manifest's own description wins; the short description (sidecar
   first, then the manifest's `metadata.short-description`/`short_description`) is used **only** when
   `description` was defaulted (`:476`–`:481`, `:95`–`:104`).
7. **Info assembled**: `allowedTools` from `allowed-tools` ?? `tools`; `userInvocable` defaults
   `true`; `catalogSuppressed` set only when the sidecar says so; `metadata` carries the frontmatter
   with the resolved `description` overwritten (`:487`–`:502`).
8. **Body getter**: lazy, memoized after the first read, and it **re-parses and re-validates** the
   whole file; a name that changed since discovery emits `skill.name_changed` and throws
   (`:505`–`:538`; pinned at `packages/skills/tests/integration/bounds.test.ts:60`, `:78`).

### 4.5 Merging (`buildRegistry`)

```
for each root (ascending precedence):
  for each skill from scanRoot(root):
    if the name already exists  -> mergeWinner(newSkill, existing)     # later root wins
    else if size < MAX_SKILLS   -> insert
    else                        -> catalog overflow (see below)
```

`packages/skills/src/registry.ts:126`–`:152`.

**Intra-root** duplicates are resolved *before* cross-root merging, first-seen wins (directory sort
order), with a warning or — under `strict` — a `duplicate_skill` throw
(`packages/skills/src/registry.ts:382`–`:399`; pinned at
`packages/skills/tests/integration/malformed.test.ts:62`, `:77`).

**Cross-root** collisions call `mergeWinner`, which keeps the winner and accumulates the full shadow
chain `[…winner.shadowed, loser, …loser.shadowed]`, and warns with `skill.shadowed` naming the
winning origin and every losing one (`packages/skills/src/registry.ts:285`–`:302`; pinned at
`packages/skills/tests/integration/discovery.test.ts:50` and
`packages/skills/tests/integration/diagnostics.test.ts:61`).

**Catalog overflow** at `MAX_SKILLS`: under `strict` it throws; otherwise it counts a drop, logs
`skill.rejected` with reason `catalog_overflow`, and — if the newcomer's name sorts *before* the
currently largest retained name — evicts that largest and inserts the newcomer
(`packages/skills/src/registry.ts:137`–`:151`, `:264`–`:270`). One warning is emitted after the whole
pass, not per skill (`:154`–`:159`). Pinned at
`packages/skills/tests/integration/bounds.test.ts:152`.

### 4.6 Registry state machine (`makeRegistry`)

| Operation | Input state | Result | Line |
| --- | --- | --- | --- |
| `list()` | any | every `info`, sorted by name | `packages/skills/src/registry.ts:594` |
| `get(name)` | unknown name | `undefined` | `:599` |
| `get(name)` | known, body readable | `{ …info, body, resources }` + `skill.body_disclosed` debug record | `:600`–`:611` |
| `get(name)` | known, manifest renamed on disk | throws `invalid_skill` "refresh required" | `:517`–`:532` |
| `resource(name, rel)` | unknown skill | `SkillError not_found` | `:562` |
| `resource(name, rel)` | `rel` empty / absolute | `SkillError invalid_input` | `packages/skills/src/paths.ts:31`, `:34` |
| `resource(name, rel)` | resolves outside the skill dir | `SkillError path_escape` | `packages/skills/src/paths.ts:40` |
| `resource(name, rel)` | inside `agents/` (lexically **or** after realpath) | `SkillError not_found` — deliberately indistinguishable from absent | `packages/skills/src/registry.ts:566`–`:571` |
| `resource(name, rel)` | cannot be stat'd | `not_found` + `skill.resource_missing` debug | `:572`–`:584` |
| `resource(name, rel)` | not a regular file | `SkillError not_a_file` | `:585` |
| `readResource(name, rel)` | as above, then bounded read at 256 KiB / 50 000 chars | text or `invalid_input` size error | `:616`–`:625` |
| `size` | any | live map size | `:626` |

Pinned: the three resource outcomes at
`packages/skills/tests/integration/registry-resource.test.ts:18`; harness-directory refusal
(both spellings and through an aliasing symlink) at
`packages/skills/tests/integration/sidecar.test.ts:193`, `:201`.

### 4.7 Resource enumeration (`enumerateResources`)

Depth-first with a `realpath`-keyed `visited` set, so a symlink cycle back into the skill terminates
(`packages/skills/src/scan.ts:247`, `:263`–`:265`; pinned at
`packages/skills/tests/integration/symlink.test.ts:72`). Exclusions and budgets, in the order the
loop applies them:

| Rule | Effect | Line |
| --- | --- | --- |
| `visited.size >= MAX_SKILL_RESOURCE_DIRECTORIES` | warn, stop the whole walk | `:246`–`:254` |
| entry budget exhausted (before opening) | warn, stop | `:260`–`:269` |
| entry budget exceeded (after listing) | warn, stop | `:276`–`:284` |
| top-level `agents/` | skipped whole | `:290` |
| symlink that escapes the skill dir | warn + `skill.resource_skipped` `escaping_symlink` | `:291`–`:295` |
| top-level `SKILL.md` | skipped | `:297` |
| `out.length >= MAX_SKILL_RESOURCES` | warn, return what is collected | `:298`–`:306` |
| directory deeper than `MAX_SKILL_RESOURCE_DEPTH` | warn, skip | `:309`–`:317` |
| final | sort by `rel` | `:325` |

`escapesRoot` returns `false` for `ENOENT` (so a dangling link falls through to the accurate
"dangling symlink" warning) and `true` for every **other** realpath failure, because `stat` needs
less permission than `realpath` and an unresolvable link out of the skill would otherwise be
published (`packages/skills/src/scan.ts:386`–`:394`; pinned at
`packages/skills/tests/integration/scan.test.ts:176`).

`safeRealpath` is a separate, more permissive fallback used only to compute a **cycle-detection
key**: it resolves a path with `realpathSync.native` and, on any failure, falls back to the
unresolved path itself rather than treating the failure as an escape, logging
`skill.realpath_failed` at `debug` (`packages/skills/src/scan.ts:495`–`:504`). It backs four call
sites — the resource-enumeration root and its walk (`:241`, `:256`), the sidecar lookup
(`packages/skills/src/scan.ts:167`) and the harness-directory probe (`:209`) — and is distinct
from the escape check above: it never rejects anything, it only decides what a symlink cycle is
keyed by when the "true" path cannot be determined.

### 4.8 YAML repair path

`parseFrontmatterDocument` tries a strict `yaml` parse with `maxAliasCount: 32`
(`packages/skills/src/parse.ts:121`). **Only on failure** does `reparseFlatMapping` run
(`:122`–`:126`, `:169`–`:191`):

| Line shape | Handling |
| --- | --- |
| blank or `#` comment | skipped |
| not `^([A-Za-z0-9_-]+):[ \t]*(.*)$` | give up, whole document fails |
| empty value | give up |
| value starts with `"' [ { \| > & * !` | re-parsed as `v: <value>` alone; a throw gives up |
| anything else | taken as the author's **literal** text |

This is what keeps `description: Five phases: detect, contain, diagnose.` readable
(`packages/skills/tests/unit/parse.test.ts:127`) while leaving a genuine nested mapping untouched
(`:160`) and refusing a non-flat document (`:154`). Because it recovers literal text, a bracketed
`allowed-tools: [read_file, grep]` beside a colon-bearing scalar still parses as a list
(`packages/skills/tests/unit/parse.test.ts:144`).

### 4.9 Required-field defaulting (`applyDefaults`)

Each of `name`, `description` is checked **individually** against its own schema; a field that is
absent *or present-but-unusable* is replaced by the caller's stand-in and recorded in `defaulted`
(`packages/skills/src/parse.ts:64`–`:79`, `:41`–`:47`). Everything else still validates normally, so
a manifest with no frontmatter at all becomes a skill named after its directory with the neutral
placeholder description (`packages/skills/tests/integration/sidecar.test.ts:302`).

### 4.10 Capability activation

| Stage | Condition | Result | Line |
| --- | --- | --- | --- |
| `forRun(ctx)` | `!ctx.env.CLARVIS_SKILLS_ENABLED` **or** no provider | `null` — capability inert | `packages/skills/src/capability.ts:96` |
| `systemSection(id)` | agent lacks `use_skills` | `undefined`, and nothing is scanned | `:117`, `:163`–`:167` |
| `systemSection(id)` | catalog empty | `undefined` | `:119` |
| `systemSection(id)` | catalog non-empty but every entry suppressed **and** no bootstraps | `undefined` (rendered section is `""`) | `:167`, `packages/skills/src/tool.ts:112` |
| `forAgent(scope)` | same grant + non-empty-catalog test | `null` or an `AgentCapability` | `:169`–`:180` |
| `attach(bc)` | — | one tool (`load_skill`), one handler, `advertised: false` | `:172`–`:177` |

The catalog is scanned **once per run** and memoized (`:115`), and the bootstraps are resolved at
most once behind an explicit boolean flag rather than `??=`, so "no valid bootstrap" does not
re-resolve and re-warn on every agent spawn (`:122`–`:153`). Pinned at
`packages/skills/tests/component/capability.test.ts:114` (one `bootstraps()` call, two loads, one
warning, identical section for lead and spawned agent) and `:139` (an ungranted agent triggers zero
scans, zero loads, zero warnings).

### 4.11 System-prompt section

`renderSkillsSection` emits, in order: each bootstrap body wrapped as
`# Plugin instructions … <plugin_instructions>…</plugin_instructions>`
(`packages/skills/src/tool.ts:77`–`:85`), then the catalog block, then the call-`load_skill`
instruction (`:106`–`:121`). The catalog block is `# Available skills` plus one
`- **name** — description` line per non-suppressed skill, sorted by name, and the empty string when
nothing is listable (`packages/skills/src/catalog/index.ts:28`–`:33`). When the catalog renders
empty the trailing instruction goes with it and only the bootstrap heads remain
(`packages/skills/src/tool.ts:112`; pinned at
`packages/skills/tests/integration/sidecar.test.ts:149`).

### 4.12 `load_skill` dispatch

`handleLoadSkillCall` (`packages/skills/src/call.ts:65`):

1. `openCallEnvelope` validates the arguments against `loadSkillTool.inputSchema` with the
   host-injected validator; an invalid call is reported as a failed `tool_call` and no
   `tool_call_started` is recorded (`:77`–`:92`; pinned at
   `packages/skills/tests/unit/call.test.ts:32`).
2. `resource` is trimmed; a value meaning "the skill's own body" — `""`, `.`, `./`, `/`, `SKILL.md`,
   `./SKILL.md`, or any path ending `<name>/SKILL.md` after backslash normalization — is dropped and
   the call becomes a body load (`:38`–`:43`, `:97`–`:101`; pinned at
   `packages/skills/tests/unit/call.test.ts:171`).
3. `envelope.start()` records `tool_call_started` (`:102`).
4. **Resource branch**: the skill's existence is checked against `listSkills()` *before* any read
   (`:105`; pinned at `packages/skills/tests/unit/call.test.ts:94`, which asserts zero reads), then
   `readResource`; a throw from `readResource` is caught and rendered as
   `could not read resource '<resource>' of skill '<name>': <reason>` — distinct from the
   unknown-skill message above and from the truncation case below (`:114`–`:118`). Output over
   `maxResourceChars` (default 50 000) is truncated with an explicit
   `[resource truncated at N characters]` marker (`:115`–`:119`). The resource branch never calls
   `loadSkill` at all — it reads a resource without loading or retaining the skill body, a
   materially separate code path from the body branch below (`packages/skills/src/call.ts:105`–`:119`;
   pinned at `packages/skills/tests/integration/call-resource.test.ts:37`–`:49`, which throws inside
   a fake `loadSkill` to prove it is never reached).
5. **Body branch**: `loadSkill(name)`; a throw becomes `could not load skill '<name>'`, `undefined`
   becomes `unknown skill '<name>'. Available skills: …` (`:122`–`:131`). An empty body renders
   `(this skill has an empty body)` (`:133`).
6. The result text is `Skill '<name>' — <description>\n\n<body>` plus a bundled-resource listing when
   the skill has resources (`:134`–`:136`, `:31`–`:35`).

The capability wrapper turns the result into `{ kind: "result", text, progress: !error }`
(`packages/skills/src/capability.ts:205`).

### 4.13 Plugin bootstrap resolution

`resolveBootstrapSkills` folds the declared refs in order, dropping each with a `warn` naming the
reason (`packages/skills/src/bootstrap.ts:119`–`:149`):

| Gate | Reason | Line |
| --- | --- | --- |
| loader threw | `load_failed` (never rethrown) | `:122`–`:125` |
| skill not in the merged catalog | `not_found` | `:127` |
| `content.root` (resolved) is none of `ref.roots` (resolved) | `foreign_root` | `:131`–`:133` |
| body blank after trim | `empty_body` | `:135` |
| body > 20 000 chars | `too_long` — skipped, never truncated | `:139` |
| running total + body > 40 000 chars | `over_run_budget`, and the loop **breaks** | `:143`–`:146` |

Admitted entries carry the skill's **own parsed name**, not the manifest string (`:148`; pinned at
`packages/skills/tests/unit/bootstrap.test.ts:49`). More than one admitted bootstrap emits an extra
`bootstrap_skills_multiple` warning (`:151`–`:157`).

Because plugin roots are scanned at the lowest precedence (§4.2), a same-named user skill wins the
merge and the bootstrap is then refused as `foreign_root` — the source states this explicitly at
`packages/skills/src/bootstrap.ts:100`–`:102`, and the test names it "the RP2.2 gate"
(`packages/skills/tests/unit/bootstrap.test.ts:65`).

### 4.14 Host wiring in the loop

`buildExecuteRunDeps` (`packages/loop/src/runtime/build-run-deps.ts`):

- `useSkills = builtins?.skills !== false` (`:370`).
- With `useSkills && CLARVIS_SKILLS_ENABLED`, `@clarvis/skills` is loaded through a **dynamic**
  `import()` and `createAgentSkills` is built over `[...extraRoots, ...clarvisSkillRoots()]`, with
  the package's prose warnings routed into the structured logger as
  `skills.discovery_warning` (`:443`–`:460`).
- A function-valued `extraSkillRoots` produces `dynamicSkills`, which re-reads the roots on every
  provider access, re-scans only when the roots' JSON signature changes, and falls back to the last
  good scan (or an empty provider that throws `"skills are unavailable"` on resource access) when a
  rescan throws (`:179`–`:230`).
- An initial scan failure logs `skills.discovery_failed` and leaves `skills` undefined rather than
  failing the deps (`:464`–`:475`).
- The capability is registered whenever `useSkills`, even with an undefined provider, so the grant,
  the reserved wire name and the tool effect stay stable (`:536`–`:549`).

### 4.15 Kernel adaptation

`createSkillsService` (`packages/kernel/src/skills/skills-service.ts:30`):

- `list()` filters on `userInvocable` **alone**; catalog suppression is deliberately not consulted
  (`:50`–`:52`, `:41`–`:44`; pinned at `packages/kernel/tests/component/skills-service.test.ts:344`).
- `SkillsServiceConfig` (`packages/kernel/src/skills/skills-service.ts:14`–`:19`) takes, beside the
  `skills` provider, an optional `skillPlansMode(skill)` callback returning a trusted, per-skill
  `PlansMode` override; `list()` calls it for every skill (`:63`–`:66`) to populate
  `SkillSummary.plansMode`. What the callback itself resolves — settings/plugin plumbing — belongs
  to the workflows/plans documents, not here.
- Each summary carries exactly one optional `task` argument, described by the skill's
  `argument-hint` when it is a non-blank string (`:53`–`:58`,
  `packages/kernel/src/skills/render-skill-prompt.ts:93`).
- `provenance` is emitted only when `scope` is one of the two known values, and carries `source` when
  non-empty and `metadata.author` when the producing tool wrote one (`:62`, `:73`–`:81`,
  `packages/kernel/src/skills/render-skill-prompt.ts:106`). The two probes read different shapes of
  the same loose `metadata` object: `skillAuthor` reads the **nested** `metadata.author` bucket
  (`packages/kernel/src/skills/render-skill-prompt.ts:106`–`:111`) while `skillEntryAgent`, below, reads the **top-level**
  `agent` field (`packages/kernel/src/skills/render-skill-prompt.ts:79`–`:84`) — the two are asymmetric, not two views of one
  lookup.
- `presentation` is **re-read field by field** from whatever the provider supplied rather than
  forwarded, and an icon path that is absolute, drive-qualified or contains `..` after backslash
  normalization is dropped (`packages/kernel/src/skills/render-skill-prompt.ts:139`–`:155`,
  `:169`–`:187`; pinned at `packages/kernel/tests/component/skills-service.test.ts:290`).
- `getPrompt(name, args)` throws kernel `not_found` for an unknown or non-invocable skill and
  otherwise returns one `user` message from `renderSkillPrompt` (`:97`–`:108`).

`renderSkillPrompt` (`packages/kernel/src/skills/render-skill-prompt.ts:211`):

| Body contains a placeholder (`$ARGUMENTS` or `{{args}}`)? | Rendering |
| --- | --- |
| yes | every occurrence replaced in **one** pass with a replacer *function*; no `Target:` block; an absent task substitutes as `""` (`:227`–`:235`) |
| no | body verbatim, then `Target:` and the task, or `(no explicit target — apply the skill to the current conversation.)` (`:238`–`:248`, `:15`) |

The single-pass replacer function exists because a string replacement would expand `$$`, `$&`,
`` $` `` and `$'` inside the caller's task (`:34`–`:43`); pinned at
`packages/kernel/tests/component/skills-service.test.ts:171` and `:185`.

`skillEntryAgent` reads the top-level `agent` field and decides whether a `/name` invocation becomes
its own run or is injected into the current turn (`:79`–`:84`). It **does not govern the
model-facing `load_skill` tool**, which serves a skill's body into whichever run/agent called it and
never consults this field at all — "a skill naming an agent therefore runs on it when a user types
`/name`, and in the caller's own turn when an agent loads it mid-run"
(`packages/kernel/src/skills/render-skill-prompt.ts:74`–`:77`). The run-request side of that decision
is `resolveSkillRun` in `packages/kernel/src/runs/settings-assembler.ts:89`; skill-driven agent
routing itself belongs to [`specs/capabilities/workflows-service.md`](../capabilities/workflows-service.md).

The one `SkillsProvider` the host builds is threaded three ways by `createInProcessKernel`: into
`createSettingsRunAssembler`'s `skills` option (`packages/kernel/src/kernel.ts:288`, for
`resolveSkillRun` above), into `createSkillsService` (`:705`, this section), and into
`createAgentWorkflowPolicy` (`:296`, delegated). The same construction also derives
`KernelCapabilities.skills` from whether a provider was actually wired —
`skills: opts.skillsProvider !== undefined` (`packages/kernel/src/kernel.ts:754`) — rather than
leaving it at `DEFAULT_KERNEL_CAPABILITIES.skills`'s static `false` (`:250`–`:256`).

---

## 5. Invariants

The invariants below are derived directly from this document's own source and tests. Numbers are local
to this document.

1. **A directory holding a `SKILL.md` is a skill and its subtree is never re-scanned.**
   `packages/skills/src/scan.ts:109`–`:114`. Pinned:
   `packages/skills/tests/integration/scan.test.ts:51`.
2. **Grouping directories are descended through, bounded by depth and by probe count.**
   `packages/skills/src/scan.ts:99`–`:115`. Pinned:
   `packages/skills/tests/integration/scan.test.ts:29`, `:41`, `:46`, `:57`.
3. **`SKILL.md` is matched case-insensitively.** `packages/skills/src/scan.ts:139`. Pinned:
   `packages/skills/tests/integration/scan.test.ts:82`.
4. **Cross-root precedence is last-root-wins, and the loser chain is retained in full on the
   winner.** `packages/skills/src/registry.ts:285`–`:301`. Pinned:
   `packages/skills/tests/integration/discovery.test.ts:50` (four roots, three shadowed origins in
   descending precedence), `:58`–`:83` (two arbitrary roots, last-root-wins).
5. **Intra-root duplicates are first-seen-wins (directory-sort order) and are resolved before any
   cross-root merge.** `packages/skills/src/registry.ts:382`–`:399`. Pinned:
   `packages/skills/tests/integration/malformed.test.ts:62`.
6. **`strict` converts every non-fatal discovery outcome into a throw**: parse failure, intra-root
   duplicate, per-root manifest overflow, catalog overflow.
   `packages/skills/src/registry.ts:137`, `:356`, `:376`, `:384`. Pinned:
   `packages/skills/tests/integration/malformed.test.ts:57`, `:77`,
   `packages/skills/tests/integration/bounds.test.ts:182`, `:189`.
7. **A malformed sidecar never removes the skill that carries it, not even under `strict`.**
   `packages/skills/src/sidecar.ts:286`–`:296` (nothing throws). Pinned:
   `packages/skills/tests/integration/sidecar.test.ts:210`, `:223`.
8. **No purely presentational frontmatter field can delete a skill** — `version`, `license` and
   `argument-hint` carry `.catch(undefined)`, as `agent` does.
   `packages/skills/src/schema.ts:57`, `:99`–`:115`. Pinned:
   `packages/skills/tests/unit/schema.test.ts:102`, `:108`, `:45`.
9. **`allowed-tools`/`tools` deliberately do *not* degrade**, because degrading a restriction widens
   what the skill may do. `packages/skills/src/schema.ts:79`–`:81`. Pinned:
   `packages/skills/tests/unit/schema.test.ts:115`.
10. **A missing or unusable `name`/`description` is supplied, not fatal, and the substitution is
    recorded on `SkillInfo.defaulted`.** `packages/skills/src/parse.ts:64`–`:79`,
    `packages/skills/src/registry.ts:451`–`:474`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts:252`, `:261`, `:269`, `:281`, `:289`.
11. **The supplied description is never invented from the directory name**; it is the sidecar's short
    description or the fixed placeholder `"(no description supplied)"`.
    `packages/skills/src/registry.ts:55`, `:453`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts:269`.
12. **A frontmatter `name` that disagrees with the directory name is warned about, never corrected**,
    and the warning is suppressed when Clarvis supplied the name itself.
    `packages/skills/src/registry.ts:460`–`:466`. Pinned:
    `packages/skills/tests/integration/malformed.test.ts:88`,
    `packages/skills/tests/integration/sidecar.test.ts:285`.
13. **Bodies are not retained at discovery; the first `get()` reads the file, and later `get()`s
    serve the memoized text.** `packages/skills/src/registry.ts:503`–`:538`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts:60`.
14. **A manifest whose `name` changed after cataloguing is refused rather than paired with a stale
    identity.** `packages/skills/src/registry.ts:517`–`:532`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts:78`,
    `packages/skills/tests/integration/diagnostics.test.ts:128`.
15. **The harness-config directory (`agents/`) is withheld from resource enumeration and from
    resource resolution, checked both lexically and after `realpath`, and a request for it is
    reported `not_found` rather than a more specific code.**
    `packages/skills/src/scan.ts:201`–`:211`, `packages/skills/src/scan.ts:297`,
    `packages/skills/src/registry.ts:566`–`:571`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts:184`, `:193`, `:201`.
16. **Nothing from a sidecar reaches a model-facing surface, with one recorded exception**: a
    borrowed short description used as a defaulted `description`.
    `packages/skills/src/registry.ts:476`–`:481`, `packages/skills/src/types.ts:63`–`:80`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts:160`, `:165` (a fixed list of sidecar-only
    strings must not appear in the catalog, the section, or a `load_skill` result).
17. **`catalogSuppressed` and `userInvocable` are independent axes.** Suppression is applied in
    exactly one place — `renderSkillCatalog` (`packages/skills/src/catalog/index.ts:28`) — and
    `userInvocable` is applied in exactly one other — `SkillsService.list`
    (`packages/kernel/src/skills/skills-service.ts:51`). Pinned:
    `packages/skills/tests/component/catalog.test.ts:22`, `:30`,
    `packages/skills/tests/integration/sidecar.test.ts:119`, `:125`,
    `packages/kernel/tests/component/skills-service.test.ts:344`.
18. **A suppressed skill stays in the registry and stays loadable by name.**
    `packages/skills/src/capability.ts:160`–`:162` (the tool is not withheld with the section).
    Pinned: `packages/skills/tests/integration/sidecar.test.ts:139`.
19. **Every resource path is confined to the skill directory, symlink-aware, with a `..`-tolerant
    canonicalization for not-yet-existing tails.** `packages/skills/src/paths.ts:25`–`:45`,
    `:85`–`:96`. Pinned: `packages/skills/tests/integration/paths.test.ts:55`, `:60`, `:71`.
20. **The containment check compares against `dirReal + path.sep`, so a sibling whose name is a
    prefix of the skill directory does not pass.** `packages/skills/src/paths.ts:39`. Pinned:
    `packages/skills/tests/integration/paths.test.ts:71`.
21. **A symlink whose target cannot be `realpath`ed for any reason other than absence counts as
    escaping.** `packages/skills/src/scan.ts:391`. Pinned:
    `packages/skills/tests/integration/scan.test.ts:176`.
22. **Resource traversal terminates on cycles**, keyed by real path.
    `packages/skills/src/scan.ts:263`–`:265`. Pinned:
    `packages/skills/tests/integration/symlink.test.ts:72`.
23. **Every file read is bounded twice — by complete size in bytes before allocation, and by decoded
    characters after** — and a complete read that finds more bytes past `fstat`'s size is refused as
    "changed while it was being read". `packages/skills/src/bounded-read.ts:53`–`:79`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts:96`, `:138`, `:320`,
    `packages/skills/tests/unit/bounded-read.test.ts:31`.
24. **A directory with more entries than `MAX_SKILL_DIRECTORY_ENTRIES` contributes nothing at all**,
    rather than a truncated listing. `packages/skills/src/scan.ts:451`–`:459`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts:203`.
25. **`resolveConfig` refuses more than `MAX_SKILL_ROOTS` roots before any root-scanning
    filesystem work — but not before all of it.** When an explicit `workspace` option is
    given, `validateDir`'s `statSync` (`packages/skills/src/config.ts:89`–`:91`, `:138`) runs
    first and can itself throw `StartupError`; only then are the empty-roots check (`:93`–`:95`)
    and the `MAX_SKILL_ROOTS` ceiling (`:96`–`:101`) reached. The ordering is: workspace
    validation (if `workspace` was supplied), then the roots-count check, then per-root
    scanning. `packages/skills/src/config.ts:89`–`:101`. Pinned:
    `packages/skills/tests/unit/config.test.ts:56`,
    `packages/skills/tests/integration/bounds.test.ts:44` (the latter passes a real, existing
    workspace via `makeWorkspace()`, so it demonstrates the ceiling is checked before
    root-scanning I/O, not before the workspace stat).
26. **The strict YAML repair runs only after a strict parse has already failed, and gives up unless
    every line is a flat `key: value`.** `packages/skills/src/parse.ts:122`–`:130`, `:169`–`:191`.
    Pinned: `packages/skills/tests/unit/parse.test.ts:127`, `:154`, `:160`.
27. **The skills capability is inert without both the env flag and a provider**, and registration is
    unconditional so grant/reservation/effect metadata never changes.
    `packages/skills/src/capability.ts:96`, `packages/loop/src/runtime/build-run-deps.ts:536-549`.
    Pinned: `packages/skills/tests/component/capability.test.ts:95`,
    `packages/loop/tests/integration/skills-grant-gating.test.ts:105`, `:161`.
28. **Neither the catalog section nor the `load_skill` tool reaches an agent without the
    `use_skills` grant, and an ungranted agent triggers no scan at all.**
    `packages/skills/src/capability.ts:116`–`:120`, `:169`. Pinned:
    `packages/skills/tests/component/capability.test.ts:139`,
    `packages/loop/tests/integration/skills-grant-gating.test.ts:85`.
29. **An empty catalog yields neither the section nor the tool**, even with the grant.
    `packages/skills/src/capability.ts:119`, `:170`. Pinned:
    `packages/skills/tests/component/capability.test.ts:177`,
    `packages/loop/tests/integration/skills-grant-gating.test.ts:133`.
30. **The catalog is scanned once per run and the same listing serves the entry agent and every
    spawned sub-agent.** `packages/skills/src/capability.ts:114`–`:115`. Pinned:
    `packages/skills/tests/component/capability.test.ts:114` (`second === first`, one `bootstraps()`
    call).
31. **`load_skill` is contributed unadvertised**, i.e. `advertised: false` on the contribution.
    `packages/skills/src/capability.ts:176`. Pinned:
    `packages/skills/tests/component/capability.test.ts:198`.
32. **`load_skill` validates against its own declared schema and refuses to run when the host wires
    no validator.** `packages/skills/src/call.ts:86`–`:87`. Pinned:
    `packages/skills/tests/unit/call.test.ts:11`, `:265`.
33. **A `resource` argument that actually names the skill's own manifest or a directory sentinel is
    treated as a body load, and no resource read is attempted.**
    `packages/skills/src/call.ts:38`–`:43`, `:97`–`:101`. Pinned:
    `packages/skills/tests/unit/call.test.ts:171` (nine spellings, zero reads).
34. **A resource request for an unknown skill is rejected before any read.**
    `packages/skills/src/call.ts:105`. Pinned: `packages/skills/tests/unit/call.test.ts:94`.
35. **`load_skill`'s resource branch never calls `loadSkill`** — it is a materially separate
    code path from the body branch, not a variant of it, and reads a resource "without loading
    or retaining the skill body." `packages/skills/src/call.ts:105`–`:119` (only the body branch
    at `:122` calls `loadSkill`). Pinned:
    `packages/skills/tests/integration/call-resource.test.ts:37`–`:49`.
36. **A `load_skill` failure is a non-progressing tool result, never a throw.**
    `packages/skills/src/capability.ts:205`, `packages/skills/src/call.ts:89`. Pinned:
    `packages/skills/tests/component/capability.test.ts:215`.
37. **A bootstrap is admitted only when the resolved skill's `root` matches one of the declaring
    plugin's own declared roots.** `packages/skills/src/bootstrap.ts:131`. Pinned:
    `packages/skills/tests/unit/bootstrap.test.ts:65`, `:183`, `:192`.
38. **An oversized bootstrap body is skipped, never truncated**, and the run-wide budget stops
    admission at the first entry that would exceed it.
    `packages/skills/src/bootstrap.ts:139`, `:143`–`:146`. Pinned:
    `packages/skills/tests/unit/bootstrap.test.ts:116`, `:163`.
39. **`resolveBootstrapSkills` never throws**, including when the loader throws.
    `packages/skills/src/bootstrap.ts:120`–`:125`. Pinned:
    `packages/skills/tests/unit/bootstrap.test.ts:91`.
40. **A host `bootstraps()` port that throws degrades the run to a plain catalog.**
    `packages/skills/src/capability.ts:139`–`:145`. Pinned:
    `packages/skills/tests/component/capability.test.ts:159`.
41. **Bootstrap bodies are rendered before the catalog**, and with no bootstraps the section is
    byte-identical to the catalog form. `packages/skills/src/tool.ts:111`–`:121`. Pinned:
    `packages/skills/tests/unit/tool.test.ts:45`, `:53`.
42. **`renderSkillCatalog` does not mutate its input.** It sorts a filtered copy
    (`packages/skills/src/catalog/index.ts:28`–`:32`). Pinned:
    `packages/skills/tests/component/catalog.test.ts:43`.
43. **Argument-placeholder substitution happens in a single pass with a replacer function**, so a
    task containing `$$`/`$&`/`` $` ``/`$'` or the other placeholder is inserted verbatim.
    `packages/kernel/src/skills/render-skill-prompt.ts:229`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts:171`, `:185`.
44. **A missing task substitutes as the empty string on the placeholder path, and as the fallback
    sentence only on the no-placeholder path.**
    `packages/kernel/src/skills/render-skill-prompt.ts:229`, `:247`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts:190`, `:126`.
45. **`getPrompt` rejects an unknown or non-user-invocable skill with kernel `not_found`.**
    `packages/kernel/src/skills/skills-service.ts:99`–`:101`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts:361`.
46. **`skillEntryAgent` reads only the *top-level* `agent` field**, not the nested `metadata` bucket.
    `packages/kernel/src/skills/render-skill-prompt.ts:80`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts:62` (a nested `metadata.agent` yields
    `undefined`).
47. **The kernel re-validates provider-supplied icon paths rather than trusting the DTO.**
    `packages/kernel/src/skills/render-skill-prompt.ts:139`–`:145`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts:290`.
48. **No diagnostic record carries a skill's content**: `skill.field_defaulted` logs a character
    count, `skill.body_disclosed` logs sizes.
    `packages/skills/src/registry.ts:258`, `:602`–`:609`. Pinned:
    `packages/skills/tests/integration/diagnostics.test.ts:97`, `:114`.
49. **Repeating diagnostic sites are guarded by `levelEnabled` before the bindings object is
    allocated.** `packages/skills/src/scan.ts:356`, `packages/skills/src/registry.ts:231`, `:256`,
    `:194`. *Unpinned* — no test asserts the guard itself.
50. **The engine reaches `@clarvis/skills` only through a dynamic `import()`** (INV-076/INV-080) —
    full statement owned by
    [engine/capability-composition.md](../engine/capability-composition.md) §5.

---

## 6. Failure modes and degradation

### 6.1 Error types

| Type | Where raised | Codes |
| --- | --- | --- |
| `StartupError` | `resolveConfig` only | no roots; too many roots; workspace missing / not a directory (`packages/skills/src/config.ts:94`, `:97`, `:144`, `:147`) |
| `SkillError` | everywhere else | `invalid_skill`, `duplicate_skill`, `not_found`, `not_a_file`, `path_escape`, `invalid_input`, `io_error` (`packages/skills/src/errors.ts:6`) |
| kernel `not_found` | `SkillsService.getPrompt`, `resolveSkillRun` | `packages/kernel/src/skills/skills-service.ts:100`, `packages/kernel/src/runs/settings-assembler.ts:95` |

`fsError` maps `ENOENT → not_found`, `EISDIR`/`ENOTDIR → not_a_file`, everything else → `io_error`
with the original errno in the message (`packages/skills/src/errors.ts:48`–`:55`; pinned at
`packages/skills/tests/unit/errors.test.ts:13`).

### 6.2 What degrades vs. what fails

| Situation | Non-strict outcome | Strict outcome |
| --- | --- | --- |
| root does not exist / unreadable | empty listing + `skill.dir_unreadable` debug (`packages/skills/src/scan.ts:462`–`:467`) | same — this one is never fatal |
| directory over the entry cap | that directory drops whole, warn (`:444`) | same |
| manifest parse failure | warn `skipping <file>: <cause>`, `skill.rejected` reason `parse`, skill omitted (`packages/skills/src/registry.ts:376`–`:380`) | rethrow |
| intra-root duplicate | warn, later one dropped (`:391`) | `duplicate_skill` throw |
| >256 manifests in one root | warn, first 256 by directory order (`:363`–`:369`) | `invalid_skill` throw |
| >512 distinct skills | warn once, largest-name eviction (`:144`–`:158`) | `invalid_skill` throw |
| dangling symlink (dir, manifest or resource) | warn "skipping dangling symlink", `skill.resource_skipped` `dangling` (`packages/skills/src/scan.ts:546`, `:560`) | same |
| escaping resource symlink | warn "escaping skill dir", entry omitted (`:292`) | same |
| escaping sidecar symlink | warn "skipping skill sidecar escaping skill dir", no sidecar (`:168`–`:173`) | same |
| unreadable / unparseable / non-mapping sidecar | warn + `skill.sidecar_invalid` (`unreadable` / `unparseable` / `not_a_mapping`), skill loads without presentation and without suppression (`packages/skills/src/sidecar.ts:335`, `:367`) | same |
| non-YAML file in `agents/` | ignored silently (extension filter, `packages/skills/src/scan.ts:171`) | same |
| body over the char cap | `get()` throws `invalid_skill` at disclosure time, catalog entry survives (`packages/skills/tests/integration/bounds.test.ts:138`) | same |
| oversized resource | `readResource` throws with `fields.dimension` = `bytes`/`characters` (`packages/skills/src/bounded-read.ts:55`, `:78`) | same |
| descriptor fails to close | `skill.handle_close_failed` debug, read result unaffected (`packages/skills/src/lib/log.ts:80`) | same |
| `realpath` fails during containment | falls back to lexical compare and warns `skill.path_unresolved` at **warn** level, because a lexical check cannot see through a symlink (`packages/skills/src/paths.ts:63`) | same |

### 6.3 Discovery summary event

Every `buildRegistry` pass ends by emitting one aggregate record — the only always-emitted
diagnostic for a whole discovery pass — at `info`, guarded by `levelEnabled(config.logger,
"info")`: `skills.discovered` with fields `roots`, `skills` (final catalog size), `shadowed`
(sum of each surviving skill's shadow-chain length), `defaulted` (skills carrying at least one
supplied field), `dropped` and `ms` (`packages/skills/src/registry.ts:188`–`:209`). Its message —
"skill discovery finished; this catalog is what every agent in the run is offered" — is the one
line that names the whole pass's outcome.

### 6.4 Capability- and host-level degradation

| Situation | Outcome | Source |
| --- | --- | --- |
| `CLARVIS_SKILLS_ENABLED` false, or no provider | capability `forRun` returns `null`; the run has no section and no tool | `packages/skills/src/capability.ts:96` |
| `builtins.skills = false` | package never loaded; `reportBuiltinDisabled` debug record | `packages/loop/src/runtime/build-run-deps.ts:369-371,440-448` |
| initial `createAgentSkills` throws | `skills.discovery_failed` (`scope: "initial"`), deps built without skills | `:464`–`:475` |
| rescan throws (dynamic roots) | `skills.discovery_failed` (`scope: "rescan"`), last good scan served; if there was none, an empty provider whose resource methods throw `"skills are unavailable"` | `:209`–`:224` |
| root provider throws | treated as no extra roots, `skills.roots_unavailable` debug | `:193`–`:205` |
| `bootstraps()` throws | `bootstrap_skills_unavailable` warn, run degrades to the plain catalog | `packages/skills/src/capability.ts:141`–`:144` |
| plugin panel cannot read a plugin's skills | `skillNamesOf` returns `{ names: [], notes: [] }` on any throw; per-skill rejection notes are capped and summarized | `packages/kernel/src/plugins/plugin-service.ts:217`–`:239` |

### 6.5 Retries and timeouts

There are none in this subsystem. Every operation is synchronous filesystem work; `refresh()` is the
only re-read and it is caller-driven (`packages/skills/src/index.ts:56`). `dynamicSkills`'s
signature-based memo is a cache, not a retry (`packages/loop/src/runtime/build-run-deps.ts:207`–`:212`).

### 6.6 Silently tolerated

- A non-YAML file in `agents/` (§6.2).
- A presentation value that is over its cap is **discarded, not truncated**, so a field can never
  become a prefix of what its author wrote (`packages/skills/src/sidecar.ts:115`).
- A colour in a notation other than 3-/6-digit hex is dropped with no record
  (`packages/skills/src/sidecar.ts:172`).
- An icon path that is absolute, drive-qualified, backslash-separated or contains `..` is dropped
  with no record (`packages/skills/src/sidecar.ts:135`–`:137`).
- `metadataShortDescription` silently ignores a bucket that is not an object, a value that is not a
  string, and one over 512 chars (`packages/skills/src/registry.ts:96`–`:102`).

---

## 7. Coupling

### 7.1 What `@clarvis/skills` depends on

| Dependency | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/capability` | runtime (value) | `splitFrontmatterFence` (`packages/skills/src/parse.ts:1`), `levelEnabled`/`NOOP_LOGGER` (`packages/skills/src/scan.ts:3`, `packages/skills/src/lib/log.ts:1`), `openCallEnvelope`/`handlerBaseOf` (`packages/skills/src/call.ts:4`, `packages/skills/src/capability.ts:20`) |
| `@clarvis/paths` | runtime (value) | `resolveAgainst`/`resolveWorkspaceDir` (`packages/skills/src/config.ts:3`), `agentsSkillsDirs`/`globalPaths`/`workspacePaths` (`packages/skills/src/preset.ts:2`) — this package spells no `.clarvis`/`.agents` literal itself |
| `yaml` | runtime | frontmatter and sidecar parsing (`packages/skills/src/parse.ts:2`, `packages/skills/src/sidecar.ts:1`) |
| `zod` | runtime | `skillFrontmatterSchema` (`packages/skills/src/schema.ts:1`) |
| Node builtins | runtime | `node:fs`, `node:path`, `node:os` |

Declared at `packages/skills/package.json:63`–`:68`. There is **no** dependency on `@clarvis/loop`,
`@clarvis/kernel` or `@clarvis/protocol`; the capability is written against the contract package
alone.

### 7.2 What depends on `@clarvis/skills`

| Consumer | Edge | Static or dynamic |
| --- | --- | --- |
| `@clarvis/loop` | `import type { AgentSkills, SkillRootInput }`, `import type { SkillsProvider }` (`packages/loop/src/runtime/build-run-deps.ts:2`, `:30`); `export type` re-exports (`packages/loop/src/lib.ts:19`–`:20`); `export type { PluginBootstrapSkill }` (`packages/loop/src/runtime/capabilities/skills-settings.ts:50`) | **type-only** — erased |
| `@clarvis/loop` | `import("@clarvis/skills")` and `import("@clarvis/skills/capability")` inside `buildExecuteRunDeps` (`:448`, `:541`) | **dynamic** value import, deliberately |
| `@clarvis/kernel` | `createAgentSkills` for the plugin panel's skill listing (`packages/kernel/src/plugins/plugin-service.ts:8`) | static value |
| `@clarvis/kernel` | `MAX_SKILL_ROOTS` to bound the plugin root budget (`packages/kernel/src/plugins/plugin-contributions.ts:27`) | static value |
| `@clarvis/kernel` | `SkillsProvider` type via `@clarvis/loop` (`packages/kernel/src/skills/skills-service.ts:1`) | type-only |
| `@clarvis/code` | reaches skills only through `KernelClient.skills` (`packages/code/src/adapters/kernel-run-client.ts:429`–`:430`, `packages/code/src/adapters/kernel-capabilities-client.ts:30`) | protocol only |

The direction is forced two ways. The **type-only / dynamic split** is what keeps `builtins.skills =
false` meaningful: `skills-settings.ts` states that a *value* import there would make
`@clarvis/loop/host` statically require the optional package
(`packages/loop/src/runtime/capabilities/skills-settings.ts:4`–`:10`), and the architecture test
enforcing it is `packages/loop/tests/architecture/optional-package-loading.test.ts:178`, `:245`. The
**contract-only** dependency is what lets `packages/skills/tests/component/capability.test.ts` drive
`forRun`/`forAgent`/`attach` with fakes (`packages/skills/tests/helpers/capability-fakes.ts`) and
never boot an engine.

### 7.3 Name ownership

`LOAD_SKILL_TOOL_NAME` is owned only by this package; the capability derives its reservation and
`control` effect from `loadSkillTool` so the engine needs neither the name nor a mirror
(`packages/skills/src/tool.ts:9`–`:13`, `packages/skills/src/capability.ts:58`–`:62`). The engine
does keep a duplicate of the capability *name* it cannot statically import, pinned against drift
by `packages/loop/tests/architecture/builtin-capability-names.test.ts:18` and owned by
[engine/capability-composition.md](../engine/capability-composition.md).

### 7.4 Deliberately separate look-alikes

`@clarvis/loop` has its own `normalizeTools` for **agent** frontmatter
(`packages/loop/src/settings/agent-frontmatter.ts:10`), exported through `packages/loop/src/host.ts:11` and used by
`packages/kernel/src/runs/settings-assembler.ts:252`. It is a different function from
`packages/skills/src/parse.ts:279`; only the fence splitter was actually shared
(`packages/capability/src/frontmatter-fence.ts:2`–`:12`).

---

## 8. Open questions

1. **A block of module-level exports is reachable only from inside the package**, and nothing
   outside it — in `packages/*/src` or `packages/*/tests` — imports any of them:
   `parseSkill`, `readSkillSidecar`, `findSkillSidecar`, `resolveResourcePath`,
   `skillFrontmatterSchema`, `SkillError`/`fsError`, `StartupError`,
   `DEFAULT_STRICT`/`DEFAULT_FOLLOW_SYMLINKS` — the `StartupError` and `fsError` here being this
   package's, not the live `@clarvis/tools` symbols of the same names. None is re-exported from
   `packages/skills/src/index.ts`, so `@clarvis/skills` does not publish them; `HARNESS_CONFIG_DIR`
   (`packages/skills/src/scan.ts:43`) is not exported at module level either. `splitFrontmatter`
   (`packages/skills/src/parse.ts:102`) is in the same position and is exercised only by
   `packages/skills/tests/unit/parse.test.ts:2`. What the source does **not** say is whether the
   package-internal ones are meant to become public again or to be inlined at their single call
   sites.
2. **The per-root overflow counter under-reports.** `scanRoot` calls `listSkillDirs` without a
   `maximumSkills` argument (`packages/skills/src/registry.ts:351`), so the default
   `MAX_SKILLS_PER_ROOT + 1` applies (`packages/skills/src/scan.ts:82`) and the scan stops at 257
   candidates. `stats.dropped += candidates.length - MAX_SKILLS_PER_ROOT`
   (`packages/skills/src/registry.ts:364`) therefore always adds exactly `1`, and the strict error's
   `actual` field is capped at 257 (`:359`), regardless of how many manifests the root really holds.
   Nothing states whether that is intended.
3. **Catalog-overflow eviction is only approximately "the first 512 by name".** The warning text says
   "retaining the first 512 by name" (`packages/skills/src/registry.ts:155`), but the algorithm
   evicts the currently largest name only when the arriving name sorts before it (`:148`–`:151`),
   which depends on arrival order across roots. The test asserts only that a small name is retained
   and a large one is not (`packages/skills/tests/integration/bounds.test.ts:178`–`:179`).
4. **`defaultWarnSink` writes directly to `process.stderr`** (`packages/skills/src/lib/log.ts:10`)
   and is the default for every entry point that takes diagnostics
   (`packages/skills/src/lib/log.ts:46`). The loop always overrides it with a logger-routing sink
   (`packages/loop/src/runtime/build-run-deps.ts:454-458`), but `packages/kernel/src/plugins/plugin-service.ts:219`
   supplies its own and `createAgentSkills` called without one falls back to stderr. Whether the
   stderr default is intended to remain reachable is not determinable.
5. **Why the first `.yaml`/`.yml` by sorted name wins when several harness sidecars exist is
   unstated.** The `agents` directory name itself is intentional interoperability vocabulary, as
   documented at `HARNESS_CONFIG_DIR` (`packages/skills/src/scan.ts:25`–`:43`); only the
   multiple-file tie-break lacks a stated rationale.
6. **`SkillPresentation.starterPrompt` and `displayName` have no consumer in this document's scope** beyond
   the protocol DTO and the kernel projection; how (or whether) a UI renders them is a
   `@clarvis/code` question, not answered here.
7. **Delegated to sibling documents, deliberately not re-derived here:** the `.agents` precedence
   rule as an interop contract; plugin skill-root construction, the plugin budget and manifest
   parsing (`packages/kernel/src/plugins/plugin-manifest.ts:157`,
   `packages/kernel/src/plugins/plugin-contributions.ts:315`); and skill-driven agent routing through
   `createAgentWorkflowPolicy.isManagerRun` and `resolveSkillRun`
   (`packages/kernel/src/runs/settings-assembler.ts:89`).
8. **Windows behaviour of this package is unverified by any job in this document's scope.** The scanner uses
   `node:path` throughout and normalizes to POSIX separators for `rel`
   (`packages/skills/src/scan.ts:416`), but `packages/skills/package.json` is not referenced by any
   Windows-scoped CI configuration in scope, and several tests use `symlinkSync` unconditionally
   (e.g. `packages/skills/tests/integration/symlink.test.ts:40`).
