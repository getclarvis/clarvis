# Clarvis

[![Release](https://img.shields.io/github/v/release/getclarvis/clarvis-releases?include_prereleases&label=release)](https://github.com/getclarvis/clarvis-releases/releases)
[![CI](https://github.com/getclarvis/clarvis/actions/workflows/ci.yml/badge.svg)](https://github.com/getclarvis/clarvis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Clarvis is a local-first coding agent that brings models, tools, plans, memory, and multi-agent
workflows into one terminal interface. Start it inside a project, choose a model, and work with the
repository in front of you.

> **Beta:** `0.1.0` is a pre-1.0 release. Interfaces and pre-1.0 state formats may change, and
> the portable artifacts are not yet code-signed or notarized. Clarvis can read and change files and
> run commands; review approval prompts and use source control.

![Clarvis first-run setup with the responsive splash in a terminal](.github/assets/clarvis-setup.svg)

## Why Clarvis

- **One project-aware TUI:** sessions, transcript, plans, memory, tasks, and run activity stay in one
  discoverable interface.
- **Bring your model:** configure API providers, OpenAI-compatible local endpoints, or the beta
  ChatGPT and Grok subscription flows for eligible accounts. Availability is provider-controlled and
  does not imply provider endorsement of Clarvis.
- **Agent workflows:** use a built-in Lead, delegate to focused Sub-agents, or run the packaged
  `audit`, `implement`, and `research` workflows.
- **Controlled tool use:** path-based workspace confinement, command review, optional native
  sandboxing on Linux and macOS, and explicit workspace trust are separate safeguards.
- **Extensible:** add MCP servers, plugins, hooks, Agent Skills, custom agents, and workflows.
- **Interactive or headless:** use the full TUI or run a prompt from scripts with `clarvis -p`.

## Install the beta

Portable releases include the exact Bun runtime and native OpenTUI dependencies. **Users do not
need Bun, Node.js, a compiler, a package manager, administrator access, or a source checkout.**

Linux (glibc) and macOS:

```bash
curl -fsSL https://github.com/getclarvis/clarvis-releases/releases/download/v0.1.0/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/getclarvis/clarvis-releases/releases/download/v0.1.0/install.ps1 | iex
```

Prefer to inspect an installer before running it? The [installation guide](https://clarvis.dev/installation)
keeps the download, review, and execute flow as an alternative.

Verify the command:

```bash
clarvis --version
```

The installers download a versioned archive from GitHub Releases, verify its SHA-256 checksum,
confirm that the staged CLI reports the requested version, and activate it only after every check
succeeds. On Linux or macOS, follow the printed instruction if the resolved launcher directory
(`${CLARVIS_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}`) is not already on `PATH`. Windows adds the
managed launcher to the user `PATH`; an existing terminal may need to be reopened.

The release workflow is configured for glibc-based Linux, macOS, and Windows on x64 and arm64. The
beta Linux archives do not target Alpine or other musl-only distributions. Platform claims remain
beta-level until the corresponding native release job has completed. See
[Installation](https://clarvis.dev/installation) for prerequisites, manual verification, configured targets,
unsigned-binary warnings, PATH behavior, and removal.

## First run

Run Clarvis from the project you want it to work on:

```bash
cd /path/to/your/project
clarvis
```

On a clean installation:

1. Press `Enter` to start the short setup.
2. Connect a provider or local OpenAI-compatible endpoint and select a model.
3. Enter the requested credential when the provider requires one. Clarvis stores credentials in
   the global user configuration, not in the project.
4. Describe the work in the composer. Clarvis starts with the built-in `marshall` Lead and an
   approval-oriented safety profile.

The current directory is the workspace boundary. Global configuration defaults to `~/.clarvis`;
project-specific configuration lives in `<project>/.clarvis`.

Essential controls:

| Input     | Action                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `/help`   | Open the complete, context-aware help screen                             |
| `Esc`     | Clear the current input, close a layer, or return to the previous screen |
| `Ctrl+C`  | Cancel active work; when idle, enter the quit flow                       |
| `/doctor` | Inspect configuration, dependencies, and recoverable setup problems      |
| `/model`  | Choose the default model                                                 |
| `/effort` | Choose the default reasoning effort supported by that model              |

Other shortcuts depend on the terminal keyboard profile and appear in the footer and `/help`; the
README does not duplicate a keymap that the application generates dynamically.

## Common commands

```bash
clarvis                                  # interactive TUI in the current directory
clarvis --continue                       # resume this workspace's latest session
clarvis --list                           # list saved sessions
clarvis -p "explain this repository"     # headless text response
clarvis -p "review this change" --format md
clarvis --worktree                       # create a generated dedicated Git worktree
clarvis --worktree focused-fix           # create or reopen a named worktree
clarvis --ascii                          # use ASCII glyphs
clarvis --update                         # update a managed portable installation
clarvis --help                           # complete CLI reference
```

Self-update is explicit; ordinary startup performs no update check. A prerelease follows newer
prereleases and the later stable promotion, while a stable installation ignores prereleases.
Source checkouts and `bun link` installations deliberately refuse self-update.

See the [public user guide](https://clarvis.dev/guide/daily-use) for sessions, headless mode,
worktrees, configuration, extensions, data locations, and diagnostics. See
[Terminal compatibility](https://clarvis.dev/terminal-compatibility) for Unicode, color, keyboard profiles,
remote terminals, and current accessibility limits.

## Security model

Clarvis is local-first, but it is not an offline application and it is **not itself a security
sandbox**:

- prompts and selected context are sent to the model provider you configure;
- enabled MCP servers, plugins, hooks, task providers, and commands have their own trust boundaries;
- file tools reject paths outside the workspace by default, but this path-based check is not a strong
  write sandbox against a concurrent symlink or junction swap; host execution and user-approved
  operations can also reach beyond a sandboxed process;
- credentials saved through the managed API-key and subscription flows stay in global files. POSIX
  installs apply owner-only mode bits; Windows relies on the user's profile access controls. Literal
  provider or MCP headers can be authored in workspace settings, so use `${NAME}` references and
  never place a secret there;
- the model catalog, marketplace, subscription login, and updater may make explicit network
  requests.

Read the [public security overview](https://clarvis.dev/operations/security) before using Clarvis on
sensitive code. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md); do not
open a public issue for a suspected vulnerability.

## Documentation and support

The public, task-oriented documentation lives at [clarvis.dev](https://clarvis.dev). English is
served from the site root, and the complete Brazilian Portuguese edition is available at
[`/pt-BR/`](https://clarvis.dev/pt-BR/).

| Need                                  | Start here                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Browse the public product guide       | [clarvis.dev](https://clarvis.dev)                                                                       |
| Install, update, verify, or remove    | [Installation](https://clarvis.dev/installation)                                                         |
| Learn the TUI and CLI                 | [Public user guide](https://clarvis.dev/guide/daily-use)                                                 |
| Terminal or accessibility behavior    | [Terminal compatibility](https://clarvis.dev/terminal-compatibility)                                     |
| Diagnose a problem                    | [Troubleshooting](https://clarvis.dev/operations/troubleshooting) or [Support](SUPPORT.md)               |
| Understand Clarvis                    | [How Clarvis works](https://clarvis.dev/explanation/how-clarvis-works)                                   |
| Contribute code                       | [Contributing](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md)                                               |
| Contribute public documentation       | [`getclarvis/docs`](https://github.com/getclarvis/docs)                                                  |
| Inspect exact behavior and invariants | [Specification index](specs/README.md)                                                                   |
| Follow releases                       | [Changelog](CHANGELOG.md) and [GitHub Releases](https://github.com/getclarvis/clarvis-releases/releases) |

## Contributing

The commands below are **for contributors working from a source checkout**, not for people who
installed a portable release. Development uses Bun exactly `1.4.0`, pinned by `mise.toml`.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). It covers the clone/bootstrap flow, targeted checks,
the documentation contract, TUI validation in a real PTY, and pull-request expectations. Human and
AI contributors should also read [AGENTS.md](AGENTS.md) before editing the monorepo.

The public site source and its deployment workflow are owned by the separate
[`getclarvis/docs`](https://github.com/getclarvis/docs) repository. This monorepo owns product
implementation, package READMEs, specifications, release tooling, and contributor documentation; it
does not build or deploy GitHub Pages.

To install a source-only command from this checkout after Bun is available, run:

```bash
./dev-install.sh
```

That one-time machine setup installs dependencies, configures the repository hook, and creates
`clarvis-develop` in `${CLARVIS_DEV_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}`. Run the command
from any project to test the current checkout without building or downloading a release. Use
`clarvis-develop --empty-workspace` to open every test in a new directory under
`/tmp/clarvis-development-temp/`. `clarvis-develop --clear` removes the effective global state and
all managed temporary workspaces and exits; workspace-local `.clarvis` data outside that temporary
root is not removed. Combine both flags to clear first and then open a newly allocated workspace.

## Packages

Clarvis is one product made from 18 private, unversioned workspace packages. They are implementation
units and are not published independently.

| Package                                        | Role                | Path                   | Description                                                  |
| ---------------------------------------------- | ------------------- | ---------------------- | ------------------------------------------------------------ |
| [`@clarvis/capability`](packages/capability)   | foundation          | `packages/capability`  | Cross-cutting capability and port contracts.                 |
| [`@clarvis/paths`](packages/paths)             | foundation          | `packages/paths`       | Global, workspace, and generated-state directory vocabulary. |
| [`@clarvis/protocol`](packages/protocol)       | host contract       | `packages/protocol`    | Transport-neutral Kernel client contract.                    |
| [`@clarvis/llm`](packages/llm)                 | execution service   | `packages/llm`         | Provider layer behind the `LLMProvider` port.                |
| [`@clarvis/mcp-client`](packages/mcp-client)   | execution service   | `packages/mcp-client`  | MCP transports, connections, and pooling.                    |
| [`@clarvis/supervision`](packages/supervision) | execution service   | `packages/supervision` | Run-scoped parent/child observation and control.             |
| [`@clarvis/trace`](packages/trace)             | execution service   | `packages/trace`       | Run trace recording, persistence, and wire projection.       |
| [`@clarvis/tools`](packages/tools)             | execution service   | `packages/tools`       | Coding, filesystem, shell, and monitor tools.                |
| [`@clarvis/hooks`](packages/hooks)             | execution service   | `packages/hooks`       | Operator-declared workspace hook execution.                  |
| [`@clarvis/skills`](packages/skills)           | execution service   | `packages/skills`      | `SKILL.md` discovery and progressive loading.                |
| [`@clarvis/loop`](packages/loop)               | engine              | `packages/loop`        | Embeddable agent-loop engine.                                |
| [`@clarvis/memory`](packages/memory)           | product capability  | `packages/memory`      | Markdown memory wiki, search, and indexing.                  |
| [`@clarvis/plan`](packages/plan)               | product capability  | `packages/plan`        | Provider-neutral plans and review gates.                     |
| [`@clarvis/tasks`](packages/tasks)             | product capability  | `packages/tasks`       | External task-management adapters and tools.                 |
| [`@clarvis/workflows`](packages/workflows)     | product capability  | `packages/workflows`   | Multi-agent workflow scheduling and records.                 |
| [`@clarvis/kernel`](packages/kernel)           | host implementation | `packages/kernel`      | In-process implementation and composition root.              |
| [`@clarvis/code`](packages/code)               | application         | `packages/code`        | The terminal UI distributed as `clarvis`.                    |
| [`@clarvis/server`](packages/server)           | application         | `packages/server`      | Authenticated MCP-over-HTTP facade, currently source-only.   |

The [architecture overview](https://clarvis.dev/explanation/how-clarvis-works) explains the product
model. The generated
[package coupling report](specs/package-coupling-analysis.md) is the exact graph authority.

## License

Clarvis is available under the [MIT License](LICENSE). Portable archives also contain the applicable
third-party notices and license texts described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
