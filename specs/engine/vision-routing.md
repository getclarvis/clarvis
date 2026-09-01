# How an image reaches a model

> Implemented at `packages/loop/src/runtime/vision-prepass.ts`,
> `packages/loop/src/runtime/entry-seed.ts`,
> `packages/loop/src/runtime/subagents/build-subagent-input.ts`,
> `packages/tools/src/tools/read-image.ts`, `packages/code/src/core/attachments.ts`,
> `packages/code/src/views/input/attachments.ts`, and the packages/files each of these imports from
> or is imported by. Every claim below is anchored to a file and line. Open questions are collected
> in the final section.

## 1. Purpose

An image can enter a Clarvis model context two ways: a user attaches or `@mentions` one in `code`'s
composer, or an agent calls `read_image` on a workspace or admitted run-scratch file. Composer images
become engine `ImagePart`s in a `user` message; `read_image` instead produces `ToolResultImage`s on
the tool-result message (`packages/loop/src/runtime/tools/builtin/toolset.ts:144-157`). Either route
requires a model that can see, but the automatic prepass concerns only composer images on a blind
entry model — the run's `entry` profile may declare no `vision` capability
(`packages/loop/src/runtime/entry-seed.ts:135`).

`vision-prepass.ts` exists for the case where the entry agent's model is blind but the operator has
also configured a separate model that *can* read images. It is a single, tool-less, agent-less
completion, spliced into the entry agent's context as a `[image analysis]` message
(`packages/loop/src/runtime/vision-prepass.ts:100,195-205`), run once per turn before the entry agent's
own loop starts (`packages/loop/src/runtime/orchestrator.ts:644-653`). Its stated reason for being a
call rather than a sub-agent: "Reading an image needs no tool surface, no spawn identity and no
iteration budget; running a nested agent to get one put an unaddressable child on the core run path and
charged an entire agent loop for a description." (`packages/loop/src/runtime/vision-prepass.ts:75-78`).

Two other things share the image vocabulary this file is built on and are described here only far
enough to place the prepass in context: `read_image` (`packages/tools/src/tools/read-image.ts`), the
tool a sighted agent uses to look at a workspace or admitted scratch file directly, and `delegate_task`'s `image_refs`
parameter (`packages/loop/src/runtime/subagents/delegate-task.ts`,
`packages/loop/src/runtime/subagents/lead-tools.ts`,
`packages/loop/src/runtime/delegation.ts:221-222`), the *other* route an image can take — handed by a
possibly-blind lead to a vision-capable Sub-agent instead of (or alongside) the automatic prepass. Full
description of delegation and of provider/model-catalog resolution belongs to their own documents;
this document covers only the seam each shares with the prepass (`collectTurnImages`, the `ImagePart`
family, capability gating).

## 2. Surface

### Vision prepass

| Symbol | Location | Shape |
| --- | --- | --- |
| `runVisionPrepass(p: VisionPrepassArgs): Promise<void>` | `packages/loop/src/runtime/vision-prepass.ts:112` | the entry point; no return value, all effects are side effects (message append, trace, ledger, usage) |
| `VisionPrepassDeps` | `:16-20` | `{ env: EnvConfig; llm: LLMProvider; logger?: Logger }` |
| `VisionPrepassArgs` | `:28-36` | `{ signal, deps, request: RunRequest, trace: TracePort, ledger: TokenLedger, seed: EntrySeed, accounting: UsageAccounting }` |
| `VISION_SYSTEM_PROMPT` | `:39-43` | the fixed system prompt for the reading call |
| `VISION_MAX_OUTPUT_TOKENS` | `:46` | `4_096` — the hard output ceiling for the reading |
| `partialUsageOf(err): LLMUsage \| undefined` | `:215-218` | reads `(err as { partialUsage? }).partialUsage`, so a failed call can still report billed tokens |
| `errorMessage(err): string` | `:221-223` | `err instanceof Error ? err.message : String(err)` |

### Entry seed (produces the prepass's gating inputs)

| Symbol | Location | Shape |
| --- | --- | --- |
| `buildEntrySeed(a): EntrySeed` | `packages/loop/src/runtime/entry-seed.ts:126` | composes the entry agent's opening messages |
| `EntrySeedDeps` | `:14-21` | `{ workspaceRoot, continuation?, runCapabilities?, seedBlocks?, seedMarkers? }` — the parameter type `buildEntrySeed`'s argument is built from |
| `EntrySeed` | `:30-34` | `{ entryMessages: LiveSeedEntry[]; turnImages: ImagePart[]; entryStripsImages: boolean }` |
| `collapseHistoricalImages(entry)` | `:77-85` | replaces prior-turn image parts with `[image from an earlier turn]` text |

### Image vocabulary (`build-subagent-input.ts`, `@clarvis/capability`, `@clarvis/tools`)

| Symbol | Location | Shape |
| --- | --- | --- |
| `collectTurnImages(messages): ImagePart[]` | `packages/loop/src/runtime/subagents/build-subagent-input.ts:99` | every image part in every `user` message, in message/part order |
| `userText(messages): string` | `:84` | concatenated text of every `user` message |
| `ImagePart` (engine) | `packages/capability/src/api.ts:9-13` | `{ type: "image"; image: string; mediaType?: string }` |
| `ContentPart` (engine) | `:17` | `TextPart \| ImagePart` |
| `ToolResultImage` | `:81-84` | `{ data: string; mediaType: string }` — an image *returned by a tool* |
| `ImagePart` (tools) | `packages/tools/src/tools/content.ts:9-13` | `{ type: "image"; data: string; mimeType: string }` — tool-result shape, different field names |
| `ImagePart` (protocol) | `packages/protocol/src/runs.ts:23-30` | `{ type: "image"; mime: string; data?: string; ref?: string }` — wire shape, inline bytes or a workspace ref |
| `ImagePart` (code) | re-exported as `@clarvis/protocol`'s | same as protocol shape |

