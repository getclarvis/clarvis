import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { inspectArtifactArchive } from "../../../packages/kernel/src/runtime/runtime-artifact-archive.ts";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheRuntimeArtifact,
  removeArtifactStage,
  parseRuntimeArtifactManifest,
  RUNTIME_ARTIFACT_LIMITS,
  validateRuntimeArtifact,
  type RuntimeArtifactManifest,
  type RuntimeArtifactSelection,
  type RuntimeArtifactSource,
} from "../../../packages/kernel/src/runtime/runtime-artifact.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeArtifactStage(root);
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identity = {
  productVersion: "1.2.3-beta.1+build.7",
  sourceRevision: "a".repeat(40),
  target: "linux-x64",
  baseAbi: "clarvis-linux-glibc-v1",
} as const;
const payload = [
  { path: "LICENSE", bytes: Buffer.from("license\n"), mode: 0o644 },
  { path: "assets/data.txt", bytes: Buffer.from("asset\n"), mode: 0o666 },
  { path: "bin/clarvis-kernel", bytes: Buffer.from("synthetic compiled kernel\n"), mode: 0o755 },
  { path: "licenses/dependency.txt", bytes: Buffer.from("dependency license\n"), mode: 0o644 },
];
function manifest(): RuntimeArtifactManifest {
  return {
    ...identity,
    schemaVersion: 1,
    dirty: false,
    kernelWireVersion: 10,
    brokerVersion: 1,
    channelVersion: 1,
    entrypoint: "bin/clarvis-kernel",
    files: payload.map((file) => ({
      path: file.path,
      size: file.bytes.length,
      sha256: hash(file.bytes),
      executable: file.path === "bin/clarvis-kernel",
    })),
  };
}
interface Member {
  path: string;
  bytes: Uint8Array;
  mode?: number;
  type?: string;
  size?: number;
  link?: string;
}
function header(member: Member): Buffer<ArrayBuffer> {
  const h = Buffer.alloc(512);
  h.write(member.path, 0, 100);
  const octal = (value: number, start: number, length: number) =>
    h.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length);
  octal(member.mode ?? 0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(member.size ?? member.bytes.length, 124, 12);
  octal(0, 136, 12);
  h.fill(32, 148, 156);
  h.write(member.type ?? "0", 156, 1);
  h.write(member.link ?? "", 157, 100);
  h.write("ustar\0", 257, 6);
  h.write("00", 263, 2);
  octal(
    h.reduce((sum, byte) => sum + byte, 0),
    148,
    8,
  );
  return h;
}
function archive(
  m: unknown = manifest(),
  extra: Member[] = [],
  members: Member[] = payload,
): Uint8Array<ArrayBuffer> {
  const entries = [
    ...members,
    ...extra,
    { path: "manifest.json", bytes: Buffer.from(JSON.stringify(m)) },
  ];
  return Bun.gzipSync(
    Buffer.concat([
      ...entries.flatMap((entry) => [
        header(entry),
        entry.bytes,
        Buffer.alloc((512 - (entry.bytes.length % 512)) % 512),
      ]),
      Buffer.alloc(1024),
    ]),
  );
}
async function fixture(bytes: Uint8Array = archive()) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-artifact-"));
  roots.push(root);
  const archivePath = join(root, "input.tar.gz");
  await writeFile(archivePath, bytes);
  const selection: RuntimeArtifactSelection = {
    ...identity,
    digest: `sha256:${hash(bytes)}`,
    size: bytes.length,
  };
  return {
    root,
    archivePath,
    selection,
    cacheRoot: join(root, "cache"),
    source: { kind: "local", archivePath } as const,
  };
}
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value));
const release: RuntimeArtifactSource = {
  kind: "release",
  repository: "getclarvis/clarvis-releases",
  tag: `v${identity.productVersion}`,
  assetName: "clarvis-kernel-linux-x64.tar.gz",
};

