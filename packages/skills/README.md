# `@clarvis/skills`

Discovery, parsing and progressive loading of `SKILL.md` skills from
caller-supplied roots. It depends on `@clarvis/paths` (the directory vocabulary)
and `@clarvis/capability` (the contract its `./capability` entry implements), and
on nothing else in the workspace.

> Private, unversioned workspace. The root manifest owns the Clarvis product version; this package
> is not published independently.

## Contract

Discovery, parsing, precedence, and progressive disclosure are specified in
[`execution/skills.md`](../../specs/execution/skills.md). Shared `.agents` behavior and plugin
contributions are specified in
[`cross-cutting/agent-interop.md`](../../specs/cross-cutting/agent-interop.md) and
[`hosts/plugins.md`](../../specs/hosts/plugins.md). Host-selected exact roots are specified by
[`hosts/extension-profiles.md`](../../specs/hosts/extension-profiles.md).

## How it works

The API separates skill discovery from loading:

1. list lightweight catalog entries;
2. load a selected skill's body;
3. resolve its scripts, references, assets and other resources only when needed.

`renderSkillsSection` treats the catalog as routing, not decoration. A skill the user names is
loaded before acting. Otherwise a listed skill is loaded when its one-line `description` clearly
matches the current task, and skipped only with a short reason. Presence in the catalog is not
itself a reason to load. The user's current instructions take precedence over the skill. If a
skill is why the run must pause, the section identifies the relevant `SKILL.md` rule. Authors
should write `description` as that router ("Use when X. Not for Y."), not as a summary of the
body. Fleet-wide precedence lives in the shared prompt; this section owns discovery and loading.

Discovery reads only a bounded manifest prefix and retains metadata plus a lazy
body loader. It does not keep every `SKILL.md` body in the catalog. The first
body disclosure is cached for that registry generation; `refresh()` replaces
the registry and its disclosed-body cache.

Roots are merged in the order supplied. When two roots contain the same skill
name, the last root wins and the losing definitions are recorded in the winner's
`shadowed` metadata.

A root may be either a collection of skill directories or one skill directory
that directly contains `SKILL.md`. Discovery stops at the first skill boundary,
so files below that directory remain resources rather than becoming nested
skills.

## Usage

```ts
import { clarvisSkillRoots, createAgentSkills } from "@clarvis/skills";

const skills = createAgentSkills({
  workspace: process.cwd(),
  roots: clarvisSkillRoots({ workspace: process.cwd() }),
});

for (const skill of skills.listSkills()) {
  console.log(skill.name, skill.description);
}

const selected = skills.loadSkill("release-notes");
if (selected) {
  console.log(selected.body);
  console.log(selected.resources);
}
```

`clarvisSkillRoots` returns the standard user and workspace roots under
`.agents/skills` and `.clarvis/skills`. Custom roots can carry provenance:

```ts
const skills = createAgentSkills({
  roots: [
    { path: "/shared/skills", scope: "user", source: "shared" },
    { path: ".clarvis/skills", scope: "workspace", source: "project" },
  ],
});
```

A root may also carry `include`, an exact allow-list of resolved manifest names. An absent list
preserves full discovery; an empty list admits nothing. Filtering happens after normal manifest
resolution, so it does not create a second naming or precedence system. The kernel uses this generic
mechanism to pass custom Extension Profile skill selections without making this package understand
Extension Profiles.

`executionRoot` is a separate, host-controlled opt-in. When present on a root, discovery exposes
only each selected skill's own directory as that skill's `executionRoot`; it never exposes the
broader collection or package directory. Filesystem-backed `load_skill` identifies the skill directory for
relative resource paths and emits the helper-execution hint only for this opted-in field. Execution
still goes through the normal shell command guard and native sandbox policy.

Host bridges mark tool-only disclosure with `resourceAccess: "remote"`. The catalog then advertises
loading by name and resource reads through `read_skill_resource`; body disclosure advertises no
mounted directory or execution root. Bundled helpers must first be read through all resource pages
and prepared with their relative directory structure in the writable workspace, then invoked
through the ordinary guarded shell. Remote locations are opaque locators.

Call `refresh()` after the filesystem changes. `resourcePath(name, rel)` resolves
a resource while enforcing that it stays inside the selected skill directory.

## Entry points