### `read_image` tool

| Field | Value |
| --- | --- |
| wire name | `"read_image"` (`packages/tools/src/tools/read-image.ts:23`) |
| input schema | `{ path: string }`, `path` required (`:29-39`) |
| result | `{ content: [imagePart(base64, mimeType)] }` on success (`:64`) |
| errors | `not_an_image` (`:57-63`), plus `too_large`/`not_found`/`path_escape` surfaced from `readRawFile`/`resolvePath` |
| gating | withheld from a model whose target declares capabilities *without* `vision`; offered when capabilities are undeclared (`packages/loop/src/runtime/loop/run-agent.ts:316-318`) |
| admitted roots | the workspace plus `config.temporaryRoots`; confinement still rejects every other root (`packages/tools/src/tools/read-image.ts:43-49`) |

### Settings / request surface

| Key | Location | Notes |
| --- | --- | --- |
| `default_vision_model` (settings.json) | `packages/loop/src/settings/settings-schema.ts:371-377` | optional `modelField`; merge strategy `lastWins` (`packages/loop/src/settings/settings-merge.ts:114`) |
| `RunRequest.vision_model` | `packages/capability/src/api.ts:446-480` | optional model ref string; a model reference, not a profile name |
| kernel assembly | `packages/kernel/src/runs/settings-assembler.ts:428-430` | `merged.default_vision_model` (a string) becomes `request.vision_model` |
| request validation | `packages/loop/src/validation/request/provider-rules.ts:118-136` (`requireResolvableModelProviders`) | `vision_model`'s provider token must resolve, exactly like every profile's `model` |
| wire schema description | `packages/loop/src/validation/request/request-schema.ts:203-210` | user-facing text: "Omit to leave images as numbered placeholders for a model that cannot see." |

### `code`'s attachment surface

| Symbol | Location | Shape |
| --- | --- | --- |
| `Attachment` | `packages/code/src/core/attachments.ts:180-187` | `{ id, kind: "image", label, size?, data, mediaType? }` — staged composer state |
| `AttachmentStore` | `:190-198` | `{ list, canAddImage, add, remove, clear }` |
| `createAttachmentStore(): AttachmentStore` | `packages/code/src/views/input/attachments.ts:26-46` | Solid-signal-backed implementation |
| `isImageRef(path): boolean` | `packages/code/src/core/attachments.ts:11-14` | recognizes `.png/.jpg/.jpeg/.gif/.webp/.bmp` |
| `parseMentions(text): string[]` | `:22-28` | extracts `@path` tokens |
| `buildContent(text, loadImage): Promise<MessageContent>` | `:73-80` | text with `@mentions` → text-or-parts |
| `appendMentionImages(parts, loadImage): Promise<ContentPart[]>` | `:90-101` | appends newly-mentioned images to already-staged parts |
| `composeWithAttachments(text, attachments): MessageContent` | `:301-315` | text + staged `Attachment[]` → text-or-parts |
| `MAX_COMPOSER_IMAGES` / `MAX_COMPOSER_IMAGE_BYTES` / `MAX_COMPOSER_IMAGE_TOTAL_BYTES` | `:106,109,112` | `4` images / `5 MiB` each / `10 MiB` total |
| `MentionImageLoadError` / `MentionImageAdmissionError` | `:133-142`, `:169-177` | subclasses of `MentionImageError`, both abort the submission |
| `MentionImageError` | `:128-130` | abstract base class of the two subclasses above |
| `AttachmentAdmission` | `:118-125` | discriminated union: `{ ok: true }` or a typed rejection |
| `AttachmentAdmissionFailure` | `:115` | `"empty" \| "count" \| "item_bytes" \| "total_bytes"` |
| `checkAttachmentAdmission(existing, bytes): AttachmentAdmission` | `:230-240` | checks a prospective image against count/per-item/aggregate budgets; called from `packages/code/src/views/input/attachments.ts:31,34` to implement `AttachmentStore.canAddImage`/`add` |
| `attachmentBytes(attachment): number` | `:218-223` | `Math.max(declared size, base64DecodedBytes(data))` — the larger of declared and encoded size |
| `base64DecodedBytes(data): number` | `:204-210` | decoded byte count from base64 length + padding, without decoding |
| `nextAttachmentId(): string` | `:289-292` | `att_<timestamp>_<seq>` |
| `formatAttachmentBytes(bytes): string` / `attachmentAdmissionMessage(admission, prefix?): string` | `:145-149`, `:152-166` | human-readable byte size and admission-failure diagnostic text |
| `createImageLoader(files): ImageLoader` | `packages/code/src/adapters/workspace-files.ts:50-58` | wraps the kernel's `files.readImage` |

## 3. Data and formats

### The three `ImagePart` shapes and where each lives

Three distinct wire shapes carry an image through the system, distinguished by field names:

| Shape | Fields | Used by |
| --- | --- | --- |
| Engine (`@clarvis/capability`) | `{ type: "image", image, mediaType? }` | `Message.content`, `LiveMessage`, `collectTurnImages`, the vision prepass call (`packages/capability/src/api.ts:9-13`) |
| Tool result (`@clarvis/tools`) | `{ type: "image", data, mimeType }` | `read_image`'s return value (`packages/tools/src/tools/content.ts:9-13`) |
| Protocol / `code` | `{ type: "image", mime, data?, ref? }` | `code`'s composer, the kernel's wire DTOs (`packages/protocol/src/runs.ts:23-30`) |

