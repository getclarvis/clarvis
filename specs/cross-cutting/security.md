# Path confinement, secrets, redaction, environment filtering and trust

> Implemented at `packages/...`. Every claim below is anchored to a file and line. Open questions
> are collected in the final section.

## 1. Purpose

This subsystem is the set of mechanisms that bound what an agent-driven run can *reach* and what a
run's machinery is allowed to *emit*. It has five largely independent halves, all reachable from
code and none of them a sandbox:

1. **Path confinement** — every coding tool resolves a caller-supplied path through one function,
   `resolvePath` (`packages/tools/src/lib/paths.ts:27`), which proves the canonicalized target sits
   under the workspace root before the tool touches it. Two read tools additionally admit the
   workspace's machine-state root, because that is where an oversized tool result is spilled and the
   model is handed the path to read it back (`packages/tools/src/config.ts:89`).
2. **Redaction** — one module, `packages/capability/src/sanitize.ts`, owns every secret pattern in the
   repository, and publishes **two** rule sets: one for content that is replayed verbatim (a trace's
   tool arguments and results) and one, with more reach and more false positives, for free text bound
   for the disk or the model.
3. **Environment filtering** — a hook subprocess's environment is built keep-list-first, then filtered
   against a per-run credential denylist derived from that run's own configuration
   (`packages/hooks/src/env.ts:175`); a stdio MCP child gets a fixed safe base plus only what its own
   `env` block names (`packages/mcp-client/src/client.ts:383`); a shell/monitor command spawned by the
   toolset has the host's credential variables deleted from its environment
   (`packages/tools/src/sandbox.ts:349`); and a Clarvis-owned Git subprocess that selects a repository
   removes Git's repository-local environment before it starts
   (`packages/paths/src/git-environment.ts`).
4. **Secret storage** — `keys.json` under the global directory, written `0o600` inside a `0o700`
   directory (`packages/kernel/src/secrets/secret-store.ts:104`,
   `packages/paths/src/constants.ts:40`,`:52`), exposed over the protocol as a **names-only** read
   surface (`packages/protocol/src/secrets.ts:14`).
   `subscriptions.json` follows the same owner-only durable-store boundary. Operator storage
   inventory reports only whether each file exists and whether its mode is owner-only; it never
   returns path, size, content, provider or token metadata (`CredentialFilePosture` in
   `packages/protocol/src/storage.ts`; `credentialPosture` in
   `packages/kernel/src/storage/storage-service.ts`).
5. **Workspace trust** — a cloned repository's `.clarvis/settings.json`, agent files, and complete
   inventory of `scope: "workspace"` plugins are repository-authored executable surfaces. Risky
   settings and agent files are withheld, and selected workspace-owned plugins stay inactive, until
   the operator approves the exact current fingerprint once. That approval covers every repository
   plugin rather than requiring one decision per plugin or Environment. Global plugins are
   operator-owned installations and require no second workspace approval
   (`packages/kernel/src/config/workspace-trust.ts`,
   `packages/kernel/src/environments/environment-manager.ts`).

Two properties recur across all five and are worth stating once. First, refusals aimed at the **model**
never name the escape hatch: `assertWithinWorkspace`'s message states the boundary and closes the futile
move, and an architecture test scans every tool string for remediation phrasing
(`packages/tools/src/lib/paths.ts:160`, `packages/tools/tests/architecture/no-bypass-hints.test.ts:81`).
Second, what a filter withholds is **counted, never named** — the hook filter returns per-rule counts
and the log line says so explicitly (`packages/hooks/src/env.ts:148`,
`packages/hooks/src/capability.ts:370`).

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
| `sanitizeErrorMessage` | `(message: string) => string` (`packages/capability/src/sanitize.ts:169`) | `TRACE_RULES_COARSE` = trace rules **plus** the 48-char catch-all (`packages/capability/src/sanitize.ts:128`) |
| `sanitizeToolPayload` | `(message: string) => string` (`packages/capability/src/sanitize.ts:181`) | `TRACE_RULES` — no catch-all (`packages/capability/src/sanitize.ts:120`) |
| `sanitizeText` | `(text: string) => string` (`packages/capability/src/sanitize.ts:194`) | `TEXT_RULES` — unquoted key/value rule **and** the catch-all (`packages/capability/src/sanitize.ts:134`) |
| `sanitizeDeep` | `<T>(value: T, redact?: (t: string) => string) => T` (`packages/capability/src/sanitize.ts:221`) | walks arrays/plain objects; defaults `redact` to `sanitizeToolPayload` (`packages/capability/src/sanitize.ts:223`) |

Re-exported by `packages/capability/src/index.ts:130-134`. `@clarvis/kernel/policy` re-exports
`sanitizeText` and `sanitizeErrorMessage` **by identity** (`packages/kernel/src/policy.ts:38-39`) —
`@clarvis/code` reaches the canonical rules only through that re-export
(`packages/kernel/tests/component/public-entrypoints.test.ts:22`). `@clarvis/memory` re-exports
`sanitizeText` and deliberately not `sanitizeDeep` (`packages/memory/src/index.ts:64`).

### 2.2 `${VAR}` reference syntax — `@clarvis/capability`

| Export | Signature | Notes |
| --- | --- | --- |
| `envRefPattern` | `() => RegExp` (`packages/capability/src/env-ref.ts:27`) | `/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g`; a **fresh** instance per call |
| `extractEnvRefs` | `(template: string) => string[]` (`packages/capability/src/env-ref.ts:37`) | names in order, duplicates kept |
| `interpolateEnvWith` | `(value, lookup) => { resolved, missing }` (`packages/capability/src/env-interpolate.ts:43`) | unset → empty string + recorded in `missing` |
| `resolveStringMapWith` | `(map, lookup) => Record<string,string>` (`packages/capability/src/env-interpolate.ts:67`) | all-or-nothing |
| `resolveStringMap` | `(map, env) => Record<string,string>` (`packages/capability/src/env-interpolate.ts:91`) | reads `NodeJS.ProcessEnv` |
| `MissingEnvVarsError` | `class … { missing: string[] }` (`packages/capability/src/env-interpolate.ts:19`) | message names the variables, never a value |

Exported at `packages/capability/src/index.ts:278-284`.

### 2.3 Forbidden provider body keys

`FORBIDDEN_PROVIDER_BODY_KEYS: readonly string[]` = `["messages","tools","model","stream","tool_choice"]`
(`packages/capability/src/provider-resolver.ts:40-46`). Enforced twice:

| Layer | Site | Effect |
| --- | --- | --- |
| Request validation | `packages/loop/src/validation/request/provider-rules.ts:41-49` | throws `ValidationError("invalid_provider_config", …, { reason: "forbidden_body_key", key })` |
| Adapter | `packages/llm/src/openai-compatible-request.ts:186` | silently `continue`s, dropping the key from the merged body |

`@clarvis/kernel/policy` re-exports it (`packages/kernel/src/policy.ts:41`) and the TUI uses it to warn
in the editor (`packages/code/src/features/providers/request-params.ts:196`).

For every *permitted* key, `applyBodyExtras` (`packages/llm/src/openai-compatible-request.ts:179-188`)
overlays the operator's `body` extras onto the assembled request body and treats an explicit `null`
value as **deleting** that key rather than sending a literal JSON `null` (`:187`: `if (value === null)
delete out[key]`). Its own TSDoc states why: several escaped fields (`stream_options` above all) are
ones Clarvis itself already puts in the body, so the hatch needs a way to make a key *gone*, and `null`
is the only spelling JSON allows for that in a settings file — the acknowledged cost is that an operator
cannot force a literal `null` through this same hatch (`:170-177`).

### 2.4 Path confinement — `@clarvis/tools`

| Export | Signature | Behaviour |
| --- | --- | --- |
| `resolvePath` | `(input, workspaceRoot, confine = false, alsoAllow: readonly string[] = [], logger) => string` (`packages/tools/src/lib/paths.ts:53-63`) | normalizes/resolves, then asserts when `confine` |
| `assertWithinWorkspace` | `(abs, workspaceRoot, input, caseInsensitive = process.platform === "win32", alsoAllow = [], logger) => void` (`packages/tools/src/lib/paths.ts:159-166`) | throws `ToolError("path_escape")` |
| `displayPath` | `(absPath, workspaceRoot) => string` (`packages/tools/src/lib/paths.ts:77-82`) | `"."`, a forward-slashed relative path, or the absolute path when outside |
| `readFileOptions` | `(config, alsoAllow = []) => ReadFileOptions` (`packages/tools/src/lib/files.ts:47`) | returns `{}` when confinement is off |
| `assertNotSymlink` | `(target) => Promise<void>` (`packages/tools/src/lib/atomic.ts:109`) | `ToolError("invalid_input")` on an existing symlink |

Configuration fields (`packages/tools/src/config.ts`):

| Field | Default | Line |
| --- | --- | --- |
| `confineToWorkspace: boolean` | `true` | `:78`, defaulted `:339` |
| `stateRoot: string` | `workspaceStatePaths(workspaceRoot).root` | `:89`, `:463` |
| `temporaryRoots: readonly string[]` | `[]`; each entry must already be a directory | `RuntimeConfig`, `createRuntimeConfig` |
| `readOnly: boolean` | `false` | `:74`, `:338` |
| `secretEnvNames?: readonly string[]` | absent | `:125`, `:467` |

The run-level knob is the environment variable `CLARVIS_AGENT_TOOLS_CONFINE`, default `true`
(`packages/capability/src/env.ts:112`), threaded into the toolset at
`packages/loop/src/runtime/capabilities/tools.ts:172`.

Its sibling schema entry is the deployment-wide ceiling `CLARVIS_AGENT_TOOLS_MAX_GRANT: z.enum(["none",
"read", "edit", "exec"]).default("edit")` (`packages/capability/src/env.ts:98`). `agentToolCaps(grants,
ceiling)` (`packages/loop/src/runtime/tools/builtin/grants.ts:39-52`) intersects an agent profile's
requested grants (`read_workspace`/`edit_workspace`/`run_commands`) against this ceiling's rank —
`none < read < edit < exec` — so the ceiling caps but never widens what a profile can reach; it is
consulted at `agentToolsActive` (`packages/loop/src/runtime/tools/builtin/grants.ts:66`) and again per agent scope in
`packages/loop/src/runtime/capabilities/tools.ts:161`.

### 2.4.1 Git repository environment filtering — `@clarvis/paths`