describe("runtime artifact release identity", () => {
  test("old manifest schema is unsupported rather than reinterpreted", () => {
    expect(() =>
      parseRuntimeArtifactManifest(encoded({ ...manifest(), schemaVersion: 0 }), identity),
    ).toThrow(expect.objectContaining({ code: "unsupported" }));
  });

  test("published artifacts reject dirty builds before cache publication and on cache reuse", async () => {
    const bytes = archive({ ...manifest(), dirty: true });
    const f = await fixture(bytes);
    await expect(
      cacheRuntimeArtifact({
        ...f,
        source: release,
        fetcher: () => Promise.resolve(new Response(bytes)),
      }),
    ).rejects.toThrow("dirty:false");
    expect(await readdir(f.cacheRoot)).toEqual([]);
    const local = await cacheRuntimeArtifact(f);
    expect(local.manifest.dirty).toBe(true);
    let downloads = 0;
    await expect(
      cacheRuntimeArtifact({
        ...f,
        source: release,
        fetcher: () => {
          downloads++;
          return Promise.resolve(new Response(bytes));
        },
      }),
    ).rejects.toThrow("dirty:false");
    expect(downloads).toBe(0);
    expect((await cacheRuntimeArtifact(f)).manifest.dirty).toBe(true);
  });
});