Converting between the engine and protocol shapes is `packages/kernel/src/runs/map-message.ts`:
`engineContentToProto` (`:11-19`) turns an engine image into `{ type: "image", mime: mediaType ??
"application/octet-stream", data: image }`; `protoContentToEngine` (`:22-33`) is the inverse, resolving
bytes from `data ?? ref ?? ""`. Every citable producer in `code`'s attachment path
(`composeWithAttachments` at `packages/code/src/core/attachments.ts:301-315`, `buildContent`/
`appendMentionImages` via `createImageLoader` at `packages/code/src/adapters/workspace-files.ts:50-58`)
only ever populates `data`; no call site sets `ref`, so the `ref` branch of `protoContentToEngine` is
unreached from any path this document traces (see §8).

Converting the tool-result shape into `ToolResultImage` (`{ data, mediaType }`) — what a `tool`-role
message's `images` field carries — happens at
`packages/loop/src/runtime/tools/builtin/toolset.ts:136-139`: `r.content.filter(p => p.type ===
"image").map(p => ({ data: p.data, mediaType: p.mimeType }))`.

### Vision-model request/settings wiring

```
settings.json:  { "default_vision_model": "anthropic/claude-vision" }
                                │  lastWins merge across scopes
                                ▼
kernel settings-assembler.ts:  merged.default_vision_model (string | undefined)
                                │  spread only when a string
                                ▼
RunRequest.vision_model:        "anthropic/claude-vision"
                                │  requireResolvableModelProviders validates the provider token
                                ▼
vision-prepass.ts:              parseModelRef(modelRef) → { provider, modelId }
                                 resolveProvider(...) → per-provider overrides (or none)
```

### Placeholder and injection text formats

| Format | Where produced | Cite |
| --- | --- | --- |
| `[image #${idx} omitted: active model lacks vision]` | `toModelMessages`'s image-stripping path, for a `user` message whose target model is blind | `packages/llm/src/to-model-messages.ts:31` |
| `[image analysis] The '${modelRef}' model read the attached image(s) on your behalf (your model cannot view images directly). Its reading[, which was CUT OFF at the output limit and may omit detail]:\n\n${text}` | the prepass's injected message | `packages/loop/src/runtime/vision-prepass.ts:208-216` |
| `[image from an earlier turn]` | `collapseHistoricalImages`, replacing a continuation's stale image parts for a blind entry agent | `packages/loop/src/runtime/entry-seed.ts:82` |

### Trace and usage records

`vision_analysis` trace kind (`packages/capability/src/trace-kinds.ts:277-282`):

```ts
interface VisionAnalysisDetail {
  model: string;
  image_count: number;
  status: "completed" | "failed";
  result: string; // the reading, or the failure's message
}
```

Usage row (`packages/loop/src/runtime/usage.ts:87-100`), folded into `Usage.by_agent` when a prepass
ran (`packages/loop/src/runtime/usage.ts:156`, `packages/loop/src/runtime/usage-accounting.ts:106,115`):

```ts
interface VisionUsage { model: string; tokens: TokenCounts }
// projects to:
{ type: "vision", model, input_tokens, output_tokens, cached_tokens, cache_write_tokens }
```

It is a mutable single slot (`UsageAccounting.vision: { current?: VisionUsage }`,
`packages/loop/src/runtime/usage-accounting.ts:38`), never folded into `subagentAggByModel` — "a run
makes at most one such call" and folding it in "reported a spawned sub-agent that never existed"
(`:31-35`).

## 4. Behavior

### 4.1 Composing the turn's images (`code` → engine)

1. The user either stages an `Attachment` (paste/attach; `packages/code/src/core/attachments.ts:180`)
   or types an `@path` mention resolved through `createImageLoader`
   (`packages/code/src/adapters/workspace-files.ts:50-58`, itself wrapping the kernel's
   `files.readImage` RPC — `packages/kernel/src/workspace/workspace-service.ts:201-210`, which reads up
   to `MAX_WORKSPACE_IMAGE_BYTES` = 7 MiB (`:21`) and infers MIME from the file **extension**
   (`mimeFromExt`, `:24`) rather than magic bytes).
2. `InputDock.tsx`'s `composeMessage()` calls `composeWithAttachments(text, attachments.list())`
   (`packages/code/src/views/InputDock.tsx:98-100`), producing plain text when there are no staged
   images or a `ContentPart[]` of `[text?, ...images]` otherwise
   (`packages/code/src/core/attachments.ts:301-315`).
3. `run-host.ts`'s `submitTurn` then folds in any `@mentions` **not already staged**: a string `content`
   goes through `buildContent` (parses mentions from scratch), an array `content` goes through
   `appendMentionImages` (scans only the text parts already present) — `packages/code/src/run-host.ts:605-608`.
   Either call can throw `MentionImageLoadError` or `MentionImageAdmissionError`
   (`packages/code/src/core/attachments.ts:133-142,169-177`); `submitTurn` catches only
   `MentionImageError`, reports the message via `setStatus`, and restores the draft
   (`packages/code/src/run-host.ts:609-613`) — the message never reaches a run.
4. The resulting `MessageContent` is submitted as a protocol `Message`; the kernel's
   `protoMessagesToEngine` (`packages/kernel/src/runs/map-message.ts:52-55`) converts it to the engine's
   `Message[]`, which becomes `request.messages`.

### 4.2 Turning `request.messages` into `EntrySeed` (engine)