| Entry                        | Contents                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@clarvis/skills`            | discovery/loading, bounded resource enumeration, and snapshot file/resource limits                               |
| `@clarvis/skills/catalog`    | `renderSkillCatalog`: catalog metadata → a compact Markdown block for a prompt                                   |
| `@clarvis/skills/capability` | the loop adapter: `createSkillsCapability`, strict body/resource tools and handlers, plugin bootstrap resolution |

```ts
import { renderSkillCatalog } from "@clarvis/skills/catalog";

const markdown = renderSkillCatalog(skills.listSkills());
```

`./capability` is a **separate entry on purpose**: nothing on `@clarvis/loop`'s
eager configuration path may reach it, or `builtins.skills = false` would still
load this package on every import of the engine. The loop reaches it through a
dynamic import instead.

`renderSkillCatalog` includes the exact `SKILL.md` path with each filesystem-backed name and
description. Host-embedded entries with `source: "builtin"` instead say to load by name and precede
external entries, keeping product guidance discoverable when a large catalog is truncated.
`load_skill` identifies them as embedded instructions rather than advertising an execution
directory. Their `root`, `dir` and `path` are `builtin:` locators, not filesystem paths. The kernel
owns the shipped `clarvis-configure` body and composition; this package does not import product
configuration or create builtin files.

The catalog never emits more than 8,000 characters. When a full catalog exceeds that bound, it first removes
descriptions, then omits a deterministic tail. The capability filters a skill whose
`agents/openai.yaml` declares `dependencies.tools` entries of `type: mcp` unless the run carries
that MCP server (including its plugin-qualified form), while the protocol/UI retain the dependency
metadata for diagnosis.

`./capability` also exports the pure `formatSkillBody`, `formatSkillResourceChunk`,
`formatSkillResourceLegacy` and `validateResourceChunk` helpers. Native handlers and the kernel
container bridge use the same disclosure and page validation. The bridge preserves builtin identity
and priority, strips host-only paths before formatting, and sends the resulting text through its
read-only RPC. A whole-resource provider never advertises a byte cursor it cannot continue.

The root also exports `enumerateResources`, `readBoundedBytes`, `readBoundedTextChunk`,
`hashBoundedFile`, their option/result types, and the bounded skill file/resource limits. The legacy
whole-resource read remains capped at 256 KiB and 50 000 decoded characters. A chunked read admits a
complete regular file of at most 8 MiB, but returns one UTF-8 page of at most 256 KiB and 50 000
characters; its continuation cursor is a byte offset and never splits a UTF-8 sequence or surrogate
pair. `load_skill` has the closed shape `{ name }` and only loads the body. Bundled files use the
separate `read_skill_resource` shape `{ name, resource, offset }`; every field is required, the first
page uses byte offset zero, and a provider-portable relative path pattern with no regex lookaround
rejects absolute paths, traversal, drive-qualified paths, backslashes, control characters and empty
segments. The resource reader validates every chunk returned by a provider and fails closed on a
mismatched, unbounded, non-progressing or inexact cursor. A legacy provider without chunk support
can serve only offset zero and never reinterprets the byte cursor as a character index.

`hashBoundedFile` streams raw bytes through a fixed buffer, without decoding or retaining the whole
file, and refuses a resource larger than the caller's bound. Kernel skill snapshots apply the public
8 MiB per-file limit and a distinct 32 MiB aggregate resource budget. This lets binary resources
participate in identity while keeping model-facing text disclosure and snapshot memory accounting
independently bounded. Their canonical catalog projection also includes `dependencies.tools`, so a
sidecar change that alters model-visible skill availability invalidates both plugin and standalone
skill snapshots even though the `agents/` sidecar directory is not a model-readable resource.
`SkillRegistry.get` exposes the absolute `identityFiles` that produced the effective content: the
manifest, selected sidecar when present, and enumerated resources. A host can arm asynchronous
monitoring for that exact set before comparing the captured catalog with its pinned digest; the
sidecar remains unavailable through the resource API.

`LOAD_SKILL_TOOL_NAME` and `READ_SKILL_RESOURCE_TOOL_NAME` are owned only here.
`createSkillsCapability` derives its `reservedWireNames` and `toolEffects` from the two canonical
descriptors, so the engine learns neither name by duplicating it on the optional package's eager
path.

## Parsing behavior

Skills are directories containing a `SKILL.md` file with YAML frontmatter and a
Markdown body. `strict: true` makes malformed skills fail discovery; the default
is to warn and skip them. Symlinks are followed by default and may be disabled
with `followSymlinks: false`.

`name` and `description` are required. The optional `agent` names the agent a
user-invocable skill runs on, and is the one field that decides how a user
invokes it: with it the skill becomes a run of its own on that agent's profile
graph, tools and budget; without it the skill's instructions are rendered into
the current turn. (It does not govern the model-facing `load_skill` tool, which
always serves the body into the run that asked for it.) The value carries
`name`'s shape plus `:`, so a plugin-contributed `<plugin>:<agent>` can be
named. A malformed value degrades to "names no agent" rather than invalidating
the manifest — a strict field here would drop a whole third-party skill from the
catalog over one key. This package only parses and bounds the field; resolving it
to an agent is the host's job (`@clarvis/kernel`).

A required field the manifest does not usably carry is **supplied, never fatal**.
A missing (or unusable) `name` falls back to the skill's directory name, reduced
to a legal one; a missing `description` falls back to the skill's short
description if one was declared anywhere, else to a neutral placeholder that
claims nothing about what the skill does. Both are reported through the warning
sink and listed on `SkillInfo.defaulted`, so a consumer can tell a supplied value
from an authored one. This is deliberate reader tolerance: a skill written in a
dialect that leaves a field out still reaches the catalog rather than vanishing
from it, and it applies under `strict` too — a supplied field is not a
malformed manifest.

Plugin roots that declare the portable Agent Plugins v1 contract opt into the
stricter Agent Skills reader instead. That policy inspects only immediate child
directories with an exact `SKILL.md`, requires the authored `name` and
`description`, enforces the portable lowercase-hyphen name (1–64 characters and
equal to the directory), and validates `license`, `compatibility` (1–500
characters), string-to-string `metadata`, and the space-separated string form of
`allowed-tools`. One invalid child is skipped without removing the plugin's other
skills or contributions. Native, standalone, and borrowed-host roots retain the
tolerant Clarvis behavior above.

## The harness-directed sidecar

A skill directory may carry an `agents/` subdirectory holding configuration
addressed to whichever runtime loads the skill, rather than to the model. The
first `.yaml`/`.yml` file in it is read as a **sidecar**. Nothing is matched by
filename: any file of that shape, in that directory, is the candidate.

It contributes three things, kept apart on purpose:

- **Presentation** — `SkillInfo.presentation`: a display name, a short
  description, per-theme icon paths, a brand colour and a starter prompt. Each
  concept is accepted under the kebab-, snake- and camel-cased spellings
  producers write it in. `metadata.short-description` in `SKILL.md`'s own
  frontmatter feeds the same field, with the sidecar taking precedence.
- **Catalog suppression** — `SkillInfo.catalogSuppressed`: the skill is withheld
  from the catalog injected into a run's context, while staying explicitly
  loadable by name through `load_skill`.
- **Tool dependencies** — bounded `dependencies.tools` entries whose `type` is `mcp`, including
  their server value and optional description/transport/URL. Unsupported dependency kinds remain
  inert sidecar data rather than widening execution authority.

Catalog suppression is **not** `user-invocable`, and the two must not be folded
together. `user-invocable` filters the slash listing a _user_ chooses from;
suppression withholds an entry from the _model_'s catalog. A skill may carry
either, both, or neither. Suppression takes effect in exactly one place —
`renderSkillCatalog` — so a consumer that renders the catalog cannot forget it.

Three rules bound the sidecar:

- **It never reaches the model.** Not the skill body, not the catalog text, not
  `load_skill`'s output. The whole `agents/` directory is therefore withheld from
  the resource listing and from `resource()`/`readResource()`, which report a
  path inside it as `not_found`: the listing is rendered to the model, and naming
  a harness-directed file there would both disclose it and invite a read of it.
- **A malformed sidecar degrades to "no sidecar"**, and never removes the skill
  that carries it — the rule `agent`'s `.catch(undefined)` already follows.
  Unreadable, unparseable and not-a-mapping all warn and yield nothing.
- **Presentation is never authorization.** Icon paths are rejected outright if
  they could address anything outside the skill directory; nothing in the sidecar
  gates a tool, a grant or a path.

All filesystem tiers are hard-bounded before content allocation: configured
roots, directory entries, manifests per root, merged catalog size, manifest
bytes/characters and frontmatter prefix size. Resource disclosure additionally
bounds traversal depth, visited entries/directories, returned files and the
bytes/characters returned in one page, the complete file admitted for paging and
the aggregate resource bytes admitted to a snapshot. A directory that exceeds
its entry cap is dropped as a whole, avoiding an order-dependent partial scan;
non-strict discovery warns when a catalog bound drops input.

## Diagnostics

Discovery has two destinations, and they are not redundant. `warningSink` receives
a formatted sentence a host may show a user; `logger` (a `Logger` from
`@clarvis/capability`, defaulting to `NOOP_LOGGER`) receives the fields an
operator greps. Both are set on `AgentSkillsOptions` and carried on the resolved
`SkillConfig`, which is itself a `SkillDiagnostics` — that is the single struct
the `scan.ts` helpers take.

Nothing here is traced. Only the model-facing `load_skill` and `read_skill_resource` calls produce
trace entries; discovery, merging, shadowing and sidecar parsing are machinery acting on the state
of a directory, which fails the trace test on attribution and on volume alike.

| Level   | `event`                       | Fields                                                      |
| ------- | ----------------------------- | ----------------------------------------------------------- |
| `info`  | `skills.discovered`           | `roots`, `skills`, `shadowed`, `defaulted`, `dropped`, `ms` |
| `warn`  | `skill.shadowed`              | `skill`, `winner`, `losers[]` (each `{root,scope,source}`)  |
| `warn`  | `skill.sidecar_invalid`       | `file`, `reason`, `cause`                                   |
| `warn`  | `skill.name_changed`          | `skill`, `actual`, `path`                                   |
| `warn`  | `skill.path_unresolved`       | `path`, `cause`                                             |
| `debug` | `skill.rejected`              | `reason`, `dir`, `file`, `cause`                            |
| `debug` | `skill.field_defaulted`       | `skill`, `field`, `dir`, `chars`                            |
| `debug` | `skill.resource_skipped`      | `reason`, `path`                                            |
| `debug` | `skill.body_disclosed`        | `skill`, `chars`, `resources`                               |
| `debug` | `skill.resource_missing`      | `skill`, `rel`, `cause`                                     |
| `debug` | `skill.dir_unreadable`        | `path`, `cause`                                             |
| `debug` | `skill.realpath_failed`       | `path`, `cause`                                             |
| `debug` | `skill.handle_close_failed`   | `path`, `cause`                                             |
| `debug` | `skills.workspace.unreadable` | `path`, `cause`                                             |

`skills.discovered` is the record that answers "why is my skill not loaded": the
gap between `roots` and `skills`, plus a non-zero `dropped` or `shadowed`, is the
diagnosis, and the per-skill events name the individual manifests.
`skill.shadowed` is the one that answers "why did the wrong one win" — cross-root
precedence is last-wins and `.agents/skills` sits lowest, which is also how a
plugin bootstrap comes to be refused for a `foreign_root`.

Three of these repeat per item — `skill.rejected`, `skill.field_defaulted` and
`skill.resource_skipped` — so each is guarded by `levelEnabled(logger, "debug")`
before its bindings object is built. **No authored content is ever logged.** A
defaulted `description` is reported as `chars`, never as `value`; a disclosed
body as `chars`; a skill body, a frontmatter value and a sidecar's presentation
text never appear at all.

## Test architecture

The suite is classified by the boundary each test exercises:

- `tests/unit` owns the complete parser, schema, normalization, root-preset,
  bootstrap-policy and tool-rendering matrices;
- `tests/component` composes the catalog and skills capability over shared,
  contract-only fakes, and proves only activation and contribution wiring;
- `tests/integration` owns real discovery and shadowing, filesystem resources,
  confinement and symlink behavior. The public facade keeps only representative
  progressive-disclosure and refresh flows instead of replaying those matrices.

The package currently needs no contract, architecture or end-to-end tier.
Cross-package optional-loading and reverse-dependency guards belong to the loop,
which owns that seam.

## Development

Run commands from the monorepo root:

```bash
bun --filter @clarvis/skills build
bun --filter @clarvis/skills typecheck
bun --filter @clarvis/skills test
bun --filter @clarvis/skills test:unit
bun --filter @clarvis/skills test:component
bun --filter @clarvis/skills test:integration
bun --filter @clarvis/skills lint
bun --filter @clarvis/skills format:check
```

The package requires Bun 1.4.0 or newer.
