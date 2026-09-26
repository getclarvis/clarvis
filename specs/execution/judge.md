# Judge and automatic execution approval

> Production: `createJudgeService` in `packages/judge/src/service.ts`, `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`, `createRunJudge` in `packages/kernel/src/execution/judge-service.ts`, `createJudgeRunner` in `packages/kernel/src/execution/judge-runner.ts`. Test: `packages/judge/tests/unit/judge.test.ts`, `packages/kernel/tests/integration/judge-approval.test.ts`, `packages/kernel/tests/unit/judge-runner.test.ts`.

## Purpose and ownership

`@clarvis/judge` gives a semantic assessment of an exact proposed action. The Kernel applies deterministic rules and host restrictions first, selects a reviewer for eligible requests, and revalidates action identity before execution. The judge neither executes that action nor stores reusable permission. `manual` routes eligible requests to the operator; `auto` routes them to the judge. Switching modes does not alter the isolation profile, network, workspace access or rule files. Production: `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`, `createIsolationService` in `packages/kernel/src/execution/isolation-service.ts`. Test: `auto reviews eligible delta and skips ordinary calls; manual asks operator` in `packages/kernel/tests/integration/judge-approval.test.ts`.

`@clarvis/judge` depends only on the capability contract. The Kernel owns model and provider resolution, evidence, native inspection, configuration and run lifetime; the loop consumes a neutral `ActionAuthorizationPort`. Plan review and Goal Steward use different lifecycle gates. Production: `ReviewRunner` in `packages/judge/src/types.ts`, `ActionAuthorizationPort` in `packages/capability/src/action-authorization.ts`, `createRunJudge` in `packages/kernel/src/execution/judge-service.ts`. Test: `packages/loop/tests/architecture/reviewer-boundary.test.ts` and `packages/kernel/tests/integration/judge-approval.test.ts`.

## Routing

