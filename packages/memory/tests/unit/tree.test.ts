import { describe, expect, test } from "bun:test";

import { analyze, extractTitle, isIndexFile, selfFileFor, titleFromDir } from "../../src/tree.ts";

describe("memory tree edge behavior", () => {
  test("recognizes both index names and falls back to a directory title", () => {
    expect(isIndexFile("PROFILE.md")).toBe(true);
    expect(isIndexFile("infra/TOPIC.md")).toBe(true);
    expect(isIndexFile("infra/MEMORY.md")).toBe(false);
    expect(extractTitle("plain text\nwithout a heading", "deep/release/MEMORY.md")).toBe("Release");
    expect(titleFromDir("")).toBe("Operational profile");
  });

  test("links an empty leaf directory to its topic fallback", () => {
    const shape = analyze([
      {
        path: "infra/note.md",
        kind: "memory",
        description: "",
        tags: [],
        updated_at: 1,
      },
    ]);

    expect(selfFileFor("infra", shape)).toEqual({ path: "infra/TOPIC.md", description: "" });
  });
});