`buildEntrySeed` (`packages/loop/src/runtime/entry-seed.ts:126-186`), called once per run
(`packages/loop/src/runtime/orchestrator.ts:611`):

1. `turnImages = collectTurnImages(messages)` — every image part across every `user` message of
   *this turn's* `messages` argument, in order (`packages/loop/src/runtime/entry-seed.ts:134`,
   `packages/loop/src/runtime/subagents/build-subagent-input.ts:99-108`).
2. `entryStripsImages = !(entryResolved.capabilities?.has("vision") ?? true)` — true only when the
   entry agent's resolved model **declares** capabilities and `vision` is not among them; an
   undeclared/unknown capability set defaults to sighted (`packages/loop/src/runtime/entry-seed.ts:135`).
3. If `entryStripsImages`, every image part in the **restored continuation** history (not this turn's)
   is replaced by `collapseHistoricalImages` with `[image from an earlier turn]`
   (`packages/loop/src/runtime/entry-seed.ts:74-85,176`) — this turn's images are left as real image parts in `messages` and
   carried separately as `turnImages`.
4. Returns `{ entryMessages, turnImages, entryStripsImages }`.

### 4.3 The prepass itself

Invoked from `orchestrator.ts` inside `runWithClockAndTimeout`'s `buildLoop` callback, **before**
`runAgent` is called (`packages/loop/src/runtime/orchestrator.ts:644-653`):

```ts
await runVisionPrepass({ signal, deps, request, trace: traceHandle, ledger, seed, accounting });
return runAgent(buildEntryInput(clock, signal));
```

`seed.entryMessages` and the `EntryInputBuilder`'s captured `entryMessages` are the **same array
object** (`packages/loop/src/runtime/entry-inputs.ts:237: messages: p.entryMessages`), so a `push` onto `seed.entryMessages`
inside the prepass is visible to the subsequent `buildEntryInput(clock, signal)` call — this is why the
docstring's ordering constraint holds: "The append lands at the absolute end of `entryMessages`... If
the seed ever grows a volatile tail, this push has to move ahead of it."
(`packages/loop/src/runtime/vision-prepass.ts:104-110`).

Step by step inside `runVisionPrepass` (`packages/loop/src/runtime/vision-prepass.ts:112-218`):

| Step | Line(s) | Effect |
| --- | --- | --- |
| 1 | `:101` | no-op unless `entryStripsImages` is true and `turnImages.length > 0` |
| 2 | `:102-103` | no-op unless `request.vision_model` is set |
| 3 | `:105-109` | `parseModelRef`, `resolveProvider`, and look up the vision model's declared `capabilities` from `request.providers` |
| 4 | `:111-123` | if capabilities are declared and `vision` is absent: log `vision.capability_missing`, record a `failed` `vision_analysis` trace entry, return — **no call is made** |
| 5 | `:125-127` | `accompanying = userText(request.messages)`; falls back to a fixed placeholder string when empty |
| 6 | `:134-154` | call `deps.llm.call({ model, provider, providerConfig?, capabilities?, messages: [system, {user: [text, ...turnImages]}], tools: [], reasoningEffort: "off", maxOutputTokens: min(modelConfig.max_output_tokens ?? 4096, 4096), timeoutMs: env.CLARVIS_DEFAULT_CALL_TIMEOUT_MS, signal? })` |
| 7 | `:155-164` | on success: blank trimmed text → `failure`; `finishReason === "length"` → `truncated = true`, keep the text anyway; otherwise keep the text |
| 8 | `:165-172` | on throw: `failure` is `"the vision pass was cancelled"` if `signal.aborted`, else the error's message; `usage = partialUsageOf(err)`; logs `vision.call_failed` |
| 9 | `:173-186` | `finally`: if `usage` is defined (success **or** a failure carrying `partialUsage`), `ledger.consume(usage)` and set `accounting.vision.current` |
| 10 | `:188-193` | always record one `vision_analysis` trace entry: `status: text !== null ? "completed" : "failed"`, `result: text ?? failure ?? "the vision pass produced no usable reading"` |
| 11 | `:195-205` | only if `text !== null`: push the `[image analysis]` user message onto `seed.entryMessages`, labelling it `CUT OFF` when `truncated` |

`timeoutMs` is the fixed environment default `CLARVIS_DEFAULT_CALL_TIMEOUT_MS` (default `180000`,
`packages/capability/src/env.ts:96`) — **not** derived from `request.budget.timeout_ms`; the run's own
configured timeout does not scope this call.

Nothing in `runVisionPrepass` checks `ledger.wouldExceed(...)` before making the call — it spends
first and charges after (`:134-154`, `:174-175`); `TokenLedger.consume` has no rejecting path
(`packages/loop/src/runtime/budget/budget.ts:56-61`), so the pass can push the ledger past
`total_token_limit` on its own.

### 4.4 `read_image` (the direct, sighted-model route)

The `read_image` tool (`packages/tools/src/tools/read-image.ts:22-66`) is unconditionally defined in
the tool registry but **withheld** at dispatch time from a target whose resolved model declares
capabilities without `vision`, via the same `?? true`-default gate:

```ts
const sighted = input.target.capabilities?.has("vision") ?? true;
const visible = (list) => sighted ? [...list] : list.filter(t => !VISION_AGENT_TOOL_WIRE_NAMES.includes(t.wireName));
```
(`packages/loop/src/runtime/loop/run-agent.ts:316-318`, `VISION_AGENT_TOOL_WIRE_NAMES = ["read_image"]`
at `packages/loop/src/runtime/tools/wire-names.ts:89`). This gate applies to **any** agent (lead or
sub-agent), independent of the vision prepass, which only ever concerns the *entry* agent's *turn*
images.

Calling `read_image` resolves the file against the workspace plus the run-owned
`config.temporaryRoots`, then reads it (`resolvePath` + `readRawFile`, capped at `config.maxImageBytes`,
default `DEFAULT_MAX_IMAGE_BYTES = 5_000_000` — `packages/tools/src/config.ts:134-135`), sniffs its
format from magic bytes (`sniffImageMime`, `packages/tools/src/lib/image.ts`, PNG/JPEG/GIF/WebP only),
and returns `{ content: [imagePart(base64, mimeType)] }` or throws `not_an_image`
(`packages/tools/src/tools/read-image.ts:56-64`). A successful call's result content is the `imagePart` alone — no text part —
so whatever flattens a `ToolResult` to `.text` for that call gets an empty string, not a textual echo
of the image (`packages/tools/src/tools/read-image.ts:64`; pinned by "produces no text output (flattened text is empty)",
`packages/tools/tests/integration/read-image.test.ts:34-38`).

### 4.5 The `delegate_task`/`image_refs` route (sibling mechanism, not this file's own)

A lead (blind or not) may instead hand specific turn images to a spawned Sub-agent by index:
`delegate_task`'s `image_refs` schema property is offered only when the turn carries at least one image
**and** `hasVisionCapableProfile(spawnableProfiles)` is true — `imageRefsAllowed = (deps.turnImages?.length
?? 0) > 0 && hasVisionCapableProfile(deps.profiles.values())`
(`packages/loop/src/runtime/delegation.ts:221-222`, consumed at `packages/loop/src/runtime/subagents/lead-tools.ts:128` to decide whether
`buildDelegateTaskTool` adds the property; `hasVisionCapableProfile` itself is defined at
`packages/loop/src/runtime/subagents/subagent-profiles.ts:238-243`). So the property is withheld both
when no spawnable profile is vision-capable and when the turn carries no images at all, even with a
vision-capable spawnable profile present. A call naming a target profile whose
model lacks `vision` is rejected (`packages/loop/src/runtime/subagents/delegate-task.ts:155-160`). The
selected indices are resolved against `ctx.turnImages` — the same array `collectTurnImages` produced —
at `packages/loop/src/runtime/subagents/delegate-task.ts:405-406`. This route and the automatic prepass
are independent and can coexist in the same run (both consume `turnImages`, neither consumes it away
from the other).

## 5. Invariants

1. **The prepass never runs unless the entry agent itself cannot see.** `entryStripsImages` must be
   true — production `packages/loop/src/runtime/vision-prepass.ts:113`, pinned by "does not pre-pass
   when the entry model can see the images itself"
   (`packages/loop/tests/integration/image-vision-routing.test.ts:379-395`).
2. **The prepass never runs without turn images.** `packages/loop/src/runtime/vision-prepass.ts:113`;
   the `blindSolo` fixture with no images is not exercised directly, but every positive test supplies
   `imageTurn(...)` (`packages/loop/tests/integration/image-vision-routing.test.ts:288-301`).
3. **The prepass never runs without a configured `vision_model`.** `:102-103`; pinned by "does not
   pre-pass when the run names no vision_model" (`packages/loop/tests/integration/image-vision-routing.test.ts:362-377`) and "offers
   image_refs to a blind lead even when no vision_model is configured" showing zero extra calls
   (`packages/loop/tests/integration/image-vision-routing.test.ts:237-280`).
4. **A `vision_model` that declares capabilities without `vision` is refused before any call is made,
   and nothing tells the entry agent a reading happened.** Production
   `packages/loop/src/runtime/vision-prepass.ts:123-135`; pinned by "refuses a vision_model that declares capabilities without
   vision, and never claims a reading" (`packages/loop/tests/integration/image-vision-routing.test.ts:466-490`, asserting
   `llm.calls.length === 1`).
