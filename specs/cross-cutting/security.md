# Path confinement, secrets, redaction, environment filtering and trust

> Implemented at `packages/...`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

This subsystem is the set of mechanisms that bound what an agent-driven run can *reach* and what a
run's machinery is allowed to *emit*. It has five largely independent halves, all reachable from
code and none of them a sandbox:

1. **Path confinement** — every coding tool resolves a caller-supplied path through one function,
   `resolvePath`, which delegates the confined branch to the canonical containment proof
   (`packages/tools/src/lib/paths.ts`) before the tool touches the target. Two read tools additionally admit the
   workspace's machine-state root, because that is where an oversized tool result is spilled and the
   model is handed the path to read it back (`packages/tools/src/config.ts`).
2. **Redaction** — one module, `packages/capability/src/sanitize.ts`, owns every secret pattern in the
   repository, and publishes **two** rule sets: one for content that is replayed verbatim (a trace's
   tool arguments and results) and one, with more reach and more false positives, for free text bound
   for the disk or the model.
3. **Environment filtering** — a hook subprocess's environment is built keep-list-first, then filtered
   against a per-run credential denylist derived from that run's own configuration
   (`packages/hooks/src/env.ts`); a stdio MCP child gets a fixed safe base plus only what its own
   `env` block names (`packages/mcp-client/src/client.ts`); a shell/monitor command spawned by the
   toolset has the host's credential variables deleted from its environment
   (`packages/tools/src/sandbox.ts`); and a Clarvis-owned Git subprocess that selects a repository
   removes Git's repository-local environment before it starts
   (`packages/paths/src/git-environment.ts`).
4. **Secret storage** — `keys.json` under the global directory, written `0o600` inside a `0o700`
   directory (`packages/kernel/src/secrets/secret-store.ts`,
   `packages/paths/src/constants.ts`), exposed over the protocol as a **names-only** read
   surface (`packages/protocol/src/secrets.ts`).
   `subscriptions.json` follows the same owner-only durable-store boundary. Operator storage
   inventory reports only whether each file exists and whether its mode is owner-only; it never
   returns path, size, content, provider or token metadata (`CredentialFilePosture` in
   `packages/protocol/src/storage.ts`; `credentialPosture` in
   `packages/kernel/src/storage/storage-service.ts`).
5. **Workspace trust** — a cloned repository's `.clarvis/settings.json`, agent files, and complete
   inventory of `scope: "workspace"` plugins are repository-authored executable surfaces. Risky
   settings and agent files are withheld, and selected workspace-owned plugins stay inactive, until
   the operator approves the exact current fingerprint once. That approval covers every repository
   plugin rather than requiring one decision per plugin or Extension Profile. Global plugins are
   operator-owned installations and require no second workspace approval
   (`packages/kernel/src/config/workspace-trust.ts`,
   `packages/kernel/src/extension-profiles/extension-profile-manager.ts`).

Two properties recur across all five and are worth stating once. First, refusals aimed at the **model**
never name the escape hatch: `assertWithinWorkspace`'s message states the boundary and closes the futile
move, and an architecture test scans every tool string for remediation phrasing
(`packages/tools/src/lib/paths.ts`, `packages/tools/tests/architecture/no-bypass-hints.test.ts`).
Second, what a filter withholds is **counted, never named** — the hook filter returns per-rule counts
and the log line says so explicitly (`packages/hooks/src/env.ts`,
`packages/hooks/src/capability.ts`).

Delegated to siblings: server authentication and bind policy
([hosts/server-auth.md](../hosts/server-auth.md)), command approval and the guard judge
([execution/command-guard.md](../execution/command-guard.md)), native Bubblewrap/Seatbelt sandboxing
([execution/sandbox.md](../execution/sandbox.md)), the `.clarvis`/state directory layout itself
([foundations/paths.md](../foundations/paths.md)), and release artifact identity, checksums, download
bounds, staging, and activation ([distribution-and-updates.md](distribution-and-updates.md)).

## 2. Surface

### 2.1 Redaction — `@clarvis/capability`

| Export | Signature | Rule set applied |
| --- | --- | --- |
| `sanitizeErrorMessage` | `(message: string) => string` (`packages/capability/src/sanitize.ts`) | `TRACE_RULES_COARSE` = trace rules **plus** the 48-char catch-all (`packages/capability/src/sanitize.ts`) |
| `sanitizeToolPayload` | `(message: string) => string` (`packages/capability/src/sanitize.ts`) | `TRACE_RULES` — no catch-all (`packages/capability/src/sanitize.ts`) |
| `sanitizeText` | `(text: string) => string` (`packages/capability/src/sanitize.ts`) | `TEXT_RULES` — unquoted key/value rule **and** the catch-all (`packages/capability/src/sanitize.ts`) |
| `sanitizeDeep` | `<T>(value: T, redact?: (t: string) => string) => T` (`packages/capability/src/sanitize.ts`) | walks arrays/plain objects; defaults `redact` to `sanitizeToolPayload` (`packages/capability/src/sanitize.ts`) |

Re-exported by `packages/capability/src/index.ts`. `@clarvis/kernel/policy` re-exports
`sanitizeText` and `sanitizeErrorMessage` **by identity** (`packages/kernel/src/policy.ts`) —
`@clarvis/code` reaches the canonical rules only through that re-export
(`packages/kernel/tests/component/public-entrypoints.test.ts`). `@clarvis/memory` re-exports
`sanitizeText` and deliberately not `sanitizeDeep` (`packages/memory/src/index.ts`).

### 2.2 `${VAR}` reference syntax — `@clarvis/capability`

| Export | Signature | Notes |
| --- | --- | --- |
| `envRefPattern` | `() => RegExp` (`packages/capability/src/env-ref.ts`) | `/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g`; a **fresh** instance per call |
| `extractEnvRefs` | `(template: string) => string[]` (`packages/capability/src/env-ref.ts`) | names in order, duplicates kept |
| `interpolateEnvWith` | `(value, lookup) => { resolved, missing }` (`packages/capability/src/env-interpolate.ts`) | unset → empty string + recorded in `missing` |
| `resolveStringMapWith` | `(map, lookup) => Record<string,string>` (`packages/capability/src/env-interpolate.ts`) | all-or-nothing |
| `resolveStringMap` | `(map, env) => Record<string,string>` (`packages/capability/src/env-interpolate.ts`) | reads `NodeJS.ProcessEnv` |
| `MissingEnvVarsError` | `class … { missing: string[] }` (`packages/capability/src/env-interpolate.ts`) | message names the variables, never a value |

Exported at `packages/capability/src/index.ts`.

### 2.3 Forbidden provider body keys

`FORBIDDEN_PROVIDER_BODY_KEYS: readonly string[]` = `["messages","tools","model","stream","tool_choice"]`
(`packages/capability/src/provider-resolver.ts`). Enforced twice:

| Layer | Site | Effect |
| --- | --- | --- |
| Request validation | `packages/loop/src/validation/request/provider-rules.ts` | throws `ValidationError("invalid_provider_config", …, { reason: "forbidden_body_key", key })` |
| Adapter | `packages/llm/src/openai-compatible-request.ts` | silently `continue`s, dropping the key from the merged body |

`@clarvis/kernel/policy` re-exports it (`packages/kernel/src/policy.ts`) and the TUI uses it to warn
in the editor (`packages/code/src/features/providers/request-params.ts`).

For every *permitted* key, `applyBodyExtras` (`packages/llm/src/openai-compatible-request.ts`)
overlays the operator's `body` extras onto the assembled request body and treats an explicit `null`
value as **deleting** that key rather than sending a literal JSON `null`
(`if (value === null) delete out[key]`). Its own TSDoc states why: several escaped fields
(`stream_options` above all) are
ones Clarvis itself already puts in the body, so the hatch needs a way to make a key *gone*, and `null`
is the only spelling JSON allows for that in a settings file — the acknowledged cost is that an operator
cannot force a literal `null` through this same hatch.

### 2.4 Path confinement — `@clarvis/tools`

| Export | Signature | Behaviour |
| --- | --- | --- |
| `resolvePath` | `(input, workspaceRoot, confine = false, alsoAllow: readonly string[] = [], logger) => string` (`packages/tools/src/lib/paths.ts`) | normalizes/resolves, then asserts when `confine` |
| `assertWithinWorkspace` | `(abs, workspaceRoot, input, caseInsensitive = process.platform === "win32", alsoAllow = [], logger) => void` (`packages/tools/src/lib/paths.ts`) | throws `ToolError("path_escape")` |
| `displayPath` | `(absPath, workspaceRoot) => string` (`packages/tools/src/lib/paths.ts`) | `"."`, a forward-slashed relative path, or the absolute path when outside |
| `readFileOptions` | `(config, alsoAllow = []) => ReadFileOptions` (`packages/tools/src/lib/files.ts`) | returns `{}` when confinement is off |
| `assertNotSymlink` | `(target) => Promise<void>` (`packages/tools/src/lib/atomic.ts`) | `ToolError("invalid_input")` on an existing symlink |

Configuration fields (`packages/tools/src/config.ts`):

| Field | Default | File |
| --- | --- | --- |
| `confineToWorkspace: boolean` | `true` | defaulted |
| `stateRoot: string` | `workspaceStatePaths(workspaceRoot).root` | — |
| `temporaryRoots: readonly string[]` | `[]`; each entry must already be a directory; first root supplies the command temp environment | `RuntimeConfig`, `resolveConfig` |
| `readOnly: boolean` | `false` | — |
| `secretEnvNames?: readonly string[]` | absent | — |

The run-level knob is the environment variable `CLARVIS_AGENT_TOOLS_CONFINE`, default `true`
(`packages/capability/src/env.ts`), threaded into the toolset at
`packages/loop/src/runtime/capabilities/tools.ts`.

Its sibling schema entry is the deployment-wide ceiling `CLARVIS_AGENT_TOOLS_MAX_GRANT: z.enum(["none",
"read", "edit", "exec"]).default("edit")` (`packages/capability/src/env.ts`). `agentToolCaps(grants,
ceiling)` (`packages/loop/src/runtime/tools/builtin/grants.ts`) intersects an agent profile's
requested grants (`read_workspace`/`edit_workspace`/`run_commands`) against this ceiling's rank —
`none < read < edit < exec` — so the ceiling caps but never widens what a profile can reach; it is
consulted at `agentToolsActive` (`packages/loop/src/runtime/tools/builtin/grants.ts`) and again per agent scope in
`packages/loop/src/runtime/capabilities/tools.ts`.

### 2.4.1 Git repository environment filtering — `@clarvis/paths`

`withoutGitRepositoryEnvironment(source)` returns a fresh copy with every variable in Git's
`git rev-parse --local-env-vars` set plus `GIT_CEILING_DIRECTORIES` removed. Names compare exactly
on POSIX and case-insensitively on Windows (`packages/paths/src/git-environment.ts`). It
preserves transport and credential
inputs: its boundary is repository routing/storage/config inherited from a parent Git process, not a
blank or allowlisted child environment. The helper is exported from `@clarvis/paths`
(`packages/paths/src/index.ts`) and re-exported through `@clarvis/kernel/local` for the TUI's
existing package boundary (`packages/kernel/src/local.ts`).

### 2.5 Hook environment filtering — `@clarvis/hooks`

| Export | Signature | File |
| --- | --- | --- |
| `filterHookEnv` | `(source, opts?: { denyExact?, add? }) => { env, denied: { exact, shape } }` | `packages/hooks/src/env.ts` |
| `interpolatedNames` | `(template: string) => string[]` | `packages/hooks/src/env.ts` |
| `runCredentialNames` | `(ctx: RunCapabilityContext, extra: readonly string[]) => string[]` | `packages/hooks/src/capability.ts` |
| `WorkspaceHooksOptions.credentialNames` | `() => readonly string[]` | `packages/hooks/src/capability.ts` |

Both `filterHookEnv` and `interpolatedNames` are on the package barrel
(`packages/hooks/src/index.ts`).

### 2.6 Secrets — kernel and protocol

| Symbol | Signature | File |
| --- | --- | --- |
| `SecretService.listNames` | `() => Promise<string[]>` | `packages/protocol/src/secrets.ts` |
| `SecretService.set` | `(name, value) => Promise<void>` | `packages/protocol/src/secrets.ts` |
| `SecretService.delete` | `(name) => Promise<void>` | `packages/protocol/src/secrets.ts` |
| `SecretStore` | `{ path(); read(): SecretSnapshot; set(name,value); delete(name) }` | `packages/kernel/src/secrets/secret-store.ts` |
| `createFileSecretStore` | `(opts?: { dir?: string }) => SecretStore` | `packages/kernel/src/secrets/secret-store.ts` |
| `createSecretService` | `(store: SecretStore) => SecretService` | `packages/kernel/src/secrets/secret-store.ts` |
| `createKernelEnvironment` | `(values) => KernelEnvironment` (frozen copy) | `packages/kernel/src/ports/environment.ts` |
| `resolveSecretEnvironment` | `(environment, keyfile, sources) => KernelEnvironment` | `packages/kernel/src/ports/environment.ts` |

Wire methods `secrets.listNames` / `secrets.set` / `secrets.delete`, carrying
`metadata.sensitivity === "secrets"` (`OPERATIONS.secrets` in
`packages/kernel/src/transport/operations.ts`).

### 2.7 Workspace trust — `@clarvis/kernel`