describe("runtime artifact cancellation and private cleanup", () => {
  test("cancels a pending download body and releases its lock", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            controller.abort(new Error("body cancelled"));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    );
    await expect(
      cacheRuntimeArtifact({
        ...f,
        source: release,
        signal: controller.signal,
        fetcher: () => Promise.resolve(response),
      }),
    ).rejects.toThrow("body cancelled");
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
    expect(await readdir(f.cacheRoot)).toEqual([]);
  });

  test("cancels existing cache validation without repairing or downloading", async () => {
    const f = await fixture();
    const cached = await cacheRuntimeArtifact(f);
    const controller = new AbortController();
    const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "throwIfAborted")
      ?.value as (this: AbortSignal) => void;
    let calls = 0;
    const check = spyOn(AbortSignal.prototype, "throwIfAborted").mockImplementation(function (
      this: AbortSignal,
    ) {
      if (++calls === 8) controller.abort(new Error("reuse cancelled"));
      original.call(this);
    });
    try {
      await expect(
        cacheRuntimeArtifact({
          ...f,
          source: release,
          signal: controller.signal,
          fetcher: () => {
            throw new Error("unexpected download");
          },
        }),
      ).rejects.toThrow("reuse cancelled");
    } finally {
      check.mockRestore();
    }
    expect(await readdir(f.cacheRoot)).toEqual([f.selection.digest.slice(7)]);
    expect(await cacheRuntimeArtifact(f)).toEqual(cached);
  });

  test.each(["local", "release"])(
    "pre-aborted %s preparation has no filesystem or network effects",
    async (kind) => {
      const f = await fixture();
      const signal = AbortSignal.abort(new Error("cancelled before preparation"));
      let calls = 0;
      await expect(
        cacheRuntimeArtifact({
          ...f,
          signal,
          source: kind === "local" ? f.source : release,
          fetcher: () => {
            calls++;
            throw new Error("unexpected fetch");
          },
        }),
      ).rejects.toThrow("cancelled before preparation");
      expect(calls).toBe(0);
      expect(existsSync(f.cacheRoot)).toBe(false);
      await expect(
        validateRuntimeArtifact(join(f.root, "absent"), f.selection, signal),
      ).rejects.toThrow("cancelled before preparation");
    },
  );

  test.each(["copy", "extract", "readonly"])(
    "cancels during local %s and removes only private stage",
    async (phase) => {
      const f = await fixture();
      const controller = new AbortController();
      const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "throwIfAborted")
        ?.value as (this: AbortSignal) => void;
      let triggered = false;
      const check = spyOn(AbortSignal.prototype, "throwIfAborted").mockImplementation(function (
        this: AbortSignal,
      ) {
        if (!triggered && existsSync(f.cacheRoot)) {
          const name = readdirSync(f.cacheRoot).find((entry) =>
            entry.startsWith(".runtime-artifact-"),
          );
          if (name !== undefined) {
            const stage = join(f.cacheRoot, name);
            const target =
              phase === "copy"
                ? join(stage, "archive.tar.gz")
                : phase === "extract"
                  ? join(stage, "payload", "LICENSE")
                  : join(stage, "payload");
            if (
              existsSync(target) &&
              (phase !== "readonly" || (statSync(target).mode & 0o777) === 0o555)
            ) {
              triggered = true;
              controller.abort(new Error("cancelled in preparation"));
            }
          }
        }
        original.call(this);
      });
      try {
        await expect(cacheRuntimeArtifact({ ...f, signal: controller.signal })).rejects.toThrow(
          "cancelled in preparation",
        );
      } finally {
        check.mockRestore();
      }
      expect(triggered).toBe(true);
      expect(await readdir(f.cacheRoot)).toEqual([]);
      expect(await readFile(f.archivePath)).toEqual(Buffer.from(archive()));
    },
  );

  test("verifies compressed hash before creating any extracted file", async () => {
    const f = await fixture();
    const destination = join(f.root, "payload");
    await mkdir(destination);
    await expect(
      inspectArtifactArchive(
        f.archivePath,
        { ...f.selection, digest: `sha256:${"0".repeat(64)}` },
        destination,
      ),
    ).rejects.toThrow("digest mismatch");
    expect(await readdir(destination)).toEqual([]);
  });

  test("removes readonly stage directories without following links or changing admitted cache", async () => {
    const f = await fixture();
    const cached = await cacheRuntimeArtifact(f);
    const stage = await mkdtemp(join(f.cacheRoot, ".runtime-artifact-"));
    await mkdir(join(stage, "nested"));
    await writeFile(join(stage, "nested", "file"), "private");
    await symlink(cached.root, join(stage, "nested", "link"), "dir");
    await chmod(join(stage, "nested", "file"), 0o444);
    await chmod(join(stage, "nested"), 0o555);
    await chmod(stage, 0o555);
    const before = (await lstat(cached.root)).mode;
    await removeArtifactStage(stage);
    expect(existsSync(stage)).toBe(false);
    expect((await lstat(cached.root)).mode).toBe(before);
    expect(await cacheRuntimeArtifact(f)).toEqual(cached);
  });

  test("releases download reader when exclusive output open fails", async () => {
    const f = await fixture();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(
      cacheRuntimeArtifact({
        ...f,
        source: release,
        fetcher: async () => {
          const stage = (await readdir(f.cacheRoot)).find((entry) =>
            entry.startsWith(".runtime-artifact-"),
          );
          await mkdir(join(f.cacheRoot, stage, "archive.tar.gz"));
          return response;
        },
      }),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
    expect(await readdir(f.cacheRoot)).toEqual([]);
  });
});

