#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const observed = (value) => (value === undefined ? "missing" : JSON.stringify(value));

const parseJson = (path, source, failures) => {
  try {
    return JSON.parse(source);
  } catch (error) {
    failures.push(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return {};
  }
};

const setupBunPins = (source) => {
  const lines = source.split("\n");
  const pins = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("uses: oven-sh/setup-bun@")) continue;
    for (let cursor = index + 1; cursor < Math.min(lines.length, index + 8); cursor += 1) {
      const match = /^\s*bun-version:\s*["']?([^\s"']+)["']?\s*$/.exec(lines[cursor]);
      if (match !== null) {
        pins.push({ line: cursor + 1, value: match[1] });
        break;
      }
      if (/^\s*-\s+(?:uses|run|name):/.test(lines[cursor])) break;
    }
  }
  return pins;
};

const canaryDefault = (source) => {
  const match = /^\s{6}bun-version:\s*$([\s\S]*?)^\s{6}[a-z][\w-]*:\s*$/m.exec(
    `${source}\n      end:`,
  );
  return match === null
    ? undefined
    : /^\s*default:\s*["']?([^\s"']+)["']?\s*$/m.exec(match[1])?.[1];
};

const runtimeEvidenceCount = (source) =>
  [...source.matchAll(/^\s*(?:-\s*)?run:\s*bun --version && bun --revision\s*$/gm)].length;

/** Check each host Bun job independently, so new jobs cannot borrow another job's runtime evidence. */
function ciRuntimeFailures(source: string, version: string): string[] {
  const failures: string[] = [];
  try {
    const workflow = Bun.YAML.parse(source) as {
      jobs?: Record<
        string,
        { steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[] }
      >;
    };
    if (!workflow?.jobs || typeof workflow.jobs !== "object")
      return [".github/workflows/ci.yml: missing jobs"];
    let setups = 0;
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const pins = steps.flatMap((step, index) =>
        step.uses?.startsWith("oven-sh/setup-bun@") ? [{ step, index }] : [],
      );
      setups += pins.length;
      const runsBun = (run?: string) =>
        /\bbun(?:x)?\b|tooling\/ci\/retry-code-coverage\.sh/.test(run ?? "");
      if (pins.length === 0 && !steps.some((step) => runsBun(step.run))) continue;
      const prefix = `.github/workflows/ci.yml: job ${name}`;
      if (pins.length !== 1)
        failures.push(`${prefix}: expected one setup-bun configuration, found ${pins.length}`);
      for (const { step } of pins)
        if (step.with?.["bun-version"] !== version)
          failures.push(`${prefix}: bun-version must equal ${version}`);
      const evidence = steps.flatMap((step, index) =>
        /^bun --version && bun --revision\s*$/.test(step.run ?? "") ? [index] : [],
      );
      if (evidence.length !== 1)
        failures.push(
          `${prefix}: expected one Bun version/revision evidence step, found ${evidence.length}`,
        );
      if (pins.length === 1 && evidence.length === 1) {
        const firstExecution = steps.findIndex(
          (step, index) => index !== evidence[0] && runsBun(step.run),
        );
        if (pins[0].index >= evidence[0] || (firstExecution >= 0 && evidence[0] >= firstExecution))
          failures.push(`${prefix}: setup and runtime evidence must precede Bun execution`);
      }
    }
    if (setups === 0)
      failures.push(".github/workflows/ci.yml: expected at least one setup-bun configuration");
  } catch (error) {
    failures.push(`.github/workflows/ci.yml: invalid job structure (${String(error)})`);
  }
  return failures;
}

