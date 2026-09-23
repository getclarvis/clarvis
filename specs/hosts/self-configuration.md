# Self configuration through file tools

## Admission and ownership

An eligible entry agent handles an operator's configuration request in the ordinary conversation
with the same file tools it uses for other workspace work. The file kernel provides a host-owned
`reviewMutation` port only when builtin tools are enabled, the run's immutable ceiling permits
editing, and the selected placement is Host or Sandbox. Agent Profiles, skills, hooks and edited
files cannot install that port or widen the ceiling. Container guests receive no host writer;
operator Settings, provider login and other administrative controls retain their own host APIs.
There is no separate configuration tool or slash command. The product-owned `clarvis-docs`
skill supplies a short catalog entry and loads its self-contained Markdown references on demand.
The guide does not grant write authority, change the effective configuration, or replace the
operator's request. Generic skills named by the user still follow normal discovery.

Production: `createFileKernel` in [file-kernel.ts](../../packages/kernel/src/file-kernel.ts),
`createAgentToolsCapability` in
[tools.ts](../../packages/loop/src/runtime/capabilities/tools.ts), and `dispatch` in
[core.ts](../../packages/tools/src/core.ts). Test: model-facing inventory, configuration review,
and denied paths in
[file-tool-configuration.test.ts](../../packages/kernel/tests/integration/file-tool-configuration.test.ts)
and [api.test.ts](../../packages/tools/tests/integration/api.test.ts).
The catalog, body/resource reads, absent slash route and dollar expansion are checked in
[configuration-surface.test.ts](../../packages/kernel/tests/integration/configuration-surface.test.ts).

## Product documentation skill

The maintained Markdown tree lives in
[clarvis-docs](../../packages/kernel/assets/skills/.system/clarvis-docs/SKILL.md) and its
`references` directory. `reconcileSystemDocs` in
[system-docs.ts](../../packages/kernel/src/skills/system-docs.ts) publishes only that reserved
subtree under the resolved global Clarvis skills directory. It verifies shipped release hashes,
checks ownership and path types, and replaces complete revisions under a lease. An unowned or
unsafe destination degrades the skill without changing user content. `createSystemDocsProvider` in
[system-docs-provider.ts](../../packages/kernel/src/skills/system-docs-provider.ts) captures the
installed body and resources for the current host generation without an execution directory.
Package-local Kernel modules derive the product root from the package identity; the Code launcher
passes the active product root explicitly to a bundled host. Source code does not resolve assets
through a `dist` layout.

The host reserves `clarvis-docs` from ordinary Extension Profile inventory and skill roots. A
workspace or plugin skill with the same name cannot replace the product entry. Existing
`use_skills` agents see it in the ordinary catalog. An entry agent without that grant receives a
system-only view only when its immutable run ceiling and selected Host or Sandbox placement admit
file editing and the host configuration-review port exists. Children and read-only or Container
agents receive no special view. The normal `load_skill` and `read_skill_resource` tools serve it;
loading a skill never approves a subsequent file mutation.

Production: `reconcileSystemDocs` in
[system-docs.ts](../../packages/kernel/src/skills/system-docs.ts), `createSystemDocsProvider` in
[system-docs-provider.ts](../../packages/kernel/src/skills/system-docs-provider.ts),
`buildRunDeps` in [build-run-deps.ts](../../packages/loop/src/runtime/build-run-deps.ts), and
`createSkillsCapability` in [capability.ts](../../packages/skills/src/capability.ts).
Test: [system-docs-publication.test.ts](../../packages/kernel/tests/unit/system-docs-publication.test.ts),
[system-docs-assets.test.ts](../../packages/kernel/tests/unit/system-docs-assets.test.ts),
[configuration-surface.test.ts](../../packages/kernel/tests/integration/configuration-surface.test.ts),
[system-docs-eligibility.test.ts](../../packages/kernel/tests/integration/system-docs-eligibility.test.ts),
[system-skill-invocation.test.ts](../../packages/kernel/tests/integration/system-skill-invocation.test.ts),
and [capability.test.ts](../../packages/skills/tests/component/capability.test.ts).

## Targets and file operations

`configurationRoots` identifies global and workspace `.clarvis` and `.agents` roots.
`configurationPathClass` distinguishes authoring, operational and private paths. File tools
classify canonical paths, including both ends of moves and copies, before dispatch; one protected
mutation sends the entire prepared batch to the host reviewer. Global access is limited to
classified file handlers and does not become a general shell or workspace mount. Private state,
credentials, trust records, symlinks, hardlinked leaves, special files, traversal and credential
filenames are refused. The selected skill's captured execution directory remains read-only; its
source can be changed through the reviewed route without changing the revision held by an active
run. The portable parent-directory replacement race remains documented in
[tools mutation](../execution/tools-mutation.md).

