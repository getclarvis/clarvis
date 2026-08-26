import { describe, it, expect } from "../helpers/bun-test.ts";
import { toModelMessages } from "../../src/index.ts";
import type { LiveMessage } from "@clarvis/capability";

describe("toModelMessages — LiveMessage → AI SDK ModelMessage", () => {
  it("maps system / user / assistant-text verbatim", () => {
    const msgs: LiveMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toModelMessages(msgs)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("maps an assistant tool_calls turn to tool-call parts (with leading text)", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "thinking",
        tool_calls: [{ id: "c1", name: "fs.read", arguments: { path: "a" } }],
      },
    ];
    expect(toModelMessages(msgs)[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        { type: "tool-call", toolCallId: "c1", toolName: "fs.read", input: { path: "a" } },
      ],
    });
  });

  it("maps provider-neutral reasoning before assistant text and preserves provider options", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "answer",
        reasoning: [
          {
            text: "thinking",
            providerOptions: { anthropic: { signature: "signed-thinking" } },
          },
        ],
      },
    ];

    expect(toModelMessages(msgs)[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "thinking",
          providerOptions: { anthropic: { signature: "signed-thinking" } },
        },
        { type: "text", text: "answer" },
      ],
    });
  });

  it("replays phased assistant text with its provider item metadata", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "Checking now.",
        text_parts: [
          {
            text: "Checking now.",
            phase: "commentary",
            providerOptions: { openai: { itemId: "msg_update", phase: "commentary" } },
          },
        ],
      },
    ];

    expect(toModelMessages(msgs)[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Checking now.",
          providerOptions: { openai: { itemId: "msg_update", phase: "commentary" } },
        },
      ],
    });
  });

  it("omits the text part when the assistant tool_calls turn has empty content", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "fs.read", arguments: {} }],
      },
    ];
    const content = (toModelMessages(msgs)[0] as { content: unknown[] }).content;
    expect(content).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "fs.read", input: {} },
    ]);
  });

  it("resolves a tool message's toolName from the paired assistant tool_call", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "fs.read", arguments: {} }],
      },
      { role: "tool", tool_call_id: "c1", content: "file contents" },
    ];
    expect(toModelMessages(msgs)[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "fs.read",
          output: { type: "text", value: "file contents" },
        },
      ],
    });
  });

  it("falls back to toolName 'unknown' for an unpaired tool message", () => {
    const msgs: LiveMessage[] = [{ role: "tool", tool_call_id: "orphan", content: "x" }];
    const part = (toModelMessages(msgs)[0] as { content: Array<{ toolName: string }> }).content[0];
    expect(part?.toolName).toBe("unknown");
  });

  it("promotes a tool result with images to a content output of text + file parts", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "read_image", arguments: {} }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: "Tool 'read_image' result: ",
        images: [{ data: "BASE64PNG", mediaType: "image/png" }],
      },
    ];
    expect(toModelMessages(msgs)[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Tool 'read_image' result: " },
              { type: "file", data: { type: "data", data: "BASE64PNG" }, mediaType: "image/png" },
            ],
          },
        },
      ],
    });
  });

  it("maps a multimodal user turn to text + image parts", () => {
    const msgs: LiveMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "https://ex.com/a.png", mediaType: "image/png" },
        ],
      },
    ];
    expect(toModelMessages(msgs)[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", image: "https://ex.com/a.png", mediaType: "image/png" },
      ],
    });
  });

  it("omits mediaType on an image part when it is absent", () => {
    const msgs: LiveMessage[] = [
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
    ];
    expect(toModelMessages(msgs)[0]).toEqual({
      role: "user",
      content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
    });
  });

  it("keeps a plain-string user turn as a string", () => {
    const msgs: LiveMessage[] = [{ role: "user", content: "hi" }];
    expect(toModelMessages(msgs)[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("toModelMessages — tool call with absent arguments", () => {
  it("defaults a tool-call input to an empty object when arguments are undefined", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "fs.read", arguments: undefined }],
      },
    ];
    const content = (toModelMessages(msgs)[0] as { content: Array<{ input: unknown }> }).content;
    expect(content[0]?.input).toEqual({});
  });
});

describe("toModelMessages — stripImages option", () => {
  it("replaces stripped image parts with a numbered placeholder instead of dropping them", () => {
    const msgs: LiveMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "https://ex.com/a.png", mediaType: "image/png" },
        ],
      },
    ];
    expect(toModelMessages(msgs, { stripImages: true })[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "text", text: "[image #0 omitted: active model lacks vision]" },
      ],
    });
  });

  it("keeps an images-only user message as a placeholder when stripImages is true", () => {
    const msgs: LiveMessage[] = [
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
    ];
    expect(toModelMessages(msgs, { stripImages: true })[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[image #0 omitted: active model lacks vision]" }],
    });
  });

  it("numbers stripped-image placeholders by global order across user messages", () => {
    const msgs: LiveMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "first" },
          { type: "image", image: "a" },
        ],
      },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [
          { type: "image", image: "b" },
          { type: "image", image: "c" },
        ],
      },
    ];
    const out = toModelMessages(msgs, { stripImages: true });
    expect(out[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "[image #0 omitted: active model lacks vision]" },
      ],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[image #1 omitted: active model lacks vision]" },
        { type: "text", text: "[image #2 omitted: active model lacks vision]" },
      ],
    });
  });

  it("strips images from tool results when stripImages is true", () => {
    const msgs: LiveMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", name: "read_image", arguments: {} }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: "result text",
        images: [{ data: "BASE64PNG", mediaType: "image/png" }],
      },
    ];
    const toolMsg = toModelMessages(msgs, { stripImages: true })[1];
    expect(toolMsg).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_image",
          output: { type: "text", value: "result text" },
        },
      ],
    });
  });

  it("does not strip images by default", () => {
    const msgs: LiveMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "https://ex.com/a.png" },
        ],
      },
    ];
    expect(toModelMessages(msgs)[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: "https://ex.com/a.png" },
      ],
    });
  });
});
