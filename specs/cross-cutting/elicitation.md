# Asking a human: ask_user, guard prompts, MCP elicitation and the mux

> Implemented at `packages/...`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

This subsystem is how a Clarvis run stops and asks a live human a question, and how the answer gets
back to the model or to whatever engine mechanism asked. One port — `Elicit`
(`packages/capability/src/elicit.ts`) — carries every such question: the model's own `ask_user`
tool call, a guard's command-confirmation prompt, a soft-budget escalation ask, and a question an
*external* MCP server raises through Clarvis acting as its MCP client. All of them funnel through the
same per-run FIFO serializer (`packages/loop/src/runtime/elicit-relay.ts`) so at most one prompt is
ever live for a given run at a time, and — one level up — a workflow's concurrently running leaders
share a second, tree-wide FIFO (`packages/workflows/src/elicit-mux.ts`) so at most one prompt is
ever live for the whole workflow tree.

The engine itself does not know what a terminal, a remote MCP client, or a headless server caller is:
it hands `ElicitParams` to whatever `Elicit` callback the host supplied and awaits an
`ElicitRawResult`. The **kernel** is the first layer that turns this into something addressable by id
(`packages/kernel/src/runs/elicit-bridge.ts`), and each of `code` (a terminal) and `server` (an
MCP-over-HTTP facade) then bridges that bridge to its own surface — a modal block in the TUI, or one
of three "postures" (`relay`/`tool`/`auto_decline`) in the server
(`packages/server/src/mcp/elicitation.ts`). A run that has no human attached at all (the server's
default posture, or a headless `code --prompt` invocation) still gets an answer for every question —
just always the same one, `decline` or `cancel` — so the engine's control flow never has to special-case
"nobody is listening."

## 2. Surface

### 2.1 The elicitation port (`@clarvis/capability`)

| Symbol | Kind | Location | Shape |
| --- | --- | --- | --- |
| `ElicitationAction` | type | `packages/capability/src/elicit.ts` | `"accept" \| "decline" \| "cancel"` |
| `ElicitationOutcome` | interface | `packages/capability/src/elicit.ts` | `{ action, answer?, noResponse? }` |
| `ElicitRequestedSchema` | interface | `packages/capability/src/elicit.ts` | `{ type: "object", properties: Record<string,{type:"string",enum?,description?}>, required: string[] }` |
| `ElicitParams` | interface | `packages/capability/src/elicit.ts` | `{ message, requestedSchema, kind?: "ask_user"\|"guard_confirm"\|"plan_review"\|"workflow_review"\|(string&{}) }` |
| `ElicitRawResult` | interface | `packages/capability/src/elicit.ts` | `{ action, content?: Record<string,unknown> }` |
| `Elicit` | type | `packages/capability/src/elicit.ts` | `(params, {signal?, timeoutMs?}) => Promise<ElicitRawResult>` |
| `ElicitTimeoutError` | class | `packages/capability/src/elicit.ts` | thrown when the wait bound elapses |
| `elicitWithClockPause` | function | `packages/capability/src/elicit.ts` | runs an `Elicit` call with the compute clock paused; swallows `ElicitTimeoutError` into `onNoResponse` |

### 2.2 The `ask_user` tool (`@clarvis/loop`)

| Item | Value |
| --- | --- |
| Wire name | `ASK_USER_TOOL_NAME` = `"ask_user"` (`packages/loop/src/runtime/tools/wire-names.ts`, re-exported `packages/loop/src/runtime/tools/ask-user-tool.ts`) |
| Descriptor | `askUserTool: NamespacedTool` (`packages/loop/src/runtime/tools/ask-user-tool.ts`) |
| Input schema | `{ question: string (minLength 1, required), options?: string[] }` |
| Capability name | `ASK_USER_CAPABILITY_NAME` = `"ask-user"` (`packages/loop/src/runtime/capabilities/ask-user.ts`) |
| Grant that gates it | run request's entry profile must include `"ask_user"` (`packages/loop/src/runtime/capabilities/ask-user.ts`) |
| Activation | only the run's **entry agent** (`scope.entry`); a spawned sub-agent never gets it |
| Advertisement | `advertised: false` — prompt-driven, not registry-listed (`packages/loop/src/runtime/capabilities/ask-user.ts`) |
| Reservation | `ASK_USER_TOOL_NAME` is one of `BUILTIN_WIRE_NAMES` (`packages/loop/src/runtime/tools/wire-names.ts`), which spreads into `RESERVED_WIRE_NAMES`; `buildRegistry` seeds that set into the registry's `used` names, so no MCP server tool can take it (`packages/loop/src/runtime/tools/mcp-registry.ts`) |
| Bypass entrypoint | `askUserAgentCapability(askUser)` (`packages/loop/src/runtime/capabilities/ask-user.ts`) — the per-agent attachment alone, for a caller that already holds an `AskUser`; contributes the tool/handler without the run-level grant/entry gate `createAskUserCapability` enforces. Used directly by `packages/loop/tests/unit/run-agent.test.ts` and `packages/loop/tests/unit/ask-user-call.test.ts` to attach the tool for testing without those checks |

### 2.3 Guard elicitation (`@clarvis/kernel`)

| Symbol | Location | Shape |
| --- | --- | --- |
| `GuardElicitParams` | `packages/kernel/src/guard/guard-elicit.ts` | `ElicitParams & { detail?: ElicitationCommandDetail }` |
| `createGuardElicit` | `packages/kernel/src/guard/guard-elicit.ts` | adapts an `Elicit` into a boolean `GuardElicit` (`req => Promise<boolean>`) |
| `createGuardSessionAllowlist` | `packages/kernel/src/guard/guard-elicit.ts` | in-memory, session-lifetime `GuardSessionAllowlist` |
| Requested schema | `decision: enum["deny","allow"]` or, when a session allowlist and a decidable non-empty command are both present, `enum["deny","allow","allow_session"]` |
| `kind` sent | `"guard_confirm"` |
| Wait bound | `ELICIT_NO_TIMEOUT_MS` = `2_147_483_647` ms — effectively unbounded unless the signal aborts |

The lower-level guard callback is wider than this human adapter. `@clarvis/tools`' `Elicit` may
return a boolean or `GuardElicitAnswer = { allowed, answerer }`, where `answerer` is
`"human" | "judge" | "session_allowlist" | "unavailable"`
(`packages/tools/src/guard/types.ts`). `createGuardElicit` itself still returns a
boolean; the kernel resolver enriches human answers and preserves judge/session attribution before
returning its run-bound guard callback (`packages/kernel/src/guard/resolver.ts`). The
full selection policy remains the concern of **command-guard-and-approval**.

The guard's own policy for *when* to prompt (escalation chain, per-tool rules) is out of scope here —
see **command-guard-and-approval**. This document covers only how the guard's yes/no question rides the
`Elicit` port.

### 2.4 The kernel elicit bridge

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitBridge` | `packages/kernel/src/runs/elicit-bridge.ts` | engine `elicit`, `onElicit(handler)` and `respond(res)` |
| `createElicitBridge(executionId)` | `packages/kernel/src/runs/elicit-bridge.ts` | one bridge per run, ids namespaced `<executionId>:elicit:<n>` |

### 2.5 Protocol wire shapes (`@clarvis/protocol`)

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitationCommandDetail` | `ElicitationCommandDetail` in `packages/protocol/src/runs.ts` | `{ command, cwd, reason, warning? }` |
| `ElicitationRequest` | `ElicitationRequest` in `packages/protocol/src/runs.ts` | `{ id, execution_id, kind, prompt, schema?, detail? }` |
| `ElicitationResponse` | `ElicitationResponse` in `packages/protocol/src/runs.ts` | `{ id, action: "accept"\|"decline"\|"cancel", content? }` |
| `RunHandle.respond(response)` | `RunHandle.respond` in `packages/protocol/src/runs.ts` | answers a pending elicitation |
| `RunHandle.onElicit(handler)` | `RunHandle.onElicit` in `packages/protocol/src/runs.ts` | registers a handler for engine-raised questions |
| `RunEvent` variant `elicitation_requested` | mapped at `packages/kernel/src/runs/map-events.ts` | `{ type, at, agent?, subagent_id?, question, options? }` |
| `RunEvent` variant `elicitation_resolved` | mapped at `packages/kernel/src/runs/map-events.ts` | `{ type, at, agent, subagent_id?, question, outcome, answer?, options? }` |

Wire framing of these notifications over JSON-RPC (`N.runElicitation`, `M.runsRespond`, etc.) is the
concern of **kernel-transport-and-wire**; this document stops at the DTO shapes themselves.

