# Asking a human: ask_user, MCP elicitation and the mux

Manual execution approval uses the Kernel's existing run elicitation bridge with
trusted `origin: "external"` and `kind: "execution_approval"`. The request shows
the final action, cwd, effects, requested permissions and reason; the TUI offers no preselected
approval. Decline, timeout, disconnect, cancellation and stale authority never
grant execution. A server-supplied MCP elicitation kind cannot claim this host
approval identity. Production: `createApprovalService` in
`packages/kernel/src/execution/approval-service.ts`, `createElicitBridge` in
`packages/kernel/src/runs/elicit-bridge.ts`, `ElicitBlock` in
`packages/code/src/views/ElicitBlock.tsx`. Test:
`packages/kernel/tests/integration/approval-policy.test.ts` and
`packages/code/tests/integration/elicit-block-render.test.tsx`.

For one fully parsed literal segment, manual review can offer an operator-authenticated
“approve and remember prefix” choice. The request shows its exact argv prefix, global destination
and possible explicit-allow sandbox bypass. The Kernel rechecks action identity and current rules,
then persists before reporting remembered; an unsuccessful write leaves one-time consent valid.
Production: `createApprovalService` in `packages/kernel/src/execution/approval-service.ts`,
`createIsolationService` in `packages/kernel/src/execution/isolation-service.ts`. Test:
`manual remember binds a shown literal prefix and a failed write keeps one-time approval` in
`packages/kernel/tests/integration/approval-policy.test.ts`.

With global `approval_mode: "auto"`, an eligible request goes to the judge and
a valid allow produces no human elicitation. A valid deny does not turn into an
automatic human question. Only required context exceeding the judge window may
fall back to the same manual request when the judge is optional and its fallback
allows it. `untrusted` policy preserves human review. Production:
`createApprovalService` in `packages/kernel/src/execution/approval-service.ts`.
Test: `packages/kernel/tests/integration/judge-approval.test.ts`.

> Implemented at `packages/...`. Every claim below is anchored to a file and a named symbol or test. Open questions
> are collected in the final section.

## 1. Purpose

This subsystem is how a Clarvis run stops and asks a live human a question, and how the answer gets
back to the model or to whatever engine mechanism asked. One port — `Elicit`
(`packages/capability/src/elicit.ts`) — carries every such question: the model's own `ask_user`
tool call, a soft-budget escalation ask, and a question an
*external* MCP server raises through Clarvis acting as its MCP client. All of them funnel through the
same per-run FIFO serializer (`packages/loop/src/runtime/elicit-relay.ts`) so at most one prompt is
ever live for a given run at a time, and — one level up — a workflow's concurrently running leaders
share a second, tree-wide FIFO (`packages/workflows/src/elicit-mux.ts`) so at most one prompt is
ever live for the whole workflow tree.

The engine does not know which host surface presents a question. It hands `ElicitParams` to whatever `Elicit` callback the host supplied and awaits an
`ElicitRawResult`. The **kernel** is the first layer that turns this into something addressable by id
(`packages/kernel/src/runs/elicit-bridge.ts`), and `code` presents it as a modal block in the TUI.
A run with no human attached (such as a headless `code --prompt` invocation) still gets an answer for every question —
just always the same one, `decline` or `cancel` — so the engine's control flow never has to special-case
"nobody is listening."


A surface that can actually put a question on screen may also declare a **decision window** for the
model's own `ask_user` questions: how long one stays open once the frontend confirms the block is
really on screen. The interactive TUI declares 30 seconds. The window is a host policy carried with
the run-creation request, it starts only after that confirmation, and on expiry the kernel closes the
question by id and hands the decision back to the model as an honest "no answer" (§4.11). Nothing
else changes: plan and workflow reviews, soft-budget asks, relayed MCP
questions and headless runs keep the wait policies below, and an elapsed window is never an
approval.

## 2. Surface


### 2.1 The elicitation port (`@clarvis/capability`)

| Symbol | Kind | Location | Shape |
| --- | --- | --- | --- |
| `ElicitationAction` | type | `packages/capability/src/elicit.ts` | `"accept" \| "decline" \| "cancel"` |
| `ElicitationOutcome` | interface | `packages/capability/src/elicit.ts` | `{ action, answer?, noResponse?, noResponseReason? }` |
| `ElicitNoResponseReason` | type | `packages/capability/src/elicit.ts` | `"window_elapsed" \| "wait_bound_elapsed"` — which bound closed an unanswered question |
| `ElicitOrigin` | type | `packages/capability/src/elicit.ts` | `"model" \| "external"` — trusted provenance a host keys window policy on; never `kind` |
| `ElicitRequestedSchema` | interface | `packages/capability/src/elicit.ts` | `{ type: "object", properties: Record<string,{type:"string",enum?,description?}>, required: string[] }` |
| `ElicitParams` | interface | `packages/capability/src/elicit.ts` | `{ message, requestedSchema, kind?: "ask_user"\|"plan_review"\|"workflow_review"\|(string&{}), origin?: ElicitOrigin }` |
| `ElicitRawResult` | interface | `packages/capability/src/elicit.ts` | `{ action, content?: Record<string,unknown>, windowElapsed?: boolean }` — `windowElapsed` is host-internal and never crosses an MCP boundary |
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


