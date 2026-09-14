# Direct self configuration

## Ownership and admission

The operator requests configuration changes in the ordinary conversation. The file kernel installs
`configure_clarvis` under the run's editing ceiling; an editable Agent Profile cannot install this
capability. Host and Sandbox retain their configured runtime and entry agent. The builtin
`clarvis-configure` skill is optional guidance with no agent override. Loading its body neither grants
access nor requires the operator to repeat the request as a slash command. Host/environment skill
gates still apply, including to this embedded guide.

An explicit configuration skill request in Docker/Podman fails because skills are unavailable. The
guest configuration service is read-only and the Code facade routes authenticated settings/model/
login actions to operator services on the host. Saved changes remain pending until an explicit
reconnect; they never mutate the active generation or switch placement.

Production: `createDirectConfigurationCapability` in
[direct-configuration.ts](../../packages/kernel/src/configuration/direct-configuration.ts),
`createFileKernel` in [file-kernel.ts](../../packages/kernel/src/file-kernel.ts),
`withBuiltinSkills` in [builtin-skills.ts](../../packages/kernel/src/skills/builtin-skills.ts),
and the configuration admission check in
[settings-assembler.ts](../../packages/kernel/src/runs/settings-assembler.ts).
Test: ordinary creation/use/edit in all guard modes in
[direct-configuration.test.ts](../../packages/kernel/tests/integration/direct-configuration.test.ts),
and pre-inference container rejection in
[native-configuration.test.ts](../../packages/kernel/tests/integration/native-configuration.test.ts).

## Authority and review

The writer consumes the run's `OPERATOR_AUTHORITY_PORT` and the same `EffectReviewService` as the
command guard. Skill text, tool arguments and model justification cannot manufacture operator
evidence. A missing authority seed does not fall back to user-role transcript scraping: automatic
review cannot authorize that operation. The host owns evidence, binding and revocation as specified
by [command guard](../execution/command-guard.md).

Before mutation, the restricted writer validates the target, schema and expected revision, then
attests an effect. Authoring and operational writes use separate descriptors; operational authority
never follows implicitly from permission to edit a skill. The reviewer receives the prepared
sanitized request and current document, operation, document class and the digest of the before/after revisions. Human mode elicits one concrete `configuration_review` for that operation;
auto mode can allow a covered effect. Command guard `off` does not disable restricted-writer
validation or operational review. There is no general self-configuration consent setting. A human refusal rejects the concrete prepared change; it does not prohibit every future revision of the same target. The shared authority state retains a bounded identity for the complete refused batch, including target and before/after revisions. Switching between `edit` and `write` with identical resulting bytes does not open another prompt at the same evidence revision. A corrected proposal must undergo its own policy decision, while an authenticated steer can restrict or revoke the broader effect. Human prompts identify why the current policy requires intervention when automatic review cannot authorize the effect.

Production: `denyAuthorityEffect` in [operator-authority.ts](../../packages/kernel/src/guard/operator-authority.ts) and `createEffectReviewService` in [effect-review-service.ts](../../packages/kernel/src/guard/effect-review-service.ts). Test: exact refusal, equivalent edit/write, corrected bytes, continuation and fresh intent in [effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts), bounded and revision-fenced storage in [operator-authority.test.ts](../../packages/kernel/tests/unit/operator-authority.test.ts).

Host-admitted steer arrival updates authority while a review is open, without prematurely
acknowledging model delivery. After asynchronous review, cancellation and authority revision are
checked again. The real writer
then rechecks the expected document revision. Drift while a prompt is open returns conflict and
requires preparing against current bytes; an old approval cannot overwrite the new document.
Workspace writes use `withOperatorWrite`: only the authorized target revision carries prior
trusted/inert status, with all other executable inputs unchanged. This does not approve an
untrusted workspace or unrelated external changes.

Production: `createDirectConfigurationCapability`, `configurationFileMutationFacts` and
`configurationFileOperation` in [files.ts](../../packages/kernel/src/configuration/files.ts),
`attestConfiguration` in [configuration.ts](../../packages/kernel/src/guard/effects/configuration.ts),
and `withOperatorWrite` in [file-config-store.ts](../../packages/kernel/src/config/file-config-store.ts).
Test: prompt counts, human denial, independently reviewed corrected proposals, drift during review and exact trust carry in
[direct-configuration.test.ts](../../packages/kernel/tests/integration/direct-configuration.test.ts)
and [configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts).

