import { expect, test } from "bun:test";
import { join } from "node:path";
import { privateEntry, productRootForEntry } from "../../src/cli-entry.ts";

test("product root follows the source launcher in a checkout or portable release", () => {
  const root = join(process.cwd(), "fixture-root");
  expect(productRootForEntry(join(root, "packages", "code", "src", "cli.ts"))).toBe(root);
  expect(() => productRootForEntry(join(root, "packages", "code", "dist", "index.js"))).toThrow(
    "outside its product root",
  );
});

test("privateEntry: routes only the process-owned remote kernel bootstrap", () => {
  expect(privateEntry(["--remote-kernel", "payload"])).toBe("remote-kernel");
  expect(privateEntry(["--version"])).toBeUndefined();
});
