# Skill discovery, parsing, precedence and progressive disclosure

> Implemented at `packages/...`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

`@clarvis/skills` turns directories of `SKILL.md` files into a merged, in-memory catalog and serves
that catalog in three tiers: **list** (name + description metadata), **get** (body + enumerated
bundled resources), **resource/readResource** (one confined file)
and **readResourceChunk** (one byte-addressed UTF-8 page of a larger confined file)
(`SkillRegistry` in `packages/skills/src/types.ts`). The tiering is the point — the run's system
prompt receives only names and one-line descriptions (`packages/skills/src/catalog/index.ts`),
and the model pulls a body on demand through the `load_skill` tool
(`packages/skills/src/tool.ts`).

The package also ships the second half of the feature: the loop **capability** that gates the catalog
on an env flag and a per-agent grant, renders the system-prompt section, and dispatches `load_skill`
(`packages/skills/src/capability.ts`). Its `SkillsProvider` port
(`packages/skills/src/tool.ts`) is the only surface hosts consume, which is what lets the kernel
adapt a scanned catalog into the protocol `SkillsService` for slash-commands
(`packages/kernel/src/skills/skills-service.ts`) without either side knowing the other's
internals.

Everything the reader does is bounded and degrading. Roots, per-root manifests, distinct skills,
directory entries, nesting depth, file bytes, decoded characters, resource counts and sidecar size
each carry a hard cap (`packages/skills/src/limits.ts`), and a manifest written in a dialect
Clarvis cannot fully read is repaired or partially defaulted rather than deleted
(`packages/skills/src/parse.ts`, `packages/skills/src/parse.ts`,
`packages/skills/src/schema.ts`).

---

## 2. Surface

### 2.1 Package entrypoints

| Subpath | File | Contents |
| --- | --- | --- |
| `.` | `packages/skills/src/index.ts` | discovery facade, config resolution, bounded resource enumeration, full/chunked reads, streaming hashes, snapshot limits, preset roots, diagnostics and types |
| `./catalog` | `packages/skills/src/catalog/index.ts` | `renderSkillCatalog` only — one function, one parameter |
| `./capability` | `packages/skills/src/capability.ts` | loop capability, `load_skill` tool + handler, bootstrap resolution, `SkillsProvider` |

Declared in `packages/skills/package.json`; every entry resolves to `src/*.ts` under the
`bun` condition and `dist/*.js` otherwise.

### 2.2 Root entry (`@clarvis/skills`)

| Export | Signature / shape | Source |
| --- | --- | --- |
| `createAgentSkills(options)` | `(AgentSkillsOptions) => AgentSkills` | `packages/skills/src/index.ts` |
| `AgentSkills` | `{ config; listSkills(); loadSkill(name); resourcePath(name, rel); readResource(name, rel); readResourceChunk(name, rel, offset?, maxChars?); refresh() }` | `packages/skills/src/index.ts` |
| `discoverSkills(config)` | `(SkillConfig) => SkillRegistry` | `packages/skills/src/core.ts` |
| `resolveConfig(options)` | `(AgentSkillsOptions) => SkillConfig` | `packages/skills/src/config.ts` |
| `normalizeTools(tools)` | `(string[] \| string \| undefined) => string[]` | `packages/skills/src/parse.ts` |
| `ParsedSkill` | type only | `packages/skills/src/parse.ts` |
| `clarvisSkillRoots(opts?)` | `(ClarvisSkillRootsOptions) => SkillRootInput[]` | `packages/skills/src/preset.ts` |
| `MAX_SKILL_ROOTS` | `32` | `packages/skills/src/limits.ts` |
| `enumerateResources(dir, followSymlinks, config)` | bounded `ResourceEntry[]` walk used by disclosure and snapshot consumers | `packages/skills/src/scan.ts` |
| `readBoundedBytes(file, options, reader?)` | exact `Buffer` read from one opened descriptor behind byte and optional character limits | `packages/skills/src/bounded-read.ts` |
| `readBoundedTextChunk(file, options, reader?)` | one UTF-8 page whose cursor and continuation are byte offsets | `packages/skills/src/bounded-read.ts` |
| `hashBoundedFile(file, options, reader?)` | streaming SHA-256 identity of one bounded regular file, without text decoding | `packages/skills/src/bounded-read.ts` |
| bounded read/hash types | `BoundedReadOptions`, `BoundedTextChunkOptions`, `BoundedTextChunk`, `BoundedFileDigest`, `DescriptorReader` | `packages/skills/src/bounded-read.ts` |
| snapshot file/resource limits | `MAX_SKILL_FILE_BYTES`, `MAX_SKILL_FILE_CHARS`, `MAX_SKILL_RESOURCE_BYTES`, `MAX_SKILL_RESOURCE_CHARS`, `MAX_SKILL_RESOURCE_FILE_BYTES`, `MAX_SKILL_RESOURCE_SNAPSHOT_BYTES` | `packages/skills/src/limits.ts` |
| `ErrorCode` | type only — the closed union of error codes | `packages/skills/src/errors.ts` |
| re-exports from `@clarvis/paths` | `resolveWorkspaceDir`, `resolveAgainst`, `expandHome` | `packages/skills/src/index.ts` |

The parser, the sidecar reader, the path guard, the frontmatter schema and both error values are
**not** on this entry. They exist and are used throughout the package, but reaching them requires
importing a module rather than the entrypoint: `parseSkill` (`packages/skills/src/parse.ts`),
`readSkillSidecar` / `SkillSidecar` (`packages/skills/src/sidecar.ts`),
`findSkillSidecar` (`packages/skills/src/scan.ts`), `resolveResourcePath`
(`packages/skills/src/paths.ts`), `skillFrontmatterSchema` (`packages/skills/src/schema.ts`),
`SkillError` / `fsError` (`packages/skills/src/errors.ts`), `StartupError`
(`packages/skills/src/config.ts`) and the two defaults `DEFAULT_STRICT` / `DEFAULT_FOLLOW_SYMLINKS`
(`packages/skills/src/config.ts`). `HARNESS_CONFIG_DIR` (`packages/skills/src/scan.ts`)
goes one step further: it is a file-local `const` with no `export` at all, read four times inside
`scan.ts`. Consequently a host observes a startup misconfiguration only as an `Error` whose `name` is
`"StartupError"`, and a skill failure only as an error carrying one of the public `ErrorCode` values
— the classes themselves are not importable from `@clarvis/skills`. (`@clarvis/tools` publishes its
own, unrelated `StartupError` and `fsError`; those are on *its* public surface.)

`AgentSkillsOptions` (and every `SkillConfig`, which extends it) carries two independent
diagnostic channels bundled as `SkillDiagnostics`
(`packages/skills/src/lib/log.ts`, `packages/skills/src/config.ts`):
`warningSink` (a `WarnSink`, prose, defaulting to `defaultWarnSink` which writes to
`process.stderr`) and `logger` (a structured `Logger`, defaulting to `NOOP_LOGGER`). They are
deliberately not redundant — "the sink carries a formatted sentence a host may surface to a
user; the logger carries fields an operator greps... a message is free to change; a field name
is a contract" (`packages/skills/src/lib/log.ts`).

### 2.3 Capability entry (`@clarvis/skills/capability`)

| Export | Value / signature | Source |
| --- | --- | --- |
| `SKILLS_CAPABILITY_NAME` | `"skills"` | `packages/skills/src/capability.ts` |
| `USE_SKILLS_GRANT` | `"use_skills"` | `packages/skills/src/capability.ts` |
| `createSkillsCapability(provider?, options?)` | `=> Capability` | `packages/skills/src/capability.ts` |
| `SkillsCapabilityOptions.bootstraps` | `() => readonly PluginBootstrapSkill[]` | `packages/skills/src/capability.ts` |
| `LOAD_SKILL_TOOL_NAME` | `"load_skill"` | `packages/skills/src/tool.ts` |
| `READ_SKILL_RESOURCE_TOOL_NAME` | `"read_skill_resource"` | `packages/skills/src/tool.ts` |
| `SKILL_RESOURCE_MAX_CHARS` | `50_000` | `packages/skills/src/tool.ts` |
| `loadSkillTool` | `NamespacedTool` (see schema below) | `packages/skills/src/tool.ts` |
| `readSkillResourceTool` | `NamespacedTool` (see schema below) | `packages/skills/src/tool.ts` |
| `renderSkillsSection(catalog, bootstraps?)` | `=> string` | `packages/skills/src/tool.ts` |
| `handleLoadSkillCall(args)` | `=> LoadSkillCallResult` (synchronous) | `packages/skills/src/call.ts` |
| `handleReadSkillResourceCall(args)` | `=> LoadSkillCallResult` (synchronous) | `packages/skills/src/call.ts` |
| `SkillsProvider` | `{ listSkills; loadSkill; readResource; readResourceChunk? }` | `packages/skills/src/tool.ts` |
| `resolveBootstrapSkills(args)` | `=> ResolvedBootstrapSkill[]` | `packages/skills/src/bootstrap.ts` |
| `BOOTSTRAP_SKILL_MAX_CHARS` | `20_000` | `packages/skills/src/bootstrap.ts` |
| `BOOTSTRAP_SKILLS_RUN_BUDGET_CHARS` | `40_000` | `packages/skills/src/bootstrap.ts` |

Capability metadata is derived from the tool descriptor rather than spelled twice:
`reservedWireNames` is `SKILLS_TOOLS.map(t => t.wireName)` and `toolEffects` maps each to `"control"`
(`packages/skills/src/capability.ts`, asserted at
`packages/skills/tests/component/capability.test.ts`).

### 2.4 Skill-tool input schemas

```
load_skill:
  { type: "object", additionalProperties: false,
    properties: { name: { type: "string", minLength: 1 } },
    required: ["name"] }

read_skill_resource:
  { type: "object", additionalProperties: false,
    properties: { name: { type: "string", minLength: 1 },
                  resource: { type: "string", minLength: 1, maxLength: 4096,
                              pattern: <safe relative POSIX path> },
                  offset: { type: "integer", minimum: 0, maximum: 8388608 } },
    required: ["name", "resource", "offset"] }
```

