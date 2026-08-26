import { describe, expect, test } from "bun:test";
import * as local from "../../src/local.ts";
import { sanitizeErrorMessage, sanitizeText } from "../../src/policy.ts";
import {
  sanitizeErrorMessage as canonicalErrorMessage,
  sanitizeText as canonical,
} from "@clarvis/capability";

describe("kernel executable entrypoints", () => {
  test("loads the local entrypoint as an executable public surface", () => {
    expect(local.resolveShell).toBeFunction();
    expect(local.createNodeProcessRunner).toBeFunction();
    expect(local.createFilePluginRepository).toBeFunction();
    expect(local.createGitPluginFetcher).toBeFunction();
    expect(local.withoutGitRepositoryEnvironment).toBeFunction();
  });
});

// @clarvis/code may depend only on kernel, protocol and paths, so the canonical
// secret-redaction rules reach it through this re-export or not at all. Losing
// it sends code back to a local copy of the rules, which is how the two drifted
// to five patterns against eighteen.
test("the kernel re-exports @clarvis/capability's sanitizeText", () => {
  expect(sanitizeText).toBe(canonical);
  expect(sanitizeErrorMessage).toBe(canonicalErrorMessage);
});

test("the re-exported sanitizeText carries the canonical named replacements", () => {
  expect(sanitizeText("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def")).toBe(
    "auth [redacted-jwt]",
  );
  expect(sanitizeText("key AIzaSyD-1234567890abcdefghij")).toBe("key [redacted-google-key]");
  expect(sanitizeText("pat github_pat_11ABCDE0000abcdefghij")).toBe("pat [redacted-github-token]");
});
