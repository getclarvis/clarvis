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
const plugin = { scope: "global" as const, source: "clarvis" as const, name: "demo" };

test("hook trust binds approval to one canonical normalized definition", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "clarvis-hook-trust-"));
  const fingerprint = hookFingerprint(hook);
  expect(pluginHookReviews(globalDir, plugin, [hook])[0]?.approved).toBe(false);

  writeHookApproval(globalDir, plugin, fingerprint, true);
  expect(pluginHookReviews(globalDir, plugin, [hook])[0]?.approved).toBe(true);
  expect(
    pluginHookReviews(globalDir, plugin, [{ ...hook, command: "python3 changed.py" }])[0]?.approved,
  ).toBe(false);
  expect(pluginHookReviews(globalDir, { ...plugin, source: "agents" }, [hook])[0]?.approved).toBe(
    false,
  );
  expect(
    hookFingerprint({ timeout_ms: 5000, command: "python3 check.py", event: "run_start" }),
  ).toBe(fingerprint);
});

test("corrupt hook trust fails closed and is never overwritten", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "clarvis-hook-trust-corrupt-"));
  const path = globalPaths(globalDir).hookTrustFile;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not json");

  expect(pluginHookReviews(globalDir, plugin, [hook])[0]?.approved).toBe(false);
  expect(() => writeHookApproval(globalDir, plugin, hookFingerprint(hook), true)).toThrow(
    "refusing to overwrite",
  );
});
