import { expect, test } from "bun:test";
import type { ContentPart, MessageContent } from "@clarvis/protocol";
import { contentToText } from "../../src/adapters/message-content.ts";

/**
 * The behavioral cases `contentToText` must satisfy, named to match the
 * equivalent case-by-case coverage in `@clarvis/capability`'s own
 * `tests/message-content.test.ts`. `@clarvis/code` may not depend on
 * `@clarvis/capability` (see `src/adapters/message-content.ts`'s TSDoc), so
 * this table cannot be imported by or shared with that package's suite —
 * each package asserts its own implementation against this same list of
 * named behaviors independently, and a maintainer changing one body is
 * expected to update both tables in step.
 */
const CASES: Array<{ name: string; input: MessageContent; expected: string }> = [
  { name: "string content is returned as-is", input: "hello world", expected: "hello world" },
  { name: "string content preserves an empty string", input: "", expected: "" },
  {
    name: "a single text part yields its text",
    input: [{ type: "text", text: "hi there" }],
    expected: "hi there",
  },
  {
    name: "a non-text part is rendered as a bracketed tag",
    input: [{ type: "image", mime: "image/png", data: "abc" }],
    expected: "[image]",
  },
  {
    name: "mixed text and non-text parts join with newlines, in order",
    input: [
      { type: "text", text: "before" },
      { type: "image", mime: "image/png", ref: "foo.png" },
      { type: "text", text: "after" },
    ] satisfies ContentPart[],
    expected: "before\n[image]\nafter",
  },
  { name: "an empty array of parts yields an empty string", input: [], expected: "" },
];

for (const { name, input, expected } of CASES) {
  test(`contentToText: ${name}`, () => {
    expect(contentToText(input)).toBe(expected);
  });
}