### 2.6 `@clarvis/server` MCP surface

| Item | Location | Shape |
| --- | --- | --- |
| `clarvis_run` input fields (elicitation-relevant) | `packages/server/src/mcp/tools.ts` | `elicitations: enum["auto_decline","await"].default("auto_decline")`, `elicitation_wait_ms?: number.int().min(1000).max(600000)` |
| `clarvis_run` output field | `packages/server/src/mcp/tools.ts` | `posture: { elicitation, guard_confirmations, plans_effective?, downgrades: string[], auto_answered: number }` |
| `clarvis_respond` input | `packages/server/src/mcp/tools.ts` | `{ execution_id, id, action, content? }` |
| `clarvis_respond` description | `packages/server/src/mcp/tools.ts` | `"Only meaningful when the run was started with elicitations: \"await\"; otherwise questions are declined automatically."` |
| `ElicitationPosture` | `packages/server/src/mcp/elicitation.ts` | `"relay" \| "tool" \| "auto_decline"` |
| `AppliedPosture` | `packages/server/src/mcp/elicitation.ts` | `{ elicitation, guard_confirmations, plans_effective?, prompt_cache_ttl?, downgrades: string[], auto_answered: number }` |
| `resolvePosture(input)` | `packages/server/src/mcp/elicitation.ts` | decides the posture before the run starts |
| `createElicitationController(opts)` | `packages/server/src/mcp/elicitation.ts` | owns one run's `onElicit` handler + pending map |
| MCP wire request the server sends its own client | `packages/server/src/mcp/server.ts` | `{ method: "elicitation/create", params: request }` via `extra.sendRequest`, answer validated against `z.object({ action: enum, content?: record })` |
| Env defaults | `packages/server/src/config/env.ts` | `CLARVIS_SERVER_ELICIT_TOOL_WAIT_MS` = 120,000; `CLARVIS_SERVER_ELICIT_RELAY_MS` = 600,000; `CLARVIS_SERVER_ELICIT_BACKSTOP_MS` = 60,000 |
| Backstop wiring | `packages/server/src/bin.ts` | `CLARVIS_DEFAULT_ELICIT_WAIT_MS := CLARVIS_SERVER_ELICIT_BACKSTOP_MS` (60s), overriding the engine's own 30-minute default for every server-hosted run |

### 2.7 `@clarvis/mcp-client` — Clarvis as an MCP client relaying elicitation

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitationRelayResult` | `packages/mcp-client/src/client.ts` | `{ action: "accept"\|"decline"\|"cancel", content? }` |
| `ElicitationRelay` | `packages/mcp-client/src/client.ts` | `{ handle(params, signal?): Promise<ElicitationRelayResult> }` |
| Capability advertisement | `packages/mcp-client/src/client.ts` | `capabilities: relay ? { elicitation: {} } : {}` — presence of a `relay` is what tells the external server Clarvis can answer |
| Request handler | `packages/mcp-client/src/client.ts` | `client.setRequestHandler(ElicitRequestSchema, ...)` forwards `request.params` to `relay.handle` |
| Pooled connections | `packages/mcp-client/src/client.ts` (doc) | opened **without** a relay — no single human to route to for a shared subprocess |
| `ConnectionManager`'s enforcement of that rule | `packages/mcp-client/src/connection-manager.ts` | `openFresh(o, signal, pooled)` opens with `...(o.relay && !pooled ? { relay: o.relay } : {})` — a `relay` handed to a poolable (stdio + `shared`) acquire is silently dropped, never reaching `createMCPClientFactory` |
| `warnRelayDropped` | `packages/mcp-client/src/connection-manager.ts` | logs `mcp.pool.relay_dropped` once per **server name** (not per acquire, not per slot) the first time a dropped relay is observed for it |

### 2.8 `@clarvis/workflows` elicit mux

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitMux` | `packages/workflows/src/elicit-mux.ts` | `{ manager: Elicit; forLeader(runId: string): Elicit }` |
| `ElicitMuxOptions` | `packages/workflows/src/elicit-mux.ts` | `{ logger?: Logger }` |
| `createElicitMux(user, options?)` | `packages/workflows/src/elicit-mux.ts` | wraps a host `Elicit` in one tree-wide FIFO |

