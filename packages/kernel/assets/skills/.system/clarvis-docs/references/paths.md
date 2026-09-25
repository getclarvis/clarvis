# Configuration locations and precedence

There are two scopes and two source families. The global Clarvis root is `CLARVIS_HOME` when set, otherwise `~/.clarvis`; the workspace Clarvis root is `<workspace>/.clarvis`. The compatible agent roots are `~/.agents` and `<workspace>/.agents`. `CLARVIS_HOME` changes the global `.clarvis` root, not the global `.agents` root.

| Content                          | Global                                                    | Workspace                                                |
| -------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Clarvis settings                 | `<global Clarvis root>/settings.json`                     | `<workspace>/.clarvis/settings.json`                     |
| Agent Profiles                   | `<global Clarvis root>/agents/`                           | `<workspace>/.clarvis/agents/`                           |
| Extension Profiles and workflows | `<global Clarvis root>/extension-profiles/`, `workflows/` | `<workspace>/.clarvis/extension-profiles/`, `workflows/` |
| Standalone skills                | `~/.agents/skills/`                                       | `<workspace>/.agents/skills/`                            |
| Plugins                          | `~/.agents/plugins/`                                      | `<workspace>/.agents/plugins/`                           |

The private global `keys.json` and `subscriptions.json` files belong under the global Clarvis root; they are not agent-authored documents. Never look for `settings.json`, credentials, Agent Profiles, Extension Profiles, or workflows under `.agents`. The global Clarvis `skills/.system/clarvis-docs/` directory contains this product documentation and is not a user-selectable skill.

Settings are parsed and merged by scope. Use the Settings interface to inspect the effective value Clarvis currently uses; read a settings file to inspect its authored value. A file on disk may be inactive because of scope, workspace trust for executable settings or repository plugins, custom Extension Profile selection for standalone skills, or a pending reconnect. A standalone skill file alone does not require workspace trust; `builtin:default` discovers it automatically after a safe catalog refresh. Do not assume that a workspace value overrides every global field: merge behavior depends on the field. Ask the Settings interface for the effective result before claiming that a saved change is active.
Execution Memory's on/off choice is global: Ctrl+X M writes `memory.enabled` in the global settings file, and a workspace `memory.enabled` value cannot override it.