describe("runtime artifact manifest", () => {
  test("admits exact identity, SemVer and fixed production ceilings", () => {
    expect(parseRuntimeArtifactManifest(encoded(manifest()), identity)).toEqual(manifest());
    expect(RUNTIME_ARTIFACT_LIMITS).toEqual({
      manifestBytes: 1048576,
      files: 4096,
      compressedBytes: 536870912,
      extractedBytes: 1073741824,
      tarBytes: 1090519040,
      entries: 8193,
      redirects: 5,
    });
    expect(Object.isFrozen(RUNTIME_ARTIFACT_LIMITS)).toBe(true);
  });
  test.each([
    { schemaVersion: 0 },
    { schema: 1 },
    { extra: true },
    { dirty: "false" },
    { kernelWireVersion: 9 },
    { brokerVersion: 2 },
    { channelVersion: 2 },
    { entrypoint: "bin/other" },
    { baseAbi: "musl" },
    { target: "linux-arm64" },
    { sourceRevision: "A".repeat(40) },
    { sourceRevision: "b".repeat(40) },
    { productVersion: "1.2.4" },
    { productVersion: "01.2.3" },
    { productVersion: "1.2.3-beta.01" },
    { productVersion: "1.2.3-" },
    { productVersion: "1.2" },
    { productVersion: "1.2.3+" },
  ])("rejects closed schema and identity drift %j", (patch) => {
    expect(() =>
      parseRuntimeArtifactManifest(encoded({ ...manifest(), ...patch }), identity),
    ).toThrow();
  });
  test.each([
    "/escape",
    "../escape",
    "assets/../escape",
    "assets//x",
    "assets/./x",
    "C:/escape",
    "assets\\escape",
    "manifest.json",
    "other/file",
    "assets/NUL",
    "assets/x.",
    "assets/\u0000x",
  ])("rejects declaration path %s", (path) => {
    const m = manifest();
    expect(() =>
      parseRuntimeArtifactManifest(
        encoded({ ...m, files: [{ ...m.files[0], path }, ...m.files.slice(1)] }),
        identity,
      ),
    ).toThrow();
  });
  test("rejects ordering, duplicates, collisions, nonpositive/unsafe sizes, hashes and file limits", () => {
    const m = manifest();
    for (const files of [
      [...m.files].reverse(),
      [m.files[0], ...m.files],
      m.files.slice(1),
      m.files.map((f) => ({ ...f, executable: false })),
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, RUNTIME_ARTIFACT_LIMITS.extractedBytes].map(
        (size) => [{ ...m.files[0], size }, ...m.files.slice(1)],
      ),
      ...["A".repeat(64), `sha256:${"a".repeat(64)}`, "a".repeat(63)].map((sha256) => [
        { ...m.files[0], sha256 },
        ...m.files.slice(1),
      ]),
      [{ ...m.files[0], unexpected: true }, ...m.files.slice(1)],
      Array.from({ length: 4097 }, () => m.files[0]),
      [
        m.files[0],
        { ...m.files[1], path: "assets/a" },
        { ...m.files[1], path: "assets/a/b" },
        ...m.files.slice(2),
      ],
    ])
      expect(() => parseRuntimeArtifactManifest(encoded({ ...m, files }), identity)).toThrow();
  });
  test("bounds manifest bytes before parsing and rejects invalid UTF-8", () => {
    expect(() => parseRuntimeArtifactManifest(new Uint8Array(1048577), identity)).toThrow(
      "manifest size limit",
    );
    expect(() => parseRuntimeArtifactManifest(Uint8Array.of(255), identity)).toThrow();
  });
});

