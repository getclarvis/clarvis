import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUpdateChecker,
  UPDATE_CHECK_TTL_MS,
  type UpdateCheckOptions,
} from "../../src/update/check.ts";
import {
  RELEASE_REPOSITORY,
  releaseAssetName,
  releaseTarget,
  type ReleaseTarget,
} from "../../src/update-contract.ts";
import type { ReleaseFetch } from "../../src/update/github-releases.ts";

interface ManagedFixture {
  root: string;
  cacheFile: string;
  target: ReleaseTarget;
  options: UpdateCheckOptions;
  cleanup(): Promise<void>;
}

async function managedFixture(currentVersion = "0.1.0"): Promise<ManagedFixture | undefined> {
  const target = releaseTarget();
  if (target === undefined) return undefined;
  const root = await mkdtemp(join(tmpdir(), "clarvis-update-check-"));
  const versionRoot = join(root, "versions", `v${currentVersion}`);
  await mkdir(versionRoot, { recursive: true });
  await writeFile(join(root, "current"), `v${currentVersion}\n`);
  await writeFile(
    join(versionRoot, "release.json"),
    JSON.stringify({
      schema: 1,
      repository: RELEASE_REPOSITORY,
      version: currentVersion,
      target,
      files: [{ path: "placeholder", size: 0, sha256: "a".repeat(64) }],
    }),
  );
  return {
    root,
    cacheFile: join(root, "cache", "update-check.json"),
    target,
    options: {
      currentVersion,
      environment: { CLARVIS_INSTALL_ROOT: root },
      cacheFile: join(root, "cache", "update-check.json"),
      now: () => 2 * UPDATE_CHECK_TTL_MS,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function releaseResponse(
  version: string,
  target: ReleaseTarget,
  etag = '"release-index"',
): Response {
  const name = releaseAssetName(version, target);
  return Response.json(
    [
      {
        tag_name: `v${version}`,
        draft: false,
        prerelease: version.includes("-"),
        published_at: "2026-09-04T00:00:00Z",
        assets: [
          {
            name,
            size: 1024,
            digest: `sha256:${"a".repeat(64)}`,
            state: "uploaded",
            browser_download_url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${name}`,
          },
        ],
      },
    ],
    { headers: { etag } },
  );
}

async function writeCache(
  fixture: ManagedFixture,
  over: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(fixture.root, "cache"), { recursive: true });
  await writeFile(
    fixture.cacheFile,
    JSON.stringify({
      schema: 1,
      repository: RELEASE_REPOSITORY,
      checked_at: 2 * UPDATE_CHECK_TTL_MS - 1,
      current_version: "0.1.0",
      target: fixture.target,
      available: { version: "0.1.1", tag_name: "v0.1.1" },
      ...over,
    }),
  );
}

test("source and unmanaged checks skip before network", async () => {
  let calls = 0;
  const fetcher: ReleaseFetch = () => {
    calls += 1;
    return Promise.resolve(Response.json([]));
  };
  expect(
    await createUpdateChecker()({
      currentVersion: "0.1.0",
      environment: { CLARVIS_CODE_SOURCE: "1" },
      fetch: fetcher,
    }),
  ).toEqual({ kind: "skipped", reason: "source" });
  expect(
    await createUpdateChecker()({ currentVersion: "0.1.0", environment: {}, fetch: fetcher }),
  ).toEqual({ kind: "skipped", reason: "unmanaged" });
  expect(calls).toBe(0);
});

test("a fresh compatible cache returns the eligible version without network", async () => {
  const fixture = await managedFixture();
  if (fixture === undefined) return;
  await writeCache(fixture);
  let calls = 0;
  try {
    expect(
      await createUpdateChecker()({
        ...fixture.options,
        fetch: () => {
          calls += 1;
          return Promise.resolve(Response.json([]));
        },
      }),
    ).toEqual({ kind: "available", version: "0.1.1", tagName: "v0.1.1", source: "cache" });
    expect(calls).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("an expired cache revalidates with ETag and accepts 304 only with that cache", async () => {
  const fixture = await managedFixture();
  if (fixture === undefined) return;
  await writeCache(fixture, { checked_at: 0, etag: 'W/"old"' });
  const conditionals: (string | null)[] = [];
  try {
    const result = await createUpdateChecker()({
      ...fixture.options,
      fetch: (_input, init) => {
        conditionals.push(new Headers(init?.headers).get("if-none-match"));
        return Promise.resolve(new Response(null, { status: 304 }));
      },
    });
    expect(result).toEqual({
      kind: "available",
      version: "0.1.1",
      tagName: "v0.1.1",
      source: "network",
    });
    expect(conditionals).toEqual(['W/"old"']);
    const stored = JSON.parse(await readFile(fixture.cacheFile, "utf8")) as {
      checked_at: number;
    };
    expect(stored.checked_at).toBe(2 * UPDATE_CHECK_TTL_MS);
  } finally {
    await fixture.cleanup();
  }
});

test("network metadata is selected, cached, and never mutates managed installation state", async () => {
  const fixture = await managedFixture();
  if (fixture === undefined) return;
  let calls = 0;
  const checker = createUpdateChecker();
  try {
    const first = await checker({
      ...fixture.options,
      fetch: () => {
        calls += 1;
        return Promise.resolve(releaseResponse("0.1.1", fixture.target));
      },
    });
    expect(first).toEqual({
      kind: "available",
      version: "0.1.1",
      tagName: "v0.1.1",
      source: "network",
    });
    expect(await checker(fixture.options)).toBe(first);
    expect(calls).toBe(1);
    expect(await readFile(join(fixture.root, "current"), "utf8")).toBe("v0.1.0\n");
    await expect(stat(join(fixture.root, "update.lock"))).rejects.toThrow();
    expect((await stat(join(fixture.root, "versions"))).isDirectory()).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid cache is a miss and an invalid 304 degrades to a silent failure result", async () => {
  const fixture = await managedFixture();
  if (fixture === undefined) return;
  await mkdir(join(fixture.root, "cache"), { recursive: true });
  await writeFile(fixture.cacheFile, "not json");
  try {
    expect(
      await createUpdateChecker()({
        ...fixture.options,
        fetch: () => Promise.resolve(new Response(null, { status: 304 })),
      }),
    ).toEqual({ kind: "failed", reason: "not_modified_without_cache" });
  } finally {
    await fixture.cleanup();
  }
});

test("stable checks ignore prereleases and network failures are returned without throwing", async () => {
  const fixture = await managedFixture();
  if (fixture === undefined) return;
  try {
    expect(
      await createUpdateChecker()({
        ...fixture.options,
        fetch: () => Promise.resolve(releaseResponse("0.2.0-beta", fixture.target)),
      }),
    ).toEqual({ kind: "current", source: "network" });
    const failed = await createUpdateChecker()({
      ...fixture.options,
      now: () => 4 * UPDATE_CHECK_TTL_MS,
      fetch: () => Promise.reject(new Error("offline")),
    });
    expect(failed).toEqual({ kind: "failed", reason: "offline" });
  } finally {
    await fixture.cleanup();
  }
});

test("an external abort reaches the physical release request", async () => {
  const fixture = await managedFixture();
  if (fixture === undefined) return;
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  try {
    const pending = createUpdateChecker()({
      ...fixture.options,
      signal: controller.signal,
      fetch: (_input, init) => {
        observed = init?.signal ?? undefined;
        markStarted();
        return new Promise<Response>((_resolve, reject) => {
          observed?.addEventListener(
            "abort",
            () => {
              const reason = observed?.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason)));
            },
            { once: true },
          );
        });
      },
    });
    await started;
    controller.abort(new Error("shutdown"));
    const result = await pending;
    expect(observed?.aborted).toBe(true);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.reason : "").toContain("shutdown");
  } finally {
    await fixture.cleanup();
  }
});
