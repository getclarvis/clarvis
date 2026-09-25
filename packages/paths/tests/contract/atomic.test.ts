import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { recorder } from "../helpers/recorder.ts";
import {
  DIR_MODE,
  FILE_MODE,
  fsyncDir,
  fsyncDirSync,
  isTmpFile,
  setPathsLogger,
  TMP_PREFIX,
  tmpPathFor,
  writeFileAtomic,
  writeFileAtomicSync,
  writeFileDurable,
  writeFileDurableSync,
} from "@clarvis/paths";

const made: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-paths-atomic-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  setPathsLogger(null);
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mode bits are unobservable under root. */
const modeBitsEnforced = process.getuid?.() !== 0;

/** Every temp file left behind in `dir`, as the shared recogniser sees them. */
const orphans = (dir: string): string[] => readdirSync(dir).filter((n) => isTmpFile(n));

const read = (file: string): string => readFileSync(file, "utf8");

describe("the temp-name builder and its recogniser", () => {
  test("builds a sibling of the target under the shared prefix", () => {
    const target = join(tempDir(), "settings.json");
    const tmp = tmpPathFor(target);
    expect(dirname(tmp)).toBe(dirname(target));
    expect(basename(tmp).startsWith(TMP_PREFIX)).toBe(true);
    expect(isTmpFile(basename(tmp))).toBe(true);
  });

  test("two writers inside one process never share a name", () => {
    const target = join(tempDir(), "keys.json");
    const names = new Set(Array.from({ length: 200 }, () => tmpPathFor(target)));
    expect(names.size).toBe(200);
  });

  test("carries the pid, so an orphan is attributable to a process", () => {
    expect(basename(tmpPathFor(join(tempDir(), "a.json")))).toContain(String(process.pid));
  });

  test("the recogniser accepts what the builder produces and nothing else", () => {
    expect(isTmpFile(basename(tmpPathFor("/work/repo/settings.json")))).toBe(true);
    expect(isTmpFile("settings.json")).toBe(false);
    for (const legacy of ["settings.json.tmp", `settings.json.tmp-${process.pid}`]) {
      expect(isTmpFile(legacy)).toBe(false);
    }
  });
});