describe("bounded runtime artifact archive", () => {
  test("validates manifest-last archives and creates only declared read/executable permissions", async () => {
    const f = await fixture(
      archive(manifest(), [{ path: "assets/", type: "5", bytes: new Uint8Array() }]),
    );
    expect(await validateRuntimeArtifact(f.archivePath, f.selection)).toEqual(manifest());
    const cached = await cacheRuntimeArtifact(f);
    expect(await readFile(cached.entrypoint, "utf8")).toBe("synthetic compiled kernel\n");
    if (process.platform !== "win32") {
      expect((await lstat(cached.entrypoint)).mode & 0o7777).toBe(0o555);
      expect((await lstat(join(cached.root, "assets/data.txt"))).mode & 0o7777).toBe(0o444);
    }
    expect(
      await cacheRuntimeArtifact({
        ...f,
        source: release,
        fetcher: () => {
          throw new Error("must not download");
        },
      }),
    ).toEqual(cached);
    expect((await readdir(f.cacheRoot)).sort()).toEqual([f.selection.digest.slice(7)]);
  });
  test.each(["/escape", "../escape", "assets/../../escape", "assets\\x", "C:/escape", "other"])(
    "refuses malicious archive path %s",
    async (path) => {
      const f = await fixture(archive(manifest(), [{ path, bytes: Buffer.from("bad") }]));
      await expect(cacheRuntimeArtifact(f)).rejects.toThrow();
      expect(await readdir(f.cacheRoot)).toEqual([]);
    },
  );
  test.each(["1", "2", "3", "4", "6", "7", "s", "x", "g", "L", "K"])(
    "refuses links/devices/sockets/extensions type %s",
    async (type) => {
      const f = await fixture(
        archive(manifest(), [
          { path: "assets/link", type, link: "../../escape", bytes: Buffer.alloc(0) },
        ]),
      );
      await expect(validateRuntimeArtifact(f.archivePath, f.selection)).rejects.toThrow(
        "member type",
      );
    },
  );
  test.each([0o4755, 0o2755, 0o6755])("refuses setuid/setgid %i", async (mode) => {
    const f = await fixture(
      archive(
        manifest(),
        [],
        payload.map((p) => ({ ...p, mode })),
      ),
    );
    await expect(validateRuntimeArtifact(f.archivePath, f.selection)).rejects.toThrow(
      "permissions",
    );
  });
  test("refuses undeclared, missing, duplicate, empty and dishonest file bytes", async () => {
    const variants = [
      archive(manifest(), [{ path: "assets/extra", bytes: Buffer.from("x") }]),
      archive(manifest(), [], payload.slice(1)),
      archive(manifest(), [payload[0]]),
      archive(
        manifest(),
        [],
        payload.map((p, i) => (i === 0 ? { ...p, bytes: Buffer.alloc(0) } : p)),
      ),
      archive(
        manifest(),
        [],
        payload.map((p, i) => (i === 0 ? { ...p, bytes: Buffer.from("changed\n") } : p)),
      ),
      archive(
        manifest(),
        [],
        payload.map((p, i) => (i === 0 ? { ...p, bytes: Buffer.from("different size") } : p)),
      ),
      archive(manifest(), [{ path: "assets/empty/", type: "5", bytes: Buffer.alloc(0) }]),
    ];
    for (const bytes of variants) {
      const f = await fixture(bytes);
      await expect(validateRuntimeArtifact(f.archivePath, f.selection)).rejects.toThrow();
    }
  });
  test("bounds declared tar file and manifest sizes before consuming payload", async () => {
    for (const member of [
      { path: "manifest.json", size: 1048577 },
      { path: "assets/huge", size: 1073741825 },
    ]) {
      const f = await fixture(Bun.gzipSync(header({ ...member, bytes: Buffer.alloc(0) })));
      await expect(validateRuntimeArtifact(f.archivePath, f.selection)).rejects.toThrow("limit");
    }
  });
  test("bounds sparse compressed sources and selected compressed bytes before reading", async () => {
    const f = await fixture();
    await expect(
      validateRuntimeArtifact(f.archivePath, { ...f.selection, size: 536870913 }),
    ).rejects.toThrow();
    await truncate(f.archivePath, 536870913);
    await expect(validateRuntimeArtifact(f.archivePath, f.selection)).rejects.toThrow("oversized");
  });
  test("refuses archive size, digest, version, revision, ABI and target mismatch", async () => {
    const f = await fixture();
    for (const patch of [
      { size: f.selection.size + 1 },
      { size: f.selection.size - 1 },
      { digest: `sha256:${"b".repeat(64)}` },
      { productVersion: "1.2.4" },
      { sourceRevision: "b".repeat(40) },
      { target: "linux-arm64" },
      { baseAbi: "wrong" },
    ])
      await expect(
        validateRuntimeArtifact(f.archivePath, {
          ...f.selection,
          ...patch,
        } as RuntimeArtifactSelection),
      ).rejects.toThrow();
  });
  test("rejects malformed gzip, truncated tar, bad headers, padding and trailing members", async () => {
    const good = Bun.gunzipSync(archive());
    const checksum = good.slice();
    checksum[0] = 42;
    const padding = good.slice();
    padding[512 + payload[0].bytes.length] = 42;
    const tail = Buffer.concat([good, Buffer.from("x")]);
    for (const bytes of [
      Buffer.from("not gzip"),
      archive().slice(0, -4),
      Bun.gzipSync(good.slice(0, -512)),
      Bun.gzipSync(checksum),
      Bun.gzipSync(padding),
      Bun.gzipSync(tail),
    ]) {
      const f = await fixture(bytes);
      await expect(validateRuntimeArtifact(f.archivePath, f.selection)).rejects.toThrow();
    }
  });
  test("accepts matching arm64 identity without executing foreign bytes", async () => {
    const f = await fixture(archive({ ...manifest(), target: "linux-arm64" }));
    expect(
      (await validateRuntimeArtifact(f.archivePath, { ...f.selection, target: "linux-arm64" }))
        .target,
    ).toBe("linux-arm64");
  });
});

