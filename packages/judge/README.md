# `@clarvis/judge`

Owns semantic reviewer configuration and isolated command/effect execution. The Kernel
registers its settings before parsing host configuration and requests; the generic Loop validates
its declared model references without knowing the reviewer domain.

Judge receives the host-captured global and workspace `CLARVIS.md` (fallback `AGENTS.md` per scope)
as persistent operator instructions. Direct operator restrictions take precedence. Routine necessary
commands do not require repeated consent merely because static analysis deferred their review.
The fixed policy separates evidence, authorization, intrinsic risk, decision and private protocol.
It is command-agnostic; concrete operations and their constraints come from the case and host descriptors.
For effect review, its private protocol directs the model to copy every constraint of the covering
host fact into each proposed grant. The host rejects omitted or widened constraints.
A conventional name, path prefix or temporary-directory location is not proof that a target is
discardable, and a recognized cleanup does not authorize other effects in the same call.
Trajectory informs the current case only; it neither denies hypothetical future actions nor grants
future authority. The Judge remains a blocking reviewer, not a high/low trajectory classifier.
It is the sole reviewer of the case: deny and unsure return to the calling agent; they are not a
request for a person or a TUI prompt.

The owning contract is [Judge](../../specs/capabilities/judge.md). Host authority, effect validation
and final consent remain governed by [effect review](../../specs/execution/effect-review.md) and
[command guard](../../specs/execution/command-guard.md).

## Public entries

- `@clarvis/judge/testing`: the production `createJudgeCoordinator` for integration fixtures;
  production hosts compose `createJudgeCapability` instead.
- `@clarvis/judge/settings`: `judgeSettingsSpec`, strict schemas, `EffectReviewConfig`,
  `GuardJudgeConfig`, operational defaults and the typed request-view accessor.
- `@clarvis/judge`: configuration plus `createJudgeCapability`, `JUDGE_PORT`, typed cases/receipts,
  host service bindings, `canonicalJudgeJson` and `JudgeArchitectureError`. The private run capability and executor are not
  public entry points. Configuration-only consumers use `./settings` to avoid loading the runtime.

`guard_mode` remains the tools policy selector. Reviewer configuration is contributed as the
`guard_judge` request parameter and `effect_review` operator settings block. `guidance` is bounded
untrusted context; it cannot replace policy or authenticated evidence. Unknown keys fail strict
validation. Plugins cannot contribute reviewer configuration. The Kernel enforces global/workspace
scope restrictions and supplies the prohibition to its plugin parser.

This package has no dependency on Kernel, Tools, Protocol or another product capability. It does
not own grants, operator consent, effect consumption or the authority ledger. Command and effect/configuration review execute through this package.

## Development

From the repository root, run `bun --filter @clarvis/judge build`, `typecheck`, `test` or `lint`.
Settings tests own bounds, strict parsing and referenced-model declarations. The architecture test
checks the package's import boundary. Kernel tests own registry composition and plugin rejection.

## Private protocol prerequisite

The internal `judgeStepSchema` closes the three `judge_step` actions, and `createJudgeStepMachine`
validates each complete provider response before dispatch. Command/decide finish in one accepted
step; compile returns the validated host transition and requires decide to cite its revision/token.
Command runs expose only the `decide_command` input schema to the provider, so the model cannot
select an effect-compilation action that the command state machine must reject.
Multiple calls, text without a tool call, malformed arguments and wrong ordering produce bounded
correction feedback. Text accompanying one valid call is accepted but never interpreted as a
decision, permission or host instruction; only the validated tool arguments carry the receipt.
The host alone validates and installs authority; its operational faults propagate separately from
semantic rejection. Closing the machine fences pending transaction results without rolling back an
already installed envelope. These modules feed the private run capability; the native host composes the public capability with command, effect and configuration consumers integrated.