`withoutGitRepositoryEnvironment(source)` returns a fresh copy with every variable in Git's
`git rev-parse --local-env-vars` set plus `GIT_CEILING_DIRECTORIES` removed. Names compare exactly
on POSIX and case-insensitively on Windows (`packages/paths/src/git-environment.ts`). It
preserves transport and credential
inputs: its boundary is repository routing/storage/config inherited from a parent Git process, not a
blank or allowlisted child environment. The helper is exported from `@clarvis/paths`
(`packages/paths/src/index.ts`) and re-exported through `@clarvis/kernel/local` for the TUI's
existing package boundary (`packages/kernel/src/local.ts:23`).

### 2.5 Hook environment filtering — `@clarvis/hooks`

| Export | Signature | Line |
| --- | --- | --- |
| `filterHookEnv` | `(source, opts?: { denyExact?, add? }) => { env, denied: { exact, shape } }` | `packages/hooks/src/env.ts:175` |
| `interpolatedNames` | `(template: string) => string[]` | `packages/hooks/src/env.ts:216` |
| `runCredentialNames` | `(ctx: RunCapabilityContext, extra: readonly string[]) => string[]` | `packages/hooks/src/capability.ts:298` |
| `WorkspaceHooksOptions.credentialNames` | `() => readonly string[]` | `packages/hooks/src/capability.ts:343` |

Both `filterHookEnv` and `interpolatedNames` are on the package barrel
(`packages/hooks/src/index.ts:14`).

### 2.6 Secrets — kernel and protocol

| Symbol | Signature | Line |
| --- | --- | --- |
| `SecretService.listNames` | `() => Promise<string[]>` | `packages/protocol/src/secrets.ts:15` |
| `SecretService.set` | `(name, value) => Promise<void>` | `packages/protocol/src/secrets.ts:23` |
| `SecretService.delete` | `(name) => Promise<void>` | `packages/protocol/src/secrets.ts:30` |
| `SecretStore` | `{ path(); read(): SecretSnapshot; set(name,value); delete(name) }` | `packages/kernel/src/secrets/secret-store.ts:24` |
| `createFileSecretStore` | `(opts?: { dir?: string }) => SecretStore` | `:75` |
| `createSecretService` | `(store: SecretStore) => SecretService` | `:135` |
| `createKernelEnvironment` | `(values) => KernelEnvironment` (frozen copy) | `packages/kernel/src/ports/environment.ts:16` |
| `resolveSecretEnvironment` | `(environment, keyfile, sources) => KernelEnvironment` | `packages/kernel/src/ports/environment.ts:30` |

Wire methods `secrets.listNames` / `secrets.set` / `secrets.delete`, carrying
`metadata.sensitivity === "secrets"` (`packages/kernel/src/transport/operations.ts:346-365`).

### 2.7 Workspace trust — `@clarvis/kernel`

| Symbol | Signature | Line |
| --- | --- | --- |
| `WORKSPACE_RISK_FIELDS` | 8-element const tuple | `packages/kernel/src/config/workspace-trust.ts:37` |
| `stripWorkspaceRiskFields` | `(settings) => { settings, withheld }` | `:96` |
| `workspaceTrustFingerprint` | `(settings, agents, extensions?) => string \| undefined` | `:294` |
| `workspaceTrustVerdict` | `(fingerprint, key, trust) => WorkspaceTrustVerdict` | `packages/kernel/src/config/workspace-trust.ts` |
| `canonicalWorkspaceKey` | `(workspaceRoot) => string` | `packages/kernel/src/config/workspace-trust.ts` |
| `readWorkspaceTrustFile` | `(globalDir) => { trust?, error? }` | `packages/kernel/src/config/workspace-trust.ts` |
| `writeWorkspaceTrust` | `(globalDir, key, fingerprint \| undefined, now?) => void` | `packages/kernel/src/config/workspace-trust.ts` |
| `workspaceTrustSchema` | zod, `.strict()` | `packages/kernel/src/config/workspace-trust.ts` |

### 2.8 Wire error normalization — `@clarvis/kernel`

Constants and helpers in `packages/kernel/src/transport/stdio.ts`: `MAX_ERROR_MESSAGE_CHARS = 16_384`
(`:46`), `MAX_ERROR_DETAILS_BYTES = 64 * 1024` (`:47`), `MAX_CLASSIFICATION_VALUE_CHARS = 1_024`
(`:48`), `terminalSafe` (`:69`), `preservedErrorDetails` (`:83`), `safeErrorDetails` (`:349`),
`toEnvelope` (`:372`). The parallel path for run events is
`packages/kernel/src/runs/map-events.ts:82` (`terminalSafe` over `sanitizeText`) and `:192`
(`boundedCapabilityDetail`).

### 2.9 Remote MCP OAuth credentials — `@clarvis/mcp-client`

| Symbol | Security role | Line |
| --- | --- | --- |
| `createMCPAuthorizationCoordinator` | loopback callback, random state, browser authority and same-key serialization | `packages/mcp-client/src/oauth.ts:234-702` |
| `MCPAuthorizationOptions.openAuthorizationUrl` | explicit host capability; omitted by headless hosts | `packages/mcp-client/src/oauth.ts:60-74` |
| `createMCPRemoteFetch` | resource-header isolation, OAuth destination validation and redirect control | `packages/mcp-client/src/remote-fetch.ts:35-118` |
| `createMcpOAuthCredentialStore` | validates, lease-serializes and durably writes the private store | `packages/mcp-client/src/oauth-store.ts:216-264` |
| `McpOAuthStoreError` | refuses corrupt, oversized, unreadable and unsafe paths without repair | `packages/mcp-client/src/oauth-store.ts:35-43` |

The file kernel supplies `<global>/state/mcp-oauth.json` and passes a browser opener only when its
host owns that authority (`packages/kernel/src/file-kernel.ts:702-723`). Tokens, codes, verifier,
state and client secrets therefore never become settings, request parameters, protocol DTOs or
diagnostic fields.

## 3. Data and formats

### 3.1 The redaction rule sets

Rules are `{ re: RegExp /* g */, replacement: string }` applied in order, each substitution threaded
into the next (`packages/capability/src/sanitize.ts:153-157`). The arrays are built once at module
load (`:148-152`).

| Group | Members | Line |
| --- | --- | --- |
| `PRELUDE` | PEM `PRIVATE KEY` block → `[redacted-private-key]`; `Bearer …` → `Bearer [redacted]`; `Basic …` → `Basic [redacted]` | `:16-23` |
| `HEADER_KEYS` | `authorization` / `x-api-key` / `api[-_]?key` `[:=]` **unquoted** value | `:32-35` |
| `QUOTED_SECRET_WORDS` | `password\|passwd\|pwd\|token\|secret` `[:=]` **quoted** value only | `:49-52` |
| `UNQUOTED_KEYS_AND_SECRET_WORDS` | the union of the previous two, matched **unquoted** | `:66-69` |
| `TAIL` | sensitive JSON key/value; URL userinfo (scheme bounded to 31 chars); secret query params; JWT; `sk-`/`rk-`/`pk-`; `AIza`; `A[KS]IA…`; `gh[pousr]_`; `github_pat_`; `xox[baprs]-` | `:82-99` |
| `COARSE_FALLBACK` | any unbroken 48+ base64url run → `[redacted]` | `:111-114` |

Composition:

| Rule set | = | Line |
| --- | --- | --- |
| `TRACE_RULES` | `PRELUDE` + `HEADER_KEYS` + `QUOTED_SECRET_WORDS` + `TAIL` | `:120` |
| `TRACE_RULES_COARSE` | `TRACE_RULES` + `COARSE_FALLBACK` | `:128` |
| `TEXT_RULES` | `PRELUDE` + `UNQUOTED_KEYS_AND_SECRET_WORDS` + `TAIL` + `COARSE_FALLBACK` | `:134` |

`sanitizeDeep`'s key-aware branch uses a separate, unanchored substring regex
`SENSITIVE_KEY` (`:202-203`); a non-empty string under such a key that the string redactor left
unchanged is replaced wholesale with `"[redacted]"` (`:230-232`).

Worked examples taken from the tests:

| Input | `sanitizeToolPayload` | `sanitizeText` |
| --- | --- | --- |
| `export TOKEN=supersecretvalue` | unchanged (`packages/capability/tests/unit/sanitize.test.ts:300`) | `[redacted]` (`:299`) |
| `const token = getToken(req);` | unchanged (`:156`) | — |
| `"integrity": "sha512-bbb…"` | unchanged (`:142`) | — |
| `{ note: "z".repeat(60) }` via `sanitizeDeep` | unchanged (`:327`) | `"[redacted]"` (`:328`) |
| `commit <40 a's>` | kept (`:174`) | — |
| `Q".repeat(48)` in an error | `[redacted]` via `sanitizeErrorMessage` (`:239`) | — |

### 3.2 `keys.json`

Path: `globalPaths(dir).keysFile` = `<global>/keys.json` (`packages/paths/src/global.ts:114`).
Schema: `z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1))`
(`packages/kernel/src/secrets/secret-store.ts:7,10`). Serialized as
`` `${JSON.stringify(values, null, 2)}\n` `` (`:105`) through `writeFileAtomicSync`, whose defaults are
file mode `0o600` and directory mode `0o700` (`packages/paths/src/atomic.ts:412-414`,
`packages/paths/src/constants.ts:40,52`).

```json
{
  "ANTHROPIC_API_KEY": "sk-abc",
  "OPENAI_API_KEY": "sk-def"
}
```
(shape from `packages/kernel/tests/integration/secret-store.test.ts:23-25`)

`SecretSnapshot` is `{ values: Record<string,string>; error?: string }` (`packages/kernel/src/secrets/secret-store.ts:13-18`); a
missing file yields `{ values: {} }` (`:79`), bad JSON yields `{ values: {}, error: "invalid JSON: …" }`
(`:84`), and a schema failure yields the first issue as `"<path>: <message>"` (`:54-59`, `:89`).

### 3.3 `workspace-trust.json`

Path `globalPaths(globalDir).workspaceTrustFile` = `<global>/workspace-trust.json`
(`packages/paths/src/global.ts:117`). Strict schema: a `workspaces` record from canonical workspace
path to a **non-empty array** of `{ fingerprint: /^sha256:[0-9a-f]{64}$/, approved_at: string }`
(`packages/kernel/src/config/workspace-trust.ts:244-261`).

```json
{
  "workspaces": {
    "/home/me/project": [
      { "fingerprint": "sha256:<64 hex>", "approved_at": "2026-01-01T00:00:00.000Z" }
    ]
  }
}
```

