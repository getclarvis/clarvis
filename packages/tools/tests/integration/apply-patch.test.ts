import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  read,
  exists,
  writeBinary,
  writeUtf16,
  chmod,
  mode,
  modeBitsEnforced,
  posixShell,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";
import { applyPatchTool } from "../../src/tools/apply-patch.ts";

describe("apply_patch", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  describe("model-friendly patch envelope", () => {
    it("executes the literal example advertised to the model without repairing its newlines", async () => {
      const properties = applyPatchTool.inputSchema.properties as {
        patch: { description: string };
      };
      const example = properties.patch.description.match(
        /\*\*\* Begin Patch\n[\s\S]*?\*\*\* End Patch/,
      )?.[0];
      expect(example).toBeDefined();
      write(root, "path", "old\n");
      const result = await callTool("apply_patch", { patch: example! }, config);
      expect(result.isError).toBe(false);
      expect(read(root, "path")).toBe("new\n");
    });

    it("accepts update, add, delete, and move blocks atomically", async () => {
      write(root, "edit.txt", "alpha\nbeta\nomega\n");
      write(root, "delete.txt", "remove me\n");
      write(root, "move.txt", "before\n");
      const patch = `*** Begin Patch
*** Update File: edit.txt
@@
 alpha
-beta
+BETA
 omega
*** Add File: added.txt
+created
+successfully
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-before
+after
*** End Patch`;

      const r = await callTool("apply_patch", { patch }, config);

      expect(r.isError).toBe(false);
      expect(read(root, "edit.txt")).toBe("alpha\nBETA\nomega\n");
      expect(read(root, "added.txt")).toBe("created\nsuccessfully\n");
      expect(exists(root, "delete.txt")).toBe(false);
      expect(r.text).toContain("D delete.txt (+0 -1)");
      expect(exists(root, "move.txt")).toBe(false);
      expect(read(root, "moved.txt")).toBe("after\n");
    });

    it("tolerates surrounding blank lines in a model patch", async () => {
      write(root, "file.txt", "before\n");
      const patch = `\n*** Begin Patch
*** Update File: file.txt
@@
-before
+after
*** End Patch

`;

      const r = await callTool("apply_patch", { patch }, config);

      expect(r.isError).toBe(false);
      expect(read(root, "file.txt")).toBe("after\n");
    });

    it("uses section anchors and the end-of-file marker", async () => {
      write(root, "anchors.txt", "first\nneedle\nfirst\nneedle\ntail\n");
      const patch = `*** Begin Patch
*** Update File: anchors.txt
@@ first
-needle
+FIRST_NEEDLE
@@
 tail
+last
*** End of File
*** End Patch`;

      const r = await callTool("apply_patch", { patch }, config);

      expect(r.isError).toBe(false);
      expect(read(root, "anchors.txt")).toBe("first\nFIRST_NEEDLE\nfirst\nneedle\ntail\nlast\n");
    });

    it("accepts a numbered unified hunk inside the model envelope", async () => {
      write(root, "numbered.txt", "one\ntwo\n");
      const patch = `*** Begin Patch
*** Update File: numbered.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
*** End Patch`;

      const r = await callTool("apply_patch", { patch }, config);

      expect(r.isError).toBe(false);
      expect(read(root, "numbered.txt")).toBe("one\nTWO\n");
    });

    it("uses numbered coordinates for insertion-only and duplicate-context hunks", async () => {
      write(root, "coordinates.txt", "one\ntwo\nthree\nsame\nsame\n");
      const patch = `*** Begin Patch
*** Update File: coordinates.txt
@@ -2,0 +3,1 @@
+inserted
@@ -5,1 +6,1 @@
-same
+SECOND_SAME
*** End Patch`;

      const result = await callTool("apply_patch", { patch }, config);

      expect(result.isError).toBe(false);
      expect(read(root, "coordinates.txt")).toBe("one\ntwo\ninserted\nthree\nsame\nSECOND_SAME\n");
    });

    it("leaves every file unchanged when a later model-style hunk fails", async () => {
      write(root, "one.txt", "one\n");
      write(root, "two.txt", "two\n");
      const patch = `*** Begin Patch
*** Update File: one.txt
@@
-one
+ONE
*** Update File: two.txt
@@
-missing
+TWO
*** End Patch`;

      const r = await callTool("apply_patch", { patch }, config);

      expect(r.json.error).toBe("patch_failed");
      expect(r.json.file).toBe("two.txt");
      expect(r.json.hunk).toBe(1);
      expect(read(root, "one.txt")).toBe("one\n");
      expect(read(root, "two.txt")).toBe("two\n");
    });

    it("returns a precise format error instead of treating a model envelope as an empty diff", async () => {
      const patch = `*** Begin Patch
*** Add File: bad.txt
missing-plus
*** End Patch`;

      const r = await callTool("apply_patch", { patch }, config);

      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("every content line to start with +");
      expect(exists(root, "bad.txt")).toBe(false);
    });
  });

  describe("modifying an existing file", () => {
    it("modifies a file", async () => {
      write(root, "f.txt", "line1\nline2\nline3\n");
      const patch = `--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+CHANGED\n line3\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("M f.txt");
      expect(read(root, "f.txt")).toMatch(/^line1\nCHANGED\nline3\n?$/);
    });

    it.skipIf(!modeBitsEnforced)("preserves the executable bit of a modified file", async () => {
      write(root, "x.sh", "echo a\n");
      chmod(root, "x.sh", 0o755);
      const patch = `--- a/x.sh\n+++ b/x.sh\n@@ -1,1 +1,1 @@\n-echo a\n+echo b\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(mode(root, "x.sh")).toBe(0o755);
    });

    it("errors is_binary for a binary target", async () => {
      writeBinary(root, "bin");
      const patch = `--- a/bin\n+++ b/bin\n@@ -1,1 +1,1 @@\n-a\n+b\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("is_binary");
    });

    it("refuses to patch a UTF-16 file (no silent transcode to UTF-8)", async () => {
      writeUtf16(root, "u16.txt", "hello\nworld\n");
      const patch = `--- a/u16.txt\n+++ b/u16.txt\n@@ -1,2 +1,2 @@\n-hello\n+HELLO\n world\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("is_binary");
    });
  });

  describe("creating a file", () => {
    it("creates a file", async () => {
      const patch = `--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("A new.txt");
      expect(read(root, "new.txt")).toMatch(/^hello\nworld\n?$/);
    });

    it("refuses to clobber an existing file with a /dev/null create", async () => {
      write(root, "exists.txt", "keep me\n");
      const patch = `--- /dev/null\n+++ b/exists.txt\n@@ -0,0 +1,1 @@\n+clobber\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(read(root, "exists.txt")).toBe("keep me\n");
    });

    it("rejects a create whose target already exists", async () => {
      write(root, "dup.txt", "existing\n");
      const patch = `--- /dev/null\n+++ b/dup.txt\n@@ -0,0 +1,1 @@\n+new\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("already exists");
      expect(read(root, "dup.txt")).toBe("existing\n");
    });

    // POSIX reports ENOTDIR here, which fsError maps to not_a_file. Windows
    // raises some other code for the same mistake - it reaches fsError's
    // io_error fallback - and which one has not been identified, so this asserts
    // the mapping only where the mapping is known to apply.
    it.skipIf(!posixShell)(
      "fails with not_a_file when creating a file beneath a path that is itself a file",
      async () => {
        write(root, "notdir", "iamafile\n");
        const patch = `--- /dev/null\n+++ b/notdir/child.txt\n@@ -0,0 +1,1 @@\n+x\n`;
        const r = await callTool("apply_patch", { patch }, config);
        expect(r.json.error).toBe("not_a_file");
        expect(exists(root, "notdir/child.txt")).toBe(false);
      },
    );
  });

  describe("deleting a file", () => {
    it("deletes a file", async () => {
      write(root, "del.txt", "bye\n");
      const patch = `--- a/del.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("D del.txt");
      expect(exists(root, "del.txt")).toBe(false);
    });

    it("rejects a delete patch that does not remove the whole file", async () => {
      write(root, "f.txt", "a\nb\n");
      const patch = `--- a/f.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(read(root, "f.txt")).toBe("a\nb\n");
    });
  });

  describe("renaming and moving files", () => {
    it("renames a file with no content change (pure rename)", async () => {
      write(root, "old.txt", "hello\nworld\n");
      const patch = `--- a/old.txt\n+++ b/new.txt\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("R old.txt -> new.txt");
      expect(exists(root, "old.txt")).toBe(false);
      expect(read(root, "new.txt")).toBe("hello\nworld\n");
    });

    it("renames a file and applies its content changes", async () => {
      write(root, "from.txt", "one\ntwo\n");
      const patch = `--- a/from.txt\n+++ b/to.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBeUndefined();
      expect(r.text).toContain("R from.txt -> to.txt");
      expect(read(root, "to.txt")).toBe("ONE\ntwo\n");
      expect(exists(root, "from.txt")).toBe(false);
    });

    it("moves and edits a file, creating the destination dir and preserving CRLF+BOM", async () => {
      write(root, "old.txt", "﻿hello\r\nworld\r\n");
      const patch = `--- a/old.txt\n+++ b/sub/new.txt\n@@ -1,2 +1,2 @@\n-hello\n+HELLO\n world\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(r.text).toContain("R old.txt -> sub/new.txt");
      expect(exists(root, "old.txt")).toBe(false);
      expect(read(root, "sub/new.txt")).toBe("﻿HELLO\r\nworld\r\n");
    });

    it.skipIf(!modeBitsEnforced)("preserves the mode of a renamed file", async () => {
      write(root, "run.sh", "echo hi\n");
      chmod(root, "run.sh", 0o755);
      const patch = `--- a/run.sh\n+++ b/run2.sh\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.isError).toBe(false);
      expect(exists(root, "run.sh")).toBe(false);
      expect(mode(root, "run2.sh")).toBe(0o755);
    });

    it("treats a rename whose paths resolve to the same file as a plain modify", async () => {
      write(root, "same.txt", "a\nb\n");
      const patch = `--- a/same.txt\n+++ b/./same.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBeUndefined();
      expect(r.text).toContain("M same.txt");
      expect(read(root, "same.txt")).toBe("A\nb\n");
      expect(exists(root, "./same.txt")).toBe(true);
    });

    it("refuses a rename whose destination already exists and changes nothing", async () => {
      write(root, "old.txt", "a\n");
      write(root, "new.txt", "keep me\n");
      const patch = `--- a/old.txt\n+++ b/new.txt\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(read(root, "old.txt")).toBe("a\n");
      expect(read(root, "new.txt")).toBe("keep me\n");
    });

    it("refuses a rename chain that reuses an endpoint (A->B, B->C)", async () => {
      write(root, "a.txt", "1\n");
      write(root, "b.txt", "2\n");
      const patch = `--- a/a.txt\n+++ b/b.txt\n` + `--- a/b.txt\n+++ b/c.txt\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(exists(root, "a.txt")).toBe(true);
      expect(exists(root, "c.txt")).toBe(false);
    });

    it("errors not_found when the rename source does not exist", async () => {
      const patch = `--- a/nope.txt\n+++ b/new.txt\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("not_found");
    });

    it("errors not_a_file when the rename source is a directory", async () => {
      mkdirSync(path.join(root, "dir"));
      const patch = `--- a/dir\n+++ b/dir2\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("not_a_file");
    });
  });

  describe("atomicity and rollback across a batch", () => {
    it("is atomic across files: a failed hunk changes nothing and reports file+hunk", async () => {
      write(root, "ok.txt", "aaa\n");
      write(root, "bad.txt", "bbb\n");
      const patch =
        `--- a/ok.txt\n+++ b/ok.txt\n@@ -1,1 +1,1 @@\n-aaa\n+AAA\n` +
        `--- a/bad.txt\n+++ b/bad.txt\n@@ -1,1 +1,1 @@\n-WRONGCONTEXT\n+X\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("patch_failed");
      expect(r.json.file).toBe("bad.txt");
      expect(r.json.hunk).toBe(1);
      expect(read(root, "ok.txt")).toBe("aaa\n");
    });

    it.skipIf(!modeBitsEnforced)(
      "rolls back a rename when a later op in the batch fails at commit",
      async () => {
        write(root, "old.txt", "keep\n");
        mkdirSync(path.join(root, "sub"));
        write(root, "sub/B.txt", "bye\n");
        chmod(root, "sub", 0o500);
        const patch =
          `--- a/old.txt\n+++ b/moved.txt\n@@ -1,1 +1,1 @@\n-keep\n+CHANGED\n` +
          `--- a/sub/B.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n`;
        const r = await callTool("apply_patch", { patch }, config);
        expect(r.isError).toBe(true);

        expect(read(root, "old.txt")).toBe("keep\n");
        expect(exists(root, "moved.txt")).toBe(false);
        expect(exists(root, "sub/B.txt")).toBe(true);
        chmod(root, "sub", 0o700);
        expect(readdirSync(root).filter((f) => f.startsWith(".clarvis-tmp"))).toHaveLength(0);
      },
    );

    it.skipIf(!modeBitsEnforced)(
      "removes directories it created when the batch fails (no orphaned dirs)",
      async () => {
        mkdirSync(path.join(root, "locked"));
        chmod(root, "locked", 0o500);
        const patch =
          `--- /dev/null\n+++ b/newdir/a.txt\n@@ -0,0 +1,1 @@\n+hello\n` +
          `--- /dev/null\n+++ b/locked/b.txt\n@@ -0,0 +1,1 @@\n+world\n`;
        const r = await callTool("apply_patch", { patch }, config);
        expect(r.isError).toBe(true);

        expect(exists(root, "newdir")).toBe(false);
        expect(exists(root, "locked/b.txt")).toBe(false);
        chmod(root, "locked", 0o700);
        expect(readdirSync(root).filter((f) => f.startsWith(".clarvis-tmp"))).toHaveLength(0);
      },
    );

    it.skipIf(!modeBitsEnforced)(
      "is all-or-nothing across the commit phase: a delete that cannot apply rolls back the modify",
      async () => {
        write(root, "A.txt", "line1\n");
        mkdirSync(path.join(root, "sub"));
        write(root, "sub/B.txt", "bye\n");
        chmod(root, "sub", 0o500);
        const patch =
          `--- a/A.txt\n+++ b/A.txt\n@@ -1,1 +1,1 @@\n-line1\n+CHANGED\n` +
          `--- a/sub/B.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n`;
        const r = await callTool("apply_patch", { patch }, config);
        expect(r.isError).toBe(true);

        expect(read(root, "A.txt")).toBe("line1\n");
        expect(exists(root, "sub/B.txt")).toBe(true);
        chmod(root, "sub", 0o700);
        expect(readdirSync(root).filter((f) => f.startsWith(".clarvis-tmp"))).toHaveLength(0);
      },
    );
  });

  describe("parsing and validating the patch", () => {
    it("rejects a non-empty patch document with no file blocks", async () => {
      const r = await callTool("apply_patch", { patch: "\n" }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("no applicable hunks");
    });

    it("rejects a patch whose +++ header is missing", async () => {
      const patch = `--- a/f\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("Malformed patch");
    });

    it("rejects a same-name block with no hunks as not actionable", async () => {
      const patch = `--- a/x.txt\n+++ b/x.txt\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("no applicable hunks");
    });

    it("rejects a /dev/null -> /dev/null block with no hunks as not actionable", async () => {
      const patch = `--- /dev/null\n+++ /dev/null\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("no applicable hunks");
    });

    it("rejects a /dev/null -> /dev/null block even when it carries a hunk", async () => {
      const patch = `--- /dev/null\n+++ /dev/null\n@@ -0,0 +1,1 @@\n+x\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("missing a valid file path");
    });

    it("rejects a hunk-only patch that has no file headers", async () => {
      const patch = `@@ -1,1 +1,1 @@\n-a\n+b\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(r.text).toContain("missing a valid file path");
    });

    it("strips a tab-timestamp header and still applies the modify", async () => {
      write(root, "ts.txt", "x\ny\n");
      const patch =
        `--- a/ts.txt\t2020-01-01 00:00:00\n` +
        `+++ b/ts.txt\t2020-01-02 00:00:00\n` +
        `@@ -1,2 +1,2 @@\n-x\n+X\n y\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBeUndefined();
      expect(read(root, "ts.txt")).toBe("X\ny\n");
    });

    it("ignores out-of-schema extra fields", async () => {
      write(root, "f.txt", "x\n");
      const patch = `--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n`;
      const r = await callTool("apply_patch", { patch, bogus: 1 }, config);
      expect(r.isError).toBe(false);
      expect(read(root, "f.txt")).toBe("y\n");
    });

    it("refuses multiple blocks targeting the same file (no silent last-wins)", async () => {
      write(root, "g.txt", "x1\nx2\nx3\n");
      const patch =
        `--- a/g.txt\n+++ b/g.txt\n@@ -1,1 +1,1 @@\n-x1\n+X1\n` +
        `--- a/g.txt\n+++ b/g.txt\n@@ -3,1 +3,1 @@\n-x3\n+X3\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("invalid_input");
      expect(read(root, "g.txt")).toBe("x1\nx2\nx3\n");
    });
  });

  describe("reporting which hunk failed", () => {
    it("reports patch_failed when a rename's hunk does not apply cleanly", async () => {
      write(root, "old.txt", "actual content\n");
      const patch = `--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-WRONGCONTEXT\n+X\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("patch_failed");
      expect(r.json.file).toBe("old.txt");
      expect(r.json.hunk).toBe(1);
      expect(read(root, "old.txt")).toBe("actual content\n");
      expect(exists(root, "new.txt")).toBe(false);
    });

    it("names the second hunk when an earlier hunk applies but a later one fails", async () => {
      write(root, "m.txt", "1\n2\n3\n4\n5\n");
      const patch =
        `--- a/m.txt\n+++ b/m.txt\n` +
        `@@ -1,1 +1,1 @@\n-1\n+ONE\n` +
        `@@ -3,1 +3,1 @@\n-WRONGCONTEXT\n+X\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("patch_failed");
      expect(r.json.file).toBe("m.txt");
      expect(r.json.hunk).toBe(2);
      expect(read(root, "m.txt")).toBe("1\n2\n3\n4\n5\n");
    });

    it("reports patch_failed with no hunk number when the combined patch fails but each hunk applies alone", async () => {
      write(root, "f.txt", "NEEDLE\na\nb\nKEY\nc\nd\n");
      const patch =
        `--- a/f.txt\n+++ b/f.txt\n` +
        `@@ -4,1 +4,1 @@\n-KEY\n+KEY2\n` +
        `@@ -6,1 +6,1 @@\n-NEEDLE\n+NEEDLE2\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("patch_failed");
      expect(r.json.file).toBe("f.txt");
      expect(r.json.hunk).toBeUndefined();
      expect(read(root, "f.txt")).toBe("NEEDLE\na\nb\nKEY\nc\nd\n");
    });

    it("reports a rename patch_failed with no hunk number when each hunk applies alone", async () => {
      write(root, "ren.txt", "NEEDLE\na\nb\nKEY\nc\nd\n");
      const patch =
        `--- a/ren.txt\n+++ b/ren2.txt\n` +
        `@@ -4,1 +4,1 @@\n-KEY\n+KEY2\n` +
        `@@ -6,1 +6,1 @@\n-NEEDLE\n+NEEDLE2\n`;
      const r = await callTool("apply_patch", { patch }, config);
      expect(r.json.error).toBe("patch_failed");
      expect(r.json.file).toBe("ren.txt");
      expect(r.json.hunk).toBeUndefined();
      expect(read(root, "ren.txt")).toBe("NEEDLE\na\nb\nKEY\nc\nd\n");
      expect(exists(root, "ren2.txt")).toBe(false);
    });
  });
});
