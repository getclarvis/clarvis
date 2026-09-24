import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
    mkdirSync("build/candidate", { recursive: true });
    writeFileSync(
      "build/candidate/source-candidate.json",
      `${JSON.stringify(identity, null, 2)}\n`,
    );
    return;
  }
  if (mode !== "publish") throw new Error("usage: candidate.ts <validate|manifest|publish>");
  const notes = `${process.env.RUNNER_TEMP ?? "/tmp"}/clarvis-candidate-notes.md`;
  writeFileSync(
    notes,
    `Source candidate from commit \`${identity.source_revision}\`. This prerelease contains no stable installers.\n`,
  );
  const result = Bun.spawnSync(
    [
      "gh",
      "release",
      "create",
      identity.tag,
      "build/candidate/source-candidate.json",
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