## File operations

`configurationRoots` resolves the four existing global/workspace Clarvis/shared roots without
creating or authorizing them. `configurationPathClass` owns the common authoring, operational and
private vocabulary. File tools consume it through `isCanonicalAuthoringPath`; the writer consumes
it directly. Classification grants nothing and does not replace canonical target or link checks.
Production: [paths configuration](../../packages/paths/src/configuration.ts) and
[authoring-path.ts](../../packages/tools/src/guard/authoring-path.ts).
Test: [configuration.test.ts](../../packages/paths/tests/unit/configuration.test.ts) and
[api.test.ts](../../packages/tools/tests/integration/api.test.ts).

`configure_clarvis` accepts these operations:

| Operation | Inputs beyond `root` and relative `path` | Result |
| --- | --- | --- |
| `list` | empty path lists a root | at most 200 allowed names and kinds, with truncation/missing indicators |
| `read` | none | UTF-8 content and SHA-256 revision, or null content/revision for an absent file |
| `write` | complete `content`, `expected_revision` | atomic replacement; null revision creates an absent file |
| `edit` | `old_text`, `new_text`, `expected_revision` | replace exactly one occurrence, preserving the remaining bytes, including a UTF-8 BOM and line endings |
| `delete` | `expected_revision` | remove one existing regular file |

Stale or omitted revisions, empty/ambiguous/missing edit matches, malformed settings JSON and settings
schema violations reject without writing. Settings validation uses the owning kernel schema. Agent Profile frontmatter rejects unknown fields; skill manifests use the same bounded parser as
discovery before any mutation. Other
authored formats retain their normal loader validation and trust checks. File reads and writes are
bounded to 256 KiB; new parents and files use the shared private modes.

Clarvis roots permit `settings.json`, context/policy prompts, and authored `agents`, `skills`,
`plugins`, `workflows`, `extension-profiles` and `runtime-recipes` trees. Shared roots permit `skills`,
`plugins` and `marketplace.json`. Private state, cache, exports, worktrees, keys, subscriptions, auth,
trust records, credential-like filenames, `.env` files and private key files are excluded. Paths
reject traversal, absolute/alternate separators, control characters, Windows devices and alternate
streams. Stable symlink paths, hardlinked leaves and special files are refused. Read descriptors
are checked against the inspected inode and decoded as strict UTF-8. Writes use the shared atomic
replacement helper. Tool envelopes persist operation, root and relative path instead of raw file
content, expected revisions or edit snippets.

This is mediated file access, not an OS isolation boundary. Another process replacing a
parent between validation and mutation remains the documented portable filesystem TOCTOU limit.
Revision checking detects an already changed source; it does not lock out an unrelated external
editor between comparison and replacement. Filename exclusions do not detect every secret an
operator embeds inside an allowed authored document. Changing executable declarations can affect
future authorized runs; the writer never executes them to validate a change.

Production: `configurationFileOperation` in [files.ts](../../packages/kernel/src/configuration/files.ts)
and `createConfigurationCapability`. Test: `native configuration files` in
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts) covers
all four roots, edits, stale revisions, settings validation, private paths, traversal, links and
bounded reads; the direct-configuration integration test exercises the tool through the real loop.

## Catalog generations and execution resources

Authorized writer completion notifies the Extension Profile manager directly. Standalone source
watchers request the same coalesced refresh. Refresh waits until captured resource users settle;
it does not wait for its own run inside a tool or cancel background work. The writer returns
`application: pending` for skill changes and explains that the current turn retains its catalog,
with automatic application after captured users settle. Invalid replacement
metadata preserves the previous catalog. Creation prepares the exact new-skill membership alongside
the file effect. A workspace custom profile gains only that skill; a global custom profile is copied
and selected for this workspace without changing global defaults. The same review covers the file
and membership, with revision conflicts checked before either lands. Existing exclusions remain.
An explicit global command-line selector cannot be silently replaced. `prepareSkillInclusion`
uses the existing definition and selection leases and rolls back its companion writes if the skill
write fails. The next idle generation and a newly opened kernel both see the saved membership.
Agent Profiles enter the next applicable assembly, without enlarging an already-running ceiling.

