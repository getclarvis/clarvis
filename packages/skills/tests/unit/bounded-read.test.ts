import { mkdirSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { readBoundedBytes, readBoundedText } from "../../src/bounded-read.ts";
import { SkillError } from "../../src/errors.ts";
import { cleanup, makeWorkspace } from "../helpers/fixtures.ts";
import { recordingLogger } from "../helpers/logging.ts";

const OPTIONS = {
  maxBytes: 1_024,
  maxChars: 1_024,
  code: "invalid_input" as const,
  label: "test input",
  logger: recordingLogger().logger,
};

describe("bounded text reads", () => {
  it("preserves exact bytes for snapshot consumers", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "bytes.bin");
      const expected = Buffer.from([0xff, 0x00, 0x01, 0x7f]);
      writeFileSync(file, expected);

      expect(readBoundedBytes(file, OPTIONS)).toEqual(expected);
    } finally {
      cleanup(workspace);
    }
  });

  it("enforces character bounds for snapshot byte consumers", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "characters.txt");
      writeFileSync(file, "four");

      expect(() => readBoundedBytes(file, { ...OPTIONS, maxChars: 3 })).toThrow(
        /maximum characters/,
      );
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects a directory before allocating a payload buffer", () => {
    const workspace = makeWorkspace();
    try {
      const directory = path.join(workspace, "directory");
      mkdirSync(directory);

      expect(() => readBoundedText(directory, OPTIONS)).toThrow(SkillError);
      expect(() => readBoundedText(directory, OPTIONS)).toThrow(/not a regular file/);
    } finally {
      cleanup(workspace);
    }
  });

  it.skipIf(process.platform !== "linux")(
    "detects a procfs file whose reported size changes during the bounded read",
    () => {
      // procfs reports this regular file as zero bytes, but a subsequent read
      // yields the process command line. That deterministically exercises the
      // same growth check that protects against a concurrently appended file.
      expect(() => readBoundedText("/proc/self/cmdline", OPTIONS)).toThrow(
        /changed while it was being read/,
      );
    },
  );

  it("detects deterministic growth after the bounded payload read on every host", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "growing.txt");
      writeFileSync(file, "seed");

      expect(() =>
        readBoundedText(file, OPTIONS, (descriptor, buffer, offset, length, position) => {
          if (position === 4) return 1;
          return readSync(descriptor, buffer, offset, length, position);
        }),
      ).toThrow(/changed while it was being read/);
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects a file that becomes shorter than its opened descriptor snapshot", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "short.txt");
      writeFileSync(file, "seed");

      expect(() =>
        readBoundedBytes(file, OPTIONS, (descriptor, buffer, offset, length, position) => {
          if (position === 2) return 0;
          return readSync(descriptor, buffer, offset, Math.min(length, 2), position);
        }),
      ).toThrow(/changed while it was being read/);
    } finally {
      cleanup(workspace);
    }
  });
});