5. **An undeclared capability set on the vision model still proceeds.** Production: the `capabilities
   !== undefined` guard at `packages/loop/src/runtime/vision-prepass.ts:111` only fires when capabilities are known; unpinned by
   a dedicated test for this exact branch (the closest is the *entry* model's `?? true` default at
   `packages/loop/src/runtime/entry-seed.ts:135`, tested via "reads an image-only turn" style cases that always use a
   capabilities-declaring `blind-lead`) — **unpinned** for the vision-model side specifically.
6. **A truncated reading (`finishReason === "length"`) is kept, not discarded, and is labelled `CUT
   OFF` in the injected message.** Production `packages/loop/src/runtime/vision-prepass.ts:159-161,201`; pinned by "keeps a
   reading the provider cut off, but labels it as cut off"
   (`packages/loop/tests/integration/image-vision-routing.test.ts:492-514`). The docstring states this is "deliberately unlike
   `summarizeContext`, which refuses a truncated summary because it overwrites a rolling anchor no
   other copy exists of; this reading is transient and overwrites nothing" (`packages/loop/src/runtime/vision-prepass.ts:96-98`).
7. **A blank reading (trimmed to `""`) injects nothing and reports `status: "failed"` on the trace,
   but the run still completes.** Production `:156-158,188-193`; pinned by "injects nothing when the
   vision model returns blank text" (`packages/loop/tests/integration/image-vision-routing.test.ts:422-443`).
8. **A thrown/cancelled call injects nothing and swallows the failure; the entry model proceeds on the
   numbered placeholders it already has.** Production `:165-172,195`; pinned by "survives a failing
   vision call: no injection, the run still completes" (`packages/loop/tests/integration/image-vision-routing.test.ts:397-420`).