The key is `realpathSync(workspaceRoot)`, falling back to the input when it cannot be resolved
(`:284-290`). The fingerprint is `sha256` over `JSON.stringify(canonical(surface))`, where `canonical`
sorts object keys recursively and drops `undefined` (`:154-164`, `:239-240`). The surface is
(`:188-223`):

| Key | Contents |
| --- | --- |
| `settings` | only the declared risk fields, keyed by their `WORKSPACE_RISK_FIELDS` name (`:192-215`) |
| `agents` | `{ name, digest: "sha256:<hex>" }` per `.clarvis/agents/*.md`, sorted by name (`:166-175`) |
| `extensions` | every installed `scope: "workspace"` plugin as an exact qualified ref plus atomic contribution digest, sorted canonically, when non-empty |

A workspace with none of the three yields `undefined` — it is **inert** and never prompted about
(`workspaceExecutableSurface` in `packages/kernel/src/config/workspace-trust.ts`). Environment
Environment definitions and global plugin selections do not enter this executable surface. The
workspace plugin inventory does so before selection. Code resolves it after the lightweight startup
composer has painted, keeps repository plugins inactive in the meantime, and then asks automatically
when the complete TUI receives the verdict.

### 3.4 Risk fields

`WORKSPACE_RISK_FIELDS` (`packages/kernel/src/config/workspace-trust.ts:37-45`), in order:

| Field | Detection |
| --- | --- |
| `hooks` | `declaresSomething` — absent/`null`/`[]`/`{}` do not count (`:89-94`, `:114`) |
| `mcpServers` | `declaresSomething` |
| `enabledPlugins` | `declaresSomething` |
| `marketplaces` | `declaresSomething` |
| `memory.provider` | only when `provider.kind` is `"executable"` or `"plugin"` (`:97-102`, `:104`) |
| `plans.provider` | same predicate (`:105`) |
| `tasks.provider` | any object-valued `tasks.provider` (`:106-112`) |
| `providers.subscription` | provider entries whose kind attaches user subscription credentials |

Stripping removes the whole key for the first four, deletes `tasks` entirely for `tasks.provider`,
deletes only the `provider` sub-key for `memory`/`plans`, and removes only subscription-backed
entries from `providers` (`:117-134`). A `memory: { provider: { kind:
"wiki" }, enabled: true }` survives untouched
(`packages/kernel/tests/integration/workspace-trust.test.ts:71-77`).

### 3.5 The wire error envelope

`toEnvelope` produces `{ code, message, details? }` (`packages/kernel/src/transport/stdio.ts:372-382`):

| Field | Derivation |
| --- | --- |
| `code` | the thrown `code` if it is in `ERROR_CODE_MEMBERS`, otherwise `"internal"` (`:49-60`, `:377`) |
| `message` | `terminalSafe(rawMessage).slice(0, 16_384)` (`:378`) |
| `details` | `safeErrorDetails` — `boundJsonValue` (depth 16, 1024 nodes, 64 KiB chars, keys through `terminalSafe`) then `sanitizeDeep(…, terminalSafe)` (`:349-369`) |

`terminalSafe` = `sanitizeErrorMessage` then strip `ANSI_ESCAPE` then strip `TERMINAL_CONTROL`
(`:65-71`). On truncation the envelope becomes `{ ...preservedErrorDetails(value), truncated: true }`,
where the preserved set is `outcome_unknown` (boolean) plus the string fields `task_code`,
`memory_code`, `current_revision`, `expectedRevision`, `actualRevision`, each capped
at 1024 chars (`:73-80`, `:83-106`, `:363`).

### 3.6 `state/mcp-oauth.json`

The strict version-1 document maps 64-hex SHA-256 keys to SDK-validated registration/token records;
the raw workspace, owner and remote resource never appear as keys
(`packages/mcp-client/src/oauth-store.ts:19-33,87-143`, key derivation at
`packages/mcp-client/src/oauth.ts:176-185`). It is bounded to 1 MiB, 128 records and 512 KiB per
record (`packages/mcp-client/src/oauth-store.ts:14-18,118,133-142,248-257`). On POSIX it is written
`0600` below a `0700` directory (`:206-214,239-241`); malformed data is an error, not an empty
fallback (`:186-197`).

## 4. Behavior

### 4.1 Confining one tool path

`resolvePath` (`packages/tools/src/lib/paths.ts:27-37`):

1. `path.isAbsolute(input) ? path.normalize(input) : path.resolve(workspaceRoot, input)` (`:34`).
2. If `confine`, call `assertWithinWorkspace(abs, workspaceRoot, input, undefined, alsoAllow, logger)`
   (`:35`). Note `caseInsensitive` is passed `undefined`, so the parameter default
   `process.platform === "win32"` applies (`:135`).
3. Return the **non-canonicalized** absolute path. The canonical form computed during the check is
   discarded; the tool then operates on the lexical path.

`assertWithinWorkspace` (`:131-165`):

1. `target = canonicalizeAllowingMissing(abs)` (`:139`).
2. For each candidate root in `[workspaceRoot, ...alsoAllow]`, canonicalize it the *same* way, fold
   both sides for case if required, and accept on equality or on `targetReal.startsWith(rootReal +
   path.sep)` (`:142-147`). The trailing separator is what stops `C:\Projects\x` passing as a child of
   `C:\Proj` (`:100-102`).
3. Otherwise log `tools.path_refused` with `reason: "unresolvable" | "outside_root"` and an
   `allow_roots_count`, never the roots themselves (`:149-157`), and throw
   `ToolError("path_escape", …, { path: input })` (`:158-164`).

`canonicalizeAllowingMissing` (`:246-258`) walks up from `abs` until `realpathSync.native` succeeds,
re-appending the skipped tail. Two branches matter:

| Condition | Result | Line |
| --- | --- | --- |
| `realpath` succeeds at `cur` | `path.join(real, ...tail)` | `:251` |
| `cur` is itself a symlink and unresolvable | `undefined` → refusal | `:252` |
| the walk reaches the filesystem root | `path.normalize(abs)` | `:254` |

The `isSymbolicLink` stop is load-bearing and is pinned: a link out of the workspace whose target is
mode `0o311` cannot be `realpath`ed but *can* be written through, so treating unresolvable as inside
would admit that write (`packages/tools/tests/integration/paths.test.ts:155-166`). Conversely a
merely-unreadable child (`0o000` directory) is admitted so its own errno surfaces (`:128-137`).

### 4.2 Which tools confine, and against which roots

Every tool passes `config.confineToWorkspace` as the `confine` argument and admits
`config.temporaryRoots`. State artifacts and selected skill execution roots are the only narrower
additions:

| Tool | `alsoAllow` | Site |
| --- | --- | --- |
| `read_file` | `[config.stateRoot, ...config.temporaryRoots]`; guard analysis also admits an exact verified state spill | `packages/tools/src/tools/read-file.ts`, `packages/tools/src/guard/context.ts` |
| `read_files` | `[config.stateRoot, ...config.temporaryRoots]`; guard analysis also admits exact verified state spills | `packages/tools/src/tools/read-files.ts`, `packages/tools/src/guard/context.ts` |
| every other native file tool | `config.temporaryRoots` | see the `resolvePath(` call in each `packages/tools/src/tools/*.ts` |
| `shell`, `monitor_start` guard analysis | `config.temporaryRoots` plus exact host-selected `config.skillExecutionRoots`; only when a sandbox is configured, each exact verified state spill is also admitted and mounted read-only | `packages/tools/src/guard/context.ts`, `packages/tools/src/lib/state-artifacts.ts` |

The state-root widening remains reachable from exactly two call sites, both read-only. Temporary
roots are different: the loop creates one owner-only scratch directory per run, passes that exact
root to guard analysis, native confinement, post-open validation, and the shell environment, and
removes it after the run is persisted. An explicit absolute `mktemp -d` template may add exactly the
new directory it created after a before/after snapshot proves the match, lstat rejects symlinks, and
uid ownership matches; the loop observes that registration for the same cleanup. It never admits
generic `/tmp` or a pre-existing match. Production:
`WorkspaceStatePaths.runTempDir`, `createToolsCapability`, `RuntimeConfig.temporaryRoots`,
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
`createToolSpill` (`packages/loop/src/runtime/context/tool-spill.ts:41-61`) and by `shell`'s
`spillTarget` (`packages/tools/src/tools/shell.ts:49-56`), both under
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
(`packages/tools/src/lib/files.ts:47-54`). When present, after `open()` the reader runs
`assertOpenedFileConfined` (`:112-145`):

1. `fs.realpath(target)`, `handle.stat({ bigint: true })`, `fs.stat(canonical, { bigint: true })`
   (`:122-124`).
2. `assertWithinWorkspace(canonical, workspaceRoot, relForError, undefined, alsoAllow)` (`:129-135`).
3. Compare `dev`/`ino` between the descriptor and the path; a mismatch throws
   `ToolError("path_escape", "Path changed while it was being opened: …")` (`:137-144`).

All bytes are then read from that descriptor with `position: null`
(`:155-170`), so a later path swap cannot redirect the read.

Call sites of `readFileOptions`: `packages/tools/src/lib/rg.ts:153`, `packages/tools/src/lib/rg.ts:375`, `packages/tools/src/tools/diff.ts:61`,
`packages/tools/src/tools/read-file.ts:82`, `packages/tools/src/tools/read-files.ts:118`, `packages/tools/src/tools/read-image.ts:54`,
`packages/tools/src/tools/apply-patch.ts:249,301`, `packages/tools/src/tools/edit-file.ts:44`, `packages/tools/src/tools/replace.ts:202`,
`packages/tools/src/tools/write-file.ts:82`.

`grep` additionally refuses the ripgrep path for a **confined directory** search and uses the
in-process walker instead, because handing a mutable directory pathname to a subprocess reopens the
window (`packages/tools/src/lib/rg.ts:164`, rationale at `:123`); a single-file ripgrep search is fed
through stdin so the child never reopens the pathname (`:164`).

### 4.4 Mutating writes

`writeAtomic` (`packages/tools/src/lib/atomic.ts:132-147`):

| Step | Line |
| --- | --- |
| `assertNotSymlink(target)` — refuse an existing symlink | `:133` |
| `fs.mkdir(dirname(target), { recursive: true })`, remembering whether it created anything | `:135` |
| capture the existing file's mode, or `0o666 & ~umask` for a new one | `:136-140` |
| `writeFileDurable(target, content, { mode, dirMode })` | `:139` |
| on failure, remove the directory this call created and rethrow | `:143-146` |

