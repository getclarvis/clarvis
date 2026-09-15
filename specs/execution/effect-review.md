# Host-attested effects and operator authority

## Trust boundaries

Workspace instructions and reviewer guidance are data. Authenticated start/continue text, applied
operator steers and accepted entry-agent `ask_user` answers are evidence. For `ask_user`, the
model-authored question is retained only as untrusted context for interpreting the authenticated
answer. The reviewer interprets that evidence; the host resolves
effects and targets and validates every grant. A descriptor, not model prose, defines the maximum
inference and constraints. The neutral vocabulary belongs to capability, syntax to tools, and the
registry, ledger, compiler and policy to kernel. `ToolEffect` retains its separate scheduling role.

Production: `OperatorAuthorityReader` in
[operator-authority.ts](../../packages/capability/src/operator-authority.ts),
`createGuardEffectRegistry` in [registry.ts](../../packages/kernel/src/guard/effects/registry.ts),
and `validateAuthorityEnvelope` in
[effect-review-service.ts](../../packages/kernel/src/guard/effect-review-service.ts).
Test: [effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts).

## Evidence and lifetime

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
are not evidence. The live parent revision fences same-process children. One-attempt CI retry grants
are excluded from independent child projections because those children have no shared atomic counter.
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
a bare command's static allowlist entry. Deny matching still sees normalized bare commands.

The initial POSIX composition accepts literal `export TMPDIR` only for a host-admitted temporary
root, bounded commit message arguments, and closed `git status`/`git log` observation forms. A
quoted heredoc producer must contain exactly operand-free `cat`, a quoted literal delimiter, no
additional redirection or command, at most 4 KiB of data, and occupy an entire double-quoted message
argument. Unquoted substitution, file-reading `cat`, an expandable heredoc, dynamic executable or
subcommand, redirections, and unknown batch segments cannot receive partial approval.

Git probes resolve repository root, current branch and HEAD. An explicit non-forced push of that
branch to a named GitHub remote also resolves the push URL and binds its repository, destination,
HEAD and upstream-setting intent; implicit refspecs, another source or destination, additional
options and every force spelling retain human review. A JSON `gh pr view` observation with the
supported metadata/check fields, or numeric `gh pr checks` with optional canonical `--repo`,
optional `--watch`, and a positive `--interval` only alongside `--watch`, resolves the canonical origin and binds the requested open
PR to the current branch and HEAD. GitHub failed-only rerun probes additionally correlate the canonical
origin, run ID, completed failed state, supported event, branch, SHA and open PR head. Probes use an
injected argv-only `ProcessRunner`, a three-second timeout and 16 KiB combined output cap. They never
execute the reviewed mutation. The resolver reattests shell effects before returning a model allow.
Network, authentication, malformed output or target mismatch closes the attestation. Unsupported
external variants retain a human-only attestation; Auto denies them by default and uses a human only
under explicit `on_unsure: "ask"`. Registry membership is not proof that every CLI spelling has a
complete attestor.
Probe lookup and configuration roots are recaptured from the actual shell spawn environment through
`resolveEffectEnvironment`. Unmatched inherited Git/GitHub overrides or executable-loading variables
close attestation before any query; arbitrary environment values are not copied into probes. The
same check runs during reattestation after review, including explicit Host escalation. Production:
[environment.ts](../../packages/kernel/src/guard/effects/environment.ts). Test:
`refuses an inherited %s override before querying or approving a target` and
`routes the real resolver through complete attestation and validated grants` in
[effect-attestation.test.ts](../../packages/kernel/tests/unit/effect-attestation.test.ts).
Literal `git -C` is resolved within the workspace; dynamic or escaping directories remain closed.
An omitted GitHub repository is resolved only from the canonical host origin.

Native content effects use resolved `PathFact`s. Canonical agent, skill and workflow Markdown may be
reviewed as authoring. Operational settings, executable manifests, private state and credentials
never inherit generic content-write authority. Native tools still reject operational configuration
before review. The restricted configuration writer produces revision, next-revision and byte facts
only after its path, content and CAS validation; its existing explicit native consent remains a
deterministic authorization route and does not become operator evidence.

Production: [analyze-shell.ts](../../packages/tools/src/guard/analyze-shell.ts),
[shell.ts](../../packages/kernel/src/guard/effects/shell.ts),
[git.ts](../../packages/kernel/src/guard/effects/git.ts),
[github-cli.ts](../../packages/kernel/src/guard/effects/github-cli.ts),
[literal-data.ts](../../packages/kernel/src/guard/effects/literal-data.ts),
[workspace.ts](../../packages/kernel/src/guard/effects/workspace.ts),
[configuration.ts](../../packages/kernel/src/guard/effects/configuration.ts), and
[files.ts](../../packages/kernel/src/configuration/files.ts).
Test: [analysis-issues.test.ts](../../packages/tools/tests/unit/analysis-issues.test.ts),
[effect-attestation.test.ts](../../packages/kernel/tests/unit/effect-attestation.test.ts), and
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts).
Native authoring approval is also exercised in
[api.test.ts](../../packages/tools/tests/integration/api.test.ts): incomplete authoring facts do not
authorize a write, and operational settings are refused before elicitation.