### 2.9 `code`'s local elicitation vocabulary

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitRequestParams` | `packages/code/src/adapters/elicit-types.ts` | `{ message, kind?, detail?, requestedSchema?, mode?, url? }` — a local mirror of the protocol type, kept dependency-free of the SDK |
| `ElicitCommandDetail` | `packages/code/src/adapters/elicit-types.ts` | `{ command, cwd, reason, warning? }` |
| `ElicitResult` | `packages/code/src/adapters/elicit-types.ts` | `{ action, content? }` |
| `ElicitSlot` | `packages/code/src/adapters/elicit-slot.ts` | `{ request, ask(params), resolve(result), cancelPending() }` — single-slot queue |
| `parseElicitForm(params)` | `packages/code/src/adapters/elicitation.ts` | derives a renderable `ElicitForm` from the wire params |
| `ElicitField`/`ElicitFieldKind` | `packages/code/src/adapters/elicitation.ts` | one input field of a parsed form — `{name, title, description?, required, kind: "select"\|"text"\|"number"\|"boolean", options, default?}` |
| `initialValues`/`ChoiceInitialSelection` | `packages/code/src/adapters/elicitation.ts` | seeds each field's starting string value, per the `"first"`/`"none"` policy (§3.6) |
| `missingRequired` | `packages/code/src/adapters/elicitation.ts` | names of required fields left blank, or non-numeric for a `number` field |
| `buildContent`/`acceptResult` | `packages/code/src/adapters/elicitation.ts` | coerces raw form values into an elicitation's `content`; wraps it as an `accept` `ElicitResult` |
| `DECLINE_RESULT`/`CANCEL_RESULT` | `packages/code/src/adapters/elicitation.ts` | the shared `decline`/`cancel` `ElicitResult` constants |
| `ElicitBlock` | `ElicitBlock` in `packages/code/src/views/ElicitBlock.tsx` | the modal-style renderer; detailed rendering/keyboard behaviour is **code-input-overlays-and-commands**' concern. One exception worth noting here because it touches `acceptResult`/`DECLINE_RESULT` directly: in `mode: "url"`, `accept()` resolves `DECLINE_RESULT` rather than an accept, regardless of how it was invoked (footer command or the `return` key binding) — the URL variant has nothing for the model to receive as an answer |

## 3. Data and formats

### 3.1 `ElicitParams` → transport request

`buildElicitParams` (`packages/loop/src/runtime/tools/ask-user-tool.ts`) turns an `ask_user` call's
`{question, options?}` into:

```jsonc
{
  "message": "<question text>",
  "requestedSchema": {
    "type": "object",
    "properties": { "response": { "type": "string", "description": "Your answer.", "enum": [...optional] } },
    "required": ["response"]
  }
}
```

`ELICIT_RESPONSE_FIELD = "response"` (`packages/loop/src/runtime/tools/ask-user-tool.ts`) is the single property name every
`ask_user` answer is keyed by; `extractAnswer` reads it back: the field's own string value
when it is a string, `JSON.stringify(content)` (the whole content object) when the field is absent but
content exists, `safeStringify(v)` (just that value) when the field is present but not itself a string,
and `""` when there is no content at all.

Guard confirmations use the same `ElicitParams` shape but key their schema's single property
`decision` instead (`packages/kernel/src/guard/guard-elicit.ts`), and carry the additional
`GuardElicitParams.detail: ElicitationCommandDetail` — `{ command, cwd, reason, warning? }` — built only when a `command` string argument and a `workspaceRoot` are both known; `cwd` resolves a
relative `cwd` argument against `workspaceRoot` via `node:path`'s `resolve`.

### 3.2 Protocol `ElicitationRequest` id format

`createElicitBridge` mints ids as `` `${executionId}:elicit:${seq++}` `` (`packages/kernel/src/runs/elicit-bridge.ts`), a
monotonically increasing per-run sequence, never reused within one bridge's lifetime.

### 3.3 `mapOutcomeToText` — the model-facing rendering of an outcome

`packages/loop/src/runtime/tools/ask-user-tool.ts`:

| `outcome.action` | `noResponse` | Text |
| --- | --- | --- |
| `accept` | — | `` `User answered: ${answer}` `` |
| `decline` | `true` | `"User did not respond within the wait window."` |
| `decline` | `false`/absent | `"User declined to answer the question."` |
| `cancel` | — | `"User dismissed the question without answering."` |

### 3.4 Trace entries

| Kind | Detail shape | Producer |
| --- | --- | --- |
| `elicitation_requested` | `ElicitationRequestedDetail` (`packages/capability/src/trace-kinds.ts`): `{ agent?, subagent_instance_id?, iteration_ref?, source: "ask_user"\|"tool_relay", question, options? }` | `handleAskUserCall` (`packages/loop/src/runtime/tools/ask-user-call.ts`, `source: "ask_user"`) and `buildElicitRelay`'s relay handler (`packages/loop/src/runtime/elicit-relay.ts`, `source: "tool_relay"`) |
| `user_question` | `UserQuestionDetail` (`packages/capability/src/trace-kinds.ts`): `{ agent, subagent_instance_id?, iteration_ref, question, outcome, answer?, options? }` | `handleAskUserCall` (`packages/loop/src/runtime/tools/ask-user-call.ts`) |

These are the engine trace kinds; the kernel's `mapEntry`/`engineEventToProto` re-projects
`elicitation_requested` and `user_question` onto the protocol `RunEvent` variants
`elicitation_requested`/`elicitation_resolved` respectively (§2.5).

A relayed MCP-server elicitation (`source: "tool_relay"`) is asymmetric with the `ask_user` path: only
`elicitation_requested` is ever recorded for it — `buildElicitRelay`'s relay handler
(`packages/loop/src/runtime/elicit-relay.ts`) has no call analogous to `handleAskUserCall`'s
second `trace.record("user_question", ...)`, so a relayed question never produces a `user_question` (and
therefore never an `elicitation_resolved` `RunEvent`) at all, while an `ask_user`-tool question always
produces both.

### 3.5 Session-scoped guard allowlist key

`sessionKey(segment)` (`packages/kernel/src/guard/guard-elicit.ts`) = the segment's
`envAssignments` joined with its `normalized` command, space-separated — e.g. a segment with
`envAssignments: ["FOO=1"]` and `normalized: "rm -rf build"` keys as `"FOO=1 rm -rf build"`. A changed
env assignment or any changed token therefore keys differently and re-prompts. `covers`/`record`
 both return/no-op immediately for an `undecidable` or zero-segment command — an
allow-for-session decision never covers something the shell-fact analyzer could not fully parse.

### 3.6 `code`'s wire-schema-to-form vocabulary

`fieldFromSchema`/`optionsFromSchema` (`packages/code/src/adapters/elicitation.ts`) turn one
`requestedSchema` property into an `ElicitField`: `optionsFromSchema` populates `options` from either a
JSON-Schema `enum` array (each value used as both `value` and `label`) or a `oneOf` array of
`{const, title?}` entries (`title` falling back to `const` as the label) — both populate the same
`options` list, so a form field cannot tell which one produced it. `fieldFromSchema` then picks `kind`:
`"select"` whenever `options` is non-empty, else `"boolean"`/`"number"` from the schema's `type`, else
`"text"`; a `boolean`-typed field with no `enum`/`oneOf` of its own synthesizes a yes/no option pair
(`{value:"true",label:"yes"}`/`{value:"false",label:"no"}`) so it renders as a choice like any other.

Three decision-relabeling tables — `GUARD_DECISION_LABELS`, `PLAN_DECISION_LABELS` and
`WORKFLOW_DECISION_LABELS` — plus the `DECISION_LABELS` dispatch keyed by `params.kind`
(`packages/code/src/adapters/elicitation.ts`) rewrite a field's option `label`s from the raw wire values
(`"allow_session"`) into user-facing wording (`"allow for this session"`) whenever `kind` is
`"guard_confirm"`, `"plan_review"` or `"workflow_review"`; `option.value` (what
is actually sent back) is untouched.

`initialValues(fields, choiceInitialSelection)` seeds each field's starting string value.
Its `ChoiceInitialSelection` parameter defaults to `"first"` (a `select`/`boolean` field with no
`default` starts on its first option), but a caller may pass `"none"` to leave every choice field blank
instead. `ElicitBlock` passes `"none"` for `plan_review` and `workflow_review`; an untouched
confirmation therefore reports the required field as missing instead of accepting whichever enum
member happens to be first. As a second fail-safe, `buildRunWorkflowHandler` authors the workflow
decision enum as `["cancel", "run"]` and treats every non-`run`/no-response outcome as cancellation.
`missingRequired(fields, values)` names every required field that is blank, or, for a
`number`-kind field, non-numeric. `buildContent(fields, values)` coerces raw string values
into the typed `content` object a response carries: a blank value is omitted from `content` entirely
(never sent as `""`), and a `number`-kind field whose value fails `Number.isNaN` is likewise dropped
rather than sent as `NaN`; a `boolean`-kind field's non-blank value becomes `raw === "true"`.
`acceptResult`/`DECLINE_RESULT`/`CANCEL_RESULT` are the three `ElicitResult` constants a
view resolves an elicitation with.

### 3.7 Guard elicitation message construction

`createGuardElicit` (`packages/kernel/src/guard/guard-elicit.ts`) builds the human-facing
`message` and the `requestedSchema`/`detail` around one guard request:

- **Reason.** `req.reason` is used when present; otherwise a default reason is synthesized as
  `` `Tool "${req.tool}" requires confirmation.` ``.
- **Command line.** When `req.args?.command` is a non-blank string, the message gets a literal
  `` `$ ${command}` `` line; otherwise, when `req.shell` is present, it falls back to
  `` `Command segments: ${req.shell.segments.map(s => s.normalized).join(", ")}` ``.
- **Undecidable warning.** When `req.shell?.undecidable`, the fixed line
  `"Warning: this command contains undecidable expansions."` (`UNDECIDABLE_WARNING`) is appended.
- **`allow_session` offer.** The `decision` schema's `enum` includes `"allow_session"` only when an
  `opts.allowlist` was supplied *and* `req.shell` is present, decidable, and non-empty;
  otherwise the schema offers only `["deny","allow"]`.
- **Structured `detail`.** `ElicitationCommandDetail` is attached only when both a `command` string arg
  and `opts.workspaceRoot` are known; its `cwd` resolves a relative `req.args?.cwd` against
  `workspaceRoot` via `node:path`'s `resolve`, or falls back to `workspaceRoot` itself when no `cwd` arg
  was given.

## 4. Behavior

### 4.1 `ask_user` end to end

1. Model emits a tool call named `ask_user` with `{question, options?}`.
2. `buildAskUserHandler` (`packages/loop/src/runtime/capabilities/ask-user.ts`) matches it and
   calls `handleAskUserCall` (`packages/loop/src/runtime/tools/ask-user-call.ts`).
3. `handleAskUserCall` opens a call envelope (`openCallEnvelope`), validates arguments against
   `askUserTool.inputSchema`; on invalid arguments returns an error result **without ever calling**
   `askUser` (`packages/loop/src/runtime/tools/ask-user-call.ts`).
4. On valid arguments: `envelope.start()`, records `elicitation_requested`, then awaits
   `askUser(askArgs)` — the `AskUser` port built by `buildAskUser` (`packages/loop/src/runtime/tools/ask-user-tool.ts`), which in
   turn calls `elicitWithClockPause` (`packages/capability/src/elicit.ts`) around the underlying `Elicit`.
5. `elicitWithClockPause` pauses the run's compute clock (`clock.pause()`), awaits the elicit, and in
   `finally` resumes it (`packages/capability/src/elicit.ts`) — so wall-clock time spent waiting on the human is never
   billed against the run's compute budget, regardless of outcome.
6. On success: `onResult` maps `accept` → `{action:"accept", answer: extractAnswer(content)}`; any
   other raw action passes through unchanged.
7. On an `ElicitTimeoutError` specifically: `onNoResponse` → `{action:"decline", noResponse:true}`,
   logged as `capability.elicit_no_response` (`packages/capability/src/elicit.ts`). Any other rejection propagates —
   **except** that an `ElicitTimeoutError` racing a signal abort is itself preempted: `elicitWithClockPause`
   checks `signal?.aborted` before checking the error's type (`packages/capability/src/elicit.ts`), so a timeout that fires
   after the caller's own signal has already aborted rethrows unchanged rather than being swallowed
   (pinned by `packages/capability/tests/unit/elicit.test.ts`'s "a signal that aborts mid-wait" cases).
8. Back in `handleAskUserCall`: if the promise rejects and the call's `signal` is aborted, the outcome
   is `{kind:"cancelled"}` (no trace, no model-facing text — the run is unwinding) (`packages/loop/src/runtime/tools/ask-user-call.ts`);
   otherwise a non-abort rejection becomes an `error` result reading
   `` `could not reach the user (${reason}).` ``.
9. On success (including timeout-as-decline): records `user_question` and returns
   `envelope.ok(mapOutcomeToText(outcome))`.
10. `buildAskUserHandler` maps `{kind:"cancelled"}` to a cancelled `HandlerVerdict`, else a `result`
    whose `progress` is `true` unless `oc.error === true` (`packages/loop/src/runtime/capabilities/ask-user.ts`).

### 4.2 Wait-bound layering

The configured wait and three wrappers/bounds can participate in one elicitation:

| Layer | Bound | Applied by |
| --- | --- | --- |
| Configured run wait | `request.elicit_wait_ms ?? CLARVIS_DEFAULT_ELICIT_WAIT_MS` (default 1,800,000 ms) | supplies ordinary `Elicit` call sites and the outer guard-confirmation wrapper (`packages/loop/src/runtime/orchestrator.ts`, `packages/loop/src/runtime/capabilities/tools.ts`) |
| Enforcement | `withElicitWaitBound(elicit, graceMs=1000)` wraps the run's `elicit` once, at orchestrator construction, adding `ELICIT_WAIT_GRACE_MS` (1000 ms) grace so the *outer* bound fires slightly after the transport's own deadline (`packages/loop/src/runtime/tools/ask-user-tool.ts`, `packages/loop/src/runtime/orchestrator.ts`) | `boundPromise` (`packages/loop/src/runtime/support/bounded.ts`) |
| Guard adapter's port-level declaration | `ELICIT_NO_TIMEOUT_MS` = 2,147,483,647 ms (practical "never") plus the run signal | `createGuardElicit` (`packages/kernel/src/guard/guard-elicit.ts`) |
| Effective guard-confirmation enforcement | `withGuardElicitWaitBound` wraps the complete guard callback with the configured run wait; timeout, abort, or rejection resolves `false`, while a timely boolean or attributed `GuardElicitAnswer` passes through unchanged | `packages/loop/src/runtime/capabilities/tools.ts`; rich-answer test at `packages/loop/tests/unit/guard-elicit-bound.test.ts` |

`withElicitWaitBound`'s special cases (`packages/loop/src/runtime/tools/ask-user-tool.ts`, pinned by
`packages/loop/tests/unit/elicit-wait-bound.test.ts`): a `timeoutMs` of `0` is passed through as `0`
(immediate `ElicitTimeoutError`, no grace added); an **omitted** `timeoutMs` leaves the wait fully
unbounded (no race at all); the wait is clamped to the 32-bit `setTimeout` ceiling
(`MAX_TIMER_DELAY_MS`) rather than overflowing to an near-instant fire
(`packages/loop/src/runtime/support/bounded.ts`); an already-aborted signal settles via `onAbort` before the inner promise can
ever win, and the inner elicit is never invoked in that case
(`elicit-wait-bound.test.ts` — "rejects immediately on an already-aborted signal without invoking the
elicit").

None of these three layers lives inside the kernel's `ElicitBridge` (§4.4) itself: `createElicitBridge`'s
`elicit` (`packages/kernel/src/runs/elicit-bridge.ts`) never reads `opts.timeoutMs` and starts no timer of its own — every
bound above is applied by a caller that wraps the bridge's `elicit`, so the bridge alone would wait
forever on an unresolved question.

### 4.3 The per-run relay/serializer (`buildElicitRelay`)

`buildElicitRelay` (`packages/loop/src/runtime/elicit-relay.ts`) builds a single `createElicitSerializer()` FIFO
(a promise chain that runs each queued `job` after the previous settles, success or failure)
shared by two consumers:

- `serializedElicit`: what the built-in `ask_user` tool (and the soft-budget ask, and the guard
  elicit) actually call — every direct call is wrapped in `serialize(() => elicit(params, opts))`.
- `relay: ElicitationRelay`: what an MCP server's own elicitation request is routed through
   — it additionally pauses the run's compute clock for the duration
  (`clock?.pauseCompute()` / `releaseCompute?.()`), records `elicitation_requested` with
  `source: "tool_relay"`, and maps an `ElicitTimeoutError` specifically to
  `{action:"decline"}` (never propagated) while any other error still throws.

When `enabled` is `false` or no `elicit` was supplied, no serializer or relay is built:
`serializedElicit` degrades to the raw `elicit` (possibly `undefined`) and `relay` is `undefined`.

### 4.4 Kernel elicit bridge — state machine

| State | Event | Effect |
| --- | --- | --- |
| no pending entry for id | `bridge.elicit(params, opts)` called | mints `id`, builds `ElicitationRequest` (`kind: params.kind ?? "ask_user"` — a caller that omits `kind` is protocol-labeled as an ordinary `ask_user` question, `packages/kernel/src/runs/elicit-bridge.ts`), stores `{request, resolve}` in `pending`, delivers to every already-registered handler (`packages/kernel/src/runs/elicit-bridge.ts`) |
| entry pending, no handler yet | `bridge.onElicit(handler)` registers | handler pushed, then **replayed every still-pending request** |
| entry pending | `bridge.respond({id, action, content?})` | entry removed from `pending`, its `resolve` settles with `{action, content?}` |
| entry pending | the elicit call's `opts.signal` aborts | entry removed from `pending`, resolves as `{action:"cancel"}` |
| entry absent (unknown/already-settled id) | `respond` called | no-op — `item === undefined` returns silently |
| — | a registered handler throws | swallowed by `deliver`'s `try/catch`; "cannot break or settle the engine's pending question" |

This buffered-delivery behavior — a question raised before any client ever calls `onElicit` is not
lost, and is delivered the moment the first handler attaches — is pinned by
`packages/kernel/tests/unit/elicit-bridge.test.ts` ("an elicitation raised before onElicit
registration is delivered when the handler attaches").

The table's abort row assumes `opts.signal` is unaborted at the moment `bridge.elicit()` is called.
`elicit`'s abort listener is registered with `opts.signal?.addEventListener("abort"...)` **after**
the entry is already stored in `pending` and delivered to every handler, and — unlike
`boundPromise` (§4.2), which checks `opts.signal?.aborted` up front before ever registering a listener
— nothing here checks whether the signal is already aborted at call time. A DOM `AbortSignal` does not
replay a past `"abort"` event to a listener added after it fired, so a caller that passes an
already-aborted signal into `bridge.elicit()` leaves that entry pending indefinitely: it is neither
cancelled by the (already-fired) abort nor answered, and only an explicit `bridge.respond(...)` for that
id resolves it. Whether any current caller can reach `bridge.elicit()` with an already-aborted signal
is not established in this document's scope (see §8).

The **remote** kernel client (`packages/kernel/src/transport/client.ts`) repeats the same buffering
pattern one hop further out, for a client that has not yet called `RunHandle.onElicit` on its own
handle: `streamingStart` registers the `ClientRun` (with empty `elicitHandlers`/`pendingElicits`)
**before** awaiting `transport.request(methods.start, ...)` (`packages/kernel/src/transport/client.ts`), so a
`runElicitation` notification arriving during or immediately after the start round-trip has somewhere
to land. The `N.runElicitation` observer pushes to `pendingElicits` while `elicitHandlers` is empty,
and delivers directly once a handler exists (`packages/kernel/src/transport/client.ts`); `RunHandle.onElicit` on the client
side then splices and replays the buffer the moment a handler attaches (`packages/kernel/src/transport/client.ts`). The
server side of the same transport wires `handle.onElicit` straight into
`notifications.notify(N.runElicitation, {request})` (`packages/kernel/src/transport/server.ts`).

### 4.5 Server posture resolution (`resolvePosture`)

`resolvePosture` (`packages/server/src/mcp/elicitation.ts`) is a pure decision made **before** the run starts:

| Input | Effect on `elicitation` |
| --- | --- |
| `clientDeclaresElicitation: true` | `"relay"` (client capability wins regardless of `requested`) |
| `clientDeclaresElicitation: false`, `requested: "await"` | `"tool"` |
| `clientDeclaresElicitation: false`, `requested: "auto_decline"` | `"auto_decline"` |

Two further downgrades, both recorded as human-readable strings in `downgrades`:

- `requested === "await"` but the client declares elicitation anyway →
  `"elicitations:await→relay (client declares the elicitation capability)"` — relay always
  wins over the caller's own request for the tool-based posture.
- `elicitation === "auto_decline"` and `requestedPlans === "review"` → downgraded to `plans_effective:
  "on"`, `"plans:review→on (an unanswered review gate cancels the run)"` — because an
  unanswered plan-review gate does not skip approval, it cancels the whole run.

`guard_confirmations` is `"relayed"` only when **all three** hold: `allowRemoteGuardApproval` (an
operator/container switch), `roleAllowsGuardApproval` (defaults `true` with no auth), and
`elicitation !== "auto_decline"`; otherwise `"denied"`, and a downgrade note names which of the two
gates was missing.

Under `auto_decline`, `prompt_cache_ttl` is pinned to `"5m"` with the note "no elicitation can pause
this run" — left `undefined` otherwise so the kernel derives it as usual.

### 4.6 `ElicitationController` — answering everything a run asks

`createElicitationController` (`packages/server/src/mcp/elicitation.ts`) is `attach`ed once per run, before the run's first
iteration (`attach(runHandle)` installs `runHandle.onElicit(...)`). Per incoming
`ElicitationRequest`:

1. If `disposed`, auto-decline immediately.
2. Always `opts.publish(request)` first — the question reaches the run's own event stream regardless
   of posture.
3. `kind === "guard_confirm"` and `posture.guard_confirmations === "denied"` → auto-decline.
4. `posture.elicitation === "auto_decline"` → auto-decline.
5. `posture.elicitation === "relay"` and a `sendRequest` is configured → forwards via
   `sendRequest(...)` (the MCP `elicitation/create` request to the connected client); on the answer,
   calls `runHandle.respond(...)`; on any thrown error (timeout, rejection, malformed answer) — falls
   back to auto-decline.
6. Otherwise (`tool` posture) — schedules a timeout (`opts.scheduleTimeout ?? scheduleSystemTimeout`,
   `opts.toolWaitMs`) that auto-declines if it fires, and records the pending entry so
   `clarvis_respond` can answer it first.

`respond(response)` only accepts an answer in `tool` posture; otherwise returns
`{accepted:false, note: "this run answers questions itself (posture=...)"}`. An unknown/already-settled
id likewise returns `{accepted:false, note:"no pending question with that id"}`.

`dispose()` sets `disposed = true` and force-auto-declines every still-pending question —
called on session/connection teardown so no question is left hanging past the connection's life.

`reportAnswered(logger, posture, action, auto)` (`packages/server/src/mcp/elicitation.ts`) logs one `elicit.answered`
event (fields: `posture`, `action`, `auto`) for every question the controller settles, at three call
sites: inside `autoDecline` (`auto: true`), after a successful relay answer (`auto: false`), and inside `respond()` for an accepted `tool`-posture answer (`auto: false`).
`AppliedPosture.auto_answered` — the same field `clarvis_run` echoes back statically per §2.6 — is a
live counter, not a fixed report value: `autoDecline` mutates it in place (`opts.posture.auto_answered
+= 1`) as a side effect of each auto-decline, so it grows across the run's lifetime rather than
being computed once.

### 4.7 The workflow elicit mux — state machine

`createElicitMux(user, options?)` (`packages/workflows/src/elicit-mux.ts`) builds one internal `createElicitSerializer()`
(re-imported from `@clarvis/loop/workflows`, i.e. the *identical* function as §4.3 — literally the same
serializer primitive, applied at the tree level rather than the run level) plus a `depth` counter for
diagnostics. Per call on a channel (`manager` or `forLeader(runId)`):

| State | Event | Effect |
| --- | --- | --- |
| signal already aborted at call time | channel invoked | logs `workflow.elicit_skipped`, resolves `{action:"cancel"}` immediately — **`user` is never called**, `depth` never incremented (`packages/workflows/src/elicit-mux.ts`) |
| not yet aborted | channel invoked | `depth += 1`, logs `workflow.elicit_queued`, enqueues `serialize(() =>...)` |
| queued, reaches front of FIFO | signal aborted **by the time it is dequeued** | logs `workflow.elicit_skipped` (with the actual waited time), resolves `{action:"cancel"}` — `user` is skipped, never called for this request |
| queued, reaches front, not aborted | — | calls `user(params, opts)`, tagging the message with `` `[leader ${runId.slice(0,8)}] ` `` prefix for a leader channel, untagged for the manager channel |
| a `signal` was supplied and the queued promise is still pending | signal aborts | listener resolves the **outer** promise immediately as `{action:"cancel"}`, independent of whether the queued job has reached the transport yet |
| the underlying `user` call rejects | signal is aborted | resolves `{action:"cancel"}` rather than rejecting |
| the underlying `user` call rejects | signal is **not** aborted | rejects with the real error, wrapped in `Error` if not already one |

### 4.8 `code`'s elicit slot

`createElicitSlot()` (`packages/code/src/adapters/elicit-slot.ts`) holds at most one live `ElicitRequestParams` at a time:
calling `ask(params)` while a previous call is still `pending` first resolves the earlier one as
`CANCEL_RESULT`, **then** installs the new request — so the UI never shows two questions
superimposed; the older one is simply superseded. `resolve(result)` clears both the pending resolver
and the visible `request` signal atomically. `cancelPending()` resolves whatever is pending
as `CANCEL_RESULT` — used e.g. when the run itself ends while a question is still open
(the `runManaged` `finally` block in `createRunHost`).

The TUI shell treats a newly visible request as explicit navigation to the live transcript tail.
`App` calls the active physical-history handle's `returnToTail()` before hiding the composer, retains
the composer as a painted but keyboard-inert bridge until `active-elicitation` owns a visible
transcript row, then requests the tail again before removing that bridge. A dirty full-page editor
pauses this transition without polling renderer frames; the retained request restarts it reactively
when the overlay closes. Each `CommittedHistory` request waits until the physical tail is resident,
clamps once and releases its latch, while `App` repeats the request across the question's actual
layout transition. Clearing the request restores the composer and requests the changed tail again.
A confirmation cannot therefore be stranded in an unmounted live tail while the screen remains
anchored to older history, no transition frame contains neither interaction surface, and native
scrollbar movement is not captured after the transition settles. Production:
`packages/code/src/views/App.tsx` (`elicitComposerHidden`, `revealHistoryTail`, elicitation effect),
`packages/code/src/views/ElicitBlock.tsx` (`active-elicitation`),
and `packages/code/src/views/history/CommittedHistory.tsx` (`tailClampRequested`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` ("an elicitation returns an old reader to
the live tail before hiding the composer" and "a pending elicitation does not discard an in-progress
config edit") and `packages/code/tests/integration/transcript-window-render.test.tsx` ("native
scrollbar movement is free after an explicit tail clamp settles"). The physical-history contract is owned by
[hosts/code-transcript-stability.md](../hosts/code-transcript-stability.md) (INV-TP34).

`kernel-run-client.ts`'s `wireElicit` (`packages/code/src/adapters/kernel-run-client.ts`) is the piece that turns a protocol
`ElicitationRequest` into the `ElicitRequestParams` the slot/block consume, and turns the UI's
`ElicitResult` back into an `ElicitationResponse` sent via `handle.respond`. If the host's own
`onElicit` callback throws, `reportElicitFailure` logs `elicit.handler.failed` and still
answers `{action:"cancel"}` — "without this the prompt simply cancels, and the run reads as if the user
had dismissed it: the defect and the deliberate refusal are indistinguishable in the transcript"
(comment).

### 4.9 The human `GuardElicit` adapter's action-to-boolean resolution

`createGuardElicit`'s returned function (§3.7 builds its input) resolves the human's answer to the
boolean a guard actually branches on (`packages/kernel/src/guard/guard-elicit.ts`): any `result.action !== "accept"`
(a `decline` or `cancel`) resolves `false` immediately; on `accept`, `decision === "allow"` resolves
`true`; `decision === "allow_session"` resolves `true` **only** when a `session` was actually offered in
the request (i.e. an allowlist was configured and the command was decidable and non-empty, §3.7) — and,
as a side effect of that one branch, calls `session.allowlist.record(session.shell)` before resolving,
which is what makes later identical commands in the same session pass without asking again (§3.5). Any
other `decision` value, or an `allow_session` answer when no `session` was offered at all, resolves
`false`.

### 4.10 Run admission: whether a run needs a human at all

`deriveRunShape` (`packages/loop/src/validation/request/run-shape.ts`) computes, once per run
before it starts, whether *any* mechanism in this document might need to reach a human:
`userInputEnabled = askUserGranted || capabilityNeedsHuman || softMode` — `askUserGranted` is
the entry profile's `"ask_user"` grant, `capabilityNeedsHuman` is `true` when any registered capability's
`requiresUserInput?.(requestView)` returns `true`, and `softMode` is `request.budget.on_exceed ===
"escalate"` (the soft-budget escalation ask, §7). A separate `humanParkLikely` field
(`askUserGranted || capabilityNeedsHuman`) **excludes** `softMode` and is further gated on
`request.elicit_wait_ms !== 0`; its only consumer is outside this document's scope.

`packages/loop/src/runtime/execute-run.ts` checks `shape.userInputEnabled` immediately after computing the shape: if it is
`true` but the host supplied no `elicit` callback at all, the run never starts — it throws
`ValidationError("elicitation_not_supported"...)` rather than admitting a run that would
later park on its first question with nothing able to answer it. This is the one place absence of an
`Elicit` transport is treated as a **request-validation failure** rather than a per-question decline;
every other "nobody is listening" case in this document (server `auto_decline`, a headless `code` client, a
disabled relay) instead runs to completion by auto-answering each question (§1, §6).

## 5. Invariants

Catalog invariants carry `INV-nnn` and are owned here; `ELI-nn` are invariants derived directly
from this document's own source and tests.

**INV-178.** `createElicitMux` serializes concurrent leaders' human-facing prompts: only one prompt is
ever presented to the user at a time across concurrently running leaders, and each leader's prompt is
tagged with that leader's id (`` `[leader ${runId.slice(0,8)}] ` `` prefix), while the manager channel's
prompt is presented untagged.
Production: `packages/workflows/src/elicit-mux.ts`.
Test: `packages/workflows/tests/contract/elicit-mux.test.ts` (concurrency + tagging),
`packages/workflows/tests/contract/elicit-mux.test.ts` (manager untagged).

**INV-179.** A queued prompt whose caller aborts its signal settles immediately as `{action:
"cancel"}` without waiting for its turn in the queue, and is never actually presented to the human
even once its turn does come around.
Production: `packages/workflows/src/elicit-mux.ts`.
Test: `packages/workflows/tests/contract/elicit-mux.test.ts` (settles at once, `<50ms`),
`packages/workflows/tests/contract/elicit-mux.test.ts` (never seen by `user` even when its turn
arrives).

**INV-180.** A genuine transport error thrown by the underlying `Elicit` function propagates as a
rejection — it is never silently reinterpreted as a cancellation (only an abort produces a
cancellation).
Production: `packages/workflows/src/elicit-mux.ts`.
Test: `packages/workflows/tests/contract/elicit-mux.test.ts`.

**INV-181.** A signal that is already aborted *before* `createElicitMux`'s channel is even called never
reaches the underlying transport at all (the `user` callback's call count stays 0) and resolves
immediately to `{action:"cancel"}`.
Production: `packages/workflows/src/elicit-mux.ts`.
Test: `packages/workflows/tests/contract/elicit-mux.test.ts`.

**ELI-01.** An `ask_user` call is available only to the run's entry agent, and only when the
entry profile's grants include `"ask_user"`; a spawned sub-agent never receives the tool regardless of
its own profile's grants.
Production: `packages/loop/src/runtime/capabilities/ask-user.ts`.
Test: `packages/loop/tests/integration/ask-user-grant-gating.test.ts` confirms only the
entry-vs-grant half (an escalate-budget entry agent without the grant is not offered `ask_user`; one
with the grant is) — see §8 for the sub-agent-exclusion half, which this file does not exercise.

**ELI-02.** An elicitation's wait time is never charged against the run's compute budget:
`elicitWithClockPause` pauses the clock before calling the underlying elicit and resumes it in a
`finally`, regardless of how the call settles (success, timeout, or any other error).
Production: `packages/capability/src/elicit.ts`.
Test: `packages/capability/tests/unit/elicit.test.ts` (pause/resume around a successful result,
a swallowed timeout, and a propagated non-timeout rejection, each asserting `clock.calls` is exactly
`["pause","resume"]`).

**ELI-03.** `withElicitWaitBound`'s outer timeout is always `timeoutMs + graceMs` except
when `timeoutMs` is exactly `0` (enforced with no grace) or `undefined` (no bound applied at all).
Production: `packages/loop/src/runtime/tools/ask-user-tool.ts`.
Test: `packages/loop/tests/unit/elicit-wait-bound.test.ts` ("a zero bound (never block on a human) is
enforced without grace", "does not race when no timeoutMs is given").

**ELI-04.** A question raised through the kernel's `ElicitBridge` before any `onElicit`
handler has been registered is not lost: it is delivered to the first handler that attaches, replaying
every still-pending request at registration time.
Production: `packages/kernel/src/runs/elicit-bridge.ts`.
Test: `packages/kernel/tests/unit/elicit-bridge.test.ts`.

**ELI-05.** The remote kernel transport client repeats the same buffered-delivery guarantee
one hop further out: an `N.runElicitation` notification arriving before the caller's own `RunHandle`
has an `onElicit` handler attached is queued in `pendingElicits` and flushed in order the moment a
handler is registered.
Production: `packages/kernel/src/transport/client.ts`.
Test: unpinned in this document's scope — no dedicated remote-client elicit-buffering test was
opened (see §8).

**ELI-06.** Under the server's `auto_decline` elicitation posture, a requested
`plans: "review"` is always downgraded to `plans_effective: "on"`, never silently left as `"review"`
and never upgraded to fail the run.
Production: `packages/server/src/mcp/elicitation.ts`.
Test: `packages/server/tests/unit/elicitation.test.ts` ("downgrades plans:review only when no
answer channel exists").

**ELI-07.** Guard confirmations are relayed to a remote server caller only when the
operator's container switch, the caller's own role, and the resolved elicitation posture all three
permit it; any one of the three being false forces `guard_confirmations: "denied"`.
Production: `packages/server/src/mcp/elicitation.ts`.
Test: `packages/server/tests/unit/elicitation.test.ts` ("relays guard approval only when operator,
role and answer channel all permit it").

**ELI-08.** A workflow preflight has no implicit affirmative path. The TUI begins with no selected
decision; the wire schema places `cancel` before `run`; only an explicitly submitted `run` starts the
first round, while decline, cancel, timeout and an absent channel spawn no leader. The model-facing
tool result keeps explicit decline, dismissal, invalid accepted content and no-response timeout
distinct. The call passes the manager run's effective `elicit_wait_ms`; every outcome logs
`workflow.review_resolved` with `waited_ms`, and a genuine timeout additionally emits
`capability.elicit_no_response` through the workflow logger.
Production: `packages/code/src/views/ElicitBlock.tsx` (`initialValues` call) and
`buildRunWorkflowHandler` in `packages/workflows/src/run-workflow.ts`.
Test: `packages/code/tests/integration/elicit-block-render.test.tsx` (`a workflow_review is an
explicit preflight with a safe before-start promise`) and
`packages/workflows/tests/component/run-workflow.test.ts` (declined,
unavailable and timed-out preflights start nothing).

## 6. Failure modes and degradation

| Failure | Where handled | Result |
| --- | --- | --- |
| `ask_user` called with invalid arguments (fails `askUserTool.inputSchema`) | `openCallEnvelope`'s `envelope.invalid` (`packages/loop/src/runtime/tools/ask-user-call.ts`) | error tool result; `askUser` is **never invoked** |
| The wait bound elapses with no answer | `ElicitTimeoutError` swallowed by `elicitWithClockPause` (`packages/capability/src/elicit.ts`) | `{action:"decline", noResponse:true}` — the model reads this as an ordinary decline, never as an exception |
| The run's own signal aborts while `askUser` is pending | `handleAskUserCall`'s catch checks `signal?.aborted` (`packages/loop/src/runtime/tools/ask-user-call.ts`) | `{kind:"cancelled"}` — no trace record, no tool-result text; the run is unwinding |
| `askUser` rejects for any other reason (transport failure, non-abort, non-timeout) | same catch, non-abort branch (`packages/loop/src/runtime/tools/ask-user-call.ts`) | error tool result `` `could not reach the user (${reason}).` ``, `error: true` |
| A relayed MCP-server elicitation (`buildElicitRelay`'s `relay`) times out | caught specifically for `ElicitTimeoutError` (`packages/loop/src/runtime/elicit-relay.ts`) | `{action:"decline"}` returned to the MCP server — never propagated as a throw |
| A relayed elicitation fails for a non-timeout reason | same catch, `else` branch (`packages/loop/src/runtime/elicit-relay.ts`) | rethrown — the MCP dispatch layer sees a real failure |
| A registered kernel-bridge `onElicit` handler throws | `deliver`'s try/catch (`packages/kernel/src/runs/elicit-bridge.ts`) | swallowed; "cannot break or settle the engine's pending question" — every other handler and the pending state are unaffected |
| An unknown or already-answered `respond(id, ...)` | `pending.get(id) === undefined` short-circuit (`packages/kernel/src/runs/elicit-bridge.ts`, and server's `packages/server/src/mcp/elicitation.ts`) | no-op / `{accepted:false, note:"no pending question with that id"}` |
| Server elicitation controller is `dispose()`d with questions outstanding | `dispose()` (`packages/server/src/mcp/elicitation.ts`) | every pending question is force-auto-declined; `disposed` latches so any later `attach`-delivered question is auto-declined too |
| Server's `relay` posture: `sendRequest` throws (client refuses, disconnects, or answer fails schema validation) | `catch` around `sendRequest` (`packages/server/src/mcp/elicitation.ts`) | falls back to `autoDecline(request.id)` — a relay failure degrades to a decline, not a stuck run |
| Workflow review is untouched, declined, cancelled, times out, or has no interactive channel | `ElicitBlock` leaves the choice blank; `buildRunWorkflowHandler` accepts only explicit `decision === "run"`, passes the effective run wait bound, and maps every other resolution separately | workflow is not started; zero leaders registered; the tool result distinguishes decline, dismissal, invalid content and no-response timeout; settled waits log `workflow.review_resolved`, and timeout also logs `capability.elicit_no_response` |
| `code`'s own `onElicit` callback throws | `reportElicitFailure` (`packages/code/src/adapters/kernel-run-client.ts`) | logs `elicit.handler.failed` (warn) and still answers `{action:"cancel"}` |
| `code` invoked headlessly (`--prompt`, no interactive UI) | `handle.onElicit` registered in `packages/code/src/runtime.tsx` (`runPrintMode`) | every question is logged to stderr and auto-declined via `handle.respond({id, action:"decline"})` |
| Elicitation disabled or no `elicit` supplied at all (`shape.userInputEnabled === false`) | `buildElicitRelay`'s `relayEnabled` guard (`packages/loop/src/runtime/elicit-relay.ts`) | `relay` is `undefined`; `serializedElicit` falls back to the raw (possibly `undefined`) `elicit` — callers that need one and find it absent are a capability-construction concern outside this document |
| A run needs a human (`shape.userInputEnabled === true`) but no `elicit` callback was supplied at all | `packages/loop/src/runtime/execute-run.ts`, checked immediately after `deriveRunShape` | the run never starts: throws `ValidationError("elicitation_not_supported", ...)` — the only elicitation failure resolved at request validation rather than per-question (§4.10) |
| `elicit_wait_ms` request param fails validation | `zodIssueToRequestErrorCode` (`packages/loop/src/validation/request/parsing.ts`) | `invalid_elicit_wait` request error code |
| A pooled (stdio + `shared`) MCP connection is acquired with a `relay` | `ConnectionManager`'s `openFresh(o, signal, pooled=true)` (`packages/mcp-client/src/connection-manager.ts`) | the `relay` is dropped — opened `...(o.relay && !pooled ? { relay: o.relay } : {})` — so the connection advertises no `elicitation` capability at all; `warnRelayDropped` logs `mcp.pool.relay_dropped` once per server name, not once per acquire |

## 7. Coupling

For container runs, authenticated remote MCP connections remain on the host. Their relay crosses
the closed `runtime.mcp_elicit` operation to the matching live guest lease and then uses the same
engine serializer and compute-clock pause before reaching the host input port. Run or lease
cancellation cannot deliver a question into a later run. Production: `createHostRemoteMcpBridge`
and `createGuestMcpConnections` in
[`remote-mcp.ts`](../../packages/kernel/src/runtime/remote-mcp.ts), and `serveExecutionWorker` in
[`execution-worker.ts`](../../packages/kernel/src/runtime/execution-worker.ts).
Test: remote guest-relay integration in
[`runtime-capability-composition.test.ts`](../../packages/kernel/tests/integration/runtime-capability-composition.test.ts),
and live-run routing/cancellation in
[`runtime-execution-worker.test.ts`](../../packages/kernel/tests/integration/runtime-execution-worker.test.ts).
The private protocol and lifetime contract belongs to
[isolated-agent-runtime](../hosts/isolated-agent-runtime.md).

**Depends on** (runtime edges, forced by import):

- `@clarvis/capability`'s `elicit.ts` is a pure-type-plus-one-function leaf; it depends only on
  `ComputeClock` and `Logger`/`NOOP_LOGGER` from within the same package
  (`packages/capability/src/elicit.ts`). Nothing here can reach the engine, by construction — this
  is why `elicitWithClockPause` had to live in the contract rather than the engine: "every capability
  that asks the human … needs the pause, and a capability outside the engine cannot reach an engine
  helper" (`packages/capability/src/elicit.ts`).
- `@clarvis/loop`'s `ask-user-tool.ts`/`ask-user-call.ts`/`elicit-relay.ts`/`capabilities/ask-user.ts`
  import the port types from `@clarvis/capability` and compose them into the engine's tool/capability
  machinery (`openCallEnvelope`, `HandlerVerdict`, `AgentCapability`); `elicit-relay.ts` additionally
  imports `ElicitationRelay`/`ElicitationRelayResult` from `@clarvis/mcp-client`
  (`packages/loop/src/runtime/elicit-relay.ts`), which is the type-level coupling that lets the loop hand an MCP relay to the
  connection pool without importing the SDK itself.
- `@clarvis/workflows`'s `elicit-mux.ts` imports `createElicitSerializer` from `@clarvis/loop/workflows`
  (`packages/workflows/src/elicit-mux.ts`) — this is one of the package's only two permitted edges into the engine
  (INV-173, owned by `specs/capabilities/workflows-scheduling.md`), enforced by
  `packages/workflows/tests/architecture/dependency-direction.test.ts`.
- `@clarvis/kernel`'s `elicit-bridge.ts` imports `Elicit`/`ElicitRawResult` from `@clarvis/loop` and
  `ElicitationRequest`/`ElicitationResponse` from `@clarvis/protocol`
  (`packages/kernel/src/runs/elicit-bridge.ts`) — it is the type-level bridge between the two, and `guard-elicit.ts` imports
  its `GuardElicitParams` back (`packages/kernel/src/guard/guard-elicit.ts`) to attach structured `detail`.
- `@clarvis/kernel`'s `managed-run.ts` constructs one `ElicitBridge` per run
  (`packages/kernel/src/runs/managed-run.ts`) and wires `bridge.elicit` into the `ManagedRunContext.elicit` the engine's
  `execute` closure receives; `RunHandle.onElicit`/`respond` on the returned handle forward
  straight to `bridge.onElicit`/`bridge.respond`.
- `@clarvis/server`'s `mcp/elicitation.ts` depends only on `@clarvis/capability` (`NOOP_LOGGER`,
  `Logger`) and `@clarvis/protocol` (`ElicitationRequest`, `ElicitationResponse`, `RunHandle`) — it
  never imports `@clarvis/loop` or the MCP SDK directly; the SDK-specific `sendRequest`/
  `getClientCapabilities` wiring lives one layer up in `mcp/server.ts` (`packages/server/src/mcp/server.ts`), which is
  the only file that actually names `@modelcontextprotocol/sdk` for this concern.
- `@clarvis/mcp-client`'s `client.ts` is the only place `ElicitRequestSchema`/`ElicitResult` from the
  MCP SDK are named for elicitation (`packages/mcp-client/src/client.ts`) — `@clarvis/loop`'s `open-tool-pool.ts` threads an
  `ElicitationRelay` through to it per connection (`packages/loop/src/runtime/open-tool-pool.ts`), never constructing the
  SDK types itself.
- `code`'s `adapters/elicit-types.ts` is a deliberately independent local mirror of the protocol shapes
  — "so code carries no `@modelcontextprotocol/sdk` dependency" (`packages/code/src/adapters/elicit-types.ts`) — with
  `kernel-run-client.ts`'s `wireElicit` as the sole translation point between the protocol
  `ElicitationRequest`/`Response` and this local vocabulary.

**Depended on by:**

- The soft-budget escalation ask (`buildSoftLimitAsk`, wired at
  `packages/loop/src/runtime/entry-inputs.ts`) shares the same serialized `elicit` and the same
  `elicitWaitMs` derivation as `ask_user` — it is a second consumer of the one per-run FIFO, out of
  scope for this document's detail (see the budget/soft-limit document) but coupled here through
  `elicitWithClockPause` and `createElicitSerializer`.
- `packages/kernel/src/guard/resolver.ts` constructs a `createGuardSessionAllowlist()` and a
  `createGuardElicit(ctx.elicit, {...})` per guard resolution — the guard's own escalation/decision
  policy (out of scope here; see **command-guard-and-approval**) rides this document's `Elicit`/`GuardElicit`
  adaptation to reach the human.
- `code`'s `run-host.ts` and `runtime.tsx` hold the only production `ElicitSlot`
  (`packages/code/src/runtime.tsx`, `runApp`), threading `elicit.ask` into the run callback
  (`packages/code/src/runtime.tsx`, `buildRunHost`), `elicit.cancelPending` into run teardown
  (`runManaged` in `packages/code/src/run-host.ts`), and `elicit.resolve` into the App surface
  (`packages/code/src/runtime.tsx`, `runControls`). Detailed overlay/keyboard rendering of the resulting block is
  **code-input-overlays-and-commands**' concern.

## 8. Open questions

- **ELI-01's sub-agent-exclusion half is production-only.** `packages/loop/tests/integration/ask-user-grant-gating.test.ts`
  was opened; its two tests confirm only that `ask_user` injection is gated on the entry profile's
  `"ask_user"` grant (an escalate-budget entry agent without the grant is not offered it; one with the
  grant is). Neither test spawns a sub-agent, so the invariant's other half — that a spawned sub-agent
  never receives the tool regardless of its own profile's grants, which the production code enforces at
  `packages/loop/src/runtime/capabilities/ask-user.ts` (`if (!scope.entry) return null`) — remains production-verified only, with no located
  test in this document's scope.
- **`ElicitBridge.elicit`'s handling of a signal already aborted at call time.** As noted in §4.4,
  `createElicitBridge`'s abort listener is registered after the pending entry is stored and delivered,
  with no upfront `opts.signal?.aborted` check (unlike `boundPromise`, §4.2). Whether any production
  caller can actually reach `bridge.elicit()` with an already-aborted `signal` — and, if so, what
  recovers that entry — is unestablished; no test exercising this specific ordering is
  known under `packages/kernel/tests`.
- **Remote-transport elicit-buffering test coverage (ELI-05).** `packages/kernel/src/transport/client.ts`'s
  `pendingElicits`/`elicitHandlers` buffering is a straightforward
  mirror of the (tested) in-process bridge behavior, but no test file specifically exercising the
  remote-transport buffering path is known under `packages/kernel/tests`; it may be
  covered by a broader transport round-trip test outside this document's scope.
- ~~**Why `guard_confirm`'s wait bound is a 32-bit-max sentinel rather than `undefined`.**~~
  **Resolved, in two parts: the numeric choice is fully explained; the sentinel-vs-omission style
  choice is inert for the current wiring, not merely "observationally identical absent an abort".**

  The *value* `2_147_483_647` is not invented for guard confirms — it is `MAX_TIMER_DELAY_MS`,
  defined once in `packages/loop/src/runtime/support/bounded.ts`, whose own comment states the
  reason directly: "The largest delay a `setTimeout` accepts (2^31 - 1 ms); longer waits are clamped
  to this so the timer fires rather than overflowing to immediate." `boundPromise` clamps any
  supplied `timeoutMs` to it (`packages/loop/src/runtime/support/bounded.ts`,
  `Math.min(opts.timeoutMs, MAX_TIMER_DELAY_MS)`) for
  exactly this reason — Node's `setTimeout` silently misbehaves on delays at or above 2^31.
  `ELICIT_NO_TIMEOUT_MS` in `packages/kernel/src/guard/guard-elicit.ts` is the identical constant,
  so wherever a real `setTimeout`-backed bound is involved, this is precisely the "wait as close to
  forever as `setTimeout` safely allows" value.

  But for *this specific caller*, the choice is provably inert, not merely indistinguishable in
  practice: the concrete `Elicit` the kernel wires up, `createElicitBridge`'s `elicit`
  (`packages/kernel/src/runs/elicit-bridge.ts`), **never reads `opts.timeoutMs` at all** — it
  only listens for `opts.signal`'s `abort` event, and starts no timer of its own (already noted in
  §4.2's table). So `createGuardElicit`'s inner `elicit(params, { timeoutMs: ELICIT_NO_TIMEOUT_MS,
  ... })` (`packages/kernel/src/guard/guard-elicit.ts`) has the same observable effect as
  omitting `timeoutMs`
  **unconditionally**, not just "absent an abort" — the field is dead for every call this bridge ever
  serves, timeout or not.

  The *real*, effective wait bound on a guard confirmation is enforced one layer up, in the loop, by
  `withGuardElicitWaitBound` (`packages/loop/src/runtime/capabilities/tools.ts`), which wraps
  the **whole** `GuardElicit` callback — not the raw `elicit` — in `boundPromise` using the run's own
  `elicit_wait_ms`/`CLARVIS_DEFAULT_ELICIT_WAIT_MS`
  (`packages/loop/src/runtime/capabilities/tools.ts`), racing it against
  abort exactly as §4.2's "Enforcement" row does for the ask-user path. Its own doc comment states
  "Only a non-finite `waitMs` is unbounded"
  (`packages/loop/src/runtime/capabilities/tools.ts`) — confirming this outer wrap, not the
  inner `ELICIT_NO_TIMEOUT_MS`, is where a guard confirmation's real deadline lives.

  ~~What remains genuinely unstated by any comment or test: *why* `createGuardElicit` bothers passing
  an explicit sentinel to a backend that ignores it, rather than omitting `timeoutMs`.~~ **Resolved
  as a recorded derivation; no behaviour changed.** The reason is now documented beside the constant
  (`packages/kernel/src/guard/guard-elicit.ts`), and it is the opposite of the "defensive
  future-proofing" reading offered here: the `Elicit` port documents `timeoutMs` as a wait bound a
  backend honours, and an *omitted* one means unbounded
  (`packages/capability/src/elicit.ts`), so the sentinel is this function's declaration,
  addressed to whatever backend is wired in, that a command approval always terminates. Omitting it
  would have declared the opposite. That the kernel's own backend does not read it makes the value a
  statement of contract here rather than an observed timer — which is what the two paragraphs above
  establish — not a redundancy. Pinned by "declares a terminating wait bound to the backend, at
  setTimeout's own ceiling"
  (`packages/kernel/tests/unit/guard.test.ts`), which captures what the backend is handed
  and asserts it is `2 ** 31 - 1` and finite.

  Closing it also turned up a false statement in the source, since corrected. `createGuardElicit`'s
  `@remarks` used to say prompts "wait effectively forever ({@link ELICIT_NO_TIMEOUT_MS}) unless the
  signal aborts", which is wrong in the one direction that matters for a command approval: the real
  bound is the engine's `withGuardElicitWaitBound` over the run's `elicit_wait_ms`
  (`packages/loop/src/runtime/capabilities/tools.ts`), and on expiry it does not fall
  through to a still-open prompt — `onTimeout: () => false` fails closed to a **denial**.
  The remark now says so (`packages/kernel/src/guard/guard-elicit.ts`).
- **The full decision policy behind guard escalation** — when the guard chooses to prompt at all, what
  `req.reason`/`req.shell` are populated from upstream, and how `allow_session` composes with the
  guard's broader ruleset — is explicitly delegated to **command-guard-and-approval**; only the
  human `Elicit → boolean` adaptation mechanism and the attributed-answer-preserving wait wrapper
  are covered here.
- **Detailed wire framing** (JSON-RPC method names `M.runsRespond`, notification names `N.runElicitation`,
  request/response envelope validation beyond the DTO shapes in §2.5) is delegated to
  **kernel-transport-and-wire**.
- **Detailed rendering/keyboard behavior of `ElicitBlock.tsx`** (form field layout, choice navigation,
  plan-review summary rendering, URL-mode presentation) is delegated to
  **code-input-overlays-and-commands**; this document covers only what data reaches the block and the
  `ElicitResult` contract it must produce.
- **`workflows`' `run-leader`/manager construction of the `ElicitMux`** — i.e., which service actually
  calls `createElicitMux` and passes `mux.manager`/`mux.forLeader(runId)` into a manager or leader run's
  deps — is outside this document's scope; only the mux's own contract (`elicit-mux.ts`) and its test are
  covered here. The construction site (likely `packages/kernel/src/workflows/workflows-service.ts`, per the
  wider repository's dependency-graph notes) belongs to whichever document covers workflow orchestration.
