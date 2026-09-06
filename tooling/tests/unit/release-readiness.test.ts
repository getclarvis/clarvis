import { expect, test } from "bun:test";

import {
  releaseReadinessFailures,
  workflowSecurityFailures,
} from "../../checks/release-readiness.ts";

const PIN = "d23441a48e516b6c34aea4fa41551a30e30af803";

const secureWorkflow = `
permissions:
  contents: read
jobs:
  check:
    steps:
      - uses: actions/checkout@${PIN}
        with:
          persist-credentials: false
      - uses: ./local-action
`;

function valid() {
  return {
    product: {
      version: "0.0.1-beta",
      license: "MIT",
      repository: { url: "git+https://github.com/getclarvis/clarvis.git" },
      workspaces: [],
    },
    installSh: "version=${CLARVIS_VERSION:-0.0.1-beta}",
    installPowerShell:
      '$Version = if ($env:CLARVIS_VERSION) { $env:CLARVIS_VERSION } else { "0.0.1-beta" }',
    rootLicense: "MIT License",
    thirdPartyNotices: "## Vercel AI SDK",
    vercelAiSdkLicense: "Copyright 2023 Vercel, Inc.\nApache License, Version 2.0",
    releaseWorkflow: `env:
  RELEASE_REPOSITORY: getclarvis/clarvis-releases
  RUNTIME_ARTIFACT_REPOSITORY: ghcr.io/getclarvis/clarvis-runtime-artifact
  RUNTIME_IMAGE_REPOSITORY: ghcr.io/getclarvis/clarvis-runtime
cp third-party/vercel-ai-sdk/LICENSE build/release/VERCEL-AI-SDK-LICENSE
if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')
  runtime-image:
  runtime-manifest:
needs: [package, runtime-manifest]
RELEASE_TAG: \${{ github.ref_name }}
bun run tooling/runtime/release-manifest.ts
docker login ghcr.io
docker push "$artifact_tag"
uses: actions/attest@${PIN}
subject-name: \${{ env.RUNTIME_ARTIFACT_REPOSITORY }}
subject-name: \${{ env.RUNTIME_IMAGE_REPOSITORY }}
artifact-metadata: write
packages: write
packages: write
push-to-registry: true
push-to-registry: true
build/release/runtime-release.json
bun run tooling/checks/release-assets.ts build/release "$GITHUB_REF_NAME"
uses: actions/create-github-app-token@${PIN}
client-id: \${{ vars.CLARVIS_RELEASE_APP_CLIENT_ID }}
private-key: \${{ secrets.CLARVIS_RELEASE_APP_PRIVATE_KEY }}
owner: getclarvis
repositories: clarvis-releases
permission-contents: write
GH_TOKEN: \${{ steps.release-token.outputs.token }}
gh release create "$GITHUB_REF_NAME" --repo "$RELEASE_REPOSITORY"`,
    workflows: [{ path: ".github/workflows/release.yml", source: secureWorkflow }],
    workspaceLicenses: [{ path: "packages/example/package.json", license: "MIT" }],
    tag: "v0.0.1-beta",
  };
}

function withReleaseRepositories(input: ReturnType<typeof valid>): ReturnType<typeof valid> {
  input.installSh += "\nrepository=${CLARVIS_RELEASE_REPOSITORY:-getclarvis/clarvis-releases}";
  input.installPowerShell +=
    '\n$Repository = if ($env:CLARVIS_RELEASE_REPOSITORY) { $env:CLARVIS_RELEASE_REPOSITORY } else { "getclarvis/clarvis-releases" }';
  return input;
}

test("accepts one product identity across the release surfaces", () => {
  expect(releaseReadinessFailures(withReleaseRepositories(valid()))).toEqual([]);
});

test("rejects an incomplete Vercel AI SDK license release set", () => {
  const input = withReleaseRepositories(valid());
  input.thirdPartyNotices = "missing SDK notice";
  input.vercelAiSdkLicense = "missing license body";
  input.releaseWorkflow = "missing release asset";
  expect(releaseReadinessFailures(input)).toEqual([
    "third-party notices must identify the Vercel AI SDK",
    "Vercel AI SDK license must contain its Apache-2.0 grant",
    "release workflow must publish the Vercel AI SDK license",
    "release workflow must publish and attest the immutable runtime manifest only on tag pushes",
    "release publish job must reject manual workflow dispatches",
    "release workflow must target getclarvis/clarvis-releases",
    "release workflow is missing scoped GitHub App setting: uses: actions/create-github-app-token@",
    "release workflow is missing scoped GitHub App setting: client-id: ${{ vars.CLARVIS_RELEASE_APP_CLIENT_ID }}",
    "release workflow is missing scoped GitHub App setting: private-key: ${{ secrets.CLARVIS_RELEASE_APP_PRIVATE_KEY }}",
    "release workflow is missing scoped GitHub App setting: owner: getclarvis",
    "release workflow is missing scoped GitHub App setting: repositories: clarvis-releases",
    "release workflow is missing scoped GitHub App setting: permission-contents: write",
    "release publication must authenticate with the scoped GitHub App token",
    "release mutation commands must name the public distribution repository",
    "release assets must pass the final map-free allowlist gate before publication",
  ]);
});

