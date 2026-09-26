# Deterministic execution policy

> Production: `packages/execpolicy/src/policy.ts` (`parseRuleDocument`, `evaluateCommand`),
> `packages/execpolicy/src/shell-analysis.ts` (`analyzeShell`, `dangerCandidates`),
> `packages/execpolicy/src/heuristics.ts` (`isDangerousArgv`),
> `packages/execpolicy/src/approval-policy.ts` (`parseApprovalPolicy`),
> `packages/kernel/src/execution/execpolicy-loader.ts` (`loadExecutionRules`), and
> `packages/paths/src/global.ts` / `workspace.ts` (execution rule paths).
>
> Test: `packages/execpolicy/tests/unit/policy.test.ts` and
> `packages/kernel/tests/unit/execpolicy-loader.test.ts`.

## Purpose and boundary

`@clarvis/execpolicy` classifies POSIX shell actions deterministically. It has no Clarvis runtime
dependencies, does not execute a command or select a reviewer. The Kernel loads
operator rules and calls `evaluateCommand` from its manual approval service
after the loop has applied hooks. Production: `packages/execpolicy/src/index.ts`,
`loadExecutionRules` in `packages/kernel/src/execution/execpolicy-loader.ts`,
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts`.
Test: `packages/execpolicy/tests/unit/policy.test.ts` (`rule evaluation`) and
`packages/kernel/tests/integration/approval-policy.test.ts`.

## Rule surface and classification

One versioned JSON document holds rules with source-local IDs, a nonempty literal argv-prefix
`pattern`, and `allow`, `prompt` or `forbidden`. A position can list literal alternatives. Optional
`justification`, `match` and `not_match` fields document and validate examples. A source identity is
the layer, file and digest. All matching rules are retained in the result; `forbidden` outranks
`prompt`, which outranks `allow`, across overlapping rules and composed segments. Missing matches
use fallback rather than becoming a fourth final decision. `host_disables_allows` ignores file allows
without suppressing prompt or forbidden rules. Production: `parseRuleDocument` and
`evaluateCommand` in `packages/execpolicy/src/policy.ts`. Test: `rule evaluation` in
`packages/execpolicy/tests/unit/policy.test.ts`.

Executable resolution is injected and receives the same cwd and PATH intended for execution.
An exact invocation matches directly; a rule naming a full executable path can also match a
resolver's trusted full path. An arbitrary binary does not acquire a known utility's identity from
its basename. No cached result can omit cwd or PATH. Production: `matchesRule` in
`packages/execpolicy/src/policy.ts`. Test: `resolver matches only trusted full executable identity`
in `packages/execpolicy/tests/unit/policy.test.ts`.

## Shell analysis and fallback

The bounded parser preserves empty arguments, quotes and escapes and decomposes literal `&&`, `||`,
`;` and `|` commands. It unwraps complete `sh`, `bash` and `zsh` `-c`/`-lc` invocations. Expansions,
substitutions, assignments, redirections, globs and control syntax yield an explicit incomplete
classification. No prefix of a byte-limited action is authorized as a complete action. Incomplete
actions are evaluated as their original shell invocation; incomplete analysis alone is not a danger
signal. A separate permissive scan can find literal forced `rm` risk in complex syntax but cannot
set `all_segments_explicitly_allowed`. Production: `analyzeShell`, `dangerCandidates` in
`packages/execpolicy/src/shell-analysis.ts` and `evaluateCommand` in
`packages/execpolicy/src/policy.ts`. Test: `literal shell analysis` in
`packages/execpolicy/tests/unit/policy.test.ts`.

The initial POSIX risk signal is `rm` with a force option and a path operand, including `-f`,
combined short options, `--force`, `--`, `env`, `sudo` and `trap`. Explicit allow replaces this
fallback for the matched command, while another matching prompt or forbidden rule still wins.
Prefix permissions do not verify scripts or filesystem content. Production: `isDangerousArgv` and
`isDangerousShell` in `packages/execpolicy/src/heuristics.ts`. Test: `force removal respects -- and
wrappers` and `explicit allow replaces the hazard fallback` in
`packages/execpolicy/tests/unit/policy.test.ts`.

## Approval policy

The accepted values are `on-request`, `untrusted`, `never`, or a granular object with required
`sandbox_approval`, `rules` and `mcp_elicitations`; optional `skill_approval` and
`request_permissions` default to false. A true category permits opening a request and never
approves it. `never` forbids any action that would need approval. Unmatched ordinary commands are
allowed under `on-request` and `never`; `untrusted` requests approval when a usable backend exists.
Danger and restricted-profile overrides request `sandbox_approval`; an explicit prompt rule requests
`rules`. An override in an unrestricted profile does not itself request approval. The package does
not implement a retry mode or create tools for the optional categories. Production:
`parseApprovalPolicy`, `canRequestApproval` in `packages/execpolicy/src/approval-policy.ts` and
`evaluateCommand` in `packages/execpolicy/src/policy.ts`. Test: `fallback and approval policy` in
`packages/execpolicy/tests/unit/policy.test.ts`.

## Sources and persistence

For eligible prompts, the Kernel selects a human in manual mode or `@clarvis/judge`
in auto mode; this changes the reviewer without changing deterministic
classification. `untrusted` retains human review. Production:
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts`.
Test: `packages/kernel/tests/integration/judge-approval.test.ts`.