A global auto/manual edit advances the bound run's authorization revision. A future action uses the
new route, while a review pending under the old revision cannot grant execution. Production:
`createIsolationService` in `packages/kernel/src/execution/isolation-service.ts` and
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts`. Test:
`approval mode edits publish a new revision for future actions in the bound run` in
`packages/kernel/tests/unit/isolation-service.test.ts` and
`a mode change routes only later actions through judge` in
`packages/kernel/tests/integration/approval-policy.test.ts`.

Forbidden rules, disabled permission requests and explicit deny-read restrictions stop before either reviewer. An ordinary action already allowed inside its profile executes without a question. `auto` reviews an eligible request; `manual` asks the operator. Under `untrusted`, the human review route remains in force. `execution_requirements.judge_required` selects the judge even with a manual preference, while `strict_review` also reviews deterministic allows; neither changes a forbidden decision. An effectively unrestricted Host action does not receive an extra semantic review unless an explicit rule or host requirement calls for one. Production: `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`, `canRequestApproval` in `packages/execpolicy/src/approval-policy.ts`. Test: `packages/kernel/tests/integration/judge-approval.test.ts` and `packages/kernel/tests/integration/approval-policy.test.ts`.

The action includes owner, execution, actor, call, attempt, final arguments, command context, requested permissions, profile, policy revision and authorization revision. An approval binds to its fingerprint and remains valid only while the host's current revision matches. Steering or a mode change advances that revision; tools retry a changed review with both fresh authorization and policy revisions before launch. Approval of a sandbox attempt cannot authorize a later attempt requesting wider permissions. Production: `ActionAuthorizationRequest` in `packages/capability/src/action-authorization.ts`, `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`, `dispatch` in `packages/tools/src/core.ts`, `authorizeAction` in `packages/loop/src/runtime/tools/authorize-action.ts`. Test: `steering during review requires a fresh authorization before execution` in `packages/tools/tests/unit/action-authorization.test.ts`.

## Assessment and evidence

The stable policy in `packages/judge/src/prompts/assessment-policy.ts` separates intrinsic risk (`low`, `medium`, `high`, `critical`) from user authorization (`unknown`, `low`, `medium`, `high`). Low and medium risk can pass within the objective; high risk requires bounded medium or higher authorization; critical risk is denied. It asks the model to evaluate actual targets and effects for exfiltration, credentials, security weakening, destruction and untrusted instructions. The model returns `outcome: allow | deny` with optional risk, authorization and rationale. The runtime respects a valid outcome after deterministic restrictions; optional fields do not trigger a second host scoring matrix. Production: `ASSESSMENT_POLICY` in `packages/judge/src/prompts/assessment-policy.ts`, `parseAssessment` in `packages/judge/src/assessment.ts`. Test: `minimal JSON, prose wrapper, and invalid assessments` in `packages/judge/tests/unit/judge.test.ts`.

The judge receives a separate context. Original user turns from the run request, later steering, and preserved authorization evidence from a continuation are marked as user authority. Assistant content and tool facts remain data; a file's instructions gain user authority only through explicit user adoption. The exact action and authority-bearing evidence must fit the context; optional evidence may be shortened. No reviewer output is inserted into the main agent's stable prompt prefix. Production: `runAuthorizationEvidence` in `packages/kernel/src/execution/judge-service.ts`, `createIsolationService` in `packages/kernel/src/execution/isolation-service.ts`, `reviewPayload` in `packages/judge/src/prompt.ts`. Test: `required authority and action must fit without truncation` in `packages/judge/tests/unit/judge.test.ts`.

## Inspection and failure

The reviewer may call `read_file`, `list_dir`, `read_image` and `shell` through the Kernel's bounded runner. Only those names reach the dispatcher. A native Sandbox gives the reviewer a read-only workspace, disabled network and private temporary scratch; no approval port, MCP, hooks, skills or Host fallback is present. Closing the runner drains its command sessions and worker. Production: `createJudgeRunner` in `packages/kernel/src/execution/judge-runner.ts`, `SandboxToolExecutor` in `packages/tools/src/execution/sandbox.ts`. Test: `inspection reads but cannot change workspace data` in `packages/kernel/tests/unit/judge-runner.test.ts` and the native sandbox tests in `packages/sandbox/tests`.

Up to `judge.max_attempts` attempts share `judge.timeout_ms` (defaults: three and 90,000 ms). Parse and provider failures may retry; a valid `deny` is final. A valid current `allow` runs without a human prompt. Technical failure and cancellation never execute and never masquerade as a semantic denial. When required authority exceeds context, an optional judge may use the configured `manual_on_context_overflow` fallback; `judge_required` and `fallback: disabled` refuse that fallback. Three consecutive completed denials or ten in the latest fifty completed assessments open a run-local circuit breaker; the loop observes its generic host stop reason. Production: `createJudgeService` in `packages/judge/src/service.ts`, `reviewDeadline` in `packages/judge/src/retry.ts`, `DenialCircuitBreaker` in `packages/judge/src/circuit-breaker.ts`, `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`, `runAgentLoop` in `packages/loop/src/runtime/loop/loop.ts`. Test: `packages/judge/tests/unit/judge.test.ts`, `three completed denials stop further reviews without a human fallback` in `packages/kernel/tests/integration/judge-approval.test.ts`.

## Settings, evaluation and coupling

A completed judge denial remains available in the same active run for an explicit operator choice. The TUI `/authorize` prompt navigates recent denials and shows the selected tool, exact arguments and rationale before confirmation. It sends `Message.authorized_denial` as steering; the Kernel checks the owner/run and denied call, records the operator's authorization, and offers it to one materially identical new attempt. The agent receives the steering and must propose the action again; confirmation never launches the old call. Deterministic rules and judge review still apply. Production: `DeniedActionPrompt` in `packages/code/src/views/overlays/DeniedActionPrompt.tsx`, `authorizeDeniedAction` in `packages/code/src/run-host.ts`, `createIsolationService` in `packages/kernel/src/execution/isolation-service.ts`. Test: `a live judge denial exposes its action and queues only a scoped new attempt` in `packages/code/tests/component/run-host.test.ts`, `denied action prompt shows the exact command and review reason` in `packages/code/tests/integration/app-commands.test.tsx`, `a completed denial can be identified for a later scoped authorization without executing it` in `packages/kernel/tests/integration/judge-approval.test.ts`, `run bindings retain global preference and separate owners` in `packages/kernel/tests/unit/isolation-service.test.ts`.

The global `approval_mode` defaults to `manual`. The global `judge` block accepts an optional catalog model, bounded guidance, timeout, attempt cap and fallback preference. The Kernel validates the block and selects the parent model when no judge override is set. The TUI `/approval` command persists manual or auto for subsequent runs. Workspace settings cannot contribute either setting. Production: `judgeSettingsSchema` in `packages/kernel/src/config/judge-settings.ts`, `kernelCapabilityRegistry` in `packages/kernel/src/config/capability-registry.ts`, `createRunJudge` in `packages/kernel/src/execution/judge-service.ts`, `ApprovalPicker` in `packages/code/src/views/overlays/ApprovalPicker.tsx`, `createFileConfigStore` in `packages/kernel/src/config/file-config-store.ts`. Test: `global isolation settings` in `packages/kernel/tests/integration/isolation-settings.test.ts` and `packages/code/tests/integration/app-commands.test.tsx`.

Selecting auto through `ConfigService.updateSettings` requires a configured model reference and
matching provider before its one global write; the TUI checks its current settings projection
before submitting that write. The model is resolved again against the run's execution catalog
before its first judge call. Production: `updateSettings` in
`packages/kernel/src/config/config-service.ts`, `ApprovalPicker` in
`packages/code/src/views/overlays/ApprovalPicker.tsx`, `createRunJudge` in
`packages/kernel/src/execution/judge-service.ts`. Test: `global isolation settings` in
`packages/kernel/tests/integration/isolation-settings.test.ts`.

`packages/judge/eval/cases.json` records synthetic business scenarios, expected outcome, reason and inspection need. `bun --filter @clarvis/judge eval` makes one live model attempt per fixture using the operator's configured provider credentials. A fake provider proves routing and parsing, not semantic quality; live eval results require an actual run and are not implied by compilation. Production: `tooling/judge/eval.ts` (`EvalCase`) and `createJudgeService` in `packages/judge/src/service.ts`. Test: `packages/judge/tests/unit/judge.test.ts` for deterministic mechanics; the explicit eval command supplies separate model evidence.

`bun --filter @clarvis/judge eval:business` runs five reviews for each synthetic case in
`packages/judge/evals/business.json`. It reports every outcome, model, judge policy digest,
latency, token use, inspection calls and separate false allow, false deny and technical counts;
cost remains unavailable when the configured model has no price. A divergence remains visible and
fails the command. This live corpus qualifies the selected model and does not replace deterministic
execution or transport tests. Production: `tooling/judge/eval.ts` (`business`, `records`). Test:
`packages/judge/tests/unit/judge.test.ts` covers parsing and retry mechanics.

The portable release smoke runs a synthetic forced-removal action under the installed native
Sandbox twice: auto uses a deterministic local judge provider without a human question, and manual
asks once. It observes the target's removal and checks the review/question counts. Production:
`qualifyNativeArchive` in `packages/code/tooling/release/smoke.ts`,
`executeReviewed` in `packages/kernel/tests/fixtures/release-native-canary.ts`. Test:
`bun --filter @clarvis/code release:smoke` on a packaged artifact.
