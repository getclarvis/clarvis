# @clarvis/judge

`@clarvis/judge` assesses one action that the Kernel has already classified as eligible for review. It uses the `LLMProvider` port from `@clarvis/capability`; the Kernel selects the configured provider/model, supplies authorization evidence and owns the inspection runner. The package does not execute the proposed action or persist a permission.

`createJudgeService` sends a stable policy and the exact action in a separate model context. It accepts a valid `allow`/`deny` JSON object, including one enclosed in prose, and normalizes optional risk, authorization and rationale fields. Parse/transport failures may retry within one deadline; a valid denial does not retry. A required action or authority record that exceeds the context budget produces `context_overflow` instead of a truncated review. `DenialCircuitBreaker` counts completed denials only.

The `ReviewRunner` port offers bounded inspection tools. The Kernel implements it with a native Sandbox policy that reads the workspace, blocks network and permits writes only in private scratch. An unavailable inspection boundary is a technical failure, never Host execution. Production: `createJudgeService` in `src/service.ts`, `parseAssessment` in `src/assessment.ts`, `reviewPayload` in `src/prompt.ts`, `DenialCircuitBreaker` in `src/circuit-breaker.ts`, and `createJudgeRunner` in `packages/kernel/src/execution/judge-runner.ts`. Tests: `tests/unit/judge.test.ts` and `packages/kernel/tests/unit/judge-runner.test.ts`.

From the repository root, run `bun --filter @clarvis/judge test`, `build` or `typecheck`. `bun --filter @clarvis/judge eval` runs the synthetic corpus in `eval/cases.json` once per case. `bun --filter @clarvis/judge eval:business` runs the separate `evals/business.json` corpus five times per case and reports every outcome, latency and token use. Both commands use the operator's configured model and credentials and may be billed; deterministic unit tests do not call a provider. A catalog price is required to report cost rather than unavailable.

See [the judge spec](../../specs/execution/judge.md) for the routing and failure contract.
