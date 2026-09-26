import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDigest,
  packCiBuild,
  readBuildIdentity,
  requireBuildProducer,
  restoreCiBuild,
  validateCiBuild,
  type BuildIdentity,
} from "../../lib/ci-artifacts.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const identity: BuildIdentity = {
  commit: "a".repeat(40),
  runId: "123",
  producerAttempt: "1",
  bunVersion: Bun.version,
  bunRevision: Bun.revision,
  platform: process.platform,
  arch: process.arch,
  lockSha256: "b".repeat(64),
};
const directories = ["packages/code/dist", "packages/protocol/dist"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-ci-artifact-"));
  roots.push(root);
  await writeFile(join(root, "private-settings.json"), "PRIVATE_FIXTURE_STATE");
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules", "dependency"), "INSTALLED_DEPENDENCY_FIXTURE");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/code", "packages/protocol"] }),
  );
  for (const name of ["code", "protocol"]) {
    const pkg = join(root, "packages", name);
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: `@clarvis/${name}`, scripts: { build: "fixture" } }),
    );
    await writeFile(join(pkg, "dist/index.js"), "export const built = true;\n");
    await writeFile(join(pkg, "dist/.tsbuildinfo"), "incremental\n");
  }
  await writeFile(join(root, "packages/code/dist/executable"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "packages/code/dist/executable"), 0o755);
  const archive = await packCiBuild(root, identity);
  return { root, archive, bytes: await readFile(archive.path) };
}

function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  const value = header
    .reduce((sum, byte) => sum + byte, 0)
    .toString(8)
    .padStart(6, "0");
  header.write(`${value}\0 `, 148, "ascii");
}

function member(bytes: Buffer, name: string) {
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString().split("\0")[0];
    const size = Number.parseInt(
      header.subarray(124, 136).toString().replaceAll("\0", "").trim(),
      8,
    );
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    if (path === name) return { offset, end, header, size };
    if (!Number.isFinite(size)) break;
    offset = end;
  }
  throw new Error(`Fixture tar member not found: ${name}`);
}

function mutateHeader(bytes: Buffer, name: string, mutate: (header: Buffer) => void) {
  const changed = Buffer.from(bytes);
  const { header } = member(changed, name);
  mutate(header);
  checksum(header);
  return changed;
}

function mutateManifest(bytes: Buffer, mutate: (manifest: any) => void) {
  const { offset, end, header, size } = member(bytes, "ci-build-manifest.json");
  const manifest = JSON.parse(bytes.subarray(offset + 512, offset + 512 + size).toString());
  mutate(manifest);
  const data = Buffer.from(JSON.stringify(manifest));
  const updated = Buffer.from(header);
  updated.fill(0, 124, 136);
  updated.write(data.length.toString(8).padStart(11, "0"), 124, "ascii");
  checksum(updated);
  return Buffer.concat([
    bytes.subarray(0, offset),
    updated,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
    bytes.subarray(end),
  ]);
}