## Compiler and decision

The compiler runs lazily for a revision whose effects are not covered. Its forced tool uses a closed,
bounded schema. Unknown effects, evidence IDs, targets or constraints invalidate the entire output.
Only bounded descriptors accept prerequisite inference. Explicit effects require direct evidence;
human-only descriptors are never inferable. Existing exclusions and inherited ceilings cannot be
removed by the model. The decision must cite a covering grant for every composed fact.
An unchanged exclusion already present in the ledger or inherited ceiling may retain a target from
an earlier call. New exclusions and all new grants still require current-call targets; retaining an
exclusion never admits a historical target for a grant. Production: `validateAuthorityEnvelope`.
Test: `retains historical target exclusions without admitting historical target grants` in
[effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts).

Cache identity includes authority revision and exact facts. Failures, invalid responses, uncertainty
and human fallback do not become clean cached verdicts. Failed-only rerun identity is reserved once
before execution and persists across recompilation and continuation; execution failure does not
refund the attempt. A stale revision cannot install an envelope or execute an allow.

The compiler preserves objective identities for the same outcome. A proposed new outcome must cite
the newest evidence in every objective and grant, follow a fresh evidence revision, and originate in
a root runtime. The host then mints a new outcome binding and increments revision. Old grants are
replaced; exclusions survive validation. The model supplies the semantic distinction, while the host
enforces freshness, binding and coverage.

`effectReviewServiceFor` shares one service per host reader. The restricted configuration writer
uses that same service for attested facts and audit; its existing explicit consent path needs no
additional model decision.

Production: `createEffectReviewService`, `validateAuthorityEnvelope`, `consumeAuthorityEffects`.
Test: [effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts).

## Reviewer configuration and rollout

`effect_review` is cross-cutting operator configuration: model, timeout, retry count, uncertain-result
fallback and temporary rollout stage. The file kernel accepts the model and rollout only from global
operator settings. Workspace configuration may lower timeout/retry limits or require denial on
uncertainty. A plugin cannot contribute this block. Explicit run reviewer overrides remain supported.
The fallback defaults to `deny`: `unsure`, missing authority coverage, an unavailable reviewer,
provider failure, timeout, or malformed structured output returns a denial to the calling model so it
can choose another command. `on_unsure: "ask"` is the explicit opt-in for human fallback; human-only
policy decisions such as credential, dangerous-command, and explicit escalation asks remain human.
`guard_judge.prompt` is deprecated guidance; `guidance` is the typed replacement. Neither replaces the
first system message, `EFFECT_REVIEW_POLICY`, which is owned by the kernel. Code composes operator-global guidance first and appends workspace guidance within the single bounded payload; an absent prompt does not disable Auto.

The explicit rollout stages are `shadow`, `local` and `ci_retry`. Shadow computes review evidence
without changing the existing guard outcome. An absent rollout uses the same conservative effect
ceiling as `local`: fully attested local effects only. CI retry
also permits the tightly correlated failed-only effect. Unknown effects remain closed to the grant
compiler. A separate call-local command reviewer may answer an ordinary shell ask whose sole fact is
`external.unknown`; that answer applies only to the exact command and never enters the authority
envelope. It reads evidence chronologically, allowing the newest instruction to refer to authenticated
scope from earlier turns without treating an earlier outcome-bounded external action as renewed after
the newest instruction changes scope. Review `on` remains human review,
and deterministic deny rules precede a reviewer. Review `off` supplies no command guard and does not
disable filesystem, credential, capability, placement or host/guest invariants.
Auto consults exact human session consent before effect review for eligible asks. Deny-list rulings
still stop the call first, and explicit Host escalation never consumes session consent. Human
consent is not operator evidence. Production: `createGuardResolver` in
[resolver.ts](../../packages/kernel/src/guard/resolver.ts) and `createJudgeElicit` in
[judge.ts](../../packages/kernel/src/guard/judge.ts). Test:
[guard-session-auto.test.ts](../../packages/kernel/tests/integration/guard-session-auto.test.ts) and
[judge.test.ts](../../packages/kernel/tests/unit/judge.test.ts).

