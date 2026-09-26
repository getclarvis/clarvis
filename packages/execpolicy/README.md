# @clarvis/execpolicy

Deterministic POSIX command classification. This package parses literal shell commands, matches
versioned argv-prefix rules, applies the initial forced-`rm` risk signal and classifies whether an
approval flow would be needed. It neither runs commands nor chooses the auto/manual reviewer. The
Kernel loader reads rule files and the Kernel approval service evaluates each
post-hook command before execution.

`evaluateCommand` accepts the exact command, cwd and PATH of the eventual execution, an optional
trusted executable resolver, rule sources, approval policy, backend availability, profile and override
facts. It returns `allow`, `prompt` or `forbidden`, matching rule identities, segment decisions,
analysis limit, stable reason and `all_segments_explicitly_allowed`. That last field is true only when
every fully parsed segment has an explicit allow and the final decision is allow. An opaque shell
invocation can match an explicit rule without claiming complete segment proof.

Rule documents are JSON `{ "version": 1, "rules": [...] }`. A rule's `pattern` is a nonempty
literal argv prefix; each position may instead contain a nonempty list of literal alternatives.
Optional `justification`, `match` and `not_match` fields document and validate examples.
`parseRuleDocument` rejects malformed files. `canSuggestRememberedAllow` rejects generic one-token
prefix suggestions, shell/interpreter wrappers and automatic `rm` prefixes; it
does not constrain deliberate operator edits. The Kernel's manual approval offers the shown literal
prefix only for a complete single-segment command and persists it under a digest-checked lease.

The strict parser understands quoting, escapes, empty arguments, `&&`, `||`, `;`, pipes and complete
`sh`/`bash`/`zsh` `-c` or `-lc` wrappers. Unsupported syntax has an explicit incomplete result.
The fallback sees the entire action and does not prompt solely because parsing was incomplete.
Permissive danger extraction can raise risk but cannot prove an allow. Prefix rules do not establish
script contents or filesystem integrity. This package has no Windows or PowerShell contract.

See [the execution policy spec](../../specs/execution/execpolicy.md). Run
`bun --filter @clarvis/execpolicy test`, `build` and `typecheck` from the repository root.