| Symbol | Signature | File |
| --- | --- | --- |
| `WORKSPACE_RISK_FIELDS` | 8-element const tuple | `packages/kernel/src/config/workspace-trust.ts` |
| `stripWorkspaceRiskFields` | `(settings) => { settings, withheld }` | `packages/kernel/src/config/workspace-trust.ts` |
| `workspaceTrustFingerprint` | `(settings, agents, extensions?) => string \| undefined` | `packages/kernel/src/config/workspace-trust.ts` |
| `workspaceTrustVerdict` | `(fingerprint, key, trust) => WorkspaceTrustVerdict` | `packages/kernel/src/config/workspace-trust.ts` |
| `canonicalWorkspaceKey` | `(workspaceRoot) => string` | `packages/kernel/src/config/workspace-trust.ts` |
| `readWorkspaceTrustFile` | `(globalDir) => { trust?, error? }` | `packages/kernel/src/config/workspace-trust.ts` |
| `writeWorkspaceTrust` | `(globalDir, key, fingerprint \| undefined, now?) => void` | `packages/kernel/src/config/workspace-trust.ts` |
| `workspaceTrustSchema` | zod, `.strict()` | `packages/kernel/src/config/workspace-trust.ts` |

### 2.8 Wire error normalization — `@clarvis/kernel`

Constants and helpers in `packages/kernel/src/transport/stdio.ts`: `MAX_ERROR_MESSAGE_CHARS = 16_384`, `MAX_ERROR_DETAILS_BYTES = 64 * 1024`, `MAX_CLASSIFICATION_VALUE_CHARS = 1_024`, `terminalSafe`, `preservedErrorDetails`, `safeErrorDetails`,
`toEnvelope`. The parallel path for run events is
`packages/kernel/src/runs/map-events.ts` (`terminalSafe` over `sanitizeText`)
(`boundedCapabilityDetail`).

### 2.9 Remote MCP OAuth credentials — `@clarvis/mcp-client`

| Symbol | Security role | File |
| --- | --- | --- |
| `createMCPAuthorizationCoordinator` | loopback callback, random state, browser authority and same-key serialization | `packages/mcp-client/src/oauth.ts` |
| `MCPAuthorizationOptions.openAuthorizationUrl` | explicit host capability; omitted by headless hosts | `packages/mcp-client/src/oauth.ts` |
| `createMCPRemoteFetch` | resource-header isolation, OAuth destination validation and redirect control | `packages/mcp-client/src/remote-fetch.ts` |
| `createMcpOAuthCredentialStore` | validates, lease-serializes and durably writes the private store | `packages/mcp-client/src/oauth-store.ts` |
| `McpOAuthStoreError` | refuses corrupt, oversized, unreadable and unsafe paths without repair | `packages/mcp-client/src/oauth-store.ts` |

The file kernel supplies `<global>/state/mcp-oauth.json` and passes a browser opener only when its
host owns that authority (`packages/kernel/src/file-kernel.ts`). Tokens, codes, verifier,
state and client secrets therefore never become settings, request parameters, protocol DTOs or
diagnostic fields.

## 3. Data and formats

### 3.1 The redaction rule sets

Rules are `{ re: RegExp /* g */, replacement: string }` applied in order, each substitution threaded
into the next (`packages/capability/src/sanitize.ts`). The arrays are built once at module
load.

| Group | Members |
| --- | --- |
| `PRELUDE` | PEM `PRIVATE KEY` block → `[redacted-private-key]`; `Bearer …` → `Bearer [redacted]`; `Basic …` → `Basic [redacted]` |
| `HEADER_KEYS` | `authorization` / `x-api-key` / `api[-_]?key` `[:=]` **unquoted** value |
| `QUOTED_SECRET_WORDS` | `password\|passwd\|pwd\|token\|secret` `[:=]` **quoted** value only |
| `UNQUOTED_KEYS_AND_SECRET_WORDS` | the union of the previous two, matched **unquoted** |
| `TAIL` | sensitive JSON key/value; URL userinfo (scheme bounded to 31 chars); secret query params; JWT; `sk-`/`rk-`/`pk-`; `AIza`; `A[KS]IA…`; `gh[pousr]_`; `github_pat_`; `xox[baprs]-` |
| `COARSE_FALLBACK` | any unbroken 48+ base64url run → `[redacted]` |

Composition:

| Rule set | = |
| --- | --- |
| `TRACE_RULES` | `PRELUDE` + `HEADER_KEYS` + `QUOTED_SECRET_WORDS` + `TAIL` |
| `TRACE_RULES_COARSE` | `TRACE_RULES` + `COARSE_FALLBACK` |
| `TEXT_RULES` | `PRELUDE` + `UNQUOTED_KEYS_AND_SECRET_WORDS` + `TAIL` + `COARSE_FALLBACK` |

`sanitizeDeep`'s key-aware branch uses a separate, unanchored substring regex
`SENSITIVE_KEY`; a non-empty string under such a key that the string redactor left
unchanged is replaced wholesale with `"[redacted]"`.

Worked examples taken from the tests:

| Input | `sanitizeToolPayload` | `sanitizeText` |
| --- | --- | --- |
| `export TOKEN=supersecretvalue` | unchanged (`packages/capability/tests/unit/sanitize.test.ts`) | `[redacted]` |
| `const token = getToken(req);` | unchanged | — |
| `"integrity": "sha512-bbb…"` | unchanged | — |
| `{ note: "z".repeat(60) }` via `sanitizeDeep` | unchanged | `"[redacted]"` |
| `commit <40 a's>` | kept | — |
| `Q".repeat(48)` in an error | `[redacted]` via `sanitizeErrorMessage` | — |

### 3.2 `keys.json`

Path: `globalPaths(dir).keysFile` = `<global>/keys.json` (`packages/paths/src/global.ts`).
Schema: `z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1))`
(`packages/kernel/src/secrets/secret-store.ts`). Serialized as
`` `${JSON.stringify(values, null, 2)}\n` `` through `writeFileAtomicSync`, whose defaults are
file mode `0o600` and directory mode `0o700` (`packages/paths/src/atomic.ts`,
`packages/paths/src/constants.ts`).

```json
{
  "ANTHROPIC_API_KEY": "sk-abc",
  "OPENAI_API_KEY": "sk-def"
}
```
(shape from `packages/kernel/tests/integration/secret-store.test.ts`)

`SecretSnapshot` is `{ values: Record<string,string>; error?: string }` (`packages/kernel/src/secrets/secret-store.ts`); a
missing file yields `{ values: {} }`, bad JSON yields `{ values: {}, error: "invalid JSON: …" }`, and a schema failure yields the first issue as `"<path>: <message>"`.

### 3.3 `workspace-trust.json`

Path `globalPaths(globalDir).workspaceTrustFile` = `<global>/workspace-trust.json`
(`packages/paths/src/global.ts`). Strict schema: a `workspaces` record from canonical workspace
path to a **non-empty array** of `{ fingerprint: /^sha256:[0-9a-f]{64}$/, approved_at: string }`
(`packages/kernel/src/config/workspace-trust.ts`).

```json
{
  "workspaces": {
    "/home/me/project": [
      { "fingerprint": "sha256:<64 hex>", "approved_at": "<iso-datetime>" }
    ]
  }
}
```

The key is `realpathSync(workspaceRoot)`, falling back to the input when it cannot be resolved. The fingerprint is `sha256` over `JSON.stringify(canonical(surface))`, where `canonical`
sorts object keys recursively and drops `undefined`. The surface is
:

| Key | Contents |
| --- | --- |
| `settings` | only the declared risk fields, keyed by their `WORKSPACE_RISK_FIELDS` name |
| `agents` | `{ name, digest: "sha256:<hex>" }` per `.clarvis/agents/*.md`, sorted by name |
| `sharedPrompt` | `{ digest: "sha256:<hex>" }` of `.clarvis/shared-agent.md` when that file exists |
| `extensions` | every installed `scope: "workspace"` plugin as an exact qualified ref plus atomic contribution digest, sorted canonically, when non-empty |

A workspace with none of those keys yields `undefined` — it is **inert** and never prompted about
(`workspaceExecutableSurface` in `packages/kernel/src/config/workspace-trust.ts`). Extension Profile
Extension Profile definitions and global plugin selections do not enter this executable surface. The
workspace plugin inventory does so before selection. Code resolves it after the lightweight startup
composer has painted, keeps repository plugins inactive in the meantime, and then asks automatically
when the complete TUI receives the verdict.

### 3.4 Risk fields

`WORKSPACE_RISK_FIELDS` (`packages/kernel/src/config/workspace-trust.ts`), in order:

| Field | Detection |
| --- | --- |
| `hooks` | `declaresSomething` — absent/`null`/`[]`/`{}` do not count |
| `mcpServers` | `declaresSomething` |
| `enabledPlugins` | `declaresSomething` |
| `marketplaces` | `declaresSomething` |
| `memory.provider` | only when `provider.kind` is `"executable"` or `"plugin"` |
| `plans.provider` | same predicate |
| `tasks.provider` | any object-valued `tasks.provider` |
| `providers.subscription` | provider entries whose kind attaches user subscription credentials |

Stripping removes the whole key for the first four, deletes `tasks` entirely for `tasks.provider`,
deletes only the `provider` sub-key for `memory`/`plans`, and removes only subscription-backed
entries from `providers`. A `memory: { provider: { kind:
"wiki" }, enabled: true }` survives untouched
(`packages/kernel/tests/integration/workspace-trust.test.ts`).

### 3.5 The wire error envelope

`toEnvelope` produces `{ code, message, details? }` (`packages/kernel/src/transport/stdio.ts`):

| Field | Derivation |
| --- | --- |
| `code` | the thrown `code` if it is in `ERROR_CODE_MEMBERS`, otherwise `"internal"` |
| `message` | `terminalSafe(rawMessage).slice(0, 16_384)` |
| `details` | `safeErrorDetails` — `boundJsonValue` (depth 16, 1024 nodes, 64 KiB chars, keys through `terminalSafe`) then `sanitizeDeep(…, terminalSafe)` |

`terminalSafe` = `sanitizeErrorMessage` then strip `ANSI_ESCAPE` then strip `TERMINAL_CONTROL`. On truncation the envelope becomes `{...preservedErrorDetails(value), truncated: true }`,
where the preserved set is `outcome_unknown` (boolean) plus the string fields `task_code`,
`memory_code`, `current_revision`, `expectedRevision`, `actualRevision`, each capped
at 1024 chars.

### 3.6 `state/mcp-oauth.json`

The strict version-1 document maps 64-hex SHA-256 keys to SDK-validated registration/token records;
the raw workspace, owner and remote resource never appear as keys
(`packages/mcp-client/src/oauth-store.ts`, key derivation at
`packages/mcp-client/src/oauth.ts`). It is bounded to 1 MiB, 128 records and 512 KiB per
record (`packages/mcp-client/src/oauth-store.ts`). On POSIX it is written
`0600` below a `0700` directory; malformed data is an error, not an empty
fallback.

## 4. Behavior

### 4.1 Confining one tool path

`resolvePath` (`packages/tools/src/lib/paths.ts`):

1. `path.isAbsolute(input) ? path.normalize(input) : path.resolve(workspaceRoot, input)`.
2. If `confine`, call `assertWithinWorkspace(abs, workspaceRoot, input, undefined, alsoAllow, logger)`. Note `caseInsensitive` is passed `undefined`, so the parameter default
   `process.platform === "win32"` applies.
3. Return the **non-canonicalized** absolute path. The canonical form computed during the check is
   discarded; the tool then operates on the lexical path.

`assertWithinWorkspace` :

1. `target = canonicalizeAllowingMissing(abs)`.
2. For each candidate root in `[workspaceRoot...alsoAllow]`, canonicalize it the *same* way, fold
   both sides for case if required, and accept on equality or on `targetReal.startsWith(rootReal +
   path.sep)`. The trailing separator is what stops `C:\Projects\x` passing as a child of
   `C:\Proj`.
3. Otherwise log `tools.path_refused` with `reason: "unresolvable" | "outside_root"` and an
   `allow_roots_count`, never the roots themselves, and throw
   `ToolError("path_escape", …, { path: input })`.

`canonicalizeAllowingMissing` walks up from `abs` until `realpathSync.native` succeeds,
re-appending the skipped tail. Two branches matter:

| Condition | Result |
| --- | --- |
| `realpath` succeeds at `cur` | `path.join(real, ...tail)` |
| `cur` is itself a symlink and unresolvable | `undefined` → refusal |
| the walk reaches the filesystem root | `path.normalize(abs)` |

The `isSymbolicLink` stop is load-bearing and is pinned: a link out of the workspace whose target is
mode `0o311` cannot be `realpath`ed but *can* be written through, so treating unresolvable as inside
would admit that write (`packages/tools/tests/integration/paths.test.ts`). Conversely a
merely-unreadable child (`0o000` directory) is admitted so its own errno surfaces.

### 4.2 Which tools confine, and against which roots

Every tool passes `config.confineToWorkspace` as the `confine` argument and admits
`config.temporaryRoots`. State artifacts and selected skill execution roots are the only narrower
additions:

| Tool | `alsoAllow` | Site |
| --- | --- | --- |
| `read_file` | `[config.stateRoot, ...config.temporaryRoots]`; guard analysis also admits an exact verified state spill | `packages/tools/src/tools/read-file.ts`, `packages/tools/src/guard/context.ts` |
| `read_files` | `[config.stateRoot, ...config.temporaryRoots]`; guard analysis also admits exact verified state spills | `packages/tools/src/tools/read-files.ts`, `packages/tools/src/guard/context.ts` |
| every other native file tool | `config.temporaryRoots` | see the `resolvePath(` call in each `packages/tools/src/tools/*.ts` |
| `shell`, `monitor_start` guard analysis | `config.temporaryRoots` plus exact host-selected `config.skillExecutionRoots`; an absolute command head may use only a platform system executable root (including `/opt/homebrew` on Darwin) or configured sandbox runtime root, and that exception is occurrence-local so an identical operand remains outside; only when a sandbox is configured, each exact verified state spill is also admitted and mounted read-only | `packages/tools/src/guard/context.ts`, `packages/tools/src/lib/system-executables.ts`, `packages/tools/src/lib/state-artifacts.ts` |

