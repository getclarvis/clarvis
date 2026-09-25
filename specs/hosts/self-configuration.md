# Self configuration through file tools

## Purpose and authority

An agent can edit configuration documents with the ordinary file tools available to its profile.
Relative paths resolve from the workspace; absolute paths remain absolute. File calls do not enter a
configuration approval path. The effective host filesystem permissions or configured native
sandbox determine whether a path can be accessed. Configuration loaders still validate documents
when the host consumes them, and workspace trust still controls activation of workspace-owned
executable configuration.

Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts), `resolveToolPath` in
[paths.ts](../../packages/tools/src/lib/paths.ts), `resolveFilesystemPolicy` in
[sandbox.ts](../../packages/tools/src/sandbox.ts), and `createFileKernel` in
[file-kernel.ts](../../packages/kernel/src/file-kernel.ts).
Test: [no-isolation.test.ts](../../packages/tools/tests/integration/no-isolation.test.ts),
[sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts), and
[configuration-surface.test.ts](../../packages/kernel/tests/integration/configuration-surface.test.ts).

## Product documentation skill

The product-owned [clarvis-docs](../../packages/kernel/assets/skills/.system/clarvis-docs/SKILL.md)
skill explains configuration paths and the active filesystem boundary. `reconcileSystemDocs` in
[system-docs.ts](../../packages/kernel/src/skills/system-docs.ts) installs its verified asset tree
under the global skills root. `createSystemDocsProvider` in
[system-docs-provider.ts](../../packages/kernel/src/skills/system-docs-provider.ts) captures its
body and resources for a host generation. The product reserves the skill name against workspace
and plugin overrides; loading the skill itself grants no tool capability.

Production: `reconcileSystemDocs` in [system-docs.ts](../../packages/kernel/src/skills/system-docs.ts),
`createSystemDocsProvider` in
[system-docs-provider.ts](../../packages/kernel/src/skills/system-docs-provider.ts), and
`createSkillsCapability` in [capability.ts](../../packages/skills/src/capability.ts).
Test: [system-docs-publication.test.ts](../../packages/kernel/tests/unit/system-docs-publication.test.ts),
[system-docs-assets.test.ts](../../packages/kernel/tests/unit/system-docs-assets.test.ts), and
[configuration-surface.test.ts](../../packages/kernel/tests/integration/configuration-surface.test.ts).

## Invariants and coupling

The file tool dispatcher does not confer additional filesystem authority for configuration files.
The selected native sandbox, when present, applies to the sandbox file service as it does to
commands. Configuration and trust services remain responsible for loading and activating authored
documents after the file operation. A run's captured skill content remains stable until the next
catalog generation.

Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts), `SandboxAgentFilesystem` in
[filesystem-service.ts](../../packages/tools/src/filesystem-service.ts),
`createFileConfigStore` in [file-config-store.ts](../../packages/kernel/src/config/file-config-store.ts), and
`captureSkillExecution` in [execution-snapshot.ts](../../packages/skills/src/execution-snapshot.ts).
Test: [sandbox.test.ts](../../packages/tools/tests/integration/sandbox.test.ts),
[configuration-documents.test.ts](../../packages/kernel/tests/integration/configuration-documents.test.ts), and
[execution-snapshot.test.ts](../../packages/skills/tests/unit/execution-snapshot.test.ts).