describe("shared Linux build artifact", () => {
  test("round trips the full build, dotfiles and executable permissions without private files", async () => {
    const { root, archive, bytes } = await fixture();
    expect(
      validateCiBuild(bytes, identity, directories).some((entry) =>
        entry.path.includes(".tsbuildinfo"),
      ),
    ).toBe(true);
    for (const directory of directories) await rm(join(root, directory), { recursive: true });
    expect(await restoreCiBuild(root, archive.path, identity, archive.digest)).toBe(archive.bytes);
    expect(await readFile(join(root, "packages/code/dist/.tsbuildinfo"), "utf8")).toBe(
      "incremental\n",
    );
    expect((await lstat(join(root, "packages/code/dist/executable"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(root, "private-settings.json"), "utf8")).toBe(
      "PRIVATE_FIXTURE_STATE",
    );
    expect(bytes.includes(Buffer.from("PRIVATE_FIXTURE_STATE"))).toBe(false);
    expect(bytes.includes(Buffer.from("INSTALLED_DEPENDENCY_FIXTURE"))).toBe(false);
  });

  test("attributes the current checkout using real Git, Bun and lockfile bytes", async () => {
    const observed = await readBuildIdentity(process.cwd(), "123", "1");
    const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
    expect(observed.commit).toBe(git.stdout.toString().trim());
    expect(observed.bunRevision).toBe(Bun.revision);
    expect(observed.lockSha256).toBe(buildDigest(await readFile("bun.lock")));
    await expect(readBuildIdentity(process.cwd(), "", "1")).rejects.toThrow("run ID");
  });

  test("rejects every identity mismatch and an incorrect transported digest before restoring", async () => {
    const { root, archive, bytes } = await fixture();
    for (const key of Object.keys(identity))
      expect(() =>
        validateCiBuild(bytes, { ...identity, [key]: "different" }, directories),
      ).toThrow(`identity mismatch: ${key}`);
    await expect(restoreCiBuild(root, archive.path, identity, "0".repeat(64))).rejects.toThrow(
      "digest mismatch",
    );
    expect(await readFile(join(root, "packages/code/dist/index.js"), "utf8")).toContain(
      "built = true",
    );
  });

  test("uses a successful earlier producer's attempt instead of the consumer's attempt", async () => {
    const { bytes } = await fixture();
    const producer = requireBuildProducer({
      CI_BUILD_ARTIFACT_ID: "42",
      CI_BUILD_ARTIFACT_DIGEST: "c".repeat(64),
      CI_BUILD_TAR_DIGEST: buildDigest(bytes),
      CI_BUILD_PRODUCER_ATTEMPT: "1",
      GITHUB_RUN_ATTEMPT: "2",
    });
    expect(() =>
      validateCiBuild(bytes, { ...identity, producerAttempt: producer.attempt }, directories),
    ).not.toThrow();
    expect(() =>
      validateCiBuild(bytes, { ...identity, producerAttempt: "2" }, directories),
    ).toThrow("producerAttempt");
  });

  test("requires all producer outputs and never substitutes a name or consumer attempt", () => {
    const env = {
      CI_BUILD_ARTIFACT_ID: "42",
      CI_BUILD_ARTIFACT_DIGEST: "c".repeat(64),
      CI_BUILD_TAR_DIGEST: "d".repeat(64),
      CI_BUILD_PRODUCER_ATTEMPT: "1",
    };
    for (const key of Object.keys(env))
      expect(() =>
        requireBuildProducer({ ...env, [key]: undefined, GITHUB_RUN_ATTEMPT: "2" }),
      ).toThrow("rerun the complete workflow");
    expect(() => requireBuildProducer({ ...env, CI_BUILD_ARTIFACT_ID: "linux-build" })).toThrow(
      "fallback is forbidden",
    );
  });

  test("rejects missing and duplicate members and manifest inventory/checksum tampering", async () => {
    const { bytes } = await fixture();
    const { offset, end } = member(bytes, "packages/code/dist/index.js");
    expect(() =>
      validateCiBuild(
        Buffer.concat([bytes.subarray(0, offset), bytes.subarray(end)]),
        identity,
        directories,
      ),
    ).toThrow("inventory mismatch");
    expect(() =>
      validateCiBuild(Buffer.concat([bytes.subarray(offset, end), bytes]), identity, directories),
    ).toThrow("Duplicate tar member");
    for (const mutate of [
      (manifest) => {
        manifest.entries.push(manifest.entries[0]);
      },
      (manifest) => {
        manifest.entries[0].sha256 = "0".repeat(64);
      },
      (manifest) => {
        manifest.directories = [];
      },
    ])
      expect(() => validateCiBuild(mutateManifest(bytes, mutate), identity, directories)).toThrow();
    const damaged = Buffer.from(bytes);
    damaged[offset + 512] ^= 1;
    expect(() => validateCiBuild(damaged, identity, directories)).toThrow(
      "checksum or inventory mismatch",
    );
  });

  test("rejects absolute/traversing/out-of-scope members, links, devices and malformed archives", async () => {
    const { bytes } = await fixture();
    for (const path of [
      "/tmp/escape",
      "../escape",
      "packages/code/dist/../../source.ts",
      "packages/code/src/source.ts",
      "C:/escape",
      "packages/code/dist/a\\b",
    ]) {
      const changed = mutateHeader(bytes, "packages/code/dist/index.js", (header) => {
        header.fill(0, 0, 100);
        header.write(path, 0);
      });
      expect(() => validateCiBuild(changed, identity, directories)).toThrow();
    }
    for (const type of ["1", "2", "3", "x", "L"]) {
      const changed = mutateHeader(bytes, "packages/code/dist/index.js", (header) => {
        header[156] = type.charCodeAt(0);
        header.write("../../escape", 157);
      });
      expect(() => validateCiBuild(changed, identity, directories)).toThrow("forbidden");
    }
    expect(() => validateCiBuild(bytes.subarray(0, 100), identity, directories)).toThrow();
    const badHeader = Buffer.from(bytes);
    badHeader[0] ^= 1;
    expect(() => validateCiBuild(badHeader, identity, directories)).toThrow("header checksum");
  });

  test("rejects producer links and symlinked restoration destinations", async () => {
    const { root, archive } = await fixture();
    await symlink("../package.json", join(root, "packages/code/dist/link"));
    await expect(packCiBuild(root, identity)).rejects.toThrow("links and special files");
    await rm(join(root, "packages/code/dist"), { recursive: true });
    await symlink(join(root, "packages/protocol/dist"), join(root, "packages/code/dist"));
    await expect(restoreCiBuild(root, archive.path, identity, archive.digest)).rejects.toThrow(
      "not a real directory",
    );
  });
});
