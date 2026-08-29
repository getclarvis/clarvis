import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readableStateArtifactPath,
  sandboxWithReadableStateArtifacts,
} from "../../src/lib/state-artifacts.ts";
import { cleanup, makeConfig, makeWorkspace } from "../helpers/fixtures.ts";

let root: string;
beforeEach(() => {
  root = makeWorkspace();
});
afterEach(() => cleanup(root));

describe("readable state artifacts", () => {
  it("admits one exact regular spill without admitting sibling state", () => {
    const stateRoot = path.join(root, "state");
    const localDir = path.join(stateRoot, "local");
    const spill = path.join(localDir, "shell-token.stderr.log");
    const promptHistory = path.join(localDir, "prompt-history");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(spill, "output\n");
    writeFileSync(promptHistory, "history\n");

    expect(readableStateArtifactPath(spill, stateRoot)).toBe(spill);
    expect(readableStateArtifactPath(promptHistory, stateRoot)).toBeUndefined();
    expect(readableStateArtifactPath(localDir, stateRoot)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("rejects a spill-shaped symbolic link", () => {
    const stateRoot = path.join(root, "state");
    const localDir = path.join(stateRoot, "local");
    const target = path.join(root, "target.log");
    const spill = path.join(localDir, "shell-link.stdout.log");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(target, "outside\n");
    symlinkSync(target, spill);

    expect(readableStateArtifactPath(spill, stateRoot)).toBeUndefined();
  });

  it("adds a referenced spill to one sandbox call as a read-only path", () => {
    const stateRoot = path.join(root, "state");
    const localDir = path.join(stateRoot, "local");
    const spill = path.join(localDir, "shell-token.stdout.log");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(spill, "output\n");
    const config = makeConfig(root, {
      stateRoot,
      sandbox: { type: "native", readOnlyPaths: ["/opt/toolchain"] },
    });

    expect(
      sandboxWithReadableStateArtifacts(`grep output ${spill}`, config)?.readOnlyPaths,
    ).toEqual(["/opt/toolchain", spill]);
  });
});
