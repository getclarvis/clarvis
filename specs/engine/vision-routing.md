# Image routing and model vision

## Purpose

An image reaches a run when a user attaches or `@mentions` it in the terminal UI, or when an
agent reads an image through `read_image`. The selected model must declare the `vision` capability
to receive image bytes. A model without that declaration receives numbered text placeholders for
user images and has no `read_image` tool. A lead can explicitly pass an image from the current turn
to a spawnable sub-agent whose model declares `vision`.

Production: `composeWithAttachments` and `appendMentionImages` in
`packages/code/src/core/attachments.ts`, `runAgent` in
`packages/loop/src/runtime/loop/run-agent.ts`, `AiSdkAdapter.call` in
`packages/llm/src/ai-sdk-adapter.ts`, and `spawnSubagent` in
`packages/loop/src/runtime/subagents/spawn-subagent.ts`. Test:
`packages/loop/tests/integration/image-vision-routing.test.ts`,
`packages/loop/tests/integration/vision-tool-gating.test.ts`, and
`packages/llm/tests/unit/to-model-messages.test.ts`.

## Image surfaces

- The Code composer stages up to four images, at most 5 MiB each and 10 MiB combined. It accepts
  image `@mentions` through `buildContent` or `appendMentionImages` and submits protocol image parts.
  The kernel's `protoMessagesToEngine` converts these to engine `ImagePart`s. Production:
  `packages/code/src/core/attachments.ts`, `packages/code/src/run-host.ts`, and
  `packages/kernel/src/runs/map-message.ts`. Test:
  `packages/code/tests/unit/attachments.test.ts` and
  `packages/kernel/tests/unit/map-message.test.ts`.
- `read_image` returns a tool-result image for an admitted workspace or run-scratch path. It is
  offered only when the current agent's model declares `vision`. Production: `createReadImage` in
  `packages/tools/src/tools/read-image.ts` and `runAgent` in
  `packages/loop/src/runtime/loop/run-agent.ts`. Test:
  `packages/loop/tests/integration/vision-tool-gating.test.ts` and
  `packages/tools/tests/integration/read-image.test.ts`.
- `spawn_subagent.image_refs` indexes images from the current turn. The option is offered when a
  spawnable profile declares `vision`; the named target is checked again before its image bytes are
  included. Production: `buildSpawnSubagentTool` in `packages/loop/src/runtime/delegation.ts`,
  `hasVisionCapableProfile` in `packages/loop/src/runtime/subagents/subagent-profiles.ts`, and
  `spawnSubagent` in `packages/loop/src/runtime/subagents/spawn-subagent.ts`. Test:
  `packages/loop/tests/integration/image-vision-routing.test.ts` and
  `packages/loop/tests/unit/image-routing.test.ts`.

## Data and conversion

The engine image part is `{ type: "image", image, mediaType? }`, the tool result image is
`{ type: "image", data, mimeType }`, and the protocol image part is
`{ type: "image", mime, data?, ref? }`. Conversion between protocol and engine content belongs to
`engineContentToProto` and `protoContentToEngine` in
`packages/kernel/src/runs/map-message.ts`. The tool-result conversion belongs to
`packages/loop/src/runtime/tools/builtin/toolset.ts`. Test:
`packages/kernel/tests/unit/map-message.test.ts` and
`packages/loop/tests/integration/vision-tool-gating.test.ts`.

## Invariants

1. **A model receives image bytes only when it declares `vision`.** An absent capability set is
   treated as lacking vision. Production: `AiSdkAdapter.call` in
   `packages/llm/src/ai-sdk-adapter.ts` sets `stripImages`, and `runAgent` in
   `packages/loop/src/runtime/loop/run-agent.ts` gates image-reading tools. Test:
   `packages/loop/tests/integration/vision-tool-gating.test.ts` and
   `packages/loop/tests/integration/image-vision-routing.test.ts`.
2. **A model without vision receives a placeholder for each image, preserving its position and
   numbering.** Production: `toModelMessages` in `packages/llm/src/to-model-messages.ts`.
   Test: `packages/llm/tests/unit/to-model-messages.test.ts`.
3. **An explicitly spawned sighted sub-agent can receive current-turn image bytes even when its
   lead cannot see them.** The lead receives image indexes for `image_refs`, while the target model's
   capability controls byte delivery. Production: `collectTurnImages` in
   `packages/loop/src/runtime/subagents/build-subagent-input.ts`, `buildSpawnSubagentTool` in
   `packages/loop/src/runtime/delegation.ts`, and `spawnSubagent` in
   `packages/loop/src/runtime/subagents/spawn-subagent.ts`. Test:
   `packages/loop/tests/integration/image-vision-routing.test.ts`.
4. **Continuation history retains the original image parts and current-turn indexes remain local to
   the new turn.** Production: `buildEntrySeed` in `packages/loop/src/runtime/entry-seed.ts`.
   Test: `packages/loop/tests/integration/continuation-image-alignment.test.ts`.

The ordinary profile model is resolved by the kernel and engine contracts in
[model catalog](../hosts/model-catalog.md) and
[request and settings schema](request-and-settings-schema.md). The image bytes remain data rather
than instructions under [model instructions](../cross-cutting/model-instructions.md).
