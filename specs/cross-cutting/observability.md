# The one diagnostic channel: Logger port, vocabulary, cost and audit

> Implemented at `packages/...`. Every claim below is anchored to a file and line. Open questions
> are collected in the final section.

## 1. Purpose

Clarvis routes every structured diagnostic — everything an operator debugging the system reads —
through one narrow port, `Logger` (`packages/capability/src/ports.ts:42`), and nowhere else. The
port is declared in `@clarvis/capability` so a capability can log without depending on a logging
library; the one concrete backend (`pino`) lives in `packages/loop/src/logger.ts:1`, kept out of the
contract package on purpose (`packages/loop/src/logger.ts:36-40`: "Returns pino's own logger, not the
`Logger` port, because a host configures it... The port is what a capability *declares*; this is the
one module that knows which library backs it").

The subsystem solves three distinct problems with one mechanism:

- **A structural contract a package can log against without adopting a backend.** `Logger` has four
  required methods (`debug/info/warn/error`) plus two optional ones (`child`, `level`)
  (`packages/capability/src/ports.ts:42-76`), and pino satisfies it structurally with no adapter
  (`packages/loop/src/logger.ts:36-40`).
- **Per-component verbosity without a per-run knob.** `CLARVIS_LOG_LEVEL` sets a process-wide floor;
  `CLARVIS_LOG` overrides it per named subsystem (`packages/capability/src/log.ts:104-160`). Both
  live only in the environment schema, never `settings.json` or a run request, but their doc-comments
  argue this from two different angles: `CLARVIS_LOG`'s own comment says nothing about silencing — it
  argues the component vocabulary is deliberately open, "the way `TraceKind` is"
  (`packages/capability/src/env.ts:179-187`). It is `CLARVIS_LOG_AUDIT` alone whose comment states the
  silencing rationale explicitly: "Environment only: a run that could write this through settings
  could silence the record of what it did" (`packages/capability/src/env.ts:189-196`).
- **An audit channel that survives an operator turning verbosity down.** Command-guard rulings and
  (per `@clarvis/server`, delegated elsewhere) authentication decisions are logged through a
  level-pinned sibling of the diagnostic logger so `CLARVIS_LOG_LEVEL=warn` — "a legitimate production
  setting" — cannot silence them (`packages/kernel/src/component-loggers.ts:88-100`).

Everything downstream of the port follows one rule stated in the package doc-comment of
`@clarvis/tools`'s own copy of the discipline: "There is exactly one way out of this package, and it
is not the terminal" (`packages/tools/tests/architecture/logging-channel.test.ts:1-13`). No package may
reach `process.stdout`, `process.stderr` or `console.*` directly for a diagnostic; a terminal host
(`@clarvis/code`) owns the terminal as a rendered canvas, and a stray raw write corrupts the frame
mid-string rather than merely being noisy (`packages/code/src/adapters/terminal-guard.ts:29-31`).

### 1.1 The trace-versus-log rule

This document's scope names "the trace-versus-log rule" as its own (trace *persistence itself* is the
sibling [foundations/trace.md](../foundations/trace.md) document's). None of the six files this document reads —
`packages/capability/src/{ports,log,env}.ts`, `packages/kernel/src/component-loggers.ts`,
`packages/loop/src/logger.ts`, and the per-package `log.ts` modules in `tools`, `skills`,
`workflows`, `plan`, `server` — states the general principle in one place; they assume it. `§6`'s
compaction-summarizer row is the only place in the document the distinction is worked through
concretely, and its citation (`packages/loop/src/runtime/context/llm-compaction.ts:363-388`) is
outside this document's own scope. Stated plainly, from what the six in-scope files show by
construction rather than by comment: **a trace entry is part of the persisted record of what a run
did and is read back on rehydration** (`TracePort.record`, `packages/capability/src/ports.ts:98-109`);
**a log record is Clarvis's own machinery narrating itself, is never parsed back, and has no
rehydration path** — every symbol this document reads (`Logger`, `NOOP_LOGGER`, `componentLogger`,
`bindLevelled`, the per-package `log.ts` modules) exists to shape that second, disposable channel, and
none of them touches `TracePort`. No in-scope file states this contrast better than the one worked
example already cited in §6; that example remains the illustration, not a restatement of a principle
this document can source more directly.

## 2. Surface

### 2.1 The port (`@clarvis/capability`)

| Symbol | Kind | Location | Signature / role |
|---|---|---|---|
| `LogFn` | interface | `packages/capability/src/ports.ts:22-24` | `(obj: unknown, msg?: string, ...args) => void` overloaded with `(msg: string, ...args) => void` — matches pino's own `LogFn` structurally |
| `Logger` | interface | `packages/capability/src/ports.ts:42-76` | `{ debug, info, warn, error: LogFn; child?(bindings): Logger; level?: string }` |
| `LOG_LEVELS` | const tuple | `packages/capability/src/log.ts:12` | `["debug","info","warn","error","silent"]` — deliberately excludes pino's `trace`/`fatal` |
| `LogLevel` | type | `packages/capability/src/log.ts:15` | `(typeof LOG_LEVELS)[number]` |
| `DEFAULT_LOG_LEVEL` | const | `packages/capability/src/log.ts:18` | `"info"` |
| `isLogLevel` | fn | `packages/capability/src/log.ts:34` | type guard: `value is LogLevel` |
| `NOOP_LOGGER` | const `Logger` | `packages/capability/src/log.ts:48-55` | discards every call; `child` returns itself; `level: "silent"` |
| `levelEnabled` | fn | `packages/capability/src/log.ts:72-76` | `(logger, level) => boolean` — guards payload *construction*, not just emission |
| `bind` | fn | `packages/capability/src/log.ts:88-90` | `(logger, bindings) => Logger` — derives via `child`, else returns `logger` unchanged |
| `parseLogScopes` | fn | `packages/capability/src/log.ts:104-116` | parses `CLARVIS_LOG`'s `component=level,...` spec into a `Map` |
| `activeLevelOf` | fn | `packages/capability/src/log.ts:131-134` | reads a logger's own reported level, or `undefined` if unrecognized |
| `levelFor` | fn | `packages/capability/src/log.ts:146-160` | resolves the effective level for one component, longest dot-prefix wins |
| `componentLogger` | fn | `packages/capability/src/log.ts:197-199` | derives a component-stamped, level-pinned child |
| `bindLevelled` | fn | `packages/capability/src/log.ts:215-224` | general form: binds arbitrary fields plus an optional level |
| `Sampler` | type | `packages/capability/src/log.ts:227` | `(key: string) => boolean` |
| `evictOldest` | fn (private) | `packages/capability/src/log.ts:230-235` | bounded-key eviction helper shared by `createSampler`/`createRateLimiter`: once `maxKeys` distinct keys are tracked, evicts the single oldest-inserted key before a new one is recorded |
| `DEFAULT_MAX_KEYS` | const | `packages/capability/src/log.ts:229` | `1_024` — the default `maxKeys` for both `createSampler` and `createRateLimiter` |
| `createSampler` | fn | `packages/capability/src/log.ts:250-260` | first-8-then-powers-of-2 admission policy, `maxKeys` defaults to `DEFAULT_MAX_KEYS` |
| `RateLimiterOptions` | interface | `packages/capability/src/log.ts:263-270` | `{ windowMs?, maxKeys?, clock? }` |
| `DEFAULT_RATE_LIMIT_MS` | const | `packages/capability/src/log.ts:272` | `60_000` — the default `windowMs` when `createRateLimiter` is called with none |
| `createRateLimiter` | fn | `packages/capability/src/log.ts:284-298` | admits one occurrence of a key per `windowMs` (default 60,000 ms), `maxKeys` defaults to `DEFAULT_MAX_KEYS` |

Every one of the above that its module exports is re-exported through `@clarvis/capability`'s root
`index.ts` (`packages/capability/src/index.ts:99-115`). The three exceptions are module-private and
appear in the table only because the exported functions' defaults and eviction behaviour are theirs:
`evictOldest`, `DEFAULT_MAX_KEYS` and `DEFAULT_RATE_LIMIT_MS` carry no `export` keyword
(`packages/capability/src/log.ts:229-231`, `:272`).

### 2.2 The backend (`@clarvis/loop`)

| Symbol | Location | Role |
|---|---|---|
| `createLogger(level?, opts?)` | `packages/loop/src/logger.ts:47-56` | builds the one pino logger a host distributes; `opts.destination` is `1` (stdout) or `2` (stderr, default); `opts.service` stamps `service` on every record, defaulting to `"@clarvis/loop"` |
| `CreateLoggerOptions` | `packages/loop/src/logger.ts:7-27` | `{ destination?: 1 \| 2; service?: string }` |
| `type Logger` (re-export) | `packages/loop/src/logger.ts:62` | re-exports `@clarvis/capability`'s port so an in-engine consumer imports it from the same path it always did |

### 2.3 Kernel component-logger factory (`@clarvis/kernel`)

| Symbol | Location | Role |
|---|---|---|
| `ComponentLoggers` | `packages/kernel/src/component-loggers.ts:17` | `(component: string) => Logger` |
| `componentFloor(root, configured)` | `packages/kernel/src/component-loggers.ts:33-35` | host's own reported level, else the configured `CLARVIS_LOG_LEVEL` |
| `createComponentLoggers(root, spec, fallback)` | `packages/kernel/src/component-loggers.ts:64-79` | builds a memoizing per-component factory; all-silent when `root` is `undefined` or already `"silent"` |
| `createAuditLogger(root, enabled)` | `packages/kernel/src/component-loggers.ts:102-106` | builds the audit channel: `{component:"audit", audit:true}` pinned at `"info"`; `NOOP_LOGGER` when `root` is absent, disabled, or itself `"silent"` |
| exported from | `packages/kernel/src/index.ts:3` | `export { createAuditLogger, createComponentLoggers }` |

### 2.4 Per-package log modules (structural sub-ports)

| Package | File | Port name | Discards-everything const | Process-wide sink |
|---|---|---|---|---|
| `@clarvis/tools` | `packages/tools/src/lib/log.ts:26-31` | `ToolsLogger` | `NOOP_TOOLS_LOGGER` (`:42-47`) | `WarnSink` / `warn()` / `setWarnSink()` (`:72-114`) |
| `@clarvis/tools` (structured warning shape) | `packages/tools/src/lib/log.ts:58-65` | `ToolsWarning` | n/a | n/a — carried as `WarnSink`'s second parameter |
| `@clarvis/skills` | `packages/skills/src/lib/log.ts:38-43` | `SkillDiagnostics` (`{warningSink, logger}`) | `DEFAULT_DIAGNOSTICS` (`:46-49`) | `WarnSink` / `warn()` / `defaultWarnSink` (`:7-21`) |
| `@clarvis/paths`* | `packages/paths/src/diag.ts:29-33` | `PathsLogger` | `NOOP_PATHS_LOGGER` (`:46-50`) | `pathsLogger` / `setPathsLogger` (referenced, not in this document's scope) |

\* `@clarvis/paths`'s `diag.ts` is outside this document's primary scope (it belongs to
`@clarvis/paths`'s own package contract) but is cited here only to show the repeated pattern; see
§7 Coupling.

`ToolsWarning` (`packages/tools/src/lib/log.ts:58-65`) is the structured half of a `WarnSink` call:
`{ event: string; level?: "debug"|"warn"|"error"; fields?: Record<string, unknown> }`. `WarnSink`'s
type is `(message: string, warning?: ToolsWarning) => void` (`:68`), so a host bridging `warn()` into
a real `Logger` recovers the same `event`/`level` vocabulary the rest of the codebase uses, rather
than only the flattened text message.

`@clarvis/workflows` (`packages/workflows/src/log.ts`) does **not** declare its own structural
port — it consumes `@clarvis/capability`'s `Logger`/`NOOP_LOGGER`/`bind` directly
(`packages/workflows/src/log.ts:17`), since the package already depends on `@clarvis/capability`.
`@clarvis/plan`'s `log.ts` goes further: it declares no logging port or `Logger` reference at all —
its sole import from `@clarvis/capability` is `sanitizeErrorMessage` (`packages/plan/src/log.ts:13`),
used to redact a message before it is ever handed to whatever logger a caller holds. Both packages'
modules instead hold logging *helpers*:

| Package | File | Symbol | Role |
|---|---|---|---|
| `@clarvis/workflows` | `packages/workflows/src/log.ts:29-31` | `workflowLogger(ctx)` | `ctx.deps.logger ?? NOOP_LOGGER`, the one permitted normalization site |
| `@clarvis/workflows` | `packages/workflows/src/log.ts:50-57` | `withBoundLogger(deps, bindings)` | derives engine deps whose logger carries `bindings`, preserving `deps` identity when there is no logger |
| `@clarvis/workflows` | `packages/workflows/src/log.ts:74-82` | `faultFields(err)` | projects a thrown value into `{err, stack?, cause?}`, sanitized |
| `@clarvis/workflows` | `packages/workflows/src/log.ts:118-121` | `joinIds(ids)` | joins a bounded id list into one scalar field, so the record stays flat and filterable |
| `@clarvis/plan` | `packages/plan/src/log.ts:41-46` | `boundedPlanReason(error)` | normalizes, redacts and caps (500 chars) a plan read/parse failure before it may be logged |
| `@clarvis/plan` | `packages/plan/src/log.ts:23` | `MAX_PLAN_LOG_REASON_CHARS` | `500` |

### 2.5 `@clarvis/server`'s logging module

| Symbol | Location | Role |
|---|---|---|
| `ServerLoggers` | `packages/server/src/logging.ts:16-28` | `{log, audit, child(bindings)}` — the pair every collaborator threads |
| `createServerLoggers(log, audit)` | `packages/server/src/logging.ts:37-45` | pairs a diagnostic logger with an audit logger, `child` re-pairs both bound |
| `SILENT_SERVER_LOGGERS` | `packages/server/src/logging.ts:54` | the fallback pair, both `NOOP_LOGGER` |
| `ownerFields(owner, mode)` | `packages/server/src/logging.ts:68-73` | `{owner, owner_authenticated: mode === "token"}` |
| `RequestLogMode` | `packages/server/src/logging.ts:76` | `"off" \| "errors" \| "all"` |
| `logHttpRequest(logger, mode, fields)` | `packages/server/src/logging.ts:104-115` | writes `event: "http.request"` at `info`, gated by `mode` |
| `REQUEST_ID_HEADER` | `packages/server/src/logging.ts:118` | `"x-clarvis-request-id"` |
| `newRequestId()` / `newInstanceId()` | `packages/server/src/logging.ts:148-161` | both mint a 12-hex-digit id via `shortId()` (`:135-137`) |

### 2.6 Environment variables (all from `packages/capability/src/env.ts`)

| Variable | Line | Type / default | Effect |
|---|---|---|---|
| `CLARVIS_LOG_LEVEL` | `:137` | `z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL)` | the process-wide floor |
| `CLARVIS_LOG` | `:147` | `z.string().optional()` | per-component override, `component=level,...`, parsed by `parseLogScopes` |
| `CLARVIS_LOG_AUDIT` | `:157` | `boolFromEnv(true)` | whether the audit channel is built at all |

Both `CLARVIS_LOG` and `CLARVIS_LOG_AUDIT` are environment-only — declared only in this schema, never
a `settings.json` key or a run-request param — but only `CLARVIS_LOG_AUDIT`'s doc-comment states the
reason as silencing: "a run that could write this through settings could silence the record of what
it did" (`packages/capability/src/env.ts:189-196`). `CLARVIS_LOG`'s own comment
(`packages/capability/src/env.ts:179-187`) argues something different — that the component vocabulary
is deliberately open, "the way `TraceKind` is" — and never mentions silencing or unmasking.
`CLARVIS_LOG_LEVEL`'s comment (`:129-136`) is about neither: it explains why the level enum excludes
`trace`/`fatal`.

### 2.7 CLI flags observed wiring these variables

- `@clarvis/server`'s `bin.ts` maps a `--log-level` flag onto `CLARVIS_LOG_LEVEL`
  (`packages/server/src/bin.ts:126`) before constructing its loggers.
- `@clarvis/kernel`'s `serveFileKernelOverStdio` accepts `opts.logger` directly (no flag), and refuses
  to start when that logger shares a file descriptor with the stdio wire — see §6.

### 2.8 The zero-`logger?.` rule

The invariant is zero `logger?.` **call sites**, not zero `logger?:` declarations, and the distinction
decides how a logger reaches each shape:

- A **function parameter** takes `logger: Logger = NOOP_LOGGER`.
- An **options-bag interface property** cannot carry a default in TypeScript, so it stays
  `logger?: Logger` and is normalized once, at construction (`options.logger ?? NOOP_LOGGER`). Every
  site below that point calls it unconditionally — `@clarvis/server`'s `SILENT_SERVER_LOGGERS`
  (`packages/server/src/logging.ts:53`) is the pattern.
- A field on a hot internal config object may be made **required** and filled by its resolver.
  `@clarvis/tools` did that with `RuntimeConfig.logger` rather than pay ~30 optional-chained sites
  against a 0.98 function floor.

This is a cost decision rather than a style one: every `logger?.debug(...)` is an extra branch, and
`@clarvis/paths` and `@clarvis/capability` hold 1.00 functions / 1.00 lines
(`tooling/checks/coverage.ts`). One exception is on record: `@clarvis/loop` keeps
`deps.logger === undefined` meaning *undefined* rather than `NOOP_LOGGER`, because a silence contract is
pinned and several downstream presence checks read `!== undefined` — substituting a no-op would change
what those checks mean (`packages/loop/src/runtime/execute-run.ts:336-339`).

## 3. Data and formats

### 3.1 The event-name-as-field convention

Every structured record carries a dotted, lowercase `event` field that is the machine contract,
paired with a human sentence naming the *consequence* — never a message prefix. Concrete examples
observed directly in source:

```ts
// packages/kernel/src/file-kernel.ts:348-358
logger.info(
  {
    event: "kernel.boot.started",
    workspace_root: opts.workspaceRoot,
    global_dir: globalDir,
    ownership_mode: ownershipMode,
    memory_enabled: opts.memory === true,
    ...
  },
  "the file-backed kernel is starting; nothing serves a request until it reports ready",
);
```

```ts
// packages/kernel/src/guard/resolver.ts:124-138
audit.info(
  {
    event: "guard.decision",
    verdict: decision.verdict,
    matched: decision.matched,
    mode,
    tool: decision.tool,
    ...
  },
  "the command guard ruled on a tool call; an 'ask' still needs an answer before the call runs",
);
```

```ts
// packages/server/src/logging.ts:104-115
logger.info(
  { event: "http.request", ...fields },
  "an HTTP request was answered; the status is what the caller saw",
);
```

```ts
// packages/tools/src/config.ts (via tools.config_resolved, observed in
// packages/tools/tests/unit/observability.test.ts, "reports the flags that decide the advertised surface")
{
  event: "tools.config_resolved",
  ripgrep: true,
  sandbox_mode: "bubblewrap",
  sandbox_availability: "optional",
  read_only: true,
  confined: false,
  platform: process.platform,
}
```

Field names throughout are `snake_case` (`run_id`, `owner`, `command_digest`, `dur_ms`, `req_bytes`).
Scalar values (`string | number | boolean | null`) and `Error` are the dominant convention, not a
sink-enforced shape: the backend is plain `pino` with no `formatters` and no `serializers`
(`packages/loop/src/logger.ts:47-56`), so arrays and nested objects serialize verbatim. Most call
sites flatten bounded collections — `@clarvis/workflows`'s `joinIds` turns an id list into one
comma-joined scalar (`packages/workflows/src/log.ts:105-121`) — but the current vocabulary has
intentional array-valued exceptions. `tasks.provider.invalid_response.zod_issues` carries at most the
bounded, deduplicated **paths** that failed projection, never their values
(`packages/tasks/src/mcp-provider.ts:120-139`, `:313-325`; pinned at
`packages/tasks/tests/component/tasks-observability.test.ts:458-526`), and
`tools.monitor_spawn.stdio_slots` records the fixed three-slot disposition
(`packages/tools/src/tools/monitor.ts:273-283`). Consumers therefore must accept JSON field values;
they cannot assume every non-error field is scalar.

Only an `error`-level record carries a stack. `faultFields` attaches `stack` and `cause` when the thrown
value is an `Error` that has them (`packages/workflows/src/log.ts:74-82`), and the three fault sites in
`@clarvis/workflows` are the only places a workflow stack exists at all — the trace edge keeps the
message and drops everything above it.

### 3.2 The audit record shape

`createAuditLogger` stamps every record with exactly two bindings and pins the level:

```ts
// packages/kernel/src/component-loggers.ts:102-106
bindLevelled(root, { component: "audit", audit: true }, "info")
```

Pinned to `"info"` on purpose, over the same destination as the diagnostic logger, so
`CLARVIS_LOG_LEVEL=warn` cannot silence it (`packages/kernel/src/component-loggers.ts:88-92`).
Guard-specific audit records observed:

| `event` | Level | Fields (beyond `event`) | Source |
|---|---|---|---|
| `guard.resolved` | info | `mode, source, judge_configured, human_channel` | `packages/kernel/src/guard/resolver.ts:268-277` |
| `guard.decision` | info | `verdict, matched, mode, tool, reason?, escalate?, command_digest?` | `packages/kernel/src/guard/resolver.ts:124-138` |
| `guard.elicit.answered` | info | `answer: "allow"\|"allow_session"\|"deny", answerer: "human"\|"judge"\|"session_allowlist"` | `packages/kernel/src/guard/resolver.ts:148-162` |
| `guard.escalation.no_channel` | warn | `run_id` | `packages/kernel/src/guard/resolver.ts:201-207` |

Note the deliberate absence of the raw shell command from `guard.decision`: it carries
`command_digest` (16 hex characters, per test) rather than the text, and the pinned test asserts the
whole serialized record never contains the workspace path or the command
(`packages/kernel/tests/unit/guard-audit.test.ts:188-207`: `expect(JSON.stringify(decision)).not.toContain("/tmp/x")`).
Redaction mechanics themselves (`sanitizeErrorMessage`, `sanitizeToolPayload`, `sanitizeDeep`,
`packages/capability/src/sanitize.ts:169-221`) belong to the sibling
[cross-cutting/security.md](security.md) document; this document only records that the audit and diagnostic paths
both route through them.

### 3.3 `CLARVIS_LOG`'s wire format

A comma-separated list of `component=level` pairs, e.g. `"paths.lease=debug,mcp=debug,llm=warn"`
(`packages/capability/src/log.ts:96`, and `packages/kernel/src/component-loggers.ts:41`). Parsing
rules, all pinned by test (`packages/capability/tests/unit/log.test.ts:136-198`):

- Whitespace around either side of `=` is trimmed.
- An entry with no `=` is skipped (`"mcp,llm=debug"` yields one scope, not two).
- An entry naming no component (`"=debug"`) is skipped.
- An entry naming a level the port cannot emit at (`trace`, `fatal`) is skipped.
- A later entry for the same component wins over an earlier one.
- Matching is **longest-prefix on dot boundaries**: `mcp=debug` covers `mcp.connect.retry`;
  `mcp=debug,mcp.connect=error` resolves `mcp.connect.retry` to `error` and `mcp.pool` to `debug`;
  `mcpclient` does **not** match `mcp=debug` (no dot boundary).

### 3.4 Identifiers

- `newRequestId()` / `newInstanceId()`: 12 hex characters, from `crypto.randomUUID()` with hyphens
  stripped and truncated (`packages/server/src/logging.ts:128-130, 141-154`). Deliberately shorter
  than a full UUID and never caller-supplied — "an id a caller chooses is an id a caller can collide
  with" (`:136-140`).
- `command_digest` on a `guard.decision` record: 16 hex characters (test-asserted regex
  `/^[0-9a-f]{16}$/`, `packages/kernel/tests/unit/guard-audit.test.ts:206`); the digest algorithm
  itself is not read in this document (it lives behind `createShellGuard`, out of this document's scope).

### 3.5 What is never logged, at any level

An `Authorization` header, a bearer token, a `secret_hash`, a JWK, `auth.json` contents, resolved MCP
`env`/`headers` **values** (only the `${VAR}` names), a command's text (a digest instead), a memory
document body, a skill body, a plan document, a tool's arguments or result, or a model prompt/response.

`packages/capability/src/sanitize.ts` covers key-shaped strings and is the single owner of the rules;
it does **not** cover model-authored prose, so a leader brief, a work-item description and a task title
are logged as `*_chars` counts and never as text. The redaction mechanics are in
[security.md](security.md) §3.1 and §7.2.

## 4. Behavior

### 4.1 Building a host's logger (file-kernel path)

Order of operations in `createFileKernel` (`packages/kernel/src/file-kernel.ts:328-365`):

1. Resolve the environment snapshot (`baseEnvironment`, `env`).
2. Build (or accept) the root `Logger`: `opts.logger ?? createLogger(env.CLARVIS_LOG_LEVEL, {service: SERVICE})`
   (`:340`).
3. Build the per-component factory: `createComponentLoggers(logger, env.CLARVIS_LOG, componentFloor(logger, env.CLARVIS_LOG_LEVEL))`
   (`:341-345`).
4. Build the audit channel: `createAuditLogger(logger, env.CLARVIS_LOG_AUDIT)` (`:346`).
5. Emit `kernel.boot.started` on the root logger, at `info`, **before** anything else is constructed
   (`:348-358`) — "nothing serves a request until it reports ready".
6. Pass `componentLogger("worktrees")`, `componentLogger("guard")` etc. to each collaborator as it is
   built (`:388, 768`), and pass `auditLogger` into `createGuardResolver({..., audit: auditLogger})`
   (`:765`).

`@clarvis/server`'s `bin.ts` follows the identical shape at the process level
(`packages/server/src/bin.ts:130-140`): build `root` via `createLogger`, bind an `instance_id`, derive
`components` and pick `components("server")`, derive `audit` via `createAuditLogger`, and pair both
into one `ServerLoggers` via `createServerLoggers`.

Four correlation scopes exist, and each is bound by the layer that owns it: **service**
(`{service, instance_id}`, bound by the factory), **component** (`{component}`, bound where the kernel
constructs each collaborator), **owner** (`{owner}`, bound in scope policy so every owner service
inherits it) and **run** (`{execution_id, owner_key_name, mode}`, bound in `executeRun` where the
execution id is minted — `packages/loop/src/runtime/execute-run.ts:337-340`). Hand a lower layer the
root logger rather than an already-bound child: one binding per scope, applied by the layer that owns
that scope, or the record carries `component` twice. `@clarvis/mcp-client`'s pool outlives every run,
so a pooled connection must never bind a run id; its join key is the connection.

### 4.2 Resolving one component's logger — `createComponentLoggers`

`packages/kernel/src/component-loggers.ts:64-79`:

| Input state | Result |
|---|---|
| `root === undefined` | returns `() => NOOP_LOGGER` for every component |
| `activeLevelOf(root) === "silent"` | returns `() => NOOP_LOGGER` for every component — **before** consulting `CLARVIS_LOG` at all |
| otherwise | parses `spec` once via `parseLogScopes`, then per component: memoized lookup in a `Map`; on miss, calls `componentLogger(root, component, levelFor(scopes, component, fallback))` and caches the result |

The `"silent"` short-circuit is the load-bearing branch: `componentFloor` only guards the *fallback*
level, while `levelFor` lets any `CLARVIS_LOG` scope override that fallback — so without the explicit
`activeLevelOf(root) === "silent"` check, an operator's own `CLARVIS_LOG=worktrees=debug` would win
over a host's deliberate silencing and "wrote raw JSON over the rendered canvas, mid-string, including
across the plan-approval gate" (`packages/kernel/src/component-loggers.ts:54-62`).

### 4.3 Building the audit channel — `createAuditLogger`

`packages/kernel/src/component-loggers.ts:102-106`:

| Input state | Result |
|---|---|
| `root === undefined` | `NOOP_LOGGER` |
| `enabled === false` (i.e. `CLARVIS_LOG_AUDIT=false`) | `NOOP_LOGGER` |
| `activeLevelOf(root) === "silent"` | `NOOP_LOGGER` — the one level audit does **not** override |
| otherwise | `bindLevelled(root, {component:"audit", audit:true}, "info")` |

The `"silent"` exception is deliberate and mirrors §4.2's reasoning: "`silent` is not a verbosity
preference — it is a host saying it has no channel" (`:94-100`); pinning audit at `"info"` against a
silenced `@clarvis/code` root would again paint raw JSON over the terminal frame "on every guarded
tool call."

### 4.4 Guard resolution and the audit trail — `createGuardResolver`

`packages/kernel/src/guard/resolver.ts:225-305` (abbreviated):

1. Read live `GuardSettings`; compute `guardMode = resolveGuardMode(request.guard_mode, settings.guard)`.
2. Derive a run-bound audit child: `auditRoot.child?.({run_id, owner}) ?? auditRoot` (`:231`).
3. Build the shell guard with `recordDecision(audit, mode, decision)` as its `onDecision` callback
   (`:232-234`) — every ruling the guard makes writes `guard.decision`.
4. Choose the elicit channel: human for `mode==="on"`, judge-then-human-fallback for `mode==="auto"`,
   none for `mode==="off"` (`:260-265`).
5. Emit one `guard.resolved` record per run (`:268-277`), naming whether the mode came from the
   request or from settings, whether a judge is configured, and whether a human channel exists.
6. On an escalated `ask` with no human channel, `noHumanChannel` denies and warns
   (`:201-207`, `guard.escalation.no_channel`) — "the one denial a user can neither see nor answer."
7. Every answered `ask` calls `answered()` (`:176-188`), which reads the session allowlist **before**
   and **after** the answer to distinguish a fresh `allow` from an `allow_session`, then calls
   `recordAnswer` (`:148-162`, `guard.elicit.answered`).

### 4.5 Refusing a logger bound to the kernel's own wire — `serveFileKernelOverStdio`

`packages/kernel/src/serve.ts:102-118`:

1. `refuseLoggerOnWire(opts)` runs **before** `createFileKernel` is even called (`:103`).
2. `loggerDescriptor(opts.logger)` walks the logger's own prototype chain (not just its own symbols,
   because a pino **child** is `Object.create(parent)` and the stream lives on the ancestor) looking
   for a symbol whose `.toString()` is `"Symbol(pino.stream)"` (`:20-55`).
3. If a descriptor is found and it equals the wire's own output descriptor (`opts.output`'s `fd`, or
   `1` when `opts.output` is unset), the function throws before any resource is constructed
   (`:76-89`).
4. Only then does `serveFileKernelOverStdio` build the kernel and start the NDJSON pump
   (`:103-105`).

### 4.6 Per-hot-path guard pattern — `levelEnabled`

Observed concretely in `reportIterationCache` (`packages/loop/src/runtime/loop/iteration-metrics.ts:232-234`):

```ts
function reportIterationCache(logger: Logger, args: IterationMetricsArgs, ratio: number): void {
  const lost = args.cacheWatch?.observe(args.llmResult.usage.cached_tokens) === true;
  if (!lost && !levelEnabled(logger, "debug")) return;
  const fields = { event: "iteration.cache", ... };
  ...
}
```

The doc-comment states the reason directly: "the `debug` case is guarded by `levelEnabled` rather than
left to the backend: the object is allocated at the call site, before any backend sees the level, and
this runs on every iteration of every agent" (`:208-211`).

## 5. Invariants

**INV-035** (owned). No production module in `@clarvis/tools`'s `src/` writes to `process.stderr`,
`process.stdout`, or any `console.*` method, except the single sanctioned module `lib/log.ts`.
- Production: `packages/tools/src/lib/log.ts` is the sanctioned writer (holds the sole
  `process.stderr.write` at `:72`).
- Test: `packages/tools/tests/architecture/logging-channel.test.ts:48-58` — scans every `.ts` file
  under `src/`, excluding `lib/log.ts`, against three regexes (`process.stderr`, `process.stdout`,
  `console.*`) and asserts zero offenders for each.
- The same test also asserts the scan actually covers something (`files.length > 40`,
  `packages/tools/tests/architecture/logging-channel.test.ts:44-46`), which rules out a silently-empty scan passing vacuously.

**INV-036** (owned). Inside that one sanctioned module, `process.stderr` is written exactly once (the
default `WarnSink`), and neither `console.*` nor `process.stdout` appears at all.
- Production: `packages/tools/src/lib/log.ts:75-77` (`defaultSink`).
- Test: `packages/tools/tests/architecture/logging-channel.test.ts:60-65` — strips block comments from
  the file's source, then asserts `code.match(/process\s*\.\s*stderr/g)` has length exactly 1 and
  that neither of the other two patterns matches at all.

**INV-OBS-1** (derived). A component logger is never granted a level a `silent`-reporting root did
not: `createComponentLoggers` and `createAuditLogger` both short-circuit to `NOOP_LOGGER` the instant
`activeLevelOf(root) === "silent"`, regardless of any `CLARVIS_LOG` scope that would otherwise apply.
- Production: `packages/kernel/src/component-loggers.ts:69` (component factory),
  `packages/kernel/src/component-loggers.ts:104` (audit).
- Test: `packages/kernel/tests/unit/component-loggers.test.ts:94-115` ("a silent root" — "is not
  overridden by a CLARVIS_LOG scope"); `packages/kernel/tests/unit/guard-audit.test.ts:351-354`
  ("is silent when the host's own logger is silent").

**INV-OBS-2** (derived). `CLARVIS_LOG_AUDIT` and `CLARVIS_LOG` cannot be set through `settings.json`
or a run request — both are declared only in the environment schema
(`packages/capability/src/env.ts:170-196`), not in any settings/request schema this document's scope
reaches. ~~Unpinned by a positive test in this document's scope (no test asserts a `settings.json` write
to either key is *rejected*); the schema's absence of the field is the only evidence.~~ **Pinned
2026-08-22** on both halves: `packages/kernel/tests/integration/capability-settings-schema.test.ts`
rejects the keys as top-level settings blocks and asserts no registered capability has contributed
one, and `packages/loop/tests/unit/request-parsing.test.ts` rejects them on a run request. The second
also states the *bound*: the engine refuses them because it declares none of them, so a capability
declaring `log_level` as a request param would be admitted — which is why the registry check on the
kernel side is the other half of the guarantee, not a duplicate of it.

**INV-OBS-3** (derived). A logger writing to the same file descriptor as `serveFileKernelOverStdio`'s
own NDJSON wire is refused before any kernel resource is constructed.
- Production: `packages/kernel/src/serve.ts:76-118` (`refuseLoggerOnWire`, called at `:103` before
  `createFileKernel`).
- Test: `packages/kernel/tests/integration/serve.test.ts:34-123` — seven cases: a direct
  `destination:1` logger is rejected (`:35-44`); a `.child()` of one is still rejected, walking the
  prototype chain (`:45-58`); a grandchild is still rejected (`:59-68`); a `destination:2` (`silent`
  level) logger and its child are accepted (`:69-79`); a logger sharing an *explicit* `opts.output`'s
  descriptor is rejected — the explicit output in this test is given `fd: 1`, the same descriptor as
  the default wire, not a descriptor that is not `1` (`:80-91`); a `silent`-level, `destination:1`
  logger paired with a custom output stream exposing no `fd` is **accepted**, because the wire's own
  descriptor comparison has nothing to compare against and degrades to a no-op rather than a refusal
  — this is the one acceptance case among the seven, not a rejection (`:92-111`); a logger exposing no
  descriptor at all against the default stdio wire is likewise accepted, degrading rather than
  refusing (`:112-123`).

**INV-OBS-4** (derived). `Logger.debug/info/warn/error` never silently fails to accept its arguments:
`NOOP_LOGGER`'s four methods all discard without throwing.
- Production: `packages/capability/src/log.ts:48-55`.
- Test: `packages/capability/tests/unit/log.test.ts:63-71`.

**INV-OBS-5** (derived). `bind`/`componentLogger`/`bindLevelled` all degrade to returning the input
logger unchanged, rather than throwing, when the backend implements no `child`.
- Production: `packages/capability/src/log.ts:88-90` (`bind`), `:220-223` (`bindLevelled`).
- Test: `packages/capability/tests/unit/log.test.ts:130-133` (`bind`), `:331-334` (`bindLevelled`),
  `:350-353` (`componentLogger`, "degrades to the logger itself rather than refusing to log").

**INV-OBS-6** (derived). `createSampler`'s admission policy is exactly: every occurrence 1 through 8,
then every power of two thereafter, and this is per-instance (two samplers never share a count).
- Production: `packages/capability/src/log.ts:250-260`.
- Test: `packages/capability/tests/unit/log.test.ts:200-236` — asserts the admitted sequence for 40
  calls is exactly `[1,2,3,4,5,6,7,8,16,32]`, and that two independent `createSampler()` instances do
  not share state.

**INV-OBS-7** (derived). No log call anywhere in this document's scope carries a value that is not a
scalar, `Error`, or (for `guard.decision`'s optional fields) `undefined`-omitted; specifically no raw
shell command ever reaches an audit record.
- Production: `packages/kernel/src/guard/resolver.ts:124-138` (`command_digest`, never `command`).
- Test: `packages/kernel/tests/unit/guard-audit.test.ts:188-207` —
  `expect(JSON.stringify(decision)).not.toContain("/tmp/x")` where `/tmp/x` was the path embedded in
  the denied command.

**INV-OBS-8** (derived). Both `createSampler` and `createRateLimiter` bound their key-tracking `Map`
by the same mechanism: `evictOldest` (`packages/capability/src/log.ts:230-235`), gated by
`DEFAULT_MAX_KEYS = 1_024` (`:229`). Once a sampler or limiter is tracking `maxKeys` distinct keys,
the oldest-inserted key (by `Map` iteration order) is evicted before a new one is recorded. Both
functions also re-insert the current key at the end of the map on every hit — `createSampler` via
`counts.delete(key); counts.set(key, next)` (`:255-256`), `createRateLimiter` via
`emitted.delete(key); emitted.set(key, now)` (`:294-295`) — which is what keeps the map ordered as an
LRU-by-insertion-order structure rather than merely a size-capped one.
- Production: `packages/capability/src/log.ts:229-235, 255-256, 294-295`.
- Test: `packages/capability/tests/unit/log.test.ts:223-230` (`createSampler`, "evicts the oldest key
  past its ceiling rather than growing" — with `maxKeys: 2`, evicting `"a"` after `"b"` and `"c"`
  arrive still leaves `"a"` readmitted as if new) and `:263-273` (`createRateLimiter`, the same shape
  with `maxKeys: 2`).

## 6. Failure modes and degradation

| Situation | What happens | Cited at |
|---|---|---|
| Host supplies no `Logger` at all | Every derivation degrades to `NOOP_LOGGER`; nothing throws | `packages/capability/src/log.ts:48-55`, `packages/kernel/src/component-loggers.ts:69` (`root === undefined`) |
| Host's logger reports `level: "silent"` | Component and audit factories both short-circuit to `NOOP_LOGGER`, ignoring any `CLARVIS_LOG` scope that would otherwise apply | `packages/kernel/src/component-loggers.ts:54-62, 94-100` |
| `CLARVIS_LOG` names an unrecognized level (e.g. `trace`, `fatal`) for a component | That single entry is skipped by `parseLogScopes`; the component falls back to the configured floor — a silent no-op, not an error | `packages/capability/src/log.ts:104-116`; test `packages/capability/tests/unit/log.test.ts:157-159` |
| `CLARVIS_LOG` names a component that does not exist | Silent no-op — the vocabulary is deliberately open, "like `TraceKind`" | `packages/capability/src/log.ts:99-102` |
| Backend implements no `child` | `bind`/`componentLogger`/`bindLevelled` all return the original logger unchanged rather than throwing or silently dropping bindings | `packages/capability/src/log.ts:88-90, 220-223` |
| Logger's `level` is present but unrecognized by this port | `levelEnabled` and `activeLevelOf` both treat this as "emitting" (`levelEnabled` returns `true`; `activeLevelOf` returns `undefined`) — "a diagnostic lost to an unparsable level is worse than one written needlessly" | `packages/capability/src/log.ts:68-76, 131-134` |
| `serveFileKernelOverStdio` is given a logger bound to the wire's own descriptor | Throws synchronously before constructing the kernel — the only point this can be caught, since "once the pump starts, the corruption looks like a peer that sends malformed JSON" | `packages/kernel/src/serve.ts:76-89, 103` |
| A `@clarvis/tools` `.gitignore`-loader or `serializeError` site has no `RuntimeConfig` in scope | Falls back to the process-wide `WarnSink`, defaulting to raw `process.stderr.write` unless a host has called `setWarnSink` | `packages/tools/src/lib/log.ts:75-114` |
| Two hosts in one process both call `setWarnSink` | Last writer wins; the earlier host's warnings are silently attributed to the wrong (or no) destination — an acknowledged, un-mitigated hazard | `packages/tools/src/lib/log.ts:99-105` ("wrong the day a second kernel shares the process") |
| A file/directory handle fails to close in `@clarvis/skills` | Logged at `debug` (not surfaced as an error, not thrown) — "the failure is genuinely not actionable by the caller" | `packages/skills/src/lib/log.ts:72-86` |
| A plan file's read/parse error would otherwise be logged verbatim | Routed through `boundedPlanReason`: whitespace-collapsed, sanitized, then capped at 500 chars — because the `yaml` package's own errors "quote the offending source lines" | `packages/plan/src/log.ts:1-46` |
| A scheduled compaction summarizer throws or returns an oversized summary | Recorded as a **log** (`compaction.summarizer_failed`, `warn`), never as a trace entry, because "the actor is the host's summarizer, not the agent, and omitting it does not make the persisted record a false account of the conversation" | `packages/loop/src/runtime/context/llm-compaction.ts:363-388` |
| An escalated guard `ask` has no human channel configured | Denied, and the denial itself is loud: `guard.escalation.no_channel` at `warn`, because this is "the one denial a user can neither see nor answer" | `packages/kernel/src/guard/resolver.ts:201-207` |
| No audit logger is supplied to `createGuardResolver` at all | Guard resolution still functions (falls back to `NOOP_LOGGER` internally via `deps.audit ?? NOOP_LOGGER`); nothing is recorded, and the call still resolves and permits normally | `packages/kernel/src/guard/resolver.ts:227`; test `packages/kernel/tests/unit/guard-audit.test.ts:318-326` |

## 7. Coupling

- **`@clarvis/capability` is the sole owner of `Logger`/`LogFn`/`LOG_LEVELS` and everything derived
  from them.** Every other package in this document's scope imports the type from there rather than
  redeclaring it: `packages/loop/src/logger.ts:2`, `packages/kernel/src/component-loggers.ts:1-10`,
  `packages/skills/src/lib/log.ts:1`, `packages/workflows/src/log.ts:17`,
  `packages/server/src/logging.ts:1`. This is a static, compile-time import edge in every case.
- **`componentLogger`/`bindLevelled` live in `@clarvis/capability` because two layers need them and
  neither can import the other**: "`@clarvis/kernel` derives a component logger for each collaborator
  it constructs, and `@clarvis/loop` does the same for the three subsystems it wires directly"
  (`packages/capability/src/log.ts:184-186`). Before this was shared, `@clarvis/loop` reached for
  `bind`, which carries the binding but not the level — so `component` was stamped on `paths` and
  `trace` records while `CLARVIS_LOG=paths=debug` silently did nothing to them
  (`packages/capability/src/log.ts:187-190`). The implementation needs a **double** type assertion,
  `logger as unknown as LevelledLogger` (`packages/capability/src/log.ts:223`), against a private
  `LevelledLogger` interface (`:171-173`) declaring pino's two-argument `child(bindings, {level})`
  form: "TypeScript checks method parameters bivariantly, so it considers the port's one-parameter
  `child` already assignable to `LevelledLogger` and collapses a single assertion to a no-op — while
  still rejecting the two-argument call" (`:192-195`).
- **`@clarvis/loop` is the sole owner of the pino backend**, and this is enforced by the package's own
  dependency boundary rather than by an observability-specific test: `pino` appears only in
  `packages/loop/src/logger.ts:1` within this document's scope, and every other consumer receives an
  already-built `Logger` value rather than constructing one.
- **`@clarvis/kernel`'s `component-loggers.ts` depends only on `@clarvis/capability`**
  (`packages/kernel/src/component-loggers.ts:1-10`) — it does not import pino or `@clarvis/loop`
  directly, so it composes over whatever `Logger` a host (kernel's own `createFileKernel`, or
  `@clarvis/server`'s `bin.ts`) hands it.
- **`@clarvis/server` reaches `createAuditLogger`/`createComponentLoggers` by importing them from
  `@clarvis/kernel`** (`packages/server/src/bin.ts:11`), not by re-implementing them — a single owner
  for the silence/audit-pinning logic that both hosts need identically.
- **`@clarvis/tools`, `@clarvis/skills` (and, outside this document's direct scope,
  `@clarvis/paths` and `@clarvis/hooks`) each declare their own minimal structural logger port**
  (`ToolsLogger`, `SkillDiagnostics.logger`, `PathsLogger`, and `HookLogger` at
  `packages/hooks/src/types.ts:164`) rather than depending on
  `@clarvis/capability`. `packages/tools/src/lib/log.ts:16-20` states the reason directly: "this
  package's only internal dependency is `@clarvis/paths`, and it stays that way. The capability port
  satisfies this shape, so a host passes its own logger straight in." This is a *type-only* coupling:
  `@clarvis/capability`'s `Logger` is never imported by `@clarvis/tools`, but is structurally
  assignable to `ToolsLogger` at every call site a host wires. That assignability **is** pinned, by
  `packages/loop/tests/architecture/logger-drift.test.ts` — `@clarvis/loop` is the lowest package
  that depends on both, and its tools capability really does hand a contract `Logger` to
  `createAgentTools`. The same file covers `@clarvis/hooks`' `HookLogger`. (The comment at
  `packages/tools/src/lib/log.ts:21` previously named that test inside `@clarvis/tools`, where it
  could not exist without the dependency edge the port is there to avoid.)
- **`@clarvis/workflows` and `@clarvis/plan` both depend on `@clarvis/capability` directly** (both
  already do, for other reasons), but they draw different amounts from it. `@clarvis/workflows`'s
  `log.ts` imports `Logger`/`NOOP_LOGGER`/`bind`/`sanitizeErrorMessage`
  (`packages/workflows/src/log.ts:17`) and consumes the `Logger` port by structural typing through
  `ctx.deps.logger`. `@clarvis/plan`'s `log.ts` imports only `sanitizeErrorMessage`
  (`packages/plan/src/log.ts:13`) — it never names `Logger`, `NOOP_LOGGER` or `bind`, and declares no
  logging port at all; its one export, `boundedPlanReason`, only produces the string a caller's own
  logger later records.
- **The terminal UI (`@clarvis/code`) is the downstream consumer that makes the whole discipline
  matter operationally.** `packages/code/src/adapters/terminal-guard.ts:29-55` documents that the
  *one* path that ever did reach the terminal directly was "a component logger pinned above a
  silenced root," and states it was "fixed at its source in `@clarvis/kernel`'s
  `createComponentLoggers`" — i.e., the `"silent"` short-circuit this document describes in §4.2/§4.3 is a
  fix for a defect this downstream package observed. The remainder of `terminal-guard.ts` (patching
  `console.*` and `process.stdout/stderr.write` as a second line of defense against dependencies this
  package does not control) belongs to the sibling [hosts/code-onboarding.md](../hosts/code-onboarding.md) document and is
  not re-described here.
- **`@clarvis/kernel/src/serve.ts` depends on no pino import**, deliberately: it identifies a pino
  stream by the *string value* of a well-known symbol description (`"Symbol(pino.stream)"`,
  `packages/kernel/src/serve.ts:22-30`) rather than importing pino's types, "so `@clarvis/kernel` does
  not depend on pino and should not start."
- **`levelEnabled` is consumed widely across the engine** (at least
  `packages/loop/src/runtime/loop/{iteration-metrics,run-agent}.ts`,
  `packages/loop/src/runtime/orchestrator.ts` (one directory up from the two above, not inside
  `runtime/loop/`),
  `packages/mcp-client/src/{connection-manager,resilient-session,connection}.ts`,
  `packages/skills/src/{registry,scan}.ts`, `packages/memory/src/{workspace-state,reindex,file-store/lock}.ts`,
  `packages/workflows/src/{dispatch,run-leader,run-round,schedule-log}.ts`,
  `packages/trace/src/json-trace-store.ts`) —
  confirmed by a repository-wide grep, though only
  `packages/loop/src/runtime/loop/iteration-metrics.ts:232-234` is in scope for this document.

## 8. Open questions

- ~~**No architecture test in this document's scope enforces the "one diagnostic channel" rule outside
  `@clarvis/tools`.**~~ **Resolved 2026-08-22.**
  `packages/paths/tests/architecture/one-diagnostic-channel.test.ts` scans every package's `src`, from
  the dependency-free leaf that already owns the monorepo-wide vocabulary scan. Its exemptions are
  **categorised** rather than listed flat — a CLI entrypoint, a package's single sanctioned sink,
  stream plumbing that names a stream without writing diagnostics, and `@clarvis/code`, which owns the
  terminal outright — so adding a file means claiming one of those, and a companion test fails when a
  named exemption stops needing to be one. The survey behind it also corrected the reading above:
  `@clarvis/workflows` and `@clarvis/plan` hold **none**; `@clarvis/skills`' single write *is* its own
  sanctioned sink, the same shape as `@clarvis/tools`'; and `@clarvis/server`'s are in `bin.ts`, which
  the standard already carves out for an operator at a shell. The rule was held everywhere — only one
  package proved it.
- ~~**INV-OBS-2** (settings/request cannot set `CLARVIS_LOG`/`CLARVIS_LOG_AUDIT`) is argued from the
  *absence* of the field from the environment-only schema location, not from a positive test that
  attempts and rejects such a write. No such rejection test was found in this document's scope.~~
  **Resolved 2026-08-22** — see INV-OBS-2 above for where, and for the one thing the tests had to be
  careful not to overstate.
- **The exact digest algorithm behind `command_digest`** (16 hex chars on a `guard.decision` record) is
  implemented in `createShellGuard`, which is outside this document's primary scope (guard/command
  policy belongs to a different document); this document only records the field's presence, shape and the
  test that pins the raw command's absence.
- **Whether any capability outside this document's scope writes an `event` name that collides with
  another package's** is not checked by anything this document found; the vocabulary is stated to be
  deliberately open (`packages/capability/src/log.ts:99-102`), so a collision would not be caught
  mechanically.
- **`@clarvis/paths`'s `diag.ts` and `@clarvis/hooks`'s `HookLogger`** are cited in §7 only for the
  repeated structural-port pattern; their own construction, `setPathsLogger` semantics, and
  process-wide-slot hazards belong to those packages' own documents and are not described in full here.
- **Whether `createSampler`/`createRateLimiter` are used correctly (i.e., keyed with enough
  distinguishing identity) at every call site listed in §7** was not verified beyond the two call
  sites actually read (`packages/mcp-client/src/connection-manager.ts:299`,
  `packages/workflows/src/dispatch.ts:230,574`). The doc-comment's own warning — "a key of `operation`
  alone collapses two different servers failing the same way into one line naming neither"
  (`packages/capability/src/log.ts:279-282`) — is a design intent, not a verified property of every
  caller.