The state-root widening remains reachable from exactly two call sites, both read-only. Temporary
roots are different: the loop creates one owner-only scratch directory per run and places it first,
then appends `systemTemporaryRoots()` — the existing environment temp plus `/tmp` on POSIX, or only
the environment temp on Windows. Guard analysis, native confinement, post-open validation and native
sandboxes admit the complete list, while the shell environment continues to name the owner-only
first root. An explicit absolute `mktemp -d` template may add exactly the new directory it created
after a before/after snapshot proves the match, lstat rejects symlinks, and uid ownership matches.
Lifecycle ownership remains separate: the loop removes only its run root and those exact registered
directories, never a system parent or unrelated pre-existing child. Production:
`WorkspaceStatePaths.runTempDir`, `createAgentToolsRunCapability`, `systemTemporaryRoots`, `RuntimeConfig.temporaryRoots`,
`RuntimeConfig.registerTemporaryRoot`, `snapshotExplicitTemporaryDirectories`,
`createdTemporaryDirectories`, `buildGuardContext`, and `readFileOptions`. Tests:
`packages/loop/tests/integration/command-guard-wiring.test.ts`,
`packages/tools/tests/integration/api.test.ts`, and
`packages/tools/tests/integration/guard-dispatch.test.ts`.

Skill execution roots are canonical directories exposed only by selected skills whose host root
opted into helper execution. They widen command path and `cwd` admission, while the dispatcher
denies every native file mutation beneath them. A native sandbox mounts them read-only; without one,
`shell` and `monitor_start` remain ordinary secret-scrubbed host processes, so the root is not an
immutability claim. Production: `packages/skills/src/registry.ts`,
`packages/loop/src/runtime/build-run-deps.ts`, `packages/tools/src/config.ts`, and
`packages/tools/src/core.ts`. Tests: `packages/skills/tests/integration/api.test.ts` and
`packages/tools/tests/integration/api.test.ts`.

The spill files state-root widening exists for are written by
`createToolSpill` (`packages/loop/src/runtime/context/tool-spill.ts`) and by `shell`'s
`spillTarget` (`packages/tools/src/tools/shell.ts`), both under
`workspaceStatePaths(workspaceRoot)`.

The state-spill exception does not mount or admit that directory. It recognizes only a direct
child whose basename belongs to the shared spill family, verifies that it currently is a regular
non-link file resolving under this workspace's `local` state directory, and admits that one path.
`read_file` and `read_files` may use that exact path without a sandbox. Command tools receive it only when
a sandbox policy exists, and add the same exact path to the call's read-only mounts; an unsandboxed
shell is refused so it cannot mutate a supposedly read-only artifact. This makes an absolute spill
pointer from a previous tool call usable without
exposing prompt history, monitor control files, memory machinery, plans locks, or another
workspace's state. Production: `readableStateArtifactPath`,
`sandboxWithReadableStateArtifacts`, `buildGuardContext`, `runCommand`, and `monitor_start`. Test:
`packages/tools/tests/integration/guard-dispatch.test.ts`.

Recognized spill writers use `FILE_MODE` (`0600` on POSIX), and bounded global housekeeping repairs
older recognized spill modes before applying the 24-hour age policy. Production:
`packages/tools/src/lib/output.ts`, `packages/loop/src/runtime/context/tool-spill.ts`, and
`sweepGlobalStateArtifacts` in `packages/paths/src/housekeeping.ts`. Test:
`packages/tools/tests/integration/output.test.ts`, `packages/loop/tests/integration/tool-spill.test.ts`,
and `packages/paths/tests/integration/housekeeping.test.ts`.

### 4.3 Post-open re-validation on a read

`readFileOptions(config, alsoAllow)` yields a `confinement` only when `confineToWorkspace` is set
(`packages/tools/src/lib/files.ts`). When present, after `open()` the reader runs
`assertOpenedFileConfined` :

1. `fs.realpath(target)`, `handle.stat({ bigint: true })`, `fs.stat(canonical, { bigint: true })`.
2. `assertWithinWorkspace(canonical, workspaceRoot, relForError, undefined, alsoAllow)`.
3. Compare `dev`/`ino` between the descriptor and the path; a mismatch throws
   `ToolError("path_escape", "Path changed while it was being opened: …")`.

All bytes are then read from that descriptor with `position: null`, so a later path swap cannot redirect the read.

Goal artifact evidence reuses the exported bounded descriptor reader with only the selected
workspace admitted, capped at 16 MiB. Model references do not select paths; paths come from the
user's declared criteria. Current digest validation is a snapshot, not a promise that a workspace
file can never change afterward. Completion still requires the host's final revalidation and
durable settlement. Production: `createGoalEvidenceSource` in
[evidence.ts](../../packages/kernel/src/goals/evidence.ts).
Test: artifact mutation and outside-workspace directory-link refusal in
[goal-runtime-port.test.ts](../../packages/kernel/tests/integration/goal-runtime-port.test.ts).

Call sites of `readFileOptions`: `packages/tools/src/lib/rg.ts`, `packages/tools/src/lib/rg.ts`, `packages/tools/src/tools/diff.ts`,
`packages/tools/src/tools/read-file.ts`, `packages/tools/src/tools/read-files.ts`, `packages/tools/src/tools/read-image.ts`,
`packages/tools/src/tools/apply-patch.ts`, `packages/tools/src/tools/edit-file.ts`, `packages/tools/src/tools/replace.ts`,
`packages/tools/src/tools/write-file.ts`.

`grep` additionally refuses the ripgrep path for a **confined directory** search and uses the
in-process walker instead, because handing a mutable directory pathname to a subprocess reopens the
window (`packages/tools/src/lib/rg.ts`); a single-file ripgrep search is fed
through stdin so the child never reopens the pathname.

### 4.4 Mutating writes

`writeAtomic` (`packages/tools/src/lib/atomic.ts`):

| Step |
| --- |
| `assertNotSymlink(target)` — refuse an existing symlink |
| `fs.mkdir(dirname(target), { recursive: true })`, remembering whether it created anything |
| capture the existing file's mode, or `0o666 & ~umask` for a new one |
| `writeFileDurable(target, content, { mode, dirMode })` |
| on failure, remove the directory this call created and rethrow |

The batch form `applyOpsAtomic` pre-flights every op through `validateTargets`, which calls `assertNotSymlink` on each rename source, rename destination and
create/modify target.

**The gap.** Neither path re-validates the *parent chain* after the confinement check. Confinement is
proved lexically/canonically at `resolvePath`; `mkdir`, staging (`fs.open(tmp, "wx")`) and the
`rename` that publishes it all take the pathname again. The only mutating tool whose race is observably
closed is one that reads the file first: `write_file` reads pre-existing content through
`readTextFile(…, readFileOptions(config))` (`packages/tools/src/tools/write-file.ts`), and that
read's descriptor check is what aborts the operation. The pinning test says so in its own title:
*"aborts write_file when its prior read detects a parent-link race"*
(`packages/tools/tests/integration/no-isolation.test.ts`). A `write_file` creating a **new**
file takes no such read—the read is inside `if (existed)`—and `mkdir`,
`remove`, `move` and `copy` never call `readFileOptions` at all.

### 4.5 Building a hook subprocess's environment

`filterHookEnv(source, { denyExact, add })` (`packages/hooks/src/env.ts`) iterates the source
once and applies, in this order:

| # | Rule | Effect |
| --- | --- | --- |
| 0 | `value === undefined` | dropped, uncounted |
| 1 | `KEEP_EXACT.has(name)` or a `LC_` prefix | kept unconditionally, counted as neither |
| 2 | `denyExact.has(name)` | dropped, `denied.exact++` |
| 3 | `isSecretName(name)` | dropped, `denied.shape++` |
| 4 | otherwise | kept |

`opts.add` is spread **last** and is never filtered. The keep-list is 31 exact names —
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `TZ`, `TERM`, the
Windows seven (`SystemRoot`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
`PROGRAMFILES`) and twelve toolchain roots (`BUN_INSTALL`, `MISE_DATA_DIR`, `ASDF_DATA_DIR`,
`NVM_DIR`, `PYENV_ROOT`, `RUSTUP_HOME`, `CARGO_HOME`, `GOROOT`, `GOPATH`, `JAVA_HOME`,
`SDKMAN_DIR`, `DOTNET_ROOT`) — plus the `LC_` prefix.

`isSecretName` is the disjunction of a separator-anchored word regex, `SECRET_NAME`
 — `authorization`, `auth`, `api[_-]?key`, `apikey`, `secret`, `token`, `password`,
