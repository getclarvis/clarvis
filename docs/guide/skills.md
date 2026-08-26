# Skills

> Package repeatable instructions and supporting resources into commands that users and agents can
> load only when needed.

## Create a workspace skill

Create a directory under `.clarvis/skills` with a `SKILL.md` file:

```text
.clarvis/skills/release-notes/
├── SKILL.md
├── references/
│   └── style-guide.md
└── examples/
    └── release.md
```

Use YAML frontmatter for discovery and Markdown for the instructions:

```md
---
name: release-notes
description: Draft concise release notes from a Git commit range.
argument-hint: "<from>..<to>"
user-invocable: true
allowed-tools:
  - shell
  - grep
  - read_file
---

Draft release notes for `$ARGUMENTS`.

1. Read `references/style-guide.md` before writing.
2. Group user-visible changes by outcome.
3. Omit internal refactors unless they change behavior.
4. Match the tone and structure in `examples/release.md`.
```

Run it from the input:

```text
/release-notes v0.0.0..HEAD
```

Every `$ARGUMENTS` or `{{args}}` placeholder is replaced with the text after the slash command. If
the body has no placeholder, Clarvis appends the task as a `Target` section instead.

## Choose where a skill lives

Clarvis reads skills from these locations, from lowest to highest precedence:

1. `~/.agents/skills`
2. `<workspace>/.agents/skills`
3. `~/.clarvis/skills`
4. `<workspace>/.clarvis/skills`

The highest-precedence skill wins when names collide. Clarvis reads `.agents/skills` for ecosystem
interoperability, but writes its own content under `.clarvis`.

An enabled plugin may also contribute skills. Plugin skills sit below personal and workspace skill
roots, keep their authored skill name, and can therefore be deliberately overridden by a local skill.

## Control invocation and tools

- `user-invocable: true` is the default and exposes `/<name>` in slash completion.
- `user-invocable: false` hides the slash command; it does not remove the skill from agent-driven
  progressive loading.
- `allowed-tools` is compatibility metadata. Clarvis preserves and validates it, but does not use it
  to change runtime permissions today; the selected agent determines the effective tools.
- `agent: reviewer` runs a slash-invoked skill as its own run on that agent. Without `agent`, the
  skill is inserted into the current turn. Plugin agents use the qualified form
  `agent: quality-kit:reviewer`.

`allowed-tools` also accepts a comma-separated string, and `tools` is an accepted alias. Prefer the
list form above because it is easier to review.

::: tip Keep the first load small
Clarvis discovers skill names and descriptions without eagerly loading every body. Put detailed
material in `references`, executable helpers in `scripts`, reusable input in `assets`, and samples in
`examples`. An agent can load those resources only after it chooses the skill.
:::

::: warning Skills are instructions, not a sandbox
A skill can direct an agent to use the tools of the selected agent. Review instructions and bundled
scripts before adding a third-party skill. Do not treat `allowed-tools` as an enforcement boundary.
:::

## See also

- [Plugins](/guide/plugins)
- [Hooks](/guide/hooks)
- [Extensions reference](/reference/extensions)