describe("writeFileAtomic", () => {
  test("creates the parent directories and writes the content", async () => {
    const dir = tempDir();
    const file = join(dir, "nested", "deeper", "settings.json");
    await writeFileAtomic(file, '{"a":1}');
    expect(read(file)).toBe('{"a":1}');
  });

  test("replaces an existing file and leaves no temp behind", async () => {
    const dir = tempDir();
    const file = join(dir, "settings.json");
    await writeFileAtomic(file, "first");
    await writeFileAtomic(file, "second");
    expect(read(file)).toBe("second");
    expect(orphans(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  test("accepts bytes as well as text", async () => {
    const file = join(tempDir(), "blob.bin");
    await writeFileAtomic(file, new Uint8Array([1, 2, 3]));
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);
  });

  test("concurrent writers of one path all settle, and none orphans a temp", async () => {
    const dir = tempDir();
    const file = join(dir, "keys.json");
    const bodies = Array.from({ length: 12 }, (_, i) => `body-${i}`);
    await Promise.all(bodies.map((body) => writeFileAtomic(file, body)));
    expect(bodies).toContain(read(file));
    expect(orphans(dir)).toEqual([]);
  });

  test("removes the temp when the rename fails, and reports the rename's error", async () => {
    const dir = tempDir();
    const target = join(dir, "occupied");
    mkdirSync(target);
    await expect(writeFileAtomic(target, "x")).rejects.toThrow();
    expect(orphans(dir)).toEqual([]);
  });

  test.if(modeBitsEnforced)("writes the file owner-only and creates dirs owner-only", async () => {
    const dir = tempDir();
    const file = join(dir, "sub", "settings.json");
    await writeFileAtomic(file, "x");
    expect(statSync(file).mode & 0o777).toBe(FILE_MODE);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(DIR_MODE);
  });

  test.if(modeBitsEnforced)("honours an explicit mode and dirMode", async () => {
    const dir = tempDir();
    const file = join(dir, "sub", "public.json");
    await writeFileAtomic(file, "x", { mode: 0o644, dirMode: 0o755 });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o755);
  });
});

describe("writeFileAtomicSync", () => {
  test("writes the content and leaves no temp behind", () => {
    const dir = tempDir();
    const file = join(dir, "sub", "settings.json");
    writeFileAtomicSync(file, "first");
    writeFileAtomicSync(file, "second");
    expect(read(file)).toBe("second");
    expect(orphans(join(dir, "sub"))).toEqual([]);
  });

  test("removes the temp when the rename fails", () => {
    const dir = tempDir();
    const target = join(dir, "occupied");
    mkdirSync(target);
    expect(() => writeFileAtomicSync(target, "x")).toThrow();
    expect(orphans(dir)).toEqual([]);
  });

  test.if(modeBitsEnforced)("applies the same 0600 / 0700 posture", () => {
    const dir = tempDir();
    const file = join(dir, "sub", "settings.json");
    writeFileAtomicSync(file, "x");
    expect(statSync(file).mode & 0o777).toBe(FILE_MODE);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(DIR_MODE);
  });
});

describe("writeFileDurable", () => {
  test("writes the content, leaving no temp behind", async () => {
    const dir = tempDir();
    const file = join(dir, "state", "job.json");
    await writeFileDurable(file, '{"state":"pending"}');
    expect(read(file)).toBe('{"state":"pending"}');
    expect(orphans(join(dir, "state"))).toEqual([]);
  });

  test("replaces an existing commit point", async () => {
    const file = join(tempDir(), "journal");
    await writeFileDurable(file, "prepare");
    await writeFileDurable(file, "commit");
    expect(read(file)).toBe("commit");
  });

  test("removes the temp when the rename fails", async () => {
    const dir = tempDir();
    const target = join(dir, "occupied");
    mkdirSync(target);
    await expect(writeFileDurable(target, "x")).rejects.toThrow();
    expect(orphans(dir)).toEqual([]);
  });

  test.if(modeBitsEnforced)("applies the same 0600 / 0700 posture", async () => {
    const dir = tempDir();
    const file = join(dir, "sub", "journal");
    await writeFileDurable(file, "x");
    expect(statSync(file).mode & 0o777).toBe(FILE_MODE);
    expect(statSync(join(dir, "sub")).mode & 0o777).toBe(DIR_MODE);
  });
});

describe("writeFileDurableSync", () => {
  test("writes the content, leaving no temp behind", () => {
    const dir = tempDir();
    const file = join(dir, "auth-key.json");
    writeFileDurableSync(file, '{"kid":"k"}');
    expect(read(file)).toBe('{"kid":"k"}');
    expect(orphans(dir)).toEqual([]);
  });

  test("removes the temp when the rename fails", () => {
    const dir = tempDir();
    const target = join(dir, "occupied");
    mkdirSync(target);
    expect(() => writeFileDurableSync(target, "x")).toThrow();
    expect(orphans(dir)).toEqual([]);
  });
});

describe("fsyncDir", () => {
  test("flushes a real directory without throwing", async () => {
    await expect(fsyncDir(tempDir())).resolves.toBeUndefined();
  });

  test("is a no-op on a platform or path that will not give a directory handle", async () => {
    await expect(fsyncDir(join(tempDir(), "absent"))).resolves.toBeUndefined();
  });

  test("the synchronous form behaves the same way", () => {
    const dir = tempDir();
    expect(() => fsyncDirSync(dir)).not.toThrow();
    expect(() => fsyncDirSync(join(dir, "absent"))).not.toThrow();
  });
});

describe("atomic write diagnostics", () => {
  test("a staging failure reports the errno and that its temp was cleaned up", async () => {
    const sink = recorder();
    setPathsLogger(sink.logger);
    const dir = tempDir();
    const target = join(dir, "occupied");
    mkdirSync(target);
    await expect(writeFileAtomic(target, "x")).rejects.toThrow();
    const [failure] = sink.events("paths.atomic_staging_failed");
    expect(failure).toMatchObject({ file: target, durable: false, tmp_removed: true });
    expect(typeof failure?.code).toBe("string");
    expect(orphans(dir)).toEqual([]);
  });

  test("the synchronous durable writer reports the same event", () => {
    const sink = recorder();
    const dir = tempDir();
    const target = join(dir, "occupied");
    mkdirSync(target);
    expect(() => writeFileDurableSync(target, "x", { logger: sink.logger })).toThrow();
    expect(sink.events("paths.atomic_staging_failed")[0]).toMatchObject({
      file: target,
      durable: true,
      tmp_removed: true,
    });
  });

  test.if(modeBitsEnforced)(
    "a cleanup that cannot remove the temp is the half the thrown error never carries",
    async () => {
      const sink = recorder();
      const dir = tempDir();
      const locked = join(dir, "locked");
      try {
        await expect(
          writeFileAtomic(join(locked, "f.json"), "x", { dirMode: 0o000, logger: sink.logger }),
        ).rejects.toThrow();
        expect(sink.events("paths.atomic_staging_failed")[0]).toMatchObject({
          tmp_removed: false,
        });
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  test.if(modeBitsEnforced)("the synchronous writer reports the same leak", () => {
    const sink = recorder();
    const dir = tempDir();
    const locked = join(dir, "locked-sync");
    try {
      expect(() =>
        writeFileAtomicSync(join(locked, "f.json"), "x", {
          dirMode: 0o000,
          logger: sink.logger,
        }),
      ).toThrow();
      expect(sink.events("paths.atomic_staging_failed")[0]).toMatchObject({ tmp_removed: false });
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("a filesystem that will not sync a directory handle says so once per errno", async () => {
    const sink = recorder();
    setPathsLogger(sink.logger);
    const absent = join(tempDir(), "absent");
    await fsyncDir(absent);
    await fsyncDir(absent);
    fsyncDirSync(absent);
    const reported = sink.events("paths.fsync_dir_unsupported");
    expect(reported.length).toBe(1);
    expect(reported[0]).toMatchObject({ dir: absent, code: "ENOENT" });
  });
});
