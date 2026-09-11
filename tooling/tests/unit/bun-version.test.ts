import { describe, expect, test } from "bun:test";
import { bunVersionFailures } from "../../checks/bun-version.ts";

const VERSION = "1.4.0";

const validSnapshot = () => ({
  mise: `[tools]\nbun = "${VERSION}"\n`,
  ci: `
jobs:
  linux:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
  windows:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
  macos:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
`,
  canary: `
on:
  workflow_dispatch:
    inputs:
      bun-version:
        description: Bun version
        default: "${VERSION}"
        required: true
      coverage:
        type: boolean
jobs:
  canary:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: \${{ inputs.bun-version }}
      - run: bun --version && bun --revision
`,
  release: `
jobs:
  package:
    steps:
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
  publish:
    steps:
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
  runtime-image:
    steps:
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
  runtime-manifest:
    steps:
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: ${VERSION}
      - run: bun --version && bun --revision
`,
  docker: `FROM oven/bun:${VERSION}-slim AS deps\nFROM oven/bun:${VERSION}-slim AS runtime\n`,
  runtimeDevelopmentContainerfile: `ARG BUILD_IMAGE=docker.io/oven/bun:${VERSION}-debian@sha256:${"a".repeat(64)}\n`,
  rootManifest: JSON.stringify({
    engines: { bun: `>=${VERSION}` },
    workspaces: ["packages/example"],
    devDependencies: { "@types/bun": VERSION },
  }),
  workspaceManifests: [
    {
      path: "packages/example/package.json",
      source: JSON.stringify({ name: "@clarvis/example", engines: { bun: `>=${VERSION}` } }),
    },
  ],
  lockfile: `
"": { "devDependencies": { "@types/bun": "${VERSION}" } },
"@types/bun": ["@types/bun@${VERSION}", "", {}],
`,
});

describe("bunVersionFailures", () => {
  test("accepts one exact version across every surface", () => {
    expect(bunVersionFailures(validSnapshot())).toEqual([]);
  });

  test("rejects a non-exact canonical mise version", () => {
    const snapshot = validSnapshot();
    snapshot.mise = '[tools]\nbun = "1.4"\n';
    expect(bunVersionFailures(snapshot).join("\n")).toContain("exact major.minor.patch");
  });

  test("names a drifting CI pin", () => {
    const snapshot = validSnapshot();
    snapshot.ci = snapshot.ci.replace(VERSION, "1.3.11");
    expect(bunVersionFailures(snapshot).join("\n")).toContain(".github/workflows/ci.yml");
  });

  test("requires attributable runtime evidence in CI, release and the canary", () => {
    const snapshot = validSnapshot();
    snapshot.ci = snapshot.ci.replace("      - run: bun --version && bun --revision\n", "");
    snapshot.release = snapshot.release.replace(
      "      - run: bun --version && bun --revision\n",
      "",
    );
    snapshot.canary = snapshot.canary.replace("      - run: bun --version && bun --revision\n", "");
    const failures = bunVersionFailures(snapshot).join("\n");
    expect(failures).toContain("expected three Bun version/revision evidence steps, found 2");
    expect(failures).toContain("expected four Bun version/revision evidence steps, found 3");
    expect(failures).toContain("expected one Bun version/revision evidence step, found 0");
  });

  test("names a drifting canary default", () => {
    const snapshot = validSnapshot();
    snapshot.canary = snapshot.canary.replace(VERSION, "1.3.11");
    expect(bunVersionFailures(snapshot).join("\n")).toContain("segfault-canary.yml");
  });

  test("names a drifting Docker stage", () => {
    const snapshot = validSnapshot();
    snapshot.docker = snapshot.docker.replace(VERSION, "1.3.14");
    expect(bunVersionFailures(snapshot).join("\n")).toContain("packages/server/Dockerfile");
  });

  test("requires the source-built runtime carrier to pin the same Bun version by digest", () => {
    const snapshot = validSnapshot();
    snapshot.runtimeDevelopmentContainerfile = snapshot.runtimeDevelopmentContainerfile.replace(
      VERSION,
      "1.3.14",
    );
    expect(bunVersionFailures(snapshot).join("\n")).toContain("Containerfile.runtime-development");

    snapshot.runtimeDevelopmentContainerfile = `ARG BUILD_IMAGE=docker.io/oven/bun:${VERSION}-debian\n`;
    expect(bunVersionFailures(snapshot).join("\n")).toContain("expected one digest-pinned");
  });

  test("names root and workspace engine drift", () => {
    const snapshot = validSnapshot();
    snapshot.rootManifest = snapshot.rootManifest.replace(">=1.4.0", ">=1.3.11");
    snapshot.workspaceManifests[0].source = snapshot.workspaceManifests[0].source.replace(
      ">=1.4.0",
      ">=1.3.11",
    );
    const failures = bunVersionFailures(snapshot).join("\n");
    expect(failures).toContain("package.json: engines.bun");
    expect(failures).toContain("packages/example/package.json: engines.bun");
  });

  test("names a drifting type declaration", () => {
    const snapshot = validSnapshot();
    snapshot.rootManifest = snapshot.rootManifest.replace(
      '"@types/bun":"1.4.0"',
      '"@types/bun":"1.3.14"',
    );
    expect(bunVersionFailures(snapshot).join("\n")).toContain("package.json: @types/bun");
  });

  test("names declared and resolved lockfile drift", () => {
    const snapshot = validSnapshot();
    snapshot.lockfile = snapshot.lockfile.replaceAll(VERSION, "1.3.14");
    const failures = bunVersionFailures(snapshot).join("\n");
    expect(failures).toContain("bun.lock: root @types/bun declaration");
    expect(failures).toContain("bun.lock: resolved @types/bun");
  });
});
