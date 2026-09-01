# The `.agents` seam and foreign-dialect degradation

> Implemented at `packages/capability/src/hooks-config.ts`,
> `packages/kernel/src/plugins/hook-dialects.ts`, `packages/paths/src/{constants,workspace}.ts`,
> `packages/skills/src/{scan,preset,sidecar,paths,registry}.ts`, and the tests under
> `packages/kernel/tests/architecture/`,
> `packages/kernel/tests/integration/plugin-manifest.test.ts`,
> `packages/capability/tests/unit/hooks-config.test.ts` and
> `packages/skills/tests/integration/sidecar.test.ts`. Every claim below is anchored to a file and
> line. Open questions are collected in the final section.

## 1. Purpose

Clarvis is one host among several that read a directory of the same shape — an agent's skills, a
plugin's hooks document, a hook's tool-name filter — written for a wider ecosystem of agent runtimes.
Two problems fall out of that: **where** does Clarvis look for content it did not write itself, and
**what** does it do when a document it reads spells something in another host's vocabulary?

This subsystem is the answer to both, factored so the answer lives in exactly one place each time it
is needed. `@clarvis/paths` names the cross-runtime `.agents` directory
(`packages/paths/src/constants.ts`) and assigns ownership by component: standalone skills and
marketplaces are discovered inputs, while `plugins/` is a first-class install inventory beside its
`.clarvis` equivalent. `@clarvis/capability` owns two correspondence tables — hook event names
(`EXTERNAL_HOOK_EVENT_NAMES`) and hook filter tool names (`EXTERNAL_TOOL_NAMES` /
`EXTERNAL_TOOLS_WITHOUT_COUNTERPART`) — each with a single owner so the two directions (writing a
foreign-legible payload, reading a foreign-authored document) can never drift apart
(`packages/capability/src/hooks-config.ts:92-103`). `@clarvis/kernel`'s `hook-dialects.ts` uses those
tables to translate a plugin's hooks document, written in whatever ornament its host uses, into
ordinary `HookConfig` entries. `@clarvis/skills`'s sidecar reader tolerates the same kind of
ornamentation for a skill's own foreign-authored presentation metadata.

The thread that ties all of it together is a single design rule, stated in the production code itself:
an approximation that fires — or matches, or forwards — at the wrong moment is worse than an honest
gap the operator can see (`packages/capability/src/hooks-config.ts:101-103`,
`packages/capability/src/hooks-config.ts:137-140`). Every mechanism below chooses to drop, note, or
degrade rather than guess.

## 2. Surface

### 2.1 The `.agents` directory (`@clarvis/paths`)

| Symbol | File:line | What it is |
| --- | --- | --- |
| `AGENTS_DIR` | `packages/paths/src/constants.ts:18` | the literal `".agents"` — the only place the string exists |
| `AGENTS_PLUGINS_DIR` | `packages/paths/src/constants.ts:24` | `"plugins"`, the subdirectory a marketplace listing lives under inside `.agents` |
| `MARKETPLACE_FILE` | `packages/paths/src/constants.ts:27` | `"marketplace.json"` |
| `agentsSkillsDirs(opts)` | `packages/paths/src/workspace.ts:134` | `{ user, workspace }` — the two `.agents/skills` directories Clarvis reads |
| `agentsPluginsDir(root)` | `packages/paths/src/workspace.ts` | one `<root>/.agents/plugins` inventory |
| `agentsPluginsDirs(opts)` | `packages/paths/src/workspace.ts` | global and workspace `.agents/plugins` inventories |
| `agentsMarketplaceFile(root)` | `packages/paths/src/workspace.ts:153` | `<root>/.agents/plugins/marketplace.json` |
| `agentsMarketplaceFiles(opts)` | `packages/paths/src/workspace.ts:163` | the user- and workspace-scoped marketplace documents |
| `isAgentsMarketplaceFile(candidate)` | `packages/paths/src/workspace.ts:183` | recognizer paired with the builder above |

