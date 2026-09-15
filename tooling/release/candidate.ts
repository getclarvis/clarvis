import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parseRuntimeReleaseManifest } from "../runtime/release-manifest.ts";

/** Validate the source-only candidate identity independently of workflow tag glob matching. */
export function candidateIdentity(tag: string, version: string, sha: string, repository: string) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.([1-9]\d*)$/.exec(tag);
  if (
    !match ||
    match[1] !== version ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    repository !== "getclarvis/clarvis"
  ) {
    throw new Error("candidate must match the prepared product version and source repository");
  }
  return {
    schema: 1,
    channel: "candidate",
    installation: "source-v1",
    tag,
    version,
    source_revision: sha,
    repository,
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
    targets: ["linux-x64", "linux-arm64"],
  };
}

/** Emit source-candidate evidence and publish only a prerelease in the source repository. */
export function main(): void {
  const product = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const identity = candidateIdentity(
    process.env.GITHUB_REF_NAME,
    product.version,
    process.env.GITHUB_SHA,
    process.env.GITHUB_REPOSITORY,
  );
  const mode = process.argv[2];
  if (mode === "validate") return;
  if (mode === "manifest") {
    const release = parseRuntimeReleaseManifest(
      readFileSync("build/candidate/runtime-release.json", "utf8"),
      identity.version,
    );
    writeFileSync(
      "build/candidate/runtime-candidate.json",
      `${JSON.stringify(
        {
          ...identity,
          runtime: release,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (mode !== "publish") throw new Error("usage: candidate.ts <validate|manifest|publish>");
  const notes = "build/candidate/notes.md";
  writeFileSync(
    notes,
    `Candidate runtime built from source commit \`${identity.source_revision}\`.\n\nQualified base and Kernel artifacts are recorded in runtime-candidate.json. This is not a stable Clarvis release and contains no stable installers.\n`,
  );
  const result = Bun.spawnSync(
    [
      "gh",
      "release",
      "create",
      identity.tag,
      "build/candidate/runtime-candidate.json",
      "build/candidate/runtime-release.json",
      ...readdirSync("build/candidate")
        .filter((name) => /^clarvis-kernel-linux-(?:x64|arm64)\.tar\.gz(?:\.sha256)?$/u.test(name))
        .sort()
        .map((name) => `build/candidate/${name}`),
      ...readdirSync("build/candidate")
        .filter((name) => /^qualification-(?:docker|podman)-linux-(?:x64|arm64)\.json$/u.test(name))
        .sort()
        .map((name) => `build/candidate/${name}`),
      "--repo",
      "getclarvis/clarvis",
      "--verify-tag",
      "--prerelease",
      "--latest=false",
      "--title",
      `Clarvis ${identity.tag} candidate`,
      "--notes-file",
      notes,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0)
    throw new Error("candidate publication failed; inspect existing release before retrying");
}

if (import.meta.main) main();