The private `createJudgeRunCapability` uses the ordinary Loop contribution contract: one
`judge_step` tool without provider-side forced selection, a shared output budget, a terminal finalize gate and lifecycle cleanup. A complete
provider response must pass admission before dispatch; admission performs no host transaction.
Every advertised schema has an explicit object root, including the staged union. Tool selection
is enforced through local admission and bounded correction, independently of the selected model.
Compile returns the authoritative tool result and advances to the decision stage; valid decisions return a
completed structured receipt immediately. Host transaction faults terminate with `internal_error`
and remain separately available to the executor. Invalid output terminates with the fixed private
`judge_invalid_response` code only after three correction retries per stage are exhausted.
Corrections return ordinary tool results to the existing Loop; there is no additional inference loop.
No human channel is contributed. Real Loop integration tests pin stage limits, append-only feedback,
exact tool catalog and absence of partial installation on multiple calls.
The package depends on Loop for this execution boundary; the native host uses it for command review.

## Isolated executor

Internal `executeJudge` creates a fresh noncontinuable run from a host service allowlist. It supplies
only the private capability, omits the environment preamble and preserves the parent-resolved TTL,
session and effective base provider. System policy is fixed. Configuration and dedicated Goal/Plan
slots form a fixed semantic head; each authenticated operator input occupies its own chronological
user message; the current authority fence and case form the volatile tail. Absent Goal/Plan slots
remain explicit so later availability changes bytes without shifting positions. The provider adapter
validates this framing and marks the end of the evidence prefix without rewriting engine messages or
identity. Operational Goal state and Plan CAS/task-status headers remain owned by the work run and do
not enter the reviewer.

Command output is capped at 1024 tokens per attempt; effects at 2048. The independent output budget
covers one or two stages, four correction attempts per stage and configured transport retries.
Calls use the ordinary model inactivity timeout and transport retry machinery; there is no private
wall-clock timer. The host default is `CLARVIS_DEFAULT_CALL_TIMEOUT_MS` unless explicitly overridden,
and the ordinary Loop owns run inactivity and ceiling validation. Transport attempts inherit
`CLARVIS_DEFAULT_MAX_RETRIES` and are bounded by `CLARVIS_RETRY_CEILING`; explicit reviewer overrides
use the same machinery. Provider fallback cannot invoke the same stage
again after a failed call; the original failure remains available to the host. Late known usage and
retried usage are retained exactly once. Host transaction and framing faults propagate separately
from semantic/provider outcomes. Real provider cache reuse remains unqualified until the live canary.

## Work-run ownership

`createJudgeCapability` activates synchronously, publishes one `JUDGE_PORT` coordinator and closes it
at run end. The host supplies the pure `requiredFor` predicate; the capability contributes no human
input requirement or tools. Consumers obtain the port lazily after activation. Each physical work
run has independent caches and cancellation, even when sessions are shared.

Command/effect methods accept JSON case facts and separate trusted snapshot/fence/validation bindings.
The coordinator deduplicates concurrent identical reviews and caches only host-validated allow/deny
receipts. Keys include work run, path, full snapshot/case, model, TTL, limits and fixed policy. Compile
results are never cached; an installed snapshot becomes the key for the validated decide receipt.
Host validators run again on reuse. Uncertainty, stale state and failures are not cached. Retirement
aborts children, clears caches and refuses new inference. Authority installation, refusals, effect
consumption and human fallback remain in the Kernel. Command, effect and configuration consumers use this shared port.

The native Kernel binds a projected internal store once per host and uses the exact effective base
provider from the work run. Host observation metadata identifies consumer, stage and private
execution; it does not enter semantic cache keys. Each actual call emits one payload-free parent
event, while cache reuse emits none. The child keeps its own accounting. Memory indexing excludes
the capability; the Container composition does not install the native host factory.

Effect cases carry `facts` and an optional trusted `host_transition` in the volatile message.
The case-specific transition token does not alter the stable snapshot prefix. Compile supplies its
transition through the authoritative tool result; host adapters revalidate it before effect use.

Host adapters use `canonicalJudgeJson` for in-flight identities and case-bound transition digests,
matching coordinator cache identity despite object-property order differences.
