import { mkdirSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  hashBoundedFile,
  readBoundedBytes,
  readBoundedText,
  readBoundedTextChunk,
} from "../../src/bounded-read.ts";
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

  it("pages UTF-8 text without splitting a multibyte character", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "paged.txt");
      writeFileSync(file, "a".repeat(1_023) + "😀" + "tail");
      const first = readBoundedTextChunk(file, {
        ...OPTIONS,
        offset: 0,
        maxFileBytes: 2_048,
        maxChars: 2_048,
      });
      expect(first.text).toBe("a".repeat(1_023));
      expect(first.nextOffset).toBe(1_023);
      const second = readBoundedTextChunk(file, {
        ...OPTIONS,
        offset: first.nextOffset!,
        maxFileBytes: 2_048,
        maxChars: 2_048,
      });
      expect(second.text).toBe("😀tail");
      expect(second.nextOffset).toBeUndefined();
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects chunk limits that cannot guarantee cursor progress", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "bounds.txt");
      writeFileSync(file, "text");
      expect(() =>
        readBoundedTextChunk(file, {
          ...OPTIONS,
          offset: 0,
          maxBytes: 0,
          maxFileBytes: 32,
          maxChars: 1,
        }),
      ).toThrow(/maxBytes must be an integer of at least 4/);
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects invalid chunk cursors and file bounds before reading payload bytes", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "bounded.txt");
      writeFileSync(file, "text");
      for (const options of [
        { offset: -1, maxBytes: 4, maxFileBytes: 32, maxChars: 4 },
        { offset: 0, maxBytes: 4, maxFileBytes: 0, maxChars: 4 },
        { offset: 0, maxBytes: 4, maxFileBytes: 32, maxChars: Number.NaN },
      ]) {
        expect(() => readBoundedTextChunk(file, { ...OPTIONS, ...options })).toThrow(SkillError);
      }
      expect(() =>
        readBoundedTextChunk(file, {
          ...OPTIONS,
          offset: 0,
          maxBytes: 4,
          maxFileBytes: 3,
          maxChars: 4,
        }),
      ).toThrow(/maximum bytes/);
      expect(() =>
        readBoundedTextChunk(file, {
          ...OPTIONS,
          offset: 5,
          maxBytes: 4,
          maxFileBytes: 32,
          maxChars: 4,
        }),
      ).toThrow(/past the end/);
    } finally {
      cleanup(workspace);
    }
  });

  it("returns stable EOF and rejects directories and absent chunk paths", () => {
    const workspace = makeWorkspace();
    try {
      const empty = path.join(workspace, "empty.txt");
      const directory = path.join(workspace, "directory");
      writeFileSync(empty, "");
      mkdirSync(directory);
      expect(
        readBoundedTextChunk(empty, {
          ...OPTIONS,
          offset: 0,
          maxFileBytes: 32,
          maxChars: 32,
        }),
      ).toEqual({ text: "", offset: 0, totalBytes: 0 });
      expect(() =>
        readBoundedTextChunk(directory, {
          ...OPTIONS,
          offset: 0,
          maxFileBytes: 32,
          maxChars: 32,
        }),
      ).toThrow(/not a regular file/);
      expect(() =>
        readBoundedTextChunk(path.join(workspace, "absent"), {
          ...OPTIONS,
          offset: 0,
          maxFileBytes: 32,
          maxChars: 32,
        }),
      ).toThrow(SkillError);
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects shortened, invalid UTF-8, and mid-sequence chunk reads", () => {
    const workspace = makeWorkspace();
    try {
      const short = path.join(workspace, "short.txt");
      const invalid = path.join(workspace, "invalid.txt");
      const multibyte = path.join(workspace, "multibyte.txt");
      writeFileSync(short, "seed");
      writeFileSync(invalid, Buffer.from([0xff]));
      writeFileSync(multibyte, "é");
      expect(() =>
        readBoundedTextChunk(
          short,
          { ...OPTIONS, offset: 0, maxFileBytes: 32, maxChars: 32 },
          () => 0,
        ),
      ).toThrow(/changed while it was being read/);
      expect(() =>
        readBoundedTextChunk(invalid, {
          ...OPTIONS,
          offset: 0,
          maxFileBytes: 32,
          maxChars: 32,
        }),
      ).toThrow(/not valid UTF-8/);
      expect(() =>
        readBoundedTextChunk(multibyte, {
          ...OPTIONS,
          offset: 1,
          maxFileBytes: 32,
          maxChars: 32,
        }),
      ).toThrow(/invalid UTF-8 cursor/);
    } finally {
      cleanup(workspace);
    }
  });

  it("never returns half of a UTF-16 surrogate pair at the character bound", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "surrogate.txt");
      writeFileSync(file, "a😀tail");
      expect(
        readBoundedTextChunk(file, {
          ...OPTIONS,
          offset: 0,
          maxFileBytes: 32,
          maxChars: 2,
        }),
      ).toMatchObject({ text: "a", nextOffset: 1 });
    } finally {
      cleanup(workspace);
    }
  });

  it("detects growth when a chunk had reached the opened size", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "chunk-growth.txt");
      writeFileSync(file, "seed");
      expect(() =>
        readBoundedTextChunk(
          file,
          { ...OPTIONS, offset: 0, maxFileBytes: 32, maxChars: 32 },
          (descriptor, buffer, offset, length, position) => {
            if (position === 4) return 1;
            return readSync(descriptor, buffer, offset, length, position);
          },
        ),
      ).toThrow(/changed while it was being read/);
    } finally {
      cleanup(workspace);
    }
  });

  it("probes an initially empty chunk before reporting stable EOF", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "empty-growth.txt");
      writeFileSync(file, "");
      expect(() =>
        readBoundedTextChunk(
          file,
          { ...OPTIONS, offset: 0, maxFileBytes: 32, maxChars: 32 },
          () => 1,
        ),
      ).toThrow(/changed while it was being read/);
    } finally {
      cleanup(workspace);
    }
  });

  it("hashes bounded raw bytes without decoding binary content", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "font.bin");
      writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd, 0x00]));
      const snapshot = hashBoundedFile(file, {
        maxBytes: 32,
        code: "invalid_skill",
        label: "test resource",
        logger: OPTIONS.logger,
      });
      expect(snapshot).toMatchObject({ bytes: 4, digest: expect.stringMatching(/^sha256:/) });
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects a non-finite or zero hashing bound", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "hash-bound.bin");
      writeFileSync(file, "x");
      for (const maxBytes of [Number.NaN, 0]) {
        expect(() =>
          hashBoundedFile(file, {
            maxBytes,
            code: "invalid_skill",
            label: "test resource",
            logger: OPTIONS.logger,
          }),
        ).toThrow(/maxBytes must be an integer of at least 1/);
      }
    } finally {
      cleanup(workspace);
    }
  });

  it("rejects non-files, absent files, and files above the hash bound", () => {
    const workspace = makeWorkspace();
    try {
      const directory = path.join(workspace, "hash-directory");
      const large = path.join(workspace, "large.bin");
      mkdirSync(directory);
      writeFileSync(large, "large");
      const options = {
        maxBytes: 4,
        code: "invalid_skill" as const,
        label: "test resource",
        logger: OPTIONS.logger,
      };
      expect(() => hashBoundedFile(directory, options)).toThrow(/not a regular file/);
      expect(() => hashBoundedFile(path.join(workspace, "absent"), options)).toThrow(SkillError);
      expect(() => hashBoundedFile(large, options)).toThrow(/maximum bytes/);
    } finally {
      cleanup(workspace);
    }
  });

  it("detects a hashing reader that grows or shortens the opened snapshot", () => {
    const workspace = makeWorkspace();
    try {
      const file = path.join(workspace, "changing.bin");
      writeFileSync(file, "x");
      const options = {
        maxBytes: 1,
        code: "invalid_skill" as const,
        label: "test resource",
        logger: OPTIONS.logger,
      };
      expect(() => hashBoundedFile(file, options, () => 2)).toThrow(/maximum bytes/);
      expect(() => hashBoundedFile(file, options, () => 0)).toThrow(
        /changed while it was being read/,
      );
    } finally {
      cleanup(workspace);
    }
  });
});
