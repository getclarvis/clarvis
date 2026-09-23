# Host-attested effects and operator authority

## Scope

This contract owns the transactional review of an operational configuration change. Its host
descriptor vocabulary, authority envelope, compiler, ledger and refusals serve protected
configuration file tools through `reviewMutation` and their operational
content mutations. It does not intercept a shell command. Command authorization is one
deterministic policy plus one Judge review path, owned by
[command-guard.md](command-guard.md); a command compiles no envelope, consumes no grant and reads no
rollout stage.

## Trust boundaries

Host-captured global and workspace context documents are persistent operator instructions.
Within each scope, `CLARVIS.md` wins over the fallback `AGENTS.md`; workspace instructions refine
global instructions within their scope, and direct operator restrictions take precedence.
Reviewer guidance, other files and model-authored text cannot create authority.
Authenticated start/continue text, applied operator steers and accepted entry-agent `ask_user`
answers are evidence. For `ask_user`, the
model-authored question is retained only as untrusted context for interpreting the authenticated
answer. The reviewer interprets that evidence; the host resolves
effects and targets and validates every grant. A descriptor, not model prose, defines the maximum
inference and constraints. The neutral vocabulary belongs to capability, syntax to tools, and the
registry, ledger, compiler and policy to kernel. `ToolEffect` retains its separate scheduling role.