9. **Whatever partial usage a failed call reports is still charged to the ledger.** Production
   `:168,174-175`, `partialUsageOf` at `:215-218`; **unpinned** — no test in this document's scope forces a
   provider error carrying `partialUsage` through this path.
10. **The reading is reported as its own `type: "vision"` usage row, never as a spawned sub-agent —
    `subagents_spawned` stays `0` and no `type: "subagent"` row with `instances! > 0` appears.**
    Production `packages/loop/src/runtime/usage-accounting.ts:31-35,106,115`, `packages/loop/src/runtime/usage.ts:87-100`; pinned by "reports the reading as
    its own usage row, never as a spawned sub-agent"
    (`packages/loop/tests/integration/image-vision-routing.test.ts:516-560`).
11. **The reading call itself carries no tools and no agent identity.** Production
    `packages/loop/src/runtime/vision-prepass.ts:158` (`tools: []`); pinned by "reads with no tools and no agent identity — it is
    a call, not a sub-agent" (`packages/loop/tests/integration/image-vision-routing.test.ts:344-360`, asserting `reader.tools` is
    `[]` and exactly two total calls were made).
12. **A continuation's own prior-turn images are collapsed to `[image from an earlier turn]` text for a
    blind entry agent, while the new turn's images stay real image parts and the entry index numbering
    aligns with `image_refs`.** Production `packages/loop/src/runtime/entry-seed.ts:77-85,176`; pinned by "collapses prior-turn
    images so current-turn markers align with image_refs"
    (`packages/loop/tests/integration/continuation-image-alignment.test.ts:56-123`).
13. **When the entry model CAN see images, a continuation carries prior-turn images forward verbatim —
    no collapse.** Production: the `entryStripsImages ? ... : continuationSeed` branch at
    `packages/loop/src/runtime/entry-seed.ts:176`; pinned by "preserves prior-turn images verbatim when the entry model CAN see
    them (no collapse)" (`packages/loop/tests/integration/continuation-image-alignment.test.ts:125-183`).
14. **`collectTurnImages` walks messages in order and only inspects `user`-role, array-content
    messages.** Production `packages/loop/src/runtime/subagents/build-subagent-input.ts:99-108`; pinned by "collects image parts across
    user messages in global order" and "returns empty when there are no images"
    (`packages/loop/tests/unit/image-routing.test.ts:52-79`).
15. **`read_image` is withheld from a model whose declared capabilities exclude `vision`, and offered
    when capabilities are undeclared.** Production `packages/loop/src/runtime/loop/run-agent.ts:316-318`; pinned by the three cases of
    "read_image is offered only to a model that can consume its result"
    (`packages/loop/tests/integration/vision-tool-gating.test.ts:45-61`).
16. **`read_image` only recognizes PNG/JPEG/GIF/WebP by magic bytes and rejects everything else with
    `not_an_image`, independent of extension.** Production
    `packages/tools/src/tools/read-image.ts:56-63`, `packages/tools/src/lib/image.ts`; pinned by
    "errors not_an_image for a non-image file"
    (`packages/tools/tests/integration/read-image.test.ts:40-45`).
17. **`read_image` is available even on a read-only tool surface.** Production: no read-only gate in
    `read-image.ts`; pinned by "is available in the read-only surface"
    (`packages/tools/tests/integration/read-image.test.ts:68-74`).
18. **A `delegate_task` call naming `image_refs` for a profile whose model lacks `vision` is rejected,
    and the offer of the `image_refs` schema property itself depends on *some* spawnable profile being
    vision-capable — not on the lead's own model — AND on the turn carrying at least one image.**
    `imageRefsAllowed = (deps.turnImages?.length ?? 0) > 0 && hasVisionCapableProfile(deps.profiles.values())`
    is the actual gate (`packages/loop/src/runtime/delegation.ts:221-222`); a vision-capable spawnable
    profile alone does not offer the property when the turn has no images. Production
    `packages/loop/src/runtime/subagents/delegate-task.ts:155-160`,
    `packages/loop/src/runtime/subagents/subagent-profiles.ts:238-243`; pinned by "rejects image_refs for a
    profile whose model lacks vision" (`packages/loop/tests/unit/image-routing.test.ts:125-135`) and "a
    blind lead routes images it cannot see to a vision-capable Sub-agent"
    (`packages/loop/tests/integration/image-vision-routing.test.ts:155-235`). `hasVisionCapableProfile`'s default for an
    undeclared-capabilities model is `?? false` (blind), the opposite of the `?? true` default used at
    the provider boundary (`to-model-messages.ts`) and the entry seed (`packages/loop/src/runtime/entry-seed.ts:135`) — and the
    code states why: "A model whose capabilities are unknown counts as blind here, unlike the provider
    boundary and the entry seed, which assume vision. The asymmetry is deliberate: sending images to a
    model that turns out to be blind costs a placeholder, while *routing* images to a sub-agent that
    turns out to be blind costs a whole wasted agent run."
    (`packages/loop/src/runtime/subagents/subagent-profiles.ts:230-235`).
19. **The composer's staged-image budget is 4 images, 5 MiB each, 10 MiB aggregate, enforced before an
    image is ever retained or base64-decoded.** Production
    `packages/code/src/core/attachments.ts:106,109,112,242-279`; pinned by "rejects empty, fifth,
    oversized and aggregate-overflow images" (`packages/code/tests/unit/attachments.test.ts:192-218`)
    and "rejected images never enter reactive composer state" (`:220-235`).