describe("host-only runtime artifact acquisition", () => {
  test.each([
    "http://github.com/x",
    "https://evil.example/x",
    "https://github.com:444/x",
    "https://user:password@github.com/x",
    "https://github.com.evil.example/x",
    "file:///tmp/x",
    "https://127.0.0.1/x",
  ])("refuses redirect BEFORE fetching %s", async (location) => {
    const f = await fixture();
    const calls: string[] = [];
    await expect(
      cacheRuntimeArtifact({
        ...f,
        source: release,
        fetcher: (url, init) => {
          calls.push(url);
          expect(init.redirect).toBe("manual");
          expect(init.credentials).toBe("omit");
          return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
        },
      }),
    ).rejects.toThrow("untrusted download");
    expect(calls).toHaveLength(1);
    expect(await readdir(f.cacheRoot)).toEqual([]);
  });
  test("allows five checked redirects across the three fixed hosts", async () => {
    const f = await fixture();
    let calls = 0;
    const locations = [
      "https://objects.githubusercontent.com/a",
      "https://release-assets.githubusercontent.com/b",
      "https://github.com/c",
      "/d",
      "https://objects.githubusercontent.com/e",
    ];
    const bytes = await readFile(f.archivePath);
    const result = await cacheRuntimeArtifact({
      ...f,
      source: release,
      fetcher: () => {
        const location = locations[calls++];
        return Promise.resolve(
          location === undefined
            ? new Response(bytes, { headers: { "content-length": String(bytes.length) } })
            : new Response(null, { status: 307, headers: { location } }),
        );
      },
    });
    expect(calls).toBe(6);
    expect(result.manifest).toEqual(manifest());
  });
  test("refuses sixth redirect before request seven", async () => {
    const f = await fixture();
    let calls = 0;
    await expect(
      cacheRuntimeArtifact({
        ...f,
        source: release,
        fetcher: () => {
          calls++;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://github.com/again" },
            }),
          );
        },
      }),
    ).rejects.toThrow("redirect limit");
    expect(calls).toBe(6);
  });
  test("refuses invalid source coordinates before fetching", async () => {
    const f = await fixture();
    for (const patch of [
      { repository: "evil/repo" },
      { tag: "v9.9.9" },
      { assetName: "../bad.tar.gz" },
      { assetName: "https://evil/x.tar.gz" },
    ]) {
      await expect(
        cacheRuntimeArtifact({
          ...f,
          source: { ...release, ...patch } as RuntimeArtifactSource,
          fetcher: () => {
            throw new Error("unexpected fetch");
          },
        }),
      ).rejects.toThrow("coordinates");
    }
  });
  test("refuses HTTP errors, missing redirects, size and digest mismatch; cleans partial stage", async () => {
    const f = await fixture();
    const bytes = await readFile(f.archivePath);
    for (const response of [
      new Response(null, { status: 404 }),
      new Response(null, { status: 302 }),
      new Response(bytes, { headers: { "content-length": "1" } }),
      new Response(bytes.slice(1)),
      new Response(Buffer.alloc(bytes.length)),
      new Response(Buffer.alloc(bytes.length + 1)),
    ]) {
      await expect(
        cacheRuntimeArtifact({ ...f, source: release, fetcher: () => Promise.resolve(response) }),
      ).rejects.toThrow();
      expect(await readdir(f.cacheRoot)).toEqual([]);
    }
  });
});

