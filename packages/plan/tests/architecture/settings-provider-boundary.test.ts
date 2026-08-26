import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("keeps the settings entry disconnected from executable provider code", () => {
  const src = join(import.meta.dir, "..", "..", "src");
  const settings = readFileSync(join(src, "settings.ts"), "utf8");
  const config = readFileSync(join(src, "provider-config.ts"), "utf8");
  expect(settings).toContain('from "./provider-config.ts"');
  expect(settings).not.toContain('from "./provider.ts"');
  expect(settings).not.toContain("file-repository");
  expect(config).not.toContain("./provider.ts");
  expect(config).not.toContain("node:fs");
});