20. **A staged attachment's declared `size` cannot understate its real payload.** `attachmentBytes`
    takes the larger of the declared size and `base64DecodedBytes(data)`, so a `size: 1` attachment
    whose `data` actually decodes to 32 bytes still reports 32 — admission checks bytes actually
    present, not the caller's claim. Production `packages/code/src/core/attachments.ts:218-223`; pinned
    by "attachmentBytes: encoded data cannot hide behind an understated size"
    (`packages/code/tests/unit/attachments.test.ts:187-190`).
21. **Budget checks compute decoded size from the base64 string's own length and padding, never by
    allocating a decoded buffer.** `base64DecodedBytes` derives byte count from `Math.ceil((data.length *
    3) / 4)` minus one byte per trailing `=`, so admission never decodes the payload it is measuring.
    Production `packages/code/src/core/attachments.ts:204-210`; pinned by "base64DecodedBytes: measures
    padded payloads without decoding them" (`packages/code/tests/unit/attachments.test.ts:179-185`).
22. **A turn with images but no accompanying user text still runs the vision call, using a fixed
    placeholder request string instead of empty text.** `accompanying = userText(request.messages)`
    falls back to `"(no accompanying text — describe the image(s))"` when empty. Production
    `packages/loop/src/runtime/vision-prepass.ts:137-139`; pinned by "reads an image-only turn (no
    accompanying text)" (`packages/loop/tests/integration/image-vision-routing.test.ts:445-464`).
23. **An `@mention`ed image that fails to load (operational error, not merely absent) raises
    `MentionImageLoadError` naming the path and blocks the send; an absent file is silently skipped
    (stays a string).** Production `packages/code/src/core/attachments.ts:37-64,133-142`; pinned by
    "an operational load error is explicit and names the mention"
    (`packages/code/tests/unit/attachments.test.ts:110-120`) and "an unresolvable mention leaves the parts untouched"
    (`:104-108`).
24. **`code` never populates the protocol `ImagePart.ref` field** — every attachment/mention path
    produces inline `data` only. Production: no call site in `packages/code/src/core/attachments.ts`,
    `views/InputDock.tsx`, `run-host.ts`, or `adapters/workspace-files.ts` sets `ref`; **unpinned** by
    any test (no test asserts its absence either — see §8).

## 6. Failure modes and degradation

| Failure | Where | Behavior |
| --- | --- | --- |
| Vision model declares capabilities without `vision` | `packages/loop/src/runtime/vision-prepass.ts:123-135` | no call made; logs `vision.capability_missing`; trace `vision_analysis` `status: "failed"`; no message injected |
| Vision LLM call throws | `:165-172` | caught; `failure` set from the error (or `"the vision pass was cancelled"` if the shared signal was aborted); logs `vision.call_failed`; `partialUsage`, if any, is still charged |
| Vision LLM call returns blank text | `:156-158` | treated as `failure = "the vision model returned no description"`; no message injected, `status: "failed"` |
| Vision LLM call truncated (`finishReason: "length"`) | `:159-161` | text is **kept**, `truncated = true`; injected message is labelled `CUT OFF` |
| No `usage` at all (call never returned any) | `:173-186` | ledger/`accounting.vision.current` are simply left unset — no charge, no usage row |
| `read_image` given a non-image / unsupported format | `packages/tools/src/tools/read-image.ts:57-63` | `ToolError("not_an_image", ...)` |
| `read_image` given an oversized file | via `readRawFile`, `config.maxImageBytes` | `too_large` (`packages/tools/tests/integration/read-image.test.ts:47-54`) |
| `read_image` given a missing path or one outside both the workspace and admitted temporary roots | via `resolvePath`/`readRawFile` | `not_found` / `path_escape` |
| Code: `@mention` load throws | `packages/code/src/core/attachments.ts:50-54` | `MentionImageLoadError`; `submitTurn` catches it, restores the draft, reports the message — the turn is **not** sent |
| Code: `@mention`/staged image exceeds a budget | `checkImageAdmission`, `:242-279` | `MentionImageAdmissionError` (mention path) or a rejected `AttachmentAdmission` (`ok: false`, composer path) — the composer never even retains the rejected item |
| Code: `@mention`ed path not found | `loadMentionImages`, `:49-55` | silently skipped — the mention text stays literal, no error |

Nothing in this subsystem retries a failed vision call; a run makes at most one attempt per turn
(`UsageAccounting.vision` is a single mutable slot, `packages/loop/src/runtime/usage-accounting.ts:31-35`).

## 7. Coupling

**Depends on** (runtime, value imports):
- `@clarvis/capability` — `ImagePart`/`ContentPart`/`ToolResultImage`/`RunRequest`/`LLMProvider`/
  `LLMUsage`/`TracePort`/`Logger`/`EnvConfig`, `parseModelRef`/`resolveProvider`, `sanitizeErrorMessage`
  (`packages/loop/src/runtime/vision-prepass.ts:1-6`). This is a **hard** dependency direction: `@clarvis/loop` imports
  `@clarvis/capability`, never the reverse.
- `./budget/budget.ts` (`TokenLedger`), `./entry-seed.ts` (`EntrySeed`), `./usage-accounting.ts`
  (`UsageAccounting`), `./subagents/build-subagent-input.ts` (`userText`) — all within `@clarvis/loop`.
- The vision call itself runs through the same `LLMProvider` port every other model call uses
  (`deps.llm.call`, `packages/loop/src/runtime/vision-prepass.ts:146`), so its image-stripping mechanics
  (`packages/llm/src/to-model-messages.ts`) are shared with the entry agent's own calls — this is why
  a vision-model call that declared `vision` still reaches the provider with real image parts rather
  than placeholders (`toUserContent`, `packages/llm/src/to-model-messages.ts:18-45`).

