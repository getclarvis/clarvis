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
    releaseWorkflow:
      "cp third-party/vercel-ai-sdk/LICENSE build/release/VERCEL-AI-SDK-LICENSE\nif: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')",
    workflows: [{ path: ".github/workflows/release.yml", source: secureWorkflow }],
    workspaceLicenses: [{ path: "packages/example/package.json", license: "MIT" }],
    tag: "v0.0.1-beta",
  };
}

test("accepts one product identity across the release surfaces", () => {
  expect(releaseReadinessFailures(valid())).toEqual([]);
});

test("rejects an incomplete Vercel AI SDK license release set", () => {
  const input = valid();
  input.thirdPartyNotices = "missing SDK notice";
  input.vercelAiSdkLicense = "missing license body";
  input.releaseWorkflow = "missing release asset";
  expect(releaseReadinessFailures(input)).toEqual([
    "third-party notices must identify the Vercel AI SDK",
    "Vercel AI SDK license must contain its Apache-2.0 grant",
    "release workflow must publish the Vercel AI SDK license",
    "release publish job must reject manual workflow dispatches",
  ]);
});

test("rejects a publish job that a manual dispatch on a tag could reach", () => {
  const input = valid();
  input.releaseWorkflow =
    "cp third-party/vercel-ai-sdk/LICENSE build/release/VERCEL-AI-SDK-LICENSE\nif: startsWith(github.ref, 'refs/tags/')";
  expect(releaseReadinessFailures(input)).toEqual([
    "release publish job must reject manual workflow dispatches",
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
  const input = valid();
  input.installSh = "version=old";
  input.installPowerShell = "$Version = old";
  input.tag = "v0.0.2-beta";
  expect(releaseReadinessFailures(input)).toEqual([
    "install.sh default version differs from the product version",
    "install.ps1 default version differs from the product version",
    "release tag v0.0.2-beta differs from v0.0.1-beta",
  ]);
});

test("rejects incomplete or stale public-release metadata", () => {
  const input = valid();
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
