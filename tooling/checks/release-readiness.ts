#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ProductManifest {
  version?: unknown;
  license?: unknown;
  repository?: { url?: unknown };
  workspaces?: unknown;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ACTION_SHA = /^[0-9a-f]{40}$/;
const SOURCE_REPOSITORY = "getclarvis/clarvis";
const RELEASE_REPOSITORY = "getclarvis/clarvis-releases";

interface WorkflowSource {
  path: string;
  source: string;
}

/** Return least-privilege and immutable-action failures for repository workflows. */
export function workflowSecurityFailures(workflows: readonly WorkflowSource[]): string[] {
  const failures: string[] = [];
  for (const workflow of workflows) {
    const lines = workflow.source.split("\n");
    const permissionsStart = lines.findIndex((line) => /^permissions:\s*$/.test(line));
    let contentsRead = false;
    if (permissionsStart >= 0) {
      for (let index = permissionsStart + 1; index < lines.length; index += 1) {
        if (/^\S/.test(lines[index])) break;
        if (/^\s{2}contents:\s*read\s*$/.test(lines[index])) contentsRead = true;
      }
    }
    if (!contentsRead) {
      failures.push(`${workflow.path} must declare top-level contents: read permissions`);
    }

    for (let index = 0; index < lines.length; index += 1) {
      const match = /^(\s*)(?:-\s+)?uses:\s*([^\s#]+)/.exec(lines[index]);
      if (match === null) continue;
      const action = match[2];
      if (!action.startsWith("./")) {
        const separator = action.lastIndexOf("@");
        const revision = separator >= 0 ? action.slice(separator + 1) : "";
        if (!ACTION_SHA.test(revision)) {
          failures.push(`${workflow.path} must pin ${action} to a complete commit SHA`);
        }
      }
      if (!action.startsWith("actions/checkout@")) continue;

      const actionIndent = match[1].length;
      let credentialsDisabled = false;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const nextStep = /^(\s*)-\s+(?:name|uses|run):/.exec(lines[cursor]);
        if (nextStep !== null && nextStep[1].length <= actionIndent) break;
        if (/^\s*persist-credentials:\s*false\s*$/.test(lines[cursor])) {
          credentialsDisabled = true;
          break;
        }
      }
      if (!credentialsDisabled) {
        failures.push(`${workflow.path} checkout must set persist-credentials: false`);
      }
    }
  }
  return failures;
}

/** Return release identity failures without performing any publication action. */
export function releaseReadinessFailures(input: {
  product: ProductManifest;
  installSh: string;
  installPowerShell: string;
  rootLicense: string;
  thirdPartyNotices: string;
  vercelAiSdkLicense: string;
  releaseWorkflow: string;
  workflows: readonly WorkflowSource[];
  workspaceLicenses: readonly { path: string; license?: unknown }[];
  tag?: string;
}): string[] {
  const failures: string[] = [];
  const version = input.product.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    failures.push("root product version must be an exact SemVer release version");
    return failures;
  }
  if (input.product.license !== "MIT") failures.push("root product license must be MIT");
  if (!input.rootLicense.includes("MIT License"))
    failures.push("root LICENSE must contain the MIT license");
  if (!input.thirdPartyNotices.includes("## Vercel AI SDK")) {
    failures.push("third-party notices must identify the Vercel AI SDK");
  }
  if (
    !input.vercelAiSdkLicense.includes("Copyright 2023 Vercel, Inc.") ||
    !input.vercelAiSdkLicense.includes("Apache License, Version 2.0")
  ) {
    failures.push("Vercel AI SDK license must contain its Apache-2.0 grant");
  }
  if (
    !input.releaseWorkflow.includes(
      "cp third-party/vercel-ai-sdk/LICENSE build/release/VERCEL-AI-SDK-LICENSE",
    )
  ) {
    failures.push("release workflow must publish the Vercel AI SDK license");
  }
  if (
    !input.releaseWorkflow.includes(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')",
    )
  ) {
    failures.push("release publish job must reject manual workflow dispatches");
  }
  if (!input.releaseWorkflow.includes(`RELEASE_REPOSITORY: ${RELEASE_REPOSITORY}`)) {
    failures.push(`release workflow must target ${RELEASE_REPOSITORY}`);
  }
  for (const required of [
    "uses: actions/create-github-app-token@",
    "client-id: ${{ vars.CLARVIS_RELEASE_APP_CLIENT_ID }}",
    "private-key: ${{ secrets.CLARVIS_RELEASE_APP_PRIVATE_KEY }}",
    "owner: getclarvis",
    "repositories: clarvis-releases",
    "permission-contents: write",
  ]) {
    if (!input.releaseWorkflow.includes(required)) {
      failures.push(`release workflow is missing scoped GitHub App setting: ${required}`);
    }
  }
  if (!input.releaseWorkflow.includes("GH_TOKEN: ${{ steps.release-token.outputs.token }}")) {
    failures.push("release publication must authenticate with the scoped GitHub App token");
  }
  if (!input.releaseWorkflow.includes('--repo "$RELEASE_REPOSITORY"')) {
    failures.push("release mutation commands must name the public distribution repository");
  }
  const mapGate = input.releaseWorkflow.indexOf(
    'bun run tooling/checks/release-assets.ts build/release "$GITHUB_REF_NAME"',
  );
  const releaseToken = input.releaseWorkflow.indexOf("uses: actions/create-github-app-token@");
  const createRelease = input.releaseWorkflow.indexOf('gh release create "$GITHUB_REF_NAME"');
  if (
    mapGate < 0 ||
    releaseToken < 0 ||
    createRelease < 0 ||
    mapGate > releaseToken ||
    releaseToken > createRelease
  ) {
    failures.push("release assets must pass the final map-free allowlist gate before publication");
  }
  failures.push(...workflowSecurityFailures(input.workflows));
  for (const workspace of input.workspaceLicenses) {
    if (workspace.license !== "MIT") failures.push(`${workspace.path} license must be MIT`);
  }
  if (input.product.repository?.url !== `git+https://github.com/${SOURCE_REPOSITORY}.git`) {
    failures.push(`root repository URL must identify ${SOURCE_REPOSITORY}`);
  }
  if (!input.installSh.includes(`CLARVIS_VERSION:-${version}`)) {
    failures.push("install.sh default version differs from the product version");
  }
  if (!input.installPowerShell.includes(`else { "${version}" }`)) {
    failures.push("install.ps1 default version differs from the product version");
  }
  if (!input.installSh.includes(`CLARVIS_RELEASE_REPOSITORY:-${RELEASE_REPOSITORY}`)) {
    failures.push(`install.sh must download from ${RELEASE_REPOSITORY}`);
  }
  if (!input.installPowerShell.includes(`else { "${RELEASE_REPOSITORY}" }`)) {
    failures.push(`install.ps1 must download from ${RELEASE_REPOSITORY}`);
  }
  if (input.tag !== undefined && input.tag.length > 0 && input.tag !== `v${version}`) {
    failures.push(`release tag ${input.tag} differs from v${version}`);
  }
  return failures;
}

