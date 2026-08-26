import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { globalPaths } from "@clarvis/paths";
import {
  hookFingerprint,
  pluginHookReviews,
  writeHookApproval,
} from "../../src/plugins/hook-trust.ts";

const hook = { event: "run_start" as const, command: "python3 check.py", timeout_ms: 5000 };

test("hook trust binds approval to one canonical normalized definition", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "clarvis-hook-trust-"));
  const fingerprint = hookFingerprint(hook);
  expect(pluginHookReviews(globalDir, "demo", [hook])[0]?.approved).toBe(false);

  writeHookApproval(globalDir, "demo", fingerprint, true);
  expect(pluginHookReviews(globalDir, "demo", [hook])[0]?.approved).toBe(true);
  expect(
    pluginHookReviews(globalDir, "demo", [{ ...hook, command: "python3 changed.py" }])[0]?.approved,
  ).toBe(false);
  expect(
    hookFingerprint({ timeout_ms: 5000, command: "python3 check.py", event: "run_start" }),
  ).toBe(fingerprint);
});

test("corrupt hook trust fails closed and is never overwritten", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "clarvis-hook-trust-corrupt-"));
  const path = globalPaths(globalDir).hookTrustFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not json");

  expect(pluginHookReviews(globalDir, "demo", [hook])[0]?.approved).toBe(false);
  expect(() => writeHookApproval(globalDir, "demo", hookFingerprint(hook), true)).toThrow(
    "refusing to overwrite",
  );
});