`passwd`, `pwd`, `credential`, `credentials`, `session` (each bounded by `_`/start/end), plus
unanchored `private[_-]?key` and `access[_-]?key` — and thirteen credential-family prefixes,
`SECRET_PREFIX`, matched case-insensitively on the upper-cased name :
`AWS_`, `AZURE_`, `GCP_`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_`, `GITHUB_`, `GH_`, `NPM_`,
`DOCKER_`, `SSH_`, `GPG_`, `HF_`, `VAULT_`.

The per-run `denyExact` is `runCredentialNames(ctx, credentialNames?.() ?? [])`
(`packages/hooks/src/capability.ts`), assembled from four sources
(`packages/hooks/src/capability.ts`):

| Source | Extraction |
| --- | --- |
| each provider's `api_key_env` | the name verbatim |
| each provider's `headers` values | `interpolatedNames` |
| each provider **model**'s `headers` values (via `Object.values(provider.models ?? {})`) | `interpolatedNames` |
| each MCP server's `env` and `headers` values | `interpolatedNames` |
| `extra` — the host's whole-registry names | verbatim |

The `extra` half exists because a run's `servers` is narrowed to those some profile grants, while the
inherited process environment still carries every key the host resolved. The host supplies
it as `hookCredentialNames: managedSecretNames` (`packages/kernel/src/file-kernel.ts`), a function
that unions only `keys.json` names with the explicit `opts.keySources` names
(`packages/kernel/src/file-kernel.ts`) — **not** provider `api_key_env` or header refs, re-read
per call. This is a distinct function from `loadSecretNames` (described in §4.6), which the
kernel wires as `resolveSecretNames` for the toolset's own `secretEnvNames` and *does* additionally union
every provider's `api_key_env` and every provider/model header's interpolated names. The two lists are
therefore built independently, from two different kernel functions, for the two different subprocess
environments in §4.6 — not the same "whole-registry" computation reused twice.

The filtered environment becomes the runner's `baseEnv` (`packages/hooks/src/capability.ts`,
`packages/hooks/src/runner.ts`). Each hook spawn layers the four fixed `CLARVIS_HOOK_*` variables
and `CLARVIS_WORKSPACE_ROOT` on top; plugin hooks also receive their root/data under the borrowed and
native variable names, and tool hooks receive tool/full-name variables when present
(`packages/hooks/src/runner.ts`).

Only the counts are logged: `hooks.env_filtered` with `denied_count`, `denied_by_exact`,
`denied_by_shape` and the message *"the withheld variables are counted and never named, because the
denylist is derived from exactly this run's credentials"* (`packages/hooks/src/capability.ts`).

### 4.6 Other subprocess environments use distinct policies

| Consumer | Policy | File |
| --- | --- | --- |
| Clarvis-owned Git selecting a repository | `withoutGitRepositoryEnvironment(inherited)` — preserve ordinary/transport inputs, remove Git's complete repository-local set and `GIT_CEILING_DIRECTORIES` before `cwd`, `-C`, or a clone destination selects the repository | helper `packages/paths/src/git-environment.ts`; plugin fetch `packages/kernel/src/adapters/git/plugin-fetcher.ts`; plugin metadata `packages/kernel/src/adapters/filesystem/plugin-repository.ts`; memory workspace probe `packages/memory/src/workspace-state.ts`; client clone `packages/code/src/adapters/plugin-install.ts` |
| `shell` / `monitor` command (unsandboxed or `require_escalated`) | `withoutSecrets(process.env, secretEnvNames)` — a copy with the named keys deleted. Git credential output, `gh auth token`, Git `--exec` helpers and `scheme::` URLs are denied independently of review. Isolated container guests reject `require_escalated`. | `packages/tools/src/sandbox.ts` (`withoutSecrets`, applied by `sandboxCommand`); `packages/tools/src/lib/sensitive-commands.ts`; `packages/tools/src/lib/sandbox-permissions.ts` |
| stdio MCP child | `{ ...getDefaultEnvironment(), ...server.env }` — authored values are normally interpolated, but remain literal when a portable adapter sets `expandVariables: false`; the caller's environment is **never** the base | `buildTransport` in `packages/mcp-client/src/client.ts` |
| remote MCP request headers | authored headers follow `expandVariables`; `bearer_token_env_var` and `env_http_headers` always resolve their explicitly named values and the resulting headers remain confined to the configured resource origin | `buildTransport` in `packages/mcp-client/src/client.ts`; `createMCPRemoteFetch` in `packages/mcp-client/src/remote-fetch.ts` |
| capability executable (plans/memory/tasks provider) | `{ ...inherited, ...additions }` — the **whole** kernel environment plus the declaration's interpolated `env` | `packages/kernel/src/capability-executables/session-manager.ts` |

`secretEnvNames` for the toolset comes from `resolveSecretNames(ctx)`
(`packages/loop/src/runtime/capabilities/tools.ts`), which the file kernel binds to
`loadSecretNames` (`packages/kernel/src/file-kernel.ts`).

### 4.7 Resolving secrets into the kernel environment

`resolveSecretEnvironment(environment, keyfile, sources)`
(`packages/kernel/src/ports/environment.ts`) computes `managed = keys(keyfile) ∪ keys(sources)`
and, per name:

| `sources[name]` | Value |
| --- | --- |
| `"env"` | `environment.values[name]` |
| `"keyfile"` | `keyfile[name]` |
| `"auto"` (default) | `environment.values[name] ?? keyfile[name]` |

The result is re-frozen through `createKernelEnvironment`. `code`'s
`keyOrigin` mirrors the same precedence for display and reports `"unset"` rather than falling back when
a pinned source is absent (`packages/code/src/adapters/provider-secrets.ts`).

### 4.8 Secret storage mutations

| Operation | Steps |
| --- | --- |
| `read()` | absent file → `{ values: {} }`; JSON parse failure → `error`; schema failure → first-issue `error`; values otherwise |
| `set(name, value)` | reject a name failing `ENV_VAR_RE`; reject an empty value; **refuse while the current file is unparseable**; rewrite the whole map atomically |
| `delete(name)` | refuse while unparseable; no-op when absent; rewrite without the key |

`createSecretService` wraps the store and exposes `Object.keys(store.read().values)` as `listNames`
 — the only read path across the protocol boundary. `code`'s `KeysAdapter` holds only a
`Set` of names and never a value (`packages/code/src/adapters/provider-secrets.ts`).

### 4.9 Workspace trust state machine

Verdict computation, recomputed on every call (`packages/kernel/src/config/file-config-store.ts`):

| State | Condition | Effect on the merge / agents |
| --- | --- | --- |
| `inert` | `workspaceTrustFingerprint(...) === undefined` | nothing withheld |
| `unapproved` | no entry for this key (`packages/kernel/src/config/workspace-trust.ts`) | risk fields stripped; workspace agent files and `scope: "workspace"` Extension Profile plugins withheld; global installed plugins remain admitted |
| `trusted` | some recorded entry equals the current fingerprint | nothing withheld |
| `changed` | entries exist but none matches; reports the most recent as `approved` | withheld, same as `unapproved` |

An unreadable `workspace-trust.json` yields `{ trust: undefined }`, and `workspaceTrustVerdict` treats
that as an empty store — i.e. `unapproved`, never `trusted` (`packages/kernel/src/config/workspace-trust.ts`; stated at `packages/kernel/src/config/file-config-store.ts`).

Transitions:

| State | Event | New state | Effect |
| --- | --- | --- | --- |
| any | `approveWorkspace()` | `trusted` | `writeWorkspaceTrust(globalDir, key, fingerprint)` appends the entry if new (`packages/kernel/src/config/workspace-trust.ts`) |
| any | `revokeWorkspace()` | `unapproved` | `delete workspaces[key]` |
| `trusted` | the surface changes | `changed` | withheld again (`packages/kernel/tests/integration/workspace-trust.test.ts`) |
| `trusted`/`inert` | operator write through `ConfigService` or the approved native configuration capability | re-recorded over the new surface | `ConfigStore.withOperatorWrite` (`packages/kernel/src/config/config-store.ts`, `packages/kernel/src/config/file-config-store.ts`, `packages/kernel/src/configuration/native-configuration.ts`) |
| `unapproved`/`changed` | the same operator-authorized write surfaces | unchanged | `if (!carried) return out` |

Ordinary native file-mutation tools cannot write workspace-authored `.clarvis` or `.agents`
configuration. The dispatcher resolves both names through `@clarvis/paths`, rejects the operation
before guard review and directs the operator to `/clarvis-configure`, where consent and
`withOperatorWrite` preserve the trust transition above. Configuration reads remain available.
Command execution retains the shell/sandbox boundary and is explicitly excluded as an alternate
writer by the bundled guide. Production: `protectWorkspaceConfiguration` in
`packages/tools/src/core.ts` and `CLARVIS_CONFIGURE_SKILL` in
`packages/kernel/src/skills/clarvis-configure.ts`. Test: the authored-configuration mutation case in
`packages/tools/tests/integration/api.test.ts` and the shipped configuration skill assertions in
`packages/kernel/tests/component/builtin-skills.test.ts`.

An explicit approve/revoke is refused with `conflict` while any run is active, before the trust file
is changed. At an idle boundary, `resolveActive` recomposes the selected workspace Extension Profile (and
workspace-derived `builtin:default`) so approval admits its workspace-owned plugin units and
revocation withholds those units immediately; global installed plugins are unaffected
(`assertWorkspaceTrustTransitionAllowed` and `resolveActive` in
`packages/kernel/src/extension-profiles/extension-profile-manager.ts`; the idle/active transition case in
`packages/kernel/tests/integration/extension-profile-manager.test.ts` and the pre-write storage case in
`packages/kernel/tests/integration/workspace-trust.test.ts`).

`writeWorkspaceTrust` throws rather than overwrite when the existing store cannot be parsed
(`packages/kernel/src/config/workspace-trust.ts`) — but `withOperatorWrite` swallows that throw, because the settings or
agent file has already landed by then (`packages/kernel/src/config/file-config-store.ts`).

A workspace Extension Profile preview may approve only the fingerprint it just resolved; changing the
definition between preview and selection is a conflict. The resulting approval admits the plugin as
an atomic unit, including its normalized hooks. There is no mutable per-hook approval projection.
Extension Profile definitions and resolved snapshots never carry secrets. See
[Extension Profiles](../hosts/extension-profiles.md#43-preview-composition-trust-and-resume).

Two independent enforcement points read the verdict, and the code says gating only one would leave the
other open (`packages/kernel/src/config/file-config-store.ts` for the settings merge for agent files).

### 4.10 An error crossing the wire

Order in `toEnvelope` (`packages/kernel/src/transport/stdio.ts`):

1. `preservedErrorDetails(value)` is computed **from the raw details**, before bounding, so the
   reconciliation flags survive truncation.
2. `boundJsonValue` builds a finite, getter-free, acyclic copy — no `toJSON` and no user getter is
   invoked (`packages/kernel/src/core/bounded-json.ts`), with object keys passed through
   `terminalSafe` (`packages/kernel/src/transport/stdio.ts`).
3. `sanitizeDeep(bounded.value, terminalSafe)` redacts.
4. If the bound truncated, or the serialized result still exceeds 64 KiB, the details collapse to
   `{...preserved, truncated: true }`.
5. The code collapses to `internal` unless it is one of the eleven known `KernelErrorCode`s.
6. The message is `terminalSafe`d then hard-sliced at 16,384 characters.

Reordering 2 before 1 is what the truncation branch depends on — the preserved map is read from the
*original* object's own property descriptors, not from the bounded copy.

The capability-event path in `packages/kernel/src/runs/map-events.ts` is the same shape with
`sanitizeText` rather than `sanitizeErrorMessage` as the string redactor and a
64 KiB / depth-32 / 4096-node bound.

`toEnvelope` is called only where a request gets a JSON-RPC **response** frame
(`packages/kernel/src/transport/stdio.ts`, `writer.send({ t: "res", id, error: toEnvelope(err) })`).
A server→client **notification** carries whatever its call site put in `params`, with no generic
sanitization at the framing layer — `serveKernelOverStdio`'s `NotificationSender` is
`(method, params) => writer.send({ t: "note", method, params })`, passing `params` straight
to the frame writer. The ordinary `run.done` result is already sanitized upstream by the loop's own result mapping
(`packages/loop/src/runtime/run-response-mapping.ts`; see §7.2), but the one place
that constructs an error notification by hand is `packages/kernel/src/transport/server.ts`'s narrow
fallback for when a run's `handle.done` promise itself rejects (not the ordinary `status: "failed"`
path): it builds `{ code: "internal", message: sanitizeErrorMessage(...) }` with **no**
`terminalSafe` ANSI/control-byte stripping and no 16,384-character cap — only secret redaction.

### 4.11 Agent-name traversal guard

`requireAgentName(name)` (`packages/kernel/src/config/config-service.ts`) rejects unless
`/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/` matches **and** the name does not contain `".."`. It is called from
`getAgent`, `deleteAgent`, `writeAgent` and both halves of `renameAgent`. `:` is excluded deliberately, because a plugin-contributed agent is addressed
`<plugin>:<agent>` and is owned by neither writable scope.

### 4.12 Authorizing a remote MCP server

The SDK performs protected-resource discovery, client registration, PKCE and token exchange; Clarvis
owns the surrounding trust boundaries. It canonicalizes the remote resource into an owner/workspace
scoped hash, reuses only a registration whose redirect still matches, and creates 32 random
bytes of state (`packages/mcp-client/src/oauth.ts`). Every OAuth fetch target and
redirect is validated before the request leaves the process, and only HTTPS or loopback HTTP is
accepted (`packages/mcp-client/src/remote-fetch.ts`). Before invoking the host opener,
the same rule is applied to the browser URL (`packages/mcp-client/src/oauth.ts`).

Configured MCP resource headers are injected only into resource requests on the configured origin.
They are withheld from SDK discovery, registration, and token exchanges even on a shared origin;
request-defined SDK credentials take precedence, and a redirect cannot carry configured resource
credentials across origins (`packages/mcp-client/src/remote-fetch.ts`). The callback listener
binds the selected loopback interface for local callbacks, accepts only the session-selected GET
path, bounds fields, compares state timing-safely and never reflects a code/state in HTML
(`packages/mcp-client/src/oauth.ts`).

The store read uses `O_NOFOLLOW`, verifies the final object is a regular file, rejects a parent whose
real path differs, and wipes its read buffer (`packages/mcp-client/src/oauth-store.ts`). A
mutation acquires a local lease, re-reads and validates under it, asserts ownership immediately before
the durable replacement and refuses to overwrite malformed state. This narrows final
symlink and stable-parent attacks; it does not close the repository's existing parent-directory
TOCTOU family between validation and rename, so the limitation in invariant 10 remains explicit.

## 5. Invariants

1. **A confined tool path is compared canonically on both sides.** `assertWithinWorkspace` resolves the
   target *and* every candidate root through `canonicalizeAllowingMissing` before comparing, so a
   symlink cannot smuggle a target out and a symlinked workspace root does not produce false escapes.
   Production `packages/tools/src/lib/paths.ts`; pinned
   `packages/tools/tests/integration/paths.test.ts`.
2. **A path whose containment cannot be proven is refused, not admitted.** When the walk hits a symlink
   it cannot resolve, `canonicalizeAllowingMissing` returns `undefined` and the caller throws.
   Production `packages/tools/src/lib/paths.ts`; pinned
   `packages/tools/tests/integration/paths.test.ts` (a `0o311` link target).
3. **The prefix test requires a separator.** A sibling directory whose name merely starts with the
   root's is rejected. Production `packages/tools/src/lib/paths.ts`; pinned
   `packages/tools/tests/integration/paths.test.ts`.
4. **Case folding is Windows-only.** `forCompare` folds only when `caseInsensitive`, whose default is
   `process.platform === "win32"`. Production `packages/tools/src/lib/paths.ts`; pinned
   `packages/tools/tests/integration/paths.test.ts`.
5. **Only the two read tools widen confinement to the state root; every native file tool may use the
   complete configured temporary-root policy, and command tools may additionally address exact
   host-approved skill execution roots.** In the standalone library that policy defaults empty; the
   product loop supplies owner-only run scratch followed by the host environment temp and POSIX
   `/tmp`. State machinery therefore remains read-only, while host-native temp output is usable by
   later calls. System parents are access-only and selected skill roots are denied to native mutation.
   Command analysis additionally recognizes only an absolute segment head below a platform system
   executable root or configured sandbox runtime root as the executable. The exception is attached
   to that occurrence rather than its raw path string, so an identical later operand remains outside.
   The policy-facing command name is reduced to its basename and Windows `PATHEXT` suffixes are
   removed, so neither an absolute spelling nor `.exe`/`.com`/`.bat`/`.cmd` bypasses an extensionless
   deny entry.
   Production: `packages/tools/src/tools/read-file.ts`, `read-files.ts`, every other `resolvePath(`
   call site, `packages/tools/src/lib/files.ts`, `packages/tools/src/guard/context.ts`,
   `packages/tools/src/sandbox.ts` (`systemTemporaryRoots`),
   `packages/loop/src/runtime/capabilities/tools.ts` (`accessibleTemporaryRoots`,
   `ownedTemporaryRoots`), `packages/tools/src/lib/system-executables.ts`, and
   `packages/tools/src/core.ts`. Pinned by
   `packages/tools/tests/integration/api.test.ts`, `guard-dispatch.test.ts`, and
   `packages/loop/tests/integration/command-guard-wiring.test.ts`.
6. **A model-facing refusal never names the bypass.** No runtime string under `packages/tools/src`
   matches the remediation shape. Production `packages/tools/src/lib/paths.ts`; pinned
   `packages/tools/tests/architecture/no-bypass-hints.test.ts`, with the guard's own sensitivity
   asserted and its specificity.
7. **A read revalidates the opened object against the roots and against the descriptor's identity.**
   Production `packages/tools/src/lib/files.ts`; pinned end-to-end for `read_file` and `grep`
   at `packages/tools/tests/integration/no-isolation.test.ts`.
8. **A confined directory grep never runs ripgrep.** Production `packages/tools/src/lib/rg.ts`;
   pinned `packages/tools/tests/integration/no-isolation.test.ts` (which explicitly builds the
   config with `ripgrepAvailable: true`).
9. **No mutating tool writes through a symlink.** Production `packages/tools/src/lib/atomic.ts`,
   invoked; pinned
   `packages/tools/tests/integration/symlink.test.ts`.
10. **Workspace-confined mutation still has an open parent-directory TOCTOU.** Confinement is decided at
    `resolvePath` and the subsequent `mkdir`/`open("wx")`/`rename` all re-take the pathname
    (`packages/tools/src/lib/atomic.ts`). The one mutating tool with an observed
    mitigation gets it from its *prior read*, not from the write —
    `packages/tools/src/tools/write-file.ts`, and the test's own title says
    *"aborts write_file when its prior read detects a parent-link race"*
    (`packages/tools/tests/integration/no-isolation.test.ts`). `mkdir`, `remove`, `move` and `copy`
    call no `readFileOptions` at all. **Unpinned as a defect** — nothing asserts the residual exposure.
11. **`sanitizeToolPayload` never applies the coarse fallback.** Production
    `packages/capability/src/sanitize.ts`; pinned
    `packages/capability/tests/unit/sanitize.test.ts`.
12. **The trace rule set matches the generic secret words only against a quoted value**, so persisted
    source code is not corrupted. Production `packages/capability/src/sanitize.ts`; pinned
    `packages/capability/tests/unit/sanitize.test.ts`.
13. **`sanitizeText` reaches an unquoted assignment that `sanitizeToolPayload` deliberately leaves.**
    Production `packages/capability/src/sanitize.ts`; pinned
    `packages/capability/tests/unit/sanitize.test.ts`.
14. **`sanitizeDeep` redacts a short opaque value whose *key* looks like a credential**, wholesale,
    under either redactor. Production `packages/capability/src/sanitize.ts`; pinned
    `packages/capability/tests/unit/sanitize.test.ts`.
15. **The URL-credential rule's scheme group is length-bounded, keeping the sanitizer linear on a long
    unbroken token.** Production `packages/capability/src/sanitize.ts`; pinned
    `packages/capability/tests/integration/sanitize-runtime.test.ts`.
16. **`@clarvis/memory`'s barrel republishes `sanitizeText` by identity and does not publish
    `sanitizeDeep`.** Production `packages/memory/src/index.ts`; pinned
    `packages/memory/tests/architecture/barrel.test.ts`. (This is INV-090 in the
    code-derived catalog, owned by **memory-capability-and-tools**, `specs/capabilities/memory-capability.md`.)
17. **The kernel re-exports the canonical redactors by identity**, which is the only route by which
    `@clarvis/code` can reach them. Production `packages/kernel/src/policy.ts`; pinned
    `packages/kernel/tests/component/public-entrypoints.test.ts`, with the named replacements
    re-asserted.
18. **An untrusted server error is normalized before crossing the wire** (INV-207) — full statement
    owned by [hosts/kernel-transport.md](../hosts/kernel-transport.md) §5; this package
    supplies the two rule sets (`sanitizeDeep`/`sanitizeErrorMessage`) the wire applies.
19. **Truncating oversized error details never drops the reconciliation flags** (INV-208) — full
    statement owned by [hosts/kernel-transport.md](../hosts/kernel-transport.md) §5.
20. **Bounding runs before sanitizing.** `boundJsonValue` produces the finite, getter-free copy the
    recursive redactors then walk, so a cyclic or enormous graph never reaches them. Production
    `packages/kernel/src/core/bounded-json.ts`, applied at
    `packages/kernel/src/transport/stdio.ts` and `packages/kernel/src/runs/map-events.ts`.
    **Unpinned** as an ordering rule.
21. **`envRefPattern` returns a fresh `RegExp` on every call**, so no interleaved `replace`/`exec`
    depends on another's `lastIndex`. Production `packages/capability/src/env-ref.ts`; pinned
    `packages/capability/tests/unit/env-ref.test.ts`.
22. **The hook denylist and the interpolation resolvers read the same `${VAR}` syntax**, because both go
    through `extractEnvRefs`/`envRefPattern`. Production `packages/hooks/src/env.ts`
    against `packages/capability/src/env-interpolate.ts`; pinned by the two identical table-driven
    suites `packages/capability/tests/unit/env-ref.test.ts` and
    `packages/hooks/tests/unit/env.test.ts`.
23. **A missing `${VAR}` is reported by name and never by value.** `MissingEnvVarsError.missing` carries
    the distinct variable names. Production `packages/capability/src/env-interpolate.ts`;
    pinned `packages/capability/tests/unit/env-interpolate.test.ts`.
24. **The hook environment keep-list wins over both deny rules.** Production
    `packages/hooks/src/env.ts`; pinned `packages/hooks/tests/unit/env.test.ts` and, for
    the counts.
25. **A variable dropped by the exact denylist is never also charged to the shape rule.** Production
    `packages/hooks/src/env.ts`; pinned `packages/hooks/tests/unit/env.test.ts`.
26. **The hook filter names nothing it withheld.** `FilteredHookEnv` carries only counts, and the log
    line emits only counts. Production `packages/hooks/src/env.ts`,
    `packages/hooks/src/capability.ts`. **Unpinned** — no test asserts the absence of a name in
    the log fields.
27. **The per-run denylist covers a provider's *model*-level headers.** They are reached through
    `Object.values(provider.models ?? {})`; a `for…of` over the record would iterate nothing and throw
    nothing. Production `packages/hooks/src/capability.ts`, hazard stated.
    **Unpinned.**
28. **A stdio MCP child never inherits the caller's environment.** Its base is
    `getDefaultEnvironment()`, and declaring `env` *adds* to it rather than switching the child from
    "inherit everything" to "inherit a filtered set". Production
    `packages/mcp-client/src/client.ts`; pinned
    `packages/mcp-client/tests/unit/mcp-transport-env.test.ts`, including the property that the
    base does not depend on the identity of the caller's env object.
29. **A hook subprocess cannot read this run's provider credentials.** Production
    `packages/hooks/src/capability.ts` composing `packages/hooks/src/env.ts`; pinned
    end-to-end against a real subprocess at
    `packages/hooks/tests/integration/real-subprocess.test.ts`, which asserts the child prints
    two empty values.
30. **`keys.json` is written owner-only.** `writeFileAtomicSync` defaults to file `0o600` inside a
    `0o700` directory. Production `packages/kernel/src/secrets/secret-store.ts`,
    `packages/paths/src/atomic.ts`, `packages/paths/src/constants.ts`. **Unpinned**
    for the secret store specifically. The code records that the bits are inert on Windows
    (`packages/kernel/src/secrets/secret-store.ts`).
31. **A secret name must be an environment-variable identifier and a value must be non-empty.**
    Production `packages/kernel/src/secrets/secret-store.ts`; pinned
    `packages/kernel/tests/integration/secret-store.test.ts`.
32. **A corrupt `keys.json` is never silently overwritten.** Both `set` and `delete` throw while
    `read().error` is set. Production `packages/kernel/src/secrets/secret-store.ts`.
    **Unpinned** — the test suite covers the read-side error but not the refusal.
33. **`SecretService` exposes names only.** Production `packages/kernel/src/secrets/secret-store.ts`,
    contract `packages/protocol/src/secrets.ts`; pinned
    `packages/kernel/tests/integration/secret-store.test.ts`. The TUI adapter holds only names
    (`packages/code/src/adapters/provider-secrets.ts`).
34. **A workspace's risky settings never enter the merge while it is unapproved** — they are withheld
    *before* merging rather than filtered afterwards. Production
    `packages/kernel/src/config/file-config-store.ts`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts`, whose comment records that an
    earlier post-merge filter compared by object identity and therefore permitted everything it claimed
    to block.
35. **Every declared risk field is gated, not just `hooks`.** Production
    `packages/kernel/src/config/workspace-trust.ts`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts` (all eight).
36. **An untrusted workspace contributes no agent layer**, on both the listing and the effective-agent
    path. Production `packages/kernel/src/config/file-config-store.ts`. **Unpinned** —
    `workspace-trust.test.ts` covers the settings half only.
37. **An empty risky value is not a declared surface.** `hooks: []` / `mcpServers: {}` leave the
    workspace `inert`. Production `packages/kernel/src/config/workspace-trust.ts`; pinned
    indirectly at `packages/kernel/tests/integration/workspace-trust.test.ts` for a workspace
    with no risky key at all. **The empty-array case itself is unpinned.**
38. **Approval binds to the surface, not to the path.** Production
    `packages/kernel/src/config/workspace-trust.ts`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts`.
39. **An unreadable trust store means "nothing approved".** Production
    `packages/kernel/src/config/workspace-trust.ts`, consumed at
    `packages/kernel/src/config/file-config-store.ts`. **Unpinned.**
40. **A trust key is the realpath of the workspace root.** Production
    `packages/kernel/src/config/workspace-trust.ts`. **Unpinned.**
41. **An operator-authorized configuration write carries an existing approval and never creates
    one.** When the pre-write workspace verdict is `trusted` or `inert`,
    `ConfigStore.withOperatorWrite` records the already-verified post-write fingerprint only when
    the authorized file has its expected revision and every other executable input is unchanged.
    Concurrent drift or a different target revision leaves the resulting surface withheld. When
    the pre-write verdict is `unapproved` or `changed`, the write does not approve it. Both
    `ConfigService` mutations and approved native `configure_clarvis` workspace mutations use this
    boundary. Production:
    `packages/kernel/src/config/config-store.ts`, `packages/kernel/src/config/file-config-store.ts`
    and `packages/kernel/src/configuration/native-configuration.ts`; pinned by
    `packages/kernel/tests/integration/workspace-trust.test.ts` and
    `packages/kernel/tests/integration/native-configuration.test.ts`.
42. **An agent name is one filename segment.** No separator, no drive/stream separator, no leading dot,
    no `..`, no `:`. Production `packages/kernel/src/config/config-service.ts`;
    pinned across all four name-taking methods at
    `packages/kernel/tests/contract/config-service.test.ts`, and for the file store.
43. **A forbidden provider `body` key is refused by the schema *and* stripped by the adapter.**
    Production `packages/loop/src/validation/request/provider-rules.ts` and
    `packages/llm/src/openai-compatible-request.ts`; the constant is pinned against the TUI's
    suggestion list at `packages/code/tests/unit/request-params.test.ts` and against the editor
    warning.
44. **A malformed `${...}` reference in a provider or model header is a request-validation failure**,
    detected by removing every well-formed reference and checking for a residual `${`. Production
    `packages/loop/src/validation/request/provider-rules.ts`. **Unpinned** in that
    package's own suite as far as this survey found; the equivalent TUI predicate is pinned at
    `packages/code/tests/unit/request-params.test.ts`.
45. **Log verbosity and the audit channel are environment-only.** `CLARVIS_LOG_LEVEL`, `CLARVIS_LOG`
    and `CLARVIS_LOG_AUDIT` live in the env schema and in no settings block, with the stated reason
    *"a run that could write this through settings could silence the record of what it did"*.
    Production `packages/capability/src/env.ts`.
    **Unpinned.**
46. **A non-`ToolError` throw never reaches the model.** It is collapsed to
    `{"error":"internal","message":"internal error"}` and the stack goes to the warn sink. Production
    `packages/tools/src/errors.ts`. **Unpinned** as a leak-prevention rule.
47. **An agent profile cannot request a tool grant above the deployment ceiling.** `agentToolCaps`
    intersects the profile's requested grants with `CLARVIS_AGENT_TOOLS_MAX_GRANT`'s rank (`none <
    read < edit < exec`, default `edit`); `canMutate`/`canExec` can only be true when the ceiling's
    rank is at least `edit`/`exec` respectively, however the profile is configured. Production
    `packages/capability/src/env.ts`, `packages/loop/src/runtime/tools/builtin/grants.ts`,
    consulted and `packages/loop/src/runtime/capabilities/tools.ts`; pinned
    `packages/loop/tests/unit/grants.test.ts`.
48. **`resolvePath` never returns the canonical form it computes for the confinement check — every
    call site, without exception, gets the lexical (un-symlink-resolved) path back.** `resolvePath`
    itself only ever returns its local `abs` (`path.normalize`/`path.resolve` on the caller's input),
    on both the confined and unconfined branches (`packages/tools/src/lib/paths.ts`); the
    canonical form `assertWithinWorkspace` derives via `canonicalizeAllowingMissing`
    lives entirely inside that function's own stack frame, is compared only as a boolean
    prefix/equality test, and is never returned, assigned to an outer variable, or passed to
    a caller — `canonicalize` and `canonicalizeAllowingMissing` both lack the `export` keyword
    (`packages/tools/src/lib/paths.ts`), so no code outside this one file, and nothing the
    package's own barrel (`packages/tools/src/index.ts`, which does not re-export `./lib/paths` at
    all) could hand a consumer, could reach that value even if it wanted to. Every tool that turns a `resolvePath` result
    into a filesystem operation — `readRawFile` (`packages/tools/src/lib/files.ts`), and the
    `mkdir`/`open("wx")`/`rename` calls in `packages/tools/src/lib/atomic.ts` — takes
    that same lexical string, never a canonicalized one. For reads this is not a gap: item 7 above
    describes the second, independent canonicalization `assertOpenedFileConfined` performs on the
    *opened* file (`packages/tools/src/lib/files.ts`), tying the confinement re-check to the
    descriptor's `dev`/`ino` rather than to any string `resolvePath` could have carried forward — so a
    canonical path threaded through from `resolvePath` would have been redundant with, and no safer
    than, a second post-open canonicalization done fresh. For writes, item 10 already records that no
    such post-open re-check exists, which is the residual TOCTOU — a defect in what happens *after*
    `resolvePath`, not evidence that `resolvePath` was supposed to return something else. **Resolved**:
    the "lexical, discarded-canonical" shape is not a leftover of the confinement check design across
    every call site with no exception found; this closes one of the ambiguities
    the retired gap report counted as fully resolved.
49. **A Clarvis-owned Git command that selects its own repository cannot inherit another repository's
    routing, index, object store, shallow/graft/replace state, or local config.** The shared helper
    removes the complete set returned by `git rev-parse --local-env-vars`, case-insensitively, while
    preserving ordinary and transport variables. Production: `packages/paths/src/git-environment.ts`,
    applied to plugin fetch/inspection/revision, Marketplace clones, and memory workspace probes.
    Test: the complete pure matrix at `packages/paths/tests/unit/git-environment.test.ts`, a
    real clone under poisoned `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` at
    `packages/code/tests/integration/plugin-install.test.ts`, the injected kernel runner at
    `packages/kernel/tests/integration/local-observability.test.ts`, and the real workspace
    probe at `packages/memory/tests/integration/workspace-state.test.ts`.
50. **Remote OAuth credentials are isolated by workspace, owner, canonical resource URL and the
    configured client/callback metadata.** The tuple is hashed and only the digest keys the private
    document. Production: `packages/mcp-client/src/oauth.ts`; the workspace, owner, and URL
    dimensions are pinned at `packages/mcp-client/tests/integration/oauth.test.ts`, while the
    additional configuration dimensions have no direct key-isolation assertion.
51. **No OAuth fetch, redirect or browser destination can downgrade to non-loopback plaintext, and
    browser authorization cannot proceed without explicit host authority.** Production
    `packages/mcp-client/src/remote-fetch.ts` and
    `packages/mcp-client/src/oauth.ts`; pinned
    `packages/mcp-client/tests/unit/remote-fetch.test.ts` and
    `packages/mcp-client/tests/integration/oauth.test.ts`.
52. **The OAuth callback accepts only a bounded code paired with the timing-safe matching random
    state, and reflects neither.** Production `packages/mcp-client/src/oauth.ts`;
    pinned `packages/mcp-client/tests/integration/oauth.test.ts`.
53. **A corrupt, oversized or symlinked OAuth store is refused and never repaired by overwrite.**
    Production `packages/mcp-client/src/oauth-store.ts`; pinned
    `packages/mcp-client/tests/integration/oauth-store.test.ts`.
54. **A configured MCP resource credential cannot enter an OAuth exchange or overwrite an
    SDK-defined credential.** Resource headers are admitted only for resource requests on the
    configured origin, while OAuth discovery, registration and token traffic stays header-isolated;
    redirect hops are evaluated independently. Production:
    `packages/mcp-client/src/remote-fetch.ts`, constructed without SDK `requestInit` headers at
    `packages/mcp-client/src/client.ts`; pinned
    `packages/mcp-client/tests/unit/remote-fetch.test.ts`.

55. **A workspace Extension Profile activates operator-owned global plugins without another workspace
    approval. Every installed `scope: "workspace"` plugin enters one content-addressed workspace
    fingerprint before selection; approving it once covers all repository plugins and Extension Profile
    switches until that inventory changes. Hook definitions remain part of each atomic plugin
    digest.** Production:
    `workspaceTrustSurface`, `preview`, and `select` in
    `packages/kernel/src/extension-profiles/extension-profile-manager.ts`, folded through
    `WorkspaceExecutableSurface.extensions` in
    `packages/kernel/src/config/workspace-trust.ts`. Test:
    `packages/kernel/tests/integration/extension-profile-manager.test.ts` (complete pre-selection
    inventory, content invalidation, global-plugin activation without workspace approval,
    mixed-scope partial admission, one-approval Extension Profile switching, and matching reconnect
    fingerprint) and
    `packages/kernel/tests/integration/workspace-trust.test.ts` (extension surface changes the trust
    hash and is reported as withheld `extension_profile` until approved).

56. **Portable Agent Plugin process paths remain package- or client-state-confined.** A relative
    executable must resolve to a real file inside `PLUGIN_ROOT`; `cwd` may be rooted only in
    `PLUGIN_ROOT` or the dedicated `PLUGIN_DATA`; those reserved variables cannot be overridden by
    the plugin; and one format-owned expansion is followed by `expandVariables: false`, preventing
    ambient secret names from being interpolated accidentally. Production:
    `agentPluginCommand`, `agentPluginCwd`, and `normalizeAgentMcpServer` in
    `packages/kernel/src/plugins/plugin-manifest.ts`; persistent path ownership in
    `packages/kernel/src/plugins/plugin-runtime.ts`. Test: portable command/cwd/env and symlink cases
    in `packages/kernel/tests/integration/plugin-manifest.test.ts` plus literal-placeholder cases in
    `packages/mcp-client/tests/component/transport-builder.test.ts`.

57. **Skill helper execution is explicit, package-scoped and never automatic.** Only a root carrying
    host execution approval yields an `executionRoot`, the value exposed for one skill is that
    skill's own directory, and selecting it merely configures command confinement. Native mutations
    are refused; a native sandbox mounts it read-only; an unsandboxed command retains normal host
    rights and is not mislabeled isolated. Production: `packages/skills/src/registry.ts`,
    `packages/loop/src/runtime/build-run-deps.ts`, `packages/tools/src/config.ts`, and
    `packages/tools/src/core.ts`. Test: `packages/skills/tests/integration/api.test.ts` and
    `packages/tools/tests/integration/api.test.ts`.

58. **Borrowed `userConfig` is a name mapping, never a secret import.** Only a shape-matched borrowed
    manifest may map a whole `${user_config.key}` string in a stdio server's `env` to the destination
    `${DEST_ENV}` name. The declaration must be `type: "string"`, the block is capped at 128 entries,
    recursive inspection is bounded, and defaults/sensitive values are never consumed or logged.
    Embedded, undeclared, native-dialect, disabled-expansion, argv/cwd/url/header, or structurally
    excessive uses withhold only that MCP. Production: `resolveBorrowedUserConfig` in
    `packages/kernel/src/plugins/plugin-manifest.ts`. Test:
    `packages/kernel/tests/integration/plugin-manifest.test.ts`.

59. **A marketplace cannot redirect an install to a different plugin identity or a source the
    kernel will deterministically refuse.** Catalog parsing and acquisition share transport,
    selector, and npm-source validation. Each install carries the listing's expected name; a
    declared mismatch is refused, while an unnamed supported foreign manifest may use that stable
    marketplace identity. Production: `pluginGitUrlIssue`, `pluginGitSelectorIssue`, and
    `pluginNpmSourceIssue` in `packages/loop/src/settings/marketplace-schema.ts`,
    `marketplaceInstallSource` in `packages/code/src/adapters/marketplace.ts`, and `installPrepared`
    in `packages/kernel/src/plugins/plugin-service.ts`. Test:
    `packages/loop/tests/unit/marketplace-schema.test.ts`,
    `packages/code/tests/integration/marketplace.test.ts`, and
    `packages/kernel/tests/integration/plugin-service.test.ts`.

60. **An isolated guest receives execution material, not host authority.** The workspace already
    selected by the host is mounted read-write at `/workspace`, so project changes are immediate
    host changes rather than an isolated copy or atomic apply transaction. A linked worktree also
    receives its discovered Git common directory read-write at the same absolute guest path; this
    intentionally exposes that repository's shared objects, refs and worktree metadata. Existing
    workspace Clarvis/`.agents` control paths are nested read-only binds, and active Plans/Memory
    roots are prepared before launch so later host writes remain visible without becoming guest
    writes. Every reserved path is walked from the workspace root before engine invocation;
    symbolic-link ancestors, intermediate non-directories and special-file leaves fail closed, so
    a nested bind cannot be redirected outside the selected workspace. Model/subscription
    credentials, the engine socket, host environment, SSH agent, global Clarvis state and
    host-global extension roots remain absent. This contains guest authority over the rest of the
    host but does not protect writable project files from the guest; an operator who wants a
    separate checkout starts Clarvis in an ordinary Git worktree. The omitted network default is
    truthfully the broader ordinary `outbound` route, so readable guest data may be exfiltrated and
    host/LAN services may be reached; `none` is the explicit offline policy and unenforced
    public-only `internet` is refused. Mise-installed toolchains execute only from `/mise`: both
    engines supply a labelled local volume derived from owner,
    project, workspace, effective UID/GID and exact image. Rootful Docker selects the operator's
    numeric identity rather than root without DAC capabilities; rootless Docker uses its
    operator-mapped root and rootful user namespace remapping is refused. Podman requires rootless
    mode, uses operator-mapped `0:0`, and inspects effective capabilities, user, read-only root,
    no-new-privileges, cgroups and the bounded non-executable scratch before attach. Its admitted
    binds request shared SELinux relabeling without disabling host SELinux enforcement; relabeling
    persists on the selected host trees. A fixed networkless
    initializer receives only the cache, seeds image content with `CHOWN`, and keeps its marker
    outside the guest's mounted `data` subdirectory. The guest can mutate that cache and later guests in the same
    workspace/image can observe it, but the Clarvis host process does not mount or execute its
    contents and other workspace identities cannot select it.
    A preview request supplies only a guest port and display scheme: the host owns a
    bounded `127.0.0.1` listener and fixed engine argv, and closes it before container shutdown.
    The repository-root Docker context is independently deny-all with only reviewed source/build
    inputs re-included, and credential-shaped files are excluded again after those inclusions; a
    local runtime fixture or subscription store is therefore not sent to the engine during an image
    build. A separately configured runtime recipe is global operator authority: the host accepts
    only a bounded stable non-symlink, single-linked script whose opened inode resolves inside the
    global operator-owned recipe directory, gives Docker only that captured file plus fixed
    build-control files, blanks proxy build arguments, and binds exact base/script/builder/schema
    labels to the derived image. The script itself is intentionally sent to the selected Docker
    engine and runs as root with its selected build network; no model or guest operation can author,
    invoke or publish it. The recipe is not a secret channel: Clarvis supplies no build-secret
    input, and credentials embedded in its bytes, commands, files or output may persist at the
    selected engine. Recipe validation/build/identity failures never fall back to an
    environment without the requested dependencies. An operational Docker failure before guest
    execution may fall back only to an available, required native Sandbox; integrity, policy and
    handshake failures remain closed, and no run is replayed after guest execution begins. Skills
    cross the private channel only as a host-path-free catalog, admitted bodies/resources, and active
    plugins' already-resolved bootstrap bodies; no root is serialized or mounted. Memory crosses
    only as a provider-opaque seed and the four
    canonical read tools. Mutating memory tools are absent from the guest descriptor, definitions
    and prompt, and the host rejects a forged mutation even when its provider is writable.
    Host plan mutation authority is pinned to the current run's created or continued plan.
    Retention deletion requires the same canonical completed/discard plan and revisions in the
    owner's durable completed run trace, then uses host-selected CAS. Reading another plan never
    grants mutation or deletion. Bounded multipart transfer preserves canonical plan sizes while
    reserving response capacity before effects and revoking unfinished transfers on teardown.
    Production: `createHostPlansGrant` in
    [`plan-bridge.ts`](../../packages/kernel/src/runtime/plan-bridge.ts) and `createPlanTransferGrant`
    in [`plan-transfer.ts`](../../packages/kernel/src/runtime/plan-transfer.ts).
    Test: retention and CAS cases in
    [`runtime-plan-bridge.test.ts`](../../packages/kernel/tests/unit/runtime-plan-bridge.test.ts),
    and transfer count/byte, cancellation and revocation cases in
    [`runtime-plan-transfer.test.ts`](../../packages/kernel/tests/contract/runtime-plan-transfer.test.ts).
    Guest coding tools preserve the host's enablement, confinement and grant ceiling and the
    host's choice to omit tools. Preview requires enabled tools, `exec` and `run_commands`.
    Production: `createLocalContainerRuntime` in
    [`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts) and
    `createGuestLoopExecutor` in
    [`guest-loop-executor.ts`](../../packages/kernel/src/runtime/guest-loop-executor.ts).
    Test: native/guest policy parity in
    [`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).
    Private RPC admits at most 256 pending requests per direction and 8 MiB of inbound frame bytes
    before handler invocation; cancelled handlers retain admission until settlement. Capability
    brokers bound attempted call identities and aggregate replay responses, retaining no response
    body for non-idempotent calls. Matching late cancellations use bounded completion identities;
    mismatches fail closed. Production: `createExecutionPeer` in
    [`execution-rpc.ts`](../../packages/kernel/src/runtime/execution-rpc.ts) and
    `createCapabilityBroker` in
    [`authority-brokers.ts`](../../packages/kernel/src/runtime/authority-brokers.ts).
    Test: floods and late cancellation races in
    [`runtime-execution-rpc.test.ts`](../../packages/kernel/tests/contract/runtime-execution-rpc.test.ts),
    and retained-result admission in
    [`runtime-authority-brokers.test.ts`](../../packages/kernel/tests/unit/runtime-authority-brokers.test.ts).
    Cancellation keeps `runtime.start` pending until the guest settles; a matching late result for
    another locally cancelled RPC is consumed through a bounded identity tombstone, while a dead
    process/channel retires the generation before the next run. Control-pump rejection cannot skip
    model/capability revocation or snapshot disposal. Failed runtime cleanup remains owned and is
    retried by a later close rather than silently reported as success. Configured hook commands and
    HTTP/SSE MCP hooks remain admitted host callbacks; guest event contexts cannot select commands or policy.
    A `stdio` MCP hook returns through the closed `runtime.hook_mcp` operation to its active guest
    run, using only that run's enabled server snapshot and guest-owned connection manager. It never
    retries on the host; hook failure remains fail-open without changing placement. Production:
    `createHostHooksBridge` in
    [`packages/kernel/src/runtime/hooks-bridge.ts`](../../packages/kernel/src/runtime/hooks-bridge.ts)
    and `createGuestHookMcpCaller` in
    [`packages/kernel/src/runtime/hook-mcp.ts`](../../packages/kernel/src/runtime/hook-mcp.ts).
    Test: transport separation in
    [`packages/kernel/tests/integration/runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts)
    and the opt-in host-file boundary checks in
    [`packages/kernel/tests/integration/runtime-mcp-hooks.e2e.test.ts`](../../packages/kernel/tests/integration/runtime-mcp-hooks.e2e.test.ts).
    Tasks keeps its canonical guest capability over a strict host provider port with identity/write
    gates. Workflow children use host-assembled requests and one shared guest budget; unprojectable
    host capabilities refuse placement. Model leases admit exact profile, vision and effective judge
    pairs, with bounded, correlated progress frames and a separate terminal result.
    The goal projection accepts only factory-owned entry authority and pins session, instance,
    execution and objective revision. Its six closed operations cannot choose an owner, invoke user
    controls, admit a run or alter limits. The host revalidates persisted binding and per-operation
    cancellation inside each mutation; revocation prevents a queued write from publishing later.
    The canonical guest capability restricts goal tools to the entry agent. Forged scopes, duplicate
    capabilities, missing descriptors and workflow combinations are refused. Only the bounded current
    goal and evidence catalog cross; session archives, operation receipts and credentials stay host-owned.
    Production: `createHostGoalBridge` / `createGuestGoalCapability` in
    [goal-bridge.ts](../../packages/kernel/src/runtime/goal-bridge.ts) and `createGoalRuntimePort` in
    [runtime-port.ts](../../packages/kernel/src/goals/runtime-port.ts).
    Test: [runtime-goal-bridge.test.ts](../../packages/kernel/tests/integration/runtime-goal-bridge.test.ts)
    and goal continuation through the actual guest RPC in
    [runtime-capability-composition.test.ts](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts).
    The host resolves provider/model overrides from its captured registry and reconstructs model
    capabilities, ignoring guest-supplied configuration. Before any adapter call, user and tool
    media must be inline base64 image data within the complete-request byte bound; URL-backed
    media is rejected even for non-vision models. SDK asset downloads cannot extend an admitted
    provider destination to arbitrary guest-controlled host-network destinations. Payloads and
    URLs are excluded from refusal diagnostics. Per-call retry limits cross unchanged;
    bounded FIFO admission uses host model policy rather than container CPU allocation. Typed
    provider errors carry only sanitized bounded messages and closed recovery/usage fields, never
    stacks, causes, headers or response bodies. Ordinary HTTP/SSE MCP operations also remain on
    host-owned authenticated connections: `runtime.mcp` accepts only snapshot server names or
    run-owned leases and catalog-admitted operations, never endpoints, credentials or stdio
    commands. Environment-backed bearer/header values and saved OAuth are not copied into the
    guest. Authored declaration templates still cross as run configuration; do not embed literal
    credentials there. Remote effects remain possible with container network `none`. Elicitation
    returns to the live guest relay, and run disposal aborts acquisitions and releases leases.
    Production: `hostModelBroker` in
    [`local-container-runtime.ts`](../../packages/kernel/src/runtime/local-container-runtime.ts),
    `assertInlineModelMedia` in
    [`model-media.ts`](../../packages/kernel/src/runtime/model-media.ts),
    `encodeRuntimeProviderError` in
    [`provider-error.ts`](../../packages/kernel/src/runtime/provider-error.ts), and
    `createHostRemoteMcpBridge` in
    [`remote-mcp.ts`](../../packages/kernel/src/runtime/remote-mcp.ts).
    Test: authenticated HTTP/SSE and real SDK model cases in
    [`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts),
    including the guest-media download refusal, and inline/malformed-media checks in
    [`runtime-model-media.test.ts`](../../packages/kernel/tests/unit/runtime-model-media.test.ts),
    and closed snapshot/lease/catalog checks in
    [`runtime-remote-mcp.test.ts`](../../packages/kernel/tests/unit/runtime-remote-mcp.test.ts).
    Production: `createHostHooksBridge` in `packages/kernel/src/runtime/hooks-bridge.ts`;
    `createHostTasksGrant` in `packages/kernel/src/runtime/tasks-bridge.ts`;
    `createHostWorkflowBridge` in `packages/kernel/src/runtime/workflows-bridge.ts`;
    `runtimeModelPairs` in `packages/kernel/src/runtime/local-container-runtime.ts`;
    `streamHostModelCall` in `packages/kernel/src/runtime/model-stream.ts`; `.dockerignore`;
    `discoverGitWorkspace` in `packages/kernel/src/git-workspace.ts`; `readOnlyWorkspacePaths` in
    `packages/kernel/src/runtime/local-container-runtime.ts`;
    `prepareRuntimeCapabilityRoot` in
    `packages/kernel/src/runtime/runtime-workspace-control.ts`;
    `createArgs` in `packages/kernel/src/runtime/docker-backend.ts` and
    `packages/kernel/src/runtime/podman-backend.ts`; `prepareMiseCache` and `prepareCacheOwnership` in
    `packages/kernel/src/runtime/container-mise-cache.ts`; `createRuntimeAuthorityRouter` in
    `packages/kernel/src/runtime/local-container-runtime.ts`; `createRuntimePortPreview` and
    `createContainerRuntimePortPreview` in `packages/kernel/src/runtime/port-preview.ts`;
    `runtimeSettingsSchema` in `packages/kernel/src/runtime/settings.ts`;
    `resolveDockerRuntimeRecipe` in `packages/kernel/src/runtime/runtime-recipe.ts`;
    `createLazyRuntimeCoordinator` in `packages/kernel/src/runtime/lazy-runtime.ts`;
    `createExecutionPeer` in `packages/kernel/src/runtime/execution-rpc.ts`;
    `createIsolatedRunExecutor` in `packages/kernel/src/runtime/isolated-run-executor.ts`;
    `createRuntimeSkillCatalog` and `createRuntimeSkillBootstraps` in
    `packages/kernel/src/runtime/skills-bridge.ts`; `createHostMemoryBridge`,
    `validRuntimeMemoryDescriptor` and `createGuestMemoryCapability` in
    `packages/kernel/src/runtime/memory-bridge.ts`;
    `effectiveSandboxSettings` in `packages/kernel/src/sandbox/policy.ts`; `Containerfile.runtime`.
    Test: `Docker runtime backend` and `Podman runtime backend` in
    `packages/kernel/tests/unit/`; `runtime port preview` in
    `packages/kernel/tests/integration/runtime-port-preview.test.ts`; the gated
    `runtime-recipe.e2e.test.ts` canary;
    `local-docker-runtime.e2e.test.ts` canary;
    `packages/kernel/tests/integration/runtime-podman-isolation.e2e.test.ts`;
    `packages/kernel/tests/integration/local-podman-runtime.test.ts`;
    `packages/kernel/tests/unit/lazy-runtime.test.ts`;
    `packages/kernel/tests/contract/runtime-execution-rpc.test.ts`;
    `packages/kernel/tests/integration/isolated-run-executor.test.ts`;
    `packages/kernel/tests/integration/runtime-capability-composition.test.ts`;
    `packages/kernel/tests/integration/runtime-model-stream.test.ts`;
    `packages/kernel/tests/unit/runtime-tasks-bridge.test.ts`;
    `packages/kernel/tests/integration/runtime-docker-identity.e2e.test.ts` (gated Linux engine DAC
    canary);
    `packages/kernel/tests/unit/runtime-skills-bridge.test.ts`;
    `packages/kernel/tests/unit/runtime-memory-bridge.test.ts`;
    `packages/kernel/tests/integration/runtime-guest-loop.test.ts`;
    `packages/kernel/tests/integration/sandbox-policy.test.ts`;
    `packages/server/tests/architecture/docker-context.test.ts`
    (`allowlists the repository-root build context and re-excludes credentials`).

61. **A remote Code connection delegates machine/user authentication, host-key verification,
    transport integrity and encryption to OpenSSH
    without widening Clarvis authority.** The client spawns SSH with argv and no local shell,
    disables port, agent and X11 forwarding, validates its destination and restricts every remotely joined command
    token to a conservative shell-safe alphabet. Workspace and optional Extension Profile selection
    cross in one closed, bounded base64url payload. Local provider credentials, Clarvis discovery
    credentials and global configuration do not enter argv or the kernel wire. A local `ssh-agent`
    may authenticate without its socket being forwarded. OpenSSH selects identities, certificates,
    jump hosts, authentication order and host-key policy from its ordinary configuration; Clarvis
    leaves `StrictHostKeyChecking` to that configuration, forces `BatchMode=yes`, and offers no
    identity-file/password store. Operators establish the host key and noninteractive authentication
    before launch; missing access fails through captured SSH stderr rather than a controlling-terminal
    or askpass prompt after the TUI owns the screen. There is no second application encryption layer:
    SSH protects prompts, tool traffic and events in transit, while both endpoints see plaintext.
    The remote process resolves its own global state and subscription OAuth, fixes owner/workspace
    server-side, advertises the resulting session namespace, exposes hosted runs/goals but no
    machine-local controls, and closes on pipe loss. Production:
    `connectRemoteKernelOverSsh` in
    [connect-remote-ssh.ts](../../packages/kernel/src/hosting/connect-remote-ssh.ts),
    `serveRemoteFileKernelOverStdio` in
    [serve-remote-stdio.ts](../../packages/kernel/src/hosting/serve-remote-stdio.ts), and Code's
    [remote-kernel-arguments.ts](../../packages/code/src/adapters/remote-kernel-arguments.ts) and
    [remote-host.ts](../../packages/code/src/remote-host.ts). Test:
    [remote-ssh.test.ts](../../packages/kernel/tests/integration/remote-ssh.test.ts),
    [remote-stdio-host.test.ts](../../packages/kernel/tests/integration/remote-stdio-host.test.ts),
    [remote-kernel-arguments.test.ts](../../packages/code/tests/unit/remote-kernel-arguments.test.ts),
    and [host-kernel-options.test.ts](../../packages/code/tests/unit/host-kernel-options.test.ts).

## 6. Failure modes and degradation

The builtin [native self-configuration flow](../hosts/self-configuration.md) is explicitly admitted
through live-session human elicitation before leaving configured isolation. It exposes only mediated
authored-file operations and questions, with no shell, MCP, extension execution or continuation.
Private credential/state paths, stable symlinks and hardlinked leaves are excluded. Consent and its
nonce are not persisted or restored by TUI resume. This is native access with a file policy;
parent-directory TOCTOU and secret literals embedded in allowed documents remain explicit limits.
Production: `createNativeConfigurationRuns` and `configurationFileOperation` in
[native-configuration.ts](../../packages/kernel/src/configuration/native-configuration.ts) and
[files.ts](../../packages/kernel/src/configuration/files.ts). Test:
[native-configuration.test.ts](../../packages/kernel/tests/unit/native-configuration.test.ts),
[configuration-files.test.ts](../../packages/kernel/tests/unit/configuration-files.test.ts), and
the live-session/resume test in [run-host.test.ts](../../packages/code/tests/component/run-host.test.ts).

| Condition | Handler | Outcome |
| --- | --- | --- |
| Confined path outside every root | `packages/tools/src/lib/paths.ts` | `ToolError("path_escape")`, `{ path: input }`; message states the boundary is fixed before the run |
| Containment unprovable (unresolvable symlink) | `packages/tools/src/lib/paths.ts` → | same `path_escape`, logged with `reason: "unresolvable"` |
| Path swapped between check and open | `packages/tools/src/lib/files.ts` | `path_escape`, `"Path changed while it was being opened"` |
| `realpath`/`stat` failure during that check | `packages/tools/src/lib/files.ts` | mapped through `fsError` |
| Native mutation below a selected skill execution root | `protectSkillPackages` in `packages/tools/src/core.ts` | `path_escape` before guard/handler; no mutation runs |
| Container reserved path has a symlink ancestor, intermediate non-directory or special-file leaf | `inspectReservedWorkspacePath` in `packages/kernel/src/runtime/local-container-runtime.ts` | `RuntimeLaunchError("unsupported_policy")` before any engine call |
| Container `internet` policy requested without public-only enforcement | Docker and Podman adapters reject launch as `unsupported_policy`; neither silently substitutes ordinary outbound access | `network`/`networkArgs` in `packages/kernel/src/runtime/{docker,podman}-backend.ts`; adapter unit tests |
| Operational Docker startup failure with configured fallback | Required native Sandbox is probed and latched for the session; if unavailable, the run fails closed and never executes bare | `createLazyRuntimeCoordinator`; lazy-runtime and sandbox-policy tests |
| Runtime image integrity, effective-policy or guest-handshake failure | No fallback; the launch fails closed | `createLazyRuntimeCoordinator`; lazy-runtime tests |
| Runtime recipe path/content, build, base or derived-image identity failure | No fallback and no uncustomized launch; the host reports the bounded sanitized recipe error | `resolveDockerRuntimeRecipe`; runtime-recipe and lazy-runtime tests |
| Guest preview asks for an invalid/unlistening port or exhausts its mapping/relay bound | schema/probe/broker rejects the request; no public bind or arbitrary engine command is created | `createRuntimePreviewCapability` in `packages/kernel/src/runtime/preview-capability.ts`; `createRuntimePortPreview` in `packages/kernel/src/runtime/port-preview.ts`; preview integration tests |
| Unsafe or unsupported borrowed `userConfig` reference | `resolveBorrowedUserConfig` in `packages/kernel/src/plugins/plugin-manifest.ts` | only the affected MCP is withheld; safe sibling contributions survive |
| Write target is a symlink | `packages/tools/src/lib/atomic.ts` | `ToolError("invalid_input")`, `"Refusing to write through a symlink"` |
| Atomic write fails after creating a parent | `packages/tools/src/lib/atomic.ts` | the created directory is removed best-effort, then rethrow |
| Batch commit fails mid-way | `packages/tools/src/lib/atomic.ts` (doc) / | rolled back; a failed undo becomes `io_error` naming the unrestorable originals |
| Oversized tool result cannot be spilled | `packages/loop/src/runtime/context/tool-spill.ts`, `packages/tools/src/lib/output.ts` | degrades to a truncation marker naming no file; the run continues |
| Unset `${VAR}` in an interpolation-enabled MCP `env`/`headers`, an environment-backed MCP credential, or a provider header | `resolveStringMap` in `packages/capability/src/env-interpolate.ts` | `MissingEnvVarsError` naming the distinct variables; portable literal mode skips only authored MCP maps, not explicit environment-backed credential declarations |
| Marketplace source fails shared transport, selector, npm, or expected-name validation | `readSource` in `packages/loop/src/settings/marketplace-schema.ts`; `installPrepared` in `packages/kernel/src/plugins/plugin-service.ts` | listing remains visible but non-installable when acquisition is impossible; a staged identity mismatch is refused before inventory mutation |
| Forbidden provider body key, validation path | `packages/loop/src/validation/request/provider-rules.ts` | `ValidationError("invalid_provider_config")` — hard failure with a diagnostic |
| Forbidden provider body key, adapter path | `packages/llm/src/openai-compatible-request.ts` | **silently dropped** |
| `keys.json` missing | `packages/kernel/src/secrets/secret-store.ts` | `{ values: {} }` — tolerated |
| `keys.json` unparseable, or valid JSON with a key failing `ENV_VAR_RE` or a value failing `min(1)` | `packages/kernel/src/secrets/secret-store.ts` | empty values plus an `error` — `keysFileSchema` is `z.record(...)`, and Zod fails the **whole** parse on any one bad key/value rather than dropping it (verified against the installed `zod@^4.4.3`: `schema.safeParse({GOOD:"v", "1bad-key":"v"})` returns `success:false` with an `"Invalid key in record"` issue), so `parsed.success ? {values:...} : {values:{}, error:...}` takes the same empty-plus-error branch as unparseable JSON; `set`/`delete` then throw `"… is invalid (…) — fix it by hand first"` |
| `workspace-trust.json` unparseable, read | `packages/kernel/src/config/workspace-trust.ts` | `{ error }`; the verdict degrades to `unapproved` |
| `workspace-trust.json` unparseable, write | `packages/kernel/src/config/workspace-trust.ts` | throws — refuses to overwrite recorded approvals |
| …except when carrying an approval across an operator write | `packages/kernel/src/config/file-config-store.ts` | swallowed: the file already landed, so a phantom failure would be worse |
| Untrusted workspace | `packages/kernel/src/config/file-config-store.ts` | risky fields and agent files withheld; the run proceeds on the operator's config; `withheld_workspace_fields` is reported and the raw scope is still visible (`packages/kernel/tests/integration/workspace-trust.test.ts`) |
| Invalid agent name | `packages/kernel/src/config/config-service.ts` | `kernelError("invalid_request")` before any path is built |
| Unknown server error code on the wire | `packages/kernel/src/transport/stdio.ts` | collapses to `internal` |
| Error details unserializable/cyclic | `packages/kernel/src/transport/stdio.ts` | `safeErrorDetails` returns `undefined`; details are simply omitted |
| Capability event detail unserializable | `packages/kernel/src/runs/map-events.ts` | `"[unserializable capability event]"`, `truncated: true` |
| Non-`ToolError` thrown by a handler | `packages/tools/src/errors.ts` | generic `internal` to the model; the stack only to the warn sink |
| ripgrep probe throws at config time | `packages/tools/src/config.ts` | treated as "capability absent" |

Degradations worth naming explicitly, because they are *deliberate* and therefore easy to mistake for
bugs: a failed spill loses the middle of one tool result rather than the run
(`packages/loop/src/runtime/context/tool-spill.ts`); withholding a repository's risky fields
lets the run proceed rather than refusing to start
(`packages/kernel/src/config/workspace-trust.ts`); and the coarse fallback's false positives are
real — a 64-hex project id and a full UUID both read as credentials, which is why
`@clarvis/server` shortens ids to 12 characters before logging
(`packages/server/src/logging.ts`; pinned by
`packages/server/tests/unit/logging.test.ts`).

## 7. Coupling

### 7.1 What forces each edge

| Edge | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/hooks` → `@clarvis/capability` | runtime, static | `import { extractEnvRefs } from "@clarvis/capability"` (`packages/hooks/src/env.ts`); declared in `packages/hooks/package.json` |
| `@clarvis/tools` → `@clarvis/paths` | runtime, static | `workspaceStatePaths` for `stateRoot` (`packages/tools/src/config.ts`); `TMP_GLOB`/`writeFileDurable` in `packages/tools/src/lib/atomic.ts` |
| `@clarvis/tools` → *nothing else internal* | — | `packages/tools/package.json` lists only `@clarvis/paths`; the package therefore **cannot** call `sanitize*` |
| `@clarvis/kernel` → `@clarvis/paths` | runtime, static | `globalPaths(...).keysFile` / `.workspaceTrustFile`, `writeFileAtomicSync` (`packages/kernel/src/secrets/secret-store.ts`, `packages/kernel/src/config/workspace-trust.ts`) |
| `@clarvis/kernel` → `@clarvis/protocol` | type-only for `SecretService` | `import type { SecretService }` (`packages/kernel/src/secrets/secret-store.ts`) |
| `@clarvis/kernel/config/workspace-trust` → `@clarvis/loop/host` | runtime, static | `readJsonFile` (`packages/kernel/src/config/workspace-trust.ts`) |
| `@clarvis/code` → canonical redactors | runtime, static | only through `@clarvis/kernel/policy` (the `sanitizeText` import in `packages/code/src/adapters/session-store.ts` and `packages/code/src/adapters/diagnostic-session.ts`), pinned by `packages/kernel/tests/component/public-entrypoints.test.ts` |
| `@clarvis/llm` → `FORBIDDEN_PROVIDER_BODY_KEYS` | runtime, static | `packages/llm/src/openai-compatible-request.ts` |
| `@clarvis/loop` validation → the same constant | runtime, static | `packages/loop/src/validation/request/provider-rules.ts` |
| `@clarvis/trace` → `sanitizeDeep` | runtime, static | `packages/trace/src/json-trace-store.ts`, `packages/trace/src/journal.ts`, `packages/trace/src/trace-mapper.ts`, `packages/trace/src/testing.ts` |
| loop tools capability → `resolveSecretNames` | runtime, injected | optional port on `AgentToolsCapabilityOptions` (`packages/loop/src/runtime/capabilities/tools.ts`), bound by the file kernel at `packages/kernel/src/file-kernel.ts` |
| hooks capability → `credentialNames` | runtime, injected | optional callback (`packages/hooks/src/capability.ts`), bound by the file kernel at `packages/kernel/src/file-kernel.ts` |
| `@clarvis/mcp-client` → `@clarvis/paths` | runtime, static | private modes, local lease and durable replacement for OAuth credentials (`packages/mcp-client/src/oauth-store.ts`) |
| file kernel → MCP authorization | runtime, injected through loop | global store path and optional browser opener (`packages/kernel/src/file-kernel.ts`; `packages/loop/src/runtime/build-run-deps.ts`) |

### 7.2 Where redaction is actually applied

| Consumer | Function | Site |
| --- | --- | --- |
| trace event mapping | `sanitizeDeep` (default redactor) | `packages/trace/src/trace-mapper.ts` |
| trace store insert | `sanitizeDeep` over `request`/`response` | `packages/trace/src/json-trace-store.ts`, `packages/trace/src/testing.ts` |
| crash journal header | `sanitizeDeep` over `request` | `packages/trace/src/journal.ts` |
| kernel wire errors | `sanitizeErrorMessage` (inside `terminalSafe`) + `sanitizeDeep` | `packages/kernel/src/transport/stdio.ts` |
| kernel run/capability events | `sanitizeText` + `sanitizeDeep` | `packages/kernel/src/runs/map-events.ts` |
| kernel task errors | `sanitizeErrorMessage`, `sanitizeDeep` | `packages/kernel/src/tasks/task-service.ts`; `packages/kernel/src/tasks/task-provider-factory.ts` |
| loop run result mapping | `sanitizeErrorMessage`, `sanitizeDeep` | `packages/loop/src/runtime/run-response-mapping.ts` |
| memory run snapshot | `sanitizeDeep(run, sanitizeText)` — **before** any bound or write | `packages/memory/src/jobs.ts`; indexer task `packages/memory/src/indexer/run.ts` |
| memory tool results / seed / policy / health | `sanitizeText` | `packages/memory/src/tools.ts`; `packages/memory/src/seed.ts`; `packages/memory/src/recording-policy.ts`; `packages/memory/src/health.ts` |
| MCP client diagnostics | `sanitizeErrorMessage` | `packages/mcp-client/src/{connection,resources,resilient-session}.ts` |
| `code` session previews | `sanitizeText` on the first line, before truncation | `redactPreview` in `packages/code/src/adapters/session-store.ts` |
| `code` diagnostics | `sanitizeErrorMessage` + ANSI strip | `packages/code/src/adapters/diagnostic-session.ts` |
| LLM provider errors | `sanitizeErrorMessage` | `packages/llm/src/ai-sdk/errors.ts` |

`sanitizeToolPayload` has **no direct production call site** outside its role as `sanitizeDeep`'s
default parameter (`packages/capability/src/sanitize.ts`); its whole production reach is through
the four `sanitizeDeep` call sites in `@clarvis/trace` and the loop's result mapping.

### 7.3 Downstream of workspace trust

`stripWorkspaceRiskFields` is consumed only by `createFileConfigStore`
(`packages/kernel/src/config/file-config-store.ts`, applied once in `operatorLayers`), which is what makes
`file-kernel.ts` able to state that no hook filtering happens at the hook layer any more
(`packages/kernel/src/file-kernel.ts`).

## 8. Open questions

- ~~**Why the parent-directory TOCTOU is left open.**~~ **Recorded, behaviour
  unchanged.** The code showed the shape of the exposure and the read-side mitigation, and one test
  title named the race, but nothing in `packages/**` stated a decision, a threat model or a rejected
  fix — so the residual write-side exposure was derived from the *absence* of a `readFileOptions`
  call rather than read off any statement. `resolvePath`'s `@remarks` now carries it
  (`packages/tools/src/lib/paths.ts`): that what it returns is the lexically normalized `abs` and
  never the canonical form the check ran against; that the window is open for
  `mkdir`/`remove`/`move`/`copy` and for a `write_file` creating a new file; that the read path is
  not exposed the same way because a content read re-proves confinement after `open` via the
  descriptor's `dev`/`ino` identity, which is exactly why discarding the canonical form is harmless
  there and not here; and that closing it needs descriptor-relative mutation (`openat`/`renameat` and
  the Windows equivalent) shared by every mutating tool, because neither re-running `realpath` nor
  atomic replacement closes it — an atomic `rename` into a swapped parent is atomically outside the
  workspace. **The defect itself is unchanged and still open**; what changed is that the decision is
  readable in the owning source instead of only in `specs/known-issues.md`.
- **Why `capability` executables inherit the whole kernel environment** while stdio MCP children get a
  fixed safe base. **Still open, but now visible at the implementation branch that makes the choice**: the divergence
  is recorded in `processEnvironment`'s own TSDoc, naming both counter-examples — the MCP child's
  fixed safe base and the hook's keep-list-then-denylist — and stating plainly that a configured
  capability executable receives every credential the kernel holds, and that whether that is intended
  is the owner's call (`packages/kernel/src/capability-executables/session-manager.ts`).
  What has not changed is the behaviour or the absence of a test.
  `packages/mcp-client/src/client.ts` argues at length for the MCP policy;
  `packages/kernel/src/capability-executables/session-manager.ts` carries no rationale and no
  test for its environment shape. This is a live divergence, not obviously a bug — a plans/memory
  provider may need credentials — but nothing in the code says which.
- ~~**A stale rationale in `packages/hooks/src/env.ts`.**~~ **Resolved.** The comment claimed the
  secret-name vocabulary was duplicated because the two sides "live on opposite sides of a dependency
  edge this package must not close", naming `@clarvis/loop`'s trace sanitizer. That edge does not
  exist: the sanitizer is `SENSITIVE_KEY` in `@clarvis/capability`
  (`packages/capability/src/sanitize.ts`), which `packages/hooks/package.json` already declares
  and `packages/hooks/src/env.ts` already imports from. The remark now gives the reason that does
  hold — the two patterns are deliberately different because their failure modes are opposite: a
  redactor over-matching costs legibility, while dropping an environment variable over-matching
  breaks the hook, which is why this one is separator-anchored and carries `auth`, `credentials` and
  `session` (`packages/hooks/src/env.ts`).
  Whether the duplication is still wanted for the *behavioural* reason (`SECRET_NAME` is
  separator-anchored and adds `auth`/`session`/thirteen prefixes; `SENSITIVE_KEY` is an unanchored
  substring test) is not stated.
- **`metadata.sensitivity` is never enforced, `secrets.set` carries its value in cleartext, and the
  transport's two host policy hooks fail open with no production implementation** — settled against
  the code, with the stdio trust model that bounds it, in
  [kernel-transport.md](../hosts/kernel-transport.md) §6.3. **Recorded**: both hooks now
  state their own absence — `KernelServerOptions.authorize` and
  `KernelServerOptions.resolveConnection` each carry a `@remarks` naming what is unrestrained without
  them, why it is inert (no hosted case for this wire exists in the tree), and each other, since
  wiring one without the other is the incoherent state. Behaviour is unchanged and building the seam
  stays the owner's decision.
- **Whether `keys.json` values are ever redacted on the wire.** `secrets.set`'s params object contains
  the raw value; the redaction path (`toEnvelope`) applies only to *errors*, not to request params.
  Whether a request frame is ever logged is a question for [cross-cutting/observability.md](observability.md).
- **Unpinned rules found while surveying** (each already flagged in §5): the read-only nature of the
  the write-side TOCTOU residue (10), the bound-before-sanitize ordering (20),
  the "count, never name" property of the hook log (26), the model-level header extraction (27),
  `keys.json` file mode (30), the refusal to overwrite a corrupt `keys.json` (32), the agent-file half
  of workspace trust (36), the empty-array risk value (37), the "unreadable store means unapproved"
  degradation (39), the realpath trust key (40), the env-only log knobs (45), and the `internal`
  collapse of a non-`ToolError` throw (46).
- **`ALLOW_OUTSIDE_WORKSPACE` does not exist as a knob.** The name survives only in the architecture
  test's positive/negative fixtures (`packages/tools/tests/architecture/no-bypass-hints.test.ts`). The real controls are
  `AgentToolsOptions.confineToWorkspace` (`packages/tools/src/config.ts`) and
  `CLARVIS_AGENT_TOOLS_CONFINE` (`packages/capability/src/env.ts`). Whether the historical variable
  was ever read is not determinable from the current tree.