The loop materializes bounded skill manifests and enumerated resources. Helper paths and resource
reads use the same captured bytes. Source editing does not rewrite already-sent instructions.
Verification surrounds materialization; disposal releases captured files. Full resource reads
preserve their size errors and chunked reads preserve pagination. A failed candidate does not leak
its execution files. Ordinary standalone refresh keeps the host process alive.

`LocalHostStatus.skills_revision` notifies Code of catalog generations. The workspace client
publishes this revision to command discovery; connection identity stays unchanged.

Production: `requestSkillRefresh` and `flushSkillRefresh` in
[extension-profile-manager.ts](../../packages/kernel/src/extension-profiles/extension-profile-manager.ts),
`snapshotSkills` in [build-run-deps.ts](../../packages/loop/src/runtime/build-run-deps.ts),
`captureSkillExecution` in [execution-snapshot.ts](../../packages/skills/src/execution-snapshot.ts),
and [workspace-client-manager.ts](../../packages/code/src/adapters/workspace-client-manager.ts).
Test: [extension-profile-manager.test.ts](../../packages/kernel/tests/integration/extension-profile-manager.test.ts),
[execution-snapshot.test.ts](../../packages/skills/tests/unit/execution-snapshot.test.ts), and
[execute-run-entrypoints.test.ts](../../packages/loop/tests/integration/execute-run-entrypoints.test.ts).

## Coupling and validation

Settings and host-pinned services retain their owning application boundaries in
[kernel config](kernel-config.md), [Extension Profiles](extension-profiles.md),
[skills](../execution/skills.md), [capability composition](../engine/capability-composition.md),
[grants](../cross-cutting/grants.md), [elicitation](../cross-cutting/elicitation.md),
and [isolated runtime](isolated-agent-runtime.md). Saving an operational document does not mutate
an active run's captured settings, credentials, mounts or placement. Credentials remain managed by
host services, not this writer. No secret may be inferred from loading guidance.

Builtin configuration examples remain owned by `CONFIGURATION_EXAMPLES` in
[configuration-examples.ts](../../packages/kernel/src/skills/configuration-examples.ts).
Their syntax and loader behavior are tested in
[configuration-guidance.test.ts](../../packages/kernel/tests/integration/configuration-guidance.test.ts).
The real interface evidence contract is the repository's PTY validation workflow; deterministic
fixtures alone do not establish a completed interactive journey or platform qualification.

## Prepared file-tool batches

Ordinary entry-agent file tools bind a host-owned `MutationReview` through guard resolution. Only tools whose mutations reach this callback defer their initial authoring review. The host validates every resulting authored document before reviewing a complete batch, including common workspace targets and any new skill membership. Operational or private destinations cannot enter this path. Review uses the same authority reader and `EffectReviewService` as the restricted writer. Captured revisions are rechecked before staging; drift, invalid content, denial or cancellation leave the batch unapplied. The existing portable parent-directory TOCTOU limitation remains.

When the entry agent first asks the operator about that bounded edit through `ask_user`, an accepted
answer becomes fresh evidence before the next mutation review. The effect judge receives both the
authenticated answer and its model-authored question, with the latter marked as untrusted context;
it must still decide that the answer covers the prepared target and diff. A declined or dismissed
question grants nothing.

`withOperatorWrite` accepts exact target revisions for synchronous or asynchronous batches. Trust carries only after settlement and only if every unrelated executable input remains unchanged. Skill membership leases cover the async transaction; failures restore companion definition/selection bytes. Successful writes notify the catalog directly, even without a working watcher.

Production: `createAuthoringMutationReview` in [authoring-mutations.ts](../../packages/kernel/src/configuration/authoring-mutations.ts), `createConfigurationReview` in [review.ts](../../packages/kernel/src/configuration/review.ts), `MutationReview` in [atomic.ts](../../packages/tools/src/lib/atomic.ts), and `withOperatorWrite` in [file-config-store.ts](../../packages/kernel/src/config/file-config-store.ts).
Test: file-tool journeys, custom membership and mixed-patch denial/drift in [direct-configuration.test.ts](../../packages/kernel/tests/integration/direct-configuration.test.ts); asynchronous trust carry and unrelated drift in [workspace-trust.test.ts](../../packages/kernel/tests/integration/workspace-trust.test.ts).