The batch form `applyOpsAtomic` pre-flights every op through `validateTargets`
(`:221-271`), which calls `assertNotSymlink` on each rename source, rename destination and
create/modify target (`:227-228`, `:256`).

**The gap.** Neither path re-validates the *parent chain* after the confinement check. Confinement is
proved lexically/canonically at `resolvePath`; `mkdir`, staging (`fs.open(tmp, "wx")`, `:73`) and the
`rename` that publishes it all take the pathname again. The only mutating tool whose race is observably
closed is one that reads the file first: `write_file` reads pre-existing content through
`readTextFile(…, readFileOptions(config))` (`packages/tools/src/tools/write-file.ts:78-84`), and that
read's descriptor check is what aborts the operation. The pinning test says so in its own title:
*"aborts write_file when its prior read detects a parent-link race"*
(`packages/tools/tests/integration/no-isolation.test.ts:148-171`). A `write_file` creating a **new**
file takes no such read (`:62`, `:77` — the read is inside `if (existed)`, `:76-93`), and `mkdir`,
`remove`, `move` and `copy` never call `readFileOptions` at all.

### 4.5 Building a hook subprocess's environment

`filterHookEnv(source, { denyExact, add })` (`packages/hooks/src/env.ts:175-200`) iterates the source
once and applies, in this order:

| # | Rule | Effect | Line |
| --- | --- | --- | --- |
| 0 | `value === undefined` | dropped, uncounted | `:166` |
| 1 | `KEEP_EXACT.has(name)` or a `LC_` prefix | kept unconditionally, counted as neither | `:167-170` |
| 2 | `denyExact.has(name)` | dropped, `denied.exact++` | `:171-174` |
| 3 | `isSecretName(name)` | dropped, `denied.shape++` | `:175-178` |
| 4 | otherwise | kept | `:179` |

`opts.add` is spread **last** and is never filtered (`:181`). The keep-list is 31 exact names —
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `TZ`, `TERM`, the
Windows seven (`SystemRoot`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
`PROGRAMFILES`) and twelve toolchain roots (`BUN_INSTALL`, `MISE_DATA_DIR`, `ASDF_DATA_DIR`,
`NVM_DIR`, `PYENV_ROOT`, `RUSTUP_HOME`, `CARGO_HOME`, `GOROOT`, `GOPATH`, `JAVA_HOME`,
`SDKMAN_DIR`, `DOTNET_ROOT`) (`:28-60`) — plus the `LC_` prefix (`:62`).

