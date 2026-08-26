import { describe, it, expect } from "bun:test";
import {
  engineMessagesToProto,
  protoMessagesToEngine,
  protoSteerToEngineContent,
} from "../../src/runs/map-message.ts";
import type { Message as ProtoMessage } from "@clarvis/protocol";

describe("map-message: engine <-> protocol content", () => {
  it("engineMessagesToProto: image parts become mime/data; system is dropped", () => {
    const proto = engineMessagesToProto([
      { role: "system", content: "scaffold" },
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "BASE64", mediaType: "image/png" },
        ],
      },
    ]);
    expect(proto).toEqual([
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mime: "image/png", data: "BASE64" },
        ],
      },
    ]);
  });

  it("protoMessagesToEngine: image mime/data become image/mediaType (inverse)", () => {
    const engine = protoMessagesToEngine([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mime: "image/png", data: "BASE64" },
        ],
      },
    ]);
    expect(engine).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "BASE64", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("protoMessagesToEngine: an image ref (no data) carries into the engine image field", () => {
    const [msg] = protoMessagesToEngine([
      { role: "user", content: [{ type: "image", mime: "image/jpeg", ref: "shot.jpg" }] },
    ]);
    expect(msg!.content).toEqual([{ type: "image", image: "shot.jpg", mediaType: "image/jpeg" }]);
  });

  it("protoSteerToEngineContent: a bare string passes through; a message converts its content", () => {
    expect(protoSteerToEngineContent("go")).toBe("go");
    const msg: ProtoMessage = {
      role: "user",
      content: [{ type: "image", mime: "image/png", data: "B" }],
    };
    expect(protoSteerToEngineContent(msg)).toEqual([
      { type: "image", image: "B", mediaType: "image/png" },
    ]);
  });
});