Ownership is component-specific. Clarvis does not mutate standalone `.agents/skills` or a
`marketplace.json`, but its managed global plugin lifecycle may atomically create, replace, or
remove one exact directory below `~/.agents/plugins`. Workspace `.agents/plugins` is discovered as
repository-owned inventory, exactly like workspace `.clarvis/plugins`; Code does not manage either
workspace tree. The architecture test admits direct mutation through
`agentsPluginsDir(s)` only in the filesystem plugin repository and keeps every other `.agents`
accessor read-only (`packages/paths/tests/architecture/agents-read-only.test.ts`).
An inventory entry may also link to a directory in a shared store; only the outer link is followed,
and contribution readers continue to realpath-confine every package-relative path. Production:
`directoryNames` in `packages/kernel/src/adapters/filesystem/plugin-repository.ts`. Test:
`packages/kernel/tests/integration/plugin-service.test.ts` ("discovers a plugin linked into the
shared .agents inventory").

`CONTEXT_FILENAMES` (`AGENTS.md` as the cross-runtime
fallback for Clarvis's own `CLARVIS.md`, `packages/paths/src/constants.ts:82`) is a related but
distinct cross-runtime naming convention — a root-level file, not a `.agents` subdirectory — and its
mechanics belong to the paths-directory-vocabulary document; it is noted here only to distinguish it from
the seam this document covers.

The "user's own content" framing is stated a fourth time, on the built-in ignore list `grep`/`glob`
apply: `INTERNAL_IGNORE_PATTERNS`'s doc comment says `AGENTS_DIR` "is deliberately absent: it is the
user's own content, and `grep`/`glob` are expected to see it" (`packages/paths/src/constants.ts:103-110`).
By contrast `INTERNAL_SKIP_DIRS`, the structural workspace-tree-walk skip list, never names `AGENTS_DIR`
either, but says nothing about why — it lists only `.git`, `node_modules`, `dist`, `CLARVIS_DIR`,
`.next`, `coverage` and `build` (`packages/paths/src/constants.ts:93-101`), and its own doc comment
distinguishes it from `INTERNAL_IGNORE_PATTERNS` only on the axis of which operation each list bounds,
not on `.agents` specifically.

### 2.2 The hook-dialect correspondence tables (`@clarvis/capability`)

All exported from `@clarvis/capability`'s root (`packages/capability/src/index.ts:71-92`):

| Symbol | File:line | Shape |
| --- | --- | --- |
| `EXTERNAL_HOOK_EVENT_NAMES` | `packages/capability/src/hooks-config.ts:104` | `Readonly<Record<string,string>>`, Clarvis event → foreign event, 11 entries |
| `EXTERNAL_TOOL_NAMES` | `packages/capability/src/hooks-config.ts:142` | `Readonly<Record<string,string>>`, normalized foreign tool name → Clarvis wire name, 16 entries |
| `EXTERNAL_HOOK_TOOL_NAMES` | `packages/capability/src/hooks-config.ts:162` | `Readonly<Record<string,string>>`, Clarvis built-in wire name → preferred external stdin spelling |
| `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` | `packages/capability/src/hooks-config.ts:185` | `ReadonlySet<string>`, 5 normalized foreign names with no Clarvis tool |
| `normalizeToolName(name)` | `packages/capability/src/hooks-config.ts:202` | `(string) => string` — strips everything but letters/digits, lower-cases |

`EXTERNAL_HOOK_EVENT_NAMES` (`packages/capability/src/hooks-config.ts:104-116`):

| Clarvis event | Foreign spelling |
| --- | --- |
| `pre_tool_use` | `PreToolUse` |
| `post_tool_use` | `PostToolUse` |
| `pre_compact` | `PreCompact` |
| `post_compact` | `PostCompact` |
| `session_start` | `SessionStart` |
| `run_end` | `SessionEnd` |
| `subagent_start` | `SubagentStart` |
| `subagent_complete` | `SubagentStop` |
| `pre_finalize` | `Stop` |
| `user_steer` | `UserPromptSubmit` |
| `user_prompt_expansion` | `UserPromptExpansion` |

`pre_delegate_task` (a `GATE_HOOK_EVENTS` member, `packages/capability/src/hooks-config.ts:31`) has no
row: it is a Clarvis-only gate with no foreign counterpart, so it is absent from the table on purpose
rather than mapped onto an approximation (`packages/capability/src/hooks-config.ts:101-102`).
`Notification`, a real foreign event, is likewise absent in the other direction
(`packages/kernel/src/plugins/hook-dialects.ts:48-50`).

`EXTERNAL_TOOL_NAMES` (`packages/capability/src/hooks-config.ts:142-174`), keyed by
`normalizeToolName`:

| Normalized foreign key | Clarvis tool |
| --- | --- |
| `bash`, `shell` | `shell` |
| `read`, `readfile` | `read_file` |
| `write`, `writefile` | `write_file` |
| `edit`, `editfile` | `edit_file` |
| `multiedit` | `multi_edit` |
| `applypatch` | `apply_patch` |
| `glob` | `glob` |
| `grep` | `grep` |
| `ls`, `listdir` | `list_dir` |
| `task` | `delegate_task` |
| `skill` | `load_skill` |

`EXTERNAL_HOOK_TOOL_NAMES` (`packages/capability/src/hooks-config.ts:162-174`) is the emission-side
counterpart. It spells built-ins in the vocabulary an externally authored hook reads on stdin; MCP
tools are derived from their stable dotted identity at runtime rather than listed in this finite map.

`EXTERNAL_TOOLS_WITHOUT_COUNTERPART` (`packages/capability/src/hooks-config.ts:185-191`): `exitplanmode`,
`todowrite`, `notebookedit`, `webfetch`, `websearch`.

### 2.3 The plugin hooks-document translator (`@clarvis/kernel`)

| Symbol | File:line | Signature |
| --- | --- | --- |
| `hooksDocumentSchema` | `packages/kernel/src/plugins/hook-dialects.ts:175` | Zod union: `{ hooks: EventMap } \| EventMap` |
| `convertHooksDocument(document, pluginRoot, options?)` | `packages/kernel/src/plugins/hook-dialects.ts:559` | `(HooksDocument, string, { pluginName?, pluginMcpServers? }?) => { hooks: HookConfig[]; notes: string[] }` |
| `HooksConversion` | `packages/kernel/src/plugins/hook-dialects.ts:184` | `{ hooks: HookConfig[]; notes: string[] }` |

Internal helpers with their own, independently useful contracts: `translateTimeout(seconds, event)`
(`:94`), `translateToolName(part, options)` (`:418`), `translateMatcher(matcher, options)` (`:508`),
`substituteRoot(command, pluginRoot)` (`:270`), `normalizeEventName(name)` (`:66`).

### 2.4 Skill roots and the foreign sidecar (`@clarvis/skills`)

| Symbol | File:line | What it does |
| --- | --- | --- |
| `clarvisSkillRoots(opts)` | `packages/skills/src/preset.ts:32` | returns the 4 standard `SkillRootInput`s, lowest precedence first |
| `HARNESS_CONFIG_DIR` | `packages/skills/src/scan.ts:43` | `"agents"` — the harness-directed subdirectory *inside* one skill's own directory |
| `findSkillSidecar(dir, followSymlinks, diagnostics)` | `packages/skills/src/scan.ts:212` | locates the preferred `.yaml`/`.yml` file directly under `<skill>/agents/` |
| `resolveResourcePath(skillDir, rel, logger)` | `packages/skills/src/paths.ts:25` | canonicalizes a skill-relative resource request and throws `path_escape` if it falls outside `skillDir` |
| `isHarnessConfigPath(skillDir, rel, abs, diagnostics)` | `packages/skills/src/scan.ts:265` | true when a resource request lands in that subdirectory, lexically or via symlink |
| `readSkillSidecar(file, diagnostics)` | `packages/skills/src/sidecar.ts:320` | parses the sidecar into `SkillSidecar { presentation?, dependencies?, catalogSuppressed }` |

`HARNESS_CONFIG_DIR` is a different "agents" than `AGENTS_DIR` in §2.1: it is a per-skill subdirectory
holding harness-addressed configuration, not the cross-runtime root directory. Both happen to be
spelled `"agents"`, at different points in the tree.

`isHarnessConfigPath`'s "via symlink" case (its `abs` parameter) depends on `resolveResourcePath`
having already canonicalized the request: `resolveResourcePath` (`packages/skills/src/paths.ts:25-45`)
resolves both the skill directory and the (possibly not-yet-existing) target through `realpath`, via its
own helpers `canonicalize` (`packages/skills/src/paths.ts:59-70`) and `canonicalizeAllowingMissing`
(`packages/skills/src/paths.ts:85-96`, which walks up to the nearest existing ancestor for a target that
does not exist yet and re-appends the missing tail). The registry calls the two in sequence —
`resolveResourcePath` first, its result then passed as `isHarnessConfigPath`'s `abs`
(`packages/skills/src/registry.ts:568-569`) — so the symlink-aware half of the harness-directory check
in §2.4/§6 is only as strong as this canonicalization.

### 2.5 MCP server key tolerance in a plugin manifest (`@clarvis/loop` + `@clarvis/kernel`)

| Symbol | File:line | What it does |
| --- | --- | --- |
| `mcpServerSettingsSchema` | `packages/loop/src/settings/settings-schema.ts:334` | strict schema used for `settings.json`; rejects any key it does not recognize |
| `mcpServerPluginSchema` | `packages/loop/src/settings/settings-schema.ts:358-360` | the same entry validated, but without `.strict()` — for a plugin manifest only, never `settings.json` |
| `sanitizeMcpServers(document)` | `packages/kernel/src/plugins/plugin-manifest.ts:1061-1084` | applies `mcpServerPluginSchema` to each `mcpServers` entry individually, dropping only the unusable ones |

This is the same "foreign document, tolerant reading" pattern as §2.3's hooks translator, applied to a
different key of the same manifest; behavior is in §4.6.

## 3. Data and formats

### 3.1 The four skill roots, in ascending precedence

`clarvisSkillRoots` (`packages/skills/src/preset.ts:32-46`) builds exactly four roots, pairing two
sources (`agents` = `.agents/skills`, `clarvis` = `.clarvis/skills`) across two scopes (`user` = under
`home`, `workspace` = under the resolved workspace):

```
1. { path: <home>/.agents/skills,      scope: "user",      source: "agents" }   // lowest
2. { path: <workspace>/.agents/skills, scope: "workspace", source: "agents" }
3. { path: globalPaths(home).skillsDir,  scope: "user",      source: "clarvis" }
4. { path: workspacePaths(ws).skillsDir, scope: "workspace", source: "clarvis" } // highest
```

Pinned verbatim by `packages/skills/tests/unit/preset.test.ts:8-19`, which asserts this exact array for
`clarvisSkillRoots({ home: "/home/u", cwd: "/tmp", workspace: "/work" })`.

That preset is the complete input for `builtin:default`. A custom
[Extension Environment](../hosts/environments.md) still derives candidates from these same four
locations, but passes only selected roots with exact `include` name lists through the host-owned
`skillRoots` seam; roots with no selected skill are omitted. The skills package remains unaware of
Environment definitions and applies the same root order and collision rules to whatever exact set it
receives. Production: `packages/kernel/src/environments/environment-manager.ts` (`skillRoots`) and
`packages/loop/src/runtime/build-run-deps.ts` (`exactRoots`). Test:
`packages/kernel/tests/integration/environment-manager.test.ts` ("selects only exact standalone
skills and passes exact include filters to @clarvis/skills")
and `packages/skills/tests/integration/discovery.test.ts` ("admits only exact manifest names from a
root allowlist").

`SkillRootInput`/`SkillRoot` (`packages/skills/src/types.ts:21-41`) carry `scope: "user" | "workspace"`
and `source: string` (free-form — `"agents"`, `"clarvis"`, or a plugin/marketplace name) purely as
provenance tags. `scan.ts`'s traversal functions (`listSkillDirs`, `packages/skills/src/scan.ts:78-119`;
`findSkillFile`, `packages/skills/src/scan.ts:131-144`) take only a `root` path and are root-agnostic:
nothing in either function branches on whether a root's `source` is `"agents"` or `"clarvis"`. The
precedence is entirely a property of **which order the four roots are listed in and folded**, not of
any different scanning behavior applied to one kind of root.

### 3.2 A plugin's hooks document, as read by `hook-dialects.ts`

Two accepted shapes (`packages/kernel/src/plugins/hook-dialects.ts:175-178`):

```jsonc
// wrapped
{ "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit", "hooks": [ { "command": "..." } ] } ] } }
// bare event map (what a manifest embeds inline)
{ "PreToolUse": [ { "matcher": "Bash|Edit", "hooks": [ { "command": "..." } ] } ] }
```

One matcher group is either `{ matcher?: string, hooks: HookEntry[] }` or a bare `HookEntry`, read as a
group of one selecting everything (`packages/kernel/src/plugins/hook-dialects.ts:150-161`). One
`HookEntry` is a loose object with optional `type`, `command`, `commandWindows`, `timeout`, `async`,
`statusMessage`, `additionalContextLimit`, `server`, `tool`, and `input`. The fields needed by the
selected type are enforced during conversion, while unrecognized keys remain tolerated
(`packages/kernel/src/plugins/hook-dialects.ts:124-143`, `:614-667`).

The `.loose()` tolerance is not only at the entry level: the object form of a matcher group is itself
`.loose()` (`packages/kernel/src/plugins/hook-dialects.ts:156`), and so is the outer wrapping document —
`z.object({ hooks: hookEventMapSchema }).loose()` (`packages/kernel/src/plugins/hook-dialects.ts:171-174`)
— whose own doc comment gives the reason: "an envelope carrying its own metadata alongside — a format
version, say — is read rather than refused for a key that says nothing to us." All three levels
(document, matcher group, entry) apply the identical "tolerate a foreign key this host gives no meaning
to" rule.

`convertHooksDocument` output — a `HooksConversion` — pairs a `HookConfig[]` (Clarvis's own
`hookSchema` shape, `packages/capability/src/hooks-config.ts:457`) with a flat `notes: string[]`, one
line per hook/filter that did not translate cleanly
(`packages/kernel/src/plugins/hook-dialects.ts:183-189`).

Example, from `packages/kernel/tests/integration/plugin-manifest.test.ts:1066-1088`: the foreign
document

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|clear|compact",
        "hooks": [ { "type": "command", "command": "\"${SOME_HOST_PLUGIN_ROOT}/hooks/go\" session-start" } ] }
    ]
  }
}
```

converts to `[{ event: "session_start", command: "\"<pluginRoot>/hooks/go\" session-start" }]` plus a
note that the (non-tool-scoped) matcher was ignored.

### 3.3 The skill sidecar document

`<skill>/agents/*.yaml` is one YAML mapping. Discovery prefers `openai.yaml`, then `openai.yml`, then
the lexicographically first remaining `.yaml`/`.yml` name
(`packages/skills/src/scan.ts:212-232`). Key spellings tolerated per presentation/policy concept
(`packages/skills/src/sidecar.ts:66-100`):

| Concept | Accepted keys |
| --- | --- |
| display name | `display-name`, `display_name`, `displayName`, `title` |
| short description | `short-description`, `short_description`, `shortDescription`, `summary` |
| icons | `icon`, `icons` (plus sized variants `icon-small`/`icon_small`/`iconSmall`, `-large` forms) |
| color | `color`, `colour`, `brand-color`, `brand_color`, `brandColor` |
| starter prompt | `default-prompt`, `default_prompt`, `defaultPrompt`, `starter-prompt`, `starter_prompt`, `starterPrompt` |
| nesting bucket | `interface`, `presentation`, `display`, `ui` |
| policy bucket | `policy`, `invocation` |
| MCP dependencies | `dependencies.tools[]`, retaining up to 64 bounded entries whose `type` is `mcp` and whose `value` is usable |

Example fixture (`packages/skills/tests/fixtures/foreign-skills/presented/agents/harness.yaml`):

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

read into `SkillPresentation { displayName: "Release Notes", shortDescription: "Turns a commit range
into publishable notes.", icons: { light: "assets/icon-light.svg", dark: "assets/icon-dark.svg" },
color: "#3b82f6", starterPrompt: "Draft the notes for everything since the last tag." }`, asserted at
`packages/skills/tests/integration/sidecar.test.ts:84-91`.

## 4. Behavior

### 4.1 Building the tool-name reading for one matcher name (`translateToolName`, `packages/kernel/src/plugins/hook-dialects.ts:418-471`)

Five rules are applied in order (`:385-416`):

1. An external MCP spelling becomes Clarvis's stable dotted identity: catch-all `mcp__.*` becomes
   `*.*`, and `mcp__<server>__<tool>` becomes `<server>.<tool>` (`:422-450`).
2. A plugin-instance MCP spelling `mcp__plugin_.*<server>.*` keeps the stable server portion and is
   force-qualified with the effective install identity supplied in `options.pluginName`
   (`:425-431`). A matcher naming a server the selected manifest contributes is qualified the same
   way; a matcher naming some other server remains unqualified (`:361-382`, `:433-458`). This prevents
   two installed plugins contributing the same server name from sharing a hook namespace.
3. Only when the name carries **no** pattern syntax at all (`PLAIN_TOOL_NAME`, `[A-Za-z0-9_-]+`) is it
   looked up in `EXTERNAL_TOOL_NAMES`/`EXTERNAL_TOOLS_WITHOUT_COUNTERPART` via `normalizeToolName`
   (`:462-466`). This restriction matters: a regular-expression family must not collapse into one
   exact built-in name.
4. A name already in this host's own `<server>.<tool>` shape passes through unchanged (`:468`).
5. Anything else — syntax this host's glob cannot express — is `{ kind: "inexpressible" }` (`:470`).

The identity in step 2 is the host-owned install-directory name, not presentation metadata from the
manifest. `resolvePluginManifest` receives that effective identity and passes it to the hooks
conversion only after the MCP server map has been resolved
(`packages/kernel/src/plugins/plugin-manifest.ts:1734-1762`). The integration tests pin both
ordinary owned-server qualification and a manifest whose display name differs from its install name
(`packages/kernel/tests/integration/plugin-manifest.test.ts:1165-1205`).

### 4.2 Building the filter for one matcher (`translateMatcher`, `packages/kernel/src/plugins/hook-dialects.ts:508-534`)

1. Strip a leading `^`/trailing `$` from the **whole** matcher, then test it against
   `CATCH_ALL_MATCHER`; a match yields `{ match: null, dropped: [] }` — no filter needed (`:512-513`).
2. Otherwise split on `|`. A bare catch-all inside an alternation refuses the whole group because
   retaining it would widen the hook to every call (`:514-520`).
3. Each inexpressible or no-counterpart alternative is recorded in `dropped`; every exact tool
   alternative is de-duplicated into the filter (`:516-529`). If at least one exact alternative
   survives, the group remains enforceable and the operator is told which branches were omitted
   (`:530-533`, emission at `:602-608`).
4. If **no** alternative survives, the group is refused as `inexpressible` or `no_counterpart` — an
   empty filter is never widened to an unfiltered hook (`:530-532`).

### 4.3 Converting a whole document (`convertHooksDocument`, `packages/kernel/src/plugins/hook-dialects.ts:559-673`)

For each `(sourceEvent, groups)` entry of the document's event map:

1. Normalize `sourceEvent` and look it up in `EVENTS_BY_NORMALIZED_NAME` (the inverse of
   `EXTERNAL_HOOK_EVENT_NAMES`, `:52-76`). No match → push a note, skip the whole event (`:567-572`).
2. If the resolved Clarvis event is in `OBSERVER_ONLY` (= `OBSERVER_HOOK_EVENTS`) but the source
   declared at least one real hook, push a note that the commands will run but can never block
   anything (`:573-585`).
3. For each matcher group: run `translateMatcher` only if the event is tool-scoped (`pre_tool_use` /
   `post_tool_use`); a refusal pushes a note and skips the **group** (`:586-601`); a partial `dropped`
   list pushes a note but keeps the rest of the filter (`:602-608`); a non-empty matcher on a
   non-tool-scoped event is noted and ignored (`:609-613`).
4. For each hook entry in the surviving group: only `"command"`/omitted and `"mcp_tool"` are
   supported. A command entry without `command`, an MCP entry without `server`/`tool`, or an MCP entry
   on `SessionEnd` is noted and skipped (`:614-630`). The timeout is converted and clamped via
   `translateTimeout` (`:632-633`). Command and Windows-command paths are substituted and anchored;
   `async`, `statusMessage`, `additionalContextLimit`, and the MCP `server`/`tool`/`input` payload are
   preserved in the resulting `HookConfig` (`:634-667`). The integration test pins both an async
   command and the complete command/MCP projections
   (`packages/kernel/tests/integration/plugin-manifest.test.ts:1607-1673`).

### 4.4 Substituting the plugin-root placeholder (`substituteRoot`, `packages/kernel/src/plugins/hook-dialects.ts:270-319`)

A single-pass scan of the command string, resolving every `$`-led reference it finds and copying
everything else through unchanged:

1. A bare `$NAME` (no `{`) is matched against `BARE_PLUGIN_ROOT`
   (`^[A-Za-z0-9_]*PLUGIN_ROOT(?![A-Za-z0-9_])`, `:202`) — the trailing negative lookahead is what stops
   it from over-matching a name like `$PLUGIN_ROOTS` or `$MY_PLUGIN_ROOT_DIR`, whose prefix would
   otherwise satisfy the same regex (doc comment `:194-201`). A match is replaced with the concrete
   plugin root; no match copies the `$` through and resumes scanning from the next character
   (`:281-290`).
2. A braced `${…}` has its closing brace found by `closingBrace` (`:225-235`), which counts nesting depth
   rather than matching the first `}`, so a reference nested inside another (case 5 below) still finds
   its own close.
3. The body up to the first character that is not a letter/digit/underscore is the variable **name**;
   everything from there on is the **rest** — the parameter-expansion operator and its argument, if any
   (`:299-301`).
4. The **operator**, if any, is whichever of the six default-if-unset forms (`:-`, `-`, `:=`, `=`, `:?`,
   `?`, `VALUE_OPERATORS`, `:213`) or two alternate-word forms (`:+`, `+`, `ALTERNATE_OPERATORS`, `:216`)
   the rest starts with, matched longest-first so `:-` is not mistaken for `-` (`:302-305`).
5. If the name is **not** a plugin-root reference (`PLUGIN_ROOT_NAME`, `^[A-Za-z0-9_]*PLUGIN_ROOT$`,
   `:192`), the whole body is recursively substituted and re-wrapped in `${…}` — this is what resolves a
   plugin-root reference nested inside another variable's default (`:307-308`).
6. Otherwise: an empty rest, or a `VALUE_OPERATORS` match, substitutes the plugin root directly, because
   the root is always set and non-empty, so every default-if-unset form answers with the value
   (`:309-310`); an `ALTERNATE_OPERATORS` match instead substitutes the alternate word — recursively,
   since that word may itself hold a reference (`:311-312`); anything else (a reference wrapped in a
   string operation this cannot emulate — `#`, `%`, `/` — `:261-262` in the function's own doc comment)
   is left exactly as written, untouched (`:313-314`).

Resolved at translation time into the literal path, not exported as an environment variable, so an
operator reviewing the hook definition reads the real path and that path becomes part of the hook's
approval fingerprint (doc comment `:266-268`).

#### 4.4.1 Anchoring a leading relative executable (`resolveRelativeCommand`, `packages/kernel/src/plugins/hook-dialects.ts:683-700`)

After placeholder substitution, a translated command beginning with an explicitly relative
executable (`./…`, `../…`, `.\…` or `..\…`, quoted or unquoted) is resolved against the plugin install
root. A target still inside that root is emitted as a quoted absolute executable followed by the
original arguments; a target that would leave the root is left unchanged (`:684-699`). The adapter is
the only caller (`:639`, `:644-647`), so native Clarvis hook arrays never cross this rewrite. That distinction
matters because the ordinary hook runner intentionally executes every command with the workspace as
its working directory (`packages/hooks/src/runner.ts:504-529`): the executable belongs to the plugin,
while its project-relative behavior still belongs to the workspace.

Pinned at `packages/kernel/tests/integration/plugin-manifest.test.ts:1080-1087,1354-1379,1815-1833`:
a convention hook and a relative executable from the selected borrowed manifest become plugin-root
paths, while a native Clarvis hook command remains unchanged.

### 4.5 Hooks source precedence: the manifest wins, but only if it says something (`resolveHooks`, `packages/kernel/src/plugins/plugin-manifest.ts:720-795`)

A plugin's hooks come from exactly one of two sources — its manifest's own `hooks` key, or the
`hooks/hooks.json` convention file — never merged (doc comment `:720-744`):

1. `harvestDeclared` runs on whatever the manifest's `hooks` key holds (`:679`).
2. **A declaration only counts when it yields at least one hook.** An empty array (`[]`) or an empty
   object (`{}`) is not "no hooks", it is "zero hooks harvested" — `harvestDeclared` returns `hooks: []`
   for both — so the `fromManifest.hooks.length > 0` check (`:583`) fails and the code falls through to
   the convention file at `:597` anyway, because a real plugin was found shipping exactly `"hooks": {}`
   while its actual commands lived in `hooks/hooks.json`; the naive reading ("the manifest declared
   hooks, so stop looking") would have silently dropped every one of them (doc comment `:665-669`).
3. If the manifest's own declaration did yield hooks, and the convention file also exists (and is not
   simply the file the declaration itself named), a note records that the convention file was not read
   because the manifest's own hooks take precedence (`:682-693`).
4. If the manifest declared nothing usable, `harvestConvention` is tried; if it yields hooks and the
   manifest had named something anyway (even if empty), a note records that the convention file was read
   because the manifest declared none (`:696-703`).
5. If neither source yields anything, the manifest's `hooks` key is deleted and no note beyond whatever
   each harvest already pushed is added (`:706-707`).

Pinned at `packages/kernel/tests/integration/plugin-manifest.test.ts:1031-1079` ("leaves an empty inline
object contributing nothing when there is nothing else", "falls through to the convention when the
declaration names nothing", "treats an empty native array the same way an empty map is treated").

### 4.6 MCP server entries: keys dropped, one bad entry salvaged, not the manifest (`@clarvis/loop` + `@clarvis/kernel`)

A plugin manifest's `mcpServers` map is read through a schema that is deliberately **not** the one
`settings.json` uses: `mcpServerPluginSchema` (`packages/loop/src/settings/settings-schema.ts:358-360`) is
`mcpServerBase.superRefine(refineMcpServer)` with no `.strict()`, the tolerant twin of
`mcpServerSettingsSchema` (`:334`), which does add `.strict()`. An operator's own `settings.json` is
best served by rejecting a stray key as the typo it probably is; a plugin manifest's entry arrives
written for another agent host and may carry a key this one gives no meaning to (a working directory, a
per-server startup budget) — rejecting the whole entry over one such key used to fail the *manifest*,
taking the plugin's agents, hooks and skills down with it. Measured on a public catalog of 196 plugins,
that single rule broke 24 of them and cost 82 skills that had nothing to do with MCP
(`packages/loop/src/settings/settings-schema.ts:310-327`) — the same shape of measurement the "5 of 39
names existed" figure the `EXTERNAL_TOOL_NAMES` architecture test uses elsewhere in this document. Unknown
keys are dropped, not carried forward, so nothing downstream can start treating a foreign key as a
contract this host never agreed to (`:329-332`).

When `mcpServers` is absent, the resolver also recognizes companion documents by convention. It tries
`.mcp.json`, then `mcp.json`; a missing file advances silently, while a malformed first convention is
noted and the second is still attempted (`packages/kernel/src/plugins/plugin-manifest.ts:796-811`). A
string declaration names one companion directly; an inline object remains inline. Every relative
companion path is tried beside the selected manifest first when that file exists there, then against
the plugin root, while both readings remain confined to the plugin root
(`packages/kernel/src/plugins/plugin-manifest.ts:347-375`). This composes foreign layouts without
merging two server maps or making one bad convention hide the next. Tests:
`packages/kernel/tests/integration/plugin-manifest.test.ts:260-360`, plus the combined skills/MCP/hooks
layout at `:362-404`.

`sanitizeMcpServers` (`packages/kernel/src/plugins/plugin-manifest.ts:1061-1084`) is what applies that
schema **per record**: it parses every entry of the manifest's `mcpServers` map individually, keeps
whichever ones validate, and pushes one note per entry that does not — the manifest schema's rule is
unchanged, only the blast radius of one bad entry is, from "this plugin does not exist" to "this server
is not contributed" (doc comment `:1043-1059`).

### 4.7 Runtime tool identity and stdin projection

Clarvis matches hooks against its own dispatch identity and emits the spelling the external process
expects; neither representation replaces the other. A handler may supply `canonicalName(call)` and the
loop carries it as `toolFullName` through both tool lifecycle contexts
(`packages/capability/src/loop-contract.ts:94-104`,
`packages/loop/src/runtime/loop/loop.ts:494-508`, `:549-617`). The hooks package then:

- keeps the model-facing `tool` as the primary match candidate and adds the stable full name as an
  alias (`packages/hooks/src/event-serialization.ts:230-237`);
- emits built-in names through `EXTERNAL_HOOK_TOOL_NAMES`, adds the external `skill` alias alongside
  the native `name` field for skill loads, and reconstructs `mcp__<server>__<tool>` from a dotted MCP
  identity while removing the Clarvis-only plugin namespace from stdin
  (`packages/hooks/src/event-serialization.ts:95-124`, `:141-155`);
- fires `user_prompt_expansion` only when the host supplied the command that expanded into this run,
  once during the hooks capability's seed phase; ordinary prompts and later model-initiated skill
  loads have no such context (`packages/capability/src/hooks-config.ts:76-85`,
  `packages/hooks/tests/component/capability.test.ts:662-689`).

This is pinned together by `packages/hooks/tests/component/capability.test.ts:455-495` and
`packages/loop/tests/unit/tool-hooks.test.ts:171-214`.

### 4.8 Skill precedence merge (delegated mechanism, cited for context)

For `builtin:default`, `clarvisSkillRoots` (§3.1) hands its four roots, in ascending order, to `buildRegistry`
(`packages/skills/src/registry.ts:122`), which scans and merges in one pass: the roots are folded **in
the order given** (`:127-153`), so a same-named skill from a later root always displaces an earlier one
through `mergeWinner` (`:286-302`), and the loser is recorded on the winner's `shadowed` chain
(`:287-291`, projected by `toShadowed` at `:320-331`). Because
`clarvisSkillRoots` places both `.agents` roots before both `.clarvis` roots, this is the concrete
mechanism by which "`.agents` always loses to `.clarvis`" holds — but the fold itself is source-
agnostic (`packages/skills/tests/integration/discovery.test.ts:58-83` exercises it with roots merely
labeled `"lower"`/`"upper"`, not `"agents"`/`"clarvis"`). The deeper registry/catalog mechanics this
composes with are owned by the [execution/skills.md](../execution/skills.md) document.

## 5. Invariants

Catalog invariants carry `INV-nnn` and are owned here; only INV-189 is catalogued to this document.
`AIN-nn` are invariants derived directly from this document's own source and tests.

**INV-189** (owned by this document). Every foreign tool name in `EXTERNAL_TOOL_NAMES` maps onto a tool
Clarvis actually dispatches (present in `@clarvis/tools`'s registry) or is explicitly allowlisted as a
capability-owned name (`delegate_task` or `load_skill`); no name in `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` is
contradicted by actually existing in the registry; and the capability allowlist contains no name that
is *also* in the tool registry (keeping it non-redundant).
Production: `packages/capability/src/hooks-config.ts:142-191`.
Test: `packages/kernel/tests/architecture/external-tool-names.test.ts:24-41`.

**AIN-01** (derived). `EXTERNAL_TOOL_NAMES` and `EXTERNAL_TOOLS_WITHOUT_COUNTERPART` are disjoint sets
— no key names both "here is the Clarvis tool" and "Clarvis has no such tool".
Production: `packages/capability/src/hooks-config.ts:142-191`.
Test: `packages/capability/tests/unit/hooks-config.test.ts:274-278` ("never lists a name in both
directions at once").

**AIN-02** (derived). `EXTERNAL_HOOK_EVENT_NAMES` is one-to-one: every foreign spelling it produces is
distinct, so inverting it (as `hook-dialects.ts` does to build `EXTERNAL_HOOK_EVENTS`) loses no
information and cannot make two Clarvis events collide onto one lookup key.
Production: `packages/capability/src/hooks-config.ts:104-116`;
inversion at `packages/kernel/src/plugins/hook-dialects.ts:52-54`.
Test: `packages/kernel/tests/integration/plugin-manifest.test.ts:1239-1254` ("round-trips every event
the shared correspondence names, in both directions"; "keeps the correspondence one-to-one, so
inverting it loses nothing").

**AIN-03** (derived). Every key of `EXTERNAL_TOOL_NAMES` (and every member of
`EXTERNAL_TOOLS_WITHOUT_COUNTERPART`) is already in its own `normalizeToolName`-normalized form, so the
lookup a real (differently-capitalized, differently-punctuated) foreign name normalizes to can never
miss the table by construction.
Production: `packages/capability/src/hooks-config.ts:142-204`.
Test: `packages/capability/tests/unit/hooks-config.test.ts:256-263` ("keys every entry by its own
normalized form, so a lookup cannot miss").

**AIN-04** (derived). `.agents` mutation authority is component-scoped. Standalone skills and
marketplace documents never reach a mutator; only the filesystem plugin repository may directly
mutate an exact directory beside an `agentsPluginsDir(s)` root. That authority does not grant
ownership of the rest of `.agents`, and persistent plugin runtime data is kept in Clarvis state.
Production: `AGENTS_DIR` and the accessors in `packages/paths/src/{constants,workspace}.ts`;
the exact managed writer is
`packages/kernel/src/adapters/filesystem/plugin-repository.ts`; runtime data is resolved by
`packages/kernel/src/plugins/plugin-runtime.ts`.
Test: `packages/paths/tests/architecture/agents-read-only.test.ts` discovers production consumers,
keeps authored accessors away from filesystem mutators, and asserts that the plugin repository is
the sole direct plugin-root writer. The separate literal sweep in
`packages/paths/tests/architecture/invariant.test.ts` catches a newly hand-spelled `.agents` path.

**AIN-05** (derived). The four standard skill roots are produced in a fixed order — `.agents/skills`
(user, then workspace) below `.clarvis/skills` (user, then workspace) — and, for whichever roots and
exact-name filters the host admits, that order is exactly the merge precedence because
`buildRegistry` folds the roots in the order it is given them and later always displaces earlier.
Production: `packages/skills/src/preset.ts:32-46`; fold order at
`packages/skills/src/registry.ts:127-153`.
Test: `packages/skills/tests/unit/preset.test.ts:8-19` pins the exact four-element array;
`packages/skills/tests/integration/discovery.test.ts:58-83` pins last-root-wins in the abstract, and
`:28-56` composes the two into one end-to-end "`.agents` skill shadowed by `.clarvis` skill of the same
name" scenario — the winner is the workspace `.clarvis` definition, with `clarvis:user`,
`agents:workspace` and `agents:user` retained on its `shadowed` chain in that order.

**AIN-06** (derived). A refused or unusable piece of a foreign hooks document never widens what a hook
matches or which events it can act on: an unrepresentable alternative is retained only as a note when
another exact alternative survives; if nothing exact survives, the whole group is dropped rather than
falling back to no filter (`packages/kernel/src/plugins/hook-dialects.ts:508-534`, tested at
`packages/kernel/tests/integration/plugin-manifest.test.ts:796-856`, `:1248-1255`). A timeout past
`MAX_HOOK_TIMEOUT_MS` is clamped down, never rounded up or emitted unbounded
(`packages/kernel/src/plugins/hook-dialects.ts:94-107`, tested at
`packages/kernel/tests/integration/plugin-manifest.test.ts:1296-1333`).

**AIN-07** (derived). A malformed or unreadable skill sidecar degrades to "no sidecar" and never
removes, suppresses, or otherwise changes the catalog status of the skill that carries it.
Production: `packages/skills/src/sidecar.ts:314-318` (doc rule stated directly on `readSkillSidecar`).
Test: `packages/skills/tests/integration/sidecar.test.ts:210-217` ("keeps a skill whose sidecar is
malformed fully present in the catalog"), `:219-221` ("reports the malformed sidecar as a warning"),
`:223-225` ("keeps a malformed sidecar from failing even a strict scan").

**AIN-08** (derived). A plugin-owned MCP matcher is qualified with the host-owned install identity,
not a manifest's presentation name, and an unrelated server matcher remains unqualified. Production:
`packages/kernel/src/plugins/hook-dialects.ts:361-382`, `:418-458` and
`packages/kernel/src/plugins/plugin-manifest.ts:1734-1762`. Test:
`packages/kernel/tests/integration/plugin-manifest.test.ts:1165-1205`.

**AIN-09** (derived). The external tool spelling is an output projection, not the hook matcher's
canonical identity: built-ins, skill loads and MCP tools can be emitted in the foreign stdin dialect
while the same invocation is still matched by its Clarvis wire/full-name candidates. Production:
`packages/hooks/src/event-serialization.ts:95-124`, `:141-155`, `:230-237`. Test:
`packages/hooks/tests/component/capability.test.ts:455-495`.

**AIN-10** (derived). `UserPromptExpansion` fires exactly once for a user-invoked skill expansion and
does not stand in for ordinary prompt submission or a later `load_skill` tool call. Production:
`packages/capability/src/hooks-config.ts:76-85` and the host request projection in
`packages/kernel/src/runs/settings-assembler.ts:460-466`. Test:
`packages/hooks/tests/component/capability.test.ts:662-689` and
`packages/kernel/tests/component/settings-assembler.test.ts:540-579`.

**AIN-11** (derived). A leading relative executable in a translated foreign hook resolves from the
plugin install root even though the subprocess keeps the workspace as its working directory; a native
Clarvis hook command is never rewritten by this adapter. Production:
`packages/kernel/src/plugins/hook-dialects.ts:634-667,683-700` and
`packages/hooks/src/runner.ts:504-529`. Test:
`packages/kernel/tests/integration/plugin-manifest.test.ts:1080-1087,1354-1379,1815-1833`.

## 6. Failure modes and degradation

| Situation | What happens | Cited at |
| --- | --- | --- |
| Foreign hook event name has no Clarvis counterpart (`Notification`) | Whole event's commands are dropped; one note naming the event | `packages/kernel/src/plugins/hook-dialects.ts:567-572`; test `packages/kernel/tests/integration/plugin-manifest.test.ts:1496-1503` |
| Foreign event maps to a Clarvis event that is observer-only | Commands still run (installed, approved) but a note warns their verdict can never block | `packages/kernel/src/plugins/hook-dialects.ts:580-585`; test `packages/kernel/tests/integration/plugin-manifest.test.ts:1505-1512` |
| One matcher alternative carries syntax this host's glob cannot express | That branch is dropped with a note when an exact branch survives; the group is dropped only when none does | `packages/kernel/src/plugins/hook-dialects.ts:508-534`, `:591-608`; tests `packages/kernel/tests/integration/plugin-manifest.test.ts:1207-1230`, `:1255-1265` |
| Matcher names only tools with no Clarvis counterpart | Whole group dropped as "no filter is not a filter" | `packages/kernel/src/plugins/hook-dialects.ts:530-532`; test `packages/kernel/tests/integration/plugin-manifest.test.ts:1246-1253` |
| Matcher names a mix of known and unknown tools | Known ones kept, unknown ones named in a note, rest of filter still applies | `packages/kernel/src/plugins/hook-dialects.ts:516-533`, `:602-608`; test `packages/kernel/tests/integration/plugin-manifest.test.ts:1237-1244` |
| Filter set on a non-tool-scoped event | Filter ignored with a note; event still fires unfiltered | `packages/kernel/src/plugins/hook-dialects.ts:609-613` |
| Hook entry of unsupported `type`, command entry without `command`, or MCP entry without `server`/`tool` | That single entry is skipped with a note; siblings are unaffected | `packages/kernel/src/plugins/hook-dialects.ts:614-627` |
| `mcp_tool` on `SessionEnd` | Entry is skipped with a note because the MCP pool is no longer available for that lifecycle event | `packages/kernel/src/plugins/hook-dialects.ts:628-630` |
| `async: true` on a command entry | The flag is preserved; every event except `SessionEnd` schedules bounded background execution and immediately passes, while `SessionEnd` remains synchronous | `packages/kernel/src/plugins/hook-dialects.ts:649`; `packages/hooks/src/runner.ts:504-526`; tests `packages/kernel/tests/integration/plugin-manifest.test.ts:1607-1624`, `packages/hooks/tests/component/runner.test.ts:549-624` |
| Timeout exceeds `MAX_HOOK_TIMEOUT_MS` | Clamped to the ceiling with a note, never emitted unbounded (which the manifest schema would then refuse for the whole document) | `packages/kernel/src/plugins/hook-dialects.ts:94-107`; test `packages/kernel/tests/integration/plugin-manifest.test.ts:1255-1263` |
| An MCP server entry in a plugin manifest carries keys this host gives no meaning to | Keys silently dropped, entry kept if otherwise valid (`mcpServerPluginSchema`, the tolerant counterpart of the strict `mcpServerSettingsSchema` used for `settings.json`) | `packages/loop/src/settings/settings-schema.ts:330-360` |
| An MCP companion is missing or malformed | Missing convention advances to the next name; a malformed convention is noted and the next is still tried; a broken explicit companion withholds only MCP servers | `packages/kernel/src/plugins/plugin-manifest.ts:736-811`; tests `packages/kernel/tests/integration/plugin-manifest.test.ts:260-360` |
| An MCP server entry is unusable even after that tolerance (e.g. a stdio server naming no command) | Only that entry dropped, with a note; rest of `mcpServers` and the whole plugin survive | `packages/kernel/src/plugins/plugin-manifest.ts:813-854` |
| A declared/convention hooks document is missing, not JSON, over its byte ceiling, or not a recognizable hooks shape | Manifest keeps loading with no hooks from that source and a note; never an `error` | `packages/kernel/src/plugins/plugin-manifest.ts:484-642`; tests `packages/kernel/tests/integration/plugin-manifest.test.ts:1107-1183` |
| A skill sidecar is unreadable, unparseable, or not a YAML mapping | Skill keeps its name/description/body; only `presentation`/`dependencies`/`catalogSuppressed` are absent; a warning is logged | `packages/skills/src/sidecar.ts:314-373`; tests `packages/skills/tests/integration/sidecar.test.ts:203-247` |
| A sidecar's resource escapes the skill directory (via symlink) | Skipped with a warning, same as any other escaping symlink | `packages/skills/src/scan.ts:174-181`; test `packages/skills/tests/integration/sidecar.test.ts:227-238` |
| A symlink's target cannot be resolved at all — missing (`ENOENT`) versus any other `realpath` failure | Treated oppositely: a *missing* target is **not** counted as escaping (falls through to the separate dangling-link warning, so a symlinked ancestor like a symlinked temp dir does not make every dangling link look like an escape); every *other* resolution failure — e.g. a target that exists but is unreadable — **is** counted as escaping, because the later `stat` needs only search permission where `realpath` needs read on the target | `packages/skills/src/scan.ts:399-406` (`escapesRoot`), doc rule at `:376-398` |
| The skill's own resource listing would otherwise name a file under `<skill>/agents/` | The top-level harness directory is skipped whole during enumeration — never named to the model in the first place, distinct from the reactive check below | doc rule `packages/skills/src/scan.ts:237-240`; enforced at `:310` |
| A resource request lexically or (via symlink) actually resolves into `<skill>/agents/` | Reported `not_found`, indistinguishable from a resource that does not exist | `packages/skills/src/registry.ts:568-574`, doc rule at `:558-560` |
| A required skill frontmatter field (`name`/`description`) is missing or unusable | Supplied from a fallback (directory name / sidecar short-description / neutral placeholder), never fatal; every substitution is warned and recorded on `SkillInfo.defaulted` | `packages/skills/src/parse.ts:49-63`; behavior demonstrated at `packages/skills/tests/integration/sidecar.test.ts:260-307` (delegated in depth to [execution/skills.md](../execution/skills.md)) |

Every row above is a **degrade**, not a **fail**: nothing in this document's scope shows a foreign
dialect document taking down anything wider than the one artifact it could not translate. This mirrors
the same design language used for plugin manifests generally (`packages/kernel/src/plugins/plugin-manifest.ts:811-828`).

## 7. Coupling

- **`@clarvis/paths` → nothing** (leaf). `AGENTS_DIR` and its accessors are pure path arithmetic with
  no dependency of their own (confirmed by the package-level leaf status this document did not need to
  re-derive; `packages/paths/src/constants.ts` imports nothing).
- **`@clarvis/skills` → `@clarvis/paths`**, statically: `preset.ts` imports `agentsSkillsDirs`,
  `globalPaths`, `workspacePaths` directly (`packages/skills/src/preset.ts:2`). This is what forces
  `.agents/skills` and `.clarvis/skills` to be resolved through the one owner of the directory
  vocabulary rather than a second hand-written path.
- **`@clarvis/capability` has no dependency on either `@clarvis/hooks` or `@clarvis/kernel`.** The two
  correspondence tables live in `hooks-config.ts`, which imports only `zod`
  (`packages/capability/src/hooks-config.ts:16`). This is what lets both the settings-schema path (eager,
  always loaded) and the optional `@clarvis/hooks` runtime read the same table without either one
  depending on the other — the structural reason given in the file's own header remark
  (`packages/capability/src/hooks-config.ts:5-14`).
- **`@clarvis/hooks` reads `EXTERNAL_HOOK_EVENT_NAMES` forwards** to label the stdin payload sent to a
  hook subprocess and `EXTERNAL_HOOK_TOOL_NAMES` forwards for built-in tool spellings:
  `packages/hooks/src/event-serialization.ts:1-27`, `:110-124`, `:241-254`. The full stdin-payload
  contract this feeds into is owned by the [execution/hooks.md](../execution/hooks.md) document.
- **`@clarvis/kernel`'s `hook-dialects.ts` reads the same table backwards**
  (`packages/kernel/src/plugins/hook-dialects.ts:28-36`, `:52-54`) to translate an installed plugin's
  document. Because both directions derive from the one table in `@clarvis/capability` rather than each
  hand-writing its own map, a table edit cannot leave the two readings out of sync — which is exactly
  what the doc comment on `EXTERNAL_HOOK_EVENT_NAMES` states is the reason it exists in one place
  (`packages/capability/src/hooks-config.ts:92-97`).
- **`@clarvis/kernel` does not depend on `@clarvis/hooks`.** `hook-dialects.ts`'s own header remark
  states why: `@clarvis/hooks` is `optionalDependencies` of the loop, and the kernel must not gain a
  dependency that would make `builtins.hooks = false` stop meaning what it says
  (`packages/kernel/src/plugins/hook-dialects.ts:17-20`). The kernel instead resolves a foreign document
  to concrete `HookConfig` values itself and hands the engine an ordinary array. There is no dedicated
  architecture test for this direction in this document's scope —
  `packages/kernel/tests/architecture/dependency-direction.test.ts` checks three unrelated things
  (`application`/`core`/`ports` not importing `node:fs`/adapters, `transport` not importing
  `file-kernel`, and no source file naming the removed `@clarvis/loop/internal` surface) and never
  mentions `@clarvis/hooks`. The evidence available is structural: `packages/kernel/package.json`
  declares no `@clarvis/hooks` dependency, and a scan of `packages/kernel/src` finds the package name
  only in the comment remarks cited above, never in an `import`.
- **`packages/kernel/src/plugins/plugin-manifest.ts` is the sole caller of `convertHooksDocument` and
  `hooksDocumentSchema`** (`packages/kernel/src/plugins/plugin-manifest.ts:25-29`, `:588-603`) — the
  translator has exactly one production consumer, which is why every degradation rule in `hook-dialects.ts`
  is phrased in terms of "this hook/group/document", never "this plugin": the caller is the one that
  decides what a lost hook costs the rest of the manifest (deeper mechanics owned by
  [hosts/plugins.md](../hosts/plugins.md)).
- **`@clarvis/tools`'s tool registry is what `EXTERNAL_TOOL_NAMES` is checked against**, one-way: the
  architecture test imports `tools` from `@clarvis/tools` to validate the table
  (`packages/kernel/tests/architecture/external-tool-names.test.ts:7,17`), but neither
  `@clarvis/capability` nor `@clarvis/kernel`'s production code imports `@clarvis/tools` for this
  purpose — the correspondence table is written by hand and only *checked* against the registry by a
  test, so a renamed tool would not fail until that architecture test runs (a compile-time-adjacent, not
  a runtime, coupling).
- **`@clarvis/skills`'s `scan.ts` has no dependency on the concept of source ("agents" vs "clarvis")** —
  see §3.1 and §4.7. The `.agents`-vs-`.clarvis` precedence is entirely a property of what
  `@clarvis/skills/preset.ts` and its caller in the kernel pass in as the ordered root list, not of any
  branch inside the scanner itself. This is a design choice a reader of `scan.ts` alone would not see:
  it only becomes visible by also reading `preset.ts`.

## 8. Open questions

- **Why `pre_delegate_task` has no foreign counterpart** is stated as a design choice
  ("Events with no counterpart on either side are absent on purpose",
  `packages/capability/src/hooks-config.ts:101-102`) but the code does not say why no foreign host's
  vocabulary was judged close enough to reuse — only that none was chosen.
  Similarly, why exactly these 5 names (`exitplanmode`, `todowrite`, `notebookedit`, `webfetch`,
  `websearch`) constitute the *complete* set of foreign tools with no counterpart — as opposed to a
  larger or smaller set — is not derivable from the code; it is asserted as a closed list with no
  visible derivation from an external catalog inside this repository (the "measured against a public
  catalog of 196 plugins" figures at `packages/capability/src/hooks-config.ts:124` and
  `packages/loop/src/settings/settings-schema.ts:310-311` are cited *inside* the source's own doc
  comments as the origin of these numbers, but the catalog itself is not part of this repository and
  this document could not independently verify it).
- **The plugin manifest's broader per-artifact degradation model** (agents, skills-root directives,
  install records, and atomic plugin hooks) is delegated to [hosts/plugins.md](../hosts/plugins.md); this document cites
  `plugin-manifest.ts` only at the points where it composes the tables, translator, and MCP companion
  tolerance this document owns (`resolveMcpServers` at `:891-906`, `sanitizeMcpServers` at
  `:1061-1084`, and `harvestDocument`/the declared-hook harvest at `:588-717`).
- **The deeper skill-registry mechanics** — required-field defaulting beyond the one example shown,
  `allowed-tools` vs. `tools` precedence, `user-invocable`/`catalogSuppressed` as two independent gating
  axes, the full limits regime (`MAX_SKILL_NESTING`, `MAX_SKILL_GROUP_DIRECTORIES`, etc.) — are
  delegated to [execution/skills.md](../execution/skills.md); this document describes only the `HARNESS_CONFIG_DIR` mechanism and the
  sidecar's dialect tolerance, both of which sit squarely on the "foreign document, tolerant reading"
  theme this document owns.