`isSecretName` (`:113-117`) is the disjunction of a separator-anchored word regex, `SECRET_NAME`
(`:76-77`) — `authorization`, `auth`, `api[_-]?key`, `apikey`, `secret`, `token`, `password`,
`passwd`, `pwd`, `credential`, `credentials`, `session` (each bounded by `_`/start/end), plus
unanchored `private[_-]?key` and `access[_-]?key` — and thirteen credential-family prefixes,
`SECRET_PREFIX` (`:80-94`), matched case-insensitively on the upper-cased name (`:115-116`):
`AWS_`, `AZURE_`, `GCP_`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_`, `GITHUB_`, `GH_`, `NPM_`,
`DOCKER_`, `SSH_`, `GPG_`, `HF_`, `VAULT_`.

The per-run `denyExact` is `runCredentialNames(ctx, credentialNames?.() ?? [])`
(`packages/hooks/src/capability.ts:366-368`), assembled from four sources
(`packages/hooks/src/capability.ts:298-313`):

| Source | Extraction | Line |
| --- | --- | --- |
| each provider's `api_key_env` | the name verbatim | `:261` |
| each provider's `headers` values | `interpolatedNames` | `:262` |
| each provider **model**'s `headers` values (via `Object.values(provider.models ?? {})`) | `interpolatedNames` | `:263` |
| each MCP server's `env` and `headers` values | `interpolatedNames` | `:265-267` |
| `extra` — the host's whole-registry names | verbatim | `:256` |

The `extra` half exists because a run's `servers` is narrowed to those some profile grants, while the
inherited process environment still carries every key the host resolved (`:243-249`). The host supplies
it as `hookCredentialNames: managedSecretNames` (`packages/kernel/src/file-kernel.ts:785`), a function
that unions only `keys.json` names with the explicit `opts.keySources` names
(`packages/kernel/src/file-kernel.ts:428-438`) — **not** provider `api_key_env` or header refs, re-read
per call. This is a distinct function from `loadSecretNames` (`:519-535`, described in §4.6), which the
kernel wires as `resolveSecretNames` for the toolset's own `secretEnvNames` and *does* additionally union
every provider's `api_key_env` and every provider/model header's interpolated names. The two lists are
therefore built independently, from two different kernel functions, for the two different subprocess
environments in §4.6 — not the same "whole-registry" computation reused twice.

The filtered environment becomes the runner's `baseEnv` (`packages/hooks/src/capability.ts:370-383`,
`packages/hooks/src/runner.ts:66`) and each hook spawn layers six `CLARVIS_HOOK_*` /
`CLARVIS_WORKSPACE_ROOT` variables on top (`packages/hooks/src/runner.ts:484-503`).

Only the counts are logged: `hooks.env_filtered` with `denied_count`, `denied_by_exact`,
`denied_by_shape` and the message *"the withheld variables are counted and never named, because the
denylist is derived from exactly this run's credentials"* (`packages/hooks/src/capability.ts:370-378`).

### 4.6 Other subprocess environments use distinct policies

| Consumer | Policy | Line |
| --- | --- | --- |
| Clarvis-owned Git selecting a repository | `withoutGitRepositoryEnvironment(inherited)` — preserve ordinary/transport inputs, remove Git's complete repository-local set and `GIT_CEILING_DIRECTORIES` before `cwd`, `-C`, or a clone destination selects the repository | helper `packages/paths/src/git-environment.ts`; plugin fetch `packages/kernel/src/adapters/git/plugin-fetcher.ts`; plugin metadata `packages/kernel/src/adapters/filesystem/plugin-repository.ts`; memory workspace probe `packages/memory/src/workspace-state.ts`; client clone `packages/code/src/adapters/plugin-install.ts`; guarded host fallback `packages/tools/src/tools/host-vcs.ts` |
| `host_vcs` argv fallback | `withoutGitRepositoryEnvironment(process.env)`, then remove `secretEnvNames`, disable prompts, hooks, and Git external protocols; ordinary host environment and credential transport remain | `packages/tools/src/tools/host-vcs.ts` (`hostEnvironment`) |
| stdio MCP child | `{ ...getDefaultEnvironment(), ...server.env }` — authored values are normally interpolated, but remain literal when a portable adapter sets `expandVariables: false`; the caller's environment is **never** the base | `buildTransport` in `packages/mcp-client/src/client.ts` |
| remote MCP request headers | authored headers follow `expandVariables`; `bearer_token_env_var` and `env_http_headers` always resolve their explicitly named values and the resulting headers remain confined to the configured resource origin | `buildTransport` in `packages/mcp-client/src/client.ts`; `createMCPRemoteFetch` in `packages/mcp-client/src/remote-fetch.ts` |
| `shell` / `monitor` command (unsandboxed) | `withoutSecrets(process.env, secretEnvNames)` — a copy with the named keys deleted | `packages/tools/src/sandbox.ts` (`withoutSecrets`, applied by `sandboxCommand`) |
| capability executable (plans/memory/tasks provider) | `{ ...inherited, ...additions }` — the **whole** kernel environment plus the declaration's interpolated `env` | `packages/kernel/src/capability-executables/session-manager.ts:76-84`, `:163` |

`secretEnvNames` for the toolset comes from `resolveSecretNames(ctx)`
(`packages/loop/src/runtime/capabilities/tools.ts:135`), which the file kernel binds to
`loadSecretNames` (`packages/kernel/src/file-kernel.ts:783`).

### 4.7 Resolving secrets into the kernel environment

`resolveSecretEnvironment(environment, keyfile, sources)`
(`packages/kernel/src/ports/environment.ts:30-49`) computes `managed = keys(keyfile) ∪ keys(sources)`
and, per name:

| `sources[name]` | Value |
| --- | --- |
| `"env"` | `environment.values[name]` (`:43`) |
| `"keyfile"` | `keyfile[name]` (`:45`) |
| `"auto"` (default) | `environment.values[name] ?? keyfile[name]` (`:46`) |

The result is re-frozen through `createKernelEnvironment` (`:48`, `:16-20`). `code`'s
`keyOrigin` mirrors the same precedence for display and reports `"unset"` rather than falling back when
a pinned source is absent (`packages/code/src/adapters/provider-secrets.ts:14-22`).

### 4.8 Secret storage mutations

| Operation | Steps | Line |
| --- | --- | --- |
| `read()` | absent file → `{ values: {} }`; JSON parse failure → `error`; schema failure → first-issue `error`; values otherwise | `:78-90` |
| `set(name, value)` | reject a name failing `ENV_VAR_RE`; reject an empty value; **refuse while the current file is unparseable**; rewrite the whole map atomically | `:111-117` |
| `delete(name)` | refuse while unparseable; no-op when absent; rewrite without the key | `:118-124` |

`createSecretService` wraps the store and exposes `Object.keys(store.read().values)` as `listNames`
(`:142-144`) — the only read path across the protocol boundary. `code`'s `KeysAdapter` holds only a
`Set` of names and never a value (`packages/code/src/adapters/provider-secrets.ts:32-45`).

### 4.9 Workspace trust state machine

Verdict computation, recomputed on every call (`packages/kernel/src/config/file-config-store.ts:508-513`):

| State | Condition | Effect on the merge / agents |
| --- | --- | --- |
| `inert` | `workspaceTrustFingerprint(...) === undefined` | nothing withheld |
| `unapproved` | no entry for this key (`packages/kernel/src/config/workspace-trust.ts:325`) | risk fields stripped; workspace agent files and `scope: "workspace"` Environment plugins withheld; global installed plugins remain admitted |
| `trusted` | some recorded entry equals the current fingerprint (`:326-328`) | nothing withheld |
| `changed` | entries exist but none matches; reports the most recent as `approved` (`:329`) | withheld, same as `unapproved` |

An unreadable `workspace-trust.json` yields `{ trust: undefined }`, and `workspaceTrustVerdict` treats
that as an empty store — i.e. `unapproved`, never `trusted` (`packages/kernel/src/config/workspace-trust.ts:300-306`,
`:323-325`; stated at `packages/kernel/src/config/file-config-store.ts:505-506`).

Transitions:

| State | Event | New state | Effect |
| --- | --- | --- | --- |
| any | `approveWorkspace()` | `trusted` | `writeWorkspaceTrust(globalDir, key, fingerprint)` appends the entry if new (`packages/kernel/src/config/workspace-trust.ts:357-360`) |
| any | `revokeWorkspace()` | `unapproved` | `delete workspaces[key]` (`:354-355`) |
| `trusted` | the surface changes | `changed` | withheld again (`packages/kernel/tests/integration/workspace-trust.test.ts:188-199`) |
| `trusted`/`inert` | operator write through `ConfigService` | re-recorded over the new surface | `withOperatorWrite` (`packages/kernel/src/config/file-config-store.ts:564-575`) |
| `unapproved`/`changed` | operator write through `ConfigService` | unchanged | `if (!carried) return out` (`:527-528`) |

An explicit approve/revoke is refused with `conflict` while any run is active, before the trust file
is changed. At an idle boundary, `resolveActive` recomposes the selected workspace Environment (and
workspace-derived `builtin:default`) so approval admits its workspace-owned plugin units and
revocation withholds those units immediately; global installed plugins are unaffected
(`assertWorkspaceTrustTransitionAllowed` and `resolveActive` in
`packages/kernel/src/environments/environment-manager.ts`; the idle/active transition case in
`packages/kernel/tests/integration/environment-manager.test.ts` and the pre-write storage case in
`packages/kernel/tests/integration/workspace-trust.test.ts`).

`writeWorkspaceTrust` throws rather than overwrite when the existing store cannot be parsed
(`packages/kernel/src/config/workspace-trust.ts:350-352`) — but `withOperatorWrite` swallows that throw, because the settings or
agent file has already landed by then (`packages/kernel/src/config/file-config-store.ts:569-573`).

A workspace Environment preview may approve only the fingerprint it just resolved; changing the
definition between preview and selection is a conflict. The resulting approval admits the plugin as
an atomic unit, including its normalized hooks. There is no mutable per-hook approval projection.
Environment definitions and resolved snapshots never carry secrets. See
[Extension Environments](../hosts/environments.md#43-preview-composition-trust-and-resume).

Two independent enforcement points read the verdict, and the code says gating only one would leave the
other open (`packages/kernel/src/config/file-config-store.ts:593-625` for the settings merge;
`:903-918` and `:940-950` for agent files, rationale at `:894-898`, `:956-960`).

### 4.10 An error crossing the wire

Order in `toEnvelope` (`packages/kernel/src/transport/stdio.ts:372-382`):

1. `preservedErrorDetails(value)` is computed **from the raw details**, before bounding, so the
   reconciliation flags survive truncation (`:350`, `:83-106`).
2. `boundJsonValue` builds a finite, getter-free, acyclic copy — no `toJSON` and no user getter is
   invoked (`packages/kernel/src/core/bounded-json.ts:15-27`), with object keys passed through
   `terminalSafe` (`packages/kernel/src/transport/stdio.ts:353`).
3. `sanitizeDeep(bounded.value, terminalSafe)` redacts (`:354`).
4. If the bound truncated, or the serialized result still exceeds 64 KiB, the details collapse to
   `{ ...preserved, truncated: true }` (`:355-360`).
5. The code collapses to `internal` unless it is one of the eleven known `KernelErrorCode`s (`:377`).
6. The message is `terminalSafe`d then hard-sliced at 16,384 characters (`:378`).

Reordering 2 before 1 is what the truncation branch depends on — the preserved map is read from the
*original* object's own property descriptors (`:87-95`), not from the bounded copy.

The capability-event path in `packages/kernel/src/runs/map-events.ts` is the same shape with
`sanitizeText` rather than `sanitizeErrorMessage` as the string redactor (`:82-84`, `:200-211`) and a
64 KiB / depth-32 / 4096-node bound (`:71-73`).

`toEnvelope` is called only where a request gets a JSON-RPC **response** frame
(`packages/kernel/src/transport/stdio.ts:575`, `writer.send({ t: "res", id, error: toEnvelope(err) })`).
A server→client **notification** carries whatever its call site put in `params`, with no generic
sanitization at the framing layer — `serveKernelOverStdio`'s `NotificationSender` is
`(method, params) => writer.send({ t: "note", method, params })` (`:552-553`), passing `params` straight
to the frame writer. The ordinary `run.done` result is already sanitized upstream by the loop's own result mapping
(`packages/loop/src/runtime/run-response-mapping.ts:54`, `:62-63`, `:69`; see §7.2), but the one place
that constructs an error notification by hand is `packages/kernel/src/transport/server.ts`'s narrow
fallback for when a run's `handle.done` promise itself rejects (not the ordinary `status: "failed"`
path): it builds `{ code: "internal", message: sanitizeErrorMessage(...) }` (`:396-405`) with **no**
`terminalSafe` ANSI/control-byte stripping and no 16,384-character cap — only secret redaction.

### 4.11 Agent-name traversal guard

`requireAgentName(name)` (`packages/kernel/src/config/config-service.ts:78-86`) rejects unless
`/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/` matches **and** the name does not contain `".."`. It is called from
`getAgent` (`:475`), `deleteAgent` (`:496`), `writeAgent` (`:515`) and both halves of `renameAgent`
(`:540-541`). `:` is excluded deliberately, because a plugin-contributed agent is addressed
`<plugin>:<agent>` and is owned by neither writable scope (`:55-58`).

### 4.12 Authorizing a remote MCP server

The SDK performs protected-resource discovery, client registration, PKCE and token exchange; Clarvis
owns the surrounding trust boundaries. It canonicalizes the remote resource into an owner/workspace
scoped hash, reuses only a registration whose redirect still matches, and creates 32 random
bytes of state (`packages/mcp-client/src/oauth.ts:188-205,452-459`). Every OAuth fetch target and
redirect is validated before the request leaves the process, and only HTTPS or loopback HTTP is
accepted (`packages/mcp-client/src/remote-fetch.ts:35-40,53-118`). Before invoking the host opener,
the same rule is applied to the browser URL (`packages/mcp-client/src/oauth.ts:217-224,510-562`).

Configured MCP resource headers are injected only into resource requests on the configured origin.
They are withheld from SDK discovery, registration, and token exchanges even on a shared origin;
request-defined SDK credentials take precedence, and a redirect cannot carry configured resource
credentials across origins (`packages/mcp-client/src/remote-fetch.ts:53-114`). The callback listener
binds the selected loopback interface for local callbacks, accepts only the session-selected GET
path, bounds fields, compares state timing-safely and never reflects a code/state in HTML
(`packages/mcp-client/src/oauth.ts:129-161,258-393`).

The store read uses `O_NOFOLLOW`, verifies the final object is a regular file, rejects a parent whose
real path differs, and wipes its read buffer (`packages/mcp-client/src/oauth-store.ts:152-203`). A
mutation acquires a local lease, re-reads and validates under it, asserts ownership immediately before
the durable replacement and refuses to overwrite malformed state (`:206-262`). This narrows final
symlink and stable-parent attacks; it does not close the repository's existing parent-directory
TOCTOU family between validation and rename, so the limitation in invariant 10 remains explicit.

## 5. Invariants

1. **A confined tool path is compared canonically on both sides.** `assertWithinWorkspace` resolves the
   target *and* every candidate root through `canonicalizeAllowingMissing` before comparing, so a
   symlink cannot smuggle a target out and a symlinked workspace root does not produce false escapes.
   Production `packages/tools/src/lib/paths.ts:141-149`; pinned
   `packages/tools/tests/integration/paths.test.ts:115-146`.
2. **A path whose containment cannot be proven is refused, not admitted.** When the walk hits a symlink
   it cannot resolve, `canonicalizeAllowingMissing` returns `undefined` and the caller throws.
   Production `packages/tools/src/lib/paths.ts:254`, `:142`; pinned
   `packages/tools/tests/integration/paths.test.ts:155-166` (a `0o311` link target).
3. **The prefix test requires a separator.** A sibling directory whose name merely starts with the
   root's is rejected. Production `packages/tools/src/lib/paths.ts:148`; pinned
   `packages/tools/tests/integration/paths.test.ts:90-93`.
4. **Case folding is Windows-only.** `forCompare` folds only when `caseInsensitive`, whose default is
   `process.platform === "win32"`. Production `packages/tools/src/lib/paths.ts:77-79`, `:137`; pinned
   `packages/tools/tests/integration/paths.test.ts:78-99`.
5. **Only the two read tools widen confinement to the state root; every native file tool may use only
   the exact configured run temporary roots, and command tools may additionally address exact
   host-approved skill execution roots.** State machinery therefore remains read-only, while scratch
   created through `$TMPDIR` or a verified explicit `mktemp -d` template is usable by later native
   calls and unrelated `/tmp` remains refused. Selected skill roots are denied to native mutation.
   Production: `packages/tools/src/tools/read-file.ts`, `read-files.ts`, every other `resolvePath(`
   call site, `packages/tools/src/lib/files.ts`, `packages/tools/src/guard/context.ts`, and
   `packages/tools/src/core.ts`. Pinned by
   `packages/tools/tests/integration/api.test.ts` and `guard-dispatch.test.ts`.
6. **A model-facing refusal never names the bypass.** No runtime string under `packages/tools/src`
   matches the remediation shape. Production `packages/tools/src/lib/paths.ts:160-166`; pinned
   `packages/tools/tests/architecture/no-bypass-hints.test.ts:81`, with the guard's own sensitivity
   asserted at `:85` and its specificity at `:95`.
7. **A read revalidates the opened object against the roots and against the descriptor's identity.**
   Production `packages/tools/src/lib/files.ts:129-144`; pinned end-to-end for `read_file` and `grep`
   at `packages/tools/tests/integration/no-isolation.test.ts:78`, `:98`.
8. **A confined directory grep never runs ripgrep.** Production `packages/tools/src/lib/rg.ts:164`;
   pinned `packages/tools/tests/integration/no-isolation.test.ts:122-146` (which explicitly builds the
   config with `ripgrepAvailable: true`).
9. **No mutating tool writes through a symlink.** Production `packages/tools/src/lib/atomic.ts:109-116`,
   invoked at `:133` and `:227-228`, `:256`; pinned
   `packages/tools/tests/integration/symlink.test.ts:34-50`.
10. **Workspace-confined mutation still has an open parent-directory TOCTOU.** Confinement is decided at
    `resolvePath` and the subsequent `mkdir`/`open("wx")`/`rename` all re-take the pathname
    (`packages/tools/src/lib/atomic.ts:70-73`, `:135-139`). The one mutating tool with an observed
    mitigation gets it from its *prior read*, not from the write —
    `packages/tools/src/tools/write-file.ts:76-93`, and the test's own title says
    *"aborts write_file when its prior read detects a parent-link race"*
    (`packages/tools/tests/integration/no-isolation.test.ts:148`). `mkdir`, `remove`, `move` and `copy`
    call no `readFileOptions` at all. **Unpinned as a defect** — nothing asserts the residual exposure.
11. **`sanitizeToolPayload` never applies the coarse fallback.** Production
    `packages/capability/src/sanitize.ts:120-125`, `:182`; pinned
    `packages/capability/tests/unit/sanitize.test.ts:132-143`.
12. **The trace rule set matches the generic secret words only against a quoted value**, so persisted
    source code is not corrupted. Production `packages/capability/src/sanitize.ts:49-52`; pinned
    `packages/capability/tests/unit/sanitize.test.ts:145-170`.
13. **`sanitizeText` reaches an unquoted assignment that `sanitizeToolPayload` deliberately leaves.**
    Production `packages/capability/src/sanitize.ts:66-69`, `:134-139`; pinned
    `packages/capability/tests/unit/sanitize.test.ts:298-301`.
14. **`sanitizeDeep` redacts a short opaque value whose *key* looks like a credential**, wholesale,
    under either redactor. Production `packages/capability/src/sanitize.ts:230-232`; pinned
    `packages/capability/tests/unit/sanitize.test.ts:276-294`, `:331-339`.
15. **The URL-credential rule's scheme group is length-bounded, keeping the sanitizer linear on a long
    unbroken token.** Production `packages/capability/src/sanitize.ts:87`; pinned
    `packages/capability/tests/integration/sanitize-runtime.test.ts:5-18`.
16. **`@clarvis/memory`'s barrel republishes `sanitizeText` by identity and does not publish
    `sanitizeDeep`.** Production `packages/memory/src/index.ts:64`; pinned
    `packages/memory/tests/architecture/barrel.test.ts:15`, `:20`. (This is INV-090 in the
    code-derived catalog, owned by **memory-capability-and-tools**, `specs/capabilities/memory-capability.md`.)
17. **The kernel re-exports the canonical redactors by identity**, which is the only route by which
    `@clarvis/code` can reach them. Production `packages/kernel/src/policy.ts:38-39`; pinned
    `packages/kernel/tests/component/public-entrypoints.test.ts:22-25`, with the named replacements
    re-asserted at `:27-33`.
18. **An untrusted server error is normalized before crossing the wire** (INV-207) — full statement
    owned by [hosts/kernel-transport.md](../hosts/kernel-transport.md) §5; this package
    supplies the two rule sets (`sanitizeDeep`/`sanitizeErrorMessage`) the wire applies.
19. **Truncating oversized error details never drops the reconciliation flags** (INV-208) — full
    statement owned by [hosts/kernel-transport.md](../hosts/kernel-transport.md) §5.
20. **Bounding runs before sanitizing.** `boundJsonValue` produces the finite, getter-free copy the
    recursive redactors then walk, so a cyclic or enormous graph never reaches them. Production
    `packages/kernel/src/core/bounded-json.ts:15-27`, applied at
    `packages/kernel/src/transport/stdio.ts:351-354` and `packages/kernel/src/runs/map-events.ts:193-203`.
    **Unpinned** as an ordering rule.
21. **`envRefPattern` returns a fresh `RegExp` on every call**, so no interleaved `replace`/`exec`
    depends on another's `lastIndex`. Production `packages/capability/src/env-ref.ts:27-29`; pinned
    `packages/capability/tests/unit/env-ref.test.ts:5-22`.
22. **The hook denylist and the interpolation resolvers read the same `${VAR}` syntax**, because both go
    through `extractEnvRefs`/`envRefPattern`. Production `packages/hooks/src/env.ts:17`, `:216-218`
    against `packages/capability/src/env-interpolate.ts:48`; pinned by the two identical table-driven
    suites `packages/capability/tests/unit/env-ref.test.ts:26-38` and
    `packages/hooks/tests/unit/env.test.ts:126-136`.
23. **A missing `${VAR}` is reported by name and never by value.** `MissingEnvVarsError.missing` carries
    the distinct variable names. Production `packages/capability/src/env-interpolate.ts:19-26`, `:78`;
    pinned `packages/capability/tests/unit/env-interpolate.test.ts:50-58`, `:78-86`.
24. **The hook environment keep-list wins over both deny rules.** Production
    `packages/hooks/src/env.ts:185-188`; pinned `packages/hooks/tests/unit/env.test.ts:73-77` and, for
    the counts, `:115-118`.
25. **A variable dropped by the exact denylist is never also charged to the shape rule.** Production
    `packages/hooks/src/env.ts:189-196`; pinned `packages/hooks/tests/unit/env.test.ts:110-113`.
26. **The hook filter names nothing it withheld.** `FilteredHookEnv` carries only counts, and the log
    line emits only counts. Production `packages/hooks/src/env.ts:148-158`,
    `packages/hooks/src/capability.ts:370-378`. **Unpinned** — no test asserts the absence of a name in
    the log fields.
27. **The per-run denylist covers a provider's *model*-level headers.** They are reached through
    `Object.values(provider.models ?? {})`; a `for…of` over the record would iterate nothing and throw
    nothing. Production `packages/hooks/src/capability.ts:306`, hazard stated at `:251-253`.
    **Unpinned.**
28. **A stdio MCP child never inherits the caller's environment.** Its base is
    `getDefaultEnvironment()`, and declaring `env` *adds* to it rather than switching the child from
    "inherit everything" to "inherit a filtered set". Production
    `packages/mcp-client/src/client.ts:383`; pinned
    `packages/mcp-client/tests/unit/mcp-transport-env.test.ts:33-63`, including the property that the
    base does not depend on the identity of the caller's env object (`:56-63`).
29. **A hook subprocess cannot read this run's provider credentials.** Production
    `packages/hooks/src/capability.ts:366-368` composing `packages/hooks/src/env.ts:175`; pinned
    end-to-end against a real subprocess at
    `packages/hooks/tests/integration/real-subprocess.test.ts:139-160`, which asserts the child prints
    two empty values.
30. **`keys.json` is written owner-only.** `writeFileAtomicSync` defaults to file `0o600` inside a
    `0o700` directory. Production `packages/kernel/src/secrets/secret-store.ts:105`,
    `packages/paths/src/atomic.ts:412-414`, `packages/paths/src/constants.ts:40`, `:52`. **Unpinned**
    for the secret store specifically. The code records that the bits are inert on Windows
    (`packages/kernel/src/secrets/secret-store.ts:95-102`).
31. **A secret name must be an environment-variable identifier and a value must be non-empty.**
    Production `packages/kernel/src/secrets/secret-store.ts:7`, `:112-113`; pinned
    `packages/kernel/tests/integration/secret-store.test.ts:31-35`.
32. **A corrupt `keys.json` is never silently overwritten.** Both `set` and `delete` throw while
    `read().error` is set. Production `packages/kernel/src/secrets/secret-store.ts:115`, `:120`.
    **Unpinned** — the test suite covers the read-side error (`:37-43`) but not the refusal.
33. **`SecretService` exposes names only.** Production `packages/kernel/src/secrets/secret-store.ts:142-144`,
    contract `packages/protocol/src/secrets.ts:14`; pinned
    `packages/kernel/tests/integration/secret-store.test.ts:45-53`. The TUI adapter holds only names
    (`packages/code/src/adapters/provider-secrets.ts:32-45`).
34. **A workspace's risky settings never enter the merge while it is unapproved** — they are withheld
    *before* merging rather than filtered afterwards. Production
    `packages/kernel/src/config/file-config-store.ts:600-603`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts:281-311`, whose comment records that an
    earlier post-merge filter compared by object identity and therefore permitted everything it claimed
    to block.
35. **Every declared risk field is gated, not just `hooks`.** Production
    `packages/kernel/src/config/workspace-trust.ts:103-115`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts:52-69` (all seven) and `:177-195`.
36. **An untrusted workspace contributes no agent layer**, on both the listing and the effective-agent
    path. Production `packages/kernel/src/config/file-config-store.ts:886`, `:950` (rationale `:877-881`). **Unpinned** —
    `workspace-trust.test.ts` covers the settings half only.
37. **An empty risky value is not a declared surface.** `hooks: []` / `mcpServers: {}` leave the
    workspace `inert`. Production `packages/kernel/src/config/workspace-trust.ts:89-94`; pinned
    indirectly at `packages/kernel/tests/integration/workspace-trust.test.ts:169-173` for a workspace
    with no risky key at all. **The empty-array case itself is unpinned.**
38. **Approval binds to the surface, not to the path.** Production
    `packages/kernel/src/config/workspace-trust.ts:326-329`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts:146-157`.
39. **An unreadable trust store means "nothing approved".** Production
    `packages/kernel/src/config/workspace-trust.ts:305`, consumed at
    `packages/kernel/src/config/file-config-store.ts:512`. **Unpinned.**
40. **A trust key is the realpath of the workspace root.** Production
    `packages/kernel/src/config/workspace-trust.ts:284-290`. **Unpinned.**
41. **An operator write through `ConfigService` carries an existing approval and never creates one.**
    Production `packages/kernel/src/config/file-config-store.ts:566-568`; pinned
    `packages/kernel/tests/integration/workspace-trust.test.ts:199-237`.
42. **An agent name is one filename segment.** No separator, no drive/stream separator, no leading dot,
    no `..`, no `:`. Production `packages/kernel/src/config/config-service.ts:65`, `:68`, `:78-86`;
    pinned across all four name-taking methods at
    `packages/kernel/tests/contract/config-service.test.ts:133-175`, and for the file store at `:177-185`.
43. **A forbidden provider `body` key is refused by the schema *and* stripped by the adapter.**
    Production `packages/loop/src/validation/request/provider-rules.ts:41-49` and
    `packages/llm/src/openai-compatible-request.ts:186`; the constant is pinned against the TUI's
    suggestion list at `packages/code/tests/unit/request-params.test.ts:35-42` and against the editor
    warning at `:53-59`.
44. **A malformed `${...}` reference in a provider or model header is a request-validation failure**,
    detected by removing every well-formed reference and checking for a residual `${`. Production
    `packages/loop/src/validation/request/provider-rules.ts:11-13`, `:24-32`. **Unpinned** in that
    package's own suite as far as this survey found; the equivalent TUI predicate is pinned at
    `packages/code/tests/unit/request-params.test.ts:61-69`.
45. **Log verbosity and the audit channel are environment-only.** `CLARVIS_LOG_LEVEL`, `CLARVIS_LOG`
    and `CLARVIS_LOG_AUDIT` live in the env schema and in no settings block, with the stated reason
    *"a run that could write this through settings could silence the record of what it did"*.
    Production `packages/capability/src/env.ts:178`, `:188`, `:198` (rationale `:194-197`).
    **Unpinned.**
46. **A non-`ToolError` throw never reaches the model.** It is collapsed to
    `{"error":"internal","message":"internal error"}` and the stack goes to the warn sink. Production
    `packages/tools/src/errors.ts:65-76`. **Unpinned** as a leak-prevention rule.
47. **An agent profile cannot request a tool grant above the deployment ceiling.** `agentToolCaps`
    intersects the profile's requested grants with `CLARVIS_AGENT_TOOLS_MAX_GRANT`'s rank (`none <
    read < edit < exec`, default `edit`); `canMutate`/`canExec` can only be true when the ceiling's
    rank is at least `edit`/`exec` respectively, however the profile is configured. Production
    `packages/capability/src/env.ts:113`, `packages/loop/src/runtime/tools/builtin/grants.ts:11-53`,
    consulted at `:66` and `packages/loop/src/runtime/capabilities/tools.ts:161`; pinned
    `packages/loop/tests/unit/grants.test.ts:37-58`.
48. **`resolvePath` never returns the canonical form it computes for the confinement check — every
    call site, without exception, gets the lexical (un-symlink-resolved) path back.** `resolvePath`
    itself only ever returns its local `abs` (`path.normalize`/`path.resolve` on the caller's input),
    on both the confined and unconfined branches (`packages/tools/src/lib/paths.ts:34-36`); the
    canonical form `assertWithinWorkspace` derives via `canonicalizeAllowingMissing` (`:139`, `:143`)
    lives entirely inside that function's own stack frame, is compared only as a boolean
    prefix/equality test (`:145`), and is never returned, assigned to an outer variable, or passed to
    a caller — `canonicalize` and `canonicalizeAllowingMissing` both lack the `export` keyword
    (`packages/tools/src/lib/paths.ts:174`, `:248`), so no code outside this one file, and nothing the
    package's own barrel (`packages/tools/src/index.ts`, which does not re-export `./lib/paths` at
    all) could hand a consumer, could reach that value even if it wanted to. Every tool that turns a `resolvePath` result
    into a filesystem operation — `readRawFile` (`packages/tools/src/lib/files.ts`), and the
    `mkdir`/`open("wx")`/`rename` calls in `packages/tools/src/lib/atomic.ts:70-73`, `:135-139` — takes
    that same lexical string, never a canonicalized one. For reads this is not a gap: item 7 above
    describes the second, independent canonicalization `assertOpenedFileConfined` performs on the
    *opened* file (`packages/tools/src/lib/files.ts:129-144`), tying the confinement re-check to the
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
    `packages/code/tests/integration/plugin-install.test.ts:49-86`, the injected kernel runner at
    `packages/kernel/tests/integration/local-observability.test.ts:102-135`, and the real workspace
    probe at `packages/memory/tests/integration/workspace-state.test.ts:11-49`.
50. **Remote OAuth credentials are isolated by workspace, owner, canonical resource URL and the
    configured client/callback metadata.** The tuple is hashed and only the digest keys the private
    document. Production: `packages/mcp-client/src/oauth.ts:188-205`; the workspace, owner, and URL
    dimensions are pinned at `packages/mcp-client/tests/integration/oauth.test.ts:56-67`, while the
    additional configuration dimensions have no direct key-isolation assertion.
51. **No OAuth fetch, redirect or browser destination can downgrade to non-loopback plaintext, and
    browser authorization cannot proceed without explicit host authority.** Production
    `packages/mcp-client/src/remote-fetch.ts:35-40,53-118` and
    `packages/mcp-client/src/oauth.ts:217-224,510-562`; pinned
    `packages/mcp-client/tests/unit/remote-fetch.test.ts:98-192` and
    `packages/mcp-client/tests/integration/oauth.test.ts:215-236`.
52. **The OAuth callback accepts only a bounded code paired with the timing-safe matching random
    state, and reflects neither.** Production `packages/mcp-client/src/oauth.ts:129-161,258-310`;
    pinned `packages/mcp-client/tests/integration/oauth.test.ts:69-102`.
53. **A corrupt, oversized or symlinked OAuth store is refused and never repaired by overwrite.**
    Production `packages/mcp-client/src/oauth-store.ts:152-262`; pinned
    `packages/mcp-client/tests/integration/oauth-store.test.ts:86-148`.
54. **A configured MCP resource credential cannot enter an OAuth exchange or overwrite an
    SDK-defined credential.** Resource headers are admitted only for resource requests on the
    configured origin, while OAuth discovery, registration and token traffic stays header-isolated;
    redirect hops are evaluated independently. Production:
    `packages/mcp-client/src/remote-fetch.ts:53-114`, constructed without SDK `requestInit` headers at
    `packages/mcp-client/src/client.ts:417-447`; pinned
    `packages/mcp-client/tests/unit/remote-fetch.test.ts:7-95,141-167`.

55. **A workspace Environment activates operator-owned global plugins without another workspace
    approval. Every installed `scope: "workspace"` plugin enters one content-addressed workspace
    fingerprint before selection; approving it once covers all repository plugins and Environment
    switches until that inventory changes. Hook definitions remain part of each atomic plugin
    digest.** Production:
    `workspaceTrustSurface`, `preview`, and `select` in
    `packages/kernel/src/environments/environment-manager.ts`, folded through
    `WorkspaceExecutableSurface.extensions` in
    `packages/kernel/src/config/workspace-trust.ts`. Test:
    `packages/kernel/tests/integration/environment-manager.test.ts` (complete pre-selection
    inventory, content invalidation, global-plugin activation without workspace approval,
    mixed-scope partial admission, one-approval Environment switching, and matching reconnect
    fingerprint) and
    `packages/kernel/tests/integration/workspace-trust.test.ts` (extension surface changes the trust
    hash and is reported as withheld `environment` until approved).

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

## 6. Failure modes and degradation

| Condition | Handler | Outcome |
| --- | --- | --- |
| Confined path outside every root | `packages/tools/src/lib/paths.ts:160` | `ToolError("path_escape")`, `{ path: input }`; message states the boundary is fixed before the run |
| Containment unprovable (unresolvable symlink) | `packages/tools/src/lib/paths.ts:254` → `:142` | same `path_escape`, logged with `reason: "unresolvable"` |
| Path swapped between check and open | `packages/tools/src/lib/files.ts:137-144` | `path_escape`, `"Path changed while it was being opened"` |
| `realpath`/`stat` failure during that check | `packages/tools/src/lib/files.ts:125-127` | mapped through `fsError` |
| Native mutation below a selected skill execution root | `protectSkillPackages` in `packages/tools/src/core.ts` | `path_escape` before guard/handler; no mutation runs |
| Unsafe or unsupported borrowed `userConfig` reference | `resolveBorrowedUserConfig` in `packages/kernel/src/plugins/plugin-manifest.ts` | only the affected MCP is withheld; safe sibling contributions survive |
| Write target is a symlink | `packages/tools/src/lib/atomic.ts:111-115` | `ToolError("invalid_input")`, `"Refusing to write through a symlink"` |
| Atomic write fails after creating a parent | `packages/tools/src/lib/atomic.ts:143-146` | the created directory is removed best-effort, then rethrow |
| Batch commit fails mid-way | `packages/tools/src/lib/atomic.ts:283-288` (doc) / `:288` | rolled back; a failed undo becomes `io_error` naming the unrestorable originals |
| Oversized tool result cannot be spilled | `packages/loop/src/runtime/context/tool-spill.ts:49-58`, `packages/tools/src/lib/output.ts:395-406` | degrades to a truncation marker naming no file; the run continues |
| Unset `${VAR}` in an interpolation-enabled MCP `env`/`headers`, an environment-backed MCP credential, or a provider header | `resolveStringMap` in `packages/capability/src/env-interpolate.ts` | `MissingEnvVarsError` naming the distinct variables; portable literal mode skips only authored MCP maps, not explicit environment-backed credential declarations |
| Marketplace source fails shared transport, selector, npm, or expected-name validation | `readSource` in `packages/loop/src/settings/marketplace-schema.ts`; `installPrepared` in `packages/kernel/src/plugins/plugin-service.ts` | listing remains visible but non-installable when acquisition is impossible; a staged identity mismatch is refused before inventory mutation |
| Forbidden provider body key, validation path | `packages/loop/src/validation/request/provider-rules.ts:43-48` | `ValidationError("invalid_provider_config")` — hard failure with a diagnostic |
| Forbidden provider body key, adapter path | `packages/llm/src/openai-compatible-request.ts:186` | **silently dropped** |
| `keys.json` missing | `packages/kernel/src/secrets/secret-store.ts:79` | `{ values: {} }` — tolerated |
| `keys.json` unparseable, or valid JSON with a key failing `ENV_VAR_RE` or a value failing `min(1)` | `:82-89` | empty values plus an `error` — `keysFileSchema` is `z.record(...)`, and Zod fails the **whole** parse on any one bad key/value rather than dropping it (verified against the installed `zod@^4.4.3`: `schema.safeParse({GOOD:"v", "1bad-key":"v"})` returns `success:false` with an `"Invalid key in record"` issue), so `parsed.success ? {values:...} : {values:{}, error:...}` (`:86-89`) takes the same empty-plus-error branch as unparseable JSON; `set`/`delete` then throw `"… is invalid (…) — fix it by hand first"` (`:115`, `:120`) |
| `workspace-trust.json` unparseable, read | `packages/kernel/src/config/workspace-trust.ts:305` | `{ error }`; the verdict degrades to `unapproved` |
| `workspace-trust.json` unparseable, write | `:350-352` | throws — refuses to overwrite recorded approvals |
| …except when carrying an approval across an operator write | `packages/kernel/src/config/file-config-store.ts:569-573` | swallowed: the file already landed, so a phantom failure would be worse |
| Untrusted workspace | `packages/kernel/src/config/file-config-store.ts:600-603`, `:886`, `:950` | risky fields and agent files withheld; the run proceeds on the operator's config; `withheld_workspace_fields` is reported (`:678`) and the raw scope is still visible (`packages/kernel/tests/integration/workspace-trust.test.ts:92-99`) |
| Invalid agent name | `packages/kernel/src/config/config-service.ts:81-85` | `kernelError("invalid_request")` before any path is built |
| Unknown server error code on the wire | `packages/kernel/src/transport/stdio.ts:377` | collapses to `internal` |
| Error details unserializable/cyclic | `packages/kernel/src/transport/stdio.ts:366-368` | `safeErrorDetails` returns `undefined`; details are simply omitted |
| Capability event detail unserializable | `packages/kernel/src/runs/map-events.ts:204-206` | `"[unserializable capability event]"`, `truncated: true` |
| Non-`ToolError` thrown by a handler | `packages/tools/src/errors.ts:69-76` | generic `internal` to the model; the stack only to the warn sink |
| ripgrep probe throws at config time | `packages/tools/src/config.ts:187-193` | treated as "capability absent" |

Degradations worth naming explicitly, because they are *deliberate* and therefore easy to mistake for
bugs: a failed spill loses the middle of one tool result rather than the run
(`packages/loop/src/runtime/context/tool-spill.ts:30-32`); withholding a repository's risky fields
lets the run proceed rather than refusing to start
(`packages/kernel/src/config/workspace-trust.ts:73-77`); and the coarse fallback's false positives are
real — a 64-hex project id and a full UUID both read as credentials, which is why
`@clarvis/server` shortens ids to 12 characters before logging
(`packages/server/src/logging.ts:120-138`, pinned
`packages/server/tests/unit/logging.test.ts:104-107`).

## 7. Coupling

### 7.1 What forces each edge

| Edge | Kind | What forces it |
| --- | --- | --- |
| `@clarvis/hooks` → `@clarvis/capability` | runtime, static | `import { extractEnvRefs } from "@clarvis/capability"` (`packages/hooks/src/env.ts:17`); declared in `packages/hooks/package.json` |
| `@clarvis/tools` → `@clarvis/paths` | runtime, static | `workspaceStatePaths` for `stateRoot` (`packages/tools/src/config.ts:7`, `:463`); `TMP_GLOB`/`writeFileDurable` in `packages/tools/src/lib/atomic.ts:4` |
| `@clarvis/tools` → *nothing else internal* | — | `packages/tools/package.json` lists only `@clarvis/paths`; the package therefore **cannot** call `sanitize*` |
| `@clarvis/kernel` → `@clarvis/paths` | runtime, static | `globalPaths(...).keysFile` / `.workspaceTrustFile`, `writeFileAtomicSync` (`packages/kernel/src/secrets/secret-store.ts:3`, `packages/kernel/src/config/workspace-trust.ts:3`) |
| `@clarvis/kernel` → `@clarvis/protocol` | type-only for `SecretService` | `import type { SecretService }` (`packages/kernel/src/secrets/secret-store.ts:4`) |
| `@clarvis/kernel/config/workspace-trust` → `@clarvis/loop/host` | runtime, static | `readJsonFile` (`packages/kernel/src/config/workspace-trust.ts:5`) |
| `@clarvis/code` → canonical redactors | runtime, static | only through `@clarvis/kernel/policy` (`packages/code/src/adapters/session-store.ts:9`, `packages/code/src/adapters/diagnostic-session.ts:12`), pinned by `packages/kernel/tests/component/public-entrypoints.test.ts:22` |
| `@clarvis/llm` → `FORBIDDEN_PROVIDER_BODY_KEYS` | runtime, static | `packages/llm/src/openai-compatible-request.ts:17` |
| `@clarvis/loop` validation → the same constant | runtime, static | `packages/loop/src/validation/request/provider-rules.ts:3` |
| `@clarvis/trace` → `sanitizeDeep` | runtime, static | `packages/trace/src/json-trace-store.ts:32`, `packages/trace/src/journal.ts:6`, `packages/trace/src/trace-mapper.ts:4`, `packages/trace/src/testing.ts:2` |
| loop tools capability → `resolveSecretNames` | runtime, injected | optional port on `AgentToolsCapabilityOptions` (`packages/loop/src/runtime/capabilities/tools.ts:82`, called `:135`), bound by the file kernel at `packages/kernel/src/file-kernel.ts:783` |
| hooks capability → `credentialNames` | runtime, injected | optional callback (`packages/hooks/src/capability.ts:343`, called `:320`) |
| `@clarvis/mcp-client` → `@clarvis/paths` | runtime, static | private modes, local lease and durable replacement for OAuth credentials (`packages/mcp-client/src/oauth-store.ts:12`) |
| file kernel → MCP authorization | runtime, injected through loop | global store path and optional browser opener (`packages/kernel/src/file-kernel.ts:640-677`; `packages/loop/src/runtime/build-run-deps.ts:391-402`) |

### 7.2 Where redaction is actually applied

| Consumer | Function | Site |
| --- | --- | --- |
| trace event mapping | `sanitizeDeep` (default redactor) | `packages/trace/src/trace-mapper.ts:61` |
| trace store insert | `sanitizeDeep` over `request`/`response` | `packages/trace/src/json-trace-store.ts:793-794`, `packages/trace/src/testing.ts:50-51` |
| crash journal header | `sanitizeDeep` over `request` | `packages/trace/src/journal.ts:159` |
| kernel wire errors | `sanitizeErrorMessage` (inside `terminalSafe`) + `sanitizeDeep` | `packages/kernel/src/transport/stdio.ts:70`, `:354` |
| kernel run/capability events | `sanitizeText` + `sanitizeDeep` | `packages/kernel/src/runs/map-events.ts:83`, `:203` |
| kernel task errors | `sanitizeErrorMessage`, `sanitizeDeep` | `packages/kernel/src/tasks/task-service.ts:235`, `:256`; `packages/kernel/src/tasks/task-provider-factory.ts:113`, `:227`, `:392` |
| loop run result mapping | `sanitizeErrorMessage`, `sanitizeDeep` | `packages/loop/src/runtime/run-response-mapping.ts:54`, `:62-63`, `:69` |
| memory run snapshot | `sanitizeDeep(run, sanitizeText)` — **before** any bound or write | `packages/memory/src/jobs.ts:224` (rationale `:214-215`); indexer task `packages/memory/src/indexer/run.ts:377` |
| memory tool results / seed / policy / health | `sanitizeText` | `packages/memory/src/tools.ts:41`, `:53`; `packages/memory/src/seed.ts:89`; `packages/memory/src/recording-policy.ts:51`; `packages/memory/src/health.ts:204-205` |
| MCP client diagnostics | `sanitizeErrorMessage` | `packages/mcp-client/src/{connection,resources,resilient-session}.ts` |
| `code` session previews | `sanitizeText` on the first line, before truncation | `packages/code/src/adapters/session-store.ts:121` (rationale `:103-110`) |
| `code` diagnostics | `sanitizeErrorMessage` + ANSI strip | `packages/code/src/adapters/diagnostic-session.ts:140` |
| LLM provider errors | `sanitizeErrorMessage` | `packages/llm/src/ai-sdk/errors.ts` |

`sanitizeToolPayload` has **no direct production call site** outside its role as `sanitizeDeep`'s
default parameter (`packages/capability/src/sanitize.ts:223`); its whole production reach is through
the four `sanitizeDeep` call sites in `@clarvis/trace` and the loop's result mapping.

### 7.3 Downstream of workspace trust

`stripWorkspaceRiskFields` is consumed only by `createFileConfigStore`
(`packages/kernel/src/config/file-config-store.ts:43-45`, applied once in `operatorLayers` at `:602`), which is what makes
`file-kernel.ts` able to state that no hook filtering happens at the hook layer any more
(`packages/kernel/src/file-kernel.ts:544-552`).

## 8. Open questions

- ~~**Why the parent-directory TOCTOU is left open.**~~ **Recorded 2026-08-22, behaviour
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
  readable at the line that makes it instead of only in `specs/known-issues.md`.
- **Why `capability` executables inherit the whole kernel environment** while stdio MCP children get a
  fixed safe base. **Still open, but now visible at the line that makes the choice**: the divergence
  is recorded in `processEnvironment`'s own TSDoc, naming both counter-examples — the MCP child's
  fixed safe base and the hook's keep-list-then-denylist — and stating plainly that a configured
  capability executable receives every credential the kernel holds, and that whether that is intended
  is the owner's call (`packages/kernel/src/capability-executables/session-manager.ts:52`–`:71`).
  What has not changed is the behaviour or the absence of a test.
  `packages/mcp-client/src/client.ts:325-338` argues at length for the MCP policy;
  `packages/kernel/src/capability-executables/session-manager.ts:76-84` carries no rationale and no
  test for its environment shape. This is a live divergence, not obviously a bug — a plans/memory
  provider may need credentials — but nothing in the code says which.
- ~~**A stale rationale in `packages/hooks/src/env.ts`.**~~ **Resolved.** The comment claimed the
  secret-name vocabulary was duplicated because the two sides "live on opposite sides of a dependency
  edge this package must not close", naming `@clarvis/loop`'s trace sanitizer. That edge does not
  exist: the sanitizer is `SENSITIVE_KEY` in `@clarvis/capability`
  (`packages/capability/src/sanitize.ts:202`), which `packages/hooks/package.json` already declares
  and `packages/hooks/src/env.ts:17` already imports from. The remark now gives the reason that does
  hold — the two patterns are deliberately different because their failure modes are opposite: a
  redactor over-matching costs legibility, while dropping an environment variable over-matching
  breaks the hook, which is why this one is separator-anchored and carries `auth`, `credentials` and
  `session` (`packages/hooks/src/env.ts:79`–`:94`).
  Whether the duplication is still wanted for the *behavioural* reason (`SECRET_NAME` is
  separator-anchored and adds `auth`/`session`/thirteen prefixes; `SENSITIVE_KEY` is an unanchored
  substring test) is not stated.
- **`metadata.sensitivity` is never enforced, `secrets.set` carries its value in cleartext, and the
  transport's two host policy hooks fail open with no production implementation** — settled against
  the code, with the stdio trust model that bounds it, in
  [kernel-transport.md](../hosts/kernel-transport.md) §6.3. **Recorded 2026-08-22**: both hooks now
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
- **`ALLOW_OUTSIDE_WORKSPACE` does not exist as a knob.** The name survives only in a comment
  (`packages/tools/src/lib/paths.ts:115`) and in the architecture test's positive/negative fixtures
  (`packages/tools/tests/architecture/no-bypass-hints.test.ts:87`, `:99`). The real controls are
  `AgentToolsOptions.confineToWorkspace` (`packages/tools/src/config.ts:236`) and
  `CLARVIS_AGENT_TOOLS_CONFINE` (`packages/capability/src/env.ts:112`). Whether the historical variable
  was ever read is not determinable from the current tree.
