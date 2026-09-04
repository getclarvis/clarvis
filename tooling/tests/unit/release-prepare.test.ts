import { describe, expect, test } from "bun:test";

import {
  compareReleaseVersions,
  prepareReleaseSources,
  type ReleasePreparationSources,
} from "../../lib/release-prepare.ts";

function fixture(): ReleasePreparationSources {
  return {
    packageJson: '{\n  "name": "clarvis",\n  "version": "0.1.0",\n  "private": true\n}\n',
    installSh: "version=${CLARVIS_VERSION:-0.1.0}\n",
    installPowerShell:
      '$Version = if ($env:CLARVIS_VERSION) { $env:CLARVIS_VERSION } else { "0.1.0" }\n',
    changelog:
      "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Stable prefixes.\n\n## [0.1.0] - 2026-09-03\n\n- First release.\n",
  };
}

describe("prepareReleaseSources", () => {
  test("updates only the release authorities and promotes Unreleased", () => {
    const prepared = prepareReleaseSources(fixture(), "0.1.1", "2026-09-04");

    expect(JSON.parse(prepared.packageJson)).toEqual({
      name: "clarvis",
      version: "0.1.1",
      private: true,
    });
    expect(prepared.installSh).toBe("version=${CLARVIS_VERSION:-0.1.1}\n");
    expect(prepared.installPowerShell).toContain('else { "0.1.1" }');
    expect(prepared.changelog).toContain(
      "## [Unreleased]\n\n## [0.1.1] - 2026-09-04\n\n### Fixed\n\n- Stable prefixes.",
    );
    expect(prepared.previousVersion).toBe("0.1.0");
  });

  test("refuses an empty changelog entry, a repeated version, or a downgrade", () => {
    const empty = fixture();
    empty.changelog = empty.changelog.replace("\n### Fixed\n\n- Stable prefixes.\n", "");
    expect(() => prepareReleaseSources(empty, "0.1.1", "2026-09-04")).toThrow(
      "Unreleased section is empty",
    );
    expect(() => prepareReleaseSources(fixture(), "0.1.0", "2026-09-04")).toThrow("must be newer");
    expect(() => prepareReleaseSources(fixture(), "0.0.9", "2026-09-04")).toThrow("must be newer");
  });

  test("fails before returning changes when an installer identity drifted", () => {
    const sources = fixture();
    sources.installSh = "version=latest\n";
    expect(() => prepareReleaseSources(sources, "0.1.1", "2026-09-04")).toThrow(
      "install.sh must contain",
    );
  });
});

test("compareReleaseVersions follows SemVer prerelease ordering", () => {
  expect(compareReleaseVersions("0.1.0", "0.1.0-beta.2")).toBeGreaterThan(0);
  expect(compareReleaseVersions("0.1.0-beta.10", "0.1.0-beta.2")).toBeGreaterThan(0);
  expect(compareReleaseVersions("0.1.1", "0.1.0")).toBeGreaterThan(0);
  expect(compareReleaseVersions("0.1.0-alpha", "0.1.0-beta")).toBeLessThan(0);
  expect(compareReleaseVersions("0.1.0-B", "0.1.0-a")).toBeLessThan(0);
  expect(
    compareReleaseVersions("100000000000000000000.0.0", "99999999999999999999.0.0"),
  ).toBeGreaterThan(0);
  expect(() => compareReleaseVersions("0.1.0-beta.01", "0.1.0-beta.1")).toThrow(
    "invalid release version",
  );
});