### 2.4 The kernel elicit bridge

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitBridge` | `packages/kernel/src/runs/elicit-bridge.ts` | engine `elicit`, removable `onElicit`/`onSettled` observers, `respond`, `present` and `close` |
| `createElicitBridge(executionId, options?)` | `packages/kernel/src/runs/elicit-bridge.ts` | one bridge per run, ids namespaced `<executionId>:elicit:<n>`; `options.policy` is the run's `elicit_policy`, `options.runtime` a clock/scheduler seam |
| `ElicitWindowRuntime` | `packages/kernel/src/runs/elicit-bridge.ts` | `{ now(): number; schedule(task, delayMs): { cancel() } }` — monotonic in production (`performance.now` plus an unref'd `setTimeout`), injectable for deterministic tests |
| `MAX_ELICIT_WINDOW_MS` | `packages/kernel/src/runs/elicit-bridge.ts` | the longest delay a host timer honours; a declared window above it is refused where the policy is read, never silently shortened |

### 2.5 Protocol wire shapes (`@clarvis/protocol`)

| Symbol | Location | Shape |
| --- | --- | --- |
| `ElicitationRequest` | `ElicitationRequest` in `packages/protocol/src/runs.ts` | `{ id, execution_id, kind, prompt, schema?, window_ms? }` — `window_ms` is published only when a host window policy applies to the request |
| `ElicitationResponse` | `ElicitationResponse` in `packages/protocol/src/runs.ts` | `{ id, action: "accept"\|"decline"\|"cancel", content? }` |
| `ElicitWindowPolicy` | `ElicitWindowPolicy` in `packages/protocol/src/runs.ts` | `{ ask_user_window_ms?: number }` |
| `StartRunParams.elicit_policy?` | `StartRunParams` in `packages/protocol/src/runs.ts` | the host window policy carried by the run-creation request |
| `ElicitationPresentation` | `ElicitationPresentation` in `packages/protocol/src/runs.ts` | `{ id, presenter }` — a frontend confirms the question is really on screen, under its own identity |
| `ElicitationPresentationAck` | `ElicitationPresentationAck` in `packages/protocol/src/runs.ts` | `{ accepted, remaining_ms? }` — the projection after a confirmation; `accepted:false` means the id is unknown or already settled |
| `RunHandle.present(presentation)` | `RunHandle.present` in `packages/protocol/src/runs.ts` | confirms presentation for one pending id; a duplicate confirmation is idempotent and never restarts the deadline |
| `RunHandle.respond(response)` | `RunHandle.respond` in `packages/protocol/src/runs.ts` | answers a pending elicitation |
| `RunHandle.onElicit(handler)` | `RunHandle.onElicit` in `packages/protocol/src/runs.ts` | registers a handler for engine-raised questions |
| `RunHandle.onElicitSettled(handler)` | `RunHandle.onElicitSettled` in `packages/protocol/src/runs.ts` | observes a question the kernel retired, by id, and returns an unsubscribe; a frontend removes that prompt instead of answering it |
| `RunEvent` variant `elicitation_requested` | mapped at `packages/kernel/src/runs/map-events.ts` | `{ type, at, agent?, subagent_id?, question, options? }` |
| `RunEvent` variant `elicitation_resolved` | mapped at `packages/kernel/src/runs/map-events.ts` | `{ type, at, agent, subagent_id?, question, outcome, answer?, no_response?, options? }` |

Wire framing of these notifications over JSON-RPC (`N.runElicitation`, `N.runElicitationSettled`,
`M.runsRespond`, etc.) is the
concern of **kernel-transport-and-wire**; this document stops at the DTO shapes themselves.

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
| `ElicitRequestParams` | `packages/code/src/adapters/elicit-types.ts` | `{ id?, windowMs?, message, kind?, requestedSchema?, mode?, url? }` — a local mirror of the protocol type, kept dependency-free of the SDK; `id` is what a presentation confirmation names and `windowMs` marks a question the kernel windowed, whose countdown the block renders only from the projected remaining time |
| `ElicitResult` | `packages/code/src/adapters/elicit-types.ts` | `{ action, content? }` |
| `ElicitPresenter` | `packages/code/src/adapters/elicit-types.ts` | `() => Promise<number \| undefined>` — confirms presentation and yields the kernel's remaining projection, or `undefined` when no window applies |
| `elicitCountdownText(remainingMs)` | `packages/code/src/adapters/elicit-types.ts` | the discreet one-line countdown the block shows while the window is open, and only once the kernel has projected a remaining time — the block never renders a declared window as if it were counting |
| `ELICIT_NO_RESPONSE_TEXT` | `packages/code/src/adapters/elicit-types.ts` | the expired-state line (`"No response in time; decision returned to the model."`), plus the transcript wording in `packages/code/src/adapters/store.ts`, which labels an unanswered question `no answer:` rather than `answered:` |
| `ElicitSlot` | `packages/code/src/adapters/elicit-slot.ts` | `{ request, remaining, ask(params, present?), present(), resolve(result), cancelPending() }` — single-slot queue; `remaining` is the local projection of the kernel's deadline |
| `parseElicitForm(params)` | `packages/code/src/adapters/elicitation.ts` | derives a renderable `ElicitForm` from the wire params and projects recognized iteration-limit copy for the TUI |
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
  "kind": "ask_user",
  "origin": "model",
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


`origin` is the *trusted provenance* of a question, not presentation vocabulary: the engine's own
`ask_user` tool marks its requests `"model"` (`buildElicitParams`), and a relayed MCP question is
rebuilt as `"external"` at the trust boundary in `packages/loop/src/runtime/elicit-relay.ts` before it
reaches the host, so an external server cannot borrow the label by declaring it in its own params.
Host policy keys on `origin` — never on `kind`, and never on a field being absent, which the bridge
still frames as `ask_user` for presentation — and only `"model"` is eligible for the interactive
decision window of §4.11.

### 3.2 Protocol `ElicitationRequest` id format

`createElicitBridge` mints ids as `` `${executionId}:elicit:${seq++}` `` (`packages/kernel/src/runs/elicit-bridge.ts`), a
monotonically increasing per-run sequence, never reused within one bridge's lifetime.

### 3.3 `mapOutcomeToText` — the model-facing rendering of an outcome

`packages/loop/src/runtime/tools/ask-user-tool.ts`:

| `outcome.action` | `noResponse` | `noResponseReason` | Text |
| --- | --- | --- | --- |
| `accept` | — | — | `` `User answered: ${answer}` `` |
| `decline` | `true` | `"window_elapsed"` | the continuation guidance of §4.11 (`WINDOW_ELAPSED_GUIDANCE`) — decide with what is available, never read the silence as approval, do not repeat the question |
| `decline` | `true` | `"wait_bound_elapsed"` (or absent) | `"User did not respond within the wait window."` |
| `decline` | `false`/absent | — | `"User declined to answer the question."` |
| `cancel` | — | — | `"User dismissed the question without answering."` |

### 3.4 Trace entries

| Kind | Detail shape | Producer |
| --- | --- | --- |
| `elicitation_requested` | `ElicitationRequestedDetail` (`packages/capability/src/trace-kinds.ts`): `{ agent?, subagent_instance_id?, iteration_ref?, source: "ask_user"\|"tool_relay", question, options? }` | `handleAskUserCall` (`packages/loop/src/runtime/tools/ask-user-call.ts`, `source: "ask_user"`) and `buildElicitRelay`'s relay handler (`packages/loop/src/runtime/elicit-relay.ts`, `source: "tool_relay"`) |
| `user_question` | `UserQuestionDetail` (`packages/capability/src/trace-kinds.ts`): `{ agent, subagent_instance_id?, iteration_ref, question, outcome, answer?, no_response?, options? }` | `handleAskUserCall` (`packages/loop/src/runtime/tools/ask-user-call.ts`) |

These are the engine trace kinds; the kernel's `mapEntry`/`engineEventToProto` re-projects
`elicitation_requested` and `user_question` onto the protocol `RunEvent` variants
`elicitation_requested`/`elicitation_resolved` respectively (§2.5), forwarding `no_response` to the
`elicitation_resolved` event so a frontend, transcript or resume path can tell a window expiry from
the operational bound without re-deriving it.

A relayed MCP-server elicitation (`source: "tool_relay"`) is asymmetric with the `ask_user` path: only
`elicitation_requested` is ever recorded for it — `buildElicitRelay`'s relay handler
(`packages/loop/src/runtime/elicit-relay.ts`) has no call analogous to `handleAskUserCall`'s
second `trace.record("user_question", ...)`, so a relayed question never produces a `user_question` (and
therefore never an `elicitation_resolved` `RunEvent`) at all, while an `ask_user`-tool question always
produces both.


### 3.6 `code`'s wire-schema-to-form vocabulary

`fieldFromSchema`/`optionsFromSchema` (`packages/code/src/adapters/elicitation.ts`) turn one
`requestedSchema` property into an `ElicitField`: `optionsFromSchema` populates `options` from either a
JSON-Schema `enum` array (each value used as both `value` and `label`) or a `oneOf` array of
`{const, title?}` entries (`title` falling back to `const` as the label) — both populate the same
`options` list, so a form field cannot tell which one produced it. `fieldFromSchema` then picks `kind`:
`"select"` whenever `options` is non-empty, else `"boolean"`/`"number"` from the schema's `type`, else
`"text"`; a `boolean`-typed field with no `enum`/`oneOf` of its own synthesizes a yes/no option pair
(`{value:"true",label:"yes"}`/`{value:"false",label:"no"}`) so it renders as a choice like any other.

`PLAN_DECISION_LABELS` and `WORKFLOW_DECISION_LABELS`, selected by `params.kind` in
`packages/code/src/adapters/elicitation.ts`, rewrite a field's option labels for plan and workflow
reviews. `option.value`, which is sent back, remains unchanged.

An iteration soft-budget question has no dedicated wire `kind`, so `parseElicitForm` recognizes it
only when both the message contains `soft iterations limit` and the `continue` field offers the
`continue`/`stop` pair. That TUI projection renders `iteration limit` in the question and field
description without modifying the request, response values, engine vocabulary, or token-limit copy.
Production: `isIterationLimitForm` and `iterationLimitCopy` in
`packages/code/src/adapters/elicitation.ts`. Test: `parseElicitForm: iteration-limit copy is concise
only for the matching continue form` in `packages/code/tests/unit/elicitation.test.ts` and `an
iteration-limit question omits soft wording in the TUI` in
`packages/code/tests/integration/elicit-block-render.test.tsx`.

`initialValues(fields, choiceInitialSelection)` seeds each field's starting string value.
Its `ChoiceInitialSelection` parameter defaults to `"first"` (a `select`/`boolean` field with no
`default` starts on its first option), but a caller may pass `"none"` to leave every choice field blank
instead. `ElicitBlock` passes `"none"` for `plan_review` and `workflow_review`; an untouched
confirmation therefore reports the required field as missing instead of accepting whichever enum
member happens to be first. As a second fail-safe, `buildRunWorkflowHandler` authors the workflow
decision enum as `["cancel", "run"]` and treats every non-`run`/no-response outcome as cancellation.
The TUI presents the workflow decision as `[1] run workflow`, `[2] do not run`, independently
of the wire enum order. This display ordering does not preselect either option; pressing its number
submits that explicit decision immediately, while arrow navigation still requires Enter.
Production: `parseElicitForm` in `packages/code/src/adapters/elicitation.ts`.
Test: `packages/code/tests/integration/elicit-block-render.test.tsx` (workflow preflight numbered
choices, untouched confirmation and immediate explicit run/cancel selection).
`missingRequired(fields, values)` names every required field that is blank, or, for a
`number`-kind field, non-numeric. `buildContent(fields, values)` coerces raw string values
into the typed `content` object a response carries: a blank value is omitted from `content` entirely
(never sent as `""`), and a `number`-kind field whose value fails `Number.isNaN` is likewise dropped
rather than sent as `NaN`; a `boolean`-kind field's non-blank value becomes `raw === "true"`.
`acceptResult`/`DECLINE_RESULT`/`CANCEL_RESULT` are the three `ElicitResult` constants a
view resolves an elicitation with.


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
6. On success: `onResult` maps `accept` → `{action:"accept", answer: extractAnswer(content)}`; a raw
   `decline` carrying the host-internal `windowElapsed` marker (§4.11) becomes
   `{action:"decline", noResponse:true, noResponseReason:"window_elapsed"}`; any other raw action
   passes through unchanged.
7. On an `ElicitTimeoutError` specifically: `onNoResponse` →
   `{action:"decline", noResponse:true, noResponseReason:"wait_bound_elapsed"}`,
   logged as `capability.elicit_no_response` (`packages/capability/src/elicit.ts`). Any other rejection propagates —
   **except** that an `ElicitTimeoutError` racing a signal abort is itself preempted: `elicitWithClockPause`
   checks `signal?.aborted` before checking the error's type (`packages/capability/src/elicit.ts`), so a timeout that fires
   after the caller's own signal has already aborted rethrows unchanged rather than being swallowed
   (pinned by `packages/capability/tests/unit/elicit.test.ts`'s "a signal that aborts mid-wait" cases).
8. Back in `handleAskUserCall`: if the promise rejects and the call's `signal` is aborted, the outcome
   is `{kind:"cancelled"}` (no trace, no model-facing text — the run is unwinding) (`packages/loop/src/runtime/tools/ask-user-call.ts`);
   otherwise a non-abort rejection becomes an `error` result reading
   `` `could not reach the user (${reason}).` ``.
9. On success (including timeout-as-decline): records `user_question` — carrying `no_response` when the
   question ended unanswered — and returns `envelope.ok(mapOutcomeToText(outcome))`.
10. `buildAskUserHandler` maps `{kind:"cancelled"}` to a cancelled `HandlerVerdict`, else a `result`
    whose `progress` is `true` unless `oc.error === true` (`packages/loop/src/runtime/capabilities/ask-user.ts`).

### 4.2 Wait-bound layering

The configured wait and three wrappers/bounds can participate in one elicitation:

| Layer | Bound | Applied by |
| --- | --- | --- |
| Configured run wait | `request.elicit_wait_ms ?? CLARVIS_DEFAULT_ELICIT_WAIT_MS` (default 1,800,000 ms) | supplies ordinary `Elicit` call sites (`packages/loop/src/runtime/orchestrator.ts`) |
| Enforcement | `withElicitWaitBound(elicit, graceMs=1000)` wraps the run's `elicit` once, at orchestrator construction, adding `ELICIT_WAIT_GRACE_MS` (1000 ms) grace so the *outer* bound fires slightly after the transport's own deadline (`packages/loop/src/runtime/tools/ask-user-tool.ts`, `packages/loop/src/runtime/orchestrator.ts`) | `boundPromise` (`packages/loop/src/runtime/support/bounded.ts`) |
| Interactive decision window | `StartRunParams.elicit_policy.ask_user_window_ms`, applied only to a model-originated `ask_user` question confirmed on screen | `createElicitBridge`'s monotonic window timer (`packages/kernel/src/runs/elicit-bridge.ts`), with the run `elicit_wait_ms` ceiling still above it |

`withElicitWaitBound`'s special cases (`packages/loop/src/runtime/tools/ask-user-tool.ts`, pinned by
`packages/loop/tests/unit/elicit-wait-bound.test.ts`): a `timeoutMs` of `0` is passed through as `0`
(immediate `ElicitTimeoutError`, no grace added); an **omitted** `timeoutMs` leaves the wait fully
unbounded (no race at all); the wait is clamped to the 32-bit `setTimeout` ceiling
(`MAX_TIMER_DELAY_MS`) rather than overflowing to an near-instant fire
(`packages/loop/src/runtime/support/bounded.ts`); an already-aborted signal settles via `onAbort` before the inner promise can
ever win, and the inner elicit is never invoked in that case
(`elicit-wait-bound.test.ts` — "rejects immediately on an already-aborted signal without invoking the
elicit").

None of the bounds above lives inside the kernel's `ElicitBridge` (§4.4) itself: `createElicitBridge`'s
`elicit` (`packages/kernel/src/runs/elicit-bridge.ts`) never reads `opts.timeoutMs`, so every bound in
the table is applied by a caller that wraps the bridge's `elicit`. The bridge owns one timer of a
different kind — the interactive decision window of §4.11 — but only when the run declared a window
policy *and* a frontend confirmed the question is on screen; with no policy, or with no confirmation,
the bridge alone would still wait forever on an unresolved question.

### 4.3 The per-run relay/serializer (`buildElicitRelay`)

`buildElicitRelay` (`packages/loop/src/runtime/elicit-relay.ts`) builds a single `createElicitSerializer()` FIFO
(a promise chain that runs each queued `job` after the previous settles, success or failure)
shared by two consumers:

- `serializedElicit`: what the built-in `ask_user` tool and soft-budget ask call — every direct
  call is wrapped in `serialize(() => elicit(params, opts))`.
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
| entry pending | `bridge.respond({id, action, content?})` | entry and abort listener removed, any window timer retired, settlement observers notified once, promise resolves with `{action, content?}` |
| entry pending | the elicit call's `opts.signal` aborts | entry and listener removed, settlement observers notified, promise resolves as `{action:"cancel"}` |
| bridge closed or signal already aborted | `elicit` called | resolves as cancellation without publishing or retaining a question |
| bridge open | `close` called | retires the bridge, cancels pending questions (and their window timers) and releases observer references |
| policy declares a window above the host timer ceiling | `windowFor` (`MAX_ELICIT_WINDOW_MS`) | publishes no `window_ms` and arms nothing — a delay the timer cannot honour carries no window at all |
| entry pending with a window policy, not yet confirmed | `bridge.present({id, presenter})` — first valid confirmation | starts the id's one monotonic deadline of `window_ms`, schedules its expiry, answers `{accepted:true, remaining_ms}` |
| entry pending, window already started | `bridge.present(...)` again — a duplicate, another observer, a reconnect or a remount | idempotent: answers `{accepted:true, remaining_ms}` with the current remaining; the deadline is never restarted |
| entry absent (unknown/already-settled id) | `bridge.present(...)` | answers `{accepted:false}`; nothing restarts and no question is revived |
| entry pending with a started window | the deadline elapses | entry removed, timer retired, promise resolves `{action:"decline", windowElapsed:true}`; a later answer or presentation for that id is a no-op |
| entry absent (unknown/already-settled id) | `respond` called | no-op — `item === undefined` returns silently |
| — | a registered handler throws | swallowed by `deliver`'s `try/catch`; "cannot break or settle the engine's pending question" |

This buffered-delivery behavior — a question raised before any client ever calls `onElicit` is not
lost, and is delivered the moment the first handler attaches — is pinned by
`packages/kernel/tests/unit/elicit-bridge.test.ts` ("an elicitation raised before onElicit
registration is delivered when the handler attaches").

The bridge registers abort cleanup before delivering to observers, so synchronous cancellation in a
handler cannot leave a pending entry behind. Each registration returns an unsubscribe function.
`RunHandle.onElicitSettled`, when supplied by a managed handle, exposes settlement to a hosting pump
without a second consumer of run events. `createManagedRun` closes the bridge when execution ends.

The bridge admits at most 64 pending questions with 8 MiB of aggregate encoded requests, plus 16
observers per channel. Saturation rejects new work with `resource_exhausted`; admitted questions
remain intact. A handler exception cannot prevent other observers or settlement. These limits do
not replace the caller's elicitation timeout or grant policy.

Production: `createElicitBridge` in [elicit-bridge.ts](../../packages/kernel/src/runs/elicit-bridge.ts),
`createManagedRunWithRuntime` in [managed-run.ts](../../packages/kernel/src/runs/managed-run.ts).
Test: the pre-aborted, synchronous-cancellation, removable-observer and pending-budget cases in
[elicit-bridge.test.ts](../../packages/kernel/tests/unit/elicit-bridge.test.ts), and the window cases
in the same file (first confirmation starts, duplicates never restart, a never-presented question
never expires, an unknown id is `accepted:false`, a late answer after the deadline is ignored).

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

The same connection is what tells that client the kernel retired a question, so a frontend is never
left holding a prompt nobody can answer: the server's pump also subscribes
`handle.onElicitSettled` and pushes `N.runElicitationSettled` carrying
`{ execution_id, elicitation_id }` (`packages/kernel/src/transport/server.ts`), and the client
validates both members, drops a request still sitting in `pendingElicits` under that id, and calls
every `RunHandle.onElicitSettled` observer of that run
(`packages/kernel/src/transport/client.ts`). A settlement is a closure, never an answer: it names
the question the kernel settled — answered, expired by its window, or torn down with the run — and
the frontend's own answer path is the only one that can accept or decline. The wire framing of that
notification is owned by [kernel transport](../hosts/kernel-transport.md) (INV-326).

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
`App` calls the active viewport handle's `returnToTail()` before hiding the composer, retains
the composer as a painted but keyboard-inert bridge until `active-elicitation` owns a visible
transcript row, then requests the tail again before removing that bridge. A dirty full-page editor
pauses this transition without polling renderer frames; the retained request restarts it reactively
when the overlay closes. `TranscriptViewport.returnToTail` mounts the newest row window, waits for
native layout, scrolls to the native bottom and releases its transaction. `App` repeats the request
across the question's actual layout transition. Clearing the request restores the composer and
requests the changed tail again; native sticky-bottom remains the follow authority.
A confirmation cannot therefore be stranded in an unmounted live tail while the screen remains
anchored to older history, no transition frame contains neither interaction surface, and native
scrollbar movement is not captured after the transition settles. Production:
`packages/code/src/views/App.tsx` (`elicitComposerHidden`, `revealHistoryTail`, elicitation effect),
`packages/code/src/views/ElicitBlock.tsx` (`active-elicitation`),
and `packages/code/src/views/transcript/TranscriptViewport.tsx` (`returnToTail`, `onFrame`). Tests:
`packages/code/tests/integration/app-shell-render.test.tsx` ("an elicitation returns an old reader to
the live tail before hiding the composer" and "a pending elicitation does not discard an in-progress
config edit") and `packages/code/tests/integration/transcript-window-render.test.tsx` ("wheel-up reveals one page on user intent and idle frames never rewind repeatedly"). The physical-history contract is owned by
[hosts/code-transcript-stability.md](../hosts/code-transcript-stability.md) (viewport transactions).

`kernel-run-client.ts`'s `wireElicit` (`packages/code/src/adapters/kernel-run-client.ts`) is the piece that turns a protocol
`ElicitationRequest` into the `ElicitRequestParams` the slot/block consume, and turns the UI's
`ElicitResult` back into an `ElicitationResponse` sent via `handle.respond`. If the host's own
`onElicit` callback throws, `reportElicitFailure` logs `elicit.handler.failed` and still
answers `{action:"cancel"}` — "without this the prompt simply cancels, and the run reads as if the user
had dismissed it: the defect and the deliberate refusal are indistinguishable in the transcript"
(comment).

A question the kernel retires is never answered by that path. `wireElicit` registers
`handle.onElicitSettled` before handing the question to the UI, forwards the id to the host through
`KernelRunClientCallbacks.onElicitSettled`, and releases the subscription once the question is done.
The host (`packages/code/src/runtime.tsx`) calls `ElicitSlot.settle(id)`, which closes the prompt only
if that exact id is the one on screen and resolves the waiting `ask` with the internal
`ElicitResult.settled` marker. `wireElicit` sees the marker and returns without `respond`: the kernel
already retired the id, so an answer would be a no-op round trip against a run that may itself be
gone. Settling can therefore remove a prompt a human never answered — it is not an answer, and only
the human's own `resolve` ever accepts or declines one.


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
`Elicit` transport is treated as a **request-validation failure** rather than a per-question decline.
A headless client or disabled relay with an installed callback can still auto-answer a question (§1, §6).

### 4.11 The interactive `ask_user` decision window

A surface that can actually put a question on screen may declare a **decision window** for the
model's own `ask_user` questions: how long one stays open once the frontend confirms the block is
really on screen. `code`'s interactive start path declares 30,000 ms (`ASK_USER_WINDOW_MS` in
`packages/code/src/adapters/kernel-run-client.ts`), carried with the run-creation request as
`StartRunParams.elicit_policy` — including a hosted execution, because the policy travels with the
params the caller starts the run with. The kernel that runs the engine owns the deadline; no
frontend does.

**Eligibility (provenance, not omission).** Only a request whose params are marked `origin: "model"`
(the engine's own `ask_user` tool) **and** whose `kind` is `"ask_user"` can be windowed. Params with no
`origin`, or `origin: "external"` (a relayed MCP question, rebuilt at the relay boundary, §3.1), never
window — even when they name `kind: "ask_user"`, which is presentation vocabulary rather than
provenance. Plan reviews, workflow reviews and the soft-budget ask are not
windowed and keep the wait policies of §4.2. A policy with an absent, non-integer, non-positive or
unrepresentable `ask_user_window_ms` publishes no window at all: a duration above
`MAX_ELICIT_WINDOW_MS` — the longest delay a host timer honours
(`packages/kernel/src/runs/elicit-bridge.ts`) — is refused where the policy is read, because a host
must never promise time it cannot grant.

**Publication.** When the policy applies, the published `ElicitationRequest` carries `window_ms` — a
duration, so no wall-clock synchronization between a frontend and a remote kernel is assumed. The
window is not running yet: the request may sit in a queue, wait for a client to attach, or wait for a
paint.

**One deadline, started by the presentation.** The frontend confirms with
`RunHandle.present({id, presenter})` only after the block is really rendered — a visibility barrier,
never merely receiving the notification (§4.8's shell transition is that seam in `code`). The kernel
accepts the first valid confirmation for that id, starts a monotonic (`performance.now`) deadline of
`window_ms`, and answers with `ElicitationPresentationAck` carrying the remaining projection.
Duplicate confirmations — another observer, a reconnect, a remounted block — are idempotent: they
report the original deadline's remaining time and never restart it. Confirming an unknown or
already-settled id answers `accepted: false`. A question that is never presented never expires.

**Expiry closes that question, once, by id.** At the deadline the kernel settles the pending entry
with `{action: "decline", windowElapsed: true}` — the internal marker of
`ElicitRawResult.windowElapsed` — retires its timer, and leaves the id settled forever: a late answer,
a late presentation or a duplicate confirmation cannot reopen it. A real answer accepted before the
deadline retires the timer and wins; an abort retires it too. Every settlement — an answer, an
elapsed window, a torn-down run — reaches a frontend that was showing the question as a closure by
id (`RunHandle.onElicitSettled`, §4.8), so the prompt disappears instead of staying on screen with
nothing left to answer.

**The model gets an honest no-answer.** The engine maps the marker to
`{action:"decline", noResponse:true, noResponseReason:"window_elapsed"}` and the tool result becomes
the continuation guidance (§3.3): decide with the information available, stay inside the authorized
scope, do not read the silence as approval, do not immediately repeat the question. This is distinct
from `wait_bound_elapsed` (the operational bound of §4.2, whose existing wording stays), from a human
decline and from a cancellation, and it is never an `accept`: no synthetic answer reaches the model. The marker is host-internal: a relayed MCP reply
is rebuilt as `{action, content}`, so `windowElapsed` never crosses the MCP boundary.

**Acceptance matrix.**

| Situation | Result |
| --- | --- |
| Frontend confirms presentation; the human answers in time | question settles with the answer; timer retired; no reason recorded |
| Frontend confirms; no answer before the deadline | kernel settles `decline` + `windowElapsed`; model reads the continuation guidance; the UI removes the question |
| Human answers after the deadline | ignored — the id is already settled, and the model keeps the no-answer guidance |
| Frontend never confirms presentation | no window starts; the question keeps the ordinary policies (wait bound, abort, run teardown) |
| Duplicate / repeated presentation confirmation | `accepted: true` with the current remaining projection; the deadline is unchanged |
| Presentation confirmation after settlement | `accepted: false`; nothing restarts |
| Presentation confirmation for an unmarked or `"external"` request | `accepted: true`, no `remaining_ms`, no timer — never a window |
| Policy declaring a window above the host's timer ceiling | no `window_ms` is published and no timer is armed; the question keeps the ordinary policies of §4.2 |
| Reconnect or remount while the question is pending | the pending request is replayed with its `window_ms`; a fresh confirmation reports the original deadline's remaining time, not a restart |
| Run aborted or bridge closed while the window is open | the question is cancelled and its timer retired with it |

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
handler is registered; a question the kernel settles first (`N.runElicitationSettled`) is removed
from that buffer instead, so no stale prompt is ever delivered.
Production: `packages/kernel/src/transport/client.ts`.
Test: `packages/kernel/tests/contract/transport-codecs.test.ts` ("buffers an elicitation emitted
before runs.start returns", "drops a buffered question the kernel settles before any handler
attaches", "keeps a buffered question when the settlement names another run").

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

**ELI-09.** A decision window applies only to a question whose params are marked `origin: "model"`
and whose `kind` is `"ask_user"`, and only when the run declared a positive
`elicit_policy.ask_user_window_ms` that this host can actually measure — one at most
`MAX_ELICIT_WINDOW_MS`, since a longer delay is not honoured by a host timer and would close the
question almost immediately. An unmarked request, a relayed external one, or one that merely
names `kind: "ask_user"` never receives `window_ms`, never expires by window, and never receives the
window's continuation guidance; plan reviews, workflow reviews, soft-budget
asks and headless runs keep their existing wait policies.
Production: `packages/kernel/src/runs/elicit-bridge.ts` (`windowFor`, `MAX_ELICIT_WINDOW_MS`),
`packages/loop/src/runtime/elicit-relay.ts` (`buildElicitRelay`'s relay rebuild).
Test: `packages/kernel/tests/unit/elicit-bridge.test.ts` (policy, provenance and forged-kind cases,
the unrepresentable-window cases above the ceiling, and the ceiling itself granted),
`packages/loop/tests/unit/elicit-relay.test.ts` (a relayed question is rebuilt as `origin: "external"`).

**ELI-10.** The window starts on the first valid presentation confirmation for that id and never
before: a question that was never confirmed never expires, and no duplicate, repeated or
reconnecting confirmation restarts the deadline — each reports the original deadline's remaining
projection, and a confirmation for an unknown or settled id is `accepted: false`.
Production: `packages/kernel/src/runs/elicit-bridge.ts` (`present`),
`packages/kernel/src/runs/managed-run.ts` (`present` on the run handle).
Test: `packages/kernel/tests/unit/elicit-bridge.test.ts` (duplicate confirmation without restart,
never-presented question, unknown-id confirmation).

**ELI-11.** An elapsed window settles exactly that question id, once: the pending entry is removed,
its timer retired, and the raw `{action:"decline", windowElapsed:true}` and the derived outcome agree.
A human answer or an abort that the kernel accepts before the deadline wins, and every later answer,
presentation or duplicate for that id is a no-op.
Production: `packages/kernel/src/runs/elicit-bridge.ts` (`present`/`finish`).
Test: `packages/kernel/tests/unit/elicit-bridge.test.ts` (attested expiry, early versus late answer,
human cancel, duplicate after settlement).

**ELI-12.** A window expiry is never an answer and never authority: the model reads the continuation
guidance rather than a wait-window note, the outcome carries `noResponseReason: "window_elapsed"`
distinct from `"wait_bound_elapsed"`, from a human decline and from a cancellation, and the expiry
admits no operator evidence. The internal marker never crosses an MCP boundary, and the reason
survives the trace record, the public `elicitation_resolved` event, the transcript and the agent
projection the same trace feeds.
Production: `packages/loop/src/runtime/tools/ask-user-tool.ts` (`mapOutcomeToText`,
`WINDOW_ELAPSED_GUIDANCE`), `packages/loop/src/runtime/tools/ask-user-call.ts`,
`packages/loop/src/runtime/elicit-relay.ts`, `packages/trace/src/trace-mapper.ts`,
`packages/code/src/adapters/store.ts` (`elicitationOutcomeText`),
`packages/supervision/src/projection.ts` (the `user_question` line names the bound).
Test: `packages/loop/tests/unit/ask-user-tool.test.ts` (three distinct no-answer texts),
`packages/loop/tests/unit/ask-user-call.test.ts` (`no_response` recorded, absent for a human
decline), `packages/loop/tests/component/execute-run.test.ts` ("does not admit a window expiry as
operator evidence and hands the model the guidance"),
`packages/kernel/tests/integration/transport.test.ts` (`runs.present` keeps the reason on the wire),
`packages/code/tests/unit/store-status.test.ts` (the transcript names the window),
`packages/supervision/tests/unit/projection.test.ts` (a window expiry reads as an unanswered
question, not as a refusal).

**ELI-13.** The interactive TUI confirms a question's presentation only after the block is really on
screen, arms no timer of its own and never decides the outcome: it projects the kernel's remaining
time as a discreet countdown, and the question disappears when the kernel settles it — the closure
arrives by id through `RunHandle.onElicitSettled`, closes exactly that prompt through
`ElicitSlot.settle`, and is never answered. A settled question never reappears after a remount or
reconnect, and a question the kernel never projected carries no countdown at all: the block renders
no remaining time it was not given.
Production: `packages/code/src/adapters/elicit-slot.ts` (`present`, `remaining`, `settle`),
`packages/code/src/views/ElicitBlock.tsx` (countdown and expired state),
`packages/code/src/views/App.tsx` (the visibility barrier),
`packages/code/src/adapters/kernel-run-client.ts` (`wireElicit`, `ASK_USER_WINDOW_MS`),
`packages/kernel/src/transport/client.ts` and `packages/kernel/src/transport/server.ts` (the
settlement notification of §4.8).
Test: `packages/code/tests/unit/elicit-slot.test.ts` (the kernel's projection arms the countdown, the
slot arms no timer by itself, and a settlement by id closes only its own question),
`packages/code/tests/integration/elicit-block-render.test.tsx` (countdown, expired state, no
countdown without a projection),
`packages/code/tests/integration/app-shell-render.test.tsx` (the block is confirmed only once it is
really visible — not while a dirty overlay still hides it — and the countdown follows the projected
remaining time),
`packages/code/tests/component/kernel-run-client.test.ts` (the settlement
closes the question for the UI and sends no answer back),
`packages/kernel/tests/integration/transport.test.ts` (each settled windowed question reaches the
direct client under its own id).

## 6. Failure modes and degradation

| Failure | Where handled | Result |
| --- | --- | --- |
| `ask_user` called with invalid arguments (fails `askUserTool.inputSchema`) | `openCallEnvelope`'s `envelope.invalid` (`packages/loop/src/runtime/tools/ask-user-call.ts`) | error tool result; `askUser` is **never invoked** |
| The wait bound elapses with no answer | `ElicitTimeoutError` swallowed by `elicitWithClockPause` (`packages/capability/src/elicit.ts`) | `{action:"decline", noResponse:true, noResponseReason:"wait_bound_elapsed"}` — the model reads this as an ordinary decline, never as an exception |
| The interactive decision window elapses with no answer (§4.11) | the bridge's monotonic deadline timer (`packages/kernel/src/runs/elicit-bridge.ts`) | `{action:"decline", windowElapsed:true}` → `noResponseReason:"window_elapsed"` and the continuation guidance; never evidence, and distinct from the wait-bound row above |
| A declared window is longer than the host's timer ceiling | `windowFor` (`packages/kernel/src/runs/elicit-bridge.ts`, `MAX_ELICIT_WINDOW_MS`) | no `window_ms` is published and no timer is armed — the question keeps the ordinary policies instead of expiring the moment it appears |
| A presentation confirmation arrives for an unknown or already-settled id | `pending.get(id) === undefined` short-circuit (`packages/kernel/src/runs/elicit-bridge.ts`) | `{accepted:false}` — nothing restarts and no question is revived |
| A windowed question is never presented (no client attached, no paint, an observer-only run) | the window only starts in `present` (`packages/kernel/src/runs/elicit-bridge.ts`) | no window runs; the question keeps the ordinary policies (wait bound, abort, teardown), and a block that received no projection renders no countdown |
| The frontend's local countdown reaches zero | `remaining` alone (`packages/code/src/adapters/elicit-slot.ts`) | presentation only — the kernel's settlement remains the authority and removes the question; the local countdown decides nothing |
| The run's own signal aborts while `askUser` is pending | `handleAskUserCall`'s catch checks `signal?.aborted` (`packages/loop/src/runtime/tools/ask-user-call.ts`) | `{kind:"cancelled"}` — no trace record, no tool-result text; the run is unwinding |
| `askUser` rejects for any other reason (transport failure, non-abort, non-timeout) | same catch, non-abort branch (`packages/loop/src/runtime/tools/ask-user-call.ts`) | error tool result `` `could not reach the user (${reason}).` ``, `error: true` |
| A relayed MCP-server elicitation (`buildElicitRelay`'s `relay`) times out | caught specifically for `ElicitTimeoutError` (`packages/loop/src/runtime/elicit-relay.ts`) | `{action:"decline"}` returned to the MCP server — never propagated as a throw |
| A relayed elicitation fails for a non-timeout reason | same catch, `else` branch (`packages/loop/src/runtime/elicit-relay.ts`) | rethrown — the MCP dispatch layer sees a real failure |
| A registered kernel-bridge `onElicit` handler throws | `deliver`'s try/catch (`packages/kernel/src/runs/elicit-bridge.ts`) | swallowed; "cannot break or settle the engine's pending question" — every other handler and the pending state are unaffected |
| An unknown or already-answered `respond(id, ...)` | `pending.get(id) === undefined` in `packages/kernel/src/runs/elicit-bridge.ts` | no pending question is settled |
| Workflow review is untouched, declined, cancelled, times out, or has no interactive channel | `ElicitBlock` leaves the choice blank; `buildRunWorkflowHandler` accepts only explicit `decision === "run"`, passes the effective run wait bound, and maps every other resolution separately | workflow is not started; zero leaders registered; the tool result distinguishes decline, dismissal, invalid content and no-response timeout; settled waits log `workflow.review_resolved`, and timeout also logs `capability.elicit_no_response` |
| `code`'s own `onElicit` callback throws | `reportElicitFailure` (`packages/code/src/adapters/kernel-run-client.ts`) | logs `elicit.handler.failed` (warn) and still answers `{action:"cancel"}` |
| `code` invoked headlessly (`--prompt`, no interactive UI) | `handle.onElicit` registered in `packages/code/src/runtime.tsx` (`runPrintMode`) | every question is logged to stderr and auto-declined via `handle.respond({id, action:"decline"})` |
| Elicitation disabled or no `elicit` supplied at all (`shape.userInputEnabled === false`) | `buildElicitRelay`'s `relayEnabled` guard (`packages/loop/src/runtime/elicit-relay.ts`) | `relay` is `undefined`; `serializedElicit` falls back to the raw (possibly `undefined`) `elicit` — callers that need one and find it absent are a capability-construction concern outside this document |
| A run needs a human (`shape.userInputEnabled === true`) but no `elicit` callback was supplied at all | `packages/loop/src/runtime/execute-run.ts`, checked immediately after `deriveRunShape` | the run never starts: throws `ValidationError("elicitation_not_supported", ...)` — the only elicitation failure resolved at request validation rather than per-question (§4.10) |
| `elicit_wait_ms` request param fails validation | `classifyIssue` (`packages/loop/src/validation/request/parsing.ts`) | `invalid_elicit_wait` request error code |
| A pooled (stdio + `shared`) MCP connection is acquired with a `relay` | `ConnectionManager`'s `openFresh(o, signal, pooled=true)` (`packages/mcp-client/src/connection-manager.ts`) | the `relay` is dropped — opened `...(o.relay && !pooled ? { relay: o.relay } : {})` — so the connection advertises no `elicitation` capability at all; `warnRelayDropped` logs `mcp.pool.relay_dropped` once per server name, not once per acquire |

## 7. Coupling

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
  (`packages/kernel/src/runs/elicit-bridge.ts`) — it is the type-level bridge between the two.
- `@clarvis/kernel`'s `managed-run.ts` constructs one `ElicitBridge` per run
  (`packages/kernel/src/runs/managed-run.ts`) and wires `bridge.elicit` into the `ManagedRunContext.elicit` the engine's
  `execute` closure receives; `RunHandle.onElicit`/`respond` on the returned handle forward
  straight to `bridge.onElicit`/`bridge.respond`.
- `@clarvis/mcp-client`'s `client.ts` is the only place `ElicitRequestSchema`/`ElicitResult` from the
  MCP SDK are named for elicitation (`packages/mcp-client/src/client.ts`) — `@clarvis/loop`'s `open-tool-pool.ts` threads an
  `ElicitationRelay` through to it per connection (`packages/loop/src/runtime/open-tool-pool.ts`), never constructing the
  SDK types itself.
- `code`'s `adapters/elicit-types.ts` is a deliberately independent local mirror of the protocol shapes
  — "so code carries no `@modelcontextprotocol/sdk` dependency" (`packages/code/src/adapters/elicit-types.ts`) — with
  `kernel-run-client.ts`'s `wireElicit` as the sole translation point between the protocol
  `ElicitationRequest`/`Response` and this local vocabulary.
- `@clarvis/protocol` owns `ElicitWindowPolicy`/`StartRunParams.elicit_policy`, the
  `ElicitationPresentation`/`Ack` pair and `RunHandle.present` (`packages/protocol/src/runs.ts`);
  `@clarvis/kernel` consumes them for the window (`packages/kernel/src/runs/elicit-bridge.ts`) and
  `code` declares the 30 s policy on its own start path (`packages/code/src/adapters/kernel-run-client.ts`), so
  the window needs neither a capability-to-protocol type edge nor a second copy of the vocabulary.
- A workflow manager's leaders present through the manager's own bridge
  (`packages/kernel/src/workflows/workflows-service.ts`, which derives the manager run's elicitation
  options from the same `StartRunParams` and lends them to every leader through `createElicitMux`), so
  one `elicit_policy` covers the leaders of the same interactive experience without a per-leader
  policy.

**Depended on by:**

- The soft-budget escalation ask (`buildSoftLimitAsk`, wired at
  `packages/loop/src/runtime/entry-inputs.ts`) shares the same serialized `elicit` and the same
  `elicitWaitMs` derivation as `ask_user` — it is a second consumer of the one per-run FIFO, out of
  scope for this document's detail (see the budget/soft-limit document) but coupled here through
  `elicitWithClockPause` and `createElicitSerializer`.
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
- ~~**`ElicitBridge.elicit` with an already-aborted signal.**~~ Resolved by the preflight cancellation
  and listener-before-delivery contract in §4.4, covered by the pre-aborted and synchronous observer
  cancellation tests in [elicit-bridge.test.ts](../../packages/kernel/tests/unit/elicit-bridge.test.ts).
- ~~**Remote-transport elicit-buffering test coverage (ELI-05).**~~ **Resolved:**
  `packages/kernel/tests/contract/transport-codecs.test.ts` now pins the buffering path directly —
  a question emitted before `runs.start` resolves is delivered to the handler that attaches later, a
  question the kernel settles first leaves the buffer empty, and a settlement naming another run
  leaves the buffered question alone.
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
