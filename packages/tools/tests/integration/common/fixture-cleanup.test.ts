import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { ExecutionSessionManager } from "../../../src/lib/execution-session.ts";
import { cleanup, makeConfig, makeWorkspace } from "../../helpers/fixtures.ts";

test("fixture waits for session closure before removing its own roots", async () => {
  const first = makeWorkspace();
  const second = makeWorkspace();
  const manager = new ExecutionSessionManager();
  makeConfig(first, { sessionManager: manager });
  let release!: (confirmed: boolean) => void;
  const closed = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const close = spyOn(manager, "close").mockImplementation(() => closed);
  try {
    const pending = cleanup(first);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    release(true);
    await pending;
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  } finally {
    close.mockRestore();
    if (existsSync(first)) await cleanup(first);
    await cleanup(second);
  }
});

test("unconfirmed session exit retains the roots and reports the failure", async () => {
  const root = makeWorkspace();
  const manager = new ExecutionSessionManager();
  makeConfig(root, { sessionManager: manager });
  const close = spyOn(manager, "close").mockResolvedValue(false);
  try {
    await expect(cleanup(root)).rejects.toThrow("roots retained");
    expect(existsSync(root)).toBe(true);
  } finally {
    close.mockRestore();
    await cleanup(root);
  }
});