`GlobalPaths.executionRulesDir` and `WorkspacePaths.executionRulesDir` resolve `rules/` under
their configuration roots; `executionRulesFile` names `default.json`. Kernel reads `.json` files
in lexical order from the global root and from an already admitted trusted workspace root. Plugins,
skills, tool responses and model arguments are not source layers. Host requirements remain separate.
Missing directories are empty. A malformed file discards all file layers for that load and returns
`invalid_rules` with a warning in the ConfigService rule view; a read error returns `io_failure`.
The execution service uses the fallback with host requirements after invalid rules and refuses I/O
failure. `writeExecutionRules` requires an explicit operator action, validates a whole replacement,
compares the exact source digest under a local lease and writes atomically. It defaults to global
unless the caller explicitly chooses a trusted workspace. Judge approval and model proposals have
no persistence path here. Production:
`globalPaths` in `packages/paths/src/global.ts`, `workspacePaths` in
`packages/paths/src/workspace.ts`, and `loadExecutionRules` / `writeExecutionRules` in
`packages/kernel/src/execution/execpolicy-loader.ts`. Test:
`packages/paths/tests/component/paths.test.ts` and
`packages/kernel/tests/unit/execpolicy-loader.test.ts`.

`ConfigService.getExecutionRules`, `checkExecutionRule` and `updateExecutionRules` expose the
effective sources, a no-execution check and a compare-and-swap replacement to authenticated
operators. Workspace trust comes from the Kernel store. The check reports matching rules,
fallback, approval need and sandbox bypass eligibility without contacting the judge. Production:
`createConfigService` in `packages/kernel/src/config/config-service.ts`, `serviceOperations` in
`packages/kernel/src/transport/operations.ts`. Test:
`packages/kernel/tests/integration/execution-rules-config.test.ts`.

Remembered allow suggestions reject generic one-token shell, interpreter, `env`, `sudo`, `git` and
`rm` prefixes. An operator can still consciously edit such a rule file. An explicit allow may later
enable a bypass only if every fully understood segment is explicitly allowed; no sandbox or read
prohibition is removed by this library. Production: `canSuggestRememberedAllow` and
`evaluateCommand` in `packages/execpolicy/src/policy.ts`. Test: `broad remembered allow suggestions
are refused` and `requires all literal segments to be explicitly allowed` in
`packages/execpolicy/tests/unit/policy.test.ts`.

Manual approval offers remembering only for one completely parsed literal segment. The shown argv
prefix is rechecked against the full action and current rules before a global allow is persisted;
an overlapping prompt or forbidden rule remains restrictive. A failed persistence attempt leaves a
valid one-time approval intact and reports that the prefix was not remembered. Production:
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts` and
`createIsolationService` in `packages/kernel/src/execution/isolation-service.ts`. Test:
`manual remember binds a shown literal prefix and a failed write keeps one-time approval` and
`manual remember is absent for a composed command` in
`packages/kernel/tests/integration/approval-policy.test.ts`.

## Coupling and invariants

**INV-EP1.** Analysis runs no shell, and an incomplete action cannot prove complete explicit
permission. Production: `analyzeShell` in `packages/execpolicy/src/shell-analysis.ts` and
`evaluateCommand` in `packages/execpolicy/src/policy.ts`. Test: `incomplete syntax never authorizes a
literal prefix` in `packages/execpolicy/tests/unit/policy.test.ts`.

**INV-EP2.** A malformed file never causes partial file-layer loading; host requirements remain.
Production: `loadExecutionRules` in `packages/kernel/src/execution/execpolicy-loader.ts`. Test:
`invalid file discards file layers but preserves host requirements` in
`packages/kernel/tests/unit/execpolicy-loader.test.ts`.

**INV-EP3.** The engine has no dependency on this package. Kernel owns rule loading and evaluation
behind the neutral action port. Production: `packages/loop/package.json`, `packages/kernel/package.json`,
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts`. Test: `bun run check:graph` and
`packages/loop/tests/architecture/reviewer-boundary.test.ts`.
