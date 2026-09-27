# Self configuration through file tools

## Purpose and authority

An agent can edit configuration documents with the ordinary file tools available to its profile.
Relative paths resolve from the workspace; absolute paths remain absolute. Kernel-bound file calls
use the same action authorization and selected execution policy as other built-in tools. The file
Kernel defaults to Sandbox; configuration paths have no unconditional write exception. Workspace
metadata is read-only by default, and writes beyond admitted roots require an eligible permission
decision. Host OS permissions remain an outer bound. There is no separate configuration-content
review before the write.
Configuration loaders still validate documents when the host consumes them, and workspace trust
still controls activation of workspace-owned
executable configuration.

Production: `dispatch` in [core.ts](../../packages/tools/src/core.ts), `resolveFileToolPath` in
[paths.ts](../../packages/tools/src/lib/paths.ts), and `createFileKernel` in
[file-kernel.ts](../../packages/kernel/src/file-kernel.ts).
The per-action boundary is owned by [native execution](../execution/sandbox.md) and
[automatic approval](../execution/judge.md). Production: `prepareToolAction` in
[action.ts](../../packages/tools/src/execution/action.ts) and `createApprovalService` in
[approval-service.ts](../../packages/kernel/src/execution/approval-service.ts).
Test: [action-authorization.test.ts](../../packages/tools/tests/integration/common/action-authorization.test.ts),
[approval-policy.test.ts](../../packages/kernel/tests/integration/approval-policy.test.ts),
[host-access.test.ts](../../packages/tools/tests/integration/common/host-access.test.ts) and
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
Test: [system-docs-publication.test.ts](../../packages/kernel/tests/integration/system-docs-publication.test.ts),
[system-docs-assets.test.ts](../../packages/kernel/tests/integration/system-docs-assets.test.ts), and
[configuration-surface.test.ts](../../packages/kernel/tests/integration/configuration-surface.test.ts).

## Invariants and coupling

The file tool dispatcher does not confer additional filesystem authority for configuration files.
Configuration and trust services remain responsible for loading and activating authored
documents after the file operation. A run's captured skill content remains stable until the next
catalog generation.

`dispatch` in [core.ts](../../packages/tools/src/core.ts),
`createFileConfigStore` in [file-config-store.ts](../../packages/kernel/src/config/file-config-store.ts), and
`captureSkillExecution` in [execution-snapshot.ts](../../packages/skills/src/execution-snapshot.ts).
Test: [configuration-documents.test.ts](../../packages/kernel/tests/integration/configuration-documents.test.ts), and
[execution-snapshot.test.ts](../../packages/skills/tests/integration/execution-snapshot.test.ts).