/** Check the live repository's release identity and fail before any artifact is built. */
export function checkReleaseReadiness(root: string): void {
  const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
  const product = JSON.parse(read("package.json")) as ProductManifest;
  const workspaces = Array.isArray(product.workspaces)
    ? product.workspaces.filter((value): value is string => typeof value === "string")
    : [];
  const failures = releaseReadinessFailures({
    product,
    installSh: read("install.sh"),
    installPowerShell: read("install.ps1"),
    rootLicense: read("LICENSE"),
    thirdPartyNotices: read("THIRD_PARTY_NOTICES.md"),
    vercelAiSdkLicense: read("third-party/vercel-ai-sdk/LICENSE"),
    releaseWorkflow: read(".github/workflows/release.yml"),
    workflows: readdirSync(resolve(root, ".github/workflows"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => ({
        path: `.github/workflows/${entry.name}`,
        source: read(`.github/workflows/${entry.name}`),
      })),
    workspaceLicenses: workspaces.map((workspace) => ({
      path: `${workspace}/package.json`,
      license: (JSON.parse(read(`${workspace}/package.json`)) as { license?: unknown }).license,
    })),
    tag: process.env.RELEASE_TAG,
  });
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`release readiness: ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  const tag = process.env.RELEASE_TAG;
  process.stdout.write(
    tag
      ? "release readiness: product, installers, source/distribution repositories and supplied tag agree\n"
      : "release readiness: product, installers and source/distribution repositories agree; no release tag supplied\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkReleaseReadiness(resolve(import.meta.dir, "../.."));
}