/** Validate every executable and declaration surface against the exact version pinned by mise. */
export function bunVersionFailures(snapshot) {
  const failures = [];
  const miseMatches = [...snapshot.mise.matchAll(/^\s*bun\s*=\s*["']([^"']+)["']\s*$/gm)];
  if (miseMatches.length !== 1) {
    failures.push(
      `mise.toml: expected exactly one quoted bun pin, found ${String(miseMatches.length)}`,
    );
  }
  const version = miseMatches[0]?.[1];
  if (version === undefined || !EXACT_VERSION.test(version)) {
    failures.push(
      `mise.toml: bun must be an exact major.minor.patch version, observed ${observed(version)}`,
    );
  }
  if (version === undefined) return failures;

  failures.push(...ciRuntimeFailures(snapshot.ci, version));

  const releasePins = setupBunPins(snapshot.release);
  if (releasePins.length !== 4) {
    failures.push(
      `.github/workflows/release.yml: expected four setup-bun pins, found ${String(releasePins.length)}`,
    );
  }
  for (const pin of releasePins) {
    if (pin.value !== version) {
      failures.push(
        `.github/workflows/release.yml:${String(pin.line)}: bun-version observed ${observed(pin.value)}, expected ${version}`,
      );
    }
  }
  const releaseEvidence = runtimeEvidenceCount(snapshot.release);
  if (releaseEvidence !== 4) {
    failures.push(
      `.github/workflows/release.yml: expected four Bun version/revision evidence steps, found ${String(releaseEvidence)}`,
    );
  }

  const canary = canaryDefault(snapshot.canary);
  if (canary !== version) {
    failures.push(
      `.github/workflows/segfault-canary.yml: bun-version default observed ${observed(canary)}, expected ${version}`,
    );
  }
  const canaryEvidence = runtimeEvidenceCount(snapshot.canary);
  if (canaryEvidence !== 1) {
    failures.push(
      `.github/workflows/segfault-canary.yml: expected one Bun version/revision evidence step, found ${String(canaryEvidence)}`,
    );
  }

  const dockerPins = [
    ...snapshot.docker.matchAll(/^FROM\s+oven\/bun:([^\s]+)(?:\s+AS\s+\w+)?\s*$/gm),
  ].map((match) => match[1]);
  if (dockerPins.length !== 2) {
    failures.push(
      `packages/server/Dockerfile: expected two oven/bun stages, found ${String(dockerPins.length)}`,
    );
  }
  for (const pin of dockerPins) {
    if (pin !== `${version}-slim`) {
      failures.push(
        `packages/server/Dockerfile: base image observed ${observed(`oven/bun:${pin}`)}, expected oven/bun:${version}-slim`,
      );
    }
  }

  const runtimeBuildPins = [
    ...snapshot.runtimeDevelopmentContainerfile.matchAll(
      /^ARG\s+BUILD_IMAGE=docker\.io\/oven\/bun:([^\s@]+)@(sha256:[a-f0-9]{64})\s*$/gm,
    ),
  ];
  if (runtimeBuildPins.length !== 1) {
    failures.push(
      `Containerfile.runtime-development: expected one digest-pinned oven/bun build image, found ${String(runtimeBuildPins.length)}`,
    );
  } else if (runtimeBuildPins[0][1] !== `${version}-debian`) {
    failures.push(
      `Containerfile.runtime-development: build image observed ${observed(`oven/bun:${runtimeBuildPins[0][1]}`)}, expected oven/bun:${version}-debian`,
    );
  }

  const rootManifest = parseJson("package.json", snapshot.rootManifest, failures);
  if (rootManifest.engines?.bun !== `>=${version}`) {
    failures.push(
      `package.json: engines.bun observed ${observed(rootManifest.engines?.bun)}, expected >=${version}`,
    );
  }
  if (rootManifest.devDependencies?.["@types/bun"] !== version) {
    failures.push(
      `package.json: @types/bun observed ${observed(rootManifest.devDependencies?.["@types/bun"])}, expected ${version}`,
    );
  }

  for (const workspace of snapshot.workspaceManifests) {
    const manifest = parseJson(workspace.path, workspace.source, failures);
    if (manifest.engines?.bun !== `>=${version}`) {
      failures.push(
        `${workspace.path}: engines.bun observed ${observed(manifest.engines?.bun)}, expected >=${version}`,
      );
    }
  }

  const declaredType = /"@types\/bun"\s*:\s*"([^"]+)"/.exec(snapshot.lockfile)?.[1];
  if (declaredType !== version) {
    failures.push(
      `bun.lock: root @types/bun declaration observed ${observed(declaredType)}, expected ${version}`,
    );
  }
  const resolvedType = /"@types\/bun"\s*:\s*\[\s*"@types\/bun@([^"\s]+)"/.exec(
    snapshot.lockfile,
  )?.[1];
  if (resolvedType !== version) {
    failures.push(
      `bun.lock: resolved @types/bun observed ${observed(resolvedType)}, expected ${version}`,
    );
  }

  return failures;
}

/** Read the repository surfaces used by {@link bunVersionFailures}. */
export function readBunVersionSnapshot(root) {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const rootManifest = read("package.json");
  const workspaces = JSON.parse(rootManifest).workspaces ?? [];
  return {
    mise: read("mise.toml"),
    ci: read(".github/workflows/ci.yml"),
    release: read(".github/workflows/release.yml"),
    canary: read(".github/workflows/segfault-canary.yml"),
    docker: read("packages/server/Dockerfile"),
    runtimeDevelopmentContainerfile: read("Containerfile.runtime-development"),
    rootManifest,
    workspaceManifests: workspaces.map((workspace) => ({
      path: `${workspace}/package.json`,
      source: read(`${workspace}/package.json`),
    })),
    lockfile: read("bun.lock"),
  };
}

/** Run the repository check and set a failing exit status when any version surface drifts. */
export function checkBunVersion(root) {
  const snapshot = readBunVersionSnapshot(root);
  const failures = bunVersionFailures(snapshot);
  if (failures.length === 0) {
    const manifestCount = 1 + snapshot.workspaceManifests.length;
    console.log(
      `bun version: mise, CI, canary, Docker, ${String(manifestCount)} manifests, types, lockfile and runtime evidence agree`,
    );
    return;
  }
  console.error(`\nbun version drift (${String(failures.length)}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}

const invoked = process.argv[1] === fileURLToPath(import.meta.url);
if (invoked) checkBunVersion(resolve(import.meta.dir, "../.."));