describe("immutable runtime artifact cache", () => {
  test.each(["corrupt", "missing", "extra", "manifest", "archive", "mode", "symlink", "hardlink"])(
    "refuses %s cache without overwrite or download",
    async (kind) => {
      const f = await fixture();
      const cached = await cacheRuntimeArtifact(f);
      await chmod(cached.root, 0o700);
      await chmod(join(cached.root, "assets"), 0o700);
      const asset = join(cached.root, "assets/data.txt");
      if (kind === "corrupt") {
        await chmod(asset, 0o600);
        await writeFile(asset, "evil!!");
        await chmod(asset, 0o444);
      }
      if (kind === "missing") await rm(asset);
      if (kind === "extra") await writeFile(join(cached.root, "extra"), "x");
      if (kind === "manifest") {
        const path = join(cached.root, "manifest.json");
        await chmod(path, 0o600);
        await writeFile(path, encoded({ ...manifest(), dirty: true }));
        await chmod(path, 0o444);
      }
      if (kind === "archive") {
        await chmod(cached.archivePath, 0o600);
        await writeFile(cached.archivePath, "corrupt");
      }
      if (kind === "mode") {
        if (process.platform === "win32") return;
        await chmod(asset, 0o666);
      }
      if (kind === "symlink") {
        await rm(asset);
        await symlink(f.archivePath, asset);
      }
      if (kind === "hardlink") {
        await rm(asset);
        await link(f.archivePath, asset);
      }
      await expect(
        cacheRuntimeArtifact({
          ...f,
          source: release,
          fetcher: () => {
            throw new Error("unexpected download");
          },
        }),
      ).rejects.toThrow();
      expect((await readdir(f.cacheRoot)).sort()).toEqual([f.selection.digest.slice(7)]);
    },
  );
  test("refuses incomplete digest directory and stale lock", async () => {
    const f = await fixture();
    const key = f.selection.digest.slice(7);
    await mkdir(f.cacheRoot, { mode: 0o700 });
    await mkdir(join(f.cacheRoot, key));
    await expect(cacheRuntimeArtifact(f)).rejects.toThrow("incomplete cache");
    expect(await readdir(join(f.cacheRoot, key))).toEqual([]);
    await mkdir(join(f.cacheRoot, `${key}.lock`));
    await expect(cacheRuntimeArtifact(f)).rejects.toThrow();
    expect(await readdir(join(f.cacheRoot, `${key}.lock`))).toEqual([]);
  });
  test("rejects linked cache root, linked digest directory, and linked local input", async () => {
    const f = await fixture();
    const real = join(f.root, "real");
    await mkdir(real);
    await symlink(real, f.cacheRoot);
    await expect(cacheRuntimeArtifact(f)).rejects.toThrow("directory");
    await rm(f.cacheRoot);
    await mkdir(f.cacheRoot, { mode: 0o700 });
    await symlink(real, join(f.cacheRoot, f.selection.digest.slice(7)));
    await expect(cacheRuntimeArtifact(f)).rejects.toThrow("directory");
    const alias = join(f.root, "alias.tar.gz");
    await symlink(f.archivePath, alias);
    await expect(validateRuntimeArtifact(alias, f.selection)).rejects.toThrow("non-regular");
  });
});
