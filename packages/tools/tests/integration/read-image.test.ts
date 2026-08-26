import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  writePng,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("read_image", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("returns a base64 image part with the sniffed mime type", async () => {
    const abs = writePng(root, "pic.png");
    const r = await callTool("read_image", { path: "pic.png" }, config);
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    const part = r.content[0]!;
    if (part.type !== "image") throw new Error("expected an image part");
    expect(part.mimeType).toBe("image/png");
    expect(part.data).toBe(readFileSync(abs).toString("base64"));
  });

  it("produces no text output (flattened text is empty)", async () => {
    writePng(root, "pic.png");
    const r = await callTool("read_image", { path: "pic.png" }, config);
    expect(r.text).toBe("");
  });

  it("errors not_an_image for a non-image file", async () => {
    write(root, "notes.txt", "just text, not an image");
    const r = await callTool("read_image", { path: "notes.txt" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_an_image");
  });

  it("errors too_large for an image beyond maxImageBytes", async () => {
    writePng(root, "pic.png");
    const small = makeConfig(root, { maxImageBytes: 10 });
    const r = await callTool("read_image", { path: "pic.png" }, small);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("too_large");
    expect(r.json.limit).toBe(10);
  });

  it("errors not_found for a missing file", async () => {
    const r = await callTool("read_image", { path: "missing.png" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_found");
  });

  it("errors path_escape for a path outside the workspace", async () => {
    const r = await callTool("read_image", { path: "../outside.png" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("path_escape");
  });

  it("is available in the read-only surface", async () => {
    writePng(root, "pic.png");
    const ro = makeConfig(root, { readOnly: true });
    const r = await callTool("read_image", { path: "pic.png" }, ro);
    expect(r.isError).toBe(false);
    expect(r.content[0]!.type).toBe("image");
  });
});