Production: `OperatorAuthorityReader` in
[operator-authority.ts](../../packages/capability/src/operator-authority.ts),
`createGuardEffectRegistry` in [registry.ts](../../packages/kernel/src/guard/effects/registry.ts),
and `validateAuthorityEnvelope` in
[effect-review.ts](../../packages/kernel/src/guard/effect-review.ts).
Test: [effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

## Evidence and lifetime

The settings assembler captures the same context records used by the work agent through a private
request-identity association. Preparation transfers that association when cloning the request;
ordinary runs and workflow managers admit it only alongside a host-issued authority seed. Public
JSON cannot supply these instructions. Each record includes scope, source basename, content and
a SHA-256 content identity. Instruction IDs may support validated objectives and grants without
bypassing descriptor ceilings, inherited ceilings, exclusions or human-only effects. Instructions
are sanitized in the ledger and retained in its checkpoint state. Changes between continuations
invalidate compiled grants and cached refusals; edits during a run do not replace its snapshot.
Root context documents follow the existing context reader, not executable-workspace trust approval.

Production: `captureRunInstructions`, `transferRunInstructions` and `seedRunInstructions` in
[instruction-snapshot.ts](../../packages/kernel/src/runs/instruction-snapshot.ts),
`createOperatorAuthorityRuntime` in
[operator-authority.ts](../../packages/kernel/src/guard/operator-authority.ts), and
`validateAuthorityEnvelope` in
[authority-validation.ts](../../packages/kernel/src/guard/authority-validation.ts).
Test: [instruction-snapshot.test.ts](../../packages/kernel/tests/unit/instruction-snapshot.test.ts)
and [judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts).

`RunService.startReserved` captures only original admitted user text before request assembly adds
mention and skill seeds. Evidence, controller binding and epoch are separate `ExecuteRunArgs`
substrate. Automatic goal continuations retain their admitted binding but contribute no synthetic
message as new evidence; a missing interactive admission supplies no seed. Later authenticated
operator steers can still update that continuation's ledger. Public requests cannot supply this
substrate. Missing evidence never falls back to filtering an
assembled transcript. The evidence schema shares the request message-count and
aggregate-character ceilings from `message-schemas.ts`; the aggregate includes both an `ask_user`
answer and its question context, while the other allowances include only the newline separators
introduced while preserving multipart text boundaries.
Therefore every accepted user-message input can become authenticated evidence without a smaller
authority-only cutoff. Later lifetime overflow still revokes the ledger instead of dropping
restrictions. Evidence is sanitized and is not written to audit events.

The loop creates the host runtime before capability activation and prepublishes its read-only port.
Only the loop's private callbacks admit a steer taken from the root operator queue or an accepted
answer returned by the entry agent's typed `ask_user` elicitation. Declined, cancelled, malformed and
non-`ask_user` elicitation results create no evidence. Child briefs and capability lifecycle callbacks
cannot create evidence. Snapshots are detached. Every admitted change increments revision, so an
in-flight compilation or decision cannot authorize the new revision.

`ExecutionRecord.operator_authority_state` is versioned transversal state, outside capability slots.
Continuation restores active state only under identical owner, session, controller epoch and outcome
binding. A fresh authenticated operator message under that same owner, session and controller may
carry a settled run's evidence into a newly minted outcome; it carries no prior envelope, denial or
effect consumption, and a synthetic continuation cannot reactivate it. This provenance comes only
from the stored authority ledger, never from `final_context`. Completed checkpoints may retain active
state; final completion settles it. Cancellation and controller retirement revoke it. Embeddings
without a durable host binding use execution-local IDs. Recovered records lacking authority state
supply no inherited grants.
The host mints an outcome ID for a new admission and preserves it only for an active continuation
with the same session and epoch. Controller retirement uses a separate authority signal, so work
already running in the background is not cancelled as a side effect of semantic revocation.

Workflow leaders receive only an active compiled intersection with a parent identity. Their briefs
are not evidence. The live parent revision fences same-process children.
An inherited runtime without a live parent reader fails closed.

Production: `createOperatorAuthorityRuntime` in
[operator-authority.ts](../../packages/kernel/src/guard/operator-authority.ts),
[execute-run.ts](../../packages/loop/src/runtime/execute-run.ts),
[orchestrator.ts](../../packages/loop/src/runtime/orchestrator.ts),
[run-service.ts](../../packages/kernel/src/runs/run-service.ts), and
[run-leader.ts](../../packages/workflows/src/run-leader.ts).
Test: [operator-authority.test.ts](../../packages/kernel/tests/unit/operator-authority.test.ts) and
[capability inheritance tests](../../packages/capability/tests/unit/operator-authority.test.ts),
`captures admitted operator text before skill seeds` in
[run-service-lifecycle.test.ts](../../packages/kernel/tests/unit/run-service-lifecycle.test.ts),
`keeps an admitted prompt larger than the former evidence ceiling active` in that same test, and
the settled-conversation carry-forward cases in that same test, and
`prepublishes one authority reader` and `admits an accepted ask_user answer` in
[execute-run.test.ts](../../packages/loop/tests/component/execute-run.test.ts).

## Analysis and attestation

`ShellAnalysisIssue` records kind, affected position and zero-based segment index. The legacy
`undecidable` value remains the conservative fold over issues. Syntax alone never proves authority
or workspace confinement. Environment prefixes, including assignment-only segments, never inherit
a bare command's static allowlist entry. Deny matching still sees normalized bare commands. Those
facts feed the policy and the command reviewer; they produce no effect fact and enter no envelope.

An effect fact exists only for a configuration change. The host-reviewed file-tool route produces
revision, next-revision, byte, operation, field and diff-digest constraints only after its path,
content, schema and CAS validation; its existing explicit native consent remains a
deterministic authorization route and does not become operator evidence. Native file tools do not
manufacture a fact: an admitted configuration target requires the run's `reviewMutation` port, and without
it the tool refuses the target rather than turning a generic command approval into configuration
approval. Operational settings and executable manifests receive their own validated descriptors;
private state and credentials remain inaccessible and never inherit generic content-write authority.

The descriptor vocabulary is closed and small: `workspace.content.write`, `clarvis.authoring.write`,
`clarvis.operational_config.write` and `destructive.delete`. Those four are the only ids the registry
accepts, so an operation name is never an authorization rule and no removed classification can be
reintroduced through the audit schema. Repository, GitHub, release, deployment and process
classification, the argv probes they needed, and the environment recapture that fenced them were
deleted with the command classifier.

Production: [analyze-shell.ts](../../packages/tools/src/guard/analyze-shell.ts),
[registry.ts](../../packages/kernel/src/guard/effects/registry.ts),
[configuration.ts](../../packages/kernel/src/guard/effects/configuration.ts), and
[files.ts](../../packages/kernel/src/configuration/files.ts).
Test: [analysis-issues.test.ts](../../packages/tools/tests/unit/analysis-issues.test.ts),
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts), and
[api.test.ts](../../packages/tools/tests/integration/api.test.ts) ("requires the host mutation
reviewer even when generic guard approves").

## Compiler and decision

Guard and configuration review resolve the optional Plans context through a getter at each review,
not during capability activation. Post-inference fences resolve it again: changed, newly available
or removed context invalidates the result. An activation-order miss cannot permanently hide a Plan.
Production: `reviewerContextSnapshot` and `reviewerContextIsCurrent` in
[review-context.ts](../../packages/kernel/src/guard/review-context.ts); `createGuardRuntimeResolver`
and `createConfigurationReview` supply lazy port getters.
Test: [review-context.test.ts](../../packages/kernel/tests/unit/review-context.test.ts),
`review resolves Plans after activation and rejects replacement or removal in flight` and
`a newly available Plans context invalidates a review begun without one`.


The compiler runs lazily for a revision whose effects are not covered. Its locally validated tool uses a closed,
bounded schema. Unknown effects, evidence IDs, targets or constraints invalidate the entire output.
Only bounded descriptors accept prerequisite inference. Explicit effects require direct evidence;
human-only descriptors are never inferable. Existing exclusions and inherited ceilings cannot be
removed by the model. The decision must cite a covering grant for every composed fact.
An unchanged exclusion already present in the ledger or inherited ceiling may retain a target from
an earlier call. New exclusions and all new grants still require current-call targets; retaining an
exclusion never admits a historical target for a grant. Production: `validateAuthorityEnvelope`.
Test: `retains historical target exclusions without admitting historical target grants` in
[effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

`OperatorAuthorityState.envelope_context_revision` binds the installed envelope to its live review
context. Only the host installation seam supplies this nonempty identifier (at most 2048 characters); it is absent from the
model candidate schema and authority seed. Validated checkpoint restoration retains it with the
envelope; malformed or orphaned binding revokes the restored state. Installation replaces or clears
it atomically, and settlement/revocation clears it. Reviewers compare this ledger field with the
current context, including absence, rather than maintaining a separate compile cache.
Production: `installAuthorityEnvelope` and `createOperatorAuthorityRuntime` in
[operator-authority.ts](../../packages/kernel/src/guard/operator-authority.ts), and
`createHostEffectReview` in [effect-review.ts](../../packages/kernel/src/guard/effect-review.ts).
Test: `keeps compile context with its envelope across continuation and clears it on replacement` in
[operator-authority.test.ts](../../packages/kernel/tests/unit/operator-authority.test.ts), and
`reuses installed compile context across reviewers and recompiles when Plans disappears` in
[effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

Cache identity includes authority revision and exact facts. Failures, invalid responses and uncertainty
do not become clean cached verdicts. A stale revision cannot install an envelope or execute an allow.

The compile transaction captures authority revision, installed interpretation identity, live context
revision and case digest before inference. It rechecks them before and after candidate validation,
then installs synchronously through the private ledger seam. An intervening envelope replacement at
the same revision is stale too. Only one installation attempt is permitted per transaction.
The returned transition contains the installed envelope/revision and a case-bound digest; its own
authenticated outcome revision is expected, while later external changes invalidate it. Rejection
after installation never rolls back the envelope. No separate compile cache is introduced.
Production: `createAuthorityReviewTransaction` and `installedAuthorityTransition` in
[authority-review-transaction.ts](../../packages/kernel/src/guard/authority-review-transaction.ts);
`validateAuthorityEnvelope` in [authority-validation.ts](../../packages/kernel/src/guard/authority-validation.ts).
Test: [authority-review-transaction.test.ts](../../packages/kernel/tests/unit/authority-review-transaction.test.ts)
pins pre/post-install fences, same-revision replacement, case binding, detached state and the
compile's own outcome revision; the existing effect-review suite executes this transaction too.

The compiler preserves objective identities for the same outcome. A proposed new outcome must cite
the newest evidence in every objective and grant, follow a fresh evidence revision, and originate in
a root runtime. The host then mints a new outcome binding and increments revision. Old grants are
replaced; exclusions survive validation. The model supplies the semantic distinction, while the host
enforces freshness, binding and coverage.

Guard and configuration adapters resolve one run-owned `JUDGE_PORT` lazily; no WeakMap service
shares inference, configuration or caches. The host ledger shares installed envelopes and refusals,
while Judge owns semantic receipt caches and in-flight inference. The reviewed file tool's explicit consent path needs no
additional model decision.

Production: `createHostEffectReview` and `validateAuthorityEnvelope`.
Test: [effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

## Reviewer configuration and rollout

`effect_review` is cross-cutting operator configuration: model, timeout, retry count, uncertain-result
fallback and temporary rollout stage. The file kernel accepts the model and rollout only from global
operator settings. Workspace configuration may lower timeout/retry limits or require denial on
uncertainty. A plugin cannot contribute this block. Explicit run reviewer overrides remain supported.
The fallback defaults to `deny`: `unsure`, missing authority coverage, an unavailable reviewer,
provider failure, timeout, or malformed structured output returns a denial to the calling model so it
can identify a technical review failure rather than missing consent. Technical failures never invoke
human fallback, even with `on_unsure: "ask"`. Auto never invokes human fallback, including
`on_unsure: "ask"`: deny and unsure refuse to the principal. Approval asks a human only for asks
that are neither allow-listed nor dangerous.
`guard_judge.guidance` is bounded additional context and cannot replace the
fixed policy. Both command and effect review use Judge-owned `JUDGE_POLICY`. Code composes operator-global guidance first and appends workspace guidance within the single bounded payload; absent guidance does not disable Auto.
For an effect grant, that policy requires the Judge to copy the covering host fact's complete
constraints, target digest and current authority revision into its candidate. The host still rejects
any incomplete or widened candidate. Production: `JUDGE_POLICY` in
[prompt.ts](../../packages/judge/src/prompt.ts) and `validateAuthorityEnvelope` in
[authority-validation.ts](../../packages/kernel/src/guard/authority-validation.ts). Test:
[execution-boundaries.test.ts](../../packages/judge/tests/unit/execution-boundaries.test.ts) and
[effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

The explicit rollout stages are `shadow` and `local`, and they scope configuration review only. Shadow
computes configuration review evidence
without changing the existing configuration outcome. An absent rollout uses the same conservative effect
ceiling as `local`: fully attested local effects only. The withdrawn `ci_retry` spelling is still
accepted from an existing settings document and normalizes to that same `local` ceiling, so an upgrade
cannot discard the unrelated settings a rejected document would take with it. Unknown ids remain closed to the grant
compiler. Command authorization reads no rollout stage: the removal of the `ci_retry` stage went with
the command classifier that reserved a failed-only rerun, and no command compiles an envelope. The
command reviewer reads evidence chronologically, allowing the newest instruction to refer to
authenticated
scope from earlier turns without treating an earlier outcome-bounded external action as renewed after
the newest instruction changes scope. Review `on` remains human review,
and deterministic deny rules precede a reviewer. Review `off` supplies no command guard and does not
disable filesystem, credential, capability, placement or host/guest invariants.
Auto consults exact human session consent before review for eligible asks. Deny-list rulings
still stop the call first, and explicit Host escalation never consumes session consent. Human
consent is not operator evidence. Production: `createGuardResolver` in
[resolver.ts](../../packages/kernel/src/guard/resolver.ts), `createCommandReview` in
[command-review.ts](../../packages/kernel/src/guard/command-review.ts) and `createConfigurationReview`
in [review.ts](../../packages/kernel/src/configuration/review.ts). Test:
[guard-session-auto.test.ts](../../packages/kernel/tests/integration/guard-session-auto.test.ts),
[command-guard-routing.test.ts](../../packages/kernel/tests/integration/command-guard-routing.test.ts) and
[judge.test.ts](../../packages/kernel/tests/integration/judge.test.ts).

Compiler and decision stages use the shared model-call inactivity timeout and transport retries,
with no private wall-clock deadline. Absent timeout overrides inherit the host environment default;
the ordinary Loop validates ceilings and owns run inactivity. Stages retain output cap and reasoning effort
inside the private Judge run. Its effective base provider, session and resolved TTL preserve normal
provider composition. Fixed policy and a canonical host snapshot form the stable prefix; exact case
facts and any case-specific transition token follow in a volatile message.
Production: `executeJudge` in [executor.ts](../../packages/judge/src/executor.ts), `createHostJudge`,
`createHostEffectReview` and `createCommandReview`. Test:
[executor.test.ts](../../packages/judge/tests/integration/executor.test.ts) and
[judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts).
Timeout, auth, quota, rate limit, transport, admission, cancellation, invalid response and unknown
failure are distinct receipts. Cancellation is enforced even if a provider ignores its signal.
Malformed protocol responses receive up to three correction retries per stage through ordinary Loop
tool-result continuation. Invalid authority candidates do not consume the host's single installation;
every corrected candidate rechecks the captured revision and context. No operational effect executes
during correction. Production: `createAuthorityReviewTransaction` in
[authority-review-transaction.ts](../../packages/kernel/src/guard/authority-review-transaction.ts).
Test: `invalid candidates can be corrected before the single installation` in
[authority-review-transaction.test.ts](../../packages/kernel/tests/unit/authority-review-transaction.test.ts).
Audit fields contain counts, timing, model identity, effect IDs and digests, never raw command,
justification, operator evidence, reviewer prompt or probe output.

Every logical provider call made by the call-local judge or the effect reviewer records exactly one
kernel-owned contributed trace event named `guard_reviewer_model_call`. The flat persisted event
distinguishes `call_local` from `effect_review`, `command_guard` from `configuration_file`, and
`compile` from `decide`; it totals the successful attempt with `retriedUsage`, uses
`ProviderError.accumulatedUsage` on failure, and leaves `cache_read_ratio` absent whenever cache
accounting is incomplete. Cancellation wins once even when the provider settles later. An internal
verdict or receipt cache hit produces no event because it made no provider call. The host uses these
measured events to add Guard cost to an ordinary hosted Session once; Goal stages account for the
same calls through their provider usage tracker. Production: `callReviewerWithTrace`,
`guardReviewerModelCallProjector` and `guardReviewerUsage` in
[reviewer-trace.ts](../../packages/kernel/src/guard/reviewer-trace.ts), plus `createCommandReview` and
`createHostEffectReview`. Test:
[reviewer-trace.test.ts](../../packages/kernel/tests/unit/reviewer-trace.test.ts),
[judge.test.ts](../../packages/kernel/tests/integration/judge.test.ts), and
[effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

The event records no prompt, messages, tools, commands, arguments, operator evidence, model response,
reasoning, justification or opaque provider metadata. Instrumentation observes the existing
`LLMCallParams` and result without changing provider messages or `final_context`; it does not call a
`ContextPort` method. It remains outside protocol, UI, current run totals, budgets and
`RunResponse.usage`. Production: `callReviewerWithTrace` and `engineEventToProto` in
[map-events.ts](../../packages/kernel/src/runs/map-events.ts). Test:
[reviewer-trace.test.ts](../../packages/kernel/tests/unit/reviewer-trace.test.ts),
[observability.test.ts](../../packages/kernel/tests/unit/observability.test.ts), and
[execute-run.test.ts](../../packages/loop/tests/component/execute-run.test.ts), "keeps contributed
trace accounting out of provider messages and final_context".

Production: [prompt.ts](../../packages/judge/src/prompt.ts),
[resolver.ts](../../packages/kernel/src/guard/resolver.ts),
[settings.ts](../../packages/judge/src/settings.ts),
and [review-audit-schema.ts](../../packages/kernel/src/guard/review-audit-schema.ts).
Test: [effect-review-service.test.ts](../../packages/kernel/tests/integration/effect-review-service.test.ts).

## Wire and presentation

Operator authority and effect review are Host/Sandbox-only. Docker/Podman Kernels receive no
evidence, binding, epoch, reviewer settings, approval bridge or guard audit channel. Code omits
Container guard fields before submission and the Container composition has no effect-review
capability. Effect review has no Container channel method or descriptor.

The public elicitation detail has optional analysis, effect, authority and reviewer fields. Older
details still validate. A command elicitation now carries the analyzer's analysis only: no command
produces a reviewed effect, so the resolved effect, authority and reviewer fields describe a
configuration review or a hosted client's own detail. The UI shows a one-based segment, affected argument position, effect and
failure kind. Durable shell rows retain answerer, effect, relation and failure vocabulary without
reviewer prose. The standalone tools DTO and dependency-free protocol DTO share no package edge.

Production: [review-detail-schema.ts](../../packages/kernel/src/guard/review-detail-schema.ts),
[effect-review.ts](../../packages/code/src/core/transcript/effect-review.ts).
Test: [container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts)
and [transport-codecs.test.ts](../../packages/kernel/tests/contract/transport-codecs.test.ts).
DTO discriminator drift is checked by
[effect-review-dto.test.ts](../../packages/kernel/tests/architecture/effect-review-dto.test.ts).

## Inert corpus and opt-in probes

[guard-corpus.json](../../packages/kernel/tests/fixtures/guard-corpus.json) is a
versioned, inert corpus of commands and synthetic evidence sources. Its commands are parsed or fed to
the shell policy; they are never executed. The policy suite asserts that no entry in
`policy_never_allowed` is ever allowed under either placement or Auto, that no `execution_environment`
prefix inherits a bare allowlist entry, and that no `non_operator_sources` entry is admitted as
evidence.

`runEffectReviewCanary` in
[effect-review.ts](../../packages/kernel/tests/canary/effect-review.ts) is outside the mandatory suite.
An authorized host caller supplies the real SDK's subscription resolver, explicit opt-in and two
distinct subscription model identities selected by the operator. One to three trials run native Judge capability
compile/decide contracts over a configuration mutation, a short timeout and injected invalid-response
handling. Each scenario
must persist exactly one projected internal run in disposable storage. Results retain provider
cache counters when available, stage usage, attempts,
failure kinds and latency percentiles, without prompts, commands, credentials or evidence text.
Decisions are observations, not probabilistic unit-test expectations. The
[canary gate test](../../packages/kernel/tests/unit/effect-review-canary-gates.test.ts) proves that
missing opt-in, duplicate model identities or invalid bounds stop before any provider access. A
single global budget refuses attempt twenty-one before it reaches the provider, and simulated
authorization failure still exercises native private execution without exposing credentials.


## Shared Judge consumer

`createHostEffectReview` supplies current case facts separately from live host snapshots and trusted
compile/validation callbacks. A usable transition is exposed only when its grants cover the current
facts. The host validates cited grants in fact order, relation, revision and transition token again
after inference. Exact refusals are checked before and
after inference. A compiled exclusion denies without a decide invocation. Cancelled reviews never
fall through to a human question. Configuration accepts the host's own compilation revision while
still rejecting external changes before the write. Architecture errors propagate without fallback.
Production: `createHostEffectReview` and `createConfigurationReview`.
Test: [effect-review.test.ts](../../packages/kernel/tests/unit/effect-review.test.ts) checks shared
ledger/refusals, invalid grant/relation/revision/token, exclusions and missing composition;
[file-tool-configuration.test.ts](../../packages/kernel/tests/integration/file-tool-configuration.test.ts)
executes the real private protocol for authoring and pins operator-question counts.
The old direct-provider characterization and canary helper are baseline-only; they do not qualify
this private execution path. Real-provider/cache qualification remains outstanding.


The native factory emits `effect_review.reviewer.started` once per actual provider invocation, with
stage/consumer read from the private execution descriptor and live authority revision; the effect id
is present only when the host named one. Cache hits
emit no start. The host adapter records typed operational/validation failures with the compile or
decide stage and aggregate attempts; logs contain no case or provider prose. The separate parent
model-call event remains the usage authority, one event per actual invocation. Compilation records
`operator_authority.recompiled`; terminal semantic decisions record reviewer completion.
Production: `createHostJudge` and `createHostEffectReview`.
Test: the command/effects real-engine cases in
[judge-host.test.ts](../../packages/kernel/tests/integration/judge-host.test.ts) verify compile/decide
identity, start counts, private accounting and cache reuse; failure-audit cases in
[effect-review.test.ts](../../packages/kernel/tests/unit/effect-review.test.ts) validate the closed schema.
