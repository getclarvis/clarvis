import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readableStateArtifactPath } from "../../src/lib/state-artifacts.ts";
import { cleanup, makeWorkspace } from "../helpers/fixtures.ts";

let root: string;
beforeEach(() => {
  root = makeWorkspace();
});
afterEach(() => cleanup(root));

describe("readable state artifacts", () => {
  it("admits one exact regular spill without admitting sibling state", () => {
    const stateRoot = path.join(root, "state");
    const localDir = path.join(stateRoot, "local");
    const spill = path.join(localDir, "toolout-12345678.txt");
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
    const spill = path.join(localDir, "toolout-12345678.txt");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(target, "outside\n");
    symlinkSync(target, spill);

    expect(readableStateArtifactPath(spill, stateRoot)).toBeUndefined();
  });
});