**Forces the calling order**: `packages/loop/src/runtime/orchestrator.ts:644-653` calls `runVisionPrepass` and only then builds
the entry agent's `RunAgentInput` via `buildEntryInput(clock, signal)` — the shared-array-reference
mechanism (§4.3) is what makes appending to `seed.entryMessages` visible to the entry agent's first
call. Nothing in the type system enforces this order; it is enforced only by the two statements'
sequence in `orchestrator.ts` and by the docstring's own warning
(`packages/loop/src/runtime/vision-prepass.ts:104-110`).

**Depended on by**: `packages/loop/src/runtime/orchestrator.ts` (the only call site of
`runVisionPrepass`). Nothing outside `@clarvis/loop` calls it directly — the kernel and `code` reach it
only by shaping a `RunRequest` with `vision_model` set and a turn carrying images.

**Shares vocabulary with, but is not, delegation**: `collectTurnImages`
(`packages/loop/src/runtime/subagents/build-subagent-input.ts:99`) feeds both `EntrySeed.turnImages` (this file's concern) and
`delegate_task`'s `image_refs` resolution (`packages/loop/src/runtime/subagents/delegate-task.ts:405-406`, a different document's
concern). The two routes do not exclude each other and do not share any mutable state beyond reading
the same array.

**`code`'s attachment path is a chain of packages**, each a hard value dependency of the one before it
in the flow: `packages/code/src/core/attachments.ts` (pure logic, no reactivity) →
`packages/code/src/views/input/attachments.ts` (Solid signal wrapper, re-exports the pure functions
verbatim, `packages/code/src/views/input/attachments.ts:5-16`) → `packages/code/src/views/InputDock.tsx` (composes the message) →
`packages/code/src/run-host.ts` (folds in `@mentions`, submits the turn) →
`packages/code/src/adapters/workspace-files.ts` (`createImageLoader`, wraps the kernel's
`WorkspaceService`) → `packages/kernel/src/workspace/workspace-service.ts` (`readImage`, confines the
path and bounds the read). `code` never imports the engine directly for any of this — only
`@clarvis/protocol`'s `ImagePart`/`MessageContent` types (`packages/code/src/core/attachments.ts:1`).

## 8. Open questions

- **Why `VISION_MAX_OUTPUT_TOKENS` is `4_096`** and not some other ceiling
  (`packages/loop/src/runtime/vision-prepass.ts:58`) — no comment or test motivates the specific number.
- **Why the vision call's `timeoutMs` is the fixed `CLARVIS_DEFAULT_CALL_TIMEOUT_MS` rather than derived
  from `request.budget.timeout_ms`** (`packages/loop/src/runtime/vision-prepass.ts:164`) — this is a real, citable asymmetry (the
  run's own configured timeout does not bound this call) but no comment states the reasoning.
- **Whether `capabilities !== undefined && !capabilities.has("vision")` for the *vision model itself*
  is exercised by a test with an undeclared-capabilities vision model.** Every test in
  `image-vision-routing.test.ts` uses a `vision-subagent`/`vision-lead` model that explicitly declares
  `["tool_calling", "vision"]`, or a `blind-lead`/`blind-model` declaring `["tool_calling"]` without
  `vision` — none uses an `uncatalogued`-style model as the `vision_model` value itself, so the
  "unknown capability set still proceeds" claim in the docstring (`packages/loop/src/runtime/vision-prepass.ts:90-91`) is
  unverified by a dedicated test for this specific branch (Invariant 5).
- **No test in this document's scope forces a provider error carrying `partialUsage` through
  `runVisionPrepass`'s catch branch** (Invariant 9) — the "survives a failing vision call" test
  (`packages/loop/tests/integration/image-vision-routing.test.ts:397-420`) uses a plain `Error`, which `partialUsageOf` (
  `packages/loop/src/runtime/vision-prepass.ts:227-230`) would resolve to `undefined`, so the ledger-charge-on-partial-failure
  path is unpinned.
- **The protocol `ImagePart.ref` field** (`packages/protocol/src/runs.ts:29`) is handled on read
  (`protoContentToEngine`, `packages/kernel/src/runs/map-message.ts:22-33`) but this document found no
  producer anywhere in `code`'s attachment path — every image reaching the engine from `code` carries
  inline `data`. Whether some other client (or a future one) is meant to populate `ref` — and what
  "the kernel resolves" (the type's own doc comment) would do with it — is outside this document's
  scope and not settled by the files in scope.
- **Whether an inactivity-timeout tick (`ComputeClock`) can abort the vision call mid-flight** —
  `runWithClockAndTimeout` races the *entire* `buildLoop` promise, which includes the prepass, against
  the clock (`packages/loop/src/runtime/run-timeout.ts:86,102`), and the clock is "poked on every trace
  entry" (`:44`) — but whether a long-running single LLM call inside the prepass (which records no
  trace entry until it finishes) can itself starve the clock into firing is not something this
  document's scope (which excludes `context-compaction.ts`'s trace-bridge poking mechanics)
  resolves; it belongs to whatever document covers `ComputeClock`/`traceBridge`.
- **Model-catalog and provider-resolution mechanics** (`parseModelRef`, `resolveProvider`, how
  `providerConfig`/`capabilities` are actually looked up and what "resolved rather than required" means
  operationally) are used by `packages/loop/src/runtime/vision-prepass.ts:117-122` but are explicitly out of this document's scope —
  see [model-catalog-and-provider-resolution](../hosts/model-catalog.md).
- **Transcript rendering of an attachment** (how a staged `Attachment` or a sent image renders in the
  TUI's transcript/composer chrome) is explicitly out of this document's scope — see
  [code-input-overlays-and-commands](../hosts/code-input-and-overlays.md).