The operations are separate so each provider-facing schema is structurally closed and every
declared property is required. `load_skill` cannot receive `resource`, `offset`, aliases or
sentinels; a call such as `{name, resource: "/dev/null? no resource omitted actually."}` is rejected
as an additional property before a provider or host bridge is touched. `read_skill_resource`
requires the exact listed relative path and an explicit byte offset: zero for the first page, then
the preceding result's cursor. Its schema rejects POSIX-absolute and drive-qualified paths,
backslashes, traversal, empty segments and control characters through a provider-portable pattern
that uses no regex lookaround; provider confinement remains the authoritative filesystem check.
Production:
`loadSkillTool` and `readSkillResourceTool` in `packages/skills/src/tool.ts`, with
`handleLoadSkillCall` and `handleReadSkillResourceCall` in `packages/skills/src/call.ts`. Test:
`packages/skills/tests/unit/tool.test.ts`, `packages/skills/tests/unit/call.test.ts` ("rejects every
resource-shaped argument on the name-only load operation"), and
`packages/skills/tests/integration/call-resource.test.ts`.

### 2.5 Settings / plugin-manifest key (owned by the engine, not this package)

| Key | Type | Source |
| --- | --- | --- |
| `bootstrapSkill` (plugin manifest) | `z.string().min(1).optional()` | `packages/loop/src/runtime/capabilities/skills-settings.ts` |

There is no `skills:` **settings.json** block: `SKILLS_PLUGIN_FIELDS` is the only thing
`skills-settings.ts` exports besides a type re-export
(`packages/loop/src/runtime/capabilities/skills-settings.ts`).

Two facts about `bootstrapSkill` are load-bearing and stated in its TSDoc
(`packages/loop/src/runtime/capabilities/skills-settings.ts`): it "deliberately carries
no `CapabilitySettingsSpec` and is not `pluginContributable`", so it never travels the
`settingsScopes`/trusted-plugin-filter path — which is what lets a skills-only plugin stay
`inert` and need no approval dialog; and it is "not regex-constrained on purpose, even though
skill names are" — a manifest field that failed validation would fail the whole manifest and
drop the plugin's skills along with it, so a bad value is instead "reported at resolution time
and skipped" (the `foreign_root`/`not_found`/etc. gates of §4.13).

### 2.6 Extension Profile gate

| Variable | Parser | Default | Source |
| --- | --- | --- | --- |
| `CLARVIS_SKILLS_ENABLED` | `boolFromEnv(true)` — `"false" \| "0" \| "no" \| "off" \| ""` are false, anything else true | `true` | `packages/capability/src/env.ts`, `packages/capability/src/env.ts` |

### 2.7 Protocol surface (`@clarvis/protocol`)

| Type | Fields | Source |
| --- | --- | --- |
| `SkillsService` | `list(): Promise<SkillSummary[]>`, `getPrompt(name, args?): Promise<Message[]>` | `packages/protocol/src/skills.ts` |
| `SkillSummary` | `name`, `description`, `agent?`, `arguments?`, `provenance?`, `presentation?`, `plansMode?` | `packages/protocol/src/skills.ts` |
| `SkillArgument` | `name`, `description?`, `required?` | `packages/protocol/src/skills.ts` |
| `SkillProvenance` | `scope: "user" \| "workspace"`, `source?`, `author?` | `packages/protocol/src/skills.ts` |
| `SkillPresentation` | `displayName?`, `shortDescription?`, `icons?`, `color?`, `starterPrompt?` | `packages/protocol/src/skills.ts` |
| `SkillIconSet` | `light?`, `dark?` | `packages/protocol/src/skills.ts` |

`KernelClient.skills` is one of the aggregated services (`packages/protocol/src/client.ts`).

---

## 3. Data and formats

### 3.1 On-disk layout

A skill is a **directory** containing a file whose lowercased name is `skill.md`
(`packages/skills/src/scan.ts`, matched case-insensitively at
`packages/skills/src/scan.ts`; pinned at `packages/skills/tests/integration/scan.test.ts`).
Everything else under that directory is resources, except the top-level `agents/` directory
(`packages/skills/src/scan.ts`).

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

Resource `kind` comes from the first path segment only (`packages/skills/src/scan.ts`); `rel` is
always POSIX-separated (`packages/skills/src/scan.ts`).

### 3.2 `SKILL.md` frontmatter

The fence is found by `splitFrontmatterFence` in `@clarvis/capability`
(`packages/capability/src/frontmatter-fence.ts`): a leading BOM and leading whitespace are
stripped, LF and CRLF are both accepted, and the outcome is `fenced` / `absent` / `unterminated`
(`packages/capability/src/frontmatter-fence.ts`).

Validated fields (`packages/skills/src/schema.ts`):

| Field | Rule | Cap | Failure behaviour |
| --- | --- | --- | --- |
| `name` | trimmed, `/^[A-Za-z0-9._-]+$/` | 128 chars | required; **supplied** from the directory name if unusable |
| `description` | trimmed, non-empty | 1024 chars | required; **supplied** from short-description/placeholder |
| `agent` | trimmed, `/^[A-Za-z0-9._:-]+$/` (admits `:` for `<plugin>:<agent>`) | 128 chars | `.catch(undefined)` — degrades to "names no agent" |
| `version` | string | — | `.catch(undefined)` |
| `license` | string | — | `.catch(undefined)` |
| `argument-hint` | string **or** `string[]`, joined with `", "` | — | `.catch(undefined)` |
| `user-invocable` | boolean | — | defaults to `true` at `packages/skills/src/registry.ts` |
| `allowed-tools` / `tools` | `string[]` (≤128 entries, ≤256 chars each) **or** comma-separated string | `packages/skills/src/schema.ts` | **no `.catch`** — an unreadable value fails the manifest |
| any other key | passthrough, retained on `SkillInfo.metadata` | — | — |

The asymmetry is explicit in the source: display-only fields degrade, a tool restriction does not,
because degrading it "would *widen* what the skill may do"
(`packages/skills/src/schema.ts`); pinned at
`packages/skills/tests/unit/schema.test.ts`.

The `argument-hint` `.catch` carries its own measured justification: `argument-hint: [file,
directory]` is a YAML flow sequence, not the bracketed text its author typed, and a bare
`z.string()` rejected it — since a frontmatter failure is not local to one field, the whole skill
vanished from the catalog along with its slash command. "Nine skills in a public catalog of 196
plugins were lost to exactly that." (`packages/skills/src/schema.ts`.)

An Agent Plugins v1 skill root selects `validation: "agent-skills"`; it does not use those tolerant
defaults for portable fields. `assertRootValidation` in `packages/skills/src/registry.ts` requires
an authored name and description, a lowercase alphanumeric/hyphen name of at most 64 characters
that exactly matches its directory, a string `license`, a 1–500-character string
`compatibility`, string-to-string `metadata`, and a string `allowed-tools`. `buildResolvedSkill`
splits that last field on whitespace, as the Agent Skills contract specifies; the native compatible
reader continues to accept arrays and comma-separated text. Failure is local to the offending
skill under ordinary plugin discovery. Production: `assertRootValidation` and
`buildResolvedSkill` in `packages/skills/src/registry.ts`, with the original YAML value retained by
`parseSkillFrontmatterWithDefaults`/`parseSkillWithDefaults` in `packages/skills/src/parse.ts`.
Test: `packages/skills/tests/integration/discovery.test.ts` ("applies Agent Skills identity
validation only to roots that request it").

Example the fixtures exercise (`packages/skills/tests/fixtures/foreign-skills/metadata-short/SKILL.md`):

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
`agents/` (`packages/skills/src/scan.ts`). It is a YAML **mapping**; anything else
degrades to "no sidecar" (`packages/skills/src/sidecar.ts`).

Accepted key spellings per concept (`packages/skills/src/sidecar.ts`):

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
| MCP tool dependencies | `dependencies.tools[]` entries with `type: mcp`, `value`, optional `description`/`transport`/`url` | at most 64 bounded entries |

`readCatalogSuppressed` (`packages/skills/src/sidecar.ts`) has a real precedence order
the table above does not show: it tries the **policy block first, then the root** mapping, and
*within* each block it checks `implicit-invocation` (in any spelling) before `hide-from-catalog` —
whichever concept is found first in a given block decides outright, and the other concept in that
same block is never consulted. Only when the policy block mentions neither concept does the root
block get a turn. So a policy-level `implicit-invocation: false` wins over a root-level
`hidden: false` even though both are present; the two concepts are never merged.

`readToolDependencies` accepts only `type: "mcp"`, bounds each string and ignores malformed or
unsupported entries without removing the skill. The resulting `SkillInfo.dependencies` is retained
by the protocol catalog; per-run capability activation keeps a skill only when every named server is
present either directly or under that skill's `plugin:<name>` namespace. Production:
`readToolDependencies` in `packages/skills/src/sidecar.ts` and `dependenciesAvailable` in
`packages/skills/src/capability.ts`. Test: dependency cases in
`packages/skills/tests/integration/sidecar.test.ts` and
`packages/kernel/tests/component/skills-service.test.ts`.

Fixture (`packages/skills/tests/fixtures/foreign-skills/presented/agents/harness.yaml`):

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

`SkillInfo` (`packages/skills/src/types.ts`): `name`, `description`, `metadata`,
`allowedTools?`, `userInvocable`, `catalogSuppressed?`, `presentation?`, `dependencies?`, `defaulted?`, `scope`,
`source`, `root`, `dir`, `executionRoot?`, `path`, `shadowed?`. `SkillContent` extends it with `body`
and `resources`, plus optional `identityFiles`: absolute manifest, selected-sidecar, and resource
paths whose bytes produced the effective content and allow-list. The sidecar path is identity-only
and does not become a readable resource (`SkillContent` in `packages/skills/src/types.ts` and
`SkillRegistry.get` in `packages/skills/src/registry.ts`). `ResolvedSkill` retains the selected
sidecar path internally so the public disclosure can identify it without exposing its contents.
Test: `createAgentSkills public facade` in `packages/skills/tests/integration/api.test.ts` and the
post-watch sidecar verification case in
`packages/kernel/tests/integration/extension-profile-manager.test.ts`.

`SkillRootInput.executionRoot` is a host approval flag, not the path ultimately disclosed. When it
is present, `buildResolvedSkill` records that discovered skill's own `dir` as
`SkillInfo.executionRoot`; the collection root or package boundary is never exposed through this
field. Production: `normalizeRoot` in `packages/skills/src/config.ts` and `buildResolvedSkill` in
`packages/skills/src/registry.ts`. Test: `packages/skills/tests/integration/api.test.ts`
(`exposes only the selected skill directory when its root approves helper execution`).

`ShadowedSkill` records only `source`, `scope`, `root`, `dir`
(`packages/skills/src/types.ts`, projected at `packages/skills/src/registry.ts`).

### 3.5 Identifiers

The skill **name** is the lookup key, the merge identity and the slash-command name
(`packages/skills/src/types.ts`, `packages/protocol/src/skills.ts`). There is no generated id
anywhere in this subsystem. When a name has to be supplied it comes from the directory basename with
unsupported characters collapsed to `-`, edge separators stripped, truncated to 128 chars, falling
back to the literal `"skill"` (`packages/skills/src/registry.ts`; pinned at
`packages/skills/tests/integration/sidecar.test.ts`).

### 3.6 Limits table

| Constant | Value | Source |
| --- | --- | --- |
| `MAX_SKILL_ROOTS` | 32 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_DIRECTORY_ENTRIES` | 2 048 | `packages/skills/src/limits.ts` |
| `MAX_SKILLS_PER_ROOT` | 256 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_NESTING` | 4 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_GROUP_DIRECTORIES` | 1 024 | `packages/skills/src/limits.ts` |
| `MAX_SKILLS` | 512 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_FILE_BYTES` | 262 144 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_FILE_CHARS` | 100 000 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_FRONTMATTER_BYTES` | 65 536 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_FRONTMATTER_CHARS` | 50 000 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_DEPTH` | 16 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_ENTRIES` | 4 096 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_DIRECTORIES` | 512 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCES` | 1 024 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_BYTES` | 262 144 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_CHARS` | 50 000 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_FILE_BYTES` | 8 388 608 (8 MiB) | `packages/skills/src/limits.ts` |
| `MAX_SKILL_RESOURCE_SNAPSHOT_BYTES` | 33 554 432 (32 MiB) | `packages/skills/src/limits.ts` |
| `MAX_SKILL_SIDECAR_BYTES` | 16 384 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_SIDECAR_CHARS` | 8 000 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_LABEL_CHARS` | 128 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_SHORT_DESCRIPTION_CHARS` | 512 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_STARTER_PROMPT_CHARS` | 4 000 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_ICON_PATH_CHARS` | 512 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_CATALOG_CHARS` | 8 000 | `packages/skills/src/catalog/index.ts` |
| `MAX_SKILL_NAME_CHARS` / `MAX_SKILL_AGENT_CHARS` | 128 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_DESCRIPTION_CHARS` | 1 024 | `packages/skills/src/limits.ts` |
| `MAX_SKILL_TOOLS` / `MAX_SKILL_TOOL_CHARS` | 128 / 256 | `packages/skills/src/limits.ts` |
| `SKILL_RESOURCE_MAX_CHARS` (maximum characters in one tool page) | 50 000 | `packages/skills/src/tool.ts` |
| `BOOTSTRAP_SKILL_MAX_CHARS` / run budget | 20 000 / 40 000 | `packages/skills/src/bootstrap.ts` |

---

## 4. Behavior

### 4.1 Configuration (`resolveConfig`)

1. `home` ← option or `os.homedir()`; `cwd` ← option or `process.cwd()`; `workspaceDir` ←
   `resolveWorkspaceDir(workspace, cwd, home)` (`packages/skills/src/config.ts`).
2. If `workspace` was given explicitly, `validateDir` stats it and throws `StartupError` when it is
   missing or not a directory, emitting `skills.workspace.unreadable` at `debug` first
   (`packages/skills/src/config.ts`).
3. Empty `roots` ⇒ `StartupError`; more than `MAX_SKILL_ROOTS` ⇒ `StartupError` naming both
   counts (pinned at `packages/skills/tests/unit/config.test.ts`).
4. Each root is normalized: path resolved against workspace + `~`, `scope` defaults to `"workspace"`,
   `source` to `""`, and an optional `include` list is validated, de-duplicated and sorted
   (`packages/skills/src/config.ts`). An absent list means full discovery; an empty list
   admits nothing.

`createAgentSkills` scans once at construction; `AgentSkills.refresh()` re-scans every configured
root from disk and **replaces** the in-memory registry wholesale, so additions, content
modifications and removals are all reflected on the next call — nothing is diffed or merged
against the previous scan (`packages/skills/src/index.ts`). Pinned:
`packages/skills/tests/integration/api.test.ts` ("refreshes additions, modifications and
removals from disk").

### 4.2 Root order

`clarvisSkillRoots` returns four roots in **ascending precedence**
(`packages/skills/src/preset.ts`):

| # | Path | scope | source |
| --- | --- | --- | --- |
| 1 | `<home>/.agents/skills` | `user` | `agents` |
| 2 | `<workspace>/.agents/skills` | `workspace` | `agents` |
| 3 | `<global>/skills` (`globalPaths`) | `user` | `clarvis` |
| 4 | `<workspace>/.clarvis/skills` | `workspace` | `clarvis` |

The `.agents` half of this ordering is an interop rule — see
[`specs/cross-cutting/agent-interop.md`](../cross-cutting/agent-interop.md).
The engine prepends any host-supplied `extraSkillRoots` **before** these four, so plugin roots sit at
the lowest precedence of all. A host-supplied `skillRoots` is instead an exact resolved set and
suppresses automatic appending of the standard four roots
(`packages/loop/src/runtime/build-run-deps.ts`). The two options are mutually exclusive. Plugin root
construction belongs to [`specs/hosts/plugins.md`](../hosts/plugins.md); what
matters here is only that they arrive as `SkillRootInput[]` with `source: "plugin:<name>"`
(`packages/kernel/src/plugins/plugin-contributions.ts`).

### 4.3 Scanning one root (`listSkillDirs`)

Discovery first checks the root itself, then uses a breadth-first queue only for a collection root
(`listSkillDirs` in `packages/skills/src/scan.ts`):

| Step | Rule | Evidence |
| --- | --- | --- |
| root holds a `SKILL.md`? | return the root as the only skill and do not inspect its resource subtree | `listSkillDirs` before queue construction |
| list a directory | streamed, at most `MAX_SKILL_DIRECTORY_ENTRIES`; on overflow the **whole directory** yields nothing | `readDirectoryBounded` |
| entry is a directory? | real dir always; symlink only when `followSymlinks` and its target is a dir | `isDirEntry` |
| probe budget | every probed child increments; past `MAX_SKILL_GROUP_DIRECTORIES` the scan warns and returns what it has | `listSkillDirs` |
| directory holds a `SKILL.md`? | it is a skill; **never descended into** | `findSkillFile` branch in `listSkillDirs` |
| otherwise | queued at `depth+1`, only while `depth+1 < MAX_SKILL_NESTING` | traversal queue in `listSkillDirs` |
| early stop | returns as soon as `out.length >= maximumSkills` | skill-admission branch in `listSkillDirs` |
| ordering | final `sort` by `dir` path (a **path** sort, not a basename sort) | local `done` closure in `listSkillDirs` |

**Direct-root invariant.** A configured root that directly contains `SKILL.md` is one skill, not a
collection, and discovery never descends into its resources.

- **Production:** `listSkillDirs` calls `findSkillFile` on the root before constructing the traversal
  queue; the same function stops below every child directory that becomes a skill.
- **Test:** `packages/skills/tests/integration/scan.test.ts`, cases "accepts a skill directory itself
  as a root" and "never looks inside a skill, so a bundled example is not a second skill".

The remaining traversal rules are pinned in `packages/skills/tests/integration/scan.test.ts` by the
grouping, multi-level nesting, nesting-bound, width-bound and early-stop cases.

### 4.4 Building one skill (`buildResolvedSkill`)

Order matters and is fixed (`packages/skills/src/registry.ts`):

1. **Bounded prefix read** of `SKILL.md`: at most `MAX_SKILL_FRONTMATTER_BYTES`, refusing the file
   outright if its complete size exceeds `MAX_SKILL_FILE_BYTES` (implemented at
   `packages/skills/src/bounded-read.ts`).
2. **Sidecar** located and read.
3. **Defaults computed** — name from the directory, description from the sidecar's short description
   or `"(no description supplied)"`.
4. **Frontmatter parsed with defaults**: split fence → YAML parse (with flat-mapping repair) →
   character cap → fill unusable required fields → zod validate
   (`packages/skills/src/parse.ts`).
5. **Warnings**: a declared name that differs from the directory name warns but is *not* corrected,
   and is skipped when the name was supplied by Clarvis (pinned at
   `packages/skills/tests/integration/malformed.test.ts` and
   `packages/skills/tests/integration/sidecar.test.ts`). Every supplied field warns and emits
   `skill.field_defaulted` recording only its **length** (pinned at
   `packages/skills/tests/integration/diagnostics.test.ts`).
6. **Description resolution**: the manifest's own description wins; the short description (sidecar
   first, then the manifest's `metadata.short-description`/`short_description`) is used **only** when
   `description` was defaulted.
7. **Info assembled**: `allowedTools` from `allowed-tools` ?? `tools`; `userInvocable` defaults
   `true`; `catalogSuppressed` set only when the sidecar says so; `metadata` carries the frontmatter
   with the resolved `description` overwritten.
8. **Body getter**: lazy, memoized after the first read, and it **re-parses and re-validates** the
   whole file; a name that changed since discovery emits `skill.name_changed` and throws
   (pinned at `packages/skills/tests/integration/bounds.test.ts`).

### 4.5 Merging (`buildRegistry`)

```
for each root (ascending precedence):
  for each skill from scanRoot(root):
    if the name already exists  -> mergeWinner(newSkill, existing)     # later root wins
    else if size < MAX_SKILLS   -> insert
    else                        -> catalog overflow (see below)
```

`packages/skills/src/registry.ts`.

**Intra-root** duplicates are resolved *before* cross-root merging, first-seen wins (directory sort
order), with a warning or — under `strict` — a `duplicate_skill` throw
(`packages/skills/src/registry.ts`; pinned at
`packages/skills/tests/integration/malformed.test.ts`).

**Cross-root** collisions call `mergeWinner`, which keeps the winner and accumulates the full shadow
chain `[…winner.shadowed, loser, …loser.shadowed]`, and warns with `skill.shadowed` naming the
winning origin and every losing one (`packages/skills/src/registry.ts`; pinned at
`packages/skills/tests/integration/discovery.test.ts` and
`packages/skills/tests/integration/diagnostics.test.ts`).

**Catalog overflow** at `MAX_SKILLS`: under `strict` it throws; otherwise it counts a drop, logs
`skill.rejected` with reason `catalog_overflow`, and — if the newcomer's name sorts *before* the
currently largest retained name — evicts that largest and inserts the newcomer
(`packages/skills/src/registry.ts`). One warning is emitted after the whole
pass, not per skill. Pinned at
`packages/skills/tests/integration/bounds.test.ts`.

### 4.6 Registry state machine (`makeRegistry`)

| Operation | Input state | Result | File |
| --- | --- | --- | --- |
| `list()` | any | every `info`, sorted by name | `packages/skills/src/registry.ts` |
| `get(name)` | unknown name | `undefined` | `packages/skills/src/registry.ts` |
| `get(name)` | known, body readable | `{ …info, body, resources }` + `skill.body_disclosed` debug record | `packages/skills/src/registry.ts` |
| `get(name)` | known, manifest renamed on disk | throws `invalid_skill` "refresh required" from the lazy body getter | `packages/skills/src/registry.ts` |
| `resource(name, rel)` | unknown skill | `SkillError not_found` | `packages/skills/src/registry.ts` |
| `resource(name, rel)` | `rel` empty / absolute | `SkillError invalid_input` | `packages/skills/src/paths.ts` |
| `resource(name, rel)` | resolves outside the skill dir | `SkillError path_escape` | `packages/skills/src/paths.ts` |
| `resource(name, rel)` | inside `agents/` (lexically **or** after realpath) | `SkillError not_found` — deliberately indistinguishable from absent | `packages/skills/src/registry.ts` |
| `resource(name, rel)` | cannot be stat'd | `not_found` + `skill.resource_missing` debug | `packages/skills/src/registry.ts` |
| `resource(name, rel)` | not a regular file | `SkillError not_a_file` | `packages/skills/src/registry.ts` |
| `readResource(name, rel)` | as above, then bounded read at 256 KiB / 50 000 chars | text or `invalid_input` size error | `packages/skills/src/registry.ts` |
| `readResourceChunk(name, rel, offset?, maxChars?)` | as above, complete file at most 8 MiB, then one page at most 256 KiB / 50 000 chars | `BoundedTextChunk` with byte cursor, or fail-closed `invalid_input` | `makeRegistry` in `packages/skills/src/registry.ts` |
| `size` | any | live map size | `packages/skills/src/registry.ts` |

Pinned: the three resource outcomes at
`packages/skills/tests/integration/registry-resource.test.ts`; harness-directory refusal
(both spellings and through an aliasing symlink) at
`packages/skills/tests/integration/sidecar.test.ts`.

### 4.7 Resource enumeration (`enumerateResources`)

`enumerateResources` is also exported from `@clarvis/skills`. This lets a host that must fingerprint
the admitted resource surface use the same symlink, depth, entry and resource-count policy as the
registry instead of implementing a divergent second walk. The function still owns no host or
Extension Profile semantics.

Snapshot consumers pair that walk with exported `hashBoundedFile`. It opens the canonical path once,
applies `fstat` to that descriptor, streams raw bytes through a fixed 64 KiB buffer, rejects a file
over 8 MiB or one that changes while read, and returns its SHA-256 digest, exact byte count and mode.
It does not decode binary resources or retain a complete file allocation. Kernel snapshot consumers
sum those exact byte counts and reject their captured skill surface after 32 MiB of resource
content; the per-file and aggregate budgets are deliberately distinct. Production:
`hashBoundedFile` in `packages/skills/src/bounded-read.ts`, `skillSurface` inside
`createPluginContributions` in `packages/kernel/src/plugins/plugin-contributions.ts`, and the
`loadDigest` callback inside `createExtensionProfileManager` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`. Test:
`packages/skills/tests/unit/bounded-read.test.ts` (`hashes bounded raw bytes without decoding binary
content`) and `packages/kernel/tests/integration/plugin-contributions.test.ts` (`streams large binary
and text resources into the exact skill snapshot` and the per-file resource bound).

Depth-first with a `realpath`-keyed `visited` set, so a symlink cycle back into the skill terminates
(`packages/skills/src/scan.ts`; pinned at
`packages/skills/tests/integration/symlink.test.ts`). Exclusions and budgets, in the order the
loop applies them:

| Rule | Effect |
| --- | --- |
| `visited.size >= MAX_SKILL_RESOURCE_DIRECTORIES` | warn, stop the whole walk |
| entry budget exhausted (before opening) | warn, stop |
| entry budget exceeded (after listing) | warn, stop |
| top-level `agents/` | skipped whole |
| symlink that escapes the skill dir | warn + `skill.resource_skipped` `escaping_symlink` |
| top-level `SKILL.md` | skipped |
| `out.length >= MAX_SKILL_RESOURCES` | warn, return what is collected |
| directory deeper than `MAX_SKILL_RESOURCE_DEPTH` | warn, skip |
| final | sort by `rel` |

`escapesRoot` returns `false` for `ENOENT` (so a dangling link falls through to the accurate
"dangling symlink" warning) and `true` for every **other** realpath failure, because `stat` needs
less permission than `realpath` and an unresolvable link out of the skill would otherwise be
published (`packages/skills/src/scan.ts`; pinned at
`packages/skills/tests/integration/scan.test.ts`).

`safeRealpath` is a separate, more permissive fallback used only to compute a **cycle-detection
key**: it resolves a path with `realpathSync.native` and, on any failure, falls back to the
unresolved path itself rather than treating the failure as an escape, logging
`skill.realpath_failed` at `debug` (`packages/skills/src/scan.ts`). It backs five call
sites — package confinement, sidecar lookup, the harness-directory probe,
and the resource-enumeration root and its walk — and is distinct
from the escape check above: it never rejects anything, it only decides what a symlink cycle is
keyed by when the "true" path cannot be determined.

### 4.8 YAML repair path

`parseFrontmatterDocument` tries a strict `yaml` parse with `maxAliasCount: 32`
(`packages/skills/src/parse.ts`). **Only on failure** does `reparseFlatMapping` run
:

| Line shape | Handling |
| --- | --- |
| blank or `#` comment | skipped |
| not `^([A-Za-z0-9_-]+):[ \t]*(.*)$` | give up, whole document fails |
| empty value | give up |
| value starts with `"' [ { \| > & * !` | re-parsed as `v: <value>` alone; a throw gives up |
| anything else | taken as the author's **literal** text |

This is what keeps `description: Five phases: detect, contain, diagnose.` readable
(`packages/skills/tests/unit/parse.test.ts`) while leaving a genuine nested mapping untouched
 and refusing a non-flat document. Because it recovers literal text, a bracketed
`allowed-tools: [read_file, grep]` beside a colon-bearing scalar still parses as a list
(`packages/skills/tests/unit/parse.test.ts`).

### 4.9 Required-field defaulting (`applyDefaults`)

Each of `name`, `description` is checked **individually** against its own schema; a field that is
absent *or present-but-unusable* is replaced by the caller's stand-in and recorded in `defaulted`
(`packages/skills/src/parse.ts`). Everything else still validates normally, so
a manifest with no frontmatter at all becomes a skill named after its directory with the neutral
placeholder description (`packages/skills/tests/integration/sidecar.test.ts`).

### 4.10 Capability activation

| Stage | Condition | Result | File |
| --- | --- | --- | --- |
| `forRun(ctx)` | `!ctx.env.CLARVIS_SKILLS_ENABLED` **or** no provider | `null` — capability inert | `packages/skills/src/capability.ts` |
| `systemSection(id)` | agent lacks `use_skills` | `undefined`, and nothing is scanned | `packages/skills/src/capability.ts` |
| `systemSection(id)` | catalog empty after dependency filtering | `undefined` | `packages/skills/src/capability.ts` |
| `systemSection(id)` | catalog non-empty but every entry suppressed **and** no bootstraps | `undefined` (rendered section is `""`) | `packages/skills/src/tool.ts` |
| `forAgent(scope)` | same grant + non-empty-catalog test | `null` or an `AgentCapability` | `packages/skills/src/tool.ts` |
| `attach(bc)` | — | two strict tools (`load_skill`, `read_skill_resource`), one handler, `advertised: false` | `createSkillsRunCapability` |

The dependency-filtered catalog is scanned **once per run** and memoized, and the bootstraps are resolved at
most once behind an explicit boolean flag rather than `??=`, so "no valid bootstrap" does not
re-resolve and re-warn on every agent spawn. Pinned at
`packages/skills/tests/component/capability.test.ts` (one `bootstraps()` call, two loads, one
warning, identical section for lead and spawned agent) (an ungranted agent triggers zero
scans, zero loads, zero warnings).

### 4.11 System-prompt section

`renderSkillsSection` emits, in order: each bootstrap body wrapped as
`# Plugin instructions … <plugin_instructions>…</plugin_instructions>`
(`renderBootstrapSection` in `packages/skills/src/tool.ts`), then the catalog block, then the
instructions for `load_skill` and `read_skill_resource` (`renderSkillsSection`). The catalog block is
`# Available skills` plus one
`- **name** — description (path: /absolute/SKILL.md)` line per non-suppressed filesystem skill.
Host-embedded `source: "builtin"` entries instead render `(builtin; load by name)` and precede
external skills; each group is sorted by name. The complete catalog never exceeds 8,000 characters.
On overflow it first drops every description while retaining
name and exact manifest path, then omits a deterministic tail with a bounded notice. It is the empty
string when nothing is listable (`renderSkillCatalog` in
`packages/skills/src/catalog/index.ts`). Test: `packages/skills/tests/component/catalog.test.ts`.
When the catalog renders
empty the trailing instruction goes with it and only the bootstrap heads remain
(`renderSkillsSection` in `packages/skills/src/tool.ts`; pinned by "still renders bootstrap bodies
when the catalog is empty" in `packages/skills/tests/integration/sidecar.test.ts`).

### 4.12 Skill-tool dispatch

Both operations first use `openCallEnvelope` with their own declared schema and the host-injected
validator. An invalid call is reported as a failed `tool_call`; it never records
`tool_call_started`, reads a provider or crosses the container bridge.

1. **Body operation:** `handleLoadSkillCall` accepts only `{name}`, starts the trace call, and invokes
   `loadSkill(name)`. A throw becomes `could not load skill '<name>'`; `undefined` becomes `unknown
   skill '<name>'. Available skills: …`; an empty body renders `(this skill has an empty body)`.
2. **Resource operation:** `handleReadSkillResourceCall` accepts exactly `{name, resource, offset}`
   and checks the skill against `listSkills()` before reading. A provider with
   `readResourceChunk` receives the explicit byte offset and at most 50 000 output characters.
   `validateResourceChunk` rejects a mismatched offset, a total over 8 MiB, too much text, a
   non-progressing or out-of-range continuation, or a cursor that does not exactly equal the UTF-8
   byte length returned. A provider without chunk support may serve offset zero through
   `readResource`; every positive offset is refused rather than reinterpreted as a character index.
   This operation never calls `loadSkill`. Production: `handleReadSkillResourceCall` and
   `validateResourceChunk` in `packages/skills/src/call.ts`. Test:
   `packages/skills/tests/unit/call.test.ts` and
   `packages/skills/tests/integration/call-resource.test.ts`.
3. A filesystem body result identifies `Skill directory: <dir>` as the base for bundled relative
   paths. It adds `Package execution root: <executionRoot>` and guarded-shell/native-sandbox guidance
   only when the host-approved field exists, then renders the body and resource listing. Production:
   `handleLoadSkillCall` in `packages/skills/src/call.ts`. Test:
   `packages/skills/tests/unit/call.test.ts` (`shows the guarded helper hint only for a host-approved
   execution root`).
   A host-embedded `source: "builtin"` result instead identifies instructions bundled in Clarvis,
   without advertising a filesystem directory. Test:
   `packages/kernel/tests/integration/builtin-skills.test.ts` (`the use_skills grant controls model access`).

The capability wrapper turns the result into `{ kind: "result", text, progress: !error }`
(`buildSkillsHandler` in `packages/skills/src/capability.ts`).

### 4.13 Plugin bootstrap resolution

`resolveBootstrapSkills` folds the declared refs in order, dropping each with a `warn` naming the
reason (`packages/skills/src/bootstrap.ts`):

| Gate | Reason |
| --- | --- |
| loader threw | `load_failed` (never rethrown) |
| skill not in the merged catalog | `not_found` |
| `content.root` (resolved) is none of `ref.roots` (resolved) | `foreign_root` |
| body blank after trim | `empty_body` |
| body > 20 000 chars | `too_long` — skipped, never truncated |
| running total + body > 40 000 chars | `over_run_budget`, and the loop **breaks** |

Admitted entries carry the skill's **own parsed name**, not the manifest string (pinned at
`packages/skills/tests/unit/bootstrap.test.ts`). More than one admitted bootstrap emits an extra
`bootstrap_skills_multiple` warning.

Because plugin roots are scanned at the lowest precedence (§4.2), a same-named user skill wins the
merge and the bootstrap is then refused as `foreign_root` — the source states this explicitly at
`packages/skills/src/bootstrap.ts`, and the test names it "the RP2.2 gate"
(`packages/skills/tests/unit/bootstrap.test.ts`).

### 4.14 Host wiring in the loop

`buildExecuteRunDeps` (`packages/loop/src/runtime/build-run-deps.ts`):

- `useSkills = builtins?.skills !== false`.
- With `useSkills && CLARVIS_SKILLS_ENABLED`, `@clarvis/skills` is loaded through a **dynamic**
  `import()` and `createAgentSkills` is built over the exact `skillRoots` when supplied, otherwise
  `[...extraRoots...clarvisSkillRoots()]`, with
  the package's prose warnings routed into the structured logger as
  `skills.discovery_warning`.
- A function-valued `skillRoots` or `extraSkillRoots` produces `dynamicSkills`, which re-reads the roots on every
  provider access, re-scans only when the roots' JSON signature changes, and falls back to the last
  good scan (or an empty provider that throws `"skills are unavailable"` on resource access) when a
  rescan throws.
- A `SkillRootSnapshotProvider` instead produces `snapshotSkills`: roots are consumed while
  dependencies are built, catalog bodies are materialized, resources are limited to the captured
  relative-path allow-list, and the host arms identity-file monitoring before verifying those bytes
  against its pin. Later calls only test the host's memory-only `available(skill)` predicate. A
  withdrawn skill disappears from the catalog, returns no body, and refuses resource reads without
  rebuilding the registry or rejecting a run. An optional idle trust-change subscription atomically
  replaces the complete captured provider; it is never consulted by run admission. Production:
  `SkillRootSnapshotProvider` and `snapshotSkills` in
  `packages/loop/src/runtime/build-run-deps.ts`. Test: exact root capture, observe-before-verify,
  withdrawal, and idle trust replacement in
  `packages/loop/tests/integration/execute-run-entrypoints.test.ts`.
- An initial scan failure logs `skills.discovery_failed` and leaves `skills` undefined rather than
  failing the deps.
- An optional host `composeSkills` callback runs once after discovery when both skill gates are
  enabled. It may supply product-embedded instructions even after a filesystem scan failure. The
  composed provider is used by both the capability and the host's listing/body service; it is not
  sent through filesystem snapshot verification. Snapshot disposal remains owned by the builder.
- The capability is registered whenever `useSkills`, even with an undefined provider, so the grant,
  the reserved wire name and the tool effect stay stable.

### 4.14a Shipped configuration guidance

The file kernel composes `clarvis-configure` from TypeScript data with the scanned provider.
It appears in a clean installation and in an empty custom Extension Profile without creating
`SKILL.md`, skill directories or resource files. It is user-invocable as a dedicated native skill run and
model-loadable only with the existing `use_skills` grant. Host or environment skill opt-out removes
it with the rest of the skill surface. The name is reserved: installed content cannot replace
these instructions, while other names retain their discovered provider and resource behavior.
Metadata and body results are detached from the shipped data to prevent caller mutation.

The guide covers configuration scope/precedence, agents and subagents, grants and capability gates,
models and credentials, Extension Profiles, plugins, skills, MCP, hooks, memory, plans, tasks,
workflows, runtime and diagnosis. `CONFIGURATION_EXAMPLES` in
[configuration-examples.ts](../../packages/kernel/src/skills/configuration-examples.ts) supplies the
verbatim filenames and bytes rendered in the guide. Settings and agent schemas, plugin/skill
discovery, Extension Profile resolution/selection and workflow loading/execution validate these
examples in [configuration-guidance.test.ts](../../packages/kernel/tests/integration/configuration-guidance.test.ts).
The on-demand body has a 32,768-character regression ceiling; the initial catalog still discloses
only metadata. Loading instructions is informational and grants no write or credential access.
Its builtin `agent` metadata selects the host's dedicated configuration route; ordinary `load_skill`
does not switch placement. The live-session elicitation and native file tools are owned by
[self-configuration.md](../hosts/self-configuration.md).

Production: `withBuiltinSkills` in
[`packages/kernel/src/skills/builtin-skills.ts`](../../packages/kernel/src/skills/builtin-skills.ts),
`CLARVIS_CONFIGURE_SKILL` in
[`packages/kernel/src/skills/clarvis-configure.ts`](../../packages/kernel/src/skills/clarvis-configure.ts),
and `createFileKernel` in [`packages/kernel/src/file-kernel.ts`](../../packages/kernel/src/file-kernel.ts).
Test: [`packages/kernel/tests/component/builtin-skills.test.ts`](../../packages/kernel/tests/component/builtin-skills.test.ts)
and [`packages/kernel/tests/integration/builtin-skills.test.ts`](../../packages/kernel/tests/integration/builtin-skills.test.ts)
cover reserved identity, detached data, external provider preservation, valid examples, empty
installation/profile behavior, opt-out, grant gating and actual on-demand tool disclosure.
[`packages/skills/tests/component/catalog.test.ts`](../../packages/skills/tests/component/catalog.test.ts)
keeps builtin guidance discoverable within the catalog's size bound.

### 4.15 Kernel adaptation

`createSkillsService` (`packages/kernel/src/skills/skills-service.ts`):

- `list()` filters on `userInvocable` **alone**; catalog suppression is deliberately not consulted
  (pinned at `packages/kernel/tests/component/skills-service.test.ts`).
- `SkillsServiceConfig` (`packages/kernel/src/skills/skills-service.ts`) takes, beside the
  `skills` provider, an optional `skillPlansMode(skill)` callback returning a trusted, per-skill
  `PlansMode` override; `list()` calls it for every skill to populate
  `SkillSummary.plansMode`. What the callback itself resolves — settings/plugin plumbing — belongs
  to the workflows/plans documents, not here.
- Each summary carries exactly one optional `task` argument, described by the skill's
  `argument-hint` when it is a non-blank string (`packages/kernel/src/skills/render-skill-prompt.ts`).
- `provenance` is emitted only when `scope` is one of the two known values, and carries `source` when
  non-empty and `metadata.author` when the producing tool wrote one (`packages/kernel/src/skills/render-skill-prompt.ts`). The two probes read different shapes of
  the same loose `metadata` object: `skillAuthor` reads the **nested** `metadata.author` bucket
  (`packages/kernel/src/skills/render-skill-prompt.ts`) while `skillEntryAgent`, below, reads the **top-level**
  `agent` field (`packages/kernel/src/skills/render-skill-prompt.ts`) — the two are asymmetric, not two views of one
  lookup.
- `presentation` is **re-read field by field** from whatever the provider supplied rather than
  forwarded, and an icon path that is absolute, drive-qualified or contains `..` after backslash
  normalization is dropped (`packages/kernel/src/skills/render-skill-prompt.ts`; pinned at `packages/kernel/tests/component/skills-service.test.ts`).
- `getPrompt(name, args)` throws kernel `not_found` for an unknown or non-invocable skill and
  otherwise returns one `user` message from `renderSkillPrompt`.

`renderSkillPrompt` (`packages/kernel/src/skills/render-skill-prompt.ts`):

| Body contains a placeholder (`$ARGUMENTS` or `{{args}}`)? | Rendering |
| --- | --- |
| yes | every occurrence replaced in **one** pass with a replacer *function*; no `Target:` block; an absent task substitutes as `""` |
| no | body verbatim, then `Target:` and the task, or `(no explicit target — apply the skill to the current conversation.)` |

The single-pass replacer function exists because a string replacement would expand `$$`, `$&`,
`` $` `` and `$'` inside the caller's task; pinned at
`packages/kernel/tests/component/skills-service.test.ts`.

`skillEntryAgent` reads the top-level `agent` field and decides whether a `/name` invocation becomes
its own run or is injected into the current turn. It **does not govern the
model-facing `load_skill` tool**, which serves a skill's body into whichever run/agent called it and
never consults this field at all — "a skill naming an agent therefore runs on it when a user types
`/name`, and in the caller's own turn when an agent loads it mid-run"
(`packages/kernel/src/skills/render-skill-prompt.ts`). The run-request side of that decision
is `resolveSkillRun` in `packages/kernel/src/runs/settings-assembler.ts`; skill-driven agent
routing itself belongs to [`specs/capabilities/workflows-service.md`](../capabilities/workflows-service.md).

The one `SkillsProvider` the host builds is threaded three ways by `createInProcessKernel`: into
`createSettingsRunAssembler`'s `skills` option (`packages/kernel/src/kernel.ts`, for
`resolveSkillRun` above), into `createSkillsService` (this section), and into
`createAgentWorkflowPolicy` (delegated). The same construction also derives
`KernelCapabilities.skills` from whether a provider was actually wired —
`skills: opts.skillsProvider !== undefined` (`packages/kernel/src/kernel.ts`) — rather than
leaving it at `DEFAULT_KERNEL_CAPABILITIES.skills`'s static `false`.

Container placement reuses that same host-admitted provider snapshot rather than mounting any host
skill root. `createRuntimeSkillCatalog` projects only safe catalog fields;
`createHostSkillsGrant` serves admitted bodies and bounded resources through `runtime.skills`; and
`createRuntimeSkillBootstraps` resolves only the active plugins' declarations through
`resolveBootstrapSkills`, then serializes `{ plugin, skill, body }` without roots. The guest
`createGuestSkillsCapability` renders those bootstrap bodies before the sanitized catalog and
proxies the same two closed operations. The host bridge accepts exactly `{operation: "load", name}`
or `{operation: "resource", name, resource, offset}`; it rejects missing or additional fields before
provider access, and a body call can never be reinterpreted from a path alias. Production:
`createHostSkillsGrant` and `createGuestSkillsCapability` in
`packages/kernel/src/runtime/skills-bridge.ts`, and `createLocalContainerRuntime` in
`packages/kernel/src/runtime/local-podman-runtime.ts`. Test:
`packages/kernel/tests/unit/runtime-skills-bridge.test.ts` (path-free catalog, active bootstrap and
exact request refusal) and
`packages/kernel/tests/integration/local-podman-runtime.test.ts` (bootstrap reaches the guest
prompt without a mount).

---

## 5. Invariants

The invariants below are derived directly from this document's own source and tests. Numbers are local
to this document.

1. **A directory holding a `SKILL.md` is a skill and its subtree is never re-scanned.**
   `packages/skills/src/scan.ts`. Pinned:
   `packages/skills/tests/integration/scan.test.ts`.
2. **Grouping directories are descended through, bounded by depth and by probe count.**
   `packages/skills/src/scan.ts`. Pinned:
   `packages/skills/tests/integration/scan.test.ts`.
3. **`SKILL.md` is matched case-insensitively.** `packages/skills/src/scan.ts`. Pinned:
   `packages/skills/tests/integration/scan.test.ts`.
4. **Cross-root precedence is last-root-wins, and the loser chain is retained in full on the
   winner.** `packages/skills/src/registry.ts`. Pinned:
   `packages/skills/tests/integration/discovery.test.ts` (four roots, three shadowed origins in
   descending precedence) (two arbitrary roots, last-root-wins).
5. **Intra-root duplicates are first-seen-wins (directory-sort order) and are resolved before any
   cross-root merge.** `packages/skills/src/registry.ts`. Pinned:
   `packages/skills/tests/integration/malformed.test.ts`.
6. **`strict` converts every non-fatal discovery outcome into a throw**: parse failure, intra-root
   duplicate, per-root manifest overflow, catalog overflow.
   `packages/skills/src/registry.ts`. Pinned:
   `packages/skills/tests/integration/malformed.test.ts`,
   `packages/skills/tests/integration/bounds.test.ts`.
7. **A malformed sidecar never removes the skill that carries it, not even under `strict`.**
   `packages/skills/src/sidecar.ts` (nothing throws). Pinned:
   `packages/skills/tests/integration/sidecar.test.ts`.
8. **No purely presentational frontmatter field can delete a skill** — `version`, `license` and
   `argument-hint` carry `.catch(undefined)`, as `agent` does.
   `packages/skills/src/schema.ts`. Pinned:
   `packages/skills/tests/unit/schema.test.ts`.
9. **`allowed-tools`/`tools` deliberately do *not* degrade**, because degrading a restriction widens
   what the skill may do. `packages/skills/src/schema.ts`. Pinned:
   `packages/skills/tests/unit/schema.test.ts`.
10. **A missing or unusable `name`/`description` is supplied, not fatal, and the substitution is
    recorded on `SkillInfo.defaulted`.** `packages/skills/src/parse.ts`,
    `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts`.
11. **The supplied description is never invented from the directory name**; it is the sidecar's short
    description or the fixed placeholder `"(no description supplied)"`.
    `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts`.
12. **A frontmatter `name` that disagrees with the directory name is warned about, never corrected**,
    and the warning is suppressed when Clarvis supplied the name itself.
    `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/malformed.test.ts`,
    `packages/skills/tests/integration/sidecar.test.ts`.
13. **Bodies are not retained at discovery; the first `get()` reads the file, and later `get()`s
    serve the memoized text.** `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts`.
14. **A manifest whose `name` changed after cataloguing is refused rather than paired with a stale
    identity.** `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts`,
    `packages/skills/tests/integration/diagnostics.test.ts`.
15. **The harness-config directory (`agents/`) is withheld from resource enumeration and from
    resource resolution, checked both lexically and after `realpath`, and a request for it is
    reported `not_found` rather than a more specific code.**
    `packages/skills/src/scan.ts`, `packages/skills/src/scan.ts`,
    `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts`.
16. **Nothing from a sidecar reaches a model-facing surface, with one recorded exception**: a
    borrowed short description used as a defaulted `description`.
    `packages/skills/src/registry.ts`, `packages/skills/src/types.ts`. Pinned:
    `packages/skills/tests/integration/sidecar.test.ts` (a fixed list of sidecar-only
    strings must not appear in the catalog, the section, or a `load_skill` result).
17. **`catalogSuppressed` and `userInvocable` are independent axes.** Suppression is applied in
    exactly one place — `renderSkillCatalog` (`packages/skills/src/catalog/index.ts`) — and
    `userInvocable` is applied in exactly one other — `SkillsService.list`
    (`packages/kernel/src/skills/skills-service.ts`). Pinned:
    `packages/skills/tests/component/catalog.test.ts`,
    `packages/skills/tests/integration/sidecar.test.ts`,
    `packages/kernel/tests/component/skills-service.test.ts`.
18. **A suppressed skill stays in the registry and stays loadable by name.**
    `packages/skills/src/capability.ts` (the tool is not withheld with the section).
    Pinned: `packages/skills/tests/integration/sidecar.test.ts`.
18a. **A skill's declared MCP dependencies are non-authoritative catalog requirements, not grants.**
    They never add a server or tool; the per-run catalog only removes a skill whose declared server
    is absent, while the protocol retains the metadata for diagnosis. Production:
    `readToolDependencies` in `packages/skills/src/sidecar.ts`, `dependenciesAvailable` in
    `packages/skills/src/capability.ts`, and `SkillsService.list` in
    `packages/kernel/src/skills/skills-service.ts`. Test:
    `packages/skills/tests/integration/sidecar.test.ts` and
    `packages/kernel/tests/component/skills-service.test.ts`.
19. **Every resource path is confined to the skill directory, symlink-aware, with a `..`-tolerant
    canonicalization for not-yet-existing tails.** `packages/skills/src/paths.ts`. Pinned: `packages/skills/tests/integration/paths.test.ts`.
20. **The containment check compares against `dirReal + path.sep`, so a sibling whose name is a
    prefix of the skill directory does not pass.** `packages/skills/src/paths.ts`. Pinned:
    `packages/skills/tests/integration/paths.test.ts`.
21. **A symlink whose target cannot be `realpath`ed for any reason other than absence counts as
    escaping.** `packages/skills/src/scan.ts`. Pinned:
    `packages/skills/tests/integration/scan.test.ts`.
22. **Resource traversal terminates on cycles**, keyed by real path.
    `packages/skills/src/scan.ts`. Pinned:
    `packages/skills/tests/integration/symlink.test.ts`.
23. **Every file read is bounded on the opened descriptor.** Complete text/byte reads are bounded by
    complete size before allocation. `readBoundedTextChunk` admits at most 8 MiB per file but
    allocates and decodes at most 256 KiB per page, treats its cursor as bytes, and never emits half
    of a UTF-8 sequence or surrogate pair. `hashBoundedFile` streams raw bytes through a fixed buffer
    rather than allocating or decoding the complete resource. Short reads, growth, invalid UTF-8 and
    invalid cursors fail closed. Production: `readBoundedText`, `readBoundedBytes`,
    `readBoundedTextChunk`, `hashBoundedFile`, and `readFromFile` in
    `packages/skills/src/bounded-read.ts`. Test: `packages/skills/tests/integration/bounds.test.ts`
    (`reads a large text resource incrementally while the legacy whole read stays bounded`) and
    `packages/skills/tests/unit/bounded-read.test.ts` (UTF-8 cursor/boundary, growth, short-read and
    binary-hash cases).
24. **A directory with more entries than `MAX_SKILL_DIRECTORY_ENTRIES` contributes nothing at all**,
    rather than a truncated listing. `packages/skills/src/scan.ts`. Pinned:
    `packages/skills/tests/integration/bounds.test.ts`.
25. **`resolveConfig` refuses more than `MAX_SKILL_ROOTS` roots before any root-scanning
    filesystem work — but not before all of it.** When an explicit `workspace` option is
    given, `validateDir`'s `statSync` (`packages/skills/src/config.ts`) runs
    first and can itself throw `StartupError`; only then are the empty-roots check
    and the `MAX_SKILL_ROOTS` ceiling reached. The ordering is: workspace
    validation (if `workspace` was supplied), then the roots-count check, then per-root
    scanning. `packages/skills/src/config.ts`. Pinned:
    `packages/skills/tests/unit/config.test.ts`,
    `packages/skills/tests/integration/bounds.test.ts` (the latter passes a real, existing
    workspace via `makeWorkspace()`, so it demonstrates the ceiling is checked before
    root-scanning I/O, not before the workspace stat).
26. **The strict YAML repair runs only after a strict parse has already failed, and gives up unless
    every line is a flat `key: value`.** `packages/skills/src/parse.ts`.
    Pinned: `packages/skills/tests/unit/parse.test.ts`.
27. **The skills capability is inert without both the env flag and a provider**, and registration is
    unconditional so grant/reservation/effect metadata never changes.
    `packages/skills/src/capability.ts`, `packages/loop/src/runtime/build-run-deps.ts`.
    Pinned: `packages/skills/tests/component/capability.test.ts`,
    `packages/loop/tests/integration/skills-grant-gating.test.ts`.
28. **Neither the catalog section nor either skill tool reaches an agent without the
    `use_skills` grant, and an ungranted agent triggers no scan at all.**
    Production: `createSkillsRunCapability` in `packages/skills/src/capability.ts`. Test:
    `packages/skills/tests/component/capability.test.ts` and
    `packages/loop/tests/integration/skills-grant-gating.test.ts`.
29. **An empty catalog yields neither the section nor the skill tools**, even with the grant.
    Production: `catalogFor` and `createSkillsRunCapability` in
    `packages/skills/src/capability.ts`. Test: "suppresses both prompt section and tool when the
    catalog is empty" in `packages/skills/tests/component/capability.test.ts` and the empty-catalog
    case in `packages/loop/tests/integration/skills-grant-gating.test.ts`.
30. **The catalog is scanned once per run and the same listing serves the entry agent and every
    spawned sub-agent.** Production: `listOnce` in `packages/skills/src/capability.ts`. Test:
    `packages/skills/tests/component/capability.test.ts` (`second === first`, one `bootstraps()`
    call).
31. **Both skill tools are contributed unadvertised**, i.e. `advertised: false` on their shared
    contribution. Production: `createSkillsRunCapability` in
    `packages/skills/src/capability.ts`. Test: "wires the unadvertised strict skill handlers" in
    `packages/skills/tests/component/capability.test.ts`.
32. **Each skill operation validates against its own declared closed schema and refuses to run when
    the host wires no validator.** Production: `handleLoadSkillCall` and
    `handleReadSkillResourceCall` in `packages/skills/src/call.ts`. Test:
    `packages/skills/tests/unit/call.test.ts` and `packages/skills/tests/unit/tool.test.ts`.
33. **`load_skill` accepts only `{name}`; every `resource`, `offset`, alias, sentinel or unknown
    field is rejected before body/provider access.** Production: `loadSkillTool` and
    `handleLoadSkillCall`. Test: "rejects every resource-shaped argument on the name-only load
    operation" in `packages/skills/tests/unit/call.test.ts`.
34. **A resource request for an unknown skill is rejected before any read.**
    Production: `handleReadSkillResourceCall` in `packages/skills/src/call.ts`. Test: "rejects a
    resource lookup before reading when the skill is unknown" in
    `packages/skills/tests/unit/call.test.ts`.
35. **`read_skill_resource` never calls `loadSkill`** — resource disclosure is a separate tool and
    code path, not a body-load variant. Production: `handleReadSkillResourceCall` in
    `packages/skills/src/call.ts`. Test: "reads a resource without loading or retaining the skill
    body" in `packages/skills/tests/integration/call-resource.test.ts`.
36. **A skill-tool failure is a non-progressing result, never a throw.** Production:
    `buildSkillsHandler` in `packages/skills/src/capability.ts`. Test: "maps a handler failure to a
    non-progressing result" in `packages/skills/tests/component/capability.test.ts`.
37. **A bootstrap is admitted only when the resolved skill's `root` matches one of the declaring
    plugin's own declared roots.** `packages/skills/src/bootstrap.ts`. Pinned:
    `packages/skills/tests/unit/bootstrap.test.ts`.
38. **An oversized bootstrap body is skipped, never truncated**, and the run-wide budget stops
    admission at the first entry that would exceed it.
    `packages/skills/src/bootstrap.ts`. Pinned:
    `packages/skills/tests/unit/bootstrap.test.ts`.
39. **`resolveBootstrapSkills` never throws**, including when the loader throws.
    `packages/skills/src/bootstrap.ts`. Pinned:
    `packages/skills/tests/unit/bootstrap.test.ts`.
40. **A host `bootstraps()` port that throws degrades the run to a plain catalog.**
    `packages/skills/src/capability.ts`. Pinned:
    `packages/skills/tests/component/capability.test.ts`.
41. **Bootstrap bodies are rendered before the catalog**, and with no bootstraps the section is
    byte-identical to the catalog form. `packages/skills/src/tool.ts`. Pinned:
    `packages/skills/tests/unit/tool.test.ts`.
42. **`renderSkillCatalog` does not mutate its input.** It sorts a filtered copy
    (`packages/skills/src/catalog/index.ts`). Pinned:
    `packages/skills/tests/component/catalog.test.ts`.
43. **Argument-placeholder substitution happens in a single pass with a replacer function**, so a
    task containing `$$`/`$&`/`` $` ``/`$'` or the other placeholder is inserted verbatim.
    `packages/kernel/src/skills/render-skill-prompt.ts`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts`.
44. **A missing task substitutes as the empty string on the placeholder path, and as the fallback
    sentence only on the no-placeholder path.**
    `packages/kernel/src/skills/render-skill-prompt.ts`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts`.
45. **`getPrompt` rejects an unknown or non-user-invocable skill with kernel `not_found`.**
    `packages/kernel/src/skills/skills-service.ts`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts`.
46. **`skillEntryAgent` reads only the *top-level* `agent` field**, not the nested `metadata` bucket.
    `packages/kernel/src/skills/render-skill-prompt.ts`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts` (a nested `metadata.agent` yields
    `undefined`).
47. **The kernel re-validates provider-supplied icon paths rather than trusting the DTO.**
    `packages/kernel/src/skills/render-skill-prompt.ts`. Pinned:
    `packages/kernel/tests/component/skills-service.test.ts`.
48. **No diagnostic record carries a skill's content**: `skill.field_defaulted` logs a character
    count, `skill.body_disclosed` logs sizes.
    `packages/skills/src/registry.ts`. Pinned:
    `packages/skills/tests/integration/diagnostics.test.ts`.
49. **Repeating diagnostic sites are guarded by `levelEnabled` before the bindings object is
    allocated.** `packages/skills/src/scan.ts`, `packages/skills/src/registry.ts`. *Unpinned* — no test asserts the guard itself.
50. **The engine reaches `@clarvis/skills` only through a dynamic `import()`** (INV-076/INV-080) —
    full statement owned by
    [engine/capability-composition.md](../engine/capability-composition.md) §5.
51. **An exact root allow-list admits only resolved manifest names in `include`; an empty list scans
    nothing and an absent list preserves full discovery** (INV-320). Production:
    `normalizeInclude` in `packages/skills/src/config.ts` and `scanRoot` in
    `packages/skills/src/registry.ts`. Test: `packages/skills/tests/unit/config.test.ts` and
    `packages/skills/tests/integration/discovery.test.ts`. Extension Profile qualification and root
    selection remain kernel policy, specified in [`hosts/extension-profiles.md`](../hosts/extension-profiles.md).
52. **Agent Plugins v1 roots enforce the complete portable Agent Skills frontmatter subset without
    changing native-reader tolerance.** Production: `assertRootValidation` and
    `buildResolvedSkill` in `packages/skills/src/registry.ts`; raw authored values are preserved by
    `parseSkillFrontmatterWithDefaults` and `parseSkillWithDefaults` in
    `packages/skills/src/parse.ts`. Test: `packages/skills/tests/integration/discovery.test.ts`
    ("applies Agent Skills identity validation only to roots that request it").
53. **Container placement discloses skill content, never host roots, and resolves bootstrap bodies
    only from active plugin declarations against the admitted provider snapshot.** The guest and
    host both enforce the exact body/resource operation split; neither accepts body aliases or
    operation-specific extra fields.
    Production: `createRuntimeSkillCatalog`, `createRuntimeSkillBootstraps`,
    `createHostSkillsGrant` and `createGuestSkillsCapability` in
    `packages/kernel/src/runtime/skills-bridge.ts`; `loadSkillTool` and `readSkillResourceTool` in
    `packages/skills/src/tool.ts`. Test:
    `packages/kernel/tests/unit/runtime-skills-bridge.test.ts` and
    `packages/kernel/tests/integration/runtime-guest-loop.test.ts` (the invalid `/dev/null`-style
    body payload never crosses to host capability authority).

---

## 6. Failure modes and degradation

### 6.1 Error types

| Type | Where raised | Codes |
| --- | --- | --- |
| `StartupError` | `resolveConfig` only | no roots; too many roots; workspace missing / not a directory (`packages/skills/src/config.ts`) |
| `SkillError` | everywhere else | `invalid_skill`, `duplicate_skill`, `not_found`, `not_a_file`, `path_escape`, `invalid_input`, `io_error` (`packages/skills/src/errors.ts`) |
| kernel `not_found` | `SkillsService.getPrompt`, `resolveSkillRun` | `packages/kernel/src/skills/skills-service.ts`, `packages/kernel/src/runs/settings-assembler.ts` |

`fsError` maps `ENOENT → not_found`, `EISDIR`/`ENOTDIR → not_a_file`, everything else → `io_error`
with the original errno in the message (`packages/skills/src/errors.ts`; pinned at
`packages/skills/tests/unit/errors.test.ts`).

### 6.2 What degrades vs. what fails

| Situation | Non-strict outcome | Strict outcome |
| --- | --- | --- |
| root does not exist / unreadable | empty listing + `skill.dir_unreadable` debug (`packages/skills/src/scan.ts`) | same — this one is never fatal |
| directory over the entry cap | that directory drops whole, warn (`packages/skills/src/scan.ts`) | same |
| manifest parse failure | warn `skipping <file>: <cause>`, `skill.rejected` reason `parse`, skill omitted (`packages/skills/src/registry.ts`) | rethrow |
| intra-root duplicate | warn, later one dropped (`packages/skills/src/registry.ts`) | `duplicate_skill` throw |
| >256 manifests in one root | warn, first 256 by directory order (`packages/skills/src/registry.ts`) | `invalid_skill` throw |
| >512 distinct skills | warn once, largest-name eviction (`packages/skills/src/registry.ts`) | `invalid_skill` throw |
| dangling symlink (dir, manifest or resource) | warn "skipping dangling symlink", `skill.resource_skipped` `dangling` (`packages/skills/src/scan.ts`) | same |
| escaping resource symlink | warn "escaping skill dir", entry omitted (`packages/skills/src/scan.ts`) | same |
| escaping sidecar symlink | warn "skipping skill sidecar escaping skill dir", no sidecar (`packages/skills/src/scan.ts`) | same |
| unreadable / unparseable / non-mapping sidecar | warn + `skill.sidecar_invalid` (`unreadable` / `unparseable` / `not_a_mapping`), skill loads without presentation and without suppression (`packages/skills/src/sidecar.ts`) | same |
| non-YAML file in `agents/` | ignored silently (extension filter, `packages/skills/src/scan.ts`) | same |
| body over the char cap | `get()` throws `invalid_skill` at disclosure time, catalog entry survives (`packages/skills/tests/integration/bounds.test.ts`) | same |
| oversized resource | `readResource` throws with `fields.dimension` = `bytes`/`characters` (`packages/skills/src/bounded-read.ts`) | same |
| chunked resource exceeds 8 MiB, cursor is not a UTF-8 byte boundary, or file changes while read | `readResourceChunk` throws `invalid_input`; no partial page is returned (`readBoundedTextChunk` in `packages/skills/src/bounded-read.ts`) | same |
| chunk provider reports an invalid size/offset/continuation | `read_skill_resource` returns a failed tool result (`validateResourceChunk` in `packages/skills/src/call.ts`) | same |
| legacy provider receives `offset > 0` | `read_skill_resource` refuses continuation; it never slices decoded text using the byte cursor (`handleReadSkillResourceCall` in `packages/skills/src/call.ts`) | same |
| descriptor fails to close | `skill.handle_close_failed` debug, read result unaffected (`packages/skills/src/lib/log.ts`) | same |
| `realpath` fails during containment | falls back to lexical compare and warns `skill.path_unresolved` at **warn** level, because a lexical check cannot see through a symlink (`packages/skills/src/paths.ts`) | same |

### 6.3 Discovery summary event

Every `buildRegistry` pass ends by emitting one aggregate record — the only always-emitted
diagnostic for a whole discovery pass — at `info`, guarded by `levelEnabled(config.logger,
"info")`: `skills.discovered` with fields `roots`, `skills` (final catalog size), `shadowed`
(sum of each surviving skill's shadow-chain length), `defaulted` (skills carrying at least one
supplied field), `dropped` and `ms` (`packages/skills/src/registry.ts`). Its message —
"skill discovery finished; this catalog is what every agent in the run is offered" — is the one
line that names the whole pass's outcome.

### 6.4 Capability- and host-level degradation

| Situation | Outcome | Source |
| --- | --- | --- |
| `CLARVIS_SKILLS_ENABLED` false, or no provider | capability `forRun` returns `null`; the run has no section and no tool | `packages/skills/src/capability.ts` |
| `builtins.skills = false` | package never loaded; `reportBuiltinDisabled` debug record | `packages/loop/src/runtime/build-run-deps.ts` |
| initial `createAgentSkills` throws | `skills.discovery_failed` (`scope: "initial"`), deps built without skills | `packages/loop/src/runtime/build-run-deps.ts` |
| rescan throws (dynamic roots) | `skills.discovery_failed` (`scope: "rescan"`), last good scan served; if there was none, an empty provider whose resource methods throw `"skills are unavailable"` | `packages/loop/src/runtime/build-run-deps.ts` |
| root provider throws | last good scan (or empty provider) remains active; `skills.roots_unavailable` debug | `dynamicSkills` in `packages/loop/src/runtime/build-run-deps.ts` |
| a process-pinned skill is marked unavailable by its host | omitted from listings/body loads; resource reads fail as unavailable; no rescan or run rejection | `snapshotSkills` in `packages/loop/src/runtime/build-run-deps.ts` |
| a capture-window digest check marks one process-pinned skill unavailable | the same informational withdrawal applies; unrelated skills remain available and dependency construction succeeds | `verifySkillCatalog` in `packages/kernel/src/extension-profiles/extension-profile-manager.ts` and `snapshotSkills` in `packages/loop/src/runtime/build-run-deps.ts` |
| an idle trust-catalog replacement cannot be captured | exact catalog becomes unavailable and `skills.snapshot_recomposition_failed` is logged; no stale trust catalog remains and no run-admission scan occurs | `snapshotSkills` in `packages/loop/src/runtime/build-run-deps.ts` |
| `bootstraps()` throws | `bootstrap_skills_unavailable` warn, run degrades to the plain catalog | `packages/skills/src/capability.ts` |
| plugin panel cannot read a plugin's skills | `skillNamesOf` returns `{ names: [], notes: [] }` on any throw; per-skill rejection notes are capped and summarized | `packages/kernel/src/plugins/plugin-service.ts` |

### 6.5 Retries and timeouts

There are none inside `@clarvis/skills`. Its operations are synchronous filesystem work; `refresh()`
is the only package-owned re-read and it is caller-driven (`packages/skills/src/index.ts`).
`dynamicSkills`'s signature memo is a cache, not a retry. The kernel's process-pinned adapter is a
host concern: it materializes bodies once and uses asynchronous stat monitoring outside this package
to drive the adapter's memory-only availability predicate.

### 6.6 Silently tolerated

- A non-YAML file in `agents/` (§6.2).
- A presentation value that is over its cap is **discarded, not truncated**, so a field can never
  become a prefix of what its author wrote (`packages/skills/src/sidecar.ts`).
- A colour in a notation other than 3-/6-digit hex is dropped with no record
  (`packages/skills/src/sidecar.ts`).
- An icon path that is absolute, drive-qualified, backslash-separated or contains `..` is dropped
  with no record (`packages/skills/src/sidecar.ts`).
- `metadataShortDescription` silently ignores a bucket that is not an object, a value that is not a
  string, and one over 512 chars (`packages/skills/src/registry.ts`).

---

## 7. Coupling

### 7.1 What `@clarvis/skills` depends on

| Dependency | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/capability` | runtime (value) | `splitFrontmatterFence` (`packages/skills/src/parse.ts`), `levelEnabled`/`NOOP_LOGGER` (`packages/skills/src/scan.ts`, `packages/skills/src/lib/log.ts`), `openCallEnvelope`/`handlerBaseOf` (`packages/skills/src/call.ts`, `packages/skills/src/capability.ts`) |
| `@clarvis/paths` | runtime (value) | `resolveAgainst`/`resolveWorkspaceDir` (`packages/skills/src/config.ts`), `agentsSkillsDirs`/`globalPaths`/`workspacePaths` (`packages/skills/src/preset.ts`) — this package spells no `.clarvis`/`.agents` literal itself |
| `yaml` | runtime | frontmatter and sidecar parsing (`packages/skills/src/parse.ts`, `packages/skills/src/sidecar.ts`) |
| `zod` | runtime | `skillFrontmatterSchema` (`packages/skills/src/schema.ts`) |
| Node builtins | runtime | `node:fs`, `node:path`, `node:os` |

Declared at `packages/skills/package.json`. There is **no** dependency on `@clarvis/loop`,
`@clarvis/kernel` or `@clarvis/protocol`; the capability is written against the contract package
alone.

### 7.2 What depends on `@clarvis/skills`

| Consumer | Edge | Static or dynamic |
| --- | --- | --- |
| `@clarvis/loop` | `import type { AgentSkills, SkillRootInput }`, `import type { SkillsProvider }` (`packages/loop/src/runtime/build-run-deps.ts`); `export type` re-exports (`packages/loop/src/lib.ts`); `export type { PluginBootstrapSkill }` (`packages/loop/src/runtime/capabilities/skills-settings.ts`) | **type-only** — erased |
| `@clarvis/loop` | `import("@clarvis/skills")` and `import("@clarvis/skills/capability")` inside `buildExecuteRunDeps` | **dynamic** value import, deliberately |
| `@clarvis/kernel` | `createAgentSkills` for the plugin panel's skill listing (`packages/kernel/src/plugins/plugin-service.ts`) | static value |
| `@clarvis/kernel` | `MAX_SKILL_ROOTS`, `enumerateResources`, `hashBoundedFile`, and the public per-file/aggregate resource limits to bound and fingerprint plugin and Extension Profile skill surfaces (`packages/kernel/src/plugins/plugin-contributions.ts`, `packages/kernel/src/extension-profiles/extension-profile-manager.ts`) | static value |
| `@clarvis/kernel` | `SkillsProvider` type via `@clarvis/loop` (`packages/kernel/src/skills/skills-service.ts`) | type-only |
| `@clarvis/kernel` | `composeSkills: withBuiltinSkills` adds product TypeScript data after host-selected filesystem discovery (`packages/kernel/src/file-kernel.ts`, `packages/kernel/src/skills/builtin-skills.ts`) | host callback; no engine-to-kernel dependency |
| `@clarvis/code` | reaches skills only through `KernelClient.skills` (`packages/code/src/adapters/kernel-run-client.ts`, `packages/code/src/adapters/kernel-capabilities-client.ts`) | protocol only |

The direction is forced two ways. The **type-only / dynamic split** is what keeps `builtins.skills =
false` meaningful: `skills-settings.ts` states that a *value* import there would make
`@clarvis/loop/host` statically require the optional package
(`packages/loop/src/runtime/capabilities/skills-settings.ts`), and the architecture test
enforcing it is `packages/loop/tests/architecture/optional-package-loading.test.ts`. The
**contract-only** dependency is what lets `packages/skills/tests/component/capability.test.ts` drive
`forRun`/`forAgent`/`attach` with fakes (`packages/skills/tests/helpers/capability-fakes.ts`) and
never boot an engine.

### 7.3 Name ownership

`LOAD_SKILL_TOOL_NAME` and `READ_SKILL_RESOURCE_TOOL_NAME` are owned only by this package; the
capability derives both reservations and `control` effects from `SKILLS_TOOLS` so the engine needs
neither name nor a mirror (`packages/skills/src/tool.ts`, `packages/skills/src/capability.ts`). The engine
does keep a duplicate of the capability *name* it cannot statically import, pinned against drift
by `packages/loop/tests/architecture/builtin-capability-names.test.ts` and owned by
[engine/capability-composition.md](../engine/capability-composition.md).

### 7.4 Deliberately separate look-alikes

`@clarvis/loop` has its own `normalizeTools` for **agent** frontmatter
(`packages/loop/src/settings/agent-frontmatter.ts`), exported through `packages/loop/src/host.ts` and used by
`packages/kernel/src/runs/settings-assembler.ts`. It is a different function from
`packages/skills/src/parse.ts`; only the fence splitter was actually shared
(`packages/capability/src/frontmatter-fence.ts`).

---

## 8. Open questions

1. **A block of module-level exports is reachable only from inside the package**, and nothing
   outside it — in `packages/*/src` or `packages/*/tests` — imports any of them:
   `parseSkill`, `readSkillSidecar`, `findSkillSidecar`, `resolveResourcePath`,
   `skillFrontmatterSchema`, `SkillError`/`fsError`, `StartupError`,
   `DEFAULT_STRICT`/`DEFAULT_FOLLOW_SYMLINKS` — the `StartupError` and `fsError` here being this
   package's, not the live `@clarvis/tools` symbols of the same names. None is re-exported from
   `packages/skills/src/index.ts`, so `@clarvis/skills` does not publish them; `HARNESS_CONFIG_DIR`
   (`packages/skills/src/scan.ts`) is not exported at module level either. `splitFrontmatter`
   (`packages/skills/src/parse.ts`) is in the same position and is exercised only by
   `packages/skills/tests/unit/parse.test.ts`. What the source does **not** say is whether the
   package-internal ones are meant to become public again or to be inlined at their single call
   sites.
2. **The per-root overflow counter under-reports.** `scanRoot` calls `listSkillDirs` with the fixed
   ceiling `MAX_SKILLS_PER_ROOT + 1` (`packages/skills/src/registry.ts`), so the scan stops at 257
   candidates. `stats.dropped += candidates.length - MAX_SKILLS_PER_ROOT`
   (`packages/skills/src/registry.ts`) therefore always adds exactly `1`, and the strict error's
   `actual` field is capped at 257, regardless of how many manifests the root really holds.
   Nothing states whether that is intended.
3. **Catalog-overflow eviction is only approximately "the first 512 by name".** The warning text says
   "retaining the first 512 by name" (`packages/skills/src/registry.ts`), but the algorithm
   evicts the currently largest name only when the arriving name sorts before it,
   which depends on arrival order across roots. The test asserts only that a small name is retained
   and a large one is not (`packages/skills/tests/integration/bounds.test.ts`).
4. **`defaultWarnSink` writes directly to `process.stderr`** (`packages/skills/src/lib/log.ts`)
   and is the default for every entry point that takes diagnostics
   (`packages/skills/src/lib/log.ts`). The loop supplies a per-instance logger-routing sink
   (`packages/loop/src/runtime/build-run-deps.ts`), while `packages/kernel/src/plugins/plugin-service.ts`
   supplies its own and `createAgentSkills` called without one falls back to stderr. Whether the
   stderr default is intended to remain reachable is not determinable.
5. **Why the first `.yaml`/`.yml` by sorted name wins when several harness sidecars exist is
   unstated.** The `agents` directory name itself is intentional interoperability vocabulary, as
   documented at `HARNESS_CONFIG_DIR` (`packages/skills/src/scan.ts`); only the
   multiple-file tie-break lacks a stated rationale.
6. **`SkillPresentation.starterPrompt` and `displayName` have no consumer in this document's scope** beyond
   the protocol DTO and the kernel projection; how (or whether) a UI renders them is a
   `@clarvis/code` question, not answered here.
7. **Delegated to sibling documents, deliberately not re-derived here:** the `.agents` precedence
   rule as an interop contract; plugin skill-root construction, the plugin budget and manifest
   parsing (`pluginSkillScanRoots` in `packages/kernel/src/plugins/plugin-manifest.ts`,
   `PLUGIN_SKILL_ROOT_BUDGET` and `skillRoots` in
   `packages/kernel/src/plugins/plugin-contributions.ts`); and skill-driven agent routing through
   `createAgentWorkflowPolicy.isManagerRun` and `resolveSkillRun`
   (`packages/kernel/src/runs/settings-assembler.ts`).
8. **Windows behaviour of this package is unverified by any job in this document's scope.** The scanner uses
   `node:path` throughout and normalizes to POSIX separators for `rel`
   (`packages/skills/src/scan.ts`), but `packages/skills/package.json` is not referenced by any
   Windows-scoped CI configuration in scope, and several tests use `symlinkSync` unconditionally
   (e.g. `packages/skills/tests/integration/symlink.test.ts`).