Compiler and judge have their own explicit timeout, retries, output cap and reasoning effort.
Their model calls use the shared `judge` auxiliary instance on the run's decorated provider, so
session affinity, canonical prompt-cache key and TTL follow the same composition as ordinary and
memory runs. Effect review marks only its stable system policy; guidance remains bundled with the
current authority evidence and effect facts outside that breakpoint. Production:
`GUARD_REVIEW_AGENT_INSTANCE_ID`
in [reviewer-policy.ts](../../packages/kernel/src/guard/reviewer-policy.ts),
`createEffectReviewService` and `createJudgeElicit`. Test:
[effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts) and
[judge.test.ts](../../packages/kernel/tests/unit/judge.test.ts).
Timeout, auth, quota, rate limit, transport, admission, cancellation, invalid response and unknown
failure are distinct receipts. Cancellation is enforced even if a provider ignores its signal.
Audit fields contain counts, timing, model identity, effect IDs and digests, never raw command,
justification, operator evidence, reviewer prompt or probe output.

Every logical provider call made by the call-local judge or the effect reviewer records exactly one
kernel-owned contributed trace event named `guard_reviewer_model_call`. The flat persisted event
distinguishes `call_local` from `effect_review`, `command_guard` from `configure_clarvis`, and
`compile` from `decide`; it totals the successful attempt with `retriedUsage`, uses
`ProviderError.accumulatedUsage` on failure, and leaves `cache_read_ratio` absent whenever cache
accounting is incomplete. Cancellation wins once even when the provider settles later. An internal
verdict or receipt cache hit produces no event because it made no provider call. Production:
`callReviewerWithTrace` and `guardReviewerModelCallProjector` in
[reviewer-trace.ts](../../packages/kernel/src/guard/reviewer-trace.ts), plus `createJudgeElicit` and
`createEffectReviewService`. Test:
[reviewer-trace.test.ts](../../packages/kernel/tests/unit/reviewer-trace.test.ts),
[judge.test.ts](../../packages/kernel/tests/unit/judge.test.ts), and
[effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts).

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

Production: [reviewer-policy.ts](../../packages/kernel/src/guard/reviewer-policy.ts),
[resolver.ts](../../packages/kernel/src/guard/resolver.ts),
[effect-review-settings.ts](../../packages/loop/src/runtime/capabilities/effect-review-settings.ts),
and [review-audit-schema.ts](../../packages/kernel/src/guard/review-audit-schema.ts).
Test: [effect-review-service.test.ts](../../packages/kernel/tests/unit/effect-review-service.test.ts).

## Wire and presentation

Operator authority and effect review are Host/Sandbox-only. Docker/Podman Kernels receive no
evidence, binding, epoch, reviewer settings, approval bridge or guard audit channel. Code omits
Container guard fields before submission and the Container composition has no effect-review
capability. Effect review has no Container channel method or descriptor.

The public elicitation detail has optional analysis, effect, authority and reviewer fields. Older
details still validate. The UI shows a one-based segment, affected argument position, effect and
failure kind. Durable shell rows retain answerer, effect, relation and failure vocabulary without
reviewer prose. The standalone tools DTO and dependency-free protocol DTO share no package edge.

Production: [review-detail-schema.ts](../../packages/kernel/src/guard/review-detail-schema.ts),
[effect-review.ts](../../packages/code/src/core/transcript/effect-review.ts).
Test: [container-kernel-host.test.ts](../../packages/kernel/tests/integration/container-kernel-host.test.ts)
and [transport-codecs.test.ts](../../packages/kernel/tests/contract/transport-codecs.test.ts).
DTO discriminator drift is checked by
[effect-review-dto.test.ts](../../packages/kernel/tests/architecture/effect-review-dto.test.ts).

## Inert corpus and opt-in probes

[effect-review-corpus.json](../../packages/kernel/tests/fixtures/effect-review-corpus.json) is a
versioned, inert corpus. Its commands are parsed or fed to fake argv evidence; they are never executed.
The accompanying [attestation test](../../packages/kernel/tests/unit/effect-attestation.test.ts)
asserts zero silent allow for execution-affecting environment prefixes in Host and containment,
and rejects unknown compositions, protected paths and synthetic evidence sources.

`runEffectReviewCanary` in
[effect-review.ts](../../packages/kernel/tests/canary/effect-review.ts) is outside the mandatory suite.
An authorized host caller supplies the real SDK's subscription resolver, explicit opt-in and one
model each for `openai-codex` and `xai-grok`. One to five trials run forced compile/decide contracts,
a short timeout and injected invalid-response handling. Results retain stage usage, attempts,
failure kinds and latency percentiles, without prompts, commands, credentials or evidence text.
Decisions are observations, not probabilistic unit-test expectations. The
[canary gate test](../../packages/kernel/tests/unit/effect-review-canary-gates.test.ts) proves that
missing opt-in or invalid bounds stop before any provider access.