test("rejects a publish job that a manual dispatch on a tag could reach", () => {
  const input = withReleaseRepositories(valid());
  input.releaseWorkflow =
    "cp third-party/vercel-ai-sdk/LICENSE build/release/VERCEL-AI-SDK-LICENSE\nif: startsWith(github.ref, 'refs/tags/')";
  expect(releaseReadinessFailures(input)).toEqual([
    "release workflow must publish and attest the immutable runtime manifest only on tag pushes",
    "release publish job must reject manual workflow dispatches",
    "release workflow must target getclarvis/clarvis-releases",
    "release workflow is missing scoped GitHub App setting: uses: actions/create-github-app-token@",
    "release workflow is missing scoped GitHub App setting: client-id: ${{ vars.CLARVIS_RELEASE_APP_CLIENT_ID }}",
    "release workflow is missing scoped GitHub App setting: private-key: ${{ secrets.CLARVIS_RELEASE_APP_PRIVATE_KEY }}",
    "release workflow is missing scoped GitHub App setting: owner: getclarvis",
    "release workflow is missing scoped GitHub App setting: repositories: clarvis-releases",
    "release workflow is missing scoped GitHub App setting: permission-contents: write",
    "release publication must authenticate with the scoped GitHub App token",
    "release mutation commands must name the public distribution repository",
    "release assets must pass the final map-free allowlist gate before publication",
  ]);
});

test("rejects publication that bypasses the scoped cross-repository app token", () => {
  const input = withReleaseRepositories(valid());
  input.releaseWorkflow = input.releaseWorkflow.replace(
    "GH_TOKEN: ${{ steps.release-token.outputs.token }}",
    "GH_TOKEN: ${{ github.token }}",
  );
  expect(releaseReadinessFailures(input)).toEqual([
    "release publication must authenticate with the scoped GitHub App token",
  ]);
});

test("rejects a runtime release path without provenance or the manifest publication barrier", () => {
  const input = withReleaseRepositories(valid());
  input.releaseWorkflow = input.releaseWorkflow
    .replace("uses: actions/attest@", "uses: actions/example@")
    .replace("needs: [package, runtime-manifest]", "needs: package");
  expect(releaseReadinessFailures(input)).toContain(
    "release workflow must publish and attest the immutable runtime manifest only on tag pushes",
  );
});

test("rejects a runtime identity gate that occurs after the first registry mutation", () => {
  const input = withReleaseRepositories(valid());
  const gate = "RELEASE_TAG: ${{ github.ref_name }}\n";
  input.releaseWorkflow = input.releaseWorkflow.replace(gate, "") + gate;
  expect(releaseReadinessFailures(input)).toContain(
    "release workflow must publish and attest the immutable runtime manifest only on tag pushes",
  );
});

test("rejects minting the publication token before the final map-free gate", () => {
  const input = withReleaseRepositories(valid());
  const gate = 'bun run tooling/checks/release-assets.ts build/release "$GITHUB_REF_NAME"\n';
  input.releaseWorkflow = input.releaseWorkflow.replace(gate, "") + `\n${gate}`;
  expect(releaseReadinessFailures(input)).toEqual([
    "release assets must pass the final map-free allowlist gate before publication",
  ]);
});

test("rejects mutable actions, retained checkout credentials, and an implicit permission default", () => {
  expect(
    workflowSecurityFailures([
      {
        path: ".github/workflows/canary.yml",
        source: "jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v6\n",
      },
    ]),
  ).toEqual([
    ".github/workflows/canary.yml must declare top-level contents: read permissions",
    ".github/workflows/canary.yml must pin actions/checkout@v6 to a complete commit SHA",
    ".github/workflows/canary.yml checkout must set persist-credentials: false",
  ]);
});

test("accepts SHA-pinned actions, explicit read permissions, and a credentialless checkout", () => {
  expect(
    workflowSecurityFailures([{ path: ".github/workflows/check.yml", source: secureWorkflow }]),
  ).toEqual([]);
});

test("rejects a drifting tag and either installer", () => {
  const input = withReleaseRepositories(valid());
  input.installSh = input.installSh.replace(
    "version=${CLARVIS_VERSION:-0.0.1-beta}",
    "version=old",
  );
  input.installPowerShell = input.installPowerShell.replace(
    '$Version = if ($env:CLARVIS_VERSION) { $env:CLARVIS_VERSION } else { "0.0.1-beta" }',
    "$Version = old",
  );
  input.tag = "v0.0.2-beta";
  expect(releaseReadinessFailures(input)).toEqual([
    "install.sh default version differs from the product version",
    "install.ps1 default version differs from the product version",
    "release tag v0.0.2-beta differs from v0.0.1-beta",
  ]);
});

test("rejects incomplete or stale public-release metadata", () => {
  const input = withReleaseRepositories(valid());
  input.product.license = "UNLICENSED";
  input.product.repository.url = "git+https://github.com/example/old.git";
  input.rootLicense = "missing license body";
  input.workspaceLicenses[0].license = undefined;
  expect(releaseReadinessFailures(input)).toEqual([
    "root product license must be MIT",
    "root LICENSE must contain the MIT license",
    "packages/example/package.json license must be MIT",
    "root repository URL must identify getclarvis/clarvis",
  ]);
});
