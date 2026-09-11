import { expect, test } from "bun:test";
import { privateEntry, resolveEntry } from "../../src/cli-entry.ts";

test("privateEntry: routes only the process-owned remote kernel bootstrap", () => {
  expect(privateEntry(["--remote-kernel", "payload"])).toBe("remote-kernel");
  expect(privateEntry(["--version"])).toBeUndefined();
});

const distPath = "/repo/packages/code/dist/index.js";

test("resolveEntry: the built bundle is used when it is there", () => {
  expect(resolveEntry({ distPath, distExists: true, forceSource: false })).toEqual({
    kind: "dist",
  });
});

test("resolveEntry: CLARVIS_CODE_SOURCE wins even over a present bundle", () => {
  expect(resolveEntry({ distPath, distExists: true, forceSource: true })).toEqual({
    kind: "source",
  });
  expect(resolveEntry({ distPath, distExists: false, forceSource: true })).toEqual({
    kind: "source",
  });
});

test("resolveEntry: a missing bundle names itself and every way out", () => {
  const choice = resolveEntry({ distPath, distExists: false, forceSource: false });
  expect(choice.kind).toBe("error");
  if (choice.kind !== "error") throw new Error("unreachable");
  expect(choice.message).toContain(distPath);
  expect(choice.message).toContain("bun --filter @clarvis/code build");
  expect(choice.message).toContain("bun run setup");
  expect(choice.message).toContain("CLARVIS_CODE_SOURCE=1");
});