The normal `read_file`, `list_dir`, search and file metadata tools inspect admitted documents.
The normal `write_file`, `edit_file`, `multi_edit`, `apply_patch`, `replace`, `copy`, `move` and
`remove` tools prepare mutations where their existing grants allow them. A protected write does
not use shell approval as a substitute for configuration review. Validated documents are limited
to 256 KiB and strict UTF-8. Settings use the kernel schema, Agent Profiles use frontmatter
validation, skill manifests use the discovery parser, and workflows use their artifact parser.
Other authored formats retain their loader and trust checks. Protected destinations use private
file and directory modes. Existing documents bind to an exact captured revision; after review,
all target revisions and authority are checked again before atomic commit. A failed, denied,
cancelled or drifted batch leaves no partial mutation.

Production: `configurationTarget` in
[configuration.ts](../../packages/paths/src/configuration.ts),
`prepareConfigurationFileMutation` and `readConfigurationDocument` in
[files.ts](../../packages/kernel/src/configuration/files.ts),
`createAuthoringMutationReview` in
[authoring-mutations.ts](../../packages/kernel/src/configuration/authoring-mutations.ts),
and `applyOpsAtomic` in [atomic.ts](../../packages/tools/src/lib/atomic.ts).
Test: document schema, four-root, revision and link cases in
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts),
file-tool journeys in
[file-tool-configuration.test.ts](../../packages/kernel/tests/integration/file-tool-configuration.test.ts),
and rollback and private-mode cases in
[atomic.test.ts](../../packages/tools/tests/integration/atomic.test.ts),
[api.test.ts](../../packages/tools/tests/integration/api.test.ts),
[copy.test.ts](../../packages/tools/tests/integration/copy.test.ts) and
[move.test.ts](../../packages/tools/tests/integration/move.test.ts).

## Effect review and operator authority

Configuration and shell commands use the same host-owned authority reader and Judge coordinator,
with facts appropriate to each effect. The configuration path attests each destination, operation,
document class and revision through `createHostEffectReview`. Skill prose and model arguments are
untrusted context. Review Auto can allow an effect covered by authenticated operator evidence
without a human prompt. Review On asks once for the complete batch. Review Off does not relax
hard target or document validation. A generic command approval never authorizes a protected file
write. A refusal binds to the exact proposal; corrected bytes require a fresh decision.

A bounded complete review can offer `allow_session`. The prompt shows the effect, operation and
canonical targets. This volatile grant is recorded only after commit and is tied to the current
owner, session, controller epoch, outcome, authority revision and environment. A later batch must
fit one entire grant and still pass preparation, authority and revision checks. A new target,
effect or authenticated steer requires a new decision. Cancellation, run settlement and reconnect
retire the grant. A one-time approval never creates it. Concurrent identical reviews may share a
pending question, but a late answer cannot authorize an obsolete batch.

Production: `createConfigurationReview` in
[review.ts](../../packages/kernel/src/configuration/review.ts),
`createHostEffectReview` in [effect-review.ts](../../packages/kernel/src/guard/effect-review.ts),
and `grantConfigurationSession` and `configurationSessionCovers` in
[operator-authority.ts](../../packages/kernel/src/guard/operator-authority.ts).
Test: grant scope and revocation in
[configuration-review.test.ts](../../packages/kernel/tests/unit/configuration-review.test.ts),
file-tool prompt counts, refusal, drift and steer in
[file-tool-configuration.test.ts](../../packages/kernel/tests/integration/file-tool-configuration.test.ts),
and Judge authority behavior in
[effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

## Catalog and activation

A new skill joins a custom Extension Profile in the same reviewed transaction as its file; the
builtin default discovers it at the next safe catalog refresh without a membership write or
workspace approval for the standalone file alone.
The manager validates the definition and selection revisions and rolls back both if application
fails. Successful file writes request a coalesced catalog refresh; captured skill manifests and
resources keep the current run's bytes. The next safe generation publishes the new skill without
restarting the host. Saved provider, placement or Extension Profile settings that require a
reconnect remain pending until the operator applies them; file writes never change the occupied
runtime generation. Workspace trust carries only for the exact authorized bytes when all other
executable inputs remain stable, and does not make an untrusted workspace trusted.

Production: `prepareSkillInclusion`, `requestSkillRefresh` and `flushSkillRefresh` in
[extension-profile-manager.ts](../../packages/kernel/src/extension-profiles/extension-profile-manager.ts),
`captureSkillExecution` in
[execution-snapshot.ts](../../packages/skills/src/execution-snapshot.ts), and
`withOperatorWrite` in
[file-config-store.ts](../../packages/kernel/src/config/file-config-store.ts).
Test: membership, pending activation and subsequent skill use in
[file-tool-configuration.test.ts](../../packages/kernel/tests/integration/file-tool-configuration.test.ts),
catalog refresh in
[extension-profile-manager.test.ts](../../packages/kernel/tests/integration/extension-profile-manager.test.ts),
and captured resources in
[execution-snapshot.test.ts](../../packages/skills/tests/unit/execution-snapshot.test.ts).

## Related contracts

See [kernel config](kernel-config.md), [Extension Profiles](extension-profiles.md),
[skills](../execution/skills.md), [effect review](../execution/effect-review.md),
[elicitation](../cross-cutting/elicitation.md), [security](../cross-cutting/security.md),
and [isolated runtime](isolated-agent-runtime.md). The real interface evidence contract is the
repository's PTY validation workflow; deterministic fixtures alone do not qualify a provider or
platform journey.
