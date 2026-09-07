import { expect, test } from "bun:test";
import { candidateIdentity } from "../../release/candidate.ts";
import {
  RUNTIME_CANDIDATE_ARTIFACT_REPOSITORY,
  RUNTIME_CANDIDATE_IMAGE_REPOSITORY,
  runtimeImageBuildPlan,
} from "../../runtime/build-image.ts";

test("candidates cannot publish a stable identity or consume official carrier namespaces", () => {
  const sha = "a".repeat(40);
  expect(candidateIdentity("v0.2.0-rc.1", "0.2.0", sha, "getclarvis/clarvis").channel).toBe(
    "candidate",
  );
  for (const tag of ["v0.2.0", "v0.2.0-beta", "v0.2.0-rc.0", "v0.2.0-rc.01", "v0.3.0-rc.1"]) {
    expect(() => candidateIdentity(tag, "0.2.0", sha, "getclarvis/clarvis")).toThrow();
  }
  expect(() =>
    candidateIdentity("v0.2.0-rc.1", "0.2.0", sha, "getclarvis/clarvis-releases"),
  ).toThrow();
  const artifact = `${RUNTIME_CANDIDATE_ARTIFACT_REPOSITORY}@sha256:${"b".repeat(64)}`;
  const image = `${RUNTIME_CANDIDATE_IMAGE_REPOSITORY}:v0.2.0-rc.1`;
  const metadata = { version: "0.2.0", sourceRevision: sha };
  expect(runtimeImageBuildPlan(["--candidate", artifact, image], metadata).commands[0]).toContain(
    "DEVELOPMENT=false",
  );
  expect(() => runtimeImageBuildPlan([artifact, image], metadata)).toThrow();
  expect(() =>
    runtimeImageBuildPlan(
      ["--candidate", artifact, "ghcr.io/getclarvis/clarvis-runtime:v0.2.0"],
      metadata,
    ),
  ).toThrow();
  expect(() => runtimeImageBuildPlan(["--candidate", "--development", image], metadata)).toThrow();
});
