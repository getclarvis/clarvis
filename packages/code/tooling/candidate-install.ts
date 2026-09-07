import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  candidateVersion,
  CANDIDATE_REPOSITORY,
  parseRuntimeCandidate,
  type RuntimeCandidate,
} from "../src/adapters/runtime-candidate.ts";
import { installDevelopmentLauncher } from "./development-install.ts";

/** Fetch public release metadata without credentials, bounding redirects, size, and time. */
export async function candidateJson(url: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json", "user-agent": "clarvis-candidate-installer" },
  });
  const final = new URL(response.url || url);
  if (
    final.protocol !== "https:" ||
    ![
      "api.github.com",
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ].includes(final.hostname)
  )
    throw new Error("candidate download redirected outside GitHub");
  if (!response.ok) throw new Error(`candidate download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("candidate download has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("candidate metadata exceeds size limit");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Select only published prereleases carrying the required image identity sidecar. */
export function selectCandidateRelease(value: unknown, requested?: string): string {
  const releases = Array.isArray(value) ? value : [value];
  const tags: string[] = [];
  for (const release of releases) {
    if (typeof release !== "object" || release === null) continue;
    const item = release as Record<string, unknown>;
    if (item.draft !== false || item.prerelease !== true || typeof item.tag_name !== "string")
      continue;
    try {
      candidateVersion(item.tag_name);
    } catch {
      continue;
    }
    if (
      !Array.isArray(item.assets) ||
      !item.assets.some(
        (asset: unknown) =>
          typeof asset === "object" &&
          asset !== null &&
          "name" in asset &&
          asset.name === "runtime-candidate.json",
      )
    )
      continue;
    tags.push(item.tag_name);
  }
  tags.sort((left, right) => {
    const a = left
      .slice(1)
      .split(/\.|-rc\./u)
      .map(BigInt);
    const b = right
      .slice(1)
      .split(/\.|-rc\./u)
      .map(BigInt);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return (a[index] ?? 0n) > (b[index] ?? 0n) ? -1 : 1;
    }
    return 0;
  });
  const selected = requested === undefined ? tags[0] : tags.find((tag) => tag === requested);
  if (selected === undefined)
    throw new Error("no published candidate with a runtime manifest was found");
  return selected;
}

function execute(argv: readonly string[], cwd: string): string {
  const executable = argv[0];
  if (executable === undefined) throw new Error("empty candidate install command");
  const result = spawnSync(executable, argv.slice(1), {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${argv[0]} ${argv[1]} failed with exit ${result.status}`);
  return result.stdout.trim();
}

/** Install an exact published source snapshot and its Docker image before switching the launcher. */
export async function installCandidate(input: {
  tag?: string;
  installRoot: string;
  binDirectory: string;
  bun: string;
  bunVersion: string;
  fetcher?: typeof fetch;
  run?: (argv: readonly string[], cwd: string) => string;
}): Promise<{ launcher: string; manifest: RuntimeCandidate; checkout: string }> {
  if (input.tag !== undefined) candidateVersion(input.tag);
  const api = `https://api.github.com/repos/${CANDIDATE_REPOSITORY}/releases`;
  const metadata = await candidateJson(
    input.tag === undefined ? `${api}?per_page=100` : `${api}/tags/${input.tag}`,
    input.fetcher,
  );
  const tag = selectCandidateRelease(metadata, input.tag);
  const manifest = parseRuntimeCandidate(
    await candidateJson(
      `https://github.com/${CANDIDATE_REPOSITORY}/releases/download/${tag}/runtime-candidate.json`,
      input.fetcher,
    ),
    tag,
  );
  const root = resolve(input.installRoot);
  await mkdir(root, { recursive: true });
  const checkout = await mkdtemp(join(root, `${tag}-`));
  const run = input.run ?? execute;
  let activated = false;
  try {
    run(["git", "init", "--quiet", checkout], root);
    run(
      ["git", "remote", "add", "origin", `https://github.com/${CANDIDATE_REPOSITORY}.git`],
      checkout,
    );
    run(["git", "fetch", "--depth=1", "origin", `refs/tags/${tag}`], checkout);
    const commit = run(["git", "rev-parse", "FETCH_HEAD^{commit}"], checkout);
    if (commit !== manifest.source_revision)
      throw new Error("candidate tag differs from published source revision");
    run(["git", "checkout", "--detach", commit], checkout);
    const product = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as {
      version?: string;
    };
    if (product.version !== manifest.version)
      throw new Error("candidate product version differs from manifest");
    const mise = await readFile(join(checkout, "mise.toml"), "utf8");
    const pinnedBun = /^bun\s*=\s*"([^"]+)"\s*$/m.exec(mise)?.[1];
    if (pinnedBun !== input.bunVersion)
      throw new Error(`candidate requires Bun ${pinnedBun}; installed Bun is ${input.bunVersion}`);
    run([input.bun, "install", "--frozen-lockfile"], checkout);
    run(["docker", "pull", manifest.runtime_image], checkout);
    const id = run(
      ["docker", "image", "inspect", "--format", "{{.Id}}", manifest.runtime_image],
      checkout,
    );
    if (!/^sha256:[a-f0-9]{64}$/u.test(id))
      throw new Error("Docker returned an invalid candidate image identity");
    const version = run([input.bun, "packages/code/src/cli.ts", "--version"], checkout);
    if (version !== `clarvis ${manifest.version}`)
      throw new Error("candidate CLI version smoke failed");
    const launcher = await installDevelopmentLauncher({
      repository: checkout,
      bun: input.bun,
      binDirectory: input.binDirectory,
      candidate: { tag, revision: commit },
    });
    activated = true;
    return { launcher, manifest, checkout };
  } finally {
    if (!activated) await rm(checkout, { recursive: true, force: true });
  }
}
