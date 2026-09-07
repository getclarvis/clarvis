import { readFileSync, writeFileSync } from "node:fs";
import {
  RUNTIME_CANDIDATE_ARTIFACT_REPOSITORY,
  RUNTIME_CANDIDATE_IMAGE_REPOSITORY,
  RUNTIME_PROTOCOL_REVISION,
} from "../runtime/build-image.ts";

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
    protocol_revision: RUNTIME_PROTOCOL_REVISION,
    platforms: ["linux/amd64", "linux/arm64"],
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
    const artifact = process.env.ARTIFACT_DIGEST;
    const runtime = process.env.RUNTIME_DIGEST;
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact) || !/^sha256:[a-f0-9]{64}$/.test(runtime))
      throw new Error("invalid candidate image digest");
    writeFileSync(
      "build/candidate/runtime-candidate.json",
      `${JSON.stringify(
        {
          ...identity,
          artifact_image: `${RUNTIME_CANDIDATE_ARTIFACT_REPOSITORY}@${artifact}`,
          runtime_image: `${RUNTIME_CANDIDATE_IMAGE_REPOSITORY}@${runtime}`,
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
    `Candidate runtime built from source commit \`${identity.source_revision}\`.\n\nDocker and rootless Podman canaries passed on linux/amd64 and linux/arm64. See runtime-candidate.json for immutable image digests. Install this source candidate with \`./dev-install.sh --candidate ${identity.tag}\` using the pinned Bun version and Docker. The installer checks out this exact commit and pulls its digest-pinned image. This is not a stable Clarvis release and contains no stable installers.\n`,
  );
  const result = Bun.spawnSync(
    [
      "gh",
      "release",
      "create",
      identity.tag,
      "build/candidate/runtime-candidate.json",
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
