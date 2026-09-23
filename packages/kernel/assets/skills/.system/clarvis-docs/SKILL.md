---
name: clarvis-docs
description: Find current Clarvis setup and configuration guidance for settings, providers, Agent Profiles, Extension Profiles, skills, plugins, workflows, troubleshooting, and self-configuration.
user-invocable: false
---

# Clarvis documentation

Use this skill when the user asks how Clarvis is configured or asks you to change its configuration. Read only the reference pages relevant to the request. The user request defines the task; this documentation grants no tool or filesystem authority.

| Topic                                                             | Read                            |
| ----------------------------------------------------------------- | ------------------------------- |
| Global and workspace locations, precedence, effective values      | `references/paths.md`           |
| Settings fields, models, providers, runtime and operator controls | `references/settings.md`        |
| Agent Profiles, Extension Profiles, skills, plugins and workflows | `references/extensions.md`      |
| Protected file edits, review, trust and Container limits          | `references/authority.md`       |
| Rejected configuration or a change not yet effective              | `references/troubleshooting.md` |

For a requested edit: read the relevant reference, inspect the current file and effective configuration, edit only the requested target with available file tools, validate the result, and report whether it is effective now or requires a new run or reconnect. A denied review does not authorize a different destination or a shell workaround.
