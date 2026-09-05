import { expect, test } from "bun:test";
import { stripAnsi, terminalPlainText } from "../../src/core/terminal-text.ts";

test("stripAnsi removes complete CSI and string-control families", () => {
  expect(stripAnsi("\u001b[1;32mok\u001b[0m")).toBe("ok");
  expect(stripAnsi("\u001b]0;title\u0007body")).toBe("body");
  expect(stripAnsi("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
  expect(stripAnsi("\u001b]0;title\u009cbody")).toBe("body");
  expect(stripAnsi("\u0090device payload\u009cafter")).toBe("after");
  expect(stripAnsi("plain")).toBe("plain");
});

test("terminalPlainText neutralizes Prisma cursor updates and line editing controls", () => {
  const prisma =
    "Running generate...\n\u001b[2K\u001b[1A\u001b[2K\u001b[GGenerated Prisma Client\nready";
  const plain = terminalPlainText(prisma);
  expect(plain).toBe("Running generate...\nGenerated Prisma Client\nready");
  expect(plain).not.toContain("\u001b");
  expect(terminalPlainText("progress 1%\rprogress 2%\nreadx\by")).toBe("progress 2%\nready");
});
